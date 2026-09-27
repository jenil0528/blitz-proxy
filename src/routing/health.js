// ============================================================================
// BlitzProxy — Provider Health Monitoring
// Lightweight checks with a configurable TTL cache — provider APIs are never
// spammed. Used by `blitz health`, auto-routing, and the dashboard.
//
// Passive marks: real request outcomes (401/403/429/5xx/network) are pinned
// for a hold window so a provider that answers cheap probes fine (some /models
// endpoints are fully anonymous, e.g. NVIDIA's) but rejects actual requests
// still shows up as auth-failed/unavailable — and auto-routing avoids it.
// ============================================================================

// How long a passively-marked failure is trusted over an active probe.
const HOLD_MS = {
  'auth-failed': 5 * 60 * 1000,   // keys don't un-revoke themselves quickly
  'rate-limited': 60 * 1000,
  'unavailable': 30 * 1000,
  'offline': 30 * 1000,
};

/**
 * Create a health monitor with TTL-based caching.
 * check() returns a cached status when fresh, and only probes the provider
 * when the cache is stale or absent. A fresh mark from a real request
 * outcome takes precedence over any probe result.
 */
export function createHealthMonitor({ ttlMs = 60000, probe } = {}) {
  const cache = new Map(); // providerId → { status, latencyMs, checkedAt, httpStatus, message }
  const marks = new Map(); // providerId → { status, httpStatus, message, markedAt, expiresAt }

  function liveMark(providerId) {
    const m = marks.get(providerId);
    return m && Date.now() < m.expiresAt ? m : null;
  }

  async function check(providerId, probeArgs, { force = false } = {}) {
    const mark = liveMark(providerId);
    if (mark) {
      return { status: mark.status, httpStatus: mark.httpStatus, message: mark.message, checkedAt: mark.markedAt };
    }
    if (marks.has(providerId)) marks.delete(providerId);

    const hit = cache.get(providerId);
    const fresh = hit && Date.now() - hit.checkedAt < ttlMs;
    if (!force && fresh) return hit;

    const result = await probe(probeArgs);
    const entry = { ...result, checkedAt: Date.now() };
    cache.set(providerId, entry);
    return entry;
  }

  /**
   * Pin a status from a real request outcome (passive health signal).
   * Supersedes probe results for the hold window of that status.
   */
  function markStatus(providerId, status, { httpStatus, message, holdMs } = {}) {
    if (!providerId || !status) return;
    const hold = holdMs ?? HOLD_MS[status] ?? 30 * 1000;
    marks.set(providerId, {
      status, httpStatus, message,
      markedAt: Date.now(),
      expiresAt: Date.now() + hold,
    });
    cache.delete(providerId);
  }

  function invalidate(providerId) {
    if (providerId) {
      cache.delete(providerId);
      marks.delete(providerId);
    } else {
      cache.clear();
      marks.clear();
    }
  }

  function snapshot() {
    const out = Object.fromEntries(cache.entries());
    for (const [id, m] of marks) {
      if (Date.now() < m.expiresAt && !out[id]) {
        out[id] = { status: m.status, httpStatus: m.httpStatus, message: m.message, checkedAt: m.markedAt };
      }
    }
    return out;
  }

  function get(providerId) {
    return liveMark(providerId) || cache.get(providerId) || null;
  }

  return { check, invalidate, markStatus, snapshot, get };
}

/**
 * Format a health entry for CLI display.
 */
export function formatHealth(h) {
  if (!h) return { label: 'UNKNOWN', color: 'dim', latency: '—' };
  const latency = typeof h.latencyMs === 'number' ? `${h.latencyMs}ms` : '—';
  switch (h.status) {
    case 'online': return { label: 'ONLINE', color: 'green', latency };
    case 'degraded': return { label: 'SLOW', color: 'yellow', latency };
    case 'rate-limited': return { label: 'RATE-LIMITED', color: 'yellow', latency: '—' };
    case 'auth-failed': return { label: 'AUTH-FAILED', color: 'red', latency: '—' };
    case 'unavailable': return { label: 'UNAVAILABLE', color: 'red', latency: '—' };
    case 'offline': return { label: 'OFFLINE', color: 'red', latency: '—' };
    default: return { label: String(h.status || 'UNKNOWN').toUpperCase(), color: 'dim', latency };
  }
}
