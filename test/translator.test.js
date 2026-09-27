// ============================================================================
// BlitzProxy — Unit Tests: Request/Response Translation
// Run with: node test/translator.test.js
// ============================================================================

import assert from 'node:assert/strict';
import { translateRequest, translateResponse } from '../src/translator.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── translateRequest ─────────────────────────────────────────────────────────

console.log('\ntranslateRequest');

test('simple user message → OpenAI messages array', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'Hello' }],
  }, 'gpt-4o');

  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, 'Hello');
});

test('string system prompt becomes system message', () => {
  const { body } = translateRequest({
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hi' }],
  }, 'gpt-4o');

  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are helpful.');
  assert.equal(body.messages[1].role, 'user');
});

test('array system prompt concatenates text blocks', () => {
  const { body } = translateRequest({
    system: [
      { type: 'text', text: 'Part A.' },
      { type: 'text', text: 'Part B.' },
    ],
    messages: [{ role: 'user', content: 'Hi' }],
  }, 'gpt-4o');

  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'Part A.\nPart B.');
});

test('max_tokens / temperature / top_p forwarded', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 100,
    temperature: 0.5,
    top_p: 0.9,
  }, 'gpt-4o');

  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);
});

test('stop_sequences forwarded as stop array', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    stop_sequences: ['END', 'STOP'],
  }, 'gpt-4o');

  assert.deepEqual(body.stop, ['END', 'STOP']);
});

test('stream=true adds stream_options', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
  }, 'gpt-4o');

  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('tool definitions translated correctly', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }],
  }, 'gpt-4o');

  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'get_weather');
  assert.equal(body.tools[0].function.description, 'Get weather');
  assert.deepEqual(body.tools[0].function.parameters.properties, { city: { type: 'string' } });
});

test('tool_choice any → required', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    tool_choice: { type: 'any' },
  }, 'gpt-4o');
  assert.equal(body.tool_choice, 'required');
});

test('tool_choice specific tool', () => {
  const { body } = translateRequest({
    messages: [{ role: 'user', content: 'x' }],
    tool_choice: { type: 'tool', name: 'my_tool' },
  }, 'gpt-4o');
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'my_tool' } });
});

test('assistant tool_use message translated with call IDs', () => {
  const { body, toolIdMap } = translateRequest({
    messages: [
      { role: 'user', content: 'Use the tool' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'my_tool',
          input: { key: 'value' },
        }],
      },
    ],
  }, 'gpt-4o');

  const assistantMsg = body.messages.find(m => m.role === 'assistant');
  assert.ok(assistantMsg, 'assistant message missing');
  assert.ok(assistantMsg.tool_calls?.length === 1, 'expected 1 tool_call');
  const tc = assistantMsg.tool_calls[0];
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'my_tool');
  assert.equal(tc.function.arguments, JSON.stringify({ key: 'value' }));

  // ID mapping: anthropic → openai
  const openaiId = tc.id;
  assert.equal(toolIdMap.get('toolu_abc'), openaiId);
  assert.equal(toolIdMap.get(openaiId), 'toolu_abc');
});

test('tool_result message translated to tool role', () => {
  // translateRequest builds its own toolIdMap from the assistant message, then
  // uses it to resolve tool_use_id in subsequent tool_result messages.
  const { body } = translateRequest({
    messages: [
      { role: 'user', content: 'Use the tool' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_xyz', name: 'f', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'result text' }],
      },
    ],
  }, 'gpt-4o');

  const toolMsg = body.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'tool message missing');
  assert.equal(toolMsg.content, 'result text');
});

test('tool_result with is_error flag prefixes content', () => {
  const { body } = translateRequest({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e', name: 'f', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_e',
          content: 'something failed',
          is_error: true,
        }],
      },
    ],
  }, 'gpt-4o');

  const toolMsg = body.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg?.content.startsWith('[ERROR]'), `expected [ERROR] prefix, got: ${toolMsg?.content}`);
});

// ─── translateResponse ────────────────────────────────────────────────────────

console.log('\ntranslateResponse');

test('basic text response', () => {
  const toolIdMap = new Map();
  const result = translateResponse({
    id: 'chatcmpl-1',
    choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, toolIdMap, 'claude-3-5-sonnet-20241022');

  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Hello!');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.model, 'claude-3-5-sonnet-20241022');
});

test('finish_reason length → max_tokens', () => {
  const result = translateResponse({
    choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
    usage: {},
  }, new Map(), 'm');
  assert.equal(result.stop_reason, 'max_tokens');
});

test('tool_calls in response → tool_use blocks', () => {
  const toolIdMap = new Map();
  const result = translateResponse({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_data', arguments: '{"x":1}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  }, toolIdMap, 'gpt-4o');

  assert.equal(result.stop_reason, 'tool_use');
  const toolBlock = result.content.find(b => b.type === 'tool_use');
  assert.ok(toolBlock, 'tool_use block missing');
  assert.equal(toolBlock.name, 'get_data');
  assert.deepEqual(toolBlock.input, { x: 1 });
  assert.ok(toolBlock.id.startsWith('toolu_'), `expected toolu_ prefix, got: ${toolBlock.id}`);
});

test('invalid tool argument JSON falls back to raw wrapper', () => {
  const result = translateResponse({
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_bad',
          type: 'function',
          function: { name: 'f', arguments: '<<invalid>>' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {},
  }, new Map(), 'm');

  const toolBlock = result.content.find(b => b.type === 'tool_use');
  assert.ok(toolBlock, 'tool_use block missing');
  assert.equal(toolBlock.input.raw, '<<invalid>>');
});

test('empty choices returns empty text fallback', () => {
  const result = translateResponse({ choices: [] }, new Map(), 'm');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, '');
  assert.equal(result.stop_reason, 'end_turn');
});

test('message with both text and tool calls', () => {
  const result = translateResponse({
    choices: [{
      message: {
        content: 'Calling tool now.',
        tool_calls: [{
          id: 'call_x',
          type: 'function',
          function: { name: 'my_fn', arguments: '{}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {},
  }, new Map(), 'm');

  const textBlock = result.content.find(b => b.type === 'text');
  const toolBlock = result.content.find(b => b.type === 'tool_use');
  assert.ok(textBlock, 'text block missing');
  assert.equal(textBlock.text, 'Calling tool now.');
  assert.ok(toolBlock, 'tool_use block missing');
  assert.equal(toolBlock.name, 'my_fn');
});

// ─── v2 additions ─────────────────────────────────────────────────────────────

console.log('\ntranslateRequest — v2 (images, thinking)');

test('image blocks become OpenAI image_url data URLs', () => {
  const { body } = translateRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      ],
    }],
  }, 'gpt-4o');

  const userMsg = body.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content), 'multimodal content must be an array');
  const img = userMsg.content.find(p => p.type === 'image_url');
  assert.ok(img, 'image_url part missing');
  assert.equal(img.image_url.url, 'data:image/jpeg;base64,QUJD');
  const txt = userMsg.content.find(p => p.type === 'text');
  assert.equal(txt.text, 'what is this?');
});

test('image url sources are forwarded as-is', () => {
  const { body } = translateRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }],
    }],
  }, 'gpt-4o');
  const img = body.messages[0].content.find(p => p.type === 'image_url');
  assert.equal(img.image_url.url, 'https://example.com/cat.png');
});

test('assistant thinking blocks are stripped (not forwarded)', () => {
  const { body } = translateRequest({
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
          { type: 'text', text: 'visible answer' },
        ],
      },
      { role: 'user', content: 'continue' },
    ],
  }, 'gpt-4o');
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('internal reasoning'));
  const assistant = body.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.content, 'visible answer');
});

console.log('\ntranslateResponse — v2 (reasoning)');

test('reasoning_content becomes a thinking block before text', () => {
  const result = translateResponse({
    choices: [{
      message: { role: 'assistant', reasoning_content: 'chain of thought', content: 'Answer' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 9 },
  }, new Map(), 'm');
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'chain of thought');
  assert.equal(result.content[1].type, 'text');
  assert.equal(result.content[1].text, 'Answer');
  assert.equal(result.stop_reason, 'end_turn');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
