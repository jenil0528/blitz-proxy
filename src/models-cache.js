// ============================================================================
// BlitzProxy — Model Discovery Cache
// Models discovered from provider /models endpoints are cached in config
// (non-secret) and surfaced in `blitz models` and GET /v1/models.
//
// Rules:
//   - capabilities are NEVER fabricated — only the model id and lastSeen
//     are recorded; explicit metadata (if a user or plugin set it) survives
//   - discovery failure must never delete manually-configured models
//   - the proxy never calls /models per request — only on explicit refresh
// ============================================================================

/**
 * Merge a fresh discovery result into the existing cache.
 * Pure function: returns a NEW discoveredModels object (caller saves).
 * @param {Object} existing  cfg.discoveredModels (or {})
 * @param {string} providerId
 * @param {string[]} modelIds upstream model ids
 */
export function mergeDiscovered(existing, providerId, modelIds) {
  const discoveredModels = { ...(existing || {}) };
  const prev = discoveredModels[providerId];
  const prevById = new Map((prev?.models || []).map(m => [m.id, m]));

  const now = new Date().toISOString();
  const models = [];
  const seen = new Set();
  for (const id of modelIds) {
    if (!id || typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const old = prevById.get(id);
    // keep explicit metadata (capabilities etc.) — never invent it
    models.push(old ? { ...old, lastSeen: now } : { id, lastSeen: now });
  }

  discoveredModels[providerId] = { models, fetchedAt: now };
  return discoveredModels;
}

/**
 * Cached discovered models for a provider, catalog ids excluded.
 * @param {Object} section  cfg.discoveredModels (the section itself)
 * @returns {Array<{id, lastSeen}>}
 */
export function discoveredList(section, providerId) {
  const entry = section?.[providerId];
  if (!entry || !Array.isArray(entry.models)) return [];
  return entry.models;
}

/**
 * Discovered ids for a provider that are NOT already in its catalog.
 * @param {Object} section  cfg.discoveredModels (the section itself)
 */
export function newDiscoveredIds(section, providerId, catalogIds) {
  const cat = new Set(catalogIds || []);
  return discoveredList(section, providerId)
    .map(m => m.id)
    .filter(id => !cat.has(id));
}

/**
 * Does a model exist for a provider (catalog or discovered)?
 */
export function modelExists(cfg, providerId, modelId) {
  const def = cfg?.discoveredModels?.[providerId]?.models;
  if (Array.isArray(def) && def.some(m => m.id === modelId)) return true;
  return false; // catalog knowledge lives in the provider definition
}
