// Sudo Agent core server (P24, step 1). Sessions, SSE message stream, cancel,
// tool registry (empty), permissions, providers. Localhost only, token auth on
// EVERY endpoint (health included). Stdlib only. ASCII only.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createLogger, newCorr, corrFromReq, maskSecrets, gatherSessionInfo } = require('./journal');
const { createStore } = require('./store');
const { createRegistry } = require('./registry');
const { normalizeConfig, probeProvider } = require('./providers');
const { runTurn, abortRun } = require('./loop');

const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024; // 1 MB

function version() {
  if (process.env.SUDO_AGENT_VERSION) return String(process.env.SUDO_AGENT_VERSION).slice(0, 32);
  try { return String(require('../package.json').version || '1.0.0'); }
  catch (_) { return '1.0.0'; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); }
  catch (_) { return false; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { code: 413 })); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(Object.assign(new Error('invalid JSON body'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

function publicProvider(cfg) {
  if (!cfg) return { configured: false };
  let base = '';
  try {
    const u = new URL(cfg.baseUrl);
    u.username = ''; u.password = '';
    base = u.toString().replace(/\/+$/, '');
  } catch (_) { base = ''; }
  // NEVER include apiKey.
  return { configured: true, type: cfg.type, model: cfg.model || '', baseUrl: base };
}

function createApp(opts) {
  opts = opts || {};
  const authToken = opts.authToken;
  const store = opts.store;
  const registry = opts.registry;
  const log = opts.log;
  const ver = opts.version || '1.0.0';
  const bootAt = Date.now();
  const runs = new Map();
  let provider = opts.provider || null; // normalized config or null
  let providerIssue = opts.providerIssue || null;

  function authed(req) {
    const h = req.headers && req.headers.authorization;
    if (!h || typeof h !== 'string') return false;
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return false;
    return safeEqual(m[1], authToken);
  }

  function handler(req, res) {
    const corr = corrFromReq(req);
    const t0 = Date.now();
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname || '/';
    const done = (code) => { if (log) { try { log.info('http', { method: req.method, path: p, code, ms: Date.now() - t0 }, corr); } catch (_) {} } };

    if (!authed(req)) { sendJson(res, 401, { error: 'authentification requise.' }); done(401); return; }

    const mSession = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})(\/messages|\/abort)?$/);

    const route = async () => {
      // -- health (auth required, like everything else) ---------------------
      if (req.method === 'GET' && p === '/health') {
        sendJson(res, 200, { ok: true, version: ver, uptimeSec: Math.floor((Date.now() - bootAt) / 1000), sessions: store.count(), provider: publicProvider(provider), providerIssue });
        done(200); return;
      }
      // -- tools / permissions / providers ----------------------------------
      if (req.method === 'GET' && p === '/tools') { sendJson(res, 200, { tools: registry.listTools() }); done(200); return; }
      if (req.method === 'GET' && p === '/permissions') { sendJson(res, 200, registry.getPermissions()); done(200); return; }
      if (req.method === 'GET' && p === '/providers') { sendJson(res, 200, { providers: [publicProvider(provider)], issue: providerIssue }); done(200); return; }
      // -- sessions ----------------------------------------------------------
      if (req.method === 'POST' && p === '/sessions') {
        const body = await readBody(req);
        const s = store.create({ title: body.title, projectRoot: body.projectRoot });
        if (log) { try { log.info('session create', { session: s.id, titleChars: s.title.length }, corr); } catch (_) {} }
        sendJson(res, 201, s); done(201); return;
      }
      if (req.method === 'GET' && p === '/sessions') { sendJson(res, 200, { sessions: store.list() }); done(200); return; }
      if (mSession && !mSession[2] && req.method === 'GET') {
        const s = store.get(mSession[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        sendJson(res, 200, s); done(200); return;
      }
      if (mSession && !mSession[2] && req.method === 'DELETE') {
        const ok = store.remove(mSession[1]);
        if (!ok) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        if (log) { try { log.info('session delete', { session: mSession[1] }, corr); } catch (_) {} }
        sendJson(res, 200, { removed: true }); done(200); return;
      }
      // -- abort ---------------------------------------------------------------
      if (mSession && mSession[2] === '/abort' && req.method === 'POST') {
        const s = store.get(mSession[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        const aborted = abortRun(runs, mSession[1]);
        sendJson(res, 200, { aborted }); done(200); return;
      }
      // -- messages (SSE) --------------------------------------------------------
      if (mSession && mSession[2] === '/messages' && req.method === 'POST') {
        const id = mSession[1];
        const s = store.get(id);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        const body = await readBody(req);
        const prompt = body.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) { sendJson(res, 400, { error: 'prompt vide.' }); done(400); return; }
        if (runs.has(id)) { sendJson(res, 409, { error: 'un tour est deja en cours sur cette session.' }); done(409); return; }
        if (!provider) { sendJson(res, 503, { code: 'bad_config', error: providerIssue || 'provider non configure.' }); done(503); return; }
        // Fast pre-check BEFORE opening the stream: offline runtime or empty
        // model list => immediate clear JSON error (<5s), never fake success.
        let pre = null;
        try { pre = await probeProvider(provider, { timeoutMs: 4000 }); }
        catch (e) { pre = { ok: false, code: 'provider_error', error: String((e && e.message) || e) }; }
        if (!pre.ok) { sendJson(res, 502, { code: pre.code, error: pre.error }); done(502); return; }
        // Stream.
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Correlation-Id': corr });
        const emit = (type, obj) => {
          try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n'); }
          catch (_) {}
        };
        let finished = false;
        const finish = () => { if (!finished) { finished = true; try { res.end(); } catch (_) {} done(200); } };
        req.on('close', () => { abortRun(runs, id); finish(); });
        try {
          await runTurn({
            store, provider, sessionId: id, prompt, corr, log, runs, preProbe: pre,
            onEvent: (evt) => emit(evt.type, evt),
          });
        } catch (e) {
          emit('turn.error', { type: 'turn.error', code: 'internal', error: 'erreur interne.' });
          if (log) { try { log.error('turn exception', { session: id, error: maskSecrets(String((e && e.message) || e)).slice(0, 200) }, corr); } catch (_) {} }
        }
        finish();
        return;
      }
      sendJson(res, 404, { error: 'route inconnue.' }); done(404);
    };

    route().catch((e) => {
      const code = (e && e.code) || 500;
      try { sendJson(res, code, { error: code === 413 ? 'corps trop volumineux.' : code === 400 ? 'corps JSON invalide.' : 'erreur interne.' }); } catch (_) {}
      done(code);
    });
  }

  const server = http.createServer(handler);
  return { server, runs, handler };
}

function parseEnv(env) {
  env = env || process.env;
  const token = env.SUDO_AGENT_TOKEN ? String(env.SUDO_AGENT_TOKEN) : '';
  if (!token || token.length < 16) return { ok: false, error: 'SUDO_AGENT_TOKEN manquant (16+ caracteres requis).' };
  let port = 0;
  if (env.SUDO_AGENT_PORT !== undefined && env.SUDO_AGENT_PORT !== '') {
    port = parseInt(String(env.SUDO_AGENT_PORT), 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) return { ok: false, error: 'SUDO_AGENT_PORT invalide.' };
  }
  let provider = null;
  let providerIssue = null;
  const rawProvider = env.SUDO_AGENT_PROVIDER ? String(env.SUDO_AGENT_PROVIDER) : '';
  if (rawProvider) {
    let parsed = null;
    try { parsed = JSON.parse(rawProvider); } catch (_) { parsed = null; }
    if (!parsed) { providerIssue = 'SUDO_AGENT_PROVIDER n\'est pas du JSON valide.'; }
    else {
      const n = normalizeConfig(parsed);
      if (n.ok) provider = n.config;
      else providerIssue = n.error;
    }
  } else {
    providerIssue = 'provider non configure (SUDO_AGENT_PROVIDER absent).';
  }
  return { ok: true, token, port, provider, providerIssue };
}

function startFromEnv() {
  const parsed = parseEnv(process.env);
  if (!parsed.ok) {
    try { process.stderr.write('[sudo-agent] ' + parsed.error + '\n'); } catch (_) {}
    process.exitCode = 2;
    return null;
  }
  const log = createLogger({ component: 'agent' });
  let store = null;
  try { store = createStore({}); }
  catch (e) {
    try { process.stderr.write('[sudo-agent] store init failed: ' + String((e && e.message) || e) + '\n'); } catch (_) {}
    process.exitCode = 2;
    return null;
  }
  const registry = createRegistry();
  const ver = version();
  const app = createApp({ authToken: parsed.token, provider: parsed.provider, providerIssue: parsed.providerIssue, store, registry, log, version: ver });

  const shutdown = (sig) => {
    try { log.info('shutdown', { signal: sig }); } catch (_) {}
    try { app.server.close(() => process.exit(0)); } catch (_) { process.exit(0); }
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  app.server.on('error', (e) => {
    try { process.stderr.write('[sudo-agent] listen failed: ' + maskSecrets(String((e && e.message) || e)) + '\n'); } catch (_) {}
    try { log.error('listen failed', { error: maskSecrets(String((e && e.message) || e)).slice(0, 200) }); } catch (_) {}
    process.exit(2);
  });

  app.server.listen(parsed.port, HOST, () => {
    const addr = app.server.address();
    const port = addr && addr.port ? addr.port : parsed.port;
    try { log.sessionHeader(gatherSessionInfo({ build: 'sudo-agent/' + ver, provider: publicProvider(parsed.provider), port })); } catch (_) {}
    try { log.info('listen', { host: HOST, port, sessions: store.count(), provider: !!parsed.provider }); } catch (_) {}
    // Handshake for the supervising extension (stdout, single JSON line).
    try { process.stdout.write(JSON.stringify({ ready: true, host: HOST, port, pid: process.pid, version: ver }) + '\n'); } catch (_) {}
  });
  return app;
}

if (require.main === module) startFromEnv();

module.exports = { createApp, parseEnv, startFromEnv, publicProvider, HOST };
