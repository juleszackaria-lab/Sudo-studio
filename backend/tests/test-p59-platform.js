// P59: platform tools + deterministic pre-router + turn isolation.
// Hermetic: stub backend on loopback, temp dirs, no network, no real model.
// Proves the parts that CAN be proven here; the installed-package proofs are
// reported separately (see the P59 report) and are never faked here.
// ASCII only.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT = path.join(ROOT, 'sudo-agent', 'src');
const platform = require(path.join(AGENT, 'platform'));
const router = require(path.join(AGENT, 'router'));
const toolsMod = require(path.join(AGENT, 'tools'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; failures.push(name); console.log('FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p59-'));
function dir(name) { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; }
function wf(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ------------------------------------------------------------- stub backend
// Serves only what the bridge really calls. `editionFeatures` drives the
// edition gate; `calls` records every request so the test can assert that an
// excluded feature is NEVER executed.
function stubBackend(opts) {
  opts = opts || {};
  const calls = [];
  const state = { features: Object.assign({ security: true, devops: true, doctor: true, environment: true }, opts.features || {}) };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
      calls.push({ method: req.method, url: req.url, body: parsed });
      req.body = parsed;
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/platform/edition') {
        return send(200, { edition: state.edition || 'enterprise', features: state.features });
      }
      if (req.url === '/api/system/doctor') {
        return send(200, { success: true, score: 60, results: [
          { name: 'Node.js', status: 'ok', value: 'v18.20.0' },
          { name: 'Python', status: 'error', value: 'Not found', fix: 'installPython' },
        ] });
      }
      if (req.url === '/api/devops/generate') {
        if (!state.features.devops) return send(403, { error: 'x', feature: 'devops', edition: 'community' });
        if (req.body && req.body.type === 'github-actions' && !state.features.cicd) {
          return send(403, { error: 'x', feature: 'cicd', edition: 'team' });
        }
        return send(200, { filename: 'Dockerfile', content: 'FROM node:18-alpine\n' });
      }
      if (req.url === '/api/environment/status') {
        if (!state.features.environment) return send(403, { error: 'x', feature: 'environment', edition: 'community' });
        return send(200, { sdks: [{ id: 'node', version: '18.20.0', installed: true }] });
      }
      if (req.url === '/api/supervisor/runtime-status') return send(200, { running: true, pid: 4242, port: 6000 });
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls, state }));
  });
}

(async () => {
  // ---------------------------------------------------------------- fixtures
  const proj = dir('projet');
  wf(proj, 'app.js', 'console.log("hi");\n');
  // A secret shaped like a GitHub token, in a file the scanner will read.
  wf(proj, 'config.js', 'const token = "ghp_' + 'A'.repeat(36) + '";\n');
  wf(proj, '.github/workflows/ci.yml', 'name: ci\non: [push]\njobs:\n  a:\n    - name: build\n      run: npm test\n');
  wf(proj, '.github/workflows/broken.yml', 'name: broken\njobs:\n  a:\n    - name: x\n      run: echo\n');
  const home = dir('home');
  const logs = dir('home/logs');
  wf(logs, 'runtime.log', 'INFO demarrage\nERROR echec chargement modele token=ghp_' + 'B'.repeat(36) + '\nINFO fin\n');

  const be = await stubBackend({ features: { security: true } });
  const ctxBase = { root: proj, home, ctxTokens: 4096, backendUrl: 'http://127.0.0.1:' + be.port, backendToken: 'jeton-test-0123456789' };

  // ============================================================ A1 registry
  const names = toolsMod.toolNames();
  const missing = platform.TOOL_NAMES.filter((n) => names.indexOf(n) === -1);
  check('A1 les 12 outils plateforme sont enregistres', missing.length === 0, 'manquants: ' + missing.join(','));

  // ================================================== A2 audit reel + masque
  const sec = await platform.run(ctxBase, 'security_audit_run', {});
  check('A2 security_audit_run trouve le secret du projet', sec.ok && sec.data.secrets.length >= 1, JSON.stringify(sec).slice(0, 200));
  const rawTok = 'ghp_' + 'A'.repeat(36);
  const dump = JSON.stringify(sec.data) + sec.summary;
  check('A3 la valeur du secret n apparait JAMAIS en clair', dump.indexOf(rawTok) === -1 && !/ghp_AAAA/.test(dump));
  check('A4 le secret garde fichier + ligne + type', sec.data.secrets.some((s) => /config\.js$/.test(String(s.fichier)) && s.ligne > 0 && s.type));
  check('A5 score deterministe et borne 0..100', sec.data.score >= 0 && sec.data.score <= 100, sec.data.score);

  // ================================================ A6 read = dernier resultat
  const sec2 = await platform.run(ctxBase, 'security_audit_read', {});
  check('A6 security_audit_read reutilise le dernier resultat (pas de nouveau scan)',
    sec2.ok && sec2.data.reused === true && sec2.data.score === sec.data.score);
  const home2 = dir('home-vide');
  const sec3 = await platform.run(Object.assign({}, ctxBase, { home: home2 }), 'security_audit_read', {});
  check('A7 sans resultat stocke, read lance le scan et le dit', sec3.ok && sec3.data.firstRun === true);

  // ============================================================ A8 budget 25%
  const small = await platform.run(Object.assign({}, ctxBase, { ctxTokens: 1024 }), 'security_audit_run', {});
  const budget = platform.budgetChars(1024);
  check('A8 resultat borne a 25% du contexte', small.chars <= budget, small.chars + ' > ' + budget);
  check('A9 budget = 25% de n_ctx (4 car./token)', platform.budgetChars(2048) === 2048 && platform.budgetChars(8192) === 8192);

  // ================================================== A10 edition refusee net
  be.state.features.security = false;
  platform.resetEditionCache();
  const beforeCalls = be.calls.length;
  const denied = await platform.run(ctxBase, 'security_audit_run', {});
  check('A10 fonction hors edition : refus explicite', denied.ok === false && denied.code === 'not_in_edition');
  check('A11 le message est comprehensible', /non incluse dans votre edition/.test(String(denied.error)), denied.error);
  const scans = be.calls.slice(beforeCalls).filter((c) => c.url === '/api/security');
  check('A12 aucun contournement : le scan n est pas execute', scans.length === 0);
  be.state.features.security = true;
  platform.resetEditionCache();

  // =========================================== A13 backend devops / doctor
  const gen = await platform.run(ctxBase, 'devops_generate', { type: 'dockerfile' });
  check('A13 devops_generate renvoie le contenu du backend reel', gen.ok && /FROM node/.test(gen.data.contenu));
  const projFiles = fs.readdirSync(proj).sort().join(',');
  check('A14 devops_generate n ecrit RIEN sur disque (ecriture = write/edit approuves)',
    !/Dockerfile/.test(projFiles), projFiles);
  const genCI = await platform.run(ctxBase, 'devops_generate', { type: 'github-actions' });
  check('A15 CI/CD hors edition -> not_in_edition (garde du backend)', genCI.ok === false && genCI.code === 'not_in_edition', JSON.stringify(genCI).slice(0, 200));

  const doc = await platform.run(ctxBase, 'doctor_run', {});
  check('A16 doctor_run utilise le backend reel', doc.ok && doc.data.checks.length === 2 && /backend/.test(doc.data.source));
  check('A17 doctor liste les manquants', doc.data.manquants.indexOf('Python') !== -1);

  const dev = await platform.run(ctxBase, 'devops_read', {});
  check('A18 devops_read voit les 2 workflows', dev.ok && dev.data.nb >= 2, dev.data.nb);
  check('A19 devops_read signale le workflow casse (on: absent)', dev.data.erreurs.length >= 1, JSON.stringify(dev.data.erreurs));

  // ================================================================= A20 logs
  const lg = await platform.run(Object.assign({}, ctxBase, { home }), 'logs_read', { niveau: 'ERROR', lignes: 10 });
  check('A20 logs_read filtre le niveau ERROR', lg.ok && lg.data.trouvees >= 1, lg.data.trouvees);
  check('A21 un jeton dans un journal est masque', JSON.stringify(lg.data).indexOf('ghp_BBBB') === -1);

  // ============================================================ A22 runtime
  const rt = await platform.run(ctxBase, 'runtime_status', {});
  check('A22 runtime_status sonde le superviseur', rt.ok && rt.data.superviseur && rt.data.superviseur.pid === 4242);

  // ============================================================ A23 licence
  const lic = await platform.run(ctxBase, 'license_status', {});
  check('A23 license_status remonte l edition reelle', lic.ok && lic.data.edition === 'enterprise');

  // ================================================== A24 hors ligne honnete
  be.srv.close();
  platform.resetEditionCache();
  const offline = await platform.run(Object.assign({}, ctxBase, { backendUrl: 'http://127.0.0.1:1' }), 'environment_read', {});
  check('A24 backend injoignable : erreur honnete, pas de donnees inventees',
    offline.ok === false && offline.code === 'backend_offline');

  // ================================================ A25 score avant / apres
  const fixProj = dir('projet-failles');
  const fixHome = dir('home-failles');
  wf(fixProj, 'conf.js', 'const token = "ghp_' + 'D'.repeat(36) + '";\n');
  const s1 = await platform.run({ root: fixProj, home: fixHome }, 'security_audit_run', {});
  check('A25 premier audit : pas de score precedent', s1.data.scoreAvant === null && s1.data.delta === null, s1.data.score);
  wf(fixProj, 'conf.js', 'const token = process.env.TOKEN;\n');
  const s2 = await platform.run({ root: fixProj, home: fixHome }, 'security_audit_run', {});
  check('A26 second audit : score AVANT/APRES reel et delta positif',
    s2.data.scoreAvant === s1.data.score && s2.data.delta > 0 && s2.data.score > s1.data.score,
    JSON.stringify({ avant: s2.data.scoreAvant, apres: s2.data.score, delta: s2.data.delta }));
  check('A27 le resume affiche avant/apres', /avant \d+, \+\d+/.test(s2.summary), s2.summary.split('\n')[0]);

  // ============================================================== B router
  const r1 = router.route('Va voir le resultat du Security Audit et corrige les failles trouvees.');
  check('B1 "Security Audit ... corrige les failles" -> security', r1.domain === 'security', r1.domain);
  check('B2 le flux de correction est detecte', router.wantsFix('corrige les failles de securite') === true);
  const r2 = router.route('Regarde Project Analysis et dis-moi ce qui est a ameliorer.');
  check('B3 "Project Analysis" -> analysis', r2.domain === 'analysis', r2.domain);
  const r3 = router.route('Il y a un probleme dans le DevOps, regarde et corrige.');
  check('B4 "probleme dans le DevOps" -> devops', r3.domain === 'devops', r3.domain);
  const r4 = router.route('Que dit le System Doctor ? Qu est-ce qui manque ?');
  check('B5 "System Doctor ... manque" -> doctor', r4.domain === 'doctor', r4.domain);
  const r5 = router.route('Regarde les journaux en erreur du runtime et explique.');
  check('B6 "journaux en erreur" -> logs', r5.domain === 'logs', r5.domain);
  const r6 = router.route('Utilise l extension/skill de verification pour controler le rendu.');
  check('B7 "extension" -> extensions', r6.domain === 'extensions', r6.domain);
  const r7 = router.route('Bonjour, comment vas-tu ?');
  check('B8 aucun domaine : surface complete, aucun outil plateforme impose', r7.domain === null && r7.tools.length === 0);
  check('B9 maximum 6 outils plateforme par tour',
    [r1, r2, r3, r4, r5, r6].every((r) => r.tools.length <= router.MAX_EXPOSED), 'max=' + router.MAX_EXPOSED);
  const a1 = JSON.stringify(router.route('corrige les failles de securite'));
  const a2 = JSON.stringify(router.route('corrige les failles de securite'));
  check('B10 routage deterministe (meme prompt, meme route)', a1 === a2);
  check('B11 chaque domaine pre-charge un outil de LECTURE', r1.prefetch === 'security_audit_read' &&
    r2.prefetch === 'project_analysis_read' && r3.prefetch === 'devops_read' &&
    r4.prefetch === 'doctor_read' && r5.prefetch === 'logs_read');

  // ====================================================== B12 surface outil
  const full = toolsMod.toOpenAISchema('full', 8192);
  const fullNames = full.map((x) => x.function.name);
  check('B12 profil complet (>=8192) : 36 outils par defaut (copy_project ajoute en P62-D5)', full.length === 36, full.length);
  check('B13 aucun outil plateforme dans la surface par defaut',
    fullNames.filter((n) => platform.isPlatformTool(n)).length === 0);
  const routed = toolsMod.toOpenAISchema('full', 8192, { platformTools: r1.tools });
  const routedPlatform = routed.map((x) => x.function.name).filter((n) => platform.isPlatformTool(n));
  check('B14 la route ajoute les outils du domaine', routedPlatform.length === r1.tools.length &&
    routedPlatform.indexOf('security_audit_run') !== -1, routedPlatform.join(','));
  const tooMany = toolsMod.toOpenAISchema('full', 8192, { platformTools: platform.TOOL_NAMES });
  check('B15 jamais plus de 6 outils plateforme, meme si on en demande 12',
    tooMany.map((x) => x.function.name).filter((n) => platform.isPlatformTool(n)).length === 6);

  // ======================================= C. runTurn reel (modele simule)
  // The transport is a scripted provider: what is proven here is the AGENT
  // behaviour (routing, pre-loaded platform data, journal, turn isolation),
  // not a model answer. No installed-package claim is made from this file.
  const { createLogger } = require(path.join(AGENT, 'journal'));
  const { SessionStore } = require(path.join(AGENT, 'store'));
  const { runTurn } = require(path.join(AGENT, 'loop'));

  async function driveTurn(prompt, responses, opts) {
    opts = opts || {};
    const h = dir('home-turn-' + Math.random().toString(16).slice(2, 8));
    const logsDir = path.join(h, 'logs');
    const log = createLogger({ logsDir, component: 'agent' });
    const store = opts.store || new SessionStore({ dir: path.join(h, 'store') });
    const s = opts.session || store.create({ title: 't', projectRoot: proj });
    const mock = await mockProvider({ responses });
    const events = [];
    const env = { SUDO_BACKEND_URL: 'http://127.0.0.1:' + (opts.backendPort || 1) };
    const saved = process.env.SUDO_BACKEND_URL;
    const savedCtx = process.env.SUDO_AGENT_CTX_TOKENS;
    process.env.SUDO_AGENT_CTX_TOKENS = String(opts.ctxTokens || 8192);
    process.env.SUDO_BACKEND_URL = env.SUDO_BACKEND_URL;
    process.env.SUDO_STUDIO_HOME = h;
    try {
      const out = await runTurn({
        store, sessionId: s.id, prompt, corr: 'p59',
        provider: { type: 'local', baseUrl: 'http://127.0.0.1:' + mock.port, model: 'mock-model' },
        toolsCtx: { home: h, sessionRules: new Map(), pending: new Map() },
        runs: new Map(), log,
        onEvent: (e) => { events.push(e); },
      });
      let journal = '';
      try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
      return { out, chats: mock.chats, journal, events, home: h, store, session: s };
    } finally {
      if (saved === undefined) delete process.env.SUDO_BACKEND_URL; else process.env.SUDO_BACKEND_URL = saved;
      if (savedCtx === undefined) delete process.env.SUDO_AGENT_CTX_TOKENS; else process.env.SUDO_AGENT_CTX_TOKENS = savedCtx;
      await mock.close();
    }
  }
  function sysTexts(body) {
    return (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
  }

  // A question about a platform feature: the router pre-loads the Doctor data
  // and injects it, so the model reasons on REAL output instead of guessing.
  const be2 = await stubBackend({});
  const t1 = await driveTurn('Que dit le System Doctor ? Qu est-ce qui manque ?', [{ content: 'Le Python manque.' }], { backendPort: be2.port });
  check('C1 le tour aboutit (modele simule)', t1.out && t1.out.status === 'done', JSON.stringify(t1.out).slice(0, 200));
  check('C2 journal : route intention = doctor', /route intention/.test(t1.journal) && /doctor/.test(t1.journal));
  check('C3 journal : donnees plateforme pre-chargees', /plateforme question prechargee/.test(t1.journal));
  const injected = t1.chats.length ? sysTexts(t1.chats[0]) : '';
  check('C4 le modele RECOIT le resultat reel du Doctor', /DONNEES PLATEFORME/.test(injected) && /Python/.test(injected), injected.slice(0, 300));
  check('C5 journal : git statut avant/apres (P59-13)', /git statut avant/.test(t1.journal) && /git statut apres/.test(t1.journal));

  // "corrige les failles" -> protocol injected (one fix at a time + re-audit).
  const tf = await driveTurn('Va voir le resultat du Security Audit et corrige les failles trouvees.',
    [{ content: 'Je traite les failles une par une.' }], { backendPort: be2.port });
  // Any round may carry the context (the strict ACTION loop retries with a
  // reduced schema, then a rescue call): the proof is that SOME payload the
  // engine sent contains the protocol and the real findings.
  const injF = tf.chats.map((c) => sysTexts(c)).join('\n===\n');
  check('C9 flux correction : protocole injecte (une faille a la fois + relance)',
    /PROTOCOLE DE CORRECTION/.test(injF) && /security_audit_run/.test(injF), injF.slice(-200));
  check('C10 flux correction : le modele voit les failles reelles du projet',
    /DONNEES PLATEFORME \(security/.test(injF));
  check('C11 flux correction : journalise', /protocole correction failles/.test(tf.journal));

  // Isolation: a failed turn must leave NO state behind for the next one.
  const t2 = await driveTurn('Regarde les journaux en erreur du runtime.', [{ content: 'rien a signaler' }], { backendPort: be2.port });
  check('C6 un tour suivant fonctionne normalement', t2.out && t2.out.status === 'done');
  const inj2 = t2.chats.length ? sysTexts(t2.chats[0]) : '';
  check('C7 isolation : le tour 2 ne recoit AUCUNE donnee Doctor du tour 1', !/DONNEES PLATEFORME \(doctor/.test(inj2));
  check('C8 isolation : le tour 2 a sa propre route (logs)', /route intention/.test(t2.journal) && /logs/.test(t2.journal));
  await be2.srv.close();

  console.log('\n---');
  console.log('P59: ' + pass + '/' + (pass + fail) + ' passed' + (fail ? ' | FAILS: ' + failures.join(', ') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('ERREUR HARNAIS :: ' + String((e && e.stack) || e).slice(0, 900));
  process.exit(1);
});

// ------------------------------------------------------- scripted provider
// Minimal OpenAI-compatible endpoint. Responses are consumed in order; a plain
// content string answers, a {toolCalls:[{name,args}]} object calls a tool.
function mockProvider(opts) {
  const o = opts || {};
  const chats = [];
  const queue = (o.responses || []).slice();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && (u.pathname === '/v1/models' || u.pathname === '/health' || u.pathname === '/props')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(u.pathname === '/v1/models'
        ? { object: 'list', data: [{ id: 'mock-model' }] }
        : { ok: true, n_ctx: 4096, default_generation_settings: { n_ctx: 4096 } }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        chats.push(body);
        const next = queue.length ? queue.shift() : { content: 'fin' };
        if (body.stream === true) {
          const txt = String(next.content === undefined ? '' : next.content);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((tc, i) => ({ id: 'call-' + chats.length + '-' + i, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: msg }] }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, chats, close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

// ------------------------------------------------------------------ helpers
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function handshake(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('handshake timeout')), 20000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(t);
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
  });
}
function httpJson(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 20000,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = null; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
// Streams a turn and resolves { done, error } when it ends (never rejects).
function turn(port, token, sid, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = http.request({ host: '127.0.0.1', port, path: '/sessions/' + sid + '/messages', method: 'POST', timeout: 45000,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.indexOf('data:') !== 0) continue;
          let obj = null;
          try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (/turn\.(done|error)/.test(buf) || obj.status || obj.type === 'turn.done' || obj.type === 'turn.error') {
            // event type travels on the "event:" line; accept both shapes
            if (obj.error && !obj.status) return finish({ done: false, error: obj.error });
            if (obj.status) return finish({ done: true });
          }
        }
      });
      res.on('end', () => finish({ done: false, error: 'stream ended' }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish({ done: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ done: false, error: String(e.message || e) }));
    req.write(payload);
    req.end();
  });
}
function readLogs(dir0) {
  let out = '';
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.log$/.test(e.name)) { try { out += fs.readFileSync(p, 'utf8'); } catch (_) {} }
    }
  };
  walk(dir0);
  return out;
}
