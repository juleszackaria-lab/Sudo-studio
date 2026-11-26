'use strict';
/**
 * P71-C8/C9 : UNE fonction de detection, partagee par le Doctor et l agent.
 *
 * Regles :
 *   - le PATH vient du REGISTRE (machine + utilisateur sous Windows), relu a
 *     chaque diagnostic : pas d environnement herite, pas de cache ;
 *   - resolution par `where` (Windows) / `which` (POSIX), puis dossiers
 *     d installation connus ;
 *   - delai par commande explicite (defaut 15 s, assez pour un premier
 *     demarrage a froid) ;
 *   - chaque resultat porte ses DETAILS : commande, sortie, chemin resolu,
 *     PATH utilise. Rien d invisible.
 *
 * Toutes les commandes passent par un `run` injectable : les tests n executent
 * rien de reel et peuvent simuler un PC Windows.
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT = 15000;

const KNOWN_DIRS = {
  node: ['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
    '/usr/local/bin', '/usr/bin'],
  npm: ['C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs',
    path.join(process.env.APPDATA || '', 'npm'), '/usr/local/bin', '/usr/bin'],
  git: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files (x86)\\Git\\cmd',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git\\cmd'), '/usr/bin'],
  python: ['C:\\Python312', 'C:\\Python311', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python\\Python312'),
    '/usr/local/bin', '/usr/bin'],
  python3: ['/usr/local/bin', '/usr/bin', 'C:\\Python312'],
  pip: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python\\Python312\\Scripts'), '/usr/local/bin'],
  where: ['C:\\Windows\\System32', '/usr/bin'],
};

/** Execute une commande ; injectable pour les tests. */
function defaultRun(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args || [], { timeout: (opts && opts.timeoutMs) || DEFAULT_TIMEOUT, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : null });
      });
  });
}

/** Deux dossiers designent-ils le meme emplacement ? (Windows : casse et
 *  separateur final ignores ; sinon comparaison directe). */
function sameDir(a, b) {
  if (!a || !b) return false;
  let x = path.normalize(String(a));
  let y = path.normalize(String(b));
  x = x.replace(/[\\/]+$/, '');
  y = y.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') { x = x.toLowerCase(); y = y.toLowerCase(); }
  return x === y;
}

function inPath(dir, pathValue) {
  return splitPath(pathValue).some((e) => sameDir(e, dir));
}

function splitPath(v) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return String(v || '').split(sep).map((s) => s.trim()).filter(Boolean);
}

/**
 * PATH machine + utilisateur, lu au moment de l appel.
 * Windows : registre via PowerShell (lecture seule, aucun droit admin requis).
 * POSIX   : variables d environnement du processus, et on le DIT.
 */
async function machinePath(run) {
  run = run || defaultRun;
  const src = { platform: process.platform };
  if (process.platform !== 'win32') {
    const v = process.env.PATH || '';
    src.fallback = 'environnement du processus (POSIX)';
    src.entries = splitPath(v).length;
    return { value: v, sources: src };
  }
  const ps = '[Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")';
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: DEFAULT_TIMEOUT });
  let registry = String(r.stdout || '').trim();
  if (r.code !== 0 || !registry) {
    const r2 = await run('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { timeoutMs: DEFAULT_TIMEOUT });
    const m = /Path\s+REG_\w+\s+(.+)/i.exec(String(r2.stdout || ''));
    registry = m ? m[1].trim() : '';
    src.fallback = 'reg query HKCU';
  } else {
    src.fallback = null;
  }
  // P71 : registre D ABORD (frais, c est la correction de V5), puis le PATH du
  // processus en complement. Certains environnements (postes de CI, dossiers
  // d outils injectes au demarrage) n ecrivent PAS le registre : sans ce
  // complement, un outil parfaitement utilisable etait annonce "hors du PATH"
  // (faux positif vu dans la fumee du paquet, P36-DOCTOR-TOOLS).
  const merged = [];
  for (const p2 of splitPath(registry).concat(splitPath(process.env.PATH || process.env.Path || ''))) {
    if (merged.indexOf(p2) === -1) merged.push(p2);
  }
  src.registry = true;
  src.registryEntries = splitPath(registry).length;
  src.processEntries = splitPath(process.env.PATH || process.env.Path || '').length;
  src.entries = merged.length;
  return { value: merged.join(';'), sources: src };
}

async function whichSyncLike(name, pathValue, run, timeoutMs) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = await run(cmd, [name], { timeoutMs: timeoutMs || DEFAULT_TIMEOUT, env: { PATH: pathValue, Path: pathValue } });
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (r.code === 0 && first) return { path: first, command: cmd + ' ' + name, stdout: String(r.stdout || '').slice(0, 400), stderr: r.stderr };
  return { path: null, command: cmd + ' ' + name, stdout: String(r.stdout || '').slice(0, 400), stderr: r.stderr };
}

function knownCandidate(name, pathValue) {
  const dirs = KNOWN_DIRS[name.replace(/\.exe$/i, '')] || [];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const cand = path.join(d, name + e);
      try { if (fs.existsSync(cand)) return cand; } catch (_) { /* ignore */ }
    }
  }
  return null;
}

/** Detecte une liste d outils et rend, pour chacun, ses DETAILS. */
async function detect(names, opts) {
  opts = opts || {};
  const run = opts.run || defaultRun;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const mp = opts.pathValue
    ? { value: opts.pathValue, sources: { fourni: true, entries: splitPath(opts.pathValue).length } }
    : await machinePath(run);
  const each = [];
  const found = {};
  const missing = [];
  const outsidePath = [];
  for (const name of names) {
    const w = await whichSyncLike(name, mp.value, run, timeoutMs);
    let resolved = w.path;
    let how = 'where';
    if (!resolved) {
      const cand = knownCandidate(name, mp.value);
      if (cand) { resolved = cand; how = 'dossier connu'; }
    }
    const entry = { name, resolved, how, command: w.command, stdout: w.stdout, stderr: w.stderr,
      pathUsed: mp.value };
    if (resolved) {
      found[name] = resolved;
      if (mp.value && !inPath(path.dirname(resolved), mp.value)) outsidePath.push(name);
    } else {
      missing.push(name);
    }
    each.push(entry);
  }
  return { found, missing, outsidePath, details: each, path: mp.value, sources: mp.sources };
}

/** Reparation du PATH UTILISATEUR (aucun droit administrateur). */
function planPathRepair(directory) {
  const dir = String(directory || '').replace(/[\\/]+$/, '');
  if (!dir) return { ok: false, code: 'no_dir', message: 'Dossier a ajouter introuvable.' };
  const script = [
    '$d = ' + JSON.stringify(dir),
    '$p = [Environment]::GetEnvironmentVariable("Path","User")',
    'if ($null -eq $p) { $p = "" }',
    'if ($p -split ";" -contains $d) { "deja-present" } else {',
    '  $new = if ($p.Trim() -eq "") { $d } else { $p.TrimEnd(";") + ";" + $d }',
    '  [Environment]::SetEnvironmentVariable("Path", $new, "User")',
    '  "ajoute"',
    '}',
  ].join('\n');
  return { ok: true, directory: dir, scope: 'utilisateur',
    command: 'powershell -NoProfile -Command <script>', script,
    message: 'Ajoute "' + dir + '" au PATH utilisateur (sans droits administrateur).' };
}

async function applyPathRepair(plan, run) {
  run = run || defaultRun;
  if (!plan || !plan.ok) return { ok: false, code: 'invalid', message: 'Rien a reparer.' };
  if (process.platform !== 'win32') {
    return { ok: false, code: 'not_supported',
      message: 'La reparation automatique du PATH concerne Windows ; sur ce systeme, exportez PATH dans votre shell.' };
  }
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', plan.script], { timeoutMs: DEFAULT_TIMEOUT });
  const out = String(r.stdout || '').trim();
  const done = r.code === 0 && /ajoute|deja-present/.test(out);
  return { ok: done, code: done ? 'path_repaired' : 'path_repair_failed',
    output: out.slice(0, 200), message: done
      ? (out.indexOf('deja-present') !== -1 ? 'Deja present dans le PATH utilisateur.' : 'PATH utilisateur mis a jour : ' + plan.directory)
      : 'La modification du PATH a echoue (code ' + r.code + ') : ' + (r.stderr || '').slice(0, 120) };
}

function journalLine(res) {
  const parts = Object.keys(res.found || {}).map((k) => k + '=' + res.found[k]);
  return 'doctor | trouves=' + parts.length + ' ' + parts.join(' ; ') +
    ' | absents=' + ((res.missing || []).join(',') || '-') +
    ' | hors_path=' + ((res.outsidePath || []).join(',') || '-') +
    ' | source=' + JSON.stringify(res.sources || {});
}

module.exports = { DEFAULT_TIMEOUT, KNOWN_DIRS, detect, machinePath, planPathRepair, applyPathRepair, journalLine, defaultRun, splitPath };
