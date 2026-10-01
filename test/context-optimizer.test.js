// ============================================================================
// BLITZ — Context Optimizer Tests (adversarial safety cases)
//
// These tests PROVE the optimizer's guarantees:
//   - instructions survive no matter how old they are
//   - security constraints survive
//   - errors survive inside huge logs
//   - tool_use / thinking / images are never touched
//   - recency window is never touched
//   - OFF mode is a byte-identical identity
//   - information is compressed with markers, never deleted
// ============================================================================

import assert from 'node:assert/strict';
import { optimizeContext, stripAnsi, CONTEXT_MODES } from '../src/context-optimizer.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\ncontext optimizer — adversarial safety');

test('modes are exactly off | safe | aggressive', () => {
  assert.deepEqual(CONTEXT_MODES, ['off', 'safe', 'aggressive']);
});

test('OFF mode is a byte-identical identity', () => {
  const req = {
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'Use PostgreSQL.' },
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      { role: 'user', content: 'go' },
    ],
  };
  const out = optimizeContext(req, { mode: 'off' });
  assert.equal(out.stats, null);
  assert.strictEqual(out.messages, req.messages, 'same reference — untouched');
  assert.strictEqual(out.system, req.system);
});

test('the original request object is NEVER mutated', () => {
  const big = Array.from({ length: 200 }, () => 'npm WARN deprecated something.foo@1.2.3').join('\n');
  const req = {
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: big }] },
      { role: 'user', content: 'next' },
    ],
  };
  const before = JSON.stringify(req);
  optimizeContext(req, { mode: 'aggressive' });
  assert.equal(JSON.stringify(req), before, 'pure function — input untouched');
});

test('USER TEXT is never modified — instruction 20 messages back survives', () => {
  const messages = [];
  for (let i = 0; i < 25; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `step ${i} ` + 'filler '.repeat(80) }] });
    messages.push({ role: 'user', content: `Use PostgreSQL. (reminder ${i})` });
  }
  const out = optimizeContext({ messages }, { mode: 'aggressive' });
  const userTexts = out.messages.filter(m => m.role === 'user').map(m => m.content);
  for (let i = 0; i < 25; i++) {
    assert.equal(userTexts[i], `Use PostgreSQL. (reminder ${i})`, `user message ${i} must be byte-identical`);
  }
});

test('security constraints in old user messages survive', () => {
  const messages = [
    { role: 'user', content: 'Never expose API keys. Never commit secrets.' },
    ...Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `log ${i}\n` + 'noise '.repeat(300) }] })),
    { role: 'user', content: 'continue' },
  ];
  const out = optimizeContext({ messages }, { mode: 'aggressive' });
  assert.equal(out.messages[0].content, 'Never expose API keys. Never commit secrets.');
});

test('system prompt is never touched', () => {
  const system = 'You are a careful engineer. Follow the architecture decisions.';
  const out = optimizeContext({
    system,
    messages: [{ role: 'user', content: 'hi' }],
  }, { mode: 'aggressive' });
  assert.strictEqual(out.system, system);
});

test('compiler errors inside a huge log are preserved verbatim', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push('npm WARN deprecated something@1.0.0');
  lines.push('src/app.ts(42,7): error TS2345: Argument of type string is not assignable to parameter of type number');
  for (let i = 0; i < 400; i++) lines.push('npm WARN deprecated something@1.0.0');
  const log = lines.join('\n');
  const out = optimizeContext({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: log }] },
      ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'recency padding' })),
    ],
  }, { mode: 'safe' });
  const text = out.messages[0].content[0].text;
  assert.ok(text.includes('error TS2345: Argument of type string is not assignable to parameter of type number'),
    'the error line must survive untouched');
  assert.ok(text.includes('[+399 duplicate lines collapsed]'), 'noise around it is collapsed with a marker');
});

test('recency window: the last 6 messages are untouched in SAFE mode', () => {
  const messages = [
    ...Array.from({ length: 12 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `old ${i} ` + 'z'.repeat(400) }],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `recent ${i} ` + 'z'.repeat(400) }],
    })),
  ];
  const out = optimizeContext({ messages }, { mode: 'safe' });
  for (let i = 12; i < 18; i++) {
    const original = messages[i].content[0].text;
    const after = out.messages[i].content[0].text;
    assert.strictEqual(after, original, `recency message ${i} must be untouched`);
  }
});

test('tool_use and thinking blocks are never touched', () => {
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'x' } };
  const thinking = { type: 'thinking', thinking: 'chain of thought', signature: 'sig' };
  const messages = [
    { role: 'assistant', content: [thinking, toolUse, { type: 'text', text: 'noise '.repeat(200) }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'aggressive' });
  assert.deepEqual(out.messages[0].content[0], thinking, 'thinking block untouched');
  assert.deepEqual(out.messages[0].content[1], toolUse, 'tool_use block untouched');
});

test('tool_result terminal output is compressed WITHOUT deleting information', () => {
  const out = Array.from({ length: 150 }, () => 'DIR: node_modules').join('\n');
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: out }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const result = optimizeContext({ messages }, { mode: 'safe' });
  const text = result.messages[0].content[0].content;
  assert.ok(text.startsWith('DIR: node_modules'), 'first occurrence kept');
  assert.ok(text.includes('[+149 duplicate lines collapsed]'), 'count preserved in marker');
  assert.ok(result.stats.tokensSaved > 0);
  assert.equal(result.stats.criticalRemoved, 0);
});

test('ANSI escape codes are stripped but visible text survives', () => {
  const raw = '\x1b[32mSUCCESS\x1b[0m build finished\n' + '\x1b[31merror\x1b[0m: nothing\n'.repeat(1) + 'tail'.padEnd(300, 'x');
  const stripped = stripAnsi(raw);
  assert.ok(stripped.includes('SUCCESS build finished'));
  assert.ok(!stripped.includes('\x1b'));
});

test('carriage-return overwrites keep the final state (progress bars)', () => {
  const text = Array.from({ length: 100 }, (_, i) => `\rProgress: ${i}%`).join('') + '\nDone!';
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: text + '\n' + 'p'.repeat(300) }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'safe' });
  const t = out.messages[0].content[0].text;
  assert.ok(t.includes('Progress: 99%'), 'final progress state kept');
  assert.ok(!/Progress: 5%/.test(t), 'intermediate overwritten states dropped');
});

test('AGGRESSIVE whole-block dedup keeps the first copy + marker', () => {
  const big = 'IDENTICAL BUILD OUTPUT\n' + 'line\n'.repeat(300);
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'aggressive' });
  assert.ok(out.messages[0].content[0].text.includes('IDENTICAL BUILD OUTPUT'), 'first copy kept');
  assert.ok(out.messages[2].content[0].text.includes('duplicate of an earlier output block'),
    'later copy collapsed with an explicit marker');
});

test('SAFE mode does NOT collapse whole duplicate blocks (conservative)', () => {
  const big = 'IDENTICAL BUILD OUTPUT\n' + 'line\n'.repeat(300);
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'safe' });
  assert.ok(out.messages[2].content[0].text.includes('IDENTICAL BUILD OUTPUT'), 'SAFE keeps both blocks');
});

test('stats math is honest', () => {
  const big = 'same line content here\n'.repeat(500);
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'pad' })),
  ];
  const out = optimizeContext({ messages }, { mode: 'safe' });
  const s = out.stats;
  assert.equal(s.originalTokens - s.optimizedTokens, s.tokensSaved);
  assert.equal(s.reductionPct, Math.round((s.tokensSaved / s.originalTokens) * 100));
  assert.ok(s.reductionPct > 50, 'massively duplicated noise compresses well');
  assert.equal(s.criticalRemoved, 0);
  assert.equal(s.messagesTouched + s.messagesPreserved, s.messagesTotal);
});

test('malformed input falls back safely instead of throwing', () => {
  assert.doesNotThrow(() => optimizeContext(null, { mode: 'safe' }));
  assert.doesNotThrow(() => optimizeContext({}, { mode: 'safe' }));
  assert.doesNotThrow(() => optimizeContext({ messages: 'not-an-array' }, { mode: 'aggressive' }));
  const out = optimizeContext({ messages: [{ role: 'assistant', content: null }] }, { mode: 'safe' });
  assert.deepEqual(out.messages, [{ role: 'assistant', content: null }], 'weird messages pass through untouched');
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
