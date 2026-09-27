// ============================================================================
// BlitzProxy — Unit Tests: Capabilities, Profiles, Health formatting
// ============================================================================

import assert from 'node:assert/strict';
import { estimateTokens, requestNeeds, requestNeedsOpenAI, modelSatisfies, contextHeadroom } from '../src/routing/capabilities.js';
import { BUILT_IN_PROFILES, parseChainEntry, getProfile, listProfiles, resolveProfileChain } from '../src/routing/profiles.js';
import { createHealthMonitor, formatHealth } from '../src/routing/health.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\ncapabilities');

test('estimateTokens grows with request size (chars/4)', () => {
  const small = estimateTokens({ messages: [{ role: 'user', content: 'hello' }] });
  const big = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  assert.ok(small > 0);
  assert.ok(big > small * 10);
});

test('requestNeeds detects tools, vision, reasoning, streaming', () => {
  const needs = requestNeeds({
    tools: [{ name: 't' }],
    stream: true,
    thinking: { type: 'enabled' },
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }] }],
  });
  assert.equal(needs.tools, true);
  assert.equal(needs.vision, true);
  assert.equal(needs.reasoning, true);
  assert.equal(needs.streaming, true);
});

test('requestNeeds: plain text needs nothing special', () => {
  const needs = requestNeeds({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(needs.tools, false);
  assert.equal(needs.vision, false);
});

test('requestNeedsOpenAI detects image_url parts', () => {
  const needs = requestNeedsOpenAI({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] }],
  });
  assert.equal(needs.vision, true);
  assert.equal(requestNeedsOpenAI({ messages: [{ role: 'user', content: 'hi' }] }).vision, false);
});

test('modelSatisfies rejects tool requests for tool-less models', () => {
  const sat = modelSatisfies('nvidia', 'meta/codellama-70b', { tools: true }, 100);
  assert.equal(sat.ok, false);
  assert.ok(sat.reasons.length > 0);
});

test('modelSatisfies accepts capable models', () => {
  const sat = modelSatisfies('nvidia', 'meta/llama-3.3-70b-instruct', { tools: true }, 1000);
  assert.equal(sat.ok, true);
});

test('modelSatisfies detects context overflow', () => {
  const sat = modelSatisfies('groq', 'gemma2-9b-it', { tools: false }, 99999);
  assert.equal(sat.ok, false);
  assert.ok(sat.reasons.some(r => r.includes('context')));
});

test('unknown models pass permissively with a note', () => {
  const sat = modelSatisfies('nvidia', 'brand/new-model', { tools: true }, 100);
  assert.equal(sat.ok, true);
  assert.equal(sat.known, false);
});

test('contextHeadroom orders bigger windows higher', () => {
  assert.ok(contextHeadroom('groq', 'llama-3.3-70b-versatile', 20000) > contextHeadroom('groq', 'gemma2-9b-it', 20000));
  assert.equal(contextHeadroom('custom', 'anything', 1000), Infinity);
});

console.log('\nprofiles');

test('built-in profiles exist', () => {
  for (const name of ['coding', 'fast', 'free', 'local']) {
    assert.ok(BUILT_IN_PROFILES[name], `missing ${name}`);
    assert.ok(BUILT_IN_PROFILES[name].chain.length > 0);
  }
  assert.equal(BUILT_IN_PROFILES.local.localOnly, true);
});

test('parseChainEntry splits provider/model on known provider', () => {
  assert.deepEqual(parseChainEntry('groq', ['groq', 'nvidia']), { provider: 'groq', model: '' });
  assert.deepEqual(parseChainEntry('nvidia/meta/llama-3.3-70b-instruct', ['nvidia', 'groq']), { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' });
  // slash in model but not a provider → whole thing is a provider name
  assert.deepEqual(parseChainEntry('some/model', ['groq']), { provider: 'some/model', model: '' });
});

test('getProfile resolves built-ins and user profiles', () => {
  assert.equal(getProfile('coding').builtIn, true);
  assert.equal(getProfile('nope'), null);
  const user = getProfile('mine', { profiles: { mine: { chain: ['nvidia'] } } });
  assert.equal(user.builtIn, false);
  assert.deepEqual(user.chain, ['nvidia']);
});

test('resolveProfileChain drops unknown providers', () => {
  const r = resolveProfileChain('coding', {}, ['nvidia', 'deepseek', 'openrouter', 'groq']);
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 4);
  const r2 = resolveProfileChain('coding', {}, ['nvidia']);
  assert.equal(r2.candidates.length, 1);
  assert.ok(r2.skipped.length > 0);
});

test('listProfiles merges built-ins and user profiles', () => {
  const all = listProfiles({ profiles: { mine: { chain: ['nvidia'] } } });
  assert.ok(all.some(p => p.name === 'coding'));
  assert.ok(all.some(p => p.name === 'mine'));
});

console.log('\nhealth monitor');

await testAsync('health monitor caches within TTL and re-probes after', async () => {
  let probes = 0;
  const monitor = createHealthMonitor({ ttlMs: 50, probe: async () => { probes++; return { status: 'online', latencyMs: 5 }; } });
  const a = await monitor.check('x', {});
  const b = await monitor.check('x', {});
  assert.equal(probes, 1, 'cached within TTL');
  assert.equal(b.checkedAt, a.checkedAt);
  await new Promise(r => setTimeout(r, 60));
  await monitor.check('x', {});
  assert.equal(probes, 2, 're-probed after TTL expiry');
  monitor.invalidate('x');
  await monitor.check('x', {});
  assert.equal(probes, 3, 're-probed after invalidation');
});

await testAsync('markStatus pins a real request outcome over probe results', async () => {
  let probes = 0;
  const monitor = createHealthMonitor({ ttlMs: 50, probe: async () => { probes++; return { status: 'online', latencyMs: 5 }; } });
  monitor.markStatus('nvidia', 'auth-failed', { httpStatus: 403, message: 'Key rejected on a real request' });
  const h = await monitor.check('nvidia', {});
  assert.equal(h.status, 'auth-failed');
  assert.equal(h.httpStatus, 403);
  assert.equal(probes, 0, 'a live mark must be trusted over a cheap probe');
  assert.equal(monitor.snapshot().nvidia.status, 'auth-failed', 'snapshot shows the mark');
  assert.equal(monitor.get('nvidia').status, 'auth-failed');
});

await testAsync('expired marks fall back to probing', async () => {
  let probes = 0;
  const monitor = createHealthMonitor({ ttlMs: 50, probe: async () => { probes++; return { status: 'online', latencyMs: 5 }; } });
  monitor.markStatus('nvidia', 'auth-failed', { holdMs: 30 });
  await new Promise(r => setTimeout(r, 40));
  const h = await monitor.check('nvidia', {});
  assert.equal(h.status, 'online');
  assert.equal(probes, 1, 'probe resumes once the mark expires');
  assert.equal(monitor.snapshot().nvidia.status, 'online');
});

test('invalidate clears marks as well as probe cache', () => {
  const monitor = createHealthMonitor({ ttlMs: 50, probe: async () => ({ status: 'online' }) });
  monitor.markStatus('nvidia', 'auth-failed');
  assert.equal(monitor.get('nvidia').status, 'auth-failed');
  monitor.invalidate('nvidia');
  assert.equal(monitor.get('nvidia'), null);
});

test('formatHealth labels map correctly', () => {
  assert.equal(formatHealth({ status: 'online', latencyMs: 100 }).label, 'ONLINE');
  assert.equal(formatHealth({ status: 'rate-limited' }).label, 'RATE-LIMITED');
  assert.equal(formatHealth({ status: 'auth-failed' }).label, 'AUTH-FAILED');
  assert.equal(formatHealth({ status: 'offline' }).label, 'OFFLINE');
  assert.equal(formatHealth(null).label, 'UNKNOWN');
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
