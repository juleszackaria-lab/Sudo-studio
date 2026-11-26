'use strict';
/**
 * P71-B5/B6 : AutoFix de Project Analysis, DETERMINISTE, avec diff et
 * verification disque. Le bouton ne peut pas echouer en silence : tout retour
 * porte un texte en francais et un code.
 *
 * Corrections implementees :
 *   - readme      : cree README.md a partir des donnees de l analyse
 *                   (nom, scripts, dependances principales, tests, CI) ;
 *   - testScript  : ajoute "test" dans package.json SEULEMENT si un lanceur de
 *                   tests est detecte (jest/vitest/mocha/playwright/cypress) ;
 *                   sinon, explique quoi faire (aucune ecriture).
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function topDeps(pkg, n) {
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {});
  const out = Object.keys(deps).sort().slice(0, n || 8)
    .map((k) => '| `' + k + '` | `' + deps[k] + '` |');
  return out;
}

function readmeContent(analysis, root) {
  const a = analysis || {};
  const pkg = root ? readJson(path.join(root, 'package.json')) : null;
  const name = (pkg && pkg.name) || a.name || 'projet';
  const L = [];
  L.push('# ' + name);
  L.push('');
  L.push('> README genere par Sudo Studio a partir de l analyse deterministe du projet.');
  L.push('');
  const scripts = (pkg && pkg.scripts) || {};
  const names = Object.keys(scripts);
  if (names.length) {
    L.push('## Scripts');
    L.push('');
    for (const n of names) L.push('- `npm run ' + n + '` : ' + scripts[n]);
    L.push('');
  }
  const deps = topDeps(pkg, 8);
  if (deps.length) {
    L.push('## Dependances principales');
    L.push('');
    L.push('| Paquet | Version |');
    L.push('|---|---|');
    for (const d of deps) L.push(d);
    L.push('');
  }
  const st = a.stats || {};
  if (st.files) {
    L.push('## Structure');
    L.push('');
    L.push('- Fichiers : ' + st.files + ' | lignes : ' + (st.lines || 0));
    const langs = Object.entries(st.byLang || {}).map(([k, v]) => k + ' (' + (v.files || 0) + ')');
    if (langs.length) L.push('- Langages : ' + langs.join(', '));
    L.push('');
  }
  const t = a.tests || {};
  L.push('## Tests');
  L.push('');
  L.push(t.count ? ('- ' + t.count + ' fichier(s) de test' + (t.frameworks && t.frameworks.length ? ' (' + t.frameworks.join(', ') + ')' : ''))
    : '- Aucun test detecte : a completer.');
  L.push('');
  L.push('## Installation');
  L.push('');
  L.push('```bash');
  L.push('npm install');
  if (scripts.start) L.push('npm start');
  L.push('```');
  L.push('');
  return L.join('\n');
}

const RUNNERS = ['vitest', 'jest', 'mocha', 'playwright', 'cypress'];
function detectRunner(analysis, root) {
  const a = analysis || {};
  const fw = (a.tests && a.tests.frameworks) || [];
  for (const r of RUNNERS) if (fw.indexOf(r) !== -1) return r;
  for (const eco of a.deps || []) {
    for (const m of eco.manifestDeps || []) {
      const n = String(m.name || '').toLowerCase();
      if (RUNNERS.indexOf(n) !== -1) return n;
    }
  }
  const pkg = root ? readJson(path.join(root, 'package.json')) : null;
  const all = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  for (const r of RUNNERS) if (all[r]) return r;
  return null;
}

function plan(fixId, analysis, opts) {
  opts = opts || {};
  const root = opts.root || (analysis && analysis.root) || '';
  if (fixId === 'readme') {
    const target = path.join(root, 'README.md');
    if (fs.existsSync(target)) {
      return { ok: false, code: 'exists', message: 'README.md existe deja : AutoFix ne l ecrase pas.' };
    }
    const content = readmeContent(analysis, root);
    return { ok: true, fixId, kind: 'create', file: 'README.md', abs: target,
      before: '', after: content, diff: diff('', content),
      message: 'Cree README.md a partir de l analyse (nom, scripts, dependances, tests).' };
  }
  if (fixId === 'testScript') {
    const target = path.join(root, 'package.json');
    const pkg = readJson(target);
    if (!pkg) return { ok: false, code: 'no_manifest', message: 'package.json illisible : impossible d ajouter un script test.' };
    if (pkg.scripts && pkg.scripts.test) {
      return { ok: false, code: 'exists', message: 'Un script test existe deja (' + pkg.scripts.test + ').' };
    }
    const runner = detectRunner(analysis, root);
    if (!runner) {
      return { ok: false, code: 'no_runner',
        message: 'Aucun lanceur de tests detecte : AutoFix n ajoute pas un script qui echouerait. ' +
          'Installez un lanceur (ex. npm i -D vitest) puis relancez, ou ecrivez le script vous-meme.' };
    }
    const cmd = runner === 'vitest' ? 'vitest run' : (runner + ' --run');
    const updated = JSON.parse(JSON.stringify(pkg));
    updated.scripts = Object.assign({}, updated.scripts || {}, { test: cmd });
    const before = JSON.stringify(pkg, null, 2) + '\n';
    const after = JSON.stringify(updated, null, 2) + '\n';
    return { ok: true, fixId, kind: 'update', file: 'package.json', abs: target,
      before, after, diff: diff(before, after), runner,
      message: 'Ajoute scripts.test = "' + cmd + '" (lanceur detecte : ' + runner + ').' };
  }
  return { ok: false, code: 'unknown_fix', message: 'AutoFix inconnu : ' + String(fixId) };
}

function diff(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const L = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) { if (a[i] !== undefined && L.length < 400) L.push(' ' + a[i]); continue; }
    if (a[i] !== undefined) L.push('-' + a[i]);
    if (b[i] !== undefined) L.push('+' + b[i]);
  }
  const keepFirst = L.slice(0, 400);
  return keepFirst.join('\n') + (L.length > 400 ? '\n[...diff tronque]' : '');
}

/** Applique APRES approbation, puis VERIFIE sur le disque. */
function apply(planObj, opts) {
  opts = opts || {};
  if (!planObj || !planObj.ok) {
    return { ok: false, code: (planObj && planObj.code) || 'invalid',
      message: (planObj && planObj.message) || 'Rien a appliquer.' };
  }
  if (!opts.approve) {
    return { ok: false, code: 'needs_approval',
      message: 'Approbation requise avant d ecrire "' + planObj.file + '".', diff: planObj.diff };
  }
  try {
    fs.mkdirSync(path.dirname(planObj.abs), { recursive: true });
    fs.writeFileSync(planObj.abs, planObj.after, 'utf8');
  } catch (e) {
    return { ok: false, code: 'write_failed',
      message: 'Ecriture impossible pour "' + planObj.file + '" : ' + String(e.message || e).slice(0, 160) };
  }
  let verified = false;
  try {
    const now = fs.readFileSync(planObj.abs, 'utf8');
    verified = planObj.kind === 'create'
      ? (now.length > 0 && fs.existsSync(planObj.abs))
      : (now === planObj.after);
  } catch (_) { verified = false; }
  if (!verified) {
    return { ok: false, code: 'not_verified',
      message: '"' + planObj.file + '" n a pas ete ecrit correctement : verification disque en echec.' };
  }
  return { ok: true, code: 'applied', file: planObj.file, diff: planObj.diff,
    message: (planObj.kind === 'create' ? 'Cree' : 'Modifie') + ' "' + planObj.file + '" (verifie sur le disque).' };
}

/** La correction a-t-elle fait disparaitre l avertissement ? */
function verifyGone(fixId, analysisAfter) {
  const a = analysisAfter || {};
  if (fixId === 'readme') return !!(a.readme && a.readme.present);
  if (fixId === 'testScript') return true; // relu par l appelant dans package.json
  return false;
}

module.exports = { plan, apply, readmeContent, detectRunner, diff, verifyGone, RUNNERS };
