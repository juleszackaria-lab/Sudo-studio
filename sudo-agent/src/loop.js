// Sudo Agent loop, step 1 (P24). Single-turn loop: history + prompt streamed
// from the provider, events emitted incrementally, session persisted.
// Transport-agnostic: the server maps events to SSE. No tools at this step.
// Stdlib only. ASCII only.
'use strict';

const { probeProvider, streamChat } = require('./providers');

const MAX_HISTORY = 50;
const MAX_PROMPT = 200000;

// runs: Map sessionId -> { aborted:boolean, destroy:fn|null, corr }
// onEvent(evt) with evt = { type, ... } among:
//   turn.start { turnId } | message.delta { text } | message.done { text, aborted }
//   turn.done { turnId, messageCount, model, aborted } | turn.error { code, error }
async function runTurn(opts) {
  opts = opts || {};
  const store = opts.store;
  const provider = opts.provider; // normalized config (see providers.normalizeConfig)
  const sessionId = opts.sessionId;
  const prompt = opts.prompt;
  const corr = opts.corr || 'turn';
  const log = opts.log || null;
  const runs = opts.runs; // required Map
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

  // Fast pre-check: offline runtime / empty model list => immediate clear error.
  // The HTTP server probes BEFORE opening the SSE stream and passes preProbe.
  let probe = opts.preProbe && typeof opts.preProbe === 'object' ? opts.preProbe : null;
  if (!probe) {
    try { probe = await probeProvider(provider, { timeoutMs: probeTimeoutMs }); }
    catch (e) { probe = { ok: false, code: 'provider_error', error: 'fournisseur indisponible.' }; }
  }
  if (!probe.ok) return fail(probe.code || 'provider_error', probe.error || 'fournisseur indisponible.');
  const model = provider.model || (probe.models && probe.models[0]) || '';
  if (!model) return fail('no_model', 'Aucun modele charge sur le runtime local (liste des modeles vide).');

  store.append(sessionId, { role: 'user', content: prompt });
  const history = store.get(sessionId).messages
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));

  const turnId = corr;
  const run = { aborted: false, destroy: null, corr, startedAt: Date.now() };
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
    try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: false }); } catch (_) {}
    if (log) { try { log.info('turn done', { session: sessionId, replyChars: full.length, messageCount }, corr); } catch (_) {} }
    return { status: 'done', model, messageCount };
  } catch (e) {
    if (e && e.code === 'aborted') {
      const partial = typeof e.partial === 'string' ? e.partial : full;
      store.append(sessionId, { role: 'assistant', content: partial, aborted: true });
      try { onEvent({ type: 'message.done', text: partial, aborted: true }); } catch (_) {}
      const messageCount = (store.get(sessionId) || { messages: [] }).messages.length;
      try { onEvent({ type: 'turn.done', turnId, messageCount, model, aborted: true }); } catch (_) {}
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

function abortRun(runs, sessionId) {
  if (!runs || !runs.has(sessionId)) return false;
  const run = runs.get(sessionId);
  run.aborted = true;
  try { if (typeof run.destroy === 'function') run.destroy(); } catch (_) {}
  return true;
}

module.exports = { runTurn, abortRun };
