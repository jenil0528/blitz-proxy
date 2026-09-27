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

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.BLITZ_HOME || join(homedir(), '.blitzproxy');
const PID_FILE = join(HOME, 'blitz.pid');
const LOG_PATH = join(__dirname, 'blitz.log');

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
    case 'provider':
    case 'providers':      return await cmdProvider(args);
    case 'test':           return await cmdTest();
    case 'health':         return await cmdHealth();
    case 'auto':           return cmdAuto(args);

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
    case 'config':         return cmdConfig(args);
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

  console.log(`\n${C.b}⚡ BlitzProxy Status${C.r}\n`);
  console.log(`  Server:    ${running ? `${C.grn}running` : `${C.red}stopped`}${C.r}  ${running ? `(${serverUrl(cfg)})` : ''}`);
  console.log(`  Provider:  ${C.grn}${active.def?.name || active.providerId}${C.r}`);
  console.log(`  Model:     ${C.blu}${active.model || '—'}${C.r}`);
  console.log(`  Routing:   ${cfg.profile ? `profile:${cfg.profile}` : cfg.routing}${cfg.fallbackChain.length ? `  •  fallback: ${cfg.fallbackChain.join(' → ')}` : ''}`);
  console.log(`  Keys:      ${await keyring.keyCount()} in ${globalThis.__blitzMode} keyring`);
  console.log(`  Privacy:   ${cfg.privacy ? `${C.grn}ON${C.r}` : 'off'}`);
  console.log(`  Config:    ${CONFIG_PATH}\n`);
}

// ─── blitz run / blitz shell (no global env hijack) ──────────────────────────

function blitzEnv(cfg, token) {
  const url = serverUrl(cfg);
  return {
    ...process.env,
    // Anthropic clients (Claude Code)
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: activeModelOrEmpty(cfg),
    // OpenAI clients (Codex CLI, OpenCode, Aider, Continue, …)
    OPENAI_BASE_URL: `${url}/v1`,
    OPENAI_API_KEY: token,
  };
}

function activeModelOrEmpty(cfg) {
  return cfg.model || '';
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
  const child = spawn(command, args.slice(1), {
    stdio: 'inherit',
    env: blitzEnv(cfg, token),
    shell: process.platform === 'win32',
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`${C.red}✕ Command not found: ${command}${C.r}`);
      console.error(`${C.d}  Claude Code: npm install -g @anthropic-ai/claude-code${C.r}`);
      process.exit(127);
    }
    console.error(`${C.red}✕ ${err.message}${C.r}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
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
  const keys = await keyring.listKeys();
  if (keys.length === 0) {
    console.log(`${C.yel}No keys saved. Add one: blitz add <key>${C.r}`);
    process.exit(1);
  }

  const input = args[0];
  if (!input) {
    console.log(`\n${C.b}Choose a key:${C.r}\n`);
    keys.forEach((k, i) => {
      const active = k.isActive ? `${C.grn}● ` : '  ';
      console.log(`${active}${i + 1}) ${k.name} ${C.d}(${k.providerName})${C.r}`);
    });
    console.log(`\n${C.d}Usage: blitz switch <number or name>${C.r}\n`);
    return;
  }

  const idx = parseInt(input, 10) - 1;
  let target;
  if (!isNaN(idx) && idx >= 0 && idx < keys.length) target = keys[idx];
  else target = keys.find(k => k.name.toLowerCase().includes(input.toLowerCase())
                            || k.provider.toLowerCase().includes(input.toLowerCase()));

  if (!target) {
    console.log(`${C.red}✕ Key not found: ${input}${C.r}`);
    console.log(`${C.d}  Run "blitz keys" to see available keys${C.r}`);
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
    const entry = (await keyring.keysForProvider(providerId))[0];
    if (entry) key = (await keyring.getKeyById(entry.id))?.key || '';
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

async function cmdModel(args) {
  const cfg = getConfig();
  const active = await resolveActiveProvider(cfg, keyring);
  const def = resolveProvider(active.providerId, cfg) || getProvider('custom');
  const modelIds = Object.keys(def?.models || {});
  const live = args.includes('--live');

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
      const entry = (await keyring.keysForProvider(id))[0];
      if (!entry) { rows.push({ id, label: 'NO-KEY', color: 'dim' }); continue; }
      key = (await keyring.getKeyById(entry.id))?.key || '';
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

function cmdConfig(args) {
  const cfg = getConfig();
  const sub = (args[0] || 'show').toLowerCase();

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
