'use strict';
/**
 * P70-F17/F18 : l'agent voit les outils du PC.
 *
 * Cause du bug V5 : le PATH de l'agent etait celui du processus, herite a
 * l'ouverture de l'editeur (ou tronque), donc fige et parfois incomplet.
 *
 * Ici : a CHAQUE tour, on relit le PATH MACHINE + UTILISATEUR (registre sous
 * Windows, sinon l'environnement), on resout chaque outil avec `where`/`which`,
 * puis avec les dossiers d'installation connus. On ne dit "introuvable" que si
 * TOUTES ces sources echouent, et on journalise le chemin complet trouve.
 *
 * ASCII only.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KNOWN_DIRS = {
  node: ['%ProgramFiles%\\nodejs', '%ProgramFiles%\\node', '%LOCALAPPDATA%\\Programs\\nodejs',
    '%APPDATA%\\npm', '%ProgramData%\\chocolatey\\bin'],
  npm: ['%ProgramFiles%\\nodejs', '%APPDATA%\\npm', '%ProgramData%\\chocolatey\\bin'],
  git: ['%ProgramFiles%\\Git\\cmd', '%ProgramFiles%\\Git\\bin', '%LOCALAPPDATA%\\Programs\\Git\\cmd'],
  python: ['%LOCALAPPDATA%\\Programs\\Python\\Python312', '%LOCALAPPDATA%\\Programs\\Python\\Python311',
    '%LOCALAPPDATA%\\Programs\\Python\\Python310', '%ProgramFiles%\\Python312', 'C:\\Python312'],
  pip: ['%LOCALAPPDATA%\\Programs\\Python\\Python312\\Scripts', '%LOCALAPPDATA%\\Programs\\Python\\Python311\\Scripts'],
  docker: ['%ProgramFiles%\\Docker\\Docker\\resources\\bin'],
  flutter: ['C:\\src\\flutter\\bin', '%LOCALAPPDATA%\\flutter\\bin'],
  dart: ['C:\\src\\flutter\\bin\\cache\\dart-sdk\\bin'],
};

const EXE = process.platform === 'win32' ? '.exe' : '';

function expand(p) {
  return String(p || '').replace(/%([^%]+)%/g, (_, k) => process.env[k] || '');
}

function splitPath(value) {
  return String(value || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** PATH machine + utilisateur, LU dans le registre sous Windows. */
function machinePath() {
  const src = {};
  let machine = '';
  let user = '';
  if (process.platform === 'win32') {
    const regQuery = (hive, key) => {
      try {
        const out = execFileSync('reg', ['query', hive, '/v', 'Path'], { encoding: 'utf8', timeout: 4000 });
        const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
        return m ? m[1].trim() : '';
      } catch (_) { return ''; }
    };
    machine = regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
    user = regQuery('HKCU\\Environment');
    src.machine = machine ? 'registre HKLM' : 'indisponible';
    src.user = user ? 'registre HKCU' : 'indisponible';
  }
  if (!machine || !user) {
    // Repli : l'environnement du processus. On le DIT (jamais silencieux).
    machine = machine || (process.env.Path || process.env.PATH || '');
    user = user || '';
    src.fallback = 'environnement du processus';
  }
  const merged = [];
  for (const p of splitPath(expand(machine)).concat(splitPath(expand(user)))) {
    const norm = path.normalize(p);
    if (merged.indexOf(norm) === -1) merged.push(norm);
  }
  src.machineEntries = splitPath(expand(machine)).length;
  src.userEntries = splitPath(expand(user)).length;
  return { value: merged.join(process.platform === 'win32' ? ';' : ':'), entries: merged, sources: src };
}

function whichSync(name, pathValue) {
  const env = Object.assign({}, process.env, { PATH: pathValue, Path: pathValue });
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 4000, env });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) { /* pas trouve par where/which */ }
  // dossier connu
  const dirs = KNOWN_DIRS[name.replace(/\.exe$/i, '')] || [];
  for (const d of dirs) {
    const cand = [] ;
    for (const exe of (process.platform === 'win32' ? [name + '.exe', name + '.cmd', name] : [name])) {
      cand.push(path.join(expand(d), exe));
    }
    for (const c of cand) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
  }
  return null;
}

/**
 * Resout une liste d'outils.
 * @returns {{found:object, missing:string[], path:string, sources:object, added:string[]}}
 */
function resolveTools(names, opts) {
  opts = opts || {};
  const mp = opts.pathValue ? { value: opts.pathValue, entries: splitPath(opts.pathValue), sources: { value: 'fourni' } } : machinePath();
  const found = {};
  const missing = [];
  const extraDirs = [];
  for (const n of names) {
    const abs = whichSync(n, mp.value);
    if (abs) {
      found[n] = abs;
      const dir = path.dirname(abs);
      if (mp.entries.indexOf(dir) === -1 && extraDirs.indexOf(dir) === -1) extraDirs.push(dir);
    } else {
      missing.push(n);
    }
  }
  // Si un outil existe hors du PATH, on l'AJOUTE au PATH des enfants et on le dit.
  const childPath = (extraDirs.length ? extraDirs.join(';') + ';' : '') + mp.value;
  return { found, missing, path: childPath, basePath: mp.value, sources: mp.sources,
    added: extraDirs, count: Object.keys(found).length };
}

function journalLine(res) {
  const parts = Object.keys(res.found).map((k) => k + '=' + res.found[k]);
  return 'outils PC | trouves=' + Object.keys(res.found).length + ' ' + parts.join(' ; ') +
    (res.missing.length ? ' | absents=' + res.missing.join(',') : '') +
    (res.added.length ? ' | ajoutes au PATH enfants=' + res.added.join(';') : '') +
    ' | source=' + JSON.stringify(res.sources);
}

// PATH a donner aux enfants (bash, git, npm...). Mis a jour a chaque tour par
// loop.js ; en l'absence de mise a jour, on relit le registre/les variables.
let CHILD_PATH = null;
function setChildPath(p) { CHILD_PATH = (p && String(p).trim()) ? String(p) : null; }
function childPathNow() { return CHILD_PATH || machinePath().value; }

module.exports = { machinePath, resolveTools, whichSync, journalLine, KNOWN_DIRS, splitPath,
  setChildPath, childPathNow };
