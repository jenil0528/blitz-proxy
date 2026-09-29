// ============================================================================
// BlitzProxy — Configuration Validation
// Reusable, read-only validation of the BlitzProxy configuration.
// `blitz config validate` prints it; tests import it directly.
//
// Rules:
//   - never mutates configuration
//   - never prints or returns key material (credential checks use the
//     masked public entries only)
//   - errors mean the config cannot serve requests safely (exit code 1)
//   - warnings mean the config works but something is probably unintended
// ============================================================================

import { resolveProvider, allProviderIds } from './provider-registry.js';
import { isLoopbackHost } from './security/lan.js';

/**
 * Validate a parsed config.
 * @param {Object} cfg              the parsed configuration (getConfig())
 * @param {Object} [opts]
 * @param {Array}  [opts.credentials] public keyring entries (masked) — optional
 * @returns {{ ok: boolean, sections: Array<{ name, ok, errors: string[], warnings: string[] }> }}
 */
export function validateConfig(cfg, opts = {}) {
  const credentials = opts.credentials || [];
  const sections = [];
  const section = (name, fn) => {
    const s = { name, ok: true, errors: [], warnings: [] };
    const err = (m) => s.errors.push(m);
    const warn = (m) => s.warnings.push(m);
    fn(s, err, warn);
    s.ok = s.errors.length === 0;
    sections.push(s);
  };

  const knownIds = allProviderIds(cfg);

  // ── Providers ────────────────────────────────────────────────────────────
  section('Providers', (s, err, warn) => {
    if (cfg.provider && !knownIds.includes(cfg.provider)) {
      err(`Active provider "${cfg.provider}" is not a known provider id — requests will fail`);
    }
    const customIds = Object.keys(cfg.customProviders || {});
    for (const id of customIds) {
      const def = cfg.customProviders[id];
      if (!def || typeof def !== 'object') {
        err(`Custom provider "${id}" must be an object with a baseUrl`);
        continue;
      }
      const url = String(def.baseUrl || '');
      if (!url) {
        err(`Custom provider "${id}" has no baseUrl`);
      } else {
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            err(`Custom provider "${id}" baseUrl must use http(s) — got "${u.protocol}"`);
          }
          if (u.protocol === 'http:' && !/127\.0\.0\.1|localhost|\[::1\]/.test(u.hostname)) {
            warn(`Custom provider "${id}" uses plain http to "${u.hostname}" — credentials would travel unencrypted`);
          }
        } catch {
          err(`Custom provider "${id}" has an invalid base URL: "${url}"`);
        }
      }
    }
    // duplicate endpoints across custom provider ids
    const byUrl = new Map();
    for (const id of customIds) {
      const url = String(cfg.customProviders[id]?.baseUrl || '').replace(/\/+$/, '');
      if (!url) continue;
      if (byUrl.has(url)) warn(`Providers "${byUrl.get(url)}" and "${id}" point at the same endpoint`);
      else byUrl.set(url, id);
    }
  });

  // ── Credentials ────────────────────────────────────────────────────────────
  section('Credentials', (s, err, warn) => {
    for (const c of credentials) {
      if (c.provider && !knownIds.includes(c.provider)) {
        warn(`Credential "${c.name}" belongs to unknown provider "${c.provider}" — it can never be used`);
      }
    }
    // identical (masked) key material stored twice for the same provider
    const seen = new Map();
    for (const c of credentials) {
      const sig = `${c.provider}::${c.maskedKey}`;
      if (seen.has(sig)) warn(`Identical key stored twice for "${c.provider}" (${seen.get(sig)} and ${c.name})`);
      else seen.set(sig, c.name);
    }
    // active provider requiring a key with none stored
    if (cfg.provider && knownIds.includes(cfg.provider)) {
      const def = resolveProvider(cfg.provider, cfg);
      if (def && def.requiresKey !== false) {
        const has = credentials.some(c => c.provider === cfg.provider);
        if (!has) warn(`Active provider "${cfg.provider}" has no stored credential — requests will fail (blitz add <key>)`);
      }
    }
  });

  // ── Models ────────────────────────────────────────────────────────────────
  section('Models', (s, err, warn) => {
    if (cfg.provider && cfg.model) {
      const def = resolveProvider(cfg.provider, cfg);
      if (def?.models && !(cfg.model in def.models)) {
        warn(`Active model "${cfg.model}" is not in the ${cfg.provider} catalog — allowed for custom/unlisted models, but check the spelling (blitz model)`);
      }
    }
    for (const [pid, entry] of Object.entries(cfg.discoveredModels || {})) {
      if (!knownIds.includes(pid)) warn(`Discovered models reference unknown provider "${pid}"`);
      if (!Array.isArray(entry?.models)) warn(`Discovered models for "${pid}" are malformed — run: blitz models refresh ${pid}`);
    }
    for (const [pid, model] of Object.entries(cfg.fallbackModels || {})) {
      if (!knownIds.includes(pid)) warn(`Fallback model references unknown provider "${pid}"`);
      else if (model) {
        const def = resolveProvider(pid, cfg);
        if (def?.models && !(model in def.models) && !Object.values(cfg.discoveredModels?.[pid]?.models || {}).some(m => m.id === model)) {
          warn(`Fallback model "${pid}/${model}" is not in the catalog — check spelling`);
        }
      }
    }
  });

  // ── Profiles ───────────────────────────────────────────────────────────────
  section('Profiles', (s, err, warn) => {
    if (cfg.profile) {
      const ids = knownIds;
      const builtins = ['coding', 'fast', 'free', 'local'];
      const userProfiles = Object.keys(cfg.profiles || {});
      if (!builtins.includes(cfg.profile) && !userProfiles.includes(cfg.profile)) {
        err(`Active profile "${cfg.profile}" does not exist (blitz profile list)`);
      }
      const chain = cfg.profiles?.[cfg.profile]?.chain;
      if (Array.isArray(chain)) {
        for (const entry of chain) {
          const pid = String(entry).split('/')[0];
          if (!ids.includes(pid)) warn(`Profile "${cfg.profile}" references unknown provider "${pid}" — it will be skipped`);
        }
      }
    }
  });

  // ── Fallback chains ────────────────────────────────────────────────────────
  section('Fallback chains', (s, err, warn) => {
    const chain = cfg.fallbackChain || [];
    for (const fb of chain) {
      if (!knownIds.includes(fb)) warn(`Fallback "${fb}" is not a known provider — it will be skipped`);
      else if (fb === cfg.provider) warn(`Circular fallback: "${fb}" is already the active provider — ignored`);
    }
  });

  // ── Routing & timeouts ────────────────────────────────────────────────────
  section('Routing & timeouts', (s, err, warn) => {
    if (cfg.routing !== 'manual' && cfg.routing !== 'auto') {
      err(`"routing" must be "manual" or "auto" — got "${cfg.routing}"`);
    }
    if (!Number.isInteger(cfg.proxyPort) || cfg.proxyPort < 1 || cfg.proxyPort > 65535) {
      err(`"proxyPort" must be an integer between 1 and 65535 — got ${JSON.stringify(cfg.proxyPort)}`);
    }
    if (!(typeof cfg.timeout === 'number' && cfg.timeout > 0)) {
      err(`"timeout" must be a positive number of milliseconds — got ${JSON.stringify(cfg.timeout)}`);
    }
    if (!(typeof cfg.retryBaseDelay === 'number' && cfg.retryBaseDelay >= 0)) {
      err(`"retryBaseDelay" must be zero or a positive number — got ${JSON.stringify(cfg.retryBaseDelay)}`);
    }
    if (!(Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0)) {
      err(`"maxRetries" must be a non-negative integer — got ${JSON.stringify(cfg.maxRetries)}`);
    }
    if (!(typeof cfg.healthTtlMs === 'number' && cfg.healthTtlMs > 0)) {
      err(`"healthTtlMs" must be a positive number — got ${JSON.stringify(cfg.healthTtlMs)}`);
    }
  });

  // ── Network & security ─────────────────────────────────────────────────────
  section('Network & security', (s, err, warn) => {
    const host = String(cfg.host || '').trim();
    if (!isLoopbackHost(host)) {
      if (cfg.requireAuth !== true) {
        err(`"host" is non-loopback ("${host}") with authentication disabled — the server refuses to start (blitz config set requireAuth true)`);
      } else {
        warn(`Binding non-loopback ("${host}") — make sure the proxy token stays private`);
      }
    }
  });

  const ok = sections.every(s => s.ok);
  return { ok, sections };
}

/**
 * Render validation results for the CLI. No secrets ever appear here.
 */
export function formatValidation(result) {
  const lines = [];
  for (const s of result.sections) {
    const mark = s.errors.length > 0 ? '✗' : s.warnings.length > 0 ? '⚠' : '✓';
    lines.push(`${mark} ${s.name}`);
    for (const e of s.errors) lines.push(`    ${e}`);
    for (const w of s.warnings) lines.push(`    ${w}`);
  }
  lines.push('');
  lines.push(result.ok ? 'Configuration is valid.' : 'Configuration is INVALID — fix the errors above.');
  return lines.join('\n');
}
