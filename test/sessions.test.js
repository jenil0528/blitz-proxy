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
const { agentAdapters, AGENTS, encodeClaudeProjectPath, claudeNativeSessions, resumeArgs } = await import('../src/agents.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nsession registry');

test('create → STARTING with metadata only (no conversation, no keys)', () => {
  const store = createSessionStore({ home: join(home, 's1') });
  const s = store.create({
    agent: 'Claude Code', projectDir: 'J:\\proj\\demo', gitRoot: 'J:\\proj\\demo', gitBranch: 'main',
    model: 'z-ai/glm-5.3', profile: '', provider: 'nvidia',
  });
  assert.match(s.id, /^B-[0-9A-F]{8}$/);
  assert.equal(s.status, 'STARTING', 'created sessions start in STARTING until the pid is attached');
  assert.equal(s.projectName, 'demo');
  assert.equal(s.gitRoot, 'J:\\proj\\demo');
  const json = JSON.stringify(s);
  assert.ok(!json.includes('nvapi-'), 'no key material in session metadata');
  assert.ok(!('messages' in s) && !('prompt' in s) && !('history' in s), 'no conversation fields');
});

test('STARTING + live pid → ACTIVE; dead pid after the grace window → INTERRUPTED', () => {
  const store = createSessionStore({ home: join(home, 's1b') });
  const s = store.create({ agent: 'claude', projectDir: '/x/grace', pid: 999999 });
  store.touch(s.id, { status: 'ACTIVE', pid: process.pid });
  assert.equal(store.get(s.id).status, 'ACTIVE');
  // a STARTING session that never got a live pid, older than the grace window
  const stuck = store.create({ agent: 'claude', projectDir: '/x/stuck', pid: 999999 });
  store.touch(stuck.id, { startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  store.pruneDead();
  assert.equal(store.get(stuck.id).status, 'INTERRUPTED', 'dead STARTING sessions are detected after the grace window');
});

test('markExited: exit 0 → COMPLETED, non-zero → INTERRUPTED', () => {
  const store = createSessionStore({ home: join(home, 's2') });
  const a = store.create({ agent: 'claude', projectDir: '/x/a', pid: 111 });
  const b = store.create({ agent: 'claude', projectDir: '/x/b', pid: 112 });
  store.touch(a.id, { status: 'ACTIVE' });
  store.touch(b.id, { status: 'ACTIVE' });
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
  store.touch(dead.id, { status: 'ACTIVE' });
  store.touch(alive.id, { status: 'ACTIVE' });
  store.pruneDead();
  assert.equal(store.get(dead.id).status, 'INTERRUPTED', 'abnormal termination detected');
  assert.equal(store.get(alive.id).status, 'ACTIVE', 'live process stays active');
});

test('cleanup removes expired records but never ACTIVE ones', () => {
  const store = createSessionStore({ home: join(home, 's4'), retentionDays: 7 });
  const old = store.create({ agent: 'claude', projectDir: '/x/old', pid: 999999 });
  store.touch(old.id, { status: 'ACTIVE' });
  store.markExited(999999, 1); // INTERRUPTED
  store.touch(old.id, { lastActivity: new Date(Date.now() - 30 * 86400000).toISOString() });
  const active = store.create({ agent: 'claude', projectDir: '/x/act', pid: process.pid });
  store.touch(active.id, { status: 'ACTIVE' });
  const removed = store.cleanup(7);
  assert.ok(removed >= 1, 'expired record removed');
  assert.equal(store.get(old.id), null);
  assert.notEqual(store.get(active.id), null, 'ACTIVE sessions survive cleanup');
  assert.equal(store.cleanup(0), 0, 'retention 0 = keep forever');
});

test('registry persists across store instances', () => {
  const dir = join(home, 's5');
  const store1 = createSessionStore({ home: dir });
  const s1 = store1.create({ agent: 'opencode', projectDir: '/x/persist', pid: 999999 });
  store1.touch(s1.id, { status: 'ACTIVE' });
  createSessionStore({ home: dir }).markExited(999999, 1);
  const reloaded = createSessionStore({ home: dir }).get(s1.id);
  assert.equal(reloaded.status, 'INTERRUPTED');
});

console.log('\nagent adapters');

test('AgentSessionAdapter interface: claude supports native resume, others honestly do not', () => {
  assert.equal(agentAdapters.claude.canResume(), true);
  assert.equal(agentAdapters.claude.label, 'Claude Code');
  assert.equal(typeof agentAdapters.claude.detect(), 'boolean');
  assert.equal(agentAdapters.opencode.canResume(), false, 'honest: no reliably-detectable resume');
  assert.equal(agentAdapters.opencode.listNativeSessions('/x'), null, 'no session layout assumptions');
  assert.equal(agentAdapters.codex.canResume(), false);
  assert.equal(agentAdapters.aider.canResume(), false);
});

test('adapter getNativeSessionId returns the newest native session (metadata only)', () => {
  const fakeHome = join(home, 'fakehome2');
  const projectDir = 'C:\\proj\\agentdemo';
  const sessionsDir = join(fakeHome, '.claude', 'projects', encodeClaudeProjectPath(projectDir));
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'older.jsonl'), '{}');
  writeFileSync(join(sessionsDir, 'newer.jsonl'), '{}');
  const id = agentAdapters.claude.getNativeSessionId(projectDir, fakeHome);
  assert.ok(id && id.length > 0, 'native id discovered');
  assert.equal(agentAdapters.claude.getNativeSessionId('C:\\no\\such', fakeHome), null, 'null when nothing found — never faked');
});

test('resumeArgs: claude uses its own --continue; others honestly unsupported', () => {
  assert.deepEqual(agentAdapters.claude.resumeArgs(), ['--continue']);
  assert.equal(agentAdapters.opencode.resumeArgs(), null);
  assert.equal(agentAdapters.aider.resumeArgs(), null);
  // backward-compatible helpers
  assert.deepEqual(resumeArgs('claude', '/x'), ['--continue']);
  assert.equal(resumeArgs('nosuch', '/x'), null);
});

console.log('\nclaude client model (image-read fix)');

test('claudeClientModel: backend ids become names Claude Code understands', async () => {
  const { claudeClientModel } = await import('../src/agents.js');
  // backend model id → a known vision-capable alias (the client decides
  // image support from the NAME; BLITZ routes to the backend regardless)
  assert.equal(claudeClientModel({ model: 'z-ai/glm-5.3' }), 'claude-sonnet-4-20250514');
  assert.equal(claudeClientModel({ model: '' }), 'claude-sonnet-4-20250514');
  // claude-* ids pass through untouched
  assert.equal(claudeClientModel({ model: 'claude-3-5-sonnet-20241022' }), 'claude-3-5-sonnet-20241022');
  // explicit user override wins
  assert.equal(claudeClientModel({ model: 'z-ai/glm-5.3', clientModel: 'claude-3-haiku-20240307' }), 'claude-3-haiku-20240307');
});

test('projectName derivation is separator-agnostic (CI fix: POSIX basename does not split backslashes)', () => {
  const store = createSessionStore({ home: join(home, 's9') });
  const a = store.create({ agent: 'claude', projectDir: 'J:\\proj\\demo' });
  const b = store.create({ agent: 'claude', projectDir: '/home/runner/work/demo' });
  assert.equal(a.projectName, 'demo', 'Windows-style path, any platform');
  assert.equal(b.projectName, 'demo', 'POSIX-style path, any platform');
  const c = store.create({ agent: 'claude', projectDir: 'demo' });
  assert.equal(c.projectName, 'demo', 'bare name');
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
