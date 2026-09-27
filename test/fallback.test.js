// ============================================================================
// BlitzProxy — Unit Tests: Error Classification (Fallback decisions)
// ============================================================================

import assert from 'node:assert/strict';
import { classifyHttpError, classifyNetworkError, describeKind } from '../src/routing/fallback.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nclassifyHttpError');

test('429 → rate_limit, fallbackable', () => {
  const c = classifyHttpError(429, 'rate limited');
  assert.equal(c.kind, 'rate_limit');
  assert.equal(c.fallbackable, true);
  assert.equal(c.retryable, true);
});

test('401 → auth, NOT fallbackable by default', () => {
  const c = classifyHttpError(401, 'invalid key');
  assert.equal(c.kind, 'auth');
  assert.equal(c.fallbackable, false);
  assert.equal(c.retryable, false);
});

test('401 → auth, fallbackable only when explicitly opted in', () => {
  const c = classifyHttpError(401, 'invalid key', { fallbackOnAuthError: true });
  assert.equal(c.kind, 'auth');
  assert.equal(c.fallbackable, true);
});

test('400 with context overflow text → context_overflow, fallbackable', () => {
  const c = classifyHttpError(400, 'This model maximum context length is 4096. However, you requested 50000 tokens');
  assert.equal(c.kind, 'context_overflow');
  assert.equal(c.fallbackable, true);
});

test('400 context_length_exceeded variant also detected', () => {
  const c = classifyHttpError(400, '{"error":{"code":"context_length_exceeded"}}');
  assert.equal(c.kind, 'context_overflow');
});

test('plain 400 → invalid_request, NOT fallbackable', () => {
  const c = classifyHttpError(400, 'missing required parameter');
  assert.equal(c.kind, 'invalid_request');
  assert.equal(c.fallbackable, false);
});

test('404 → model_not_found, fallbackable', () => {
  const c = classifyHttpError(404, 'model not found');
  assert.equal(c.kind, 'model_not_found');
  assert.equal(c.fallbackable, true);
});

test('410 Gone (model retired) → model_not_found, fallbackable', () => {
  const c = classifyHttpError(410, '{"title":"Gone","status":410,"detail":"model retired"}');
  assert.equal(c.kind, 'model_not_found');
  assert.equal(c.fallbackable, true);
  assert.equal(c.retryable, false);
});

test('model-not-found in body text detected even with 400', () => {
  const c = classifyHttpError(400, 'The model does not exist or you do not have access');
  assert.equal(c.kind, 'model_not_found');
});

test('413 → payload_too_large, NOT fallbackable', () => {
  const c = classifyHttpError(413, 'too large');
  assert.equal(c.kind, 'payload_too_large');
  assert.equal(c.fallbackable, false);
});

test('500/502/503 → server, fallbackable', () => {
  for (const s of [500, 502, 503]) {
    const c = classifyHttpError(s, 'oops');
    assert.equal(c.kind, 'server');
    assert.equal(c.fallbackable, true);
  }
});

test('408 → timeout, fallbackable', () => {
  const c = classifyHttpError(408, 'slow');
  assert.equal(c.kind, 'timeout');
  assert.equal(c.fallbackable, true);
});

console.log('\nclassifyNetworkError');

test('connection refused → fallbackable', () => {
  const c = classifyNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  assert.equal(c.kind, 'connection_refused');
  assert.equal(c.fallbackable, true);
});

test('abort/timeout → timeout, fallbackable', () => {
  const c = classifyNetworkError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
  assert.equal(c.kind, 'timeout');
  assert.equal(c.fallbackable, true);
});

test('DNS failure → dns, fallbackable', () => {
  const c = classifyNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  assert.equal(c.kind, 'dns');
  assert.equal(c.fallbackable, true);
});

test('generic fetch failed → network, fallbackable', () => {
  const c = classifyNetworkError(new TypeError('fetch failed'));
  assert.equal(c.kind, 'network');
  assert.equal(c.fallbackable, true);
});

test('TLS errors are NOT fallbackable (fail fast)', () => {
  const c = classifyNetworkError(new Error('unable to verify the first certificate (CERT_HAS_EXPIRED)'));
  assert.equal(c.kind, 'tls');
  assert.equal(c.fallbackable, false);
});

test('describeKind maps every kind to a label', () => {
  for (const kind of ['rate_limit', 'auth', 'invalid_request', 'model_not_found', 'context_overflow', 'server', 'timeout', 'network']) {
    const label = describeKind(kind);
    assert.ok(label && label.length > 3, `no label for ${kind}`);
  }
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
