// ============================================================================
// BlitzProxy — Unit Tests: Responses API Translator (Codex CLI support)
// ============================================================================

import assert from 'node:assert/strict';
import { translateResponsesRequest, translateResponsesResponse, translateResponsesStream } from '../src/responses-translator.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

function makeRes() {
  const writes = [];
  return {
    writes,
    write(d) { writes.push(d); },
    end() { writes.push(null); },
    events() {
      return writes
        .filter(w => w !== null)
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map(block => {
          const lines = block.split('\n');
          const eventLine = lines.find(l => l.startsWith('event: '));
          const dataLine = lines.find(l => l.startsWith('data: '));
          return {
            event: eventLine?.slice(7),
            data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
          };
        });
    },
  };
}

function makeStream(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  let i = 0;
  return {
    getReader() {
      return {
        read() {
          if (i >= chunks.length) return Promise.resolve({ done: true });
          return Promise.resolve({ done: false, value: chunks[i++] });
        },
      };
    },
  };
}

console.log('\ntranslateResponsesRequest (Codex → chat/completions)');

test('instructions become the system message', () => {
  const { body } = translateResponsesRequest({
    instructions: 'You are a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are a coding agent.');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, 'hi');
});

test('string input becomes a user message', () => {
  const { body } = translateResponsesRequest({ input: 'hello there' });
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, 'hello there');
});

test('function_call items merge into one assistant message; outputs become tool messages', () => {
  const { body } = translateResponsesRequest({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'file1\nfile2' },
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'output_text', text: '/home' }] },
    ],
  });
  const roles = body.messages.map(m => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool']);
  const assistant = body.messages[1];
  assert.equal(assistant.tool_calls.length, 2, 'consecutive function calls merge');
  assert.equal(assistant.tool_calls[0].id, 'call_a');
  assert.equal(body.messages[2].tool_call_id, 'call_a');
  assert.equal(body.messages[2].content, 'file1\nfile2');
  assert.equal(body.messages[3].content, '/home', 'array output parts are joined');
});

test('tools map to chat/completions function format', () => {
  const { body } = translateResponsesRequest({
    input: 'x',
    tools: [{ type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object' }, strict: false }],
  });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'shell');
  assert.ok(!('strict' in body.tools[0].function), 'strict is dropped');
});

test('max_output_tokens / temperature / stream forwarded', () => {
  const { body } = translateResponsesRequest({
    input: 'x', max_output_tokens: 512, temperature: 0.2, stream: true,
  });
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('reasoning items and unsupported fields are dropped safely', () => {
  const { body } = translateResponsesRequest({
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thoughts' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ],
    reasoning: { effort: 'high' },
    store: false,
    prompt_cache_key: 'abc',
    parallel_tool_calls: false,
  });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('thoughts'), 'reasoning history must not be forwarded');
  assert.ok(!raw.includes('prompt_cache_key'));
  assert.equal(body.messages.length, 1);
});

test('input_image parts become image_url parts', () => {
  const { body } = translateResponsesRequest({
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
    ] }],
  });
  const user = body.messages[0];
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,QUJD');
});

console.log('\ntranslateResponsesResponse (provider → Codex)');

test('chat completion becomes a Responses output message', () => {
  const out = translateResponsesResponse({
    choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  }, 'gpt-5-codex');
  assert.equal(out.object, 'response');
  assert.equal(out.status, 'completed');
  assert.equal(out.model, 'gpt-5-codex');
  const msg = out.output.find(o => o.type === 'message');
  assert.equal(msg.content[0].type, 'output_text');
  assert.equal(msg.content[0].text, 'Hello!');
  assert.equal(out.usage.input_tokens, 12);
  assert.equal(out.usage.total_tokens, 17);
});

test('tool_calls become function_call items with call_id', () => {
  const out = translateResponsesResponse({
    choices: [{
      message: { content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: {},
  }, 'm');
  const fc = out.output.find(o => o.type === 'function_call');
  assert.ok(fc, 'function_call item missing');
  assert.equal(fc.call_id, 'call_x');
  assert.equal(fc.name, 'shell');
  assert.equal(fc.arguments, '{"cmd":"ls"}');
});

test('finish_reason length → status incomplete with details', () => {
  const out = translateResponsesResponse({
    choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: {},
  }, 'm');
  assert.equal(out.status, 'incomplete');
  assert.equal(out.incomplete_details.reason, 'max_output_tokens');
});

test('reasoning_content becomes a reasoning item', () => {
  const out = translateResponsesResponse({
    choices: [{ message: { reasoning_content: 'hmm', content: 'answer' }, finish_reason: 'stop' }], usage: {},
  }, 'm');
  assert.ok(out.output.some(o => o.type === 'reasoning'));
  assert.ok(out.output.some(o => o.type === 'message'));
});

console.log('\ntranslateResponsesStream (SSE events)');

await testAsync('text stream emits the full Codex event sequence', async () => {
  const res = makeRes();
  const stream = makeStream([
    'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"lo!"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
    'data: [DONE]',
  ]);
  const result = await translateResponsesStream(stream, res, 'gpt-5-codex');
  const events = res.events();
  const types = events.map(e => e.event);

  assert.equal(result.errored, false);
  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.output_item.added'));
  assert.ok(types.includes('response.content_part.added'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.output_text.done'));
  assert.ok(types.includes('response.output_item.done'));
  assert.equal(types[types.length - 1], 'response.completed');

  const deltas = events.filter(e => e.event === 'response.output_text.delta');
  assert.equal(deltas.map(e => e.data.delta).join(''), 'Hello!');

  const completed = events.find(e => e.event === 'response.completed');
  assert.equal(completed.data.response.usage.input_tokens, 7);
  const msg = completed.data.response.output.find(o => o.type === 'message');
  assert.equal(msg.content[0].text, 'Hello!');
});

await testAsync('tool call stream emits function_call events with arguments', async () => {
  const res = makeRes();
  const stream = makeStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_A","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]);
  await translateResponsesStream(stream, res, 'm');
  const events = res.events();

  const added = events.find(e => e.event === 'response.output_item.added' && e.data.item.type === 'function_call');
  assert.ok(added, 'function_call output_item.added missing');
  assert.equal(added.data.item.call_id, 'call_A');

  const argDeltas = events.filter(e => e.event === 'response.function_call_arguments.delta');
  assert.equal(argDeltas.map(e => e.data.delta).join(''), '{"cmd":"ls"}');

  const argDone = events.find(e => e.event === 'response.function_call_arguments.done');
  assert.equal(argDone.data.arguments, '{"cmd":"ls"}');

  const itemDone = events.find(e => e.event === 'response.output_item.done' && e.data.item.type === 'function_call');
  assert.equal(itemDone.data.item.call_id, 'call_A');
  assert.equal(itemDone.data.item.name, 'shell');

  const completed = events.find(e => e.event === 'response.completed');
  const fc = completed.data.response.output.find(o => o.type === 'function_call');
  assert.equal(fc.arguments, '{"cmd":"ls"}');
});

await testAsync('mid-stream failure emits response.failed — never fakes completion', async () => {
  const res = makeRes();
  let i = 0;
  const chunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n')];
  const failingStream = {
    getReader() {
      return {
        read() {
          if (i === 0) { i++; return Promise.resolve({ done: false, value: chunks[0] }); }
          return Promise.reject(new Error('connection reset'));
        },
      };
    },
  };
  const result = await translateResponsesStream(failingStream, res, 'm');
  assert.equal(result.errored, true);
  const events = res.events();
  assert.ok(events.some(e => e.event === 'response.failed'), 'response.failed event missing');
  assert.ok(!events.some(e => e.event === 'response.completed'), 'no fake completion after failure');
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
