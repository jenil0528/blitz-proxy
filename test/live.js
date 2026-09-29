// ============================================================================
// BlitzProxy — LIVE integration tests (explicit opt-in only)
//
//   BLITZ_LIVE_TESTS=1 node test/live.js      (or: npm run test:live)
//
// These tests use your REAL configuration and credentials against the REAL
// upstream provider — they cost a few tokens. They never run in normal CI
// (`npm test` does not include this file) and never print key material.
//
// Skipped (exit 0) unless BLITZ_LIVE_TESTS is set.
// ============================================================================

if (process.env.BLITZ_LIVE_TESTS !== '1') {
  console.log('\nLive tests SKIPPED — set BLITZ_LIVE_TESTS=1 to run them against your real provider.\n');
  process.exit(0);
}

import assert from 'node:assert/strict';

const { initApp, getConfig, saveConfig } = await import('../src/config.js');
const keyring = await import('../src/security/keyring.js');
const { resolveActiveProvider } = await import('../src/routing/router.js');
const { resolveCredential } = await import('../src/credentials.js');
const { getAdapter } = await import('../src/provider-registry.js');
const { createProxyServer } = await import('../src/server.js');
const { createStats } = await import('../src/stats.js');
const { getProxyToken } = await import('../src/security/auth.js');
const { validateConfig, formatValidation } = await import('../src/config-validate.js');

await initApp();
const cfg = getConfig();
const active = await resolveActiveProvider(cfg, keyring);
const cred = await resolveCredential({ keyring, providerId: active.providerId });
if (!cred && active.source !== 'env') {
  console.error('No credential stored for the active provider — add one first: blitz add <key>');
  process.exit(1);
}

const token = await getProxyToken(keyring);
const stats = createStats({ home: process.env.BLITZ_HOME || process.env.USERPROFILE + '/.blitzproxy', privacy: true });
const server = createProxyServer({ keyring, stats, token });

const baseUrl = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

let passed = 0, failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

const reqTimeout = active.def?.timeout || 300000;

async function post(path, body) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(reqTimeout + 10000),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

console.log(`\nLIVE tests — provider: ${active.def?.name} (${active.model || 'default'})`);
console.log('Credentials are used as configured; keys are never printed.\n');

await test('configuration is valid', async () => {
  const r = validateConfig(cfg, { credentials: await keyring.listKeys() });
  if (!r.ok) throw new Error(formatValidation(r));
});

await test('active credential passes real validation', async () => {
  const adapter = getAdapter(active.def);
  const v = await adapter.validateKey({ def: active.def, key: active.key });
  if (v.valid !== true) throw new Error(v.message);
});

await test('GET /health responds', async () => {
  const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.proxy, 'BlitzProxy');
});

await test('GET /v1/models lists models', async () => {
  const res = await fetch(baseUrl + '/v1/models', { signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.data) && data.data.length > 0);
});

await test('POST /v1/messages (Anthropic) — non-stream', async () => {
  const { status, text } = await post('/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  assert.equal(data.type, 'message');
});

await test('POST /v1/messages (Anthropic) — streaming', async () => {
  const { status, text } = await post('/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  assert.equal(status, 200);
  assert.ok(text.includes('message_start'), 'SSE event sequence present');
  assert.ok(text.includes('message_stop'));
});

await test('POST /v1/messages (Anthropic) — tool call round-trip', async () => {
  const { status, text } = await post('/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 64,
    tools: [{ name: 'echo', description: 'echo the input', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }],
    messages: [{ role: 'user', content: 'Call the echo tool with x=1. Do not answer in text.' }],
  });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  assert.ok(data.content?.some(c => c.type === 'tool_use'), 'expected a tool_use block');
});

await test('POST /v1/chat/completions (OpenAI) — non-stream', async () => {
  const { status, text } = await post('/v1/chat/completions', {
    model: 'gpt-4o',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  assert.ok(data.choices?.length >= 1);
});

await test('POST /v1/responses (Codex format) — non-stream', async () => {
  const { status, text } = await post('/v1/responses', {
    model: 'gpt-5',
    max_output_tokens: 16,
    input: 'Reply with exactly: OK',
  });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  assert.ok(data.output !== undefined, 'Responses-shaped object returned');
});

await new Promise(resolve => server.close(resolve));

console.log(`\n${passed + failed} live tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
