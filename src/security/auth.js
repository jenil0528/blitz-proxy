// ============================================================================
// BlitzProxy — Local Proxy Authentication
// A per-install random token protects administrative endpoints.
// "blitz" (and any static string) is never used as a token.
// ============================================================================

import { randomBytes } from 'crypto';
import { timingSafeEqual } from 'crypto';

const TOKEN_SECRET_NAME = 'authtoken';

/**
 * Get (or create on first use) the local proxy token from the keyring.
 * Returns a 32-char url-safe random token.
 */
export async function getProxyToken(keyring) {
  let token = await keyring.getSecret(TOKEN_SECRET_NAME);
  if (!token) {
    token = randomBytes(24).toString('base64url');
    await keyring.setSecret(TOKEN_SECRET_NAME, token);
  }
  return token;
}

/**
 * Constant-time token comparison.
 */
export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract the caller-supplied token from a request:
 *   x-api-key header, Authorization: Bearer, or ?token= (dashboard only).
 */
export function extractToken(req, url) {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader) return apiKeyHeader;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (url) {
    try {
      const parsed = new URL(url, 'http://localhost');
      const t = parsed.searchParams.get('token');
      if (t) return t;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Check an incoming request against the expected token.
 */
export function checkAuth(req, url, expectedToken) {
  if (!expectedToken) return true; // no token configured → nothing to enforce
  const supplied = extractToken(req, url);
  return supplied !== null && tokenMatches(supplied, expectedToken);
}
