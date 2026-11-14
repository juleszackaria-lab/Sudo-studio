/**
 * job.js - P56-2/4/5/6: a SPEC becomes a JOB = a plan of steps that covers
 * numbered requirements, with state on DISK and a real RESUM E.
 *
 * Differences with the P52 orchestrator (orch.js), which stays as it is:
 *   - each step CITES the requirements it covers (reqs: ['R3','R4']);
 *   - the step context is built here: objective + the useful SPEC section +
 *     the files already touched + a TWO LINE summary of previous steps;
 *   - coverage is accumulated per requirement (files / test / status) and
 *     turned into the final honest table;
 *   - the state file (<workspace hors projet>/jobs/job-<id>.json) records attempts,
 *     calls, duration, status, files, tests and a journal, so a stop, a crash,
 *     a runtime restart or a panel close resumes EXACTLY where it stopped;
 *   - per-step and global budgets (calls + time) bound the run;
 *   - a step that fails N times is marked "non realisee" and the run continues
 *     (the other steps are not punished for it);
 *   - each step may carry its own model (P56-6 policy), applied by the loop.
 *
 * Pure Node + fs, ASCII-only, never throws at the caller.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const spec = require('./spec');
const stepcheck = require('./stepcheck');
const stateDir = require('./stateDir'); // P63-D : etat hors du projet

const VERSION = 1;
const DEFAULT_STEP_ATTEMPTS = 2;

// P63-D: plus AUCUN fichier de l'agent dans le projet. Les travaux vivent
// dans le workspace hors projet (stateDir), comme les cahiers des charges.
function jobsDir(root) { return stateDir.paths(root).jobs; }
function jobPath(root, id) {
  return path.join(jobsDir(root), 'job-' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');
}

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
// P63-B: trois delais, un seul endroit, des invariants verifiables.
//   runtimeWaitMs : attente maximale du runtime quand il tombe (180 s) ;
//   stepActiveMs  : duree ACTIVE d'une etape, temps de panne runtime EXCLU ;
//   jobTotalMs    : duree totale du travail (toutes etapes).
// Regle : aucun delai interne ne peut etre plus court que celui qu'il couvre.
//   stepActiveMs >= runtimeWaitMs (une etape interrompue par le runtime doit
//   pouvoir attendre sa reprise sans etre declaree "depassee").
//   jobTotalMs >= stepActiveMs.
const DELAYS = {
  runtimeWaitMs: 180000,
  stepActiveMs: 300000,
  jobTotalMs: 3600000,
  attempts: 3,
};

function delays() {
  const d = {
    runtimeWaitMs: intEnv('SUDO_AGENT_RUNTIME_WAIT_MS', DELAYS.runtimeWaitMs),
    stepActiveMs: intEnv('SUDO_AGENT_STEP_ACTIVE_MS', DELAYS.stepActiveMs),
    jobTotalMs: intEnv('SUDO_AGENT_JOB_TOTAL_MS', DELAYS.jobTotalMs),
    attempts: intEnv('SUDO_AGENT_STEP_ATTEMPTS', DELAYS.attempts),
  };
  // Invariants : on CORRIGE vers le haut, jamais vers le bas (aucune etape ne
  // peut etre plus courte que l'attente runtime qu'elle est censee couvrir).
  if (d.stepActiveMs < d.runtimeWaitMs) d.stepActiveMs = d.runtimeWaitMs;
  if (d.jobTotalMs < d.stepActiveMs) d.jobTotalMs = d.stepActiveMs;
  d.coherent = true;
  return d;
}

function budgets() {
  const d = delays();
  return {
    stepCalls: intEnv('SUDO_AGENT_STEP_CALLS', 8),
    // compat : les appelants historiques lisent stepMs/jobMs.
    stepMs: d.stepActiveMs,
    jobMs: d.jobTotalMs,
    stepActiveMs: d.stepActiveMs,
    runtimeWaitMs: d.runtimeWaitMs,
    jobTotalMs: d.jobTotalMs,
    attempts: d.attempts,
    // P62-F2: jamais plus de 60 % de n_ctx par appel sur un cahier des charges.
    ctxShare: 0.60,
    // P62-F7: 6 outils exposes au maximum par etape (petits modeles).
    toolsLimit: intEnv('SUDO_AGENT_SPEC_TOOLS', 6),
  };
}

// P62-F1: un cahier est estime en jetons AVANT tout envoi. S'il depasse la
// moitie du contexte, il n'est JAMAIS transmis en entier : seules les
// sections utiles le sont (deja le cas), et on le journalise.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// P62-F7: petits modeles, peu d'outils. Une etape de cahier des charges ne
// voit qu'un jeu COURTE (6 au plus) choisi par ce qu'elle doit faire, au lieu
// des 31 outils de la surface complete. reply/done restent toujours la (le
// moteur les ajoute) : un tour peut donc toujours se terminer honnetement.
const STEP_TOOLS_BASE = ['read', 'list', 'grep'];
const STEP_TOOLS_WRITE = ['write', 'edit', 'exec_start'];

function toolSubsetFor(step, limit) {
  const max = Number(limit) > 0 ? Number(limit) : 6;
  const wantsWrite = !step || step.kind !== 'verify';
  const list = STEP_TOOLS_BASE.concat(wantsWrite ? STEP_TOOLS_WRITE : []);
  const out = [];
  for (const t of list) { if (out.indexOf(t) === -1) out.push(t); }
  return out.slice(0, Math.max(3, max));
}

function specPolicy(specMeta, nCtx) {
  const ctx = Number(nCtx) > 0 ? Number(nCtx) : 8192;
  const toks = estimateTokens(specMeta && (specMeta.chars ? ' '.repeat(specMeta.chars) : ''));
  const specTokens = Number(specMeta && specMeta.chars) > 0 ? Math.ceil(Number(specMeta.chars) / 4) : toks;
  const share = specTokens / ctx;
  return {
    nCtx: ctx,
    specTokens,
    share: Math.round(share * 1000) / 1000,
    wholeDocumentForbidden: share > 0.5,
    callBudgetChars: Math.floor(ctx * 0.60 * 4),
  };
}

// ---------------------------------------------------------------------------
// Model policy (P56-6): a step can run on another model when the policy allows
// it AND that model is actually available on the current provider.
// ---------------------------------------------------------------------------
function pickModel(step, policy, available) {
  const p = policy || {};
  const avail = Array.isArray(available) ? available.map(String) : [];
  if (!avail.length) return null;
  const want = step && step.complex ? p.complex : p.small;
  if (!want) return null;
  const hit = avail.find((m) => m === want) || avail.find((m) => m.indexOf(want) !== -1);
  return hit || null;
}

// ---------------------------------------------------------------------------
// Create / load / save
// ---------------------------------------------------------------------------
function freshState(id, specMeta, steps, opts) {
  const o = opts || {};
  return {
    v: VERSION,
    id,
    specId: specMeta.id,
    title: specMeta.title,
    createdAt: new Date().toISOString(),
    updated: new Date().toISOString(),
    runs: 0,
    status: 'proposed', // proposed -> running -> done | partial | failed | stopped
    budgets: budgets(),
    specPolicy: o.specPolicy || null, // P62-F1 : estimation + interdiction du document entier
    modelPolicy: o.modelPolicy || null,
    steps: steps.map((s) => ({
      i: s.i, text: s.text, reqs: s.reqs || [], section: s.section || 1,
      complex: !!s.complex, model: s.model || null,
      kind: s.kind || 'work', // P63-E14 : 'out-of-scope' n'est pas executee
      status: 'pending', attempts: 0, calls: 0, ms: 0, detail: '', files: [], test: null,
    })),
    coverage: (specMeta.requirements || []).map((r) => ({
      req: r.id, text: r.text.slice(0, 200), section: r.section,
      files: [], test: null, status: 'todo', // todo | fait | echec | non fait
    })),
    journal: [],
  };
}

function log(state, stepIdx, ev, detail) {
  state.journal.push({ at: new Date().toISOString(), run: state.runs, step: stepIdx, ev, detail: String(detail || '').slice(0, 400) });
  if (state.journal.length > 600) state.journal = state.journal.slice(-500);
}

function save(root, state) {
  try {
    fs.mkdirSync(jobsDir(root), { recursive: true });
    state.updated = new Date().toISOString();
    const tmp = jobPath(root, state.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, jobPath(root, state.id));
    return true;
  } catch (_) { return false; }
}

function load(root, id) {
  try {
    const st = JSON.parse(fs.readFileSync(jobPath(root, id), 'utf8'));
    if (st && st.v === VERSION && Array.isArray(st.steps)) return st;
  } catch (_) {}
  return null;
}

function list(root) {
  try {
    return fs.readdirSync(jobsDir(root))
      .filter((f) => /^job-.*\.json$/.test(f))
      .map((f) => {
        try {
          const st = JSON.parse(fs.readFileSync(path.join(jobsDir(root), f), 'utf8'));
          return { id: st.id, title: st.title, status: st.status, steps: st.steps.length, updated: st.updated,
            done: st.steps.filter((s) => s.status === 'done').length };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.updated < b.updated ? 1 : -1));
  } catch (_) { return []; }
}

// Latest job that is not finished (what the "Reprendre" button resumes).
// P63-C1: tout travail INACHEVE est repris, quel que soit son statut
// d'arret (coupure, panne runtime, veille, fermeture de fenetre, echec).
function resumable(root) {
  const all = list(root);
  const open = all.find((j) => j.status === 'running' || j.status === 'proposed' ||
    j.status === 'stopped' || j.status === 'partial' || j.status === 'failed' ||
    j.status === 'interrupted');
  if (!open) return null;
  const st = load(root, open.id);
  if (!st) return null;
  const c = countSteps(st);
  // Un travail dont toutes les etapes sont faites (ou hors perimetre) n'est
  // pas repris : il n'y a rien a reprendre.
  if (c.done + c.outOfScope >= c.total) return null;
  return { id: st.id, steps: c.total, done: c.done, failed: c.failed,
    interrupted: c.interrupted, skipped: c.skipped, next: firstOpenStep(st) };
}

function create(root, specMeta, steps, opts) {
  const id = 'job-' + specMeta.id.replace(/^spec-/, '') + '-' + Date.now().toString(36).slice(-4);
  const state = freshState(id, specMeta, steps || spec.planSteps(specMeta), opts);
  save(root, state);
  return state;
}

// ---------------------------------------------------------------------------
// Step context (P56-2): objective + useful section + files + 2-line summary.
// ---------------------------------------------------------------------------
function prevSummary(state, upto) {
  const done = state.steps.filter((s) => s.i < upto);
  if (!done.length) return '';
  const last = done.slice(-2).map((s) => {
    const tag = s.status === 'done' ? 'faite' : (s.status === 'failed' ? 'ECHOUEE' : s.status);
    return (s.i + 1) + ' ' + tag + ' : ' + String(s.text).slice(0, 90) + (s.files && s.files.length ? ' (' + s.files.slice(0, 3).join(', ') + ')' : '');
  });
  return last.join('\n').slice(0, 400);
}

function stepPrompt(ctx) {
  const L = [];
  L.push('PROJET : ' + ctx.title + ' | ETAPE ' + ctx.n + '/' + ctx.N);
  L.push('OBJECTIF : ' + ctx.step.text);
  if (ctx.step.reqs && ctx.step.reqs.length) L.push('EXIGENCES COUVERTES : ' + ctx.step.reqs.join(', '));
  if (ctx.section) {
    L.push('');
    L.push('SECTION DU CAHIER DES CHARGES (extrait utile seulement) :');
    L.push(ctx.section);
  }
  if (ctx.filesHint && ctx.filesHint.length) {
    L.push('');
    L.push('FICHIERS DEJA TOUCHES : ' + ctx.filesHint.slice(0, 12).join(', '));
  }
  if (ctx.prev) {
    L.push('');
    L.push('ETAPES PRECEDENTES (resume court) :');
    L.push(ctx.prev);
  }
  L.push('');
  L.push('UNE seule action par pas. Termine par done avec un court resume.');
  // P62-F2: budget strict (60 % de n_ctx, 4 caracteres par jeton au plus).
  const cap = Number(ctx.budgetChars) > 0 ? Number(ctx.budgetChars) : 12000;
  const txt = L.join('\n');
  return txt.length > cap ? (txt.slice(0, Math.max(0, cap - 40)) + '\n[contexte tronque au budget]') : txt;
}

function filesHint(state) {
  const out = [];
  state.steps.forEach((s) => (s.files || []).forEach((f) => { if (out.indexOf(f) === -1) out.push(f); }));
  return out;
}

// ---------------------------------------------------------------------------
// Run / resume. runStep(step, ctx) is injected by the loop: it runs ONE fresh
// child turn and resolves { calls, ok, error, aborted, files, test }.
// ---------------------------------------------------------------------------
async function run(opts) {
  const root = opts.root;
  const state = opts.state || load(root, opts.id);
  if (!state) return { error: 'projet introuvable' };
  const runStep = opts.runStep;
  if (typeof runStep !== 'function') return { error: 'runStep manquant' };
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const resumed = state.status === 'running' || state.status === 'stopped';
  // A step left 'running' means the process died INSIDE it (kill, crash,
  // runtime restart). It is retried, never silently skipped nor counted done.
  if (resumed) {
    state.steps.forEach((s) => {
      if (s.status === 'running') { s.status = 'pending'; s.detail = 'interrompue (reprise apres arret)'; }
    });
  }
  state.runs += 1;
  state.status = 'running';
  // P63-C8: aucun statut mensonger a la reprise.
  state.steps.forEach((s) => {
    if (s.status === 'out_of_scope') return;
    if (s.status === 'interrupted_runtime') { s.detail = s.detail || 'interrompue par une panne du runtime'; }
  });
  log(state, -1, resumed ? 'resume' : 'start', (resumed ? 'reprise' : 'demarrage') + ' execution ' + state.runs);
  save(root, state);
  const b = state.budgets || budgets();
  const jobStart = Date.now();
  const N = state.steps.length;
  let aborted = false;

  // P63-C: ordre de reprise. 1) les etapes INTERROMPUES par le runtime (elles
  // ont deja commence, elles passent en premier), 2) les autres dans l'ordre.
  const order = state.steps.slice().sort((a, b) => {
    const w = (x) => (x.status === 'interrupted_runtime' ? 0 : 1);
    return w(a) - w(b) || a.i - b.i;
  });
  for (const s of order) {
    // P63-E14: une exigence hors perimetre n'est pas executee, elle est DITE.
    if (s.kind === 'out-of-scope' || s.status === 'out_of_scope') {
      s.status = 'out_of_scope';
      s.detail = 'hors perimetre - a faire par l utilisateur';
      (s.reqs || []).forEach((rid) => {
        const c = state.coverage.find((x) => x.req === rid);
        if (c) { c.status = 'hors perimetre'; c.proof = s.detail; }
      });
      log(state, s.i, 'out_of_scope', s.detail);
      continue;
    }
    if (opts.shouldStop && opts.shouldStop()) { aborted = true; break; }
    const retryable = s.status === 'pending' || (s.status === 'failed' && s.attempts < b.attempts);
    if (!retryable) {
      emit('job.step', { jobId: state.id, n: s.i + 1, N, status: s.status, detail: 'deja ' + s.status });
      continue;
    }
    if (Date.now() - jobStart > b.jobMs) {
      state.steps.forEach((r) => {
        if (r.status === 'pending') { r.status = 'skipped'; r.detail = 'budget global depasse'; }
      });
      log(state, s.i, 'budget', 'budget global depasse, arret honnete');
      break;
    }
    // P62-F4: jusqu'a `attempts` essais DANS la meme execution, chacun avec
    // l'erreur REELLE du precedent. Une etape n'est "faite" qu'apres
    // verification deterministe (fichiers reels + syntaxe + test si detecte).
    let ok = false;
    let res = null;
    let files = [];
    let check = null;
    let abortedHere = false;
    let interruptedHere = false; // P63-B3 : panne runtime, pas un echec
    const maxAtt = Math.max(1, b.attempts);
    for (let att = 0; att < maxAtt; att++) {
      s.status = 'running';
      s.attempts += 1;
      save(root, state); // checkpoint BEFORE the step: a crash still resumes here
      emit('job.step', { jobId: state.id, n: s.i + 1, N, status: 'start', text: s.text.slice(0, 200), reqs: s.reqs });
      log(state, s.i, 'start', 'essai ' + s.attempts);
      const t0 = Date.now();
      const ctx = {
        n: s.i + 1, N,
        step: s,
        title: state.title,
        section: spec.readSection(root, state.specId, s.section),
        prev: prevSummary(state, s.i),
        filesHint: filesHint(state),
        callBudget: b.stepCalls,
        msBudget: b.stepMs,
        model: s.model || pickModel(s, state.modelPolicy, opts.availableModels),
        // P62-F2/F7: budget de contexte et surface d outils de CETTE etape.
        budgetChars: (state.specPolicy && state.specPolicy.callBudgetChars) || Math.floor(8192 * 0.60 * 4),
        toolsLimit: b.toolsLimit,
        // P62-F7: sous-ensemble d'outils de cette etape (6 au plus).
        toolSubset: toolSubsetFor(s, b.toolsLimit),
        // P62-F4: a partir du 2e essai, le modele recoit l'erreur REELLE.
        lastError: att > 0 ? String(s.detail || '').slice(0, 300) : '',
        attempt: att + 1,
        attempts: maxAtt,
      };
      res = null;
      try { res = await runStep(s, ctx); }
      catch (e) { res = { calls: 0, ok: false, error: 'etape: ' + String((e && e.message) || e).slice(0, 200) }; }
      const wallMs = Date.now() - t0;
      // P63-B3: le temps ou le runtime etait INDISPONIBLE n'est jamais decompte
      // du budget de l'etape. `runtimeDownMs` vient du moteur (horloge
      // monotone) ; a defaut on prend 0 et on garde le mur.
      const downMs = Math.max(0, Number(res && res.runtimeDownMs) || 0);
      s.ms = wallMs;
      s.activeMs = Math.max(0, wallMs - downMs);
      s.runtimeDownMs = downMs;
      s.calls = (res && res.calls) || 0;
      if (res && res.interruptedByRuntime) {
        // P63-B3: statut dedie, jamais "NON REALISEE" : ce n'est pas la faute
        // du travail, et l'etape reprendra EN PREMIER.
        s.status = 'interrupted_runtime';
        s.detail = ('INTERROMPUE (runtime) apres ' + Math.round(s.activeMs / 1000) +
          's de travail actif ; le runtime est reste indisponible ' + Math.round(downMs / 1000) + 's. Reprise automatique.');
        log(state, s.i, 'interrupted_runtime', s.detail);
        save(root, state);
        emit('job.step', { jobId: state.id, n: s.i + 1, N, status: 'interrupted_runtime', detail: s.detail });
        interruptedHere = true;
        break; // sort de la boucle d'essais : ce n'est PAS un echec
      }
      if (res && res.aborted) {
        s.status = 'pending';
        s.detail = 'interrompue : ' + String(res.error || 'arret demande').slice(0, 160);
        log(state, s.i, 'aborted', s.detail);
        save(root, state);
        emit('job.step', { jobId: state.id, n: s.i + 1, N, status: 'pending', detail: s.detail });
        aborted = true;
        abortedHere = true;
        break;
      }
      files = (res && Array.isArray(res.files)) ? res.files.slice(0, 40) : [];
      files.forEach((f) => { if (s.files.indexOf(f) === -1) s.files.push(f); });
      const test = (res && res.test) || null;
      const declared = !!(res && res.ok) && (files.length > 0 || !!test || !!(res && res.declared));
      check = null;
      if (declared) {
        try {
          check = stepcheck.verifyStep(root, files, { testCommand: (test && test.command) || null });
        } catch (e) {
          check = { ok: false, detail: 'verification impossible : ' + String((e && e.message) || e).slice(0, 160), checks: [], failed: [] };
        }
      }
      s.check = check ? { ok: check.ok, detail: String(check.detail || '').slice(0, 300),
        files: (check.checks || []).map((c) => ({ f: c.file, ok: c.ok, partial: c.partial, why: String(c.detail || '').slice(0, 160) })) } : null;
      ok = declared && !!check && check.ok !== false;
      s.test = test || (check && check.test ? { command: check.test.command, ok: check.test.ok, detail: check.test.detail } : null);
      s.detail = String((res && (res.detail || res.error)) || (ok ? 'executee verifiee' : 'echec sans detail')).slice(0, 200);
      if (!ok && check && check.detail) {
        s.detail = ('verification deterministe en echec : ' + String(check.detail || '')).slice(0, 300);
      }
      if (s.activeMs > b.stepActiveMs && !ok) {
        s.detail = ('budget temps ACTIF depasse (' + Math.round(s.activeMs / 1000) + 's sur ' +
          Math.round(b.stepActiveMs / 1000) + 's, hors panne runtime ' + Math.round(s.runtimeDownMs / 1000) +
          's) ' + s.detail).slice(0, 300);
      }
      if (ok) break;
      log(state, s.i, 'retry', 'essai ' + s.attempts + ' en echec, on rejoue avec l erreur reelle');
    }
    if (abortedHere) break;
    if (interruptedHere) continue; // statut deja pose, reprise en premier
    s.status = ok ? 'done' : 'failed';
    // Coverage: each covered requirement inherits the step outcome.
    s.reqs.forEach((rid) => {
      const c = state.coverage.find((x) => x.req === rid);
      if (!c) return;
      files.forEach((f) => { if (c.files.indexOf(f) === -1) c.files.push(f); });
      if (s.test) c.test = s.test;
      c.proof = (s.check && s.check.detail ? s.check.detail : '').slice(0, 240);
      if (ok) c.status = 'fait';
      else c.status = (s.attempts >= b.attempts) ? 'non fait' : 'echec';
    });
    log(state, s.i, s.status, s.detail);
    save(root, state); // checkpoint AFTER each step
    emit('job.step', { jobId: state.id, n: s.i + 1, N, status: s.status, detail: s.detail.slice(0, 200), files });
  }

  const counted = countSteps(state);
  // Statut final sans ambiguite : 'done' = tout fait ; 'interrupted' = une
  // panne runtime a laisse du travail (reprise possible) ; 'partial' = au moins
  // une etape non realisee ; 'failed' = rien de fait.
  if (aborted) state.status = 'stopped';
  else if (counted.done + counted.outOfScope === counted.total) state.status = 'done';
  else if (counted.interrupted > 0) state.status = 'interrupted';
  else if (counted.done === 0) state.status = 'failed';
  else state.status = 'partial';
  state.progress = progressLine(state);
  log(state, -1, aborted ? 'stopped' : 'done', JSON.stringify(counted));
  save(root, state);
  const report = reportText(state, { aborted });
  emit('job.done', { jobId: state.id, report: report.slice(0, 4000), ...counted, aborted });
  return { state, report, aborted, ...counted };
}

function countSteps(state) {
  let done = 0; let failed = 0; let skipped = 0; let interrupted = 0; let outOfScope = 0;
  state.steps.forEach((s) => {
    if (s.status === 'done') done++;
    else if (s.status === 'failed') failed++;
    else if (s.status === 'interrupted_runtime') interrupted++;
    else if (s.status === 'out_of_scope') outOfScope++;
    else skipped++;
  });
  return { done, failed, skipped, interrupted, outOfScope, total: state.steps.length };
}

// P63-C: ligne de progression demandee mot pour mot dans le prompt.
function progressLine(state) {
  const c = countSteps(state);
  return c.done + ' faite(s), ' + c.failed + ' echouee(s), ' + c.interrupted +
    ' interrompue(s), ' + c.skipped + ' non tentee(s)' +
    (c.outOfScope ? ', ' + c.outOfScope + ' hors perimetre' : '') + ' sur ' + c.total + '.';
}

// P63-C5: le travail le plus recent INACHEVE (rien a voir avec le modele).
function unfinished(root) {
  const all = list(root);
  const open = all.find((j) => j.status === 'running' || j.status === 'proposed' || j.status === 'stopped' ||
    j.status === 'partial' || j.status === 'failed');
  if (!open) return null;
  const st = load(root, open.id);
  if (!st) return null;
  const c = countSteps(st);
  if (c.done >= c.total) return null; // tout est fait : rien a reprendre
  return { id: st.id, state: st, counts: c, line: progressLine(st),
    next: firstOpenStep(st) };
}

function firstOpenStep(state) {
  const st = (state.steps || []).find((s) => s.status !== 'done' && s.status !== 'out_of_scope');
  return st ? st.i : -1;
}

function coverageTable(state) {
  return (state.coverage || []).map((c) => ({
    req: c.req,
    text: c.text,
    section: c.section,
    files: c.files,
    test: c.test,
    proof: c.proof || '',
    status: c.status,
    done: c.status === 'fait',
  }));
}

function coverageText(state) {
  const rows = coverageTable(state);
  const L = ['COUVERTURE (exigence -> fichiers -> test -> etat) :'];
  let fait = 0;
  rows.forEach((r) => {
    if (r.done) fait++;
    L.push('  ' + r.req + ' [' + r.status + '] ' + (r.files.length ? r.files.slice(0, 4).join(', ') : '-') +
      ' | test: ' + (r.test || '-') + ' | preuve: ' + ((r.proof || '-').slice(0, 80)) + ' | ' + r.text.slice(0, 90));
  });
  L.push('  Total : ' + fait + '/' + rows.length + ' exigence(s) couverte(s).');
  return L.join('\n');
}

function reportText(state, opts) {
  const o = opts || {};
  const c = countSteps(state);
  const L = [];
  const travail = c.total - c.outOfScope;
  const reste = travail - c.done;
  // P63-C6: JAMAIS "termine" s'il reste une etape non faite. Le titre dit
  // INCOMPLET (x/N) et la liste suit. Les nombres sont ceux du plan :
  // travail x/N, hors perimetre annonce a part (jamais compte en echec).
  const entete = (reste > 0 ? 'INCOMPLET' : 'TERMINE') + ' (travail ' + c.done + '/' + travail + ')' +
    (c.outOfScope ? ', ' + c.outOfScope + ' hors perimetre' : '');
  L.push(entete + ' - PROJET "' + state.title + '" - ' + c.total + ' etape(s) au plan.');
  L.push('Etapes : ' + c.done + ' faite(s), ' + c.failed + ' echouee(s), ' + c.interrupted +
    ' interrompue(s), ' + c.skipped + ' non tentee(s)' +
    (c.outOfScope ? ', ' + c.outOfScope + ' hors perimetre' : '') + '.' +
    (o.aborted ? ' (interrompu : reprise possible)' : ''));
  if (reste > 0) {
    const list = state.steps.filter((s) => s.status !== 'done' && s.status !== 'out_of_scope')
      .slice(0, 20).map((s) => (s.i + 1) + ' (' + s.status + ')');
    L.push('Reste a faire : ' + list.join(', ') + (reste > 20 ? ' ...' : ''));
  }
  state.steps.forEach((s) => {
    const tag = s.status === 'done' ? 'FAIT'
      : s.status === 'failed' ? 'ECHOUE'
      : s.status === 'interrupted_runtime' ? 'INTERROMPUE (runtime)'
      : s.status === 'out_of_scope' ? 'HORS PERIMETRE (a faire par l utilisateur)'
      : s.status.toUpperCase();
    L.push('  ' + (s.i + 1) + '/' + c.total + ' [' + tag + '] ' +
      (s.reqs.length ? '(' + s.reqs.join(',') + ') ' : '') + String(s.text).slice(0, 120) +
      (s.files.length ? ' -> ' + s.files.slice(0, 3).join(', ') : '') + (s.detail ? ' :: ' + s.detail.slice(0, 120) : ''));
  });
  const rows = coverageTable(state);
  const nonFaits = rows.filter((r) => r.status !== 'fait');
  if (rows.length) {
    L.push('');
    L.push(coverageText(state));
    if (nonFaits.length) {
      L.push('');
      L.push('NON REALISE (' + nonFaits.length + ') : ' + nonFaits.slice(0, 20).map((r) => r.req).join(', ') +
        (nonFaits.length > 20 ? ' ...' : ''));
    }
  }
  return L.join('\n');
}

module.exports = {
  VERSION, jobsDir, jobPath, budgets, pickModel, estimateTokens, specPolicy, toolSubsetFor,
  create, load, save, list, resumable, freshState, delays, DELAYS,
  progressLine, unfinished, firstOpenStep,
  run, stepPrompt, prevSummary, filesHint,
  countSteps, coverageTable, coverageText, reportText, log,
};
