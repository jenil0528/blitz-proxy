// ============================================================================
// BlitzProxy — LAN Bind Guard
// Local-first by default: loopback binding with no auth stays exactly as it
// is. Binding to a non-loopback interface (LAN IP / 0.0.0.0 / public IPv6)
// EXPOSES YOUR API KEYS to everyone on the network — so it is only allowed
// when authentication is explicitly enabled. The server refuses to start
// otherwise; this is a configuration error, not a warning.
// ============================================================================

/**
 * Is this host a loopback address? (localhost, 127.0.0.0/8, ::1)
 * Empty/undefined hosts count as loopback — they fall back to Node's
 * loopback default.
 */
export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Assert that the bind configuration is safe.
 * Throws a clear configuration error when a non-loopback host is requested
 * without authentication. Local behavior is never touched.
 */
export function assertSafeBind(cfg) {
  const host = String(cfg?.host || '').trim();
  if (isLoopbackHost(host)) return; // local-first default — unchanged

  if (cfg.requireAuth !== true) {
    throw new Error(
      `Refusing to start: "host" is set to "${host}" (non-loopback) with authentication disabled.\n` +
      `Anyone on your network could then use your API keys through BlitzProxy.\n` +
      `Fix one of:\n` +
      `  blitz config set requireAuth true    # require the proxy token for /v1/* too\n` +
      `  blitz config set host 127.0.0.1      # go back to local-only binding`
    );
  }
}
