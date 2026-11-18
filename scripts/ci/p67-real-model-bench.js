/**
 * SUDO STUDIO - P67: banc "MODELE REEL" (aucun faux fournisseur).
 *
 * But: reproduire et INSTRUMENTER, avec le vrai petit modele
 * (Qwen2.5-Coder-1.5B-Instruct Q4_K_M, Apache-2.0), les echecs observes sur PC
 * le 17/11/2026 (session 1d1499cffb9262b6, agent.log):
 *   E1 6 appels modele, 6 rejets d'appel d'outil, 0 outil execute
 *   E2 format de secours "FICHIER:" -> files=0
 *   E3 cout: jetons de prompt reels contre budget annonce
 *
 * Ce script ne corrige RIEN. Il mesure et il ecrit des faits:
 *   - par tache: reponse finale, outils reellement executes, appels modele,
 *     jetons de prompt et de generation, duree, verdict;
 *   - par rejet d'appel d'outil: la ligne de rejet du runtime (sortie brute
 *     debut/fin, finish_reason, jetons generes, raison exacte) et la ligne
 *     [GRAMMAR] qui dit si le decodage contraint a ete APPLIQUE;
 *   - le budget annonce par l'agent contre les jetons reellement comptes.
 *
 * Usage:
 *   node scripts/ci/p67-real-model-bench.js --url http://127.0.0.1:6000 \
 *        --model <id> --out <dossier> [--only a,b,c,d]
 *
 * ASCII only. Node stdlib only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const { runTurn, resolveTurnApproval } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const URL_BASE = arg('url', '');
const MODEL = arg('model', 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf');
const OUT = arg('out', path.join(ROOT, 'p67-results'));
const ONLY = arg('only', '');

if (!URL_BASE) {
  console.error('ERREUR: --url <baseUrl OpenAI-compatible> obligatoire (modele reel).');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

// ---------------------------------------------------------------------------
// Projet d'essai: un faux secret (pour l'audit) + une couleur (pour le diff).
// ---------------------------------------------------------------------------
function makeProject() {
  const proj = tmp('p67proj');
  const files = {
    'app.py': 'import os\n\nAPI_KEY = "sk-test-1234567890abcdef"\n\n\ndef main():\n    print("bonjour")\n',
    'style.css': ':root {\n  --primary: #3366cc;\n}\n\nbody { color: #222; }\n',
    'README.md': '# Projet de test P67\n\nPetit projet pour le banc modele reel.\n',
    '.gitignore': 'node_modules\n__pycache__\n',
  };
  for (const rel of Object.keys(files)) {
    const full = path.join(proj, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return proj;
}

function git(proj, args) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('git', args, { cwd: proj, stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Un tour complet du VRAI agent contre le VRAI modele.
// ---------------------------------------------------------------------------
async function turn(world, prompt, opts) {
  opts = opts || {};
  const events = [];
  const t0 = Date.now();
  world.seq += 1;
  const p = runTurn({
    store: world.store,
    sessionId: world.sessionId,
    prompt,
    corr: 'p67-' + world.seq,
    provider: { type: 'local', baseUrl: URL_BASE, model: MODEL },
    toolsCtx: world.toolsCtx(),
    runs: new Map(),
    log: world.log,
    onEvent: (e) => { try { events.push(e); } catch (_) {} },
    maxIt: opts.maxIt || 6,
  });
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  const limit = opts.waitMs || 900000;
  let approved = 0;
  while (!settled && Date.now() - t0 < limit) {
    for (const id of Array.from(world.waiters.keys())) {
      try { resolveTurnApproval(world.toolsCtx(), id, 'allow'); approved += 1; } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  let out = null;
  let error = null;
  try { out = await p; } catch (e) { error = String((e && e.message) || e); }
  const ms = Date.now() - t0;
  const end = world.store.get(world.sessionId);
  const lastRun = (end && end.meta && end.meta.lastRun) || {};
  return {
    out, error, ms, approved, events,
    calls: Array.isArray(lastRun.calls) ? lastRun.calls : [],
    messages: (end && end.messages) || [],
  };
}

function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.content) return String(m.content);
  }
  return '';
}

function countLines(text, needle) {
  return String(text || '').split('\n').filter((l) => l.indexOf(needle) !== -1);
}

// ---------------------------------------------------------------------------
// Taches du prompt 67 (a a d)
// ---------------------------------------------------------------------------
const TASKS = [
  {
    id: 'a',
    prompt: '1+1 font combien',
    check: (r) => {
      const answer = lastAssistant(r.messages);
      const noTool = r.calls.length === 0;
      const says2 = /(^|[^0-9])2([^0-9]|$)/.test(answer);
      return { pass: noTool && says2, detail: 'outils=' + r.calls.length + ' reponse=' + JSON.stringify(answer.slice(0, 120)) };
    },
  },
  {
    id: 'b',
    prompt: 'Cree un fichier test.txt contenant bonjour',
    check: (r, world) => {
      const exists = world.exists('test.txt');
      const content = exists ? String(world.read('test.txt') || '') : '';
      return { pass: exists && /bonjour/i.test(content), detail: 'existe=' + exists + ' contenu=' + JSON.stringify(content.slice(0, 80)) };
    },
  },
  {
    id: 'c',
    prompt: "utilise l'audit de securite pour detecter les soucis et corriger les majeurs",
    check: (r) => {
      const answer = lastAssistant(r.messages);
      const explicit = /(score|faille|secret|aucun|aucune|corrig)/i.test(answer);
      return { pass: explicit && r.calls.length > 0, detail: 'outils=' + r.calls.length + ' reponse=' + JSON.stringify(answer.slice(0, 160)) };
    },
  },
  {
    id: 'd',
    prompt: 'Change la couleur principale en vert',
    check: (r, world) => {
      const css = String(world.read('style.css') || '');
      // Vert = le mot, ou un hexadecimal dont la composante verte domine
      // (le correctif deterministe ecrit #22c55e : mon ancien motif ne
      // l'acceptait pas, defaut de MESURE, pas du produit).
      const hex = /--primary:\s*#([0-9a-f]{6})\b/i.exec(css);
      let isGreen = /--primary:\s*(green|vert)\b/i.test(css);
      if (hex) {
        const r = parseInt(hex[1].slice(0, 2), 16), g = parseInt(hex[1].slice(2, 4), 16), b = parseInt(hex[1].slice(4, 6), 16);
        isGreen = isGreen || (g > r && g > b);
      }
      return { pass: isGreen, detail: 'style.css=' + JSON.stringify(css.replace(/\s+/g, ' ').slice(0, 120)) };
    },
  },
];

async function runTask(t, world) {
  // Mesure PAR TACHE : on repart d'un journal vide, sinon les compteurs
  // cumulent les tours precedents (defaut de mesure, pas de produit).
  try { fs.writeFileSync(path.join(world.logsDir, 'agent.log'), ''); } catch (_) {}
  let r = await turn(world, t.prompt, { maxIt: 6 });
  // Garde de reprise : apres une tache inachevee, le tour suivant repond
  // "REPRENDRE ou ABANDONNER". Le banc tranche (ABANDONNER) pour mesurer la
  // tache demandee, et le dit dans le rapport.
  const last = lastAssistant(r.messages);
  let abandoned = false;
  if (/REPRENDRE/.test(last) && /ABANDONNER/.test(last)) {
    abandoned = true;
    try { fs.writeFileSync(path.join(world.logsDir, 'agent.log'), ''); } catch (_) {}
    r = await turn(world, 'ABANDONNER', { maxIt: 2 });
  }
  const v = t.check(r, world);
  const journal = SAFE_JOURNAL();
  const chatLines = countLines(journal, 'appel modele');
  const rejectLines = countLines(journal, 'appel outil invalide');
  const fallbackLines = countLines(journal, 'format de secours');
  const tokensPrompt = chatLines.map((l) => {
    const m = /jetonsPrompt"?[:=]\s*(\d+)/.exec(l);
    return m ? Number(m[1]) : 0;
  });
  const tokensGen = chatLines.map((l) => {
    const m = /jetonsGeneres"?[:=]\s*(\d+)/.exec(l);
    return m ? Number(m[1]) : 0;
  });
  return {
    id: t.id,
    prompt: t.prompt,
    pass: !!v.pass,
    detail: v.detail,
    ms: r.ms,
    error: r.error,
    modelCalls: chatLines.length,
    tokensPrompt,
    tokensGen,
    toolsExecuted: r.calls.map((c) => (c && (c.name || c.tool)) || '?'),
    rejections: rejectLines.slice(-3),
    fallbacks: fallbackLines.slice(-3),
    finalAnswer: lastAssistant(r.messages).slice(0, 400),
    abandonedResumeGuard: abandoned,
    events: r.events.filter((e) => /runtime|approval|step/.test(String(e && e.type))).slice(-6),
  };
}

let world = null;
function SAFE_JOURNAL() {
  try { return fs.readFileSync(path.join(world.logsDir, 'agent.log'), 'utf8'); }
  catch (_) { return ''; }
}

(async () => {
  const proj = makeProject();
  git(proj, ['init']);
  git(proj, ['config', 'user.email', 'p67@local']);
  git(proj, ['config', 'user.name', 'P67']);
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-m', 'fixture P67']);
  const home = tmp('p67home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 'p67', projectRoot: proj });
  const rules = new Map();
  rules.set(s.id, new Set());
  world = {
    proj, home, logsDir, log, store, sessionId: s.id, rules,
    pending: new Map(), waiters: new Map(), seq: 0,
    toolsCtx: () => ({ home, sessionRules: rules, pending: world.pending, waiters: world.waiters }),
    read: (rel) => { try { return fs.readFileSync(path.join(proj, rel), 'utf8'); } catch (_) { return null; } },
    exists: (rel) => fs.existsSync(path.join(proj, rel)),
  };

  const wanted = ONLY ? ONLY.split(',').map((x) => x.trim()) : TASKS.map((t) => t.id);
  const results = [];
  for (const t of TASKS) {
    if (wanted.indexOf(t.id) === -1) continue;
    process.stdout.write('\n=== TACHE ' + t.id + ': ' + t.prompt + '\n');
    let r;
    try { r = await runTask(t, world); }
    catch (e) { r = { id: t.id, pass: false, error: String((e && e.message) || e), detail: 'exception' }; }
    results.push(r);
    process.stdout.write('PASS=' + r.pass + ' | ' + r.detail + '\n');
    if (r.error) process.stdout.write('ERREUR=' + String(r.error).slice(0, 300) + '\n');
    process.stdout.write('appels modele=' + r.modelCalls + ' jetonsPrompt=' + JSON.stringify(r.tokensPrompt || []) +
      ' jetonsGeneres=' + JSON.stringify(r.tokensGen || []) + ' duree=' + Math.round((r.ms || 0) / 1000) + 's\n');
    if (r.rejections && r.rejections.length) {
      for (const l of r.rejections) process.stdout.write('REJET: ' + l.slice(0, 400) + '\n');
    }
  }

  const journal = SAFE_JOURNAL();
  const grammar = countLines(journal, '[GRAMMAR]');
  const report = {
    date: new Date().toISOString(),
    baseUrl: URL_BASE,
    model: MODEL,
    node: process.version,
    tasks: results,
    grammarLines: grammar.slice(-6),
    pass: results.filter((r) => r.pass).length,
    total: results.length,
  };
  fs.writeFileSync(path.join(OUT, 'p67-real-model.json'), JSON.stringify(report, null, 2));
  try { fs.copyFileSync(path.join(logsDir, 'agent.log'), path.join(OUT, 'agent.log')); } catch (_) {}
  process.stdout.write('\nTOTAL: ' + report.pass + '/' + report.total + ' taches reussies avec le vrai modele\n');
  process.exit(0);
})().catch((e) => {
  console.error('ECHEC BANC: ' + ((e && e.stack) || e));
  process.exit(1);
});
