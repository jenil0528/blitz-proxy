// ============================================================================
// BlitzProxy — Secure API Key Storage (Keyring)
// Platform-aware secret storage, zero runtime dependencies:
//   Windows  → DPAPI (per-user encrypted blob, via PowerShell)
//   macOS    → Keychain (security CLI)
//   Linux    → Secret Service (secret-tool)
//   fallback → plaintext file with 0600 permissions + loud warning
//   memory   → in-process only (tests)
//
// The vault is a single JSON blob so every platform only needs one secret:
//   { version, activeKeyId, keys: [ { id, name, key, provider, providerName, model, createdAt } ], secrets: {} }
//
// Env overrides (also used by the test-suite for isolation):
//   BLITZ_HOME    → vault directory (default ~/.blitzproxy)
//   BLITZ_KEYRING → force 'dpapi' | 'keychain' | 'secret-service' | 'file' | 'memory'
// ============================================================================

import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, statSync, unlinkSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { maskKeyWithPrefix } from './mask.js';
import { detectProviderFromKey } from '../providers.js';

const REFRESH_MS = 2000;

let homeDir = null;
let mode = null;
let vault = null;               // in-memory cache of the blob
let lastRefresh = 0;
let vaultMtime = 0;
let fileWarned = false;

// ─── Low-level process helper ────────────────────────────────────────────────

// windowsHide is critical: the detached proxy server has no console, so a
// spawned console app (powershell.exe for DPAPI) would otherwise pop a
// visible terminal window on the user's screen — mid-session.
function runTool(cmd, args, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function toolExists(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return r.error ? false : true;
  } catch {
    return false;
  }
}

// ─── Platform backends — each stores/loads ONE string (the vault blob) ──────

async function dpapiStore(blobStr) {
  const ps =
    '$in = [Console]::In.ReadToEnd(); ' +
    'Add-Type -AssemblyName System.Security; ' +
    '$bytes = [Text.Encoding]::UTF8.GetBytes($in); ' +
    '$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Convert]::ToBase64String($enc))';
  const b64 = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], blobStr);
  atomicWrite(vaultPath('keys.bin'), b64);
}

async function dpapiLoad() {
  const p = vaultPath('keys.bin');
  if (!existsSync(p)) return null;
  const b64 = readFileSync(p, 'utf-8').trim();
  const ps =
    '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    'Add-Type -AssemblyName System.Security; ' +
    '$dec = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))';
  return await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], b64);
}

async function keychainStore(blobStr) {
  await runTool('security', ['add-generic-password', '-s', 'blitzproxy', '-a', 'vault', '-w', blobStr, '-U']);
}

async function keychainLoad() {
  try {
    return await runTool('security', ['find-generic-password', '-s', 'blitzproxy', '-a', 'vault', '-w']);
  } catch (err) {
    if (String(err.message).includes('could not be found')) return null;
    throw err;
  }
}

async function secretServiceStore(blobStr) {
  const p = vaultPath('vault.tmp');
  atomicWrite(p, blobStr);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('secret-tool', ['store', '--label=BlitzProxy', 'service', 'blitzproxy', 'account', 'vault'], { windowsHide: true });
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`)));
    });
  } finally {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

async function secretServiceLoad() {
  try {
    return await runTool('secret-tool', ['lookup', 'service', 'blitzproxy', 'account', 'vault']);
  } catch (err) {
    if (String(err.message).includes('exited 1')) return null;
    throw err;
  }
}

function fileStore(blobStr) {
  const p = vaultPath('keys.json');
  atomicWrite(p, blobStr);
  try { chmodSync(p, 0o600); } catch { /* Windows: ACLs apply instead */ }
}

function fileLoad() {
  const p = vaultPath('keys.json');
  if (!existsSync(p)) return null;
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  return readFileSync(p, 'utf-8');
}

// ─── Vault plumbing ──────────────────────────────────────────────────────────

function vaultPath(name) {
  return join(homeDir, name);
}

function atomicWrite(path, content) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

async function persist() {
  const blobStr = JSON.stringify(vault);
  switch (mode) {
    case 'dpapi': await dpapiStore(blobStr); break;
    case 'keychain': await keychainStore(blobStr); break;
    case 'secret-service': await secretServiceStore(blobStr); break;
    case 'file': fileStore(blobStr); break;
    case 'memory': break;
  }
  // Track our own file mtime where a file exists (fast refresh path)
  try {
    const p = mode === 'dpapi' ? vaultPath('keys.bin') : mode === 'file' ? vaultPath('keys.json') : null;
    vaultMtime = p && existsSync(p) ? statSync(p).mtimeMs : vaultMtime;
  } catch { /* ignore */ }
  lastRefresh = Date.now();
}

async function loadRaw() {
  switch (mode) {
    case 'dpapi': return await dpapiLoad();
    case 'keychain': return await keychainLoad();
    case 'secret-service': return await secretServiceLoad();
    case 'file': return fileLoad();
    case 'memory': return null;
  }
  return null;
}

function emptyVault() {
  return { version: 1, activeKeyId: '', keys: [], secrets: {} };
}

function parseVault(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return {
      version: v.version || 1,
      activeKeyId: v.activeKeyId || '',
      keys: Array.isArray(v.keys) ? v.keys : [],
      secrets: v.secrets && typeof v.secrets === 'object' ? v.secrets : {},
    };
  } catch {
    return null;
  }
}

/**
 * Reload the vault from storage if another process (the CLI) changed it.
 * File-backed stores (dpapi/file) reload ONLY when the file's mtime changed —
 * an unchanged vault must never trigger a helper-process spawn, since the
 * detached server runs without a console and every spawn costs a window
 * flash on Windows. External stores without a file (keychain/secret-service)
 * are re-read on a slow cadence instead.
 */
async function maybeRefresh() {
  const now = Date.now();
  if (mode === 'memory' || !vault) return;
  const p = mode === 'dpapi' ? vaultPath('keys.bin') : mode === 'file' ? vaultPath('keys.json') : null;
  if (p) {
    let mtime = vaultMtime;
    try { mtime = statSync(p).mtimeMs; } catch { /* gone */ }
    if (mtime === vaultMtime) return;
  } else if (now - lastRefresh < 5000) {
    return;
  }
  const raw = await loadRaw();
  const fresh = parseVault(raw);
  if (fresh) {
    if (JSON.stringify(vault) !== JSON.stringify(fresh)) vault = fresh;
    // Always sync the observed mtime — even when the content is identical —
    // or a rewrite with unchanged content would force a reload on every call.
    try { if (p) vaultMtime = statSync(p).mtimeMs; } catch { /* ignore */ }
  }
  lastRefresh = now;
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the keyring. Safe to call multiple times.
 * Returns the active storage mode.
 */
export async function initKeyring(opts = {}) {
  if (mode) return mode;

  homeDir = opts.home || process.env.BLITZ_HOME || join(homedir(), '.blitzproxy');
  try {
    mkdirSync(homeDir, { recursive: true });
    chmodSync(homeDir, 0o700);
  } catch { /* best effort */ }

  const forced = opts.mode || process.env.BLITZ_KEYRING;
  if (forced) {
    mode = forced;
  } else if (platform() === 'win32') {
    mode = toolExists('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']) ? 'dpapi' : 'file';
  } else if (platform() === 'darwin') {
    mode = toolExists('security', ['-h']) ? 'keychain' : 'file';
  } else {
    mode = toolExists('secret-tool', ['--help']) ? 'secret-service' : 'file';
  }

  if (mode === 'file') {
    if (!fileWarned) {
      fileWarned = true;
      console.warn('[Keyring] ⚠ OS secure storage unavailable — falling back to a plaintext vault with restrictive permissions.');
      console.warn('[Keyring]   Location: ' + vaultPath('keys.json'));
      console.warn('[Keyring]   This file must never be committed or synced. Reduced security.');
    }
  }

  const raw = await loadRaw();
  vault = parseVault(raw) || emptyVault();
  vaultMtime = (() => {
    try {
      const p = mode === 'dpapi' ? vaultPath('keys.bin') : mode === 'file' ? vaultPath('keys.json') : null;
      return p && existsSync(p) ? statSync(p).mtimeMs : 0;
    } catch { return 0; }
  })();
  lastRefresh = Date.now();
  return mode;
}

export function storageMode() {
  return mode;
}

export function vaultHome() {
  return homeDir;
}

// ─── Key management API ──────────────────────────────────────────────────────

function publicEntry(e, activeId) {
  return {
    id: e.id,
    name: e.name,
    provider: e.provider,
    providerName: e.providerName || e.provider,
    maskedKey: maskKeyWithPrefix(e.key),
    isActive: e.id === activeId,
    model: e.model || '',
    createdAt: e.createdAt,
  };
}

export async function listKeys() {
  await initKeyring();
  await maybeRefresh();
  return vault.keys.map(e => publicEntry(e, vault.activeKeyId));
}

export async function getKeyById(id) {
  await initKeyring();
  await maybeRefresh();
  return vault.keys.find(k => k.id === id) || null;
}

export async function keyCount() {
  await initKeyring();
  await maybeRefresh();
  return vault.keys.length;
}

export async function addKey({ key, provider, name, model }) {
  await initKeyring();
  await maybeRefresh();
  if (!key || typeof key !== 'string') throw new Error('API key is required');

  let resolvedProvider = provider;
  let providerName = '';
  if (!resolvedProvider) {
    const detected = detectProviderFromKey(key);
    if (!detected) {
      resolvedProvider = 'custom';
      providerName = 'Custom';
    } else if (detected.confidence === 'ambiguous') {
      const err = new Error('AMBIGUOUS_PROVIDER');
      err.code = 'AMBIGUOUS_PROVIDER';
      err.candidates = detected.candidates;
      throw err;
    } else {
      resolvedProvider = detected.provider;
      providerName = detected.name;
    }
  }
  if (!providerName) {
    const detected = detectProviderFromKey(key);
    providerName = (detected && detected.name) || resolvedProvider;
  }

  // Idempotent: adding the exact same key for the same provider is a no-op.
  const existingSame = vault.keys.find(
    k => k.provider === resolvedProvider && k.key === key
  );
  if (existingSame) return publicEntry(existingSame, vault.activeKeyId);

  // Multiple keys per provider are allowed — the router rotates through them
  // when one is rejected. Keep names unique so switch/rm stay unambiguous.
  let finalName = name || providerName || resolvedProvider;
  if (vault.keys.some(k => k.name.toLowerCase() === finalName.toLowerCase())) {
    let n = 2;
    while (vault.keys.some(k => k.name.toLowerCase() === `${finalName} #${n}`.toLowerCase())) n++;
    finalName = `${finalName} #${n}`;
  }

  const entry = {
    id: randomBytes(8).toString('hex'),
    name: finalName,
    key,
    provider: resolvedProvider,
    providerName,
    model: model || '',
    createdAt: new Date().toISOString(),
  };

  vault.keys.push(entry);
  if (!vault.activeKeyId) vault.activeKeyId = entry.id;
  await persist();
  return publicEntry(entry, vault.activeKeyId);
}

export async function removeKey(id) {
  await initKeyring();
  await maybeRefresh();
  const idx = vault.keys.findIndex(k => k.id === id);
  if (idx === -1) return false;
  const wasActive = vault.keys[idx].id === vault.activeKeyId;
  vault.keys.splice(idx, 1);
  if (wasActive) {
    vault.activeKeyId = vault.keys.length > 0 ? vault.keys[0].id : '';
  }
  await persist();
  return true;
}

export async function removeProviderKeys(providerId) {
  await initKeyring();
  await maybeRefresh();
  const before = vault.keys.length;
  const removedActive = vault.keys.some(k => k.provider === providerId && k.id === vault.activeKeyId);
  vault.keys = vault.keys.filter(k => k.provider !== providerId);
  if (removedActive) {
    vault.activeKeyId = vault.keys.length > 0 ? vault.keys[0].id : '';
  }
  if (vault.keys.length !== before) {
    await persist();
    return before - vault.keys.length;
  }
  return 0;
}

export async function setActiveKey(id) {
  await initKeyring();
  await maybeRefresh();
  const entry = vault.keys.find(k => k.id === id);
  if (!entry) return null;
  vault.activeKeyId = id;
  await persist();
  return publicEntry(entry, vault.activeKeyId);
}

export async function getActiveKey() {
  await initKeyring();
  await maybeRefresh();
  if (!vault.activeKeyId) return null;
  const entry = vault.keys.find(k => k.id === vault.activeKeyId) || null;
  if (!entry) return null;
  return { ...entry };
}

export async function hasProvider(providerId) {
  await initKeyring();
  await maybeRefresh();
  return vault.keys.some(k => k.provider === providerId);
}

export async function keysForProvider(providerId) {
  await initKeyring();
  await maybeRefresh();
  return vault.keys.filter(k => k.provider === providerId).map(e => publicEntry(e, vault.activeKeyId));
}

// ─── Generic secrets (proxy auth token, etc.) ────────────────────────────────

export async function setSecret(name, value) {
  await initKeyring();
  vault.secrets[name] = value;
  await persist();
}

export async function getSecret(name) {
  await initKeyring();
  await maybeRefresh();
  const v = vault.secrets[name];
  return typeof v === 'string' ? v : null;
}

export async function deleteSecret(name) {
  await initKeyring();
  if (name in vault.secrets) {
    delete vault.secrets[name];
    await persist();
    return true;
  }
  return false;
}

// ─── Legacy migration (config.json plaintext keys → vault) ───────────────────

/**
 * Import v1 plaintext savedKeys from config.json into the secure vault.
 * Preserves entry ids and the active key selection. Returns the number of
 * keys migrated (0 if nothing to do).
 */
export async function importLegacyKeys(savedKeys, activeKeyId) {
  await initKeyring();
  if (!Array.isArray(savedKeys) || savedKeys.length === 0) return 0;

  let migrated = 0;
  for (const k of savedKeys) {
    if (!k || !k.key || !k.provider) continue;
    const exists = vault.keys.some(e => e.id === k.id || (e.provider === k.provider));
    if (exists) continue;
    vault.keys.push({
      id: k.id || randomBytes(8).toString('hex'),
      name: k.name || k.provider,
      key: k.key,
      provider: k.provider,
      providerName: k.providerName || k.provider,
      model: k.model || '',
      createdAt: k.createdAt || new Date().toISOString(),
    });
    migrated++;
  }
  if (activeKeyId && vault.keys.some(e => e.id === activeKeyId)) {
    vault.activeKeyId = activeKeyId;
  } else if (!vault.activeKeyId && vault.keys.length > 0) {
    vault.activeKeyId = vault.keys[0].id;
  }
  if (migrated > 0) await persist();
  return migrated;
}
