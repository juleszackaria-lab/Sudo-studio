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
const { execFileSync } = require('child_process');
const { probeProvider, streamChat, chatOnce, waitForRuntime, runtimeDeadline } = require('./providers');
const { classifyAction } = require('./intent');
const { executeTool, toOpenAISchema, ensureSeriesCheckpoint, saveRunSidecar } = require('./tools');
const routerMod = require('./router'); // P59-B: routeur d intention deterministe
const platformMod = require('./platform'); // P59-A: pont plateforme (resultat pre-charge)
const { loadProjectRules } = require('./permissions');
const { diffSnapshot } = require('./checkpoints');
const { maskSecrets } = require('./journal');
const plan = require('./plan');
const orch = require('./orch');
const specMod = require('./spec'); // P56: cahiers des charges longs
const jobMod = require('./job');   // P56: projet = plan + etat sur disque + reprise
const modes = require('./modes');
const prereq = require('./prereq');
const msgs = require('./msgs');
const profiles = require('./profiles');

// P57: en dessous de ce contexte, l'inventaire d'extensions n'est pas injecte
// dans le prompt (il mangeait le budget des petits modeles) ; les outils
// restent la voie d'acces.
const EXT_MIN_CTX = 8192;
const compressMod = require('./compress');
const verifyMod = require('./verify');
const mcpMod = require('./mcp');
const skillsMod = require('./skills');
const agentsMod = require('./agents');
const commandsMod = require('./commands');
const recovery = require('./recovery');
const recipes = require('./recipes');
const extMod = require('./extensions');
const pmap = require('./projectmap');
const resolvePath = require('./resolvePath'); // P61-8: resolution tolerante des chemins

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
// P61-5: outils dont la cible doit avoir ete LUE avant d'agir (l'agent li
// lui-meme au lieu de renvoyer une erreur au modele).
const NEEDS_PRIOR_READ = ['delete', 'rename'];
const AUTO_READ_LINES = 200;

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
  const wo = ctx.waitOpts || {};
  // P62-B1: la fenetre d attente est basee sur le TEMPS (180 s par defaut),
  // avec une echeance PARTAGEE par tout le tour. Seuls les harnais qui
  // epinglent `attempts` gardent l ancien compteur, pour rester rapides.
  const pinned = Number(wo.attempts) > 0;
  const common = {
    probeTimeoutMs: wo.probeTimeoutMs,
    shouldAbort: ctx.shouldAbort,
    onProgress: (n, max, message) => {
      try { ctx.onEvent({ type: 'runtime.wait', attempt: n, maxAttempts: max, message }); } catch (_) {}
    },
  };
  const w = await waitForRuntime(ctx.provider, pinned
    ? Object.assign({}, common, { attempts: wo.attempts, delayMs: wo.delayMs, quickRefusedFail: true })
    : Object.assign({}, common, { budgetMs: wo.budgetMs || 180000, deadline: wo.deadline }));
  return { retry: !!(w.recovered && w.probe && w.probe.ok), wait: w };
}

// P62-B1: fenetre d attente par defaut = 180 s (contrat produit). Les tests
// et harnais peuvent la reduire par variable d environnement, sans jamais
// changer le comportement livre.
function runtimeBudgetMs() {
  const v = Number(process.env.SUDO_AGENT_RUNTIME_WAIT_MS);
  return (v > 0 ? v : 180000);
}

// P62-B2: apres la fenetre d attente, on demande UNE relance au superviseur
// avant d annoncer l echec. Le superviseur vit dans le backend (processus
// separe) : il n est donc pas ralenti par le masquage de la fenetre.
// Jamais bloquant : un backend absent rend { attempted: false }.
async function relanceSuperviseur(ctx) {
  let platform = null;
  try { platform = require('./platform'); } catch (_) { platform = null; }
  if (!platform || typeof platform.backendCall !== 'function') return { attempted: false, outcome: 'module absent' };
  let r = null;
  try { r = await platform.backendCall({}, 'POST', '/api/supervisor/runtime-restart', {}, 15000); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  const outcome = r && r.ok ? 'relance demandee (' + Number((r.body && r.body.status) || 0) + ')'
    : 'relance impossible (' + String((r && (r.error || r.status)) || 'backend injoignable') + ')';
  try { if (ctx.journal) ctx.journal(r && r.ok ? 'info' : 'warn', 'relance superviseur', { outcome: outcome.slice(0, 160) }); } catch (_) {}
  try { if (ctx.onEvent) ctx.onEvent({ type: 'runtime.restart', attempted: !!(r && r.ok), outcome: outcome.slice(0, 200) }); } catch (_) {}
  return { attempted: !!(r && r.ok), outcome };
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

// P59-13: `git status` BEFORE and AFTER every task, journaled (one line each).
// Read-only, 5 s max, never fatal: a folder without git simply reports 'sans git'.
function gitStatusOf(root) {
  if (!root) return { kind: 'sans projet' };
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = String(out).split(/\r?\n/).filter((l) => l.trim());
    return { kind: 'git', count: lines.length, sample: lines.slice(0, 12).map((l) => l.trim().slice(0, 120)) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { kind: /not a git repository/i.test(msg) ? 'sans git' : 'erreur', error: msg.slice(0, 120) };
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
  // P56-6: a step may run on another model (policy), when it is available.
  const model = opts.modelOverride || provider.model || (probe.models && probe.models[0]) || '';
  if (!model) return fail('no_model', 'Aucun modele charge sur le runtime local (liste des modeles vide).');

  // P54-3: custom command. "/name args" becomes the rendered template; an
  // unknown command is reported honestly (never a silent chat fallback).
  // Done here so questions, tool turns and legacy turns behave the same.
  let turnPrompt = prompt;
  let storedText = prompt;
  try {
    const home0 = homeOf(opts.toolsCtx);
    let root0 = null;
    try {
      root0 = fs.realpathSync(session.projectRoot);
    } catch (_) {
      try { root0 = session.projectRoot || null; } catch (_) { root0 = null; }
    }
    const cmd = commandsMod.expand(home0, root0, prompt);
    if (cmd && cmd.matched) {
      if (!cmd.ok) {
        if (log) { try { log.warn('commande inconnue', { session: sessionId, name: String(cmd.name || '').slice(0, 40) }, corr); } catch (_) {} }
        store.append(sessionId, { role: 'user', content: prompt });
        store.append(sessionId, { role: 'assistant', content: cmd.error });
        try { onEvent({ type: 'message.start', role: 'assistant' }); } catch (_) {}
        try { onEvent({ type: 'message.done', text: cmd.error, aborted: false }); } catch (_) {}
        try { onEvent({ type: 'turn.start', turnId: corr, model }); } catch (_) {}
        try { onEvent({ type: 'turn.done', turnId: corr, messageCount: (store.get(sessionId) || { messages: [] }).messages.length, model, aborted: false, status: 'PARTIEL', reason: 'unknown_command', filesModified: [], stopReason: 'unknown_command', declaredDone: true, toolCalls: 0, unresolvedErrors: [] }); } catch (_) {}
        return { status: 'done', model, runStatus: 'PARTIEL', code: 'unknown_command' };
      }
      turnPrompt = cmd.prompt;
      storedText = 'Commande /' + cmd.name + (cmd.scope === 'project' ? ' (projet)' : '') + ' :\n' + cmd.prompt;
      if (log) {
        try { log.info('commande developpee', { session: sessionId, name: String(cmd.name).slice(0, 40), scope: cmd.scope, chars: cmd.prompt.length }, corr); } catch (_) {}
        if (cmd.missing && cmd.missing.length) { try { log.warn('commande argument manquant', { session: sessionId, args: cmd.missing.join(',') }, corr); } catch (_) {} }
      }
    }
  } catch (e) {
    if (log) { try { log.warn('commande illisible', { session: sessionId, error: String((e && e.message) || e).slice(0, 120) }, corr); } catch (_) {} }
  }
  store.append(sessionId, { role: 'user', content: storedText });
  const sessionNow = store.get(sessionId) || session;
  const useTools = !!opts.toolsCtx && sessionNow.projectRoot && opts.tools !== false;
  // P59-13: git status before/after (read-only proof that the agent did not
  // touch files outside the demand). Journaled once each, never fatal.
  const _root = (opts.toolsCtx && opts.toolsCtx.root) || sessionNow.projectRoot || null;
  const _gitBefore = gitStatusOf(_root);
  if (log) { try { log.info('git statut avant', { session: sessionId, kind: _gitBefore.kind, count: _gitBefore.count || 0, sample: (_gitBefore.sample || []).join(' | ') }, corr); } catch (_) {} }
  const _after = (res) => {
    const g = gitStatusOf(_root);
    if (log) { try { log.info('git statut apres', { session: sessionId, kind: g.kind, count: g.count || 0, delta: (g.count || 0) - (_gitBefore.count || 0), sample: (g.sample || []).join(' | ') }, corr); } catch (_) {} }
    return res;
  };



  // P62-B1: une seule echeance monotone pour TOUT le tour. Le compteur ne
  // repart jamais a zero entre deux points d attente.
  const rwDeadline = (opts.runtimeWait && opts.runtimeWait.deadline) ||
    runtimeDeadline((opts.runtimeWait && opts.runtimeWait.budgetMs) || runtimeBudgetMs());
  const base = { store, provider, sessionId, prompt: turnPrompt, corr, log, runs, onEvent, model, probeTimeoutMs, preProbe: probe, verify: opts.verify, runtimeWait, rwDeadline, maxIt: opts.maxIt, subDepth: opts.subDepth };
  if (useTools) return _after(await toolsTurn(base, sessionNow, opts.toolsCtx));
  return _after(await legacyTurn(base, sessionNow));
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
  // P59-B: a QUESTION about a platform feature ("Que dit le System Doctor ?")
  // gets the same deterministic routing + pre-loaded READ result as an ACTION.
  // No tool is offered (this path never calls one), the data is injected.
  let platformQ = '';
  try {
    const qroute = routerMod.route(base.prompt);
    if (qroute.domain && qroute.prefetch) {
      const pf = await platformMod.run({
        root, home: homeOf(toolsCtx), ctxTokens: base.ctxTokens,
        backendUrl: process.env.SUDO_BACKEND_URL, backendToken: process.env.SUDO_BACKEND_TOKEN,
      }, qroute.prefetch, {});
      if (pf.ok) {
        platformQ = 'DONNEES PLATEFORME (' + qroute.domain + ', source reelle)\n' + pf.summary;
        journal('info', 'plateforme question prechargee', { tool: qroute.prefetch, chars: pf.chars });
      } else {
        journal('warn', 'plateforme question indisponible', { tool: qroute.prefetch, code: pf.code });
      }
    }
  } catch (e) {
    journal('warn', 'plateforme question erreur', { error: String((e && e.message) || e).slice(0, 120) });
  }
  const messages = [{ role: 'system', content: 'You are Sudo Agent. Answer the question about this project briefly, from the context. No tools.' }];
  if (mapText) messages.push({ role: 'system', content: mapText });
  if (preloadText) messages.push({ role: 'system', content: preloadText });
  if (platformQ) messages.push({ role: 'system', content: filter(platformQ) });
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
// P54-5: global rules (Agent Extensions > Rules, scope global). Capped, never
// throws: a broken file must never break a turn.
// P57(3): "@nom" dans la barre de texte. Un skill -> son contenu complet est
// charge (une fois) ; un agent -> le tour delegue a cet agent. Aucun "@" ou nom
// inconnu : aucune erreur, le texte reste une demande normale.
function parseMention(home, root, prompt) {
  const m = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/.exec(String(prompt || ''));
  if (!m) return null;
  const name = m[2];
  const rest = String(prompt).replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  try {
    const d = extMod.describe(home, root, name);
    if (d.ok && d.kind === 'skill') return { kind: 'skill', name: d.name, rest, active: d.active };
    if (d.ok && d.kind === 'agent') return { kind: 'agent', name: d.name, rest };
  } catch (_) { return null; }
  return null;
}

function readGlobalRulesSafe(home) {
  try {
    const t = agentsMod.readGlobalRules(home);
    if (!t || t.length > MAX_AGENTS_MD) return null;
    return 'Regles globales (Agent Extensions) :\n' + t;
  } catch (_) { return null; }
}

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
// P61: 'already_done' et 'duplicate' ne sont PAS des echecs : le travail a
// deja ete fait une fois (idempotence), le doublon est simplement ecarte.
// 'target_given_up' est une explication d'arret, pas une erreur d'outil.
const GUIDANCE_CODES = ['todos_open', 'no_plan', 'engine_todos', 'recon_required', 'verify', 'corrective', 'verify_timeout',
  'already_done', 'duplicate', 'not_found_resolved'];

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
      // P53-1: a missing tool is recovered by ANY later success (the model
      // adapted: another tool, or the user installed it mid-turn).
      if (c.code === 'tool_missing') { fixed = true; break; }
      if (calls[j].tool === c.tool && calls[j].target === c.target) { fixed = true; break; }
    }
    if (!fixed) bad.push(c);
  }
  return bad;
}

// P53-3: ECHEC only when NOTHING could be done. Real modifications plus
// standing tool errors, or an impossible/failed verification, are a PARTIEL
// with the file list and the honest reason.
function computeRunStatus(declared, calls, extra) {
  const unresolved = unresolvedErrors(calls);
  const ex = extra || {};
  const files = Array.isArray(ex.files) ? ex.files : [];
  const verifyNote = ex.verifyNote ? String(ex.verifyNote) : '';
  const lang = ex.lang === 'en' ? 'en' : 'fr';
  const filesTxt = files.slice(0, 6).join(', ');
  if (!declared) {
    return { status: 'PARTIEL', reason: 'iterations max atteintes sans reponse finale.', unresolved, verifyNote,
      partialFiles: files.slice() };
  }
  if (unresolved.length) {
    const names = unresolved.slice(0, 5).map((c) => c.tool + ':' + (c.code || 'error')).join(', ');
    const why = 'erreurs d\'outil non resolues : ' + names;
    if (files.length) {
      return { status: 'PARTIEL', reason: msgs.t(lang).finalPartial(files.length, filesTxt, why),
        unresolved, verifyNote, partialFiles: files.slice() };
    }
    return { status: 'ECHEC', reason: why + '.', unresolved, verifyNote };
  }
  if (verifyNote) {
    const reason = files.length ? msgs.t(lang).finalPartial(files.length, filesTxt, verifyNote)
      : 'verification non executee ou echouee : ' + verifyNote + '.';
    return { status: 'PARTIEL', reason, unresolved, verifyNote, partialFiles: files.slice() };
  }
  return { status: 'TERMINE', reason: '', unresolved, verifyNote };
}

// P61-9: aucun statut (PARTIEL / ECHEC / abandonne) n'est pose sans un texte
// visible qui dit POURQUOI, CE QUI EST FAIT et CE QUI RESTE. Fonction pure.
function statusNotice(verdict, calls, filesModified, stopReason) {
  const v = verdict || {};
  if (v.status === 'TERMINE') return '';
  const done = (calls || []).filter((c) => c.ok && c.code !== 'skipped');
  const ko = (calls || []).filter((c) => !c.ok && c.code !== 'skipped' && GUIDANCE_CODES.indexOf(c.code) === -1);
  const lines = [];
  const why = String(v.reason || stopReason || 'non precisee').replace(/[.\s]+$/, '');
  lines.push('Statut : ' + (v.status || 'PARTIEL') + ' - raison : ' + why + '.');
  if (filesModified && filesModified.length) {
    lines.push('Fait : ' + filesModified.length + ' fichier(s) modifie(s) (' + filesModified.slice(0, 6).join(', ') + ').');
  } else if (done.length) {
    const uniq = [];
    for (const c of done) { const k = c.tool + (c.target ? ' ' + String(c.target).slice(0, 40) : ''); if (uniq.indexOf(k) === -1) uniq.push(k); }
    lines.push('Fait : ' + uniq.slice(0, 6).join(', ') + '.');
  } else {
    lines.push('Fait : aucun appel abouti.');
  }
  if (ko.length) {
    const uniq = [];
    for (const c of ko) { const k = c.tool + ' (' + (c.code || 'echec') + ')'; if (uniq.indexOf(k) === -1) uniq.push(k); }
    lines.push('Reste : ' + uniq.slice(0, 6).join(', ') + '.');
  } else {
    lines.push('Reste : la demande n\'a pas ete confirmee terminee ; relancez-la ou precisez l\'action.');
  }
  return lines.join('\n');
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
  const rwDeadline = base.rwDeadline || null; // P62-B1: echeance partagee du tour
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
  // P59-B: deterministic pre-router. It picks the domain (security, analysis,
  // devops, doctor, logs, extensions), the at-most-6 platform tools this turn
  // may use, and the READ tool whose result is pre-loaded into the context.
  // The model never has to choose among thirty tools for a platform question.
  const route = routerMod.route(base.prompt);
  const routeFix = routerMod.wantsFix(base.prompt) && route.domain === 'security';
  journal('info', 'route intention', { domain: route.domain || 'aucun', tools: route.tools.join(','), fix: routeFix });
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
  // P62-F2: refus d'approbation -> arret immediat et raison explicite.
  let operatorDenied = null;
  if (base.maxIt !== undefined && base.maxIt !== null) {
    const m = parseInt(base.maxIt, 10);
    if (Number.isFinite(m)) maxIt = Math.min(10, Math.max(1, m));
  }
  const subDepth = base.subDepth || 0; // P50-6: spawn allowed only at depth 0
  const ctxTokens = profiles.resolveCtxTokens({ override: process.env.SUDO_AGENT_CTX_TOKENS, probeNctx: probeNctx(base.preProbe, model), providerType: provider.type });

  // P59-B: pre-load the matching READ tool. Bounded (25% of n_ctx) and masked
  // by the bridge; a failure is journaled and never blocks the turn.
  let platformText = '';
  if (route.domain && route.prefetch) {
    try {
      const pf = await platformMod.run({
        root, home, ctxTokens,
        backendUrl: process.env.SUDO_BACKEND_URL, backendToken: process.env.SUDO_BACKEND_TOKEN,
      }, route.prefetch, {});
      if (pf.ok) {
        platformText = 'DONNEES PLATEFORME (' + route.domain + ', ' + route.prefetch + ', source reelle)\n' + pf.summary;
        // Budget guard: the pre-loaded result must never push the turn over its
        // own context (a 2k window cannot pay for a full audit). 10% of n_ctx,
        // and nothing at all below 4k - the routed TOOLS stay available, so the
        // agent can still ask for the data explicitly.
        if (ctxTokens < 4096) {
          platformText = '';
          journal('info', 'plateforme omise (contexte trop petit)', { ctx: ctxTokens, tool: route.prefetch });
        } else {
          const cap = Math.max(400, Math.floor(ctxTokens * 4 * 0.10));
          if (platformText.length > cap) platformText = platformText.slice(0, cap - 24) + '\n... [tronque]';
        }
        journal('info', 'plateforme prechargee', { tool: route.prefetch, chars: platformText.length });
      } else {
        journal('warn', 'plateforme indisponible', { tool: route.prefetch, code: pf.code });
        platformText = 'PLATEFORME : ' + route.prefetch + ' indisponible - ' + String(pf.error || '').slice(0, 160);
      }
    } catch (e) {
      journal('warn', 'plateforme erreur', { tool: route.prefetch, error: String((e && e.message) || e).slice(0, 120) });
    }
  }

  // P59-5: "corrige les failles" is a PROTOCOL, not a single edit: one fix at
  // a time, each with its diff + approval, then the audit is RE-RUN. A vuln is
  // never called fixed without a confirming audit.
  if (routeFix && platformText) {
    platformText += '\n\nPROTOCOLE DE CORRECTION (obligatoire) :\n' +
      '1) classe les failles par gravite et traite UNE seule faille par pas ;\n' +
      '2) chaque correction passe par edit/patch (diff affiche puis approbation) ;\n' +
      '3) apres chaque correction, appelle security_audit_run pour confirmer ;\n' +
      '4) ne declare JAMAIS une faille corrigee sans une relance qui le prouve ;\n' +
      '5) termine par le score AVANT / APRES et la liste des failles restantes avec la raison.';
    journal('info', 'protocole correction failles', { domain: route.domain });
  }

  const runEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };

  // P56-1: a LONG brief (>= SUDO_AGENT_SPEC_LINES lines or SUDO_AGENT_SPEC_CHARS
  // chars) is stored as a SPEC document on disk; the context only ever gets a
  // section slice. The engine extracts sections + numbered requirements, builds
  // the plan and STOPS for validation (Lancer / Modifier) before any action.
  // A later short "lancer" / "reprendre" resumes the stored job on disk.
  let jobState = null;
  try {
    const rootP = session.projectRoot;
    const isChildTurn = !!(toolsCtx && (toolsCtx.noOrchPlan || toolsCtx.noResume));
    if (mode === 'build' && !isChildTurn && rootP && intent.kind !== 'QUESTION') {
      const short = String(base.prompt || '').trim();
      const wantsStart = short.length < 400 && /^\s*(lancer|lance|demarrer|demarre|valider|valide|go)\b/i.test(short);
      const wantsResume = short.length < 400 && /reprend/i.test(short);
      const resum = (wantsStart || wantsResume) ? jobMod.resumable(rootP) : null;
      if (resum) {
        jobState = jobMod.load(rootP, resum.id);
        if (log) { try { log.info('projet repris', { session: sessionId, job: resum.id, restant: resum.steps - resum.done }, corr); } catch (_) {} }
      } else if (specMod.isLongSpec(base.prompt)) {
        const meta = specMod.ingest(rootP, base.prompt, {});
        if (!meta.error) {
          const stepsP = specMod.planSteps(meta);
          const st = jobMod.create(rootP, meta, stepsP, {});
          const planTxt = specMod.planText(meta, stepsP);
          if (log) { try { log.info('cahier des charges recu', { session: sessionId, spec: meta.id, lignes: meta.lines, exigences: meta.requirements.length, etapes: stepsP.length }, corr); } catch (_) {} }
          store.append(sessionId, { role: 'assistant', content: planTxt });
          try { onEvent({ type: 'message.start', role: 'assistant' }); } catch (_) {}
          try { onEvent({ type: 'message.done', text: planTxt, aborted: false }); } catch (_) {}
          try { onEvent({ type: 'job.plan', jobId: st.id, specId: meta.id, steps: stepsP.length,
            requirements: meta.requirements.length, sections: meta.sections.length,
            title: meta.title, plan: planTxt.slice(0, 6000) }); } catch (_) {}
          try {
            onEvent({ type: 'turn.done', turnId: corr, messageCount: (store.get(sessionId) || { messages: [] }).messages.length,
              model, aborted: false, status: 'PARTIEL', reason: 'plan en attente de validation (Lancer / Modifier).',
              filesModified: [], stopReason: 'spec_plan', declaredDone: true, toolCalls: 0, unresolvedErrors: [] });
          } catch (_) {}
          if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
          return { status: 'done', model, runStatus: 'PARTIEL', code: 'spec_plan', job: st.id, spec: meta.id };
        }
        if (log) { try { log.warn('cahier des charges refuse', { error: String(meta.error).slice(0, 120) }, corr); } catch (_) {} }
      }
    }
  } catch (e) {
    if (log) { try { log.warn('cahier des charges illisible', { error: String((e && e.message) || e).slice(0, 120) }, corr); } catch (_) {} }
  }
  runs.set(sessionId, runEntry);
  const run = { id: turnId, sessionId, checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: runEntry.killFns };
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}

  const agentsMd = [readGlobalRulesSafe(home), readAgentsMd(root)].filter(Boolean).join('\n\n');
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

  // P55-4: recette integree chargee A LA DEMANDE. Elle n'est injectee que si
  // la demande correspond a une tache frequente (aucun cout sinon) et elle
  // porte la pile detectee du projet (dossier de tests, commande a lancer).
  let recipeText = '';
  try {
    recipeText = recipes.promptText(base.prompt, root);
    if (recipeText) journal('info', 'recette chargee', { recipe: (recipes.match(base.prompt) || {}).id || '?',
      chars: recipeText.length });
  } catch (e) {
    journal('warn', 'recette indisponible', { error: String((e && e.message) || e).slice(0, 120) });
  }

  // P57(1): registre d'extensions. Le contexte ne recoit que des NOMS et UNE
  // ligne de description (jamais les corps de skills) ; le moteur propose
  // d'office les extensions pertinentes pour la demande. Les fonctions
  // extensions_list/describe/skill_load/mcp_call font le reste A LA DEMANDE.
  let extDigest = '';
  let extProposal = '';
  // P57(1): sur un contexte micro (<=4096), l'inventaire n'apporte rien et
  // ferait deborder le prompt : il est omis, et les outils (extensions_list,
  // extensions_describe) restent disponibles a la demande. Le journal le dit.
  const extRoom = ctxTokens >= EXT_MIN_CTX;
  if (extRoom) {
    try {
      extDigest = extMod.digest(home, root);
      extProposal = extMod.proposalText(home, root, base.prompt);
      const sug = extMod.suggest(home, root, base.prompt, 3);
      if (extDigest || extProposal) {
        journal('info', 'extensions visibles', { digestChars: extDigest.length,
          proposed: sug.map((x) => x.kind + ':' + x.name) });
      }
    } catch (e) {
      journal('warn', 'extensions illisibles', { error: String((e && e.message) || e).slice(0, 120) });
    }
  } else {
    journal('info', 'extensions omises (contexte court)', { ctx: ctxTokens, min: EXT_MIN_CTX });
  }
  // P57(3): "@nom" dans la barre de texte charge un skill ou cible un agent.
  let mention = null;
  try { mention = parseMention(home, root, base.prompt); } catch (_) { mention = null; }
  let mentionText = '';
  if (mention && mention.kind === 'skill') {
    // Le corps n'entre dans le contexte QUE parce que l'utilisateur l'a
    // explicitement cite : meme chemin que skill_load (skill actif exige).
    try {
      const sk = extMod.loadSkill(home, root, mention.name);
      if (sk.ok) {
        mentionText = 'SKILL ' + sk.scope + '/' + sk.name + ' (charge par @mention)\n' + sk.text;
        journal('info', 'skill charge par mention', { name: sk.name, chars: sk.text.length });
      } else {
        journal('warn', 'mention skill refusee', { name: mention.name, code: sk.code || 'error' });
      }
    } catch (e) { journal('warn', 'mention skill illisible', { error: String((e && e.message) || e).slice(0, 120) }); }
  }
  if (mention && mention.kind === 'agent') {
    try {
      const def = agentsMod.findAgent(home, mention.name);
      if (def) {
        if (Array.isArray(def.tools) && def.tools.length) base.allowedTools = def.tools.slice(0, 40);
        if (def.instructions) mentionText = 'AGENT ' + def.name + ' (choisi par @mention)\n' + String(def.instructions).slice(0, 2000);
        journal('info', 'agent cible par mention', { name: def.name, tools: (def.tools || []).length });
      }
    } catch (_) { /* la mention ne casse jamais le tour */ }
  }
  if (mention) journal('info', 'mention resolue', { kind: mention.kind, name: mention.name });

  const sessionRulesMap = (toolsCtx && toolsCtx.sessionRules) || new Map();
  if (!sessionRulesMap.has(sessionId)) sessionRulesMap.set(sessionId, new Set());
  const projRules = loadProjectRules(home, root);

  const tctx = {
    root, sessionId, session, store, log, corr, run, home, mode,
    ctxTokens, platformTools: route.tools, // P59: budget + routed surface
    backendUrl: process.env.SUDO_BACKEND_URL, backendToken: process.env.SUDO_BACKEND_TOKEN,
    sessionRules: sessionRulesMap.get(sessionId),
    projectRules: projRules.rules,
    sessionKill: runEntry.killFns,
    checkpoint: null,
  };
  tctx.checkpoint = () => ensureSeriesCheckpoint(tctx);

  // P26-b/e: tool schemas for the profile + (full only) policy-allowed MCP tools.
  // P57-1: les schemas d'extensions ne sont proposes que si le contexte les
  // porte (meme seuil que le digest) ; sinon l'agent garde son jeu d'avant.
  const schemas = toOpenAISchema(profile, ctxTokens, { platformTools: route.tools });
  if (profile === 'full') {
    let servers = {};
    try { servers = mcpMod.loadConfig(home); } catch (_) { servers = {}; }
    for (const srv of Object.keys(servers)) {
      // P54-1: a DISABLED server never spawns and never offers tools.
      let expose = [];
      try { expose = mcpMod.exposedTools(home, srv); } catch (_) { expose = []; }
      if (!expose.length) continue;
      try {
        const listed = await mcpMod.listTools(home, srv, (m) => journal('info', 'mcp', { msg: m }));
        for (const t of listed) {
          if (!t || !t.name || expose.indexOf(t.name) === -1) continue;
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
  // P54-4: a custom agent may restrict the tools its child turn can use. The
  // finish tools stay available so a turn can always end honestly.
  if (Array.isArray(base.allowedTools) && base.allowedTools.length) {
    const keep = new Set(base.allowedTools.concat(['reply', 'done']));
    const filtered = schemas.filter((x) => x && x.function && keep.has(x.function.name));
    if (filtered.length) {
      schemas.length = 0;
      for (const x of filtered) schemas.push(x);
      journal('info', 'outils restreints (agent)', { tools: filtered.length });
    }
  }
  let activeSchemas = schemas;
  let schemaChars = JSON.stringify(activeSchemas).length;

  // P53-5: the engine speaks the conversation language (French by default).
  let convLang = 'fr';
  try {
    const recent = (store.get(sessionId) || { messages: [] }).messages.slice(-4)
      .filter((x) => x && x.role === 'user').map((x) => String(x.content || '')).join('\n');
    convLang = msgs.detectLang(String(base.prompt || '') + '\n' + recent, 'fr');
  } catch (_) { convLang = 'fr'; }
  const T = () => msgs.t(convLang);
  tctx.lang = convLang; // tools speak the conversation language too (P53-5)
  // P53-7: verified machine environment (5 s probes, cached, same data the
  // Environment panel shows). Failures never break a turn.
  let envSnap = null;
  try { envSnap = await prereq.envSnapshot(); } catch (_) { envSnap = null; }
  if (envSnap && envSnap.missing && envSnap.missing.length) {
    journal('info', 'environnement', { lang: convLang, absents: envSnap.missing.slice(0, 10).join(',') });
  }

  const modelMessages = () => {
    const stored = (store.get(sessionId) || { messages: [] }).messages.slice(-MAX_HISTORY);
    const out = toProviderMessages(stored, false);
    if (agentsMd) out.unshift({ role: 'system', content: 'Project instructions (AGENTS.md):\n' + filter(agentsMd) });
    let sys = modes.modeSystem(mode, profile, { lang: convLang, env: envSnap }); // P43-3: terse system on small; P53-5/7: language + environment
    const note = profiles.chunkNote(profile);
    if (note) sys += '\n' + note;
    out.unshift({ role: 'system', content: sys });
    // P39-a/c: map then preload, right after the system prompt (both are
    // counted by the context estimate, P39-e).
    if (preloadText) out.splice(1, 0, { role: 'system', content: preloadText });
    if (platformText) out.splice(1, 0, { role: 'system', content: filter(platformText) });
    if (mapText) out.splice(1, 0, { role: 'system', content: mapText });
    // P50-2: skills after map/preload (counted by the context estimate).
    if (skillsText) out.splice(1 + (mapText ? 1 : 0) + (preloadText ? 1 : 0), 0, { role: 'system', content: filter(skillsText) });
    if (recipeText) out.splice(1 + (mapText ? 1 : 0) + (preloadText ? 1 : 0) + (skillsText ? 1 : 0), 0,
      { role: 'system', content: filter(recipeText) });
    // P57(1): inventaire compact + propositions (noms et une ligne seulement).
    let extAt = 1 + (mapText ? 1 : 0) + (preloadText ? 1 : 0) + (skillsText ? 1 : 0) + (recipeText ? 1 : 0);
    if (extDigest) { out.splice(extAt, 0, { role: 'system', content: filter('EXTENSIONS DISPONIBLES\n' + extDigest) }); extAt += 1; }
    if (extProposal) { out.splice(extAt, 0, { role: 'system', content: filter(extProposal) }); extAt += 1; }
    if (mentionText) out.splice(extAt, 0, { role: 'system', content: filter(mentionText) });
    return out;
  };
  // Field named `ctx` (not ctxTokens): the journal masks *token* substrings.
  // P39-e: initial estimate covers system prompt + schemas + map + preload.
  const est0 = profiles.estimateTokens(modelMessages(), schemaChars);
  journal('info', 'turn start', { model, tools: true, mode, profile, ctx: ctxTokens, est0,
    mapTokens: mapInfo ? mapInfo.tokens : 0, preload: preloadText ? preloadText.length : 0,
    agentsMd: agentsMd ? agentsMd.length : 0 });
  // P61-16: budget strict - jamais plus de 70 % de n_ctx par appel.
  const CTX_BUDGET = 0.70;
  // P61-16/19: si l'overhead FIXE (instructions + schemas) mange deja le
  // budget de 70 %, on REDUIT la surface d'outils du tour au lieu de bloquer.
  // Degradation progressive : jeu complet -> jeu reduit -> 6 outils coeur.
  const CORE6 = ['read', 'write', 'edit', 'reply', 'done', 'bash'];
  const trimSchemas = () => {
    const steps = [];
    const red = recovery.reducedTools(activeSchemas);
    if (red.length && red.length < activeSchemas.length) steps.push({ how: 'reduit', set: red });
    const core = activeSchemas.filter((x) => x && x.function && CORE6.indexOf(x.function.name) !== -1);
    if (core.length && (!red.length || core.length < red.length)) steps.push({ how: 'coeur6', set: core });
    for (const st of steps) {
      const chars = JSON.stringify(st.set).length;
      if (chars < schemaChars) {
        activeSchemas = st.set; schemaChars = chars;
        journal('info', 'surface d outils reduite pour tenir le budget', { how: st.how,
          tools: st.set.length, budget: CTX_BUDGET });
      }
      const est = profiles.estimateTokens(modelMessages(), schemaChars);
      if (est <= ctxTokens * CTX_BUDGET) break;
    }
  };
  if (est0 > ctxTokens * CTX_BUDGET) {
    journal('warn', 'contexte initial eleve, reduction de la surface', { est0, ctx: ctxTokens, budget: CTX_BUDGET });
    trimSchemas();
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
    const sysChars = modes.modeSystem(mode, profile).length + profiles.chunkNote(profile).length + (agentsMd ? agentsMd.length : 0) + (skillsText ? skillsText.length : 0) + (recipeText ? recipeText.length : 0) + extDigest.length + extProposal.length + mentionText.length;
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
    // P61-16: 70 % maximum de n_ctx par appel (au-dela on compresse).
    if (est <= ctxTokens * CTX_BUDGET) return { ok: true, compressed: false };
    // P61-16: l'overhead fixe seul peut depasser le budget. Ce n'est pas un
    // historique a compresser : on reduit la surface d'outils et on continue.
    const fixedOnly = profiles.estimateTokens(modelMessages().slice(0, 1), schemaChars);
    if (fixedOnly > ctxTokens * CTX_BUDGET) { trimSchemas(); }
    const stored = (store.get(sessionId) || { messages: [] }).messages;
    if (stored.length <= 5) {
      // P61-16: un historique court ne se compresse pas. Deux cas distincts :
      //  - au-dela de 100 % du contexte, meme la demande nue ne rentre pas :
      //    on s'arrete HONNETEMENT (reponse de secours, statut PARTIEL) ;
      //  - entre 70 % et 100 %, l'overhead fixe explique le depassement et la
      //    surface d'outils vient d'etre reduite : le tour CONTINUE (bloquer
      //    ici punirait la taille du contrat d'outils, pas l'historique).
      const estR = profiles.estimateTokens(modelMessages(), schemaChars);
      if (estR > ctxTokens) {
        return { ok: false, reason: 'contexte sature (' + estR + ' tokens estimes pour ' + ctxTokens + ', historique trop court pour compresser).' };
      }
      journal('warn', 'budget depasse apres reduction (historique court), poursuite',
        { est: estR, ctx: ctxTokens, budget: CTX_BUDGET, tools: activeSchemas.length });
      return { ok: true, compressed: false, saturated: true };
    }
    const old = stored.slice(0, -4).map((m) => {
      let c = m.content || '';
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) c += '\n[appels: ' + m.tool_calls.map((t) => t.name).join(', ') + ']';
      return { role: m.role === 'tool' ? 'user' : m.role, content: ('[' + m.role + '] ' + c).slice(0, 2000) };
    });
    // P61-16: sur un historique court (moins de 8 messages), un petit modele
    // n'a rien d'utile a resumer ET l'appel de resume coute un tour complet :
    // on prend le resume DETERMINISTE, sans appel modele. Au-dela, le modele
    // resume (avec repli deterministe s'il ne rend rien).
    let summary = '';
    let summaryFromModel = false;
    if (stored.length >= 8) {
      try {
        const r = await chatOnce(provider, { model, messages: [{ role: 'system', content: compressMod.summarizePrompt() }].concat(old) });
        summary = String(r.text || '').trim();
        summaryFromModel = !!summary;
      } catch (e) {
        journal('warn', 'compression failed', { error: String((e && e.message) || e).slice(0, 160) });
        summary = '';
      }
    }
    // P61-16: pas de resume modele utilisable -> resume DETERMINISTE (jamais
    // d'echec de compression du a un petit modele).
    let how = summaryFromModel ? 'modele' : 'deterministe (historique court ou modele muet)';
    if (!summary) {
      summary = compressMod.deterministicSummary(stored);
      how = 'deterministe';
      journal('warn', 'resume modele vide, resume deterministe', { chars: summary.length });
    }
    if (!summary) return { ok: false, reason: 'compression du contexte echouee (resume vide).' };
    store.setMessages(sessionId, compressMod.spliceHistory(summary, stored, 4));
    journal('info', 'contexte compresse (methode)', { methode: how });
    journal('info', 'contexte compresse', { before: stored.length, summaryChars: summary.length });
    const est2 = profiles.estimateTokens(modelMessages(), schemaChars);
    if (est2 > ctxTokens * CTX_BUDGET) {
      // P61-16: si le depassement vient de l'overhead FIXE (instructions +
      // schemas d'outils), on ne bloque pas le tour : on le journalise, en
      // nommant la cause. Bloquer ici punirait l'utilisateur pour la taille
      // du contrat d'outils, pas pour son historique.
      journal('warn', 'budget 70 pourcent depasse apres compression', { est2, ctx: ctxTokens,
        cause: 'overhead fixe (instructions + schemas)' });
    }
    return { ok: true, compressed: true };
  };

  // P26-d: verify loop. After modifications, run the detected project check
  // command(s) under permissions; feed failures back (2 rounds max).
  // Returns 'done' (finalize), 'continue' (failures fed, keep looping) or
  // 'stop' (stopReason/stopDetail set).
  let verifyRounds = 0;
  let stopReason = '';
  let stopDetail = '';
  // P53-1/2/3: verification can be IMPOSSIBLE (tool absent) or TIME OUT.
  // Neither is a tool error, neither may block the final answer: they become
  // the honest reason of a PARTIEL verdict.
  let verifyNote = '';
  const verifyTimeoutMs = (() => {
    const v = parseInt(process.env.SUDO_AGENT_VERIFY_TIMEOUT_MS, 10);
    if (Number.isFinite(v) && v >= 5000) return Math.min(600000, v);
    return 120000; // P53-2: build/test checks get 120 s by default
  })();
  const maybeVerify = async () => {
    if (mode !== 'build') return 'done';
    if (base.verify === false) { journal('info', 'verify ignore (desactive)'); return 'done'; }
    if (!currentFilesModified().length) { journal('info', 'verify ignore (aucun fichier modifie)'); return 'done'; }
    const checks = verifyMod.detectChecks(root);
    if (!checks.length) { journal('info', 'verify: aucune commande detectee'); return 'done'; }
    const failures = [];
    const skipped = [];
    const timedOut = [];
    for (const c of checks) {
      if (runEntry.aborted) return 'stop';
      // P53-1: prove the tool exists BEFORE running anything. Absent =>
      // skipped step with an install action: no 30 s wait, no retry.
      let pre = { ok: true, checked: false };
      try { pre = await prereq.checkCommand(c.command, { lang: convLang }); } catch (_) { pre = { ok: true, checked: false }; }
      if (!pre.ok) {
        skipped.push({ check: c, reason: pre.message, action: pre.action });
        journal('warn', 'verify non executee', { check: c.name, tool: pre.tool, raison: pre.reason });
        continue;
      }
      let r = null;
      // P53-2: control commands get the configurable budget (120 s default).
      try { r = await executeTool(tctx, 'bash', { command: c.command, timeoutMs: verifyTimeoutMs }, {}); }
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
          try { r = await executeTool(tctx, 'bash', { command: c.command, timeoutMs: verifyTimeoutMs }, { preApproved: true }); }
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
        // P53-2: a timeout is "delai depasse", not "echec d'outil non resolu".
        // Retrying a 120 s command wastes minutes: report it and move on.
        if (r.code === 'timeout') {
          // P53-2: the timeout belongs to the CHECK, not to the model: the
          // recorded call is re-labelled so it never reads as an unresolved
          // tool error ("delai depasse", not "echec d'outil non resolu").
          const last = run.calls[run.calls.length - 1];
          if (last && last.tool === 'bash' && last.code === 'timeout') {
            last.code = 'verify_timeout';
            last.ok = false;
            last.summary = 'delai depasse (' + Math.round(verifyTimeoutMs / 1000) + ' s) : ' + c.name;
          }
          timedOut.push({ check: c, ms: verifyTimeoutMs });
          journal('warn', 'verify delai depasse', { check: c.name, ms: verifyTimeoutMs });
          continue;
        }
        failures.push({ check: c, reason: String(r.reason || 'echec.').slice(0, 500) });
        continue;
      }
      journal('info', 'verify pass', { check: c.name });
    }
    // P53-1/3: nothing actionable failed, but verification did not happen.
    // Record the honest reason and let the turn finish (never blocked).
    if (!failures.length) {
      const notes = [];
      if (skipped.length) notes.push(skipped.map((x) => x.check.name + ' ' + x.reason).join('; '));
      if (timedOut.length) notes.push(timedOut.map((x) => T().verifyTimeout(x.check.name, x.ms)).join('; '));
      if (notes.length) {
        verifyNote = notes.join('; ');
        journal('warn', 'verify incomplete', { skipped: skipped.length, timeouts: timedOut.length });
        return 'done';
      }
      return 'done';
    }
    if (verifyRounds >= 2) {
      for (const f of failures) {
        run.calls.push({ tool: 'bash', target: f.check.command, ok: false, code: 'verify_failed', ms: 0, at: new Date().toISOString(), summary: f.reason.slice(0, 300) });
      }
      journal('warn', 'verify failed', { rounds: verifyRounds, checks: failures.map((f) => f.check.name).join(', ') });
      stopReason = 'verify_failed';
      return 'done'; // finalize: declared + unresolved => ECHEC (honest)
    }
    verifyRounds += 1;
    // P53-5: engine message, conversation language, imperative, no apology bait.
    const body = failures.map((f) => '- ' + f.check.name + ' (' + f.check.command + ') : ' + f.reason).join('\n');
    store.append(sessionId, { role: 'user', content: T().verifyFail(verifyRounds, 2, body) });
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
  const onReq = (req) => { runEntry.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; };
  // P62-E1: une ligne de mesures par appel au modele (aucune estimation :
  // uniquement ce que le runtime renvoie). Alimente l analyse de vitesse
  // sans jamais inventer de chiffre.
  const perf = { calls: 0, promptTokens: 0, genTokens: 0, genMs: 0, waitMs: 0 };
  const notePerf = (usage, ms) => {
    const u = usage || {};
    const pt = Number(u.prompt_tokens || u.promptTokens || 0);
    const ct = Number(u.completion_tokens || u.completionTokens || 0);
    perf.calls += 1;
    perf.promptTokens += pt;
    perf.genTokens += ct;
    perf.genMs += Math.max(0, ms || 0);
    const tps = (ct > 0 && ms > 0) ? Math.round((ct / (ms / 1000)) * 10) / 10 : 0;
    journal('info', 'appel modele', { n: perf.calls, jetonsPrompt: pt, jetonsGeneres: ct, ms: Math.round(ms || 0), jetonsParSeconde: tps });
  };
  const roundRaw = (toolsUsed) => {
    const t0r = Date.now();
    return chatOnce(provider, Object.assign({ model, messages: modelMessages(), tools: toolsUsed,
      onRequest: onReq }, chatOpts)).then((r) => {
      notePerf(r && r.usage, Date.now() - t0r);
      return r;
    });
  };
  // P55-3: une panne du fournisseur (500, delai, appel d'outil invalide) est
  // RECUPERABLE : jusqu'a 3 essais avec un schema reduit, puis le format de
  // secours "FICHIER: chemin". On ne renonce qu'apres avoir epuise les voies.
  const reducedSchemas = recovery.reducedTools(activeSchemas);
  let recoveryUsed = 0;
  // Ecritures issues du format de secours : elles passent par le CHEMIN
  // NORMAL (approbation, journal, verification), pas par un raccourci.
  const fallbackQueue = [];
  let fallbackRounds = 0;
  const roundOnce = async () => {
    if (fallbackQueue.length) {
      const f = fallbackQueue.shift();
      const args = { file: f.path, content: f.content };
      journal('info', 'ecriture issue du format de secours', { file: f.path, reste: fallbackQueue.length });
      return { text: '', usage: null, fallbackFile: true,
        toolCalls: [{ id: 'fb-' + run.calls.length, type: 'function', name: 'write',
          argsText: JSON.stringify(args), args, parseError: null }] };
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const useReduced = attempt > 0;
        const r = await roundRaw(useReduced ? reducedSchemas : activeSchemas);
        // Le runtime signale un appel inutilisable par 200 + erreur structuree.
        if (r && r.invalidCall && !(r.toolCalls && r.toolCalls.length)) {
          recoveryUsed += 1;
          journal('warn', 'appel outil invalide, reprise', { field: r.invalidCall.field,
            attempt: attempt + 1, detail: String(r.invalidCall.detail || '').slice(0, 120) });
          // On renvoie l'exemple valide au modele (message explicite).
          store.append(sessionId, { role: 'assistant', content: String(r.text || '').slice(0, 800) });
          store.append(sessionId, { role: 'user', content: String(r.invalidCall.message || 'Appel invalide.').slice(0, 800)
            + (r.invalidCall.example ? ' Exemple valide : ' + JSON.stringify(r.invalidCall.example).slice(0, 300) : '') });
          continue;
        }
        if (attempt > 0) journal('info', 'reprise apres panne fournisseur', { attempt: attempt + 1,
          tools: useReduced ? reducedSchemas.length : activeSchemas.length, why: String((lastErr && lastErr.message) || '').slice(0, 120) });
        return r;
      } catch (e) {
        lastErr = e;
        const cls = recovery.classify(e);
        if (!cls.recoverable || runEntry.aborted) throw e;
        recoveryUsed += 1;
        journal('warn', 'panne fournisseur recuperable', { attempt: attempt + 1, why: cls.why });
        // P61-10a: le runtime local est tombe. On ne rend pas la main au
        // modele ni a l'utilisateur : la requete est MISE EN FILE et rejouee
        // des que /health repond (120 s max, message clair a chaque essai).
        // Un port ferme n'est pas une fin de tour, c'est un redemarrage.
        if (e && e.code === 'runtime_offline') {
          // P62-B1: fenetre de 180 s mesuree a l horloge MONOTONE, echeance
          // partagee par le tour : aucun compteur ne repart a zero.
          const pinned = Number(runtimeWait && runtimeWait.attempts) > 0;
          const wOpts = pinned
            ? { attempts: runtimeWait.attempts, delayMs: runtimeWait.delayMs || 10000,
                probeTimeoutMs: runtimeWait.probeTimeoutMs || 2000 }
            : { budgetMs: (runtimeWait && runtimeWait.budgetMs) || runtimeBudgetMs(),
                deadline: (runtimeWait && runtimeWait.deadline) || rwDeadline,
                probeTimeoutMs: (runtimeWait && runtimeWait.probeTimeoutMs) || 2000 };
          const w = await waitForRuntime(provider, Object.assign({}, wOpts, {
            shouldAbort: () => runEntry.aborted,
            onProgress: (n, max, message) => {
              try { onEvent({ type: 'runtime.wait', attempt: n, maxAttempts: max,
                message: message || 'Runtime indisponible, reprise automatique en cours (ecoule : ' +
                  Math.round((w && w.elapsedMs ? w.elapsedMs : 0) / 1000) + ' s sur 180 s)' }); } catch (_) {}
            },
          }));
          if (w.recovered) {
            journal('info', 'runtime retabli, requete rejouee', { elapsedMs: w.elapsedMs || 0, probes: w.attemptsMade });
            continue;
          }
          // P62-B2: l echec n est annonce qu APRES une tentative de relance
          // par le superviseur, puis une derniere fenetre courte.
          const rel = await relanceSuperviseur({ onEvent, journal, shouldAbort: () => runEntry.aborted });
          if (rel.attempted && !runEntry.aborted) {
            const w2 = await waitForRuntime(provider, Object.assign({}, wOpts, {
              budgetMs: 60000, deadline: runtimeDeadline(60000),
              shouldAbort: () => runEntry.aborted,
              onProgress: (n, max, message) => {
                try { onEvent({ type: 'runtime.wait', attempt: n, maxAttempts: max,
                  message: message || 'Runtime relance par le superviseur, reprise en cours (ecoule : ' +
                    Math.round((w2 && w2.elapsedMs ? w2.elapsedMs : 0) / 1000) + ' s sur 60 s)' }); } catch (_) {}
              },
            }));
            if (w2.recovered) {
              journal('info', 'runtime relance par le superviseur puis retabli', { probes: w2.attemptsMade });
              continue;
            }
          }
          journal('warn', 'runtime indisponible apres la fenetre', {
            elapsedMs: w.elapsedMs || 0, probes: w.attemptsMade, relance: rel.outcome || 'aucune' });
          const sec = Math.round((w.elapsedMs || 0) / 1000);
          const err = new Error('Runtime local hors ligne : indisponible apres ' + sec + ' s (fenetre de 180 s)' +
            (rel.attempted ? ' et une relance du superviseur' : '') +
            '. La demande et le travail deja fait sont conserves : la reprise continuera depuis le dernier point de controle des que le runtime repond.');
          err.code = 'runtime_offline';
          throw err;
        }
        // Une seconde d'attente entre deux essais (panne transitoire).
        if (attempt < 2) await new Promise((r2) => setTimeout(r2, 400));
      }
    }
    // Derniere voie : le format de secours texte, sans aucun outil.
    journal('warn', 'format de secours (FICHIER: chemin)', { used: recoveryUsed });
    const fb = await chatOnce(provider, { model, messages: modelMessages().concat([
      { role: 'user', content: recovery.fallbackPrompt(base.prompt) }]), onRequest: onReq });
    const parsed = recovery.parseFileBlocks(fb && fb.text);
    journal('info', 'roundOnce format de secours rendu', { files: (parsed.files || []).length,
      ok: !!parsed.ok, chars: String((fb && fb.text) || '').length });
    return { text: String((fb && fb.text) || ''), toolCalls: [], usage: (fb && fb.usage) || null,
      fallback: { parsed, raw: String((fb && fb.text) || '').slice(0, 2000) } };
  };
  // P49-1: constrained repair: free text is never a valid ACTION output.
  // Up to 2 driver retries with an explicit order, then an honest stop.
  const actionRepair = async (why) => {
    for (let a = 0; a < 2; a++) {
      if (runEntry.aborted) return null;
      journal('warn', 'reparation contrainte', { attempt: a + 1, why: String(why).slice(0, 120) });
      store.append(sessionId, { role: 'user', content: T().strictAction(why) });
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
  // P56: a project run (job) never doubles as a P52 orchestration.
  const orchTexts = (!jobState && wantPlan && seedTexts.length >= orch.longSteps()) ? seedTexts : [];
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
  // P61-9: distingue un texte ECRIT PAR LE MODELE (reponse declaree ou
  // reponse de secours) d'un texte ECRIT PAR L'AGENT (constat de statut). Le
  // second porte toujours fait/reste ; le premier est stocke tel quel, le
  // statut restant lisible dans turn.done / lastRun.
  let answerFromModel = false;
  let iters = 0;
  let subSpawns = 0;
  let childSeq = 0;
  let buildFixFails = 0;
  let buildFixStop = false;
  const guard = plan.createLoopGuard();
  // P61-4: idempotence stricte PAR TOUR. Un appel identique (meme outil, memes
  // arguments) n'est execute qu'UNE fois ; une redemande recoit le resultat
  // deja obtenu. Etat local a la fonction : rien ne fuit d'un tour au suivant.
  const executed = new Map();      // sig -> { content, ok, code, tool, target }
  const dupHits = new Map();       // sig -> nombre de redemandes identiques
  const retryAllowed = new Set();  // sigs autorises une fois (apres une panne de garde)
  // P61-8: cibles introuvables. 2 echecs identiques => la cible est abandonnee
  // avec une explication, JAMAIS un max_iters.
  const targetFails = new Map();   // cible -> nombre d'echecs
  const listedTargets = new Set(); // cibles dont la liste des fichiers a deja ete donnee
  const INVALIDATABLE = ['write', 'edit', 'patch', 'append', 'delete', 'rename', 'mkdir'];
  let loopStop = false;
  let runtimeStop = false; // P62: arret propre sur fenetre runtime epuisee
  let pauseAborted = false;
  let orchVerdict = null;
  let attempt = 0;
  const MAX_ATTEMPTS = (strictAction && mode === 'build') ? 3 : 1;
  try {
  // P52 loop guard v2: a loop stop NEVER ends without an answer. Last
  // round WITHOUT tools (answer from what is collected), else a labelled
  // deterministic fallback. Status stays PARTIEL (loop happened).
  // P61-4: invalide le cache d'idempotence quand un fichier a change.
  const invalidateTarget = (tool, args) => {
    if (INVALIDATABLE.indexOf(tool) === -1) return;
    const target = String((args && (args.file || args.from)) || '');
    if (!target) return;
    for (const [k, v] of Array.from(executed.entries())) {
      if (v && String(v.target || '') === target) executed.delete(k);
    }
  };
  // P61-12: reparation des arguments d'outil illisibles. Deux passes, jamais
  // une erreur brute envoyee a l'utilisateur.
  const repairArgs = (raw, name) => {
    let t = String(raw === undefined || raw === null ? '' : raw);
    const tries = [];
    const strip = () => t.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
    tries.push(() => strip());
    tries.push(() => strip()
      .replace(/,\s*([}\]])/g, '$1')                       // virgules finales
      .replace(/^\s*'([^']*)'\s*$/, '"$1"')                 // chaine simple quote
      .replace(/([,{]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3'));  // cles en simple quote
    tries.push(() => {
      const m = t.match(/\{[\s\S]*\}/);
      return m ? m[0] : '';
    });
    for (const fn of tries) {
      let cand = '';
      try { cand = fn(); } catch (_) { cand = ''; }
      if (!cand) continue;
      try {
        let v = JSON.parse(cand);
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch (_) {}
    }
    // Dernier recours : une chaine nue "README.md" = { file: "README.md" }.
    // P61-12: une chaine nue n'est acceptee comme chemin QUE si elle en a la
    // forme (pas d'espace, un separateur ou une extension). "pas du json" ne
    // doit pas devenir un nom de fichier : on prefere un message clair.
    const lone = strip().replace(/^["']|["']$/g, '');
    const looksLikePath = lone.length > 0 && lone.length < 200 && !/\s/.test(lone) && /[./\\]/.test(lone);
    if (lone && looksLikePath && lone.indexOf('{') === -1 && name) {
      const key = (name === 'read' || name === 'delete' || name === 'write' || name === 'edit') ? 'file' : '';
      if (key) return { [key]: lone };
    }
    return null;
  };
  // P61-8: chemin introuvable -> l'agent resout lui-meme et le DIT.
  const autoResolveTarget = async (toolName, args, res) => {
    const target = String((args && (args.file || args.path || args.from)) || '');
    if (!target || !res || res.ok) return null;
    if (res.code !== 'not_found') return null;
    // P61-8 (portee): not_found couvre DEUX cas tres differents. Si le
    // FICHIER existe, l'echec porte sur son CONTENU (edit: chaine "old"
    // introuvable) : ce n'est pas un probleme de chemin, il ne faut donc ni
    // resoudre la cible ni l'abandonner - la boucle corrective s'en charge.
    try {
      const abs = require('path').resolve(root, target);
      const st = require('fs').statSync(abs);
      if (st && (st.isFile() || st.isDirectory())) return null;
    } catch (_) { /* le fichier n'existe pas : c'est bien un chemin */ }
    const n = (targetFails.get(target) || 0) + 1;
    targetFails.set(target, n);
    // P62-F4: arret apres 2 echecs sur la MEME cible (la video montrait 4
    // lectures identiques jusqu'a max_iters). Le 1er echec sert a resoudre ou
    // a lister ; le 2e echec ferme la cible avec sa raison.
    if (n >= 2) return { giveUp: true };
    const hit = resolvePath.resolveClosest(root, target);
    // P61-8: compare la forme BRUTE (readme.md != README.md) : la casse est
    // justement ce qu'on corrige.
    if (hit.ok && hit.rel && hit.rel !== target) {
      journal('info', 'chemin resolu', { demande: target.slice(0, 80), resolu: hit.rel.slice(0, 80), comment: hit.how });
      const rd = await executeTool(tctx, 'read', { file: hit.rel, limit: 200 }, {});
      if (rd.status === 'done') {
        const body = { ok: true, summary: 'fichier introuvable sous le nom demande; lu sous le nom reel ' + hit.rel + '.',
          result: rd.call.result, cheminCorrige: { demande: target, utilise: hit.rel, comment: hit.how },
          note: 'utilise ce chemin exact (' + hit.rel + ') pour la suite.' };
        return { content: JSON.stringify(body) };
      }
    }
    const cands = (hit.candidates || []).slice(0, 40);
    const already = listedTargets.has(target);
    if (!already) listedTargets.add(target);
    journal('warn', 'cible introuvable', { cible: target.slice(0, 80), candidats: cands.length, deja_liste: already });
    return {
      content: JSON.stringify({
        ok: false, code: 'not_found',
        error: 'fichier introuvable : ' + target + '. Fichiers existants (utilise un de ces chemins EXACTS) : ' + cands.join(', '),
        candidats: cands,
        note: already ? 'liste deja donnee : ne redemande pas ce chemin, choisis-en un ou termine.' : undefined,
      }),
    };
  };
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
        answerFromModel = true;
        store.append(sessionId, { role: 'assistant', content: finalText });
        journal('info', 'reponse secours IA', { chars: rt.length });
      }
    } catch (e) {
      journal('warn', 'reponse secours IA echouee', { error: String((e && e.message) || e).slice(0, 160) });
    }
    if (!finalText) {
      finalText = pmap.deterministicFallback({ root, map: mapInfo, calls: run.calls, loopKey: String(what || '?'), prompt: base.prompt });
      // Repli deterministe : texte de l'agent, il porte deja son explication.
      answerFromModel = true;
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
        // P62-B1: meme echeance partagee que le reste du tour.
        const wT = await waitAndRetry({ provider, onEvent,
          shouldAbort: () => runEntry.aborted,
          waitOpts: Object.assign({}, runtimeWait, { deadline: (runtimeWait && runtimeWait.deadline) || rwDeadline }) });
        if (!wT.retry || runEntry.aborted) {
          // P62-B2/B6: la fenetre est epuisee. On ne rend pas une erreur nue :
          // le tour s'arrete avec une raison en francais, et le travail deja
          // fait reste. Aucun statut muet.
          stopReason = 'runtime_offline';
          stopDetail = String((e && e.message) || 'runtime local indisponible.');
          finalText = String((e && e.message) || 'Runtime local indisponible.');
          answerFromModel = true;
          store.append(sessionId, { role: 'assistant', content: finalText });
          try { onEvent({ type: 'message.done', text: finalText, aborted: false }); } catch (_) {}
          journal('warn', 'tour arrete : runtime indisponible', { reason: stopDetail.slice(0, 160) });
          runtimeStop = true;
          break;
        }
        reply = await roundOnce();
      } finally {
        runEntry.destroy = null;
      }
      if (runtimeStop) break; // P62: sortie propre, deja expliquee
      let calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      // P57-3: task(agent, consigne) est le raccourci nomme de subagent : meme
      // chemin (profondeur 1 max, memes garde-fous), un seul enfant.
      calls = calls.map((c) => {
        if (!c || c.name !== 'task' || !c.args || typeof c.args !== 'object') return c;
        const consigne = String(c.args.consigne || c.args.task || '').slice(0, 2000);
        const agent = String(c.args.agent || '').slice(0, 60);
        if (!consigne || !agent) return c;
        return Object.assign({}, c, { name: 'subagent',
          args: { task: consigne, agent, readonly: c.args.readonly === true } });
      });
      // P55-3: reponse au format de secours ("FICHIER: chemin"). Les fichiers
      // sont EMPILES puis ecrits par le chemin normal d'outil (approbation,
      // journal, verification) : la panne fournisseur ne doit pas abandonner
      // la tache, et aucun raccourci ne contourne les garde-fous.
      if (!calls.length && reply.fallback && reply.fallback.parsed
          && reply.fallback.parsed.ok && reply.fallback.parsed.files.length && !runEntry.aborted) {
        fallbackRounds += 1;
        if (fallbackRounds > 1) {
          // Deux series completes (3 essais + secours) sans retablissement :
          // le fournisseur est juge indisponible. On s'arrete HONNETEMENT,
          // sans perdre le travail deja ecrit.
          stopReason = 'provider_unavailable';
          stopDetail = 'le fournisseur refuse les appels d outil (2 series de reprises + format de secours).';
          break;
        }
        const files = reply.fallback.parsed.files.slice(0, 12);
        for (const f of files) fallbackQueue.push(f);
        journal('info', 'fichiers du format de secours empiles', { files: files.length, serie: fallbackRounds });
        continue;
      }
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
        answerFromModel = true;
        store.append(sessionId, { role: 'assistant', content: finalText });
        break;
      }
      // P26-a: ONE action per step. The first call runs; extras are skipped
      // (with their own tool message so the transcript stays valid).
      store.append(sessionId, { role: 'assistant', content: reply.text || '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, argsText: c.argsText })) });
      const first = calls[0];
      // P61-12: arguments illisibles -> reparation cote agent (2 passes), puis
      // message clair en francais. Jamais une erreur brute, jamais un 500.
      if (first && first.parseError) {
        const fixed = repairArgs(first.argsText, first.name);
        if (fixed) {
          first.args = fixed;
          first.parseError = null;
          journal('info', 'arguments d outil repares', { tool: String(first.name || '').slice(0, 40) });
        }
      }
      // P61-4: un appel identique deja execute dans CE tour n'est pas rejoue.
      const sig = (!first || first.parseError) ? '' : plan.argSig(first.name, first.args);
      if (sig) {
        const prior = executed.get(sig);
        if (prior && !retryAllowed.has(sig)) {
          const hits = (dupHits.get(sig) || 1) + 1;
          dupHits.set(sig, hits);
          const callIdD = first.id || ('call-' + run.calls.length);
          // P61-4 + P52: un appel de MUTATION redemande 3 fois declenche la
          // strategie corrective (le modele peut encore s'adapter) ; une
          // redemande ulterieure arrete le tour proprement avec une reponse
          // de secours. Un appel en LECTURE seule n'est jamais escalade :
          // il n'a aucun effet de bord, on renvoie simplement son resultat.
          const escalatable = GUARD_TOOLS.indexOf(first.name) !== -1;
          const bodyD = (escalatable && hits >= 3)
            ? { ok: false, code: 'corrective',
                error: 'arret de la repetition : tu as redemande 3 fois le meme appel (' + String(first.name) + ') sans changer d\'arguments. ' +
                  'Le resultat est deja ci-dessus. Change d\'argument, choisis un autre outil, ou termine via reply/done.' }
            : { ok: false, code: 'already_done',
                error: 'deja execute, passe a l\'etape suivante : cet appel a dEJA ete fait dans ce tour, voici son resultat.',
                result: (function () { try { return JSON.parse(prior.content).result; } catch (_) { return undefined; } })(),
                summary: 'deja execute, passe a l etape suivante.' };
          run.calls.push({ tool: first.name || '?', target: '', ok: false, code: bodyD.code, ms: 0,
            at: new Date().toISOString(), summary: 'non rejoue : appel identique deja execute.' });
          store.append(sessionId, { role: 'tool', tool_call_id: callIdD, name: first.name, content: JSON.stringify(bodyD) });
          try { onEvent({ type: 'tool.result', callId: callIdD, tool: first.name, ok: false, code: bodyD.code, ms: 0, summary: bodyD.summary || bodyD.error.slice(0, 120) }); } catch (_) {}
          for (const extra of calls.slice(1)) {
            const xid = extra.id || ('call-' + run.calls.length);
            store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name,
              content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.' }) });
            try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore.' }); } catch (_) {}
          }
          // P61-4: au-dela de la strategie corrective, une 4e redemande
          // identique arrete le tour PROPREMENT (reponse de secours, raison
          // visible, statut PARTIEL) : on n'execute jamais deux fois la meme
          // action, et on ne laisse jamais le modele tourner a vide.
          if (escalatable && hits >= 5) {
            stopReason = 'loop';
            stopDetail = 'boucle : ' + String(first.name) + ' redemande a l\'identique ' + hits +
              ' fois malgre la strategie corrective (execute une seule fois).';
            journal('warn', 'repeat loop', { tool: first.name, hits, via: 'idempotence' });
            await rescueAnswer(first.name);
            break;
          }
          if (escalatable && hits >= 3) {
            // La 3e redemande reste NON executee et arme la garde corrective :
            // toute repetition ulterieure sera refusee puis arrettera le tour.
            guard.forbiddenArgs = sig;
            journal('warn', 'boucle corrective', { tool: first.name, hits, via: 'idempotence' });
            store.append(sessionId, { role: 'user', content: 'STRATEGIE CORRECTIVE : tu as repete 3 fois le meme appel ' + String(first.name || '?') +
              ' (memes arguments). Il n\'a ete execute QU\'UNE fois, son resultat est ci-dessus. ' +
              'Change de strategie : constate autrement (list/grep/read), choisis un autre outil ou d\'autres arguments, ou termine via reply/done. ' +
              'Ne re-emets PAS cet appel (une repetition identique = arret du tour).' });
          }
          continue;
        }
        if (prior && retryAllowed.has(sig)) retryAllowed.delete(sig);
      }
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
          content: JSON.stringify({ ok: false, code: 'corrective', error: 'STRATEGIE CORRECTIVE : ' + T().corrective, detail: 'change de strategie.' }) });
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
          finishIntercept(false, 'bad_args', T().badArgs(first.parseError));
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
          finishIntercept(false, 'verify', convLang === 'en'
            ? 'Verification still running: finish the work, then reply (checks were modified).'
            : 'verifications en cours : poursuis le travail (des checks ont ete modifies).');
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
      // (P57-3: task(agent, consigne) est traduit AVANT, au point d'emission de
      // l'appel, pour rester sur `const first` - voir calls.map plus haut.)
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
          jobs = [{ task: sa.task, focus: sa.focus, readonly: sa.readonly, maxRounds: sa.maxRounds, agent: sa.agent }];
        } else { refuseSub('subagent: task (ou tasks[]) requis.'); continue; }
        // P54-4: named agents (custom definitions). Unknown name = honest refusal.
        if (sa.agent !== undefined) {
          for (const j of jobs) if (j && j.agent === undefined) j.agent = sa.agent;
        }
        const agentDefs = new Map();
        for (const j of jobs) {
          if (!j || j.agent === undefined || j.agent === null || j.agent === '') continue;
          const def = agentsMod.findAgent(home, j.agent);
          if (!def) { refuseSub('agent inconnu : ' + String(j.agent).slice(0, 60) + ' (Agent Extensions > Agents).'); jobs = null; break; }
          agentDefs.set(String(j.agent).toLowerCase(), def);
        }
        if (!jobs) continue;
        let jobsOk = true;
        for (const j of jobs) {
          if (!j || typeof j.task !== 'string' || !j.task.trim() || j.task.length > 2000) { refuseSub('tache invalide (texte requis, <=2000).'); jobsOk = false; break; }
        }
        if (!jobsOk) continue;
        subSpawns += 1;
        try { onEvent({ type: 'tool.start', callId: callIdS, tool: 'subagent',
          args: { agent: (jobs[0] && jobs[0].agent) || '', consigne: String((jobs[0] && jobs[0].task) || '').slice(0, 120) } }); } catch (_) {}
        const runChild = async (job) => {
          childSeq += 1;
          const n = childSeq;
          const child = store.create({ title: 'sub: ' + String(job.task).slice(0, 60), projectRoot: session.projectRoot });
          const childMode = job.readonly === true ? 'plan' : mode;
          try { store.update(child.id, (x) => { x.meta.mode = childMode; x.meta.parent = sessionId; }); } catch (_) {}
          let mr = parseInt(job.maxRounds, 10);
          if (!Number.isFinite(mr)) mr = 4;
          mr = Math.min(6, Math.max(1, mr));
          // P54-4: a custom agent contributes its instructions and its tool
          // allowlist; Build/Plan stay the default when no agent is named.
          const defA = job.agent ? agentDefs.get(String(job.agent).toLowerCase()) : null;
          const cprompt = 'Execute cette sous-tache agent (enfant ' + n + ')'
            + (defA ? ' avec l\'agent "' + defA.name + '"' : '') + '. Tache : ' + String(job.task).slice(0, 2000)
            + (job.focus ? '\nContexte : ' + String(job.focus).slice(0, 1000) : '')
            + (defA && defA.instructions ? '\nInstructions de l\'agent :\n' + defA.instructions.slice(0, 4000) : '')
            + '\nTermine par done avec un RESUME compact (faits + fichiers touches).'
            + (defA && defA.tools && defA.tools.length ? '\nOutils autorises pour cet agent : ' + defA.tools.join(', ') + '.' : '')
            + (job.readonly === true ? ' Lecture seule (mode PLAN).' : '');
          journal('info', 'sous-agent demarre', { child: child.id, mode: childMode, maxRounds: mr,
            agent: defA ? String(defA.name).slice(0, 40) : 'build/plan', tools: defA && defA.tools ? defA.tools.length : 0 });
          try { onEvent({ type: 'subagent.start', callId: callIdS, child: child.id }); } catch (_) {}
          let cres = null;
          try {
            cres = await runTurn({ store, sessionId: child.id, prompt: cprompt, corr: corr + '.s' + n,
              provider, toolsCtx: { home, sessionRules: sessionRulesMap, pending: toolsCtx ? toolsCtx.pending : new Map(), noResume: true },
              runs, log, onEvent: () => {}, subDepth: subDepth + 1, maxIt: mr, runtimeWait,
              allowedTools: (defA && defA.tools && defA.tools.length) ? defA.tools.slice(0, 40) : null });
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
      try { onEvent({ type: 'tool.start', callId, tool: first.name, args: first.args }); } catch (_) {}
      let content = '';
      if (first.parseError) {
        const entry = { tool: first.name || '?', target: '', ok: false, code: 'bad_args', ms: 0, at: new Date().toISOString(), summary: first.parseError };
        run.calls.push(entry);
        // P26-b: constraining hint on top of the runtime grammar + retry.
        content = JSON.stringify({ ok: false, code: 'bad_args', error: T().badArgs(first.parseError), detail: 'arguments d\'outil illisibles.' });
      } else if (!first.name) {
        run.calls.push({ tool: '?', target: '', ok: false, code: 'bad_args', ms: 0, at: new Date().toISOString(), summary: 'appel sans nom.' });
        content = JSON.stringify({ ok: false, code: 'bad_args', error: T().invalidCall('name'),
          example: '{"name":"read","arguments":{"file":"README.md"}}', detail: 'champ name manquant.' });
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
        // P61-5: protection "lire avant de supprimer/renommer" AUTOMATIQUE.
        // Si la cible n'a pas ete lue pendant la session, l'AGENT la lit
        // lui-meme (lecture bornee) puis rejoue l'action dans la MEME etape :
        // aucun aller-retour avec le modele, aucune iteration consommee.
        if (NEEDS_PRIOR_READ.indexOf(first.name) !== -1 && first.args && typeof first.args.file === 'string') {
          const rel = String(first.args.file);
          const readFiles = (session.meta && Array.isArray(session.meta.readFiles)) ? session.meta.readFiles : [];
          const abs = path.join(root, rel);
          let exists = false;
          try { exists = fs.statSync(abs).isFile(); } catch (_) { exists = false; }
          if (exists && readFiles.indexOf(rel) === -1) {
            const ar = await executeTool(tctx, 'read', { file: rel, limit: AUTO_READ_LINES }, {});
            const okRead = ar.status === 'done';
            journal(okRead ? 'info' : 'warn', 'lecture automatique avant action',
              { tool: first.name, file: rel.slice(0, 120), ok: okRead });
            if (okRead) {
              const fresh = store.get(sessionId) || session;
              if (fresh && fresh.meta) session.meta = fresh.meta;
            }
          }
        }
        let r = await executeTool(tctx, first.name, first.args, {});
        // P61-8: cible introuvable -> resolution automatique (casse, nom
        // approche) ou liste UNE fois ; 2 echecs => cible abandonnee.
        if (r.status === 'error' && (r.code === 'not_found')) {
          const reso = await autoResolveTarget(first.name, first.args, { ok: false, code: r.code });
          if (reso && reso.giveUp) {
            stopReason = 'target_given_up';
            stopDetail = 'cible introuvable apres 2 tentatives : ' + String((first.args && first.args.file) || '?') +
              ' (aucun fichier correspondant dans le projet).';
            content = JSON.stringify({ ok: false, code: 'target_given_up',
              error: 'cible abandonnee : ' + String((first.args && first.args.file) || '?') + ' est introuvable (2 tentatives).' });
            journal('warn', 'cible abandonnee', { cible: String((first.args && first.args.file) || '?').slice(0, 120) });
            store.append(sessionId, { role: 'tool', tool_call_id: first.id || ('call-' + run.calls.length), name: first.name, content });
            run.calls.push({ tool: first.name, target: String((first.args && first.args.file) || ''), ok: false, code: 'target_given_up', ms: 0, at: new Date().toISOString(), summary: stopDetail });
            try { onEvent({ type: 'tool.result', callId: first.id || 'x', tool: first.name, ok: false, code: 'target_given_up', ms: 0, summary: stopDetail.slice(0, 200) }); } catch (_) {}
            break;
          }
          if (reso && reso.content) {
            content = reso.content;
            run.calls.push({ tool: first.name, target: String((first.args && first.args.file) || ''), ok: false,
              code: 'not_found_resolved', ms: 0, at: new Date().toISOString(), summary: 'cible introuvable : resolution automatique / liste fournie.' });
            store.append(sessionId, { role: 'tool', tool_call_id: first.id || ('call-' + run.calls.length), name: first.name, content: content.slice(0, 8000) });
            try { onEvent({ type: 'tool.result', callId: first.id || 'x', tool: first.name, ok: false, code: 'not_found_resolved', ms: 0, summary: 'chemin resolu automatiquement.' }); } catch (_) {}
            for (const extra of calls.slice(1)) {
              const xid = extra.id || ('call-' + run.calls.length);
              store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name,
                content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas.' }) });
            }
            continue;
          }
        }
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
            // P62-F2: un refus est un VERDICT, pas une invitation a tourner en
            // rond. Avant, le modele continuait (not_read x4) pour finir sur un
            // "AUCUNE MODIFICATION" incomprehensible. On s'arrete ici, en
            // francais, en disant quel outil a ete refuse et que rien n'a ete
            // modifie. Aucun message trompeur, aucun compteur gonfle.
            run.calls.push({ tool: first.name, target: String((r.request.pattern && r.request.pattern.text) || ''), ok: false, code: 'denied', ms: 0, at: new Date().toISOString(), summary: 'refuse par l\'operateur.' });
            content = JSON.stringify({ ok: false, code: 'denied', error: 'refuse par l\'operateur : le tour s arrete, aucune modification.', detail: 'refuse par l\'operateur.' });
            operatorDenied = { tool: String(first.name || '?'), summary: String((r.request && r.request.summary) || '').slice(0, 200) };
            stopReason = 'approval_denied';
            stopDetail = 'action refusee par l operateur : ' + operatorDenied.tool +
              (operatorDenied.summary ? ' (' + operatorDenied.summary + ')' : '') +
              '. Aucune modification effectuee.';
            journal('warn', 'approbation refusee, tour arrete', { tool: operatorDenied.tool });
          } else {
            // Approved (once/session/project): re-execute, THIS turn continues.
            // P61-5: la re-execution APRES approbation doit laisser la meme
            // trace qu'un appel ordinaire. tools.recordCall l'ecrit quand le
            // contexte porte le tour ; si ce n'est pas le cas, le journal du
            // tour restait vide (ok=false, code="ok", resume vide), la memoire
            // d'idempotence retenait un ECHEC la ou l'outil avait reussi, et le
            // modele relancait la meme ecriture jusqu'au PARTIEL (paquet
            // installe, runs 42955250962 / 42956495322). On ne pousse une
            // entree QUE si l'outil ne l'a pas deja fait : jamais de doublon.
            const beforeCalls = run.calls.length;
            const r2 = await executeTool(tctx, first.name, first.args, { preApproved: true });
            const okR2 = r2.status === 'done';
            if (run.calls.length === beforeCalls) {
              const c2 = (r2 && r2.call) || {};
              run.calls.push({
                tool: first.name,
                target: String((first.args && (first.args.file || first.args.from)) || '').slice(0, 200),
                ok: okR2 && c2.ok !== false,
                code: okR2 ? (c2.ok === false ? String(c2.code || 'tool_fail') : 'ok') : String((r2 && r2.code) || 'error'),
                ms: c2.ms || 0,
                at: new Date().toISOString(),
                summary: String(c2.summary || c2.error || (r2 && r2.reason) || '').slice(0, 300),
              });
            }
            // P61: une re-execution approuvee qui echoue doit DIRE pourquoi.
            if (!okR2) journal('warn', 'appel approuve en echec', { tool: first.name, code: String((r2 && r2.code) || 'error'), reason: String((r2 && r2.reason) || '').slice(0, 200) });
            if (okR2) content = doneContent(r2);
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
      // P61-4: memoise le resultat pour refuser une redemande identique.
      if (sig) {
        // P61-4 (portee): seuls les appels REELLEMENT executes alimentent la
        // memoire d'idempotence. Un refus, une approbation en attente ou une
        // reponse de guidance n'a rien fait : le rejouer n'est pas un doublon
        // (sinon un utilisateur qui refuse 3 fois verrait une "boucle").
        const NON_EXEC = ['denied', 'need_approval', 'asked', 'skipped', 'plan_mode', 'deploy_policy',
          'no_project', 'unknown_tool', 'corrective', 'not_read'];
        if (NON_EXEC.indexOf(last.code || 'ok') === -1) {
          executed.set(sig, { content, ok: !!last.ok, code: last.code || 'ok', tool: first.name,
            target: String((first.args && (first.args.file || first.args.from)) || '') });
        }
        if (last.ok) invalidateTarget(first.name, first.args);
        // P61-6: une panne de GARDE (pas une panne d'outil) autorise UNE
        // seule reprise a l'identique, pour que le modele puisse rejouer
        // l'action apres la lecture corrective.
        if (!last.ok && (last.code === 'not_read' || last.code === 'corrective')) retryAllowed.add(sig);
      }
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
        // P61-4: un DOUBLON dans la meme reponse du modele est deduplique
        // avant execution (meme outil, memes arguments que `first`).
        const sameAsFirst = !extra.parseError && first && !first.parseError &&
          plan.argSig(extra.name, extra.args) === plan.argSig(first.name, first.args);
        if (sameAsFirst) {
          run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'duplicate', ms: 0, at: new Date().toISOString(),
            summary: 'doublon dans la meme reponse : non execute.' });
          store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name,
            content: JSON.stringify({ ok: false, code: 'duplicate', error: 'doublon dans la meme reponse du modele : non execute (le premier appel a deja ete fait). Passe a l\'etape suivante.' }) });
          try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'duplicate', ms: 0, summary: 'doublon non execute.' }); } catch (_) {}
          continue;
        }
        run.calls.push({ tool: extra.name || '?', target: '', ok: false, code: 'skipped', ms: 0, at: new Date().toISOString(), summary: 'ignore : une seule action par pas.' });
          store.append(sessionId, { role: 'tool', tool_call_id: xid, name: extra.name, content: JSON.stringify({ ok: false, code: 'skipped', error: 'une seule action par pas : cet appel est ignore, repose-le au pas suivant.', detail: 'une seule action par pas.' }) });
        try { onEvent({ type: 'tool.result', callId: xid, tool: extra.name, ok: false, code: 'skipped', ms: 0, summary: 'ignore : une seule action par pas.' }); } catch (_) {}
      }
      // P62-F2: un refus d'approbation arrete le tour ICI (raison explicite).
      if (operatorDenied) { loopStop = true; }
      if (pauseAborted || loopStop || buildFixStop) break; // P50-3 + P52: extras closed above, transcript valid.
    }
    // P49-2: the model claimed done with no verified files: constrained
    // re-attempt (bounded by MAX_ATTEMPTS); otherwise the verdict below
    // stands. A run-only ACTION with successful calls counts as done.
    // Only false-TERMINE retries: a loud ECHEC (standing tool errors,
    // mid-turn approval need) stops immediately, never retried.
    if (!runEntry.aborted && strictAction && declared && mode === 'build' &&
        !currentFilesModified().length && !(runOnly && run.calls.some((c) => c.ok)) &&
        computeRunStatus(declared, run.calls, { files: currentFilesModified(), verifyNote, lang: convLang }).status === 'TERMINE') {
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
  // P56-2/3/4/5: project run. Each step is a FRESH child turn whose context
  // only holds the objective, the useful SPEC slice, the files already touched
  // and a two-line summary of previous steps. State (attempts, files, tests,
  // coverage) is checkpointed on disk before AND after every step, so a stop,
  // a crash, a runtime restart or a closed panel resumes at the same step.
  let jobVerdict = null;
  if (jobState && !runEntry.aborted) {
    journal('info', 'tour projet', { job: jobState.id, etapes: jobState.steps.length, execution: jobState.runs });
    const waiters = (toolsCtx && toolsCtx.waiters) || null;
    const stepRunner = async (step, ctx) => {
      if (runEntry.aborted) return { calls: 0, aborted: true, error: 'tour abandonne.' };
      const child = store.create({ title: 'etape ' + ctx.n + '/' + ctx.N + ': ' + String(step.text).slice(0, 50), projectRoot: session.projectRoot });
      try { store.update(child.id, (x) => { x.meta.jobParent = sessionId; x.meta.job = jobState.id; }); } catch (_) {}
      try { sessionRulesMap.set(child.id, sessionRulesMap.get(sessionId)); } catch (_) {}
      const cprompt = jobMod.stepPrompt(ctx);
      const t0 = Date.now();
      let cres = null;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { abortRun(runs, child.id); } catch (_) {} }, ctx.msBudget);
      if (timer.unref) { try { timer.unref(); } catch (_) {} }
      const pabort = setInterval(() => { if (runEntry.aborted) { try { abortRun(runs, child.id); } catch (_) {} } }, 250);
      if (pabort.unref) { try { pabort.unref(); } catch (_) {} }
      // P56-4: un pas de projet ne peut JAMAIS bloquer le reste du projet.
      // Le delai est double : 1) on demande l'arret du tour enfant, 2) si le
      // tour ne rend pas la main (attente externe), on rend l'etape en echec
      // au lieu de laisser le projet fige indefiniment.
      let watchdog = null;
      try {
        const childTurn = runTurn({ store, sessionId: child.id, prompt: cprompt, corr: corr + '.j' + ctx.n,
          provider, modelOverride: ctx.model || undefined,
          toolsCtx: { home, sessionRules: sessionRulesMap, pending: toolsCtx ? toolsCtx.pending : new Map(),
            waiters: (toolsCtx && toolsCtx.waiters) || null,
            parentSessionId: sessionId, noResume: true, noOrchPlan: true },
          runs, log, onEvent: (e) => {
            try {
              if (e && (e.type === 'turn.paused' || (typeof e.type === 'string' && e.type.indexOf('tool.') === 0) || e.type === 'runtime.wait')) onEvent(e);
            } catch (_) {}
          }, maxIt: ctx.callBudget, runtimeWait,
          // P62-F7: une etape de cahier ne voit que son sous-ensemble d'outils.
          allowedTools: Array.isArray(ctx.toolSubset) ? ctx.toolSubset : undefined });
        cres = await Promise.race([
          childTurn,
          new Promise((resolve) => {
            watchdog = setTimeout(() => {
              timedOut = true;
              // Diagnostic : ce que le processus attend encore (socket modele,
              // attente externe, processus enfant) au moment du depassement.
              let pending = [];
              try {
                pending = process._getActiveHandles().map((h) => {
                  const n = (h && h.constructor && h.constructor.name) || '?';
                  return n + (h && h.remotePort ? ':' + h.remotePort : '');
                });
              } catch (_) {}
              journal('warn', 'etape projet delai depasse', { n: ctx.n, handles: pending.slice(0, 8) });
              try { abortRun(runs, child.id); } catch (_) {}
              resolve({ status: 'error', error: 'delai etape depasse (tour enfant sans reponse).' });
            }, ctx.msBudget + 15000);
            if (watchdog.unref) { try { watchdog.unref(); } catch (_) {} }
          }),
        ]);
      } catch (e) {
        journal('warn', 'etape projet erreur', { n: ctx.n, error: String((e && e.message) || e).slice(0, 160) });
      } finally {
        try { clearTimeout(timer); } catch (_) {}
        try { clearTimeout(watchdog); } catch (_) {}
        try { clearInterval(pabort); } catch (_) {}
      }
      const cs = store.get(child.id);
      const cmeta = (cs && cs.meta && cs.meta.lastRun) || {};
      const calls = Array.isArray(cmeta.calls) ? cmeta.calls : [];
      const files = Array.isArray(cmeta.filesModified) ? cmeta.filesModified : [];
      const testCall = calls.find((c) => c && c.ok && (c.tool === 'bash') && /test|spec|pytest|jest|npm run/.test(String(c.target || '')));
      if (runEntry.aborted) return { calls: calls.length, aborted: true, error: 'tour abandonne.' };
      if (timedOut) return { calls: calls.length, ok: false, error: 'delai etape depasse (' + Math.round((Date.now() - t0) / 1000) + 's).', files };
      const childDeclared = cmeta.stopReason === 'declared';
      const okChild = !cres || cres.status !== 'error';
      return {
        calls: calls.length,
        // Honnetete (P56-5) : "declare terminee" sans fichier modifie et sans
        // test execute n'est PAS une preuve. L'etape est alors marquee en
        // echec et le rapport la compte en "non realisee".
        ok: okChild && (files.length > 0 || !!testCall),
        declared: childDeclared,
        files,
        test: testCall ? String(testCall.target).slice(0, 160) : null,
        detail: files.length ? files.slice(0, 4).join(', ')
          : (testCall ? 'test execute : ' + String(testCall.target).slice(0, 100)
            : (childDeclared ? 'declare terminee sans modification verifiee' : 'aucune modification verifiee')),
        error: (cres && cres.status === 'error') ? String(cres.error || 'erreur enfant').slice(0, 200) : '',
      };
    };
    try {
      const res = await jobMod.run({
        root, state: jobState, runStep: stepRunner,
        shouldStop: () => runEntry.aborted,
        availableModels: (base.preProbe && Array.isArray(base.preProbe.models)) ? base.preProbe.models : [],
        emit: (t, o) => { try { onEvent(Object.assign({ type: t }, o)); } catch (_) {} },
      });
      finalText = res.report || '';
      declared = true;
      const failed = res.failed || 0;
      const skipped = res.skipped || 0;
      const total = res.total || jobState.steps.length;
      if (res.aborted) jobVerdict = { status: 'PARTIEL', reason: 'projet interrompu (bouton Reprendre ou "reprendre").', unresolved: [] };
      else if (failed > 0 && res.done === 0) jobVerdict = { status: 'ECHEC', reason: failed + ' etape(s) non realisee(s) sur ' + total + '.', unresolved: [] };
      else if (failed > 0) jobVerdict = { status: 'PARTIEL', reason: failed + ' etape(s) non realisee(s) sur ' + total + ', les autres sont faites.', unresolved: [] };
      else if (skipped > 0) jobVerdict = { status: 'PARTIEL', reason: skipped + ' etape(s) non tentee(s) (budget).', unresolved: [] };
      else jobVerdict = { status: 'TERMINE', reason: '', unresolved: [] };
      journal('info', 'projet termine', { job: jobState.id, faites: res.done, echouees: failed, nontentees: skipped });
    } catch (e) {
      finalText = 'Projet interrompu : ' + String((e && e.message) || e).slice(0, 300);
      declared = true;
      jobVerdict = { status: 'ECHEC', reason: 'execution du projet interrompue.', unresolved: [] };
      journal('warn', 'projet interrompu', { error: String((e && e.message) || e).slice(0, 160) });
    }
  }

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
      answerFromModel = true;
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('info', 'reponse secours contexte', { chars: rescued.length });
    } else {
      finalText = pmap.deterministicFallback({ root, map: mapInfo, calls: run.calls, prompt: base.prompt, why: 'context' });
      // Ce texte est redige par l'AGENT : il porte deja sa propre explication
      // (mode sans IA, contexte sature) et n'a pas besoin du constat de statut.
      answerFromModel = true;
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('warn', 'reponse secours deterministe', { chars: finalText.length, why: 'context' });
    }
  }

  // P62-E1: une seule ligne de synthese en fin de tour (mesures reelles).
  try {
    const totTps = (perf.genTokens > 0 && perf.genMs > 0) ? Math.round((perf.genTokens / (perf.genMs / 1000)) * 10) / 10 : 0;
    journal('info', 'mesures du tour', { appelsModele: perf.calls, jetonsPrompt: perf.promptTokens,
      jetonsGeneres: perf.genTokens, msGeneration: Math.round(perf.genMs), jetonsParSeconde: totTps,
      appelsOutils: run.calls.length });
  } catch (_) {}

  // Honest status (P25-g + P26 stops).
  const filesModified = currentFilesModified();
  let verdict = computeRunStatus(declared, run.calls, { files: currentFilesModified(), verifyNote, lang: convLang });
  const strongVerdict = orchVerdict || jobVerdict; // P52/P56: per-step report wins (honest).
  if (strongVerdict) verdict = strongVerdict;
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
  // P62-D5: une action REUSSIE hors du projet (copie vers un dossier voisin)
  // n'apparait dans aucun diff du projet. Sans cette ligne, l utilisateur
  // lisait "copie faite" sans savoir OU. Le fait vient du resultat d outil,
  // jamais du texte du modele.
  {
    const outs = run.calls.filter((c) => c.ok && c.code === 'ok' && c.tool === 'copy_project');
    if (outs.length) {
      const txt = outs.map((c) => String(c.summary || '')).filter(Boolean).join(' | ');
      if (txt) finalText = (finalText.trim() ? finalText.trim() + '\n\n' : '') + 'Copie hors projet : ' + txt;
    }
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
      if (!verdict.unresolved.length && !verdict.verifyNote && !strongVerdict) verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      if (!finalText.trim()) finalText = 'Tache terminee.';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (declared && !filesModified.length && okCalls > 0
               && run.calls.some((c) => c.ok && c.code === 'ok' && (c.tool === 'mcp_call' || /^mcp__/.test(String(c.tool || ''))))
               && !verdict.unresolved.length && !verdict.verifyNote && !strongVerdict) {
      // P57-8: une ACTION EXTERNE verifiee (appel MCP abouti, sortie reelle)
      // n'est pas un echec faute de fichier modifie : le statut reste honnete
      // parce qu'il s'appuie sur une preuve, et le resume le dit.
      verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      finalText = (finalText.trim() ? finalText.trim() + '\n\n' : '') +
        'Action externe verifiee par MCP (' + run.calls.filter((c) => c.ok && c.code === 'ok' && c.tool === 'mcp_call').length + ' appel(s) abouti(s)) : aucun fichier du projet modifie.';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (declared && runOnly && okCalls > 0) {
      verdict = { status: 'TERMINE', reason: '', unresolved: [] };
      finalText = (finalText.trim() || 'Execution verifiee.') + '\n\nAucun fichier modifie (execution seule, verifiee : ' + okCalls + ' appels aboutis).';
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (stopReason === 'provider_unavailable' && filesModified.length > 0) {
      // P55-3: arret honnete. Le travail ecrit reste, la verification n'a pas
      // pu etre faite : statut PARTIEL explicite, jamais un TERMINE flatteur.
      const list = filesModified.slice(0, 5).join(', ');
      finalText = 'PARTIEL : fournisseur d\'inference indisponible (erreur HTTP 500 repetee). ' +
        filesModified.length + ' fichier(s) ecrit(s) par le format de secours (' + list + '). ' +
        'Verification non executee : relancez la demande des que le modele repond.';
      verdict = { status: 'PARTIEL', reason: 'fournisseur indisponible', unresolved: verdict.unresolved };
      store.append(sessionId, { role: 'assistant', content: finalText });
    } else if (operatorDenied) {
      // P62-F2: message clair, statut motive, aucune ambiguite sur ce qui a
      // (ou n'a pas) ete fait. Le tour s'arrete au lieu de tourner en rond.
      const quoi = operatorDenied.summary ? ' (' + operatorDenied.summary + ')' : '';
      finalText = 'REFUSE : l\'action "' + operatorDenied.tool + '"' + quoi +
        ' a ete refusee par l\'operateur. Aucune modification n\'a ete effectuee. ' +
        'Relancez la demande avec une autre formulation, ou approuvez cette action pour continuer.';
      verdict = { status: 'PARTIEL', reason: 'action refusee par l operateur : ' + operatorDenied.tool, unresolved: verdict.unresolved };
      store.append(sessionId, { role: 'assistant', content: finalText });
      journal('warn', 'verdict refus', { tool: operatorDenied.tool });
    } else if (!declared && (filesModified.length > 0 || finalText.trim())) {
      // Undeclared but real: modified files without a declaration, or an
      // answer already produced (context/loop rescue): keep the verdict.
    } else if ((!declared || verdict.status === 'TERMINE') && !strongVerdict) {
      // P49-2 target: false TERMINE (declared, no evidence) and answerless
      // stops (no_tool). A declared ECHEC (mid-turn approval need, standing
      // tool errors) is loud already: it stands, never downgraded.
      const totalCalls = run.calls.filter((c) => c.code !== 'skipped').length;
      let raison = '';
      if (mode === 'plan') raison = 'mode PLAN : les modifications sont refusees (basculez en BUILD pour modifier).';
      else if (stopReason === 'no_tool' || stopReason === 'build_fix' || stopReason === 'target_given_up') raison = stopDetail;
      else if (!totalCalls) raison = 'aucun appel d\'outil emis.';
      else if (!okCalls) {
        const errs = run.calls.filter((c) => !c.ok).slice(0, 3).map((c) => c.tool + '/' + (c.code || 'error'));
        raison = 'tous les appels ont echoue (' + errs.join(', ') + ').';
      } else {
        const denies = run.calls.filter((c) => !c.ok && c.code === 'denied').map((c) => c.tool);
        raison = denies.length ? 'action refusee par l\'operateur (' + denies.join(', ') + ').' : 'appels lecture seule uniquement, aucun fichier touche.';
      }
      // P61-9: quand des outils ont REELLEMENT tourne, dire "AUCUNE
      // MODIFICATION" masque le travail fait. Le titre doit dire ce qui s'est
      // passe, pas l'inverse.
      // Le titre reste factuel : RIEN n'a ete modifie sur le disque. Ce qui a
      // ete fait (lectures, refus, outils aboutis) est dit par le constat
      // "Fait / Reste" (P61-9) ajoute juste apres, pas par ce titre.
      finalText = 'AUCUNE MODIFICATION : ' + raison + '\n\nProposition : reformulez en UNE action precise (ex : "cree le fichier X qui ..."), ' +
        (mode === 'plan' ? 'basculez en BUILD pour modifier.' : 'verifiez les chemins (list/glob) puis relancez.');
      verdict = { status: 'PARTIEL', reason: 'AUCUNE MODIFICATION : ' + raison, unresolved: verdict.unresolved };
      // The honest text above must be the stored answer too (next-turn
      // history and panels read the store, not just message.done).
      store.append(sessionId, { role: 'assistant', content: finalText });
    }
  }
  // P53-3: honest status in the ANSWER itself:
  // "PARTIEL : N fichiers modifies (liste) ; verification non executee ou echouee : raison".
  // P53-3: the status line rides in the ANSWER when the run really did
  // something and verification could not confirm it (files + reason), or when
  // verification was impossible/failed. Pure stops (loop, rescue) keep their
  // deterministic text: the status is already in turn.done/lastRun.
  const honestWhy = (verdict.verifyNote || (verdict.unresolved && verdict.unresolved.length && filesModified.length > 0));
  if (honestWhy && verdict.status !== 'TERMINE' && verdict.reason && !/^(PARTIEL|ECHEC)/.test(String(finalText || '').trim())) {
    const head = (finalText || '').replace(/\s+$/, '');
    finalText = (head ? head + '\n\n' : '') + verdict.status + ' : ' + verdict.reason;
    try {
      const cur = (store.get(sessionId) || { messages: [] }).messages;
      const last = cur[cur.length - 1];
      if (last && last.role === 'assistant') {
        store.update(sessionId, (st) => {
          const arr = st.messages || [];
          const i = arr.length - 1;
          if (arr[i] && arr[i].role === 'assistant') arr[i].content = finalText;
        });
      } else {
        store.append(sessionId, { role: 'assistant', content: finalText });
      }
    } catch (_) {}
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
  // P61-9: sur un arret en boucle ou une cible abandonnee, le texte generique
  // "AUCUNE MODIFICATION" masquerait le vrai resultat : le constat de statut
  // le remplace (il dit deja fait / reste).
  if ((stopOut === 'loop' || stopOut === 'target_given_up') && !runEntry.aborted) {
    const notice0 = statusNotice(verdict, run.calls, filesModified, stopOut);
    if (notice0) {
      // Le texte de secours produit par le modele (P39-d) est CONSERVE : on
      // lui ajoute le constat de statut, on ne l'efface pas. Seul le texte
      // generique "AUCUNE MODIFICATION" est remplace (il masquerait le vrai
      // resultat, exigence P61-9).
      const cur = String(finalText || '').trim();
      if (!answerFromModel) {
        // Texte ecrit par l'agent : on remplace le generique, sinon on ajoute
        // le constat (fait / reste) s'il n'y est pas deja.
        const generic = !cur || /^AUCUNE MODIFICATION/.test(cur);
        finalText = generic ? notice0 : (cur.indexOf(notice0) !== -1 ? cur : cur + '\n\n' + notice0);
      }
      try {
        store.update(sessionId, (st) => {
          const arr = st.messages || [];
          const i = arr.length - 1;
          if (arr[i] && arr[i].role === 'assistant') arr[i].content = finalText;
          else arr.push({ role: 'assistant', content: finalText });
        });
      } catch (_) {}
    }
  }
  // P61-9: le statut est TOUJOURS lisible par l'utilisateur (et stocke).
  if (!runEntry.aborted) {
    const notice = statusNotice(verdict, run.calls, filesModified, stopOut);
    if (notice && !answerFromModel && String(finalText || '').indexOf('Reste :') === -1) {
      // Si le texte porte DEJA la meme raison (bloc "PARTIEL : ..." de P53-3),
      // on n'ajoute que le detail fait/reste : pas de raison en double.
      const curTxt = String(finalText || '').trim();
      const sameReason = curTxt.indexOf('Statut : ') === -1 && verdict.reason && curTxt.indexOf(String(verdict.reason).slice(0, 40)) !== -1;
      const add = sameReason
        ? notice.split('\n').filter((l) => /^(Fait|Reste) :/.test(l)).join('\n')
        : notice;
      finalText = (curTxt ? curTxt + '\n\n' : '') + add;
      try {
        const msgsNow = (store.get(sessionId) || { messages: [] }).messages;
        const lastM = msgsNow[msgsNow.length - 1];
        if (lastM && lastM.role === 'assistant') {
          store.update(sessionId, (st) => { const arr = st.messages || []; const i = arr.length - 1; if (arr[i] && arr[i].role === 'assistant') arr[i].content = finalText; });
        } else {
          store.append(sessionId, { role: 'assistant', content: finalText });
        }
      } catch (_) {}
    }
  }
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
  // P61-9: la reponse finale est TOUJOURS dans le transcript (un modele qui
  // termine par l'outil `done` n'ecrit aucun message assistant : l'utilisateur
  // voyait alors un tour "TERMINE" sans texte).
  try {
    const arr = (store.get(sessionId) || { messages: [] }).messages;
    const txt = String(finalText || '').trim();
    const has = txt && arr.some((m) => m && m.role === 'assistant' && String(m.content || '').trim() === txt);
    if (txt && !has) store.append(sessionId, { role: 'assistant', content: txt });
    else if (!txt) {
      const okN = run.calls.filter((c) => c.ok && c.code !== 'skipped').length;
      const fallbackTxt = verdict.status === 'TERMINE'
        ? 'Tache terminee (' + okN + ' appel(s) abouti(s)).'
        : statusNotice(verdict, run.calls, filesModified, stopOut);
      if (fallbackTxt) { finalText = fallbackTxt; store.append(sessionId, { role: 'assistant', content: fallbackTxt }); }
    }
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
    // P61-9: un abandon dit QUI a annule (bouton, delai, erreur interne).
    const why = runEntry.abortReason || 'annule';
    const txt = 'Demande interrompue : ' + why + '.\n' +
      'Fait : ' + (run.calls.filter((c) => c.ok).length) + ' appel(s) abouti(s)' +
      (currentFilesModified().length ? ', ' + currentFilesModified().length + ' fichier(s) modifie(s) (conserves)' : '') + '.\n' +
      'Reste : la demande n\'est pas terminee ; relancez-la pour continuer.';
    try { onEvent({ type: 'message.done', text: txt, aborted: true }); } catch (_) {}
    try { store.append(sessionId, { role: 'assistant', content: txt, aborted: true }); } catch (_) {}
    const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
    try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'interrompu : ' + why, filesModified: currentFilesModified(), stopReason: 'aborted' }); } catch (_) {}
    journal('info', 'turn aborted', { reason: why });
    if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
    return { status: 'aborted', model };
  }
}

function abortRun(runs, sessionId, reason) {
  if (!runs || !runs.has(sessionId)) return false;
  const run = runs.get(sessionId);
  run.aborted = true;
  if (!run.abortReason) run.abortReason = reason || 'arrete par l\'operateur (bouton Annuler)';
  try { if (typeof run.destroy === 'function') run.destroy(); } catch (_) {}
  if (Array.isArray(run.killFns)) {
    for (const k of run.killFns) { try { k(); } catch (_) {} }
  }
  return true;
}

module.exports = { runTurn, abortRun, computeRunStatus, unresolvedErrors, detectRepetition, MAX_TOOL_ITERS, resolveTurnApproval, summarizeResult };
