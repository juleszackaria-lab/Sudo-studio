/**
 * stateDir.js - P63-D : l'etat de l'agent vit HORS du projet.
 *
 * Decision (prompt 63, point 9) : aucun dossier `.sudo-agent`, aucun fichier de
 * l'agent dans le projet. Tout va dans :
 *
 *   Windows : %LOCALAPPDATA%\SudoStudio\agent\workspaces\<empreinte>\
 *   Linux   : $XDG_DATA_HOME/SudoStudio/agent/workspaces/<empreinte>/
 *             (defaut : ~/.local/share/SudoStudio/agent/workspaces/<empreinte>/)
 *   macOS   : ~/Library/Application Support/SudoStudio/agent/workspaces/<empreinte>/
 *
 * <empreinte> = sha256 du chemin ABSOLU et RESOLU du projet, 16 caracteres.
 * Deux projets differents n'ont donc jamais le meme dossier, et deplacer le
 * projet ne melange rien.
 *
 * Un dossier `.sudo-agent` deja present dans un projet (anciennes versions) est
 * DETECTE, jamais supprime sans accord : `migrateLegacy()` ne deplace les
 * fichiers que si l'appelant a recu une approbation explicite.
 *
 * Tout est injectable (env, platform, home, fs) : testable sans toucher au
 * disque reel. Ne jette jamais. ASCII only.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DIR = '.sudo-agent';

function fingerprint(projectRoot) {
  const abs = path.resolve(String(projectRoot || '.'));
  // Windows : la casse ne distingue pas deux chemins -> empreinte stable.
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// Ancien emplacement (versions precedentes) : ~/.sudo_studio/agent.
// P63-B/P5 : ce dossier n'est PLUS utilise en lecture ni en ecriture. Il est
// seulement DETECTE, puis migre vers l'emplacement unique si l'utilisateur
// donne son accord explicite (migrateHome(true)). Aucun etat ne vit donc a
// deux endroits a la fois.
function legacyHome(opts) {
  const o = opts || {};
  const home = o.home || (() => { try { return os.homedir(); } catch (_) { return '.'; } })();
  return path.join(String(home), '.sudo_studio', 'agent');
}

// Chemin UNIQUE de l'etat global de l'agent (hors projet).
function agentHome(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  if (o.base) return o.base;
  if (env.SUDO_AGENT_HOME) return env.SUDO_AGENT_HOME; // tests + support
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local');
    return path.join(local, 'SudoStudio', 'agent');
  }
  if (platform === 'darwin') {
    return path.join(o.home || os.homedir(), 'Library', 'Application Support', 'SudoStudio', 'agent');
  }
  const data = env.XDG_DATA_HOME || path.join(o.home || os.homedir(), '.local', 'share');
  return path.join(data, 'SudoStudio', 'agent');
}

// P63-B/P5/P6 : l'ancien dossier global a-t-il des donnees a reprendre ?
function detectLegacyHome(opts) {
  const o = opts || {};
  const dir = legacyHome(o);
  const target = agentHome(o);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { names = []; }
  const same = path.resolve(dir) === path.resolve(target);
  return { present: !same && names.length > 0, dir, target, entries: names.slice(0, 40) };
}

// Migration de l'ancien dossier global vers l'emplacement unique.
// N'agit QUE si `approved === true` (accord explicite de l'utilisateur).
function migrateHome(approved, opts) {
  const o = opts || {};
  const det = detectLegacyHome(o);
  if (!det.present) return { ok: true, skipped: true, reason: 'aucun ancien dossier a migrer', target: det.target };
  if (approved !== true) {
    return { ok: false, needsApproval: true, plan: { from: det.dir, to: det.target, entries: det.entries },
      message: "L'ancien dossier " + det.dir + " contient " + det.entries.length +
        ' element(s) (sessions, regles, points de retour). Je peux le deplacer vers ' + det.target +
        ' (emplacement unique). Approuve pour continuer.', target: det.target };
  }
  ensureDir(det.target);
  let moved = 0;
  const failed = [];
  for (const name of det.entries) {
    const src = path.join(det.dir, name);
    const dst = path.join(det.target, name);
    try {
      if (fs.existsSync(dst)) { failed.push(name + ' : deja present a destination'); continue; }
      try { fs.renameSync(src, dst); } catch (_) { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
      moved += 1;
    } catch (e) { failed.push(name + ' : ' + String((e && e.message) || e).slice(0, 80)); }
  }
  // Le dossier historique est retire s'il est vide (jamais s'il reste quelque chose).
  let removed = false;
  try { if (!fs.readdirSync(det.dir).length) { fs.rmdirSync(det.dir); removed = true; } } catch (_) {}
  return { ok: failed.length === 0, moved, failed, removed, target: det.target };
}

function workspaceDir(projectRoot, opts) {
  const o = opts || {};
  return path.join(o.agentHome || agentHome(o), 'workspaces', o.fingerprint || fingerprint(projectRoot));
}

// Les sous-dossiers de l'etat, tous dans le workspace.
function paths(projectRoot, opts) {
  const w = workspaceDir(projectRoot, opts);
  return {
    root: w,
    jobs: path.join(w, 'jobs'),
    specs: path.join(w, 'specs'),
    sessions: path.join(w, 'sessions'),
    checkpoints: path.join(w, 'checkpoints'),
    logs: path.join(w, 'logs'),
    registry: path.join(w, 'advancement.json'),
  };
}

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); return true; } catch (_) { return false; }
}

function ensureWorkspace(projectRoot, opts) {
  const p = paths(projectRoot, opts);
  Object.keys(p).forEach((k) => { if (k !== 'registry') ensureDir(p[k]); });
  return p;
}

// ---------------------------------------------------------------------------
// Ancien emplacement dans le projet : detection + migration AVEC accord.
// ---------------------------------------------------------------------------
function legacyDir(projectRoot) {
  return path.join(String(projectRoot || ''), LEGACY_DIR);
}

function listLegacy(projectRoot) {
  const dir = legacyDir(projectRoot);
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch (_) {}
        out.push({ rel: r, size });
      }
    }
  };
  walk(dir, '');
  return out;
}

function detectLegacy(projectRoot) {
  const files = listLegacy(projectRoot);
  return { present: files.length > 0 || fs.existsSync(legacyDir(projectRoot)), dir: legacyDir(projectRoot), files };
}

/**
 * Deplace l'ancien `.sudo-agent` dans le workspace. N'agit QUE si
 * `approved === true` : sinon rend la proposition (l'appelant la montre a
 * l'utilisateur et demande l'accord). Le dossier du projet n'est retire que
 * s'il est vide apres la copie.
 */
function migrateLegacy(projectRoot, approved, opts) {
  const det = detectLegacy(projectRoot);
  if (!det.present) return { ok: true, skipped: true, reason: 'aucun .sudo-agent dans le projet' };
  const target = paths(projectRoot, opts);
  const plan = { from: det.dir, to: target.root, files: det.files.length };
  if (!approved) {
    return { ok: false, needsApproval: true, plan,
      message: 'Le projet contient un dossier d agent (.sudo-agent) de ' + det.files.length +
        ' fichier(s). Je peux le deplacer vers ' + target.root + ' et le retirer du projet. Approuve pour continuer.' };
  }
  ensureWorkspace(projectRoot, opts);
  let moved = 0;
  const failed = [];
  for (const f of det.files) {
    const src = path.join(det.dir, f.rel);
    // jobs/ et specs/ sont recopies a la racine du workspace, le reste sous son nom.
    const dest = path.join(target.root, f.rel.split(path.sep).join(path.sep));
    try {
      ensureDir(path.dirname(dest));
      try { fs.renameSync(src, dest); } catch (_) { fs.copyFileSync(src, dest); try { fs.unlinkSync(src); } catch (_) {} }
      moved += 1;
    } catch (e) { failed.push(f.rel + ' : ' + String((e && e.message) || e).slice(0, 80)); }
  }
  let removed = false;
  try {
    // P63-D: on ne laisse pas un .sudo-agent vide dans le projet. Les
    // sous-dossiers devenus vides (jobs/, specs/...) sont retires un a un.
    const prune = (dir) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { return; }
      names.forEach((n) => {
        const p2 = path.join(dir, n);
        let st2 = null;
        try { st2 = fs.statSync(p2); } catch (_) { return; }
        if (!st2.isDirectory()) return;
        prune(p2);
        try { if (!fs.readdirSync(p2).length) fs.rmdirSync(p2); } catch (_) {}
      });
    };
    prune(det.dir);
    const left = listLegacy(projectRoot);
    if (!left.length) { fs.rmdirSync(det.dir); removed = true; }
  } catch (_) {}
  return { ok: failed.length === 0, moved, failed, removedFromProject: removed, plan };
}

// Un fichier de l'agent ne doit JAMAIS atterrir dans le projet.
function isAgentPathInProject(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  return rel === LEGACY_DIR || rel.indexOf(LEGACY_DIR + '/') === 0 ||
    rel === '.agent' || rel.indexOf('.agent/') === 0;
}

module.exports = {
  LEGACY_DIR, fingerprint, agentHome, legacyHome, detectLegacyHome, migrateHome,
  workspaceDir, paths, ensureWorkspace,
  legacyDir, detectLegacy, listLegacy, migrateLegacy, isAgentPathInProject,
};
