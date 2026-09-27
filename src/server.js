// ============================================================================
// BlitzProxy — Core Proxy Server
// Endpoints:
//   POST /v1/messages              Anthropic Messages API (Claude Code)
//   GET  /v1/models                 Model list (Claude Code / OpenCode compat)
//   POST /v1/messages/count_tokens  Token estimation
//   POST /v1/chat/completions       OpenAI-compatible endpoint (passthrough)
//   GET  /health                    Public status (no secrets)
//   GET  /dashboard                 Local dashboard (token-gated)
//   *    /admin/*                   Administrative API (token required)
//
// Local-first: binds 127.0.0.1 by default; never falls back mid-stream;
// errors are classified before failover; stats are aggregate-only.
// ============================================================================

import { createServer } from 'http';
import { appendFileSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig, getConfigRaw, refreshConfigIfChanged } from './config.js';
import { resolveProvider, getAdapter } from './provider-registry.js';
import { translateRequest, translateResponse } from './translator.js';
import { translateStream } from './stream-translator.js';
import { translateResponsesRequest, translateResponsesResponse, translateResponsesStream } from './responses-translator.js';
import { withRetry } from './retry.js';
import { requestNeeds, requestNeedsOpenAI, estimateTokens } from './routing/capabilities.js';
import { planCandidates, resolveActiveProvider } from './routing/router.js';
import { classifyHttpError, classifyNetworkError } from './routing/fallback.js';
import { createHealthMonitor } from './routing/health.js';
import { recordRequest } from './stats.js';
import { checkAuth } from './security/auth.js';
import { redactSecrets, maskKeyWithPrefix } from './security/mask.js';
import { DASHBOARD_HTML } from './dashboard/index.js';
import * as log from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, '..', 'blitz.log');
const LOG_FILE_OLD = join(__dirname, '..', 'blitz.log.old');
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const VERSION = process.env.BLITZ_VERSION || '2.0.0';

// ─── Privacy-safe request logging ────────────────────────────────────────────

let lastRotateCheck = 0;
const ROTATE_CHECK_INTERVAL = 60000;

function rotateLogIfNeeded() {
  const now = Date.now();
  if (now - lastRotateCheck < ROTATE_CHECK_INTERVAL) return;
  lastRotateCheck = now;
  try {
    const stats = statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE) renameSync(LOG_FILE, LOG_FILE_OLD);
  } catch { /* no file yet */ }
}

function logTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Request log lines: timestamp, route, status, latency, provider/model,
 * stream flag, fallback events. Never prompts, responses, or keys.
 * Disabled entirely in privacy mode.
 */
function appendLog(line) {
  const cfg = getConfigRaw();
  if (cfg.privacy) return;
  rotateLogIfNeeded();
  try {
    appendFileSync(LOG_FILE, redactSecrets(line) + '\n', 'utf-8');
  } catch { /* best-effort logging */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    req.on('data', chunk => {
      if (totalLen + chunk.length > maxBytes) {
        req.destroy();
        return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
      }
      totalLen += chunk.length;
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 1) resolve(chunks[0].toString('utf-8'));
      else if (chunks.length === 0) resolve('');
      else resolve(Buffer.concat(chunks, totalLen).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

function effectiveDef(def, cfg) {
  if (def.id === 'custom' && cfg.customBaseUrl) {
    return { ...def, baseUrl: cfg.customBaseUrl };
  }
  return def;
}

function sendJson(res, status, obj) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  try { res.end(JSON.stringify(obj)); } catch { res.end(); }
}

function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, {
    type: 'error',
    error: { type, message: redactSecrets(String(message || 'Unknown error')) },
  });
}

/** Map classified errors to Anthropic error responses (S7 fix: no more 401→400). */
function respondClassifiedError(res, cls, detail) {
  switch (cls.kind) {
    case 'auth':
      return sendAnthropicError(res, 401, 'authentication_error', cls.message);
    case 'rate_limit':
      return sendAnthropicError(res, 429, 'rate_limit_error', cls.message + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));
    case 'context_overflow':
      return sendAnthropicError(res, 400, 'invalid_request_error', cls.message + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));
    case 'invalid_request':
    case 'payload_too_large':
      return sendAnthropicError(res, 400, 'invalid_request_error', cls.message + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));
    case 'server':
      return sendAnthropicError(res, 529, 'api_error', cls.message + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));
    default:
      return sendAnthropicError(res, 502, 'api_error', cls.message + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));
  }
}

function respondOpenAIError(res, status, type, message) {
  sendJson(res, status, { error: { message: redactSecrets(String(message || 'Unknown error')), type, code: type } });
}

function isLocalOrigin(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

// ─── Passive health signals ──────────────────────────────────────────────────

/**
 * Record a real request outcome as a passive health signal. Cheap probes can
 * lie — some /models endpoints are anonymous (NVIDIA's answers 200 to any
 * Bearer) — so a live 401/403/429/5xx/network failure pins an honest status
 * that auto-routing and the dashboard trust over probe results for a while.
 */
function markProviderHealth(health, providerId, cls, status) {
  switch (cls.kind) {
    case 'auth':
      return health.markStatus(providerId, 'auth-failed', { httpStatus: status, message: 'Key rejected on a real request' });
    case 'rate_limit':
      return health.markStatus(providerId, 'rate-limited', { httpStatus: status, message: 'Rate limited on a real request' });
    case 'server':
      return health.markStatus(providerId, 'unavailable', { httpStatus: status, message: `HTTP ${status} on a real request` });
    case 'timeout':
    case 'connection_refused':
    case 'dns':
    case 'network':
      return health.markStatus(providerId, 'offline', { message: `${cls.kind} on a real request` });
    default:
      // model_not_found / invalid_request / etc: the provider authenticated us
      // fine — not a health signal.
      return health.invalidate(providerId);
  }
}

/**
 * Make auth failures actionable: name the exact (masked) key that was
 * rejected so the user knows which one to replace.
 */
function enrichAuthMessage(cls, cand) {
  if (!cls || cls.kind !== 'auth' || !cand?.key) return cls;
  return {
    ...cls,
    message: `${cls.message} — the provider rejected key ${maskKeyWithPrefix(cand.key)}; replace it with: blitz add <new-key>`,
  };
}

// ─── Server factory ──────────────────────────────────────────────────────────

/**
 * Create the BlitzProxy HTTP server (not yet listening).
 *
 * @param {Object} deps
 * @param {Object} deps.keyring   keyring instance
 * @param {Object} deps.stats     stats store
 * @param {string} deps.token     local proxy auth token (admin + optional API auth)
 */
export function createProxyServer({ keyring, stats, token }) {
  const startedAt = Date.now();

  const health = createHealthMonitor({
    ttlMs: getConfig().healthTtlMs || 60000,
    probe: async (args) => {
      const adapter = getAdapter(args.def);
      return adapter.healthCheck(args);
    },
  });

  async function checkProviderHealth(providerId, cfg, { force = false } = {}) {
    const def = resolveProvider(providerId, cfg);
    if (!def) return { status: 'unknown', checkedAt: Date.now() };
    const effDef = effectiveDef(def, cfg);
    if (!effDef.baseUrl) return { status: 'not-configured', checkedAt: Date.now() };
    let key = '';
    if (def.requiresKey !== false) {
      const entry = (await keyring.keysForProvider(providerId))[0];
      if (!entry) return { status: 'no-key', checkedAt: Date.now() };
      const full = await keyring.getKeyById(entry.id);
      key = full?.key || '';
    }
    return health.check(providerId, { def: effDef, key }, { force });
  }

  const proxyServer = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const origin = req.headers.origin;

    // CORS: only same-machine browser origins — never a wildcard
    if (isLocalOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      refreshConfigIfChanged();
      const cfg = getConfig();

      // ── Public ────────────────────────────────────────────────────────
      if (path === '/health' || path === '/') {
        const active = await resolveActiveProvider(cfg, keyring);
        sendJson(res, 200, {
          status: 'ok',
          proxy: 'BlitzProxy',
          version: VERSION,
          provider: active.def?.name || active.providerId,
          model: active.model || '',
          routing: cfg.profile ? `profile:${cfg.profile}` : cfg.routing,
          privacy: cfg.privacy === true,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        });
        return;
      }

      // ── Token-gated: admin + dashboard ────────────────────────────────
      if (path.startsWith('/admin') || path === '/dashboard') {
        if (!checkAuth(req, req.url, token)) {
          sendJson(res, 401, { error: { message: 'Unauthorized — provide the BlitzProxy token', type: 'authentication_error' } });
          return;
        }
        if (path === '/dashboard' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(DASHBOARD_HTML);
          return;
        }
        if (path === '/admin/stats' && req.method === 'GET') {
          const rows = stats.getSummary({ scope: 'today' });
          const allRows = stats.getSummary({ scope: 'all' });
          sendJson(res, 200, {
            today: rows,
            allTime: allRows,
            privacy: cfg.privacy === true,
            costIsEstimate: true,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          });
          return;
        }
        if (path === '/admin/health' && req.method === 'GET') {
          const providerIds = new Set([cfg.provider, ...(cfg.fallbackChain || [])]);
          const vaultIds = (await keyring.listKeys()).map(k => k.provider);
          for (const id of vaultIds) providerIds.add(id);
          if (cfg.profile === 'local' || cfg.provider === 'ollama') providerIds.add('ollama');
          providerIds.delete('');
          const out = {};
          for (const id of providerIds) {
            out[id] = await checkProviderHealth(id, cfg);
          }
          sendJson(res, 200, out);
          return;
        }
        if (path === '/admin/keys' && req.method === 'GET') {
          sendJson(res, 200, { keys: await keyring.listKeys() });
          return;
        }
        if (path === '/admin/keys' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 1024 * 1024));
          if (!body.key) {
            sendJson(res, 400, { error: { message: 'key is required', type: 'invalid_request' } });
            return;
          }
          try {
            const entry = await keyring.addKey({ key: body.key, provider: body.provider, name: body.name });
            sendJson(res, 200, { added: entry });
          } catch (err) {
            if (err.code === 'AMBIGUOUS_PROVIDER') {
              sendJson(res, 400, { error: { message: 'Ambiguous key prefix — specify "provider"', type: 'invalid_request', candidates: err.candidates } });
            } else {
              sendJson(res, 400, { error: { message: err.message, type: 'invalid_request' } });
            }
          }
          return;
        }
        const keyMatch = path.match(/^\/admin\/keys\/([a-f0-9]+)$/);
        if (keyMatch && req.method === 'DELETE') {
          const removed = await keyring.removeKey(keyMatch[1]);
          sendJson(res, removed ? 200 : 404, { removed });
          return;
        }
        if (path === '/admin/config' && req.method === 'GET') {
          const safe = { ...cfg };
          safe.customHeaders = Object.fromEntries(
            Object.entries(cfg.customHeaders || {}).map(([k]) => [k, '***']));
          sendJson(res, 200, safe);
          return;
        }
        sendJson(res, 404, { error: { message: `Unknown admin endpoint: ${path}`, type: 'not_found' } });
        return;
      }

      // ── API endpoints ─────────────────────────────────────────────────
      if (cfg.requireAuth && !checkAuth(req, req.url, token)) {
        if (path === '/v1/messages' || path === '/v1/chat/completions' || path === '/v1/responses') {
          sendAnthropicError(res, 401, 'authentication_error', 'BlitzProxy token required (set ANTHROPIC_API_KEY to the proxy token)');
        } else {
          sendJson(res, 401, { error: { message: 'BlitzProxy token required', type: 'authentication_error' } });
        }
        return;
      }

      if (path === '/v1/messages' && req.method === 'POST') {
        await handleMessages(req, res, path);
        return;
      }
      if (path === '/v1/models' && req.method === 'GET') {
        handleModels(req, res);
        return;
      }
      if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
        await handleCountTokens(req, res);
        return;
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res, path);
        return;
      }
      if (path === '/v1/responses' && req.method === 'POST') {
        await handleResponses(req, res, path);
        return;
      }

      sendJson(res, 404, { error: { type: 'not_found', message: `Unknown endpoint: ${path}` } });
    } catch (err) {
      log.error('[Proxy] Unhandled error:', err);
      sendAnthropicError(res, 500, 'api_error', err.message || 'Internal proxy error');
    }
  });

  proxyServer.maxConnections = 100;
  proxyServer.keepAliveTimeout = 65000;
  proxyServer.headersTimeout = 66000;

  return proxyServer;

  // ─── Anthropic Messages handler (candidate loop + fallback) ─────────────

  async function handleMessages(req, res, path) {
    const reqStart = Date.now();
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendAnthropicError(res, 413, 'invalid_request_error', 'Request body too large (limit: 10 MB)');
        return;
      }
      throw err;
    }

    let anthropicReq;
    try {
      anthropicReq = JSON.parse(raw);
    } catch {
      appendLog(`[${logTimestamp()}] ERROR 400 invalid_json ${path}`);
      sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON in request body');
      return;
    }

    const cfg = getConfig();
    const isStream = anthropicReq.stream === true;
    const needs = requestNeeds(anthropicReq);
    const estTokens = estimateTokens(anthropicReq);
    const plan = await planCandidates({ cfg, keyring, needs, estTokens, health });

    for (const w of plan.warnings) log.warn(`[Router] ${w}`);

    if (plan.candidates.length === 0) {
      sendAnthropicError(res, 503, 'api_error', 'No usable provider is configured. Add a key with: blitz add <api-key>');
      return;
    }

    log.proxy('in', `model=${anthropicReq.model || 'default'} stream=${isStream} msgs=${anthropicReq.messages?.length || 0} tools=${anthropicReq.tools?.length || 0} candidates=${plan.candidates.length}`);

    let lastCls = null;
    let lastDetail = '';

    for (let i = 0; i < plan.candidates.length; i++) {
      const cand = plan.candidates[i];
      const baseDef = resolveProvider(cand.provider, cfg);
      if (!baseDef) continue;
      const def = effectiveDef(baseDef, cfg);
      const adapter = getAdapter(def);
      const { body: openaiBody, toolIdMap } = translateRequest(anthropicReq, cand.model);
      const started = Date.now();

      try {
        const response = await withRetry(
          () => adapter.chat({
            def, key: cand.key, body: openaiBody, timeoutMs: cand.timeoutMs,
            extraHeaders: cfg.customHeaders,
          }),
          { maxRetries: cfg.maxRetries, baseDelay: cfg.retryBaseDelay }
        );

        if (!response.ok) {
          const errText = await response.text();
          response.__blitzTimers?.clear();
          const cls = enrichAuthMessage(
            classifyHttpError(response.status, errText, { fallbackOnAuthError: cfg.fallbackOnAuthError }),
            cand
          );
          const latencyMs = Date.now() - started;
          recordRequest(stats, {
            providerId: cand.provider, model: cand.model, ok: false,
            status: response.status, latencyMs, rateLimited: cls.kind === 'rate_limit',
          });
          appendLog(`[${logTimestamp()}] ERROR ${response.status} ${cls.kind} provider=${cand.provider} (${latencyMs}ms)`);

          const nextIdx = i + 1;
          const next = nextIdx < plan.candidates.length ? plan.candidates[nextIdx] : null;

          // Key rotation: another stored key exists for the SAME provider.
          // This is not a provider failover, so it happens even when
          // fallbackOnAuthError is false — and without poisoning health.
          if (cls.kind === 'auth' && next?.provider === cand.provider) {
            appendLog(`[${logTimestamp()}] ROTATE ${cand.provider} key rejected → trying next key`);
            lastCls = cls; lastDetail = errText;
            continue;
          }

          markProviderHealth(health, cand.provider, cls, response.status);

          if (cls.fallbackable && next) {
            appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${next.provider} reason=${cls.kind}`);
            lastCls = cls; lastDetail = errText;
            continue;
          }
          respondClassifiedError(res, cls, errText);
          return;
        }

        // ── Success: from here on, no provider switching mid-response ──
        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const result = await translateStream(response.body, res, toolIdMap, anthropicReq.model || cand.model);
          response.__blitzTimers?.clear();
          const latencyMs = Date.now() - reqStart;
          if (result.errored) {
            appendLog(`[${logTimestamp()}] ERROR stream-failed provider=${cand.provider} (${latencyMs}ms)`);
            recordRequest(stats, {
              providerId: cand.provider, model: cand.model, ok: false,
              status: 502, latencyMs,
            });
          } else {
            recordRequest(stats, {
              providerId: cand.provider, model: cand.model, ok: true, status: 200,
              latencyMs,
              inputTokens: result.inputTokens, outputTokens: result.outputTokens,
              fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
            });
            appendLog(`[${logTimestamp()}] POST ${path} → 200 OK (${latencyMs}ms) ${cand.provider}/${cand.model} [stream]`);
          }
          return;
        }

        const openaiRes = await response.json();
        response.__blitzTimers?.clear();
        const anthropicRes = translateResponse(openaiRes, toolIdMap, anthropicReq.model || cand.model);
        const latencyMs = Date.now() - started;
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: true, status: 200,
          latencyMs,
          inputTokens: anthropicRes.usage.input_tokens,
          outputTokens: anthropicRes.usage.output_tokens,
          fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
        });
        appendLog(`[${logTimestamp()}] POST ${path} → 200 OK (${Date.now() - reqStart}ms) ${cand.provider}/${cand.model}`);
        log.proxy('out', `stop=${anthropicRes.stop_reason} blocks=${anthropicRes.content.length} tokens=${anthropicRes.usage.output_tokens}`);
        sendJson(res, 200, anthropicRes);
        return;

      } catch (err) {
        const cls = classifyNetworkError(err);
        const latencyMs = Date.now() - started;
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: false,
          status: 502, latencyMs,
        });
        appendLog(`[${logTimestamp()}] ERROR ${cls.kind} provider=${cand.provider} (${latencyMs}ms)`);
        markProviderHealth(health, cand.provider, cls, 502);

        const nextIdx = i + 1;
        if (cls.fallbackable && nextIdx < plan.candidates.length) {
          const next = plan.candidates[nextIdx];
          appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${next.provider} reason=${cls.kind}`);
          lastCls = cls; lastDetail = err.message;
          continue;
        }
        respondClassifiedError(res, cls, err.message);
        return;
      }
    }

    if (lastCls) respondClassifiedError(res, lastCls, lastDetail);
    else sendAnthropicError(res, 502, 'api_error', 'All providers failed');
  }

  // ─── OpenAI-compatible passthrough handler ───────────────────────────────

  async function handleChatCompletions(req, res, path) {
    const reqStart = Date.now();
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        respondOpenAIError(res, 413, 'invalid_request', 'Request body too large');
        return;
      }
      throw err;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      respondOpenAIError(res, 400, 'invalid_request', 'Invalid JSON in request body');
      return;
    }

    const cfg = getConfig();
    const isStream = body.stream === true;
    const needs = requestNeedsOpenAI(body);
    const estTokens = estimateTokens(body);
    const plan = await planCandidates({ cfg, keyring, needs, estTokens, health });

    if (plan.candidates.length === 0) {
      respondOpenAIError(res, 503, 'api_error', 'No usable provider is configured');
      return;
    }

    let lastCls = null;

    for (let i = 0; i < plan.candidates.length; i++) {
      const cand = plan.candidates[i];
      const baseDef = resolveProvider(cand.provider, cfg);
      if (!baseDef) continue;
      const def = effectiveDef(baseDef, cfg);
      const adapter = getAdapter(def);
      const started = Date.now();

      try {
        const response = await withRetry(
          () => adapter.chat({
            def, key: cand.key,
            body: { ...body, model: cand.model },
            timeoutMs: cand.timeoutMs,
            extraHeaders: cfg.customHeaders,
          }),
          { maxRetries: cfg.maxRetries, baseDelay: cfg.retryBaseDelay }
        );

        if (!response.ok) {
          const errText = await response.text();
          response.__blitzTimers?.clear();
          const cls = enrichAuthMessage(
            classifyHttpError(response.status, errText, { fallbackOnAuthError: cfg.fallbackOnAuthError }),
            cand
          );
          recordRequest(stats, {
            providerId: cand.provider, model: cand.model, ok: false,
            status: response.status, latencyMs: Date.now() - started,
            rateLimited: cls.kind === 'rate_limit',
          });
          const nextIdx = i + 1;
          const next = nextIdx < plan.candidates.length ? plan.candidates[nextIdx] : null;
          if (cls.kind === 'auth' && next?.provider === cand.provider) {
            appendLog(`[${logTimestamp()}] ROTATE ${cand.provider} key rejected → trying next key`);
            lastCls = cls;
            continue;
          }
          markProviderHealth(health, cand.provider, cls, response.status);
          if (cls.fallbackable && next) {
            appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${next.provider} reason=${cls.kind}`);
            lastCls = cls;
            continue;
          }
          respondOpenAIError(res, response.status, cls.kind, cls.message + (errText ? ` — ${errText.slice(0, 300)}` : ''));
          return;
        }

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } catch (pipeErr) {
            log.error('[OpenAI-passthrough] stream pipe error:', pipeErr.message);
          }
          res.end();
          response.__blitzTimers?.clear();
          recordRequest(stats, {
            providerId: cand.provider, model: cand.model, ok: true, status: 200,
            latencyMs: Date.now() - reqStart,
            fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
          });
          appendLog(`[${logTimestamp()}] POST ${path} → 200 OK (${Date.now() - reqStart}ms) ${cand.provider}/${cand.model} [stream|openai]`);
          return;
        }

        const text = await response.text();
        response.__blitzTimers?.clear();
        let usage = null;
        try {
          const parsed = JSON.parse(text);
          usage = parsed?.usage || null;
        } catch { /* passthrough — no usage available */ }
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: true, status: 200,
          latencyMs: Date.now() - started,
          inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens,
          fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
        });
        appendLog(`[${logTimestamp()}] POST ${path} → 200 OK (${Date.now() - reqStart}ms) ${cand.provider}/${cand.model} [openai]`);
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(text);
        return;

      } catch (err) {
        const cls = classifyNetworkError(err);
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: false, status: 502,
          latencyMs: Date.now() - started,
        });
        markProviderHealth(health, cand.provider, cls, 502);
        const nextIdx = i + 1;
        if (cls.fallbackable && nextIdx < plan.candidates.length) {
          appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${plan.candidates[nextIdx].provider} reason=${cls.kind}`);
          lastCls = cls;
          continue;
        }
        respondOpenAIError(res, 502, cls.kind, cls.message);
        return;
      }
    }

    if (lastCls) respondOpenAIError(res, 502, lastCls.kind, lastCls.message);
    else respondOpenAIError(res, 502, 'api_error', 'All providers failed');
  }

  // ─── OpenAI Responses API handler (Codex CLI) ─────────────────────────────

  async function handleResponses(req, res, path) {
    const reqStart = Date.now();
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        respondOpenAIError(res, 413, 'invalid_request', 'Request body too large');
        return;
      }
      throw err;
    }
    let responsesReq;
    try {
      responsesReq = JSON.parse(raw);
    } catch {
      respondOpenAIError(res, 400, 'invalid_request', 'Invalid JSON in request body');
      return;
    }

    const cfg = getConfig();
    const isStream = responsesReq.stream === true;
    const { body: openaiBody } = translateResponsesRequest(responsesReq);
    const needs = {
      tools: Array.isArray(responsesReq.tools) && responsesReq.tools.length > 0,
      vision: JSON.stringify(responsesReq.input || '').includes('"input_image"'),
      reasoning: typeof responsesReq.reasoning?.effort === 'string',
      fast: false,
      streaming: isStream,
      maxTokens: responsesReq.max_output_tokens || 0,
    };
    const estTokens = estimateTokens({ messages: openaiBody.messages, tools: openaiBody.tools });
    const plan = await planCandidates({ cfg, keyring, needs, estTokens, health });

    if (plan.candidates.length === 0) {
      respondOpenAIError(res, 503, 'api_error', 'No usable provider is configured');
      return;
    }

    let lastCls = null;

    for (let i = 0; i < plan.candidates.length; i++) {
      const cand = plan.candidates[i];
      const baseDef = resolveProvider(cand.provider, cfg);
      if (!baseDef) continue;
      const def = effectiveDef(baseDef, cfg);
      const adapter = getAdapter(def);
      const started = Date.now();

      try {
        const response = await withRetry(
          () => adapter.chat({
            def, key: cand.key,
            body: { ...openaiBody, model: cand.model },
            timeoutMs: cand.timeoutMs,
            extraHeaders: cfg.customHeaders,
          }),
          { maxRetries: cfg.maxRetries, baseDelay: cfg.retryBaseDelay }
        );

        if (!response.ok) {
          const errText = await response.text();
          response.__blitzTimers?.clear();
          const cls = enrichAuthMessage(
            classifyHttpError(response.status, errText, { fallbackOnAuthError: cfg.fallbackOnAuthError }),
            cand
          );
          recordRequest(stats, {
            providerId: cand.provider, model: cand.model, ok: false,
            status: response.status, latencyMs: Date.now() - started,
            rateLimited: cls.kind === 'rate_limit',
          });
          const nextIdx = i + 1;
          const next = nextIdx < plan.candidates.length ? plan.candidates[nextIdx] : null;
          if (cls.kind === 'auth' && next?.provider === cand.provider) {
            appendLog(`[${logTimestamp()}] ROTATE ${cand.provider} key rejected → trying next key`);
            lastCls = cls;
            continue;
          }
          markProviderHealth(health, cand.provider, cls, response.status);
          if (cls.fallbackable && next) {
            appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${next.provider} reason=${cls.kind}`);
            lastCls = cls;
            continue;
          }
          respondOpenAIError(res, response.status, cls.kind, cls.message + (errText ? ` — ${errText.slice(0, 300)}` : ''));
          return;
        }

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const result = await translateResponsesStream(response.body, res, responsesReq.model || cand.model);
          response.__blitzTimers?.clear();
          const latencyMs = Date.now() - reqStart;
          recordRequest(stats, {
            providerId: cand.provider, model: cand.model,
            ok: !result.errored, status: result.errored ? 502 : 200,
            latencyMs,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
          });
          appendLog(`[${logTimestamp()}] POST ${path} → ${result.errored ? 'STREAM-ERROR' : '200 OK'} (${latencyMs}ms) ${cand.provider}/${cand.model} [responses|stream]`);
          return;
        }

        const openaiRes = await response.json();
        response.__blitzTimers?.clear();
        const out = translateResponsesResponse(openaiRes, responsesReq.model || cand.model);
        const latencyMs = Date.now() - started;
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: true, status: 200,
          latencyMs,
          inputTokens: out.usage.input_tokens, outputTokens: out.usage.output_tokens,
          fallbackTo: i > 0 ? plan.candidates[i - 1].provider : undefined,
        });
        appendLog(`[${logTimestamp()}] POST ${path} → 200 OK (${Date.now() - reqStart}ms) ${cand.provider}/${cand.model} [responses]`);
        sendJson(res, 200, out);
        return;

      } catch (err) {
        const cls = classifyNetworkError(err);
        recordRequest(stats, {
          providerId: cand.provider, model: cand.model, ok: false, status: 502,
          latencyMs: Date.now() - started,
        });
        markProviderHealth(health, cand.provider, cls, 502);
        const nextIdx = i + 1;
        if (cls.fallbackable && nextIdx < plan.candidates.length) {
          appendLog(`[${logTimestamp()}] FALLBACK ${cand.provider}→${plan.candidates[nextIdx].provider} reason=${cls.kind}`);
          lastCls = cls;
          continue;
        }
        respondOpenAIError(res, 502, cls.kind, cls.message);
        return;
      }
    }

    if (lastCls) respondOpenAIError(res, 502, lastCls.kind, lastCls.message);
    else respondOpenAIError(res, 502, 'api_error', 'All providers failed');
  }

  // ─── Models & token counting ─────────────────────────────────────────────

  function handleModels(req, res) {
    const cfg = getConfig();
    const data = [
      { id: 'claude-sonnet-4-20250514', object: 'model' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model' },
      { id: 'claude-3-haiku-20240307', object: 'model' },
      { id: 'claude-3-opus-20240229', object: 'model' },
    ];
    // Expose the configured provider's models too (OpenCode-friendly)
    const def = resolveProvider(cfg.provider, cfg);
    if (def && def.models) {
      for (const id of Object.keys(def.models)) {
        data.push({ id, object: 'model', owned_by: def.name });
      }
    }
    sendJson(res, 200, { object: 'list', data });
  }

  async function handleCountTokens(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendAnthropicError(res, 413, 'invalid_request_error', 'Request body too large');
        return;
      }
      throw err;
    }
    let reqBody = {};
    try {
      reqBody = JSON.parse(raw);
    } catch { /* estimate from empty body */ }

    const estimated = estimateTokens(reqBody);
    sendJson(res, 200, { input_tokens: estimated });
  }
}
