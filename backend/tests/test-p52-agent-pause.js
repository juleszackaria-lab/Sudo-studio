// MISSION P52 (part 1) - pause d'approbation, plan moteur, choix, outils
// adaptes, garde anti-boucle v2, resumes : preuves deterministes
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

const { runTurn, resolveTurnApproval } = require(path.join(AGENT_SRC, 'loop.js'));
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
        if (body && body.stream === true) {
          const txt = String(next.content === undefined ? '' : next.content);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
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

// A persistent world (same store/session across turns) for choice tests.
function createWorld(proj) {
  const home = tmp('p52home');
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
    const savedEnv = {};
    for (const k of Object.keys(opts.env || {})) {
      savedEnv[k] = process.env[k];
      process.env[k] = opts.env[k];
    }
    try {
      w.seq += 1;
      const p = runTurn({ store, sessionId: s.id, prompt, corr: opts.corr || ('p52-' + w.seq),
        provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
        toolsCtx: w.toolsCtx(), runs: new Map(), log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} } });
      if (opts.autoApprove) {
        let settled = false;
        p.then(() => { settled = true; }, () => { settled = true; });
        const t0 = Date.now();
        while (!settled && Date.now() - t0 < 20000) {
          for (const id of Array.from(w.waiters.keys())) {
            try { resolveTurnApproval(w.toolsCtx(), id, opts.autoApprove); } catch (_) {}
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
  w.todos = () => {
    const cur = store.get(s.id);
    return (cur && cur.meta && cur.meta.todos) || [];
  };
  return w;
}

function fixtureProject() {
  const dir = tmp('p52proj');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p52' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'k.txt'), 'k\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'e.txt'), 'AAA\n', 'utf8');
  return dir;
}

const tests = [
t('P1 pause puis approbation : le tour reprend et TERMINE', async () => {
  const w = createWorld(fixtureProject());
  const r = await w.turn('Cree le fichier p.txt avec P', [
    call('write', { file: 'p.txt', content: 'P\n' }),
    call('done', { summary: 'fini' }),
  ], { autoApprove: 'once' });
  assert(r.out.runStatus === 'TERMINE', 'TERMINE, recu ' + r.out.runStatus);
  assert(r.events.some((e) => e.type === 'turn.paused'), 'evenement turn.paused');
  const paused = r.events.filter((e) => e.type === 'turn.paused')[0];
  assert(paused.tool === 'write' && paused.requestId, 'pause porteuse (outil + requete)');
  assert(w.waiters.size === 0, 'waiter consomme');
  assert(w.pending.size === 0, 'pending consomme');
  assert(fs.readFileSync(path.join(w.proj, 'p.txt'), 'utf8') === 'P\n', 'fichier ecrit par le tour repris');
  assert(r.journal.indexOf('tour en pause') !== -1 && r.journal.indexOf('pause resolue') !== -1, 'journal pause/resolue');
}),
t('P2 refus operateur : PARTIEL honnete AUCUNE MODIFICATION (pas d ECHEC)', async () => {
  const w = createWorld(fixtureProject());
  const r = await w.turn('Cree le fichier r.txt avec R', [
    call('write', { file: 'r.txt', content: 'R\n' }),
    call('reply', { text: 'Refuse, je propose autre chose.' }),
    call('reply', { text: 'Toujours refuse, j explique.' }),
    call('reply', { text: 'J abandonne proprement.' }),
  ], { autoApprove: 'deny' });
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL honnete, recu ' + r.out.runStatus);
  assert(r.last.content.indexOf('AUCUNE MODIFICATION') !== -1, 'mention honnete');
  assert(r.last.content.indexOf("action refusee par l'operateur (write)") !== -1, 'cause refus citee');
  assert(!fs.existsSync(path.join(w.proj, 'r.txt')), 'rien ecrit');
  const tools = r.end.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert(tools.indexOf('refuse par l\'operateur') !== -1, 'modele informe du refus');
}),
t('P3 sans waiter (sous-tour) : ECHEC need_approval historique', async () => {
  const w = createWorld(fixtureProject());
  w.waiters = null; // pas de registre : comportement historique
  const r = await w.turn('Cree le fichier s.txt avec S', [
    call('write', { file: 's.txt', content: 'S\n' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'ECHEC', 'ECHEC historique, recu ' + r.out.runStatus);
  assert(!r.events.some((e) => e.type === 'turn.paused'), 'pas de pause sans waiter');
  assert(w.pending.size === 1, 'demande en attente conservee');
}),
t('P4 plan moteur : incident A, 4/4 verifiees, TERMINE', async () => {
  const w = createWorld(fixtureProject());
  w.allow('write|file|TEST_AGENT.md', 'append|file|TEST_AGENT.md', 'write|file|tmp-agent/a.txt', 'delete|file|tmp-agent/a.txt');
  const r = await w.turn('1. Cree TEST_AGENT.md avec Test agent OK ; 2. Ajoute a la fin une ligne ; 3. cree tmp-agent/a.txt ; 4. supprime-le', [
    call('write', { file: 'TEST_AGENT.md', content: 'Test agent OK\n' }),
    call('append', { file: 'TEST_AGENT.md', content: 'ligne2' }),
    call('write', { file: 'tmp-agent/a.txt', content: 'a\n' }),
    call('delete', { file: 'tmp-agent/a.txt' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE, recu ' + r.out.runStatus);
  const todos = w.todos();
  assert(todos.length === 4 && todos.every((x) => x.status === 'done'), '4/4 done, recu ' + JSON.stringify(todos.map((x) => x.status)));
  assert(todos.every((x) => x.engine === true), 'todos moteur');
  assert(r.last.content.indexOf('Plan moteur : 4/4 verifiees.') !== -1, 'annexe honnete');
  assert(r.last.content.indexOf('Modifications verifiees') !== -1, 'annexe fichiers');
  assert(fs.readFileSync(path.join(w.proj, 'TEST_AGENT.md'), 'utf8') === 'Test agent OK\nligne2', 'contenu exact');
  assert(!fs.existsSync(path.join(w.proj, 'tmp-agent/a.txt')), 'a.txt supprime');
  assert((r.journal.match(/etape verifiee/g) || []).length === 4, '4 verifications journalisees');
}),
t('P5 choix : tache inachevee -> PARTIEL await_choice (0 appel modele), REPRENDRE execute', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt', 'write|file|n.txt');
  const r1 = await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'vite fait' }),
  ]);
  assert(r1.out.runStatus === 'TERMINE', 'tour 1 TERMINE');
  assert(w.todos().filter((x) => x.status === 'done').length === 1, '1/2 verifiee');
  const r2 = await w.turn('Cree le fichier n.txt avec N', []);
  assert(r2.out.runStatus === 'PARTIEL', 'tour 2 PARTIEL');
  assert(r2.chats.length === 0, 'aucun appel modele pour le choix');
  assert(r2.events.some((e) => e.type === 'turn.done' && e.stopReason === 'await_choice'), 'stopReason await_choice');
  assert(r2.last.content.indexOf('REPRENDRE') !== -1 && r2.last.content.indexOf('ABANDONNER') !== -1, 'choix propose');
  const r3 = await w.turn('REPRENDRE', [
    call('write', { file: 'n.txt', content: 'N\n' }),
    call('done', { summary: 'ok' }),
  ]);
  assert(r3.out.runStatus === 'TERMINE', 'tour 3 TERMINE');
  assert(fs.readFileSync(path.join(w.proj, 'n.txt'), 'utf8') === 'N\n', 'demande stockee executee');
  assert(w.todos().every((x) => x.status === 'done'), 'plus rien d ouvert');
}),
t('P6 ABANDONNER (seul) : anciennes abandonnees + demande stockee executee', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt', 'write|file|n.txt');
  await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'vite fait' }),
  ]);
  await w.turn('Cree le fichier n.txt avec N', []);
  const staleId = w.todos().filter((x) => x.status !== 'done')[0].id;
  const r3 = await w.turn('abandonner', [
    call('write', { file: 'n.txt', content: 'N\n' }),
    call('done', { summary: 'ok' }),
  ]);
  assert(r3.out.runStatus === 'TERMINE', 'TERMINE');
  assert(fs.existsSync(path.join(w.proj, 'n.txt')), 'stockee executee');
  const stale = w.todos().filter((x) => x.id === staleId)[0];
  assert(stale && stale.status === 'abandoned', 'ancienne abandonnee');
}),
t('P7 nouvelle ACTION pendant le choix : abandon implicite + nouvelle demande (stockee remplacee)', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt', 'write|file|n.txt', 'write|file|z.txt');
  await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'vite fait' }),
  ]);
  await w.turn('Cree le fichier n.txt avec N', []);
  const r3 = await w.turn('Cree le fichier z.txt avec Z', [
    call('write', { file: 'z.txt', content: 'Z\n' }),
    call('done', { summary: 'ok' }),
  ]);
  assert(r3.out.runStatus === 'TERMINE', 'TERMINE');
  assert(fs.existsSync(path.join(w.proj, 'z.txt')), 'nouvelle executee');
  assert(!fs.existsSync(path.join(w.proj, 'n.txt')), 'stockee remplacee, non executee');
  assert(w.todos().filter((x) => x.status === 'abandoned').length >= 1, 'ancienne abandonnee implicitement');
}),
t('P8 QUESTION jamais bloquee : repond librement, choix reporte a la prochaine ACTION', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt');
  await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'vite fait' }),
  ]);
  const r2 = await w.turn('Que contient le fichier k.txt ?', [text('Il contient k et K2.')]);
  assert(r2.out.runStatus === 'TERMINE', 'question repondue');
  assert(r2.last.content.indexOf('K2') !== -1, 'texte de la reponse');
  assert(w.todos().some((x) => x.status !== 'done' && x.status !== 'abandoned'), 'anciennes preservees (pas de destruction surprise)');
  // La prochaine ACTION propose le choix (report, pas blocage).
  const r3 = await w.turn('Cree le fichier n.txt avec N', []);
  assert(r3.out.runStatus === 'PARTIEL', 'choix reporte');
  assert(r3.events.some((e) => e.type === 'turn.done' && e.stopReason === 'await_choice'), 'await_choice');
}),
t('P9 abandon automatique apres delai : pas de choix, execution directe', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt', 'write|file|n.txt');
  await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'vite fait' }),
  ]);
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  w.store.update(w.sessionId, (x) => {
    for (const td of x.meta.todos) { if (td.status !== 'done') td.at = old; }
  });
  const r2 = await w.turn('Cree le fichier n.txt avec N', [
    call('write', { file: 'n.txt', content: 'N\n' }),
    call('done', { summary: 'ok' }),
  ]);
  assert(r2.out.runStatus === 'TERMINE', 'execution directe');
  assert(!r2.events.some((e) => e.type === 'turn.done' && e.stopReason === 'await_choice'), 'pas de choix');
  assert(r2.journal.indexOf('todos auto-abandonnes') !== -1, 'journal auto-abandon');
  assert(fs.existsSync(path.join(w.proj, 'n.txt')), 'fichier cree');
}),
t('P10 todo modele refuse : guidance moteur, fin acceptee', async () => {
  const w = createWorld(fixtureProject());
  w.allow('write|file|q.txt');
  const r = await w.turn('Cree le fichier q.txt avec Q', [
    call('todo', { op: 'add', text: 'faire q' }),
    call('write', { file: 'q.txt', content: 'Q\n' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE (guidance non bloquante)');
  const tools = r.end.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert(tools.indexOf('geres par le moteur') !== -1, 'guidance moteur');
  assert(fs.existsSync(path.join(w.proj, 'q.txt')), 'travail fait');
}),
t('P11 write create-only : existant refuse, edit reprend', async () => {
  const w = createWorld(fixtureProject());
  w.allow('write|file|e.txt', 'edit|file|e.txt');
  const r = await w.turn('Modifie e.txt pour mettre BBB', [
    call('write', { file: 'e.txt', content: 'BBB\n' }),
    call('edit', { file: 'e.txt', old: 'AAA\n', new: 'BBB\n' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  const first = r.end.messages.filter((m) => m.role === 'tool')[0].content;
  assert(first.indexOf('"code":"exists"') !== -1, 'code exists');
  assert(first.indexOf('Utilise edit') !== -1, 'piste edit/append');
  assert(fs.readFileSync(path.join(w.proj, 'e.txt'), 'utf8') === 'BBB\n', 'edite, pas ecrase aveuglement');
}),
t('P12 mkdir + append : outils simples', async () => {
  const w = createWorld(fixtureProject());
  w.allow('mkdir|file|dd', 'append|file|dd/g.txt');
  const r = await w.turn('Cree le dossier dd puis ajoute G a la fin de dd/g.txt', [
    call('mkdir', { dir: 'dd' }),
    call('append', { file: 'dd/g.txt', content: 'G' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  assert(fs.readFileSync(path.join(w.proj, 'dd/g.txt'), 'utf8') === 'G', 'fichier ajoute');
}),
t('P13a garde v2 : 3 identiques -> corrective, adaptation -> TERMINE', async () => {
  const w = createWorld(fixtureProject());
  w.allow('edit|file|e.txt');
  const r = await w.turn('Modifie e.txt pour mettre BBB', [
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('read', { file: 'e.txt' }),
    call('edit', { file: 'e.txt', old: 'AAA\n', new: 'BBB\n' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE apres adaptation');
  const users = r.end.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  assert(users.indexOf('STRATEGIE CORRECTIVE') !== -1, 'strategie corrective injectee');
  assert(fs.readFileSync(path.join(w.proj, 'e.txt'), 'utf8') === 'BBB\n', 'corrige via adaptation');
  assert(r.journal.indexOf('boucle corrective') !== -1, 'journal corrective');
}),
t('P13b garde v2 : recidive identique refusee, puis adaptation', async () => {
  const w = createWorld(fixtureProject());
  w.allow('edit|file|e.txt');
  const r = await w.turn('Modifie e.txt pour mettre BBB', [
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'AAA\n', new: 'BBB\n' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  const tools = r.end.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert(tools.indexOf('"code":"corrective"') !== -1, 'recidive refusee (corrective)');
  assert(fs.readFileSync(path.join(w.proj, 'e.txt'), 'utf8') === 'BBB\n', 'corrige');
}),
t('P13c garde v2 : 2e recidive -> arret boucle PARTIEL + reponse secours', async () => {
  const w = createWorld(fixtureProject());
  w.allow('edit|file|e.txt');
  const r = await w.turn('Modifie e.txt pour mettre BBB', [
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    call('edit', { file: 'e.txt', old: 'ZZZ', new: 'Y' }),
    text('Secours : je n y arrive pas.'),
  ]);
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL, recu ' + r.out.runStatus);
  const done = r.events.filter((e) => e.type === 'turn.done')[0];
  assert(done && done.stopReason === 'loop', 'stopReason loop');
  assert(r.last.content.indexOf('Secours') !== -1, 'reponse secours present');
}),
t('P14 garde v2 : lectures repetees ignorees', async () => {
  const w = createWorld(fixtureProject());
  const r = await w.turn('Lis k.txt trois fois puis termine', [
    call('read', { file: 'k.txt' }),
    call('read', { file: 'k.txt' }),
    call('read', { file: 'k.txt' }),
    call('done', { summary: 'fini' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  const users = r.end.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  assert(users.indexOf('STRATEGIE CORRECTIVE') === -1, 'pas de corrective sur lectures');
}),
t('P15 resultats resumes passe TOOLCAP, courts intacts', async () => {
  const dir = fixtureProject();
  fs.writeFileSync(path.join(dir, 'big.txt'), 'LIGNE\n'.repeat(1000), 'utf8');
  const w = createWorld(dir);
  const r = await w.turn('Lis big.txt puis k.txt', [
    call('read', { file: 'big.txt' }),
    call('read', { file: 'k.txt' }),
    call('done', { summary: 'fini' }),
  ], { env: { SUDO_AGENT_TOOLCAP: '200' } });
  assert(r.out.runStatus === 'TERMINE', 'TERMINE');
  const tools = r.end.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert(tools[0].indexOf('[resume :') !== -1, 'marqueur resume');
  assert(tools[0].length < 1500, 'gros resultat coupe (' + tools[0].length + ')');
  const w2 = createWorld(dir);
  const r2 = await w2.turn('Lis k.txt', [call('read', { file: 'k.txt' }), call('done', { summary: 'f' })]);
  const small = r2.end.messages.filter((m) => m.role === 'tool')[0].content;
  assert(tools[1] === small, 'petit resultat inchange (byte-identique)');
}),
t('P16 fin jamais bloquee par todos ouverts : annexe honnete', async () => {
  const w = createWorld(fixtureProject());
  w.allow('append|file|k.txt');
  const r = await w.turn('1. Ajoute K2 a la fin de k.txt ; 2. Cree n.txt avec N', [
    call('append', { file: 'k.txt', content: 'K2' }),
    call('done', { summary: 'je m arrete la' }),
  ]);
  assert(r.out.runStatus === 'TERMINE', 'fin acceptee');
  assert(r.last.content.indexOf('Plan moteur : 1/2') !== -1, 'annexe 1/2');
  assert(r.last.content.indexOf('Restantes') !== -1, 'restantes annoncees');
  assert(w.todos().filter((x) => x.status === 'done').length === 1, '1 verifiee, 1 ouverte');
}),
t('P17 refus repetes : PARTIEL honnete, jamais comptabilises par la garde', async () => {
  const w = createWorld(fixtureProject());
  const r = await w.turn('Cree le fichier d.txt', [
    call('write', { file: 'd.txt', content: 'D\n' }),
    call('write', { file: 'd.txt', content: 'D\n' }),
    call('write', { file: 'd.txt', content: 'D\n' }),
    call('reply', { text: 'Toujours refuse, j abandonne proprement.' }),
  ], { autoApprove: 'deny' });
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL honnete, recu ' + r.out.runStatus);
  const users = r.end.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  assert(users.indexOf('STRATEGIE CORRECTIVE') === -1, 'pas de corrective sur refus');
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
  console.log(PASS + '/' + tests.length + ' P52-pause tests passed' + (FAILS.length ? ' FAILS: ' + FAILS.join(' | ') : ''));
  process.exit(FAILS.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
