// ============================================================================
// BlitzProxy — Configuration Manager (v2)
// - config.json is the non-secret store (no API keys since v2)
// - API keys live in the secure keyring (src/security/keyring.js)
// - .env is honored as INPUT only — secrets are never written back
// - v1 plaintext configs are migrated automatically with a backup
// ============================================================================

import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync, renameSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initKeyring, importLegacyKeys, addKey } from './security/keyring.js';
import { loadPlugins } from './provider-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.BLITZ_CONFIG || join(__dirname, '..', 'config.json');
const ENV_PATH = join(__dirname, '..', '.env');

// ─── Zero-dependency .env loader (input only) ────────────────────────────────

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  try {
    const envContent = readFileSync(filePath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* .env is optional input */ }
}
loadEnvFile(ENV_PATH);

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  version: 2,
  provider: '',
  model: '',
  routing: 'manual',            // 'manual' | 'auto'
  profile: '',                  // '' | coding | fast | free | local | <custom>
  profiles: {},                  // user-defined profiles
  aliases: {},                   // { name: '<provider>/<model>' } — blitz use <alias>
  discoveredModels: {},          // { providerId: { models: [{id, lastSeen}], fetchedAt } }
  fallbackChain: [],             // provider ids tried after the active provider
  fallbackModels: {},            // { providerId: modelId } per-fallback model
  fallbackOnAuthError: false,    // auth failures do NOT failover by default
  fallbackMode: 'enabled',       // 'enabled' | 'strict' — strict: explicit model fails → error, never a silent switch
  contextOptimization: 'safe',  // 'off' | 'safe' | 'aggressive' — context optimizer mode
  proxyPort: 4819,
  host: '127.0.0.1',             // local-first; never 0.0.0.0 by default
  requireAuth: false,            // token required for /v1/* (admin always requires it)
  customBaseUrl: '',
  customHeaders: {},
  customProviders: {},           // user-defined provider definitions
  maxRetries: 3,
  retryBaseDelay: 500,
  logRequests: true,
  logLevel: 'info',
  privacy: false,
  healthTtlMs: 60000,
  timeout: 120000,
};

let currentConfig = { ...DEFAULT_CONFIG };
let configMtime = 0;
let lastStatCheck = 0;

// ─── Load / reload ───────────────────────────────────────────────────────────

function applyEnvOverrides(cfg) {
  if (process.env.PROVIDER) cfg.provider = process.env.PROVIDER.toLowerCase();
  if (process.env.MODEL) cfg.model = process.env.MODEL;
  if (process.env.PROXY_PORT) cfg.proxyPort = parseInt(process.env.PROXY_PORT, 10);
  if (process.env.CUSTOM_BASE_URL) cfg.customBaseUrl = process.env.CUSTOM_BASE_URL;
  if (process.env.LOG_LEVEL) cfg.logLevel = process.env.LOG_LEVEL;
  if (process.env.TIMEOUT) {
    cfg.timeout = parseInt(process.env.TIMEOUT, 10);
    cfg._timeoutSet = true;
  }
  if (process.env.BLITZ_HOST || process.env.HOST) cfg.host = process.env.BLITZ_HOST || process.env.HOST;
  if (process.env.PRIVACY) cfg.privacy = String(process.env.PRIVACY) === 'true' || process.env.PRIVACY === '1';
  return cfg;
}

export function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      currentConfig = { ...DEFAULT_CONFIG, ...fileConfig };
      try { configMtime = statSync(CONFIG_PATH).mtimeMs; } catch { /* ignore */ }
    } catch (e) {
      console.warn('[Config] Failed to parse config.json, using defaults:', e.message);
      currentConfig = { ...DEFAULT_CONFIG };
    }
  }
  applyEnvOverrides(currentConfig);

  if (!currentConfig.provider && !currentConfig.model) {
    // No key anywhere → local default (matches v1 behavior)
  }
  if (!currentConfig.model) {
    currentConfig.model = '';
  }
  return currentConfig;
}

/**
 * Pick up config.json changes made by the CLI (throttled mtime check).
 */
export function refreshConfigIfChanged() {
  const now = Date.now();
  if (now - lastStatCheck < 5000) return currentConfig;
  lastStatCheck = now;
  try {
    if (!existsSync(CONFIG_PATH)) return currentConfig;
    const mtime = statSync(CONFIG_PATH).mtimeMs;
    if (mtime !== configMtime) {
      const savedPrivacy = currentConfig.privacy;
      const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      currentConfig = { ...DEFAULT_CONFIG, ...fileConfig };
      applyEnvOverrides(currentConfig);
      configMtime = mtime;
      if (savedPrivacy !== currentConfig.privacy) {
        console.log(`[Config] privacy mode ${currentConfig.privacy ? 'enabled' : 'disabled'}`);
      }
    }
  } catch { /* keep the in-memory config on read errors */ }
  return currentConfig;
}

export function getConfig() {
  return { ...currentConfig };
}

export function getConfigRaw() {
  return currentConfig;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

const SECRET_FIELDS = ['apiKey', 'savedKeys', 'autoDetected', '_timeoutSet'];

/**
 * Save config updates to config.json.
 * Secret fields are never persisted — keys live in the keyring only.
 */
export function saveConfig(updates = {}) {
  const merged = { ...currentConfig, ...updates };
  const persisted = {};
  for (const [k, v] of Object.entries(merged)) {
    if (SECRET_FIELDS.includes(k)) continue;
    if (k.startsWith('_')) continue;
    persisted[k] = v;
  }
  currentConfig = merged;

  try {
    const tmp = CONFIG_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf-8');
    try { chmodSync(tmp, 0o600); } catch { /* Windows: ACLs apply */ }
    renameSync(tmp, CONFIG_PATH);
    configMtime = statSync(CONFIG_PATH).mtimeMs;
  } catch (e) {
    console.error('[Config] Failed to save config.json:', e.message);
  }
  return currentConfig;
}

// ─── Migration (v1 plaintext → v2 secure) ─────────────────────────────────────

/**
 * One-shot migration of v1 configs:
 *   - savedKeys + apiKey move into the secure keyring
 *   - original config.json backed up with restrictive permissions
 *   - .env keeps working as input, but is no longer written by BlitzProxy
 * Returns { migrated, backupPath }.
 */
async function migrateV1IfNeeded() {
  const legacyKeys = currentConfig.savedKeys;
  const legacyActive = currentConfig.activeKeyId;
  const legacyApiKey = currentConfig.apiKey;

  let migrated = 0;
  let backupPath = null;

  if (Array.isArray(legacyKeys) && legacyKeys.length > 0) {
    migrated = await importLegacyKeys(legacyKeys, legacyActive);
    try {
      backupPath = CONFIG_PATH + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(CONFIG_PATH, backupPath);
      try { chmodSync(backupPath, 0o600); } catch { /* best effort */ }
    } catch { /* backup is best-effort */ }
    console.log(`[Config] ✅ Migrated ${migrated} API key(s) to secure storage.`);
    if (backupPath) console.log(`[Config] Plaintext backup (keep private or delete): ${backupPath}`);
  } else if (typeof legacyApiKey === 'string' && legacyApiKey && !legacyKeys) {
    // Single-key v1 setup without savedKeys
    try {
      await addKey({ key: legacyApiKey, provider: currentConfig.provider || undefined });
      migrated = 1;
      console.log('[Config] ✅ Migrated API key from config to secure storage.');
    } catch { /* ambiguous or invalid — leave it in env */ }
  }

  if (migrated > 0 || currentConfig.savedKeys !== undefined || currentConfig.apiKey !== undefined) {
    // Strip secret fields from config.json
    const updates = {};
    for (const k of SECRET_FIELDS) {
      if (k in currentConfig && k !== '_timeoutSet') updates[k] = undefined;
    }
    if ('activeKeyId' in currentConfig) updates.activeKeyId = undefined;
    updates.version = 2;
    const merged = { ...currentConfig };
    for (const k of Object.keys(updates)) delete merged[k];
    merged.version = 2;
    const persisted = {};
    for (const [k, v] of Object.entries(merged)) {
      if (k.startsWith('_')) continue;
      persisted[k] = v;
    }
    currentConfig = merged;
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2), 'utf-8');
      configMtime = statSync(CONFIG_PATH).mtimeMs;
    } catch (e) {
      console.error('[Config] Failed to rewrite config.json:', e.message);
    }
  }

  // First run with no vault at all: adopt API_KEY from environment/.env input
  const { keyCount } = await import('./security/keyring.js');
  if ((await keyCount()) === 0 && process.env.API_KEY) {
    try {
      await addKey({ key: process.env.API_KEY });
      console.log('[Config] ✅ Imported API key from .env/environment into secure storage.');
    } catch (err) {
      if (err.code !== 'AMBIGUOUS_PROVIDER') {
        console.warn('[Config] Could not import API_KEY from environment:', err.message);
      }
    }
  }

  return { migrated, backupPath };
}

// ─── App initialization ──────────────────────────────────────────────────────

/**
 * Full initialization: config load → plugins → keyring → v1 migration.
 * Used by the server and the CLI.
 */
export async function initApp() {
  loadConfig();
  const projectDir = join(__dirname, '..');
  const home = process.env.BLITZ_HOME || null;
  const plugins = await loadPlugins(projectDir, home);
  const mode = await initKeyring();
  const migration = await migrateV1IfNeeded();
  return { config: getConfig(), keyringMode: mode, plugins, migration };
}

export { initKeyring };
