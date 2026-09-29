![version](https://img.shields.io/badge/version-2.0.0-blue) ![node](https://img.shields.io/badge/node-18%2B-green) ![zero deps](https://img.shields.io/badge/dependencies-zero-brightgreen) ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-lightgrey) ![tests](https://img.shields.io/badge/tests-231%20passed%20%2F%2016%20suites-brightgreen) ![CI](https://github.com/jenil0528/blitz-proxy/actions/workflows/ci.yml/badge.svg)

# ⚡ BlitzProxy

**A local-first, multi-provider AI gateway for Claude Code, OpenCode, Codex, and any OpenAI/Anthropic-compatible client.**

Zero runtime dependencies. Pure Node.js. Your keys stay in your OS keyring — your prompts never leave your machine except to the provider you chose.

```
Claude Code ─┐
OpenCode    ─┤→  BlitzProxy (127.0.0.1:4819)  →  Provider registry  →  NVIDIA / Groq / OpenRouter /
Codex CLI   ─┤        Anthropic + OpenAI APIs        with fallback         DeepSeek / Gemini / Ollama / …
any client  ─┘        + secure keyring             + key rotation          + your own endpoints
```

BlitzProxy works perfectly with a single provider — routing, fallback, health, and stats are all optional layers you can ignore.

---

## Features

- **Speaks both APIs natively** — Anthropic Messages (`/v1/messages`) *and* OpenAI Chat Completions + Responses (`/v1/chat/completions`, `/v1/responses`), translated in real time to any provider
- **Multiple credentials per provider, smart rotation** — live 401/403 holds a credential out, 429 cools it down; the healthiest credential serves first, and a rejected key never poisons its provider
- **Model registry with discovery cache** — `blitz models refresh` caches the provider's live `/models` list; capabilities are never fabricated; `GET /v1/models` serves catalog + discovered
- **`blitz use <provider>/<model>`** — switch ONLY the model; credentials and provider config stay untouched. Aliases (`blitz alias set coding nvidia/...`) give whole routes short names
- **Interactive model picker** — `blitz model` lists the catalog and lets you select a model right there (or use fuzzy search, `provider/model` syntax, or a live list from the provider)
- **Honest credential validation** — `blitz validate` confirms a key with a real 1-token inference request, because some `/models` endpoints (NVIDIA's included) accept *any* key
- **Multi-provider fallback** — rate limits, timeouts, 5xx, network errors, context overflow, and retired models fail over to the next provider *before the first byte reaches your client*
- **Automatic routing** — `blitz auto` ranks providers per request by live health, capability match, and priority — deterministic, never an LLM deciding routes
- **Health that reflects reality** — real request outcomes (401/403/429/5xx) are pinned over cheap probes, per provider AND per credential
- **Config validation** — `blitz config validate` checks providers, credentials, models, profiles, fallback chains, ports, timeouts — read-only, actionable, never prints secrets
- **LAN-safe by refusal** — binding a non-loopback host without authentication makes the server refuse to start
- **Request correlation** — every response carries `X-Blitz-Request-Id`; errors include it as `request_id`
- **Secure by default** — keys in the OS keyring (Windows DPAPI / macOS Keychain / Linux Secret Service), masked everywhere, redacted from every log, local-only binding, token-gated admin
- **Zero dependencies** — no `npm install`, no supply chain, Node.js 18+ is the only requirement
- **Invisible background operation (Windows)** — the proxy and all its helper processes (keyring, process management) run fully hidden: no console windows flash on your screen while you work

## Quick Start

```bash
# 1. install the `blitz` command (see below for your OS)
# 2. add a key — prefix detection picks the provider automatically
blitz add nvapi-xxxxxxxx

# 3. start the proxy + launch Claude Code in one command
blitz
```

That's it. Claude Code now runs on your choice of 16 built-in providers (or your own endpoint) with fallback, key rotation, and usage stats.

## Installation

Requires **Node.js 18+**. No `npm install` — the project has zero dependencies.

### Windows

```powershell
# from the BlitzProxy folder
powershell -ExecutionPolicy Bypass -File install.ps1
```

The safe installer:
- creates a `blitz` command shim in `%LOCALAPPDATA%\BlitzProxy`
- adds it to your **user** PATH via the registry API (no `setx` truncation risk)
- backs up an existing `config.json`
- **does not** permanently change `ANTHROPIC_*` (use `blitz run claude` instead)

Open a **new terminal** afterwards so the PATH refresh applies. Uninstall: `powershell -File uninstall.ps1` (add `-Purge` to also remove stored keys and stats).

### Linux

```bash
bash setup.sh        # installs a `blitz` wrapper at /usr/local/bin/blitz (no rc-file changes)
```

Uninstall: `bash uninstall.sh` (add `--purge` to also remove stored keys/stats).

### macOS

Same as Linux: `bash setup.sh` — keys are stored in the **macOS Keychain** automatically.

## API Keys

```bash
blitz add nvapi-xxxxxxxx           # auto-detects NVIDIA, stores in OS keyring
blitz add gsk_xxxxxxxx "My Groq"   # optional friendly name
blitz add                          # no key on the command line → hidden prompt
                                    # (avoids leaving the key in shell history)
```

Keys are stored in your OS secure storage — **Windows DPAPI**, **macOS Keychain**, or **Linux Secret Service** — with a loudly-warned, `0600`-permission plaintext fallback only when the OS store is unavailable. Keys are masked everywhere (`nvapi-••••a82f`), never logged, never written to `.env`, never committed.

### Multiple keys per provider

Add as many keys as you want for the same provider — useful when one runs out of free credits or gets rate-limited:

```bash
blitz add nvapi-first-key
blitz add nvapi-second-key
# → NVIDIA NIM now has 2 keys — they rotate automatically when one is rejected
```

Rotation is **smart, not a blind round-robin**. Each credential carries live state (successes, failures, rate-limit cooldowns):

- **401/403** → the credential is held out (5 min) and the next request starts with a healthy one
- **429** → the credential cools down (60s) while others serve
- A successful request clears the state and counts toward the credential's health

Selection order is deterministic: vault-active credential → healthiest (fewest recent failures) → rate-limited → held-out as last resort. When *every* credential is rejected, the error names the (masked) key and the fix:

```
Provider rejected authentication (HTTP 403) — the provider rejected key
nvapi-••••6w-U; replace it with: blitz add <new-key>
```

### Managing credentials

```bash
blitz credentials    # list all credentials (masked), shows rotation counts
blitz credential add # same as blitz add
blitz switch 2       # make credential #2 the active one
blitz rm 1           # delete credential #1
blitz rm nvidia      # delete ALL credentials for a provider
blitz validate       # deep-validate the active provider's credential with a REAL request
blitz validate groq  # …or any provider's
```

A key prefix is never treated as proof of validity — and neither is a `200` from `/models` (NVIDIA's model list is anonymous and answers 200 to *any* Bearer token). `blitz validate` therefore confirms the key with a minimal real inference request (costs at most one token) and surfaces the provider's own error detail:

```
✕ NVIDIA NIM: Provider rejected the key on a real request (HTTP 403: Authorization failed)
```

## Model Selection

```bash
blitz model                # interactive: numbered catalog → select a model right here
blitz model glm            # fuzzy match (picks from matches, or prompts when ambiguous)
blitz model 7              # set by list number
blitz model nvidia/meta/llama-3.3-70b-instruct   # provider/model syntax (switches provider)
blitz model --live         # fetch the provider's real model list — selectable too
```

### Model registry, discovery & aliases

```bash
blitz use nvidia/z-ai/glm-5.3   # switch ONLY the active model — credentials stay untouched
blitz use 2                     # (plain numbers still switch credentials)

blitz models                    # full registry: catalog + discovered, ACTIVE marker
blitz models search glm         # search across all usable providers
blitz models info z-ai/glm-5.3  # provider, source, capabilities, active state
blitz models refresh            # discover models from the active provider's /models
blitz models refresh groq      # …or any provider — cached, never per-request

blitz alias set coding nvidia/z-ai/glm-5.3   # short names for provider/model pairs
blitz alias set fast groq/llama-3.3-70b-versatile
blitz alias list
blitz use coding                # aliases resolve centrally
```

Discovery is honest: cached model ids carry **no fabricated capabilities** (only `lastSeen`), catalog entries are never deleted by a failed refresh, and `GET /v1/models` serves catalog + discovered models for the active provider. Invalid models give clear errors — `blitz models info <model>` before you switch.

The picker lists capabilities with every model (`tools vision reasoning 128k ctx`), marks the active one with `●`, and cancels cleanly with Enter. Non-interactive shells fall back to the classic numbered list.

### Agent launchers

```bash
blitz claude         # shortcut for: blitz run claude
blitz opencode       # OpenCode through the gateway
blitz codex          # Codex CLI (Responses API)
blitz aider          # Aider
```

Each launcher detects the agent, injects the endpoints + token into that process only, resolves the active profile/model, and never touches your global environment. Cline / Roo Code are VS Code extensions — connect them by pointing their base-URL settings at `http://127.0.0.1:4819/v1` with your BlitzProxy token.

## Connect Clients

### Claude Code

```bash
blitz                    # starts proxy + launches Claude Code (env for this process only)
blitz run claude --resume # any claude flags pass through
blitz shell              # a whole shell with the BlitzProxy environment
```

`blitz run` / `blitz shell` set the client env vars **for that process only** — your global environment is never hijacked:

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4819` |
| `ANTHROPIC_API_KEY` | your local BlitzProxy token |
| `OPENAI_BASE_URL` | `http://127.0.0.1:4819/v1` |
| `OPENAI_API_KEY` | your local BlitzProxy token |

### Codex, OpenCode & other clients

```bash
blitz run codex     # OpenAI Codex CLI — uses the /v1/responses endpoint
blitz run opencode  # OpenCode — uses /v1/chat/completions
blitz run aider     # any OpenAI-compatible tool
```

Every endpoint gets the same routing, key rotation, fallback, stats, and cost tracking:

| Endpoint | Used by | Format |
|---|---|---|
| `POST /v1/messages` | Claude Code, Anthropic SDKs | Anthropic Messages — streaming, tools, images, thinking/reasoning blocks, token usage |
| `POST /v1/responses` | OpenAI Codex CLI | OpenAI **Responses API** — `response.*` SSE events, function-call round-trips, `response.failed` on mid-stream errors (never a fake completion) |
| `POST /v1/chat/completions` | OpenCode, Aider, Continue, LangChain, … | OpenAI Chat Completions (passthrough) |
| `GET /v1/models` | all | Claude-compat + configured provider models |
| `GET /health` | status checks | public, no internals |

## Routing & Reliability

**Manual mode (default):** your active provider first, then the fallback chain:

```bash
blitz fallback add groq
blitz fallback add openrouter
blitz fallback list        # nvidia → groq → openrouter
```

Failover happens for **rate limits, timeouts, 5xx, network errors, context overflow, and missing models** — never for invalid requests or TLS errors, and **not for auth errors by default** (`blitz config set fallbackOnAuthError true` to opt in). The one exception: a rejected key rotates to your next key for the same provider first (see above). Failover only ever happens **before the first streamed byte**; once streaming has begun, a provider failure produces an explicit `error` event instead of a silently truncated response.

**Automatic mode:** `blitz auto` — ranks available providers per request by health snapshot, capability match (tools/vision/context window), and a priority list. Capability-aware routing means a tools request never silently lands on a tool-less model when an alternative exists.

**Profiles** — named chains for different work styles:

```bash
blitz profile list
blitz profile set coding    # nvidia → deepseek → openrouter → groq
blitz profile set fast      # groq → cerebras
blitz profile set free      # free tiers first
blitz profile set local     # ollama ONLY — never contacts cloud providers
blitz profile add mine --chain "nvidia,deepseek/deepseek-chat" --desc="my chain"
blitz profile off
```

## Provider Health

```bash
blitz health         # live checks per provider (deep: verifies with a real request)
```

Health has two layers:
- **Cheap probes** (`/models`) with a TTL cache — provider APIs are never spammed
- **Passive marks from real traffic** — a live 401/403/429/5xx pins the provider as `AUTH-FAILED` / `RATE-LIMITED` / `UNAVAILABLE` for a hold window (auth: 5 min), overriding any probe result. The dashboard and auto-routing trust real outcomes over probes — so a provider that answers health checks fine but rejects your requests is shown as broken, because it is.

## Dashboard & Stats

```bash
blitz dashboard    # → http://127.0.0.1:4819/dashboard?token=<your token>
blitz stats        # per-provider request counts, success/fail, latency, tokens, estimated cost
blitz logs --live  # tail the request log (routes, statuses, latency — never prompts)
```

The dashboard is local-only, token-gated, and built with zero frontend dependencies: provider health, current routing, request counts, errors, fallback and rotation events, and clearly-labeled **pricing estimates** (unknown pricing shows `n/a` — never invented). Stats are aggregates only: prompts and responses are never stored.

## Security

- Binds **127.0.0.1** by default. Binding to a non-loopback host (`0.0.0.0`, a LAN IP, public IPv6) **requires authentication** — the server refuses to start otherwise, because an open LAN proxy would let anyone on your network spend your API keys
- Auto-generated local token protects `/admin/*` and `/dashboard`; optional `blitz config set requireAuth true` extends it to `/v1/*` (mandatory for LAN use)
- Keys in the OS keyring, masked in every output, redacted from every log
- No CORS wildcard — only same-machine browser origins
- Every response carries an `X-Blitz-Request-Id` correlation header; error payloads include it as `request_id` so bug reports never need prompts or keys
- Privacy mode: `blitz privacy` — no request log, stats in-memory only
- **No telemetry, ever.** No analytics code exists in this project.

Details: [SECURITY.md](SECURITY.md).

## Troubleshooting

```bash
blitz doctor           # checks Node, config, keyring, keys, port, env conflicts, client CLIs…
blitz config validate  # read-only validation: providers, credentials, models, profiles, fallbacks, ports, timeouts
```

| Symptom | Fix |
|---|---|
| Every request returns 401/403 | Key revoked/expired — `blitz validate <provider>` confirms with a real request; then `blitz add <new-key>` |
| Key added but provider still fails | `blitz keys` — an unrecognized key format lands under `custom` and never gets used for a named provider; re-add with `blitz add <key> --provider=<id>` |
| Server refuses to start (LAN host) | non-loopback binding needs auth: `blitz config set requireAuth true`, or go back to `blitz config set host 127.0.0.1` |
| Config looks wrong | `blitz config validate` — actionable errors, never mutates anything |
| `Port 4819 already in use` | `blitz stop`, or `blitz config set proxyPort 4818` |
| `blitz` not found | re-run the installer, then open a **new** terminal |
| NVIDIA first request slow | normal — serverless cold start; the NVIDIA timeout budget is 300s |
| Wrong model for provider | `blitz use <provider>/<model>`, `blitz models search <query>`, or `blitz provider <name>` |
| Provider 400 with "context" | request exceeds the model's window — enable a fallback with a larger context, or trim the request |

## Provider Catalog

| Provider | id | Key prefix | Notes |
|---|---|---|---|
| NVIDIA NIM | `nvidia` | `nvapi-` | free credits at build.nvidia.com; big model list |
| Groq | `groq` | `gsk_` | ultra-fast inference, generous free tier |
| OpenRouter | `openrouter` | `sk-or-` | gateway to 200+ models, many free |
| DeepSeek | `deepseek` | `sk-` | extremely affordable, strong coding models |
| OpenAI | `openai` | `sk-` | official API |
| GitHub Models | `github` | `github_pat_` | free with a GitHub account |
| Cerebras | `cerebras` | `csk-` | blazing fast |
| Google Gemini | `gemini` | `AIza` | via its OpenAI-compatible endpoint |
| Mistral | `mistral` | — | official API (set provider manually) |
| xAI | `xai` | `xai-` | Grok models |
| Together AI | `together` | — | huge catalog (set provider manually) |
| Fireworks | `fireworks` | `fw_` | fast serving of open models |
| SambaNova | `sambanova` | — | fast open-model inference |
| Hugging Face | `huggingface` | `hf_` | router to many hosted models |
| Ollama | `ollama` | none | local models — no key, no cloud |
| Custom | `custom` | any | any OpenAI-compatible endpoint |

Ambiguous `sk-` keys (DeepSeek vs OpenAI) prompt interactively. Custom endpoint:

```bash
blitz provider custom
blitz config set customBaseUrl https://your-endpoint/v1
```

## Custom Providers & Plugins

Define endpoints in `config.json` under `customProviders`, or drop a plugin file in `providers/` — adding a provider never requires touching the router:

```js
// providers/example.js
export const id = 'example';
export const name = 'Example';
export const baseUrl = 'https://api.example.com/v1';
export const defaultModel = 'example-large';
export const requiresKey = true;
```

Drop it in `providers/`, restart, done. Full guide: [PROVIDERS.md](PROVIDERS.md).

## Configuration

`config.json` (auto-created, no secrets) + environment overrides as input only:

| Variable | Effect |
|---|---|
| `API_KEY` | overrides the keyring for the active provider (power users) |
| `PROVIDER` / `MODEL` | override provider/model selection |
| `PROXY_PORT` / `BLITZ_HOST` | override port / bind host |
| `TIMEOUT` | override provider timeouts |
| `PRIVACY=true` | same as `blitz privacy` |

Common settings:

```bash
blitz config set fallbackOnAuthError true   # allow auth-failure failover BETWEEN providers
blitz config set requireAuth true           # token required for /v1/* too
blitz config set proxyPort 4818
```

## Development

```bash
npm test            # 231 tests, 16 suites — mocked providers behind real HTTP servers, no real keys
npm run lint        # syntax check over all sources
npm run dev         # watch-mode server
npm run test:live   # OPT-IN live tests — set BLITZ_LIVE_TESTS=1 first; uses your real provider
```

Live tests (Anthropic + OpenAI + Responses endpoints, streaming, tool calls, real credential validation) never run in CI, never print keys, and cost a few tokens. Test philosophy for the mocked suite: no real API keys, no fake assertions — mocked *upstream providers* behind real HTTP servers. Architecture deep-dive: [ARCHITECTURE.md](ARCHITECTURE.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands at a Glance

| Area | Commands |
|---|---|
| Run & agents | `blitz` · `blitz claude/opencode/codex/aider` · `blitz run <cmd>` · `blitz shell` · `blitz start/stop/restart/status` |
| Credentials | `blitz add` · `credentials` · `switch` · `rm` · `validate` |
| Models | `blitz model` · `models` · `models refresh` · `use <provider/model>` · `alias` |
| Routing | `blitz provider` · `auto` · `fallback` · `profile` |
| Insight & safety | `blitz health` · `stats` · `logs` · `dashboard` · `doctor` · `config validate` · `config` · `privacy` · `token` |

## License

MIT — see [LICENSE](LICENSE). Created by **Jenil Patel**.
