// ============================================================================
// BlitzProxy — Test Helper: Mock OpenAI-compatible provider
// A real HTTP server that speaks the OpenAI Chat Completions API with
// scriptable failure modes. No real API keys, no real providers.
// ============================================================================

import { createServer } from 'http';

/**
 * Create a mock provider server.
 *
 * Options:
 *   mode       → see failure modes below
 *   rejectKeys → Bearer keys that always get 403 (for key-rotation tests)
 *
 * Modes:
 *   ok            → normal completion           { content: 'Hello from mock!' }
 *   tools         → completion with one tool call (fn: echo, {x:1})
 *   reasoning     → completion with reasoning_content + content
 *   stream        → SSE text stream
 *   stream-tools  → SSE stream with tool call deltas
 *   stream-crash → SSE stream that dies mid-response (network failure)
 *   429           → always 429
 *   429-then-ok   → 429 on first request, then ok
 *   500           → always 500
 *   400-context   → 400 with context_length_exceeded
 *   401           → always 401
 *   invalid       → 400 invalid request
 */
export function createMockProvider({ mode = 'ok', rejectKeys = [] } = {}) {
  const requests = [];
  let state = { ...{} };
  let currentMode = mode;
  let rejectedKeys = [...rejectKeys];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* leave empty */ }
      requests.push({ method: req.method, url: req.url, body: parsed, headers: req.headers });

      if (req.method === 'GET' && req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock/model-a' }, { id: 'mock/model-b' }] }));
        return;
      }

      // Scriptable per-key rejection (key rotation tests)
      const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (rejectedKeys.length > 0 && rejectedKeys.includes(bearer)) {
        return sendJson(res, 403, { status: 403, title: 'Forbidden', detail: 'Authorization failed' });
      }

      const m = currentMode;

      if (m === '429') return sendJson(res, 429, { error: { message: 'rate limited' } });
      if (m === '429-then-ok') {
        if (!state.hit429) {
          state.hit429 = true;
          res.setHeader('retry-after', '0');
          return sendJson(res, 429, { error: { message: 'rate limited' } });
        }
      }
      if (m === '500') return sendJson(res, 500, { error: { message: 'server exploded' } });
      if (m === '401') return sendJson(res, 401, { error: { message: 'invalid api key' } });
      if (m === '400-context') {
        return sendJson(res, 400, { error: { message: 'This model maximum context length is 4096 tokens. However, you requested 50000 tokens' } });
      }
      if (m === 'invalid') return sendJson(res, 400, { error: { message: 'invalid request parameter' } });

      const wantsStream = parsed.stream === true;

      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (m === 'stream-crash') {
          res.write('data: {"choices":[{"delta":{"content":"partial "},"finish_reason":null}]}\n\n');
          setTimeout(() => res.destroy(), 50);
          return;
        }
        if (m === 'stream-tools') {
          const events = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mock","function":{"name":"echo","arguments":""}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":7,"completion_tokens":5}}',
            'data: [DONE]',
          ];
          let i = 0;
          const timer = setInterval(() => {
            if (i >= events.length) { clearInterval(timer); res.end(); return; }
            res.write(events[i++] + '\n\n');
          }, 5);
          return;
        }
        // stream text (+ reasoning first in reasoning mode)
        const chunks = [];
        if (m === 'reasoning') {
          chunks.push('data: {"choices":[{"delta":{"reasoning_content":"let me think"},"finish_reason":null}]}');
        }
        chunks.push(
          'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{"content":"from mock!"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":6}}',
          'data: [DONE]',
        );
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) { clearInterval(timer); res.end(); return; }
          res.write(chunks[i++] + '\n\n');
        }, 5);
        return;
      }

      // Non-streaming completions
      const usage = { prompt_tokens: 10, completion_tokens: 6 };
      if (m === 'tools') {
        return sendJson(res, 200, {
          id: 'chatcmpl-mock',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_mock',
                type: 'function',
                function: { name: 'echo', arguments: '{"x":1}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage,
        });
      }
      if (m === 'reasoning') {
        return sendJson(res, 200, {
          id: 'chatcmpl-mock',
          choices: [{
            message: { role: 'assistant', reasoning_content: 'thought process', content: 'Final answer' },
            finish_reason: 'stop',
          }],
          usage,
        });
      }
      sendJson(res, 200, {
        id: 'chatcmpl-mock',
        choices: [{
          message: { role: 'assistant', content: 'Hello from mock!' },
          finish_reason: 'stop',
        }],
        usage,
      });
    });
  });

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  return {
    server,
    requests,
    setMode: (m) => { currentMode = m; state = {}; },
    mode: () => currentMode,
    setRejectKeys: (keys) => { rejectedKeys = [...keys]; },
    start: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
    }),
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}
