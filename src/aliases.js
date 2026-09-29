// ============================================================================
// BlitzProxy — Model Aliases
// Short names that resolve to a concrete provider/model pair.
//   blitz use coding  →  nvidia/z-ai/glm-5.3
//
// Aliases live in config.json (non-secret):  "aliases": { "coding": "nvidia/z-ai/glm-5.3" }
// Resolution is a single lookup — no chains, no recursion, fully deterministic.
// ============================================================================

export const ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Set an alias (value must look like "provider/model"). Returns error message or null. */
export function validateAliasValue(value, knownProviderIds) {
  const v = String(value || '').trim();
  const idx = v.indexOf('/');
  if (idx <= 0 || idx === v.length - 1) return `alias value must be "<provider>/<model>" — got "${v}"`;
  const pid = v.slice(0, idx);
  if (!knownProviderIds.includes(pid)) return `"${pid}" is not a known provider id`;
  return null;
}

/** Resolve an alias to its "provider/model" value, or null. */
export function resolveAlias(cfg, name) {
  if (!name || typeof name !== 'string') return null;
  const v = cfg?.aliases?.[name];
  return typeof v === 'string' && v.includes('/') ? v : null;
}

/** All user aliases as [{ name, value }]. */
export function listAliases(cfg) {
  return Object.entries(cfg?.aliases || {}).map(([name, value]) => ({ name, value }));
}
