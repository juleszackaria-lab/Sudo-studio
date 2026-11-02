// MISSION P53 - agent : verifications robustes, messages au modele, journaux
// lisibles. Preuves deterministes (fournisseur factice scripte, projets
// temporaires). Couvre les 7 exigences :
//   R1 pre-controle d'outil avant toute commande de controle (aucun 30 s)
//   R2 delai configurable (120 s) + statut "delai depasse"
//   R3 statut final nuance (PARTIEL = fichiers + raison, ECHEC si rien fait)
//   R4 edit robuste (fins de ligne, espaces, correspondance approchee, lignes reelles)
//   R5 messages moteur -> modele : langue de la conversation, imperatifs
//   R6 journal : polling approvals en DEBUG, tour = debut/outils/resultat/fin
//   R7 le prompt connait l'environnement (outils absents)
// Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const HOST = '127.0.0.1';

process.env.SUDO_AGENT_CTX_TOKENS = '32768';

const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));
const toolsMod = require(path.join(AGENT_SRC, 'tools.js'));
const prereq = require(path.join(AGENT_SRC, 'prereq.js'));
const msgs = require(path.join(AGENT_SRC, 'msgs.js'));
const modes = require(path.join(AGENT_SRC, 'modes.js'));
const serverMod = require(path.join(AGENT_SRC, 'server.js'));
const perm = require(path.join(AGENT_SRC, 'permissions.js'));

let PASS = 0;
const FAILS = [];
const REGISTRY = [];
function t(name, fn) { REGISTRY.push({ name, fn }); return { name, fn }; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

const call = (name, args) => ({ toolCalls: [{ id: 'c-' + name + '-' + Math.random().toString(36).slice(2, 8), name, args: args || {} }] });
const text = (content) => ({ content });

function mockProvider(responses) {
  const chats = [];
  const queue = (responses || []).slice();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', n_ctx: 8192 }] }));
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

function createWorld(proj) {
  const home = tmp('p53home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const rules = new Map();
  rules.set(s.id, new Set());
  const w = { proj, home, logsDir, log, store, sessionId: s.id, rules, pending: new Map(), waiters: new Map(), seq: 0 };
  w.toolsCtx = () => ({ home, sessionRules: rules, pending: w.pending, waiters: w.waiters });
  w.allow = (...keys) => { for (const k of keys) rules.get(s.id).add(k); };
  w.turn = async (prompt, responses, opts) => {
    opts = opts || {};
    const mock = await mockProvider(responses);
    const events = [];
    const saved = {};
    const env = opts.env || {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    try {
      w.seq += 1;
      const out = await runTurn({ store, sessionId: s.id, prompt, corr: opts.corr || ('p53-' + w.seq),
        provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
        toolsCtx: w.toolsCtx(), runs: new Map(), log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} } });
      const end = store.get(s.id);
      let journal = '';
      try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
      return { out, end, events, chats: mock.chats, journal, last: end.messages[end.messages.length - 1],
        lastRun: (end.meta && end.meta.lastRun) || {} };
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      await mock.close();
    }
  };
  return w;
}

// A Flutter-like project WITHOUT flutter installed: pubspec.yaml => the
// verifier detects "flutter analyze" + "flutter test" (the incident).
function flutterProject() {
  const dir = tmp('p53flutter');
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: scanner_num\ndependencies:\n  flutter:\n    sdk: flutter\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# ScannerNum\nVoir le diff.\n', 'utf8');
  return dir;
}

function nodeProject() {
  const dir = tmp('p53node');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p53' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nligne un\nligne deux\nligne trois\n', 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// R1 - pre-controle : outil absent => etape non executee, PAS d'attente 30 s
// ---------------------------------------------------------------------------
t('R1a outil absent -> verification NON EXECUTEE, aucune attente, PARTIEL honnete', async () => {
  const dir = flutterProject();
  const w = createWorld(dir);
  w.allow('edit|file|README.md');
  // Tool pre-check forced deterministic: this machine has NO flutter.
  const r = await w.turn('modifie le README', [
    call('edit', { file: 'README.md', old: 'Voir le diff.', new: 'Voir le diff (modifie).' }),
    call('done', {}),
  ], { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL, got ' + JSON.stringify(r.out));
  const reason = String(r.lastRun.reason || '');
  assert(/flutter/.test(reason) && /introuvable/.test(reason), 'raison honnete: ' + reason);
  assert(/README\.md/.test(reason), 'fichiers listes dans la raison: ' + reason);
  assert(/PARTIEL/.test(String(r.last.content)), 'statut dans la reponse: ' + String(r.last.content).slice(0, 160));
  // aucun bash execute pour flutter : le journal ne doit porter aucun delai.
  assert(!/verify (fail|delai)/.test(r.journal), 'aucune execution flutter: ' + r.journal.slice(-300));
  assert(/verify non executee/.test(r.journal), 'journal: etape non executee');
  // le fichier est bien modifie (les modifications valides sont conservees)
  assert(/modifie/.test(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')), 'README modifie');
});

t('R1b la reponse finale n\'est JAMAIS refusee a cause d\'une verification impossible', async () => {
  const dir = flutterProject();
  const w = createWorld(dir);
  w.allow('edit|file|README.md');
  const r = await w.turn('modifie le README puis termine', [
    call('edit', { file: 'README.md', old: 'Voir le diff.', new: 'Voir le diff (v2).' }),
    call('done', {}),
  ], { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  const doneEvent = r.events.filter((e) => e.type === 'turn.done').pop();
  assert(doneEvent && doneEvent.declaredDone === true, 'fin acceptee (declared)');
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL (pas ECHEC), got ' + JSON.stringify(r.out));
  assert(!/verifications en cours/.test(JSON.stringify(r.chats)), 'aucun refus "verifications en cours"');
});

// ---------------------------------------------------------------------------
// R2 - delai configurable (120 s) + statut "delai depasse"
// ---------------------------------------------------------------------------
t('R2a commande de controle : 120 s par defaut, configurable, jamais 30 s', async () => {
  // direct: a control command gets the control budget, a plain one keeps 30 s
  assert(toolsMod.isControlCommand('flutter test') === true, 'flutter test = controle');
  assert(toolsMod.isControlCommand('npm test') === true, 'npm test = controle');
  assert(toolsMod.isControlCommand('echo hi') === false, 'echo = commande simple');
  assert(toolsMod.controlTimeout() === 120000, 'defaut 120 s, got ' + toolsMod.controlTimeout());
  const prev = process.env.SUDO_AGENT_CONTROL_TIMEOUT_MS;
  process.env.SUDO_AGENT_CONTROL_TIMEOUT_MS = '20000';
  assert(toolsMod.controlTimeout() === 20000, 'configurable, got ' + toolsMod.controlTimeout());
  if (prev === undefined) delete process.env.SUDO_AGENT_CONTROL_TIMEOUT_MS;
  else process.env.SUDO_AGENT_CONTROL_TIMEOUT_MS = prev;
});

t('R2b delai depasse -> statut "delai depasse", pas "echec d\'outil non resolu"', async () => {
  const dir = tmp('p53slow');
  // .sudo-verify: a check that overruns its (tiny) budget on purpose.
  fs.writeFileSync(path.join(dir, '.sudo-verify'), 'node -e "setTimeout(function(){}, 60000)"\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n', 'utf8');
  const w = createWorld(dir);
  const checkCmd = 'node -e "setTimeout(function(){}, 60000)"';
  const ptn = perm.patternOf('bash', { command: checkCmd }, { ok: true, rel: '.' });
  w.allow('write|file|f2.txt', perm.ruleKey('bash', ptn));
  const r = await w.turn('cree f2.txt', [
    call('write', { file: 'f2.txt', content: 'x\n' }),
    call('done', {}),
  ], { env: { SUDO_AGENT_VERIFY_TIMEOUT_MS: '6000' } });
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL, got ' + JSON.stringify(r.out));
  assert(/delai depasse/.test(String(r.lastRun.reason)), 'raison delai: ' + String(r.lastRun.reason));
  assert(!/erreurs d'outil non resolues/.test(String(r.lastRun.reason)), 'pas un echec d\'outil');
  assert(/verify delai depasse/.test(r.journal), 'journal: delai depasse');
});

// ---------------------------------------------------------------------------
// R3 - statut final nuance
// ---------------------------------------------------------------------------
t('R3a rien fait + erreurs = ECHEC ; fichiers modifies + erreurs = PARTIEL', async () => {
  // (1) nothing done: two failing reads on missing files -> ECHEC
  const d1 = nodeProject();
  const w1 = createWorld(d1);
  const r1 = await w1.turn('lis les fichiers', [
    call('read', { file: 'absent1.txt' }),
    call('read', { file: 'absent2.txt' }),
    call('done', {}),
  ]);
  assert(r1.out.runStatus === 'ECHEC', 'ECHEC attendu (rien fait), got ' + JSON.stringify(r1.out));

  // (2) real modification + a standing tool error -> PARTIEL with the file list
  const d2 = nodeProject();
  const w2 = createWorld(d2);
  w2.allow('edit|file|README.md');
  const r2 = await w2.turn('modifie le README', [
    call('edit', { file: 'README.md', old: 'ligne deux', new: 'ligne 2' }),
    call('edit', { file: 'README.md', old: 'ABSENT-XYZ', new: 'q' }),
    call('done', {}),
  ]);
  assert(r2.out.runStatus === 'PARTIEL', 'PARTIEL attendu, got ' + JSON.stringify(r2.out));
  assert(/PARTIEL/.test(String(r2.last.content)) && /README\.md/.test(String(r2.last.content)), 'statut + fichiers: ' + String(r2.last.content).slice(-200));
});

// ---------------------------------------------------------------------------
// R4 - edit robuste
// ---------------------------------------------------------------------------
function ctxFor(dir, ...rules) {
  const w = createWorld(dir);
  const set = new Set(rules);
  return { root: dir, home: w.home, sessionId: w.sessionId, sessionRules: set, pending: new Map(), store: w.store };
}

t('R4a fins de ligne tolerees (fichier CRLF, old en LF)', async () => {
  const dir = tmp('p53crlf');
  fs.writeFileSync(path.join(dir, 'w.txt'), 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');
  const ctx = ctxFor(dir, 'edit|file|w.txt');
  const r = await toolsMod.executeTool(ctx, 'edit', { file: 'w.txt', old: 'beta\ngamma\n', new: 'BETA\nGAMMA\n' });
  assert(r.status === 'done', 'edit ok: ' + JSON.stringify(r).slice(0, 200));
  const after = fs.readFileSync(path.join(dir, 'w.txt'), 'utf8');
  assert(after === 'alpha\r\nBETA\r\nGAMMA\r\n', 'contenu + CRLF conserves: ' + JSON.stringify(after));
});

t('R4b espaces toleres (indentation differente)', async () => {
  const dir = tmp('p53ws');
  fs.writeFileSync(path.join(dir, 's.js'), 'function a() {\n    const x = 1;\n    return x;\n}\n', 'utf8');
  const ctx = ctxFor(dir, 'edit|file|s.js');
  const r = await toolsMod.executeTool(ctx, 'edit', { file: 's.js', old: 'function a() {\n  const x = 1;\n  return x;\n}', new: 'function a() {\n  const x = 2;\n  return x;\n}' });
  assert(r.status === 'done', 'edit espaces ok: ' + JSON.stringify(r).slice(0, 200));
  assert(/const x = 2;/.test(fs.readFileSync(path.join(dir, 's.js'), 'utf8')), 'valeur remplacee');
});

t('R4c correspondance approchee (un mot a change)', async () => {
  const dir = tmp('p53fuzzy');
  fs.writeFileSync(path.join(dir, 'f.py'), 'def compute_total(items):\n    total = 0\n    return total\n', 'utf8');
  const ctx = ctxFor(dir, 'edit|file|f.py');
  const r = await toolsMod.executeTool(ctx, 'edit', { file: 'f.py', old: 'def compute_total(items):\n    total = 0\n    return total + 1', new: 'def compute_total(items):\n    total = sum(items)\n    return total' });
  assert(r.status === 'done', 'edit approche ok: ' + JSON.stringify(r).slice(0, 300));
  assert(/sum\(items\)/.test(fs.readFileSync(path.join(dir, 'f.py'), 'utf8')), 'bloc remplace');
});

t('R4d introuvable -> lignes REELLES autour de la zone + append propose', async () => {
  const dir = tmp('p53nf');
  fs.writeFileSync(path.join(dir, 'g.txt'), 'un\ndeux\ntrois\nquatre\ncinq\n', 'utf8');
  const ctx = ctxFor(dir, 'edit|file|g.txt');
  const r = await toolsMod.executeTool(ctx, 'edit', { file: 'g.txt', old: 'zzz totalement different qqq', new: 'x' });
  assert(r.status === 'error' && r.code === 'not_found', 'not_found: ' + JSON.stringify(r).slice(0, 200));
  const err = String(r.reason || '');
  assert(/Lignes reelles/.test(err), 'message: lignes reelles: ' + err.slice(0, 200));
  assert(/1\| un/.test(err), 'vraies lignes numerotees: ' + err.slice(0, 200));
  assert(/append/.test(err), 'append propose');
  assert(/append/.test(err) && /edit/.test(err + ' edit'), 'alternative proposee');
});

// ---------------------------------------------------------------------------
// R5 - messages du moteur : langue de la conversation, imperatifs
// ---------------------------------------------------------------------------
const EN_STOP = /\b(sorry|apologi[sz]e|I can't|I cannot|unable to|as an AI|Please provide|You must|Your request|cannot assist)\b/i;

function allModelText(chats) {
  const out = [];
  for (const c of chats) {
    for (const m of (c.messages || [])) out.push(String(m.content || ''));
    const tc = c.tools ? JSON.stringify(c.tools) : '';
    if (tc) out.push(tc);
  }
  return out.join('\n');
}

t('R5a conversation FR -> aucun message anglais envoye au modele', async () => {
  const dir = nodeProject();
  const w = createWorld(dir);
  w.allow('edit|file|README.md');
  const r = await w.turn('modifie le README du projet et corrige la ligne', [
    call('edit', { file: 'README.md', old: 'ligne un', new: 'Ligne un' }),
    call('done', {}),
    call('done', {}),
    call('done', {}),
  ], { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  // Le prompt systeme doit etre francais (la cause des reponses anglaises).
  const sys = (r.chats[0].messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(/Tu es Sudo Agent/.test(sys), 'prompt systeme FR: ' + sys.slice(0, 80));
  assert(!/You are Sudo Agent/.test(sys), 'aucun prompt anglais');
  // Aucune formulation qui invite a s'excuser / refuser.
  assert(!EN_STOP.test(allModelText(r.chats)), 'formulation anglaise interdite: ' + (allModelText(r.chats).match(EN_STOP) || [''])[0]);
});

t('R5b appel invalide -> message FR court, factuel, imperatif', async () => {
  const dir = nodeProject();
  const w = createWorld(dir);
  const noName = { toolCalls: [{ id: 'x1', name: '', args: {} }] };
  const r = await w.turn('modifie le README', [noName, call('done', {})],
    { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  const blob = allModelText(r.chats);
  assert(/Appel invalide/.test(blob), 'message FR: ' + blob.slice(-300));
  assert(/champ name manquant/.test(blob), 'factuel');
  const plain = blob.replace(/\\"/g, '"');
  assert(/"name":"<outil>"/.test(plain) && /"arguments"/.test(plain), 'exemple JSON fourni');
  assert(!EN_STOP.test(blob), 'aucune invitation a s\'excuser');
});

t('R5c conversation EN -> messages en anglais (aucune regression de langue)', async () => {
  const dir = nodeProject();
  const w = createWorld(dir);
  const r = await w.turn('please read the README of this project and tell me what it contains', [
    text('The README is a demo file.'),
  ], { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  const sys = (r.chats[0].messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(/You are Sudo Agent/.test(sys), 'prompt EN: ' + sys.slice(0, 80));
});

t('R5d detectLang : FR/EN deterministes', async () => {
  assert(msgs.detectLang('modifie le fichier du projet et corrige l erreur') === 'fr', 'fr');
  assert(msgs.detectLang('please fix the error in this file for the project') === 'en', 'en');
  assert(msgs.detectLang('') === 'fr', 'defaut produit = fr');
});

// ---------------------------------------------------------------------------
// R6 - journaux : approvals en DEBUG, tour = debut/outils/resultat/fin
// ---------------------------------------------------------------------------
function httpJson(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, method, path: p,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { b = raw; } resolve({ status: res.statusCode, body: b }); });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

t('R6a polling approvals en DEBUG : 300 sondages -> journal quasi muet', async () => {
  const home = tmp('p53log');
  const logsDir = path.join(home, 'logs');
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const log = createLogger({ logsDir, component: 'agent' });
  const mock = await mockProvider([{ content: 'ok' }]);
  process.env.SUDO_STUDIO_HOME = home;
  const srv = serverMod.createApp({ authToken: 'tok', store, log,
    provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' } }).server;
  await new Promise((r) => srv.listen(0, HOST, r));
  const port = srv.address().port;
  try {
    const s = store.create({ title: 'log', projectRoot: nodeProject() });
    log.info('test start', { case: 'R6a' }); // the file is created on first write
    const before = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8').split('\n').filter(Boolean).length;
    // 10 minutes d'inactivite ~ 300 sondages d'approbations (1 toutes les 2 s).
    for (let i = 0; i < 300; i++) await httpJson(port, 'tok', 'GET', '/sessions/' + s.id + '/approvals');
    const after = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8').split('\n').filter(Boolean).length;
    const delta = after - before;
    assert(delta < 20, '10 min inactives = < 20 lignes, got ' + delta);
  } finally {
    await new Promise((r) => srv.close(() => r()));
    await mock.close();
    delete process.env.SUDO_STUDIO_HOME;
  }
});

t('R6b SUDO_AGENT_LOG_LEVEL=debug reactive les sondages', async () => {
  const home = tmp('p53log2');
  const logsDir = path.join(home, 'logs');
  process.env.SUDO_AGENT_LOG_LEVEL = 'debug';
  const log = createLogger({ logsDir, component: 'agent' });
  try {
    const store = new SessionStore({ storeDir: path.join(home, 'store') });
    const mock = await mockProvider([{ content: 'ok' }]);
    process.env.SUDO_STUDIO_HOME = home;
    const srv = serverMod.createApp({ authToken: 'tok', store, log,
      provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' } }).server;
    await new Promise((r) => srv.listen(0, HOST, r));
    const port = srv.address().port;
    try {
      const s = store.create({ title: 'log', projectRoot: nodeProject() });
      for (let i = 0; i < 3; i++) await httpJson(port, 'tok', 'GET', '/sessions/' + s.id + '/approvals');
      const raw = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8');
      assert(/\[DEBUG\]/.test(raw) && /approvals/.test(raw), 'debug reactivable');
    } finally { await new Promise((r) => srv.close(() => r())); await mock.close(); }
  } finally {
    delete process.env.SUDO_AGENT_LOG_LEVEL;
    delete process.env.SUDO_STUDIO_HOME;
  }
});

t('R6c un tour ecrit debut, outils, resultat et fin', async () => {
  const dir = nodeProject();
  const w = createWorld(dir);
  w.allow('edit|file|README.md');
  const r = await w.turn('modifie le README', [
    call('edit', { file: 'README.md', old: 'ligne un', new: 'Ligne un' }),
    call('done', {}),
  ], { env: { SUDO_AGENT_ENV_AVAILABLE: 'node,npm,git' } });
  assert(/turn start/.test(r.journal), 'debut');
  assert(/tool ok/.test(r.journal), 'outils + resultat');
  assert(/turn done/.test(r.journal), 'fin');
});

// ---------------------------------------------------------------------------
// R7 - le prompt connait l'environnement
// ---------------------------------------------------------------------------
t('R7a prompt : outils ABSENTS listes, installation proposee', async () => {
  const snap = { present: ['node', 'git'], missing: ['flutter', 'docker'] };
  const fr = modes.buildSystem({ lang: 'fr', env: snap });
  assert(/ABSENTS/.test(fr) && /flutter/.test(fr), 'absents listes: ' + fr.slice(-160));
  assert(/SDK Manager/.test(fr) && /permission/.test(fr), 'installation + permission');
  const small = modes.buildSystemSmall({ lang: 'fr', env: snap });
  assert(/ABSENTS/.test(small) && /flutter/.test(small), 'variante terse aussi');
});

t('R7b bash sur un outil absent : refus immediat avec action (aucune attente)', async () => {
  const dir = nodeProject();
  const ctx = ctxFor(dir);
  const prev = process.env.SUDO_AGENT_ENV_AVAILABLE;
  process.env.SUDO_AGENT_ENV_AVAILABLE = 'node,npm,git';
  prereq.resetCache();
  try {
    const t0 = Date.now();
    const r = await toolsMod.executeTool(ctx, 'bash', { command: 'flutter test' });
    const ms = Date.now() - t0;
    assert(r.status === 'error' && r.code === 'tool_missing', 'tool_missing: ' + JSON.stringify(r).slice(0, 200));
    assert(/introuvable/.test(String(r.reason || '')), 'message clair: ' + String(r.reason).slice(0, 120));
    assert(ms < 5000, 'aucune attente de 30 s, got ' + ms + ' ms');
    assert(r.data && r.data.action && r.data.action.kind === 'sdk', 'action proposee');
  } finally {
    if (prev === undefined) delete process.env.SUDO_AGENT_ENV_AVAILABLE;
    else process.env.SUDO_AGENT_ENV_AVAILABLE = prev;
    prereq.resetCache();
  }
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
(async () => {
  // Optional filter: `node test-p53-agent-robust.js R1` runs a subset.
  const ONLY = process.argv[2] || '';
  for (const item of REGISTRY) {
    if (ONLY && item.name.indexOf(ONLY) !== 0) continue;
    try {
      await item.fn();
      PASS += 1;
      console.log('ok - ' + item.name);
    } catch (e) {
      FAILS.push(item.name + ' :: ' + String((e && e.message) || e));
      console.log('FAIL - ' + item.name + ' :: ' + String((e && e.message) || e));
    }
  }
  console.log(PASS + '/' + (PASS + FAILS.length) + ' P53 tests passed');
  if (FAILS.length) console.log('FAILS: ' + FAILS.join(' | '));
  process.exit(FAILS.length ? 1 : 0);
})();
