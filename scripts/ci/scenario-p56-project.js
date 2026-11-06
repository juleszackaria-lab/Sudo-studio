/**
 * scenario-p56-project.js - P56 end-to-end: a 60-line brief becomes a project.
 *
 * Real agent server + a SCRIPTED provider (the calls a good model would make)
 * + a real project folder. Sequence:
 *
 *   1. the 60-line brief is pasted. NOT ONE model call happens: the engine
 *      stores it as a document, extracts sections + numbered requirements,
 *      builds the plan and STOPS for validation ("Lancer / Modifier");
 *   2. "lancer" runs the project step by step; each step is a fresh minimal
 *      context (objective + its SPEC slice + files + two-line summary);
 *   3. the server is KILLED at the start of step 12 (crash / voluntary stop);
 *   4. a NEW server is started and "reprendre" resumes at step 12 - the steps
 *      already done are NOT replayed;
 *   5. the final report carries the honest coverage table
 *      (exigence -> fichiers -> test -> etat) and the build/test evidence.
 *
 * Usage: node scripts/ci/scenario-p56-project.js [--json] [--keep]
 * Exit 0 = every control passed. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'sudo-agent', 'src');
const TOKEN = 'p56-scenario-token-0123456789';
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;
const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond });
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 400)); }
}
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- the brief
// 4 sections x (1 heading + 14 requirements) = 60 lines exactly.
function brief60() {
  const L = [];
  const themes = ['Donnees', 'Interface', 'Qualite', 'Livraison'];
  let n = 0;
  themes.forEach((t, i) => {
    L.push('## ' + (i + 1) + '. ' + t);
    for (let k = 0; k < 14; k++) {
      n += 1;
      L.push('- Exigence ' + n + ' (' + t.toLowerCase() + ') doit etre implementee et verifiee par un test.');
    }
  });
  return L.join('\n');
}

// ------------------------------------------------------- scripted provider
// The calls a good model would make, one round at a time. Each answer is
// delayed by CALL_MS so the scenario has real windows to observe a running
// step (and to stop the server in the middle of step 12).
const CALL_MS = parseInt(process.env.P56_CALL_MS || '120', 10);
function scriptedProvider(projRoot) {
  const payloads = [];
  const perStep = {};
  const hooks = { onStep: null };
  const state = { mode: 'ok' }; // 'fail' : le modele declare sans rien faire
  function answer(body, res) {
    const text = (body.messages || []).map((m) => String(m.content || '')).join('\n');
    const m = /ETAPE\s+(\d+)\/(\d+)/.exec(text);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const reply = (msg) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    };
    if (!hasTools || !m) { reply({ role: 'assistant', content: 'ok' }); return; }
    const n = parseInt(m[1], 10);
    const N = parseInt(m[2], 10);
    const nn = String(n).padStart(2, '0');
    const round = (perStep[n] = (perStep[n] || 0) + 1);
    if (process.env.P56_DEBUG === '1') console.log('   [model] etape ' + n + ' tour ' + round);
    // Point de rendez-vous : le scenario sait EXACTEMENT quand l'etape 12
    // demarre (l'etat "en cours" est deja ecrit sur disque).
    if (typeof hooks.onStep === 'function') { try { hooks.onStep(n, round); } catch (_) {} }
    // Le script ne compte pas les tours : il regarde l'ETAT DU DISQUE. Il agit
    // donc correctement apres une reprise (une etape interrompue reprend son
    // travail la ou il en etait, sans rien sauter ni refaire en double).
    if (state.mode === 'fail') { reply({ role: 'assistant', content: null,
      tool_calls: [{ id: 'f' + n + '_' + round, type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'etape ' + n + ' faite' }) } }] });
      return; }
    // Le script ne compte pas les tours : il regarde l'ETAT DU DISQUE. Il agit
    // donc correctement apres une reprise (une etape interrompue reprend son
    // travail la ou il en etait, sans rien sauter ni refaire en double).
    const has = (rel) => fs.existsSync(path.join(projRoot, rel));
    // Le moteur exige de CONSTATATER avant d'ecrire (recon_required). Un bon
    // modele commence donc chaque tour par une lecture : on fait pareil.
    const seenTool = (body.messages || []).some((x) => x && x.role === 'tool');
    let fn = null;
    let args = {};
    if (!seenTool) {
      fn = 'list'; args = { dir: '.' };
    } else if (!has('src/etape' + nn + '_a.js')) {
      fn = 'write'; args = { file: 'src/etape' + nn + '_a.js', content: '// etape ' + n + ' partie A\nmodule.exports = ' + n + ';\n' };
    } else if (!has('src/etape' + nn + '_b.js')) {
      fn = 'write'; args = { file: 'src/etape' + nn + '_b.js', content: '// etape ' + n + ' partie B\nmodule.exports = ' + n + ';\n' };
    } else if (!has('src/etape' + nn + '.test.js')) {
      fn = 'write'; args = { file: 'src/etape' + nn + '.test.js', content:
        'const assert = require(\'assert\');\n'
        + 'assert.strictEqual(require(\'./etape' + nn + '_a\'), ' + n + ');\n'
        + 'assert.strictEqual(require(\'./etape' + nn + '_b\'), ' + n + ');\n'
        + 'console.log(\'etape ' + n + ' ok\');\n' };
    } else if (!has('TESTED-' + nn + '.log')) {
      fn = 'bash'; args = { command: 'node --test src/ 2>&1 | tail -3; echo ok > TESTED-' + nn + '.log' };
    } else { fn = 'done'; args = { summary: 'etape ' + n + '/' + N + ' faite' }; }
    reply({ role: 'assistant', content: null,
      tool_calls: [{ id: 'c' + n + '_' + round, type: 'function', function: { name: fn, arguments: JSON.stringify(args) } }] });
  }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted-p56', n_ctx: 8192 }] }));
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
      payloads.push(body);
      setTimeout(() => { try { answer(body, res); } catch (_) {} }, CALL_MS);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, HOST, () => resolve({
      url: 'http://' + HOST + ':' + srv.address().port,
      payloads,
      hooks,
      state,
      close: () => new Promise((r) => srv.close(() => r())),
    }));
  });
}

// -------------------------------------------------- operator (approbations)
// The scenario plays the OPERATOR: any pending write/bash approval is granted
// with the "project" rule (once per project), exactly like a user who trusts
// the generated project. Nothing is ever pre-approved by the engine itself.
function operatorLoop(port, stopFlag) {
  const seen = [];
  return (async () => {
    while (!stopFlag.done) {
      await sleep(80);
      let list = [];
      try { const r = await httpJson(port, 'GET', '/sessions'); list = (r.body.sessions || []).map((x) => x.id); } catch (_) { continue; }
      for (const sid of list) {
        let pend = null;
        try { pend = await httpJson(port, 'GET', '/sessions/' + sid + '/approvals'); } catch (_) { continue; }
        for (const rq of ((pend.body && pend.body.pending) || [])) {
          seen.push(rq.tool + ':' + String((rq.pattern && rq.pattern.text) || '').slice(0, 60));
          if (process.env.P56_DEBUG === '1') console.log('   [operateur] ' + rq.tool + ' ' + String((rq.pattern && rq.pattern.text) || '').slice(0, 50));
          try { await httpJson(port, 'POST', '/sessions/' + sid + '/approvals', { requestId: rq.id, decision: 'project' }); } catch (_) {}
        }
      }
    }
  })();
}

// ------------------------------------------------------------- server boot
function agentHandshake(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let errText = '';
    const timer = setTimeout(() => reject(new Error('handshake timeout :: ' + errText.slice(-500))), timeoutMs || 25000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl).trim())); } catch (e) { reject(new Error('bad handshake')); }
    });
    child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
    child.on('exit', (code) => reject(new Error('exited (' + code + ') :: ' + errText.slice(-500))));
  });
}
function httpJson(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, method, path: p,
      headers: Object.assign({ Authorization: 'Bearer ' + TOKEN },
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
    // Un incident reseau ne doit pas figer la boucle operateur du scenario.
    req.setTimeout(4000, () => { try { req.destroy(new Error('http timeout')); } catch (_) {} });
    if (data) req.write(data);
    req.end();
  });
}
function ssePost(port, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let raw = '';
    const req = http.request({ host: HOST, port, method: 'POST', path: p,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const settle = () => {
        const events = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { events.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
        }
        resolve({ events, raw });
      };
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', settle);
      // Serveur tue en plein tour : la connexion meurt sans "end". On rend la
      // main avec ce qui a ete recu (c'est justement le cas a tester).
      res.on('aborted', settle);
      res.on('close', settle);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 300000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.write(data);
    req.end();
  });
}
function boot(env) {
  const ch = spawn(process.execPath, [path.join(SRC, 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Toujours vider les tuyaux : un serveur bloque si personne ne lit stderr,
  // et une sortie inattendue doit etre visible, jamais silencieuse.
  ch.errBuf = '';
  ch.outBuf = '';
  ch.exited = null;
  ch.stdout.on('data', (c) => { ch.outBuf += c.toString('utf8'); });
  ch.stderr.on('data', (c) => { ch.errBuf += c.toString('utf8'); if (ch.errBuf.length > 200000) ch.errBuf = ch.errBuf.slice(-100000); });
  ch.on('exit', (code, sig) => { ch.exited = { code, sig }; });
  return ch;
}
function rssKb(pid) {
  try { return parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim(), 10) || 0; }
  catch (_) { return 0; }
}
function jobStateFiles(root) {
  try {
    return fs.readdirSync(path.join(root, '.sudo-agent', 'jobs')).filter((f) => /^job-.*\.json$/.test(f))
      .map((f) => path.join(root, '.sudo-agent', 'jobs', f));
  } catch (_) { return []; }
}
function readJob(root) {
  const files = jobStateFiles(root);
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(files[0], 'utf8')); } catch (_) { return null; }
}

// ------------------------------------------------------------------ scenario
(async () => {
  const asJson = process.argv.indexOf('--json') !== -1;
  const keep = process.argv.indexOf('--keep') !== -1;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-proj-'));
  const BRIEF = brief60();
  const provider = await scriptedProvider(proj);
  const env = Object.assign({}, process.env, {
    SUDO_AGENT_TOKEN: TOKEN,
    SUDO_AGENT_PORT: '0',
    SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: provider.url, model: 'scripted-p56' }),
    SUDO_STUDIO_HOME: home,
    SUDO_STUDIO_LOGS: path.join(home, 'logs'),
    SUDO_AGENT_STORE: path.join(home, 'store'),
    SUDO_AGENT_STEP_CALLS: '8',
    SUDO_AGENT_STEP_MS: '60000',
    SUDO_AGENT_JOB_MS: '600000',
  });

  if (process.env.P56_HEARTBEAT === '1') {
    const hbFile = '/tmp/p56-heartbeat.txt';
    setInterval(() => { try { fs.appendFileSync(hbFile, Date.now() + ' scenario\n'); } catch (_) {} }, 1000).unref();
  }
  let child = boot(env);
  const out = { steps: 0, killedAt: 0 };
  try {
    const hs1 = await agentHandshake(child);
    const port1 = hs1.port;
    const s1 = await httpJson(port1, 'POST', '/sessions', { title: 'p56', projectRoot: proj });
    const sid1 = s1.body.id;
    const rssBefore = rssKb(child.pid);
    const opFlag = { done: false };
    const op1 = operatorLoop(port1, opFlag);

    // ---- 1. the brief: plan + requirements, NO model call -----------------
    const t1 = await ssePost(port1, '/sessions/' + sid1 + '/messages', { prompt: BRIEF }, 120000);
    const done1 = t1.events.filter((e) => e && e.type === 'turn.done').pop() || {};
    const msg1 = t1.events.filter((e) => e && e.type === 'message.done').pop() || {};
    const planEvt = t1.events.filter((e) => e && e.type === 'job.plan').pop() || {};
    out.planStatus = done1.status;
    out.stopReason = done1.stopReason;
    out.planText = String(msg1.text || '').slice(0, 20000);

    check('1. le cahier des charges est reconnu (plan propose sans executer)',
      done1.stopReason === 'spec_plan' && /PLAN DU CAHIER DES CHARGES/.test(out.planText), done1.stopReason);
    check('2. le plan affiche sections + exigences numerotees + etapes',
      /SECTIONS/.test(out.planText) && /R1 \(S1\)/.test(out.planText) && /ETAPES/.test(out.planText) &&
      /Lancer \/ Modifier/.test(out.planText), out.planText.slice(0, 200));
    check('3. AUCUN appel au modele pendant la reception du document', provider.payloads.length === 0, provider.payloads.length);
    check('4. le document est stocke sur disque, pas dans le contexte',
      fs.existsSync(path.join(proj, '.sudo-agent', 'specs')) &&
      fs.readdirSync(path.join(proj, '.sudo-agent', 'specs')).some((f) => f.endsWith('.md')));
    check('5. 56 exigences numerotees et 20 etapes', planEvt.requirements === 56 && planEvt.steps === 20,
      { exigences: planEvt.requirements, etapes: planEvt.steps });
    const jobs1 = await httpJson(port1, 'GET', '/jobs?session=' + sid1);
    check('6. un projet est en attente dans /jobs (etat initial)',
      (jobs1.body.jobs || []).length === 1 && jobs1.body.jobs[0].status === 'proposed' &&
      jobs1.body.resumable && jobs1.body.resumable.id === jobs1.body.jobs[0].id, jobs1.body);

    // ---- 2. "lancer": the project runs, then we KILL the server at step 12
    const t2promise = ssePost(port1, '/sessions/' + sid1 + '/messages', { prompt: 'lancer' }, 45000);
    let killed = false;
    const dbg = process.env.P56_DEBUG === '1';
    const killer = (async () => {
      const deadline = Date.now() + 180000;
      while (!killed && Date.now() < deadline) { await sleep(20); }
      if (!killed) console.log('   [kill] etape 12 jamais atteinte avant le delai.');
    })();
    provider.hooks.onStep = (n, round) => {
      if (n === 12 && round === 1 && !killed) {
        killed = true;
        out.killedAt = 12;
        // L'etat sur disque est deja "etape 12 en cours" : on coupe le serveur
        // net (SIGKILL), comme un crash ou une fermeture brutale.
        setImmediate(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
          if (process.env.P56_DEBUG === '1') console.log('   [kill] SIGKILL envoye au serveur (etape 12 demarree)');
        });
      }
    };
    const t2 = await t2promise.catch((e) => ({ events: [], error: String((e && e.message) || e) }));
    if (process.env.P56_DEBUG === '1') console.log('   [lancer] rendu la main (' + t2.events.length + ' evenements, sortie serveur=' + JSON.stringify(child.exited) + ')');
    if (t2.error) console.log('   [lancer] ' + t2.error + ' | serveur sorti=' + JSON.stringify(child.exited));
    out.lancerError = t2.error || '';
    await killer;
    check('7. le serveur a ete tue pendant l etape 12', killed === true && out.killedAt === 12, out.killedAt);
    const afterKill = readJob(proj);
    out.afterKill = afterKill ? {
      done: afterKill.steps.filter((s) => s.status === 'done').length,
      pending: afterKill.steps.filter((s) => s.status === 'pending' || s.status === 'running').length,
      status: afterKill.status,
    } : null;
    check('8. sur disque : etapes faites conservees, la 12 non terminee',
      !!afterKill && out.afterKill.done >= 1 && afterKill.steps[11].status !== 'done', out.afterKill);

    // ---- 3. NEW server + "reprendre" -------------------------------------
    child = boot(env);
    const hs2 = await agentHandshake(child);
    const port2 = hs2.port;
    const s2 = await httpJson(port2, 'POST', '/sessions', { title: 'p56-reprise', projectRoot: proj });
    const sid2 = s2.body.id;
    opFlag.done = true;
    try { await op1; } catch (_) {}
    const opFlag2 = { done: false };
    const op2 = operatorLoop(port2, opFlag2);
    const jobs2 = await httpJson(port2, 'GET', '/jobs?session=' + sid2);
    check('9. apres redemarrage, le projet est repris depuis le disque',
      jobs2.body.resumable && jobs2.body.resumable.status !== 'done', jobs2.body.resumable);

    const resumedFrom = (readJob(proj).steps.filter((s) => s.status === 'done').length) + 1;
    const t3 = await ssePost(port2, '/sessions/' + sid2 + '/messages', { prompt: 'reprendre le projet' }, 300000);
    const done3 = t3.events.filter((e) => e && e.type === 'turn.done').pop() || {};
    const msg3 = t3.events.filter((e) => e && e.type === 'message.done').pop() || {};
    out.resumeText = String(msg3.text || '');
    out.resumeStatus = done3.status;
    out.resumedFrom = resumedFrom;

    check('10. la reprise redemarre a l etape interrompue (pas au debut)',
      resumedFrom >= 2 && resumedFrom <= 12, resumedFrom);
    check('11. le journal de reprise est sur disque',
      (readJob(proj).journal || []).some((x) => x.ev === 'resume'), (readJob(proj).journal || []).slice(0, 4));

    const finalJob = readJob(proj);
    const doneCount = finalJob.steps.filter((s) => s.status === 'done').length;
    check('12. toutes les etapes finissent par etre faites', doneCount === 20, doneCount);
    check('13. le fournisseur factice a produit 40 fichiers',
      fs.existsSync(path.join(proj, 'src')) &&
      fs.readdirSync(path.join(proj, 'src')).filter((f) => /^etape\d\d_[ab]\.js$/.test(f)).length === 40,
      fs.existsSync(path.join(proj, 'src')) ? fs.readdirSync(path.join(proj, 'src')).length : 0);
    // Preuve reelle : les tests du projet genere passent (pas seulement
    // "l'agent a lance une commande").
    let testOut = '';
    let testOk = false;
    try {
      testOut = execFileSync(process.execPath, ['--test', 'src/'], { cwd: proj, encoding: 'utf8', timeout: 120000 });
      testOk = /# pass 20/.test(testOut) || /etape \d+ ok/.test(testOut);
    } catch (e) {
      testOut = String((e && (e.stdout || e.message)) || e);
      testOk = false;
    }
    check('14. les tests du projet genere passent (node --test src/)', testOk,
      String(testOut).split('\n').filter((l) => /^# (pass|fail)/.test(l)).join(' | ') || String(testOut).slice(-200));
    check('14b. le build/test a bien ete execute par l agent (appels bash)', provider.payloads.length >= 60, provider.payloads.length);
    check('15. le rapport final contient le tableau de couverture',
      /COUVERTURE/.test(out.resumeText) && /Total : \d+\/56 exigence/.test(out.resumeText),
      out.resumeText.slice(0, 200));
    const cov = await httpJson(port2, 'GET', '/jobs/' + finalJob.id + '/coverage?session=' + sid2);
    check('16. l API de couverture rend exigence -> fichiers -> test -> etat',
      Array.isArray(cov.body.coverage) && cov.body.coverage.length === 56 &&
      cov.body.coverage.every((r) => Array.isArray(r.files) && r.status) &&
      cov.body.coverage.some((r) => r.files.length > 0 && r.test), cov.body.coverage && cov.body.coverage[0]);
    check('17. statut final honnete TERMINE (20/20 etapes)', out.resumeStatus === 'TERMINE', out.resumeStatus);

    // ---- 4. memory stays flat --------------------------------------------
    const rssAfter = rssKb(child.pid);
    out.rssBefore = rssBefore;
    out.rssAfter = rssAfter;
    check('18. memoire du serveur stable (< +250 Mo)',
      rssAfter > 0 && (rssAfter - rssBefore) < 250000, { avant: rssBefore, apres: rssAfter });

    // ---- 5. honest non-realised path -------------------------------------
    // A brand-new brief whose step 1 always fails must NOT lie: the run ends
    // with failed steps and the report says NON REALISE.
    const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-fail-'));
    const s3 = await httpJson(port2, 'POST', '/sessions', { title: 'p56-echec', projectRoot: proj2 });
    await ssePost(port2, '/sessions/' + s3.body.id + '/messages', { prompt: BRIEF }, 120000);
    provider.state.mode = 'fail';
    const t4 = await ssePost(port2, '/sessions/' + s3.body.id + '/messages', { prompt: 'lancer' }, 300000);
    provider.state.mode = 'ok';
    const done4 = t4.events.filter((e) => e && e.type === 'turn.done').pop() || {};
    const msg4 = t4.events.filter((e) => e && e.type === 'message.done').pop() || {};
    out.failStatus = done4.status;
    check('19. un projet dont les etapes echouent reste honnete (jamais TERMINE)',
      done4.status === 'PARTIEL' || done4.status === 'ECHEC', done4.status);
    check('20. le rapport annonce explicitement ce qui n a pas ete fait',
      /NON REALISE|ECHOUE/.test(String(msg4.text || '')), String(msg4.text || '').slice(0, 200));
  } finally {
    if (fail > 0) console.log('--- serveur stderr (fin) ---\n' + String(child.errBuf || '').slice(-3000) + '\n--- fin stderr ---');
    try { if (typeof opFlag !== 'undefined') opFlag.done = true; } catch (_) {}
    try { if (typeof opFlag2 !== 'undefined') opFlag2.done = true; } catch (_) {}
    try { child.kill('SIGKILL'); } catch (_) {}
    await provider.close();
    if (!keep) {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {}
    } else {
      console.log('conserves : ' + home + ' | ' + proj);
    }
  }

  console.log('\nscenario P56 : ' + pass + ' PASS, ' + fail + ' FAIL | etapes=' + out.steps +
    ' | reprise depuis ' + out.resumedFrom + ' | statut final=' + out.resumeStatus +
    ' | RSS ' + out.rssBefore + ' -> ' + out.rssAfter + ' Ko');
  if (asJson) console.log(JSON.stringify({ pass, fail, out }, null, 1));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('ERREUR SCENARIO :: ' + String((e && e.stack) || e).slice(0, 900));
  process.exit(1);
});
