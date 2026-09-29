// ============================================================================
// BlitzProxy — Unit Tests: Canonical Credential Resolution & Smart Rotation
// BLITZ_KEYRING=memory (set by the runner) — no OS keychain, no real keys.
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'blitz-creds-test-'));
process.env.BLITZ_HOME = home;
process.env.BLITZ_KEYRING = 'memory';
delete process.env.API_KEY;

const keyring = await import('../src/security/keyring.js');
const creds = await import('../src/credentials.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\ncredential resolver');

await test('setup: two nvidia credentials + one groq', async () => {
  await keyring.addKey({ key: 'nvapi-credAAAA1111aaaa', name: 'NVIDIA Main' });
  await keyring.addKey({ key: 'nvapi-credBBBB2222bbbb', name: 'NVIDIA Backup' });
  await keyring.addKey({ key: 'gsk_credCCCC3333cccc', provider: 'groq' });
  const keys = await keyring.listKeys();
  assert.equal(keys.filter(k => k.provider === 'nvidia').length, 2);
  assert.equal(keys.filter(k => k.provider === 'groq').length, 1);
});

await test('resolveCredential: vault-active credential wins for its provider', async () => {
  const c = await creds.resolveCredential({ keyring, providerId: 'nvidia' });
  const active = await keyring.getActiveKey();
  assert.equal(c.provider, 'nvidia');
  assert.equal(c.id, active.id);
  assert.ok(c.key.startsWith('nvapi-'));
});

await test('resolveCredential: explicit credentialId is honored when it matches the provider', async () => {
  const backup = (await keyring.listKeys()).find(k => k.name === 'NVIDIA Backup');
  const c = await creds.resolveCredential({ keyring, providerId: 'nvidia', credentialId: backup.id });
  assert.equal(c.id, backup.id);
});

await test('resolveCredential: explicit credentialId for ANOTHER provider falls through to priority order', async () => {
  const groqEntry = (await keyring.listKeys()).find(k => k.provider === 'groq');
  const c = await creds.resolveCredential({ keyring, providerId: 'nvidia', credentialId: groqEntry.id });
  assert.equal(c.provider, 'nvidia');
});

await test('resolveCredential: null when the provider has no credentials', async () => {
  const c = await creds.resolveCredential({ keyring, providerId: 'deepseek' });
  assert.equal(c, null);
});

await test('rejection: a 401/403-rejected credential is skipped in favor of healthy ones', async () => {
  const active = await keyring.getActiveKey();
  creds.markCredentialRejected(active.id);
  const c = await creds.resolveCredential({ keyring, providerId: 'nvidia' });
  assert.notEqual(c.id, active.id, 'rejected credential must not be selected first');
  // success clears the rejection
  creds.markCredentialHealthy(c.id);
  assert.equal(creds.isCredentialRejected(c.id), false);
  // cleanup: restore the original state
  creds.markCredentialHealthy(active.id);
});

await test('rejection: last-resort fallback still reaches an invalid credential when all are rejected', async () => {
  const all = (await keyring.keysForProvider('nvidia'));
  for (const e of all) creds.markCredentialRejected(e.id);
  const c = await creds.resolveCredential({ keyring, providerId: 'nvidia' });
  assert.ok(c, 'resolver must still return a credential as a last resort');
  for (const e of all) creds.markCredentialHealthy(e.id); // cleanup
});

await test('rate-limit cooldown: 429 credential deprioritized but outranks invalid ones', async () => {
  const active = await keyring.getActiveKey();
  const backup = (await keyring.listKeys()).find(k => k.name === 'NVIDIA Backup');
  creds.markCredentialRateLimited(active.id, 5000);
  const ordered = await creds.resolveCredentials({ keyring, providerId: 'nvidia' });
  assert.equal(ordered[0].id, backup.id, 'healthy credential must rotate in before a cooling one');
  assert.ok(ordered.some(c => c.id === active.id), 'cooling credential stays available as a later option');
  assert.equal(creds.isCredentialCooldown(active.id), true);
  assert.equal(creds.isCredentialRejected(active.id), false, '429 is not invalid');
  // cleanup
  creds.markCredentialHealthy(active.id);
});

await test('failure ordering: more failures rank lower among healthy credentials', async () => {
  const active = await keyring.getActiveKey();
  const backup = (await keyring.listKeys()).find(k => k.name === 'NVIDIA Backup');
  // give the ACTIVE one two failures without invalidating it (short hold)
  creds.markCredentialRejected(active.id, 1); // expires immediately
  creds.markCredentialRejected(active.id, 1);
  creds.markCredentialRejected(active.id, 1);
  const ordered = await creds.resolveCredentials({ keyring, providerId: 'nvidia' });
  assert.equal(ordered[0].id, backup.id, 'fewer failures ranks first');
  creds.markCredentialHealthy(active.id);
  creds.markCredentialHealthy(backup.id);
});

await test('stats: successes/failures tracked without key material', async () => {
  const active = await keyring.getActiveKey();
  creds.markCredentialHealthy(active.id);
  const stats = creds.credentialStats();
  const mine = stats.find(s => s.id === active.id);
  assert.ok(mine, 'stats include the credential');
  assert.ok(mine.successes >= 1);
  assert.equal(JSON.stringify(stats).includes('nvapi-'), false, 'stats must never contain key material');
  assert.equal(mine.state, 'healthy');
});

await test('expiry: rejections auto-expire after their hold window', async () => {
  const active = await keyring.getActiveKey();
  creds.markCredentialRejected(active.id, 30);
  assert.equal(creds.isCredentialRejected(active.id), true);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(creds.isCredentialRejected(active.id), false);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
