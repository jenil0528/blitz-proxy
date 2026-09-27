// ============================================================================
// BlitzProxy — Request Router
// Builds the ordered candidate chain for a request:
//   profile → auto (health + capability ranked) → active provider + fallback chain
// Providers without keys are skipped; capability mismatches are avoided
// unless no viable candidate remains (then surfaced as warnings, never silent).
// A provider with several stored keys yields one candidate per key, so a
// rejected key rotates to the next one before any provider failover happens.
// ============================================================================

import { PROVIDERS, PROVIDER_PRIORITY, getProvider, bestModelFor, findModelInfo } from '../providers.js';
import { resolveProvider, allProviderIds } from '../provider-registry.js';
import { modelSatisfies, contextHeadroom } from './capabilities.js';
import { resolveProfileChain } from './profiles.js';

/**
 * Resolve the active provider + key.
 * Precedence: env API_KEY (power-user input) → cfg.provider (explicit user
 * choice, single source of truth) → vault active key (blitz add/switch) → ollama.
 */
export async function resolveActiveProvider(cfg, keyring) {
  const envKey = process.env.API_KEY;
  if (envKey) {
    let providerId = cfg.provider || '';
    if (!providerId || !findModelInfo(providerId, cfg.model || '')) {
      const { detectProviderFromKey } = await import('../providers.js');
      const detected = detectProviderFromKey(envKey);
      if (detected && detected.confidence !== 'ambiguous') providerId = detected.provider;
      else if (!providerId) providerId = 'custom';
    }
    const def = resolveProvider(providerId, cfg) || getProvider('custom');
    const model = (cfg.model && providerOwnsModel(providerId, cfg.model, cfg)) ? cfg.model : def.defaultModel;
    return { providerId, def, key: envKey, model, source: 'env' };
  }

  // Explicit provider selection (`blitz provider X`) wins — the key for that
  // provider is looked up in the vault. Never silently substitute another
  // provider's key.
  const wanted = cfg.provider || '';
  if (wanted) {
    const def = resolveProvider(wanted, cfg) || getProvider('custom');
    let key = '';
    if (def.requiresKey !== false) {
      const entries = await keyring.keysForProvider(wanted);
      if (entries.length > 0) {
        const full = await keyring.getKeyById(entries[0].id);
        key = full?.key || '';
      }
    }
    const model = (cfg.model && providerOwnsModel(wanted, cfg.model, cfg)) ? cfg.model : (def.defaultModel || '');
    return { providerId: wanted, def, key, model, source: 'config' };
  }

  // No explicit provider → the vault's active key decides (blitz add / switch flow)
  const entry = await keyring.getActiveKey();
  if (entry) {
    const def = resolveProvider(entry.provider, cfg) || getProvider('custom');
    const model = entry.model || ((cfg.model && providerOwnsModel(entry.provider, cfg.model, cfg)) ? cfg.model : def.defaultModel);
    return { providerId: entry.provider, def, key: entry.key, model, source: 'vault' };
  }

  // No key at all → no-key providers (ollama / configured custom)
  const providerId = 'ollama';
  const def = PROVIDERS.ollama;
  return { providerId, def, key: '', model: def.defaultModel, source: 'default' };
}

function providerOwnsModel(providerId, modelId, cfg) {
  const def = resolveProvider(providerId, cfg);
  if (!def) return false;
  if (def.models && modelId in def.models) return true;
  // Custom endpoints accept any model string
  if (def.id === 'custom' && (cfg.customBaseUrl || cfg.customProviders?.custom)) return true;
  return false;
}

/**
 * Providers that can currently be used: have a key, or need none.
 */
export async function availableProviders(cfg, keyring) {
  const ids = allProviderIds(cfg);
  const out = [];
  for (const id of ids) {
    const def = resolveProvider(id, cfg);
    if (!def) continue;
    if (def.requiresKey === false) {
      if (id === 'custom' && !cfg.customBaseUrl && !cfg.customProviders?.custom) continue;
      out.push(id);
      continue;
    }
    if (await keyring.hasProvider(id)) out.push(id);
  }
  return out;
}

/**
 * Build the ordered candidate chain for a request.
 * @param {Object} args
 * @param {Object} args.cfg           current config
 * @param {Object} args.keyring       keyring instance
 * @param {Object} args.needs         { tools, vision, reasoning, streaming }
 * @param {number} args.estTokens     estimated input tokens
 * @param {Object} [args.health]      health monitor (snapshot used for auto mode)
 * @returns {{ candidates, warnings, source }}
 */
export async function planCandidates({ cfg, keyring, needs, estTokens, health }) {
  const warnings = [];
  const known = allProviderIds(cfg);
  const available = await availableProviders(cfg, keyring);
  const active = await resolveActiveProvider(cfg, keyring);

  const isLocalOnlyProfile = cfg.profile ? (resolveProfileChain(cfg.profile, cfg, known).profile?.localOnly === true) : false;

  let orderedProviders = [];
  let source = 'manual';

  if (cfg.profile) {
    const resolved = resolveProfileChain(cfg.profile, cfg, known);
    if (resolved.ok && resolved.candidates.length > 0) {
      source = `profile:${cfg.profile}`;
      orderedProviders = resolved.candidates
        .filter(c => available.includes(c.provider))
        .map(c => ({ provider: c.provider, model: c.model || '' }));
      const dropped = resolved.candidates.filter(c => !available.includes(c.provider));
      for (const d of dropped) warnings.push(`profile entry ${d.provider}${d.model ? '/' + d.model : ''} skipped — no key / not configured`);
    } else if (resolved.ok) {
      warnings.push(`profile "${cfg.profile}" has no usable providers — falling back to active provider`);
    } else {
      warnings.push(resolved.error);
    }
  }

  if (orderedProviders.length === 0 && cfg.routing === 'auto') {
    source = 'auto';
    const ranked = rankForAuto(available, cfg, needs, estTokens, health);
    orderedProviders = ranked.map(p => ({ provider: p, model: '' }));
    if (ranked.length === 0) warnings.push('auto routing found no available providers');
  }

  if (orderedProviders.length === 0) {
    // Manual mode: active provider first, then the configured fallback chain
    orderedProviders = [{ provider: active.providerId, model: active.model }];
    for (const fb of cfg.fallbackChain || []) {
      if (fb === active.providerId) continue;
      if (!known.includes(fb)) {
        warnings.push(`fallback "${fb}" is not a known provider — skipped`);
        continue;
      }
      if (!available.includes(fb)) {
        warnings.push(`fallback "${fb}" has no key / is not configured — skipped`);
        continue;
      }
      orderedProviders.push({ provider: fb, model: '' });
    }
  }

  // Local-only profiles must never silently fall back to cloud providers
  if (isLocalOnlyProfile) {
    const filtered = [];
    for (const c of orderedProviders) {
      const def = resolveProvider(c.provider, cfg);
      if (def?.isLocal) filtered.push(c);
      else warnings.push(`${c.provider} skipped — local-only profile`);
    }
    if (filtered.length > 0) orderedProviders = filtered;
    else warnings.push('local-only profile: no local providers available — refusing cloud fallback');
  }

  // Dedupe by provider, keep first occurrence
  const seen = new Set();
  const deduped = [];
  for (const c of orderedProviders) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    deduped.push(c);
  }

  // Resolve each candidate: key + model + capability check.
  // A provider with several stored keys yields one candidate per key, so the
  // request loop can rotate to the next key when one is rejected (401/403).
  let candidates = [];
  const skippedForCapability = [];
  for (const c of deduped) {
    const def = resolveProvider(c.provider, cfg);
    if (!def) continue;

    let providerKeys = [''];
    if (def.requiresKey !== false) {
      const entries = await keyring.keysForProvider(c.provider);
      const fullKeys = [];
      for (const e of entries) {
        const full = await keyring.getKeyById(e.id);
        if (full?.key) fullKeys.push(full.key);
      }
      // Env-provided key strictly overrides stored keys for the active provider.
      if (c.provider === active.providerId && active.key && active.source === 'env') {
        providerKeys = [active.key];
      } else if (c.provider === active.providerId && active.key && fullKeys.includes(active.key)) {
        providerKeys = [active.key, ...fullKeys.filter(k => k !== active.key)];
      } else {
        providerKeys = fullKeys;
      }
      if (providerKeys.length === 0) continue;
    }

    let model = c.model
      || (cfg.model && providerOwnsModel(c.provider, cfg.model, cfg) ? cfg.model : '')
      || cfg.fallbackModels?.[c.provider]
      || '';
    if (!model) {
      model = needs?.tools || needs?.vision ? bestModelFor(c.provider, needs) : (def.defaultModel || '');
    }

    const sat = modelSatisfies(c.provider, model, needs || {}, estTokens || 0);
    if (!sat.ok) {
      skippedForCapability.push({ provider: c.provider, model, reasons: sat.reasons, keys: providerKeys });
      continue;
    }
    for (const r of sat.reasons || []) warnings.push(`${c.provider}: ${r}`);

    for (const key of providerKeys) {
      candidates.push({
        provider: c.provider,
        model,
        key,
        timeoutMs: cfg._timeoutSet ? cfg.timeout : (def.timeout || 120000),
        source,
      });
    }
  }

  // If capability filtering removed everything, keep the original chain with
  // loud warnings rather than failing with no candidates at all.
  if (candidates.length === 0 && skippedForCapability.length > 0) {
    for (const s of skippedForCapability) {
      const def = resolveProvider(s.provider, cfg);
      warnings.push(`⚠ ${s.provider}/${s.model}: ${s.reasons.join('; ')} — using anyway (no alternative)`);
      for (const key of s.keys) {
        candidates.push({
          provider: s.provider,
          model: s.model,
          key,
          timeoutMs: cfg._timeoutSet ? cfg.timeout : (def?.timeout || 120000),
          source,
        });
      }
    }
  }

  // Order overflow-related fallbacks by context headroom (bigger windows first)
  if (estTokens > 0 && candidates.length > 1) {
    const stable = candidates.map((c, i) => ({ c, i }));
    stable.sort((a, b) =>
      contextHeadroom(b.c.provider, b.c.model, estTokens) - contextHeadroom(a.c.provider, a.c.model, estTokens));
    // Only reorder if the request is actually near overflow
    if (estTokens > 32000) candidates = stable.map(s => s.c);
  }

  return { candidates, warnings, source, needs, estTokens };
}

/**
 * Rank providers for auto mode: health first, then configured priority,
 * then capability fit. Never probes inline — uses the health snapshot only.
 */
function rankForAuto(available, cfg, needs, estTokens, health) {
  const snapshot = health?.snapshot ? health.snapshot() : {};
  const scored = available.map(id => {
    const def = resolveProvider(id, cfg);
    const h = snapshot[id];
    let score = 0;
    if (h) {
      if (h.status === 'online') score -= 100;
      else if (h.status === 'degraded') score -= 50;
      else if (h.status === 'rate-limited') score += 50;
      else if (h.status === 'offline' || h.status === 'auth-failed') score += 200;
    }
    const priorityIdx = PROVIDER_PRIORITY.indexOf(id);
    score += priorityIdx === -1 ? 50 : priorityIdx;
    if (def?.isLocal) score += 25; // prefer cloud for auto unless explicitly local
    if (needs?.tools || needs?.vision) {
      const best = bestModelFor(id, needs);
      const info = findModelInfo(id, best);
      if (info) {
        if (needs.tools && info.tools) score -= 10;
        if (needs.vision && info.vision) score -= 10;
      }
    }
    return { id, score };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.id);
}
