// ============================================================================
// BLITZ — Agent Session Adapters
// ONE adapter interface per agent; agent-specific knowledge lives HERE and
// nowhere else. Conceptual interface (AgentSessionAdapter):
//
//   detect()                        is the agent installed?
//   canResume()                     does a NATIVE resume mechanism exist?
//   listNativeSessions(projectDir)  the agent's own session records (or null)
//   getNativeSessionId(projectDir)   newest native session id (or null)
//   resumeArgs(projectDir)          CLI args that resume the agent natively
//
// HONESTY RULE: if an agent does not expose a reliably-detectable resume
// mechanism, canResume() is false and resumeArgs() is null — "Native resume
// unavailable" is shown, never faked. Agents own their history; BLITZ only
// reads metadata (ids, mtimes) and never copies conversations.
// ============================================================================

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

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

/** Discover Claude Code native session files for a project. Newest first. */
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

// ─── Adapter interface ───────────────────────────────────────────────────────

/** Build an AgentSessionAdapter for a known agent definition. */
function makeAdapter(def) {
  return {
    id: def.id,
    label: def.label,
    command: def.cmd,

    /** Installed on PATH? Never throws. */
    detect() {
      try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const r = spawnSync(finder, [def.cmd], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        return r.status === 0 && (r.stdout || '').trim().length > 0;
      } catch {
        return false;
      }
    },

    /** Native resume: only Claude Code has a reliably-known mechanism here. */
    canResume() {
      return def.id === 'claude';
    },

    /**
     * The agent's OWN session records — metadata only. Null when the agent
     * does not store per-project sessions in a discoverable location.
     */
    listNativeSessions(projectDir, home) {
      if (def.id === 'claude') return claudeNativeSessions(projectDir, home);
      return null; // opencode/codex/aider: no reliably-detectable layout — honest null
    },

    /** Newest native session id, or null. */
    getNativeSessionId(projectDir, home) {
      const list = this.listNativeSessions(projectDir, home);
      return list && list.length > 0 ? list[0].id : null;
    },

    /**
     * Resume arguments using the agent's native mechanism, or null.
     * Claude Code: `--continue` resumes the most recent conversation in the
     * project directory — the agent's own history, never copied by BLITZ.
     */
    resumeArgs() {
      if (def.id === 'claude') return ['--continue'];
      return null;
    },
  };
}

export const agentAdapters = {
  claude: makeAdapter({ id: 'claude', label: 'Claude Code', cmd: 'claude' }),
  opencode: makeAdapter({ id: 'opencode', label: 'OpenCode', cmd: 'opencode' }),
  codex: makeAdapter({ id: 'codex', label: 'Codex CLI', cmd: 'codex' }),
  aider: makeAdapter({ id: 'aider', label: 'Aider', cmd: 'aider' }),
};

/**
 * The model NAME Claude Code should see. Claude Code makes client-side
 * capability decisions (image reading, etc.) from the model name it is
 * configured with — a backend id like "z-ai/glm-5.3" is unknown to it and
 * makes it refuse to read images ("this model does not support image input")
 * before the request ever reaches the gateway. BLITZ routes to the active
 * backend model regardless of the client's display name, so the client gets
 * a name it understands:
 *   1. explicit cfg.clientModel (blitz config set clientModel <name>)
 *   2. the active model itself when it is already a claude-* id
 *   3. a known vision-capable claude alias otherwise
 */
export function claudeClientModel(cfg = {}) {
  if (cfg.clientModel) return cfg.clientModel;
  const active = String(cfg.model || '');
  if (active.startsWith('claude-')) return active;
  return 'claude-sonnet-4-20250514';
}

// ─── Backward-compatible helpers (thin wrappers over the adapters) ──────────

export const AGENTS = Object.fromEntries(
  Object.entries(agentAdapters).map(([id, a]) => [id, {
    cmd: a.command,
    label: a.label,
    nativeResume: a.canResume(),
  }])
);

export function detectAgent(cmd) {
  const a = Object.values(agentAdapters).find(x => x.command === cmd);
  return a ? a.detect() : false;
}

export function resumeArgs(agentId, projectDir) {
  const a = agentAdapters[agentId];
  return a ? a.resumeArgs(projectDir) : null;
}
