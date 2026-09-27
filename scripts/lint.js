#!/usr/bin/env node
// ============================================================================
// BlitzProxy — Syntax Lint (zero-dependency)
// Runs `node --check` over every JS source file. Catches syntax errors
// before CI/test runs without adding a linter dependency.
// ============================================================================

import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'providers']);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectJsFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = collectJsFiles(root);
let failed = 0;

for (const file of files) {
  // node --check honors package.json "type": "module" for ESM syntax
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim().split('\n').slice(0, 6).join('\n');
    console.error(`✗ ${relative(root, file)}\n${msg}\n`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check.\n`);
  process.exit(1);
}
console.log(`${files.length} files — all syntax checks passed.`);
