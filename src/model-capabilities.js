// ============================================================================
// BLITZ — Model Capability Registry
// ONE normalized capability system for the whole gateway. Providers declare
// what they know in their catalog/adapter; anything not declared is UNKNOWN
// (null) — NEVER silently treated as supported.
//
// Capability sources, in priority order:
//   1. explicit provider metadata (catalog `models` entries, plugin defs)
//   2. provider adapter knowledge (implicit in the catalog itself)
//   3. discovered model metadata (only if explicitly annotated — never fabricated)
//   4. conservative fallback: chat=true (all OpenAI-compatible providers),
//      everything else UNKNOWN
//
// All providers in this gateway speak the OpenAI-compatible chat protocol,
// so chat and streaming are known-true at the protocol level. Everything
// model-specific (tools, vision, reasoning, structured output, …) is only
// claimed when the catalog says so.
// ============================================================================

import { resolveProvider } from './provider-registry.js';

/**
 * Normalized capabilities for a provider/model combination.
 * Values: true (supported), false (not supported), null (UNKNOWN).
 */
export function getCapabilities(providerId, modelId, cfg = {}) {
  const def = resolveProvider(providerId, cfg);
  if (!def) return null;

  const catalog = def.models?.[modelId];

  return {
    // protocol-level (all adapters are OpenAI-compatible)
    chat: true,
    streaming: true,
    protocol: 'openai-compat',

    // model-level — only claimed when the catalog declares it
    tools: catalog ? catalog.tools === true : null,
    vision: catalog ? catalog.vision === true : null,
    reasoning: catalog ? catalog.reasoning === true : null,
    structuredOutput: catalog?.structuredOutput === true ? true : null,
    jsonMode: catalog?.jsonMode === true ? true : null,
    embeddings: catalog?.embeddings === true ? true : false, // chat providers: known false
    audioInput: catalog?.audioInput === true ? true : null,
    audioOutput: catalog?.audioOutput === true ? true : null,
    promptCaching: catalog?.promptCaching === true ? true : null,

    // limits — null = UNKNOWN (never guessed)
    contextWindow: typeof catalog?.contextWindow === 'number' ? catalog.contextWindow : null,
    maxOutputTokens: typeof catalog?.maxOutputTokens === 'number' ? catalog.maxOutputTokens : null,

    known: Boolean(catalog), // false = unknown model, all model-level caps UNKNOWN
    provider: providerId,
    model: modelId,
  };
}

/**
 * Validate requested features against known capabilities.
 * UNKNOWN capabilities never fail validation (we cannot reject what we
 * cannot know) — only KNOWN-false capabilities mismatch.
 * @returns {{ ok: boolean, mismatches: Array<{capability, reason}>, unknown: string[] }}
 */
export function validateCapabilities(needs, caps) {
  if (!caps) return { ok: true, mismatches: [], unknown: [] };
  const mismatches = [];
  const unknown = [];

  const check = (requested, supported, name) => {
    if (!requested) return;
    if (supported === false) mismatches.push({ capability: name, reason: `${caps.provider}/${caps.model} does not support ${name} (verified in catalog)` });
    else if (supported === null) unknown.push(name);
  };

  check(needs.tools, caps.tools, 'tools');
  check(needs.vision, caps.vision, 'vision');
  check(needs.reasoning, caps.reasoning, 'reasoning');

  if (typeof caps.contextWindow === 'number' && typeof needs.estTokens === 'number' && needs.estTokens > caps.contextWindow) {
    mismatches.push({
      capability: 'context window',
      reason: `estimated ${needs.estTokens} tokens exceeds the ${Math.round(caps.contextWindow / 1024)}k context of ${caps.provider}/${caps.model}`,
    });
  }

  return { ok: mismatches.length === 0, mismatches, unknown };
}

/**
 * Render one capability value for the CLI: ✓ | ✗ | ? (UNKNOWN)
 */
export function capabilityMark(value) {
  if (value === true) return '✓';
  if (value === false) return '✗';
  return '?';
}

/** Human label for a capability value — never claims UNKNOWN as supported. */
export function capabilityLabel(value) {
  if (value === true) return 'SUPPORTED';
  if (value === false) return 'NOT SUPPORTED';
  return 'UNKNOWN';
}

/** Format tokens for display: 131072 → "128K", null → "UNKNOWN". */
export function formatTokens(n) {
  if (typeof n !== 'number') return 'UNKNOWN';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}
