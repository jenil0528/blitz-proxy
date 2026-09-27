// ============================================================================
// BlitzProxy — Server Launcher
// Initializes config, keyring, plugins, stats and the proxy token,
// then listens on host:port (127.0.0.1 by default).
// Run directly:  node server.js
// ============================================================================

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { initApp, getConfig } from './src/config.js';
import * as keyring from './src/security/keyring.js';
import { resolveActiveProvider } from './src/routing/router.js';
import { createProxyServer } from './src/server.js';
import { createStats } from './src/stats.js';
import { getProxyToken } from './src/security/auth.js';
import * as log from './src/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(process.env.BLITZ_HOME || join(homedir(), '.blitzproxy'), 'blitz.pid');

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

async function main() {
  const { keyringMode } = await initApp();
  process.env.BLITZ_VERSION = VERSION;

  const cfg = getConfig();
  log.setLogLevel(cfg.logLevel);

  const home = process.env.BLITZ_HOME || join(homedir(), '.blitzproxy');
  const stats = createStats({ home, privacy: cfg.privacy === true });
  const token = await getProxyToken(keyring);
  const active = await resolveActiveProvider(cfg, keyring);

  const server = createProxyServer({ keyring, stats, token });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  ✕ Port ${cfg.proxyPort} is already in use.`);
      console.error('    BlitzProxy is likely already running — try: blitz status');
      console.error('    Or stop it first: blitz stop');
      console.error('    Or change the port: blitz config set proxyPort <port>');
      process.exit(1);
    }
    console.error('[Server] Fatal error:', err.message);
    process.exit(1);
  });

  server.listen(cfg.proxyPort, cfg.host, () => {
    const keyringLabel = keyringMode === 'file' ? `${keyringMode} (⚠ plaintext fallback)` : keyringMode;
    log.banner([
      `${'\x1b[1m'}⚡ BlitzProxy v${VERSION}${'\x1b[0m'}  —  Local AI Provider Gateway`,
      '',
      `  Listen:    ${'\x1b[33m'}http://${cfg.host}:${cfg.proxyPort}${'\x1b[0m'}`,
      `  Provider:  ${'\x1b[32m'}${active.def?.name || active.providerId}${'\x1b[0m'}${active.model ? `  •  ${active.model}` : ''}`,
      `  Routing:   ${cfg.profile ? 'profile:' + cfg.profile : cfg.routing}${cfg.fallbackChain?.length ? '  •  fallback: ' + cfg.fallbackChain.join(' → ') : ''}`,
      `  Keyring:   ${keyringLabel}`,
      `  Auth:      /v1 ${cfg.requireAuth ? 'token required' : 'open (localhost only)'}  •  /admin + /dashboard: token required`,
      `  Privacy:   ${cfg.privacy ? 'ON — request logging disabled' : 'off — aggregate logs only, no prompts'}`,
      '',
      `  ${'\x1b[2m'}Claude Code: blitz run claude   •   Dashboard: blitz dashboard${'\x1b[0m'}`,
    ]);

    try {
      writeFileSync(PID_FILE, String(process.pid), 'utf-8');
    } catch { /* PID file is best-effort */ }
  });

  function shutdown(signal) {
    log.info(`Received ${signal} — shutting down...`);
    stats.flush();
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[Server] Startup failed:', err.message);
  process.exit(1);
});
