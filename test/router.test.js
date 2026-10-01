// ============================================================================
// BlitzProxy — Unit Tests: Router (candidate planning)
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'blitz-router-test-'));
process.env.BLITZ_HOME = home;
process.env.BLITZ_KEYRING = 'memory';
process.env.BLITZ_CONFIG = join(home, 'config.json');
delete process.env.API_KEY;

const { loadConfig, saveConfig, getConfig } = await import('../src/config.js');
const keyring = await import('../src/security/keyring.js');
const { planCandidates, resolveActiveProvider, availableProviders } = await import('../src/routing/router.js');
const { createHealthMonitor } = await import('../src/routing/health.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nrouter');

loadConfig();

await test('setup: keys for nvidia + groq, active nvidia', async () => {
  await keyring.addKey({ key: 'nvapi-routertest1111aaaa' }); // → nvidia, auto-activates
  await keyring.addKey({ key: 'gsk_routertest2222bbbb', provider: 'groq' });
  const active = await resolveActiveProvider(getConfig(), keyring);
  assert.equal(active.providerId, 'nvidia');
});

await test('manual mode: active provider first, then fallback chain', async () => {
  saveConfig({ provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', routing: 'manual', fallbackChain: ['groq'], profile: '' });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 100,
  });
  assert.equal(plan.candidates.length, 2);
  assert.equal(plan.candidates[0].provider, 'nvidia');
  assert.equal(plan.candidates[0].model, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(plan.candidates[1].provider, 'groq');
  assert.equal(plan.candidates[1].model, 'llama-3.3-70b-versatile', 'fallback uses its provider default');
});

await test('capability mismatch is skipped when an alternative exists', async () => {
  // meta/codellama-70b has tools:false in the catalog — a tools request must skip it
  saveConfig({ provider: 'nvidia', model: 'meta/codellama-70b', routing: 'manual', fallbackChain: ['groq'], profile: '' });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 50,
  });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].provider, 'groq', 'nvidia/meta/codellama-70b must be skipped for tool requests');
});

await test('capability warnings but candidates kept when no alternative exists', async () => {
  saveConfig({ provider: 'nvidia', model: 'meta/codellama-70b', routing: 'manual', fallbackChain: [], profile: '' });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 50,
  });
  assert.equal(plan.candidates.length, 1, 'single candidate used with warning rather than failing');
  assert.equal(plan.candidates[0].provider, 'nvidia');
});

await test('auto mode ranks by health then priority', async () => {
  saveConfig({ routing: 'auto', profile: '', fallbackChain: [] });
  const monitor = createHealthMonitor({
    ttlMs: 60000,
    probe: async () => ({ status: 'online', latencyMs: 1 }),
  });
  // Seed the snapshot: groq healthy, nvidia rate-limited
  await monitor.check('groq', {}, { force: true });
  const monitorWithState = {
    snapshot: () => ({
      groq: { status: 'online', latencyMs: 1 },
      nvidia: { status: 'rate-limited', latencyMs: 1 },
    }),
  };
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: {}, estTokens: 0, health: monitorWithState,
  });
  assert.ok(plan.candidates.length >= 2);
  assert.equal(plan.candidates[0].provider, 'groq', 'healthy provider must outrank the rate-limited one');
  assert.equal(plan.source, 'auto');
});

await test('profile chain drives candidates', async () => {
  saveConfig({ routing: 'manual', profile: 'coding', fallbackChain: [], provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 100,
  });
  assert.equal(plan.source, 'profile:coding');
  const providers = plan.candidates.map(c => c.provider);
  assert.ok(providers.includes('nvidia'));
  assert.ok(providers.includes('deepseek') === false, 'deepseek has no key in this test vault');
});

await test('local-only profile never falls back to cloud providers', async () => {
  saveConfig({ routing: 'manual', profile: 'local', fallbackChain: ['groq'], provider: 'nvidia' });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: {}, estTokens: 0,
  });
  for (const c of plan.candidates) {
    assert.equal(c.provider, 'ollama', 'local profile must only produce ollama');
  }
  saveConfig({ profile: '' });
});

await test('providers without keys are unavailable', async () => {
  const avail = await availableProviders(getConfig(), keyring);
  assert.ok(avail.includes('nvidia'));
  assert.ok(avail.includes('groq'));
  assert.ok(!avail.includes('deepseek'), 'no deepseek key in vault');
  assert.ok(avail.includes('ollama'), 'ollama needs no key');
});

await test('overflow requests prefer larger context windows', async () => {
  saveConfig({ routing: 'manual', profile: '', provider: 'nvidia', fallbackChain: ['groq'], fallbackModels: {} });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: {}, estTokens: 60000, // near qwen 32k limit
  });
  // nvidia llama-3.3 (131k) must still lead; both are viable
  assert.equal(plan.candidates[0].provider, 'nvidia');
});

await test('multiple keys per provider → one candidate per key, active key first', async () => {
  await keyring.addKey({ key: 'nvapi-routertest3333dddd' }); // second nvidia key
  saveConfig({ routing: 'manual', profile: '', provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', fallbackChain: ['groq'] });
  const plan = await planCandidates({
    cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 100,
  });
  assert.deepEqual(plan.candidates.map(x => x.provider), ['nvidia', 'nvidia', 'groq'],
    'nvidia yields one candidate per stored key, then the fallback provider');
  assert.equal(plan.candidates[0].key, 'nvapi-routertest1111aaaa', 'active key goes first');
  assert.equal(plan.candidates[1].key, 'nvapi-routertest3333dddd', 'second key rotates on rejection');
  assert.equal(plan.candidates[2].key, 'gsk_routertest2222bbbb');
});

await test('STRICT mode: an explicit model failure can never switch — fallback chain ignored', async () => {
  saveConfig({
    routing: 'manual', profile: '', fallbackMode: 'strict',
    provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b',
    fallbackChain: ['groq'], fallbackModels: {},
  });
  const plan = await planCandidates({ cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 100 });
  assert.equal(plan.candidates.length, 2, 'both NVIDIA credentials remain — rotation is not a model switch');
  for (const c of plan.candidates) {
    assert.equal(c.provider, 'nvidia', 'no other provider may appear in strict mode');
    assert.equal(c.model, 'nvidia/nemotron-3-super-120b-a12b', 'the explicit model only');
  }
  assert.ok(plan.warnings.some(w => w.includes('strict mode')), 'the ignored chain is surfaced loudly');
});

await test('STRICT mode: a capability mismatch returns a clear error — never a silent switch', async () => {
  // meta/codellama-70b is tools:false — enabled mode switches to an alternative;
  // strict mode must REFUSE with a client-visible error instead of switching.
  saveConfig({
    routing: 'manual', profile: '', fallbackMode: 'strict',
    provider: 'nvidia', model: 'meta/codellama-70b',
    fallbackChain: ['groq'], fallbackModels: {},
  });
  const plan = await planCandidates({ cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 50 });
  assert.equal(plan.candidates.length, 0, 'strict refuses to route an incompatible explicit selection');
  assert.ok(plan.fatalError, 'a clear client-visible error is surfaced');
  assert.ok(plan.fatalError.includes('Capability mismatch'), 'the error names the mismatch');
  assert.ok(plan.fatalError.includes('meta/codellama-70b'), 'the error names the model');
  assert.ok(plan.fatalError.includes('does not switch models'), 'the error explains the policy');
});

await test('ENABLED mode (default): fallback chain + capability switching still work', async () => {
  saveConfig({
    routing: 'manual', profile: '', fallbackMode: 'enabled',
    provider: 'nvidia', model: 'meta/codellama-70b',
    fallbackChain: ['groq'], fallbackModels: {},
  });
  const plan = await planCandidates({ cfg: getConfig(), keyring, needs: { tools: true }, estTokens: 50 });
  assert.equal(plan.candidates[0].provider, 'groq', 'capability mismatch switches when fallback is enabled');
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
