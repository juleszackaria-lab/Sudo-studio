/**
 * delegation.js - P65 partie E : DELEGATION DETERMINISTE.
 *
 * Constat (audit E16) : l'onglet "Agents" ne gere que des DEFINITIONS (nom,
 * consignes, outils autorises). Aucune delegation n'y est orchestree. Le
 * moteur, lui, savait deja lancer un sous-agent (outil subagent / task), mais
 * personne ne validait le diff avant l'ecriture.
 *
 * Ce module ajoute une chaine COURTE et DETERMINISTE, sans planificateur
 * modele :
 *
 *   orchestrateur (moteur)  ->  executant (sous-agent, contexte isole,
 *                               outils restreints)
 *                           ->  verificateur (sous-agent LECTURE SEULE qui
 *                               examine le diff)
 *                           ->  application du diff SEULEMENT si les
 *                               verifications deterministes passent ET si le
 *                               verificateur ne dit pas NON.
 *
 * Un seul modele charge, execution sequentielle (jamais deux tours a la fois).
 * Si la verification echoue, les fichiers sont REMIS dans leur etat precedent
 * (snapshot avant etape) : rien de casse n'est laisse sur le disque.
 *
 * Le journal de delegation est ecrit dans le journal de l'agent ET dans un
 * fichier lisible (stateDir), pour qu'on puisse relire qui a fait quoi.
 *
 * ASCII only. Stdlib only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ckpt = require('./checkpoints');
const stepcheck = require('./stepcheck');

const MAX_STEPS = 8;
const EXECUTOR_TOOLS = ['read', 'list', 'glob', 'grep', 'write', 'edit', 'append', 'mkdir',
  'skill', 'todo', 'done', 'reply'];
const VERIFIER_TOOLS = ['read', 'list', 'glob', 'grep', 'done', 'reply'];

function delegationLogPath(root, turnId) {
  let dir = null;
  try { dir = require('./stateDir').paths(root).root; } catch (_) { dir = null; }
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const safe = String(turnId || 'turn').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return path.join(dir, 'delegation-' + safe + '.json');
}

function verdictOf(text) {
  const m = /VERDICT\s*:\s*(OUI|NON|YES|NO)/i.exec(String(text || ''));
  if (!m) return 'indetermine';
  const v = m[1].toUpperCase();
  return (v === 'OUI' || v === 'YES') ? 'oui' : 'non';
}

// Verifications deterministes du diff : existence + syntaxe par fichier.
function checkDiff(root, diff) {
  const checks = [];
  for (const rel of (diff.created || []).concat(diff.changed || [])) {
    let v = null;
    try { v = stepcheck.verifyFile(root, rel); } catch (_) { v = null; }
    if (!v) { checks.push({ file: rel, ok: false, partial: false, detail: 'verification impossible' }); continue; }
    checks.push({ file: rel, ok: !!v.ok, partial: !!v.partial, detail: String(v.detail || '').slice(0, 200) });
  }
  const bad = checks.filter((c) => !c.ok);
  return { checks, ok: bad.length === 0, failed: bad.map((c) => c.file + ' : ' + c.detail) };
}

/**
 * opts: {
 *   root, turnId, steps: [texte...],
 *   spawn: async ({ role, step, index, total, diff, tools, prompt }) =>
 *            { ok, childId, text, filesModified },
 *   journal: (level, event, fields) => void,
 *   onEvent: (evt) => void,
 *   maxSteps
 * }
 * Renvoie { ok, steps:[{ index, step, status, applied, files, verifier, checks }], report }
 */
async function run(opts) {
  const o = opts || {};
  const root = o.root;
  const journal = typeof o.journal === 'function' ? o.journal : () => {};
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const spawn = o.spawn;
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map((s) => String(s || '').trim()).filter(Boolean)
    .slice(0, Number(o.maxSteps) > 0 ? Number(o.maxSteps) : MAX_STEPS);
  const out = { ok: false, steps: [], report: '' };
  if (!root) { out.report = 'delegation refusee : aucun projet ouvert.'; return out; }
  if (!steps.length) { out.report = 'delegation refusee : aucune etape exploitable.'; return out; }
  if (typeof spawn !== 'function') { out.report = 'delegation impossible : lanceur de sous-agent absent.'; return out; }

  const logPath = delegationLogPath(root, o.turnId);
  const entries = [];
  const record = (rec) => { entries.push(rec); };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const n = i + 1;
    let snap = null;
    try { snap = ckpt.snapshotProject(root, { maxFiles: 300, maxBytes: 4 * 1024 * 1024 }); } catch (_) { snap = null; }
    journal('info', 'delegation etape', { n: n, total: steps.length, step: step.slice(0, 120), phase: 'executant' });
    try { onEvent({ type: 'delegation.step', phase: 'executor', n: n, total: steps.length, step: step.slice(0, 200) }); } catch (_) {}

    let exec = null;
    try {
      exec = await spawn({ role: 'executor', step: step, index: i, total: steps.length, tools: EXECUTOR_TOOLS });
    } catch (e) { exec = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
    const diff = snap ? ckpt.diffSnapshot(root, snap) : { changed: [], created: [], deleted: [], truncated: true };
    const files = (diff.created || []).concat(diff.changed || []);
    journal('info', 'delegation executant rendu', { n: n, child: (exec && exec.childId) || '',
      ok: !!(exec && exec.ok), fichiers: files.join(',') || 'aucun', supprimes: (diff.deleted || []).length });

    // Aucune modification : rien a verifier, l'etape ne peut pas etre "appliquee".
    if (!files.length) {
      const rec = { index: i, step: step.slice(0, 200), status: 'sans-modification',
        applied: false, files: [], verifier: 'non-appele', checks: [] };
      out.steps.push(rec); record({ at: new Date().toISOString(), phase: 'etape', n: n, total: steps.length, ...rec });
      continue;
    }

    // Sous-agent VERIFICATEUR : lecture seule, il examine le diff.
    try { onEvent({ type: 'delegation.step', phase: 'verifier', n: n, total: steps.length, files: files }); } catch (_) {}
    let ver = null;
    try {
      ver = await spawn({ role: 'verifier', step: step, index: i, total: steps.length,
        diff: diff, files: files, tools: VERIFIER_TOOLS });
    } catch (e) { ver = { ok: false, text: 'verificateur en erreur : ' + String((e && e.message) || e).slice(0, 200) }; }
    const verdict = verdictOf(ver && ver.text);
    const checks = checkDiff(root, diff);
    const apply = !diff.truncated && checks.ok && verdict !== 'non';
    journal(apply ? 'info' : 'warn', 'delegation verification', { n: n, verdict: verdict,
      deterministe: checks.ok ? 'ok' : 'echec', fichiers: files.join(',') || 'aucun',
      applique: apply ? 'oui' : 'non' });

    if (!apply) {
      let rb = null;
      try { rb = ckpt.restoreSnapshot(root, snap, { created: diff.created }); } catch (e) { rb = { errors: [String((e && e.message) || e)] }; }
      journal('warn', 'delegation retour arriere', { n: n,
        restaures: ((rb && rb.restored) || []).filter((x) => x.ok).length,
        supprimes: ((rb && rb.deleted) || []).length,
        nonRestaures: ((rb && rb.unverified) || []).length });
    }
    const rec = {
      index: i, step: step.slice(0, 200),
      status: apply ? 'appliquee' : 'refusee',
      applied: apply, files,
      verifier: verdict,
      verifierText: String((ver && ver.text) || '').slice(0, 300),
      checks: checks.checks,
      executor: (exec && exec.childId) || '',
      rolledBack: apply ? false : true,
    };
    out.steps.push(rec);
    record({ at: new Date().toISOString(), phase: 'etape', n: n, total: steps.length, ...rec });
    try { onEvent({ type: 'delegation.result', n: n, total: steps.length, applied: apply, verdict: verdict, files: files }); } catch (_) {}
  }

  const applied = out.steps.filter((s) => s.applied).length;
  const refused = out.steps.filter((s) => s.status === 'refusee').length;
  const idle = out.steps.filter((s) => s.status === 'sans-modification').length;
  out.report = 'Delegation : ' + applied + '/' + steps.length + ' etape(s) appliquee(s)' +
    (refused ? ', ' + refused + ' refusee(s) apres verification (fichiers remis en etat)' : '') +
    (idle ? ', ' + idle + ' sans modification' : '') + '.';
  out.ok = applied === steps.length;

  try {
    (out.steps || []).forEach((s, k) => {
      journal('info', 'delegation bilan', { n: k + 1, statut: s.status, applique: s.applied ? 'oui' : 'non',
        verificateur: s.verifier, fichiers: (s.files || []).join(',') || 'aucun' });
    });
  } catch (_) {}

  if (logPath) {
    try {
      fs.writeFileSync(logPath, JSON.stringify({
        schema: 'sudo-delegation/1', at: new Date().toISOString(), root: String(root),
        turnId: String(o.turnId || ''), steps: out.steps, report: out.report,
      }, null, 2) + '\n', 'utf8');
      journal('info', 'journal de delegation ecrit', { fichier: logPath });
    } catch (_) {}
  }
  return out;
}

module.exports = { run, verdictOf, checkDiff, delegationLogPath, EXECUTOR_TOOLS, VERIFIER_TOOLS, MAX_STEPS };
