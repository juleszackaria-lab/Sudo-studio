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
  return { ok: true, config: { type, baseUrl: u.toString().replace(/\/+$/, ''), model, apiKey } };
}

function headersFor(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.type === 'cloud' && cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
  return h;
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
          const models = data && Array.isArray(data.data) ? data.data.map((m) => m && m.id).filter((x) => typeof x === 'string') : [];
          if (!models.length) {
            finish({ ok: false, code: 'no_model', models: [], error: 'Aucun modele charge sur le runtime local (liste des modeles vide).' });
            return;
          }
          finish({ ok: true, models });
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
    const payload = JSON.stringify({ model, messages, stream: true });
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

module.exports = { normalizeConfig, probeProvider, streamChat, joinUrl };
