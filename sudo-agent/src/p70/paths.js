'use strict';
/**
 * P70-B6 : resolveur de chemin DETERMINISTE, sans modele.
 *
 * Regles (elles sont le contrat) :
 *   - relatif au projet ; le projet est la seule racine acceptee ;
 *   - insensible a la casse ;
 *   - separateurs Windows et POSIX traites pareil ;
 *   - correspondance UNIQUE exigee : plusieurs candidats -> on DEMANDE
 *     (aucune approximation silencieuse) ;
 *   - cible absente -> message clair + suggestions, jamais une cible devinee ;
 *   - ".github" n'est PAS ".git" (segments entiers, pas de prefixe).
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');

const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules']);
const MAX_WALK = 20000;

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function normalizeTarget(raw) {
  let t = toPosix(String(raw || '').trim());
  t = t.replace(/^\.\//, '').replace(/\/+/g, '/');
  t = t.replace(/^["'`]|["'`]$/g, '');
  return t.replace(/\/$/, '');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Parcourt le projet une fois ; renvoie des chemins POSIX relatifs. */
function walk(root, opts) {
  opts = opts || {};
  const out = [];
  const seen = new Set();
  const stack = [''];
  while (stack.length && out.length < (opts.limit || MAX_WALK)) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      if (!opts.includeProtected && PROTECTED_SEGMENTS.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (seen.has(r.toLowerCase())) continue;
      seen.add(r.toLowerCase());
      out.push({ rel: r, dir: e.isDirectory() });
      if (e.isDirectory()) stack.push(r);
    }
  }
  return out;
}

/** 'project' | 'protected' | 'outside'. ".github" reste 'project'. */
function classify(relOrAbs, root) {
  const rel = toPosix(relOrAbs);
  const segs = rel.split('/').filter(Boolean);
  for (const s of segs) {
    if (PROTECTED_SEGMENTS.has(s.toLowerCase())) return 'protected';
  }
  if (path.isAbsolute(rel)) {
    const relToRoot = toPosix(path.relative(root, rel));
    if (relToRoot.startsWith('..')) return 'outside';
    // un chemin absolu DANS le projet suit les memes regles
    for (const s of relToRoot.split('/')) {
      if (PROTECTED_SEGMENTS.has(s.toLowerCase())) return 'protected';
    }
  }
  return 'project';
}

/**
 * Resout `raw` dans `root`.
 * -> {ok:true, rel, abs, dir, how}
 * -> {ok:false, reason:'ambiguous', candidates:[...]}
 * -> {ok:false, reason:'absent', suggestions:[...]}
 * -> {ok:false, reason:'no_target'|'outside'}
 */
function resolve(root, raw, opts) {
  opts = opts || {};
  const want = normalizeTarget(raw);
  if (!want) return { ok: false, reason: 'no_target' };
  if (path.isAbsolute(want) && classify(want, root) === 'outside') {
    return { ok: false, reason: 'outside', target: want };
  }
  const entries = opts.entries || walk(root, { includeProtected: true });
  const wantLower = want.toLowerCase();
  const abs0 = path.isAbsolute(want) ? want : path.join(root, want);

  // 1. le chemin existe vraiment ? (lstat : on cherche le nom EXACT sur le disque)
  const exactAbs = findByCase(abs0);
  if (exactAbs) {
    const rel = toPosix(path.relative(root, exactAbs));
    return finish(rel, exactAbs);
  }
  // 2. meme chemin relatif, casse differente
  const same = entries.filter((e) => e.rel.toLowerCase() === wantLower);
  if (same.length === 1) return finish(same[0].rel, path.join(root, same[0].rel));
  if (same.length > 1) return { ok: false, reason: 'ambiguous', candidates: same.map((e) => e.rel).slice(0, 12) };

  // 3. meme nom de base, unique
  const base = wantLower.split('/').pop();
  const byBase = entries.filter((e) => e.rel.split('/').pop().toLowerCase() === base);
  if (byBase.length === 1) return finish(byBase[0].rel, path.join(root, byBase[0].rel));
  if (byBase.length > 1) {
    // indice de dossier fourni ?
    const dirHint = wantLower.indexOf('/') >= 0 ? wantLower.slice(0, wantLower.lastIndexOf('/')) : '';
    const hinted = dirHint ? byBase.filter((e) => e.rel.toLowerCase().indexOf(dirHint + '/') >= 0) : [];
    if (hinted.length === 1) return finish(hinted[0].rel, path.join(root, hinted[0].rel));
    return { ok: false, reason: 'ambiguous', candidates: (hinted.length ? hinted : byBase).map((e) => e.rel).slice(0, 12) };
  }

  // 4. suffixe de chemin unique ("workflows/ci-cd.yml")
  const bySuffix = entries.filter((e) => e.rel.toLowerCase().endsWith('/' + wantLower));
  if (bySuffix.length === 1) return finish(bySuffix[0].rel, path.join(root, bySuffix[0].rel));
  if (bySuffix.length > 1) return { ok: false, reason: 'ambiguous', candidates: bySuffix.map((e) => e.rel).slice(0, 12) };

  // 5. absent : suggestions triees par distance, JAMAIS choisies a la place
  const scored = entries
    .map((e) => ({ rel: e.rel, d: levenshtein(e.rel.split('/').pop().toLowerCase(), base) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d || a.rel.length - b.rel.length)
    .slice(0, 6);
  return { ok: false, reason: 'absent', target: want, suggestions: scored.map((x) => x.rel) };
}

function finish(rel, abs) {
  let dir = false;
  try { dir = fs.statSync(abs).isDirectory(); } catch (_) { dir = false; }
  return { ok: true, rel, abs, dir, cls: classify(rel) };
}

/** Trouve le nom REELLEMENT sur le disque (casse exacte) pour un absolu. */
function findByCase(abs) {
  const parts = toPosix(abs).split('/');
  let cur = parts[0] === '' ? '/' : parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const want = parts[i];
    if (!want) continue;
    let names = [];
    try { names = fs.readdirSync(cur); } catch (_) { return null; }
    const hit = names.find((n) => n === want) || names.find((n) => n.toLowerCase() === want.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

module.exports = { resolve, classify, walk, normalizeTarget, toPosix, levenshtein,
  PROTECTED_SEGMENTS };
