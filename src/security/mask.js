// ============================================================================
// BlitzProxy — Key Masking & Secret Redaction
// Never display or log full API keys anywhere.
// ============================================================================

/**
 * Mask an API key for display: shows only the last 4 characters.
 *   nvapi-abcdefgh1234  →  ●●●●1234
 * Short keys are fully masked.
 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '••••';
  if (key.length < 8) return '••••••••';
  return '••••' + key.slice(-4);
}

/**
 * Mask a key while keeping a recognizable provider prefix (if any),
 * e.g. `nvapi-••••a82f` or `gsk_••••91kd`. Only the known prefix is
 * ever revealed — never key material.
 */
const KNOWN_PREFIXES = ['nvapi-', 'gsk_', 'sk-or-', 'sk-or-v1-', 'csk-', 'github_pat_', 'hf_', 'xai-', 'AIza'];

export function maskKeyWithPrefix(key) {
  if (!key || typeof key !== 'string') return '••••••••';
  const prefix = KNOWN_PREFIXES.find(p => key.startsWith(p));
  const masked = maskKey(key);
  return prefix ? prefix + masked : masked;
}

/**
 * Redact secret-like strings from arbitrary text before logging/printing.
 * Catches Bearer tokens, x-api-key values, and long key-shaped strings.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, '$1••••')
    .replace(/(x-api-key\s*["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1••••')
    .replace(/\b(nvapi-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|sk-or-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{20,}|csk-[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,})/g,
      m => maskKeyWithPrefix(m));
}
