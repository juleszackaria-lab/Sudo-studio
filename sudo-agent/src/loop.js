// Sudo Agent loop (P24 single-turn + P25 tool loop). Without a project root
// the turn streams a plain answer (legacy). With a project root the model
// may call tools (read/list/glob/grep/write/edit/patch/bash/todo) under
// boundary + permissions + checkpoints, and the turn ends with an HONEST
// status: TERMINE only if the agent declared done, no tool error stands
// unresolved, and the really-modified file list is provided. Stdlib only,
// ASCII only (status words use unaccented capitals on purpose).
'use strict';

const fs = require('fs');
const path = require('path');
const { probeProvider, streamChat, chatOnce } = require('./providers');
const { executeTool, toOpenAISchema, ensureSeriesCheckpoint, saveRunSidecar } = require('./tools');
const { loadProjectRules, matchDenyList } = require('./permissions');
const { diffSnapshot } = require('./checkpoints');
const { maskSecrets } = require('./journal');

const MAX_HISTORY = 50;
const MAX_PROMPT = 200000;
const MAX_TOOL_ITERS = 8;
const MAX_AGENTS_MD = 32 * 1024;

function homeOf(toolsCtx) {
  if (toolsCtx && toolsCtx.home) return String(toolsCtx.home);
  if (process.env.SUDO_STUDIO_HOME) return String(process.env.SUDO_STUDIO_HOME);
  try { return require('os').homedir(); } catch (_) { return process.cwd(); }
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

  let probe = opts.preProbe && typeof opts.preProbe === 'object' ? opts.preProbe : null;
  if (!probe) {
    try { probe = await probeProvider(provider, { timeoutMs: probeTimeoutMs }); }
    catch (e) { probe = { ok: false, code: 'provider_error', error: 'fournisseur indisponible.' }; }
  }
  if (!probe.ok) return fail(probe.code || 'provider_error', probe.error || 'fournisseur indisponible.');
  const model = provider.model || (probe.models && probe.models[0]) || '';
  if (!model) return fail('no_model', 'Aucun modele charge sur le runtime local (liste des modeles vide).');

  store.append(sessionId, { role: 'user', content: prompt });
  const sessionNow = store.get(sessionId) || session;
  const useTools = !!opts.toolsCtx && sessionNow.projectRoot && opts.tools !== false;

  const base = { store, provider, sessionId, prompt, corr, log, runs, onEvent, model, probeTimeoutMs };
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
  try {
    const res = await streamChat(provider, history, {
      model,
      shouldAbort: () => run.aborted,
      onRequest: (req) => { run.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; },
      onToken: (delta, text) => {
        full = text;
        try { onEvent({ type: 'message.delta', text: delta }); } catch (_) {}
      },
    });
    full = res.text || '';
    store.append(sessionId, { role: 'assistant', content: full });
    try { onEvent({ type: 'message.done', text: full, aborted: false }); } catch (_) {}
    const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
    const doneEvt = { type: 'turn.done', turnId, messageCount, model, aborted: false, status: 'TERMINE', reason: '', filesModified: [] };
    try { onEvent(doneEvt); } catch (_) {}
    if (log) { try { log.info('turn done', { session: sessionId, replyChars: full.length, messageCount, status: 'TERMINE' }, corr); } catch (_) {} }
    return { status: 'done', model, messageCount, runStatus: 'TERMINE' };
  } catch (e) {
    if (e && e.code === 'aborted') {
      const partial = typeof e.partial === 'string' ? e.partial : full;
      store.append(sessionId, { role: 'assistant', content: partial, aborted: true });
      try { onEvent({ type: 'message.done', text: partial, aborted: true }); } catch (_) {}
      const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
      try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'aborted', filesModified: [] }); } catch (_) {}
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
// Tool turn (P25). Model iterates with tool calls; honest status at the end.
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

// Unresolved = error entries (except clean policy denials) with no later
// success on the same tool+target.
function unresolvedErrors(calls) {
  const bad = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c.ok || c.code === 'denied' || c.code === 'asked') continue;
    let fixed = false;
    for (let j = i + 1; j < calls.length; j++) {
      if (calls[j].ok && calls[j].tool === c.tool && calls[j].target === c.target) { fixed = true; break; }
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

async function toolsTurn(base, session, toolsCtx) {
  const { store, provider, sessionId, corr, log, runs, onEvent, model } = base;
  const turnId = corr;
  const home = homeOf(toolsCtx);
  const cloud = provider.type === 'cloud';
  const filter = (s) => (cloud ? maskSecrets(String(s === undefined || s === null ? '' : s)) : String(s === undefined || s === null ? '' : s));

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

  const runEntry = { aborted: false, destroy: null, killFns: [], corr, startedAt: Date.now() };
  runs.set(sessionId, runEntry);
  const run = { id: turnId, sessionId, checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: runEntry.killFns };
  try { onEvent({ type: 'turn.start', turnId, model }); } catch (_) {}

  const agentsMd = readAgentsMd(root);
  if (log) {
    try { log.info('turn start', { session: sessionId, model, tools: true, agentsMd: agentsMd ? agentsMd.length : 0 }, corr); } catch (_) {}
  }

  const sessionRulesMap = (toolsCtx && toolsCtx.sessionRules) || new Map();
  if (!sessionRulesMap.has(sessionId)) sessionRulesMap.set(sessionId, new Set());
  const projRules = loadProjectRules(home, root);

  const tctx = {
    root, sessionId, session, store, log, corr, run, home,
    sessionRules: sessionRulesMap.get(sessionId),
    projectRules: projRules.rules,
    sessionKill: runEntry.killFns,
    checkpoint: null,
  };
  tctx.checkpoint = () => ensureSeriesCheckpoint(tctx);
  const schemas = toOpenAISchema();

  const modelMessages = () => {
    const stored = (store.get(sessionId) || { messages: [] }).messages.slice(-MAX_HISTORY);
    const out = toProviderMessages(stored, false);
    if (agentsMd) out.unshift({ role: 'system', content: 'Project instructions (AGENTS.md):\n' + filter(agentsMd) });
    return out;
  };

  let declared = false;
  let finalText = '';
  let iters = 0;
  try {
    for (iters = 0; iters < MAX_TOOL_ITERS; iters++) {
      if (runEntry.aborted) break;
      let reply = null;
      try {
        reply = await chatOnce(provider, {
          model, messages: modelMessages(), tools: schemas,
          onRequest: (req) => { runEntry.destroy = () => { try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {} }; },
        });
      } catch (e) {
        // Provider without tool support: fall back to ONE legacy streamed turn.
        if (e && e.status === 400 && iters === 0) {
          if (log) { try { log.warn('tools unsupported, legacy fallback', { session: sessionId }, corr); } catch (_) {} }
          // Legacy re-reads history (user prompt already appended).
          return legacyTurn({ store, provider, sessionId, prompt: base.prompt, corr, log, runs, onEvent, model });
        }
        throw e;
      } finally {
        runEntry.destroy = null;
      }
      const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      if (!calls.length) {
        declared = true;
        finalText = reply.text || '';
        store.append(sessionId, { role: 'assistant', content: finalText });
        break;
      }
      store.append(sessionId, { role: 'assistant', content: reply.text || '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, argsText: c.argsText })) });
      for (const c of calls) {
        if (runEntry.aborted) break;
        const callId = c.id || ('call-' + run.calls.length);
        try { onEvent({ type: 'tool.start', callId, tool: c.name }); } catch (_) {}
        let content = '';
        if (c.parseError) {
          const entry = { tool: c.name || '?', target: '', ok: false, code: 'bad_args', ms: 0, at: new Date().toISOString(), summary: c.parseError };
          run.calls.push(entry);
          content = JSON.stringify({ ok: false, error: 'arguments d\'outil illisibles : ' + c.parseError });
        } else {
          const r = await executeTool(tctx, c.name, c.args, {});
          if (r.status === 'done') {
            content = JSON.stringify({ ok: true, summary: r.call.summary, result: r.call.result, diff: r.call.diff ? r.call.diff.slice(0, 4000) : undefined });
          } else if (r.status === 'need-approval') {
            try { toolsCtx.pending.set(r.request.id, { request: r.request, sessionId, fullArgs: c.args }); } catch (_) {}
            const entry = { tool: c.name, target: String((r.request.pattern && r.request.pattern.text) || ''), ok: false, code: 'need_approval', ms: 0, at: new Date().toISOString(), summary: 'approbation requise (' + r.request.id + ')' };
            run.calls.push(entry);
            content = JSON.stringify({ ok: false, code: 'need_approval', requestId: r.request.id, summary: r.request.summary, hint: 'appel NON execute : approbation operateur requise.' });
          } else {
            content = JSON.stringify({ ok: false, code: r.code || 'error', error: r.reason || 'echec.' });
          }
        }
        content = filter(content).slice(0, 8000);
        store.append(sessionId, { role: 'tool', tool_call_id: callId, name: c.name, content });
        const last = run.calls[run.calls.length - 1] || {};
        try { onEvent({ type: 'tool.result', callId, tool: c.name, ok: !!last.ok, code: last.code || 'ok', ms: last.ms || 0, summary: (last.summary || '').slice(0, 300) }); } catch (_) {}
      }
    }
  } catch (e) {
    if (e && e.code === 'aborted') {
      store.append(sessionId, { role: 'assistant', content: finalText, aborted: true });
      return finishAborted();
    }
    const code = (e && e.code) || 'provider_error';
    const error = (e && e.message) || 'Erreur du fournisseur.';
    if (log) { try { log.warn('turn failed', { session: sessionId, code }, corr); } catch (_) {} }
    try { onEvent({ type: 'turn.error', code, error }); } catch (_) {}
    if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
    return { status: 'error', code, error };
  }

  if (runEntry.aborted) {
    store.append(sessionId, { role: 'assistant', content: finalText, aborted: true });
    return finishAborted();
  }

  // Honest status (P25-g).
  let filesModified = [];
  if (run.checkpointName && run.snapshot) {
    try {
      const d = diffSnapshot(root, run.snapshot, {});
      filesModified = d.changed.map((f) => '~' + f).concat(d.created.map((f) => '+' + f), d.deleted.map((f) => '-' + f));
    } catch (_) { filesModified = []; }
  }
  const verdict = computeRunStatus(declared, run.calls);
  saveRunSidecar(tctx);
  try {
    store.update(sessionId, (s) => {
      if (!s.meta) s.meta = {};
      s.meta.lastRun = { at: new Date().toISOString(), status: verdict.status, reason: verdict.reason, filesModified,
        calls: run.calls.map((c) => ({ tool: c.tool, target: c.target, ok: c.ok, code: c.code })) };
    });
  } catch (_) {}
  try { onEvent({ type: 'message.done', text: finalText, aborted: false }); } catch (_) {}
  const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
  try {
    onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: false, status: verdict.status, reason: verdict.reason, filesModified,
      declaredDone: declared, toolCalls: run.calls.length, unresolvedErrors: verdict.unresolved.map((c) => ({ tool: c.tool, target: c.target, code: c.code })) });
  } catch (_) {}
  if (log) {
    try { log.info('turn done', { session: sessionId, status: verdict.status, tools: run.calls.length, files: filesModified.length }, corr); } catch (_) {}
  }
  if (runs.get(sessionId) === runEntry) runs.delete(sessionId);
  return { status: 'done', model, messageCount, runStatus: verdict.status };

  function finishAborted() {
    try { onEvent({ type: 'message.done', text: finalText, aborted: true }); } catch (_) {}
    const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
    try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true, status: 'PARTIEL', reason: 'aborted', filesModified: [] }); } catch (_) {}
    if (log) { try { log.info('turn aborted', { session: sessionId }, corr); } catch (_) {} }
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

module.exports = { runTurn, abortRun, computeRunStatus, unresolvedErrors, MAX_TOOL_ITERS };
