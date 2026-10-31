// Sudo Agent orchestrator (P52 item 7). Long action plans (>= LONG_STEPS)
// run step by step, each step in a FRESH minimal context (only the step
// text + system prompt + short summary of previous steps). Plan, state,
// hashes and journal persist on disk (.sudo-agent/orch-<planId>.json)
// so a crash / server stop / panel close resumes where it stopped.
// Per-step budgets (calls + time) and a global budget bound every run;
// each step is verified on disk when its turn ends; the final report
// tells fait / echoue / non tente honestly, step by step.
// ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');
const plan = require('./plan');

const VERSION = 1;

function longSteps() { return plan.intEnv('SUDO_AGENT_LONG_STEPS', 5); }
function stepCallBudget() { return plan.intEnv('SUDO_AGENT_STEP_CALLS', 8); }
function stepMsBudget() { return plan.intEnv('SUDO_AGENT_STEP_MS', 120000); }
function orchMsBudget() { return plan.intEnv('SUDO_AGENT_ORCH_MS', 1800000); }

function orchDir(root) { return path.join(root, '.sudo-agent'); }
function planPath(root, planId) {
  const safe = String(planId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(orchDir(root), 'orch-' + safe + '.json');
}

function loadState(root, planId) {
  try {
    const raw = fs.readFileSync(planPath(root, planId), 'utf8');
    const st = JSON.parse(raw);
    if (st && st.version === VERSION && st.planId === planId && Array.isArray(st.steps)) return st;
  } catch (_) {}
  return null;
}

function saveState(root, state) {
  fs.mkdirSync(orchDir(root), { recursive: true });
  state.updated = new Date().toISOString();
  const tmp = planPath(root, state.planId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, planPath(root, state.planId));
}

function journal(state, i, ev, detail) {
  if (!Array.isArray(state.journal)) state.journal = [];
  state.journal.push({ t: new Date().toISOString(), i, ev, detail: String(detail || '').slice(0, 300) });
  if (state.journal.length > 500) state.journal = state.journal.slice(-500);
}

function snapshot(root, stepTexts) {
  const rels = [];
  for (const a of plan.buildPlan(stepTexts)) {
    if (a.file) rels.push(a.file);
    if (a.file2) rels.push(a.file2);
    if (a.dir) rels.push(a.dir);
  }
  return plan.snapFiles(root, rels);
}

function freshState(planId, stepTexts) {
  const steps = stepTexts.map((text, i) => ({
    i, text: String(text).slice(0, 2000), status: 'pending', detail: '',
    attempts: 0, calls: 0, ms: 0,
  }));
  return { version: VERSION, planId, started: new Date().toISOString(), updated: '',
    steps, snap: null, journal: [], runs: 0 };
}

// Short summary of previous steps, fed to each fresh step context.
function stepsSummary(state, upto) {
  const lines = [];
  for (const s of state.steps) {
    if (s.i >= upto) break;
    lines.push((s.i + 1) + '. [' + s.status + '] ' + String(s.text).slice(0, 120) +
      (s.detail ? ' (' + String(s.detail).slice(0, 120) + ')' : ''));
  }
  return lines.join('\n').slice(0, 2000);
}

// Final honest report: per-step fait / echoue / non tente + totals.
function finalReport(state) {
  const L = ['Plan orchestre : ' + state.steps.length + ' etape(s).'];
  let done = 0, failed = 0, skipped = 0;
  for (const s of state.steps) {
    if (s.status === 'done') { done++; L.push((s.i + 1) + '/' + state.steps.length + ' FAIT : ' + s.text.slice(0, 140) + (s.detail ? ' (' + s.detail.slice(0, 140) + ')' : '')); }
    else if (s.status === 'failed') { failed++; L.push((s.i + 1) + '/' + state.steps.length + ' ECHOUE : ' + s.text.slice(0, 140) + (s.detail ? ' (' + s.detail.slice(0, 140) + ')' : '')); }
    else { skipped++; L.push((s.i + 1) + '/' + state.steps.length + ' NON TENTE : ' + s.text.slice(0, 140)); }
  }
  L.push('Total : ' + done + ' fait(s), ' + failed + ' echoue(s), ' + skipped + ' non tente(s).');
  return L.join('\n');
}

// Run (or resume) the orchestration. runStep(step, ctx) is injected by
// the loop (owns provider + tools); it must run ONE fresh-context turn
// for the step and resolve { calls, ok, error, aborted }. ctx carries
// { n, N, prev (summary), callBudget, msBudget }. emit(ev, obj) streams
// progress (orch.step / orch.done). Resolves { report, done, failed,
// skipped } (counts of step statuses).
async function runOrchestrated(opts) {
  const root = opts.root;
  const planId = opts.planId;
  const stepTexts = opts.stepTexts || [];
  const emit = opts.emit || (() => {});
  const runStep = opts.runStep;
  let state = loadState(root, planId);
  const resumed = !!state;
  if (!state) {
    state = freshState(planId, stepTexts);
    state.snap = snapshot(root, stepTexts);
    journal(state, -1, 'start', stepTexts.length + ' etapes');
  } else {
    state.runs += 1;
    journal(state, -1, 'resume', 'reprise ( execution ' + (state.runs + 1) + ' )');
  }
  saveState(root, state);
  const analyses = plan.buildPlan(state.steps.map((s) => s.text));
  const orchStart = Date.now();
  const orchBudget = orchMsBudget();
  const callBudget = stepCallBudget();
  const msBudget = stepMsBudget();
  const N = state.steps.length;
  for (const s of state.steps) {
    const shouldRun = s.status === 'pending' || (s.status === 'failed' && s.attempts < 2);
    if (!shouldRun) {
      emit('orch.step', { planId, n: s.i + 1, N, status: s.status, detail: 'deja ' + s.status });
      continue;
    }
    if (Date.now() - orchStart > orchBudget) {
      for (const r of state.steps) {
        if (r.status === 'pending' || (r.status === 'failed' && r.attempts < 2)) { r.status = 'skipped'; r.detail = 'budget global depasse'; journal(state, r.i, 'skipped', 'budget global'); }
      }
      journal(state, s.i, 'budget', 'budget global depasse, arret honnete');
      break;
    }
    s.status = 'pending';
    s.attempts += 1;
    const n = s.i + 1;
    emit('orch.step', { planId, n, N, status: 'start', text: s.text.slice(0, 200) });
    journal(state, s.i, 'start', 'essai ' + s.attempts);
    saveState(root, state);
    const t0 = Date.now();
    let res = null;
    try {
      res = await runStep(s, { n, N, prev: stepsSummary(state, s.i), callBudget, msBudget });
    } catch (e) {
      res = { calls: 0, ok: false, error: 'step turn: ' + String((e && e.message) || e).slice(0, 200) };
    }
    s.calls = (res && res.calls) || 0;
    s.ms = Date.now() - t0;
    if (res && res.aborted) {
      s.detail = 'interrompu (' + String(res.error || 'abandon').slice(0, 160) + ')';
      journal(state, s.i, 'aborted', s.detail);
      saveState(root, state);
      emit('orch.step', { planId, n, N, status: 'pending', detail: s.detail });
      break; // crash/stop simulation: leave pending, resume later.
    }
    let v = null;
    try { v = plan.verifyStep(root, analyses[s.i], state.snap, !!(res && res.declared)); }
    catch (e) { v = { ok: false, detail: 'verification impossible: ' + String((e && e.message) || e).slice(0, 160) }; }
    if (v.ok) {
      s.status = 'done';
      s.detail = String(v.detail).slice(0, 300);
      journal(state, s.i, 'done', s.detail);
    } else if (res && res.error && s.calls >= callBudget) {
      s.status = 'failed';
      s.detail = 'budget appels depasse (' + s.calls + '), ' + String(v.detail).slice(0, 160);
      journal(state, s.i, 'failed', s.detail);
    } else {
      s.status = 'failed';
      s.detail = String(v.detail || (res && res.error) || 'echec').slice(0, 300);
      journal(state, s.i, 'failed', s.detail);
    }
    if (s.ms > msBudget && s.status !== 'done') {
      s.detail = ('budget temps depasse (' + Math.round(s.ms / 1000) + 's), ' + s.detail).slice(0, 300);
      journal(state, s.i, 'timeout', s.detail);
    }
    saveState(root, state);
    emit('orch.step', { planId, n, N, status: s.status, detail: s.detail.slice(0, 200) });
  }
  const report = finalReport(state);
  let done = 0, failed = 0, skipped = 0;
  for (const s of state.steps) {
    if (s.status === 'done') done++;
    else if (s.status === 'failed') failed++;
    else skipped++;
  }
  journal(state, -1, resumed ? 'resumed-done' : 'done', 'fin');
  saveState(root, state);
  emit('orch.done', { planId, report: report.slice(0, 4000), done, failed, skipped });
  return { report, done, failed, skipped };
}

module.exports = {
  VERSION,
  longSteps,
  stepCallBudget,
  stepMsBudget,
  orchMsBudget,
  planPath,
  loadState,
  saveState,
  runOrchestrated,
  finalReport,
  stepsSummary,
};
