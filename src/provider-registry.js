// ============================================================================
// BlitzProxy — Provider Registry & Adapters
// A clean provider interface:
//   adapter.validateKey(key)  adapter.healthCheck(key)  adapter.listModels(key)
//   adapter.chat({ key, body, timeoutMs, extraHeaders })
// Providers are resolved from: built-in catalog → config.customProviders →
// user plugins (providers/*.js in the project dir or BLITZ_HOME).
// Adding a provider never requires touching the router.
// ============================================================================

import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { PROVIDERS } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const plugins = new Map();   // id → { def, adapter? }

// ─── OpenAI-compatible adapter (shared by nearly all providers) ─────────────

function buildHeaders(def, key, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(def.headers || {}),
    ...extra,
  };
  if (key && def.requiresKey !== false && def.id !== 'ollama') {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

function normalizeBaseUrl(def) {
  let url = def.baseUrl || '';
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Confirm a key by making a minimal real inference request. Some /models
 * endpoints are anonymous (NVIDIA answers 200 for any Bearer token), so this
 * is the only authoritative check that a key actually authorizes requests.
 * Costs at most a single token of quota — only used for explicit validation.
 */
async function confirmKeyByInference(def, key) {
  const url = `${normalizeBaseUrl(def)}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(def, key),
      body: JSON.stringify({
        model: def.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return { valid: true, status: 'ok', message: 'Key accepted — verified with a real request' };
    if (res.status === 401 || res.status === 403) {
      let detail = '';
      try {
        const body = JSON.parse(await res.text());
        detail = body?.detail || body?.error?.message || '';
      } catch { /* non-JSON body */ }
      return {
        valid: false,
        status: 'auth-failed',
        message: `Provider rejected the key on a real request (HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 120)}` : ''})`,
      };
    }
    if (res.status === 402) {
      return { valid: false, status: 'billing', message: 'Key authenticated but provider returned HTTP 402 — payment/credits required' };
    }
    if (res.status === 429) {
      return { valid: true, status: 'rate-limited', message: 'Key valid but rate-limited right now' };
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      // Providers authenticate before validating the request body — a 4xx
      // other than 401/402/403 means the key itself was accepted.
      return { valid: true, status: 'ok', message: `Key accepted (auth passed; probe returned HTTP ${res.status})` };
    }
    return { valid: null, status: 'unknown', message: `Inference probe returned HTTP ${res.status} — cannot confirm key` };
  } catch (err) {
    return { valid: null, status: 'unreachable', message: `Models reachable, but inference probe failed: ${err.message}` };
  }
}

export const openAICompatAdapter = {
  buildHeaders,

  async chat({ def, key, body, timeoutMs, extraHeaders }) {
    const url = `${normalizeBaseUrl(def)}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs || def.timeout || 120000);
    timer.unref?.();
    try {
      return await fetch(url, {
        method: 'POST',
        headers: buildHeaders(def, key, extraHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      // Cleared by caller via response.__blitzTimers when body is consumed
      if (controller.signal.aborted) clearTimeout(timer);
      // attach for post-consumption cleanup
    }
  },

  async listModels({ def, key }) {
    const url = `${normalizeBaseUrl(def)}/models`;
    const res = await fetch(url, {
      headers: buildHeaders(def, key),
      signal: AbortSignal.timeout(Math.min(def.timeout || 120000, 15000)),
    });
    if (!res.ok) throw Object.assign(new Error(`models: HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    return (data.data || []).map(m => m.id).filter(Boolean);
  },

  async validateKey({ def, key }) {
    if (def.requiresKey === false && !key) {
      return { valid: true, status: 'ok', message: 'No key required' };
    }
    if (!key) return { valid: false, status: 'no-key', message: 'No API key configured' };
    const url = `${normalizeBaseUrl(def)}/models`;
    try {
      const res = await fetch(url, {
        headers: buildHeaders(def, key),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401 || res.status === 403) {
        return { valid: false, status: 'auth-failed', message: `Provider rejected the key (HTTP ${res.status})` };
      }
      if (res.status === 429) {
        return { valid: true, status: 'rate-limited', message: 'Key valid but rate-limited right now' };
      }
      if (!res.ok) {
        return { valid: null, status: 'unknown', message: `Provider returned HTTP ${res.status} — cannot confirm key` };
      }
      // /models answered 200 — but some providers (e.g. NVIDIA) serve the
      // models list anonymously, so that alone proves nothing about the key.
      // Confirm with a minimal real inference request instead.
      if (!def.defaultModel) {
        return { valid: true, status: 'ok', message: 'Endpoint reachable (no model configured for a deeper probe)' };
      }
      return await confirmKeyByInference(def, key);
    } catch (err) {
      return { valid: null, status: 'unreachable', message: `Could not reach provider: ${err.message}` };
    }
  },

  async healthCheck({ def, key, deep = false }) {
    const started = Date.now();
    const url = `${normalizeBaseUrl(def)}/models`;
    try {
      const res = await fetch(url, {
        headers: buildHeaders(def, key),
        signal: AbortSignal.timeout(10000),
      });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        // Anonymous /models endpoints (e.g. NVIDIA's) report "online" even
        // with a dead key. A deep check — explicit user action only —
        // confirms with a minimal real request.
        if (deep && key && def.defaultModel && def.requiresKey !== false) {
          const v = await confirmKeyByInference(def, key);
          if (v.valid === false) {
            const status = v.status === 'billing' ? 'unavailable' : 'auth-failed';
            return { status, latencyMs, httpStatus: 401, message: v.message };
          }
        }
        return { status: latencyMs > 5000 ? 'degraded' : 'online', latencyMs, httpStatus: 200 };
      }
      if (res.status === 401 || res.status === 403) return { status: 'auth-failed', latencyMs, httpStatus: res.status };
      if (res.status === 429) return { status: 'rate-limited', latencyMs, httpStatus: 429 };
      return { status: 'unavailable', latencyMs, httpStatus: res.status };
    } catch (err) {
      return { status: 'offline', latencyMs: Date.now() - started, message: err.message };
    }
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Resolve a provider definition:
 *   built-in catalog → config customProviders → plugins
 * Returns null when the id is unknown.
 */
export function resolveProvider(providerId, cfg = {}) {
  if (PROVIDERS[providerId]) return PROVIDERS[providerId];

  const custom = cfg.customProviders?.[providerId];
  if (custom) {
    return {
      id: providerId,
      name: custom.name || providerId,
      baseUrl: custom.baseUrl,
      api: 'openai-compat',
      defaultModel: custom.defaultModel || '',
      keyPrefix: custom.keyPrefix || '',
      requiresKey: custom.requiresKey !== false,
      timeout: custom.timeout || 120000,
      headers: custom.headers || {},
      description: custom.description || 'User-defined endpoint',
      models: custom.models || {},
      pricing: custom.pricing || {},
    };
  }

  const plugin = plugins.get(providerId);
  if (plugin) return plugin.def;

  return null;
}

/**
 * Get the adapter for a provider definition.
 * Plugins may export custom adapter functions; everything else uses the
 * shared OpenAI-compatible adapter.
 */
export function getAdapter(def) {
  const plugin = plugins.get(def.id);
  if (plugin?.adapter) {
    const a = plugin.adapter;
    return {
      chat: a.chat ? (args) => a.chat({ ...args, def }) : (args) => openAICompatAdapter.chat({ ...args, def }),
      listModels: a.listModels ? (args) => a.listModels({ ...args, def }) : (args) => openAICompatAdapter.listModels({ ...args, def }),
      validateKey: a.validateKey ? (args) => a.validateKey({ ...args, def }) : (args) => openAICompatAdapter.validateKey({ ...args, def }),
      healthCheck: a.healthCheck ? (args) => a.healthCheck({ ...args, def }) : (args) => openAICompatAdapter.healthCheck({ ...args, def }),
    };
  }
  return {
    chat: (args) => openAICompatAdapter.chat({ ...args, def }),
    listModels: (args) => openAICompatAdapter.listModels({ ...args, def }),
    validateKey: (args) => openAICompatAdapter.validateKey({ ...args, def }),
    healthCheck: (args) => openAICompatAdapter.healthCheck({ ...args, def }),
  };
}

// ─── Plugin loading ───────────────────────────────────────────────────────────

/**
 * Load user provider plugins from `providers/` directories.
 * A plugin is an ESM module exporting a provider definition
 * (and optionally custom adapter functions). See PROVIDERS.md.
 *
 *   // providers/example.js
 *   export const id = 'example';
 *   export const name = 'Example';
 *   export const baseUrl = 'https://api.example.com/v1';
 *   export const defaultModel = 'example-model';
 *   export const requiresKey = true;
 *   export const timeout = 120000;
 */
export async function loadPlugins(projectDir, homeDir) {
  const dirs = [];
  if (projectDir) dirs.push(join(projectDir, 'providers'));
  if (homeDir) dirs.push(join(homeDir, 'providers'));

  const loaded = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_'));
    } catch { continue; }
    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(join(dir, file)).href);
        const raw = mod.default && mod.default.id ? mod.default : mod;
        const def = {
          id: raw.id || file.replace(/\.js$/, ''),
          name: raw.name || raw.id,
          baseUrl: raw.baseUrl,
          api: raw.api || 'openai-compat',
          defaultModel: raw.defaultModel || '',
          keyPrefix: raw.keyPrefix || '',
          requiresKey: raw.requiresKey !== false,
          timeout: raw.timeout || 120000,
          headers: raw.headers || {},
          description: raw.description || 'User plugin',
          models: raw.models || {},
          pricing: raw.pricing || {},
        };
        if (!def.baseUrl) throw new Error('plugin missing baseUrl');
        const adapterFns = {};
        for (const fn of ['chat', 'listModels', 'validateKey', 'healthCheck']) {
          if (typeof raw[fn] === 'function') adapterFns[fn] = raw[fn];
        }
        plugins.set(def.id, { def, adapter: Object.keys(adapterFns).length > 0 ? adapterFns : null });
        loaded.push(def.id);
      } catch (err) {
        console.warn(`[Registry] ⚠ Failed to load plugin ${file}: ${err.message}`);
      }
    }
  }
  return loaded;
}

export function listPluginIds() {
  return [...plugins.keys()];
}

/**
 * All resolvable provider ids for a given config.
 */
export function allProviderIds(cfg = {}) {
  const ids = new Set(Object.keys(PROVIDERS));
  for (const id of Object.keys(cfg.customProviders || {})) ids.add(id);
  for (const id of plugins.keys()) ids.add(id);
  return [...ids];
}
