# Changelog

## Unreleased — strict fallback + context optimization + compatibility tester

### Added — Strict fallback mode (explicit model selection always wins)
- `blitz config set fallbackMode strict` — an explicitly selected model is authoritative: the fallback chain is ignored (loudly), capability heuristics can never silently replace the selection, and a provider failure returns the provider's real error. Credential rotation (same provider, different key) still applies — it is not a model switch. Default `enabled` preserves existing behavior.

### Added — Context optimization (privacy-first, safety-first)
- `src/context-optimizer.js` on the `/v1/messages` path, modes `off` / `safe` (default) / `aggressive` via `blitz config set contextOptimization`.
- SAFE ops are lossless by construction: ANSI stripping, carriage-return progress resolution, duplicate-line collapse with explicit `[+N]` markers, blank-wall collapse. System prompts, user text, recency window (last 6), and tool_use/thinking/image blocks are never touched — verified by 16 adversarial tests (old instructions, security constraints, compiler errors inside huge logs, progress bars, malformed input).
- AGGRESSIVE adds exact-duplicate whole-block collapse in old messages. Semantic summarization deliberately NOT implemented (would require model calls; can hallucinate).
- Transparency: `X-Blitz-Context-Reduction` header, `CONTEXT` log lines, pure-function reversibility with automatic fallback to the original context on optimizer error.

### Added — Request transparency & compatibility
- `X-Blitz-Model` response header: the model ACTUALLY used (vs the requested one) on every successful response.
- `blitz compatibility` — runs the live end-to-end suite (Anthropic/OpenAI/Responses, streaming, tool calls, credential validation) against your real provider; explicit user action, never prints keys.
- `blitz cline` / `blitz roo` — honest setup values for the Cline/Roo Code VS Code extensions (they are editor extensions, not launchable CLIs — no fake launcher).

### Tests
- 231 → **253 tests across 17 suites** — new `context-optimizer.test.js` (16 adversarial safety tests), strict-mode router tests, strict-mode + context-optimization end-to-end server tests.

## Unreleased — BLITZ gateway evolution

### Added — Canonical credential resolution & smart rotation
- **`src/credentials.js`** — ONE resolver for every subsystem (requests, health, validation, discovery, CLI). Direct `keys[0]` indexing is eliminated across server, router, and CLI.
- **Smart rotation, not round-robin**: live 401/403 marks a credential invalid (5-min hold), 429 applies a 60s cooldown, success clears state. Selection order: vault-active → healthiest (fewest failures) → cooling → held-out as last resort. Candidates now carry `credentialId`, so a rejected key never poisons its provider and the *next* request starts with the healthy credential.
- Per-credential stats (`successes`, `failures`, `lastUsed`, state) — never key material.

### Added — Model registry, discovery & aliases
- `blitz models` / `models search` / `models info` — full registry view across usable providers (catalog + discovered), ACTIVE marker, honest capability display (never fabricated).
- `blitz models refresh [provider]` — discovery from the provider's `/models` endpoint, cached in config (`discoveredModels`); failed discovery never deletes manual entries; the proxy never calls `/models` per request.
- `GET /v1/models` now serves catalog + discovered models for the active provider.
- `blitz use <provider>/<model>` — switches ONLY the model; credentials untouched. `blitz alias set/list/remove` — short names (`coding → nvidia/z-ai/glm-5.3`) resolved centrally; `blitz use <alias>`.

### Added — Configuration validation & LAN safety
- `blitz config validate` — read-only validation of syntax, providers, credentials, models, profiles, fallback chains (incl. circular), routing, ports, timeouts, and LAN safety; actionable errors/warnings; exit 0/1; never mutates, never prints secrets. Reusable `validateConfig()` + `formatValidation()`.
- **LAN bind guard** (`src/security/lan.js`): non-loopback `host` without `requireAuth` makes the server refuse to start with a clear fix-it message. Loopback behavior unchanged.

### Added — Observability & launchers
- **Request correlation**: every response carries `X-Blitz-Request-Id` (`BLZ-XXXXXX`); error payloads include `request_id`; request logs carry `req=`.
- Agent launchers: `blitz claude` / `opencode` / `codex` / `aider` (shortcuts for `blitz run <agent>`). Cline/Roo Code connect via base-URL settings (documented — they are editor extensions, not CLIs).
- Enhanced `blitz status`: gateway state, active route (provider/model/credential), registry counts (providers, credentials, models), endpoint availability.
- Timeout hierarchy: global (explicit) → model (catalog `timeout` field) → provider → 120s default.

### Added — Opt-in live test mode
- `BLITZ_LIVE_TESTS=1 npm run test:live` — real-provider end-to-end checks (config validation, credential validation, /health, /v1/models, Anthropic non-stream/stream/tools, OpenAI chat, Responses) with strict timeouts, never printing keys. Never runs in CI.

### Repository
- Stale `jenil0528/claude-code-proxy` references updated to `jenil0528/blitz-proxy` (README badge, CONTRIBUTING).
- Tests: **231 tests across 16 suites** — new suites for credential resolution/smart rotation, config validation + LAN guard, model discovery cache + aliases; server suite extended (rotation ordering across requests, request IDs, /v1/models with discovered models).

## Unreleased (previous)

### Added — Multi-key management & rotation
- **Multiple API keys per provider** — `blitz add` no longer replaces the existing key for a provider; extra keys are kept (with auto-suffixed names like `NVIDIA NIM #2`) and shown with rotation counts in `blitz keys`.
- **Automatic key rotation** — when a request gets 401/403, the next stored key for the *same* provider is tried before any provider failover. Rotation is not a failover: it happens even with `fallbackOnAuthError` off and never marks the provider unhealthy on success. When every key is rejected, the error names the (masked) key and the fix: `blitz add <new-key>`.
- **Router emits one candidate per (provider, key)** — key order: active key first, then the rest. Env `API_KEY` still strictly overrides stored keys.

### Added — Interactive model picker
- `blitz model` with no arguments now doubles as a picker: the numbered catalog is followed by a selection prompt (TTY only; non-interactive shells keep the classic list).
- Ambiguous fuzzy matches (`blitz model glm`) list the matches and prompt for a choice instead of silently taking the first.
- `blitz model --live` lists the provider's real models numbered and selectable.

### Fixed — No more terminal windows popping mid-session (Windows)
- The detached proxy server runs **without a console**, so every helper-process spawn (PowerShell for DPAPI keyring access) opened a visible terminal window — repeatedly, while Claude Code was prompting. All non-interactive spawns now pass `windowsHide: true`: keyring PowerShell (`DPAPI` load/store/probe), `taskkill`, `findServerPid`, `which`/`where` lookups, and the detached server itself.
- **Keyring refresh is mtime-driven**: file-backed stores (DPAPI/file) reload only when the vault file actually changed — previously the vault was re-read (spawning PowerShell) every 30 seconds even when nothing changed, and a same-content rewrite left a stale internal mtime that forced a reload *on every request*, i.e. a window flash per request.
- Regression tests: cross-process vault changes (CLI → running server) are picked up; identical-content rewrites no longer leave a stale mtime.

### Fixed — Honest validation & health (the lying `/models` problem)
- Some providers (notably NVIDIA) serve `/v1/models` anonymously — 200 for any Bearer token. `blitz validate` now backs its "key is valid" claim with a **minimal real inference request** (≤1 token) and surfaces the provider's own error detail (401/403/402/429 paths handled).
- `blitz health` performs the same deep check (explicit user action only); the server's periodic/dashboard probes stay cheap but are now corrected by **passive health marks**: real 401/403/429/5xx/network outcomes pin `auth-failed` (5 min) / `rate-limited` (1 min) / `unavailable` / `offline` (30 s) over probe results, so the dashboard and auto-routing reflect reality.
- Auth errors returned to clients now include the masked key that was rejected and the fix command.
- `blitz add` warns loudly when a key matches no known provider format and no longer silently switches the active provider to an unconfigured `custom` endpoint.

### Tests
- 178 → **184 tests, 13 suites** — new coverage: key rotation (success + exhaustion), per-key candidates, multi-key keyring semantics, cross-process vault pickup, identical-rewrite mtime sync, anonymous-`/models` validation paths, passive health marks.

## 2.0.0 — The Multi-Provider Gateway Release

Full upgrade from a single-provider Claude→OpenAI proxy to a local AI provider gateway. Every v1 command still works.

### Added — Security (HIGH PRIORITY)
- **Secure key storage** — keys move from plaintext `config.json` into your OS store: **Windows DPAPI**, **macOS Keychain**, **Linux Secret Service**, with a loudly-warned `0600` plaintext fallback only when unavailable.
- **Automatic v1 → v2 migration** of plaintext configs, with a timestamped backup you control.
- Keys are masked everywhere (`nvapi-••••a82f`), redacted from every log line, and never written to `.env` again.
- **Binds `127.0.0.1` by default** — LAN peers can no longer silently burn your credits.
- **Auto-generated local proxy token** (never the string `blitz`) protecting `/admin/*` and `/dashboard`; optional `requireAuth` for `/v1/*`.
- CORS wildcard removed — only same-machine browser origins are honored.
- `.gitignore` hardened (`*.key`, `secrets/`, `credentials/`, `logs/`, `config.json.bak*`).
- Added `SECURITY.md`; `blitz privacy` mode (no request log, in-memory stats only).
- `blitz validate <provider>` — key validity confirmed by the provider's own API, never by prefix.

### Added — Routing & Reliability
- **Provider registry with adapters** (`chat`, `listModels`, `validateKey`, `healthCheck`) and a **plugin system** (`providers/*.js`, `PROVIDERS.md`) — new providers without touching the router.
- **Multi-provider fallback**: rate-limits, timeouts, 5xx, network errors, context overflow, and missing models trigger the next provider; **auth errors and invalid requests fail fast by default** (opt-in for auth). Fallback only ever happens **before the first streamed byte**.
- **Automatic routing** (`blitz auto`) — health + capability + priority ranking per request.
- **Profiles** — `coding`, `fast`, `free`, `local` (local never contacts cloud), plus user-defined chains.
- **Capability-aware routing** — tool/vision/context requirements filter candidate models; a tools request never silently lands on a tool-less model when an alternative exists.
- **Health monitoring** (`blitz health`) with TTL-cached checks — provider APIs are never spammed.
- **Model catalog with metadata** — context windows, tool/vision/reasoning flags, and clearly-labeled **pricing estimates** (unknown pricing shows `n/a`, never invented).

### Added — Compatibility & Insight
- **OpenAI Responses API endpoint** `POST /v1/responses` — full Codex CLI support: instructions/input items, function calls + outputs (with `call_id` round-trip), `input_image`, streaming `response.*` SSE events (`created` → `output_text.delta`/`function_call_arguments.delta` → `completed`), mid-stream failures emit `response.failed` (never a fake completion).
- **OpenAI-compatible endpoint** `POST /v1/chat/completions` (OpenCode, Codex-style, any OpenAI client) with the same routing/fallback/stats.
- **Claude Code fixes**: images now forwarded as proper `image_url` parts (were silently dropped), provider `reasoning_content` → `thinking` blocks, assistant thinking stripped from history, auth errors map to **401 `authentication_error`** (was a misleading 400), mid-stream failures emit an explicit **`error` SSE event** instead of a fake-successful truncated response.
- **Usage statistics & estimated cost** (`blitz stats`) — aggregates only, prompts never stored, 90-day retention.
- **Local dashboard** (`blitz dashboard`) — token-gated, localhost-only, zero frontend dependencies.
- **`blitz doctor`** — checks Node, Claude/OpenCode CLIs, config, keyring, keys, port conflicts, global env hijacking, model availability.
- **Process management**: `blitz start/stop/restart/status` with a PID file and friendly `EADDRINUSE` handling.
- **`blitz run <cmd>` / `blitz shell`** — per-process environment instead of permanently hijacking `ANTHROPIC_*`.

### Fixed
- Mid-stream provider failure silently looked like success (audited B1).
- Read timeout timer never cleared after body consumption (B3).
- Non-stream timeout hard-capped at 120s while NVIDIA needs 300s cold starts (B2).
- `blitz logs --live` byte-offset corruption on multi-byte characters (B8).
- `.env` placeholder key auto-created at import and treated as a real key (B9).
- Dead `logRequests` flag — now honored, and disabled entirely by privacy mode (S9).
- Stale GitHub Models / Hugging Face endpoints updated (B7).

### Installer (Windows)
- New safe **`install.ps1` / `uninstall.ps1`** — registry-API user PATH (no `setx` truncation risk), existing-install detection, config backup, opt-in-only global env. `setup.bat` forwards to it.
- Mac/Linux: **`setup.sh` installs an absolute-path wrapper** (symlinks broke `$0` resolution) and **`uninstall.sh`** removes only BlitzProxy components; plugin file URLs now properly encoded (paths with spaces work on every OS).

### Breaking Changes & Migration
- **Binds `127.0.0.1`** — LAN users must opt in: `blitz config set host 0.0.0.0`.
- **Keys migrate to the keyring** on first run — plaintext `config.json` is backed up automatically; `.env` is input-only now.
- `ANTHROPIC_API_KEY=blitz` is no longer set globally by installers — use `blitz run claude` (or set `requireAuth` and use the real token).
- Replaced setup scripts: behavior preserved, `setx PATH` anti-pattern removed.

### Testing & CI
- **145 tests across 11 suites** (was 23/2) — masking, keyring, migration, catalog, classification, routing, profiles, health, stats, translation (incl. images/thinking/reasoning), streaming (incl. failure semantics), and full **HTTP integration tests** against mock providers (fallback, auth, dashboard, OpenAI passthrough). **Live-verified end-to-end with the real Claude Code CLI** through a mock provider (26 tools, 9.2KB system prompt, streaming — all translated and answered). CI now runs Linux/Windows/macOS × Node 18/20/22 plus `npm run lint`.

## 1.1.0
- Multi-key management, key prefix auto-detection, retry/backoff, streaming translation, `blitz.log` rotation, per-provider timeouts, connection keep-alive.

## 1.0.0
- Initial release: Claude Code → single OpenAI-compatible provider proxy.
