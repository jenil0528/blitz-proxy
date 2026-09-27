// ============================================================================
// BlitzProxy — OpenAI Responses API Translator
// Converts between the Responses API (used by Codex CLI) and the OpenAI
// Chat Completions API spoken by providers.
//
//   Codex ──POST /v1/responses──▶ BlitzProxy ──/chat/completions──▶ provider
//        ◀── response.* SSE ───           ◀── OpenAI SSE ──
// ============================================================================

import { randomUUID } from 'crypto';
import * as log from './logger.js';

function uid(prefix) {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// ─── Responses Request → OpenAI Chat Completions Request ─────────────────────

/**
 * @returns {{ body: Object, toolCallIds: string[] }} body = chat/completions body
 */
export function translateResponsesRequest(resReq) {
  const body = {};
  const messages = [];

  if (resReq.instructions) {
    messages.push({ role: 'system', content: String(resReq.instructions) });
  }

  const input = resReq.input;
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }]
    : Array.isArray(input) ? input : [];

  let pendingAssistantToolCalls = null;
  const flushToolCalls = () => {
    if (pendingAssistantToolCalls) {
      messages.push(pendingAssistantToolCalls);
      pendingAssistantToolCalls = null;
    }
  };

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'message': {
        flushToolCalls();
        const role = item.role === 'assistant' ? 'assistant'
          : item.role === 'developer' ? 'system' : 'user';
        const content = translateContentParts(item.content, role === 'assistant');
        if (content !== null) messages.push({ role, content });
        break;
      }
      case 'function_call': {
        // Merge consecutive function calls into one assistant message
        if (!pendingAssistantToolCalls) {
          pendingAssistantToolCalls = { role: 'assistant', content: null, tool_calls: [] };
        }
        pendingAssistantToolCalls.tool_calls.push({
          id: item.call_id || uid('call'),
          type: 'function',
          function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        });
        break;
      }
      case 'function_call_output': {
        flushToolCalls();
        let output = item.output;
        if (Array.isArray(output)) {
          output = output
            .map(p => (typeof p === 'string' ? p : p?.text || p?.output || ''))
            .join('\n');
        } else if (output && typeof output === 'object') {
          output = output.text || output.output || JSON.stringify(output);
        }
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(output ?? '') });
        break;
      }
      case 'reasoning': {
        // Reasoning history is not forwarded to chat/completions providers
        break;
      }
      default:
        break;
    }
  }
  flushToolCalls();
  body.messages = messages;

  if (Array.isArray(resReq.tools) && resReq.tools.length > 0) {
    body.tools = resReq.tools
      .filter(t => t?.type === 'function')
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      }));
  }

  if (resReq.tool_choice) {
    if (typeof resReq.tool_choice === 'string') {
      body.tool_choice = resReq.tool_choice === 'any' ? 'required' : resReq.tool_choice;
    } else if (resReq.tool_choice.type === 'function') {
      body.tool_choice = { type: 'function', function: { name: resReq.tool_choice.name } };
    }
  }

  if (resReq.max_output_tokens) body.max_tokens = resReq.max_output_tokens;
  if (resReq.temperature !== undefined) body.temperature = resReq.temperature;
  if (resReq.top_p !== undefined) body.top_p = resReq.top_p;
  if (resReq.stream !== undefined) body.stream = resReq.stream;
  if (body.stream) body.stream_options = { include_usage: true };

  // Dropped intentionally (chat/completions has no equivalent):
  // reasoning{effort}, store, include, prompt_cache_key, previous_response_id,
  // parallel_tool_calls, metadata, text.format

  return { body };
}

function translateContentParts(content, isAssistant) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const parts = [];
  let sawImage = false;
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'refusal') {
      parts.push({ type: 'text', text: String(part.text ?? '') });
    } else if (part.type === 'input_image' && part.image_url) {
      sawImage = true;
      parts.push({ type: 'image_url', image_url: { url: part.image_url } });
    }
  }
  if (parts.length === 0) return '';
  if (!sawImage) {
    // Plain text — collapse to a string (most compatible)
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    return text || (isAssistant ? null : '');
  }
  return parts;
}

// ─── OpenAI Chat Completions Response → Responses API Response ────────────────

export function translateResponsesResponse(openaiRes, requestModel) {
  const choice = openaiRes.choices?.[0];
  const message = choice?.message || {};
  const output = [];

  if (message.reasoning_content) {
    output.push({ id: uid('rs'), type: 'reasoning', summary: [] });
  }
  if (message.content) {
    output.push({
      id: uid('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        id: uid('fc'),
        type: 'function_call',
        status: 'completed',
        call_id: tc.id,
        name: tc.function?.name,
        arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
      });
    }
  }
  if (output.length === 0) {
    output.push({
      id: uid('msg'), type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const truncated = choice?.finish_reason === 'length';
  return {
    id: uid('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: truncated ? 'incomplete' : 'completed',
    incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
    model: requestModel || 'blitz-proxy',
    output,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
      total_tokens: (openaiRes.usage?.prompt_tokens || 0) + (openaiRes.usage?.completion_tokens || 0),
    },
    error: null,
    metadata: {},
  };
}

// ─── Streaming: OpenAI SSE → Responses API SSE events ─────────────────────────

const sharedDecoder = new TextDecoder();

/**
 * Convert an OpenAI streaming response into Responses API SSE events.
 * @returns {{ inputTokens, outputTokens, errored }}
 */
export async function translateResponsesStream(openaiStream, res, requestModel) {
  const responseId = uid('resp');
  const state = {
    seq: 0,
    outputIndex: -1,
    textItemId: null,
    textStarted: false,
    textFull: '',
    toolBuffers: {},          // tcIndex → { itemId, callId, name, args, outputIndex, announced, done }
    finishedItems: [],
    inputTokens: 0,
    outputTokens: 0,
    errored: false,
  };

  send(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model: requestModel || 'blitz-proxy', output: [],
    },
  });

  try {
    const reader = openaiStream.getReader ? openaiStream.getReader() : null;
    let buffer = '';
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += sharedDecoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line, res, state);
        }
      }
      if (buffer.trim()) processLine(buffer, res, state);
    } else {
      for await (const chunk of openaiStream) {
        buffer += typeof chunk === 'string' ? chunk : sharedDecoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line, res, state);
        }
      }
      if (buffer.trim()) processLine(buffer, res, state);
    }
  } catch (err) {
    log.error('[Responses] Stream error:', err.message);
    state.errored = true;
    send(res, 'response.failed', {
      type: 'response.failed',
      response: {
        id: responseId, object: 'response', status: 'failed',
        error: { code: 'api_error', message: `Upstream stream failed: ${err.message}` },
        output: state.finishedItems,
      },
    });
    try { res.end(); } catch { /* already destroyed */ }
    return { inputTokens: state.inputTokens, outputTokens: state.outputTokens, errored: true };
  }

  finalizeText(res, state);
  finalizeAllTools(res, state);

  send(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId, object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: requestModel || 'blitz-proxy',
      output: state.finishedItems,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens || 1,
        total_tokens: state.inputTokens + (state.outputTokens || 1),
      },
    },
  });
  try { res.end(); } catch { /* ignore */ }
  return { inputTokens: state.inputTokens, outputTokens: state.outputTokens, errored: false };
}

function processLine(line, res, state) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return;
  if (!trimmed.startsWith('data:')) return;
  const jsonStr = trimmed.slice(5).trim();
  if (jsonStr === '[DONE]') return;

  let chunk;
  try { chunk = JSON.parse(jsonStr); } catch { return; }

  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens || chunk.usage.input_tokens || state.inputTokens;
    state.outputTokens = chunk.usage.completion_tokens || chunk.usage.output_tokens || state.outputTokens;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;
  const delta = choice.delta || {};

  if (delta.reasoning_content) {
    // Reasoning deltas are not streamed as events (kept in reasoning summary);
    // track output tokens via usage only.
  }

  if (delta.content) {
    if (!state.textStarted) {
      finalizeAllTools(res, state); // tool items come before text? close any open ones
      state.outputIndex++;
      state.textItemId = uid('msg');
      state.textStarted = true;
      send(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: { id: state.textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      send(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: state.textItemId,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    state.textFull += delta.content;
    send(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: state.textItemId,
      output_index: state.outputIndex,
      content_index: 0,
      delta: delta.content,
    });
  }

  if (Array.isArray(delta.tool_calls)) {
    finalizeText(res, state);
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state.toolBuffers[idx]) {
        state.outputIndex++;
        const buf = {
          itemId: uid('fc'),
          callId: tc.id || uid('call'),
          name: tc.function?.name || '',
          args: tc.function?.arguments || '',
          outputIndex: state.outputIndex,
          announced: true,
        };
        state.toolBuffers[idx] = buf;
        send(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: buf.outputIndex,
          item: { id: buf.itemId, type: 'function_call', status: 'in_progress', call_id: buf.callId, name: buf.name, arguments: '' },
        });
        if (buf.args) {
          send(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: buf.itemId, output_index: buf.outputIndex, delta: buf.args,
          });
        }
      } else {
        const buf = state.toolBuffers[idx];
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) {
          buf.args += tc.function.arguments;
          send(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: buf.itemId, output_index: buf.outputIndex, delta: tc.function.arguments,
          });
        }
      }
    }
  }
}

function finalizeText(res, state) {
  if (!state.textStarted) return;
  send(res, 'response.output_text.done', {
    type: 'response.output_text.done',
    item_id: state.textItemId, output_index: state.outputIndex, content_index: 0,
    text: state.textFull,
  });
  send(res, 'response.content_part.done', {
    type: 'response.content_part.done',
    item_id: state.textItemId, output_index: state.outputIndex, content_index: 0,
    part: { type: 'output_text', text: state.textFull, annotations: [] },
  });
  const item = {
    id: state.textItemId, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: state.textFull, annotations: [] }],
  };
  send(res, 'response.output_item.done', {
    type: 'response.output_item.done',
    output_index: state.outputIndex, item,
  });
  state.finishedItems.push(item);
  state.textStarted = false;
  state.textItemId = null;
}

function finalizeAllTools(res, state) {
  for (const idx of Object.keys(state.toolBuffers)) {
    const buf = state.toolBuffers[idx];
    if (buf.done) continue;
    buf.done = true;
    send(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: buf.itemId, output_index: buf.outputIndex, arguments: buf.args,
    });
    const item = {
      id: buf.itemId, type: 'function_call', status: 'completed',
      call_id: buf.callId, name: buf.name, arguments: buf.args,
    };
    send(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: buf.outputIndex, item,
    });
    state.finishedItems.push(item);
  }
}

function send(res, eventType, data) {
  try {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    log.debug('[Responses] Failed to write event:', err.message);
  }
}
