// ============================================================================
// BlitzProxy — Unit Tests: Provider Catalog & Detection
// ============================================================================

import assert from 'node:assert/strict';
import {
  PROVIDERS, PROVIDER_PRIORITY, getProvider, listProviderKeys,
  detectProviderFromKey, findModelInfo, bestModelFor, providerCanSatisfy,
  estimateRequestCost, providerModelIds,
} from '../src/providers.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nprovider catalog');

test('every provider has required fields', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.name, `${id} missing name`);
    assert.ok(typeof p.timeout === 'number' && p.timeout > 0, `${id} bad timeout`);
    if (id !== 'custom') assert.ok(p.baseUrl?.startsWith('http'), `${id} missing baseUrl`);
    assert.ok(p.api === 'openai-compat', `${id} unexpected api type`);
  }
});

test('key prefix detection (unambiguous, longest-first)', () => {
  assert.deepEqual(detectProviderFromKey('nvapi-abc'), { provider: 'nvidia', name: 'NVIDIA NIM', confidence: 'prefix' });
  assert.equal(detectProviderFromKey('gsk_xyz').provider, 'groq');
  assert.equal(detectProviderFromKey('sk-or-v1-xyz').provider, 'openrouter');
  assert.equal(detectProviderFromKey('csk-xyz').provider, 'cerebras');
  assert.equal(detectProviderFromKey('github_pat_xyz').provider, 'github');
  assert.equal(detectProviderFromKey('hf_xyz').provider, 'huggingface');
  assert.equal(detectProviderFromKey('xai-xyz').provider, 'xai');
  assert.equal(detectProviderFromKey('AIzaSyXYZ').provider, 'gemini');
});

test('sk- prefix is flagged ambiguous with candidates', () => {
  const d = detectProviderFromKey('sk-something123');
  assert.equal(d.confidence, 'ambiguous');
  assert.ok(d.candidates.length >= 2);
  const providerIds = d.candidates.map(c => c.provider);
  assert.ok(providerIds.includes('deepseek'));
  assert.ok(providerIds.includes('openai'));
});

test('unknown key format returns null (never guessed)', () => {
  assert.equal(detectProviderFromKey('totally-unknown-format'), null);
});

test('ollama/no-key sentinel', () => {
  assert.equal(detectProviderFromKey('').provider, 'ollama');
  assert.equal(detectProviderFromKey('ollama').provider, 'ollama');
});

test('a prefix is not a validity claim — detect only ever returns metadata', () => {
  const d = detectProviderFromKey('nvapi-fake');
  assert.ok(!('valid' in d), 'detection must never claim validity');
});

test('getProvider falls back to custom', () => {
  assert.equal(getProvider('nvidia').id, 'nvidia');
  assert.equal(getProvider('does-not-exist').id, 'custom');
  assert.deepEqual(listProviderKeys().includes('nvidia'), true);
});

test('findModelInfo returns metadata or null', () => {
  const info = findModelInfo('nvidia', 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(info.tools, true);
  assert.equal(findModelInfo('nvidia', 'no/such-model'), null);
  assert.equal(findModelInfo('custom', 'anything'), null);
});

test('bestModelFor prefers tool-capable coding models when tools are needed', () => {
  const m = bestModelFor('nvidia', { tools: true });
  const info = findModelInfo('nvidia', m);
  assert.ok(info.tools, 'best model must support tools');
});

test('bestModelFor prefers vision models for image requests', () => {
  const m = bestModelFor('openrouter', { vision: true });
  const info = findModelInfo('openrouter', m);
  assert.ok(info.vision, `expected vision model, got ${m}`);
});

test('providerCanSatisfy filters providers without capable models', () => {
  assert.equal(providerCanSatisfy('nvidia', { tools: true }), true);
  assert.equal(providerCanSatisfy('custom', { tools: true }), true); // unknown → permissive
});

test('pricing is estimate-only: unknown pricing returns null, never invented', () => {
  assert.equal(estimateRequestCost('nvidia', 'nvidia/nemotron-3-super-120b-a12b', 1000, 1000), 0);
  assert.equal(estimateRequestCost('nvidia', 'unknown/model', 1000, 1000), null);
  assert.equal(estimateRequestCost('deepseek', 'deepseek-chat', 1_000_000, 1_000_000), 0.27 + 1.10);
  assert.equal(estimateRequestCost('openai', 'gpt-4o', 1000, 1000), null, 'dynamic pricing must not be guessed');
});

test('priority list covers all providers', () => {
  for (const id of listProviderKeys()) {
    assert.ok(PROVIDER_PRIORITY.includes(id), `${id} missing from priority list`);
  }
});

test('every catalog model has capability metadata', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    for (const [mid, m] of Object.entries(p.models || {})) {
      assert.ok(typeof m.tools === 'boolean', `${id}/${mid} missing tools flag`);
      assert.ok(typeof m.vision === 'boolean', `${id}/${mid} missing vision flag`);
      assert.ok(typeof m.reasoning === 'boolean', `${id}/${mid} missing reasoning flag`);
    }
  }
});

test('defaultModel exists in its provider catalog', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === 'custom') continue;
    assert.ok(p.models[p.defaultModel], `${id} defaultModel ${p.defaultModel} not in catalog`);
  }
});

test('providerModelIds lists model ids', () => {
  const ids = providerModelIds('groq');
  assert.ok(ids.includes('llama-3.3-70b-versatile'));
  assert.deepEqual(providerModelIds('nope'), []);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
