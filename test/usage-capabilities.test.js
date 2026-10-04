// ============================================================================
// BLITZ — Tests: Normalized Usage, Capability Registry, Context Modes
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'blitz-usage-test-'));
process.env.BLITZ_HOME = home;

const { normalizeUsage } = await import('../src/usage.js');
const { getCapabilities, validateCapabilities, capabilityMark, formatTokens } = await import('../src/model-capabilities.js');
const { optimizeContext, resolveModeOptions, CONTEXT_MODES } = await import('../src/context-optimizer.js');
const { createStats } = await import('../src/stats.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nnormalized usage');

test('OpenAI shape with cached + reasoning tokens', () => {
  const u = normalizeUsage({ openai: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 } } });
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 40);
  assert.equal(u.cachedInputTokens, 60);
  assert.equal(u.reasoningTokens, 12);
  assert.equal(u.totalTokens, 140);
  assert.equal(u.estimated, false);
  assert.equal(u.source, 'provider-usage');
});

test('Anthropic shape: cache reads + writes count as cached', () => {
  const u = normalizeUsage({ anthropic: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } });
  assert.equal(u.inputTokens, 50);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cachedInputTokens, 10);
  assert.equal(u.reasoningTokens, 0);
  assert.equal(u.estimated, false);
});

test('missing provider usage → clearly-marked estimate, never exact', () => {
  const u = normalizeUsage({ estimatedInputTokens: 1234, estimatedOutputTokens: 56 });
  assert.equal(u.estimated, true);
  assert.equal(u.source, 'estimate');
  assert.equal(u.totalTokens, 1290);
  assert.equal(u.cachedInputTokens, 0);
});

test('no usage and no estimates → null (never invented)', () => {
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ openai: { foo: 1 } }), null);
});

console.log('\ncapability registry');

test('catalog model: declared capabilities are known, undeclared are UNKNOWN', () => {
  const caps = getCapabilities('nvidia', 'z-ai/glm-5.3', {});
  assert.equal(caps.tools, true, 'declared in catalog');
  assert.equal(caps.vision, false, 'declared false');
  assert.equal(caps.structuredOutput, null, 'not declared → UNKNOWN');
  assert.equal(caps.promptCaching, null, 'UNKNOWN, never assumed');
  assert.equal(caps.chat, true);
  assert.equal(caps.streaming, true, 'protocol-level');
  assert.equal(caps.known, true);
});

test('unknown model: everything model-level is UNKNOWN — never supported', () => {
  const caps = getCapabilities('nvidia', 'no/such-model', {});
  assert.equal(caps.known, false);
  assert.equal(caps.tools, null);
  assert.equal(caps.vision, null);
  assert.equal(capabilityMark(caps.tools), '?');
});

test('validateCapabilities: known-false mismatches, UNKNOWN passes', () => {
  const caps = getCapabilities('nvidia', 'meta/codellama-70b', {});
  assert.equal(caps.tools, false);
  const bad = validateCapabilities({ tools: true }, caps);
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches[0].capability, 'tools');

  const unknownModel = getCapabilities('nvidia', 'brand/new-model', {});
  const ok = validateCapabilities({ tools: true }, unknownModel);
  assert.equal(ok.ok, true, 'UNKNOWN capabilities never reject a request');
  assert.ok(ok.unknown.includes('tools'));

  const good = validateCapabilities({ tools: true }, getCapabilities('nvidia', 'z-ai/glm-5.3', {}));
  assert.equal(good.ok, true);
});

test('validateCapabilities: context window overflow is a mismatch', () => {
  const caps = getCapabilities('groq', 'gemma2-9b-it', {});
  const r = validateCapabilities({ estTokens: 999999 }, caps);
  assert.equal(r.ok, false);
  assert.ok(r.mismatches[0].reason.includes('exceeds'));
});

test('formatTokens renders limits, null stays UNKNOWN', () => {
  assert.equal(formatTokens(131072), '128K');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(null), 'UNKNOWN');
});

console.log('\ncontext modes');

test('five modes exist', () => {
  assert.deepEqual(CONTEXT_MODES, ['off', 'safe', 'balanced', 'aggressive', 'custom']);
});

test('BALANCED collapses duplicate old blocks; SAFE does not', () => {
  const big = 'IDENTICAL BUILD OUTPUT\n' + 'line\n'.repeat(300);
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    ...Array.from({ length: 8 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const safe = optimizeContext({ messages }, { mode: 'safe' });
  const balanced = optimizeContext({ messages }, { mode: 'balanced' });
  assert.ok(safe.messages[2].content[0].text.includes('IDENTICAL BUILD OUTPUT'), 'SAFE keeps both');
  assert.ok(balanced.messages[2].content[0].text.includes('duplicate of an earlier output block'), 'BALANCED collapses the later copy');
});

test('CUSTOM honors per-operation flags (duplicates off → no collapse)', () => {
  const noisy = Array.from({ length: 300 }, () => 'repeated noise line').join('\n');
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: noisy }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const off = optimizeContext({ messages }, { mode: 'custom', custom: { duplicates: false, blankWalls: false } });
  assert.ok(off.messages[0].content[0].text.includes('repeated noise line\nrepeated noise line'),
    'duplicate collapse disabled — content preserved verbatim');
  const on = optimizeContext({ messages }, { mode: 'custom', custom: {} });
  assert.ok(on.messages[0].content[0].text.includes('[+299 duplicate lines collapsed]'));
});

test('CUSTOM recency override protects more history when requested', () => {
  const noisy = Array.from({ length: 300 }, () => 'x'.repeat(20) + ' unique tail').join('\n');
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: noisy }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const protected_ = optimizeContext({ messages }, { mode: 'custom', custom: { recency: 7 } });
  assert.equal(protected_.stats.messagesTouched, 0, 'all messages inside the protected window');
});

test('stats report the operations performed', () => {
  const noisy = '\x1b[32mok\x1b[0m\n' + Array.from({ length: 300 }, () => 'same').join('\n');
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: noisy }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'safe' });
  assert.ok(out.stats.operations.includes('ansi-strip'));
  assert.ok(out.stats.operations.includes('duplicate-line-collapse'));
  assert.equal(out.stats.criticalRemoved, 0);
});

test('resolveModeOptions: unknown mode falls back to SAFE', () => {
  assert.equal(resolveModeOptions('bogus').recency, 6);
});

console.log('\nusage stats (new dimensions)');

test('stats record + getUsage: cached/reasoning/estimated/contextSaved + per-model rows', () => {
  const stats = createStats({ home: join(home, 's1'), privacy: true });
  // simulate a real recording path via record()
  stats.record('nvidia', {
    ok: true, model: 'z-ai/glm-5.3', latencyMs: 100,
    inputTokens: 100, outputTokens: 40, cachedTokens: 60, reasoningTokens: 12,
    contextSavedTokens: 500, estimated: false,
  });
  stats.record('nvidia', { ok: true, model: 'kimi/k2.5', inputTokens: 10, outputTokens: 5, estimated: true });
  const u = stats.getUsage({ scope: 'today' });
  const nvidia = u.providers.find(r => r.providerId === 'nvidia');
  assert.equal(nvidia.inputTokens, 110);
  assert.equal(nvidia.cachedTokens, 60);
  assert.equal(nvidia.reasoningTokens, 12);
  assert.equal(nvidia.contextSavedTokens, 500);
  assert.equal(nvidia.estimatedRequests, 1, 'estimates counted separately — never mixed into exact');
  assert.equal(u.models.length, 2, 'per-model rows across the provider');
  const glm = u.models.find(m => m.model === 'z-ai/glm-5.3');
  assert.equal(glm.contextSavedTokens, 500);
  // backward compatibility: getSummary still returns an array of provider rows
  const rows = stats.getSummary({ scope: 'today' });
  assert.ok(Array.isArray(rows));
  assert.equal(rows[0].providerId, 'nvidia');
});

test('month scope aggregates only the current month', () => {
  const stats = createStats({ home: join(home, 's2'), privacy: true });
  stats.record('nvidia', { ok: true, inputTokens: 1 });
  const u = stats.getUsage({ scope: 'month' });
  assert.equal(u.providers[0].inputTokens, 1);
});

console.log('\nagent attribution');

test('detectAgentFromUserAgent recognizes known clients, never guesses', async () => {
  const { detectAgentFromUserAgent } = await import('../src/usage.js');
  assert.equal(detectAgentFromUserAgent('claude-cli/1.0.44 (external, cli)'), 'Claude Code');
  assert.equal(detectAgentFromUserAgent('claude-code/2.0'), 'Claude Code');
  assert.equal(detectAgentFromUserAgent('opencode/0.5.2'), 'OpenCode');
  assert.equal(detectAgentFromUserAgent('codex_cli_rs/0.1.41'), 'Codex CLI');
  assert.equal(detectAgentFromUserAgent('aider 0.63.1'), 'Aider');
  assert.equal(detectAgentFromUserAgent('some-random-tool/1.0'), 'other');
  assert.equal(detectAgentFromUserAgent(''), 'unknown');
  assert.equal(detectAgentFromUserAgent(undefined), 'unknown');
});

test('stats track usage by agent (User-Agent attribution)', () => {
  const stats = createStats({ home: join(home, 's3'), privacy: true });
  stats.record('nvidia', { ok: true, model: 'z-ai/glm-5.3', agent: 'Claude Code', inputTokens: 100, outputTokens: 40, contextSavedTokens: 500 });
  stats.record('nvidia', { ok: true, model: 'z-ai/glm-5.3', agent: 'OpenCode', inputTokens: 30, outputTokens: 10 });
  const u = stats.getUsage({ scope: 'today' });
  const cc = u.agents.find(a => a.agent === 'Claude Code');
  assert.equal(cc.requests, 1);
  assert.equal(cc.inputTokens, 100);
  assert.equal(cc.contextSavedTokens, 500);
  const oc = u.agents.find(a => a.agent === 'OpenCode');
  assert.equal(oc.outputTokens, 10);
  assert.equal(u.agents.length, 2);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
