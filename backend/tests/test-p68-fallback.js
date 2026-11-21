/**
 * SUDO STUDIO - P68-C : deux promesses mesurees, pas racontees.
 *
 * C11 - FORMAT DE SECOURS "FICHIER: chemin"
 *   Quand le fournisseur n'arrive plus a produire un appel d'outil, l'agent
 *   demande le meme travail en texte libre. Les blocs doivent devenir de VRAIS
 *   fichiers, par le chemin normal (outil write : approbation, journal) :
 *     C11a un bloc valide -> fichier ecrit sur le disque, etape journalisee ;
 *     C11b un chemin interdit (absolu, remontee de dossier) -> RIEN n'est ecrit
 *          hors du projet, et l'echec est annonce ;
 *     C11c "AUCUN FICHIER" -> aucun fichier, aucune fausse reussite ;
 *     C11d parseFileBlocks refuse les chemins dangereux et le contenu demesure.
 *
 * C12 - REESSais BORNES (appel d'outil invalide)
 *     C12a un appel invalide est reessaie, PAS abandonne : 1 panne puis un
 *          appel valide -> la tache se termine, la panne est journalisee ;
 *     C12b 2 reessais au maximum : apres 3 appels invalides le moteur arrete
 *          les frais (au plus 3 requetes d'appel d'outil) et passe au secours ;
 *     C12c le modele recoit une consigne explicite entre deux essais.
 *
 * Fournisseur factice scripte, projet temporaire. Stdlib only, ASCII only.
 * Lancer : node backend/tests/test-p68-fallback.js
 */
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
const recovery = require(path.join(AGENT_SRC, 'recovery.js'));

let PASS = 0;
const FAILS = [];
const REGISTRY = [];
function t(name, fn) { REGISTRY.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

const call = (name, args) => ({ toolCalls: [{ name, args: args || {} }] });
const text = (content) => ({ content });
// Reponse 200 + erreur structuree : c'est ce que le runtime renvoie quand
// l'appel d'outil reste inutilisable apres reparation (providers.js).
const invalid = () => ({ invalidCall: { field: 'name', detail: 'nom absent' } });

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
        const next = queue.length ? queue.shift() : text('fin.');
        if (next.invalidCall) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: '' } }],
            error: { code: 'invalid_tool_call', field: next.invalidCall.field,
              message: 'Appel invalide : champ ' + next.invalidCall.field + ' manquant.',
              detail: next.invalidCall.detail, example: { name: 'read', arguments: { file: 'a.txt' } } },
          }));
          return;
        }
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
    srv.listen(0, HOST, () => resolve({ server: srv, port: srv.address().port, chats,
      close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

function createWorld(proj) {
  const home = tmp('p68home');
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
    try {
      w.seq += 1;
      const out = await runTurn({ store, sessionId: s.id, prompt, corr: opts.corr || ('p68-' + w.seq),
        provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
        toolsCtx: w.toolsCtx(), runs: new Map(), log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} } });
      const end = store.get(s.id);
      let journal = '';
      try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
      return { out, end, events, chats: mock.chats, journal,
        last: end.messages[end.messages.length - 1],
        lastRun: (end.meta && end.meta.lastRun) || {} };
    } finally {
      await mock.close();
    }
  };
  return w;
}

function project() {
  const dir = tmp('p68proj');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nligne un\n', 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// C11 - le format de secours ecrit de VRAIS fichiers
// ---------------------------------------------------------------------------
t('C11a un bloc FICHIER valide devient un fichier reel (chemin normal)', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('write|file|recu.txt', 'write|file|README.md');
  const fallback = 'Voici le fichier demande.\n\nFICHIER: recu.txt\ncontenu ecrit par le format de secours\nFIN FICHIER\n';
  const r = await w.turn('Cree le fichier recu.txt avec ce contenu.', [
    invalid(), invalid(), invalid(),   // 3 appels invalides : on epuise les essais
    text(fallback),                    // puis le format de secours
    call('done', {}),
  ]).catch((e) => ({ error: e }));

  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  const p = path.join(dir, 'recu.txt');
  assert(fs.existsSync(p), 'le fichier recu.txt doit exister (journal: ' + String(r.journal).slice(-400) + ')');
  const body = fs.readFileSync(p, 'utf8');
  assert(/format de secours/.test(body), 'contenu ecrit: ' + JSON.stringify(body));
  assert(/fichiers du format de secours empiles/.test(r.journal), 'journal : blocs empiles');
  assert(/ecriture issue du format de secours/.test(r.journal), 'journal : ecriture par le chemin normal');
});

t('C11b un chemin interdit n ecrit RIEN hors du projet', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('write|file|recu.txt');
  const evil = 'FICHIER: ../../evade.txt\ncontenu interdit\nFIN FICHIER\nFICHIER: /tmp/p68-absolu.txt\nencore\nFIN FICHIER\n';
  const r = await w.turn('Cree un fichier.', [
    invalid(), invalid(), invalid(),
    text(evil),
    text('AUCUN FICHIER'),
  ]).catch((e) => ({ error: e }));

  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  assert(!fs.existsSync(path.join(dir, '..', '..', 'evade.txt')), 'aucune ecriture par remontee de dossier');
  assert(!fs.existsSync('/tmp/p68-absolu.txt'), 'aucune ecriture en chemin absolu');
  const runs = String(r.journal);
  assert(!/ecriture issue du format de secours/.test(runs) || !fs.existsSync(path.join(dir, 'evade.txt')),
    'aucune ecriture issue d un bloc refuse');
});

t('C11c "AUCUN FICHIER" n ecrit rien et ne pretend rien avoir fait', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('write|file|x.txt');
  const before = fs.readdirSync(dir).sort().join(',');
  const r = await w.turn('Cree un fichier.', [
    invalid(), invalid(), invalid(),
    text('AUCUN FICHIER'),
  ]).catch((e) => ({ error: e }));
  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  const after = fs.readdirSync(dir).sort().join(',');
  assert(before === after, 'aucun fichier cree: ' + before + ' -> ' + after);
  const txt = String((r.last && r.last.content) || '');
  assert(!/recu\.txt|x\.txt/.test(txt) || /aucun/i.test(txt), 'pas de fausse reussite: ' + txt.slice(0, 200));
});

t('C11d parseFileBlocks refuse les chemins dangereux et le contenu demesure', async () => {
  const bad = recovery.parseFileBlocks('FICHIER: ../../x.txt\na\nFICHIER: C:\\Windows\\evil.txt\nb\nFICHIER: /etc/passwd\nc\n');
  assert(bad.ok === false, 'aucun bloc exploitable: ' + JSON.stringify(bad).slice(0, 200));
  assert((bad.refused || []).length === 3, 'les 3 chemins sont journalises comme refuses: ' + JSON.stringify(bad.refused));
  const big = recovery.parseFileBlocks('FICHIER: gros.txt\n' + 'x'.repeat(600 * 1024) + '\n');
  assert(big.ok === false, 'contenu > 512 Ko refuse');
  const good = recovery.parseFileBlocks('FICHIER: src/app.js\nconsole.log(1);\nFIN FICHIER\n');
  assert(good.ok === true && good.files[0].path === 'src/app.js', 'un bloc simple reste accepte');
});

// ---------------------------------------------------------------------------
// C12 - reessais bornes sur appel invalide
// ---------------------------------------------------------------------------
t('C12a un appel invalide est reessaie, puis la tache aboutit', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('write|file|ok.txt');
  const r = await w.turn('Cree ok.txt.', [
    invalid(),
    call('write', { file: 'ok.txt', content: 'bonjour\n' }),
    call('done', {}),
  ]).catch((e) => ({ error: e }));
  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  assert(fs.existsSync(path.join(dir, 'ok.txt')), 'le fichier est ecrit apres la reprise');
  assert(/appel outil invalide, reprise/.test(r.journal), 'la panne est journalisee');
  const reqs = r.chats.filter((c) => c && c.messages).length;
  assert(reqs >= 2, 'au moins deux requetes (panne + reprise), vu ' + reqs);
});

t('C12b au plus 2 reessais : 3 tentatives puis arret des frais', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('write|file|ok.txt');
  const r = await w.turn('Cree ok.txt.', [
    invalid(), invalid(), invalid(), invalid(), invalid(), invalid(),
    text('AUCUN FICHIER'),
  ]).catch((e) => ({ error: e }));
  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  const j = String(r.journal);
  const attempts = (j.match(/attempt=\d+/g) || []).map((m) => parseInt(m.replace(/[^0-9]/g, ''), 10));
  assert(attempts.indexOf(3) !== -1, 'la 3e tentative a bien lieu (2 reessais), vu ' + JSON.stringify(attempts));
  assert(attempts.every((n) => n <= 3), 'jamais plus de 2 reessais par incident, vu ' + JSON.stringify(attempts));
  assert(!fs.existsSync(path.join(dir, 'ok.txt')), 'aucune ecriture trompeuse');
  assert(!!r.out && !!r.out.runStatus, 'le tour se termine (statut: ' + (r.out && r.out.runStatus) + ')');
});

t('C12c entre deux essais le modele recoit une consigne explicite', async () => {
  const dir = project();
  const w = createWorld(dir);
  w.allow('read|file|README.md');
  const r = await w.turn('Lis README.md.', [
    invalid(),
    call('read', { file: 'README.md' }),
    call('done', {}),
  ]).catch((e) => ({ error: e }));
  assert(!r.error, 'tour en erreur: ' + (r.error && r.error.message));
  const second = r.chats[1] || {};
  const msgs = Array.isArray(second.messages) ? second.messages : [];
  const guide = msgs.map((m) => String(m.content || '')).join('\n');
  assert(/Appel invalide|Exemple valide/.test(guide), 'consigne de correction envoyee au modele: ' + guide.slice(-300));
  assert(/read/.test(guide), 'l exemple valide cite un outil reel');
});

// ---------------------------------------------------------------------------
(async () => {
  for (const item of REGISTRY) {
    try {
      await item.fn();
      PASS += 1;
      console.log('ok - ' + item.name);
    } catch (e) {
      FAILS.push(item.name + ' :: ' + (e && e.message));
      console.log('FAIL ' + item.name + ' :: ' + (e && e.message));
    }
  }
  console.log('\nP68-C secours/reessais: ' + PASS + ' checks passed' +
    (FAILS.length ? ', ' + FAILS.length + ' FAILED' : ' (all green)'));
  if (FAILS.length) process.exit(1);
  process.exit(0);
})();
