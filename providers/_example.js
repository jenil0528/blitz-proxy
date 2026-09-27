// ============================================================================
// BlitzProxy — Provider Plugin Template
// Copy this file, rename it (e.g. my-provider.js), and fill in your values.
// Files starting with "_" are ignored by the plugin loader, so this
// template never registers itself.
//
// Full documentation: PROVIDERS.md
// ============================================================================

export const id = 'example';                       // unique provider id (lowercase)
export const name = 'Example Provider';           // display name
export const baseUrl = 'https://api.example.com/v1'; // OpenAI-compatible base URL
export const defaultModel = 'example-large';
export const keyPrefix = 'ex_';                   // optional: enables `blitz add` auto-detection
export const requiresKey = true;                   // false for local/no-auth endpoints
export const timeout = 120000;                     // request budget in ms
export const description = 'Any OpenAI-compatible endpoint';

// Optional: capability metadata powers capability-aware routing,
// `blitz model` display, and estimated costs.
export const models = {
  'example-large': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
  'example-mini':  { contextWindow: 32768,  tools: true, vision: false, reasoning: false, tags: ['fast'] },
};

// Optional: estimated USD per 1M tokens. Omit entries with unknown/dynamic
// pricing — BlitzProxy displays them as "n/a" instead of guessing.
export const pricing = {
  'example-large': { input: 0.5, output: 1.5 },
};

// Optional: override adapter behavior if your provider deviates from the
// OpenAI-compatible contract. Uncomment and adapt only what you need.
//
// export async function chat({ def, key, body, timeoutMs, extraHeaders }) {
//   // Must return a fetch-like Response: .ok, .status, .text(), .json(), .body
//   return fetch(`${def.baseUrl}/chat/completions`, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       ...(key ? { Authorization: `Bearer ${key}` } : {}),
//       ...extraHeaders,
//     },
//     body: JSON.stringify(body),
//     signal: AbortSignal.timeout(timeoutMs),
//   });
// }
//
// export async function listModels({ def, key }) { /* → string[] */ }
// export async function validateKey({ def, key }) { /* → { valid, status, message } */ }
// export async function healthCheck({ def, key }) { /* → { status, latencyMs } */ }
