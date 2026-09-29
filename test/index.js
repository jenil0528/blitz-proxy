// ============================================================================
// BlitzProxy — Test Runner
// Runs all test suites in isolated processes: node test/index.js  (npm test)
// ============================================================================

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
  'mask.test.js',
  'providers.test.js',
  'fallback.test.js',
  'routing.test.js',
  'stats.test.js',
  'translator.test.js',
  'stream.test.js',
  'responses.test.js',
  'keyring.test.js',
  'config.test.js',
  'router.test.js',
  'adapter.test.js',
  'credentials.test.js',
  'validate.test.js',
  'registry.test.js',
  'server.test.js',
];

let overallFailed = 0;

for (const suite of suites) {
  console.log(`\n━━━ ${suite} ━━━`);
  const result = spawnSync(process.execPath, [join(__dirname, suite)], {
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1', BLITZ_KEYRING: process.env.BLITZ_KEYRING || 'memory' },
  });
  if (result.status !== 0) overallFailed++;
}

if (overallFailed > 0) {
  console.error(`\n${overallFailed} suite(s) failed.\n`);
  process.exit(1);
} else {
  console.log(`\nAll ${suites.length} test suites passed.\n`);
}
