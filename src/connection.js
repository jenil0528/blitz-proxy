// ============================================================================
// BlitzProxy — Connection Manager
// HTTP timeout management and optimised fetch wrapper
//
// Node.js 18+ uses undici for the built-in `fetch()`.  Undici manages its own
// connection pool internally — the old `http.Agent` / `https.Agent` style of
// pooling does NOT apply to `fetch()`.  Connection keep-alive and socket reuse
// are handled automatically by undici without any extra configuration.
// ============================================================================

import * as log from './logger.js';

/**
 * Optimized fetch with connection reuse and separate connect/read timeouts.
 *
 * @param {string} url
 * @param {Object} options - Standard fetch options
 * @param {Object} timeouts
 * @param {number} timeouts.connect - Connection timeout in ms (default: 10000)
 * @param {number} timeouts.read - Overall read timeout in ms (default: 300000)
 * @returns {Promise<Response>}
 */
export async function fetchWithPool(url, options = {}, timeouts = {}) {
  const {
    connect: connectTimeout = 10000,
    read: readTimeout = 300000,
  } = timeouts;

  // Use the smaller of connect/read for the abort signal
  // The connect timeout catches dead servers fast,
  // the read timeout is handled by the overall AbortSignal
  const controller = new AbortController();
  const signal = controller.signal;

  // Connect timeout — fires fast if server is unreachable
  const connectTimer = setTimeout(() => {
    controller.abort(new Error(`Connection timeout after ${connectTimeout}ms`));
  }, connectTimeout);
  connectTimer.unref?.();

  // Read timeout — overall deadline for the full response
  const readTimer = setTimeout(() => {
    controller.abort(new Error(`Read timeout after ${readTimeout}ms`));
  }, readTimeout);
  readTimer.unref?.();

  const clearTimers = () => {
    clearTimeout(connectTimer);
    clearTimeout(readTimer);
  };

  try {
    const response = await fetch(url, {
      ...options,
      signal,
      // Node.js 18+ undici dispatcher for keepalive is automatic
    });

    // Connection established — clear the connect timer
    clearTimeout(connectTimer);

    // The read timer guards body consumption; the caller clears it once the
    // body has been fully consumed via response.__blitzTimers.clear().
    try {
      Object.defineProperty(response, '__blitzTimers', {
        value: { clear: clearTimers },
        enumerable: false,
        writable: false,
        configurable: true,
      });
    } catch { /* non-fatal */ }

    return response;
  } catch (err) {
    clearTimers();
    throw err;
  }
}

/**
 * Cleanup on process exit.
 * Connection clean-up is handled automatically by undici; this is a no-op
 * kept for backward compatibility with any external callers.
 */
export function destroyAgents() {
  // No-op: undici (Node.js built-in fetch) manages its own pool lifecycle.
}
