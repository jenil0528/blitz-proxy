// ============================================================================
// BlitzProxy — Request/Response Translator
// Converts between Anthropic Messages API ⟷ OpenAI Chat Completions API
// ============================================================================

import * as log from './logger.js';
import { randomUUID } from 'crypto';

// ─── Tool Call ID Mapping ────────────────────────────────────────────────────
// Anthropic uses `toolu_xxxx`, OpenAI uses `call_xxxx`
// We maintain a bidirectional map per request lifecycle

function generateToolId() {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function generateCallId() {
  return 'call_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// ─── Anthropic Request → OpenAI Request ──────────────────────────────────────

/**
 * Map an Anthropic thinking budget to a reasoning-effort bucket.
 * Deterministic and conservative; no budget → medium.
 */
function budgetToEffort(budget) {
  if (typeof budget !== 'number' || budget <= 0) return 'medium';
  if (budget <= 4000) return 'low';
  if (budget <= 16000) return 'medium';
  return 'high';
}

function cacheControlOf(block) {
  return block?.cache_control?.type === 'ephemeral' ? { type: 'ephemeral' } : null;
}

/**
 * Translate an Anthropic Messages API request body into an OpenAI Chat Completions request body.
 * @param {Object} anthropicReq - The Anthropic request body
 * @param {string} model - The model to use on the OpenAI side
 * @param {Object} [opts]
 * @param {string|null} [opts.reasoningControl] - provider reasoning control style declared
 *   by the catalog/adapter: 'openrouter-reasoning' | 'reasoning-effort' | 'glm-thinking'.
 *   Undeclared → thinking is dropped (the provider reasons on its own or not at all).
 * @param {string|null} [opts.promptCaching] - 'anthropic-ephemeral' when the provider's
 *   API accepts Anthropic-style cache_control on content parts / tools (e.g. OpenRouter).
 *   Undeclared → cache_control markers are stripped (most providers cache automatically).
 * @returns {{ body: Object, toolIdMap: Map }}
 */
export function translateRequest(anthropicReq, model, opts = {}) {
  const toolIdMap = new Map(); // anthropicId -> openaiId & reverse
  const openaiBody = {};

  // Model
  openaiBody.model = model;

  // Extended thinking → provider reasoning control, ONLY when the provider
  // declares a supported control style (never sent speculatively).
  if (anthropicReq.thinking?.type === 'enabled') {
    const control = opts.reasoningControl;
    if (control === 'openrouter-reasoning') {
      openaiBody.reasoning = { effort: budgetToEffort(anthropicReq.thinking.budget_tokens) };
      const budget = anthropicReq.thinking.budget_tokens;
      if (typeof budget === 'number' && budget > 0) openaiBody.reasoning.max_tokens = budget;
    } else if (control === 'reasoning-effort') {
      openaiBody.reasoning_effort = budgetToEffort(anthropicReq.thinking.budget_tokens);
    } else if (control === 'glm-thinking') {
      openaiBody.thinking = { type: 'enabled' };
    }
    // no declared control → deliberately dropped
  }

  // Messages
  openaiBody.messages = translateMessages(anthropicReq.messages || [], anthropicReq.system, toolIdMap, opts);

  // Tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiBody.tools = translateToolDefinitions(anthropicReq.tools, opts);
  }

  // Tool choice
  if (anthropicReq.tool_choice) {
    openaiBody.tool_choice = translateToolChoice(anthropicReq.tool_choice);
  }

  // Parameters
  if (anthropicReq.max_tokens) openaiBody.max_tokens = anthropicReq.max_tokens;
  if (anthropicReq.temperature !== undefined) openaiBody.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiBody.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiBody.stop = anthropicReq.stop_sequences;
  if (anthropicReq.stream !== undefined) openaiBody.stream = anthropicReq.stream;

  // Stream options — request usage stats in streaming mode
  if (openaiBody.stream) {
    openaiBody.stream_options = { include_usage: true };
  }

  // Lazy debug: avoid JSON.stringify cost when not in debug mode
  if (log.isDebug()) {
    log.debug('[Translator] Translated request:', JSON.stringify(openaiBody).slice(0, 500));
  }

  return { body: openaiBody, toolIdMap };
}

// ─── Message Translation ─────────────────────────────────────────────────────

function translateMessages(messages, systemPrompt, toolIdMap, opts) {
  const result = [];

  // System message (Anthropic puts it at top level, OpenAI as a message)
  if (systemPrompt) {
    if (typeof systemPrompt === 'string') {
      result.push({ role: 'system', content: systemPrompt });
    } else if (Array.isArray(systemPrompt)) {
      // Anthropic allows system to be an array of content blocks.
      // With prompt-caching passthrough enabled, keep blocks (with their
      // cache_control breakpoints) as parts; otherwise collapse to a string.
      const caching = opts?.promptCaching === 'anthropic-ephemeral';
      const hasCache = systemPrompt.some(b => b?.cache_control?.type === 'ephemeral');
      if (caching && hasCache) {
        const parts = systemPrompt
          .filter(b => b.type === 'text')
          .map(b => {
            const part = { type: 'text', text: b.text };
            const cc = cacheControlOf(b);
            if (cc) part.cache_control = cc;
            return part;
          });
        if (parts.length > 0) result.push({ role: 'system', content: parts });
      } else {
        const text = systemPrompt
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        if (text) result.push({ role: 'system', content: text });
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push(...translateUserMessage(msg, toolIdMap, opts));
    } else if (msg.role === 'assistant') {
      result.push(...translateAssistantMessage(msg, toolIdMap, opts));
    }
  }

  return result;
}

function translateUserMessage(msg, toolIdMap, opts) {
  const results = [];

  // Content can be a string or array of content blocks
  if (typeof msg.content === 'string') {
    results.push({ role: 'user', content: msg.content });
    return results;
  }

  if (!Array.isArray(msg.content)) {
    results.push({ role: 'user', content: String(msg.content || '') });
    return results;
  }

  // Separate tool_result blocks from other content
  const toolResults = [];
  const otherBlocks = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      toolResults.push(block);
    } else {
      otherBlocks.push(block);
    }
  }

  // Tool results → separate "tool" role messages
  for (const tr of toolResults) {
    const callId = toolIdMap.get(tr.tool_use_id) || tr.tool_use_id;
    let content = '';

    if (typeof tr.content === 'string') {
      content = tr.content;
    } else if (Array.isArray(tr.content)) {
      content = tr.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }

    // Handle error results
    if (tr.is_error) {
      content = `[ERROR] ${content}`;
    }

    results.push({
      role: 'tool',
      tool_call_id: callId,
      content: content || 'OK',
    });
  }

  // Other content blocks → user message (text + vision parts).
  // With prompt-caching passthrough, cache_control breakpoints are kept on
  // per-block text parts; otherwise text collapses to a plain string.
  if (otherBlocks.length > 0) {
    const caching = opts?.promptCaching === 'anthropic-ephemeral';
    const hasCache = caching && otherBlocks.some(b => b?.cache_control?.type === 'ephemeral');
    const textParts = [];
    const imageParts = [];
    let cacheOnText = false;
    for (const block of otherBlocks) {
      if (block.type === 'text') {
        if (hasCache) {
          const part = { type: 'text', text: block.text };
          const cc = cacheControlOf(block);
          if (cc) { part.cache_control = cc; cacheOnText = true; }
          textParts.push(part);
        } else {
          textParts.push(block.text);
        }
      } else if (block.type === 'image' && block.source) {
        // Anthropic image → OpenAI image_url (base64 data URL or remote URL)
        if (block.source.type === 'base64' && block.source.data) {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}` },
          });
        } else if (block.source.type === 'url' && block.source.url) {
          imageParts.push({ type: 'image_url', image_url: { url: block.source.url } });
        }
      }
    }

    if (imageParts.length > 0) {
      const parts = [];
      if (textParts.length > 0) {
        if (typeof textParts[0] === 'string') {
          parts.push({ type: 'text', text: textParts.join('\n') });
        } else {
          parts.push(...textParts);
        }
      }
      parts.push(...imageParts);
      results.push({ role: 'user', content: parts });
    } else if (textParts.length > 0) {
      if (cacheOnText) {
        results.push({ role: 'user', content: textParts }); // parts array keeps breakpoints
      } else {
        results.push({ role: 'user', content: textParts.join('\n') });
      }
    }
  }

  return results;
}

function translateAssistantMessage(msg, toolIdMap, opts) {
  // Content can be a string or array of content blocks
  if (typeof msg.content === 'string') {
    return [{ role: 'assistant', content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: 'assistant', content: String(msg.content || '') }];
  }

  // Build a single assistant message with optional tool_calls.
  // cache_control breakpoints survive only on plain-text turns — a
  // tool-call turn must keep a string content part for provider compatibility.
  const assistantMsg = { role: 'assistant', content: null, tool_calls: [] };
  const textParts = [];
  const caching = opts?.promptCaching === 'anthropic-ephemeral';
  const hasCache = caching && msg.content.some(b => b?.cache_control?.type === 'ephemeral');
  let sawToolUse = false;

  for (const block of msg.content) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Reasoning history is not forwarded to OpenAI-compatible providers
      continue;
    }
    if (block.type === 'text') {
      if (hasCache) {
        const part = { type: 'text', text: block.text };
        const cc = cacheControlOf(block);
        if (cc) part.cache_control = cc;
        textParts.push(part);
      } else {
        textParts.push(block.text);
      }
    } else if (block.type === 'tool_use') {
      sawToolUse = true;
      const callId = generateCallId();
      toolIdMap.set(block.id, callId); // anthropic → openai
      toolIdMap.set(callId, block.id); // openai → anthropic (reverse)

      assistantMsg.tool_calls.push({
        id: callId,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      });
    }
  }

  if (textParts.length > 0) {
    if (hasCache && !sawToolUse && typeof textParts[0] !== 'string') {
      assistantMsg.content = textParts; // parts array keeps breakpoints
    } else {
      assistantMsg.content = textParts.map(p => (typeof p === 'string' ? p : p.text)).join('\n');
    }
  }

  if (assistantMsg.tool_calls.length === 0) {
    delete assistantMsg.tool_calls;
  }

  return [assistantMsg];
}

// ─── Tool Definition Translation ─────────────────────────────────────────────

function translateToolDefinitions(tools, opts) {
  const caching = opts?.promptCaching === 'anthropic-ephemeral';
  return tools.map(tool => {
    const def = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    };
    // Anthropic puts cache_control on the tool object; OpenRouter-style APIs
    // accept it at the same level. Pass through only when declared.
    const cc = caching ? cacheControlOf(tool) : null;
    if (cc) def.cache_control = cc;
    return def;
  });
}

function translateToolChoice(choice) {
  if (!choice) return undefined;

  if (typeof choice === 'string') {
    // 'auto', 'none', 'any'
    if (choice === 'any') return 'required';
    return choice;
  }

  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') {
    return { type: 'function', function: { name: choice.name } };
  }

  return 'auto';
}

// ─── OpenAI Response → Anthropic Response ────────────────────────────────────

/**
 * Translate an OpenAI Chat Completions response into an Anthropic Messages response.
 * @param {Object} openaiRes - The OpenAI response body
 * @param {Map} toolIdMap - Tool ID mapping from the request phase
 * @param {string} requestModel - The model name from the original Anthropic request
 * @returns {Object} Anthropic-formatted response
 */
export function translateResponse(openaiRes, toolIdMap, requestModel) {
  const choice = openaiRes.choices?.[0];
  if (!choice) {
    // Empty response fallback
    return buildAnthropicResponse(
      [{ type: 'text', text: '' }],
      'end_turn',
      requestModel,
      openaiRes.usage
    );
  }

  const message = choice.message;
  const content = [];

  // Provider reasoning (e.g. DeepSeek R1 reasoning_content) → thinking block
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: 'blitzproxy' });
  }

  // Text content
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Tool calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const anthropicId = toolIdMap.get(tc.id) || generateToolId();

      let input;
      try {
        input = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {
        input = { raw: tc.function.arguments };
      }

      content.push({
        type: 'tool_use',
        id: anthropicId,
        name: tc.function.name,
        input,
      });
    }
  }

  // If no content at all, add empty text
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Map stop reason
  const stopReason = translateStopReason(choice.finish_reason, message.tool_calls);

  return buildAnthropicResponse(content, stopReason, requestModel, openaiRes.usage);
}

function translateStopReason(finishReason, toolCalls) {
  if (toolCalls && toolCalls.length > 0) return 'tool_use';

  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function buildAnthropicResponse(content, stopReason, model, usage) {
  return {
    id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24),
    type: 'message',
    role: 'assistant',
    model: model || 'blitz-proxy',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || usage?.input_tokens || 0,
      output_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
      // Real provider cache reads when reported (OpenAI-compat
      // prompt_tokens_details.cached_tokens); 0 otherwise — never invented.
      // OpenAI-compat APIs have no "cache write" counter, so creation stays 0.
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}
