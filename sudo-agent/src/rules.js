// Sudo Agent project rules editor (P54-5): AGENTS.md, never clobbered.
// - read/write the project AGENTS.md with an explicit confirmation when the
//   file already exists (the API returns the DIFF and waits for confirm);
// - "generate" derives a first draft from the project analysis (map + audit),
//   offline, deterministic, no network;
// - the global rules file lives in agents.js (same page, other scope).
// Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_RULES = 64 * 1024;

function rulesPath(root) {
  if (!root || typeof root !== 'string') return null;
  return path.join(root, 'AGENTS.md');
}

function readProjectRules(root) {
  const p = rulesPath(root);
  if (!p) return { ok: false, code: 'no_project', error: 'aucun projet.' };
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return { ok: true, exists: false, text: '', bytes: 0 }; }
  return { ok: true, exists: true, text, bytes: Buffer.byteLength(text, 'utf8') };
}

// Line diff (bounded, readable in a panel). Pure.
function diffText(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const max = 400;
  const out = [];
  const n = Math.max(a.length, b.length);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < n && out.length < max; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x !== undefined) { out.push('- ' + x); removed += 1; }
    if (y !== undefined) { out.push('+ ' + y); added += 1; }
  }
  return { lines: out, added, removed, truncated: out.length >= max };
}

// Writes AGENTS.md. Existing file => requires opts.confirm === true (the page
// shows the diff first). Never touches any other file.
function saveProjectRules(root, text, opts) {
  opts = opts || {};
  const p = rulesPath(root);
  if (!p) return { ok: false, code: 'no_project', error: 'aucun projet.' };
  const t = String(text === undefined || text === null ? '' : text);
  if (t.length > MAX_RULES) return { ok: false, code: 'too_big', error: 'AGENTS.md trop long (>64 Ko).' };
  const before = readProjectRules(root);
  const exists = before.ok && before.exists;
  const diff = diffText(exists ? before.text : '', t);
  const changed = (diff.added || 0) + (diff.removed || 0) > 0;
  // An identical rewrite is not an overwrite: nothing to confirm, nothing lost.
  if (exists && opts.confirm !== true && changed) {
    return { ok: false, code: 'confirm_required', exists: true, diff,
      error: 'AGENTS.md existe deja : confirmez apres relecture du diff (aucune ecriture faite).' };
  }
  try { fs.writeFileSync(p, t, 'utf8'); }
  catch (e) { return { ok: false, code: 'io', error: 'ecriture impossible : ' + String((e && e.message) || e).slice(0, 120) }; }
  return { ok: true, exists: true, diff, bytes: Buffer.byteLength(t, 'utf8') };
}

// Draft from the real analysis (project map + dependency stack). Deterministic.
function generateDraft(projectmap, root) {
  let map = null;
  try { map = projectmap.buildProjectMap(root); } catch (_) { map = null; }
  if (!map || !map.ok) return { ok: false, code: 'no_analysis', error: 'analyse du projet indisponible.' };
  const lines = [];
  lines.push('# AGENTS.md');
  lines.push('');
  lines.push('## Projet');
  lines.push('- Type : ' + String(map.type || 'inconnu') + '.');
  if (Array.isArray(map.keyFiles) && map.keyFiles.length) {
    lines.push('- Fichiers cles : ' + map.keyFiles.slice(0, 8).join(', ') + '.');
  }
  if (Array.isArray(map.entryPoints) && map.entryPoints.length) {
    lines.push('- Points d\'entree : ' + map.entryPoints.slice(0, 6).join(', ') + '.');
  }
  lines.push('');
  lines.push('## Regles de travail');
  lines.push('- Lire ou lister un fichier avant de le modifier ; ne jamais deviner un chemin.');
  lines.push('- Une action a la fois : verifier le resultat de l\'outil avant le pas suivant.');
  lines.push('- Modifier avec edit (bloc exact) ; ecrire uniquement des fichiers nouveaux avec write.');
  lines.push('- Ne jamais commiter de secret ; les jetons restent dans le trousseau.');
  lines.push('');
  lines.push('## Verifications');
  const checks = [];
  try {
    const verify = require('./verify');
    const detected = verify.detectChecks(root) || [];
    for (const c of detected) checks.push(c.command);
  } catch (_) {}
  if (checks.length) {
    for (const c of checks.slice(0, 6)) lines.push('- ' + c);
  } else {
    lines.push('- Aucune commande de verification detectee (ajoutez un fichier .sudo-verify).');
  }
  lines.push('');
  const text = lines.join('\n');
  return { ok: true, text, type: map.type || 'inconnu', keyFiles: (map.keyFiles || []).slice(0, 8) };
}

module.exports = { rulesPath, readProjectRules, diffText, saveProjectRules, generateDraft, MAX_RULES };
