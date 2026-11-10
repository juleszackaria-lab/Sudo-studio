// Sudo Agent - resolution de chemin tolerante (P61-8).
//
// Un petit modele ecrit "readme.md" alors que le fichier s'appelle
// "README.md". Refuser et redemander la meme chose en boucle ne rend service a
// personne : l'agent resout le chemin LUI-MEME, une fois, et le DIT.
//
// Regles (dans cet ordre, on s'arrete au premier rang qui donne un resultat) :
//   1. chemin relatif identique a la casse pres        -> unique / ambigu
//   2. nom de fichier identique a la casse pres        -> unique / ambigu
//   3. nom de fichier a une distance de frappe <= 2    -> unique / ambigu
//   4. sinon : liste bornee des fichiers existants (UNE fois)
//
// Bornes : marche limitee (MAX_FILES) et profondeur limitee, jamais dans
// .git / node_modules / dist / build. Aucune ecriture. Stdlib seule, ASCII.
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.venv', '__pycache__', '.next'];
const MAX_FILES = 4000;
const MAX_DEPTH = 8;

function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Bounded walk of the project: [{ rel, base, relLower }]. */
function walk(root) {
  const out = [];
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length && out.length < MAX_FILES) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const rel = cur.rel ? cur.rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (cur.depth >= MAX_DEPTH) continue;
        if (SKIP_DIRS.indexOf(e.name.toLowerCase()) !== -1) continue;
        stack.push({ dir: path.join(cur.dir, e.name), rel, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        out.push({ rel, base: e.name, relLower: rel.toLowerCase(), baseLower: e.name.toLowerCase() });
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/**
 * Resolve `wanted` inside `root`.
 * Returns { ok:true, rel, how } when EXACTLY ONE file matches the best rank,
 * or { ok:false, reason:'ambiguous'|'absent', candidates:[rel...], listed }.
 */
function resolveClosest(root, wanted, opts) {
  opts = opts || {};
  const want = norm(wanted);
  if (!want) return { ok: false, reason: 'absent', candidates: [] };
  const files = opts.files || walk(root);
  const wantBase = want.split('/').pop();
  const wantDir = want.indexOf('/') === -1 ? '' : want.slice(0, want.lastIndexOf('/'));

  // 1. same relative path, case-insensitive
  const exact = files.filter((f) => f.relLower === want);
  if (exact.length === 1) return { ok: true, rel: exact[0].rel, how: 'casse' };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map((f) => f.rel).slice(0, 10) };

  // 2. same basename, case-insensitive (directory hint first)
  let same = files.filter((f) => f.baseLower === wantBase);
  if (same.length > 1 && wantDir) {
    const hinted = same.filter((f) => f.relLower.indexOf(wantDir + '/') !== -1);
    if (hinted.length) same = hinted;
  }
  if (same.length === 1) return { ok: true, rel: same[0].rel, how: 'nom' };
  if (same.length > 1) {
    // Prefer the shallowest one only when it is unambiguous enough to be safe:
    // we do NOT guess, we report the candidates (the model picks).
    return { ok: false, reason: 'ambiguous', candidates: same.map((f) => f.rel).slice(0, 10) };
  }

  // 3. typo-tolerant basename (distance <= 2)
  const near = [];
  for (const f of files) {
    const d = levenshtein(f.baseLower, wantBase);
    if (d <= 2 && Math.abs(f.baseLower.length - wantBase.length) <= 2) near.push({ rel: f.rel, d });
  }
  near.sort((a, b) => a.d - b.d || a.rel.length - b.rel.length);
  if (near.length && (near.length === 1 || near[0].d < near[1].d)) {
    return { ok: true, rel: near[0].rel, how: 'approche' };
  }
  if (near.length > 1 && near[0].d === near[1].d) {
    return { ok: false, reason: 'ambiguous', candidates: near.slice(0, 10).map((x) => x.rel) };
  }

  // 4. absent: the caller shows the bounded file list ONCE.
  return { ok: false, reason: 'absent', candidates: files.map((f) => f.rel).slice(0, 60) };
}

module.exports = { resolveClosest, walk, levenshtein, norm, MAX_FILES };
