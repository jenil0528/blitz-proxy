// ============================================================================
// BLITZ — Session Registry (recovery metadata only)
// A lightweight discovery/recovery layer over agents' OWN history systems.
// BLITZ never stores conversation content, prompts, or credentials — only
// the minimum metadata needed to find and resume an interrupted session:
//   { id, agent, projectDir, projectName, gitBranch, pid, status,
//     startedAt, lastActivity, model, profile, provider }
//
// Statuses: STARTING → ACTIVE → (COMPLETED | INTERRUPTED); IDLE/UNKNOWN are
// informational. Sessions whose process died without an exit event are
// pruned to INTERRUPTED on the next list.
//
// Storage: local JSON in BLITZ_HOME (never uploaded anywhere — there is no
// remote code in this project at all).
// ============================================================================

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { randomBytes } from 'crypto';

const FILE = 'sessions.json';

function newId() {
  return 'B-' + randomBytes(4).toString('hex').toUpperCase();
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function createSessionStore({ home, retentionDays = 30 } = {}) {
  const filePath = join(home || '.', FILE);
  let data = { version: 1, sessions: [] };

  if (home && existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (parsed && Array.isArray(parsed.sessions)) data = parsed;
    } catch { /* corrupt registry is not worth crashing over */ }
  }

  function persist() {
    if (!home) return; // memory-only (tests)
    try {
      mkdirSync(home, { recursive: true });
      const tmp = filePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmp, filePath);
    } catch { /* best effort */ }
  }

  /**
   * Mark ACTIVE sessions whose process no longer exists as INTERRUPTED —
   * abnormal termination (crash, killed terminal, reboot) detection.
   */
  function pruneDead() {
    let changed = false;
    for (const s of data.sessions) {
      if (s.status === 'ACTIVE' && !isPidAlive(s.pid)) {
        s.status = 'INTERRUPTED';
        delete s.pid;
        changed = true;
      }
    }
    if (changed) persist();
    return changed;
  }

  function create({ agent, projectDir, projectName, gitBranch, pid, model, profile, provider }) {
    const session = {
      id: newId(),
      agent: agent || 'unknown',
      projectDir: projectDir || '',
      projectName: projectName || (projectDir ? basename(projectDir) : '—'),
      gitBranch: gitBranch || '',
      pid: pid || null,
      status: 'ACTIVE',
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      model: model || '',
      profile: profile || '',
      provider: provider || '',
    };
    data.sessions.unshift(session);
    // cap the registry — bounded memory, oldest first out
    data.sessions = data.sessions.slice(0, 200);
    persist();
    return session;
  }

  function touch(id, patch = {}) {
    const s = data.sessions.find(x => x.id === id);
    if (!s) return null;
    // Explicit patch fields win; lastActivity defaults to now only when the
    // caller did not provide one (tests set historical timestamps).
    Object.assign(s, { lastActivity: new Date().toISOString() }, patch);
    persist();
    return s;
  }

  /** The agent process exited: code 0 = COMPLETED, anything else = INTERRUPTED. */
  function markExited(pid, exitCode) {
    const s = data.sessions.find(x => x.pid === pid && x.status === 'ACTIVE');
    if (!s) return null;
    s.status = exitCode === 0 ? 'COMPLETED' : 'INTERRUPTED';
    delete s.pid;
    s.lastActivity = new Date().toISOString();
    persist();
    return s;
  }

  function get(id) {
    return data.sessions.find(x => x.id === id) || null;
  }

  function list({ status } = {}) {
    pruneDead();
    return status ? data.sessions.filter(s => s.status === status) : data.sessions;
  }

  /**
   * Remove expired recovery metadata. retentionDays 0 = keep forever.
   * ACTIVE sessions are never removed.
   */
  function cleanup(days = retentionDays) {
    if (!Number.isFinite(days) || days <= 0) return 0; // forever
    const cutoff = Date.now() - days * 86400000;
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(s =>
      s.status === 'ACTIVE' || (Date.parse(s.lastActivity || s.startedAt || 0) >= cutoff)
    );
    const removed = before - data.sessions.length;
    if (removed > 0) persist();
    return removed;
  }

  return { create, touch, markExited, get, list, cleanup, pruneDead, filePath };
}
