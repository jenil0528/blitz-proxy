// ============================================================================
// BlitzProxy — Unit Tests: Configuration Validation & LAN Bind Guard
// Read-only checks — validation never mutates config.
// ============================================================================

import assert from 'node:assert/strict';
import { validateConfig, formatValidation } from '../src/config-validate.js';
import { assertSafeBind, isLoopbackHost } from '../src/security/lan.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const baseValid = {
  version: 2,
  provider: 'nvidia',
  model: 'z-ai/glm-5.3',
  routing: 'manual',
  profile: '',
  profiles: {},
  aliases: {},
  discoveredModels: {},
  fallbackChain: ['groq'],
  fallbackModels: {},
  fallbackOnAuthError: false,
  proxyPort: 4819,
  host: '127.0.0.1',
  requireAuth: false,
  customBaseUrl: '',
  customHeaders: {},
  customProviders: {},
  maxRetries: 3,
  retryBaseDelay: 500,
  logRequests: true,
  logLevel: 'info',
  privacy: false,
  healthTtlMs: 60000,
  timeout: 120000,
};

function validate(cfg, credentials = []) {
  return validateConfig(cfg, { credentials });
}

console.log('\nconfig validation');

await test('a valid configuration passes with no errors', async () => {
  const r = validate(baseValid, [{ id: 'k1', name: 'NVIDIA Main', provider: 'nvidia', maskedKey: 'nvapi-••••aaaa' }]);
  assert.equal(r.ok, true, JSON.stringify(r.sections.flatMap(s => s.errors)));
  assert.equal(r.sections.length, 7);
});

await test('unknown active provider is an error', async () => {
  const r = validate({ ...baseValid, provider: 'nosuch' });
  assert.equal(r.ok, false);
  const providers = r.sections.find(s => s.name === 'Providers');
  assert.ok(providers.errors.some(e => e.includes('nosuch')));
});

await test('custom provider with invalid URL is an error', async () => {
  const r = validate({ ...baseValid, customProviders: { mine: { baseUrl: 'not a url' } } });
  assert.equal(r.ok, false);
  assert.ok(r.sections[0].errors.some(e => e.includes('mine')));
});

await test('custom provider with non-http protocol is an error', async () => {
  const r = validate({ ...baseValid, customProviders: { mine: { baseUrl: 'ftp://example.com/v1' } } });
  assert.equal(r.ok, false);
  assert.ok(r.sections[0].errors.some(e => e.includes('http')));
});

await test('plain http to a non-local host warns (unencrypted credentials)', async () => {
  const r = validate({ ...baseValid, customProviders: { mine: { baseUrl: 'http://api.example.com/v1' } } });
  assert.equal(r.ok, true, 'warned but valid');
  assert.ok(r.sections[0].warnings.some(w => w.includes('unencrypted')));
});

await test('active provider without a stored credential warns', async () => {
  const r = validate(baseValid, []); // nvidia active, no credentials passed
  assert.equal(r.ok, true);
  const credSection = r.sections.find(s => s.name === 'Credentials');
  assert.ok(credSection.warnings.some(w => w.includes('no stored credential')));
});

await test('credential for an unknown provider warns', async () => {
  const r = validate(baseValid, [{ id: 'k1', name: 'Odd', provider: 'nosuchprov', maskedKey: 'x••••yyyy' }]);
  assert.ok(r.sections.find(s => s.name === 'Credentials').warnings.some(w => w.includes('unknown provider')));
});

await test('duplicate identical keys for a provider warn', async () => {
  const r = validate(baseValid, [
    { id: 'k1', name: 'A', provider: 'nvidia', maskedKey: 'nvapi-••••aaaa' },
    { id: 'k2', name: 'B', provider: 'nvidia', maskedKey: 'nvapi-••••aaaa' },
  ]);
  assert.ok(r.sections.find(s => s.name === 'Credentials').warnings.some(w => w.includes('twice')));
});

await test('active model missing from the catalog warns (custom models allowed)', async () => {
  const r = validate({ ...baseValid, model: 'brand/new-model' });
  assert.equal(r.ok, true);
  assert.ok(r.sections.find(s => s.name === 'Models').warnings.some(w => w.includes('brand/new-model')));
});

await test('nonexistent active profile is an error', async () => {
  const r = validate({ ...baseValid, profile: 'ghost' });
  assert.equal(r.ok, false);
  assert.ok(r.sections.find(s => s.name === 'Profiles').errors.some(e => e.includes('ghost')));
});

await test('profile chain referencing an unknown provider warns', async () => {
  const r = validate({ ...baseValid, profile: 'mine', profiles: { mine: { chain: ['nvidia', 'nosuchprov'] } } });
  assert.equal(r.ok, true);
  assert.ok(r.sections.find(s => s.name === 'Profiles').warnings.some(w => w.includes('nosuchprov')));
});

await test('circular fallback (active provider in its own chain) warns', async () => {
  const r = validate({ ...baseValid, fallbackChain: ['groq', 'nvidia'] });
  assert.equal(r.ok, true);
  assert.ok(r.sections.find(s => s.name === 'Fallback chains').warnings.some(w => w.includes('Circular')));
});

await test('invalid routing value is an error', async () => {
  const r = validate({ ...baseValid, routing: 'sometimes' });
  assert.equal(r.ok, false);
});

await test('invalid port is an error', async () => {
  assert.equal(validate({ ...baseValid, proxyPort: 99999 }).ok, false);
  assert.equal(validate({ ...baseValid, proxyPort: 0 }).ok, false);
  assert.equal(validate({ ...baseValid, proxyPort: '4819' }).ok, false);
});

await test('invalid timeout values are errors', async () => {
  assert.equal(validate({ ...baseValid, timeout: -1 }).ok, false);
  assert.equal(validate({ ...baseValid, retryBaseDelay: -5 }).ok, false);
  assert.equal(validate({ ...baseValid, maxRetries: 1.5 }).ok, false);
  assert.equal(validate({ ...baseValid, healthTtlMs: 0 }).ok, false);
});

await test('validation never mutates the config object', async () => {
  const snapshot = JSON.stringify(baseValid);
  validate({ ...baseValid, provider: 'nosuch', proxyPort: -2 });
  assert.equal(JSON.stringify(baseValid), snapshot);
});

await test('formatting contains no secrets and marks errors', async () => {
  const r = validate({ ...baseValid, provider: 'nosuch' }, [
    { id: 'k1', name: 'N', provider: 'nvidia', maskedKey: 'nvapi-••••aaaa' },
  ]);
  const text = formatValidation(r);
  assert.ok(text.includes('✗'));
  assert.ok(text.includes('INVALID'));
  assert.ok(!text.includes('nvapi-AAAA') && !text.includes('nvapi-xxxx'));
});

console.log('\nLAN bind guard');

test('loopback hosts are recognized', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost(''), true);
  assert.equal(isLoopbackHost(undefined), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('localhost without auth: allowed (default behavior unchanged)', () => {
  assert.doesNotThrow(() => assertSafeBind({ host: '127.0.0.1', requireAuth: false }));
  assert.doesNotThrow(() => assertSafeBind({ host: 'localhost', requireAuth: false }));
  assert.doesNotThrow(() => assertSafeBind({ host: '::1', requireAuth: false }));
  assert.doesNotThrow(() => assertSafeBind({ host: '', requireAuth: false }));
});

test('non-loopback without auth: REFUSES to start', () => {
  for (const host of ['0.0.0.0', '192.168.1.10', '::', 'myserver.local']) {
    assert.throws(() => assertSafeBind({ host, requireAuth: false }), /Refusing to start/, host);
  }
});

test('non-loopback WITH auth: allowed', () => {
  for (const host of ['0.0.0.0', '192.168.1.10']) {
    assert.doesNotThrow(() => assertSafeBind({ host, requireAuth: true }));
  }
});

await test('config validation catches the unsafe LAN bind too', async () => {
  const r = validate({ ...baseValid, host: '0.0.0.0', requireAuth: false });
  assert.equal(r.ok, false);
  assert.ok(r.sections.find(s => s.name === 'Network & security').errors.some(e => e.includes('refuses to start')));
  const r2 = validate({ ...baseValid, host: '0.0.0.0', requireAuth: true });
  assert.equal(r2.ok, true);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
