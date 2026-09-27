// ============================================================================
// BlitzProxy — Provider Catalog
// Static definitions for supported OpenAI-compatible providers.
// Each model may carry capability metadata + estimated pricing (per 1M tokens).
//
// IMPORTANT: pricing values are ESTIMATES for cost display only.
// Models without a pricing entry are shown as "n/a" — never guessed.
// ============================================================================

export const PROVIDERS = {
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    api: 'openai-compat',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    keyPrefix: 'nvapi-',
    requiresKey: true,
    timeout: 300000,
    headers: {},
    description: 'Free credits on signup at build.nvidia.com',
    // Catalog refreshed from the live /models list (2026-09-24).
    // tool calling live-verified on the default model and z-ai/glm-5.3.
    // Completion-style code models are marked tools:false.
    models: {
      'nvidia/nemotron-3-super-120b-a12b': { tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'nvidia/nemotron-3-ultra-550b-a55b': { tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'nvidia/nemotron-3.5-lightning-30b-a3b': { tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { tools: true, vision: true, reasoning: true, tags: ['reasoning', 'fast'] },
      'nvidia/llama-3.1-nemotron-70b-instruct': { tools: true, vision: false, reasoning: false, tags: [] },
      'nvidia/llama-3.1-nemotron-51b-instruct': { tools: true, vision: false, reasoning: false, tags: [] },
      'z-ai/glm-5.3': { tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'z-ai/glm-5.3-flash': { tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'moonshotai/kimi-k3': { tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'deepseek-ai/deepseek-v4.1-flash': { tools: true, vision: false, reasoning: false, tags: ['coding', 'fast'] },
      'openai/gpt-oss-20b': { tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'mistralai/mistral-large-2-instruct': { tools: true, vision: false, reasoning: false, tags: [] },
      'mistralai/mistral-nemotron': { tools: true, vision: false, reasoning: false, tags: [] },
      'meta/llama-3.2-90b-vision-instruct': { tools: true, vision: true, reasoning: false, tags: ['vision'] },
      'meta/llama-3.2-11b-vision-instruct': { tools: true, vision: true, reasoning: false, tags: ['vision', 'fast'] },
      'meta/llama3-chatqa-1.5-70b': { tools: true, vision: false, reasoning: false, tags: [] },
      'google/gemma-3-12b-it': { tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'google/gemma-3-4b-it': { tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'meta/codellama-70b': { tools: false, vision: false, reasoning: false, tags: ['coding'] },
      'mistralai/codestral-22b-instruct-v0.1': { tools: false, vision: false, reasoning: false, tags: ['coding'] },
      'ibm/granite-34b-code-instruct': { tools: false, vision: false, reasoning: false, tags: ['coding'] },
      'bigcode/starcoder2-15b': { tools: false, vision: false, reasoning: false, tags: ['coding'] },
    },
    pricing: {
      'nvidia/nemotron-3-super-120b-a12b': { input: 0, output: 0 },
      'z-ai/glm-5.3': { input: 0, output: 0 },
    },
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai-compat',
    defaultModel: 'llama-3.3-70b-versatile',
    keyPrefix: 'gsk_',
    requiresKey: true,
    timeout: 30000,
    headers: {},
    description: 'Ultra-fast inference, generous free tier',
    models: {
      'llama-3.3-70b-versatile': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding', 'fast'] },
      'llama-3.1-70b-versatile': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'llama-3.1-8b-instant': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'gemma2-9b-it': { contextWindow: 8192, tools: false, vision: false, reasoning: false, tags: ['fast'] },
      'deepseek-r1-distill-llama-70b': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['reasoning'] },
      'qwen-qwq-32b': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['reasoning'] },
    },
    pricing: {
      'llama-3.3-70b-versatile': { input: 0, output: 0 },
      'llama-3.1-8b-instant': { input: 0, output: 0 },
    },
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-compat',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyPrefix: 'sk-or-',
    requiresKey: true,
    timeout: 120000,
    headers: { 'HTTP-Referer': 'https://blitzproxy.local', 'X-Title': 'BlitzProxy' },
    description: 'Gateway to 200+ models, many free options',
    models: {
      'meta-llama/llama-3.3-70b-instruct:free': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['free', 'coding'] },
      'meta-llama/llama-3.1-405b-instruct:free': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['free'] },
      'qwen/qwen-2.5-72b-instruct:free': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['free'] },
      'deepseek/deepseek-chat-v3-0324:free': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['free', 'coding'] },
      'google/gemini-2.0-flash-exp:free': { contextWindow: 1048576, tools: true, vision: true, reasoning: false, tags: ['free', 'vision'] },
      'google/gemini-2.5-pro-exp-03-25:free': { contextWindow: 1048576, tools: true, vision: true, reasoning: true, tags: ['free', 'vision'] },
      'mistralai/mistral-large-2411': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
    },
    pricing: {
      'meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },
      'deepseek/deepseek-chat-v3-0324:free': { input: 0, output: 0 },
      'google/gemini-2.0-flash-exp:free': { input: 0, output: 0 },
    },
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-compat',
    defaultModel: 'deepseek-chat',
    keyPrefix: 'sk-',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Extremely affordable, strong coding models',
    models: {
      'deepseek-chat': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'deepseek-reasoner': { contextWindow: 65536, tools: true, vision: false, reasoning: true, tags: ['coding', 'reasoning'] },
      'deepseek-coder': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'deepseek-v4-pro': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['coding'] },
    },
    pricing: {
      'deepseek-chat': { input: 0.27, output: 1.10 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 },
    },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-compat',
    defaultModel: 'gpt-4o',
    keyPrefix: 'sk-',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'OpenAI official API (dynamic pricing — cost shown as n/a)',
    models: {
      'gpt-4o': { contextWindow: 128000, tools: true, vision: true, reasoning: false, tags: ['coding', 'vision'] },
      'gpt-4o-mini': { contextWindow: 128000, tools: true, vision: true, reasoning: false, tags: ['fast', 'vision'] },
      'gpt-4-turbo': { contextWindow: 128000, tools: true, vision: true, reasoning: false, tags: [] },
      'gpt-4': { contextWindow: 8192, tools: true, vision: false, reasoning: false, tags: [] },
      'gpt-3.5-turbo': { contextWindow: 16385, tools: true, vision: false, reasoning: false, tags: [] },
      'o1-preview': { contextWindow: 128000, tools: false, vision: false, reasoning: true, tags: ['reasoning'] },
      'o1-mini': { contextWindow: 128000, tools: false, vision: false, reasoning: true, tags: ['reasoning'] },
    },
    pricing: {},
  },

  github: {
    id: 'github',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    api: 'openai-compat',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    keyPrefix: 'github_pat_',
    requiresKey: true,
    timeout: 60000,
    headers: {},
    description: 'Free with GitHub account',
    models: {
      'Meta-Llama-3.3-70B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'Meta-Llama-3.1-405B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'Mistral-Large-2411': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'gpt-4o': { contextWindow: 128000, tools: true, vision: true, reasoning: false, tags: [] },
      'DeepSeek-R1': { contextWindow: 65536, tools: true, vision: false, reasoning: true, tags: ['reasoning'] },
    },
    pricing: {
      'Meta-Llama-3.3-70B-Instruct': { input: 0, output: 0 },
    },
  },

  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    api: 'openai-compat',
    defaultModel: 'llama-3.3-70b',
    keyPrefix: 'csk-',
    requiresKey: true,
    timeout: 30000,
    headers: {},
    description: 'Blazing fast inference',
    models: {
      'llama-3.3-70b': { contextWindow: 128000, tools: true, vision: false, reasoning: false, tags: ['coding', 'fast'] },
      'llama-3.1-70b': { contextWindow: 128000, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'llama-3.1-8b': { contextWindow: 128000, tools: true, vision: false, reasoning: false, tags: ['fast'] },
    },
    pricing: {
      'llama-3.3-70b': { input: 0, output: 0 },
    },
  },

  mistral: {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai-compat',
    defaultModel: 'mistral-large-latest',
    keyPrefix: '',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Mistral official API (set provider manually)',
    models: {
      'mistral-large-latest': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'mistral-small-latest': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'codestral-latest': { contextWindow: 262144, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'ministral-8b-latest': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
    },
    pricing: {},
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api: 'openai-compat',
    defaultModel: 'gemini-2.5-flash',
    keyPrefix: 'AIza',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Gemini via its OpenAI-compatible endpoint',
    models: {
      'gemini-2.5-pro': { contextWindow: 1048576, tools: true, vision: true, reasoning: true, tags: ['coding', 'vision'] },
      'gemini-2.5-flash': { contextWindow: 1048576, tools: true, vision: true, reasoning: true, tags: ['fast', 'vision'] },
      'gemini-2.0-flash': { contextWindow: 1048576, tools: true, vision: true, reasoning: false, tags: ['fast', 'vision'] },
    },
    pricing: {
      'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    },
  },

  xai: {
    id: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    api: 'openai-compat',
    defaultModel: 'grok-3',
    keyPrefix: 'xai-',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Grok models from xAI',
    models: {
      'grok-3': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['coding'] },
      'grok-3-mini': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['fast'] },
      'grok-2-1212': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
    },
    pricing: {},
  },

  together: {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    api: 'openai-compat',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyPrefix: '',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Signup credits, huge model catalog (set provider manually)',
    models: {
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'Qwen/Qwen2.5-72B-Instruct-Turbo': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: [] },
      'Qwen/Qwen2.5-Coder-32B-Instruct': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'deepseek-ai/DeepSeek-V3': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'mistralai/Mixtral-8x22B-Instruct-v0.1': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: [] },
    },
    pricing: {},
  },

  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    api: 'openai-compat',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    keyPrefix: 'fw_',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Fast serving of open models',
    models: {
      'accounts/fireworks/models/llama-v3p3-70b-instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'accounts/fireworks/models/deepseek-v3': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'accounts/fireworks/models/qwen2p5-coder-32b-instruct': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['coding'] },
    },
    pricing: {},
  },

  sambanova: {
    id: 'sambanova',
    name: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    api: 'openai-compat',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    keyPrefix: '',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'Fast open-model inference (set provider manually)',
    models: {
      'Meta-Llama-3.3-70B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'Meta-Llama-3.1-8B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
    },
    pricing: {},
  },

  huggingface: {
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    api: 'openai-compat',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    keyPrefix: 'hf_',
    requiresKey: true,
    timeout: 120000,
    headers: {},
    description: 'HF Inference Providers router, massive model library',
    models: {
      'meta-llama/Llama-3.3-70B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'meta-llama/Meta-Llama-3.1-70B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'meta-llama/Meta-Llama-3.1-8B-Instruct': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'Qwen/Qwen2.5-72B-Instruct': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: [] },
      'Qwen/Qwen2.5-Coder-32B-Instruct': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'mistralai/Mistral-Large-Instruct-2411': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'mistralai/Mixtral-8x22B-Instruct-v0.1': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: [] },
      'bigcode/starcoder2-15b': { contextWindow: 16384, tools: false, vision: false, reasoning: false, tags: ['coding'] },
      'NousResearch/Hermes-3-Llama-3.1-8B': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: [] },
      'deepseek-ai/DeepSeek-Coder-V2-Instruct': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: ['coding'] },
    },
    pricing: {},
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-compat',
    defaultModel: 'llama3.3:latest',
    keyPrefix: '',
    requiresKey: false,
    timeout: 600000,
    headers: {},
    description: 'Run models locally — no API key needed',
    supportsAutoDetect: true,
    isLocal: true,
    models: {
      'llama3.3:latest': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'llama3.1:8b': { contextWindow: 131072, tools: true, vision: false, reasoning: false, tags: ['fast'] },
      'qwen2.5-coder:32b': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'qwen2.5-coder:latest': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'qwen2.5:latest': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: [] },
      'deepseek-coder-v2:latest': { contextWindow: 128000, tools: true, vision: false, reasoning: false, tags: ['coding'] },
      'deepseek-r1:latest': { contextWindow: 131072, tools: true, vision: false, reasoning: true, tags: ['reasoning'] },
      'mixtral:latest': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: [] },
      'codellama:latest': { contextWindow: 16384, tools: false, vision: false, reasoning: false, tags: ['coding'] },
      'mistral:latest': { contextWindow: 32768, tools: true, vision: false, reasoning: false, tags: [] },
      'phi3:latest': { contextWindow: 131072, tools: false, vision: false, reasoning: false, tags: ['fast'] },
      'gemma2:latest': { contextWindow: 8192, tools: false, vision: false, reasoning: false, tags: ['fast'] },
      'command-r:latest': { contextWindow: 128000, tools: true, vision: false, reasoning: false, tags: [] },
      'llava:latest': { contextWindow: 131072, tools: false, vision: true, reasoning: false, tags: ['vision'] },
    },
    pricing: {
      'llama3.3:latest': { input: 0, output: 0 },
    },
  },

  custom: {
    id: 'custom',
    name: 'Custom Endpoint',
    baseUrl: '',
    api: 'openai-compat',
    defaultModel: '',
    keyPrefix: '',
    requiresKey: false,
    timeout: 120000,
    headers: {},
    description: 'Any OpenAI-compatible API endpoint',
    models: {},
    pricing: {},
  },
};

/**
 * Priority order for automatic routing (fast/free coding models first).
 */
export const PROVIDER_PRIORITY = [
  'groq', 'cerebras', 'nvidia', 'openrouter', 'deepseek', 'github',
  'gemini', 'mistral', 'together', 'huggingface', 'xai', 'openai',
  'fireworks', 'sambanova', 'ollama', 'custom',
];

// ─── Key prefix detection ────────────────────────────────────────────────────
// Ordered longest-prefix-first to avoid ambiguity (e.g. "sk-or-" before "sk-").

const KEY_PATTERNS = [
  { prefix: 'nvapi-',       provider: 'nvidia',      name: 'NVIDIA NIM' },
  { prefix: 'gsk_',         provider: 'groq',        name: 'Groq' },
  { prefix: 'sk-or-',       provider: 'openrouter',  name: 'OpenRouter' },
  { prefix: 'github_pat_',  provider: 'github',      name: 'GitHub Models' },
  { prefix: 'hf_',          provider: 'huggingface', name: 'Hugging Face' },
  { prefix: 'csk-',         provider: 'cerebras',    name: 'Cerebras' },
  { prefix: 'xai-',         provider: 'xai',         name: 'xAI' },
  { prefix: 'AIza',         provider: 'gemini',      name: 'Google Gemini' },
  { prefix: 'fw_',          provider: 'fireworks',   name: 'Fireworks AI' },
  // sk- is intentionally LAST and handled specially — DeepSeek and OpenAI share it
];

const SK_AMBIGUOUS_PROVIDERS = [
  { provider: 'deepseek', name: 'DeepSeek' },
  { provider: 'openai',   name: 'OpenAI' },
];

/**
 * Auto-detect provider from API key prefix.
 * Returns { provider, name, confidence } or null if no match.
 * A prefix is NEVER treated as proof that a key is valid — use validateKey().
 */
export function detectProviderFromKey(apiKey) {
  if (!apiKey || apiKey === 'ollama' || apiKey === 'none') {
    return { provider: 'ollama', name: 'Ollama (Local)', confidence: 'exact' };
  }
  for (const pattern of KEY_PATTERNS) {
    if (apiKey.startsWith(pattern.prefix)) {
      return { provider: pattern.provider, name: pattern.name, confidence: 'prefix' };
    }
  }
  if (apiKey.startsWith('sk-')) {
    return { provider: null, name: null, confidence: 'ambiguous', candidates: SK_AMBIGUOUS_PROVIDERS };
  }
  return null;
}

/**
 * Get provider by id, with fallback to custom.
 */
export function getProvider(key) {
  return PROVIDERS[key] || PROVIDERS.custom;
}

export function listProviderKeys() {
  return Object.keys(PROVIDERS);
}

// ─── Capability helpers ──────────────────────────────────────────────────────

/**
 * Metadata for a known model, or null when unknown
 * (unknown models are treated permissively by the router).
 */
export function findModelInfo(providerId, modelId) {
  const p = PROVIDERS[providerId];
  if (!p || !p.models) return null;
  const m = p.models[modelId];
  return m || null;
}

export function providerModelIds(providerId) {
  const p = PROVIDERS[providerId];
  return p && p.models ? Object.keys(p.models) : [];
}

/**
 * Best catalog model for a provider given the request needs.
 * Prefers: capability match → 'coding' tag → larger context window.
 */
export function bestModelFor(providerId, needs = {}) {
  const p = PROVIDERS[providerId];
  if (!p || !p.models) return p ? p.defaultModel : '';
  const ids = Object.keys(p.models);
  const scored = ids.map(id => {
    const m = p.models[id];
    let score = 0;
    if (needs.tools && m.tools) score += 4;
    if (needs.vision && m.vision) score += 4;
    if (needs.reasoning && m.reasoning) score += 2;
    if ((m.tags || []).includes('coding')) score += 2;
    if ((m.tags || []).includes('fast')) score += needs.fast ? 2 : 0;
    score += Math.min((m.contextWindow || 0) / 1000000, 1);
    return { id, score, m };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.length > 0 ? scored[0].id : p.defaultModel;
}

/**
 * Does a provider have any catalog model matching the needs?
 * Unknown catalog entries return true (permissive).
 */
export function providerCanSatisfy(providerId, needs = {}) {
  const p = PROVIDERS[providerId];
  if (!p) return true;
  const ids = Object.keys(p.models || {});
  if (ids.length === 0) return true;
  return ids.some(id => {
    const m = p.models[id];
    if (needs.tools && m.tools === false) return false;
    if (needs.vision && m.vision === false) return false;
    return true;
  });
}

// ─── Ollama local model detection ────────────────────────────────────────────

export async function detectOllamaModels(baseUrl = 'http://127.0.0.1:11434') {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

/**
 * Estimated USD cost for a request, or null when pricing is unknown.
 * Values are ESTIMATES ONLY — never treat as exact.
 */
export function estimateRequestCost(providerId, modelId, inputTokens, outputTokens) {
  const p = PROVIDERS[providerId];
  if (!p || !p.pricing) return null;
  const price = p.pricing[modelId];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
