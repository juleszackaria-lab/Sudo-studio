// Sudo Agent core server (P24, step 1). Sessions, SSE message stream, cancel,
// tool registry (empty), permissions, providers. Localhost only, token auth on
// EVERY endpoint (health included). Stdlib only. ASCII only.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createLogger, newCorr, corrFromReq, maskSecrets, gatherSessionInfo } = require('./journal');
const { createStore } = require('./store');
const { createRegistry } = require('./registry');
const { normalizeConfig, probeProvider, waitForRuntime } = require('./providers');
const { runTurn, abortRun } = require('./loop');
const toolMod = require('./tools');
const permMod = require('./permissions');
const ckptMod = require('./checkpoints');
const modesMod = require('./modes');
const mcpMod = require('./mcp');
const keyringMod = require('./keyring');
const skillsMod = require('./skills');
const commandsMod = require('./commands');
const agentsMod = require('./agents');
const rulesMod = require('./rules');
const pmapMod = require('./projectmap');
const execMod = require('./exec');

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
  const pending = new Map(); // approvalId -> { request, sessionId }
  const waiters = new Map(); // P52: approvalId -> { resolve, sessionId } (paused turns)
  const sessionRules = new Map(); // sessionId -> Set(ruleKey)
  const home = process.env.SUDO_STUDIO_HOME || (function () { try { return require('os').homedir(); } catch (_) { return process.cwd(); } })();
  // P25: populate the tool registry (handlers wired to the real pipeline).
  try {
    for (const name of toolMod.toolNames()) {
      const def = toolMod.TOOLS[name];
      registry.registerTool({ name, description: def.description, danger: def.danger, handler: (ctx, args) => toolMod.executeTool(ctx, name, args, {}) });
    }
  } catch (_) {}
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
    // P53-6: approval polling is a heartbeat, not an event: it lands in
    // DEBUG (off by default) so ten idle minutes write a handful of lines.
    const isApprovalPoll = req.method === 'GET' && /^\/sessions\/[A-Za-z0-9_-]{1,64}\/approvals$/.test(p);
    const done = (code) => {
      if (!log) return;
      try {
        const f = { method: req.method, path: p, code, ms: Date.now() - t0 };
        if (isApprovalPoll) log.debug('http', f, corr);
        else log.info('http', f, corr);
      } catch (_) {}
    };

    if (!authed(req)) { sendJson(res, 401, { error: 'authentification requise.' }); done(401); return; }

    const mSession = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})(\/messages|\/abort)?$/);
    const mTools = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})\/tools\/call$/);
    const mAppr = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})\/approvals$/);
    const mUndo = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})\/undo$/);
    const mMode = p.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})\/mode$/);

    const toolRoot = (projectRoot) => {
      if (!projectRoot || typeof projectRoot !== 'string') return { ok: false, error: 'aucun dossier de projet sur cette session.' };
      try {
        const st = require('fs').statSync(projectRoot);
        if (!st.isDirectory()) return { ok: false, error: 'dossier de projet invalide.' };
        let real = projectRoot;
        try { real = require('fs').realpathSync(projectRoot); } catch (_) {}
        return { ok: true, root: real };
      } catch (_) { return { ok: false, error: 'dossier de projet invalide.' }; }
    };
    const rulesFor = (sessionId, root) => {
      if (!sessionRules.has(sessionId)) sessionRules.set(sessionId, new Set());
      return { session: sessionRules.get(sessionId), project: permMod.loadProjectRules(home, root).rules };
    };

    const route = async () => {
      // -- health (auth required, like everything else) ---------------------
      if (req.method === 'GET' && p === '/health') {
        sendJson(res, 200, { ok: true, version: ver, uptimeSec: Math.floor((Date.now() - bootAt) / 1000), sessions: store.count(), provider: publicProvider(provider), providerIssue });
        done(200); return;
      }
      // -- tools / permissions / providers ----------------------------------
      if (req.method === 'GET' && p === '/tools') {
        const list = registry.listTools().map((t) => ({ name: t.name, description: t.description, danger: t.danger, mutating: !!(toolMod.TOOLS[t.name] && toolMod.TOOLS[t.name].mutating) }));
        sendJson(res, 200, { tools: list }); done(200); return;
      }
      if (req.method === 'GET' && p === '/permissions') {
        sendJson(res, 200, { mode: 'ask-mutating', readonly: permMod.READONLY_AUTO, mutating: permMod.MUTATING_ASK, denyList: permMod.denyIds(), p8: toolMod.p8Available(), l2: toolMod.l2status() });
        done(200); return;
      }
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
      // -- mode (P26-a: build|plan) -------------------------------------------
      if (mMode && req.method === 'POST') {
        const s = store.get(mMode[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        if (runs.has(mMode[1])) { sendJson(res, 409, { error: 'un tour est deja en cours sur cette session.' }); done(409); return; }
        const body = await readBody(req);
        const m = modesMod.setMode(store, mMode[1], body.mode);
        if (m === null) { sendJson(res, 400, { error: 'mode invalide (build|plan).' }); done(400); return; }
        if (log) { try { log.info('session mode', { session: mMode[1], mode: m }, corr); } catch (_) {} }
        sendJson(res, 200, { mode: m }); done(200); return;
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
        // Pre-check BEFORE opening the stream: empty model list / bad
        // config => immediate clear JSON error (<5s), never fake success.
        // P48(4): an OFFLINE local runtime instead opens the stream and
        // waits (<=60s, "Runtime restarting, attempt n/5" events) for the
        // supervised restart, then resumes the turn transparently.
        let pre = null;
        try { pre = await probeProvider(provider, { timeoutMs: 4000 }); }
        catch (e) { pre = { ok: false, code: 'provider_error', error: String((e && e.message) || e) }; }
        if (!pre.ok && pre.code !== 'runtime_offline') { sendJson(res, 502, { code: pre.code, error: pre.error }); done(502); return; }
        // Stream.
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Correlation-Id': corr });
        const emit = (type, obj) => {
          try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n'); }
          catch (_) {}
        };
        let finished = false;
        const finish = () => { if (!finished) { finished = true; try { res.end(); } catch (_) {} done(200); } };
        req.on('close', () => { abortRun(runs, id); finish(); });
        if (!pre.ok) {
          const w = await waitForRuntime(provider, {
            shouldAbort: () => finished,
            onProgress: (n, max, message) => emit('runtime.wait',
              { type: 'runtime.wait', attempt: n, maxAttempts: max, message }),
          });
          if (finished) return;
          if (!w.recovered || !w.probe || !w.probe.ok) {
            const code = (w.probe && w.probe.code) || pre.code || 'runtime_offline';
            const error = (w.probe && w.probe.error) || pre.error || 'Runtime local hors ligne.';
            emit('turn.error', { type: 'turn.error', code, error });
            if (log) { try { log.warn('turn error', { session: id, code }, corr); } catch (_) {} }
            finish();
            return;
          }
          pre = w.probe;
        }
        try {
          await runTurn({
            store, provider, sessionId: id, prompt, corr, log, runs, preProbe: pre,
            tools: body.tools, verify: body.verify, toolsCtx: { home, pending, sessionRules, waiters },
            onEvent: (evt) => emit(evt.type, evt),
          });
        } catch (e) {
          emit('turn.error', { type: 'turn.error', code: 'internal', error: 'erreur interne.' });
          if (log) { try { log.error('turn exception', { session: id, error: maskSecrets(String((e && e.message) || e)).slice(0, 200) }, corr); } catch (_) {} }
        }
        finish();
        return;
      }
      // -- direct tool call (own series; permission-checked) ---------------------
      if (mTools && req.method === 'POST') {
        const s = store.get(mTools[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        if (runs.has(mTools[1])) { sendJson(res, 409, { error: 'un tour est deja en cours sur cette session.' }); done(409); return; }
        const body = await readBody(req);
        const r = toolRoot(s.projectRoot);
        if (!r.ok) { sendJson(res, 400, { code: 'bad_project', error: r.error }); done(400); return; }
        const run = { id: corr, sessionId: mTools[1], checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: [], direct: true };
        const entry = { aborted: false, destroy: null, killFns: run.killFns, corr };
        runs.set(mTools[1], entry);
        try {
          const rr = rulesFor(mTools[1], r.root);
          const tctx = { root: r.root, sessionId: mTools[1], session: s, store, log, corr, run, home,
            sessionRules: rr.session, projectRules: rr.project, sessionKill: run.killFns, checkpoint: null };
          tctx.checkpoint = () => toolMod.ensureSeriesCheckpoint(tctx);
          const out = await toolMod.executeTool(tctx, body.tool, body.args, {});
          toolMod.saveRunSidecar(tctx);
          if (out.status === 'need-approval') {
            pending.set(out.request.id, { request: out.request, sessionId: mTools[1], fullArgs: body.args });
            sendJson(res, 200, { status: 'need-approval', request: out.request }); done(200); return;
          }
          sendJson(res, 200, out); done(200); return;
        } finally {
          if (runs.get(mTools[1]) === entry) runs.delete(mTools[1]);
        }
      }
      // -- approvals -------------------------------------------------------------
      if (mAppr && req.method === 'GET') {
        const s = store.get(mAppr[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        const list = [];
        for (const v of pending.values()) { if (v.sessionId === mAppr[1]) list.push(v.request); }
        sendJson(res, 200, { pending: list }); done(200); return;
      }
      if (mAppr && req.method === 'POST') {
        const s = store.get(mAppr[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        const body = await readBody(req);
        const decision = body.decision;
        if (['once', 'session', 'project', 'deny'].indexOf(decision) === -1) {
          sendJson(res, 400, { error: 'decision invalide (once|session|project|deny).' }); done(400); return;
        }
        const pend = pending.get(body.requestId);
        if (!pend || pend.sessionId !== mAppr[1]) { sendJson(res, 404, { code: 'unknown_request', error: 'demande inconnue.' }); done(404); return; }
        pending.delete(body.requestId);
        // P26-f: a deploy approval is ALWAYS single-use, even if the operator
        // picked session/project: no rule is ever stored for a deploy.
        let effDecision = decision;
        let deployNote = null;
        if (pend.request && pend.request.deploy === true && (decision === 'session' || decision === 'project')) {
          effDecision = 'once';
          deployNote = 'deploiement : approbation unique imposee (aucune regle memorisee).';
        }
        if (log) { try { log.info('approval decision', { session: mAppr[1], request: body.requestId, decision, effDecision, tool: pend.request.tool }, corr); } catch (_) {} }
        if (decision === 'deny') {
          // P52: a paused turn owns this request: hand the refusal over.
          const waiterD = waiters.get(body.requestId);
          if (waiterD) { try { waiterD.resolve({ decision: 'deny' }); } catch (_) {} try { waiters.delete(body.requestId); } catch (_) {} }
          sendJson(res, 200, { status: 'denied', reason: 'refuse par l\'operateur.' }); done(200); return;
        }
        const r = toolRoot(s.projectRoot);
        if (!r.ok) { sendJson(res, 400, { code: 'bad_project', error: r.error }); done(400); return; }
        const rr = rulesFor(mAppr[1], r.root);
        const key = permMod.ruleKey(pend.request.tool, pend.request.pattern);
        if (effDecision === 'session') rr.session.add(key);
        if (effDecision === 'project') {
          try { permMod.saveProjectRule(home, r.root, pend.request.tool, pend.request.pattern); } catch (e) {
            sendJson(res, 500, { error: 'regle de projet non enregistree.' }); done(500); return;
          }
          rr.project.add(key);
        }
        // P52: a paused turn owns this request: the TURN re-executes
        // (single execution, streamed). Rules above still apply next.
        // No waiter = legacy direct-tool approval (executed here).
        const waiter = waiters.get(body.requestId);
        if (waiter) {
          try { waiter.resolve({ decision: effDecision }); } catch (_) {}
          try { waiters.delete(body.requestId); } catch (_) {}
          sendJson(res, 200, { status: 'accepted', note: deployNote }); done(200); return;
        }
        const run = { id: corr, sessionId: mAppr[1], checkpointed: false, checkpointName: null, snapshot: null, calls: [], created: [], killFns: [], direct: true };
        const tctx = { root: r.root, sessionId: mAppr[1], session: s, store, log, corr, run, home,
          sessionRules: rr.session, projectRules: rr.project, sessionKill: [], checkpoint: null };
        tctx.checkpoint = () => toolMod.ensureSeriesCheckpoint(tctx);
        const args = (pend.fullArgs && typeof pend.fullArgs === 'object' ? pend.fullArgs : null) || pend.request.args || {};
        const out = await toolMod.executeTool(tctx, pend.request.tool, args, { preApproved: true });
        toolMod.saveRunSidecar(tctx);
        if (out.status === 'need-approval') {
          sendJson(res, 200, { status: 'denied', reason: 'approbation insuffisante (etat modifie).' }); done(200); return;
        }
        if (out.status === 'done') { sendJson(res, 200, { status: 'executed', call: out.call, note: deployNote }); done(200); return; }
        sendJson(res, 200, out); done(200); return;
      }
      // -- undo --------------------------------------------------------------------
      if (mUndo && req.method === 'POST') {
        const s = store.get(mUndo[1]);
        if (!s) { sendJson(res, 404, { error: 'session introuvable.' }); done(404); return; }
        if (runs.has(mUndo[1])) { sendJson(res, 409, { error: 'un tour est deja en cours sur cette session.' }); done(409); return; }
        const body = await readBody(req);
        const scope = body.scope || 'last';
        if (scope !== 'last' && scope !== 'session') { sendJson(res, 400, { error: 'scope invalide (last|session).' }); done(400); return; }
        const r = toolRoot(s.projectRoot);
        if (!r.ok) { sendJson(res, 400, { code: 'bad_project', error: r.error }); done(400); return; }
        const snaps = ckptMod.listSnapshots(home, mUndo[1]).filter((n) => n.slice(-4) !== '.run').sort();
        if (!snaps.length) { sendJson(res, 200, { scope, restored: [], deleted: [], unverified: [], errors: [], verified: true, note: 'aucun instantane.' }); done(200); return; }
        const target = scope === 'session' ? snaps[0] : snaps[snaps.length - 1];
        let snap = null;
        try { snap = ckptMod.loadSnapshot(home, mUndo[1], target); }
        catch (_) { sendJson(res, 500, { error: 'instantane illisible.' }); done(500); return; }
        let created = [];
        try { const side = ckptMod.loadSnapshot(home, mUndo[1], target + '.run'); if (side && Array.isArray(side.created)) created = side.created; } catch (_) {}
        const result = ckptMod.restoreSnapshot(r.root, snap, { created });
        const verified = result.errors.length === 0 && result.unverified.length === 0 && result.restored.every((x) => x.ok);
        // Undo-stack semantics: a VERIFIED undo consumes history (pop last, or
        // clear all after a session revert). Unverified restores keep history.
        let popped = 0;
        if (verified) {
          try {
            const fs = require('fs');
            const path = require('path');
            const dir = ckptMod.sessionDir(home, mUndo[1]);
            const victims = scope === 'session' ? snaps : [target];
            for (const v of victims) {
              for (const f of [v + '.json', v + '.run.json']) {
                try { fs.unlinkSync(path.join(dir, f)); popped += 1; } catch (_) {}
              }
            }
          } catch (_) {}
        }
        if (log) { try { log.info('undo', { session: mUndo[1], scope, snapshot: target, restored: result.restored.length, deleted: result.deleted.length, verified, popped }, corr); } catch (_) {} }
        sendJson(res, 200, Object.assign({ scope, snapshot: target, verified, popped }, result)); done(200); return;
      }
      // -- MCP servers + keyring (P50-1) ---------------------------------------
      const mMcpSrv = p.match(/^\/mcp\/servers\/([A-Za-z0-9_-]{1,64})(\/test)?$/);
      if (req.method === 'GET' && p === '/mcp/servers') {
        const servers = mcpMod.loadConfig(home);
        const policy = mcpMod.loadPolicy(home);
        const list = Object.keys(servers).sort().map((n) => mcpMod.describeServer(n, servers[n] || {}, policy));
        sendJson(res, 200, { servers: list }); done(200); return;
      }
      if (req.method === 'POST' && p === '/mcp/servers') {
        const body = await readBody(req);
        const verr = mcpMod.validateServerConfig(body.name, body);
        if (verr) { sendJson(res, 400, { error: verr }); done(400); return; }
        const transport = body.transport || (body.url ? 'http' : 'stdio');
        const entry = transport === 'http'
          ? { url: String(body.url), headers: body.headers || undefined, tokenTarget: body.tokenTarget || undefined, timeoutMs: body.timeoutMs || undefined }
          : { command: String(body.command), args: body.args || undefined, cwd: body.cwd || undefined, env: body.env || undefined };
        for (const k of Object.keys(entry)) { if (entry[k] === undefined) delete entry[k]; }
        const servers = mcpMod.loadConfig(home);
        servers[String(body.name)] = entry;
        try { mcpMod.saveConfig(home, servers); }
        catch (e) { sendJson(res, 500, { error: 'ecriture configuration impossible.' }); done(500); return; }
        if (log) { try { log.info('mcp server add', { server: String(body.name), transport }, corr); } catch (_) {} }
        sendJson(res, 201, { server: mcpMod.describeServer(String(body.name), entry, mcpMod.loadPolicy(home)) }); done(201); return;
      }
      if (mMcpSrv && !mMcpSrv[2] && req.method === 'DELETE') {
        const servers = mcpMod.loadConfig(home);
        if (!servers[mMcpSrv[1]]) { sendJson(res, 404, { error: 'serveur MCP inconnu.' }); done(404); return; }
        delete servers[mMcpSrv[1]];
        try { mcpMod.saveConfig(home, servers); }
        catch (e) { sendJson(res, 500, { error: 'ecriture configuration impossible.' }); done(500); return; }
        if (log) { try { log.info('mcp server delete', { server: mMcpSrv[1] }, corr); } catch (_) {} }
        sendJson(res, 200, { removed: true }); done(200); return;
      }
      if (mMcpSrv && mMcpSrv[2] === '/test' && req.method === 'POST') {
        const servers = mcpMod.loadConfig(home);
        if (!servers[mMcpSrv[1]]) { sendJson(res, 404, { error: 'serveur MCP inconnu.' }); done(404); return; }
        const j = (m) => { if (log) { try { log.info('mcp', { msg: String(m).slice(0, 300) }, corr); } catch (_) {} } };
        try {
          const r = await mcpMod.testServer(home, mMcpSrv[1], j);
          sendJson(res, 200, r); done(200); return;
        } catch (e) {
          const code = (e && e.code) || 'mcp_error';
          sendJson(res, 502, { ok: false, code, error: String((e && e.message) || e).slice(0, 300) }); done(502); return;
        }
      }
      if (req.method === 'GET' && p === '/keyring/status') {
        const a = keyringMod.available();
        sendJson(res, 200, { available: !!a.ok, platform: process.platform, detail: a.ok ? undefined : String(a.error || '').slice(0, 200) }); done(200); return;
      }
      if (req.method === 'POST' && p === '/keyring/secret') {
        const body = await readBody(req);
        const r = await keyringMod.setSecret(body.target, body.secret);
        if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        // Journal: target name only. The secret value is never logged.
        if (log) { try { log.info('keyring set', { target: String(body.target).slice(0, 160) }, corr); } catch (_) {} }
        sendJson(res, 200, { stored: true, target: String(body.target) }); done(200); return;
      }
      if (req.method === 'DELETE' && p === '/keyring/secret') {
        const body = await readBody(req);
        const r = await keyringMod.deleteSecret(body.target);
        if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        if (log) { try { log.info('keyring delete', { target: String(body.target).slice(0, 160) }, corr); } catch (_) {} }
        sendJson(res, 200, { removed: true }); done(200); return;
      }
      // -- skills (P50-2) ------------------------------------------------------
      const mSkillDel = p.match(/^\/skills\/([A-Za-z0-9_-]{1,64})$/);
      const mStageDel = p.match(/^\/skills\/staged\/([0-9a-f]{16})$/);
      if (req.method === 'GET' && p === '/skills') {
        const qRoot = url.searchParams.get('projectRoot');
        let root = null;
        if (qRoot) {
          const tr = toolRoot(qRoot);
          if (!tr.ok) { sendJson(res, 400, { code: 'bad_project', error: tr.error }); done(400); return; }
          root = tr.root;
        }
        sendJson(res, 200, { skills: skillsMod.listSkills(home, root), staged: skillsMod.listStaged(home) }); done(200); return;
      }
      if (req.method === 'POST' && p === '/skills/preview') {
        const body = await readBody(req);
        const r = await skillsMod.previewImport(home, body.source);
        if (!r.ok) { sendJson(res, 400, { code: r.code, error: r.error }); done(400); return; }
        if (log) { try { log.info('skill preview', { name: r.name, files: r.files.length }, corr); } catch (_) {} }
        sendJson(res, 200, r); done(200); return;
      }
      if (req.method === 'POST' && p === '/skills/activate') {
        const body = await readBody(req);
        let root = null;
        if (body.scope === 'project') {
          const tr = toolRoot(body.projectRoot);
          if (!tr.ok) { sendJson(res, 400, { code: 'bad_project', error: tr.error }); done(400); return; }
          root = tr.root;
        }
        const r = skillsMod.activateStaged(home, root, body.stagingId, body.scope, body.name);
        if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        if (log) { try { log.info('skill activate', { scope: r.scope, name: r.name }, corr); } catch (_) {} }
        sendJson(res, 201, r); done(201); return;
      }
      if (mStageDel && req.method === 'DELETE') {
        skillsMod.discardStaged(home, mStageDel[1]);
        sendJson(res, 200, { removed: true }); done(200); return;
      }
      if (req.method === 'POST' && p === '/skills/active') {
        const body = await readBody(req);
        let root = null;
        if (body.scope === 'project') {
          const tr = toolRoot(body.projectRoot);
          if (!tr.ok) { sendJson(res, 400, { code: 'bad_project', error: tr.error }); done(400); return; }
          root = tr.root;
        }
        const r = skillsMod.setActive(home, root, body.scope, body.name, body.active !== false);
        if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        sendJson(res, 200, r); done(200); return;
      }
      if (mSkillDel && req.method === 'DELETE') {
        const body = await readBody(req);
        let root = null;
        if (body.scope === 'project') {
          const tr = toolRoot(body.projectRoot);
          if (!tr.ok) { sendJson(res, 400, { code: 'bad_project', error: tr.error }); done(400); return; }
          root = tr.root;
        }
        const r = skillsMod.deleteSkill(home, root, body.scope, mSkillDel[1]);
        if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        if (log) { try { log.info('skill delete', { scope: body.scope, name: mSkillDel[1] }, corr); } catch (_) {} }
        sendJson(res, 200, r); done(200); return;
      }
      // -- P54: Agent Extensions (MCP extra + commands + agents + rules) -------
      const qRootOf = () => {
        const q = url.searchParams.get('projectRoot');
        if (!q) return { ok: true, root: null };
        const tr = toolRoot(q);
        return tr.ok ? { ok: true, root: tr.root } : { ok: false, error: tr.error };
      };
      if (req.method === 'GET' && p === '/extensions/mcp/presets') {
        sendJson(res, 200, { presets: mcpMod.presets() }); done(200); return;
      }
      if (req.method === 'GET' && p === '/extensions/mcp/tools') {
        const servers0 = mcpMod.loadConfig(home);
        const policy0 = mcpMod.loadPolicy(home);
        const st0 = mcpMod.readToolsState(home);
        const out = {};
        for (const n of Object.keys(servers0)) {
          out[n] = {
            enabled: mcpMod.isEnabled(servers0[n]),
            // Keyring ENTRY NAME only (used by the page to open the masked
            // input): never a token value.
            tokenTarget: servers0[n].tokenTarget ? String(servers0[n].tokenTarget).slice(0, 160) : '',
            allowed: policy0[n] === '*' ? ['*'] : (Array.isArray(policy0[n]) ? policy0[n].slice(0, 100) : []),
            expose: mcpMod.exposedTools(home, n),
            decisions: (st0.servers && st0.servers[n]) ? st0.servers[n] : {},
          };
        }
        sendJson(res, 200, { servers: out }); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/mcp/tools') {
        const body = await readBody(req);
        const server = String(body.server || '');
        if (body.expose !== undefined) {
          const r = mcpMod.setExposed(home, server, body.expose);
          if (!r.ok) { sendJson(res, 400, { error: r.error }); done(400); return; }
        }
        if (body.tool && body.decision) {
          const r2 = mcpMod.setToolDecision(home, server, String(body.tool), String(body.decision));
          if (!r2.ok) { sendJson(res, 400, { error: r2.error }); done(400); return; }
        }
        if (log) { try { log.info('mcp tools maj', { server, exposed: Array.isArray(body.expose) ? body.expose.length : -1 }, corr); } catch (_) {} }
        sendJson(res, 200, { ok: true, expose: mcpMod.exposedTools(home, server) }); done(200); return;
      }
      if (mMcpSrv && !mMcpSrv[2] && req.method === 'POST') {
        const body = await readBody(req);
        if (body.enabled === undefined) { sendJson(res, 400, { error: 'enabled (booleen) requis.' }); done(400); return; }
        const r3 = mcpMod.setEnabled(home, mMcpSrv[1], body.enabled !== false);
        if (!r3.ok) { sendJson(res, 404, { error: r3.error }); done(404); return; }
        if (log) { try { log.info('mcp serveur etat', { server: mMcpSrv[1], enabled: r3.enabled }, corr); } catch (_) {} }
        sendJson(res, 200, r3); done(200); return;
      }
      if (req.method === 'GET' && p === '/extensions/mcp/export') {
        sendJson(res, 200, mcpMod.toMcpServersJson(home)); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/mcp/import') {
        const body = await readBody(req);
        const r4 = mcpMod.importMcpServersJson(home, body);
        if (!r4.ok) { sendJson(res, 400, r4); done(400); return; }
        if (log) { try { log.info('mcp import', { added: r4.added.length, refused: r4.refused.length }, corr); } catch (_) {} }
        sendJson(res, 200, r4); done(200); return;
      }
      const mCmd = p.match(/^\/extensions\/commands\/([A-Za-z0-9_-]{1,64})$/);
      if (req.method === 'GET' && p === '/extensions/commands') {
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        sendJson(res, 200, { commands: commandsMod.listCommands(home, qr.root) }); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/commands') {
        const body = await readBody(req);
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const r5 = commandsMod.saveCommand(home, qr.root, body.scope || 'global', String(body.name || ''),
          body.description, body.template, body.args);
        if (!r5.ok) { sendJson(res, 400, { error: r5.error }); done(400); return; }
        if (log) { try { log.info('commande enregistree', { scope: r5.scope, name: r5.name }, corr); } catch (_) {} }
        sendJson(res, 201, r5); done(201); return;
      }
      if (mCmd && req.method === 'GET') {
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const all = commandsMod.listCommands(home, qr.root).filter((c) => c.name === mCmd[1]);
        if (!all.length) { sendJson(res, 404, { error: 'commande introuvable.' }); done(404); return; }
        const argList = (url.searchParams.get('args') || '').split(/\s+/).filter(Boolean);
        const ex = commandsMod.expand(home, qr.root, '/' + mCmd[1] + (argList.length ? ' ' + argList.join(' ') : ''));
        sendJson(res, 200, { command: all[0], preview: ex.ok ? ex.prompt : '', missing: ex.missing || [] }); done(200); return;
      }
      if (mCmd && req.method === 'DELETE') {
        const body = await readBody(req);
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const r6 = commandsMod.deleteCommand(home, qr.root, body.scope || 'global', mCmd[1]);
        if (!r6.ok) { sendJson(res, 400, { error: r6.error }); done(400); return; }
        sendJson(res, 200, r6); done(200); return;
      }
      const mAgent = p.match(/^\/extensions\/agents\/([A-Za-z0-9 _%-]{1,60})$/);
      if (req.method === 'GET' && p === '/extensions/agents') {
        sendJson(res, 200, { agents: agentsMod.listAgents(home) }); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/agents') {
        const body = await readBody(req);
        const r7 = agentsMod.saveAgent(home, body);
        if (!r7.ok) { sendJson(res, 400, { error: r7.error }); done(400); return; }
        if (log) { try { log.info('agent enregistre', { name: r7.agent.name, tools: r7.agent.tools.length }, corr); } catch (_) {} }
        sendJson(res, 201, r7); done(201); return;
      }
      if (mAgent && req.method === 'DELETE') {
        const r8 = agentsMod.deleteAgent(home, decodeURIComponent(mAgent[1]));
        if (!r8.ok) { sendJson(res, 404, { error: r8.error }); done(404); return; }
        sendJson(res, 200, r8); done(200); return;
      }
      if (req.method === 'GET' && p === '/extensions/rules') {
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const project = qr.root ? rulesMod.readProjectRules(qr.root) : { ok: true, exists: false, text: '' };
        sendJson(res, 200, { project, global: agentsMod.readGlobalRules(home) }); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/rules') {
        const body = await readBody(req);
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        if (body.scope === 'global') {
          const r9 = agentsMod.saveGlobalRules(home, body.text);
          if (!r9.ok) { sendJson(res, 400, { error: r9.error }); done(400); return; }
          if (log) { try { log.info('regles globales maj', { bytes: r9.bytes }, corr); } catch (_) {} }
          sendJson(res, 200, r9); done(200); return;
        }
        if (!qr.root) { sendJson(res, 400, { error: 'aucun projet : AGENTS.md non editable.' }); done(400); return; }
        const r10 = rulesMod.saveProjectRules(qr.root, body.text, { confirm: body.confirm === true });
        if (!r10.ok) { const code = r10.code === 'confirm_required' ? 409 : 400; sendJson(res, code, r10); done(code); return; }
        if (log) { try { log.info('AGENTS.md maj', { bytes: r10.bytes, added: r10.diff.added, removed: r10.diff.removed }, corr); } catch (_) {} }
        sendJson(res, 200, r10); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/rules/generate') {
        const qr = qRootOf();
        if (!qr.ok || !qr.root) { sendJson(res, 400, { error: 'aucun projet.' }); done(400); return; }
        const draft = rulesMod.generateDraft(pmapMod, qr.root);
        if (!draft.ok) { sendJson(res, 400, { error: draft.error }); done(400); return; }
        const cur = rulesMod.readProjectRules(qr.root);
        const diff = rulesMod.diffText(cur.exists ? cur.text : '', draft.text);
        sendJson(res, 200, { ok: true, text: draft.text, exists: !!cur.exists, diff, type: draft.type }); done(200); return;
      }
      if (req.method === 'GET' && p === '/extensions/export') {
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const bundle = {
          version: 1, exportedAt: new Date().toISOString(),
          mcp: mcpMod.toMcpServersJson(home),
          mcpTools: mcpMod.readToolsState(home),
          commands: commandsMod.listCommands(home, qr.root).map((c) => Object.assign({}, c)),
          agents: agentsMod.listAgents(home).filter((a) => !a.builtin),
          rules: { global: agentsMod.readGlobalRules(home),
            project: qr.root ? (rulesMod.readProjectRules(qr.root).text || '') : '' },
        };
        sendJson(res, 200, bundle); done(200); return;
      }
      if (req.method === 'POST' && p === '/extensions/import') {
        const body = await readBody(req);
        const qr = qRootOf();
        if (!qr.ok) { sendJson(res, 400, { error: qr.error }); done(400); return; }
        const report = { mcp: null, commands: [], agents: [], rules: [] };
        if (body.mcp) report.mcp = mcpMod.importMcpServersJson(home, body.mcp);
        if (Array.isArray(body.commands)) {
          for (const c of body.commands) {
            if (!c || !c.name) continue;
            const rc = commandsMod.saveCommand(home, qr.root, c.scope === 'project' ? 'project' : 'global',
              String(c.name), c.description, String(c.template || c.descriptionText || ''), c.args);
            report.commands.push({ name: String(c.name), ok: !!rc.ok, error: rc.error });
          }
        }
        if (Array.isArray(body.agents)) {
          for (const a of body.agents) {
            const ra = agentsMod.saveAgent(home, a);
            report.agents.push({ name: String((a && a.name) || ''), ok: !!ra.ok, error: ra.error });
          }
        }
        if (body.rules && typeof body.rules === 'object') {
          if (typeof body.rules.global === 'string') report.rules.push({ scope: 'global', ok: agentsMod.saveGlobalRules(home, body.rules.global).ok });
          if (qr.root && typeof body.rules.project === 'string' && body.rules.project) {
            const rp = rulesMod.saveProjectRules(qr.root, body.rules.project, { confirm: true });
            report.rules.push({ scope: 'project', ok: !!rp.ok, error: rp.error });
          }
        }
        if (log) { try { log.info('extensions import', { commands: report.commands.length, agents: report.agents.length }, corr); } catch (_) {} }
        sendJson(res, 200, { ok: true, report }); done(200); return;
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
    try { mcpMod.disconnectAll((m) => { try { log.info('mcp', { msg: m }); } catch (_) {} }); } catch (_) {}
    try { execMod.stopAll(); } catch (_) {}
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
    try { log.info('tools ready', { count: toolMod.toolNames().length, p8: toolMod.p8Available() }); } catch (_) {}
    try { log.info('listen', { host: HOST, port, sessions: store.count(), provider: !!parsed.provider }); } catch (_) {}
    // Handshake for the supervising extension (stdout, single JSON line).
    try { process.stdout.write(JSON.stringify({ ready: true, host: HOST, port, pid: process.pid, version: ver }) + '\n'); } catch (_) {}
  });
  return app;
}

if (require.main === module) startFromEnv();

module.exports = { createApp, parseEnv, startFromEnv, publicProvider, HOST };
