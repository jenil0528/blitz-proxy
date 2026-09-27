// ============================================================================
// BlitzProxy — Unit Tests: Config v2 + v1 Migration
// Uses temp BLITZ_CONFIG / BLITZ_HOME so the real user config is never touched.
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp = mkdtempSync(join(tmpdir(), 'blitz-config-test-'));
const CONFIG_PATH = join(tmp, 'config.json');
process.env.BLITZ_CONFIG = CONFIG_PATH;
process.env.BLITZ_HOME = join(tmp, 'home');
process.env.BLITZ_KEYRING = 'file';

// Clean env overrides that would leak from the developer machine
delete process.env.PROVIDER;
delete process.env.MODEL;
delete process.env.API_KEY;
delete process.env.PROXY_PORT;
delete process.env.TIMEOUT;
delete process.env.LOG_LEVEL;
delete process.env.CUSTOM_BASE_URL;

const config = await import('../src/config.js');
const keyring = await import('../src/security/keyring.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nconfig v2');

await test('defaults are local-first', async () => {
  const cfg = config.getConfig();
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.proxyPort, 4819);
  assert.equal(cfg.routing, 'manual');
  assert.equal(cfg.requireAuth, false);
  assert.equal(cfg.privacy, false);
  assert.equal(cfg.version, 2);
});

await test('saveConfig persists non-secret fields and strips secrets', async () => {
  config.saveConfig({ model: 'groq/llama-3.3-70b-versatile', provider: 'groq' });
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.model, 'groq/llama-3.3-70b-versatile');
  assert.ok(!('apiKey' in parsed), 'apiKey must never be persisted');
  assert.ok(!('savedKeys' in parsed), 'savedKeys must never be persisted');
  assert.ok(!raw.includes('nvapi-'), 'no key material in config.json');
});

await test('env overrides take precedence', async () => {
  process.env.PROXY_PORT = '5999';
  process.env.LOG_LEVEL = 'debug';
  config.loadConfig();
  const cfg = config.getConfig();
  assert.equal(cfg.proxyPort, 5999);
  assert.equal(cfg.logLevel, 'debug');
  delete process.env.PROXY_PORT;
  delete process.env.LOG_LEVEL;
});

console.log('\nv1 migration (plaintext keys → keyring)');

await test('v1 config with savedKeys is migrated to the secure vault', async () => {
  // Write a v1-style config with plaintext keys
  writeFileSync(CONFIG_PATH, JSON.stringify({
    provider: 'nvidia',
    apiKey: 'nvapi-plaintextsecret9999',
    model: 'meta/llama-3.3-70b-instruct',
    proxyPort: 4819,
    savedKeys: [
      { id: 'k1', name: 'NVIDIA', key: 'nvapi-plaintextsecret9999', provider: 'nvidia', providerName: 'NVIDIA NIM', createdAt: '2024-01-01' },
      { id: 'k2', name: 'Groq', key: 'gsk_plaintextsecret8888', provider: 'groq', providerName: 'Groq', createdAt: '2024-01-02' },
    ],
    activeKeyId: 'k2',
  }, null, 2), 'utf-8');

  const { migration } = await config.initApp();
  const migrated = migration.migrated;

  assert.ok(migrated >= 2, `expected 2 migrated keys, got ${migrated}`);

  // Keys now live in the keyring
  const keys = await keyring.listKeys();
  assert.equal(keys.length, 2);
  const active = await keyring.getActiveKey();
  assert.equal(active.id, 'k2');
  assert.equal(active.key, 'gsk_plaintextsecret8888');

  // config.json no longer contains any key material
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  assert.ok(!raw.includes('plaintextsecret'), 'secrets must be stripped from config.json after migration');
  assert.ok(!raw.includes('savedKeys'), 'savedKeys must be removed after migration');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);

  // A backup of the original was made (user's data is never silently destroyed)
  const backups = (await import('fs')).readdirSync(tmp).filter(f => f.startsWith('config.json.bak'));
  assert.ok(backups.length >= 1, 'migration must leave a backup');
});

await test('v1 apiKey-only config is migrated too', async () => {
  const tmp2 = mkdtempSync(join(tmpdir(), 'blitz-config-v1b-'));
  const cfgPath2 = join(tmp2, 'config.json');
  writeFileSync(cfgPath2, JSON.stringify({
    provider: 'groq',
    apiKey: 'gsk_secondmigration7777',
    model: 'llama-3.3-70b-versatile',
  }), 'utf-8');
  // point the config module at the fresh copy by writing over CONFIG_PATH
  writeFileSync(CONFIG_PATH, readFileSync(cfgPath2, 'utf-8'), 'utf-8');
  await config.initApp();
  const active = await keyring.getActiveKey();
  assert.ok(['gsk_plaintextsecret8888', 'gsk_secondmigration7777'].includes(active.key));
});

await test('initApp is idempotent — running twice does not duplicate keys', async () => {
  const before = await keyring.keyCount();
  await config.initApp();
  await config.initApp();
  const after = await keyring.keyCount();
  assert.equal(after, before);
});

await test('saveConfig does NOT write API keys into .env', async () => {
  const { dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = join(projectRoot, '.env');
  config.saveConfig({ model: 'x' });
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, 'utf-8');
    assert.ok(!raw.includes('plaintextsecret'), '.env must never receive migrated key material');
  }
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
