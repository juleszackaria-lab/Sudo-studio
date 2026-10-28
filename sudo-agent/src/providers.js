// Sudo Agent providers (P24). OpenAI-compatible chat completions over stdlib
// http/https. This module is the ONLY place that dials out, and only to the
// configured provider baseUrl. No other network. ASCII only.
'use strict';

const http = require('http');
const https = require('https');
const { maskSecrets } = require('./journal');

function joinUrl(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + (p.startsWith('/') ? p : '/' + p);
}

function pickLib(url) {
  return url.protocol === 'https:' ? https : http;
}

// Provider config: { type: 'local'|'cloud', baseUrl, model, apiKey? }.
// Returns { ok, config } or { ok:false, error }. Never throws on bad input.
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'provider non configure' };
  const type = raw.type === 'cloud' ? 'cloud' : raw.type === 'local' ? 'local' : null;
  if (!type) return { ok: false, error: 'provider invalide (type local|cloud requis)' };
  let u = null;
  try {
    u = new URL(String(raw.baseUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') u = null;
  } catch (_) { u = null; }
  if (!u) return { ok: false, error: 'provider invalide (baseUrl http(s) requise)' };
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : null;
  if (type === 'cloud' && !apiKey) return { ok: false, error: 'Cle API manquante pour le fournisseur cloud (configurez-la dans les parametres).' };
  // P26-b: optional profile override (small|full|auto). Invalid values fall
  // back to auto-detection from the model id.
  const pv = typeof raw.profile === 'string' ? raw.profile.trim().toLowerCase() : '';
  const profile = (pv === 'small' || pv === 'full' || pv === 'auto') ? pv : 'auto';
  return { ok: true, config: { type, baseUrl: u.toString().replace(/\/+$/, ''), model, apiKey, profile } };
}

function headersFor(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.type === 'cloud' && cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
  return h;
}

// P49-4: optional sampling overrides, validated then merged into the
// /v1/chat/completions payload. opts: { temperature, topP, topK,
// repeatPenalty, maxTokens, stop }. Anything invalid is OMITTED (the
// runtime defaults apply: temp 0.1, top_p 0.9, repeat 1.1, max 512).
function samplingPayload(opts) {
  const out = {};
  // Flat ({ temperature, topP, ... }) or nested ({ sampling: {...} }).
  const o = (opts && typeof opts === 'object' && opts.sampling && typeof opts.sampling === 'object') ? opts.sampling : (opts || {});
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const t = num(o.temperature);
  if (t !== null && t >= 0 && t <= 2) out.temperature = t;
  const tp = num(o.topP);
  if (tp !== null && tp > 0 && tp <= 1) out.top_p = tp;
  const tk = num(o.topK);
  if (tk !== null && tk >= 1 && tk <= 500) out.top_k = Math.floor(tk);
  const rp = num(o.repeatPenalty);
  if (rp !== null && rp >= 1 && rp <= 2) out.repeat_penalty = rp;
  const mt = num(o.maxTokens);
  if (mt !== null && mt >= 1 && mt <= 8192) out.max_tokens = Math.floor(mt);
  if (typeof o.stop === 'string' && o.stop) out.stop = [o.stop];
  else if (Array.isArray(o.stop) && o.stop.length) {
    out.stop = o.stop.filter((s) => typeof s === 'string' && s).slice(0, 8);
    if (!out.stop.length) delete out.stop;
  }
  return out;
}

function shortError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'connexion refusee';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'delai depasse';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'hote inconnu';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connexion interrompue';
  if (err && err.abortedByAgent) return 'annule';
  return maskSecrets(String((err && err.message) || err || 'erreur inconnue')).slice(0, 160);
}

// Probe: GET /v1/models with a short timeout. Fails fast (<5s) with a CLEAR
// error when the runtime is offline or no model is loaded. Never fake success.
function probeProvider(cfg, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 4000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let url = null;
    try { url = new URL(joinUrl(cfg.baseUrl, '/v1/models')); } catch (_) { finish({ ok: false, code: 'bad_config', error: 'provider invalide (baseUrl).' }); return; }
    const lib = pickLib(url);
    let req = null;
    try {
      req = lib.request(url, { method: 'GET', headers: headersFor(cfg), timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 65536) { try { res.destroy(); } catch (_) {} } });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const provider = cfg.type === 'local' ? 'runtime local' : 'fournisseur cloud';
            finish({ ok: false, code: 'provider_error', error: 'Erreur du ' + provider + ' (HTTP ' + res.statusCode + ').' });
            return;
          }
          let data = null;
          try { data = JSON.parse(body); } catch (_) { data = null; }
          const items = data && Array.isArray(data.data) ? data.data : [];
          const models = items.map((m) => m && m.id).filter((x) => typeof x === 'string');
          // P26-b: keep per-model details (runtime n_ctx) for context budget.
          const details = items.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, n_ctx: m.n_ctx }));
          if (!models.length) {
            finish({ ok: false, code: 'no_model', models: [], details: [], error: 'Aucun modele charge sur le runtime local (liste des modeles vide).' });
            return;
          }
          finish({ ok: true, models, details });
        });
      });
    } catch (e) { finish({ ok: false, code: 'provider_error', error: 'Erreur du fournisseur: ' + shortError(e) }); return; }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', (e) => {
      if (cfg.type === 'local') {
        finish({ ok: false, code: 'runtime_offline', error: 'Runtime local hors ligne: ' + cfg.baseUrl + ' injoignable (' + shortError(e) + '). Demarrez le runtime ou verifiez le provider actif.' });
      } else {
        finish({ ok: false, code: 'provider_unreachable', error: 'Fournisseur cloud injoignable (' + shortError(e) + ').' });
      }
    });
    req.end();
  });
}

// Streaming chat: POST /v1/chat/completions { stream:true }, SSE parse.
// opts: { model, timeoutMs, onToken, shouldAbort, onRequest }.
// Resolves { text, usage } or rejects { code, message }.
function streamChat(cfg, messages, opts) {
  opts = opts || {};
  const model = opts.model;
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve, reject) => {
    let done = false;
    let text = ''; // accumulated reply (outer scope: abort handlers need it too)
    const fail = (code, message) => { if (!done) { done = true; const e = new Error(message); e.code = code; reject(e); } };
    const win = (r) => { if (!done) { done = true; resolve(r); } };
    let url = null;
    try { url = new URL(joinUrl(cfg.baseUrl, '/v1/chat/completions')); } catch (_) { fail('bad_config', 'provider invalide (baseUrl).'); return; }
    const payload = JSON.stringify(Object.assign({ model, messages, stream: true }, samplingPayload(opts)));
    const lib = pickLib(url);
    let req = null;
    try {
      req = lib.request(url, { method: 'POST', headers: Object.assign({ 'Content-Length': Buffer.byteLength(payload) }, headersFor(cfg)), timeout: timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = '';
          res.on('data', (c) => { body += c; if (body.length > 8192) { try { res.destroy(); } catch (_) {} } });
          res.on('end', () => fail('provider_error', 'Erreur du fournisseur (HTTP ' + res.statusCode + '): ' + maskSecrets(body).slice(0, 200)));
          return;
        }
        let buf = '';
        text = '';
        let usage = null;
        const pump = () => {
          if (opts.shouldAbort && opts.shouldAbort()) {
            try { req.destroy(Object.assign(new Error('aborted'), { abortedByAgent: true })); } catch (_) {}
            return;
          }
        };
        res.on('data', (chunk) => {
          pump();
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { win({ text, usage }); try { res.destroy(); } catch (_) {} return; }
            let ev = null;
            try { ev = JSON.parse(data); } catch (_) { continue; }
            if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
            const delta = ev.choices && ev.choices[0] && ev.choices[0].delta ? ev.choices[0].delta.content : null;
            if (typeof delta === 'string' && delta) {
              text += delta;
              try { if (opts.onToken) opts.onToken(delta, text); } catch (_) {}
            }
          }
        });
        res.on('end', () => win({ text, usage }));
        res.on('error', (e) => {
          if (e && e.abortedByAgent) { const a = new Error('aborted'); a.code = 'aborted'; a.partial = text; if (!done) { done = true; reject(a); } }
          // P48(4): the runtime dying MID-stream drops the socket (reset/
          // broken pipe). On a local provider that is runtime_offline, not
          // a provider error, so the turn waits for the supervised restart.
          else if (cfg.type === 'local' && e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ECONNREFUSED')) {
            const a = new Error('Runtime local hors ligne: ' + cfg.baseUrl + ' injoignable (' + shortError(e) + ').');
            a.code = 'runtime_offline'; a.partial = text; if (!done) { done = true; reject(a); }
          }
          else fail('provider_error', 'Erreur du fournisseur: ' + shortError(e));
        });
      });
    } catch (e) { fail('provider_error', 'Erreur du fournisseur: ' + shortError(e)); return; }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', (e) => {
      if (e && e.abortedByAgent) { const a = new Error('aborted'); a.code = 'aborted'; a.partial = text; if (!done) { done = true; reject(a); } }
      else if (cfg.type === 'local') fail('runtime_offline', 'Runtime local hors ligne: ' + cfg.baseUrl + ' injoignable (' + shortError(e) + ').');
      else fail('provider_unreachable', 'Fournisseur cloud injoignable (' + shortError(e) + ').');
    });
    if (opts.onRequest) { try { opts.onRequest(req); } catch (_) {} }
    req.write(payload);
    req.end();
  });
}

module.exports = { normalizeConfig, probeProvider, streamChat, chatOnce, joinUrl, waitForRuntime, samplingPayload };

// Non-streaming chat, optional tools (P25). opts: { model, messages, tools?,
// toolChoice?, temperature?, topP?, topK?, repeatPenalty?, maxTokens?,
// stop?, timeoutMs, onRequest }. Resolves { text, toolCalls, usage } where
// toolCalls is [{ id, name, argsText, args, parseError }]. Rejects
// { code, message }.
function chatOnce(cfg, opts) {
  opts = opts || {};
  const model = opts.model;
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (code, message, status) => { if (!done) { done = true; const e = new Error(message); e.code = code; if (status) e.status = status; reject(e); } };
    let url = null;
    try { url = new URL(joinUrl(cfg.baseUrl, '/v1/chat/completions')); } catch (_) { fail('bad_config', 'provider invalide (baseUrl).'); return; }
    // P49-1: tool_choice 'required' forces a tool call on providers that
    // honor it (cloud); the local runtime already grammar-forces JSON.
    const onceBody = Object.assign({ model, messages: opts.messages || [], stream: false,
      tools: opts.tools || undefined }, samplingPayload(opts));
    if (opts.toolChoice === 'required' || opts.toolChoice === 'auto' || opts.toolChoice === 'none') {
      onceBody.tool_choice = opts.toolChoice;
    }
    const payload = JSON.stringify(onceBody);
    const lib = pickLib(url);
    let req = null;
    try {
      req = lib.request(url, { method: 'POST', headers: Object.assign({ 'Content-Length': Buffer.byteLength(payload) }, headersFor(cfg)), timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 4 * 1024 * 1024) { try { res.destroy(); } catch (_) {} } });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            fail('provider_error', 'Erreur du fournisseur (HTTP ' + res.statusCode + '): ' + maskSecrets(body).slice(0, 200), res.statusCode);
            return;
          }
          let data = null;
          try { data = JSON.parse(body); } catch (_) { fail('provider_error', 'Reponse fournisseur illisible.'); return; }
          const msg = data && data.choices && data.choices[0] && data.choices[0].message;
          if (!msg) { fail('provider_error', 'Reponse fournisseur vide.'); return; }
          const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
          const toolCalls = rawCalls.map((c, i) => {
            const fn = (c && c.function) || {};
            const argsText = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments === undefined ? {} : fn.arguments);
            let parsed = {};
            let parseError = null;
            try { parsed = JSON.parse(argsText); if (!parsed || typeof parsed !== 'object') parsed = {}; }
            catch (_) { parseError = 'arguments JSON invalides'; }
            return { id: (c && c.id) || ('call-' + i), name: fn.name || '', argsText, args: parsed, parseError };
          });
          resolve({ text: typeof msg.content === 'string' ? msg.content : '', toolCalls, usage: data.usage || null });
        });
      });
    } catch (e) { fail('provider_error', 'Erreur du fournisseur: ' + shortError(e)); return; }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', (e) => {
      if (e && e.abortedByAgent) { const a = new Error('aborted'); a.code = 'aborted'; if (!done) { done = true; reject(a); } }
      else if (cfg.type === 'local') fail('runtime_offline', 'Runtime local hors ligne: ' + cfg.baseUrl + ' injoignable (' + shortError(e) + ').');
      else fail('provider_unreachable', 'Fournisseur cloud injoignable (' + shortError(e) + ').');
    });
    if (opts.onRequest) { try { opts.onRequest(req); } catch (_) {} }
    req.write(payload);
    req.end();
  });
}

// P48(4): wait for a supervised local-runtime restart. Called when a local
// call just failed with runtime_offline. Probes up to `attempts` times,
// `delayMs` apart (defaults 5 x 10s: 50s of sleep + fast probes, always
// <= 60s total), reporting each round through onProgress BEFORE sleeping
// so panels show "Runtime restarting, attempt n/5" for the whole wait.
// Keeps waiting when the runtime answers but no model is loaded yet (the
// supervisor re-triggers /reload after a restart: "up but loading" is
// progress, not a verdict). Any other probe verdict (bad_config,
// provider_error, ...) returns immediately: only a restart episode waits.
// opts: { attempts, delayMs, probeTimeoutMs, probeFn, sleep, onProgress,
// shouldAbort }. Resolves { recovered, probe, attemptsMade, aborted }.
// Never waits for cloud configs.
function waitForRuntime(cfg, opts) {
  opts = opts || {};
  const max = Number(opts.attempts) > 0 ? Math.floor(Number(opts.attempts)) : 5;
  const delayMs = Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : 10000;
  const probeTimeoutMs = Number(opts.probeTimeoutMs) > 0 ? Number(opts.probeTimeoutMs) : 2000;
  const probeFn = typeof opts.probeFn === 'function' ? opts.probeFn : probeProvider;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
  if (!cfg || cfg.type !== 'local') {
    return Promise.resolve({ recovered: false, probe: null, attemptsMade: 0, aborted: false });
  }
  return (async () => {
    let lastProbe = null;
    for (let n = 1; n <= max; n++) {
      if (shouldAbort && shouldAbort()) {
        return { recovered: false, probe: lastProbe, attemptsMade: n - 1, aborted: true };
      }
      if (onProgress) {
        try { onProgress(n, max, 'Runtime restarting, attempt ' + n + '/' + max); } catch (_) {}
      }
      await sleep(delayMs);
      if (shouldAbort && shouldAbort()) {
        return { recovered: false, probe: lastProbe, attemptsMade: n, aborted: true };
      }
      let p = null;
      try { p = await probeFn(cfg, { timeoutMs: probeTimeoutMs }); }
      catch (e) { p = { ok: false, code: 'provider_error', error: String((e && e.message) || e) }; }
      lastProbe = p;
      if (p && p.ok) return { recovered: true, probe: p, attemptsMade: n, aborted: false };
      const code = (p && p.code) || 'provider_error';
      if (code !== 'runtime_offline' && code !== 'no_model') {
        return { recovered: false, probe: p, attemptsMade: n, aborted: false };
      }
    }
    return { recovered: false, probe: lastProbe, attemptsMade: max, aborted: false };
  })();
}
