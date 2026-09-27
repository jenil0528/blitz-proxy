// ============================================================================
// BlitzProxy — Unit Tests: Secure Keyring
// Runs with BLITZ_KEYRING=file + a temp BLITZ_HOME so no OS keychain is touched.
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'blitz-keyring-test-'));
process.env.BLITZ_HOME = home;
process.env.BLITZ_KEYRING = 'file';

const keyring = await import('../src/security/keyring.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nkeyring (file-backed vault)');

await test('init detects forced file mode', async () => {
  const mode = await keyring.initKeyring();
  assert.equal(mode, 'file');
});

await test('addKey auto-detects provider from prefix', async () => {
  const entry = await keyring.addKey({ key: 'nvapi-testkey1111aaaa' });
  assert.equal(entry.provider, 'nvidia');
  assert.equal(entry.isActive, true);
  assert.ok(entry.maskedKey.startsWith('nvapi-'));
  assert.ok(!entry.maskedKey.includes('testkey1111'), 'key material must not appear in masked output');
});

await test('addKey with explicit provider skips detection', async () => {
  const entry = await keyring.addKey({ key: 'custom-shaped-key-0000bbbb', provider: 'together' });
  assert.equal(entry.provider, 'together');
});

await test('addKey allows multiple keys per provider (rotation)', async () => {
  const countBefore = await keyring.keyCount();
  const entry = await keyring.addKey({ key: 'nvapi-second-key-2222cccc' });
  const countAfter = await keyring.keyCount();
  assert.equal(countAfter, countBefore + 1, 'a second key for the same provider is added, not replaced');
  const keys = await keyring.listKeys();
  const nvidiaKeys = keys.filter(k => k.provider === 'nvidia');
  assert.equal(nvidiaKeys.length, 2);
  assert.ok(nvidiaKeys.some(k => k.id === entry.id));
  assert.notEqual(entry.name, 'NVIDIA NIM', 'duplicate display names get a suffix');
});

await test('addKey is idempotent for the exact same key', async () => {
  const countBefore = await keyring.keyCount();
  const again = await keyring.addKey({ key: 'nvapi-second-key-2222cccc' });
  const countAfter = await keyring.keyCount();
  assert.equal(countAfter, countBefore, 'identical key material is never stored twice');
  const nvidiaKeys = (await keyring.listKeys()).filter(k => k.provider === 'nvidia');
  assert.equal(nvidiaKeys.length, 2);
  assert.ok(again.maskedKey, 'the existing entry is returned');
});

await test('ambiguous sk- throws AMBIGUOUS_PROVIDER', async () => {
  await assert.rejects(
    () => keyring.addKey({ key: 'sk-somekey1234567890abcdef' }),
    (err) => err.code === 'AMBIGUOUS_PROVIDER' && Array.isArray(err.candidates),
  );
});

await test('listKeys never exposes key material', async () => {
  const keys = await keyring.listKeys();
  for (const k of keys) {
    assert.ok(!JSON.stringify(k).includes('testkey1111'));
    assert.ok(!JSON.stringify(k).includes('second-key-2222'));
    assert.ok(typeof k.maskedKey === 'string');
  }
});

await test('setActiveKey + getActiveKey', async () => {
  const keys = await keyring.listKeys();
  const target = keys.find(k => k.provider === 'together');
  await keyring.setActiveKey(target.id);
  const active = await keyring.getActiveKey();
  assert.equal(active.id, target.id);
  assert.equal(active.provider, 'together');
  assert.equal(active.key, 'custom-shaped-key-0000bbbb');
});

await test('removeProviderKeys clears a provider and re-points active', async () => {
  const removed = await keyring.removeProviderKeys('together');
  assert.equal(removed, 1);
  const active = await keyring.getActiveKey();
  assert.notEqual(active?.provider, 'together');
  assert.equal(await keyring.hasProvider('together'), false);
});

await test('generic secrets (proxy token)', async () => {
  await keyring.setSecret('authtoken', 'test-token-abc');
  assert.equal(await keyring.getSecret('authtoken'), 'test-token-abc');
  assert.equal(await keyring.getSecret('missing'), null);
  assert.equal(await keyring.deleteSecret('authtoken'), true);
  assert.equal(await keyring.getSecret('authtoken'), null);
});

await test('importLegacyKeys migrates v1 plaintext entries preserving ids', async () => {
  const legacyActiveId = 'legacy0001';
  const migrated = await keyring.importLegacyKeys([
    { id: legacyActiveId, name: 'My Groq', key: 'gsk_legacygskkey9999x', provider: 'groq', providerName: 'Groq', createdAt: '2024-01-01' },
    { id: 'legacy0002', name: 'Old', key: 'zz-no-provider-bad', provider: 'nosuch', createdAt: '2024-01-01' },
  ], legacyActiveId);
  assert.ok(migrated >= 1);
  const active = await keyring.getActiveKey();
  assert.equal(active.id, legacyActiveId);
  assert.equal(active.key, 'gsk_legacygskkey9999x');
  assert.equal(await keyring.hasProvider('groq'), true);
});

await test('vault persists to disk (0600 plaintext fallback file)', async () => {
  const { readFileSync, statSync, existsSync } = await import('fs');
  const vaultPath = join(home, 'keys.json');
  assert.ok(existsSync(vaultPath), 'vault file must exist in file mode');
  const raw = readFileSync(vaultPath, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.keys));
  assert.ok(parsed.keys.length > 0);
  // POSIX enforces 0600; Windows maps chmod to ACLs, so only check there
  if (process.platform !== 'win32') {
    const mode = statSync(vaultPath).mode & 0o777;
    assert.equal(mode, 0o600, `vault file must be 0600, got ${mode.toString(8)}`);
  }
});

await test('removeKey deletes an entry by id', async () => {
  const keys = await keyring.listKeys();
  const victim = keys[0];
  assert.equal(await keyring.removeKey(victim.id), true);
  assert.equal(await keyring.getKeyById(victim.id), null);
});

await test('vault changes made by another process (the CLI) are picked up', async () => {
  const { readFileSync, writeFileSync } = await import('fs');
  const vaultPath = join(home, 'keys.json');
  const before = await keyring.keyCount();
  // Simulate the CLI rewriting the vault while this process (the server) runs
  const raw = JSON.parse(readFileSync(vaultPath, 'utf-8'));
  raw.keys.push({
    id: 'external1', name: 'External Groq', key: 'gsk_externalkey9999zzzz',
    provider: 'groq', providerName: 'Groq', createdAt: new Date().toISOString(),
  });
  writeFileSync(vaultPath, JSON.stringify(raw), 'utf-8');
  assert.equal(await keyring.keyCount(), before + 1, 'external write must be visible after refresh');
  assert.equal(await keyring.hasProvider('groq'), true);
});

await test('identical-content rewrite does not leave a stale mtime (no reload loop)', async () => {
  const { readFileSync, writeFileSync, statSync } = await import('fs');
  const vaultPath = join(home, 'keys.json');
  const count = await keyring.keyCount();
  // Rewrite the SAME bytes — mtime changes but content does not.
  writeFileSync(vaultPath, readFileSync(vaultPath, 'utf-8'), 'utf-8');
  // First call refreshes (mtime changed); subsequent calls must be stable.
  const afterFirst = await keyring.keyCount();
  const afterSecond = await keyring.keyCount();
  assert.equal(afterFirst, count);
  assert.equal(afterSecond, count);
  assert.ok(statSync(vaultPath).mtimeMs > 0);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
