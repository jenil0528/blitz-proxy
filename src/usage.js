// ============================================================================
// BLITZ — Normalized Usage
// Providers do NOT return identical usage fields. Everything in BLITZ
// converts provider usage into ONE internal format here, and estimates are
// always MARKED as estimates — never presented as exact provider usage.
//
// Internal format:
//   { inputTokens, outputTokens, cachedInputTokens, reasoningTokens,
//     totalTokens, estimated, source }
// ============================================================================

/**
 * Normalize usage from any provider shape.
 * @param {Object} opts
 * @param {Object} [opts.openai]   raw OpenAI-shaped usage:
 *   { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens },
 *    completion_tokens_details: { reasoning_tokens } }
 * @param {Object} [opts.anthropic] Anthropic-shaped usage:
 *   { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * @param {number} [opts.estimatedInputTokens]  request estimate when the
 *   provider returned no usage
 * @param {number} [opts.estimatedOutputTokens]
 * @returns {{ inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens, estimated, source }|null}
 */
export function normalizeUsage({ openai, anthropic, estimatedInputTokens, estimatedOutputTokens } = {}) {
  // OpenAI-compatible shape (chat/completions, responses)
  if (openai && typeof openai === 'object' && typeof openai.prompt_tokens === 'number') {
    const cached = Number(openai.prompt_tokens_details?.cached_tokens) || 0;
    const reasoning = Number(openai.completion_tokens_details?.reasoning_tokens) || 0;
    return {
      inputTokens: openai.prompt_tokens,
      outputTokens: Number(openai.completion_tokens) || 0,
      cachedInputTokens: cached,
      reasoningTokens: reasoning,
      totalTokens: (openai.prompt_tokens || 0) + Number(openai.completion_tokens || 0),
      estimated: false,
      source: 'provider-usage',
    };
  }
  // Anthropic-shaped usage
  if (anthropic && typeof anthropic === 'object' && typeof anthropic.input_tokens === 'number') {
    const cached = Number(anthropic.cache_read_input_tokens) || 0;
    const cachedWrite = Number(anthropic.cache_creation_input_tokens) || 0;
    const out = Number(anthropic.output_tokens) || 0;
    return {
      inputTokens: anthropic.input_tokens,
      outputTokens: out,
      cachedInputTokens: cached + cachedWrite,
      reasoningTokens: 0, // Anthropic usage has no separate reasoning field
      totalTokens: (anthropic.input_tokens || 0) + out + cachedWrite,
      estimated: false,
      source: 'provider-usage',
    };
  }
  // No provider usage at all → estimate, clearly marked
  const estIn = Number(estimatedInputTokens) || 0;
  const estOut = Number(estimatedOutputTokens) || 0;
  if (estIn <= 0 && estOut <= 0) return null;
  return {
    inputTokens: estIn,
    outputTokens: estOut,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: estIn + estOut,
    estimated: true,
    source: 'estimate',
  };
}

/** Format a token count for display: 1234567 → "1.23M". */
export function formatTokensCount(n) {
  if (typeof n !== 'number' || isNaN(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Agent attribution (best-effort, from HTTP headers — never fabricated) ──

const AGENT_UA_PATTERNS = [
  [/claude-?(code|cli)/i, 'Claude Code'],
  [/opencode/i, 'OpenCode'],
  [/codex/i, 'Codex CLI'],
  [/aider/i, 'Aider'],
  [/continue/i, 'Continue'],
  [/cline/i, 'Cline'],
  [/roo-?code/i, 'Roo Code'],
];

/**
 * Detect which agent is talking to the gateway from its User-Agent header.
 * Returns a display name or 'other' — never a guess beyond these patterns.
 */
export function detectAgentFromUserAgent(ua) {
  const s = String(ua || '');
  for (const [re, name] of AGENT_UA_PATTERNS) {
    if (re.test(s)) return name;
  }
  return s ? 'other' : 'unknown';
}
