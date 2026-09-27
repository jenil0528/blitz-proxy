# Security Policy

## Design Principles

1. **Local-first** — the proxy binds `127.0.0.1` by default. LAN exposure is an explicit opt-in.
2. **Keys are secrets** — stored in OS secure storage, masked in every display, redacted from every log.
3. **No telemetry** — there is no analytics or tracking code in this project. Nothing phones home.
4. **Prompts are yours** — request/response content is never written to disk. Logs contain metadata only.
5. **Fail loudly, not silently** — auth errors and invalid requests never trigger silent failover.

## Key Storage

| Platform | Mechanism |
|---|---|
| Windows | DPAPI (`ProtectedData`, CurrentUser scope) via PowerShell — encrypted vault at `~/.blitzproxy/keys.bin` |
| macOS | Keychain (`security add-generic-password`) |
| Linux | Secret Service (`secret-tool`) |
| Fallback | `~/.blitzproxy/keys.json` with `0600` permissions + a loud warning at every start |

The vault holds one encrypted JSON blob containing keys and the local proxy token. Key material is never present in `config.json`, `.env`, or logs. Migration from v1 plaintext configs creates a timestamped backup and prints its path so you can delete it.

The fallback plaintext file is a **documented reduction in security**, used only when the OS store is unavailable (e.g., missing `secret-tool` on a headless Linux box). Its permissions are locked to the current user.

## Threat Model

**BlitzProxy deliberately blocks:**

- **LAN abuse** — binding to localhost by default; other machines cannot reach the proxy to spend your credits.
- **Drive-by browser requests** — no `Access-Control-Allow-Origin: *`; only same-machine browser origins are echoed. Combined with token-gated admin endpoints, malicious pages cannot read your config, keys, or stats.
- **Local process abuse of admin endpoints** — `/admin/*` and `/dashboard` always require the per-install random token (32 chars, generated once, stored in the keyring, compared with `timingSafeEqual`). `"blitz"` and other static strings are never tokens.
- **Secret leakage in logs** — every log line passes through `redactSecrets()`; keys are displayed only as `prefix-••••last4`.
- **Silent truncation** — a provider dying mid-stream produces an explicit `error` SSE event, never a fake-successful truncated answer.

**What BlitzProxy cannot protect against by design:**

- A malicious local process running as your user (it can read memory like any other process; use your OS's process isolation).
- The configured provider itself — your prompts necessarily go to the provider you chose, with your key. Fallback providers also see prompts when they serve a request. The `local` profile exists precisely so you can guarantee prompts never leave your machine.
- Compromise of your OS user account (the DPAPI/Keychain secrets are user-scoped).

## Transport & Routing

- Outbound requests go **only** to the provider endpoint resolved from the catalog, your `customProviders`, or your `customBaseUrl`. There is no other destination in the code.
- The OpenRouter adapter sends only the standard attribution headers (`HTTP-Referer`, `X-Title`) — never your key or request data.
- The proxy itself adds no headers containing secrets to responses.

## Reporting a Vulnerability

Please open a private security advisory on GitHub (Security → Advisories) or email the maintainer. Include reproduction steps. Please do not open a public issue for exploitable vulnerabilities.

## Hardening Checklist for Users

```powershell
blitz config set requireAuth true     # token required even for /v1/*
blitz privacy                          # no request log, no stats on disk
blitz config set host 127.0.0.1       # (this is the default — verify)
blitz validate nvidia                 # confirm keys are real, not guessed
```
