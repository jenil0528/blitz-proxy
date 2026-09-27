# Providers

## Supported Providers

| Provider | Base URL | Key Prefix | Notes |
|---|---|---|---|
| NVIDIA NIM | `integrate.api.nvidia.com/v1` | `nvapi-` | 300s timeout (serverless cold starts) |
| Groq | `api.groq.com/openai/v1` | `gsk_` | fastest; 30s timeout |
| OpenRouter | `openrouter.ai/api/v1` | `sk-or-` | attribution headers; `:free` models priced at $0 |
| DeepSeek | `api.deepseek.com/v1` | `sk-` ⚠ | shares `sk-` with OpenAI → interactive prompt |
| OpenAI | `api.openai.com/v1` | `sk-` ⚠ | dynamic pricing → cost shown as `n/a` |
| Google Gemini | `generativelanguage.googleapis.com/v1beta/openai` | `AIza` | via Google's OpenAI-compatible endpoint |
| Mistral | `api.mistral.ai/v1` | — | set provider manually |
| Cerebras | `api.cerebras.ai/v1` | `csk-` | |
| Together AI | `api.together.xyz/v1` | — | set provider manually |
| Fireworks AI | `api.fireworks.ai/inference/v1` | `fw_` | |
| SambaNova | `api.sambanova.ai/v1` | — | set provider manually |
| xAI | `api.x.ai/v1` | `xai-` | |
| GitHub Models | `models.github.ai/inference` | `github_pat_` | |
| Hugging Face | `router.huggingface.co/v1` | `hf_` | |
| Ollama | `127.0.0.1:11434/v1` | — | local, no key, 600s timeout |
| Custom | your endpoint | — | `blitz config set customBaseUrl …` |

All providers use the shared **OpenAI-compatible adapter**. That claim is honest: each provider listed speaks the `/chat/completions` + `/models` shape that the adapter exercises. Providers whose model catalogs drift can be listed live via `blitz model --live`.

## Capability Metadata

Each catalog model may define:

```js
'meta/llama-3.3-70b-instruct': {
  contextWindow: 131072,   // tokens
  tools: true,             // function/tool calling
  vision: false,           // image input
  reasoning: false,        // reasoning/thinking output
  tags: ['coding'],        // coding | fast | free | vision | reasoning
}
```

The router skips models that cannot satisfy a request **when an alternative exists** (e.g. no tool support while Claude Code sends tool definitions). Unknown models are treated permissively — the provider fails loudly instead of the router guessing.

## Pricing (Estimates)

`pricing` entries are USD per 1M tokens and **estimates only** — displayed as `≈$` and labeled `costIsEstimate` in the API. Free tiers are `0`. Unknown or dynamic pricing is **omitted** and displayed as `n/a`; it is never guessed. Override pricing by editing the catalog or a plugin.

## Writing a Plugin

A plugin is an ESM file exporting a provider definition. Drop it in `providers/` (project root or `~/.blitzproxy/providers/`), restart, done — the router and CLI pick it up automatically.

```js
// providers/example.js — minimal
export const id = 'example';
export const name = 'Example';
export const baseUrl = 'https://api.example.com/v1';
export const defaultModel = 'example-large';
export const requiresKey = true;          // default true
export const timeout = 120000;            // default 120000
```

```js
// providers/example-full.js — with metadata
export const id = 'example';
export const name = 'Example';
export const baseUrl = 'https://api.example.com/v1';
export const keyPrefix = 'ex_';           // enables prefix auto-detection
export const defaultModel = 'example-large';
export const timeout = 60000;
export const models = {
  'example-large': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
  'example-mini':  { contextWindow: 32768,  tools: true, vision: false, reasoning: false, tags: ['fast'] },
};
export const pricing = { 'example-large': { input: 0.5, output: 1.5 } }; // estimates
```

### Custom adapter behavior

By default plugins use the shared OpenAI-compatible adapter. Override only what differs:

```js
export const id = 'weird';
export const baseUrl = 'https://api.weird.ai';
export const defaultModel = 'weird-1';

export async function chat({ def, key, body, timeoutMs }) {
  const res = await fetch(`${def.baseUrl}/completions`, {
    method: 'POST',
    headers: { 'X-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res; // must behave like fetch Response (ok/status/body/text/json)
}
```

Overridable adapter functions: `chat({def, key, body, timeoutMs, extraHeaders}) → Response`, `listModels({def, key}) → string[]`, `validateKey({def, key}) → {valid, status, message}`, `healthCheck({def, key}) → {status, latencyMs}`.

### Adapter Contract

- `chat` must return a standard `Response`-like object (`.ok`, `.status`, `.text()`, `.json()`, `.body` stream). Streaming responses must carry SSE chunks on `.body`.
- Non-OK responses are classified by the router (status + body text) — no adapter-side error handling required.
- Never log or persist `key` inside an adapter.

### Config-defined providers

For simple endpoints without a plugin file, add to `config.json`:

```json
"customProviders": {
  "lmstudio": {
    "name": "LM Studio",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "defaultModel": "qwen2.5-72b",
    "requiresKey": false,
    "timeout": 120000,
    "models": { "qwen2.5-72b": { "contextWindow": 32768, "tools": true, "vision": false, "reasoning": false, "tags": [] } }
  }
}
```

## Testing Your Plugin

The test-suite's mock providers (`test/helpers/mock-provider.js`) are config-defined providers speaking plain OpenAI — the same mechanism your plugin uses. Point a `customProviders` entry at a mock and reuse the integration suite pattern to verify translation, fallback, and auth behavior end-to-end.
