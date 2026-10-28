// Sudo Agent skills (P50-2). SKILL.md packs (global + project) with
// preview-before-activate import from local dirs or git. A skill is a
// directory holding SKILL.md (optional YAML-ish front-matter: name,
// version, description) plus helper files. Only ACTIVE skills are injected
// into the agent prompt, and injection is capped. Import is two-step:
// previewImport() stages a copy and reports metadata WITHOUT installing;
// activateStaged() installs + activates. Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STAGE_RE = /^[0-9a-f]{16}$/;
const MAX_SKILL_FILE = 64 * 1024;      // SKILL.md hard cap
const MAX_IMPORT_FILES = 200;          // import tree cap
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_INJECT_PER_SKILL = 8000;     // prompt chars per skill
const MAX_INJECT_TOTAL = 24000;        // prompt chars total
const STAGE_TTL_MS = 24 * 3600 * 1000; // prune staging older than this

function agentDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent');
}
function globalDir(home) { return path.join(agentDir(home), 'skills'); }
function stagingDir(home) { return path.join(agentDir(home), 'skills_staging'); }
function projectDir(root) { return path.join(String(root), '.sudo_studio', 'skills'); }
function stateFile(home) { return path.join(agentDir(home), 'skills.json'); }

function validName(n) { return typeof n === 'string' && NAME_RE.test(n); }

function loadState(home) {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    if (d && typeof d.active === 'object' && d.active) return { active: d.active };
  } catch (_) {}
  return { active: {} };
}
function saveState(home, state) {
  fs.mkdirSync(agentDir(home), { recursive: true });
  fs.writeFileSync(stateFile(home), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
function stateKey(scope, name) { return scope + ':' + name; }

// Minimal front-matter: lines "key: value" between --- markers.
function parseSkillMd(text) {
  const out = { name: '', version: '', description: '', body: String(text || '') };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(out.body);
  if (m) {
    out.body = out.body.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const k = kv[1].toLowerCase();
      const v = kv[2].trim().slice(0, 500);
      if (k === 'name') out.name = v;
      else if (k === 'version') out.version = v;
      else if (k === 'description') out.description = v;
    }
  }
  if (!out.description) {
    const h = /^#\s+(.+)$/m.exec(out.body);
    if (h) out.description = h[1].trim().slice(0, 200);
  }
  return out;
}

function readSkillFile(skillPath) {
  const p = path.join(skillPath, 'SKILL.md');
  let st = null;
  try { st = fs.statSync(p); } catch (_) { return { ok: false, code: 'no_skill_md', error: 'SKILL.md introuvable.' }; }
  if (!st.isFile() || st.size > MAX_SKILL_FILE) return { ok: false, code: 'skill_md_too_big', error: 'SKILL.md trop volumineux (>64 Ko).' };
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return { ok: false, code: 'no_skill_md', error: 'SKILL.md illisible.' }; }
  return { ok: true, text };
}

function skillMeta(dirName, text) {
  const parsed = parseSkillMd(text);
  const name = parsed.name || dirName;
  if (!validName(name)) return { ok: false, code: 'bad_skill_name', error: 'nom de skill invalide: ' + String(name).slice(0, 80) };
  return { ok: true, meta: { name, version: parsed.version || '', description: parsed.description || '', body: parsed.body } };
}

function scopeDir(home, projectRoot, scope) {
  if (scope === 'global') return globalDir(home);
  if (scope === 'project') {
    if (!projectRoot || typeof projectRoot !== 'string') return null;
    return projectDir(projectRoot);
  }
  return null;
}

function listSkills(home, projectRoot) {
  const state = loadState(home);
  const out = [];
  const scopes = [['global', globalDir(home)]];
  if (projectRoot && typeof projectRoot === 'string') scopes.push(['project', projectDir(projectRoot)]);
  for (const [scope, dir] of scopes) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || !validName(e.name)) continue;
      const rf = readSkillFile(path.join(dir, e.name));
      if (!rf.ok) { out.push({ scope, name: e.name, broken: rf.code, active: false }); continue; }
      const sm = skillMeta(e.name, rf.text);
      if (!sm.ok) { out.push({ scope, name: e.name, broken: sm.code, active: false }); continue; }
      out.push({ scope, name: sm.meta.name, version: sm.meta.version, description: sm.meta.description,
        active: state.active[stateKey(scope, sm.meta.name)] === true });
    }
  }
  return out;
}

function setActive(home, projectRoot, scope, name, on) {
  if (scope !== 'global' && scope !== 'project') return { ok: false, error: 'scope invalide (global|project).' };
  if (!validName(name)) return { ok: false, error: 'nom de skill invalide.' };
  const dir = scopeDir(home, projectRoot, scope);
  if (!dir) return { ok: false, error: 'racine projet requise pour le scope project.' };
  const found = listSkills(home, projectRoot).some((s) => s.scope === scope && s.name === name && !s.broken);
  if (!found) return { ok: false, error: 'skill introuvable ou invalide: ' + scope + '/' + name };
  const state = loadState(home);
  if (on) state.active[stateKey(scope, name)] = true;
  else delete state.active[stateKey(scope, name)];
  saveState(home, state);
  return { ok: true, active: !!on };
}

// Text injected in the agent system prompt. Only active + valid skills,
// capped. Never throws: failures are reported in `skipped`.
function activeSkillsText(home, projectRoot) {
  const used = [];
  const skipped = [];
  let total = 0;
  const parts = [];
  let skills = [];
  try { skills = listSkills(home, projectRoot); } catch (_) { skills = []; }
  for (const s of skills) {
    if (!s.active || s.broken) continue;
    const dir = scopeDir(home, projectRoot, s.scope);
    const rf = readSkillFile(path.join(dir, s.name));
    if (!rf.ok) { skipped.push({ name: s.scope + '/' + s.name, error: rf.code }); continue; }
    const sm = skillMeta(s.name, rf.text);
    if (!sm.ok) { skipped.push({ name: s.scope + '/' + s.name, error: sm.code }); continue; }
    let body = sm.meta.body.trim();
    if (body.length > MAX_INJECT_PER_SKILL) body = body.slice(0, MAX_INJECT_PER_SKILL) + '\n[...tronque...]';
    if (total + body.length > MAX_INJECT_TOTAL) { skipped.push({ name: s.scope + '/' + s.name, error: 'budget_depasse' }); continue; }
    total += body.length;
    used.push(s.scope + '/' + s.name);
    parts.push('## Skill: ' + s.name + ' (' + s.scope + ')' + (sm.meta.version ? ' v' + sm.meta.version : '') + '\n' + body);
  }
  const text = parts.length ? 'Active skills (follow them):\n' + parts.join('\n\n') : '';
  return { text, used, skipped };
}

// ---- import (preview then activate) --------------------------------------
function isGitSource(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^https:\/\//.test(src)) return true;
  if (/^file:\/\//.test(src)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/.test(src)) return true; // scp-like
  return false;
}

function copyTreeCapped(src, dst, st) {
  const entries = fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') { st.skipped.push(e.name + '/ (ignore)'); continue; }
    if (st.files >= MAX_IMPORT_FILES) { st.skipped.push('... (limite ' + MAX_IMPORT_FILES + ' fichiers)'); break; }
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) { st.skipped.push(e.name + ' (lien symbolique ignore)'); continue; }
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTreeCapped(s, d, st); continue; }
    if (!e.isFile()) continue;
    const sz = fs.statSync(s).size;
    if (st.bytes + sz > MAX_IMPORT_BYTES) { st.skipped.push(e.name + ' (limite taille)'); continue; }
    fs.copyFileSync(s, d);
    st.files += 1; st.bytes += sz;
  }
}

function listRelFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (e.name !== '.git') walk(path.join(d, e.name), r); }
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.slice(0, MAX_IMPORT_FILES);
}

function findSkillRoot(staged) {
  if (fs.existsSync(path.join(staged, 'SKILL.md'))) return staged;
  let entries = [];
  try { entries = fs.readdirSync(staged, { withFileTypes: true }); } catch (_) { return null; }
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== '.git').map((e) => e.name).sort();
  for (const d of dirs) {
    if (fs.existsSync(path.join(staged, d, 'SKILL.md'))) return path.join(staged, d);
  }
  return null;
}

function runGit(args, opts) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = childProcess.spawn('git', args, { shell: false, timeout: 60000,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); return; }
    let err = '';
    if (child.stderr) child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', (code) => resolve({ ok: code === 0, error: err.slice(0, 400) }));
    if (opts && opts.timeoutMs) setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, opts.timeoutMs);
  });
}

function pruneStaging(home) {
  const dir = stagingDir(home);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  const now = Date.now();
  for (const e of entries) {
    if (!STAGE_RE.test(e)) continue;
    try {
      const st = fs.statSync(path.join(dir, e));
      if (now - st.mtimeMs > STAGE_TTL_MS) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    } catch (_) {}
  }
}

function listStaged(home) {
  const dir = stagingDir(home);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  return entries.filter((e) => STAGE_RE.test(e)).sort();
}

// Stage a copy for preview. NOTHING is installed. Returns metadata or a
// coded error; staging dir is removed on failure.
async function previewImport(home, source) {
  pruneStaging(home);
  if (typeof source !== 'string' || !source.trim() || source.length > 2000) {
    return { ok: false, code: 'bad_source', error: 'source invalide.' };
  }
  const src = source.trim();
  const stagingId = crypto.randomBytes(8).toString('hex');
  const staged = path.join(stagingDir(home), stagingId);
  const fail = (code, error) => {
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, code, error };
  };
  try { fs.mkdirSync(staged, { recursive: true }); }
  catch (_) { return { ok: false, code: 'staging_failed', error: 'zone de transit inaccessible.' }; }
  const warnings = [];
  if (isGitSource(src)) {
    const g = await runGit(['clone', '--depth', '1', '--', src, staged + '-repo'], { timeoutMs: 60000 });
    if (!g.ok) {
      try { fs.rmSync(staged + '-repo', { recursive: true, force: true }); } catch (_) {}
      return fail('git_failed', 'clone git impossible: ' + String(g.error || 'git indisponible ?').slice(0, 200));
    }
    try {
      const st = { files: 0, bytes: 0, skipped: [], list: [] };
      copyTreeCapped(staged + '-repo', staged, st);
      warnings.push(...st.skipped);
    } catch (e) {
      try { fs.rmSync(staged + '-repo', { recursive: true, force: true }); } catch (_) {}
      return fail('copy_failed', 'copie impossible: ' + String((e && e.message) || e).slice(0, 160));
    }
    try { fs.rmSync(staged + '-repo', { recursive: true, force: true }); } catch (_) {}
  } else {
    let st = null;
    try { st = fs.statSync(src); } catch (_) { return fail('bad_source', 'dossier local introuvable.'); }
    if (!st.isDirectory()) return fail('bad_source', 'la source locale doit etre un dossier.');
    try {
      const cst = { files: 0, bytes: 0, skipped: [], list: [] };
      copyTreeCapped(src, staged, cst);
      warnings.push(...cst.skipped);
    } catch (e) { return fail('copy_failed', 'copie impossible: ' + String((e && e.message) || e).slice(0, 160)); }
  }
  const root = findSkillRoot(staged);
  if (!root) return fail('no_skill_md', 'SKILL.md introuvable (racine ou un sous-dossier).');
  const dirName = path.basename(root);
  const rf = readSkillFile(root);
  if (!rf.ok) return fail(rf.code, rf.error);
  const sm = skillMeta(dirName === staged ? 'skill' : dirName, rf.text);
  if (!sm.ok) return fail(sm.code, sm.error);
  return { ok: true, stagingId, source: src.length > 300 ? src.slice(0, 300) : src,
    name: sm.meta.name, version: sm.meta.version, description: sm.meta.description,
    files: listRelFiles(staged), warnings,
    excerpt: sm.meta.body.trim().slice(0, 1500) };
}

function discardStaged(home, stagingId) {
  if (!STAGE_RE.test(String(stagingId || ''))) return { ok: false, error: 'identifiant de transit invalide.' };
  try { fs.rmSync(path.join(stagingDir(home), stagingId), { recursive: true, force: true }); } catch (_) {}
  return { ok: true };
}

// Install a staged preview, then activate it. Refuses to overwrite.
function activateStaged(home, projectRoot, stagingId, scope, name) {
  if (!STAGE_RE.test(String(stagingId || ''))) return { ok: false, error: 'identifiant de transit invalide.' };
  const dir = scopeDir(home, projectRoot, scope);
  if (!dir) return { ok: false, error: scope === 'project' ? 'racine projet requise pour le scope project.' : 'scope invalide (global|project).' };
  const staged = path.join(stagingDir(home), stagingId);
  const root = findSkillRoot(staged);
  if (!root) return { ok: false, error: 'transit introuvable ou expire.' };
  const rf = readSkillFile(root);
  if (!rf.ok) return { ok: false, error: rf.error };
  const sm = skillMeta(path.basename(root), rf.text);
  if (!sm.ok) return { ok: false, error: sm.error };
  const finalName = name !== undefined && name !== null && String(name) !== '' ? String(name) : sm.meta.name;
  if (!validName(finalName)) return { ok: false, error: 'nom de skill invalide.' };
  const dest = path.join(dir, finalName);
  if (fs.existsSync(dest)) return { ok: false, error: 'un skill porte deja ce nom (' + scope + '/' + finalName + ').' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(dest);
    const st = { files: 0, bytes: 0, skipped: [], list: [] };
    copyTreeCapped(staged, dest, st);
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: 'installation impossible: ' + String((e && e.message) || e).slice(0, 160) };
  }
  discardStaged(home, stagingId);
  const state = loadState(home);
  state.active[stateKey(scope, finalName)] = true;
  saveState(home, state);
  return { ok: true, scope, name: finalName, active: true };
}

function deleteSkill(home, projectRoot, scope, name) {
  if (scope !== 'global' && scope !== 'project') return { ok: false, error: 'scope invalide (global|project).' };
  if (!validName(name)) return { ok: false, error: 'nom de skill invalide.' };
  const dir = scopeDir(home, projectRoot, scope);
  if (!dir) return { ok: false, error: 'racine projet requise pour le scope project.' };
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return { ok: false, error: 'skill introuvable: ' + scope + '/' + name };
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) {
    return { ok: false, error: 'suppression impossible: ' + String((e && e.message) || e).slice(0, 160) };
  }
  const state = loadState(home);
  delete state.active[stateKey(scope, name)];
  try { saveState(home, state); } catch (_) {}
  return { ok: true };
}

module.exports = {
  globalDir, projectDir, stagingDir, validName,
  listSkills, setActive, activeSkillsText,
  previewImport, activateStaged, discardStaged, listStaged, deleteSkill,
  parseSkillMd,
};
