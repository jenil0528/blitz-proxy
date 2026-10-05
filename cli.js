#!/usr/bin/env node
// ============================================================================
// BlitzProxy — CLI Tool v2
// All management from the terminal. Preserves every v1 command and adds:
// routing, fallback, health, stats, profiles, doctor, start/stop, run/shell,
// privacy, config, token, dashboard.
// ============================================================================

import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync, watchFile, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { initApp, getConfig, saveConfig, CONFIG_PATH } from './src/config.js';
import * as keyring from './src/security/keyring.js';
import { getProxyToken } from './src/security/auth.js';
import { resolveProvider, getAdapter, allProviderIds } from './src/provider-registry.js';
import { PROVIDERS, findModelInfo, getProvider } from './src/providers.js';
import { listProfiles, resolveProfileChain } from './src/routing/profiles.js';
import { formatHealth } from './src/routing/health.js';
import { createStats } from './src/stats.js';
import { resolveActiveProvider, availableProviders } from './src/routing/router.js';
import { resolveCredential, resolveCredentials } from './src/credentials.js';
import { validateConfig, formatValidation } from './src/config-validate.js';
import { mergeDiscovered, discoveredList } from './src/models-cache.js';
import { resolveAlias, listAliases, validateAliasValue, ALIAS_RE } from './src/aliases.js';
import { CONTEXT_MODES } from './src/context-optimizer.js';
import { getCapabilities, capabilityMark, capabilityLabel, formatTokens } from './src/model-capabilities.js';
import { AGENTS, claudeNativeSessions, resumeArgs, claudeClientModel } from './src/agents.js';
import { createSessionStore } from './src/sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.BLITZ_HOME || join(homedir(), '.blitzproxy');
const PID_FILE = join(HOME, 'blitz.pid');
const LOG_PATH = join(__dirname, 'blitz.log');

// Session registry: recovery metadata only (no conversation content, no keys)
const sessionStore = createSessionStore({ home: HOME });

const C = {
  r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m',
  red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m',
  blu: '\x1b[36m', mag: '\x1b[35m',
};

const PROVIDER_ICONS = {
  nvidia: '🟢', groq: '⚡', openrouter: '🔀', together: '🤝',
  deepseek: '🔮', openai: '🤖', github: '🐙', cerebras: '🧠', ollama: '🦙',
  huggingface: '🤗', custom: '🔧', gemini: '💎', mistral: '🌬️', xai: '𝕏',
  fireworks: '🎆', sambanova: '🐍',
};

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (cmd === '--version' || cmd === 'version') return printVersion();

  const { keyringMode } = await initApp();
  globalThis.__blitzMode = keyringMode;

  switch (cmd) {
    // ── Keys ──
    case 'add':            return await cmdAdd(args);
    case 'keys':
    case 'list':           return await cmdKeys();
    case 'switch':
    case 'use':            return await cmdSwitch(args);
    case 'rm':
    case 'remove':
    case 'delete':         return await cmdRemove(args);
    case 'validate':       return await cmdValidate(args);

    // ── Providers & models ──
    case 'model':          return await cmdModel(args);
    case 'models':         return await cmdModels(args);
    case 'alias':
    case 'aliases':        return await cmdAlias(args);
    case 'provider':
    case 'providers':      return await cmdProvider(args);
    case 'test':           return await cmdTest();
    case 'health':         return await cmdHealth();
    case 'auto':           return cmdAuto(args);

    // ── Credentials ──
    case 'credential':
    case 'credentials':    return await cmdCredential(args);

    // ── Agent launchers (shortcuts for blitz run <agent>) ──
    case 'claude':         return await cmdRun(['claude', ...args]);
    case 'opencode':       return await cmdRun(['opencode', ...args]);
    case 'codex':          return await cmdRun(['codex', ...args]);
    case 'aider':          return await cmdRun(['aider', ...args]);
    case 'cline':
    case 'roo':
    case 'roocode':        return cmdEditorAgentHelp();
    case 'compatibility':  return await cmdCompatibility();
    case 'context':         return cmdContext(args);
    case 'usage':           return await cmdUsage(args);
    case 'sessions':        return cmdSessions();
    case 'session':         return await cmdSession(args);
    case 'resume':          return await cmdResume(args);
    case 'requests':        return cmdRequests(args);

    // ── Routing ──
    case 'profile':
    case 'profiles':       return await cmdProfile(args);
    case 'fallback':       return cmdFallback(args);

    // ── Lifecycle ──
    case 'start':          return await cmdStart();
    case 'stop':           return await cmdStop();
    case 'restart':        return await cmdRestart();
    case 'status':         return await cmdStatus();
    case 'run':            return await cmdRun(args);
    case 'shell':          return await cmdShell();

    // ── Insight ──
    case 'stats':          return await cmdStats();
    case 'config':         return await cmdConfig(args);
    case 'privacy':        return cmdPrivacy();
    case 'token':          return await cmdToken();
    case 'dashboard':      return await cmdDashboard();
    case 'doctor':         return await cmdDoctor();

    // ── Logs & help ──
    case 'logs':
    case 'log':            return cmdLogs(args);
    case 'help':
    case '--help':
    case '-h':             return cmdHelp(false);
    case undefined:        return await cmdDefault();
    default:               return cmdHelp(false, cmd);
  }
}

// ─── Default: `blitz` → ensure proxy + launch Claude Code ─────────────────────

async function cmdDefault() {
  await ensureServer();
  const cfg = getConfig();
  const token = await getProxyToken(keyring);
  const hasClaude = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['claude'],
    { encoding: 'utf-8', windowsHide: true },
  ).status === 0;

  if (!hasClaude) {
    console.log(`${C.grn}✓ BlitzProxy is running at ${serverUrl(cfg)}${C.r}`);
    console.log(`${C.yel}⚠ Claude Code CLI not found.${C.r}`);
    console.log(`${C.d}  Install it: npm install -g @anthropic-ai/claude-code${C.r}`);
    console.log(`${C.d}  Or point any client at ${serverUrl(cfg)} (see blitz help)${C.r}`);
    return;
  }

  console.log(`${C.d}Launching Claude Code through BlitzProxy...${C.r}`);
  const child = spawn('claude', [], {
    stdio: 'inherit',
    env: blitzEnv(cfg, token),
    shell: process.platform === 'win32',
  });
  child.on('error', err => {
    console.error(`${C.red}✕ Failed to launch claude: ${err.message}${C.r}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ─── Server lifecycle helpers ─────────────────────────────────────────────────

function serverUrl(cfg) {
  return `http://${cfg.host || '127.0.0.1'}:${cfg.proxyPort || 4819}`;
}

async function probeServer(cfg, timeoutMs = 3000) {
  try {
    const res = await fetch(`${serverUrl(cfg)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.proxy === 'BlitzProxy' ? data : null;
  } catch { return null; }
}

async function ensureServer({ quiet = false } = {}) {
  const cfg = getConfig();
  const running = await probeServer(cfg);
  if (running) return running;

  if (!quiet) console.log(`${C.d}Starting BlitzProxy server...${C.r}`);
  const child = spawn(process.execPath, [join(__dirname, 'server.js')], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    cwd: __dirname,
    windowsHide: true, // a detached console-less server must never pop a window
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const up = await probeServer(cfg, 1500);
    if (up) {
      if (!quiet) console.log(`${C.grn}✓ Proxy running at ${serverUrl(cfg)}${C.r}`);
      return up;
    }
  }
  console.error(`${C.red}✕ Server did not start within 20s — run "blitz doctor"${C.r}`);
  process.exit(1);
}

async function cmdStart() {
  const cfg = getConfig();
  const running = await probeServer(cfg);
  if (running) {
    console.log(`${C.grn}✓ BlitzProxy is already running at ${serverUrl(cfg)}${C.r}`);
    console.log(`${C.d}  Provider: ${running.provider}  •  Model: ${running.model || '—'}${C.r}`);
    return;
  }
  await ensureServer();
}

async function cmdStop() {
  const cfg = getConfig();
  const running = await probeServer(cfg);
  if (!running) {
    console.log(`${C.yel}BlitzProxy is not running.${C.r}`);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }

  // Identify the real server process — a stale PID file must never cause us
  // to kill an unrelated process (PIDs get reused).
  const pid = findServerPid();
  if (!pid) {
    console.error(`${C.red}✕ Could not identify the BlitzProxy server process.${C.r}`);
    console.error(`${C.d}  It is listening on ${serverUrl(cfg)}. Stop it manually:${C.r}`);
    console.error(`${C.d}  ${process.platform === 'win32' ? 'taskkill /IM node.exe /FI "WINDOWTITLE eq BlitzProxy"' : 'pkill -f "node .*server.js"'}`);
    process.exit(1);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!(await probeServer(cfg, 1000))) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      console.log(`${C.grn}✓ BlitzProxy stopped.${C.r}`);
      return;
    }
  }
  console.error(`${C.yel}⚠ Server still responding — it may not have shut down yet.${C.r}`);
}

/**
 * Find the PID of the node process running our server.js — verifies the
 * command line, never trusting the PID file alone.
 */
function findServerPid() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | Select-Object -First 1 -ExpandProperty ProcessId`],
        { encoding: 'utf-8', timeout: 10000, windowsHide: true });
      const pid = parseInt((r.stdout || '').trim().split('\n')[0], 10);
      return isNaN(pid) ? null : pid;
    }
    for (const pidStr of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
      try {
        const cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8');
        if (cmdline.includes('server.js')) return parseInt(pidStr, 10);
      } catch { /* no permission for this process */ }
    }
    return null;
  } catch {
    return null;
  }
}

async function cmdRestart() {
  const cfg = getConfig();
  if (await probeServer(cfg)) await cmdStop();
  await cmdStart();
}

async function cmdStatus() {
  const cfg = getConfig();
  const running = await probeServer(cfg);
  const active = await resolveActiveProvider(cfg, keyring);
  const keys = await keyring.listKeys();
  const activeCred = await resolveCredential({ keyring, providerId: active.providerId });

  // Registry counts: catalog + discovered models across usable providers
  const avail = await availableProviders(cfg, keyring);
  let modelCount = 0;
  let providerCount = 0;
  for (const pid of avail) {
    const def = resolveProvider(pid, cfg);
    if (!def) continue;
    providerCount += 1;
    modelCount += Object.keys(def.models || {}).length;
    modelCount += discoveredList(cfg.discoveredModels, pid).filter(m => !(def.models && m.id in def.models)).length;
  }

  console.log(`\n${C.b}⚡ BlitzProxy Status${C.r}\n`);
  console.log(`  ${C.b}Gateway${C.r}`);
  console.log(`    Running:      ${running ? `${C.grn}YES${C.r} (${serverUrl(cfg)})` : `${C.red}stopped${C.r}`}`);
  console.log(`    Auth:         /v1 ${cfg.requireAuth ? 'token required' : 'open (localhost only)'}  •  admin/dashboard: token`);
  console.log(`    Endpoints:    Anthropic ${C.grn}✓${C.r}  OpenAI Chat ${C.grn}✓${C.r}  Responses ${C.grn}✓${C.r}  Models ${C.grn}✓${C.r}`);
  console.log(`  ${C.b}Active route${C.r}`);
  console.log(`    Provider:     ${C.grn}${active.def?.name || active.providerId}${C.r}`);
  console.log(`    Model:        ${C.blu}${active.model || '—'}${C.r}`);
  console.log(`    Credential:   ${activeCred ? activeCred.name : C.d + '(none)' + C.r}`);
  console.log(`    Routing:      ${cfg.profile ? `profile:${cfg.profile}` : cfg.routing}${cfg.fallbackChain.length ? `  •  fallback: ${cfg.fallbackChain.join(' → ')}` : ''}`);
  console.log(`  ${C.b}Registry${C.r}`);
  console.log(`    Providers:    ${providerCount} usable (${avail.length ? avail.join(', ') : '—'})`);
  console.log(`    Credentials:  ${keys.length} in ${globalThis.__blitzMode} keyring${keys.some(k => k.provider === active.providerId && k.id !== activeCred?.id) ? '  •  rotation ready' : ''}`);
  console.log(`    Models:       ${modelCount}${Object.keys(cfg.aliases || {}).length ? `  •  aliases: ${Object.keys(cfg.aliases).join(', ')}` : ''}`);
  console.log(`    Privacy:      ${cfg.privacy ? `${C.grn}ON${C.r}` : 'off'}  •  Config: ${CONFIG_PATH}\n`);
}

// ─── Context control ─────────────────────────────────────────────────────────

const CUSTOM_OPS = ['ansi', 'overwrites', 'duplicates', 'blankWalls', 'blockDedup', 'nonConsecutive', 'recency'];

function cmdContext(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'status').toLowerCase();

  if (sub === 'status') {
    console.log(`\n${C.b}Context Optimization${C.r}\n`);
    console.log(`  Mode:            ${C.b}${cfg.contextOptimization || 'safe'}${C.r}${cfg.contextLock ? '  •  🔒 LOCKED' : ''}`);
    if (cfg.contextOptimization === 'custom') {
      const merged = contextModeOptions(cfg);
      console.log(`  Custom flags:    ${CUSTOM_OPS.map(op => `${op}=${merged[op]}`).join('  ')}`);
    } else {
      console.log(`  Guarantee:        system + user text and the recency window are never touched`);
      console.log(`                   nothing is deleted — duplicates keep the first copy + count`);
    }
    console.log(`  Change:          blitz context <off|safe|balanced|aggressive|custom>`);
    if (!cfg.contextLock) console.log(`  Lock:             blitz context lock   ${C.d}(prevents any mode change until unlocked)${C.r}`);
    else console.log(`  ${C.yel}🔒 Locked — run: blitz context unlock${C.r}`);
    console.log();
    return;
  }
  if (sub === 'lock' || sub === 'unlock') {
    const next = sub === 'lock';
    saveConfig({ contextLock: next });
    console.log(next ? `${C.grn}🔒 Context policy locked${C.r} ${C.d}— the mode cannot change until: blitz context unlock${C.r}`
                    : `${C.grn}Context policy unlocked${C.r}`);
    return;
  }
  if (sub === 'custom') {
    const op = args[1];
    const value = args[2];
    if (!op || !CUSTOM_OPS.includes(op)) {
      console.log(`${C.red}✕ Usage: blitz context custom <${CUSTOM_OPS.join('|')}> <on|off|recency-number>${C.r}`);
      process.exit(1);
    }
    const merged = { ...(cfg.contextCustom || {}) };
    if (op === 'recency') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0 || n > 100) {
        console.log(`${C.red}✕ recency must be a number of trailing messages (0-100)${C.r}`);
        process.exit(1);
      }
      merged.recency = n;
    } else {
      if (value !== 'on' && value !== 'off') {
        console.log(`${C.red}✕ Value must be on|off${C.r}`);
        process.exit(1);
      }
      merged[op] = value === 'on';
    }
    saveConfig({ contextCustom: merged, contextOptimization: 'custom' });
    console.log(`${C.grn}✓ custom.${op} set — context mode is now CUSTOM${C.r}`);
    return;
  }
  if (CONTEXT_MODES.includes(sub)) {
    if (cfg.contextLock) {
      console.log(`${C.red}✕ Context policy is LOCKED — unlock first: blitz context unlock${C.r}`);
      process.exit(1);
    }
    saveConfig({ contextOptimization: sub });
    console.log(`${C.grn}✓ Context mode: ${C.b}${sub}${C.r}`);
    if (sub === 'off') console.log(`${C.d}  Original context is sent unchanged (upstream limits still apply).${C.r}`);
    if (sub === 'safe') console.log(`${C.d}  Lossless noise removal only — instructions, errors, tool calls, recency: never touched.${C.r}`);
    if (sub === 'balanced') console.log(`${C.d}  SAFE + duplicate old output blocks collapse (first copy + marker kept).${C.r}`);
    if (sub === 'aggressive') console.log(`${C.d}  BALANCED + non-consecutive duplicate collapse, recency window 2.${C.r}`);
    if (sub === 'custom') console.log(`${C.d}  Per-operation control: blitz context custom <op> <on|off>${C.r}`);
    return;
  }
  console.log(`${C.d}Usage: blitz context [off|safe|balanced|aggressive|custom|status|lock|unlock|custom <op> <on|off>]${C.r}`);
}

function contextModeOptions(cfg) {
  const safe = { ansi: true, overwrites: true, duplicates: true, blankWalls: true, blockDedup: false, nonConsecutive: false, recency: 6 };
  return cfg.contextOptimization === 'custom' ? { ...safe, ...(cfg.contextCustom || {}) } : safe;
}

// ─── Request inspector (blitz.log is metadata-only; nothing in privacy mode) ──

async function cmdRequests(args) {
  const n = Math.min(Math.max(parseInt(args[0], 10) || 20, 1), 100);
  const cfg = getConfig();
  if (cfg.privacy === true) {
    console.log(`${C.d}Privacy mode is ON — request logging is disabled. Turn it off with: blitz privacy${C.r}`);
    return;
  }
  if (!existsSync(LOG_PATH)) {
    console.log(`${C.d}No request log yet at ${LOG_PATH}${C.r}`);
    return;
  }
  const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n').slice(-n * 6); // events cluster per request
  const byReq = new Map();
  const order = [];
  for (const line of lines) {
    const m = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+(POST|GET)\s+(\S+)\s+→\s+(\d{3})\s+OK?\s+\((\d+)ms\)\s+(\S+)\s*(\[[^\]]*\])?\s*req=(BLZ-[A-F0-9]{6})/);
    if (!m) {
      // correlate events (CONTEXT/ROTATE/FALLBACK/ERROR) to their request id
      const em = line.match(/\[([^\]]+)\]\s+(CONTEXT|ROTATE|FALLBACK|ERROR)\s+(.*)\s*req=(BLZ-[A-F0-9]{6})/);
      if (em) {
        const id = em[4];
        if (byReq.has(id)) {
          byReq.get(id).events.push(em[2] + (em[3].slice(0, 60)));
        }
      }
      continue;
    }
    const [, time, , endpoint, status, latency, model, flags, reqId] = m;
    if (!byReq.has(reqId)) {
      byReq.set(reqId, { time: time.slice(11), endpoint, status, latency, model, flags: (flags || '').trim(), events: [] });
      order.push(reqId);
    }
  }
  const rows = order.slice(-n).reverse().map(id => byReq.get(id));
  if (rows.length === 0) {
    console.log(`${C.d}No completed requests in the recent log. Make one: blitz test${C.r}`);
    return;
  }
  console.log(`\n${C.b}Recent requests${C.r}  ${C.d}— last ${rows.length} • metadata only, never prompts${C.r}\n`);
  for (const r of rows) {
    const color = r.status.startsWith('2') ? C.grn : r.status.startsWith('4') ? C.yel : C.red;
    console.log(`  ${C.d}${r.time}${C.r} ${color}${r.status}${C.r} ${r.endpoint.padEnd(22)} ${String(r.latency + 'ms').padStart(9)}  ${C.b}${r.model}${C.r}${r.flags ? ` ${C.d}${r.flags}${C.r}` : ''}  ${C.d}${r.id || ''}${C.r}`);
    if (r.events.length) console.log(`      ${C.d}→ ${r.events.join(' • ').slice(0, 160)}${C.r}`);
  }
  console.log(`\n${C.d}Correlate with request ids in client errors (request_id) • context events show optimizer savings${C.r}\n`);
}

// ─── Usage reporting (normalized token accounting) ───────────────────────────

async function cmdUsage(args) {
  const cfg = getConfig();
  let scope = 'today';
  let filter = null;   // { kind: 'model'|'provider', value }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]?.toLowerCase();
    if (a === 'today') scope = 'today';
    else if (a === 'month') scope = 'month';
    else if (a === 'all') scope = 'all';
    else if (a === 'model' || a === 'provider') {
      filter = { kind: a, value: args[i + 1] };
      i++;
    }
  }

  const stats = createStats({ home: HOME, privacy: cfg.privacy === true });
  const { providers, models, agents } = stats.getUsage({ scope });
  const label = scope === 'today' ? 'Today' : scope === 'month' ? 'This month' : 'All time';

  const rows = filter?.kind === 'provider'
    ? providers.filter(r => r.providerId === filter.value)
    : providers;

  const tot = rows.reduce((acc, r) => ({
    requests: acc.requests + r.requests,
    ok: acc.ok + r.ok,
    fail: acc.fail + r.fail,
    input: acc.input + (r.inputTokens || 0),
    output: acc.output + (r.outputTokens || 0),
    cached: acc.cached + (r.cachedTokens || 0),
    reasoning: acc.reasoning + (r.reasoningTokens || 0),
    ctxSaved: acc.ctxSaved + (r.contextSavedTokens || 0),
    estimated: acc.estimated + (r.estimatedRequests || 0),
  }), { requests: 0, ok: 0, fail: 0, input: 0, output: 0, cached: 0, reasoning: 0, ctxSaved: 0, estimated: 0 });

  console.log(`\n${C.b}BLITZ USAGE${C.r}  ${C.d}— ${label}${C.r}\n`);
  if (tot.requests === 0) {
    console.log(`${C.d}No recorded requests in this period.${C.r}\n`);
    return;
  }
  console.log(`  Requests:       ${tot.requests}  ${C.d}(${tot.ok} ok, ${tot.fail} failed)${C.r}`);
  console.log(`  Input:          ${fmtTok(tot.input)}`);
  console.log(`  Output:         ${fmtTok(tot.output)}`);
  if (tot.cached) console.log(`  Cached input:   ${fmtTok(tot.cached)}  ${C.d}(cache reads + writes)${C.r}`);
  if (tot.reasoning) console.log(`  Reasoning:      ${fmtTok(tot.reasoning)}`);
  console.log(`  Total:          ${fmtTok(tot.input + tot.output + tot.cached)}`);
  if (tot.ctxSaved) console.log(`  Context saved:  ${fmtTok(tot.ctxSaved)}  ${C.grn}— optimizer savings${C.r}`);
  const exactPct = tot.requests > 0 ? Math.round(((tot.requests - tot.estimated) / tot.requests) * 100) : 0;
  console.log(`  Usage source:   ${C.b}${exactPct}% EXACT${C.r}${tot.estimated ? ` ${C.d}+ ${tot.estimated} ESTIMATED (provider returned no usage)${C.r}` : ''}`);

  const modelRows = (filter?.kind === 'model' ? models.filter(m => m.model === filter.value) : models).slice(0, 8);
  if (modelRows.length > 0) {
    console.log(`\n  ${C.b}By model${C.r}`);
    for (const m of modelRows) {
      const total = (m.inputTokens || 0) + (m.outputTokens || 0);
      console.log(`    ${(m.model || '—').padEnd(42).slice(0, 42)} ${fmtTok(total).padStart(8)}  ${C.d}${m.requests} req${C.r}`);
    }
  }
  const agentRows = (agents || []).filter(a => a.agent !== 'unknown').slice(0, 5);
  if (agentRows.length > 0) {
    console.log(`\n  ${C.b}By agent${C.r}  ${C.d}(User-Agent attribution — best-effort)${C.r}`);
    for (const a of agentRows) {
      const total = (a.inputTokens || 0) + (a.outputTokens || 0);
      console.log(`    ${(a.agent || '—').padEnd(42).slice(0, 42)} ${fmtTok(total).padStart(8)}  ${C.d}${a.requests} req${C.r}`);
    }
  }
  console.log();
}

function fmtTok(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Agent support: editors + compatibility tester ──────────────────────────

/**
 * Cline and Roo Code are VS Code EXTENSIONS, not terminal CLIs — they cannot
 * be launched from here. Instead of faking it, give the exact setup values
 * the extension needs (never the token itself — point at `blitz token`).
 */
function cmdEditorAgentHelp() {
  const cfg = getConfig();
  console.log(`\n${C.b}Cline / Roo Code — connect through BLITZ${C.r}\n`);
  console.log(`  These agents run inside VS Code, so there is nothing to launch from the`);
  console.log(`  terminal. Point the extension at the BLITZ gateway:\n`);
  console.log(`  ${C.d}1. In the extension's settings, choose an OpenAI-compatible provider.${C.r}`);
  console.log(`  ${C.d}2. Base URL:  ${C.blu}http://${cfg.host || '127.0.0.1'}:${cfg.proxyPort}/v1${C.r}${C.d}`);
  console.log(`     (use a LAN-visible host + ${C.b}requireAuth=true${C.r}${C.d} if VS Code runs elsewhere)${C.r}`);
  console.log(`  ${C.d}3. API key:    your BLITZ token — print it with ${C.b}blitz token${C.r}${C.d}`);
  console.log(`  ${C.d}4. Model:      anything from ${C.b}blitz models${C.r}${C.d} — BLITZ routes to the active model${C.r}\n`);
  console.log(`  ${C.d}Verify the gateway first: ${C.b}blitz compatibility${C.r}\n`);
}

/**
 * Run the LIVE end-to-end compatibility suite (test/live.js) against the real
 * configured provider: Anthropic + OpenAI + Responses endpoints, streaming,
 * tool calls, credential validation. Explicit user action — costs a few
 * tokens, never prints keys.
 */
async function cmdCompatibility() {
  const cfg = getConfig();
  const livePath = join(__dirname, 'test', 'live.js');
  if (!existsSync(livePath)) {
    console.log(`${C.red}✕ live test suite not found: ${livePath}${C.r}`);
    process.exit(1);
  }
  const active = await resolveActiveProvider(cfg, keyring);
  console.log(`${C.b}BLITZ compatibility check${C.r}  ${C.d}— live requests against ${active.def?.name || active.providerId} (${active.model || 'default'})`);
  console.log(`${C.d}This makes real (tiny) API requests using your stored credentials. Keys are never printed.${C.r}\n`);
  const child = spawn(process.execPath, [livePath], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env, BLITZ_LIVE_TESTS: '1', BLITZ_CONFIG: process.env.BLITZ_CONFIG || '' },
    windowsHide: true,
  });
  child.on('error', err => {
    console.log(`${C.red}✕ failed to start: ${err.message}${C.r}`);
    process.exit(1);
  });
  child.on('exit', code => process.exit(code ?? 0));
}

// ─── blitz run / blitz shell (no global env hijack) ──────────────────────────

function blitzEnv(cfg, token) {
  const url = serverUrl(cfg);
  return {
    ...process.env,
    // Anthropic clients (Claude Code). The client sees a model name it
    // understands (client-side capability decisions like image reading are
    // made from the NAME); BLITZ routes to the active backend model.
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: claudeClientModel(cfg),
    // OpenAI clients (Codex CLI, OpenCode, Aider, Continue, …)
    OPENAI_BASE_URL: `${url}/v1`,
    OPENAI_API_KEY: token,
  };
}

async function cmdRun(args) {
  const command = args[0];
  if (!command) {
    console.log(`${C.yel}Usage: blitz run <command> [args...]${C.r}`);
    console.log(`${C.d}  Example: blitz run claude${C.r}`);
    console.log(`${C.d}  Runs the command with BlitzProxy env vars for this process only.${C.r}`);
    return;
  }
  await ensureServer();
  const cfg = getConfig();
  const token = await getProxyToken(keyring);

  // Session tracking: record launch metadata so `blitz sessions`/`blitz resume`
  // can find this run later. Metadata only — never conversation content or keys.
  const session = sessionStore.create({
    agent: AGENTS[command]?.label || command,
    projectDir: process.cwd(),
    gitRoot: gitRootIn(process.cwd()),
    gitBranch: gitBranchIn(process.cwd()),
    model: cfg.model,
    profile: cfg.profile,
    provider: cfg.provider,
  });

  const child = spawn(command, args.slice(1), {
    stdio: 'inherit',
    env: blitzEnv(cfg, token),
    shell: process.platform === 'win32',
  });
  if (child.pid) sessionStore.touch(session.id, { pid: child.pid, status: 'ACTIVE' });

  child.on('error', (err) => {
    sessionStore.touch(session.id, { status: 'FAILED' });
    if (err.code === 'ENOENT') {
      console.error(`${C.red}✕ Command not found: ${command}${C.r}`);
      console.error(`${C.d}  Claude Code: npm install -g @anthropic-ai/claude-code${C.r}`);
      process.exit(127);
    }
    console.error(`${C.red}✕ ${err.message}${C.r}`);
    process.exit(1);
  });
  child.on('exit', (code) => {
    sessionStore.markExited(child.pid, code);
    process.exit(code ?? 0);
  });
}

/** Current git branch for session metadata — empty outside a repo. */
function gitBranchIn(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    });
    if (r.status === 0) return (r.stdout || '').trim();
  } catch { /* not a repo / git missing */ }
  return '';
}

/** Git repository root for session metadata — empty outside a repo. */
function gitRootIn(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    });
    if (r.status === 0) return (r.stdout || '').trim();
  } catch { /* not a repo / git missing */ }
  return '';
}

// ─── Sessions: discovery + resume ────────────────────────────────────────────

function cmdSessions() {
  const sessions = sessionStore.list();
  const recoverable = sessions.filter(s => s.status === 'INTERRUPTED');
  const active = sessions.filter(s => s.status === 'ACTIVE');
  if (sessions.length === 0) {
    console.log(`\n${C.d}No recorded sessions yet. Launch an agent through BLITZ to track one:${C.r}`);
    console.log(`${C.d}  blitz claude   •   blitz run opencode   •   blitz codex${C.r}\n`);
    return;
  }
  console.log(`\n${C.b}Sessions${C.r}  ${C.d}— recovery metadata only; conversations stay in the agent${C.r}\n`);
  sessions.slice(0, 15).forEach((s, i) => {
    const icon = s.status === 'ACTIVE' ? `${C.grn}●` : s.status === 'INTERRUPTED' ? `${C.red}⚠` : s.status === 'COMPLETED' ? `${C.d}✓` : `${C.d}·`;
    const when = s.lastActivity ? relativeTime(s.lastActivity) : '—';
    console.log(`${icon}${C.r} ${i + 1}) ${C.b}${s.projectName}${C.r}  ${C.d}${s.agent} • ${s.model || 'default'}${s.gitBranch ? ` • ${s.gitBranch}` : ''}${C.r}`);
    console.log(`      ${C.d}${s.status} • ${when} • ${s.id}${s.projectDir ? ` • ${s.projectDir}` : ''}${C.r}`);
  });
  console.log(`\n${C.d}${active.length} active • ${recoverable.length} interrupted   —   resume: blitz resume <number or id>   •   cleanup: blitz session cleanup${C.r}\n`);
}

function relativeTime(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

async function cmdSession(args) {
  const sub = (args[0] || '').toLowerCase();
  const sessions = sessionStore.list();
  if (sub === 'cleanup') {
    const removed = sessionStore.cleanup(getConfig().sessionRetentionDays);
    console.log(removed > 0
      ? `${C.grn}✓ Removed ${removed} expired session record(s)${C.r}`
      : `${C.d}Nothing expired to remove.${C.r}`);
    return;
  }
  const input = args[0] === 'show' ? args[1] : args[0];
  if (!input) return cmdSessions();
  const target = sessions.find(s => s.id === input) || sessions[parseInt(input, 10) - 1];
  if (!target) {
    console.log(`${C.red}✕ Session not found: ${input}${C.r}`);
    process.exit(1);
  }
  console.log(`\n${C.b}${target.projectName}${C.r}  ${C.d}${target.id}${C.r}\n`);
  console.log(`  Agent:        ${target.agent}`);
  console.log(`  Status:       ${target.status}`);
  console.log(`  Project:      ${target.projectDir || '—'}`);
  console.log(`  Branch:       ${target.gitBranch || '—'}`);
  console.log(`  Model:        ${target.model || '—'}  ${C.d}(${target.provider || '—'}${target.profile ? ` • profile:${target.profile}` : ''})${C.r}`);
  console.log(`  Started:      ${target.startedAt || '—'}`);
  console.log(`  Last activity:${target.lastActivity || '—'}`);
  const agentId = Object.keys(AGENTS).find(k => AGENTS[k].label === target.agent || k === target.agent);
  if (agentId === 'claude' && target.projectDir) {
    const native = claudeNativeSessions(target.projectDir);
    if (native) console.log(`  Native session: ${C.d}${native[0].id} (Claude Code's own history — BLITZ never copies it)${C.r}`);
  }
  console.log(`\n  ${C.d}Resume: blitz resume ${target.id}${C.r}\n`);
}

async function cmdResume(args) {
  const sessions = sessionStore.list();
  const candidates = sessions.filter(s => s.status === 'INTERRUPTED' || s.status === 'ACTIVE');
  if (candidates.length === 0) {
    console.log(`${C.d}No resumable sessions recorded. Launch one: blitz claude${C.r}`);
    return;
  }
  const input = args[0];
  let target;
  if (!input) {
    console.log(`\n${C.b}Resumable sessions${C.r}\n`);
    candidates.slice(0, 10).forEach((s, i) => {
      console.log(`  ${i + 1}) ${C.b}${s.projectName}${C.r} ${C.d}${s.agent} • ${s.status} • ${s.model || 'default'}${C.r}`);
    });
    console.log(`\n${C.d}Resume one: blitz resume <number or id>${C.r}\n`);
    return;
  }
  target = candidates.find(s => s.id === input) || candidates[parseInt(input, 10) - 1];
  if (!target) {
    console.log(`${C.red}✕ Session not found: ${input}${C.r}`);
    process.exit(1);
  }
  if (!target.projectDir || !existsSync(target.projectDir)) {
    console.log(`${C.red}✕ The project directory no longer exists: ${target.projectDir}${C.r}`);
    process.exit(1);
  }
  const agentId = Object.keys(AGENTS).find(k => AGENTS[k].label === target.agent || k === target.agent);
  const resume = agentId ? resumeArgs(agentId, target.projectDir) : null;
  const command = agentId ? AGENTS[agentId].cmd : target.agent;
  if (!resume) {
    console.log(`${C.yel}Native resume is unavailable for ${target.agent} — relaunching it in the project instead.${C.r}`);
  }
  await ensureServer();
  const cfg = getConfig();
  const token = await getProxyToken(keyring);
  console.log(`${C.d}Resuming ${target.projectName} (${target.agent}) in ${target.projectDir}${resume ? ' — native agent resume' : ''}${C.r}`);
  const child = spawn(command, resume || [], {
    cwd: target.projectDir,
    stdio: 'inherit',
    env: blitzEnv(cfg, token),
    shell: process.platform === 'win32',
  });
  if (child.pid) sessionStore.touch(target.id, { status: 'ACTIVE', pid: child.pid });
  child.on('error', err => {
    console.error(`${C.red}✕ Failed to launch ${command}: ${err.message}${C.r}`);
    process.exit(1);
  });
  child.on('exit', code => {
    sessionStore.markExited(child.pid, code);
    process.exit(code ?? 0);
  });
}

async function cmdShell() {
  await ensureServer();
  const cfg = getConfig();
  const token = await getProxyToken(keyring);
  const shellCmd = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL || '/bin/sh');
  console.log(`${C.d}Spawning shell with BlitzProxy environment (exit to return)...${C.r}`);
  const child = spawn(shellCmd, process.platform === 'win32' ? ['/K', `echo BlitzProxy env active — ${serverUrl(cfg)}`] : ['-i'], {
    stdio: 'inherit',
    env: blitzEnv(cfg, token),
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ─── Keys ────────────────────────────────────────────────────────────────────

async function cmdAdd(args) {
  let key = args[0];
  let name = '';
  let providerOpt = '';
  for (const a of args.slice(1)) {
    if (a.startsWith('--provider=')) providerOpt = a.slice('--provider='.length);
    else if (a !== key) name = name ? `${name} ${a}` : a;
  }

  // Interactive prompt mode when no key given (avoids shell history exposure)
  if (!key) {
    if (!process.stdin.isTTY) {
      console.log(`${C.red}✕ Usage: blitz add <api-key> [name] [--provider=name]${C.r}`);
      process.exit(1);
    }
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    key = await new Promise(resolve => {
      rl.question('API key: ', answer => { resolve(answer.trim()); });
    });
    rl.close();
    if (!key) {
      console.log(`${C.red}✕ No key entered${C.r}`);
      process.exit(1);
    }
  }

  try {
    const entry = await keyring.addKey({ key, name: name || undefined, provider: providerOpt || undefined });
    const providerKeys = await keyring.keysForProvider(entry.provider);
    const isOnlyKey = providerKeys.length === 1 && providerKeys[0].id === entry.id;
    console.log(`${C.grn}⚡ Added${isOnlyKey ? ' & activated' : ''}: ${C.b}${entry.name}${C.r}`);
    console.log(`${C.d}   Provider: ${entry.providerName}  •  Key: ${entry.maskedKey}  •  Storage: ${globalThis.__blitzMode}${C.r}`);
    if (!isOnlyKey) {
      console.log(`${C.d}   ${providerKeys.length} keys for ${entry.providerName} — they rotate automatically when one is rejected${C.r}`);
    }
    const cfg = getConfig();

    // Unrecognized key formats land on 'custom' — with no endpoint configured
    // that would break every request. Warn loudly and keep the current
    // provider instead of silently switching to a dead endpoint.
    const customConfigured = !!(cfg.customBaseUrl || cfg.customProviders?.custom);
    if (!providerOpt && entry.provider === 'custom' && !customConfigured) {
      console.log(`${C.yel}⚠ This key doesn't match any known provider format — stored under 'custom'.${C.r}`);
      console.log(`${C.d}  It will NOT be used for requests yet. If it belongs to a specific${C.r}`);
      console.log(`${C.d}  provider (e.g. nvidia), re-add it with: blitz add <key> --provider=<id>${C.r}`);
      console.log(`${C.d}  Active provider kept: ${cfg.provider || '(none)'}${C.r}`);
      return;
    }

    const def = resolveProvider(entry.provider, getConfig());
    if (def) await saveConfig({ provider: entry.provider, model: entry.model || def.defaultModel || getConfig().model });
  } catch (err) {
    if (err.code === 'AMBIGUOUS_PROVIDER') {
      const chosen = await resolveAmbiguousProvider(err.candidates);
      try {
        const entry = await keyring.addKey({ key, name: name || undefined, provider: chosen.provider });
        await saveConfig({ provider: chosen.provider, model: getConfig().model });
        console.log(`${C.grn}⚡ Added & activated: ${C.b}${entry.name}${C.r}`);
        console.log(`${C.d}   Provider: ${entry.providerName}  •  Key: ${entry.maskedKey}${C.r}`);
      } catch (e2) {
        console.error(`${C.red}✕ ${e2.message}${C.r}`);
        process.exit(1);
      }
      return;
    }
    console.error(`${C.red}✕ ${err.message}${C.r}`);
    process.exit(1);
  }
}

async function resolveAmbiguousProvider(candidates) {
  if (!process.stdin.isTTY) {
    const fallback = candidates[0];
    console.log(`${C.yel}⚠ Ambiguous key prefix "sk-" — defaulting to ${fallback.name} (non-interactive mode)${C.r}`);
    console.log(`${C.d}  To specify: blitz add <key> --provider=${fallback.provider === 'deepseek' ? 'openai' : 'deepseek'}${C.r}`);
    return fallback;
  }
  console.log(`\n${C.yel}⚠ This key starts with "sk-", which is used by multiple providers.${C.r}`);
  console.log(`${C.b}Which provider is this key for?${C.r}\n`);
  candidates.forEach((c, i) => {
    console.log(`  ${PROVIDER_ICONS[c.provider] || '  '} ${i + 1}) ${c.name}`);
  });
  console.log();
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${C.blu}Enter choice (1-${candidates.length}): ${C.r}`, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < candidates.length) resolve(candidates[idx]);
      else {
        console.log(`${C.yel}⚠ Invalid choice — defaulting to ${candidates[0].name}${C.r}`);
        resolve(candidates[0]);
      }
    });
  });
}

async function cmdKeys() {
  const keys = await keyring.listKeys();
  if (keys.length === 0) {
    console.log(`${C.yel}No API keys saved.${C.r}`);
    console.log(`${C.d}Add one: blitz add <api-key> [name]${C.r}`);
    return;
  }

  console.log(`\n${C.b}  # │ Provider        │ Name                │ Key${C.r}`);
  console.log(`${C.d}  ──┼─────────────────┼─────────────────────┼─────────────────${C.r}`);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const num = String(i + 1).padStart(2);
    const active = k.isActive ? `${C.grn}● ` : `${C.d}  `;
    const provider = (k.providerName || k.provider).padEnd(15).slice(0, 15);
    const name = k.name.padEnd(19).slice(0, 19);
    console.log(`${active}${num}${C.r} │ ${provider} │ ${name} │ ${C.d}${k.maskedKey}${C.r}`);
  }

  const cfg = getConfig();
  const active = await resolveActiveProvider(cfg, keyring);
  console.log(`\n${C.d}  Active: ${C.grn}${active.def?.name || active.providerId}${C.r}${C.d} • storage: ${globalThis.__blitzMode} • timeout ${(active.def?.timeout || cfg.timeout) / 1000 | 0}s${C.r}`);

  const counts = {};
  for (const k of keys) counts[k.provider] = (counts[k.provider] || 0) + 1;
  const multi = Object.entries(counts).filter(([, n]) => n > 1);
  if (multi.length > 0) {
    console.log(`${C.d}  Key rotation: ${multi.map(([p, n]) => `${p} ×${n}`).join(', ')} — rejected keys rotate to the next one automatically${C.r}`);
  }
  console.log();
}

async function cmdSwitch(args) {
  const cfg0 = getConfig();
  const input = args[0];

  // `blitz use <provider>/<model>` and aliases switch the ACTIVE MODEL only —
  // the credential never changes. Plain numbers/names keep switching keys.
  if (input && isNaN(parseInt(input, 10))) {
    const target = resolveAlias(cfg0, input) || input;
    const slashIdx = target.indexOf('/');
    if (slashIdx > 0) {
      const candidateProvider = target.slice(0, slashIdx);
      if (allProviderIds(cfg0).includes(candidateProvider)) {
        const providerId = candidateProvider;
        let model = target.slice(slashIdx + 1);
        // Model ids that begin with their own provider name (nvidia/nemotron-…)
        // lose the prefix when split — restore the full catalog id when the
        // stripped one is unknown and the prefixed one exists.
        if (!findModelInfo(providerId, model) && findModelInfo(providerId, `${providerId}/${model}`)) {
          model = `${providerId}/${model}`;
        }
        const def = resolveProvider(providerId, cfg0);
        if (def?.requiresKey !== false && !(await keyring.hasProvider(providerId))) {
          console.log(`${C.yel}⚠ No credential stored for ${providerId} — requests will fail until: blitz add <key> --provider=${providerId}${C.r}`);
        }
        await saveConfig({ provider: providerId, model, profile: '' });
        console.log(`${C.grn}✓ Model set: ${C.b}${model}${C.r} ${C.d}(${providerId})${C.r}`);
        console.log(`${C.d}  Credentials are untouched — switching models never switches keys.${C.r}`);
        return;
      }
    }
  }

  const keys = await keyring.listKeys();
  if (keys.length === 0) {
    console.log(`${C.yel}No keys saved. Add one: blitz add <key>${C.r}`);
    process.exit(1);
  }

  if (!input) {
    console.log(`\n${C.b}Choose a key:${C.r}\n`);
    keys.forEach((k, i) => {
      const active = k.isActive ? `${C.grn}● ` : '  ';
      console.log(`${active}${i + 1}) ${k.name} ${C.d}(${k.providerName})${C.r}`);
    });
    console.log(`\n${C.d}Usage: blitz switch <number or name>   •   blitz use <provider/model> to switch models${C.r}\n`);
    return;
  }

  const idx = parseInt(input, 10) - 1;
  let target;
  if (!isNaN(idx) && idx >= 0 && idx < keys.length) target = keys[idx];
  else target = keys.find(k => k.name.toLowerCase().includes(input.toLowerCase())
                            || k.provider.toLowerCase().includes(input.toLowerCase()));

  if (!target) {
    console.log(`${C.red}✕ Key not found: ${input}${C.r}`);
    console.log(`${C.d}  Run "blitz keys" to see stored credentials${C.r}`);
    console.log(`${C.d}  Or switch models with: blitz use <provider>/<model>${C.r}`);
    process.exit(1);
  }

  const entry = await keyring.setActiveKey(target.id);
  const def = resolveProvider(entry.provider, getConfig()) || getProvider('custom');
  await saveConfig({
    provider: entry.provider,
    model: entry.model || (findModelInfo(entry.provider, getConfig().model) ? getConfig().model : def.defaultModel),
  });
  console.log(`${C.grn}⚡ Switched to: ${C.b}${entry.name}${C.r}`);
  console.log(`${C.d}   Provider: ${entry.providerName}  •  Timeout: ${(def.timeout || 120000) / 1000}s${C.r}`);
}

async function cmdRemove(args) {
  const keys = await keyring.listKeys();
  const input = args[0];
  if (!input) {
    console.log(`${C.red}✕ Usage: blitz rm <number | name | provider>${C.r}`);
    process.exit(1);
  }

  // By provider id first (Phase 3 requirement: blitz remove <provider>)
  const known = allProviderIds(getConfig());
  if (known.includes(input.toLowerCase())) {
    const pid = input.toLowerCase();
    const n = await keyring.removeProviderKeys(pid);
    if (n > 0) {
      console.log(`${C.grn}✓ Removed ${n} key(s) for ${pid}${C.r}`);
      await syncProviderFromVault();
    } else {
      console.log(`${C.yel}No keys stored for ${pid}${C.r}`);
    }
    return;
  }

  const idx = parseInt(input, 10) - 1;
  let target;
  if (!isNaN(idx) && idx >= 0 && idx < keys.length) target = keys[idx];
  else target = keys.find(k => k.name.toLowerCase().includes(input.toLowerCase()));

  if (!target) {
    console.log(`${C.red}✕ Key not found: ${input}${C.r}`);
    process.exit(1);
  }

  await keyring.removeKey(target.id);
  console.log(`${C.grn}✓ Deleted: ${target.name}${C.r}`);
  const remaining = await keyring.listKeys();
  if (remaining.length > 0) {
    const active = remaining.find(k => k.isActive);
    if (active) console.log(`${C.d}  Active key: ${active.name}${C.r}`);
  } else {
    console.log(`${C.yel}  No keys remaining. Add one: blitz add <key>${C.r}`);
  }

  // Keep cfg.provider consistent: if we removed the active provider's key,
  // follow the vault's new active key (or clear the selection).
  await syncProviderFromVault();
}

async function syncProviderFromVault() {
  const cfg = getConfig();
  const active = await keyring.getActiveKey();
  const newProvider = active?.provider || '';
  if (newProvider !== cfg.provider) {
    const def = newProvider ? resolveProvider(newProvider, cfg) : null;
    await saveConfig({
      provider: newProvider,
      model: active?.model || def?.defaultModel || '',
    });
  }
}

async function cmdValidate(args) {
  const cfg = getConfig();
  let providerId = args[0]?.toLowerCase();
  if (!providerId) {
    const active = await resolveActiveProvider(cfg, keyring);
    providerId = active.providerId;
  }
  const def = resolveProvider(providerId, cfg);
  if (!def) {
    console.log(`${C.red}✕ Unknown provider: ${providerId}${C.r}`);
    process.exit(1);
  }
  const adapter = getAdapter(def);
  let key = '';
  if (def.requiresKey !== false) {
    // Canonical credential resolution — never keys[0].
    const cred = await resolveCredential({ keyring, providerId });
    key = cred?.key || '';
  }
  console.log(`${C.d}Validating key for ${def.name} via ${def.baseUrl}...${C.r}`);
  const result = await adapter.validateKey({ def, key });
  if (result.valid === true) {
    console.log(`${C.grn}✓ ${def.name}: key is valid${result.message ? ` — ${result.message}` : ''}${C.r}`);
  } else if (result.valid === false) {
    console.log(`${C.red}✕ ${def.name}: ${result.message}${C.r}`);
    process.exit(1);
  } else {
    console.log(`${C.yel}? ${def.name}: ${result.message}${C.r}`);
  }
}

// ─── Providers & models ───────────────────────────────────────────────────────

async function cmdProvider(args) {
  const cfg = getConfig();

  if (args.length === 0 || args[0] === 'list') {
    console.log(`\n${C.b}Available Providers:${C.r}\n`);
    const available = await availableProviders(cfg, keyring);
    for (const [key, p] of Object.entries(PROVIDERS)) {
      const active = key === cfg.provider;
      const marker = active ? `${C.grn}● ` : '  ';
      const hasKey = available.includes(key);
      const keyLabel = p.requiresKey === false ? `${C.d}no key needed${C.r}` : hasKey ? `${C.grn}key ✓${C.r}` : `${C.d}no key${C.r}`;
      console.log(`${marker}${PROVIDER_ICONS[key] || '  '} ${p.name.padEnd(17)}${C.d} timeout=${String(p.timeout / 1000).padEnd(4)}s ${C.r}${keyLabel} ${C.d}${p.description}${C.r}`);
    }
    const cfgCustom = Object.keys(cfg.customProviders || {});
    for (const id of cfgCustom) {
      const def = resolveProvider(id, cfg);
      console.log(`   ${PROVIDER_ICONS.custom} ${def.name.padEnd(17)}${C.d} custom endpoint${C.r}`);
    }
    console.log(`\n${C.d}Set provider: blitz provider <name>   (keys: blitz add <key>)${C.r}\n`);
    return;
  }

  const input = args[0].toLowerCase();
  const match = Object.entries(PROVIDERS).find(([k, p]) =>
    k === input || p.name.toLowerCase().includes(input)
  ) || Object.entries(cfg.customProviders || {}).find(([k]) => k === input);

  if (!match) {
    console.log(`${C.red}✕ Unknown provider: ${input}${C.r}`);
    console.log(`${C.d}  Run "blitz provider" to see all options${C.r}`);
    process.exit(1);
  }

  const [key, prov] = match;
  const ownedModel = cfg.model && findModelInfo(key, cfg.model) ? cfg.model : '';
  await saveConfig({ provider: key, model: ownedModel || prov.defaultModel, profile: '' });
  console.log(`${C.grn}✓ Provider: ${C.b}${prov.name}${C.r}`);
  console.log(`${C.d}   Model:   ${ownedModel || prov.defaultModel}  •  Timeout: ${prov.timeout / 1000}s${C.r}`);
  if (prov.requiresKey !== false && !(await keyring.hasProvider(key))) {
    console.log(`${C.yel}   ⚠ No key stored for ${prov.name} — blitz add <key> --provider=${key}${C.r}`);
  }
}

function modelCaps(def, m) {
  const info = def?.models?.[m];
  if (!info) return '';
  return [
    info.tools ? 'tools' : null,
    info.vision ? 'vision' : null,
    info.reasoning ? 'reasoning' : null,
    info.contextWindow ? `${(info.contextWindow / 1024) | 0}k ctx` : null,
  ].filter(Boolean).join(' ');
}

function printModelList(def, modelIds, activeModel, { live = false } = {}) {
  console.log(`\n${C.b}${live ? 'Live models' : 'Models'} for ${def?.name || 'provider'}:${C.r}\n`);
  modelIds.forEach((m, i) => {
    const isActive = m === activeModel;
    const marker = isActive ? `${C.grn}● ` : '  ';
    const caps = modelCaps(def, m);
    console.log(`${marker}${String(i + 1).padStart(2)}) ${m}${C.r}${caps ? ` ${C.d}${caps}${C.r}` : ''}`);
  });
  console.log();
}

async function ask(question) {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function setModel(providerId, model) {
  await saveConfig({ model });
  console.log(`${C.grn}✓ Model set: ${C.b}${model}${C.r} ${C.d}(${providerId})${C.r}`);
}

/**
 * Interactive selection from a numbered model list (TTY only).
 * Returns the chosen model id, or null when cancelled / invalid.
 */
async function pickModel(def, modelIds) {
  const answer = await ask(`${C.blu}Select a model (1-${modelIds.length}, Enter to cancel): ${C.r}`);
  if (!answer) return null;
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= modelIds.length) {
    console.log(`${C.yel}⚠ Invalid choice — nothing changed${C.r}`);
    return null;
  }
  return modelIds[idx];
}

function cmdModelCapabilities(modelQuery) {
  const cfg = getConfig();
  if (!modelQuery) {
    console.log(`${C.red}✕ Usage: blitz model capabilities <provider/model | model>${C.r}`);
    console.log(`${C.d}  Example: blitz model capabilities nvidia/z-ai/glm-5.3${C.r}`);
    process.exit(1);
  }
  // Resolve provider/model — same disambiguation as `blitz use`
  let providerId = cfg.provider;
  let modelId = modelQuery;
  const slashIdx = modelQuery.indexOf('/');
  if (slashIdx > 0) {
    const candidateProvider = modelQuery.slice(0, slashIdx);
    if (allProviderIds(cfg).includes(candidateProvider)) {
      providerId = candidateProvider;
      modelId = modelQuery.slice(slashIdx + 1);
      if (!findModelInfo(providerId, modelId) && findModelInfo(providerId, `${providerId}/${modelId}`)) {
        modelId = `${providerId}/${modelId}`;
      }
    }
  }
  const caps = getCapabilities(providerId, modelId, cfg);
  if (!caps) {
    console.log(`${C.red}✕ Unknown provider: ${providerId}${C.r}`);
    process.exit(1);
  }
  const def = resolveProvider(providerId, cfg);
  console.log(`\n${C.b}${modelId}${C.r} ${C.d}(${def?.name || providerId})${C.r}\n`);
  const row = (label, v) => console.log(`  ${label.padEnd(16)} ${v === true ? `${C.grn}✓${C.r}` : v === false ? `${C.red}✗${C.r}` : `${C.yel}?${C.r} ${C.d}UNKNOWN${C.r}`}`);
  row('Streaming', caps.streaming);
  row('Tools', caps.tools);
  row('Structured', caps.structuredOutput);
  row('JSON mode', caps.jsonMode);
  row('Vision', caps.vision);
  row('Reasoning', caps.reasoning);
  row('Prompt caching', caps.promptCaching);
  row('Embeddings', caps.embeddings);
  console.log(`  ${'Context'.padEnd(16)} ${C.b}${formatTokens(caps.contextWindow)}${C.r}`);
  console.log(`  ${'Max output'.padEnd(16)} ${C.b}${formatTokens(caps.maxOutputTokens)}${C.r}`);
  console.log(`  ${'Protocol'.padEnd(16)} ${C.d}${caps.protocol}${C.r}`);
  if (!caps.known) {
    console.log(`\n  ${C.yel}?  This model is not in the verified catalog — capability values are UNKNOWN,${C.r}`);
    console.log(`  ${C.d}   never assumed supported. Add catalog metadata or discover it: blitz models refresh${C.r}`);
  }
  console.log();
}

async function cmdModelTest(modelQuery) {
  const cfg = getConfig();
  const active = await resolveActiveProvider(cfg, keyring);
  if (!modelQuery) {
    console.log(`${C.d}No model given — testing the active model (${active.model || 'default'}).${C.r}`);
  }
  let providerId = active.providerId;
  let modelId = modelQuery || active.model;
  if (modelQuery) {
    const slashIdx = modelQuery.indexOf('/');
    if (slashIdx > 0) {
      const candidateProvider = modelQuery.slice(0, slashIdx);
      if (allProviderIds(cfg).includes(candidateProvider)) {
        providerId = candidateProvider;
        modelId = modelQuery.slice(slashIdx + 1);
        if (!findModelInfo(providerId, modelId) && findModelInfo(providerId, `${providerId}/${modelId}`)) {
          modelId = `${providerId}/${modelId}`;
        }
      }
    }
  }
  const def = resolveProvider(providerId, cfg);
  if (!def || !def.baseUrl) {
    console.log(`${C.red}✕ Unknown or unconfigured provider: ${providerId}${C.r}`);
    process.exit(1);
  }
  const cred = await resolveCredential({ keyring, providerId });
  if (def.requiresKey !== false && !cred) {
    console.log(`${C.red}✕ No credential stored for ${providerId} — blitz add <key> --provider=${providerId}${C.r}`);
    process.exit(1);
  }
  console.log(`${C.d}Testing ${providerId}/${modelId} with a real 1-token request (uses your credential, never prints it)…${C.r}`);
  const adapter = getAdapter(def);
  const started = Date.now();
  try {
    const res = await adapter.chat({
      def, key: cred?.key || '',
      body: { model: modelId, messages: [{ role: 'user', content: 'Say "OK" in one word.' }], max_tokens: 5, stream: false },
      timeoutMs: Math.min(def.timeout || 120000, 180000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`${C.red}✕ HTTP ${res.status}: ${text.slice(0, 200)}${C.r}`);
      process.exit(1);
    }
    let reply = '';
    try { reply = JSON.parse(text).choices?.[0]?.message?.content || 'OK'; } catch { reply = 'OK'; }
    console.log(`${C.grn}✓ ${providerId}/${modelId} responded${C.r} ${C.d}${Date.now() - started}ms — "${String(reply).trim().slice(0, 40)}"${C.r}`);
  } catch (err) {
    console.log(`${C.red}✕ ${err.message}${C.r}`);
    process.exit(1);
  }
}

async function cmdModel(args) {
  const cfg = getConfig();
  const active = await resolveActiveProvider(cfg, keyring);
  const def = resolveProvider(active.providerId, cfg) || getProvider('custom');
  const modelIds = Object.keys(def?.models || {});
  const live = args.includes('--live');

  // ── subcommands first ──
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'list') return await cmdModels([]);
  if (sub === 'capabilities' || sub === 'caps') return cmdModelCapabilities(args.slice(1).join(' '));
  if (sub === 'test') return await cmdModelTest(args.slice(1).join(' '));

  if (live && def.baseUrl) {
    try {
      const adapter = getAdapter(def);
      let key = active.key || '';
      const remote = await adapter.listModels({ def, key });
      if (remote.length > 0) {
        printModelList(def, remote, active.model, { live: true });
        if (process.stdin.isTTY) {
          const picked = await pickModel(def, remote);
          if (picked) await setModel(active.providerId, picked);
        } else {
          console.log(`${C.d}${remote.length} models — set one: blitz model <number or name>${C.r}\n`);
        }
        return;
      }
    } catch (err) {
      console.log(`${C.yel}⚠ Live fetch failed: ${err.message} — showing catalog${C.r}`);
    }
  }

  if (args.length === 0 || (args.length === 1 && live)) {
    if (modelIds.length > 0) {
      printModelList(def, modelIds, active.model);
      if (process.stdin.isTTY) {
        // The list doubles as a picker: select a model right here.
        const picked = await pickModel(def, modelIds);
        if (picked) await setModel(active.providerId, picked);
      } else {
        console.log(`${C.d}Set model: blitz model <number or name>   Live list: blitz model --live${C.r}\n`);
      }
    } else {
      console.log(`${C.d}  No predefined models. Set one manually:${C.r}`);
      console.log(`${C.d}  blitz model <model-name>   (or blitz model --live)${C.r}\n`);
    }
    return;
  }

  const input = args.filter(a => a !== '--live').join(' ');
  let newModel = input;
  let providerId = active.providerId;

  // provider/model syntax support — but only when the first segment names a
  // DIFFERENT provider than the active one. When it matches the active
  // provider (e.g. `nvidia/nemotron-...` while nvidia is active), the whole
  // input is the model id — NVIDIA/OpenRouter-style ids contain slashes.
  const slashIdx = input.indexOf('/');
  if (slashIdx > 0) {
    const candidateProvider = input.slice(0, slashIdx);
    if (candidateProvider !== active.providerId && allProviderIds(cfg).includes(candidateProvider)) {
      providerId = candidateProvider;
      newModel = input.slice(slashIdx + 1);
      // Model ids that begin with their own provider name (nvidia/nemotron-…)
      // lose the prefix when split — restore the full catalog id when the
      // stripped one is unknown and the prefixed one exists.
      if (!findModelInfo(providerId, newModel) && findModelInfo(providerId, `${providerId}/${newModel}`)) {
        newModel = `${providerId}/${newModel}`;
      }
      await saveConfig({ provider: providerId });
    }
  }

  const targetDef = resolveProvider(providerId, cfg);
  const targetModels = Object.keys(targetDef?.models || {});

  const idx = parseInt(newModel, 10) - 1;
  if (String(idx + 1) === newModel && idx >= 0 && idx < targetModels.length) {
    newModel = targetModels[idx];
  } else if (targetModels.length > 0) {
    const needle = newModel.toLowerCase();
    const matches = targetModels.filter(m => m.toLowerCase().includes(needle));
    if (matches.length === 1) {
      newModel = matches[0];
    } else if (matches.length > 1) {
      // Ambiguous fuzzy query — show the matches and let the user pick.
      printModelList(targetDef, matches, cfg.model);
      if (process.stdin.isTTY) {
        const picked = await pickModel(targetDef, matches);
        if (!picked) return;
        newModel = picked;
      } else {
        newModel = matches[0];
        console.log(`${C.d}Multiple matches — using the first. Be more specific to pick another.${C.r}`);
      }
    }
    // 0 matches: set the raw input — custom/unlisted models stay possible
  }

  await saveConfig({ model: newModel });
  console.log(`${C.grn}✓ Model set: ${C.b}${newModel}${C.r} ${C.d}(${providerId})${C.r}`);
}

// ─── blitz models: registry view, search, info, discovery ────────────────────

async function cmdModels(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'list').toLowerCase();

  if (sub === 'refresh') {
    return await cmdModelsRefresh(args.slice(1));
  }

  // Build the registry view: catalog + discovered models per provider with a
  // credential or no-key requirement.
  const avail = await availableProviders(cfg, keyring);
  const rows = [];
  for (const pid of avail) {
    const def = resolveProvider(pid, cfg);
    if (!def) continue;
    for (const [id, info] of Object.entries(def.models || {})) {
      rows.push({ provider: pid, id, caps: info, source: 'catalog' });
    }
    for (const m of discoveredList(cfg.discoveredModels, pid)) {
      if (def.models && m.id in def.models) continue;
      rows.push({ provider: pid, id: m.id, caps: null, source: 'discovered', lastSeen: m.lastSeen });
    }
  }

  const query = (args[0] && sub !== 'list' && sub !== 'info') ? args.slice(sub === 'search' ? 1 : 0).join(' ').toLowerCase() : null;
  const filtered = sub === 'search'
    ? rows.filter(r => r.id.toLowerCase().includes((args[1] || '').toLowerCase()))
    : (sub === 'info' ? rows : (query ? rows.filter(r => r.id.toLowerCase().includes(query)) : rows));

  if (sub === 'info') {
    const id = args.slice(1).join(' ');
    const row = rows.find(r => r.id === id) || rows.find(r => r.id.toLowerCase().includes(id.toLowerCase()));
    if (!row) {
      console.log(`${C.red}✕ Model not found: ${args.slice(1).join(' ')}${C.r}`);
      console.log(`${C.d}  Try: blitz models search <query>${C.r}`);
      process.exit(1);
    }
    const def = resolveProvider(row.provider, cfg);
    console.log(`\n${C.b}${row.id}${C.r} ${C.d}(${row.provider})${C.r}`);
    console.log(`  Provider:     ${def?.name || row.provider}`);
    console.log(`  Source:       ${row.source}${row.lastSeen ? ` • seen ${row.lastSeen.slice(0, 10)}` : ''}`);
    if (row.caps) {
      const caps = [
        row.caps.tools ? 'tools' : null,
        row.caps.vision ? 'vision' : null,
        row.caps.reasoning ? 'reasoning' : null,
        row.caps.contextWindow ? `${(row.caps.contextWindow / 1024) | 0}k context` : null,
      ].filter(Boolean);
      console.log(`  Capabilities: ${caps.length ? caps.join(', ') : 'text only'}`);
    } else {
      console.log(`  Capabilities: unknown (discovered — never fabricated)`);
    }
    console.log(`  Active:       ${cfg.provider === row.provider && cfg.model === row.id ? `${C.grn}yes${C.r}` : 'no'}\n`);
    return;
  }

  console.log(`\n${C.b}Models${C.r}  ${C.d}${filtered.length} across ${new Set(filtered.map(r => r.provider)).size} provider(s)${C.r}\n`);
  for (const r of filtered) {
    const isActive = cfg.provider === r.provider && cfg.model === r.id;
    const marker = isActive ? `${C.grn}● ` : '  ';
    const caps = r.caps ? [
      r.caps.tools ? 'tools' : null,
      r.caps.vision ? 'vision' : null,
      r.caps.reasoning ? 'reasoning' : null,
    ].filter(Boolean).join(' ') : '';
    console.log(`${marker}${r.id}${C.r} ${C.d}${r.provider}${C.r}${caps ? ` ${C.d}${caps}${C.r}` : ''}${isActive ? ` ${C.grn}ACTIVE${C.r}` : ''}${r.source === 'discovered' ? ` ${C.d}[discovered]${C.r}` : ''}`);
  }
  console.log(`\n${C.d}Use: blitz use <provider>/<model>   •   Refresh: blitz models refresh${C.r}\n`);
}

async function cmdModelsRefresh(args) {
  const cfg = getConfig();
  const providerId = args[0]?.toLowerCase() || cfg.provider;
  if (!providerId) {
    console.log(`${C.yel}No provider specified and none is active. Usage: blitz models refresh <provider>${C.r}`);
    process.exit(1);
  }
  const def = resolveProvider(providerId, cfg);
  if (!def || !def.baseUrl) {
    console.log(`${C.red}✕ Unknown or unconfigured provider: ${providerId}${C.r}`);
    process.exit(1);
  }
  if (def.requiresKey !== false) {
    const cred = await resolveCredential({ keyring, providerId });
    if (!cred) {
      console.log(`${C.red}✕ No credential stored for ${providerId} — add one first: blitz add <key> --provider=${providerId}${C.r}`);
      process.exit(1);
    }
    console.log(`${C.d}Discovering models for ${def.name} with credential ${cred.name}…${C.r}`);
    const adapter = getAdapter(def);
    try {
      const ids = await adapter.listModels({ def, key: cred.key });
      const discoveredModels = mergeDiscovered(cfg.discoveredModels, providerId, ids);
      const known = new Set([...Object.keys(def.models || {}), ...discoveredModels[providerId].models.map(m => m.id)]);
      saveConfig({ discoveredModels });
      console.log(`${C.grn}✓ ${ids.length} models discovered for ${def.name}${C.r}`);
      console.log(`${C.d}  Cached in config — surfaced in blitz models and GET /v1/models.${C.r}`);
      console.log(`${C.d}  Manual catalog entries are preserved; capabilities are never fabricated.${C.r}`);
    } catch (err) {
      console.log(`${C.yel}⚠ Discovery failed: ${err.message}${C.r}`);
      console.log(`${C.d}  Existing models are untouched. Add manually with:${C.r}`);
      console.log(`${C.d}  blitz use ${providerId}/<model-id>${C.r}`);
      process.exit(1);
    }
    return;
  }
  // no-key provider (ollama)
  const adapter = getAdapter(def);
  try {
    const ids = await adapter.listModels({ def, key: '' });
    const discoveredModels = mergeDiscovered(cfg.discoveredModels, providerId, ids);
    saveConfig({ discoveredModels });
    console.log(`${C.grn}✓ ${ids.length} models discovered for ${def.name}${C.r}`);
  } catch (err) {
    console.log(`${C.yel}⚠ Discovery failed: ${err.message} — existing models kept${C.r}`);
    process.exit(1);
  }
}

// ─── blitz alias: short names for provider/model pairs ──────────────────────

async function cmdAlias(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'list').toLowerCase();

  if (sub === 'set') {
    const [name, value] = args.slice(1);
    if (!name || !value) {
      console.log(`${C.red}✕ Usage: blitz alias set <name> <provider/model>${C.r}`);
      console.log(`${C.d}  Example: blitz alias set coding nvidia/z-ai/glm-5.3${C.r}`);
      process.exit(1);
    }
    if (!ALIAS_RE.test(name)) {
      console.log(`${C.red}✕ Alias names: lowercase letters, digits, dashes; max 32 chars${C.r}`);
      process.exit(1);
    }
    const err = validateAliasValue(value, allProviderIds(cfg));
    if (err) {
      console.log(`${C.red}✕ ${err}${C.r}`);
      process.exit(1);
    }
    saveConfig({ aliases: { ...cfg.aliases, [name]: value } });
    console.log(`${C.grn}✓ Alias set: ${C.b}${name}${C.r} ${C.d}→ ${value}${C.r}`);
    console.log(`${C.d}  Use it: blitz use ${name}${C.r}`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = args[1];
    if (!cfg.aliases?.[name]) {
      console.log(`${C.yel}No alias named "${name}"${C.r}`);
      process.exit(1);
    }
    const aliases = { ...cfg.aliases };
    delete aliases[name];
    saveConfig({ aliases });
    console.log(`${C.grn}✓ Removed alias: ${name}${C.r}`);
    return;
  }
  if (sub === 'list' || sub === 'show') {
    const all = listAliases(cfg);
    if (all.length === 0) {
      console.log(`${C.d}No aliases configured.${C.r}`);
      console.log(`${C.d}Create one: blitz alias set coding nvidia/z-ai/glm-5.3${C.r}\n`);
      return;
    }
    console.log(`\n${C.b}Aliases${C.r}\n`);
    for (const a of all) {
      const active = cfg.provider && a.value === `${cfg.provider}/${cfg.model}`;
      console.log(`  ${C.b}${a.name.padEnd(16)}${C.r}${C.d}→${C.r} ${a.value}${active ? ` ${C.grn}ACTIVE${C.r}` : ''}`);
    }
    console.log(`\n${C.d}Use: blitz use <alias>   •   Set: blitz alias set <name> <provider/model>${C.r}\n`);
    return;
  }
  console.log(`${C.d}Usage: blitz alias [list | set <name> <provider/model> | remove <name>]${C.r}`);
}

// ─── blitz credential(s): unified credential management ──────────────────────

async function cmdCredential(args) {
  const sub = (args[0] || 'list').toLowerCase();
  const rest = args.slice(1);
  switch (sub) {
    case 'add':     return await cmdAdd(rest);
    case 'list':
    case 'show':    return await cmdKeys();
    case 'use':     return await cmdSwitch(rest);
    case 'test':    return await cmdValidate(rest);
    case 'remove':
    case 'rm':      return await cmdRemove(rest);
    default:
      console.log(`${C.d}Usage: blitz credential [add | list | use <n> | test [provider] | remove <n>]${C.r}`);
      console.log(`${C.d}  (aliases: blitz add / keys / switch / validate / rm)${C.r}`);
  }
}

async function cmdTest() {
  const cfg = getConfig();
  const active = await resolveActiveProvider(cfg, keyring);
  const def = resolveProvider(active.providerId, cfg);
  if (!def || !def.baseUrl) {
    console.log(`${C.red}✕ No provider endpoint configured.${C.r}`);
    process.exit(1);
  }
  const adapter = getAdapter(def);
  const model = active.model || def.defaultModel;
  console.log(`\n${C.d}Testing ${def.name} (${model}) at ${def.baseUrl}...${C.r}`);
  const started = Date.now();
  try {
    const res = await adapter.chat({
      def, key: active.key,
      body: {
        model,
        messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
        max_tokens: 5,
        stream: false,
      },
      timeoutMs: Math.min(def.timeout || 120000, 60000),
      extraHeaders: cfg.customHeaders,
    });
    if (!res.ok) {
      const err = await res.text();
      console.log(`${C.red}✕ Provider returned ${res.status}: ${err.slice(0, 200)}${C.r}`);
      process.exit(1);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message?.content || 'OK';
    console.log(`${C.grn}✓ Connected! ${C.r}${C.d}${Date.now() - started}ms — Response: "${String(msg).trim()}"${C.r}\n`);
  } catch (err) {
    console.log(`${C.red}✕ ${err.message}${C.r}`);
    process.exit(1);
  }
}

// ─── Health / auto / fallback / profiles ──────────────────────────────────────

async function cmdHealth() {
  const cfg = getConfig();
  const providerIds = new Set([...(await availableProviders(cfg, keyring))]);
  if (!providerIds.has(cfg.provider) && cfg.provider) providerIds.add(cfg.provider);

  console.log(`\n${C.b}Provider Health${C.r}  ${C.d}(live checks, cached by server when running)\n${C.r}`);
  const rows = [];
  for (const id of providerIds) {
    const def = resolveProvider(id, cfg);
    if (!def || (!def.baseUrl && !cfg.customBaseUrl)) continue;
    const effDef = def.id === 'custom' && cfg.customBaseUrl ? { ...def, baseUrl: cfg.customBaseUrl } : def;
    const adapter = getAdapter(effDef);
    let key = '';
    if (def.requiresKey !== false) {
      // Canonical credential resolution — never keys[0].
      const cred = await resolveCredential({ keyring, providerId: id });
      if (!cred) { rows.push({ id, label: 'NO-KEY', color: 'dim' }); continue; }
      key = cred.key;
    }
    const h = await adapter.healthCheck({ def: effDef, key, deep: true });
    const f = formatHealth(h);
    rows.push({ id, label: f.label, color: f.color, latency: f.latency, name: def.name });
  }

  for (const r of rows) {
    const color = { green: C.grn, yellow: C.yel, red: C.red, dim: C.d }[r.color] || C.d;
    const label = r.label.padEnd(13);
    const name = (r.name || r.id).padEnd(17);
    console.log(`  ${name} ${color}${label}${C.r} ${C.d}${r.latency || ''}${C.r}`);
  }
  console.log();
}

function cmdAuto(args) {
  const cfg = getConfig();
  const arg = (args[0] || '').toLowerCase();
  const current = cfg.routing === 'auto';
  const next = arg === 'on' ? true : arg === 'off' ? false : arg === 'status' ? current : !current;
  if (arg === 'status') {
    console.log(`Routing: ${current ? `${C.grn}auto${C.r}` : 'manual'}`);
    return;
  }
  saveConfig({ routing: next ? 'auto' : 'manual' });
  if (next) {
    console.log(`${C.grn}⚡ Automatic routing enabled.${C.r}`);
    console.log(`${C.d}  Requests pick the best available provider by health,${C.r}`);
    console.log(`${C.d}  capabilities, and priority — with your configured fallback chain.${C.r}`);
  } else {
    console.log(`${C.grn}✓ Manual routing — using active provider + fallback chain.${C.r}`);
  }
}

function cmdFallback(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'list').toLowerCase();

  if (sub === 'list' || sub === 'show') {
    if (cfg.fallbackChain.length === 0) {
      console.log(`${C.d}No fallback chain configured.${C.r}`);
      console.log(`${C.d}Add one: blitz fallback add groq${C.r}`);
      return;
    }
    console.log(`\n${C.b}Fallback chain:${C.r}`);
    console.log(`  ${C.grn}${cfg.provider || 'active'}${C.r} → ${cfg.fallbackChain.join(' → ')}\n`);
    return;
  }
  if (sub === 'add') {
    const id = (args[1] || '').toLowerCase();
    if (!allProviderIds(cfg).includes(id)) {
      console.log(`${C.red}✕ Unknown provider: ${id}${C.r}`);
      process.exit(1);
    }
    if (!cfg.fallbackChain.includes(id)) {
      saveConfig({ fallbackChain: [...cfg.fallbackChain, id] });
    }
    console.log(`${C.grn}✓ Fallback chain: ${cfg.provider || 'active'} → ${[...cfg.fallbackChain, id].filter((v, i, a) => a.indexOf(v) === i).join(' → ')}${C.r}`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const id = (args[1] || '').toLowerCase();
    saveConfig({ fallbackChain: cfg.fallbackChain.filter(f => f !== id) });
    console.log(`${C.grn}✓ Removed ${id} from fallback chain${C.r}`);
    return;
  }
  console.log(`${C.d}Usage: blitz fallback list | add <provider> | remove <provider>${C.r}`);
}

async function cmdProfile(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'list').toLowerCase();

  if (sub === 'list' || sub === 'show' || sub === '') {
    const profiles = listProfiles(cfg);
    console.log(`\n${C.b}Profiles:${C.r}\n`);
    for (const p of profiles) {
      const active = cfg.profile === p.name;
      const marker = active ? `${C.grn}● ` : '  ';
      console.log(`${marker}${C.b}${p.name}${C.r}${p.builtIn ? '' : ' (custom)'} ${C.d}— ${p.description}${C.r}`);
      console.log(`     ${C.d}chain: ${p.chain.join(' → ')}${C.r}`);
    }
    console.log(`\n${C.d}Activate: blitz profile set <name>   Deactivate: blitz profile off${C.r}\n`);
    return;
  }
  if (sub === 'set' || sub === 'use') {
    const name = args[1];
    const resolved = resolveProfileChain(name, cfg, allProviderIds(cfg));
    if (!resolved.ok) {
      console.log(`${C.red}✕ ${resolved.error}${C.r}`);
      process.exit(1);
    }
    saveConfig({ profile: name });
    console.log(`${C.grn}⚡ Profile: ${C.b}${name}${C.r}`);
    console.log(`${C.d}   Chain: ${resolved.candidates.map(c => c.provider + (c.model ? '/' + c.model : '')).join(' → ') || '(no usable entries)'}${C.r}`);
    for (const s of resolved.skipped) console.log(`${C.yel}   ⚠ skipped ${s}${C.r}`);
    return;
  }
  if (sub === 'off') {
    saveConfig({ profile: '' });
    console.log(`${C.grn}✓ Profile cleared — using active provider + fallback chain.${C.r}`);
    return;
  }
  if (sub === 'add') {
    const name = args[1];
    const chainIdx = args.indexOf('--chain');
    const chain = chainIdx !== -1 ? args[chainIdx + 1]?.split(',').map(s => s.trim()).filter(Boolean) : null;
    if (!name || !chain || chain.length === 0) {
      console.log(`${C.red}✕ Usage: blitz profile add <name> --chain "nvidia,deepseek/deepseek-chat"${C.r}`);
      process.exit(1);
    }
    const profiles = { ...(cfg.profiles || {}) };
    profiles[name] = { chain, description: args.find(a => a.startsWith('--desc='))?.slice(7) || 'User profile' };
    saveConfig({ profiles });
    console.log(`${C.grn}✓ Profile "${name}" saved: ${chain.join(' → ')}${C.r}`);
    console.log(`${C.d}  Activate: blitz profile set ${name}${C.r}`);
    return;
  }
  console.log(`${C.d}Usage: blitz profile [list | set <name> | add <name> --chain ... | off]${C.r}`);
}

// ─── Stats / config / privacy / token / dashboard ─────────────────────────────

async function cmdStats() {
  const cfg = getConfig();
  const stats = createStats({ home: HOME, privacy: cfg.privacy === true });
  const today = stats.getSummary({ scope: 'today' });
  const all = stats.getSummary({ scope: 'all' });

  const renderRows = (rows, title) => {
    console.log(`\n${C.b}${title}${C.r}`);
    if (rows.length === 0) {
      console.log(`  ${C.d}No requests recorded.${C.r}`);
      return;
    }
    for (const r of rows) {
      console.log(`  ${C.b}${r.providerId.padEnd(12)}${C.r}req=${String(r.requests).padEnd(6)} ok=${C.grn}${String(r.ok).padEnd(6)}${C.r}fail=${C.red}${String(r.fail).padEnd(4)}${C.r}rl=${String(r.rateLimited).padEnd(4)} lat=${r.avgLatencyMs != null ? r.avgLatencyMs + 'ms' : '—'} in=${fmtTokens(r.inputTokens)} out=${fmtTokens(r.outputTokens)} ${r.costUsd != null ? `≈$${r.costUsd.toFixed(4)}` : '$n/a'}`);
    }
  };

  renderRows(today, 'Today');
  if (cfg.privacy) {
    console.log(`\n  ${C.yel}⚠ Privacy mode: stats are in-memory only for this server session.${C.r}`);
  }
  const allDiff = all.length > 0 && (all.length !== today.length || all.some(a => (today.find(t => t.providerId === a.providerId)?.requests || 0) !== a.requests));
  if (allDiff) renderRows(all, 'All time (90 days)');
  console.log(`\n${C.d}Costs are ESTIMATES from the catalog — n/a means pricing is unknown/dynamic.${C.r}\n`);
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const CONFIG_KEYS = new Set([
  'provider', 'model', 'routing', 'profile', 'proxyPort', 'host', 'requireAuth',
  'timeout', 'maxRetries', 'retryBaseDelay', 'logLevel', 'logRequests', 'privacy',
  'healthTtlMs', 'customBaseUrl', 'fallbackChain', 'fallbackOnAuthError',
]);

async function cmdConfig(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'show').toLowerCase();

  if (sub === 'validate') {
    // Syntax: re-parse the file from disk exactly as the server would.
    let syntaxOk = true;
    let syntaxErr = '';
    try {
      JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      syntaxOk = false;
      syntaxErr = e.message;
    }
    if (!syntaxOk) {
      console.log(`${C.red}✗ Configuration syntax${C.r}`);
      console.log(`    ${syntaxErr}`);
      console.log(`\n${C.red}Configuration is INVALID — fix the error above. (${CONFIG_PATH})${C.r}`);
      process.exit(1);
    }
    const result = validateConfig(getConfig(), { credentials: await keyring.listKeys() });
    console.log(`\n${C.b}Validating ${CONFIG_PATH}${C.r}\n`);
    console.log(`${C.grn}✓${C.r} Configuration syntax`);
    const out = formatValidation(result)
      .replace(/^✗ /gm, `${C.red}✗ ${C.r}`)
      .replace(/^⚠ /gm, `${C.yel}⚠ ${C.r}`)
      .replace(/Configuration is INVALID/g, `${C.red}Configuration is INVALID${C.r}`)
      .replace(/Configuration is valid/g, `${C.grn}Configuration is valid${C.r}`);
    console.log(out);
    process.exit(result.ok ? 0 : 1);
  }

  if (sub === 'show') {
    console.log(`\n${C.b}BlitzProxy Configuration${C.r}  ${C.d}${CONFIG_PATH}${C.r}\n`);
    const safe = { ...cfg };
    safe.customHeaders = Object.fromEntries(Object.entries(cfg.customHeaders || {}).map(([k]) => [k, '***']));
    for (const [k, v] of Object.entries(safe)) {
      if (k.startsWith('_')) continue;
      const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      console.log(`  ${k.padEnd(22)} ${C.blu}${val}${C.r}`);
    }
    console.log(`\n${C.d}Change: blitz config set <key> <value>   Keys are stored in the secure keyring.${C.r}\n`);
    return;
  }
  if (sub === 'set') {
    const key = args[1];
    const rawValue = args.slice(2).join(' ');
    if (!key || !rawValue) {
      console.log(`${C.red}✕ Usage: blitz config set <key> <value>${C.r}`);
      process.exit(1);
    }
    if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('secret')) {
      console.log(`${C.red}✕ Secrets are managed via the keyring: blitz add <key>${C.r}`);
      process.exit(1);
    }
    let value;
    const looksLikeJson = rawValue.startsWith('{') || rawValue.startsWith('[');
    if (looksLikeJson) {
      try {
        value = JSON.parse(rawValue);
      } catch (e) {
        console.log(`${C.red}✕ Invalid JSON for "${key}": ${e.message}${C.r}`);
        console.log(`${C.d}  Hint: quote the whole value; on PowerShell prefer single quotes,${C.r}`);
        console.log(`${C.d}  or set objects via: blitz config set ${key} (file mode coming)${C.r}`);
        process.exit(1);
      }
    } else {
      try {
        value = JSON.parse(rawValue);
      } catch {
        if (/^(true|false)$/.test(rawValue)) value = rawValue === 'true';
        else if (!isNaN(parseInt(rawValue, 10)) && rawValue === String(parseInt(rawValue, 10))) value = parseInt(rawValue, 10);
        else value = rawValue;
      }
    }
    const updates = { [key]: value };
    if (key === 'timeout') updates._timeoutSet = true;
    if (key === 'proxyPort' || key === 'host') updates._needsRestart = true;
    saveConfig(updates);
    console.log(`${C.grn}✓ ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}${C.r}`);
    if (updates._needsRestart && !key.startsWith('_')) {
      console.log(`${C.d}  Restart the server to apply: blitz restart${C.r}`);
    }
    return;
  }
  if (sub === 'get') {
    const key = args[1];
    const val = cfg[key];
    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? ''));
    return;
  }
  console.log(`${C.d}Usage: blitz config [show | get <key> | set <key> <value>]${C.r}`);
}

function cmdPrivacy() {
  const cfg = getConfig();
  const next = !cfg.privacy;
  saveConfig({ privacy: next });
  if (next) {
    console.log(`${C.grn}🔒 Privacy mode ON${C.r}`);
    console.log(`  ${C.d}• Request logging to blitz.log: disabled${C.r}`);
    console.log(`  ${C.d}• Usage stats: kept in memory only, never written to disk${C.r}`);
    console.log(`  ${C.d}• Prompts/responses: never stored (that was already true)${C.r}`);
    console.log(`  ${C.d}• API keys: still in the OS keyring (needed to work)${C.r}`);
    console.log(`  ${C.d}Restart the server to apply fully: blitz restart${C.r}`);
  } else {
    console.log(`${C.grn}✓ Privacy mode OFF${C.r}`);
    console.log(`  ${C.d}• Aggregate request logs (no prompts) written to blitz.log${C.r}`);
    console.log(`  ${C.d}• Stats persisted to ~/.blitzproxy/stats.json${C.r}`);
  }
}

async function cmdToken() {
  const token = await getProxyToken(keyring);
  console.log(`\n${C.b}BlitzProxy local token:${C.r}`);
  console.log(`  ${C.blu}${token}${C.r}\n`);
  console.log(`${C.d}Used for /admin endpoints and the dashboard. ${C.r}`);
  console.log(`${C.d}Set as ANTHROPIC_API_KEY in clients when requireAuth is on.${C.r}\n`);
}

async function cmdDashboard() {
  const cfg = getConfig();
  const running = await probeServer(cfg);
  if (!running) {
    console.log(`${C.yel}BlitzProxy is not running — starting it...${C.r}`);
  }
  await ensureServer();
  const token = await getProxyToken(keyring);
  const url = `${serverUrl(cfg)}/dashboard?token=${token}`;
  console.log(`\n${C.b}Dashboard:${C.r}\n  ${C.blu}${url}${C.r}\n`);
  console.log(`${C.d}Open the URL in a local browser. It is only reachable from this machine.${C.r}\n`);
}

// ─── Doctor ──────────────────────────────────────────────────────────────────

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf-8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

async function cmdDoctor() {
  const cfg = getConfig();
  const results = [];
  const check = (name, status, hint) => results.push({ name, status, hint });

  // 1. Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  check('Node.js', major >= 18 ? 'pass' : 'fail',
    major >= 18 ? `v${process.versions.node}` : `v${process.versions.node} — install Node 18+ from nodejs.org`);

  // 2. Config file
  if (existsSync(CONFIG_PATH)) {
    try {
      JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      check('config.json', 'pass', CONFIG_PATH);
    } catch (e) {
      check('config.json', 'fail', `parse error: ${e.message}`);
    }
  } else {
    check('config.json', 'warn', 'not created yet — created on first `blitz config set`');
  }

  // 3. Keyring
  const mode = globalThis.__blitzMode;
  check('Keyring storage', mode === 'file' ? 'warn' : 'pass',
    mode === 'file' ? '⚠ plaintext fallback in use — OS secure storage unavailable' : `${mode} (OS secure storage)`);

  // 4. Keys + active provider
  const keys = await keyring.listKeys();
  const active = await resolveActiveProvider(cfg, keyring);
  check('API keys', keys.length > 0 ? 'pass' : 'warn',
    keys.length > 0 ? `${keys.length} stored (${keys.map(k => k.provider).join(', ')})` : 'none — only local/no-key providers usable');

  if (active.def?.requiresKey !== false && !active.key) {
    check('Active provider key', 'fail', `no key for ${active.providerId} — blitz add <key> --provider=${active.providerId}`);
  } else {
    check('Active provider key', 'pass', `${active.def?.name || active.providerId}`);
  }

  // 5. Model known?
  if (active.model && active.def) {
    const known = findModelInfo(active.providerId, active.model);
    check('Active model', known ? 'pass' : 'warn',
      known ? active.model : `${active.model} — not in catalog; fine for custom endpoints, otherwise check spelling`);
  }

  // 6. Proxy port
  const running = await probeServer(cfg, 2000);
  if (running) {
    check('Proxy server', 'pass', `running at ${serverUrl(cfg)} (provider: ${running.provider})`);
  } else {
    try {
      const res = await fetch(`${serverUrl(cfg)}/`, { signal: AbortSignal.timeout(600) });
      check('Proxy server', 'fail', `port ${cfg.proxyPort} occupied by something else — blitz config set proxyPort <port>`);
      void res;
    } catch {
      check('Proxy server', 'warn', `not running — blitz start`);
    }
  }

  // 7. Conflicting global env
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL !== serverUrl(cfg)) {
    check('ANTHROPIC_BASE_URL', 'fail',
      `set to ${process.env.ANTHROPIC_BASE_URL} in this shell — plain "claude" targets the wrong endpoint. Run via: blitz run claude`);
  } else {
    check('ANTHROPIC_BASE_URL', 'pass', process.env.ANTHROPIC_BASE_URL ? `correct (${serverUrl(cfg)})` : 'not set globally — use blitz run claude');
  }

  // 8/9. Client tools
  const claudePath = which('claude');
  check('Claude Code CLI', claudePath ? 'pass' : 'warn', claudePath || 'not found — npm install -g @anthropic-ai/claude-code');
  const opencodePath = which('opencode');
  check('OpenCode CLI', opencodePath ? 'pass' : 'info', opencodePath || 'not installed (optional)');

  // 10. .env input
  if (process.env.API_KEY) {
    check('.env / API_KEY', 'warn', 'API_KEY is set in the environment — it overrides the keyring while present');
  }

  // 11. Write permissions
  try {
    writeFileSync(CONFIG_PATH + '.doctor.tmp', '{}', 'utf-8');
    unlinkSync(CONFIG_PATH + '.doctor.tmp');
    check('Config write access', 'pass', dirname(CONFIG_PATH));
  } catch (e) {
    check('Config write access', 'fail', e.message);
  }

  // Render
  console.log(`\n${C.b}⚡ BlitzProxy Doctor${C.r}\n`);
  let fails = 0, warns = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? `${C.grn}[PASS]${C.r}` : r.status === 'warn' ? `${C.yel}[WARN]${C.r}` : r.status === 'info' ? `${C.d}[INFO]${C.r}` : `${C.red}[FAIL]${C.r}`;
    if (r.status === 'fail') fails++;
    if (r.status === 'warn') warns++;
    console.log(`  ${icon} ${r.name.padEnd(20)} ${C.d}${r.hint}${C.r}`);
  }
  console.log(`\n  ${fails === 0 ? `${C.grn}All critical checks passed.` : `${C.red}${fails} critical issue(s).`} ${warns > 0 ? `${C.yel}${warns} warning(s).` : ''}${C.r}\n`);
  if (fails > 0) process.exit(1);
}

// ─── Logs ────────────────────────────────────────────────────────────────────

function colorLogLine(line) {
  if (!line.trim()) return '';
  if (line.includes('FALLBACK')) return `${C.yel}${line}${C.r}`;
  if (line.includes('ERROR')) {
    const code = line.match(/ERROR\s+(\d+)/);
    if (code) {
      const status = parseInt(code[1], 10);
      if (status >= 500) return `${C.red}${line}${C.r}`;
      if (status >= 400) return `${C.yel}${line}${C.r}`;
    }
    return `${C.red}${line}${C.r}`;
  }
  if (line.includes('→ 200')) return `${C.grn}${line}${C.r}`;
  return line;
}

function cmdLogs(args) {
  const flag = args[0];

  if (flag === '--clear') {
    try {
      writeFileSync(LOG_PATH, '', 'utf-8');
      console.log(`${C.grn}✓ Log file cleared${C.r}`);
    } catch {
      console.log(`${C.yel}No log file to clear${C.r}`);
    }
    return;
  }

  if (flag === '--live') {
    console.log(`${C.d}Watching ${LOG_PATH}... (Ctrl+C to stop)${C.r}\n`);
    let lastSize = 0;
    try { lastSize = statSync(LOG_PATH).size; } catch { /* no file yet */ }

    watchFile(LOG_PATH, { interval: 500 }, (curr) => {
      if (curr.size < lastSize) lastSize = 0; // rotated
      if (curr.size > lastSize) {
        try {
          const buf = readFileSync(LOG_PATH);
          const newContent = buf.slice(lastSize).toString('utf-8');
          for (const line of newContent.split('\n').filter(l => l.trim())) {
            console.log(colorLogLine(line));
          }
        } catch { /* ignore transient read errors */ }
        lastSize = curr.size;
      }
    });
    return;
  }

  let content = '';
  try {
    content = readFileSync(LOG_PATH, 'utf-8');
  } catch {
    console.log(`${C.yel}No log file found. Start the proxy to generate logs.${C.r}`);
    return;
  }
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    console.log(`${C.d}Log file is empty.${C.r}`);
    return;
  }
  const last50 = lines.slice(-50);
  console.log(`${C.d}── Last ${last50.length} log entries ──${C.r}\n`);
  for (const line of last50) console.log(colorLogLine(line));
  console.log(`\n${C.d}Total: ${lines.length} │ blitz logs --live │ blitz logs --clear${C.r}`);
}

// ─── Help & version ──────────────────────────────────────────────────────────

function printVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    console.log(`BlitzProxy v${pkg.version}`);
  } catch {
    console.log('BlitzProxy (unknown version)');
  }
}

function cmdHelp(isDefault, unknown) {
  if (unknown) {
    console.log(`${C.red}✕ Unknown command: ${unknown}${C.r}\n`);
  }
  console.log(`
${C.b}⚡ BlitzProxy — Local AI Provider Gateway${C.r}

${C.b}RUN:${C.r}
  blitz                    Start proxy + launch Claude Code (env for this process only)
  blitz run <cmd...>       Run any command with BlitzProxy env (blitz run claude,
                           blitz run codex, blitz run opencode — both Anthropic and
                           OpenAI env vars are set)
  blitz shell              Spawn a shell with BlitzProxy environment
  blitz start / stop / restart / status   Manage the proxy server

${C.b}API KEYS (secure keyring)${C.r}
  blitz add [key] [name] [--provider=x]  Add API key (provider auto-detected)
  blitz keys               List keys (masked)
  blitz switch <n|name>    Switch active key
  blitz rm <n|name|provider>  Remove key(s)
  blitz validate [provider]  Validate key against the provider API

${C.b}ROUTING:${C.r}
  blitz provider [name]    List / switch provider
  blitz model [name|--live]  List / set model (supports provider/model)
  blitz fallback [list|add|remove <p>]   Configure fallback chain
  blitz profile [list|set|add|off]       Routing profiles (coding/fast/free/local)
  blitz auto [on|off]      Toggle automatic routing
  blitz health             Live provider health check

${C.b}INSIGHT:${C.r}
  blitz stats              Usage + estimated cost per provider
  blitz config [show|set|get]  Configuration (secrets masked)
  blitz privacy            Toggle privacy mode (no logs/stats on disk)
  blitz token              Show the local proxy auth token
  blitz dashboard          Open dashboard URL (localhost, token-gated)
  blitz doctor             Diagnose common problems
  blitz test               Round-trip test of active provider

${C.b}LOGS:${C.r}
  blitz logs [--live|--clear]

${C.b}MORE:${C.r}
  blitz help               This help
  blitz --version          Version
  `);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`${C.red}✕ ${err.stack || err.message || err}${C.r}`);
  process.exit(1);
});
