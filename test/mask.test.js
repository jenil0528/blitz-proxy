// ============================================================================
// BlitzProxy — Unit Tests: Key Masking & Secret Redaction
// ============================================================================

import assert from 'node:assert/strict';
import { maskKey, maskKeyWithPrefix, redactSecrets } from '../src/security/mask.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nmaskKey / maskKeyWithPrefix / redactSecrets');

test('maskKey shows only last 4 chars', () => {
  assert.equal(maskKey('nvapi-abcdefgh1234'), '••••1234');
  assert.equal(maskKey('gsk_xxxxxxxxxxxx91kd'), '••••91kd');
  assert.equal(maskKey('sk-or-v1-7f2a99b2c3'), '••••b2c3');
});

test('maskKey handles short/empty keys safely', () => {
  assert.equal(maskKey(''), '••••');
  assert.equal(maskKey(null), '••••');
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey('1234567'), '••••••••'); // 7 chars < 8 → fully masked
});

test('maskKey never reveals the middle of a key', () => {
  const key = 'nvapi-SECRETSECRETSECRETa82f';
  const masked = maskKey(key);
  assert.ok(!masked.includes('SECRET'), 'masked key must not contain key material');
  assert.equal(masked, '••••a82f');
});

test('maskKeyWithPrefix keeps only the known provider prefix', () => {
  assert.equal(maskKeyWithPrefix('nvapi-SECRETSECRETa82f'), 'nvapi-••••a82f');
  assert.equal(maskKeyWithPrefix('gsk_SECRET91kd'), 'gsk_••••91kd');
  assert.equal(maskKeyWithPrefix('sk-or-v1-SECRET7x2p'), 'sk-or-••••7x2p');
  assert.equal(maskKeyWithPrefix('AIzaSECRET7x2p'), 'AIza••••7x2p');
  const unknown = 'zzzzzzzzzzzzzzzz1234';
  assert.equal(maskKeyWithPrefix(unknown), '••••1234'); // unknown prefix not leaked
});

test('redactSecrets strips Bearer tokens and key-shaped strings', () => {
  const line = 'Authorization: Bearer gsk_abcdefghijklmnop1234 failed';
  const out = redactSecrets(line);
  assert.ok(!out.includes('abcdefghijklmnop1234'), 'bearer token must be redacted');
  assert.ok(out.includes('••••'), 'masked form present');
});

test('redactSecrets leaves ordinary text untouched', () => {
  const line = 'POST /v1/messages → 200 OK (123ms) groq/llama-3.3-70b-versatile';
  assert.equal(redactSecrets(line), line);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
