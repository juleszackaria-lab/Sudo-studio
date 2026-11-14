/**
 * SUDO STUDIO - P63 : reprise reelle, delais coherents, etat hors du projet,
 * plan coherent (G1, G2, G3, G5).
 *
 * Ce fichier prouve, sur le VRAI moteur (loop.js + job.js + spec.js +
 * stateDir.js) et avec un faux fournisseur local (aucun modele reel) :
 *   G1  "continu" sur un travail inacheve reprend le REGISTRE (aucun appel
 *       parent au modele, aucune conversation), reprend a la premiere etape
 *       non faite, et n'annonce jamais TERMINE s'il reste du travail ;
 *   G2  le temps de panne du runtime n'est JAMAIS decompte du budget d'etape :
 *       une etape interrompue est "INTERROMPUE (runtime)" et reprend EN
 *       PREMIER ; une etape de 121 s murales dont 101 s de panne n'est pas
 *       declaree "budget depasse" ;
 *   G3  aucun fichier de l'agent n'est ecrit dans le projet ; l'etat
 *       (jobs, specs, registre) vit dans le workspace hors projet ;
 *   G5  les nombres du plan (exigences, etapes) sont les MEMES a l'affichage,
 *       pendant l'execution et au bilan ; le hors perimetre n'est pas compte
 *       en echec.
 *
 * ASCII only. Lancer : node backend/tests/test-p63-agent.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'sudo-agent', 'src');

// G3: l'etat vit hors du projet. Les tests l'isolent dans un dossier
// temporaire dedie (jamais le vrai dossier utilisateur).
process.env.SUDO_AGENT_HOME = process.env.SUDO_AGENT_HOME ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'p63-home-'));
process.env.SUDO_AGENT_CTX_TOKENS = '32768';

const { runTurn } = require(path.join(SRC, 'loop.js'));
const { createLogger } = require(path.join(SRC, 'journal.js'));
const { SessionStore } = require(path.join(SRC, 'store.js'));
const job = require(path.join(SRC, 'job.js'));
const spec = require(path.join(SRC, 'spec.js'));
const stateDir = require(path.join(SRC, 'stateDir.js'));
const resume = require(path.join(SRC, 'resume.js'));
const calc = require(path.join(SRC, 'calc.js'));

let PASS = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { PASS += 1; console.log('ok - ' + name); }
  else { FAILS.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

const call = (name, args) => ({ toolCalls: [{ name, args: args || {} }] });
const text = (content) => ({ content });

// Faux fournisseur local : aucun modele reel, reponses scriptees, et la liste
// COMPLETE des appels recus (c'est notre preuve "aucun appel parent").
function mockProvider(responses, respond) {
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
        // P63: le scenario peut dependre du CONTENU (numero d'etape), sinon
        // l'ordre des reponses se desynchronise des essais du moteur.
        const promptText = String((body.messages || []).map((m) => String(m.content || '')).join('\n'));
        let next = null;
        if (typeof respond === 'function') next = respond(promptText, chats.length);
        if (!next) next = queue.length ? queue.shift() : { content: 'default-done' };
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((tc, i) => ({ id: 'call-' + chats.length + '-' + i,
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
    srv.listen(0, '127.0.0.1', () => resolve({
      server: srv, port: srv.address().port, chats,
      close: () => new Promise((r) => srv.close(() => r())),
    }));
  });
}

function createWorld(proj) {
  const home = tmp('p63home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 'p63', projectRoot: proj });
  const rules = new Map();
  rules.set(s.id, new Set());
  const w = { proj, home, logsDir, log, store, sessionId: s.id, rules, pending: new Map(), waiters: new Map(), seq: 0 };
  w.toolsCtx = () => ({ home, sessionRules: rules, pending: w.pending, waiters: w.waiters });
  w.allow = (...keys) => { for (const k of keys) rules.get(s.id).add(k); };
  w.turn = async (prompt, responses, opts) => {
    opts = opts || {};
    const mock = await mockProvider(responses, opts.respond);
    const events = [];
    const runs = new Map();
    try {
      w.seq += 1;
      const out = await runTurn({
        store, sessionId: s.id, prompt,
        corr: opts.corr || ('p63-' + w.seq),
        provider: { type: 'local', baseUrl: 'http://127.0.0.1:' + mock.port, model: 'mock-model' },
        toolsCtx: w.toolsCtx(), runs, log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} },
      });
      const end = store.get(s.id);
      return { out, end, events, chats: mock.chats, last: end.messages[end.messages.length - 1] };
    } finally {
      await mock.close();
    }
  };
  return w;
}

function fixtureProject() {
  const dir = tmp('p63proj');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p63' }), 'utf8');
  return dir;
}

// Un travail de N etapes, dont `done` deja faites, enregistre sur disque.
function seedJob(root, N, done) {
  const reqs = [];
  for (let i = 1; i <= N; i++) reqs.push({ id: 'R' + i, text: 'Exigence ' + i, section: 1 });
  const meta = { id: 'spec-' + Math.random().toString(36).slice(2, 8), title: 'Projet P63',
    requirements: reqs, sections: [{ n: 1, title: 'But' }], lines: 10 };
  const steps = [];
  for (let i = 0; i < N; i++) {
    steps.push({ i, section: 1, reqs: ['R' + (i + 1)], text: 'Creer le fichier f' + pad(i + 1) + '.txt', complex: false });
  }
  const st = job.create(root, meta, steps, {});
  for (let i = 0; i < done; i++) {
    const s = st.steps[i];
    s.status = 'done';
    s.detail = 'executee verifiee';
    s.files = ['f' + pad(i + 1) + '.txt'];
    st.coverage[i].status = 'fait';
    st.coverage[i].files = ['f' + pad(i + 1) + '.txt'];
    fs.writeFileSync(path.join(root, 'f' + pad(i + 1) + '.txt'), 'F' + (i + 1) + '\n');
  }
  // etat d'un travail interrompu (comme apres une coupure reelle)
  st.status = 'partial';
  st.runs = 1;
  job.save(root, st);
  return st;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Scenario d'etape : le modele ecrit fNN.txt puis declare done. Les etapes
// listees dans `fail` declarent done SANS rien ecrire (jamais une preuve).
function stepScenario(fail) {
  const seen = {};
  const bad = fail || [];
  return (promptText) => {
    const m = /(?:execute l etape|etape)\s+(\d+)\s*\/\s*(\d+)/i.exec(promptText);
    if (!m) return null;
    const n = Number(m[1]);
    seen[n] = (seen[n] || 0) + 1;
    if (seen[n] > 1) return call('done', { summary: 'etape ' + n + ' terminee' });
    if (bad.indexOf(n) !== -1) return call('done', { summary: 'rien fait' });
    return call('write', { file: 'f' + pad(n) + '.txt', content: 'F' + n + '\n' });
  };
}

function stepsResponses(from, to, opts) {
  opts = opts || {};
  const out = [];
  for (let i = from; i <= to; i++) {
    if (opts.fail && opts.fail.indexOf(i) !== -1) {
      // "done" sans aucune modification : jamais une preuve (P56-5).
      out.push(call('done', { summary: 'rien fait' }));
      continue;
    }
    out.push(call('write', { file: 'f' + pad(i) + '.txt', content: 'F' + i + '\n' }));
    out.push(call('done', { summary: 'etape ' + i }));
  }
  return out;
}

function allowSteps(N) {
  const out = [];
  for (let i = 1; i <= N; i++) out.push('write|file|f' + pad(i) + '.txt');
  return out;
}

async function main() {
  // ===================================================================== G1
  {
    const proj = fixtureProject();
    const st = seedJob(proj, 12, 4);
    const w = createWorld(proj);
    w.allow(...allowSteps(12));
    // Etapes 5 et 6 echouent (aucune modification) -> INCOMPLET, jamais TERMINE.
    const r = await w.turn('continu', [], { respond: stepScenario([5, 6]) });

    // "Aucun appel parent" : chaque appel recu porte une consigne d'ETAPE
    // ("Execute l etape n/N") et JAMAIS la conversation (le mot "continu").
    const parents = r.chats.filter((c) => {
      const all = String((c.messages || []).map((m) => String(m.content || '')).join('\n'));
      const isStepPrompt = /PROJET :/.test(all) && /ETAPE \d+\/\d+/.test(all);
      return !isStepPrompt || /(^|\n)continu\s*$/i.test(all);
    });
    check('G1-a: "continu" reprend le travail sans passer par le modele parent',
      r.chats.length > 0 && parents.length === 0,
      'appels: ' + r.chats.length + ' | appels parents: ' + parents.length);
    check('G1-b: le registre a bien ete consulte (l etape 5 a redemarre)',
      /Redemarrage a l etape 5/.test(String(r.end.messages.map((m) => m.content).join('\n'))),
      'transcript sans bandeau de reprise');
    check('G1-c: le travail a reparti de la 1re etape non faite (fichiers 5..12)',
      [5, 6, 7, 8, 9, 10, 11, 12].every((i) => fs.existsSync(path.join(proj, 'f' + pad(i) + '.txt'))) === false &&
      [7, 8, 9, 10, 11, 12].every((i) => fs.existsSync(path.join(proj, 'f' + pad(i) + '.txt'))),
      'fichiers presents : ' + fs.readdirSync(proj).join(','));
    const report = String(r.last.content || '');
    check('G1-d: jamais TERMINE quand une etape n est ni faite ni echouee',
      /^INCOMPLET \(travail \d+\/12\)/.test(report) && report.indexOf('TERMINE') === -1, report.slice(0, 120));
    check('G1-e: la reponse dit les 4 nombres (faites, echouees, interrompues, non tentees)',
      /\d+ faite\(s\), \d+ echouee\(s\), \d+ interrompue\(s\), \d+ non tentee\(s\)/.test(report),
      report.split('\n').slice(0, 3).join(' | '));
    check('G1-f: le statut rendu est PARTIEL, pas TERMINE',
      r.out.runStatus === 'PARTIEL', String(r.out.runStatus));
    const stAfter = job.load(proj, st.id);
    check('G1-g: 3 essais par etape sans progres puis etape suivante (etape 5 echouee avec raison)',
      stAfter.steps[4].status === 'failed' && stAfter.steps[4].attempts === job.delays().attempts &&
      !!String(stAfter.steps[4].detail || '').length,
      JSON.stringify({ status: stAfter.steps[4].status, attempts: stAfter.steps[4].attempts,
        detail: String(stAfter.steps[4].detail || '').slice(0, 80) }));
    const dispatched = r.events.filter((e) => e.type === 'job.step' &&
      !/^deja /.test(String(e.detail || '')) && e.status !== 'done').map((e) => e.n);
    check('G1-h: les etapes faites avant la coupure ne sont pas rejouees',
      [1, 2, 3, 4].every((n) => dispatched.indexOf(n) === -1) &&
      !r.chats.some((c) => /"file":"f0[1-4]\.txt"/.test(JSON.stringify(c.messages))),
      'etapes dispatchees: ' + dispatched.join(','));

    // G1 variante : "continu" sans travail inacheve -> reponse deterministe.
    const w2 = createWorld(fixtureProject());
    const r2 = await w2.turn('continu', []);
    check('G1-i: "continu" sans travail inacheve ne fait aucun appel modele',
      r2.chats.length === 0, 'appels: ' + r2.chats.length);
    check('G1-j: et le dit clairement',
      /Aucun travail inacheve/i.test(String(r2.last.content || '')), String(r2.last.content || '').slice(0, 90));
  }

  // ===================================================================== G2
  {
    // 2a. invariants des delais : aucun delai interne plus court que celui
    // qu'il couvre.
    const d = job.delays();
    check('G2-a: le budget ACTIF d une etape couvre l attente runtime (>= 180 s)',
      d.stepActiveMs >= d.runtimeWaitMs && d.runtimeWaitMs >= 180000,
      JSON.stringify(d));
    check('G2-b: le budget total couvre une etape', d.jobTotalMs >= d.stepActiveMs, JSON.stringify(d));
    // et un reglage incoherent est corrige vers le haut, jamais vers le bas.
    process.env.SUDO_AGENT_STEP_ACTIVE_MS = '1000';
    const d2 = job.delays();
    delete process.env.SUDO_AGENT_STEP_ACTIVE_MS;
    check('G2-c: un reglage incoherent (etape < attente) est corrige vers le haut',
      d2.stepActiveMs === d2.runtimeWaitMs, JSON.stringify(d2));

    // 2d. etape interrompue par une panne runtime de 150 s : statut dedie,
    // pas "budget temps depasse", et reprise EN PREMIER.
    const proj = tmp('p63g2');
    const st = seedJob(proj, 4, 0);
    const order = [];
    const runStep = async (step, ctx) => {
      order.push(ctx.n);
      if (ctx.n === 2) {
        return { ok: false, interruptedByRuntime: true, runtimeDownMs: 150000, files: [],
          error: 'runtime indisponible pendant l etape' };
      }
      const rel = 'f' + pad(ctx.n) + '.txt';
      fs.writeFileSync(path.join(proj, rel), 'F' + ctx.n + '\n');
      return { ok: true, files: [rel], declared: true, runtimeDownMs: 0 };
    };
    const res = await job.run({ root: proj, state: st, runStep });
    const st2 = job.load(proj, st.id);
    const s2 = st2.steps[1];
    check('G2-d: une etape coupee par le runtime est "INTERROMPUE (runtime)", jamais "budget depasse"',
      s2.status === 'interrupted_runtime' && /INTERROMPUE \(runtime\)/.test(String(s2.detail)) &&
      !/budget temps/i.test(String(s2.detail)),
      JSON.stringify({ status: s2.status, detail: String(s2.detail || '').slice(0, 120) }));
    check('G2-e: la panne de 150 s n est pas comptee comme du travail (activeMs ~ 0)',
      Number(s2.activeMs) === 0 && Number(s2.runtimeDownMs) === 150000,
      JSON.stringify({ activeMs: s2.activeMs, down: s2.runtimeDownMs }));
    check('G2-f: le bilan dit INCOMPLET, pas TERMINE',
      /^INCOMPLET \(travail /.test(String(res.report)) && res.interrupted === 1,
      String(res.report).split('\n')[0]);
    check('G2-g: 150 s de panne n a pas fait echouer l etape (elle est reprise)',
      res.failed === 0, 'failed=' + res.failed);

    // 2e. une etape de 121 s MURALES dont 101 s de panne : 20 s actives, pas
    // de "budget depasse" (l'ancien comportement : 121 s > 120 s -> echec).
    const proj2 = tmp('p63g2b');
    const stB = seedJob(proj2, 2, 0);
    const resB = await job.run({ root: proj2, state: stB, runStep: async (step, ctx) => {
      if (ctx.n === 1) {
        await new Promise((r) => setTimeout(r, 60));
        const rel = 'f01.txt';
        fs.writeFileSync(path.join(proj2, rel), 'F1\n');
        return { ok: true, files: [rel], declared: true, runtimeDownMs: 120000 };
      }
      const rel = 'f02.txt';
      fs.writeFileSync(path.join(proj2, rel), 'F2\n');
      return { ok: true, files: [rel], declared: true };
    } });
    const stB2 = job.load(proj2, stB.id);
    check('G2-h: 121 s murales dont 120 s de panne = etape FAITE (budget actif)',
      stB2.steps[0].status === 'done' && !/budget/i.test(String(stB2.steps[0].detail || '')),
      JSON.stringify({ status: stB2.steps[0].status, ms: stB2.steps[0].ms, active: stB2.steps[0].activeMs,
        detail: String(stB2.steps[0].detail || '').slice(0, 80) }));
    check('G2-i: et le travail est TERMINE (2/2)', resB.done === 2, JSON.stringify(resB).slice(0, 120));
  }

  // ===================================================================== G3
  {
    const proj = fixtureProject();
    const before = fs.readdirSync(proj).sort().join(',');
    const st = seedJob(proj, 3, 0);
    const res = await job.run({ root: proj, state: st, runStep: async (step, ctx) => {
      const rel = 'f' + pad(ctx.n) + '.txt';
      fs.writeFileSync(path.join(proj, rel), 'F' + ctx.n + '\n');
      return { ok: true, files: [rel], declared: true };
    } });
    const after = fs.readdirSync(proj).filter((f) => /^(f\d\d\.txt)$/.test(f) === false).sort().join(',');
    check('G3-a: aucun dossier/fichier d agent cree dans le projet',
      after === before && !fs.existsSync(path.join(proj, '.sudo-agent')) &&
      !fs.existsSync(path.join(proj, '.sudo_studio')),
      'avant: ' + before + ' | apres: ' + after);
    const p = stateDir.paths(proj);
    check('G3-b: l etat (jobs, specs, registre) vit dans le workspace hors projet',
      fs.existsSync(p.jobs) && String(p.root).indexOf(proj) === -1,
      p.jobs);
    check('G3-c: le chemin du workspace porte l empreinte du projet',
      String(p.root).indexOf(stateDir.fingerprint(proj)) !== -1, p.root);
    check('G3-d: les jobs du projet sont bien ceux du workspace',
      fs.readdirSync(p.jobs).some((f) => f.indexOf(st.id) !== -1), fs.readdirSync(p.jobs).join(','));
    check('G3-e: le travail est fait DANS le dossier du projet',
      res.done === 3 && fs.existsSync(path.join(proj, 'f01.txt')), JSON.stringify(res).slice(0, 120));
    // migration : un .sudo-agent existant n'est jamais deplace sans accord.
    const legacyRoot = tmp('p63legacy');
    fs.mkdirSync(path.join(legacyRoot, '.sudo-agent', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, '.sudo-agent', 'jobs', 'job-x.json'), '{}');
    const det = stateDir.detectLegacy(legacyRoot);
    const migNo = stateDir.migrateLegacy(legacyRoot, false);
    check('G3-f: un .sudo-agent existant est DETECTE mais pas deplace sans approbation',
      det.present === true && migNo.ok === false && migNo.needsApproval === true &&
      fs.existsSync(path.join(legacyRoot, '.sudo-agent')),
      JSON.stringify(migNo).slice(0, 160));
    const migYes = stateDir.migrateLegacy(legacyRoot, true);
    check('G3-g: avec approbation il est migre hors du projet',
      migYes.ok === true && !fs.existsSync(path.join(legacyRoot, '.sudo-agent')) &&
      fs.existsSync(path.join(stateDir.paths(legacyRoot).jobs, 'job-x.json')),
      JSON.stringify(migYes).slice(0, 160));
  }

  // ===================================================================== G5
  {
    const proj = tmp('p63g5');
    const brief = '# Cahier des charges\n\n## 1. Objectif\nLivrer un produit.\n\n' +
      '- Exigence 1 : creer le module a.\n- Exigence 2 : creer le module b.\n' +
      '- Exigence 3 : publier sur le Play Store.\n';
    const meta = spec.ingest(proj, brief, {});
    const pm = spec.planWithMeta(meta);
    const planTxt = spec.planText(meta, pm.steps, pm);
    const st = job.create(proj, meta, pm.steps, {});
    const shown = Number((planTxt.match(/(\d+) etape\(s\) a executer/) || [])[1]);
    check('G5-a: le nombre d etapes affiche est celui du plan execute',
      shown === st.steps.filter((s) => s.kind !== 'out-of-scope').length && shown === pm.kept,
      JSON.stringify({ affiche: shown, execute: st.steps.length, kept: pm.kept, total: pm.total }));
    check('G5-b: le plan annonce toutes les exigences (perimetre + hors perimetre)',
      planTxt.indexOf(String(meta.requirements.length)) !== -1,
      planTxt.split('\n').slice(0, 3).join(' | '));
    check('G5-c: une exigence hors perimetre est DITE, pas comptee en etape de travail',
      pm.outOfScope.length === 1 && st.steps.filter((s) => s.kind === 'out-of-scope').length === 1,
      JSON.stringify(pm.outOfScope));
    const res = await job.run({ root: proj, state: st, runStep: async (step, ctx) => {
      const rel = 'a' + ctx.n + '.txt';
      fs.writeFileSync(path.join(proj, rel), 'A' + ctx.n + '\n');
      return { ok: true, files: [rel], declared: true };
    } });
    check('G5-d: le hors perimetre n est ni execute ni compte en echec',
      res.done === pm.kept && res.failed === 0 && res.outOfScope === 1,
      JSON.stringify({ done: res.done, failed: res.failed, oos: res.outOfScope, kept: pm.kept }));
    check('G5-e: le bilan affiche le meme total que le plan (TERMINE travail 1/1, hors perimetre a part)',
      /^TERMINE \(travail 1\/1\)/.test(String(res.report)) && /1 hors perimetre/i.test(String(res.report)),
      String(res.report).split('\n').slice(0, 2).join(' | '));
  }

  // ===================================================================== C ui
  {
    check('C-ui: le libelle du bouton est "Reprendre le travail"',
      resume.buttonLabel() === 'Reprendre le travail', resume.buttonLabel());
    const kw = ['continu', 'continue', 'reprends', 'poursuis', 'vas-y', 'on continue', 'ok continue', 'resume'];
    check('C-ui: les 8 mots cles sont reconnus (ponctuation toleree)',
      kw.every((k) => resume.isResumeIntent(k) && resume.isResumeIntent(' ' + k + ' !')),
      kw.filter((k) => !resume.isResumeIntent(k)).join(','));
    check('C-ui: une phrase contenant le mot ne declenche PAS la reprise deterministe',
      !resume.isResumeIntent('continue d ecrire le rapport') &&
      !resume.isResumeIntent('reprends le fichier a.txt'), 'faux positif');
  }

  // ============================================ P4 budget total (horloge simulee)
  {
    const proj = tmp('p63budget');
    const meta = { id: 'spec-bud', title: 'Budget', lines: 3, sections: [{ n: 1, title: 'B' }],
      requirements: [1, 2, 3, 4, 5].map((n) => ({ id: 'R' + n, text: 'e' + n, section: 1 })) };
    const steps = [0, 1, 2, 3, 4].map((i) => ({ i, section: 1, reqs: ['R' + (i + 1)],
      text: 'Creer b' + i + '.txt', complex: false }));
    const st = job.create(proj, meta, steps, {});
    // Horloge SIMULEE : 1 h par etape, budget total 2 h -> arret apres 3 etapes.
    let clock = 1000000;
    const before = process.env.SUDO_AGENT_JOB_TOTAL_MS;
    process.env.SUDO_AGENT_JOB_TOTAL_MS = String(2 * 3600 * 1000);
    const res = await job.run({ root: proj, state: st, now: () => clock,
      runStep: async (step, ctx) => {
        clock += 3600 * 1000;
        const rel = 'b' + ctx.n + '.txt';
        fs.writeFileSync(path.join(proj, rel), 'B' + ctx.n + '\n');
        return { ok: true, files: [rel], declared: true };
      } });
    const stB = job.load(proj, st.id);
    const rep = String(res.report || '');
    check('P4-a: budget total atteint -> arret PROPRE, aucune etape comptee en echec',
      res.failed === 0 && res.done === 3 && res.skipped === 2,
      JSON.stringify({ done: res.done, failed: res.failed, skipped: res.skipped }));
    check('P4-b: le bilan dit INCOMPLET (x/N), jamais un echec',
      /^INCOMPLET \(travail 3\/5\)/.test(rep) && /budget total atteint/i.test(rep), rep.split('\n')[0]);
    check('P4-c: le statut du travail est resumable (incomplete)',
      stB.status === 'incomplete' && stB.budgetHit === true, String(stB.status));
    check('P4-d: les etapes non tentees restent EN PLACE et la reprise est possible',
      stB.steps[3].status === 'pending' && !!job.unfinished(proj) && job.unfinished(proj).next === 3,
      JSON.stringify({ s4: stB.steps[3].status, next: job.unfinished(proj) && job.unfinished(proj).next }));
    check('P4-e: le delai total est configurable (defaut 6 h, 0 = illimite)',
      job.DELAYS.jobTotalMs === 21600000, String(job.DELAYS.jobTotalMs));
    if (before === undefined) delete process.env.SUDO_AGENT_JOB_TOTAL_MS;
    else process.env.SUDO_AGENT_JOB_TOTAL_MS = before;
    const d0 = job.delays();
    process.env.SUDO_AGENT_JOB_TOTAL_MS = '0';
    const dz = job.delays();
    if (before === undefined) delete process.env.SUDO_AGENT_JOB_TOTAL_MS;
    else process.env.SUDO_AGENT_JOB_TOTAL_MS = before;
    check('P4-f: 0 = aucune limite totale (reglage explicite)',
      dz.jobTotalMs === 0 && dz.unlimited === true && d0.jobTotalMs === 21600000,
      JSON.stringify({ zero: dz.jobTotalMs, defaut: d0.jobTotalMs }));
    // Reprise reelle apres l arret budget : "continu" finit le travail.
    const w = createWorld(proj);
    w.allow(...[1, 2, 3, 4, 5].map((i) => 'write|file|b' + i + '.txt'));
    const r4 = await w.turn('continu', [], { respond: (promptText) => {
      const m = /(?:execute l etape|etape)\s+(\d+)\s*\/\s*(\d+)/i.exec(promptText);
      if (!m) return null;
      const n = Number(m[1]);
      return call('write', { file: 'b' + n + '.txt', content: 'B' + n + '\n' });
    } });
    check('P4-g: "continu" apres un arret budget reprend a la 1re etape non faite',
      /Redemarrage a l etape 4/.test(String(r4.end.messages.map((m) => m.content).join('\n'))),
      String(r4.last.content || '').slice(0, 80));
  }

  // ===================== P5/P6 emplacement UNIQUE de l etat + migration
  {
    const h = tmp('p63home2');
    const canon = stateDir.agentHome({ home: h });
    fs.mkdirSync(path.join(h, '.sudo_studio', 'agent', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(h, '.sudo_studio', 'agent', 'sessions', 'vieux.json'), '{}');
    check('P6-a: un ancien dossier present ne change PLUS l emplacement utilise',
      stateDir.agentHome({ home: h }) === canon && canon.indexOf('.sudo_studio') === -1, canon);
    const det = stateDir.detectLegacyHome({ home: h });
    check('P6-b: l ancien dossier est DETECTE (pour proposer la migration)',
      det.present === true && det.entries.indexOf('sessions') !== -1, JSON.stringify(det.entries));
    const no = stateDir.migrateHome(false, { home: h });
    check('P6-c: sans accord explicite, rien n est deplace',
      no.ok === false && no.needsApproval === true &&
      fs.existsSync(path.join(h, '.sudo_studio', 'agent', 'sessions', 'vieux.json')),
      JSON.stringify(no).slice(0, 120));
    const yes = stateDir.migrateHome(true, { home: h });
    check('P6-d: avec accord, l ancien emplacement est migre vers l emplacement unique',
      yes.ok === true && yes.moved >= 1 &&
      fs.existsSync(path.join(canon, 'sessions', 'vieux.json')),
      JSON.stringify(yes).slice(0, 160));
    check('P6-e: le dossier historique vide est retire (plus deux emplacements)',
      yes.removed === true && !fs.existsSync(path.join(h, '.sudo_studio', 'agent')),
      String(yes.removed));
  }

  // ============================================================ F-18 calcul
  {
    check('F18-a: "2 + 298" est calcule sans modele (resultat 300)',
      calc.answer('2 + 298') === '300', String(calc.answer('2 + 298')));
    check('F18-b: une expression non arithmetique n est pas prise pour un calcul',
      calc.isCalc('creer un fichier') === false && calc.answer('bonjour') === null, 'faux positif');
    const w3 = createWorld(fixtureProject());
    const r3 = await w3.turn('2 + 298', []);
    check('F18-c: la question part sans aucun appel modele et la reponse est juste',
      r3.chats.length === 0 && /300/.test(String(r3.last.content || '')),
      'appels: ' + r3.chats.length + ' | ' + String(r3.last.content || '').slice(0, 60));
  }

  console.log('\nP63: ' + PASS + ' checks passed' + (FAILS.length ? ', ' + FAILS.length + ' FAILED' : ' (all green)'));
  FAILS.forEach((f) => console.log('  - ' + f));
  process.exit(FAILS.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
