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
      cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
      models: {},
      agents: {},
      latencyMsSum: 0, latencyCount: 0,
      costUsd: 0, costCount: 0,
    };
    day[providerId] = b;
    return b;
  }

  function agentBucket(b, agent) {
    if (!agent) return null;
    const a = b.agents[agent] || {
      requests: 0, ok: 0, fail: 0,
      inputTokens: 0, outputTokens: 0,
      cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
    };
    b.agents[agent] = a;
    return a;
  }

  function modelBucket(b, model) {
    if (!model) return null;
    const m = b.models[model] || {
      requests: 0, ok: 0, fail: 0,
      inputTokens: 0, outputTokens: 0,
      cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
      latencyMsSum: 0, latencyCount: 0,
    };
    b.models[model] = m;
    return m;
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
    if (evt.cachedTokens) b.cachedTokens = (b.cachedTokens || 0) + evt.cachedTokens;
    if (evt.reasoningTokens) b.reasoningTokens = (b.reasoningTokens || 0) + evt.reasoningTokens;
    if (evt.contextSavedTokens) b.contextSavedTokens = (b.contextSavedTokens || 0) + evt.contextSavedTokens;
    if (evt.estimated) b.estimatedRequests = (b.estimatedRequests || 0) + 1;
    if (evt.fallbackTo) b.fallbacks += 1;

    // Per-model bucket (aggregates by model within the provider)
    if (evt.model) {
      const m = modelBucket(b, evt.model);
      if (m) {
        m.requests += 1;
        if (evt.ok) m.ok += 1; else m.fail += 1;
        if (evt.inputTokens) m.inputTokens += evt.inputTokens;
        if (evt.outputTokens) m.outputTokens += evt.outputTokens;
        if (evt.cachedTokens) m.cachedTokens = (m.cachedTokens || 0) + evt.cachedTokens;
        if (evt.reasoningTokens) m.reasoningTokens = (m.reasoningTokens || 0) + evt.reasoningTokens;
        if (evt.contextSavedTokens) m.contextSavedTokens = (m.contextSavedTokens || 0) + evt.contextSavedTokens;
        if (evt.estimated) m.estimatedRequests = (m.estimatedRequests || 0) + 1;
        if (typeof evt.latencyMs === 'number' && evt.latencyMs >= 0) {
          m.latencyMsSum += evt.latencyMs;
          m.latencyCount += 1;
        }
      }
    }
    // Per-agent bucket (attribution from the client's User-Agent — best-effort)
    if (evt.agent) {
      const a = agentBucket(b, evt.agent);
      if (a) {
        a.requests += 1;
        if (evt.ok) a.ok += 1; else a.fail += 1;
        if (evt.inputTokens) a.inputTokens += evt.inputTokens;
        if (evt.outputTokens) a.outputTokens += evt.outputTokens;
        if (evt.cachedTokens) a.cachedTokens = (a.cachedTokens || 0) + evt.cachedTokens;
        if (evt.reasoningTokens) a.reasoningTokens = (a.reasoningTokens || 0) + evt.reasoningTokens;
        if (evt.contextSavedTokens) a.contextSavedTokens = (a.contextSavedTokens || 0) + evt.contextSavedTokens;
        if (evt.estimated) a.estimatedRequests = (a.estimatedRequests || 0) + 1;
      }
    }

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
    const monthPrefix = todayKey().slice(0, 7); // YYYY-MM
    const dayKeys = days === 'all'
      ? Object.keys(data.days)
      : days === 'month'
        ? Object.keys(data.days).filter(k => k.startsWith(monthPrefix))
        : [todayKey()];
    for (const dayKey of dayKeys) {
      const day = data.days[dayKey] || {};
      for (const [providerId, b] of Object.entries(day)) {
        const agg = out.get(providerId) || {
          requests: 0, ok: 0, fail: 0, rateLimited: 0, fallbacks: 0,
          inputTokens: 0, outputTokens: 0,
          cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
          models: {},
          agents: {},
          latencyMsSum: 0, latencyCount: 0, costUsd: 0, costCount: 0,
        };
        agg.requests += b.requests || 0;
        agg.ok += b.ok || 0;
        agg.fail += b.fail || 0;
        agg.rateLimited += b.rateLimited || 0;
        agg.fallbacks += b.fallbacks || 0;
        agg.inputTokens += b.inputTokens || 0;
        agg.outputTokens += b.outputTokens || 0;
        agg.cachedTokens += b.cachedTokens || 0;
        agg.reasoningTokens += b.reasoningTokens || 0;
        agg.contextSavedTokens += b.contextSavedTokens || 0;
        agg.estimatedRequests += b.estimatedRequests || 0;
        agg.latencyMsSum += b.latencyMsSum || 0;
        agg.latencyCount += b.latencyCount || 0;
        agg.costUsd += b.costUsd || 0;
        agg.costCount += b.costCount || 0;
        // merge per-model buckets across days
        for (const [model, m] of Object.entries(b.models || {})) {
          const mm = agg.models[model] || (agg.models[model] = {
            requests: 0, ok: 0, fail: 0,
            inputTokens: 0, outputTokens: 0,
            cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
            latencyMsSum: 0, latencyCount: 0,
          });
          mm.requests += m.requests || 0;
          mm.ok += m.ok || 0;
          mm.fail += m.fail || 0;
          mm.inputTokens += m.inputTokens || 0;
          mm.outputTokens += m.outputTokens || 0;
          mm.cachedTokens += m.cachedTokens || 0;
          mm.reasoningTokens += m.reasoningTokens || 0;
          mm.contextSavedTokens += m.contextSavedTokens || 0;
          mm.estimatedRequests += m.estimatedRequests || 0;
          mm.latencyMsSum += m.latencyMsSum || 0;
          mm.latencyCount += m.latencyCount || 0;
        }
        // merge per-agent buckets across days
        for (const [agent, a] of Object.entries(b.agents || {})) {
          const aa = agg.agents[agent] || (agg.agents[agent] = {
            requests: 0, ok: 0, fail: 0,
            inputTokens: 0, outputTokens: 0,
            cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
          });
          aa.requests += a.requests || 0;
          aa.ok += a.ok || 0;
          aa.fail += a.fail || 0;
          aa.inputTokens += a.inputTokens || 0;
          aa.outputTokens += a.outputTokens || 0;
          aa.cachedTokens += a.cachedTokens || 0;
          aa.reasoningTokens += a.reasoningTokens || 0;
          aa.contextSavedTokens += a.contextSavedTokens || 0;
          aa.estimatedRequests += a.estimatedRequests || 0;
        }
        out.set(providerId, agg);
      }
    }
    return out;
  }

  /**
   * Summary for display: today (default) or all retained days.
   * Returns the provider rows array (backward-compatible shape).
   */
  function getSummary({ scope = 'today' } = {}) {
    return getUsage({ scope }).providers;
  }

  /**
   * Rich usage summary: provider rows + per-model rows (model across
   * providers) + per-agent rows (User-Agent attribution, best-effort).
   * New token dimensions: cachedTokens, reasoningTokens, contextSavedTokens,
   * estimatedRequests (estimates never counted as exact).
   */
  function getUsage({ scope = 'today' } = {}) {
    const providers = summarize(scope === 'all' ? 'all' : scope === 'month' ? 'month' : 1);
    const rows = [];
    const models = new Map();
    const agents = new Map();
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
        cachedTokens: b.cachedTokens,
        reasoningTokens: b.reasoningTokens,
        contextSavedTokens: b.contextSavedTokens,
        estimatedRequests: b.estimatedRequests,
        avgLatencyMs: b.latencyCount > 0 ? Math.round(b.latencyMsSum / b.latencyCount) : null,
        costUsd: b.costCount > 0 ? b.costUsd : null, // estimate; null = pricing unknown
      });
      for (const [model, m] of Object.entries(b.models || {})) {
        let mm = models.get(model);
        if (!mm) {
          mm = {
            model, requests: 0, ok: 0, fail: 0,
            inputTokens: 0, outputTokens: 0,
            cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
          };
          models.set(model, mm);
        }
        mm.requests += m.requests;
        mm.ok += m.ok;
        mm.fail += m.fail;
        mm.inputTokens += m.inputTokens;
        mm.outputTokens += m.outputTokens;
        mm.cachedTokens += m.cachedTokens;
        mm.reasoningTokens += m.reasoningTokens;
        mm.contextSavedTokens += m.contextSavedTokens;
        mm.estimatedRequests += m.estimatedRequests;
      }
      for (const [agent, a] of Object.entries(b.agents || {})) {
        let aa = agents.get(agent);
        if (!aa) {
          aa = {
            agent, requests: 0, ok: 0, fail: 0,
            inputTokens: 0, outputTokens: 0,
            cachedTokens: 0, reasoningTokens: 0, contextSavedTokens: 0, estimatedRequests: 0,
          };
          agents.set(agent, aa);
        }
        aa.requests += a.requests;
        aa.ok += a.ok;
        aa.fail += a.fail;
        aa.inputTokens += a.inputTokens;
        aa.outputTokens += a.outputTokens;
        aa.cachedTokens += a.cachedTokens;
        aa.reasoningTokens += a.reasoningTokens;
        aa.contextSavedTokens += a.contextSavedTokens;
        aa.estimatedRequests += a.estimatedRequests;
      }
    }
    rows.sort((a, b2) => b2.requests - a.requests);
    return {
      providers: rows,
      models: [...models.values()].sort((a, b2) => b2.requests - a.requests),
      agents: [...agents.values()].sort((a, b2) => b2.requests - a.requests),
    };
  }

  function clear() {
    data = { days: {} };
    dirty = true;
    flush();
  }

  return { record, flush, getSummary, getUsage, clear, filePath, isPrivacy: () => privacy };
}

/**
 * Convenience: record a completed request with cost estimate.
 * New optional fields flow through to the new token dimensions:
 * cachedTokens, reasoningTokens, estimated, contextSavedTokens.
 */
export function recordRequest(stats, { providerId, model, agent, ok, status, latencyMs, inputTokens, outputTokens, cachedTokens, reasoningTokens, estimated, contextSavedTokens, rateLimited, fallbackTo }) {
  const cost = ok ? estimateRequestCost(providerId, model, inputTokens || 0, outputTokens || 0) : null;
  stats.record(providerId, {
    ok,
    model,
    agent,
    rateLimited: rateLimited === true,
    latencyMs,
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cachedTokens: cachedTokens || 0,
    reasoningTokens: reasoningTokens || 0,
    estimated: estimated === true,
    contextSavedTokens: contextSavedTokens || 0,
    fallbackTo,
    costUsd: ok && typeof cost === 'number' ? cost : undefined,
  });
}
