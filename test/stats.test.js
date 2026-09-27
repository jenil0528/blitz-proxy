// ============================================================================
// BlitzProxy — Unit Tests: Stats & Cost Tracking
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStats, recordRequest } from '../src/stats.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nstats + cost');

const home = mkdtempSync(join(tmpdir(), 'blitz-stats-test-'));

test('record accumulates per-provider aggregates', () => {
  const stats = createStats({ home });
  recordRequest(stats, { providerId: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', ok: true, status: 200, latencyMs: 100, inputTokens: 1000, outputTokens: 200 });
  recordRequest(stats, { providerId: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', ok: true, status: 200, latencyMs: 300, inputTokens: 500, outputTokens: 100 });
  recordRequest(stats, { providerId: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', ok: false, status: 429, latencyMs: 50, rateLimited: true });
  recordRequest(stats, { providerId: 'groq', model: 'llama-3.3-70b-versatile', ok: true, status: 200, latencyMs: 40, inputTokens: 10, outputTokens: 5, fallbackTo: 'groq' });

  const rows = stats.getSummary({ scope: 'today' });
  const nvidia = rows.find(r => r.providerId === 'nvidia');
  assert.equal(nvidia.requests, 3);
  assert.equal(nvidia.ok, 2);
  assert.equal(nvidia.fail, 1);
  assert.equal(nvidia.rateLimited, 1);
  assert.equal(nvidia.avgLatencyMs, 150);
  assert.equal(nvidia.inputTokens, 1500);
  assert.equal(nvidia.outputTokens, 300);
  assert.equal(nvidia.costUsd, 0, 'free-tier pricing estimate is 0');

  const groq = rows.find(r => r.providerId === 'groq');
  assert.equal(groq.fallbacks, 1);
});

test('estimated cost uses catalog pricing (labeled estimate, n/a when unknown)', () => {
  const stats = createStats({ home: mkdtempSync(join(tmpdir(), 'blitz-stats-2-')) });
  recordRequest(stats, { providerId: 'deepseek', model: 'deepseek-chat', ok: true, status: 200, latencyMs: 10, inputTokens: 1_000_000, outputTokens: 1_000_000 });
  recordRequest(stats, { providerId: 'openai', model: 'gpt-4o', ok: true, status: 200, latencyMs: 10, inputTokens: 1000, outputTokens: 1000 });
  const rows = stats.getSummary({ scope: 'today' });
  const deepseek = rows.find(r => r.providerId === 'deepseek');
  const openai = rows.find(r => r.providerId === 'openai');
  assert.ok(Math.abs(deepseek.costUsd - 1.37) < 0.001, `expected ≈1.37, got ${deepseek.costUsd}`);
  assert.equal(openai.costUsd, null, 'unknown/dynamic pricing must be n/a, never guessed');
});

test('failed requests do not add cost', () => {
  const stats = createStats({ home: mkdtempSync(join(tmpdir(), 'blitz-stats-3-')) });
  recordRequest(stats, { providerId: 'deepseek', model: 'deepseek-chat', ok: false, status: 500, latencyMs: 5 });
  const rows = stats.getSummary({ scope: 'today' });
  assert.equal(rows[0].costUsd, null);
});

test('flush persists to disk; privacy mode never writes', () => {
  const homeA = mkdtempSync(join(tmpdir(), 'blitz-stats-4-'));
  const statsA = createStats({ home: homeA });
  recordRequest(statsA, { providerId: 'nvidia', model: 'm', ok: true, status: 200, latencyMs: 1, inputTokens: 1, outputTokens: 1 });
  statsA.flush();
  assert.ok(existsSync(join(homeA, 'stats.json')), 'stats.json must be written after flush');

  const homeB = mkdtempSync(join(tmpdir(), 'blitz-stats-5-'));
  const statsB = createStats({ home: homeB, privacy: true });
  recordRequest(statsB, { providerId: 'nvidia', model: 'm', ok: true, status: 200, latencyMs: 1, inputTokens: 1, outputTokens: 1 });
  statsB.flush();
  assert.ok(!existsSync(join(homeB, 'stats.json')), 'privacy mode must not persist stats');

  // In-memory summary still works in privacy mode
  const rows = statsB.getSummary({ scope: 'today' });
  assert.equal(rows[0].requests, 1);
});

test('stats contain no prompt or response material', () => {
  const homeC = mkdtempSync(join(tmpdir(), 'blitz-stats-6-'));
  const stats = createStats({ home: homeC });
  recordRequest(stats, { providerId: 'nvidia', model: 'm', ok: true, status: 200, latencyMs: 1, inputTokens: 5, outputTokens: 2 });
  stats.flush();
  const raw = readFileSync(join(homeC, 'stats.json'), 'utf-8');
  assert.ok(!raw.includes('messages'), 'stats must not store message content');
  assert.ok(!raw.includes('prompt'), 'stats must not store prompts');
});

test('clear wipes aggregated data', () => {
  const homeD = mkdtempSync(join(tmpdir(), 'blitz-stats-7-'));
  const stats = createStats({ home: homeD });
  recordRequest(stats, { providerId: 'nvidia', model: 'm', ok: true, status: 200, latencyMs: 1, inputTokens: 1, outputTokens: 1 });
  stats.clear();
  assert.equal(stats.getSummary({ scope: 'today' }).length, 0);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
