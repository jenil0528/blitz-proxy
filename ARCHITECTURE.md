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
| `server.js` | Launcher: init app, token, stats, **LAN bind guard**, listen, PID file, graceful shutdown |
| `cli.js` | All terminal commands (async main, dispatch table, agent launchers) |
| `src/server.js` | `createProxyServer()` — endpoints, auth, candidate loop, admin API, dashboard, request IDs |
| `src/config.js` | Config v2: load/save/migrate, env input, hot reload (`refreshConfigIfChanged`) |
| `src/config-validate.js` | Read-only configuration validation (providers, credentials, models, profiles, fallbacks, ports, timeouts, LAN safety) |
| `src/credentials.js` | **Canonical credential resolver** — one selection path for every subsystem; live credential states (invalid hold, rate-limit cooldown, successes/failures), healthiest-first rotation order |
| `src/providers.js` | Static catalog: base URLs, models, capabilities, pricing estimates, key prefixes |
| `src/provider-registry.js` | Adapter interface (chat/validateKey/healthCheck/listModels), plugin loading |
| `src/routing/router.js` | `planCandidates()` — chain resolution, per-credential candidates, model/provider/global timeout hierarchy, capability filtering |
| `src/routing/fallback.js` | Error classification: kind + `fallbackable` + `retryable` |
| `src/routing/health.js` | TTL-cached health monitor + passive marks from real traffic (never probes inline in requests) |
| `src/routing/capabilities.js` | Token estimation, request needs, model satisfaction |
| `src/routing/profiles.js` | Built-in + user profiles, chain parsing, local-only enforcement |
| `src/models-cache.js` | Model discovery cache — merge/dedupe/preserve, never fabricates capabilities |
| `src/aliases.js` | Model aliases (`coding → nvidia/z-ai/glm-5.3`), single deterministic lookup |
| `src/context-optimizer.js` | Privacy-first context optimization (off/safe/aggressive) — lossless noise removal with adversarially-tested preservation guarantees |
| `src/security/keyring.js` | Platform vault: DPAPI/Keychain/Secret Service/file/memory |
| `src/security/auth.js` | Proxy token generation, constant-time checks, extraction |
| `src/security/lan.js` | Loopback detection + `assertSafeBind` — non-loopback without auth refuses to start |
| `src/security/mask.js` | `maskKey`, `maskKeyWithPrefix`, `redactSecrets` |
| `src/translator.js` | Anthropic → OpenAI request / OpenAI → Anthropic response |
| `src/stream-translator.js` | OpenAI SSE → Anthropic SSE (blocks, thinking, error events) |
| `src/retry.js` | Exponential backoff + jitter, Retry-After, permanent-error skip |
| `src/connection.js` | fetch with connect/read timeouts, timer lifecycle |
| `src/stats.js` | Aggregate usage + estimated cost, privacy mode, 90-day pruning |
| `src/logger.js` | Colored console output levels |
| `src/dashboard/index.js` | Token-gated dashboard HTML (vanilla JS, polls /admin) |

## Request Lifecycle (Anthropic endpoint)

1. `POST /v1/messages` → body read (10 MB cap) → JSON parse → 400 on invalid. A `requestId` (`BLZ-XXXXXX`) is generated per request and attached to logs, headers (`X-Blitz-Request-Id`), and error payloads.
2. `requestNeeds()` + `estimateTokens()` → `planCandidates()` builds an ordered chain:
   - **profile active?** → profile chain (local-only profiles filtered to local providers)
   - **routing=auto?** → health-snapshot + capability + priority ranking
   - **else** → active provider, then `fallbackChain`
   - Providers without credentials skipped; capability mismatches skipped **only if an alternative exists**; **one candidate per credential** in resolver order (active → healthiest → cooling → held-out).
3. For each candidate: `translateRequest()` → `withRetry(adapter.chat())` (backoff on 429/5xx, same-provider retries). Timeout: global (if explicitly set) → model → provider → 120s default.
4. Non-OK → `classifyHttpError()`:
   - **auth (401/403)** and another credential exists for the SAME provider → mark that credential invalid (5-min hold) and rotate — not a failover, so `fallbackOnAuthError` does not gate it, and no provider health is poisoned on a successful rotation.
   - **rate limit (429)** → that credential cools down (60s); retry then failover may proceed per policy.
   - fallbackable (rate-limit / server / timeout / context-overflow / model-not-found) and more candidates remain → log `FALLBACK a→b`, next candidate.
   - otherwise → mapped Anthropic error (401/429/400/529/502) with the request id and stop. Invalid-request errors never fail over.
5. OK → the credential's state is cleared and a success recorded. **Streaming**: SSE headers out, `translateStream()` pipes events; from this moment no provider switching is possible by design. A mid-stream failure emits an `error` SSE event. **Non-streaming**: `translateResponse()` → 200.
6. Stats recorded per attempt (tokens, latency, rate-limit flag, fallback attribution); `blitz.log` gets one metadata line (skipped in privacy mode).

## Credential Resolution (canonical)

Every subsystem — requests, health checks, `blitz validate`, `blitz health`, model discovery, CLI status — resolves credentials through `src/credentials.js`. Nothing may index `keys[0]` directly.

Priority: explicit credential id → vault-active credential → healthiest eligible (fewest recent failures, then vault order) → rate-limit-cooled → invalid-held as last resort (keys can recover upstream, so they are never permanently excluded). States are in-process per credential id; `credentialStats()` exposes them without key material for status/doctor.

Circuit-breaker semantics: the credential state machine implements CLOSED (healthy) → OPEN (invalid hold / cooldown: requests skip it) → HALF_OPEN (hold expiry: the credential re-enters selection as a last-resort tier, probed by real traffic) → CLOSED on the first success. Provider-level health marks (`src/routing/health.js`) follow the same pattern per provider.

## Fallback Modes (explicit model selection always wins)

`fallbackMode: 'enabled'` (default, backward compatible): manual mode uses the active provider first, then the configured fallback chain; capability mismatches switch when an alternative exists.

`fallbackMode: 'strict'`: an explicitly selected model is authoritative. The fallback chain is ignored (loudly), capability heuristics cannot replace the selection, and a provider failure returns the provider's own error — requested model = actual model. Credential rotation (same provider, different key) still applies because it is not a model switch. Profiles are explicit chains by construction; auto routing only engages when no explicit model was selected.

## Context Optimization (`src/context-optimizer.js`)

Applied on the `/v1/messages` path before translation. Modes: `off` (identity), `safe` (default), `aggressive`.

- SAFE operations are lossless by construction: ANSI escape stripping, carriage-return overwrite resolution (final state kept), duplicate consecutive lines collapsed to first occurrence + `[+N duplicate lines collapsed]` marker, blank-line wall collapse.
- Never modified: system prompts, user text (instructions/decisions/security constraints at any age), the last N messages (recency window: safe 6 / aggressive 2), `tool_use`/`thinking`/`image` blocks.
- AGGRESSIVE adds exact-duplicate whole-block collapse across OLD optimizable blocks (first copy kept, later copies marked) and narrows the recency window to 2. Semantic summarization is intentionally NOT implemented (requires model calls and can hallucinate — violates the no-fake-features rule).
- Pure function over a copy; the server falls back to the unmodified context on any optimizer error. Transparency: `X-Blitz-Context-Reduction` header, `CONTEXT` log line (original→optimized tokens, criticalRemoved: 0); guarantees verified by adversarial tests in `test/context-optimizer.test.js`.

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
