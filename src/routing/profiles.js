// ============================================================================
// BlitzProxy — Routing Profiles
// Profiles are named provider/model chains: coding, fast, free, local,
// plus user-defined profiles in config.
// ============================================================================

export const BUILT_IN_PROFILES = {
  coding: {
    description: 'Strong coding models with tool calling, big context first',
    chain: ['nvidia', 'deepseek', 'openrouter', 'groq'],
    tags: ['coding'],
  },
  fast: {
    description: 'Lowest-latency providers first',
    chain: ['groq', 'cerebras'],
    tags: ['fast'],
  },
  free: {
    description: 'Free tiers and free models first',
    chain: ['openrouter', 'groq', 'nvidia', 'github'],
    tags: ['free'],
  },
  local: {
    description: 'Local models only — never contacts cloud providers',
    chain: ['ollama'],
    tags: ['local'],
    localOnly: true,
  },
};

/**
 * Parse a chain entry: either 'provider' or 'provider/model-id'
 * (model ids may contain slashes themselves, e.g. nvidia/meta/llama-...).
 */
export function parseChainEntry(entry, knownProviderIds = []) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const trimmed = entry.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0) {
    const candidate = trimmed.slice(0, slashIdx);
    if (knownProviderIds.includes(candidate)) {
      return { provider: candidate, model: trimmed.slice(slashIdx + 1) };
    }
  }
  return { provider: trimmed, model: '' };
}

/**
 * Get a profile definition (built-in or user-defined from config).
 */
export function getProfile(name, cfg = {}) {
  if (!name) return null;
  if (BUILT_IN_PROFILES[name]) {
    return { name, ...BUILT_IN_PROFILES[name], builtIn: true };
  }
  const user = cfg.profiles?.[name];
  if (user) {
    return {
      name,
      description: user.description || 'User profile',
      chain: Array.isArray(user.chain) ? user.chain : [],
      tags: user.tags || [],
      localOnly: user.localOnly === true,
      builtIn: false,
    };
  }
  return null;
}

export function listProfiles(cfg = {}) {
  const all = [];
  for (const [name, p] of Object.entries(BUILT_IN_PROFILES)) {
    all.push({ name, ...p, builtIn: true });
  }
  for (const [name, p] of Object.entries(cfg.profiles || {})) {
    all.push({
      name,
      description: p.description || 'User profile',
      chain: Array.isArray(p.chain) ? p.chain : [],
      tags: p.tags || [],
      localOnly: p.localOnly === true,
      builtIn: false,
    });
  }
  return all;
}

/**
 * Resolve a profile to an ordered candidate list of { provider, model }.
 * Entries for unknown providers are dropped with a reason recorded.
 */
export function resolveProfileChain(name, cfg, knownProviderIds) {
  const profile = getProfile(name, cfg);
  if (!profile) return { ok: false, error: `Unknown profile: ${name}`, candidates: [] };

  const candidates = [];
  const skipped = [];
  for (const entry of profile.chain) {
    const parsed = parseChainEntry(entry, knownProviderIds);
    if (!parsed) continue;
    if (!knownProviderIds.includes(parsed.provider)) {
      skipped.push(`${entry} (unknown provider)`);
      continue;
    }
    candidates.push(parsed);
  }
  return { ok: true, profile, candidates, skipped };
}
