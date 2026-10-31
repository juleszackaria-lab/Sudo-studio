// MISSION P52 (part 2) - taches longues orchestrees : contexte frais par
// etape, persistance disque, reprise apres crash, budgets, verification
// par etape, indicateur n/N, rapport honnete. Preuves deterministes
// (fournisseur factice scripte, projets temporaires). Stdlib only,
// ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const HOST = '127.0.0.1';

process.env.SUDO_AGENT_CTX_TOKENS = '32768';

const { runTurn, abortRun, resolveTurnApproval } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));

let PASS = 0;
const FAILS = [];
function t(name, fn) {
  return { name, fn };
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert');
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

const call = (name, args, id) => ({ toolCalls: [{ id: id || ('c-' + name + '-' + Math.random().toString(36).slice(2, 7)), name, args: args || {} }] });
const text = (content) => ({ content });

function mockProvider(responses) {
  const chats = [];
  const queue = (responses || []).slice();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        chats.push(body);
        const next = queue.length ? queue.shift() : { content: 'default-done' };
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((tc, i) => ({ id: tc.id || ('call-' + chats.length + '-' + i),
            type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
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
    srv.listen(0, HOST, () => {
      resolve({ server: srv, port: srv.address().port, chats,
        close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function createWorld(proj) {
  const home = tmp('p52ohome');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const rules = new Map();
  rules.set(s.id, new Set());
  const w = { proj, home, logsDir, log, store, sessionId: s.id, rules,
    pending: new Map(), waiters: new Map(), seq: 0 };
  w.toolsCtx = () => ({ home, sessionRules: rules, pending: w.pending, waiters: w.waiters });
  w.allow = (...keys) => { for (const k of keys) rules.get(s.id).add(k); };
  w.turn = async (prompt, responses, opts) => {
    opts = opts || {};
    const mock = await mockProvider(responses);
    const events = [];
    const runs = new Map();
    const savedEnv = {};
    for (const k of Object.keys(opts.env || {})) {
      savedEnv[k] = process.env[k];
      process.env[k] = opts.env[k];
    }
    try {
      w.seq += 1;
      const p = runTurn({ store, sessionId: s.id, prompt, corr: opts.corr || ('p52o-' + w.seq),
        provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
        toolsCtx: w.toolsCtx(), runs, log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} } });
      if (opts.autoApprove || opts.abortOnPaused || opts.abortOnOrchStep) {
        let settled = false;
        let aborted = false;
        p.then(() => { settled = true; }, () => { settled = true; });
        const t0 = Date.now();
        while (!settled && Date.now() - t0 < 60000) {
          if (opts.autoApprove) {
            for (const id of Array.from(w.waiters.keys())) {
              try { resolveTurnApproval(w.toolsCtx(), id, opts.autoApprove); } catch (_) {}
            }
          }
          if (!aborted && opts.abortOnPaused && events.some((e) => e.type === 'turn.paused')) {
            aborted = true;
            try { abortRun(runs, s.id); } catch (_) {}
          }
          if (!aborted && opts.abortOnOrchStep && events.some((e) => e.type === 'orch.step' && e.n === opts.abortOnOrchStep)) {
            aborted = true;
            try { abortRun(runs, s.id); } catch (_) {}
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      const out = await p;
      const end = store.get(s.id);
      let journal = '';
      try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
      return { out, end, events, chats: mock.chats, journal,
        last: end.messages[end.messages.length - 1] };
    } finally {
      for (const k of Object.keys(opts.env || {})) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await mock.close();
    }
  };
  return w;
}

function fixtureProject() {
  const dir = tmp('p52oproj');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p52o' }), 'utf8');
  return dir;
}

// N create-steps prompt + scripted children (write + done each).
function stepsPrompt(n, prefix) {
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const f = prefix + String(i).padStart(2, '0') + '.txt';
    parts.push(i + '. Cree ' + f + ' avec ' + prefix.toUpperCase() + i);
  }
  return parts.join(' ; ');
}
function stepsResponses(n, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const f = prefix + String(i).padStart(2, '0') + '.txt';
    out.push(call('write', { file: f, content: prefix.toUpperCase() + i + '\n' }));
    out.push(call('done', { summary: 'etape ' + i + ' finie' }));
  }
  return out;
}
function stepsRules(n, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push('write|file|' + prefix + String(i).padStart(2, '0') + '.txt');
  return out;
}

const tests = [
t('O1 orchestre 6 etapes : TERMINE, fichiers, n/N, etat disque', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(6, 'o'));
  const r = await w.turn(stepsPrompt(6, 'o'), stepsResponses(6, 'o'), { corr: 'o1plan' });
  assert(r.out.runStatus === 'TERMINE', 'TERMINE, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('6 fait(s), 0 echoue(s), 0 non tente(s)') !== -1, 'totaux honnetes');
  for (let i = 1; i <= 6; i++) {
    const f = 'o' + String(i).padStart(2, '0') + '.txt';
    assert(fs.readFileSync(path.join(w.proj, f), 'utf8') === 'O' + i + '\n', f + ' exact');
  }
  const steps = r.events.filter((e) => e.type === 'orch.step');
  for (let i = 1; i <= 6; i++) {
    assert(steps.some((e) => e.n === i && e.N === 6 && e.status === 'start'), 'indicateur ' + i + '/6');
    assert(steps.some((e) => e.n === i && e.N === 6 && e.status === 'done'), 'etape ' + i + ' done');
  }
  assert(r.events.some((e) => e.type === 'orch.done'), 'orch.done');
  assert(r.chats.length === 12, '12 appels enfants, 0 parent (recu ' + r.chats.length + ')');
  const stFile = path.join(w.proj, '.sudo-agent', 'orch-o1plan.json');
  assert(fs.existsSync(stFile), 'etat disque');
  const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  assert(st.steps.length === 6 && st.steps.every((x) => x.status === 'done'), 'etat 6/6 done');
  assert(st.snap && st.snap.global, 'hashes persistants');
  assert(st.journal.length >= 6, 'journal persistant');
}),
t('O2 contexte frais : chaque enfant ignore les etapes futures', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(6, 'o'));
  const r = await w.turn(stepsPrompt(6, 'o'), stepsResponses(6, 'o'));
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  assert(r.chats.length === 12, '2 appels par enfant');
  for (let k = 0; k < 6; k++) {
    const mine = JSON.stringify([r.chats[2 * k], r.chats[2 * k + 1]]);
    for (let j = k + 1; j < 6; j++) {
      const future = 'o' + String(j + 1).padStart(2, '0') + '.txt';
      assert(mine.indexOf(future) === -1, 'etape ' + (k + 1) + ' ignore ' + future);
    }
  }
}),
t('O3 crash (abort) puis reprise : PARTIEL interrompu puis TERMINE 6/6', async () => {
  const w = createWorld(fixtureProject());
  // Pas de regles : l enfant 1 se met en pause, l abort simule le crash.
  const r1 = await w.turn(stepsPrompt(6, 'o'), stepsResponses(6, 'o'), { corr: 'o3plan', abortOnPaused: true });
  assert(r1.out.runStatus === 'PARTIEL', 'PARTIEL, recu ' + r1.out.runStatus);
  assert(r1.last.content.indexOf('interrompu') !== -1 || r1.last.content.indexOf('NON TENTE') !== -1, 'rapport interrompu');
  const st1 = JSON.parse(fs.readFileSync(path.join(w.proj, '.sudo-agent', 'orch-o3plan.json'), 'utf8'));
  assert(st1.steps[0].status === 'pending', 'etape 1 en attente (reprise possible)');
  assert(!fs.existsSync(path.join(w.proj, 'o01.txt')), 'rien de verifie');
  // Reprise : mots explicites + regles.
  w.allow(...stepsRules(6, 'o'));
  const r2 = await w.turn('reprendre le plan interrompu', stepsResponses(6, 'o'), { corr: 'o3resume' });
  assert(r2.out.runStatus === 'TERMINE', 'TERMINE apres reprise, recu ' + r2.out.runStatus);
  assert(r2.last.content.indexOf('6 fait(s), 0 echoue(s), 0 non tente(s)') !== -1, 'totaux 6/6');
  for (let i = 1; i <= 6; i++) {
    assert(fs.existsSync(path.join(w.proj, 'o' + String(i).padStart(2, '0') + '.txt')), 'fichier ' + i);
  }
  const st2 = JSON.parse(fs.readFileSync(path.join(w.proj, '.sudo-agent', 'orch-o3plan.json'), 'utf8'));
  assert(st2.runs >= 1 && st2.steps.every((x) => x.status === 'done'), 'etat repris puis 6/6');
  assert(r2.journal.indexOf('reprise plan orchestre') !== -1, 'journal reprise');
}),
t('O4 budget appels par etape : enfant borne, etape echouee, ECHEC honnete', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(6, 'o'));
  const resp = stepsResponses(6, 'o');
  resp[0] = call('read', { file: 'package.json' }); // enfant 1 : 2 lectures, jamais d ecriture
  resp[1] = call('read', { file: 'package.json' });
  const r = await w.turn(stepsPrompt(6, 'o'), resp, { env: { SUDO_AGENT_STEP_CALLS: '2' } });
  assert(r.out.runStatus === 'ECHEC', 'ECHEC, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('1/6 ECHOUE') !== -1, 'echec nomme');
  assert(r.last.content.indexOf('1 echoue(s)') !== -1, 'total echec');
  assert(!fs.existsSync(path.join(w.proj, 'o01.txt')), 'etape 1 non faite');
  assert(fs.existsSync(path.join(w.proj, 'o02.txt')), 'etape 2 faite (poursuite)');
  const kids = w.store.list().filter((x) => (x.title || '').indexOf('orch 1/6') === 0);
  assert(kids.length === 1, 'enfant 1 trace');
  const k1 = w.store.get(kids[0].id);
  assert(k1.meta.lastRun.calls.length <= 2, 'enfant borne a 2 appels');
}),
t('O5 echec de verification : done sans effet -> ECHOUE, rapport honnete', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(6, 'o'));
  const resp = stepsResponses(6, 'o');
  resp[4] = call('done', { summary: 'je pretends avoir fini' }); // enfant 3 : declare sans agir
  resp.splice(5, 1);
  const r = await w.turn(stepsPrompt(6, 'o'), resp);
  assert(r.out.runStatus === 'ECHEC', 'ECHEC, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('3/6 ECHOUE') !== -1, 'etape 3 ECHOUE nommee');
  assert(r.last.content.indexOf('o03') !== -1, 'cible citee');
  assert(!fs.existsSync(path.join(w.proj, 'o03.txt')), 'rien cree');
  assert(fs.existsSync(path.join(w.proj, 'o04.txt')), 'poursuite apres echec');
}),
t('O6 reprise sans plan : tour normal, pas d orchestre', async () => {
  const w = createWorld(fixtureProject());
  const r = await w.turn('reprendre le plan, s il y en a un', [text('Rien a reprendre, que puis-je faire ?')]);
  assert(!r.events.some((e) => e.type === 'orch.step'), 'pas d etapes orchestre');
  assert(r.journal.indexOf('reprise sans plan') !== -1, 'journal reprise sans plan');
}),
t('O7 30 etapes en contexte modeste (6000) : TERMINE 30/30 sans saturation', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(30, 'f'));
  const r = await w.turn(stepsPrompt(30, 'f'), stepsResponses(30, 'f'), { env: { SUDO_AGENT_CTX_TOKENS: '6000' } });
  assert(r.out.runStatus === 'TERMINE', 'TERMINE, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('30 fait(s), 0 echoue(s), 0 non tente(s)') !== -1, 'totaux 30/30');
  for (let i = 1; i <= 30; i++) {
    const f = 'f' + String(i).padStart(2, '0') + '.txt';
    assert(fs.readFileSync(path.join(w.proj, f), 'utf8') === 'F' + i + '\n', f + ' exact');
  }
  assert(r.chats.length === 60, '60 appels enfants, 0 parent (recu ' + r.chats.length + ')');
  assert(!r.events.some((e) => e.type === 'turn.done' && e.stopReason === 'context'), 'pas de saturation');
}),
t('O8 arret serveur simule a l etape 12 : reprise termine 30/30', async () => {
  const proj = fixtureProject();
  const w = createWorld(proj);
  w.allow(...stepsRules(30, 'f'));
  const r1 = await w.turn(stepsPrompt(30, 'f'), stepsResponses(30, 'f'), { corr: 'o8plan', abortOnOrchStep: 12 });
  assert(r1.out.runStatus === 'PARTIEL', 'PARTIEL, recu ' + r1.out.runStatus);
  // Abort timing races the (fast) step 12: the first non-done step K is 12
  // (abort landed mid-step) or 13 (step 12 just finished). Either way the
  // run stopped early and steps 1..11 are verified.
  assert(r1.events.some((e) => e.type === 'orch.step' && e.n >= 12), 'etape 12 atteinte');
  const st1 = JSON.parse(fs.readFileSync(path.join(proj, '.sudo-agent', 'orch-o8plan.json'), 'utf8'));
  const K = st1.steps.findIndex((x) => x.status !== 'done') + 1;
  assert(K >= 12 && K <= 15, 'point de chute K=' + K);
  for (let i = 1; i < K; i++) {
    const f = 'f' + String(i).padStart(2, '0') + '.txt';
    assert(fs.readFileSync(path.join(proj, f), 'utf8') === 'F' + i + '\n', 'fichier ' + f);
  }
  // Boundary file fK may exist (write landed before the abort); the resume
  // re-verifies it (idempotent). Beyond K: untouched.
  for (let i = K + 1; i <= 30; i++) {
    assert(!fs.existsSync(path.join(proj, 'f' + String(i).padStart(2, '0') + '.txt')), 'absent f' + i);
  }
  // Nouveau monde (meme projet : l etat disque survit), reprise explicite.
  const w2 = createWorld(proj);
  w2.allow(...stepsRules(30, 'f'));
  const resp2 = [];
  for (let i = K; i <= 30; i++) {
    const f = 'f' + String(i).padStart(2, '0') + '.txt';
    resp2.push(call('write', { file: f, content: 'F' + i + '\n' }));
    resp2.push(call('done', { summary: 'etape ' + i + ' finie' }));
  }
  const r2 = await w2.turn('reprendre le plan interrompu', resp2, { corr: 'o8resume' });
  assert(r2.out.runStatus === 'TERMINE', 'TERMINE apres reprise, recu ' + r2.out.runStatus);
  assert(r2.last.content.indexOf('30 fait(s), 0 echoue(s), 0 non tente(s)') !== -1, 'totaux 30/30');
  for (let i = 12; i <= 30; i++) {
    assert(fs.existsSync(path.join(proj, 'f' + String(i).padStart(2, '0') + '.txt')), 'etape ' + i + ' reprise');
  }
  const st = JSON.parse(fs.readFileSync(path.join(proj, '.sudo-agent', 'orch-o8plan.json'), 'utf8'));
  assert(st.steps.every((x) => x.status === 'done'), 'etat final 30/30');
}),
t('O9 budget global : arret honnete avec NON TENTE', async () => {
  const w = createWorld(fixtureProject());
  w.allow(...stepsRules(6, 'o'));
  const r = await w.turn(stepsPrompt(6, 'o'), stepsResponses(6, 'o'), { env: { SUDO_AGENT_ORCH_MS: '0' } });
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('NON TENTE') !== -1, 'non tentes annonces');
  assert(r.last.content.indexOf('non tente(s)') !== -1, 'total non tentes');
}),
];

async function main() {
  for (const tst of tests) {
    try {
      await tst.fn();
      PASS += 1;
      console.log('ok - ' + tst.name);
    } catch (e) {
      FAILS.push(tst.name);
      console.log('FAIL - ' + tst.name + ' :: ' + ((e && e.message) || e));
    }
  }
  console.log(PASS + '/' + tests.length + ' P52-orch tests passed' + (FAILS.length ? ' FAILS: ' + FAILS.join(' | ') : ''));
  process.exit(FAILS.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
