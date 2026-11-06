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
 *   - the state file (.sudo-agent/jobs/job-<id>.json) records attempts,
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

const VERSION = 1;
const DEFAULT_STEP_ATTEMPTS = 2;

function jobsDir(root) { return path.join(root, '.sudo-agent', 'jobs'); }
function jobPath(root, id) {
  return path.join(jobsDir(root), 'job-' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');
}

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function budgets() {
  return {
    stepCalls: intEnv('SUDO_AGENT_STEP_CALLS', 8),
    stepMs: intEnv('SUDO_AGENT_STEP_MS', 120000),
    jobMs: intEnv('SUDO_AGENT_JOB_MS', 1800000),
    attempts: intEnv('SUDO_AGENT_STEP_ATTEMPTS', DEFAULT_STEP_ATTEMPTS),
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
    modelPolicy: o.modelPolicy || null,
    steps: steps.map((s) => ({
      i: s.i, text: s.text, reqs: s.reqs || [], section: s.section || 1,
      complex: !!s.complex, model: s.model || null,
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
function resumable(root) {
  const all = list(root);
  return all.find((j) => j.status === 'running' || j.status === 'proposed' || j.status === 'stopped') || null;
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
  return L.join('\n').slice(0, 12000);
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
  log(state, -1, resumed ? 'resume' : 'start', (resumed ? 'reprise' : 'demarrage') + ' execution ' + state.runs);
  save(root, state);
  const b = state.budgets || budgets();
  const jobStart = Date.now();
  const N = state.steps.length;
  let aborted = false;

  for (const s of state.steps) {
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
    };
    let res = null;
    try { res = await runStep(s, ctx); }
    catch (e) { res = { calls: 0, ok: false, error: 'etape: ' + String((e && e.message) || e).slice(0, 200) }; }
    s.ms = Date.now() - t0;
    s.calls = (res && res.calls) || 0;
    if (res && res.aborted) {
      s.status = 'pending';
      s.detail = 'interrompue : ' + String(res.error || 'arret demande').slice(0, 160);
      log(state, s.i, 'aborted', s.detail);
      save(root, state);
      emit('job.step', { jobId: state.id, n: s.i + 1, N, status: 'pending', detail: s.detail });
      aborted = true;
      break;
    }
    const files = (res && Array.isArray(res.files)) ? res.files.slice(0, 40) : [];
    files.forEach((f) => { if (s.files.indexOf(f) === -1) s.files.push(f); });
    const test = (res && res.test) || null;
    const ok = !!(res && res.ok) && (files.length > 0 || !!test || !!(res && res.declared));
    s.status = ok ? 'done' : 'failed';
    s.test = test;
    s.detail = String((res && (res.detail || res.error)) || (ok ? 'executee' : 'echec sans detail')).slice(0, 300);
    if (s.ms > b.stepMs && !ok) s.detail = ('budget temps depasse (' + Math.round(s.ms / 1000) + 's) ' + s.detail).slice(0, 300);
    // Coverage: each covered requirement inherits the step outcome.
    s.reqs.forEach((rid) => {
      const c = state.coverage.find((x) => x.req === rid);
      if (!c) return;
      files.forEach((f) => { if (c.files.indexOf(f) === -1) c.files.push(f); });
      if (test) c.test = test;
      if (ok) c.status = 'fait';
      else c.status = (s.attempts >= b.attempts) ? 'non fait' : 'echec';
    });
    log(state, s.i, s.status, s.detail);
    save(root, state); // checkpoint AFTER each step
    emit('job.step', { jobId: state.id, n: s.i + 1, N, status: s.status, detail: s.detail.slice(0, 200), files });
  }

  const counted = countSteps(state);
  // Statut final sans ambiguite : 'done' = tout fait, 'partial' = au moins une
  // etape non realisee (les autres sont faites), 'failed' = rien de fait.
  if (aborted) state.status = 'stopped';
  else if (counted.failed === 0 && counted.skipped === 0) state.status = 'done';
  else if (counted.done === 0) state.status = 'failed';
  else state.status = 'partial';
  log(state, -1, aborted ? 'stopped' : 'done', JSON.stringify(counted));
  save(root, state);
  const report = reportText(state, { aborted });
  emit('job.done', { jobId: state.id, report: report.slice(0, 4000), ...counted, aborted });
  return { state, report, aborted, ...counted };
}

function countSteps(state) {
  let done = 0; let failed = 0; let skipped = 0;
  state.steps.forEach((s) => {
    if (s.status === 'done') done++;
    else if (s.status === 'failed') failed++;
    else skipped++;
  });
  return { done, failed, skipped, total: state.steps.length };
}

function coverageTable(state) {
  return (state.coverage || []).map((c) => ({
    req: c.req,
    text: c.text,
    section: c.section,
    files: c.files,
    test: c.test,
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
      ' | test: ' + (r.test || '-') + ' | ' + r.text.slice(0, 90));
  });
  L.push('  Total : ' + fait + '/' + rows.length + ' exigence(s) couverte(s).');
  return L.join('\n');
}

function reportText(state, opts) {
  const o = opts || {};
  const c = countSteps(state);
  const L = [];
  L.push('PROJET "' + state.title + '" - ' + c.total + ' etape(s).');
  L.push('Etapes : ' + c.done + ' faite(s), ' + c.failed + ' echouee(s), ' + c.skipped + ' non tentee(s).' +
    (o.aborted ? ' (interrompu : reprise possible)' : ''));
  state.steps.forEach((s) => {
    L.push('  ' + (s.i + 1) + '/' + c.total + ' [' + (s.status === 'done' ? 'FAIT' : (s.status === 'failed' ? 'ECHOUE' : s.status.toUpperCase())) + '] ' +
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
  VERSION, jobsDir, jobPath, budgets, pickModel,
  create, load, save, list, resumable, freshState,
  run, stepPrompt, prevSummary, filesHint,
  countSteps, coverageTable, coverageText, reportText, log,
};
