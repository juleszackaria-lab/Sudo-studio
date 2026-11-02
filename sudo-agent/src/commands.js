// Sudo Agent custom commands (P54-3).
// A command is a markdown prompt TEMPLATE with arguments, global
// (<home>/.sudo_studio/agent/commands/<name>.md) or per project
// (<root>/.sudo_studio/commands/<name>.md), invoked as "/name arg1 arg2".
//
// File format (front matter optional):
//   ---
//   name: revue
//   description: Relit un fichier et propose des corrections
//   args: file, focus
//   ---
//   Relis ${file} et concentre-toi sur ${focus}.
//   Arguments disponibles : $1, $2, $ARGS (tout le reste de la ligne).
//
// Resolution order for "/name": project first, then global. Nothing here ever
// touches the network or the log; expansion is pure. Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEMPLATE = 32 * 1024;
const MAX_ARGS = 32;

function agentDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent');
}

function globalDir(home) { return path.join(agentDir(home), 'commands'); }
function projectDir(root) { return path.join(String(root), '.sudo_studio', 'commands'); }

function scopeDir(home, root, scope) {
  if (scope === 'global') return globalDir(home);
  if (scope === 'project') return root ? projectDir(root) : null;
  return null;
}

function validName(n) { return typeof n === 'string' && NAME_RE.test(n); }

function parseFront(text) {
  const out = { name: '', description: '', args: [], body: String(text || '') };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(out.body);
  if (!m) return out;
  out.body = out.body.slice(m[0].length);
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2].trim().slice(0, 500);
    if (k === 'name') out.name = v;
    else if (k === 'description') out.description = v;
    else if (k === 'args') out.args = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, MAX_ARGS);
  }
  return out;
}

function readCommand(dir, name) {
  const p = path.join(dir, name + '.md');
  let st = null;
  try { st = fs.statSync(p); } catch (_) { return { ok: false, code: 'not_found', error: 'commande introuvable : ' + name }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'commande introuvable : ' + name };
  if (st.size > MAX_TEMPLATE) return { ok: false, code: 'too_big', error: 'commande trop volumineuse (>32 Ko).' };
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return { ok: false, code: 'io', error: 'commande illisible : ' + name }; }
  const fm = parseFront(text);
  return { ok: true, name: fm.name || name, description: fm.description, args: fm.args, template: fm.body };
}

function listScope(home, root, scope) {
  const dir = scopeDir(home, root, scope);
  if (!dir) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of entries.sort()) {
    if (!/\.md$/i.test(f)) continue;
    const name = f.replace(/\.md$/i, '');
    if (!validName(name)) continue;
    const r = readCommand(dir, name);
    if (!r.ok) { out.push({ scope, name, broken: r.code }); continue; }
    out.push({ scope, name, description: r.description, args: r.args, descriptionText: r.description || String(r.template || '').trim().split('\n')[0].slice(0, 120) });
  }
  return out;
}

// All commands, project entries shadowing global ones with the same name.
function listCommands(home, root) {
  const globalList = listScope(home, root, 'global');
  const projectList = listScope(home, root, 'project');
  const byName = new Map();
  for (const c of globalList) byName.set(c.name, c);
  for (const c of projectList) byName.set(c.name, c); // project wins
  const out = Array.from(byName.values());
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

function saveCommand(home, root, scope, name, description, template, argNames) {
  if (!validName(name)) return { ok: false, error: 'nom de commande invalide (lettres, chiffres, - _).' };
  if (typeof template !== 'string' || !template.trim()) return { ok: false, error: 'modele de consigne requis.' };
  if (template.length > MAX_TEMPLATE) return { ok: false, error: 'modele trop long (>32 Ko).' };
  const dir = scopeDir(home, root, scope);
  if (!dir) return { ok: false, error: 'scope project : racine projet requise.' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: 'ecriture impossible : ' + String((e && e.message) || e).slice(0, 120) }; }
  const names = Array.isArray(argNames) ? argNames.map((a) => String(a).trim()).filter((a) => /^[A-Za-z0-9_-]{1,64}$/.test(a)).slice(0, MAX_ARGS) : [];
  const head = '---\nname: ' + name + '\ndescription: ' + String(description || '').replace(/\r?\n/g, ' ').slice(0, 200) + '\n' +
    (names.length ? 'args: ' + names.join(', ') + '\n' : '') + '---\n';
  try { fs.writeFileSync(path.join(dir, name + '.md'), head + template.replace(/\r\n/g, '\n'), 'utf8'); }
  catch (e) { return { ok: false, error: 'ecriture impossible : ' + String((e && e.message) || e).slice(0, 120) }; }
  return { ok: true, name, scope };
}

function deleteCommand(home, root, scope, name) {
  if (!validName(name)) return { ok: false, error: 'nom de commande invalide.' };
  const dir = scopeDir(home, root, scope);
  if (!dir) return { ok: false, error: 'scope project : racine projet requise.' };
  try { fs.unlinkSync(path.join(dir, name + '.md')); }
  catch (_) { return { ok: false, error: 'commande introuvable : ' + scope + '/' + name }; }
  return { ok: true };
}

// "/name rest of line" -> { name, args }. Anything else -> null.
function parseInvocation(prompt) {
  const s = String(prompt || '').trim();
  const m = /^\/([A-Za-z0-9_-]{1,64})(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  const rest = String(m[2] || '').trim();
  const args = rest ? rest.split(/\s+/).slice(0, MAX_ARGS) : [];
  return { name: m[1], args, raw: rest };
}

// Pure template rendering: $1..$9, $ARGS, ${nom}, {{nom}}.
function renderTemplate(template, argNames, args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const names = Array.isArray(argNames) ? argNames : [];
  let out = String(template || '');
  out = out.replace(/\$\{([A-Za-z0-9_-]{1,64})\}/g, (all, k) => {
    const i = names.indexOf(k);
    return i === -1 ? all : String(list[i] === undefined ? '' : list[i]);
  });
  out = out.replace(/\{\{([A-Za-z0-9_-]{1,64})\}\}/g, (all, k) => {
    const i = names.indexOf(k);
    return i === -1 ? all : String(list[i] === undefined ? '' : list[i]);
  });
  out = out.replace(/\$(\d)/g, (all, d) => {
    const i = parseInt(d, 10) - 1;
    return list[i] === undefined ? '' : String(list[i]);
  });
  out = out.replace(/\$ARGS\b/g, list.join(' '));
  return out;
}

// Expand an invocation for a turn. Returns:
//  { matched:false }                          -> not a command, run the prompt as-is
//  { matched:true, ok:false, error }          -> unknown command (honest refusal)
//  { matched:true, ok:true, name, scope, prompt, missing:[names] }
function expand(home, root, prompt) {
  const inv = parseInvocation(prompt);
  if (!inv) return { matched: false };
  const found = listCommands(home, root).filter((c) => c.name === inv.name && !c.broken)[0];
  if (!found) return { matched: true, ok: false, code: 'unknown_command', name: inv.name,
    error: 'commande inconnue : /' + inv.name + ' (creez-la dans Agent Extensions > Commands).' };
  const dir = scopeDir(home, root, found.scope);
  const r = readCommand(dir, inv.name);
  if (!r.ok) return { matched: true, ok: false, code: r.code, name: inv.name, error: r.error };
  const missing = [];
  const argNames = Array.isArray(r.args) ? r.args : [];
  for (let i = 0; i < argNames.length; i++) if (!inv.args[i]) missing.push(argNames[i]);
  const text = renderTemplate(r.template, argNames, inv.args);
  return { matched: true, ok: true, name: found.name, scope: found.scope,
    prompt: text.trim(), missing, template: r.template.slice(0, 400) };
}

module.exports = { NAME_RE, globalDir, projectDir, listCommands, saveCommand, deleteCommand,
  parseInvocation, renderTemplate, expand, parseFront };
