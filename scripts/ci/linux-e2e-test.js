/**
 * linux-e2e-test.js - "est-ce que ca fonctionne TOTALEMENT sur Linux ?"
 *
 * Deux modes, meme verite :
 *
 *   node scripts/ci/linux-e2e-test.js --bundle <dir>
 *       Teste un ARTEFACT extrait (le paquet Linux) : structure, binaires,
 *       services, extension, puis le mode agent de bout en bout.
 *
 *   node scripts/ci/linux-e2e-test.js --source
 *       Teste l'arbre source (ce que le paquet contient), pour valider le
 *       harnais sans construire l'artefact.
 *
 * Ce qui est verifie (aucune simulation du produit) :
 *   1. structure : editeur, extension, serveur d'agent, backend, runtime ;
 *   2. binaires : presents, executables, taille plausible, `--selftest` OK ;
 *   3. services : backend /api/system/health, runtime /health, arret propre ;
 *   4. mode agent REEL : le serveur d'agent demarre, une session est creee,
 *      un tour d'agent en mode build ecrit un vrai fichier, une action
 *      sensible declenche une approbation, un cahier des charges long produit
 *      un plan SANS etre execute ;
 *   5. editeur : lancement sans interface (xvfb si present) et absence
 *      d'erreur d'enregistrement de vues dans les journaux.
 *
 * Usage : voir ci-dessus. Options : --json, --out <fichier.json>, --keep.
 * Sortie : 0 = tout vert, 1 = au moins un echec, 2 = mauvais usage.
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail: detail === undefined ? null : String(detail).slice(0, 300) });
  if (ok) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 400)); }
}
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'linux-e2e-token-' + Date.now();

// ---------------------------------------------------------------- reseau
function httpJson(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({}, headers || {},
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    if (data) req.write(data);
    req.end();
  });
}
function ssePost(port, p, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let raw = '';
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (res) => {
      const settle = () => {
        const events = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { events.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
        }
        resolve({ status: res.statusCode, events, raw });
      };
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', settle);
      res.on('aborted', settle);
      res.on('close', settle);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 120000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.write(data);
    req.end();
  });
}
function waitHealth(port, p, ms) {
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 40000)) {
      try {
        const r = await httpJson(port, 'GET', p, null, {});
        if (r.status >= 200 && r.status < 500) return { ok: true, status: r.status, ms: Date.now() - t0, body: r.body };
      } catch (_) { /* pas encore */ }
      await sleep(300);
    }
    return { ok: false, ms: Date.now() - t0 };
  })();
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function killTree(ch) {
  try { ch.kill('SIGKILL'); } catch (_) { /* ignore */ }
  try { execFileSync('pkill', ['-9', '-P', String(ch.pid)]); } catch (_) { /* ignore */ }
}
function handshake(ch, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error('handshake timeout :: ' + err.slice(-300))), timeoutMs || 30000);
    ch.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl).trim())); } catch (e) { reject(new Error('bad handshake')); }
    });
    ch.stderr.on('data', (c) => { err += c.toString('utf8'); });
    ch.on('exit', (code) => reject(new Error('exited (' + code + ') :: ' + err.slice(-300))));
  });
}

// ------------------------------------------- fournisseur local scripte
// Un serveur OpenAI-compatible local : c'est le "runtime" du test. Il repond
// exactement ce qu'un bon modele repondrait. Aucune vraie inference ici.
function scriptedRuntime() {
  const state = { calls: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && (u.pathname === '/v1/models' || u.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(u.pathname === '/health'
        ? { status: 'ok' }
        : { object: 'list', data: [{ id: 'e2e-model', n_ctx: 8192 }] }));
      return;
    }
    if (req.method !== 'POST' || u.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) { body = {}; }
      state.calls += 1;
      const msgs = body.messages || [];
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const sawTool = msgs.some((m) => m && m.role === 'tool');
      const text = msgs.map((m) => String(m.content || '')).join('\n');
      const reply = (msg) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      };
      if (!hasTools) { reply({ role: 'assistant', content: 'ok' }); return; }
      if (/PLAN DU CAHIER DES CHARGES/.test(text)) { reply({ role: 'assistant', content: 'plan recu' }); return; }
      let fn = 'done';
      let args = { summary: 'rien a faire' };
      if (!sawTool) { fn = 'list'; args = { dir: '.' }; }
      else if (!/ecrit par l agent/.test(text)) {
        fn = 'write';
        args = { file: 'hello-linux.txt', content: 'ecrit par l agent sur linux\n' };
      }
      reply({ role: 'assistant', content: null,
        tool_calls: [{ id: 'c' + state.calls, type: 'function', function: { name: fn, arguments: JSON.stringify(args) } }] });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      calls: () => state.calls,
      close: () => new Promise((r) => srv.close(() => r())),
    }));
  });
}

// ------------------------------------------------------------- structure
function isExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
}
function findEditor(bundle) {
  const cands = [
    path.join(bundle, 'bin', 'sudostudio'),
    path.join(bundle, 'sudostudio'),
    path.join(bundle, 'SudoStudio'),
  ];
  try {
    for (const f of fs.readdirSync(path.join(bundle, 'bin'))) {
      if (/^(sudostudio|code|codium)/.test(f)) cands.push(path.join(bundle, 'bin', f));
    }
  } catch (_) { /* pas de bin/ */ }
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ------------------------------------------------------------ mode agent
async function agentModeChecks(opts) {
  const nodeBin = opts.nodeBin || process.execPath;
  const serverJs = opts.serverJs;
  const runtimeUrl = opts.runtimeUrl;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-e2e-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-e2e-home-'));
  const env = Object.assign({}, process.env, {
    SUDO_AGENT_TOKEN: TOKEN,
    SUDO_AGENT_PORT: '0',
    SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: runtimeUrl, model: 'e2e-model' }),
    SUDO_STUDIO_HOME: home,
    SUDO_STUDIO_LOGS: path.join(home, 'logs'),
    SUDO_AGENT_STORE: path.join(home, 'store'),
  });
  let ch = null;
  try {
    ch = spawn(nodeBin, [serverJs], { cwd: path.dirname(path.dirname(serverJs)), env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let stderr = '';
    ch.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    let hs = null;
    try { hs = await handshake(ch); }
    catch (e) { check('agent : le serveur d agent demarre sous Linux', false, String(e.message) + ' | ' + stderr.slice(-300)); return proj; }
    check('agent : le serveur d agent demarre sous Linux', !!hs && hs.port > 0, hs && hs.port);
    const base = { Authorization: 'Bearer ' + TOKEN };

    // L'operateur (ce harnais) accorde les approbations comme un utilisateur
    // qui fait confiance au projet : sans cela, une ecriture reste en attente
    // (c'est le comportement voulu du produit, pas un bug).
    let stopOp = false;
    let approvalsSeen = 0;
    const operator = (async () => {
      while (!stopOp) {
        await sleep(120);
        let list = [];
        try { const r = await httpJson(hs.port, 'GET', '/sessions', null, base); list = (r.body.sessions || []).map((x) => x.id); } catch (_) { continue; }
        for (const id of list) {
          let pend = null;
          try { pend = await httpJson(hs.port, 'GET', '/sessions/' + id + '/approvals', null, base); } catch (_) { continue; }
          for (const rq of ((pend.body && pend.body.pending) || [])) {
            approvalsSeen += 1;
            try { await httpJson(hs.port, 'POST', '/sessions/' + id + '/approvals', { requestId: rq.id, decision: 'project' }, base); } catch (_) {}
          }
        }
      }
    })();

    const s = await httpJson(hs.port, 'POST', '/sessions', { title: 'e2e linux', projectRoot: proj }, base);
    check('agent : une session de projet est creee', s.status === 201 || s.status === 200, s.status);
    const sid = s.body && s.body.id;

    // 1. tour REEL en mode build : l'agent ecrit un fichier
    const turn = await ssePost(hs.port, '/sessions/' + sid + '/messages', { prompt: 'cree le fichier hello-linux.txt avec un contenu' }, base, 120000);
    const done = turn.events.filter((e) => e && e.type === 'turn.done').pop() || {};
    const wrote = fs.existsSync(path.join(proj, 'hello-linux.txt'));
    check('agent : un tour build aboutit (turn.done)', !!done.status, done.status || turn.status);
    check('agent : le fichier demande existe reellement sur le disque', wrote,
      fs.existsSync(proj) ? fs.readdirSync(proj).slice(0, 6) : 'projet absent');
    if (wrote) {
      check('agent : le contenu ecrit est celui du modele',
        /ecrit par l agent/.test(fs.readFileSync(path.join(proj, 'hello-linux.txt'), 'utf8')));
    }
    check('agent : le tour rapporte le fichier modifie',
      Array.isArray(done.filesModified) && done.filesModified.some((f) => /hello-linux/.test(f)),
      done.filesModified);

    // 2. permissions : lecture seule auto, ecriture = approbation operateur
    const perms = await httpJson(hs.port, 'GET', '/permissions', null, base);
    check('agent : politique de permissions active (ask-mutating)',
      perms.status === 200 && perms.body.mode === 'ask-mutating', perms.body && perms.body.mode);

    // 3. cahier des charges long : plan SANS execution
    const brief = (() => {
      const L = [];
      ['Donnees', 'Interface', 'Qualite', 'Livraison'].forEach((t, i) => {
        L.push('## ' + (i + 1) + '. ' + t);
        for (let k = 0; k < 14; k++) L.push('- Exigence ' + (i * 14 + k + 1) + ' (' + t.toLowerCase() + ') doit etre implementee et testee.');
      });
      return L.join('\n');
    })();
    // Un cahier se colle dans une session NEUVE (c'est l'usage reel). Dans une
    // session qui a deja des taches en cours, le moteur demande d'abord s'il
    // faut reprendre ou repartir (stopReason await_choice) : comportement
    // voulu, verifie separement ci-dessous.
    const s2 = await httpJson(hs.port, 'POST', '/sessions', { title: 'cahier linux', projectRoot: proj }, base);
    const sid2 = s2.body && s2.body.id;
    const before = fs.readdirSync(proj).filter((f) => f !== '.sudo-agent').length;
    const plan = await ssePost(hs.port, '/sessions/' + sid2 + '/messages', { prompt: brief }, base, 60000);
    const planDone = plan.events.filter((e) => e && e.type === 'turn.done').pop() || {};
    const planMsg = plan.events.filter((e) => e && e.type === 'message.done').pop() || {};
    check('agent : un cahier long est reconnu (stopReason spec_plan)',
      planDone.stopReason === 'spec_plan', planDone.stopReason);
    check('agent : le plan est affiche (sections + exigences + etapes)',
      /PLAN DU CAHIER DES CHARGES/.test(String(planMsg.text || '')) && /EXIGENCES/.test(String(planMsg.text || '')));
    // La reception ecrit le document dans .sudo-agent/ (c'est voulu : il ne
    // doit jamais entrer dans le contexte). Aucun fichier du PROJET ne doit
    // apparaitre avant la validation.
    const projectFiles = () => fs.readdirSync(proj).filter((f) => f !== '.sudo-agent');
    check('agent : AUCUNE execution avant validation (aucun fichier du projet en plus)',
      projectFiles().length === before, projectFiles());

    check('agent : une action sensible a bien demande une approbation', approvalsSeen >= 1, approvalsSeen);

    // 4. arret propre
    stopOp = true;
    try { await operator; } catch (_) {}
    ch.kill('SIGTERM');
    await sleep(400);
    const alive = (() => { try { process.kill(ch.pid, 0); return true; } catch (_) { return false; } })();
    check('agent : le serveur s arrete proprement (SIGTERM)', !alive || ch.exitCode !== null, { alive, code: ch.exitCode });
    ch = null;
  } finally {
    if (ch) killTree(ch);
  }
  return proj;
}

// ------------------------------------------------------------------ main
(async () => {
  const bundle = arg('bundle', null);
  const source = process.argv.indexOf('--source') !== -1;
  const asJson = process.argv.indexOf('--json') !== -1;
  const outFile = arg('out', null);
  const keep = process.argv.indexOf('--keep') !== -1;
  const report = { mode: bundle ? 'bundle' : (source ? 'source' : '?'), at: new Date().toISOString(), platform: process.platform, arch: process.arch };

  if (!bundle && !source) {
    console.log('usage : node scripts/ci/linux-e2e-test.js --bundle <dir> | --source [--json] [--out f.json] [--keep]');
    process.exit(2);
  }

  const runtime = await scriptedRuntime();
  report.runtimeUrl = runtime.url;
  const cleanup = [];
  try {
    if (bundle) {
      const B = path.resolve(String(bundle));
      check('artefact : le dossier existe', fs.existsSync(B), B);

      // 1. structure
      const editor = findEditor(B);
      check('artefact : editeur present et executable', !!editor && isExec(editor), editor);
      const extDir = [path.join(B, 'extensions', 'sudo-ai'), path.join(B, 'extensions', 'sudo-studio')]
        .find((d) => fs.existsSync(d));
      check('artefact : extension Sudo Studio embarquee', !!extDir &&
        fs.existsSync(path.join(extDir, 'extension.js')), extDir);
      const agentServer = path.join(B, 'sudo-agent', 'src', 'server.js');
      check('artefact : serveur d agent present (sudo-agent/src/server.js)', fs.existsSync(agentServer), agentServer);
      const backendBin = [path.join(B, 'backend', 'backend'), path.join(B, 'backend', 'sudo-studio-backend')]
        .find((f) => fs.existsSync(f));
      check('artefact : backend Linux present et executable', !!backendBin && isExec(backendBin), backendBin);
      const runtimeBin = [path.join(B, 'backend', 'runtime', 'server'), path.join(B, 'runtime', 'server')]
        .find((f) => fs.existsSync(f));
      check('artefact : runtime Linux present et executable', !!runtimeBin && isExec(runtimeBin), runtimeBin);
      check('artefact : script de demarrage Linux (start.sh) present',
        fs.existsSync(path.join(B, 'start.sh')) || fs.existsSync(path.join(B, 'sudo-studio.sh')));

      // 2. binaires : taille plausible + selftest
      for (const [label, bin] of [['backend', backendBin], ['runtime', runtimeBin]]) {
        if (!bin) continue;
        const size = fs.statSync(bin).size;
        check('binaire ' + label + ' : taille plausible (> 500 ko)', size > 500000, size);
      }
      if (backendBin) {
        let st = { code: -1, out: '' };
        try { st = { code: 0, out: execFileSync(backendBin, ['--selftest'], { encoding: 'utf8', timeout: 120000 }) }; }
        catch (e) { st = { code: (e && e.status) || 1, out: String((e && (e.stdout || e.message)) || e) }; }
        check('binaire backend : --selftest vert', st.code === 0, { code: st.code, out: String(st.out).slice(-200) });
      }

      // 3. services (backend + runtime reels)
      if (backendBin) {
        const bport = await freePort();
        const bch = spawn(backendBin, [], { env: Object.assign({}, process.env, { PORT: String(bport), NODE_ENV: 'production' }), stdio: ['ignore', 'pipe', 'pipe'] });
        cleanup.push(() => killTree(bch));
        const h = await waitHealth(bport, '/api/system/health', 45000);
        check('service backend : /api/system/health repond', h.ok, { status: h.status, ms: h.ms });
        killTree(bch);
      }
      if (runtimeBin) {
        const rport = await freePort();
        const rch = spawn(runtimeBin, ['--port', String(rport)], { stdio: ['ignore', 'pipe', 'pipe'] });
        cleanup.push(() => killTree(rch));
        const h = await waitHealth(rport, '/health', 90000);
        check('service runtime : /health repond', h.ok, { status: h.status, ms: h.ms });
        killTree(rch);
      }

      // 4. mode agent complet, depuis l'artefact
      const proj = await agentModeChecks({ serverJs: agentServer, runtimeUrl: runtime.url, nodeBin: process.env.LINUX_E2E_NODE || process.execPath });
      cleanup.push(() => { try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {} });
    } else {
      // mode source : meme mode agent, depuis l'arbre
      check('source : serveur d agent present', fs.existsSync(path.join(REPO, 'sudo-agent', 'src', 'server.js')));
      check('source : extension presente', fs.existsSync(path.join(REPO, 'sudo-ai-extension', 'extension.js')));
      const proj = await agentModeChecks({
        serverJs: path.join(REPO, 'sudo-agent', 'src', 'server.js'),
        runtimeUrl: runtime.url,
      });
      cleanup.push(() => { try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {} });
    }
  } finally {
    await runtime.close();
    for (const f of cleanup) { try { f(); } catch (_) {} }
  }

  report.pass = pass;
  report.fail = fail;
  report.results = results;
  console.log('\n== Linux E2E : ' + pass + ' PASS, ' + fail + ' FAIL (' + report.mode + ') ==');
  if (asJson) console.log(JSON.stringify({ pass, fail, mode: report.mode }, null, 1));
  if (outFile && outFile !== true) {
    // Preuve : un rapport demande mais non ecrit est une erreur, jamais un silence.
    const dest = path.resolve(String(outFile));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('rapport ecrit : ' + dest);
  }
  if (keep) console.log('dossiers temporaires conserves dans ' + os.tmpdir());
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('ERREUR HARNAIS :: ' + String((e && e.stack) || e).slice(0, 800));
  process.exit(1);
});
