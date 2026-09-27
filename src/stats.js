// ============================================================================
// BlitzProxy — Usage Statistics & Cost Tracking
// Aggregates only: requests, successes, failures, rate limits, latency,
// token counts, fallback events, estimated cost. Prompts and responses are
// NEVER stored. In privacy mode, aggregates are kept in memory only.
//
// Cost values are ESTIMATES derived from the catalog pricing table.
// Unknown pricing → cost shown as n/a — never guessed.
// ============================================================================

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { estimateRequestCost } from './providers.js';

const KEEP_DAYS = 90;

function todayKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Create the stats store.
 * @param {Object} opts
 * @param {string} opts.home      stats directory (BLITZ_HOME)
 * @param {boolean} opts.privacy  privacy mode → in-memory only, nothing persisted
 */
export function createStats({ home, privacy = false }) {
  const filePath = join(home || '.', 'stats.json');
  let data = { days: {} };
  let dirty = false;
  let flushTimer = null;

  if (!privacy && home && existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.days) data = parsed;
    } catch { /* corrupted stats are not worth crashing over */ }
  }

  function prune() {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(data.days)) {
      if (day < cutoff) delete data.days[day];
    }
  }

  function bucket(providerId) {
    const day = data.days[todayKey()] || {};
    data.days[todayKey()] = day;
    const b = day[providerId] || {
      requests: 0, ok: 0, fail: 0, rateLimited: 0, fallbacks: 0,
      inputTokens: 0, outputTokens: 0,
      latencyMsSum: 0, latencyCount: 0,
      costUsd: 0, costCount: 0,
    };
    day[providerId] = b;
    return b;
  }

  function record(providerId, evt) {
    const b = bucket(providerId);
    b.requests += 1;
    if (evt.ok) b.ok += 1; else b.fail += 1;
    if (evt.rateLimited) b.rateLimited += 1;
    if (typeof evt.latencyMs === 'number' && evt.latencyMs >= 0) {
      b.latencyMsSum += evt.latencyMs;
      b.latencyCount += 1;
    }
    if (evt.inputTokens) b.inputTokens += evt.inputTokens;
    if (evt.outputTokens) b.outputTokens += evt.outputTokens;
    if (evt.fallbackTo) b.fallbacks += 1;
    // A computed $0 estimate is valid (free tier) and must not be confused
    // with "pricing unknown" — tracked via costCount.
    if (typeof evt.costUsd === 'number') {
      b.costUsd = (b.costUsd || 0) + evt.costUsd;
      b.costCount = (b.costCount || 0) + 1;
    }
    dirty = true;
    // Debounced flush: durable within ~1s even if the process is killed
    // hard (Windows stop = TerminateProcess, no exit hooks).
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1000);
      flushTimer.unref?.();
    }
  }

  function flush() {
    if (privacy || !home || !dirty) return;
    prune();
    try {
      const tmp = filePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmp, filePath);
      dirty = false;
    } catch { /* best-effort persistence */ }
  }

  // Periodic flush — never keeps the process alive on its own
  const timer = setInterval(flush, 10000);
  timer.unref?.();
  process.on('exit', () => flush());

  function summarize(days) {
    const out = new Map();
    const dayKeys = days === 'all'
      ? Object.keys(data.days)
      : [todayKey()];
    for (const dayKey of dayKeys) {
      const day = data.days[dayKey] || {};
      for (const [providerId, b] of Object.entries(day)) {
        const agg = out.get(providerId) || {
          requests: 0, ok: 0, fail: 0, rateLimited: 0, fallbacks: 0,
          inputTokens: 0, outputTokens: 0,
          latencyMsSum: 0, latencyCount: 0, costUsd: 0, costCount: 0,
        };
        agg.requests += b.requests || 0;
        agg.ok += b.ok || 0;
        agg.fail += b.fail || 0;
        agg.rateLimited += b.rateLimited || 0;
        agg.fallbacks += b.fallbacks || 0;
        agg.inputTokens += b.inputTokens || 0;
        agg.outputTokens += b.outputTokens || 0;
        agg.latencyMsSum += b.latencyMsSum || 0;
        agg.latencyCount += b.latencyCount || 0;
        agg.costUsd += b.costUsd || 0;
        agg.costCount += b.costCount || 0;
        out.set(providerId, agg);
      }
    }
    return out;
  }

  /**
   * Summary for display: today (default) or all retained days.
   */
  function getSummary({ scope = 'today' } = {}) {
    const providers = summarize(scope === 'all' ? 'all' : 1);
    const rows = [];
    for (const [providerId, b] of providers) {
      rows.push({
        providerId,
        requests: b.requests,
        ok: b.ok,
        fail: b.fail,
        rateLimited: b.rateLimited,
        fallbacks: b.fallbacks,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        avgLatencyMs: b.latencyCount > 0 ? Math.round(b.latencyMsSum / b.latencyCount) : null,
        costUsd: b.costCount > 0 ? b.costUsd : null, // estimate; null = pricing unknown
      });
    }
    rows.sort((a, b2) => b2.requests - a.requests);
    return rows;
  }

  function clear() {
    data = { days: {} };
    dirty = true;
    flush();
  }

  return { record, flush, getSummary, clear, filePath, isPrivacy: () => privacy };
}

/**
 * Convenience: record a completed request with cost estimate.
 */
export function recordRequest(stats, { providerId, model, ok, status, latencyMs, inputTokens, outputTokens, rateLimited, fallbackTo }) {
  const cost = ok ? estimateRequestCost(providerId, model, inputTokens || 0, outputTokens || 0) : null;
  stats.record(providerId, {
    ok,
    rateLimited: rateLimited === true,
    latencyMs,
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    fallbackTo,
    costUsd: ok && typeof cost === 'number' ? cost : undefined,
  });
}
