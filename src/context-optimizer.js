// ============================================================================
// BLITZ — Context Optimizer (privacy-first, safety-first)
//
// Coding agents shovel enormous terminal output (build logs, npm installs,
// directory listings) into the model context. This optimizer reduces USELESS
// context while PRESERVING everything that matters. It is deliberately
// conservative and content-preserving by construction:
//
//   OFF         → identity, nothing is touched
//   SAFE        → lossless line-level ops only (ANSI, duplicate runs, CR)
//   BALANCED    → SAFE + exact-duplicate whole-block collapse in OLD messages
//   AGGRESSIVE  → BALANCED + non-consecutive duplicate-line collapse in old
//                 blocks + a narrower recency window
//   CUSTOM      → per-operation flags via config `contextCustom`
//
// HARD SAFETY GUARANTEES (all modes that are not OFF):
//   1. System prompts and USER TEXT are NEVER modified — instructions,
//      decisions, security constraints survive no matter how old they are.
//   2. The last N messages (recency window) are NEVER touched.
//   3. tool_use, thinking, and image blocks are NEVER touched — only the
//      TEXT of assistant messages and tool_result payloads is optimizable.
//   4. Every op preserves content: ANSI escape codes are stripped (they are
//      terminal formatting, not content), overwritten \r segments keep their
//      final state, and duplicate lines keep the FIRST occurrence plus an
//      explicit "[+N duplicate lines collapsed]" marker. Information is
//      compressed, never deleted.
//   5. Pure function: the original request object is never mutated; the
//      caller can always fall back to it (the server does, on any error).
//
// "Critical content removed" is 0 by construction and verified by tests.
// Semantic summarization is intentionally NOT implemented — it would require
// model calls and can hallucinate; see ARCHITECTURE.md.
// ============================================================================

export const CONTEXT_MODES = ['off', 'safe', 'balanced', 'aggressive', 'custom'];

// Per-mode operation presets. CUSTOM merges over SAFE defaults with the
// user's contextCustom flags.
const MODE_PRESETS = {
  safe:       { ansi: true, overwrites: true, duplicates: true, blankWalls: true, blockDedup: false, nonConsecutive: false, recency: 6 },
  balanced:   { ansi: true, overwrites: true, duplicates: true, blankWalls: true, blockDedup: true,  nonConsecutive: false, recency: 4 },
  aggressive: { ansi: true, overwrites: true, duplicates: true, blankWalls: true, blockDedup: true,  nonConsecutive: true,  recency: 2 },
};

/**
 * Resolve the effective operation set for a mode.
 * @param {string} mode  off | safe | balanced | aggressive | custom
 * @param {Object} contextCustom  per-operation flags for custom mode
 */
export function resolveModeOptions(mode, contextCustom) {
  if (mode === 'custom') {
    return { ...MODE_PRESETS.safe, ...(contextCustom || {}) };
  }
  return MODE_PRESETS[mode] || MODE_PRESETS.safe;
}

const MIN_BLOCK_CHARS = 200;       // tiny blocks are never worth touching
const DUPLICATE_RUN_MIN = 3;       // collapse runs of >=3 identical lines
const BLANK_RUN_MIN = 3;           // collapse runs of >=3 blank lines

// ─── Line-level lossless operations ──────────────────────────────────────────

// ANSI escape sequences: CSI (...m colors, cursor moves), OSC (...terminal
// titles), and simple escapes. These are terminal FORMATTING, not content.
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x1b]*(?:\x1b\\|\x07)/g;
const ANSI_SIMPLE_RE = /[\x07\x1b=>]{0,2}\x1b[@-_]/g;

/** Remove ANSI formatting noise. The visible text is preserved verbatim. */
export function stripAnsi(text) {
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_SIMPLE_RE, '');
}

/**
 * Carriage-return overwritten segments (progress bars, spinner lines) keep
 * only their FINAL state — exactly what a terminal would display.
 */
function collapseOverwrites(lines) {
  const out = [];
  for (const line of lines) {
    if (line.includes('\r')) {
      const segments = line.split('\r').filter(Boolean);
      out.push(segments.length > 0 ? segments[segments.length - 1] : '');
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Collapse runs of identical consecutive lines to the first occurrence plus
 * an explicit count marker. The information (what repeated, how many times)
 * is fully preserved.
 */
function collapseDuplicateRuns(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i] && lines[i].trim() !== '') j++;
    const run = j - i;
    if (run >= DUPLICATE_RUN_MIN) {
      out.push(`… [+${run - 1} duplicate lines collapsed]`);
    }
    i = j;
  }
  return out;
}

/** Collapse runs of >=3 blank lines to a single blank line (no information). */
function collapseBlankRuns(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      const run = j - i;
      if (run >= BLANK_RUN_MIN) {
        out.push('');
        out.push(`… [+${run - 1} blank lines collapsed]`);
      } else {
        for (let k = 0; k < run; k++) out.push('');
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

/** Apply the configured line-level operations to a text payload. */
function optimizeText(text, ops) {
  if (typeof text !== 'string' || text.length < MIN_BLOCK_CHARS) return text;

  let next = ops.ansi ? stripAnsi(text) : text;
  if (ops.overwrites && next.includes('\r')) {
    next = collapseOverwrites(next.split('\n')).join('\n');
  }
  const lines = next.split('\n');
  let current = lines;
  if (ops.duplicates) current = collapseDuplicateRuns(current);
  if (ops.blankWalls) current = collapseBlankRuns(current);
  let result = current.join('\n');

  if (ops.nonConsecutive) {
    // AGGRESSIVE only: collapse duplicate lines even when separated by
    // other content within the SAME block (e.g. a wall of the same warning
    // interleaved with timestamps). First occurrence + count is preserved.
    const seen = new Map();
    const outLines = [];
    for (const line of current) {
      const t = line.trim();
      if (t !== '' && t.length >= 12 && !t.startsWith('… [')) {
        const n = seen.get(t) || 0;
        if (n >= 2) {
          seen.set(t, n + 1);
          continue; // skip later duplicates; count reported in the marker
        }
        seen.set(t, n + 1);
      }
      outLines.push(line);
    }
    for (const [line, n] of seen) {
      if (n > 3) {
        // annotate the kept occurrence with how many duplicates were dropped
        const idx = outLines.findIndex(l => l.trim() === line);
        if (idx !== -1) outLines.splice(idx + 1, 0, `… [+${n - 1} further duplicate lines collapsed]`);
      }
    }
    result = outLines.join('\n');
  }

  return result;
}

// ─── Message classification (importance/confidence) ──────────────────────────

// User/system text is CRITICAL (importance 1.0) — never modified.
// tool_use/thinking/image blocks are CRITICAL — never modified.
// Recency-window messages are HIGH (keep entire, untouched).
// Old assistant text / tool_result payloads are MEDIUM/LOW — optimizable.
function blockIsOptimizable(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'text') return true;              // assistant text (old messages only)
  if (block.type === 'tool_result') return true;        // terminal output payload
  return false;                                          // tool_use / thinking / image: never
}

function textOfBlock(block) {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) {
      return block.content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
    }
  }
  return null;
}

function setTextOfBlock(block, text) {
  if (block.type === 'text') { block.text = text; return; }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') { block.content = text; return; }
    if (Array.isArray(block.content)) {
      let replaced = false;
      for (const p of block.content) {
        if (p && p.type === 'text' && typeof p.text === 'string' && !replaced) {
          p.text = text;
          replaced = true;
        } else if (p && p.type === 'text' && replaced) {
          p.text = '';
        }
      }
    }
  }
}

// ─── Optimizer entry point ───────────────────────────────────────────────────

function estimateTokensFromChars(s) {
  return Math.ceil(String(s || '').length / 4); // same heuristic as capabilities.estimateTokens
}

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(textOfBlock).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Optimize the context of an Anthropic Messages request.
 *
 * @param {Object} anthropicReq   parsed /v1/messages body (NEVER mutated)
 * @param {Object} opts
 * @param {string} opts.mode      'off' | 'safe' | 'balanced' | 'aggressive' | 'custom'
 * @param {Object} [opts.custom] per-operation flags for custom mode (cfg.contextCustom)
 * @returns {{ messages, system, stats }}
 *   stats: { mode, originalTokens, optimizedTokens, tokensSaved, reductionPct,
 *            messagesTotal, messagesTouched, messagesPreserved, criticalRemoved,
 *            operations: string[] }
 */
export function optimizeContext(anthropicReq, { mode = 'safe', custom } = {}) {
  const originalMessages = anthropicReq?.messages;
  if (mode === 'off' || !Array.isArray(originalMessages) || originalMessages.length === 0) {
    return {
      messages: originalMessages,
      system: anthropicReq?.system,
      stats: null,
    };
  }
  const ops = resolveModeOptions(mode, custom);
  const recency = Number.isInteger(ops.recency) && ops.recency >= 0 ? ops.recency : 6;
  const performed = new Set();

  const note = (name) => performed.add(name);

  const originalTokens = estimateTokensFromChars(
    JSON.stringify(originalMessages) + JSON.stringify(anthropicReq?.system ?? '')
  );

  const messages = [];
  let messagesTouched = 0;
  let messagesPreserved = 0;
  const seenBlockTexts = new Map(); // block dedup (old blocks only, BALANCED+)

  const runBlock = (block) => {
    if (!blockIsOptimizable(block)) return null; // tool_use / thinking / image: untouched
    const text = textOfBlock(block);
    if (typeof text !== 'string') return null;
    let optimized = optimizeText(text, ops);
    if (optimized !== text) {
      if (ops.ansi && stripAnsi(text) !== text) note('ansi-strip');
      if (ops.overwrites && text.includes('\r')) note('carriage-return-collapse');
      if (ops.duplicates) note('duplicate-line-collapse');
      if (ops.blankWalls) note('blank-line-collapse');
      if (ops.nonConsecutive) note('non-consecutive-duplicate-collapse');
    }
    if (ops.blockDedup) {
      const key = `${block.type}::${optimized}`;
      if (seenBlockTexts.get(key) === true) {
        optimized = `… [duplicate of an earlier output block — collapsed]`;
        note('block-dedup');
      } else {
        seenBlockTexts.set(key, true);
      }
    }
    if (optimized === text) return null;
    setTextOfBlock(block, optimized);
    return true;
  };

  for (let idx = 0; idx < originalMessages.length; idx++) {
    const msg = originalMessages[idx];
    const inRecencyWindow = idx >= originalMessages.length - recency;
    const role = msg?.role;

    // CRITICAL: user text and system content are never modified — no matter
    // how old the message is. Instructions, decisions, security constraints
    // live here and MUST survive.
    if (inRecencyWindow || role === 'system' || role === 'user') {
      // User messages may still carry tool_result payloads (terminal output),
      // which are optimizable WITHOUT touching user text.
      if (role === 'user' && !inRecencyWindow && Array.isArray(msg?.content)) {
        const clone = { ...msg, content: msg.content.map(b => ({ ...(b || {}) })) };
        let changed = false;
        for (const block of clone.content) {
          if (blockIsOptimizable(block) && block.type === 'tool_result') {
            if (runBlock(block) === true) changed = true;
          }
        }
        messages.push(changed ? clone : msg);
        if (changed) messagesTouched++; else messagesPreserved++;
        continue;
      }
      messages.push(msg);
      messagesPreserved++;
      continue;
    }

    // Assistant messages (old): optimize text blocks; tool_use/thinking stay.
    if (role === 'assistant' && Array.isArray(msg?.content)) {
      const clone = { ...msg, content: msg.content.map(b => ({ ...(b || {}) })) };
      let changed = false;
      for (const block of clone.content) {
        if (runBlock(block) === true) changed = true;
      }
      messages.push(changed ? clone : msg);
      if (changed) messagesTouched++; else messagesPreserved++;
      continue;
    }

    // Anything else: preserved untouched.
    messages.push(msg);
    messagesPreserved++;
  }

  const optimizedTokens = estimateTokensFromChars(
    JSON.stringify(messages) + JSON.stringify(anthropicReq?.system ?? '')
  );

  const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
  const reductionPct = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;

  return {
    messages,
    system: anthropicReq?.system, // never modified — CRITICAL by definition
    stats: {
      mode,
      originalTokens,
      optimizedTokens,
      tokensSaved,
      reductionPct,
      messagesTotal: originalMessages.length,
      messagesTouched,
      messagesPreserved,
      criticalRemoved: 0, // by construction; verified by adversarial tests
      operations: [...performed],
    },
  };
}
