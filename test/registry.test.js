// ============================================================================
// BlitzProxy — Unit Tests: Model Discovery Cache & Aliases
// ============================================================================

import assert from 'node:assert/strict';
import { mergeDiscovered, discoveredList, newDiscoveredIds } from '../src/models-cache.js';
import { resolveAlias, listAliases, validateAliasValue, ALIAS_RE } from '../src/aliases.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nmodels cache');

test('mergeDiscovered records ids with lastSeen and dedupes', () => {
  const cfg = {};
  const out = mergeDiscovered(cfg, 'nvidia', ['a', 'b', 'a', '']);
  assert.equal(out.nvidia.models.length, 2);
  assert.deepEqual(out.nvidia.models.map(m => m.id), ['a', 'b']);
  assert.ok(out.nvidia.models[0].lastSeen);
  assert.equal(cfg.discoveredModels, undefined, 'pure function — input untouched');
});

test('mergeDisformed: re-refresh updates lastSeen without duplicating', () => {
  let cfg = mergeDiscovered({}, 'nvidia', ['a', 'b']);
  const firstSeen = cfg.nvidia.models[0].lastSeen;
  cfg = mergeDiscovered(cfg, 'nvidia', ['a', 'b', 'c']);
  assert.equal(cfg.nvidia.models.length, 3);
  assert.equal(cfg.nvidia.models.find(m => m.id === 'a').lastSeen >= firstSeen, true);
});

test('mergeDiscovered preserves explicit metadata, never invents capabilities', () => {
  const seeded = { nvidia: { models: [{ id: 'a', tools: true, lastSeen: 'old' }], fetchedAt: 'old' } };
  const out = mergeDiscovered(seeded, 'nvidia', ['a', 'new']);
  const a = out.nvidia.models.find(m => m.id === 'a');
  assert.equal(a.tools, true, 'explicit metadata survives');
  const fresh = out.nvidia.models.find(m => m.id === 'new');
  assert.equal(fresh.tools, undefined, 'discovered models carry no fabricated caps');
  assert.equal('reasoning' in fresh, false);
});

test('discovered models that disappear upstream are dropped from the cache', () => {
  let section = mergeDiscovered({}, 'nvidia', ['a', 'b']);
  section = mergeDiscovered(section, 'nvidia', ['a']);
  assert.deepEqual(section.nvidia.models.map(m => m.id), ['a']);
});

test('newDiscoveredIds excludes catalog ids', () => {
  const section = mergeDiscovered({}, 'mocka', ['mock/model-a', 'mock/new']);
  const ids = newDiscoveredIds(section, 'mocka', ['mock/model-a']);
  assert.deepEqual(ids, ['mock/new']);
});

test('discoveredList tolerates missing config sections', () => {
  assert.deepEqual(discoveredList({}, 'nvidia'), []);
  assert.deepEqual(discoveredList({ nvidia: {} }, 'nvidia'), []);
});

console.log('\naliases');

test('ALIAS_RE accepts short lowercase names only', () => {
  assert.equal(ALIAS_RE.test('coding'), true);
  assert.equal(ALIAS_RE.test('fast-2'), true);
  assert.equal(ALIAS_RE.test('Coding'), false);
  assert.equal(ALIAS_RE.test('1x'), false);
  assert.equal(ALIAS_RE.test('has space'), false);
  assert.equal(ALIAS_RE.test('a'.repeat(40)), false);
});

test('validateAliasValue requires a known provider/model pair', () => {
  assert.equal(validateAliasValue('nvidia/z-ai/glm-5.3', ['nvidia', 'groq']), null);
  assert.ok(validateAliasValue('nosuch/model', ['nvidia']).includes('not a known provider'));
  assert.ok(validateAliasValue('nvidia', ['nvidia']).includes('<provider>/<model>'));
  assert.ok(validateAliasValue('nvidia/', ['nvidia']).includes('<provider>/<model>'));
});

test('resolveAlias returns the provider/model pair or null', () => {
  const cfg = { aliases: { coding: 'nvidia/z-ai/glm-5.3' } };
  assert.equal(resolveAlias(cfg, 'coding'), 'nvidia/z-ai/glm-5.3');
  assert.equal(resolveAlias(cfg, 'missing'), null);
  assert.equal(resolveAlias(cfg, undefined), null);
});

test('listAliases enumerates user aliases', () => {
  const cfg = { aliases: { coding: 'nvidia/z-ai/glm-5.3', fast: 'groq/llama-3.3-70b-versatile' } };
  const all = listAliases(cfg);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(a => a.name), ['coding', 'fast']);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
