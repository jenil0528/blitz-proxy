// ============================================================================
// BlitzProxy — Unit Tests: openAICompatAdapter key validation & health
// Covers the anonymous-/models problem: some providers (e.g. NVIDIA) answer
// 200 to /v1/models for ANY Bearer token, so validateKey must confirm the
// key with a minimal real inference request, and deep health must too.
// ============================================================================

import assert from 'node:assert/strict';
import { openAICompatAdapter } from '../src/provider-registry.js';

const realFetch = globalThis.fetch;
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const def = {
  id: 'nim',
  name: 'NIM-like',
  baseUrl: 'https://api.example.test/v1',
  defaultModel: 'test/model',
  requiresKey: true,
  headers: {},
  timeout: 10000,
};

/** /models is anonymous (200 always); chat decides the key's fate. */
function stubAnonymousModels(chatStatus, chatBody = {}) {
  return async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse(200, { data: [] });
    return jsonResponse(chatStatus, chatBody);
  };
}

function withFetch(handler, fn) {
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}

console.log('\nvalidateKey — anonymous /models requires an inference probe');

await testAsync('200 on /models + accepted inference → valid (probe was performed)', () => {
  let chatProbed = false;
  return withFetch(async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse(200, { data: [] });
    chatProbed = true;
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  }, async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'nvapi-goodkey' });
    assert.equal(r.valid, true);
    assert.equal(r.status, 'ok');
    assert.equal(chatProbed, true, 'a real inference request must back the "valid" claim');
  });
});

await testAsync('200 on /models but inference 403 → INVALID (the dead-NVIDIA-key case)', () => {
  return withFetch(stubAnonymousModels(403, { status: 403, title: 'Forbidden', detail: 'Authorization failed' }), async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'nvapi-deadkey' });
    assert.equal(r.valid, false);
    assert.equal(r.status, 'auth-failed');
    assert.ok(r.message.includes('Authorization failed'), 'provider detail is surfaced');
  });
});

await testAsync('200 on /models but inference 401 → INVALID', () => {
  return withFetch(stubAnonymousModels(401, { detail: 'Authentication failed' }), async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'not-an-nvidia-key' });
    assert.equal(r.valid, false);
    assert.equal(r.status, 'auth-failed');
  });
});

await testAsync('inference 402 → invalid (billing/credits)', () => {
  return withFetch(stubAnonymousModels(402, {}), async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'k' });
    assert.equal(r.valid, false);
    assert.equal(r.status, 'billing');
  });
});

await testAsync('inference 429 → still valid (key works, just throttled)', () => {
  return withFetch(stubAnonymousModels(429, {}), async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'k' });
    assert.equal(r.valid, true);
    assert.equal(r.status, 'rate-limited');
  });
});

await testAsync('inference 400 → key accepted (auth precedes request validation)', () => {
  return withFetch(stubAnonymousModels(400, { error: { message: 'bad request' } }), async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'k' });
    assert.equal(r.valid, true);
  });
});

await testAsync('/models rejects with 401 directly → invalid, no inference probe needed', () => {
  let chatProbed = false;
  return withFetch(async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse(401, {});
    chatProbed = true;
    return jsonResponse(200, {});
  }, async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: 'k' });
    assert.equal(r.valid, false);
    assert.equal(r.status, 'auth-failed');
    assert.equal(chatProbed, false, 'no probe when /models already authenticated the answer');
  });
});

await testAsync('no key configured → invalid without touching the network', () => {
  let called = false;
  return withFetch(async () => { called = true; return jsonResponse(200, {}); }, async () => {
    const r = await openAICompatAdapter.validateKey({ def, key: '' });
    assert.equal(r.valid, false);
    assert.equal(r.status, 'no-key');
    assert.equal(called, false);
  });
});

await testAsync('no defaultModel → valid on reachable /models alone', () => {
  return withFetch(async (url) => {
    assert.ok(String(url).endsWith('/models'));
    return jsonResponse(200, { data: [] });
  }, async () => {
    const r = await openAICompatAdapter.validateKey({ def: { ...def, defaultModel: '' }, key: 'k' });
    assert.equal(r.valid, true);
  });
});

console.log('\nhealthCheck — deep vs cheap');

await testAsync('deep health exposes a dead key behind an anonymous /models', () => {
  return withFetch(stubAnonymousModels(403, { detail: 'Authorization failed' }), async () => {
    const deep = await openAICompatAdapter.healthCheck({ def, key: 'nvapi-dead', deep: true });
    assert.equal(deep.status, 'auth-failed');
    const cheap = await openAICompatAdapter.healthCheck({ def, key: 'nvapi-dead', deep: false });
    assert.equal(cheap.status, 'online', 'cheap probe stays cheap — the server layers passive marks on top');
  });
});

await testAsync('deep health stays online when inference works', () => {
  return withFetch(stubAnonymousModels(200, { choices: [] }), async () => {
    const h = await openAICompatAdapter.healthCheck({ def, key: 'k', deep: true });
    assert.equal(h.status, 'online');
  });
});

await testAsync('deep health skips the probe when no key is required', () => {
  let chatProbed = false;
  const localDef = { ...def, requiresKey: false, defaultModel: 'llama3', id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' };
  return withFetch(async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse(200, { data: [] });
    chatProbed = true;
    return jsonResponse(200, {});
  }, async () => {
    const h = await openAICompatAdapter.healthCheck({ def: localDef, key: '', deep: true });
    assert.equal(h.status, 'online');
    assert.equal(chatProbed, false);
  });
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
