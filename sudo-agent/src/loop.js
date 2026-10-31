// Sudo Agent loop (P24 single-turn + P25 tool loop + P26 agent loop). Without
// a project root the turn streams a plain answer (legacy). With a project
// root the model may call tools under boundary + permissions + checkpoints.
// P26: Build/Plan modes, size profiles, context budget + compression, one
// action per step, repeat-loop detection, verify loop after modifications,
// MCP tools (full profile). The turn ends with an HONEST status: TERMINE
// only if the agent declared done, no tool error stands unresolved, and the
// really-modified file list is provided. Stdlib only, ASCII only (status
// words use unaccented capitals on purpose).
// P52: approvals pause (resumable), engine-owned todos, adapted tools,
// orchestrated long tasks, summarized results.
'use strict';

const fs = require('fs');
const path = require('path');
const { probeProvider, streamChat, chatOnce, waitForRuntime } = require('./providers');
const { classifyAction } = require('./intent');
const { executeTool, toOpenAISchema, ensureSeriesCheckpoint, saveRunSidecar } = require('./tools');
const { loadProjectRules } = require('./permissions');
const { diffSnapshot } = require('./checkpoints');
const { maskSecrets } = require('./journal');
const plan = require('./plan');
const orch = require('./orch');
const modes = require('./modes');
const profiles = require('./profiles');
const compressMod = require('./compress');
const verifyMod = require('./verify');
const mcpMod = require('./mcp');
const skillsMod = require('./skills');
const pmap = require('./projectmap');

const MAX_HISTORY = 50;
const MAX_PROMPT = 200000;
const MAX_TOOL_ITERS = 8; // legacy default; P26 uses per-profile limits
// P50-6: sub-agents. Spawn allowed only at depth 0, 3 spawns max per
// turn, fan-out max 3, child rounds capped (default 4, max 6).
const MAX_SUB_SPAWNS = 3;
const MAX_SUB_PARALLEL = 3;
// P50-3: bounded build-fix loop. Consecutive EXECUTED failures on these
// tools (any success resets) stop the turn honestly at MAX_BUILD_FIX.
const BUILD_FIX_TOOLS = ['bash', 'exec_start', 'exec_poll', 'write', 'edit', 'patch', 'append', 'mkdir', 'gen_check', 'mkignore', 'ci', 'sdk'];
const MAX_BUILD_FIX = 6;
const MAX_AGENTS_MD = 32 * 1024;

function homeOf(toolsCtx) {
  if (toolsCtx && toolsCtx.home) return String(toolsCtx.home);
  if (process.env.SUDO_STUDIO_HOME) return String(process.env.SUDO_STUDIO_HOME);
  try { return require('os').homedir(); } catch (_) { return process.cwd(); }
}

// P48(4): after a runtime_offline failure, wait for the supervised restart
// (each round emits onEvent { type: 'runtime.wait', attempt, maxAttempts,
// message }) and tell the caller whether a single retry is worthwhile.
// ctx: { provider, onEvent, shouldAbort?, waitOpts? }. waitOpts overrides
// { attempts, delayMs, probeTimeoutMs } (tests use short waits; production
// uses the waitForRuntime defaults: 5 x 10s, always <= 60s).
async function waitAndRetry(ctx) {
  const w = await waitForRuntime(ctx.provider, {
    attempts: ctx.waitOpts && ctx.waitOpts.attempts,
    delayMs: ctx.waitOpts && ctx.waitOpts.delayMs,
    probeTimeoutMs: ctx.waitOpts && ctx.waitOpts.probeTimeoutMs,
    shouldAbort: ctx.shouldAbort,
    onProgress: (n, max, message) => {
      try { ctx.onEvent({ type: 'runtime.wait', attempt: n, maxAttempts: max, message }); } catch (_) {}
    },
  });
  return { retry: !!(w.recovered && w.probe && w.probe.ok) };
}

// P52 item 1: an approval PAUSES the turn (resumable). Registers the
// pending request (operator-facing session id for orchestrated steps),
// emits turn.paused, and waits for resolveTurnApproval (operator) or an
// abort. Without a waiter registry (sub-turns) the caller keeps the
// legacy need_approval behavior. Resolves { legacy } | { aborted } |
// { decision } ('once'|'session'|'project'|'deny').
async function pauseForApproval(ctx) {
  const toolsCtx = ctx.toolsCtx;
  const waiters = (toolsCtx && toolsCtx.waiters) || null;
  const parentSession = (toolsCtx && toolsCtx.parentSessionId) || ctx.sessionId;
  try { (toolsCtx.pending || new Map()).set(ctx.request.id, { request: ctx.request, sessionId: parentSession, fullArgs: ctx.fullArgs }); } catch (_) {}
  if (!waiters) return { legacy: true };
  try { ctx.onEvent({ type: 'turn.paused', turnId: ctx.turnId, session: parentSession, requestId: ctx.request.id, tool: ctx.request.tool, summary: ctx.request.summary, pattern: ctx.request.pattern }); } catch (_) {}
  if (ctx.journal) { try { ctx.journal('info', 'tour en pause', { request: ctx.request.id, tool: ctx.request.tool }); } catch (_) {} }
  const verdict = await new Promise((resolve) => {
    const done = (v) => {
      try { clearInterval(iv); } catch (_) {}
      try { waiters.delete(ctx.request.id); } catch (_) {}
      resolve(v);
    };
    waiters.set(ctx.request.id, { resolve: done, sessionId: parentSession });
    const iv = setInterval(() => { if (ctx.runEntry.aborted) done({ decision: 'abort' }); }, 250);
    if (iv.unref) { try { iv.unref(); } catch (_) {} }
  });
  if (!verdict || verdict.decision === 'abort') return { aborted: true };
  if (ctx.journal) { try { ctx.journal('info', 'pause resolue', { request: ctx.request.id, decision: verdict.decision }); } catch (_) {} }
  return { decision: verdict.decision };
}

// Operator/test side of pauseForApproval. Returns false when no paused
// turn waits for this request (legacy direct-tool approvals).
function resolveTurnApproval(toolsCtx, requestId, decision) {
  try {
    const w = toolsCtx && toolsCtx.waiters ? toolsCtx.waiters.get(requestId) : null;
    if (!w || typeof w.resolve !== 'function') return false;
    try { if (toolsCtx.pending) toolsCtx.pending.delete(requestId); } catch (_) {}
    w.resolve({ decision });
    return true;
  } catch (_) { return false; }
}

// P52 item 10: tool results fed to the model are summarized past TOOLCAP
// (default 2000 chars): every long string becomes head + marker + tail.
// Short results pass through BYTE-IDENTICAL (legacy behavior kept).
function summarizeResult(text) {
  const cap = plan.intEnv('SUDO_AGENT_TOOLCAP', 2000);
  const s = String(text || '');
  const cut = (v) => {
    if (typeof v !== 'string' || v.length <= cap) return v;
    const head = Math.floor(cap * 0.6);
    return v.slice(0, head) + '\n...[resume : ' + v.length + ' caracteres]...\n' + v.slice(v.length - (cap - head));
  };
  try {
    const o = JSON.parse(s);
    let changed = false;
    const walk = (v) => {
      if (typeof v === 'string') { const c = cut(v); if (c !== v) changed = true; return c; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') { const o2 = {}; for (const k of Object.keys(v)) o2[k] = walk(v[k]); return o2; }
      return v;
    };
    const out = walk(o);
    return changed ? JSON.stringify(out) : s;
  } catch (_) {
    return cut(s);
  }
}

async function runTurn(opts) {
  opts = opts || {};
  const store = opts.store;
  const provider = opts.provider;
  const sessionId = opts.sessionId;
  const prompt = opts.prompt;
  const corr = opts.corr || 'turn';
  const log = opts.log || null;
  const runs = opts.runs;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const probeTimeoutMs = opts.probeTimeoutMs || 4000;

  const fail = (code, error) => {
    try { onEvent({ type: 'turn.error', code, error }); } catch (_) {}
    if (log) { try { log.warn('turn error', { session: sessionId, code }, corr); } catch (_) {} }
    return { status: 'error', code, error };
  };

  if (!store || !runs) return fail('internal', 'moteur agent indisponible.');
  if (!provider || typeof provider !== 'object') return fail('bad_config', 'provider non configure.');
  const session = store.get(sessionId);
  if (!session) return fail('not_found', 'session introuvable.');
  if (typeof prompt !== 'string' || !prompt.trim()) return fail('bad_request', 'prompt vide.');
  if (prompt.length > MAX_PROMPT) return fail('bad_request', 'prompt trop long.');
  if (runs.has(sessionId)) return fail('busy', 'un tour est deja en cours sur cette session.');

  const runtimeWait = opts.runtimeWait || null;
  let probe = opts.preProbe && typeof opts.preProbe === 'object' ? opts.preProbe : null;
  if (!probe) {
    try { probe = await probeProvider(provider, { timeoutMs: probeTimeoutMs }); }
    catch (e) { probe = { ok: false, code: 'provider_error', error: 'fournisseur indisponible.' }; }
    // P48(4): offline at turn start (direct runTurn callers): wait for the
    // supervised restart, then probe once more before giving up.
    if (!probe.ok && probe.code === 'runtime_offline') {
      const w0 = await waitAndRetry({ provider, onEvent, waitOpts: runtimeWait });
      if (w0.retry) {
        try { probe = await probeProvider(provider, { timeoutMs: probeTimeoutMs }); }
        catch (e) { probe = { ok: false, code: 'provider_error', error: 'fournisseur indisponible.' }; }
      }
    }
  }
  if (!probe.ok) return fail(probe.code || 'provider_error', probe.error || 'fournisseur indisponible.');
  const model = provider.model || (probe.models && probe.models[0]) || '';
  if (!model) return fail('no_model', 'Aucun modele charge sur le runtime local (liste des modeles vide).');

  store.append(sessionId, { role: 'user', content: prompt });
  const sessionNow = store.get(sessionId) || session;
  const useTools = !!opts.toolsCtx && sessionNow.projectRoot && opts.tools !== false;

  const base = { store, provider, sessionId, prompt, corr, log, runs, onEvent, model, probeTimeoutMs, preProbe: probe, verify: opts.verify, runtimeWait, maxIt: opts.maxIt, subDepth: opts.subDepth };
  if (useTools) return toolsTurn(base, sessionNow, opts.toolsCtx);
  return legacyTurn(base, sessionNow);
}

// ---------------------------------------------------------------------------
// Legacy single-turn (P24): stream the answer, no tools.
// ---------------------------------------------------------------------------
async function legacyTurn(base) {
  const { store, provider, sessionId, prompt, corr, log, runs, onEvent, model } = base;
  const history = (store.get(sessionId) || { messages: [] }).messages
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));
  const turnId = corr;
  const run = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
  runs.set(sessionId, run);
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}
  if (log) { try { log.info('turn start', { session: sessionId, model, history: history.length, promptChars: prompt.length }, corr); } catch (_) {} }
  let full = '';
  const streamOnce = () => streamChat(provider, history, {
    model,
    shouldAbort: () => run.aborted,
    onRequest: (req) => { run.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; },
    onToken: (delta, text) => {
      full = text;
      try { onEvent({ type: 'message.delta', text: delta }); } catch (_) {}
    },
  });
  try {
    let res = null;
    try {
      res = await streamOnce();
    } catch (e0) {
      // P48(4): runtime died (turn start or mid-stream): wait for the
      // supervised restart, then retry the stream once. The failed
      // stream produced no tool calls, so the retry is side-effect free.
      if (!e0 || e0.code !== 'runtime_offline' || run.aborted) throw e0;
      full = '';
      const wL = await waitAndRetry({ provider, onEvent,
        shouldAbort: () => run.aborted, waitOpts: base.runtimeWait });
      if (!wL.retry || run.aborted) throw e0;
      res = await streamOnce();
    }
    full = res.text || '';
    // P49-4: a stuck small model repeats itself: one guided retry (bounded,
    // keeps the first text if the retry fails).
    if (full && detectRepetition(full)) {
      if (log) { try { log.warn('repetition detectee', { session: sessionId, chars: full.length }, corr); } catch (_) {} }
      history.push({ role: 'user', content: 'Tu te repetes : reponds brievement, sans repeter deux fois la meme phrase.' });
      try {
        const res2 = await streamOnce();
        const t2 = (res2 && res2.text) || '';
        if (t2) full = t2;
      } catch (_) {}
      run.destroy = null;
    }
    store.append(sessionId, { role: 'assistant', content: full });
    try { onEvent({ type: 'message.done', text: full, aborted: false }); } catch (_) {}
    const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
    const doneEvt = { type: 'turn.done', turnId, messageCount, model, aborted: false, status: 'TERMINE', reason: '', filesModified: [], stopReason: 'declared' };
    try { onEvent(doneEvt); } catch (_) {}
    if (log) { try { log.info('turn done', { session: sessionId, replyChars: full.length, messageCount, status: 'TERMINE' }, corr); } catch (_) {} }
    return { status: 'done', model, messageCount, runStatus: 'TERMINE' };
  } catch (e) {
    if (e && e.code === 'aborted') {
      const partial = typeof e.partial === 'string' ? e.partial : full;
      store.append(sessionId, { role: 'assistant', content: partial, aborted: true });
      try { onEvent({ type: 'message.done', text: partial, aborted: true }); } catch (_) {}
      const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
      try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'aborted', filesModified: [], stopReason: 'aborted' }); } catch (_) {}
      if (log) { try { log.info('turn aborted', { session: sessionId, replyChars: partial.length }, corr); } catch (_) {} }
      return { status: 'aborted', model };
    }
    const code = (e && e.code) || 'provider_error';
    const error = (e && e.message) || 'Erreur du fournisseur.';
    if (log) { try { log.warn('turn failed', { session: sessionId, code }, corr); } catch (_) {} }
    try { onEvent({ type: 'turn.error', code, error }); } catch (_) {}
    return { status: 'error', code, error };
  } finally {
    if (runs.get(sessionId) === run) runs.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Question turn (P43-2). General questions: NO free tool exploration.
// A deterministic builder assembles map + preload + question context, then
// ONE streamed model call. On provider failure or empty reply: labelled
// deterministic fallback (why='question'). Same event vocabulary as
// toolsTurn (turn.start/message.delta/message.done/turn.done), runStatus
// TERMINE on success, PARTIEL + real text on fallback. Agent AND chat
// share it (both call runTurn -> toolsTurn -> here).
// ---------------------------------------------------------------------------
async function questionTurn(base, session, toolsCtx, root, mapText, mapInfo, preloadText) {
  const { store, provider, sessionId, corr, log, runs, onEvent, model } = base;
  const turnId = corr;
  const cloud = provider.type === 'cloud';
  const filter = (s) => (cloud ? maskSecrets(String(s === undefined || s === null ? '' : s)) : String(s === undefined || s === null ? '' : s));
  const journal = (level, event, fields) => { if (log) { try { log[level](event, Object.assign({ session: sessionId }, fields || {}), corr); } catch (_) {} } };
  const runEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
  runs.set(sessionId, runEntry);
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}

  // Deterministic context: map + preload (same strings toolsTurn built and
  // journaled) + bounded question context (README/manifest heads, fixed
  // order: same project -> same bytes).
  let qctx = { text: '', tokens: 0, files: [] };
  try {
    qctx = pmap.buildQuestionContext(root, mapInfo) || qctx;
  } catch (e) {
    journal('warn', 'contexte question impossible', { error: String((e && e.message) || e).slice(0, 120) });
  }
  // Bounded tail of the transcript (the current prompt is the last user
  // message): follow-ups stay answerable, cost stays bounded.
  let tail = [];
  try {
    tail = (store.get(sessionId) || { messages: [] }).messages.slice(-6).map((m) => {
      if (m.role === 'user' || m.role === 'system') return { role: m.role, content: filter(m.content) };
      if (m.role === 'assistant') return { role: 'assistant', content: filter(m.content || '') };
      return { role: 'user', content: '[outil] ' + filter(m.content || '').slice(0, 2000) };
    });
  } catch (_) { tail = []; }
  if (!tail.length || tail[tail.length - 1].role !== 'user') {
    tail.push({ role: 'user', content: filter(base.prompt) });
  }
  const messages = [{ role: 'system', content: 'You are Sudo Agent. Answer the question about this project briefly, from the context. No tools.' }];
  if (mapText) messages.push({ role: 'system', content: mapText });
  if (preloadText) messages.push({ role: 'system', content: preloadText });
  if (qctx.text) messages.push({ role: 'system', content: qctx.text });
  for (const m of tail) messages.push(m);
  journal('info', 'question envoyee', { tokens: profiles.estimateTokens(messages, 0), files: qctx.files.join(','), history: tail.length });

  let full = '';
  const streamOnce = () => streamChat(provider, messages, {
    model,
    shouldAbort: () => runEntry.aborted,
    onToken: (tok) => { try { onEvent({ type: 'message.delta', text: tok }); } catch (_) {} },
    onRequest: (req) => { runEntry.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; },
  });
  try {
    const res = await streamOnce();
    full = String((res && res.text) || '').trim();
  } catch (e) {
    if (e && e.code === 'aborted') {
      store.append(sessionId, { role: 'assistant', content: full, aborted: true });
      try { onEvent({ type: 'message.done', text: full, aborted: true }); } catch (_) {}
      const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
      try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'aborted', filesModified: [], stopReason: 'aborted' }); } catch (_) {}
      journal('info', 'question annulee');
      if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
      return { status: 'aborted', model };
    }
    // P48(4): runtime died: wait for the supervised restart and retry the
    // single call once before falling back to the deterministic answer.
    if (e && e.code === 'runtime_offline' && !runEntry.aborted) {
      const wQ = await waitAndRetry({ provider, onEvent,
        shouldAbort: () => runEntry.aborted, waitOpts: base.runtimeWait });
      if (wQ.retry && !runEntry.aborted) {
        try {
          const res2 = await streamOnce();
          full = String((res2 && res2.text) || '').trim();
        } catch (e2) {
          journal('warn', 'question echouee', { code: (e2 && e2.code) || 'provider_error' });
          full = '';
        }
      } else {
        journal('warn', 'question echouee', { code: 'runtime_offline' });
        full = '';
      }
    } else {
      journal('warn', 'question echouee', { code: (e && e.code) || 'provider_error' });
      full = '';
    }
  } finally {
    runEntry.destroy = null;
  }
  // P49-4: a stuck small model repeats itself: one guided retry (bounded,
  // keeps the first text if the retry fails).
  if (full && !runEntry.aborted && detectRepetition(full)) {
    journal('warn', 'repetition detectee', { chars: full.length });
    messages.push({ role: 'user', content: 'Tu te repetes : reponds brievement, sans repeter deux fois la meme phrase.' });
    try {
      const resR = await streamOnce();
      const tR = String((resR && resR.text) || '').trim();
      if (tR) full = tR;
    } catch (_) {}
    runEntry.destroy = null;
  }
  let runStatus = 'TERMINE';
  let reason = '';
  if (!full && !runEntry.aborted) {
    full = pmap.deterministicFallback({ root, map: mapInfo, calls: [], prompt: base.prompt, why: 'question' });
    runStatus = 'PARTIEL';
    reason = 'fournisseur sans reponse (un seul appel).';
    journal('warn', 'reponse secours deterministe', { chars: full.length, why: 'question' });
  }
  store.append(sessionId, { role: 'assistant', content: full });
  if (!reason) journal('info', 'question repondue', { chars: full.length });
  try { onEvent({ type: 'message.done', text: full, aborted: false }); } catch (_) {}
  const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
  try {
    onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: false, status: runStatus, reason, filesModified: [], stopReason: 'question',
      declaredDone: true, toolCalls: 0, unresolvedErrors: [] });
  } catch (_) {}
  if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
  return { status: 'done', model, messageCount, runStatus };
}

// ---------------------------------------------------------------------------
// Tool turn (P25 + P26).
// ---------------------------------------------------------------------------
function readAgentsMd(root) {
  try {
    const st = fs.statSync(path.join(root, 'AGENTS.md'));
    if (!st.isFile() || st.size > MAX_AGENTS_MD) return null;
    return fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  } catch (_) { return null; }
}

function toProviderMessages(stored, cloud) {
  const out = [];
  for (const m of stored) {
    if (m.role === 'user' || m.role === 'system') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsText || '{}' } }));
      }
      out.push(msg);
      continue;
    }
    if (m.role === 'tool') {
      const content = cloud ? maskSecrets(m.content) : m.content;
      out.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content });
    }
  }
  return out;
}

// Unresolved = error entries (except clean policy denials, plan refusals and
// skipped extra calls) with no later success on the same tool+target.
// P49: file-mutating tools gated by the recon rule on improvement intents
// (bash stays available: it is also the execute/verify vehicle).
const FILE_MUTATING = ['write', 'edit', 'patch', 'delete', 'rename', 'append', 'mkdir'];
// P52: loop guard v2 counts COMPLETED calls only (executed, done or error)
// on state-changing tools (mcp__* included via prefix). Reads, approvals,
// denials, guidance and skips never feed the guard.
const GUARD_TOOLS = ['write', 'edit', 'patch', 'append', 'mkdir', 'delete', 'rename', 'bash', 'exec_start', 'exec_poll', 'exec_stop', 'gen_start', 'gen_check', 'gen_phase', 'gen_restore', 'mkignore', 'ci', 'sdk', 'subagent'];
const GUARD_SKIP_CODES = ['need_approval', 'asked', 'denied', 'deploy_policy', 'no_project', 'unknown_tool', 'skipped', 'plan_mode', 'bad_args', 'corrective', 'exists'];

// P49: driver-side guidance codes are not failures: a rejected reply/done
// (open todos, no plan, recon missing, verify still running) teaches the
// model the rules.
// P52: engine_todos (model-side todo refused), corrective (loop-guard
// restriction) and exists (write is create-only: use edit/append) join
// them; todos_open/no_plan stay listed so old transcripts never poison
// new verdicts.
const GUIDANCE_CODES = ['todos_open', 'no_plan', 'engine_todos', 'recon_required', 'verify', 'corrective'];

// P49-4: same sentence 3+ times in one reply = a stuck small model.
// Pure (unit-tested): returns { repeated, count } or null.
function detectRepetition(text) {
  const parts = String(text || '').split(/[.!?\u2026\n;]+/)
    .map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 20);
  const seen = new Map();
  for (const p of parts) {
    const n = (seen.get(p) || 0) + 1;
    seen.set(p, n);
    if (n >= 3) return { repeated: p.slice(0, 160), count: n };
  }
  return null;
}

function unresolvedErrors(calls) {
  const bad = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c.ok || c.code === 'denied' || c.code === 'asked' || c.code === 'plan_mode' || c.code === 'skipped' ||
        GUIDANCE_CODES.indexOf(c.code) !== -1) continue;
    let fixed = false;
    for (let j = i + 1; j < calls.length; j++) {
      // P26-b: a parse error is recovered by ANY later successful action
      // (the retry worked); other errors need the same tool+target fixed.
      // P52: an 'exists' refusal is recovered by ANY later success on the
      // same target (write -> edit recovery); unrecovered it stands (ECHEC).
      if (!calls[j].ok) continue;
      if (c.code === 'bad_args') { fixed = true; break; }
      if (c.code === 'exists' && c.target && calls[j].target === c.target) { fixed = true; break; }
      if (calls[j].tool === c.tool && calls[j].target === c.target) { fixed = true; break; }
    }
    if (!fixed) bad.push(c);
  }
  return bad;
}

function computeRunStatus(declared, calls) {
  const unresolved = unresolvedErrors(calls);
  if (!declared) return { status: 'PARTIEL', reason: 'iterations max atteintes sans reponse finale.', unresolved };
  if (unresolved.length) {
    const names = unresolved.slice(0, 5).map((c) => c.tool + ':' + (c.code || 'error')).join(', ');
    return { status: 'ECHEC', reason: 'erreurs d\'outil non resolues : ' + names + '.', unresolved };
  }
  return { status: 'TERMINE', reason: '', unresolved };
}

function probeNctx(preProbe, model) {
  try {
    const details = preProbe && Array.isArray(preProbe.details) ? preProbe.details : [];
    let hit = details.filter((d) => d && d.id === model)[0] || details[0];
    const n = hit ? parseInt(hit.n_ctx, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) { return 0; }
}

async function toolsTurn(base, session, toolsCtx) {
  const { store, provider, sessionId, corr, log, runs, onEvent, model } = base;
  const runtimeWait = base.runtimeWait || null;
  const turnId = corr;
  const home = homeOf(toolsCtx);
  const cloud = provider.type === 'cloud';
  const filter = (s) => (cloud ? maskSecrets(String(s === undefined || s === null ? '' : s)) : String(s === undefined || s === null ? '' : s));
  const journal = (level, event, fields) => { if (log) { try { log[level](event, Object.assign({ session: sessionId }, fields || {}), corr); } catch (_) {} } };

  // Project root must exist; realpath it (symlinked TMPDIR and friends).
  let root = null;
  try {
    const st = fs.statSync(session.projectRoot);
    if (!st.isDirectory()) throw new Error('not a dir');
    try { root = fs.realpathSync(session.projectRoot); } catch (_) { root = session.projectRoot; }
  } catch (_) {
    const error = 'dossier de projet invalide : ' + String(session.projectRoot).slice(0, 200);
    try { onEvent({ type: 'turn.error', code: 'bad_project', error }); } catch (_) {}
    return { status: 'error', code: 'bad_project', error };
  }

  // P39-a: project map, rebuilt every turn (fresh in Build mode: files may
  // have changed). Agent AND chat share toolsTurn, so both get the map.
  // Journaled on first build and whenever the text changes (proof line).
  let mapText = '';
  let mapInfo = null;
  try {
    const built = pmap.buildProjectMap(root);
    if (built.ok) {
      mapText = built.text;
      mapInfo = built;
      let prev = null;
      try { prev = (store.get(sessionId) || {}).meta || null; } catch (_) { prev = null; }
      const prevText = prev && prev.projectMap ? prev.projectMap.text : null;
      if (prevText !== mapText) {
        try {
          store.update(sessionId, (s) => {
            if (!s.meta) s.meta = {};
            s.meta.projectMap = { root, text: mapText, tokens: built.tokens,
              entries: built.entries, type: built.type, at: new Date().toISOString() };
          });
        } catch (_) {}
        journal('info', prevText === null ? 'carte projet injectee' : 'carte projet mise a jour',
          { entries: built.entries, type: built.type, tokens: built.tokens, truncated: !!built.truncated });
      }
    } else {
      journal('warn', 'carte projet impossible', { error: String(built.error || '').slice(0, 120) });
    }
  } catch (e) {
    journal('warn', 'carte projet erreur', { error: String((e && e.message) || e).slice(0, 120) });
    mapText = '';
    mapInfo = null;
  }

  // P39-c: general questions get README + manifests + deterministic
  // mini-analysis in context before the first model call.
  let preloadText = '';
  try {
    if (mapText && pmap.isGeneralQuestion(base.prompt)) {
      const pre = pmap.buildPreload(root, mapInfo);
      if (pre && pre.text) {
        preloadText = pre.text;
        journal('info', 'contexte general precharge', { tokens: pre.tokens });
      }
    }
  } catch (e) {
    journal('warn', 'precharge impossible', { error: String((e && e.message) || e).slice(0, 120) });
  }

  // P49-1: ACTION/QUESTION router (classification is journaled proof).
  // ACTION turns take the strict tool loop below (tool call forced, honest
  // verdict). QUESTION keeps the single-call path. AMBIGUOUS keeps the
  // legacy loop behavior (free text may still declare).
  // P52 item 4: resolve a pending Reprendre/Abandonner choice FIRST (the
  // effective prompt may be the STORED one). QUESTIONs never block: an
  // unrelated message implicitly abandons stale todos (journaled) and
  // runs as a new demand.
  const abandonMs = plan.intEnv('SUDO_AGENT_ABANDON_MS', 1800000);
  const pendResolve = plan.resolvePendingChoice(store, sessionId, turnId, base.prompt, abandonMs);
  if (pendResolve) {
    journal('info', 'choix precedent resolu', { action: pendResolve.action });
    if (pendResolve.effective !== base.prompt) {
      store.append(sessionId, { role: 'user', content: pendResolve.note + '\nDemande : ' + pendResolve.effective });
      base.prompt = pendResolve.effective;
    }
  }
  const intent = classifyAction(base.prompt);
  journal('info', 'intention classee', { kind: intent.kind, verbs: intent.verbs.join(','), expectsChange: intent.expectsChange, collective: intent.collective, improvement: intent.improvement, taskItems: intent.taskItems.length });
  // P43-2: QUESTIONS take the single-call path (no free tool exploration).
  // The map + preload above are shared, so the journal keeps the same
  // proof lines ('carte projet injectee', 'contexte general precharge').
  if (intent.kind === 'QUESTION') {
    return questionTurn(base, session, toolsCtx, root, mapText, mapInfo, preloadText);
  }
  // P52 item 4: ACTION turns with stale engine todos (open, from a
  // previous turn) do not start blind: over-delay ones auto-abandon,
  // the rest ask Reprendre/Abandonner (a completed turn; the reply
  // resolves it). QUESTION never blocks (returned above).
  if (intent.kind !== 'QUESTION') {
    const stale = plan.openStale(store, sessionId, turnId);
    if (stale.length) {
      const split = plan.splitStaleByAge(store, sessionId, stale, abandonMs);
      if (split.auto.length) journal('info', 'todos auto-abandonnes', { count: split.auto.length });
      if (split.fresh.length) {
        plan.setPendingChoice(store, sessionId, split.fresh.map((t) => t.id), base.prompt);
        const choiceEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
        runs.set(sessionId, choiceEntry);
        try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}
        const choiceText = plan.choiceMessage(split.fresh, base.prompt);
        store.append(sessionId, { role: 'assistant', content: choiceText });
        try { onEvent({ type: 'message.done', text: choiceText, aborted: false }); } catch (_) {}
        const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
        try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: false, status: 'PARTIEL', reason: 'await_choice', filesModified: [], stopReason: 'await_choice', declaredDone: true, toolCalls: 0, unresolvedErrors: [] }); } catch (_) {}
        journal('info', 'choix demande', { stale: split.fresh.length });
        if (runs.get(sessionId) === choiceEntry) runs.delete(sessionId);
        return { status: 'done', model, messageCount, runStatus: 'PARTIEL' };
      }
    }
  }

  // P26-a/b: mode, size profile, context budget.
  const mode = modes.getMode(session);
  const profile = profiles.selectProfile({ modelId: model, providerType: provider.type, override: provider.profile || process.env.SUDO_AGENT_PROFILE });
  // P50-6: sub-turns cap their rounds via base.maxIt (1..10).
  let maxIt = profiles.maxIters(profile);
  if (base.maxIt !== undefined && base.maxIt !== null) {
    const m = parseInt(base.maxIt, 10);
    if (Number.isFinite(m)) maxIt = Math.min(10, Math.max(1, m));
  }
  const subDepth = base.subDepth || 0; // P50-6: spawn allowed only at depth 0
  const ctxTokens = profiles.resolveCtxTokens({ override: process.env.SUDO_AGENT_CTX_TOKENS, probeNctx: probeNctx(base.preProbe, model), providerType: provider.type });

  const runEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
  runs.set(sessionId, runEntry);
  const run = { id: turnId, sessionId, checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: runEntry.killFns };
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}

  const agentsMd = readAgentsMd(root);
  // P50-2: active skills (global + project) injected as system context.
  // Failures never break a turn; they are journaled instead.
  let skillsText = '';
  try {
    const sk = skillsMod.activeSkillsText(home, root);
    skillsText = sk.text || '';
    for (const s of sk.skipped) journal('warn', 'skill ignore', { skill: s.name, error: String(s.error).slice(0, 80) });
    if (sk.used.length) journal('info', 'skills actifs', { skills: sk.used });
  } catch (e) {
    journal('warn', 'skills illisibles', { error: String((e && e.message) || e).slice(0, 120) });
  }

  const sessionRulesMap = (toolsCtx && toolsCtx.sessionRules) || new Map();
  if (!sessionRulesMap.has(sessionId)) sessionRulesMap.set(sessionId, new Set());
  const projRules = loadProjectRules(home, root);

  const tctx = {
    root, sessionId, session, store, log, corr, run, home, mode,
    sessionRules: sessionRulesMap.get(sessionId),
    projectRules: projRules.rules,
    sessionKill: runEntry.killFns,
    checkpoint: null,
  };
  tctx.checkpoint = () => ensureSeriesCheckpoint(tctx);

  // P26-b/e: tool schemas for the profile + (full only) policy-allowed MCP tools.
  const schemas = toOpenAISchema(profile);
  if (profile === 'full') {
    let servers = {};
    try { servers = mcpMod.loadConfig(home); } catch (_) { servers = {}; }
    for (const srv of Object.keys(servers)) {
      try {
        const listed = await mcpMod.listTools(home, srv, (m) => journal('info', 'mcp', { msg: m }));
        for (const t of listed) {
          if (!t || !t.name || !mcpMod.isAllowed(home, srv, t.name)) continue;
          schemas.push({ type: 'function', function: {
            name: 'mcp__' + srv + '__' + t.name,
            description: ('MCP ' + srv + '/' + t.name + ': ' + String(t.description || '')).slice(0, 400),
            parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object' },
          } });
        }
      } catch (e) {
        journal('warn', 'mcp list failed', { server: srv, error: String((e && e.message) || e).slice(0, 160) });
      }
    }
  }
  const schemaChars = JSON.stringify(schemas).length;

  const modelMessages = () => {
    const stored = (store.get(sessionId) || { messages: [] }).messages.slice(-MAX_HISTORY);
    const out = toProviderMessages(stored, false);
    if (agentsMd) out.unshift({ role: 'system', content: 'Project instructions (AGENTS.md):\n' + filter(agentsMd) });
    let sys = modes.modeSystem(mode, profile); // P43-3: terse system on small
    const note = profiles.chunkNote(profile);
    if (note) sys += '\n' + note;
    out.unshift({ role: 'system', content: sys });
    // P39-a/c: map then preload, right after the system prompt (both are
    // counted by the context estimate, P39-e).
    if (preloadText) out.splice(1, 0, { role: 'system', content: preloadText });
    if (mapText) out.splice(1, 0, { role: 'system', content: mapText });
    // P50-2: skills after map/preload (counted by the context estimate).
    if (skillsText) out.splice(1 + (mapText ? 1 : 0) + (preloadText ? 1 : 0), 0, { role: 'system', content: filter(skillsText) });
    return out;
  };
  // Field named `ctx` (not ctxTokens): the journal masks *token* substrings.
  // P39-e: initial estimate covers system prompt + schemas + map + preload.
  const est0 = profiles.estimateTokens(modelMessages(), schemaChars);
  journal('info', 'turn start', { model, tools: true, mode, profile, ctx: ctxTokens, est0,
    mapTokens: mapInfo ? mapInfo.tokens : 0, preload: preloadText ? preloadText.length : 0,
    agentsMd: agentsMd ? agentsMd.length : 0 });
  if (est0 > ctxTokens * 0.75) {
    journal('warn', 'contexte initial eleve', { est0, ctx: ctxTokens });
  }
  // P43-3: per-part budget table (same chars/4 estimator): proves where the
  // context goes and makes every saturation diagnosable. Field values are
  // plain numbers (nothing secret-shaped, nothing *token*-named).
  try {
    const mm = modelMessages();
    let mmChars = 0;
    let resChars = 0;
    for (const m of mm) {
      const c = (m && typeof m.content === 'string') ? m.content.length : 0;
      mmChars += c;
      if (m && m.role === 'tool') resChars += c;
    }
    const sysChars = modes.modeSystem(mode, profile).length + profiles.chunkNote(profile).length + (agentsMd ? agentsMd.length : 0) + (skillsText ? skillsText.length : 0);
    const mapChars = mapText.length + preloadText.length;
    const budget = profiles.tokenBudget({ system: sysChars, tools: schemaChars, map: mapChars,
      history: Math.max(0, mmChars - sysChars - mapChars - resChars), results: resChars });
    journal('info', 'budget parties', Object.assign({ ctx: ctxTokens }, budget));
  } catch (_) {}

  const currentFilesModified = () => {
    if (!run.checkpointName || !run.snapshot) return [];
    try {
      const d = diffSnapshot(root, run.snapshot, {});
      return d.changed.map((f) => '~' + f).concat(d.created.map((f) => '+' + f), d.deleted.map((f) => '-' + f));
    } catch (_) { return []; }
  };

  // P26-c: compress history past 75% of the context size. Returns
  // { ok:true } or { ok:false, reason } (honest stop, never silent loss).
  const maybeCompress = async () => {
    const est = profiles.estimateTokens(modelMessages(), schemaChars);
    if (est <= ctxTokens * 0.75) return { ok: true, compressed: false };
    const stored = (store.get(sessionId) || { messages: [] }).messages;
    if (stored.length <= 5) return { ok: false, reason: 'contexte sature (' + est + ' tokens estimes pour ' + ctxTokens + ', historique trop court pour compresser).' };
    const old = stored.slice(0, -4).map((m) => {
      let c = m.content || '';
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) c += '\n[appels: ' + m.tool_calls.map((t) => t.name).join(', ') + ']';
      return { role: m.role === 'tool' ? 'user' : m.role, content: ('[' + m.role + '] ' + c).slice(0, 2000) };
    });
    let summary = '';
    try {
      const r = await chatOnce(provider, { model, messages: [{ role: 'system', content: compressMod.summarizePrompt() }].concat(old) });
      summary = String(r.text || '').trim();
    } catch (e) {
      journal('warn', 'compression failed', { error: String((e && e.message) || e).slice(0, 160) });
      summary = '';
    }
    if (!summary) return { ok: false, reason: 'compression du contexte echouee (resume vide).' };
    store.setMessages(sessionId, compressMod.spliceHistory(summary, stored, 4));
    journal('info', 'contexte compresse', { before: stored.length, summaryChars: summary.length });
    const est2 = profiles.estimateTokens(modelMessages(), schemaChars);
    if (est2 > ctxTokens) return { ok: false, reason: 'contexte sature meme apres compression (' + est2 + ' / ' + ctxTokens + ').' };
    return { ok: true, compressed: true };
  };

  // P26-d: verify loop. After modifications, run the detected project check
  // command(s) under permissions; feed failures back (2 rounds max).
  // Returns 'done' (finalize), 'continue' (failures fed, keep looping) or
  // 'stop' (stopReason/stopDetail set).
  let verifyRounds = 0;
  let stopReason = '';
  let stopDetail = '';
  const maybeVerify = async () => {
    if (mode !== 'build') return 'done';
    if (base.verify === false) { journal('info', 'verify ignore (desactive)'); return 'done'; }
    if (!currentFilesModified().length) { journal('info', 'verify ignore (aucun fichier modifie)'); return 'done'; }
    const checks = verifyMod.detectChecks(root);
    if (!checks.length) { journal('info', 'verify: aucune commande detectee'); return 'done'; }
    const failures = [];
    for (const c of checks) {
      if (runEntry.aborted) return 'stop';
      let r = null;
      try { r = await executeTool(tctx, 'bash', { command: c.command }, {}); }
      catch (e) { r = { status: 'error', reason: String((e && e.message) || e).slice(0, 300) }; }
      if (r.status === 'need-approval') {
        // P52: verify approvals pause like any other (no waiter: legacy stop).
        const paused = await pauseForApproval({ toolsCtx, sessionId, runEntry, onEvent, turnId, journal, request: r.request, fullArgs: { command: c.command } });
        if (paused.aborted) return 'stop';
        if (paused.legacy) {
          stopReason = 'verify_approval';
          stopDetail = 'verification en attente d\'approbation (' + r.request.id + ' : ' + c.command.slice(0, 120) + ').';
          return 'stop';
        }
        if (paused.decision === 'deny') {
          r = { status: 'denied', reason: 'verification refusee par l\'operateur.' };
        } else {
          try { r = await executeTool(tctx, 'bash', { command: c.command }, { preApproved: true }); }
          catch (e) { r = { status: 'error', reason: String((e && e.message) || e).slice(0, 300) }; }
          if (r.status === 'need-approval') {
            stopReason = 'verify_approval';
            stopDetail = 'verification en attente d\'approbation (' + r.request.id + ' : ' + c.command.slice(0, 120) + ').';
            return 'stop';
          }
        }
      }
      if (r.status === 'denied') {
        stopReason = 'verify_denied';
        stopDetail = 'verification refusee : ' + String(r.reason || '').slice(0, 200);
        return 'stop';
      }
      if (r.status !== 'done') {
        failures.push({ check: c, reason: String(r.reason || 'echec.').slice(0, 500) });
        continue;
      }
      journal('info', 'verify pass', { check: c.name });
    }
    if (!failures.length) return 'done';
    if (verifyRounds >= 2) {
      for (const f of failures) {
        run.calls.push({ tool: 'bash', target: f.check.command, ok: false, code: 'verify_failed', ms: 0, at: new Date().toISOString(), summary: f.reason.slice(0, 300) });
      }
      journal('warn', 'verify failed', { rounds: verifyRounds, checks: failures.map((f) => f.check.name).join(', ') });
      stopReason = 'verify_failed';
      return 'done'; // finalize: declared + unresolved => ECHEC (honest)
    }
    verifyRounds += 1;
    const body = failures.map((f) => '- ' + f.check.name + ' (' + f.check.command + ') : ' + f.reason).join('\n');
    store.append(sessionId, { role: 'user', content: 'VERIFICATION ECHOUEE (essai ' + verifyRounds + '/2) :\n' + body + '\nCorrige le probleme puis reponds.' });
    journal('warn', 'verify fail, retry', { round: verifyRounds, checks: failures.map((f) => f.check.name).join(', ') });
    return 'continue';
  };

  // P49-1: strict ACTION regime. QUESTION/AMBIGUOUS keep their historical
  // behavior bit for bit (chatOpts empty => byte-identical payloads).
  const strictAction = intent.kind === 'ACTION';
  const runOnly = strictAction && !intent.expectsChange;
  const chatOpts = strictAction
    ? { toolChoice: 'required', sampling: { temperature: 0.15, topP: 0.9, topK: 40, repeatPenalty: 1.12, maxTokens: 1200 } }
    : {};
  const roundOnce = () => chatOnce(provider, Object.assign({ model, messages: modelMessages(), tools: schemas,
    onRequest: (req) => { runEntry.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; } },
  chatOpts));
  // P49-1: constrained repair: free text is never a valid ACTION output.
  // Up to 2 driver retries with an explicit order, then an honest stop.
  const actionRepair = async (why) => {
    for (let a = 0; a < 2; a++) {
      if (runEntry.aborted) return null;
      journal('warn', 'reparation contrainte', { attempt: a + 1, why: String(why).slice(0, 120) });
      store.append(sessionId, { role: 'user', content: 'RAPPEL STRICT : ' + why + ' Tu DOIS emettre exactement UN appel d\'outil maintenant (aucun texte libre). Si la tache est vraiment finie, appelle done ou reply ; sinon agis avec read/list/grep/write/edit.' });
      let r2 = null;
      try {
        r2 = await roundOnce();
      } catch (e) {
        // Same P48 rule as the main site: wait for the supervised restart.
        if (!e || e.code !== 'runtime_offline' || runEntry.aborted) throw e;
        const wR = await waitAndRetry({ provider, onEvent,
          shouldAbort: () => runEntry.aborted, waitOpts: runtimeWait });
        if (!wR.retry || runEntry.aborted) throw e;
        r2 = await roundOnce();
      } finally {
        runEntry.destroy = null;
      }
      const c2 = Array.isArray(r2.toolCalls) ? r2.toolCalls : [];
      if (c2.length) return r2;
    }
    return null;
  };
  // P49-2: constrained re-attempt prompt (whole-turn retry, history kept).
  const constrainedPrompt = (n) => 'RELANCE CONTRAINTE ' + n + '/2 : ta precedente tentative s\'est terminee sans AUCUNE modification verifiee. Recommence : constate (list/grep/read), agis (UN appel d\'outil a la fois), puis termine via done/reply. Le texte libre ne termine rien.';
  // P52: NO finish gate over todos (item 3): a reply/done is never
  // refused for open or missing todos. The engine verifies each step on
  // disk; the appendix reports the plan honestly.
  let reconDone = false;
  // P52: the ENGINE owns the plan (the model never manages todos).
  // Pasted lists, collective actions and semicolon-numbered prompts seed
  // session todos driver-side; each step carries its disk verifier.
  // Long plans (>= LONG_STEPS) run orchestrated instead (disjoint path).
  // noOrchPlan (orchestrated step children): execute ONE step, never
  // re-plan (the prev summary looks like a task list) nor re-orchestrate
  // (anti-recursion). Verification happens at the orch level.
  const noOrchPlan = !!(toolsCtx && toolsCtx.noOrchPlan);
  const seedTexts = noOrchPlan ? [] : plan.parseSteps(base.prompt, intent.taskItems || []);
  const wantPlan = !noOrchPlan && mode === 'build' && (strictAction || (intent.kind === 'AMBIGUOUS' && (intent.hasTaskList || seedTexts.length >= 2)));
  const orchTexts = (wantPlan && seedTexts.length >= orch.longSteps()) ? seedTexts : [];
  // P52-7: explicit resume words revive the most recent unfinished
  // orchestrated plan (crash/stop/close recovery). Anything else starts
  // a fresh plan (never hijacks an old one implicitly).
  let orchResumeId = null;
  // noResume (orch/subagent children): executors never trigger a resume.
  // Backstop: a turn never resumes its own orch plan (anti-recursion).
  const ownOrchPlan = (session.meta && session.meta.orchPlan) || '';
  if (mode === 'build' && intent.kind !== 'QUESTION' && !(toolsCtx && toolsCtx.noResume) && /reprend|resume|continu/i.test(base.prompt)) {
    try {
      const dir = path.join(root, '.sudo-agent');
      const files = fs.readdirSync(dir).filter((f) => f.indexOf('orch-') === 0 && f.slice(-5) === '.json').sort();
      for (let i = files.length - 1; i >= 0; i--) {
        const pid = files[i].slice(5, -5);
        if (pid === ownOrchPlan) continue;
        const st = orch.loadState(root, pid);
        if (st && st.steps.some((x) => x && (x.status === 'pending' || x.status === 'failed'))) { orchResumeId = pid; break; }
      }
    } catch (_) {}
    journal('info', orchResumeId ? 'reprise plan orchestre' : 'reprise sans plan', { plan: orchResumeId || '' });
  }
  let enginePlan = [];
  if (wantPlan && !orchTexts.length && !orchResumeId && seedTexts.length) {
    try {
      const seeded = plan.seedPlan(store, sessionId, turnId, plan.buildPlan(seedTexts), root);
      enginePlan = seeded.todos;
      journal('info', 'plan moteur ensemence', { steps: enginePlan.length });
      store.append(sessionId, { role: 'user', content: plan.planNote(enginePlan) });
    } catch (e) {
      journal('warn', 'plan moteur impossible', { error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  let declared = false;
  let finalText = '';
  let iters = 0;
  let subSpawns = 0;
  let childSeq = 0;
  let buildFixFails = 0;
  let buildFixStop = false;
  const guard = plan.createLoopGuard();
  let loopStop = false;
  let pauseAborted = false;
  let orchVerdict = null;
  let attempt = 0;
  const MAX_ATTEMPTS = (strictAction && mode === 'build') ? 3 : 1;
  try {
  // P52 loop guard v2: a loop stop NEVER ends without an answer. Last
  // round WITHOUT tools (answer from what is collected), else a labelled
  // deterministic fallback. Status stays PARTIEL (loop happened).
  const rescueAnswer = async (what) => {
    if (runEntry.aborted) return;
    try {
      const rescue = await chatOnce(provider, { model,
        messages: modelMessages().concat([{ role: 'user',
          content: 'STOP OUTILS : tu as repete le meme appel malgre la strategie corrective (' + String(what || '?') +
            '). SANS appeler d\'outils, reponds avec ce qui est deja collecte. ' +
            'Si vraiment impossible, dis-le brievement.' }]),
      });
      const rt = String((rescue && rescue.text) || '').trim();
      if (rt) {
        finalText = rt;
        store.append(sessionId, { role: 'assistant', content: finalText });
        journal('info', 'reponse secours IA', { chars: rt.length });
      }
    } catch (e) {
      journal('warn', 'reponse secours IA echouee', { error: String((e && e.message) || e).slice(0, 160) });
    }
    if (!finalText) {
      finalText = pmap.deterministicFallback({ root, map: mapInfo, calls: run.calls, loopKey: String(what || '?'), prompt: base.prompt });
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('warn', 'reponse secours deterministe', { chars: finalText.length });
    }
  };
    for (attempt = 0; attempt < ((orchTexts.length || orchResumeId) ? 0 : MAX_ATTEMPTS); attempt++) {
      if (attempt > 0) {
        // P49-2: constrained re-attempt: strong order, fresh round budget.
        store.append(sessionId, { role: 'user', content: constrainedPrompt(attempt) });
        declared = false; finalText = ''; loopStop = false; pauseAborted = false; guard.reset();
        stopReason = ''; stopDetail = '';
        journal('warn', 'relance contrainte', { attempt: attempt + 1, max: MAX_ATTEMPTS });
      }
    for (iters = 0; iters < maxIt; iters++) {
      if (runEntry.aborted) break;
      const cmp = await maybeCompress();
      if (!cmp.ok) { stopReason = 'context'; stopDetail = cmp.reason; break; }
      let reply = null;
      try {
        reply = await roundOnce();
      } catch (e) {
        // Provider without tool support: fall back to ONE legacy streamed turn.
        if (e && e.status === 400 && iters === 0) {
          journal('warn', 'tools unsupported, legacy fallback');
          return legacyTurn({ store, provider, sessionId, prompt: base.prompt, corr, log, runs, onEvent, model, runtimeWait });
        }
        // P48(4): runtime died mid-turn: wait for the supervised restart,
        // then retry this round once. The failed round produced no model
        // response, so history is unchanged and the retry is safe.
        if (!e || e.code !== 'runtime_offline' || runEntry.aborted) throw e;
        const wT = await waitAndRetry({ provider, onEvent,
          shouldAbort: () => runEntry.aborted, waitOpts: runtimeWait });
        if (!wT.retry || runEntry.aborted) throw e;
        reply = await roundOnce();
      } finally {
        runEntry.destroy = null;
      }
      let calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      // P49-1: free text NEVER ends an ACTION turn: constrained repair
      // (2 driver retries), then an honest no_tool stop.
      if (!calls.length && strictAction && !runEntry.aborted) {
        const fix = await actionRepair('reponse sans appel d\'outil (texte libre interdit pour une ACTION)');
        if (fix) { reply = fix; calls = Array.isArray(fix.toolCalls) ? fix.toolCalls : []; }
        else { stopReason = 'no_tool'; stopDetail = 'le modele n\'emet aucun appel d\'outil (reparations contraintes epuisees).'; break; }
      }
      if (!calls.length) {
        // P52: same catch-up sweep on the free-text declare path.
        try {
          const swept = plan.sweepVerify(store, sessionId, root, true);
          if (swept.length) journal('info', 'plan verifie (solde)', { steps: swept.length });
        } catch (_) {}
        const v = await maybeVerify();
        if (v === 'continue') continue;
        if (v === 'stop') break;
        declared = true;
        finalText = reply.text || '';
        store.append(sessionId, { role: 'assistant', content: finalText });
        break;
      }
      // P26-a: ONE action per step. The first call runs; extras are skipped
      // (with their own tool message so the transcript stays valid).
      store.append(sessionId, { role: 'assistant', content: reply.text || '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, argsText: c.argsText })) });
      const first = calls[0];
      // P52 loop guard v2: while corrective, the IDENTICAL call (same tool
      // + same args) is refused with guidance; the 2nd identical repeat
      // stops the turn (with a rescue answer). A different tool or
      // different args runs (adaptation resets the guard).
      if (!first.parseError && guard.forbiddenArgs && plan.argSig(first.name, first.args) === guard.forbiddenArgs) {
        guard.correctiveRefusals += 1;
        const callIdG = first.id || ('call-' + run.calls.length);
        const closeExtrasG = () => {
          for (const extra of calls.slice(1)) {
            const xid = extra.id || ('call-' + run.calls.length);
            run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
            store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
            try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
          }
        };
        if (guard.correctiveRefusals >= 2) {
          stopReason = 'loop';
          stopDetail = 'boucle repetitive : ' + String(first.name || '?') + ' (meme appel malgre la strategie corrective, arret).';
          journal('warn', 'repeat loop', { tool: first.name });
          run.calls.push({ tool: first.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'non execute : arret boucle.' });
          store.append(sessionId, { role: 'tool', tool_call_id: callIdG, name: first.name,
            content: JSON.stringify({ ok: false, code: 'skipped', error: 'non execute : meme appel malgre la strategie corrective (arret).' }) });
          try { onEvent({ type: 'tool.result', callId: callIdG, tool: first.name, ok: false, code: 'skipped', ms: 0, summary: 'arret boucle.' }); } catch (_) {}
          closeExtrasG();
          await rescueAnswer(first.name);
          break;
        }
        run.calls.push({ tool: first.name || '?', target: '', ok: false, code: 'corrective', ms: 0, at: new Date().toISOString(), summary: 'refuse : strategie corrective, change d\'appel.' });
        store.append(sessionId, { role: 'tool', tool_call_id: callIdG, name: first.name,
          content: JSON.stringify({ ok: false, code: 'corrective', error: 'STRATEGIE CORRECTIVE : tu as repete 3 fois le meme appel (meme outil, memes arguments, meme resultat). Change de strategie : constate autrement (list/grep/read), choisis un autre outil ou d\'autres arguments, ou termine via reply/done. Ne re-emets PAS cet appel (une repetition identique = arret du tour).', detail: 'change de strategie.' }) });
        try { onEvent({ type: 'tool.result', callId: callIdG, tool: first.name, ok: false, code: 'corrective', ms: 0, summary: 'strategie corrective.' }); } catch (_) {}
        closeExtrasG();
        continue;
      }
      // P49-1: reply/done terminate the turn (the ONLY no-modification
      // exits). Gates teach the rules; extras are closed so the transcript
      // stays valid for the next round.
      if (first.name === 'reply' || first.name === 'done') {
        const callIdF = first.id || ('call-' + run.calls.length);
        const closeExtrasF = () => {
          for (const extra of calls.slice(1)) {
            const xid = extra.id || ('call-' + run.calls.length);
            run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
            store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
            try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
          }
        };
        const finishIntercept = (ok, code, text) => {
          run.calls.push({ tool: first.name, target: String(text || '').slice(0, 200), ok, code, ms: 0, at: new Date().toISOString(), summary: ok ? 'fin declaree (' + first.name + ').' : String(text).slice(0, 300) });
          const body = ok
            ? { ok: true, summary: 'fin de tour acceptee.', result: null, detail: 'fin de tour acceptee.' }
            : { ok: false, code, error: text, detail: text };
          store.append(sessionId, { role: 'tool', tool_call_id: callIdF, name: first.name, content: filter(JSON.stringify(body)).slice(0, 8000) });
          try { onEvent({ type: 'tool.result', callId: callIdF, tool: first.name, ok, code, ms: 0, summary: String(text || '').slice(0, 300) }); } catch (_) {}
        };
        const argText = first.name === 'reply'
          ? String((first.args && first.args.text) || '').trim()
          : String((first.args && first.args.summary) || '').trim();
        if (first.parseError) {
          finishIntercept(false, 'bad_args', 'arguments d\'outil illisibles : ' + first.parseError + ' Reponds avec UN appel JSON strict.');
          closeExtrasF();
          continue;
        }
        if (first.name === 'reply' && !argText) {
          finishIntercept(false, 'bad_args', 'reply: text requis (ta reponse finale).');
          closeExtrasF();
          continue;
        }
        if (argText && detectRepetition(argText)) {
          finishIntercept(false, 'bad_args', 'ta reponse se repete : reformule-la brievement, sans repeter deux fois la meme phrase, via reply/done.');
          closeExtrasF();
          continue;
        }
        // P52: catch-up sweep (steps finished without per-call verification
        // are verified now). NEVER blocks: open steps stay open (honest
        // appendix below), the finish is always accepted.
        try {
          const swept = plan.sweepVerify(store, sessionId, root, true);
          if (swept.length) journal('info', 'plan verifie (solde)', { steps: swept.length });
        } catch (_) {}
        const vF = await maybeVerify();
        if (vF === 'continue' || vF === 'stop') {
          finishIntercept(false, 'verify', 'verifications en cours : poursuis le travail (des checks ont ete modifies).');
          closeExtrasF();
          if (vF === 'stop') break; else continue;
        }
        finishIntercept(true, 'final', argText || 'fin.');
        closeExtrasF();
        declared = true;
        finalText = argText;
        break;
      }
      // P50-6: sub-agents (one task or parallel fan-out). Spawn is free
      // (no privilege escalation: same root, same rules, depth<=1, all
      // capped) but journaled. Children run real turns on child sessions.
      if (first.name === 'subagent') {
        const callIdS = first.id || ('call-' + run.calls.length);
        const closeExtrasS = () => {
          for (const extra of calls.slice(1)) {
            const xid = extra.id || ('call-' + run.calls.length);
            run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
            store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
            try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
          }
        };
        const finishSub = (ok, code, body, summary) => {
          run.calls.push({ tool: 'subagent', target: '', ok, code, ms: 0, at: new Date().toISOString(), summary: String(summary).slice(0, 300) });
          store.append(sessionId, { role: 'tool', tool_call_id: callIdS, name: 'subagent', content: filter(JSON.stringify(body)).slice(0, 8000) });
          try { onEvent({ type: 'tool.result', callId: callIdS, tool: 'subagent', ok, code, ms: 0, summary: String(summary).slice(0, 300) }); } catch (_) {}
        };
        const refuseSub = (text) => {
          finishSub(false, 'bad_args', { ok: false, code: 'bad_args', error: text, detail: text }, text);
          closeExtrasS();
        };
        if (first.parseError) { refuseSub('arguments illisibles : ' + first.parseError); continue; }
        if (subDepth >= 1) { refuseSub('sous-agent imbrique refuse (profondeur max 1).'); continue; }
        if (subSpawns >= MAX_SUB_SPAWNS) { refuseSub('trop de sous-agents (3 max par tour).'); continue; }
        if (runEntry.aborted) { refuseSub('tour abandonne.'); continue; }
        const sa = (first.args && typeof first.args === 'object') ? first.args : {};
        let jobs = null;
        if (Array.isArray(sa.tasks) && sa.tasks.length) {
          if (sa.task) { refuseSub('task XOR tasks (pas les deux).'); continue; }
          if (sa.tasks.length > MAX_SUB_PARALLEL) { refuseSub('fan-out max 3 sous-agents.'); continue; }
          jobs = sa.tasks;
        } else if (typeof sa.task === 'string' && sa.task.trim()) {
          jobs = [{ task: sa.task, focus: sa.focus, readonly: sa.readonly, maxRounds: sa.maxRounds }];
        } else { refuseSub('subagent: task (ou tasks[]) requis.'); continue; }
        let jobsOk = true;
        for (const j of jobs) {
          if (!j || typeof j.task !== 'string' || !j.task.trim() || j.task.length > 2000) { refuseSub('tache invalide (texte requis, <=2000).'); jobsOk = false; break; }
        }
        if (!jobsOk) continue;
        subSpawns += 1;
        try { onEvent({ type: 'tool.start', callId: callIdS, tool: 'subagent' }); } catch (_) {}
        const runChild = async (job) => {
          childSeq += 1;
          const n = childSeq;
          const child = store.create({ title: 'sub: ' + String(job.task).slice(0, 60), projectRoot: session.projectRoot });
          const childMode = job.readonly === true ? 'plan' : mode;
          try { store.update(child.id, (x) => { x.meta.mode = childMode; x.meta.parent = sessionId; }); } catch (_) {}
          let mr = parseInt(job.maxRounds, 10);
          if (!Number.isFinite(mr)) mr = 4;
          mr = Math.min(6, Math.max(1, mr));
          const cprompt = 'Execute cette sous-tache agent (enfant ' + n + '). Tache : ' + String(job.task).slice(0, 2000)
            + (job.focus ? '\nContexte : ' + String(job.focus).slice(0, 1000) : '')
            + '\nTermine par done avec un RESUME compact (faits + fichiers touches).'
            + (job.readonly === true ? ' Lecture seule (mode PLAN).' : '');
          journal('info', 'sous-agent demarre', { child: child.id, mode: childMode, maxRounds: mr });
          try { onEvent({ type: 'subagent.start', callId: callIdS, child: child.id }); } catch (_) {}
          let cres = null;
          try {
            cres = await runTurn({ store, sessionId: child.id, prompt: cprompt, corr: corr + '.s' + n,
              provider, toolsCtx: { home, sessionRules: sessionRulesMap, pending: toolsCtx ? toolsCtx.pending : new Map(), noResume: true },
              runs, log, onEvent: () => {}, subDepth: subDepth + 1, maxIt: mr, runtimeWait });
          } catch (e) {
            journal('warn', 'sous-agent erreur', { child: child.id, error: String((e && e.message) || e).slice(0, 160) });
            return { ok: false, child: child.id, error: String((e && e.message) || e).slice(0, 300) };
          }
          const cs = store.get(child.id);
          const cmsgs = (cs && cs.messages) || [];
          // Summary = the done/reply ARGUMENT (last message is just the
          // accept receipt). Fallback: last assistant text (rescue path).
          let summary = '';
          for (let mi = cmsgs.length - 1; mi >= 0 && !summary; mi--) {
            const tcs = (cmsgs[mi] && cmsgs[mi].tool_calls) || [];
            for (const tc of tcs) {
              if (tc.name === 'done' || tc.name === 'reply') {
                try { const a = JSON.parse(tc.argsText || '{}'); summary = String(a.summary || a.text || ''); } catch (_) {}
                break;
              }
            }
          }
          if (!summary) {
            for (let mi = cmsgs.length - 1; mi >= 0; mi--) {
              if (cmsgs[mi] && cmsgs[mi].role === 'assistant' && cmsgs[mi].content) { summary = String(cmsgs[mi].content); break; }
            }
          }
          summary = summary.slice(0, 2000);
          const cmeta = (cs && cs.meta && cs.meta.lastRun) || {};
          try { onEvent({ type: 'subagent.done', callId: callIdS, child: child.id, status: cmeta.status || (cres && cres.status) }); } catch (_) {}
          return { ok: !cres || cres.status !== 'error', child: child.id, status: cmeta.status || (cres && cres.status),
            summary, files: cmeta.filesModified || [], toolCalls: (cmeta.calls || []).length };
        };
        const t0s = Date.now();
        let results = null;
        try {
          results = jobs.length === 1 ? [await runChild(jobs[0])] : await Promise.all(jobs.map((j) => runChild(j)));
        } catch (e) {
          finishSub(false, 'subagent_failed', { ok: false, code: 'subagent_failed', error: String((e && e.message) || e).slice(0, 300) }, 'sous-agent echoue.');
          closeExtrasS(); continue;
        }
        const okAll = results.every((x) => x.ok);
        const body = jobs.length === 1
          ? { ok: results[0].ok, summary: results[0].summary, result: results[0], detail: String(results[0].summary || '').slice(0, 500) }
          : { ok: okAll, summary: results.map((x, i) => '[enfant ' + (i + 1) + ' ' + (x.ok ? 'ok' : 'ECHEC') + '] ' + (x.summary || x.error || '')).join('\n').slice(0, 4000), result: results, detail: results.length + ' enfants.' };
        journal('info', 'sous-agents termines', { n: results.length, ok: okAll, ms: Date.now() - t0s });
        finishSub(okAll, okAll ? 'ok' : 'subagent_failed', body, jobs.length + ' enfant(s), ' + (okAll ? 'tous ok.' : 'echecs.') + ' (' + (Date.now() - t0s) + ' ms).');
        closeExtrasS();
        continue;
      }
      const callId = first.id || ('call-' + run.calls.length);
      try { onEvent({ type: 'tool.start', callId, tool: first.name }); } catch (_) {}
      let content = '';
      if (first.parseError) {
        const entry = { tool: first.name || '?', target: '', ok: false, code: 'bad_args', ms: 0, at: new Date().toISOString(), summary: first.parseError };
        run.calls.push(entry);
        // P26-b: constraining hint on top of the runtime grammar + retry.
        content = JSON.stringify({ ok: false, error: 'arguments d\'outil illisibles : ' + first.parseError + ' Reponds avec UN appel JSON strict.', detail: 'arguments d\'outil illisibles.' });
      } else if (strictAction && intent.improvement && !reconDone && FILE_MUTATING.indexOf(first.name) !== -1) {
        // P49-3: improvement without recon is forbidden: look first.
        run.calls.push({ tool: first.name, target: '', ok: false, code: 'recon_required', ms: 0, at: new Date().toISOString(), summary: 'bloque : constat requis avant ecriture.' });
        content = JSON.stringify({ ok: false, code: 'recon_required', error: 'constate d\'abord : list/grep/read le projet avant d\'ecrire (amelioration pilotee par constats reels, pas de conseils generiques).', detail: 'constate d\'abord : list/grep/read avant write/edit.' });
      } else if (first.name === 'todo') {
        // P52: the model never manages todos (the engine owns the plan).
        run.calls.push({ tool: 'todo', target: '', ok: false, code: 'engine_todos', ms: 0, at: new Date().toISOString(), summary: 'refuse : todos geres par le moteur.' });
        content = JSON.stringify({ ok: false, code: 'engine_todos', error: 'les todos sont geres par le moteur (PLAN MOTEUR affiche) : poursuis l\'etape en cours, ne gere pas de liste.', detail: 'todos geres par le moteur.' });
      } else {
        const doneContent = (rr) => {
          // P49-3: any successful look unlocks file mutations for the turn.
          if (rr.call.ok && ['read', 'list', 'glob', 'grep'].indexOf(first.name) !== -1) reconDone = true;
          return JSON.stringify({ ok: true, summary: rr.call.summary, result: rr.call.result, diff: rr.call.diff ? rr.call.diff.slice(0, 4000) : undefined, detail: rr.call.summary });
        };
        const errContent = (rr) => JSON.stringify({ ok: false, code: rr.code || 'error', error: rr.reason || 'echec.', detail: rr.reason || 'echec.' });
        const legacyNeedApproval = (rr) => {
          const entry = { tool: first.name, target: String((rr.request.pattern && rr.request.pattern.text) || ''), ok: false, code: 'need_approval', ms: 0, at: new Date().toISOString(), summary: 'approbation requise (' + rr.request.id + ')' };
          run.calls.push(entry);
          return JSON.stringify({ ok: false, code: 'need_approval', requestId: rr.request.id, summary: rr.request.summary, hint: 'appel NON execute : approbation operateur requise.', detail: rr.request.summary });
        };
        const r = await executeTool(tctx, first.name, first.args, {});
        if (r.status === 'done') {
          content = doneContent(r);
        } else if (r.status === 'need-approval') {
          // P52 item 1: approvals PAUSE the turn (resumable), they no
          // longer fail it. No waiter (sub-turns) keeps legacy behavior.
          const paused = await pauseForApproval({ toolsCtx, sessionId, runEntry, onEvent, turnId, journal, request: r.request, fullArgs: first.args });
          if (paused.aborted) {
            run.calls.push({ tool: first.name, target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'abandonne pendant la pause.' });
            content = JSON.stringify({ ok: false, code: 'skipped', error: 'tour abandonne pendant l\'attente d\'approbation.' });
            pauseAborted = true;
          } else if (paused.legacy) {
            content = legacyNeedApproval(r);
          } else if (paused.decision === 'deny') {
            run.calls.push({ tool: first.name, target: String((r.request.pattern && r.request.pattern.text) || ''), ok: false, code: 'denied', ms: 0, at: new Date().toISOString(), summary: 'refuse par l\'operateur.' });
            content = JSON.stringify({ ok: false, code: 'denied', error: 'refuse par l\'operateur. Adapte (autre outil, autre chemin) ou termine via reply/done.', detail: 'refuse par l\'operateur.' });
          } else {
            // Approved (once/session/project): re-execute, THIS turn continues.
            const r2 = await executeTool(tctx, first.name, first.args, { preApproved: true });
            if (r2.status === 'done') content = doneContent(r2);
            else if (r2.status === 'need-approval') content = legacyNeedApproval(r2); // state changed mid-pause: honest stop, no re-pause loop.
            else content = errContent(r2);
          }
        } else {
          content = errContent(r);
        }
      }
      content = filter(summarizeResult(content)).slice(0, 8000);

      // P52: the engine verifies the current plan step on disk after
      // each executed call and marks it done ONLY when verified (never
      // blocks: failures just leave the step open).
      try {
        const lastCall = run.calls[run.calls.length - 1] || {};
        if (lastCall.ok) {
          const marked = plan.verifyCurrent(store, sessionId, root);
          if (marked) {
            journal('info', 'etape verifiee', { step: marked.id, detail: String(marked.detail || '').slice(0, 160) });
            try {
              const o = JSON.parse(content);
              o.planProgress = 'etape ' + marked.id + ' VERIFIEE (' + String(marked.detail || '').slice(0, 200) + ').';
              content = JSON.stringify(o);
            } catch (_) {}
          }
        }
      } catch (_) {}
      store.append(sessionId, { role: 'tool', tool_call_id: callId, name: first.name, content });
      const last = run.calls[run.calls.length - 1] || {};
      try { onEvent({ type: 'tool.result', callId, tool: first.name, ok: !!last.ok, code: last.code || 'ok', ms: last.ms || 0, summary: (last.summary || '').slice(0, 300) }); } catch (_) {}
      // P52 loop guard v2: same tool + same args + same result on
      // COMPLETED calls only. The 3rd identical triggers the corrective
      // strategy; identical again stops (with a rescue answer, P39-d).
      // Reads, approvals, denials, guidance and skips never count.
      if (!first.parseError && (GUARD_TOOLS.indexOf(first.name) !== -1 || (first.name && first.name.indexOf('mcp__') === 0)) &&
          GUARD_SKIP_CODES.indexOf(last.code || 'ok') === -1 && GUIDANCE_CODES.indexOf(last.code || 'ok') === -1) {
        const gv = guard.note(plan.callSig(first.name, first.args, !!last.ok, last.code));
        if (gv === 'correct') {
          journal('warn', 'boucle corrective', { tool: first.name });
          guard.forbiddenArgs = plan.argSig(first.name, first.args);
          store.append(sessionId, { role: 'user', content: 'STRATEGIE CORRECTIVE : tu as repete 3 fois le meme appel ' + String(first.name || '?') + ' (memes arguments, meme resultat). Change de strategie : constate autrement (list/grep/read), choisis un autre outil ou d\'autres arguments, ou termine via reply/done. Ne re-emets PAS cet appel (une repetition identique = arret du tour).' });
        } else if (gv === 'stop') {
          // Defensive only (the pre-exec restriction normally prevents
          // re-executing the identical call while corrective).
          stopReason = 'loop';
          stopDetail = 'boucle repetitive : ' + String(first.name || '?') + ' (meme outil, memes arguments, meme resultat malgre la strategie corrective, arret).';
          journal('warn', 'repeat loop', { tool: first.name });
          await rescueAnswer(first.name);
          loopStop = true;
        }
      }
      // P50-3: bounded build-fix loop (see consts above). need_approval
      // and skipped never count: the tool did not run.
      if (last.ok) buildFixFails = 0;
      else if (BUILD_FIX_TOOLS.indexOf(first.name) !== -1 && last.code !== 'need_approval' && last.code !== 'skipped') {
        buildFixFails += 1;
        if (buildFixFails >= MAX_BUILD_FIX) {
          stopReason = 'build_fix';
          stopDetail = 'boucle de correction bornee : ' + buildFixFails + ' echecs consecutifs (' + first.name + ', dernier : ' + String(last.code || 'echec').slice(0, 80) + ').';
          journal('warn', 'build-fix borne atteinte', { fails: buildFixFails, tool: first.name });
          buildFixStop = true;
        }
      }
      for (const extra of calls.slice(1)) {
        const xid = extra.id || ('call-' + run.calls.length);
        run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
          store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
        try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
      }
      if (pauseAborted || loopStop || buildFixStop) break; // P50-3 + P52: extras closed above, transcript valid.
    }
    // P49-2: the model claimed done with no verified files: constrained
    // re-attempt (bounded by MAX_ATTEMPTS); otherwise the verdict below
    // stands. A run-only ACTION with successful calls counts as done.
    // Only false-TERMINE retries: a loud ECHEC (standing tool errors,
    // mid-turn approval need) stops immediately, never retried.
    if (!runEntry.aborted && strictAction && declared && mode === 'build' &&
        !currentFilesModified().length && !(runOnly && run.calls.some((c) => c.ok)) &&
        computeRunStatus(declared, run.calls).status === 'TERMINE') {
      continue;
    }
    break;
    }
  } catch (e) {
    if (e && e.code === 'aborted') {
      store.append(sessionId, { role: 'assistant', content: finalText, aborted: true });
      return finishAborted();
    }
    const code = (e && e.code) || 'provider_error';
    const error = (e && e.message) || 'Erreur du fournisseur.';
    journal('warn', 'turn failed', { code });
    try { onEvent({ type: 'turn.error', code, error }); } catch (_) {}
    if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
    return { status: 'error', code, error };
  }

  if (runEntry.aborted) {
    store.append(sessionId, { role: 'assistant', content: finalText, aborted: true });
    return finishAborted();
  }

  // P52 item 7: orchestrated long tasks. Each step runs in a FRESH
  // minimal child context (step text + short summary of previous steps);
  // plan/state/hashes/journal persist on disk (crash/stop/close resume
  // via explicit resume words). The parent makes no model calls itself.
  if ((orchResumeId || orchTexts.length) && !runEntry.aborted) {
    const orchPlanId = orchResumeId || turnId;
    journal('info', 'tour orchestre', { plan: orchPlanId, steps: orchTexts.length || 'reprise', resume: !!orchResumeId });
    try { await ensureSeriesCheckpoint(tctx); } catch (e) {
      journal('warn', 'instantane orchestre impossible', { error: String((e && e.message) || e).slice(0, 120) });
    }
    const waiters = (toolsCtx && toolsCtx.waiters) || null;
    const stepRunner = async (step, ctx) => {
      if (runEntry.aborted) return { calls: 0, aborted: true, error: 'tour abandonne.' };
      const child = store.create({ title: 'orch ' + ctx.n + '/' + ctx.N + ': ' + step.text.slice(0, 50), projectRoot: session.projectRoot });
      try { store.update(child.id, (x) => { x.meta.orchParent = sessionId; x.meta.orchPlan = orchPlanId; }); } catch (_) {}
      // Share the parent session rules (operator approvals apply to steps).
      try { sessionRulesMap.set(child.id, sessionRulesMap.get(sessionId)); } catch (_) {}
      const cprompt = 'Execute l\'etape ' + ctx.n + '/' + ctx.N + ' du plan : ' + step.text +
        (ctx.prev ? '\nEtapes precedentes accomplies :\n' + ctx.prev : '') +
        '\nUNE seule action par pas. Termine par done avec un court resume.';
      const t0 = Date.now();
      let cres = null;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { abortRun(runs, child.id); } catch (_) {} }, ctx.msBudget);
      if (timer.unref) { try { timer.unref(); } catch (_) {} }
      // A parent abort also aborts the step child (else a paused child
      // would hang the turn forever).
      const pabort = setInterval(() => { if (runEntry.aborted) { try { abortRun(runs, child.id); } catch (_) {} } }, 250);
      if (pabort.unref) { try { pabort.unref(); } catch (_) {} }
      try {
        cres = await runTurn({ store, sessionId: child.id, prompt: cprompt, corr: corr + '.o' + ctx.n,
          provider, toolsCtx: { home, sessionRules: sessionRulesMap, pending: toolsCtx ? toolsCtx.pending : new Map(), waiters, parentSessionId: sessionId, noResume: true, noOrchPlan: true },
          runs, log, onEvent: (e) => {
            try {
              if (e && (e.type === 'turn.paused' || (typeof e.type === 'string' && e.type.indexOf('tool.') === 0) || e.type === 'runtime.wait')) onEvent(e);
            } catch (_) {}
          }, maxIt: ctx.callBudget, runtimeWait });
      } catch (e) {
        journal('warn', 'etape orchestre erreur', { n: ctx.n, error: String((e && e.message) || e).slice(0, 160) });
      } finally {
        try { clearTimeout(timer); } catch (_) {}
        try { clearInterval(pabort); } catch (_) {}
      }
      const cs = store.get(child.id);
      const calls = (cs && cs.meta && cs.meta.lastRun && Array.isArray(cs.meta.lastRun.calls)) ? cs.meta.lastRun.calls : [];
      const childDeclared = !!(cs && cs.meta && cs.meta.lastRun && cs.meta.lastRun.stopReason === 'declared');
      if (runEntry.aborted) return { calls: calls.length, aborted: true, error: 'tour abandonne.' };
      if (timedOut) return { calls: calls.length, ok: false, error: 'delai etape depasse (' + Math.round((Date.now() - t0) / 1000) + 's).' };
      return { calls: calls.length, ok: !cres || cres.status !== 'error', declared: childDeclared, error: (cres && cres.status === 'error') ? String(cres.error || 'erreur enfant').slice(0, 200) : '' };
    };
    let orchAborted = false;
    try {
      const res = await orch.runOrchestrated({ root, planId: orchPlanId, stepTexts: orchTexts,
        runStep: async (step, ctx) => {
          const r = await stepRunner(step, ctx);
          if (r.aborted) orchAborted = true;
          run.calls.push({ tool: 'orch', target: 'etape ' + ctx.n + '/' + ctx.N, ok: !r.aborted && r.ok !== false, code: r.aborted ? 'skipped' : (r.ok === false ? 'step_failed' : 'ok'), ms: 0, at: new Date().toISOString(), summary: ('etape ' + ctx.n + '/' + ctx.N + ' : ' + (r.aborted ? 'interrompue' : (r.error || 'executee'))).slice(0, 300) });
          return r;
        },
        emit: (t, o) => { try { onEvent(Object.assign({ type: t }, o)); } catch (_) {} } });
      finalText = res.report;
      declared = true;
      const total = res.done + res.failed + res.skipped;
      if (orchAborted) orchVerdict = { status: 'PARTIEL', reason: 'interrompu (reprise : repondez "reprendre le plan").', unresolved: [] };
      else if (res.failed > 0) orchVerdict = { status: 'ECHEC', reason: res.failed + ' etape(s) echouee(s) sur ' + total + '.', unresolved: [] };
      else if (res.skipped > 0) orchVerdict = { status: 'PARTIEL', reason: res.skipped + ' etape(s) non tentee(s) (budget).', unresolved: [] };
      else orchVerdict = { status: 'TERMINE', reason: '', unresolved: [] };
      journal('info', 'orchestre termine', { done: res.done, failed: res.failed, skipped: res.skipped });
    } catch (e) {
      finalText = 'Plan orchestre interrompu : ' + String((e && e.message) || e).slice(0, 300);
      declared = true;
      orchVerdict = { status: 'ECHEC', reason: 'orchestration interrompue.', unresolved: [] };
      journal('warn', 'orchestre interrompu', { error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  // P43-3: a context stop NEVER abandons. Minimal second round: terse
  // system + map + the raw prompt, NO tools, NO history. If it fails too,
  // the labelled deterministic fallback (why='context'). Status stays
  // PARTIEL (honest), but message.done carries real text.
  if (!declared && stopReason === 'context' && !runEntry.aborted) {
    let rescued = '';
    try {
      const minimal = [{ role: 'system', content: modes.modeSystem(mode, 'small') }];
      if (mapText) minimal.push({ role: 'system', content: mapText });
      minimal.push({ role: 'user', content: String(base.prompt || '').slice(0, 2000) });
      const rr = await chatOnce(provider, { model, messages: minimal });
      rescued = String((rr && rr.text) || '').trim();
    } catch (e) {
      journal('warn', 'reponse secours contexte echouee', { error: String((e && e.message) || e).slice(0, 160) });
    }
    if (rescued) {
      finalText = rescued;
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('info', 'reponse secours contexte', { chars: rescued.length });
    } else {
      finalText = pmap.deterministicFallback({ root, map: mapInfo, calls: run.calls, prompt: base.prompt, why: 'context' });
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('warn', 'reponse secours deterministe', { chars: finalText.length, why: 'context' });
    }
  }

  // Honest status (P25-g + P26 stops).
  const filesModified = currentFilesModified();
  let verdict = computeRunStatus(declared, run.calls);
  if (orchVerdict) verdict = orchVerdict; // P52: the orchestrated verdict wins (honest per-step report).
  if (!declared && stopReason && stopReason !== 'verify_failed') {
    verdict = { status: 'PARTIEL', reason: stopDetail || 'arret.', unresolved: verdict.unresolved };
  }
  // P49-2: honest ACTION verdict, model-independent: verified files win
  // over claims. TERMINE only with evidence; else AUCUNE MODIFICATION
  // with a reason and a proposal. The files appendix is global (declared
  // turns that really changed files say so).
  if (declared && filesModified.length > 0) {
    const app = 'Modifications verifiees (' + filesModified.length + ') : ' + filesModified.join(', ');
    finalText = (finalText.trim() ? finalText.trim() + '\n\n' : '') + app;
  }
  // P52: engine-plan honesty appendix (verified X/Y + remaining steps).
  if (declared) {
    try {
      const papp = plan.planAppendix(store, sessionId);
      if (papp) finalText = (finalText.trim() ? finalText.trim() + '\n\n' : '') + papp;
    } catch (_) {}
  }
  if (strictAction && !runEntry.aborted) {
    const okCalls = run.calls.filter((c) => c.ok && c.code !== 'skipped').length;
    if (declared && filesModified.length > 0) {
      // Errors may still stand (unresolved): then ECHEC is kept, with the
      // files listed above. TERMINE only when nothing stands unresolved.
      if (!verdict.unresolved.length && !orchVerdict) verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      if (!finalText.trim()) finalText = 'Tache terminee.';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (declared && runOnly && okCalls > 0) {
      verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      finalText = (finalText.trim() || 'Execution verifiee.') + '\n\nAucun fichier modifie (execution seule, verifiee : ' + okCalls + ' appels aboutis).';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (!declared && (filesModified.length > 0 || finalText.trim())) {
      // Undeclared but real: modified files without a declaration, or an
      // answer already produced (context/loop rescue): keep the verdict.
    } else if ((!declared || verdict.status === 'TERMINE') && !orchVerdict) {
      // P49-2 target: false TERMINE (declared, no evidence) and answerless
      // stops (no_tool). A declared ECHEC (mid-turn approval need, standing
      // tool errors) is loud already: it stands, never downgraded.
      const totalCalls = run.calls.filter((c) => c.code !== 'skipped').length;
      let raison = '';
      if (mode === 'plan') raison = 'mode PLAN : les modifications sont refusees (basculez en BUILD pour modifier).';
      else if (stopReason === 'no_tool' || stopReason === 'build_fix') raison = stopDetail;
      else if (!totalCalls) raison = 'aucun appel d\'outil emis.';
      else if (!okCalls) {
        const errs = run.calls.filter((c) => !c.ok).slice(0, 3).map((c) => c.tool + '/' + (c.code || 'error'));
        raison = 'tous les appels ont echoue (' + errs.join(', ') + ').';
      } else {
        const denies = run.calls.filter((c) => !c.ok && c.code === 'denied').map((c) => c.tool);
        raison = denies.length ? 'action refusee par l\'operateur (' + denies.join(', ') + ').' : 'appels lecture seule uniquement, aucun fichier touche.';
      }
      finalText = 'AUCUNE MODIFICATION : ' + raison + '\n\nProposition : reformulez en UNE action precise (ex : "cree le fichier X qui ..."), ' +
        (mode === 'plan' ? 'basculez en BUILD pour modifier.' : 'verifiez les chemins (list/glob) puis relancez.');
      verdict = { status: 'PARTIEL', reason: 'AUCUNE MODIFICATION : ' + raison, unresolved: verdict.unresolved };
      // The honest text above must be the stored answer too (next-turn
      // history and panels read the store, not just message.done).
      store.append(sessionId, { role: 'assistant', content: finalText });
    }
  }
  // P52: orchestrated turns always store the report (even file-less or
  // interrupted ones: the store is the transcript of record).
  if (orchVerdict && declared) {
    try {
      const msgs = (store.get(sessionId) || { messages: [] }).messages;
      if (!msgs.length || msgs[msgs.length - 1].role !== 'assistant' || msgs[msgs.length - 1].content !== finalText) {
        store.append(sessionId, { role: 'assistant', content: finalText });
      }
    } catch (_) {}
  }
  const stopOut = stopReason || (declared ? 'declared' : 'max_iters');
  // P49-2: the combined tool diffs ride along (bounded) for honest review.
  const runDiff = run.calls.filter((c) => c.diff).map((c) => '[' + c.tool + ' ' + String(c.target || '').slice(0, 120) + ']\n' + String(c.diff)).join('\n').slice(0, 8000);
  saveRunSidecar(tctx);
  try {
    store.update(sessionId, (s) => {
      if (!s.meta) s.meta = {};
      s.meta.lastRun = { at: new Date().toISOString(), status: verdict.status, reason: verdict.reason, filesModified, stopReason: stopOut, mode, profile, diff: runDiff || null,
        calls: run.calls.map((c) => ({ tool: c.tool, target: c.target, ok: c.ok, code: c.code })) };
    });
  } catch (_) {}
  try { onEvent({ type: 'message.done', text: finalText, aborted: false }); } catch (_) {}
  const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
  try {
    onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: false, status: verdict.status, reason: verdict.reason, filesModified, stopReason: stopOut,
      declaredDone: declared, toolCalls: run.calls.length, unresolvedErrors: verdict.unresolved.map((c) => ({ tool: c.tool, target: c.target, code: c.code })) });
  } catch (_) {}
  journal('info', 'turn done', { status: verdict.status, tools: run.calls.length, files: filesModified.length, stopReason: stopOut });
  if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
  return { status: 'done', model, messageCount, runStatus: verdict.status };

  function finishAborted() {
    try { onEvent({ type: 'message.done', text: finalText, aborted: true }); } catch (_) {}
    const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
    try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'aborted', filesModified: [], stopReason: 'aborted' }); } catch (_) {}
    journal('info', 'turn aborted');
    if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
    return { status: 'aborted', model };
  }
}

function abortRun(runs, sessionId) {
  if (!runs || !runs.has(sessionId)) return false;
  const run = runs.get(sessionId);
  run.aborted = true;
  try { if (typeof run.destroy === 'function') run.destroy(); } catch (_) {}
  if (Array.isArray(run.killFns)) {
    for (const k of run.killFns) { try { k(); } catch (_) {} }
  }
  return true;
}

module.exports = { runTurn, abortRun, computeRunStatus, unresolvedErrors, detectRepetition, MAX_TOOL_ITERS, resolveTurnApproval, summarizeResult };
