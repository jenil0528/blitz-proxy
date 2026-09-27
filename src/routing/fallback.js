// ============================================================================
// BlitzProxy — Error Classification for Fallback
// Clearly distinguishes error kinds and decides whether switching providers
// could help. Auth errors and invalid requests do NOT failover by default —
// failing loudly is safer than silently burning a different provider's quota.
// ============================================================================

const CONTEXT_OVERFLOW_RE = /context[_ ]?(length|window)|context_length_exceeded|maximum context|exceeds? (the )?.*context|too (many|long) (input )?tokens?|input.*too long|prompt is too long/i;
const MODEL_NOT_FOUND_RE = /model.*(not (found|exist))|invalid model|unknown model|does not have a model/i;

/**
 * Classify an HTTP error from a provider.
 * @returns {{ kind, fallbackable, retryable, message }}
 */
export function classifyHttpError(status, bodyText, opts = {}) {
  const text = typeof bodyText === 'string' ? bodyText.slice(0, 2000) : '';

  if (status === 429) {
    return { kind: 'rate_limit', fallbackable: true, retryable: true, message: 'Rate limited by provider' };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      fallbackable: opts.fallbackOnAuthError === true,
      retryable: false,
      message: `Provider rejected authentication (HTTP ${status}) — check your API key for this provider`,
    };
  }
  if (status === 404 || status === 410 || MODEL_NOT_FOUND_RE.test(text)) {
    return { kind: 'model_not_found', fallbackable: true, retryable: false, message: 'Model not available on provider (retired or unknown)' };
  }
  if (status === 413) {
    return { kind: 'payload_too_large', fallbackable: false, retryable: false, message: 'Request payload too large' };
  }
  if (status === 408) {
    return { kind: 'timeout', fallbackable: true, retryable: true, message: 'Provider request timeout' };
  }
  if (status === 400 || status === 422) {
    if (CONTEXT_OVERFLOW_RE.test(text)) {
      return {
        kind: 'context_overflow',
        fallbackable: true,
        retryable: false,
        message: 'Request exceeds the model context window',
      };
    }
    return {
      kind: 'invalid_request',
      fallbackable: false,
      retryable: false,
      message: 'Provider rejected the request as invalid',
    };
  }
  if (status >= 500) {
    return { kind: 'server', fallbackable: true, retryable: true, message: `Provider server error (HTTP ${status})` };
  }
  return {
    kind: 'unknown_http',
    fallbackable: status >= 500,
    retryable: false,
    message: `Provider returned HTTP ${status}`,
  };
}

/**
 * Classify a network-level failure (fetch threw).
 */
export function classifyNetworkError(err, opts = {}) {
  const msg = String(err?.message || err || '');
  const code = String(err?.cause?.code || err?.code || '');

  if (/abort/i.test(err?.name || '') || /timed? out|ETIMEDOUT/i.test(msg + code)) {
    return { kind: 'timeout', fallbackable: true, retryable: true, message: 'Provider timed out' };
  }
  if (/ECONNREFUSED/.test(msg + code)) {
    return { kind: 'connection_refused', fallbackable: true, retryable: false, message: 'Provider refused connection (server not running?)' };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg + code)) {
    return { kind: 'dns', fallbackable: true, retryable: true, message: 'DNS resolution failed for provider URL' };
  }
  if (/ECONNRESET|EPIPE|UND_ERR|socket|fetch failed|network/i.test(msg + code)) {
    return { kind: 'network', fallbackable: true, retryable: true, message: 'Network error contacting provider' };
  }
  if (/CERT_|self-signed|certificate/i.test(msg + code)) {
    return { kind: 'tls', fallbackable: false, retryable: false, message: 'TLS certificate error contacting provider' };
  }
  return { kind: 'network', fallbackable: true, retryable: true, message: msg || 'Network error' };
}

/**
 * Human-readable label per kind (used by CLI/dashboard).
 */
export function describeKind(kind) {
  const map = {
    rate_limit: 'Rate limited',
    auth: 'Authentication failed',
    invalid_request: 'Invalid request',
    model_not_found: 'Model unavailable',
    context_overflow: 'Context window overflow',
    payload_too_large: 'Payload too large',
    server: 'Provider outage',
    timeout: 'Timeout',
    connection_refused: 'Connection refused',
    dns: 'DNS failure',
    network: 'Network error',
    tls: 'TLS error',
  };
  return map[kind] || 'Unknown error';
}
