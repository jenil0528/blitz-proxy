# Architecture

## Overview

BlitzProxy is a single-process Node.js (ESM, zero runtime dependencies) gateway. Everything runs in one event loop; concurrency is handled by Node's non-blocking I/O.

```
                    ┌────────────────────────────────────────────────────┐
Claude Code ────────▶                                                    │
OpenCode    ────────▶  HTTP server (src/server.js)                        │
other clients ──────▶  ┌────────────┐                                    │
                    │  │  Auth      │  token check (admin always, /v1 opt)│
                    │  └────┬───────┘                                    │
                    │       ▼                                            │
                    │  Endpoint layer                                    │
                    │   /v1/messages            (Anthropic)               │
                    │   /v1/chat/completions   (OpenAI passthrough)     │
                    │   /v1/models, /v1/messages/count_tokens             │
                    │   /health  /dashboard  /admin/*                    │
                    │       ▼                                            │
                    │  Router (src/routing/router.js)                    │
                    │   profile → auto → manual chain resolution         │
                    │   capability filter (tools/vision/context)         │
                    │       ▼                                            │
                    │  Candidate loop (src/server.js)                   │
                    │   for each candidate:                              │
                    │     translate → adapter.chat → retry               │
                    │     classify error → fallback? → next candidate    │
                    │       ▼                                            │
                    │  Translation (src/translator.js,                   │
                    │              src/stream-translator.js)             │
                    │   Anthropic ⇄ OpenAI, SSE, tool IDs, images,       │
                    │   reasoning ⇄ thinking blocks, error events       │
                    └────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────────┐
        ▼                       ▼                           ▼
  Provider Registry       Secure Keyring                Stats
  (provider-registry.js) (security/keyring.js)         (stats.js)
  catalog + adapters     DPAPI / Keychain /            aggregates +
  + plugins              Secret Service / 0600 file    cost estimates
```

## Module Map

| Path | Responsibility |
|---|---|
| `server.js` | Launcher: init app, token, stats, listen, PID file, graceful shutdown |
| `cli.js` | All terminal commands (async main, dispatch table) |
| `src/server.js` | `createProxyServer()` — endpoints, auth, candidate loop, admin API, dashboard |
| `src/config.js` | Config v2: load/save/migrate, env input, hot reload (`refreshConfigIfChanged`) |
| `src/providers.js` | Static catalog: base URLs, models, capabilities, pricing estimates, key prefixes |
| `src/provider-registry.js` | Adapter interface (chat/validateKey/healthCheck/listModels), plugin loading |
| `src/routing/router.js` | `planCandidates()` — chain resolution, key/model resolution, capability filtering |
| `src/routing/fallback.js` | Error classification: kind + `fallbackable` + `retryable` |
| `src/routing/health.js` | TTL-cached health monitor (never probes inline in requests) |
| `src/routing/capabilities.js` | Token estimation, request needs, model satisfaction |
| `src/routing/profiles.js` | Built-in + user profiles, chain parsing, local-only enforcement |
| `src/security/keyring.js` | Platform vault: DPAPI/Keychain/Secret Service/file/memory |
| `src/security/auth.js` | Proxy token generation, constant-time checks, extraction |
| `src/security/mask.js` | `maskKey`, `maskKeyWithPrefix`, `redactSecrets` |
| `src/translator.js` | Anthropic → OpenAI request / OpenAI → Anthropic response |
| `src/stream-translator.js` | OpenAI SSE → Anthropic SSE (blocks, thinking, error events) |
| `src/retry.js` | Exponential backoff + jitter, Retry-After, permanent-error skip |
| `src/connection.js` | fetch with connect/read timeouts, timer lifecycle |
| `src/stats.js` | Aggregate usage + estimated cost, privacy mode, 90-day pruning |
| `src/logger.js` | Colored console output levels |
| `src/dashboard/index.js` | Token-gated dashboard HTML (vanilla JS, polls /admin) |

## Request Lifecycle (Anthropic endpoint)

1. `POST /v1/messages` → body read (10 MB cap) → JSON parse → 400 on invalid.
2. `requestNeeds()` + `estimateTokens()` → `planCandidates()` builds an ordered chain:
   - **profile active?** → profile chain (local-only profiles filtered to local providers)
   - **routing=auto?** → health-snapshot + capability + priority ranking
   - **else** → active provider, then `fallbackChain`
   - Providers without keys skipped; capability mismatches skipped **only if an alternative exists**.
3. For each candidate: `translateRequest()` → `withRetry(adapter.chat())` (backoff on 429/5xx, same-provider retries).
4. Non-OK → `classifyHttpError()`:
   - fallbackable (rate-limit / server / timeout / context-overflow / model-not-found) and more candidates remain → log `FALLBACK a→b`, next candidate.
   - otherwise → mapped Anthropic error (401/429/400/529/502) and stop. Auth and invalid-request errors never failover (config opt-in for auth).
5. OK → **streaming**: SSE headers out, `translateStream()` pipes events; from this moment no provider switching is possible by design. A mid-stream failure emits an `error` SSE event. **Non-streaming**: `translateResponse()` → 200.
6. Stats recorded per attempt (tokens, latency, rate-limit flag, fallback attribution); `blitz.log` gets one metadata line (skipped in privacy mode).

## Configuration Flow

- `config.json` (project root) holds **non-secret** settings only. `BLITZ_CONFIG` env overrides the path (used by tests).
- `.env` / environment values are **input** overrides with historical precedence (`API_KEY`, `PROVIDER`, `MODEL`, `PROXY_PORT`, `TIMEOUT`, `LOG_LEVEL`, `CUSTOM_BASE_URL`).
- Keys live in the keyring vault. The **active key id** stays in the vault; `provider`/`model` in config.json mirror the active selection for fast sync display.
- The server hot-reloads config.json changes (mtime check, throttled) — CLI edits apply within seconds without restart, except `host`/`proxyPort` (require `blitz restart`).
- v1 configs (plaintext `savedKeys`/`apiKey`) are migrated automatically on first run with a timestamped backup.

## Key Vault Design

One encrypted JSON blob per install (single secret per platform store):

```json
{ "version": 1, "activeKeyId": "…", "keys": [ { "id", "name", "key", "provider", "providerName", "model", "createdAt" } ], "secrets": { "authtoken": "…" } }
```

- Windows: blob → UTF-8 → DPAPI `Protect(…, CurrentUser)` → base64 → `~/.blitzproxy/keys.bin`
- macOS: blob as one `security` generic password
- Linux: blob via `secret-tool` (attribute pair lookup)
- Fallback: blob as `keys.json` with `0600`
- `memory` mode exists for tests.

The server refreshes the vault from disk when its mtime changes (throttled), so CLI key changes propagate to a running server. One key per provider by design (`blitz add` replaces).

## Streaming Fallback Rule

Fallback decisions happen **only before the first byte is sent to the client**. After SSE starts, failures become explicit `error` events. This prevents the two worst failure modes: duplicated tool calls (from replaying a request another provider already partially answered) and silent truncation.

## Process Management

`blitz start` spawns `node server.js` detached (stdio ignored) and polls `/health` until ready (or reports failure). The server writes its PID to `~/.blitzproxy/blitz.pid`; `blitz stop` reads it and sends SIGTERM (Windows: `process.kill` / `taskkill` fallback). `EADDRINUSE` produces a friendly message, not a stack trace.

## Extension Points

1. **Provider plugins** — `providers/*.js` (project dir or `BLITZ_HOME/providers`), auto-loaded by the registry; may override any adapter method. See PROVIDERS.md.
2. **Config-defined providers** — `customProviders` map in config.json for simple OpenAI-compatible endpoints (used by the test-suite's mock providers).
3. **Profiles** — user profiles in `config.profiles` with `--chain` syntax.
