// ============================================================================
// BlitzProxy — Model Capability Matching
// The router must never silently send a request to a model that cannot
// satisfy it (e.g. tool calls to a model without tool support).
// Unknown models are treated permissively — we fail loudly at the provider,
// not silently in the router.
// ============================================================================

import { findModelInfo } from '../providers.js';

/**
 * Fast token estimate (chars / 4) — same heuristic as /v1/messages/count_tokens.
 */
export function estimateTokens(anthropicReq) {
  let chars = 0;
  try {
    if (anthropicReq.messages) chars += JSON.stringify(anthropicReq.messages).length;
    if (anthropicReq.system) {
      chars += typeof anthropicReq.system === 'string'
        ? anthropicReq.system.length
        : JSON.stringify(anthropicReq.system).length;
    }
    if (anthropicReq.tools) chars += JSON.stringify(anthropicReq.tools).length;
  } catch { return 0; }
  return Math.ceil(chars / 4);
}

function hasImageBlocks(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    const c = m?.content;
    if (!Array.isArray(c)) return false;
    return c.some(b => b?.type === 'image');
  });
}

function hasImagePartsOpenAI(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    const c = m?.content;
    if (!Array.isArray(c)) return false;
    return c.some(b => b?.type === 'image_url');
  });
}

/**
 * What does this Anthropic-format request require from a model?
 */
export function requestNeeds(anthropicReq) {
  const needs = {
    tools: Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0,
    vision: hasImageBlocks(anthropicReq.messages),
    reasoning: anthropicReq.thinking?.type === 'enabled',
    fast: false,
    streaming: anthropicReq.stream === true,
    maxTokens: anthropicReq.max_tokens || 0,
  };
  return needs;
}

/**
 * Same for OpenAI-format requests (used by /v1/chat/completions).
 */
export function requestNeedsOpenAI(body) {
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: hasImagePartsOpenAI(body.messages),
    reasoning: typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none',
    fast: false,
    streaming: body.stream === true,
    maxTokens: body.max_tokens || 0,
  };
}

/**
 * Can a specific model satisfy the needs?
 * Returns { ok, reasons[] }. Unknown models pass permissively with a note.
 */
export function modelSatisfies(providerId, modelId, needs, estTokens) {
  const reasons = [];
  const info = findModelInfo(providerId, modelId);
  if (!info) {
    return { ok: true, reasons: ['unknown model — assuming capable'], known: false };
  }
  if (needs.tools && info.tools === false) {
    reasons.push(`model does not support tool calling`);
  }
  if (needs.vision && info.vision === false) {
    reasons.push(`model does not support vision input`);
  }
  if (estTokens > 0 && info.contextWindow && estTokens > info.contextWindow) {
    reasons.push(`estimated ${estTokens} tokens exceeds ${info.contextWindow} context window`);
  }
  return { ok: reasons.length === 0, reasons, known: true };
}

/**
 * Context headroom of a model for overflow-aware fallback ordering
 * (bigger windows first). Unknown → Infinity (permissive).
 */
export function contextHeadroom(providerId, modelId, estTokens) {
  const info = findModelInfo(providerId, modelId);
  if (!info || !info.contextWindow) return Infinity;
  return info.contextWindow - (estTokens || 0);
}
