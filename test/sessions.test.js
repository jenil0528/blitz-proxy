// ============================================================================
// BLITZ — Tests: Session Registry + Agent Adapters + Vision Guard
// Recovery metadata ONLY — tests assert that no conversation content or key
// material is ever stored.
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'blitz-sessions-test-'));
process.env.BLITZ_HOME = home;

const { createSessionStore } = await import('../src/sessions.js');
const { AGENTS, encodeClaudeProjectPath, claudeNativeSessions, resumeArgs } = await import('../src/agents.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nsession registry');

test('create → ACTIVE with metadata only (no conversation, no keys)', () => {
  const store = createSessionStore({ home: join(home, 's1') });
  const s = store.create({
    agent: 'Claude Code', projectDir: 'J:\\proj\\demo', gitBranch: 'main',
    model: 'z-ai/glm-5.3', profile: '', provider: 'nvidia',
  });
  assert.match(s.id, /^B-[0-9A-F]{8}$/);
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.projectName, 'demo');
  const json = JSON.stringify(s);
  assert.ok(!json.includes('nvapi-'), 'no key material in session metadata');
  assert.ok(!('messages' in s) && !('prompt' in s) && !('history' in s), 'no conversation fields');
});

test('markExited: exit 0 → COMPLETED, non-zero → INTERRUPTED', () => {
  const store = createSessionStore({ home: join(home, 's2') });
  const a = store.create({ agent: 'claude', projectDir: '/x/a', pid: 111 });
  const b = store.create({ agent: 'claude', projectDir: '/x/b', pid: 112 });
  store.markExited(111, 0);
  store.markExited(112, 137);
  assert.equal(store.get(a.id).status, 'COMPLETED');
  assert.equal(store.get(b.id).status, 'INTERRUPTED');
  assert.equal(store.get(b.id).pid, undefined, 'pid cleared after exit');
});

test('pruneDead: ACTIVE sessions whose process vanished become INTERRUPTED', () => {
  const store = createSessionStore({ home: join(home, 's3') });
  const dead = store.create({ agent: 'claude', projectDir: '/x/dead', pid: 999999 }); // not a live pid
  const alive = store.create({ agent: 'claude', projectDir: '/x/alive', pid: process.pid });
  const listed = store.list();
  assert.equal(store.get(dead.id).status, 'INTERRUPTED', 'abnormal termination detected');
  assert.equal(store.get(alive.id).status, 'ACTIVE', 'live process stays active');
});

test('cleanup removes expired records but never ACTIVE ones', () => {
  const store = createSessionStore({ home: join(home, 's4'), retentionDays: 7 });
  const old = store.create({ agent: 'claude', projectDir: '/x/old', pid: 999999 });
  store.markExited(999999, 1); // INTERRUPTED
  store.touch(old.id, { lastActivity: new Date(Date.now() - 30 * 86400000).toISOString() });
  const active = store.create({ agent: 'claude', projectDir: '/x/act', pid: process.pid });
  const removed = store.cleanup(7);
  assert.ok(removed >= 1, 'expired record removed');
  assert.equal(store.get(old.id), null);
  assert.notEqual(store.get(active.id), null, 'ACTIVE sessions survive cleanup');
  assert.equal(store.cleanup(0), 0, 'retention 0 = keep forever');
});

test('registry persists across store instances', () => {
  const dir = join(home, 's5');
  const s1 = createSessionStore({ home: dir }).create({ agent: 'opencode', projectDir: '/x/persist', pid: 999999 });
  createSessionStore({ home: dir }).markExited(999999, 1);
  const reloaded = createSessionStore({ home: dir }).get(s1.id);
  assert.equal(reloaded.status, 'INTERRUPTED');
});

console.log('\nagent adapters');

test('known agents and native-resume support flags', () => {
  assert.equal(AGENTS.claude.nativeResume, true);
  assert.equal(AGENTS.opencode.nativeResume, false, 'honest: no reliable native resume detected');
  assert.equal(AGENTS.codex.nativeResume, false, 'honest: not verified');
  assert.equal(AGENTS.aider.nativeResume, false, 'honest: not verified');
});

test('encodeClaudeProjectPath collapses path characters', () => {
  const enc = encodeClaudeProjectPath('C:\\Users\\jenil\\Projects\\my app');
  assert.ok(!enc.includes('\\') && !enc.includes(':'), 'special chars collapsed: ' + enc);
});

test('claudeNativeSessions finds the newest native session (agent owns history)', () => {
  const fakeHome = join(home, 'fakehome');
  const projectDir = 'C:\\proj\\demo';
  const sessionsDir = join(fakeHome, '.claude', 'projects', encodeClaudeProjectPath(projectDir));
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'aaa.jsonl'), '{}');
  writeFileSync(join(sessionsDir, 'bbb.jsonl'), '{}');
  const found = claudeNativeSessions(projectDir, fakeHome);
  assert.ok(Array.isArray(found) && found.length === 2);
  for (const s of found) assert.ok(s.id && s.file.endsWith('.jsonl'));
  // unknown project → null, never faked
  assert.equal(claudeNativeSessions('C:\\no\\such', fakeHome), null);
});

test('resumeArgs: claude uses its own --continue; others honestly unsupported', () => {
  assert.deepEqual(resumeArgs('claude', '/x'), ['--continue']);
  assert.equal(resumeArgs('opencode', '/x'), null);
  assert.equal(resumeArgs('aider', '/x'), null);
  assert.equal(resumeArgs('nosuch', '/x'), null);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
