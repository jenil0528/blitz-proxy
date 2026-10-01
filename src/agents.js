// ============================================================================
// BLITZ — Agent Adapters
// Agent-specific knowledge lives HERE and nowhere else. Adapters answer:
//   - is the agent installed?        detect()
//   - can it resume natively?       nativeResume
//   - what is the resume command?    resumeArgs()
//   - what are its native sessions? nativeSessions() (when discoverable)
//
// HONESTY RULE: if an agent does not expose a reliably-detectable resume
// mechanism, it is reported as unavailable — never faked.
// ============================================================================

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const AGENTS = {
  claude: { cmd: 'claude', label: 'Claude Code', nativeResume: true },
  opencode: { cmd: 'opencode', label: 'OpenCode', nativeResume: false },
  codex: { cmd: 'codex', label: 'Codex CLI', nativeResume: false },
  aider: { cmd: 'aider', label: 'Aider', nativeResume: false },
};

/**
 * Detect whether a command is on PATH. Never throws.
 */
export function detectAgent(cmd) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(finder, [cmd], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    return r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Claude Code encodes project paths as directory names under
 * ~/.claude/projects — the absolute path with non-alphanumerics collapsed
 * to dashes. Used to locate the project's native session files.
 */
export function encodeClaudeProjectPath(projectDir) {
  return String(projectDir || '')
    .replace(/^[A-Za-z]:/, m => m[0]) // C: → C
    .replace(/[^A-Za-z0-9.]+/g, '-');
}

/**
 * Discover Claude Code native sessions for a project directory.
 * @param {string} projectDir  the project's absolute path
 * @param {string} [home]      override for the user home (tests)
 * @returns {Array<{id, file, mtime}>|null}  newest first, or null when the
 *   project has no native sessions (nothing faked).
 */
export function claudeNativeSessions(projectDir, home) {
  try {
    const projectsDir = join(home || (process.env.USERPROFILE || process.env.HOME), '.claude', 'projects');
    const dir = join(projectsDir, encodeClaudeProjectPath(projectDir));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = join(dir, f);
        return { id: f.replace(/\.jsonl$/, ''), file: full, mtime: statSync(full).mtimeMs };
      })
      .filter(s => s.id.length > 0)
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Resume arguments for an agent, or null when native resume is unsupported.
 * - Claude Code: `--continue` resumes the most recent conversation in the
 *   project directory — the agent's own native mechanism, no history stored
 *   or duplicated by BLITZ.
 */
export function resumeArgs(agentId, projectDir) {
  const agent = AGENTS[agentId];
  if (!agent || !agent.nativeResume) return null;
  if (agentId === 'claude') return ['--continue'];
  return null;
}
