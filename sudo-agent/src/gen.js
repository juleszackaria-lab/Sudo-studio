// Sudo Agent whole-project generation (P50-4). Phased runs
// plan->files->deps->build->tests with per-phase manifests, incremental
// content backups (real restore points), recorded build/test checks (real
// exit codes, never model-declared), and an honest report: TERMINE only
// with all phases + passing build AND tests checks, else PARTIEL with the
// missing list. Runs live under <project>/.sudo_studio/gen/<runid>/.
// Stdlib only, ASCII only. No require() of tools.js (cycle).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[0-9a-f]{16}$/;
const PHASES = ['plan', 'files', 'deps', 'build', 'tests'];
const SKIP_DIRS = ['.git', 'node_modules', '.sudo_studio', '__pycache__', '.venv', 'dist', 'build', 'target', 'out'];
const MAX_WALK_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;   // hashed + backed up below this
const MAX_BACKUP_FILES = 500;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_RESTORE_DELETES = 200;
const MAX_CHECK_TAIL = 4000;

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
function genRoot(root) { return path.join(String(root), '.sudo_studio', 'gen'); }
function runDir(root, id) { return path.join(genRoot(root), id); }

function readRun(root, id) {
  if (!validId(id)) return { ok: false, error: 'identifiant de generation invalide.' };
  const dir = runDir(root, id);
  let run = null;
  try { run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); }
  catch (_) { return { ok: false, error: 'generation introuvable.' }; }
  if (!run || run.id !== id) return { ok: false, error: 'generation illisible.' };
  return { ok: true, run, dir };
}
function writeRun(dir, run) {
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n', 'utf8');
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// rel -> { sha, size } ; skipped counts the rest. Never follows symlinks.
function manifestOf(root) {
  const files = {};
  let skipped = 0;
  let count = 0;
  const walk = (rel) => {
    if (count >= MAX_WALK_FILES) return;
    const abs = rel ? path.join(root, rel) : root;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (count >= MAX_WALK_FILES) { skipped += 1; continue; }
      if (e.isSymbolicLink()) { skipped += 1; continue; }
      const r = rel ? rel + '/' + e.name : e.name;
      const a = path.join(root, r);
      if (e.isDirectory()) {
        if (SKIP_DIRS.indexOf(e.name) !== -1) continue;
        walk(r);
        continue;
      }
      if (!e.isFile()) continue;
      let st = null;
      try { st = fs.statSync(a); } catch (_) { skipped += 1; continue; }
      if (st.size > MAX_FILE_BYTES) { skipped += 1; continue; }
      try {
        files[r] = { sha: sha256(fs.readFileSync(a)), size: st.size };
        count += 1;
      } catch (_) { skipped += 1; }
    }
  };
  walk('');
  return { files, skipped };
}

function diffManifests(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const k of Object.keys(after)) {
    if (!before[k]) created.push(k);
    else if (before[k].sha !== after[k].sha) modified.push(k);
  }
  for (const k of Object.keys(before)) {
    if (!after[k]) deleted.push(k);
  }
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function loadManifest(dir, tag) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.' + tag + '.json'), 'utf8'));
    if (d && typeof d.files === 'object') return d;
  } catch (_) {}
  return null;
}
function saveManifest(dir, tag, m) {
  fs.writeFileSync(path.join(dir, 'manifest.' + tag + '.json'), JSON.stringify(m), 'utf8');
}

// Copy post-state contents of changed paths into backup.<tag>/. Caps apply;
// beyond them the gap is RECORDED (never silent).
function backupChanged(root, dir, tag, changed) {
  const bdir = path.join(dir, 'backup.' + tag);
  let files = 0;
  let bytes = 0;
  const gaps = [];
  for (const rel of changed.slice().sort()) {
    const abs = path.join(root, rel);
    let buf = null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) { gaps.push(rel + ' (trop gros/absent)'); continue; }
      buf = fs.readFileSync(abs);
    } catch (_) { gaps.push(rel + ' (illisible)'); continue; }
    if (files >= MAX_BACKUP_FILES || bytes + buf.length > MAX_BACKUP_BYTES) { gaps.push(rel + ' (plafond sauvegarde)'); continue; }
    const dest = path.join(bdir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    } catch (_) { gaps.push(rel + ' (ecriture)'); continue; }
    files += 1;
    bytes += buf.length;
  }
  return { files, bytes, gaps };
}

function startRun(root, goal, stack) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) return { ok: false, error: 'objectif requis (<=2000 caracteres).' };
  const id = crypto.randomBytes(8).toString('hex');
  const dir = runDir(root, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, error: 'dossier de generation inaccessible.' };
  }
  const man = manifestOf(root);
  saveManifest(dir, 'start', man);
  // Seed contents of the starting tree (bounded): the restore base.
  const seeded = backupChanged(root, dir, 'start', Object.keys(man.files));
  const run = { id, goal: goal.trim(), stack: String(stack || '').slice(0, 200),
    createdAt: new Date().toISOString(), phases: {}, checks: [], seed: seeded };
  writeRun(dir, run);
  return { ok: true, id, seeded };
}

function markPhase(root, id, phase, note) {
  if (PHASES.indexOf(phase) === -1) return { ok: false, error: 'phase invalide (' + PHASES.join('|') + ').' };
  const rr = readRun(root, id);
  if (!rr.ok) return rr;
  const { run, dir } = rr;
  const idx = PHASES.indexOf(phase);
  for (let i = 0; i < idx; i++) {
    if (!run.phases[PHASES[i]]) return { ok: false, error: 'ordre impose : phase ' + PHASES[i] + ' manquante avant ' + phase + '.' };
  }
  if (run.phases[phase]) return { ok: false, error: 'phase ' + phase + ' deja marquee.' };
  const prevTag = idx === 0 ? 'start' : PHASES[idx - 1];
  const prev = loadManifest(dir, prevTag);
  const now = manifestOf(root);
  saveManifest(dir, phase, now);
  const diff = prev ? diffManifests(prev.files, now.files) : { created: Object.keys(now.files), modified: [], deleted: [] };
  const changed = diff.created.concat(diff.modified);
  const bk = backupChanged(root, dir, phase, changed);
  run.phases[phase] = { at: new Date().toISOString(), note: String(note || '').slice(0, 500),
    created: diff.created.length, modified: diff.modified.length, deleted: diff.deleted.length,
    backup: bk, manifestSkipped: now.skipped };
  writeRun(dir, run);
  let warning = null;
  if ((phase === 'build' || phase === 'tests') && !run.checks.some((c) => c.phase === phase && c.code === 0)) {
    warning = 'aucun check ' + phase + ' reussi : le rapport restera PARTIEL.';
  }
  return { ok: true, phase, warning, backup: bk };
}

function recordCheck(root, id, entry) {
  const rr = readRun(root, id);
  if (!rr.ok) return rr;
  const check = { phase: entry.phase, command: String(entry.command).slice(0, 500),
    code: entry.code === null || entry.code === undefined ? null : entry.code,
    signal: entry.signal || null, timedOut: !!entry.timedOut, ms: entry.ms || 0,
    at: new Date().toISOString(), tail: String(entry.tail || '').slice(-MAX_CHECK_TAIL) };
  rr.run.checks.push(check);
  writeRun(rr.dir, rr.run);
  return { ok: true, check };
}

function buildReport(root, id) {
  const rr = readRun(root, id);
  if (!rr.ok) return rr;
  const { run, dir } = rr;
  const start = loadManifest(dir, 'start');
  const now = manifestOf(root);
  const diff = start ? diffManifests(start.files, now.files) : { created: [], modified: [], deleted: [] };
  const missing = [];
  for (const p of PHASES) {
    if (!run.phases[p]) missing.push('phase ' + p);
  }
  const buildOk = run.checks.some((c) => c.phase === 'build' && c.code === 0);
  const testsOk = run.checks.some((c) => c.phase === 'tests' && c.code === 0);
  if (!buildOk) missing.push('check build reussi');
  if (!testsOk) missing.push('check tests reussi');
  const gaps = [];
  if (run.seed && run.seed.gaps && run.seed.gaps.length) gaps.push('start: ' + run.seed.gaps.length + ' fichier(s) non sauvegardes');
  for (const p of PHASES) {
    const ph = run.phases[p];
    if (ph && ph.backup && ph.backup.gaps && ph.backup.gaps.length) gaps.push(p + ': ' + ph.backup.gaps.length + ' fichier(s) non sauvegardes');
  }
  return { ok: true, report: {
    id: run.id, goal: run.goal, stack: run.stack, createdAt: run.createdAt,
    phases: run.phases, checks: run.checks, diff, backupGaps: gaps,
    verdict: missing.length === 0
      ? { status: 'TERMINE', missing: [] }
      : { status: 'PARTIEL', missing },
  } };
}

// Restore the tree to a phase (or 'start'). Refuses on unrestorable gaps
// unless partial:true (then gaps are REPORTED, never hidden).
function restorePhase(root, id, phase, opts) {
  opts = opts || {};
  if (phase !== 'start' && PHASES.indexOf(phase) === -1) return { ok: false, error: 'phase invalide (start|' + PHASES.join('|') + ').' };
  const rr = readRun(root, id);
  if (!rr.ok) return rr;
  const { run, dir } = rr;
  if (phase !== 'start' && !run.phases[phase]) return { ok: false, error: 'phase ' + phase + ' non marquee.' };
  const target = loadManifest(dir, phase);
  if (!target) return { ok: false, error: 'manifeste ' + phase + ' introuvable.' };
  const now = manifestOf(root);
  const diff = diffManifests(target.files, now.files);
  // diff.created = present now, absent in target => appeared after => delete.
  if (diff.created.length > MAX_RESTORE_DELETES && !opts.partial) {
    return { ok: false, error: 'restauration refusee : ' + diff.created.length + ' fichiers a supprimer (plafond ' + MAX_RESTORE_DELETES + ').' };
  }
  // Candidate content sources, newest first: phase backups down to the
  // target phase, then the start seed.
  const tags = [];
  if (phase === 'start') tags.push('start');
  else {
    const idx = PHASES.indexOf(phase);
    for (let i = idx; i >= 0; i--) tags.push(PHASES[i]);
    tags.push('start');
  }
  const contentFor = (rel) => {
    for (const t of tags) {
      const p = path.join(dir, 'backup.' + t, rel);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return fs.readFileSync(p);
      } catch (_) {}
    }
    return null;
  };
  const gaps = [];
  const toWrite = [];
  for (const rel of Object.keys(target.files)) {
    const cur = now.files[rel];
    if (cur && cur.sha === target.files[rel].sha) continue; // already there
    const buf = contentFor(rel);
    if (buf === null || sha256(buf) !== target.files[rel].sha) { gaps.push(rel); continue; }
    toWrite.push([rel, buf]);
  }
  if (gaps.length && !opts.partial) {
    return { ok: false, error: 'restauration refusee : ' + gaps.length + ' fichier(s) sans sauvegarde (' + gaps.slice(0, 5).join(', ') + ').' };
  }
  let restored = 0;
  let deleted = 0;
  const errors = [];
  for (const [rel, buf] of toWrite) {
    try {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      restored += 1;
    } catch (e) { errors.push(rel); }
  }
  for (const rel of diff.created) {
    try {
      fs.rmSync(path.join(root, rel), { force: true });
      deleted += 1;
    } catch (_) { errors.push(rel); }
  }
  return { ok: true, phase, restored, deleted, gaps, errors,
    partial: gaps.length > 0 || errors.length > 0 };
}

module.exports = {
  PHASES, validId, startRun, markPhase, recordCheck, buildReport, restorePhase,
  manifestOf, diffManifests,
};
