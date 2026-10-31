// MISSION P49 - L'agent EXECUTE : preuves deterministes (fournisseur factice
// scripte, projets temporaires). Couvre : classification ACTION/QUESTION,
// regime strict (tool_choice required + sampling + reply/done), verdict
// honnete (TERMINE seulement avec fichiers verifies, sinon AUCUNE
// MODIFICATION + relances + proposition), verrou recon, todos imposes,
// outils delete/rename, anti-repetition. Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const HOST = '127.0.0.1';

const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { detectRepetition } = require(path.join(AGENT_SRC, 'loop.js'));
const intent = require(path.join(AGENT_SRC, 'intent.js'));
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  return d;
}

function fixtureProject() {
  const dir = tmp('p49proj');
  // No scripts: the P26 verify loop is out of scope here (its own suite).
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p49' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# P49\nProjet preuve.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'alpha\nbeta\n', 'utf8');
  return dir;
}

function mockProvider(opts) {
  opts = opts || {};
  const chats = [];
  const queue = (opts.responses || []).slice();
  const models = opts.models || [{ id: 'mock-model' }];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
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

async function driveTurn(proj, prompt, responses, opts) {
  opts = opts || {};
  const home = tmp('p49home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ dir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  if (opts.mode) store.update(s.id, (x) => { x.meta.mode = opts.mode; });
  const pending = new Map();
  const rules = new Map();
  if (opts.rules) rules.set(s.id, new Set(opts.rules));
  const mock = await mockProvider({ responses });
  const events = [];
  try {
    const out = await runTurn({
      store, sessionId: s.id, prompt, corr: 'p49',
      provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
      toolsCtx: { home, sessionRules: rules, pending },
      runs: new Map(), log,
      onEvent: (e) => { try { events.push(e); } catch (_) {} },
    });
    const end = store.get(s.id);
    const last = end.messages[end.messages.length - 1];
    let journal = '';
    try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
    return { out, last, end, chats: mock.chats, journal, events, pending };
  } finally {
    await mock.close();
  }
}

function sysTexts(body) {
  return (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
}
function toolTexts(body) {
  return (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content).join('\n---\n');
}
function doneEvent(r) {
  return r.events.filter((e) => e && e.type === 'turn.done').pop() || {};
}
function sha(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function countSub(s, sub) {
  let n = 0;
  let i = -1;
  for (;;) {
    i = s.indexOf(sub, i + 1);
    if (i === -1) return n;
    n += 1;
  }
}
const call = (name, args) => ({ toolCalls: [{ name, args: args || {} }] });

// -- A. classification -------------------------------------------------------
const tests = [
t('A1 verbes FR -> ACTION modif', async () => {
  for (const p of ['cree un fichier x', 'supprime notes.txt', 'renomme a en b',
      'corrige le bug login', 'modifie le readme', 'applique ces ameliorations',
      'ecris la doc', 'ajoute un test', 'retire ce bloc']) {
    const c = intent.classifyAction(p);
    assert(c.kind === 'ACTION' && c.expectsChange === true, p + ' => ' + JSON.stringify(c));
  }
}),
t('A2 verbes EN + run -> ACTION', async () => {
  for (const p of ['create file x', 'delete notes.txt', 'rename a to b',
      'fix the login bug', 'apply these improvements', 'remove this block']) {
    const c = intent.classifyAction(p);
    assert(c.kind === 'ACTION' && c.expectsChange === true, p + ' => ' + JSON.stringify(c));
  }
  for (const p of ['lance les tests', 'execute les tests', 'run the tests']) {
    const c = intent.classifyAction(p);
    assert(c.kind === 'ACTION' && c.expectsChange === false, p + ' => ' + JSON.stringify(c));
  }
  // A build may write artifacts: it expects changes (locked semantics).
  const b = intent.classifyAction('execute le build');
  assert(b.kind === 'ACTION' && b.expectsChange === true, 'build => ' + JSON.stringify(b));
}),
t('A3 questions -> QUESTION', async () => {
  for (const p of ['explique ce projet', 'a quoi sert ce fichier ?',
      'resume le readme', 'c\'est quoi ce module ?', 'pourquoi ce test echoue ?']) {
    const c = intent.classifyAction(p);
    assert(c.kind === 'QUESTION', p + ' => ' + JSON.stringify(c));
  }
}),
t('A4 ambigu + listes + flags', async () => {
  assert(intent.classifyAction('bonjour').kind === 'AMBIGUOUS', 'bonjour');
  assert(intent.classifyAction('lis readme.md').kind === 'AMBIGUOUS', 'lis');
  const l = intent.classifyAction('voici la liste :\n1. ajouter un titre\n2. corriger une faute\n');
  assert(l.kind === 'ACTION' && l.hasTaskList && l.taskItems.length === 2, 'liste => ' + JSON.stringify(l));
  const c = intent.classifyAction('applique ces ameliorations au readme');
  assert(c.collective === true, 'collectif: ' + JSON.stringify(c));
  const i = intent.classifyAction('ameliore la doc');
  assert(i.improvement === true && i.expectsChange === true, 'amelioration: ' + JSON.stringify(i));
}),

// -- B. regime strict ----------------------------------------------------------
t('B1 ACTION sans appel -> PARTIEL honnete + forcing prouve', async () => {
  const r = await driveTurn(fixtureProject(), 'corrige le bug login', [{ content: 'bla bla' }]);
  assert(r.out.runStatus === 'PARTIEL', 'runStatus: ' + JSON.stringify(r.out));
  const ev = doneEvent(r);
  assert(String(ev.reason || '').indexOf('AUCUNE MODIFICATION') === 0, 'raison: ' + ev.reason);
  assert(r.last.content.indexOf('AUCUNE MODIFICATION') === 0, 'texte stocke: ' + r.last.content.slice(0, 80));
  assert(r.last.content.indexOf('Proposition :') !== -1, 'proposition');
  assert(r.chats.length === 3, '1 tour + 2 reparations, got ' + r.chats.length);
  assert(r.chats[0].tool_choice === 'required', 'tool_choice required');
  assert(r.chats[0].temperature === 0.15 && r.chats[0].top_p === 0.9 && r.chats[0].top_k === 40 &&
    r.chats[0].repeat_penalty === 1.12 && r.chats[0].max_tokens === 1200, 'sampling: ' + JSON.stringify(r.chats[0]).slice(0, 200));
  assert(countSub(r.journal, 'reparation contrainte') === 2, 'journal reparations');
  assert(r.journal.indexOf('intention classee') !== -1, 'classification journalisee');
}),
t('B2 creation -> TERMINE + fichiers verifies', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'cree le fichier livre.txt avec le mot pain',
    [call('write', { file: 'livre.txt', content: 'pain\n' }), call('done', { summary: 'fichier cree.' })],
    { rules: ['write|file|livre.txt'] });
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(sha(fs.readFileSync(path.join(proj, 'livre.txt'), 'utf8')) === sha('pain\n'), 'contenu');
  assert(r.last.content.indexOf('Modifications verifiees (1)') !== -1, 'annexe: ' + r.last.content.slice(-120));
  const lr = r.end.meta.lastRun;
  assert(lr && lr.status === 'TERMINE' && lr.filesModified.join(',') === '+livre.txt', 'lastRun: ' + JSON.stringify(lr));
}),
t('B3 reply sans modif -> relances x2 puis AUCUNE MODIFICATION', async () => {
  const proj = fixtureProject();
  const rp = call('reply', { text: 'c\'est fini (mensonge).' });
  const r = await driveTurn(proj, 'corrige le bug login', [rp, rp, rp]);
  assert(r.out.runStatus === 'PARTIEL', 'runStatus: ' + JSON.stringify(r.out));
  assert(r.last.content.indexOf('AUCUNE MODIFICATION') === 0, 'texte: ' + r.last.content.slice(0, 60));
  assert(r.last.content.indexOf('appels lecture seule uniquement') !== -1, 'raison: ' + r.last.content.slice(0, 120));
  assert(countSub(r.journal, 'relance contrainte') === 2, 'journal relances');
  assert(r.chats.length === 3, '3 tentatives, got ' + r.chats.length);
}),
t('B4 lecture+ecriture meme tour (regression stale ctx)', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'modifie notes.txt (BETA)',
    [call('read', { file: 'notes.txt' }),
     call('edit', { file: 'notes.txt', old: 'beta\n', new: 'BETA\n' }),
     call('done', {})],
    { rules: ['edit|file|notes.txt'] });
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8') === 'alpha\nBETA\n', 'contenu change');
  const lr = r.end.meta.lastRun;
  assert(lr.diff && lr.diff.indexOf('- beta') !== -1 && lr.diff.indexOf('+ BETA') !== -1, 'diff: ' + String(lr.diff).slice(0, 120));
}),
t('B5 suppression lue -> TERMINE + fichier parti', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'supprime notes.txt',
    [call('read', { file: 'notes.txt' }), call('delete', { file: 'notes.txt' }), call('done', {})],
    { rules: ['delete|file|notes.txt'] });
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(!fs.existsSync(path.join(proj, 'notes.txt')), 'fichier parti');
  assert(r.end.meta.lastRun.filesModified.join(',') === '-notes.txt', 'lastRun: ' + JSON.stringify(r.end.meta.lastRun.filesModified));
}),
t('B6 suppression aveugle refusee puis reparee', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'supprime notes.txt',
    [call('delete', { file: 'notes.txt' }), call('read', { file: 'notes.txt' }),
     call('delete', { file: 'notes.txt' }), call('done', {})],
    { rules: ['delete|file|notes.txt'] });
  assert(toolTexts(r.chats[1]).indexOf('pas ete lu') !== -1, 'verrou lecture: ' + toolTexts(r.chats[1]).slice(0, 120));
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(!fs.existsSync(path.join(proj, 'notes.txt')), 'fichier parti');
}),
t('B7 renommage lu -> TERMINE + deplace', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'renomme notes.txt en archive.txt',
    [call('read', { file: 'notes.txt' }), call('rename', { from: 'notes.txt', to: 'archive.txt' }), call('done', {})],
    { rules: ['rename|file|notes.txt'] });
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(!fs.existsSync(path.join(proj, 'notes.txt')) && fs.readFileSync(path.join(proj, 'archive.txt'), 'utf8') === 'alpha\nbeta\n', 'deplace');
  assert(r.end.meta.lastRun.filesModified.join(',').indexOf('+archive.txt') !== -1, 'lastRun');
}),
t('B8 renommage vers cible existante -> refuse, intact, ECHEC conserve', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'renomme notes.txt en README.md',
    [call('read', { file: 'notes.txt' }), call('rename', { from: 'notes.txt', to: 'README.md' }), call('done', { summary: 'fait.' })],
    { rules: ['rename|file|notes.txt'] });
  assert(toolTexts(r.chats[2]).indexOf('existe deja') !== -1, 'anti-ecrasement: ' + toolTexts(r.chats[2]).slice(0, 120));
  assert(fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8') === 'alpha\nbeta\n', 'source intacte');
  // A loud tool error stands: declared ECHEC is never downgraded to PARTIEL.
  assert(r.out.runStatus === 'ECHEC', 'runStatus: ' + JSON.stringify(r.out));
  assert(doneEvent(r).reason.indexOf('rename') !== -1, 'raison: ' + doneEvent(r).reason);
}),
t('B9 amelioration sans constat -> verrou recon puis TERMINE', async () => {
  // Realistic ctx: this 4-round turn (recon + read + edit-with-diff) plus
  // the P52 plan trace exceeds the 2048-token micro-fallback.
  const prevCtx = process.env.SUDO_AGENT_CTX_TOKENS;
  process.env.SUDO_AGENT_CTX_TOKENS = '32768';
  try {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'ameliore le README',
    [call('write', { file: 'README.md', content: 'conseils generiques\n' }),
     call('read', { file: 'README.md' }),
     call('edit', { file: 'README.md', old: 'Projet preuve.\n', new: 'Projet preuve.\n\n## Usage\nConstats reels.\n' }),
     call('done', {})],
    { rules: ['edit|file|README.md'] });
  assert(toolTexts(r.chats[1]).indexOf('recon_required') !== -1, 'verrou: ' + toolTexts(r.chats[1]).slice(0, 100));
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(fs.readFileSync(path.join(proj, 'README.md'), 'utf8').indexOf('Constats reels') !== -1, 'contenu');
  } finally {
    if (prevCtx === undefined) delete process.env.SUDO_AGENT_CTX_TOKENS;
    else process.env.SUDO_AGENT_CTX_TOKENS = prevCtx;
  }
}),
t('B10 run-only execute -> TERMINE execution verifiee', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'lance les tests',
    [call('bash', { command: 'echo tests-ok' }), call('done', {})],
    { rules: ['bash|command|echo tests-ok'] });
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(r.last.content.indexOf('execution seule, verifiee') !== -1, 'mention: ' + r.last.content.slice(-140));
}),
t('B11 liste collee -> plan ensemence + fin jamais bloquee (P52)', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'applique ces ameliorations :\n1. ajouter un titre\n2. corriger une faute',
    [call('read', { file: 'README.md' }),
     call('write', { file: 'titre.txt', content: 'titre\n' }), call('done', {})],
    { rules: ['write|file|titre.txt'] });
  assert(r.journal.indexOf('plan moteur ensemence') !== -1, 'ensemencement journalise');
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(fs.existsSync(path.join(proj, 'titre.txt')), 'fichier cree');
}),
t('B12 collectif sans plan -> plan ensemence + fin acceptee (P52)', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'applique ces ameliorations au readme',
    [call('read', { file: 'README.md' }),
     call('write', { file: 'plus.txt', content: 'plus\n' }), call('done', {})],
    { rules: ['write|file|plus.txt'] });
  assert(r.journal.indexOf('plan moteur ensemence') !== -1, 'ensemencement journalise');
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(fs.existsSync(path.join(proj, 'plus.txt')), 'fichier cree');
}),
t('B13 approbation en attente -> ECHEC (bloque), fichier intact', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'cree le fichier attente.txt',
    [call('write', { file: 'attente.txt', content: 'x\n' }), call('done', {})]);
  // Blocked on the operator mid-turn: loud ECHEC (P26-B3 semantics kept).
  assert(r.out.runStatus === 'ECHEC', 'runStatus: ' + JSON.stringify(r.out));
  assert(r.pending.size === 1, 'demande en attente');
  assert(!fs.existsSync(path.join(proj, 'attente.txt')), 'rien execute sans approbation');
}),
t('B14 mode PLAN -> refus + AUCUNE sans relance', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'cree le fichier plan.txt avec ok',
    [call('write', { file: 'plan.txt', content: 'ok\n' }), call('done', {})], { mode: 'plan' });
  assert(toolTexts(r.chats[1]).indexOf('plan_mode') !== -1, 'refus plan: ' + toolTexts(r.chats[1]).slice(0, 100));
  assert(r.out.runStatus === 'PARTIEL', 'runStatus: ' + JSON.stringify(r.out));
  assert(r.last.content.indexOf('AUCUNE MODIFICATION : mode PLAN') === 0, 'raison: ' + r.last.content.slice(0, 60));
  assert(r.journal.indexOf('relance contrainte') === -1, 'pas de relance en PLAN');
  assert(!fs.existsSync(path.join(proj, 'plan.txt')), 'fichier intact');
}),
t('B15 enveloppe {ok, detail} sur succes + erreur', async () => {
  const proj = fixtureProject();
  const r = await driveTurn(proj, 'lis les notes puis inventorie (tour mixte)',
    [call('read', { file: 'notes.txt' }), call('read', { file: 'absent.txt' }),
     call('reply', { text: 'notes lues, absent manquant.' })]);
  const tt = toolTexts(r.chats[2]);
  assert(tt.indexOf('"ok":true') !== -1 && tt.indexOf('"detail"') !== -1, 'succes: ' + tt.slice(0, 160));
  assert(tt.indexOf('"ok":false') !== -1 && tt.indexOf('introuvable') !== -1, 'erreur: ' + tt.slice(0, 300));
}),

// -- C. anti-repetition --------------------------------------------------------
t('C1 detectRepetition pur', async () => {
  assert(detectRepetition('Le ciel est bleu et vaste. Le ciel est bleu et vaste. Le ciel est bleu et vaste.') !== null, '3x');
  assert(detectRepetition('Le ciel est bleu et vaste. Le ciel est bleu et vaste.') === null, '2x ok');
  assert(detectRepetition('Oui. Oui. Oui.') === null, 'phrases courtes ignorees');
  assert(detectRepetition('') === null && detectRepetition(null) === null, 'vide');
}),
t('C2 question qui begaye -> 1 retry guide puis reponse propre', async () => {
  const proj = fixtureProject();
  const beg = 'Le readme decrit un projet de test simple. Le readme decrit un projet de test simple. Le readme decrit un projet de test simple.';
  const r = await driveTurn(proj, 'explique ce projet', [{ content: beg }, { content: 'propre.' }]);
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
  assert(r.last.content === 'propre.', 'retry propre stocke: ' + r.last.content);
  assert(r.chats.length === 2, '2 appels, got ' + r.chats.length);
  assert(r.journal.indexOf('repetition detectee') !== -1, 'journalise');
}),
t('C3 reply qui begaye -> rejet puis accepte', async () => {
  const proj = fixtureProject();
  const beg = 'Le fichier est cree correctement ici. Le fichier est cree correctement ici. Le fichier est cree correctement ici.';
  const r = await driveTurn(proj, 'cree le fichier ok.txt avec ok',
    [call('write', { file: 'ok.txt', content: 'ok\n' }),
     call('reply', { text: beg }), call('reply', { text: 'fichier cree.' })],
    { rules: ['write|file|ok.txt'] });
  assert(toolTexts(r.chats[2]).indexOf('se repete') !== -1, 'rejet: ' + toolTexts(r.chats[2]).slice(0, 100));
  assert(r.out.runStatus === 'TERMINE', 'runStatus: ' + JSON.stringify(r.out));
}),

// -- D. marqueurs sources ------------------------------------------------------
t('D1 marqueurs agent', async () => {
  const loop = fs.readFileSync(path.join(AGENT_SRC, 'loop.js'), 'utf8');
  assert(loop.indexOf("require('./intent')") !== -1, 'intent requis');
  assert(loop.indexOf("toolChoice: 'required'") !== -1, 'forcing');
  assert(loop.indexOf('temperature: 0.15') !== -1 && loop.indexOf('topK: 40') !== -1 &&
    loop.indexOf('repeatPenalty: 1.12') !== -1 && loop.indexOf('maxTokens: 1200') !== -1, 'sampling');
  assert(loop.indexOf('AUCUNE MODIFICATION') !== -1, 'verdict');
  assert(loop.indexOf('recon_required') !== -1 && loop.indexOf('todos_open') !== -1 && loop.indexOf('no_plan') !== -1, 'verrous');
  const tools = fs.readFileSync(path.join(AGENT_SRC, 'tools.js'), 'utf8');
  assert(tools.indexOf('async function hDelete') !== -1 && tools.indexOf('async function hRename') !== -1, 'delete/rename');
  assert(tools.indexOf('async function hReply') !== -1 && tools.indexOf('async function hDone') !== -1, 'reply/done');
  const modes = fs.readFileSync(path.join(AGENT_SRC, 'modes.js'), 'utf8');
  assert(modes.indexOf('Edit example:') !== -1 && modes.indexOf('Write example:') !== -1, 'exemples');
  assert(modes.indexOf('reply(text) or done()') !== -1, 'sorties');
}),
t('D2 marqueurs runtime', async () => {
  const oc = fs.readFileSync(path.join(ROOT, 'backend', 'runtime', 'openai_compat.py'), 'utf8');
  assert(oc.indexOf('def sampling_kwargs') !== -1, 'sampling_kwargs');
  assert(oc.indexOf('def tools_for_request') !== -1, 'tools_for_request');
  assert(oc.indexOf('**sampling') !== -1, 'transmission llama');
}),
t('D3 marqueurs harnais P49 (20 demandes)', async () => {
  const b = fs.readFileSync(path.join(ROOT, 'scripts', 'bench-agent.ps1'), 'utf8');
  assert(b.indexOf('$P49_KEYS') !== -1, 'cles P49');
  for (const k of ['A1-create', 'A10-verify', 'A13-run', 'A16-explain', 'A20-read']) {
    assert(b.indexOf("'" + k + "'") !== -1, 'tache ' + k);
  }
  assert(b.indexOf('Get-PendingTools') !== -1, 'preuves de tentative');
  assert(b.indexOf('TOURNESOL') !== -1, 'mot-cle seed');
  assert(b.indexOf('T1-explain') !== -1 && b.indexOf('T5-summarize') !== -1, 'T1-T5 intacts');
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
  console.log(PASS + '/' + tests.length + ' P49 tests passed' + (FAILS.length ? ' FAILS: ' + FAILS.join(' | ') : ''));
  process.exit(FAILS.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
