// Sudo Agent loop (P24 single-turn + P25 tool loop + P26 agent loop). Without
// a project root the turn streams a plain answer (legacy). With a project
// root the model may call tools under boundary + permissions + checkpoints.
// P26: Build/Plan modes, size profiles, context budget + compression, one
// action per step, repeat-loop detection, verify loop after modifications,
// MCP tools (full profile). The turn ends with an HONEST status: TERMINE
// only if the agent declared done, no tool error stands unresolved, and the
// really-modified file list is provided. Stdlib only, ASCII only (status
// words use unaccented capitals on purpose).
'use strict';

const fs = require('fs');
const path = require('path');
const { probeProvider, streamChat, chatOnce, waitForRuntime } = require('./providers');
const { classifyAction } = require('./intent');
const { executeTool, toOpenAISchema, ensureSeriesCheckpoint, saveRunSidecar } = require('./tools');
const { loadProjectRules } = require('./permissions');
const { diffSnapshot } = require('./checkpoints');
const { maskSecrets } = require('./journal');
const modes = require('./modes');
const profiles = require('./profiles');
const compressMod = require('./compress');
const verifyMod = require('./verify');
const mcpMod = require('./mcp');
const pmap = require('./projectmap');

const MAX_HISTORY = 50;
const MAX_PROMPT = 200000;
const MAX_TOOL_ITERS = 8; // legacy default; P26 uses per-profile limits
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

  const base = { store, provider, sessionId, prompt, corr, log, runs, onEvent, model, probeTimeoutMs, preProbe: probe, verify: opts.verify, runtimeWait };
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
const FILE_MUTATING = ['write', 'edit', 'patch', 'delete', 'rename'];

// P49: driver-side guidance codes are not failures: a rejected reply/done
// (open todos, no plan, recon missing, verify still running) teaches the
// model the rules.
const GUIDANCE_CODES = ['todos_open', 'no_plan', 'recon_required', 'verify'];

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
      if (calls[j].ok && (c.code === 'bad_args' || (calls[j].tool === c.tool && calls[j].target === c.target))) { fixed = true; break; }
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
  const intent = classifyAction(base.prompt);
  journal('info', 'intention classee', { kind: intent.kind, verbs: intent.verbs.join(','), expectsChange: intent.expectsChange, collective: intent.collective, improvement: intent.improvement, taskItems: intent.taskItems.length });
  // P43-2: QUESTIONS take the single-call path (no free tool exploration).
  // The map + preload above are shared, so the journal keeps the same
  // proof lines ('carte projet injectee', 'contexte general precharge').
  if (intent.kind === 'QUESTION') {
    return questionTurn(base, session, toolsCtx, root, mapText, mapInfo, preloadText);
  }

  // P26-a/b: mode, size profile, context budget.
  const mode = modes.getMode(session);
  const profile = profiles.selectProfile({ modelId: model, providerType: provider.type, override: provider.profile || process.env.SUDO_AGENT_PROFILE });
  const maxIt = profiles.maxIters(profile);
  const ctxTokens = profiles.resolveCtxTokens({ override: process.env.SUDO_AGENT_CTX_TOKENS, probeNctx: probeNctx(base.preProbe, model), providerType: provider.type });

  const runEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
  runs.set(sessionId, runEntry);
  const run = { id: turnId, sessionId, checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: runEntry.killFns };
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}

  const agentsMd = readAgentsMd(root);

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
    const sysChars = modes.modeSystem(mode, profile).length + profiles.chunkNote(profile).length + (agentsMd ? agentsMd.length : 0);
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
        try { toolsCtx.pending.set(r.request.id, { request: r.request, sessionId, fullArgs: { command: c.command } }); } catch (_) {}
        stopReason = 'verify_approval';
        stopDetail = 'verification en attente d\'approbation (' + r.request.id + ' : ' + c.command.slice(0, 120) + ').';
        return 'stop';
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

  const callKey = (c) => {
    const a = (c && c.args) || {};
    const t = a.file || a.dir || a.path || a.cwd || a.pattern || a.command || a.op || a.scope || '';
    return String(c.name || '?') + '|' + String(t).slice(0, 200);
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
  // P49-3: fresh todo reads (the store is file-backed: always re-read).
  const readTodos = () => {
    try {
      const cur = store.get(sessionId);
      if (cur && cur.meta && Array.isArray(cur.meta.todos)) return cur.meta.todos;
    } catch (_) {}
    return [];
  };
  // P49-1: reply/done acceptance gate. Returns null when allowed.
  const replyBlockedReason = () => {
    const todos = readTodos();
    const open = todos.filter((t) => !t.done);
    if (open.length) {
      return { code: 'todos_open', error: 'finis d\'abord les ' + open.length + ' todos ouverts (' + open.slice(0, 3).map((t) => t.id + ': ' + String(t.text).slice(0, 60)).join(' ; ') + ') : appelle todo/done pour chacun, puis reply/done.' };
    }
    if (strictAction && intent.collective && !todos.length && !run.calls.some((c) => c.ok)) {
      return { code: 'no_plan', error: 'demande collective : decoupe d\'abord le travail en todos (todo/add, un par etape), puis execute-les une par une.' };
    }
    return null;
  };
  let reconDone = false;
  // P49-3: a pasted task list seeds session todos driver-side (bounded).
  if (strictAction && intent.hasTaskList) {
    for (const item of intent.taskItems.slice(0, 20)) {
      try { await executeTool(tctx, 'todo', { op: 'add', text: item }, {}); } catch (_) {}
    }
    journal('info', 'todos ensemences', { count: Math.min(intent.taskItems.length, 20) });
  }

  let declared = false;
  let finalText = '';
  let iters = 0;
  let lastKey = '';
  let sameCount = 0;
  let attempt = 0;
  const MAX_ATTEMPTS = (strictAction && mode === 'build') ? 3 : 1;
  try {
    for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // P49-2: constrained re-attempt: strong order, fresh round budget.
        store.append(sessionId, { role: 'user', content: constrainedPrompt(attempt) });
        declared = false; finalText = ''; lastKey = ''; sameCount = 0;
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
      const key = first.parseError ? '' : callKey(first);
      if (key && key === lastKey) {
        sameCount += 1;
      } else {
        lastKey = key;
        sameCount = key ? 1 : 0;
      }
      if (key && sameCount >= 3) {
        stopReason = 'loop';
        stopDetail = 'boucle repetitive detectee : ' + key.slice(0, 160) + ' (3 appels identiques, arret).';
        journal('warn', 'repeat loop', { key: key.slice(0, 160) });
        // Close the dangling 3rd call so the transcript stays valid.
        const loopCallId = first.id || ('call-' + run.calls.length);
        run.calls.push({ tool: first.name || '?', target: '', ok: false, code: 'skipped', ms: 0,
          at: new Date().toISOString(), summary: 'non execute : boucle repetitive detectee.' });
        store.append(sessionId, { role: 'tool', tool_call_id: loopCallId, name: first.name,
          content: JSON.stringify({ ok: false, code: 'skipped', error: 'non execute : boucle repetitive (3 appels identiques).' }) });
        // P39-d: a loop stop NEVER ends without an answer. Last round
        // WITHOUT tools (answer from what is collected), else a labelled
        // deterministic fallback. Status stays PARTIEL (loop happened).
        if (!runEntry.aborted) {
          try {
            const rescue = await chatOnce(provider, { model,
              messages: modelMessages().concat([{ role: 'user',
                content: 'STOP OUTILS : tu as repete 3 fois le meme appel (' + key.slice(0, 160) +
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
            finalText = pmap.deterministicFallback({ root, map: mapInfo, calls: run.calls, loopKey: key, prompt: base.prompt });
            store.append(sessionId, { role: 'assistant', content: finalText });
            journal('warn', 'reponse secours deterministe', { chars: finalText.length });
          }
        }
        break;
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
        const block = replyBlockedReason();
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
        if (block) {
          finishIntercept(false, block.code, block.error);
          closeExtrasF();
          continue;
        }
        if (argText && detectRepetition(argText)) {
          finishIntercept(false, 'bad_args', 'ta reponse se repete : reformule-la brievement, sans repeter deux fois la meme phrase, via reply/done.');
          closeExtrasF();
          continue;
        }
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
      } else {
        const r = await executeTool(tctx, first.name, first.args, {});
        if (r.status === 'done') {
          // P49-3: any successful look unlocks file mutations for the turn.
          if (r.call.ok && ['read', 'list', 'glob', 'grep'].indexOf(first.name) !== -1) reconDone = true;
          content = JSON.stringify({ ok: true, summary: r.call.summary, result: r.call.result, diff: r.call.diff ? r.call.diff.slice(0, 4000) : undefined, detail: r.call.summary });
        } else if (r.status === 'need-approval') {
          try { toolsCtx.pending.set(r.request.id, { request: r.request, sessionId, fullArgs: first.args }); } catch (_) {}
          const entry = { tool: first.name, target: String((r.request.pattern && r.request.pattern.text) || ''), ok: false, code: 'need_approval', ms: 0, at: new Date().toISOString(), summary: 'approbation requise (' + r.request.id + ')' };
          run.calls.push(entry);
          content = JSON.stringify({ ok: false, code: 'need_approval', requestId: r.request.id, summary: r.request.summary, hint: 'appel NON execute : approbation operateur requise.', detail: r.request.summary });
        } else {
          content = JSON.stringify({ ok: false, code: r.code || 'error', error: r.reason || 'echec.', detail: r.reason || 'echec.' });
        }
      }
      content = filter(content).slice(0, 8000);
      store.append(sessionId, { role: 'tool', tool_call_id: callId, name: first.name, content });
      const last = run.calls[run.calls.length - 1] || {};
      try { onEvent({ type: 'tool.result', callId, tool: first.name, ok: !!last.ok, code: last.code || 'ok', ms: last.ms || 0, summary: (last.summary || '').slice(0, 300) }); } catch (_) {}
      for (const extra of calls.slice(1)) {
        const xid = extra.id || ('call-' + run.calls.length);
        run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
        store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
        try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
      }
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
  if (strictAction && !runEntry.aborted) {
    const okCalls = run.calls.filter((c) => c.ok && c.code !== 'skipped').length;
    if (declared && filesModified.length > 0) {
      // Errors may still stand (unresolved): then ECHEC is kept, with the
      // files listed above. TERMINE only when nothing stands unresolved.
      if (!verdict.unresolved.length) verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      if (!finalText.trim()) finalText = 'Tache terminee.';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (declared && runOnly && okCalls > 0) {
      verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      finalText = (finalText.trim() || 'Execution verifiee.') + '\n\nAucun fichier modifie (execution seule, verifiee : ' + okCalls + ' appels aboutis).';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (!declared && (filesModified.length > 0 || finalText.trim())) {
      // Undeclared but real: modified files without a declaration, or an
      // answer already produced (context/loop rescue): keep the verdict.
    } else if (!declared || verdict.status === 'TERMINE') {
      // P49-2 target: false TERMINE (declared, no evidence) and answerless
      // stops (no_tool). A declared ECHEC (mid-turn approval need, standing
      // tool errors) is loud already: it stands, never downgraded.
      const totalCalls = run.calls.filter((c) => c.code !== 'skipped').length;
      let raison = '';
      if (mode === 'plan') raison = 'mode PLAN : les modifications sont refusees (basculez en BUILD pour modifier).';
      else if (stopReason === 'no_tool') raison = stopDetail;
      else if (!totalCalls) raison = 'aucun appel d\'outil emis.';
      else if (!okCalls) {
        const errs = run.calls.filter((c) => !c.ok).slice(0, 3).map((c) => c.tool + '/' + (c.code || 'error'));
        raison = 'tous les appels ont echoue (' + errs.join(', ') + ').';
      } else raison = 'appels lecture seule uniquement, aucun fichier touche.';
      finalText = 'AUCUNE MODIFICATION : ' + raison + '\n\nProposition : reformulez en UNE action precise (ex : "cree le fichier X qui ..."), ' +
        (mode === 'plan' ? 'basculez en BUILD pour modifier.' : 'verifiez les chemins (list/glob) puis relancez.');
      verdict = { status: 'PARTIEL', reason: 'AUCUNE MODIFICATION : ' + raison, unresolved: verdict.unresolved };
      // The honest text above must be the stored answer too (next-turn
      // history and panels read the store, not just message.done).
      store.append(sessionId, { role: 'assistant', content: finalText });
    }
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

module.exports = { runTurn, abortRun, computeRunStatus, unresolvedErrors, detectRepetition, MAX_TOOL_ITERS };
