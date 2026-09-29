// ============================================================================
// BlitzProxy — Canonical Credential Resolution & Smart Rotation
// ONE resolver for every subsystem: requests, health checks, validation,
// model discovery, CLI status. Nothing may reach for keys[0] anymore.
//
// A credential is a stored API key (keyring entry) bound to a provider.
// It is independent of models: switching the active model never changes
// the credential.
//
// Credential state (in-process, per credential id):
//   invalidUntil   — set on live 401/403 (long hold, default 5 min)
//   cooldownUntil  — set on live 429 (short cooldown, default 60s)
//   successes/failures/lastUsed — rotation stats (never the key itself)
//
// Rotation order (deterministic):
//   1. the vault's active credential, when eligible
//   2. other eligible credentials, ordered by fewest recent failures,
//      then vault order
//   3. credentials in rate-limit cooldown (they recover quickly)
//   4. credentials in the invalid hold — last resort, keys recover upstream
//
// Selection is per credential, not per provider: a rejected or rate-limited
// key only affects itself; the provider stays usable with its other keys.
// ============================================================================

const INVALID_HOLD_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

const state = new Map(); // credentialId → { invalidUntil, cooldownUntil, successes, failures, lastUsed }

function entry(credentialId) {
  let e = state.get(credentialId);
  if (!e) {
    e = { invalidUntil: 0, cooldownUntil: 0, successes: 0, failures: 0, lastUsed: 0 };
    state.set(credentialId, e);
  }
  return e;
}

/** Live 401/403: the credential is invalid — hold it out for a while. */
export function markCredentialRejected(credentialId, holdMs = INVALID_HOLD_MS) {
  if (!credentialId) return;
  const e = entry(credentialId);
  e.invalidUntil = Date.now() + holdMs;
  e.failures += 1;
}

/** Live 429: the credential works but is throttled — short cooldown. */
export function markCredentialRateLimited(credentialId, cooldownMs = RATE_LIMIT_COOLDOWN_MS) {
  if (!credentialId) return;
  const e = entry(credentialId);
  e.cooldownUntil = Date.now() + cooldownMs;
}

/** A request succeeded with this credential: clear invalid/cooldown state, count success. */
export function markCredentialHealthy(credentialId) {
  if (!credentialId) return;
  const e = entry(credentialId);
  e.invalidUntil = 0;
  e.cooldownUntil = 0;
  e.failures = 0;
  e.successes += 1;
}

/** Is this credential inside its invalid hold window? */
export function isCredentialRejected(credentialId) {
  if (!credentialId) return false;
  const e = state.get(credentialId);
  if (!e) return false;
  return Date.now() < e.invalidUntil;
}

/** Is this credential inside its rate-limit cooldown? */
export function isCredentialCooldown(credentialId) {
  if (!credentialId) return false;
  const e = state.get(credentialId);
  if (!e) return false;
  return Date.now() < e.cooldownUntil;
}

/** Stats snapshot for status/doctor. Never contains key material. */
export function credentialStats() {
  const out = [];
  for (const [id, e] of state) {
    out.push({
      id,
      successes: e.successes,
      failures: e.failures,
      lastUsed: e.lastUsed ? new Date(e.lastUsed).toISOString() : null,
      state: Date.now() < e.invalidUntil ? 'invalid'
        : Date.now() < e.cooldownUntil ? 'cooldown'
        : 'healthy',
    });
  }
  return out;
}

/** All stored credentials for a provider, as FULL entries (with key material). */
async function fullCredentials(keyring, providerId) {
  const entries = await keyring.keysForProvider(providerId);
  const out = [];
  for (const e of entries) {
    const full = await keyring.getKeyById(e.id);
    if (full?.key) out.push(full);
  }
  return out;
}

function tier(credentialId) {
  const invalid = isCredentialRejected(credentialId);
  const cooldown = isCredentialCooldown(credentialId);
  if (!invalid && !cooldown) return 0;      // eligible
  if (!invalid && cooldown) return 1;       // rate-limited, recovers fast
  return 2;                                 // invalid hold — last resort
}

/**
 * Resolve ONE credential for a provider.
 * Priority:
 *   1. explicitly requested credential id (when it belongs to the provider)
 *   2. the vault's active key, when it belongs to this provider and is eligible
 *   3. the healthiest eligible credential
 *   4. any remaining credential (keys recover upstream)
 * Returns the full keyring entry { id, name, key, provider, ... } or null.
 */
export async function resolveCredential({ keyring, providerId, credentialId }) {
  if (!providerId) return null;

  if (credentialId) {
    const full = await keyring.getKeyById(credentialId);
    if (full && full.key && full.provider === providerId) return full;
    // A mismatched or unknown id falls through to the normal priority order.
  }

  const ordered = await resolveCredentials({ keyring, providerId });
  if (ordered.length === 0) return null;

  // 2. vault-active credential when eligible
  const active = await keyring.getActiveKey();
  if (active && active.provider === providerId && tier(active.id) === 0) {
    const match = ordered.find(c => c.id === active.id);
    if (match) return match;
  }

  // 3./4. resolver ordering already tiers: healthy → cooldown → invalid
  return ordered[0];
}

/**
 * Ordered credentials for a provider (rotation order), deterministic:
 *   active (when eligible) → eligible by fewest failures, vault order →
 *   cooldown → invalid hold.
 * Never returns an empty array when credentials exist.
 */
export async function resolveCredentials({ keyring, providerId }) {
  const creds = await fullCredentials(keyring, providerId);
  if (creds.length === 0) return [];

  const active = await keyring.getActiveKey();
  const activeId = active && active.provider === providerId ? active.id : null;

  const scored = creds.map((c, idx) => {
    const e = state.get(c.id);
    return {
      cred: c,
      t: tier(c.id),
      failures: e ? e.failures : 0,
      idx,
      isActive: c.id === activeId,
    };
  });
  scored.sort((a, b) =>
    (a.t - b.t) ||
    (b.isActive - a.isActive) ||
    (a.failures - b.failures) ||
    (a.idx - b.idx)
  );

  const now = Date.now();
  for (const s of scored) {
    const e = entry(s.cred.id);
    e.lastUsed = now;
  }

  return scored.map(s => s.cred);
}
