// Sudo Agent profiles + context budget (P26-b). Small models (<=3B, or
// unknown local) get few tools with terse descriptions and chunked tasks;
// 7B+ get the full set. Context size: explicit override, else the runtime
// n_ctx read from the probe, else prudent defaults. Stdlib only. ASCII only.
'use strict';

// Full set order (stable); small subset keeps the most useful six.
const FULL_TOOLS = ['read', 'list', 'glob', 'grep', 'write', 'edit', 'patch', 'bash', 'todo'];
const SMALL_TOOLS = ['read', 'list', 'grep', 'write', 'edit', 'bash'];

const TERSE = {
  read: 'Read a project file.',
  list: 'List a directory.',
  grep: 'Search text (regex).',
  write: 'Create/replace a file (replace needs prior read).',
  edit: 'Replace one exact unique string.',
  bash: 'Run a shell command (timeout, truncated).',
};

function parseParamsB(modelId) {
  const m = /(\d+(?:[._]\d+)?)\s*b\b/i.exec(String(modelId || ''));
  if (!m) return null;
  const v = parseFloat(m[1].replace('_', '.'));
  return Number.isFinite(v) ? v : null;
}

// override: 'small'|'full'|'auto'|undefined. providerType: 'local'|'cloud'.
// 7B+ -> full; anything else (incl. unknown local) -> small (safe).
function selectProfile(opts) {
  opts = opts || {};
  const o = String(opts.override || opts.env || 'auto').toLowerCase();
  if (o === 'small' || o === 'full') return o;
  const b = parseParamsB(opts.modelId);
  if (b !== null && b >= 7) return 'full';
  if (b !== null) return 'small';
  return opts.providerType === 'cloud' ? 'full' : 'small';
}

function profileTools(profile) {
  return profile === 'small' ? SMALL_TOOLS.slice() : FULL_TOOLS.slice();
}

function maxIters(profile) {
  return profile === 'small' ? 6 : 10;
}

function chunkNote(profile) {
  if (profile !== 'small') return '';
  return 'Small model: split the task into tiny steps, one tool per step, verify each result.';
}

// override (int) > probe n_ctx (int) > defaults (local 2048, cloud 8000).
function resolveCtxTokens(opts) {
  opts = opts || {};
  const ints = [opts.override, opts.probeNctx].map((v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  if (ints[0] > 0) return ints[0];
  if (ints[1] > 0) return ints[1];
  return opts.providerType === 'cloud' ? 8000 : 2048;
}

// Rough estimate: chars/4 per message + overhead + schemas.
function estimateTokens(messages, schemaChars) {
  let chars = 0;
  for (const m of messages || []) {
    chars += 32;
    if (m && typeof m.content === 'string') chars += m.content.length;
    if (m && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) chars += String((c && c.function && c.function.arguments) || '').length + 32;
    }
  }
  chars += schemaChars || 0;
  return Math.ceil(chars / 4) + 64;
}

module.exports = { FULL_TOOLS, SMALL_TOOLS, TERSE, parseParamsB, selectProfile, profileTools, maxIters, chunkNote, resolveCtxTokens, estimateTokens };
