// ============================================================================
// BlitzProxy — Integration Tests: Proxy Server
// Real HTTP servers (mock OpenAI-compatible providers) — no real API keys.
// Covers: Anthropic translation (stream/non-stream/tools/reasoning),
// fallback, error classification, OpenAI passthrough, auth, dashboard.
// ============================================================================

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp = mkdtempSync(join(tmpdir(), 'blitz-server-test-'));
process.env.BLITZ_HOME = join(tmp, 'home');
process.env.BLITZ_CONFIG = join(tmp, 'config.json');
process.env.BLITZ_KEYRING = 'memory';
delete process.env.API_KEY;
delete process.env.PROVIDER;
delete process.env.MODEL;

const { createMockProvider } = await import('./helpers/mock-provider.js');

// Mocks must be up before config references their ports
const mockA = createMockProvider({ mode: 'ok' });
const mockB = createMockProvider({ mode: 'ok' });
// Mock C rejects its first key (key-rotation tests); nothing else uses it.
const mockC = createMockProvider({ mode: 'ok', rejectKeys: ['rot-key-1'] });
const a = await mockA.start();
const b = await mockB.start();
const c = await mockC.start();

writeFileSync(process.env.BLITZ_CONFIG, JSON.stringify({
  version: 2,
  provider: 'mocka',
  model: 'mock/model-a',
  routing: 'manual',
  fallbackChain: ['mockb'],
  proxyPort: 4819,
  host: '127.0.0.1',
  maxRetries: 1,
  retryBaseDelay: 30,
  requireAuth: false,
  logRequests: false,
  privacy: true, // keep the test run from writing blitz.log entries
  customProviders: {
    mocka: {
      name: 'Mock A',
      baseUrl: a.url,
      defaultModel: 'mock/model-a',
      requiresKey: true,
      timeout: 8000,
      models: { 'mock/model-a': { contextWindow: 8192, tools: true, vision: true, reasoning: true, tags: [] } },
    },
    mockb: {
      name: 'Mock B',
      baseUrl: b.url,
      defaultModel: 'mock/model-b',
      requiresKey: true,
      timeout: 8000,
      models: { 'mock/model-b': { contextWindow: 65536, tools: true, vision: false, reasoning: false, tags: [] } },
    },
    mockc: {
      name: 'Mock C',
      baseUrl: c.url,
      defaultModel: 'mock/model-c',
      requiresKey: true,
      timeout: 8000,
      models: { 'mock/model-c': { contextWindow: 8192, tools: true, vision: false, reasoning: false, tags: [] } },
    },
  },
}, null, 2), 'utf-8');

const { initApp, getConfig, saveConfig } = await import('../src/config.js');
const keyring = await import('../src/security/keyring.js');
const { getProxyToken } = await import('../src/security/auth.js');
const { createProxyServer } = await import('../src/server.js');
const { createStats } = await import('../src/stats.js');

await initApp();
await keyring.addKey({ key: 'test-key-aaaa', provider: 'mocka' });
await keyring.addKey({ key: 'test-key-bbbb', provider: 'mockb' });
await keyring.addKey({ key: 'rot-key-1', provider: 'mockc' });
await keyring.addKey({ key: 'rot-key-2', provider: 'mockc' });

const stats = createStats({ home: process.env.BLITZ_HOME, privacy: true });
const token = await getProxyToken(keyring);
const server = createProxyServer({ keyring, stats, token });

const baseUrl = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
  mockA.setMode('ok'); mockB.setMode('ok');
}

function anthropicReq(opts = {}) {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello' }],
    ...opts,
  });
}

async function post(path, body, headers = {}) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function parseSSE(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const eventLine = lines.find(l => l.startsWith('event: '));
    const dataLine = lines.find(l => l.startsWith('data: '));
    return {
      event: eventLine?.slice(7),
      data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
    };
  });
}

console.log('\nserver integration (mock providers)');

await test('GET /health is public and leaks no internals', async () => {
  const res = await fetch(baseUrl + '/health');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.proxy, 'BlitzProxy');
  assert.ok(!('baseUrl' in data), 'health must not disclose provider base URLs');
  assert.ok(!('key' in data));
});

await test('POST /v1/messages non-stream → Anthropic response', async () => {
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.type, 'message');
  assert.equal(data.role, 'assistant');
  assert.equal(data.model, 'claude-3-5-sonnet-20241022', 'response model echoes the request');
  assert.equal(data.content[0].type, 'text');
  assert.equal(data.content[0].text, 'Hello from mock!');
  assert.equal(data.stop_reason, 'end_turn');
  assert.equal(data.usage.input_tokens, 10);
  assert.equal(data.usage.output_tokens, 6);
});

await test('provider receives the key as Bearer auth', async () => {
  await post('/v1/messages', anthropicReq());
  const last = mockA.requests[mockA.requests.length - 1];
  assert.equal(last.headers['authorization'], 'Bearer test-key-aaaa');
  assert.equal(last.body.model, 'mock/model-a', 'translated request uses the provider model');
});

await test('POST /v1/messages stream → correct Anthropic SSE sequence', async () => {
  const res = await post('/v1/messages', anthropicReq({ stream: true }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/event-stream'));
  const text = await res.text();
  const events = parseSSE(text);
  const types = events.map(e => e.event);
  assert.ok(types.includes('message_start'));
  assert.ok(types.includes('ping'));
  assert.ok(types.includes('content_block_start'));
  assert.ok(types.includes('content_block_delta'));
  assert.ok(types.includes('content_block_stop'));
  assert.ok(types.includes('message_delta'));
  assert.ok(types.includes('message_stop'));
  const textDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
  assert.equal(textDeltas.map(e => e.data.delta.text).join(''), 'Hello from mock!');
  const msgDelta = events.find(e => e.event === 'message_delta');
  assert.equal(msgDelta.data.delta.stop_reason, 'end_turn');
});

await test('tool call non-stream → tool_use block', async () => {
  mockA.setMode('tools');
  const res = await post('/v1/messages', anthropicReq({ tools: [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }] }));
  const data = await res.json();
  assert.equal(data.stop_reason, 'tool_use');
  const block = data.content.find(c => c.type === 'tool_use');
  assert.ok(block, 'tool_use block missing');
  assert.equal(block.name, 'echo');
  assert.deepEqual(block.input, { x: 1 });
  assert.ok(block.id.startsWith('toolu_'));
});

await test('tool call stream → input_json_delta + stop_reason tool_use', async () => {
  mockA.setMode('stream-tools');
  const res = await post('/v1/messages', anthropicReq({ stream: true, tools: [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }] }));
  const events = parseSSE(await res.text());
  const starts = events.filter(e => e.event === 'content_block_start');
  assert.equal(starts[0].data.content_block.type, 'tool_use');
  const argDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta');
  assert.equal(argDeltas.map(e => e.data.delta.partial_json).join(''), '{"x":1}');
  const msgDelta = events.find(e => e.event === 'message_delta');
  assert.equal(msgDelta.data.delta.stop_reason, 'tool_use');
});

await test('reasoning_content → thinking block (non-stream)', async () => {
  mockA.setMode('reasoning');
  const res = await post('/v1/messages', anthropicReq());
  const data = await res.json();
  assert.equal(data.content[0].type, 'thinking');
  assert.equal(data.content[0].thinking, 'thought process');
  assert.equal(data.content[1].type, 'text');
  assert.equal(data.content[1].text, 'Final answer');
});

await test('reasoning stream → thinking_delta events before text', async () => {
  mockA.setMode('reasoning');
  const res = await post('/v1/messages', anthropicReq({ stream: true }));
  const events = parseSSE(await res.text());
  const thinkingDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta');
  assert.equal(thinkingDeltas.length, 1);
  assert.equal(thinkingDeltas[0].data.delta.thinking, 'let me think');
  const starts = events.filter(e => e.event === 'content_block_start');
  assert.equal(starts[0].data.content_block.type, 'thinking');
});

await test('image blocks are forwarded as image_url parts (not dropped)', async () => {
  await post('/v1/messages', anthropicReq({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ],
    }],
  }));
  const last = mockA.requests[mockA.requests.length - 1];
  const userMsg = last.body.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content), 'multimodal content must be an array');
  const img = userMsg.content.find(p => p.type === 'image_url');
  assert.ok(img, 'image_url part missing');
  assert.equal(img.image_url.url, 'data:image/png;base64,aGVsbG8=');
});

await test('assistant thinking blocks are stripped from history', async () => {
  await post('/v1/messages', anthropicReq({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning', signature: 'x' }, { type: 'text', text: 'answer' }] },
      { role: 'user', content: 'continue' },
    ],
  }));
  const last = mockA.requests[mockA.requests.length - 1];
  const raw = JSON.stringify(last.body);
  assert.ok(!raw.includes('secret reasoning'), 'thinking content must not be forwarded');
  const assistant = last.body.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.content, 'answer');
});

await test('fallback on 429: mockA rate-limited → served by mockB', async () => {
  mockA.setMode('429');
  const requestsBefore = mockB.requests.length;
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.content[0].text, 'Hello from mock!');
  assert.equal(mockB.requests.length, requestsBefore + 1, 'fallback provider must receive the request');
  assert.equal(mockB.requests[mockB.requests.length - 1].headers['authorization'], 'Bearer test-key-bbbb');
});

await test('fallback on context overflow: 400 context_length → served by mockB', async () => {
  mockA.setMode('400-context');
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.content[0].text, 'Hello from mock!');
});

await test('NO fallback on auth error: 401 surfaces as authentication_error', async () => {
  mockA.setMode('401');
  const requestsBefore = mockB.requests.length;
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.type, 'error');
  assert.equal(data.error.type, 'authentication_error');
  assert.equal(mockB.requests.length, requestsBefore, 'auth errors must NOT failover by default');
});

await test('key rotation: rejected key rotates to the next key for the SAME provider', async () => {
  try {
    saveConfig({ provider: 'mockc', model: 'mock/model-c', fallbackChain: ['mockb'], profile: '' });
    const mockBBefore = mockB.requests.length;
    const res = await post('/v1/messages', anthropicReq());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.content[0].text, 'Hello from mock!');
    assert.equal(mockC.requests.length, 2, 'both stored keys for mockc must be tried');
    assert.equal(mockC.requests[0].headers['authorization'], 'Bearer rot-key-1', 'first key attempted first');
    assert.equal(mockC.requests[1].headers['authorization'], 'Bearer rot-key-2', 'rejected key rotates to the next one');
    assert.equal(mockB.requests.length, mockBBefore, 'no provider failover while another key remains');
  } finally {
    saveConfig({ provider: 'mocka', model: 'mock/model-a', fallbackChain: ['mockb'], profile: '' });
  }
});

await test('key rotation exhausted: auth error surfaces when every key is rejected', async () => {
  try {
    saveConfig({ provider: 'mockc', model: 'mock/model-c', fallbackChain: [], profile: '' });
    mockC.setRejectKeys(['rot-key-1', 'rot-key-2']);
    const res = await post('/v1/messages', anthropicReq());
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error.type, 'authentication_error');
    assert.ok(data.error.message.includes('rejected'), 'the error explains that a key was rejected');
  } finally {
    mockC.setRejectKeys(['rot-key-1']);
    saveConfig({ provider: 'mocka', model: 'mock/model-a', fallbackChain: ['mockb'], profile: '' });
  }
});

await test('smart rotation: after a rejection the NEXT request uses the healthy credential first', async () => {
  try {
    saveConfig({ provider: 'mockc', model: 'mock/model-c', fallbackChain: [], profile: '' });
    // Request 1: rot-key-1 rejected → rotates to rot-key-2 → succeeds
    const r1 = await post('/v1/messages', anthropicReq());
    assert.equal(r1.status, 200);
    // Request 2: must START with the healthy credential (rot-key-2) — no retry of the dead one
    const before = mockC.requests.length;
    const r2 = await post('/v1/messages', anthropicReq());
    assert.equal(r2.status, 200);
    assert.equal(mockC.requests.length, before + 1, 'second request must need exactly one upstream attempt');
    assert.equal(mockC.requests[before].headers['authorization'], 'Bearer rot-key-2',
      'rejected credential is skipped by the resolver on subsequent requests');
  } finally {
    saveConfig({ provider: 'mocka', model: 'mock/model-a', fallbackChain: ['mockb'], profile: '' });
  }
});

await test('request IDs: every error carries a BLZ- correlation id', async () => {
  mockA.setMode('401');
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.ok(/^BLZ-[A-F0-9]{6}$/.test(data.request_id || ''), 'error payload includes a request id');
  assert.equal(res.headers.get('x-blitz-request-id'), data.request_id, 'header matches payload');
});

await test('request IDs: success responses carry the header too', async () => {
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 200);
  assert.ok(/^BLZ-[A-F0-9]{6}$/.test(res.headers.get('x-blitz-request-id') || ''));
  const stream = await post('/v1/messages', anthropicReq({ stream: true }));
  assert.ok(/^BLZ-[A-F0-9]{6}$/.test(stream.headers.get('x-blitz-request-id') || ''));
});

await test('GET /v1/models includes discovered models for the active provider', async () => {
  try {
    saveConfig({ discoveredModels: { mocka: { models: [{ id: 'mock/discovered-x', lastSeen: 'now' }], fetchedAt: 'now' } } });
    const res = await fetch(baseUrl + '/v1/models');
    const data = await res.json();
    const ids = data.data.map(m => m.id);
    assert.ok(ids.includes('claude-3-5-sonnet-20241022'), 'Claude-compat entries remain');
    assert.ok(ids.includes('mock/model-a'), 'catalog entries remain');
    assert.ok(ids.includes('mock/discovered-x'), 'discovered entry is exposed');
    assert.equal(ids.filter(i => i === 'mock/discovered-x').length, 1, 'no duplicates');
  } finally {
    saveConfig({ discoveredModels: {} });
  }
});

await test('NO fallback on invalid request: 400 invalid_request_error', async () => {
  mockA.setMode('invalid');
  const requestsBefore = mockB.requests.length;
  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.type, 'invalid_request_error');
  assert.equal(mockB.requests.length, requestsBefore, 'invalid requests must not failover');
});

await test('mid-stream provider failure sends an error event — never fakes success', async () => {
  mockA.setMode('stream-crash');
  const res = await post('/v1/messages', anthropicReq({ stream: true }));
  assert.equal(res.status, 200); // headers already sent before the failure
  const text = await res.text();
  assert.ok(text.includes('event: error'), 'client must be told about the failure');
  const events = parseSSE(text);
  const errorMsg = events.find(e => e.event === 'error');
  assert.ok(errorMsg, 'error event missing');
  assert.equal(errorMsg.data.error.type, 'api_error');
  assert.ok(!text.includes('message_stop') || text.indexOf('event: error') < text.indexOf('event: message_stop'),
    'no fake success finalize after error');
});

await test('POST /v1/chat/completions passthrough (non-stream)', async () => {
  const res = await post('/v1/chat/completions', JSON.stringify({
    model: '',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, 'Hello from mock!');
  assert.equal(data.id, 'chatcmpl-mock');
});

await test('POST /v1/chat/completions passthrough (stream)', async () => {
  const res = await post('/v1/chat/completions', JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('data: {"choices"'), 'SSE passthrough');
  assert.ok(text.includes('[DONE]'));
});

await test('POST /v1/responses (Codex) non-stream → Responses API object', async () => {
  const res = await post('/v1/responses', JSON.stringify({
    model: 'gpt-5-codex',
    instructions: 'You are a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: false,
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.object, 'response');
  assert.equal(data.status, 'completed');
  assert.equal(data.model, 'gpt-5-codex');
  const msg = data.output.find(o => o.type === 'message');
  assert.equal(msg.content[0].type, 'output_text');
  assert.equal(msg.content[0].text, 'Hello from mock!');
  assert.equal(data.usage.input_tokens, 10);

  // The provider received a translated chat/completions request
  const last = mockA.requests[mockA.requests.length - 1];
  assert.equal(last.body.messages[0].role, 'system');
  assert.equal(last.body.messages[0].content, 'You are a coding agent.');
  assert.equal(last.body.messages[1].content, 'hi');
});

await test('POST /v1/responses (Codex) stream → full event sequence', async () => {
  const res = await post('/v1/responses', JSON.stringify({
    input: 'hello',
    stream: true,
  }));
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map(b => {
    const lines = b.split('\n');
    return {
      event: lines.find(l => l.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find(l => l.startsWith('data: '))?.slice(6) || 'null'),
    };
  });
  const types = events.map(e => e.event);
  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.output_item.done'));
  assert.equal(types[types.length - 1], 'response.completed');
  const deltas = events.filter(e => e.event === 'response.output_text.delta');
  assert.equal(deltas.map(e => e.data.delta).join(''), 'Hello from mock!');
});

await test('POST /v1/responses (Codex) tool round-trip with function_call_output', async () => {
  mockA.setMode('tools');
  const res = await post('/v1/responses', JSON.stringify({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call', call_id: 'call_prev', name: 'echo', arguments: '{"x":0}' },
      { type: 'function_call_output', call_id: 'call_prev', output: 'previous result' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    ],
    tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }],
    stream: false,
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  const fc = data.output.find(o => o.type === 'function_call');
  assert.ok(fc, 'function_call item missing');
  assert.equal(fc.name, 'echo');
  assert.equal(fc.call_id, 'call_mock');
  assert.equal(fc.arguments, '{"x":1}');

  // The provider saw the translated history: assistant tool_calls + tool result
  const last = mockA.requests[mockA.requests.length - 1];
  const roles = last.body.messages.map(m => m.role);
  assert.ok(roles.includes('tool'), 'tool message missing in translated request');
  const toolMsg = last.body.messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_prev');
  assert.equal(toolMsg.content, 'previous result');
});

await test('GET /v1/models returns Claude-compat + configured provider models', async () => {
  const res = await fetch(baseUrl + '/v1/models');
  const data = await res.json();
  const ids = data.data.map(m => m.id);
  assert.ok(ids.includes('claude-sonnet-4-20250514'));
  assert.ok(ids.includes('mock/model-a'), 'active provider models exposed for OpenCode');
});

await test('POST /v1/messages/count_tokens returns an estimate', async () => {
  const res = await post('/v1/messages/count_tokens', anthropicReq());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.input_tokens === 'number' && data.input_tokens > 0);
});

await test('admin endpoints require the token', async () => {
  const noToken = await fetch(baseUrl + '/admin/stats');
  assert.equal(noToken.status, 401);
  const withToken = await fetch(baseUrl + `/admin/stats?token=${token}`);
  assert.equal(withToken.status, 200);
  const data = await withToken.json();
  assert.ok(Array.isArray(data.today));
  assert.equal(data.costIsEstimate, true);
});

await test('admin keys endpoint lists masked keys only', async () => {
  const res = await fetch(baseUrl + `/admin/keys?token=${token}`);
  const data = await res.json();
  assert.equal(data.keys.length, 4, 'two mocka/mockb keys + two rotation keys for mockc');
  for (const k of data.keys) {
    assert.ok(!JSON.stringify(k).includes('test-key-aaaa'), 'key material must never be exposed');
    assert.ok(!JSON.stringify(k).includes('rot-key-1'), 'key material must never be exposed');
    assert.ok(k.maskedKey.includes('•'));
  }
});

await test('dashboard requires token; serves HTML when valid', async () => {
  const noToken = await fetch(baseUrl + '/dashboard');
  assert.equal(noToken.status, 401);
  const res = await fetch(baseUrl + `/dashboard?token=${token}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('BlitzProxy Dashboard'));
});

await test('requireAuth=true blocks /v1 without the token and allows it with', async () => {
  saveConfig({ requireAuth: true });
  const blocked = await post('/v1/messages', anthropicReq());
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).error.type, 'authentication_error');
  const ok = await post('/v1/messages', anthropicReq(), { 'x-api-key': token });
  assert.equal(ok.status, 200);
  saveConfig({ requireAuth: false });
});

await test('unknown endpoint → 404 JSON error', async () => {
  const res = await fetch(baseUrl + '/v1/nope');
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.type, 'not_found');
});

await test('stats record requests per provider with fallback attribution', async () => {
  mockA.setMode('429');
  await post('/v1/messages', anthropicReq());
  const rows = stats.getSummary({ scope: 'today' });
  const mockARow = rows.find(r => r.providerId === 'mocka');
  const mockBRow = rows.find(r => r.providerId === 'mockb');
  assert.ok(mockARow && mockARow.fail >= 1, 'failed attempt recorded on mocka');
  assert.ok(mockARow.rateLimited >= 1, 'rate-limit recorded');
  assert.ok(mockBRow && mockBRow.ok >= 1, 'success recorded on mockb');
});

await test('network failure of the only candidate → clean 502 (no leaked internals)', async () => {
  // Regression: the catch path used to reference an out-of-scope variable,
  // turning a connection refusal into a 500 "response is not defined".
  const { createServer: createDummy } = await import('node:http');
  const dummy = createDummy();
  const deadPort = await new Promise(r => dummy.listen(0, '127.0.0.1', () => r(dummy.address().port)));
  await new Promise(r => dummy.close(r));

  const cfg = getConfig();
  saveConfig({
    customProviders: {
      ...cfg.customProviders,
      dead: { name: 'Dead', baseUrl: `http://127.0.0.1:${deadPort}`, defaultModel: 'x', requiresKey: false, timeout: 3000 },
    },
    provider: 'dead', model: 'x', fallbackChain: [],
  });

  const res = await post('/v1/messages', anthropicReq());
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error.type, 'api_error');
  assert.ok(!JSON.stringify(data).includes('is not defined'), 'internal errors must never leak');
  assert.ok(data.error.message.length > 0);

  // restore config for any later tests
  saveConfig({ provider: 'mocka', model: 'mock/model-a', fallbackChain: ['mockb'] });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
await new Promise(resolve => server.close(resolve));
await mockA.stop();
await mockB.stop();
await mockC.stop();

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
