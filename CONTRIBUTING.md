# Contributing

Thanks for improving BlitzProxy!

## Ground Rules

- **Zero runtime dependencies** — use Node.js built-ins only. New platform features go through child processes (`powershell`/`security`/`secret-tool`), as the keyring does.
- **Local-first, privacy-first** — never add telemetry, analytics, or anything that sends data to a third party.
- **No secrets in code or tests** — keys in tests must be obvious fakes (`test-key-aaaa`), never real material.
- **Preserve backwards compatibility** — v1 CLI verbs keep working. Breaking changes need a CHANGELOG entry and a migration path.
- **Honest feature claims** — don't mark a provider as supported until its adapter is implemented and exercised by tests (mocked upstream is fine; untested code is not).

## Development Setup

```bash
git clone https://github.com/jenil0528/blitz-proxy
cd blitz-proxy
npm test          # 184+ tests across 13 suites
npm run lint      # syntax check
```

Node.js 18+ required. No install step.

## Before You Submit

1. `npm run lint` passes.
2. `npm test` passes — including on the oldest supported Node (18).
3. New behavior has tests. Bug fixes include a test that fails without the fix.
4. No secrets, logs of prompts, or new network destinations.
5. Docs updated if you touched commands, endpoints, or providers (README, ARCHITECTURE, PROVIDERS).

## Adding a Provider

See [PROVIDERS.md](PROVIDERS.md). Prefer a plugin under `providers/` over editing the catalog when the provider is niche; prefer the catalog for well-known providers with curated capability metadata.

## Adding a CLI Command

`cli.js` uses a dispatch switch — add your case, implement `cmdXxx`, and document it in `cmdHelp()` and README. Commands that change config call `saveConfig()`; commands that need the server use `ensureServer()`.

## Test Conventions

- Each suite is an isolated process (`test/index.js` runs them one by one).
- Suites set `BLITZ_HOME` / `BLITZ_CONFIG` to temp dirs and `BLITZ_KEYRING` to `memory` or `file` **before** importing modules.
- Integration tests speak to real HTTP servers (the mock provider) — no monkey-patched fetches.
- Never gate tests on real API keys or live provider behavior.

## Reporting Bugs

Open an issue with: your OS, Node version, `blitz doctor` output, and the relevant `blitz.log` lines (redact anything sensitive — the logger already masks keys, but double-check).

## License

By contributing you agree your work is released under the project's [MIT license](LICENSE).
