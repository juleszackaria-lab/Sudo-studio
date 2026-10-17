// Sudo Agent tools (P25-a). read, list, glob, grep, write, edit, patch,
// bash, todo. Every file path is boundary-contained (boundary.js), every
// shell command goes through the P8 sandbox module when present (L1 restricted
// mode + verdicts) plus the P25 default deny list, mutating tools ask unless a
// session/project rule matches, and write refuses to overwrite a file that was
// not read during the session. Stdlib only. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveInRoot } = require('./boundary');
const perm = require('./permissions');
const ckpt = require('./checkpoints');
const { maskSecrets } = require('./journal');

const MAX_READ_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_LIST = 200;
const MAX_GLOB = 200;
const MAX_GREP = 100;
const MAX_GREP_FILE = 256 * 1024;
const MAX_DIFF_LINES = 200;
const MAX_BASH_BYTES = 64 * 1024;
const BASH_DEFAULT_TIMEOUT = 30000;
const BASH_MAX_TIMEOUT = 120000;

// ---------------------------------------------------------------------------
// P8 sandbox module (real one, monorepo). Absent in a bare package -> the
// internal boundary + deny list still apply (fail restricted, journaled).
// ---------------------------------------------------------------------------
let _p8 = null;
let _p8Tried = false;
function p8() {
  if (!_p8Tried) {
    _p8Tried = true;
    try { _p8 = require('../../sudo-ai-extension/src/agent/sandbox.js'); }
    catch (_) { _p8 = null; }
  }
  return _p8;
}
function p8Available() { return !!p8(); }

// Spawn seam: production uses child_process.spawn; tests inject a fake to
// capture hidden-window opts. Never changes production behavior by itself.
let _spawnFn = null;
function setSpawnFn(fn) { _spawnFn = typeof fn === 'function' ? fn : null; }
function spawner() { return _spawnFn || spawn; }

let _l2 = null; // cached per process: { via, reason }
function l2status() {
  if (_l2) return _l2;
  const mod = p8();
  if (!mod) { _l2 = { via: null, reason: 'module P8 absent' }; return _l2; }
  try { _l2 = mod.pickL2(mod.detectL2()); }
  catch (_) { _l2 = { via: null, reason: 'detection impossible' }; }
  return _l2;
}

function filterEnvFallback(input) {
  const out = {};
  const src = input || {};
  for (const k of Object.keys(src)) {
    if (k === 'SUDO_AGENT_TOKEN') continue;
    if (/secret|token|password|passwd|private[_-]?key|api[_-]?key|authorization|credential/i.test(k)) continue;
    out[k] = src[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display diff (prefix/suffix trim). For operator display, not for applying.
// ---------------------------------------------------------------------------
function diffLines(oldStr, newStr) {
  const a = String(oldStr === undefined || oldStr === null ? '' : oldStr).split('\n');
  const b = String(newStr === undefined || newStr === null ? '' : newStr).split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const out = [];
  const ctx = 3;
  for (let i = Math.max(0, pre - ctx); i < pre; i++) out.push('  ' + a[i]);
  for (let i = pre; i < a.length - suf; i++) out.push('- ' + a[i]);
  for (let i = pre; i < b.length - suf; i++) out.push('+ ' + b[i]);
  for (let i = b.length - suf; i < Math.min(b.length, b.length - suf + ctx); i++) out.push('  ' + b[i]);
  if (out.length > MAX_DIFF_LINES) {
    return out.slice(0, MAX_DIFF_LINES).join('\n') + '\n... [diff tronque, ' + out.length + ' lignes]';
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Strict unified-diff applier (no fuzz). Supports multi-file, creation
// (--- /dev/null) and deletion (+++ /dev/null).
// Returns { ok, files:[{ path, action }] } or { ok:false, error }.
// ---------------------------------------------------------------------------
function parsePatch(text) {
  const lines = String(text || '').split('\n');
  const files = [];
  let i = 0;
  const fail = (msg) => ({ ok: false, error: msg });
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('--- ')) { i += 1; continue; } // skip preamble/garbage
    const oldPath = line.slice(4).trim().split('\t')[0];
    i += 1;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) return fail('patch invalide: +++ manquant.');
    const newPath = lines[i].slice(4).trim().split('\t')[0];
    i += 1;
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!m) return fail('patch invalide: en-tete de bloc corrompue.');
      const hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], ops: [] };
      i += 1;
      while (i < lines.length && lines[i].length && (lines[i][0] === ' ' || lines[i][0] === '-' || lines[i][0] === '+' || lines[i][0] === '\\')) {
        // Next file header ends the hunk body (else '--- a/...' would be eaten
        // as a removal line). Headers always use a/, b/ or /dev/null.
        if (/^--- (a\/|\/dev\/null)/.test(lines[i]) || /^\+\+\+ (b\/|\/dev\/null)/.test(lines[i])) break;
        if (lines[i][0] === '\\') { i += 1; continue; } // "\ No newline" marker
        hunk.ops.push({ t: lines[i][0], s: lines[i].slice(1) });
        i += 1;
      }
      hunks.push(hunk);
    }
    if (!hunks.length) return fail('patch invalide: aucun bloc pour ' + newPath + '.');
    files.push({ oldPath, newPath, hunks });
  }
  if (!files.length) return fail('patch vide ou illisible.');
  return { ok: true, files };
}

function stripAB(p) {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function applyHunks(content, hunks) {
  const hasNL = content.endsWith('\n');
  const src = (hasNL ? content.slice(0, -1) : content).split('\n');
  if (src.length === 1 && src[0] === '') src.length = 0;
  const out = [];
  let pos = 0; // 0-based cursor in src
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const at = h.oldStart === 0 ? 0 : h.oldStart - 1;
    if (at < pos) return { ok: false, error: 'blocs dans le desordre (bloc ' + (hi + 1) + ').' };
    while (pos < at) { out.push(src[pos]); pos += 1; }
    for (const op of h.ops) {
      if (op.t === ' ') {
        if (src[pos] !== op.s) return { ok: false, error: 'contexte different (bloc ' + (hi + 1) + ', ligne ' + (pos + 1) + ').' };
        out.push(src[pos]); pos += 1;
      } else if (op.t === '-') {
        if (src[pos] !== op.s) return { ok: false, error: 'ligne a retirer absente (bloc ' + (hi + 1) + ', ligne ' + (pos + 1) + ').' };
        pos += 1;
      } else {
        out.push(op.s);
      }
    }
  }
  while (pos < src.length) { out.push(src[pos]); pos += 1; }
  return { ok: true, text: out.join('\n') + (out.length ? '\n' : '') };
}

// ---------------------------------------------------------------------------
// Minimal glob (** / * / ?) over a bounded walk.
// ---------------------------------------------------------------------------
function globToRegExp(pattern) {
  let re = '^';
  const p = String(pattern || '');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if ('.+^${}()|[]\\'.indexOf(c) !== -1) { re += '\\' + c; }
    else { re += c; }
  }
  return new RegExp(re + '$');
}

function walkRel(root, dirAbs, maxEntries) {
  const out = [];
  const stop = () => out.length >= maxEntries;
  const visit = (dir, rel) => {
    if (stop()) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (stop()) return;
      const r = rel ? rel + '/' + e.name : e.name;
      try {
        if (e.isSymbolicLink()) { out.push({ rel: r, type: 'link' }); }
        else if (e.isDirectory()) { out.push({ rel: r, type: 'dir' }); visit(path.join(dir, e.name), r); }
        else if (e.isFile()) {
          let size = -1;
          try { size = fs.statSync(path.join(dir, e.name)).size; } catch (_) {}
          out.push({ rel: r, type: 'file', size });
        }
      } catch (_) {}
    }
  };
  const base = dirAbs ? path.relative(root, dirAbs) : '';
  visit(dirAbs || root, base === '' ? '' : base.split(path.sep).join('/'));
  return { entries: out, truncated: out.length >= maxEntries };
}

// ---------------------------------------------------------------------------
// Tool handlers. Each: async (ctx, args, resolved) -> result envelope.
// result: { ok, data?, error?, code?, summary, markRead?:[rel], created?:[rel], diff? }.
// ---------------------------------------------------------------------------
function isText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

async function hRead(ctx, args, resolved) {
  const file = args.file;
  if (typeof file !== 'string' || !file.trim()) return { ok: false, code: 'bad_args', error: 'read: file requis.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'read refuse: ' + r.reason };
  let buf = null;
  try { buf = fs.readFileSync(r.abs); }
  catch (_) { return { ok: false, code: 'not_found', error: 'read: fichier introuvable : ' + r.rel }; }
  if (buf.length > MAX_READ_BYTES) return { ok: false, code: 'too_big', error: 'read: fichier trop volumineux (' + buf.length + ' octets).' };
  if (!isText(buf)) return { ok: true, data: { rel: r.rel, binary: true, size: buf.length }, summary: 'fichier binaire (' + buf.length + ' octets), contenu non affiche.', markRead: [r.rel] };
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const limit = Math.min(MAX_READ_LINES, Math.max(1, parseInt(args.limit, 10) || MAX_READ_LINES));
  const slice = lines.slice(offset, offset + limit);
  return {
    ok: true,
    data: { rel: r.rel, offset, totalLines: lines.length, truncated: offset + limit < lines.length, content: slice.join('\n') },
    summary: 'lu ' + r.rel + ' (' + slice.length + '/' + lines.length + ' lignes).',
    markRead: [r.rel],
  };
}

async function hList(ctx, args, resolved) {
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'list refuse: ' + r.reason };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, code: 'not_found', error: 'list: dossier introuvable : ' + (r.rel || '.') }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_dir', error: 'list: pas un dossier : ' + r.rel };
  const recursive = args.recursive === true;
  const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || MAX_LIST));
  if (!recursive) {
    let names = [];
    try { names = fs.readdirSync(r.abs); } catch (e) { return { ok: false, code: 'io', error: 'list: ' + String((e && e.message) || e).slice(0, 150) }; }
    names.sort();
    const entries = names.slice(0, limit).map((n) => {
      let t = '?';
      try { const s = fs.statSync(path.join(r.abs, n)); t = s.isDirectory() ? 'dir' : 'file'; } catch (_) {}
      return { name: n, type: t };
    });
    return { ok: true, data: { dir: r.rel || '.', entries, truncated: names.length > limit }, summary: entries.length + ' entrees dans ' + (r.rel || '.') + '.' };
  }
  const w = walkRel(ctx.root, r.abs, limit);
  return { ok: true, data: { dir: r.rel || '.', entries: w.entries, truncated: w.truncated }, summary: w.entries.length + ' entrees (recursif).' };
}

async function hGlob(ctx, args, resolved) {
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, code: 'bad_args', error: 'glob: pattern requis.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'glob refuse: ' + r.reason };
  let re = null;
  try { re = globToRegExp(pattern.trim()); } catch (_) { return { ok: false, code: 'bad_pattern', error: 'glob: motif invalide.' }; }
  const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || MAX_GLOB));
  const w = walkRel(ctx.root, r.abs, Math.max(limit * 2, 500));
  const base = r.rel ? r.rel + '/' : '';
  const matches = [];
  for (const e of w.entries) {
    if (e.type !== 'file') continue;
    const rel = base ? (e.rel.indexOf(base) === 0 ? e.rel : base + e.rel) : e.rel;
    const short = base && rel.indexOf(base) === 0 ? rel.slice(base.length) : rel;
    if (re.test(short) || re.test(rel)) {
      matches.push(rel);
      if (matches.length >= limit) break;
    }
  }
  return { ok: true, data: { pattern, matches, truncated: matches.length >= limit }, summary: matches.length + ' fichiers.' };
}

async function hGrep(ctx, args, resolved) {
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || !pattern) return { ok: false, code: 'bad_args', error: 'grep: pattern requis.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'grep refuse: ' + r.reason };
  let re = null;
  try { re = new RegExp(pattern, 'm'); } catch (_) { return { ok: false, code: 'bad_pattern', error: 'grep: expression invalide.' }; }
  const limit = Math.min(500, Math.max(1, parseInt(args.limit, 10) || MAX_GREP));
  const w = walkRel(ctx.root, r.abs, 2000);
  const base = r.rel ? r.rel + '/' : '';
  const matches = [];
  let filesScanned = 0;
  for (const e of w.entries) {
    if (matches.length >= limit) break;
    if (e.type !== 'file') continue;
    if (e.size > MAX_GREP_FILE) continue;
    const rel = base && e.rel.indexOf(base) !== 0 ? base + e.rel : e.rel;
    let buf = null;
    try { buf = fs.readFileSync(path.join(ctx.root, rel)); } catch (_) { continue; }
    if (!isText(buf)) continue;
    filesScanned += 1;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200) });
    }
  }
  return { ok: true, data: { pattern, matches, filesScanned, truncated: matches.length >= limit }, summary: matches.length + ' occurrences.' };
}

async function hWrite(ctx, args, resolved) {
  if (typeof args.content !== 'string') return { ok: false, code: 'bad_args', error: 'write: content (string) requis.' };
  if (args.content.length > 2 * 1024 * 1024) return { ok: false, code: 'too_big', error: 'write: contenu trop volumineux.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'write refuse: ' + r.reason };
  let exists = false;
  try { exists = fs.statSync(r.abs).isFile(); } catch (_) { exists = false; }
  if (exists) {
    // P25-c: overwrite only a file READ during this session, with a shown diff.
    const readFiles = (ctx.session && ctx.session.meta && Array.isArray(ctx.session.meta.readFiles)) ? ctx.session.meta.readFiles : [];
    if (readFiles.indexOf(r.rel) === -1) {
      return { ok: false, code: 'not_read', error: 'write refuse : ' + r.rel + ' existe et n\'a pas ete lu pendant la session. Lisez-le d\'abord (protection contre l\'ecrasement).' };
    }
    let oldText = '';
    try { oldText = fs.readFileSync(r.abs, 'utf8'); } catch (e) { return { ok: false, code: 'io', error: 'write: relecture impossible.' }; }
    const diff = diffLines(oldText, args.content);
    try {
      const tmp = r.abs + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, args.content, 'utf8');
      fs.renameSync(tmp, r.abs);
    } catch (e) { return { ok: false, code: 'io', error: 'write: ' + String((e && e.message) || e).slice(0, 150) }; }
    return { ok: true, data: { rel: r.rel, overwritten: true, bytes: args.content.length }, summary: 'remplace ' + r.rel + ' (apres lecture + diff).', diff, markRead: [r.rel] };
  }
  try {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    // mkdir -p above could only create inside root: abs is contained, parents too.
    fs.writeFileSync(r.abs, args.content, 'utf8');
  } catch (e) { return { ok: false, code: 'io', error: 'write: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { rel: r.rel, overwritten: false, bytes: args.content.length }, summary: 'cree ' + r.rel + '.', created: [r.rel], markRead: [r.rel] };
}

async function hEdit(ctx, args, resolved) {
  if (typeof args.old !== 'string' || !args.old) return { ok: false, code: 'bad_args', error: 'edit: old (chaine exacte) requis.' };
  if (typeof args.new !== 'string') return { ok: false, code: 'bad_args', error: 'edit: new (string) requis.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'edit refuse: ' + r.reason };
  let text = null;
  try { text = fs.readFileSync(r.abs, 'utf8'); } catch (_) { return { ok: false, code: 'not_found', error: 'edit: fichier introuvable : ' + r.rel }; }
  const parts = text.split(args.old);
  const count = parts.length - 1;
  if (count === 0) return { ok: false, code: 'not_found', error: 'edit: chaine introuvable dans ' + r.rel + '.' };
  if (count > 1) return { ok: false, code: 'ambiguous', error: 'edit: chaine ambigue (' + count + ' occurrences dans ' + r.rel + '). Precisez un bloc unique.' };
  const next = parts.join(args.new);
  const diff = diffLines(text, next);
  try {
    const tmp = r.abs + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, r.abs);
  } catch (e) { return { ok: false, code: 'io', error: 'edit: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { rel: r.rel, bytes: next.length }, summary: 'modifie ' + r.rel + ' (1 remplacement).', diff, markRead: [r.rel] };
}

async function hPatch(ctx, args) {
  if (typeof args.patch !== 'string' || !args.patch.trim()) return { ok: false, code: 'bad_args', error: 'patch: patch (diff unifie) requis.' };
  const parsed = parsePatch(args.patch);
  if (!parsed.ok) return { ok: false, code: 'bad_patch', error: 'patch: ' + parsed.error };
  // Resolve + read ALL targets first; apply only if every hunk verifies.
  const plan = [];
  for (const f of parsed.files) {
    const newRel = stripAB(f.newPath);
    const oldRel = stripAB(f.oldPath);
    const rel = newRel !== null ? newRel : oldRel;
    if (rel === null) return { ok: false, code: 'bad_patch', error: 'patch: chemin manquant.' };
    const r = resolveInRoot(ctx.root, rel);
    if (!r.ok) return { ok: false, code: r.code, error: 'patch refuse (' + rel.slice(0, 80) + ') : ' + r.reason };
    if (newRel === null) {
      plan.push({ r, action: 'delete' });
      continue;
    }
    let current = null;
    let exists = false;
    try { const st = fs.statSync(r.abs); exists = st.isFile(); } catch (_) { exists = false; }
    if (oldRel === null) {
      if (exists) return { ok: false, code: 'exists', error: 'patch: ' + r.rel + ' existe deja (creation refusee).' };
      current = '';
    } else {
      if (!exists) return { ok: false, code: 'not_found', error: 'patch: fichier introuvable : ' + r.rel };
      try { current = fs.readFileSync(r.abs, 'utf8'); } catch (_) { return { ok: false, code: 'io', error: 'patch: lecture impossible : ' + r.rel }; }
    }
    const applied = applyHunks(current, f.hunks);
    if (!applied.ok) return { ok: false, code: 'mismatch', error: 'patch: ' + r.rel + ' : ' + applied.error };
    plan.push({ r, action: oldRel === null ? 'create' : 'modify', next: applied.text, diff: diffLines(current, applied.text) });
  }
  const touched = [];
  const created = [];
  try {
    for (const p of plan) {
      if (p.action === 'delete') {
        try { fs.unlinkSync(p.r.abs); } catch (_) { return { ok: false, code: 'io', error: 'patch: suppression impossible : ' + p.r.rel }; }
      } else {
        fs.mkdirSync(path.dirname(p.r.abs), { recursive: true });
        const tmp = p.r.abs + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, p.next, 'utf8');
        fs.renameSync(tmp, p.r.abs);
        if (p.action === 'create') created.push(p.r.rel);
      }
      touched.push(p.r.rel + ' (' + p.action + ')');
    }
  } catch (e) { return { ok: false, code: 'io', error: 'patch: ' + String((e && e.message) || e).slice(0, 150) }; }
  return {
    ok: true, data: { files: touched },
    summary: 'patch applique : ' + touched.join(', ') + '.',
    diff: plan.map((p) => '=== ' + p.r.rel + ' (' + p.action + ')\n' + (p.diff || '(supprime)')).join('\n').slice(0, 20000),
    created,
    markRead: plan.filter((p) => p.action !== 'delete').map((p) => p.r.rel),
  };
}

function killTree(child) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return 'pgid'; } catch (_) {}
    }
    try { child.kill('SIGKILL'); } catch (_) {}
    if (process.platform === 'win32' && child.pid) {
      try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {}); } catch (_) {}
    }
    return 'pid';
  } catch (_) { return 'none'; }
}

async function hBash(ctx, args, resolved) {
  const command = args.command;
  if (typeof command !== 'string' || !command.trim()) return { ok: false, code: 'bad_args', error: 'bash: command requise.' };
  if (command.length > 8000) return { ok: false, code: 'too_big', error: 'bash: commande trop longue.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'bash refuse (dossier) : ' + r.reason };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, code: 'not_found', error: 'bash: dossier introuvable.' }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_dir', error: 'bash: pas un dossier.' };
  const timeoutMs = Math.min(BASH_MAX_TIMEOUT, Math.max(1000, parseInt(args.timeoutMs, 10) || BASH_DEFAULT_TIMEOUT));
  const mod = p8();
  const env = mod ? mod.filterSpawnEnv(process.env).env : filterEnvFallback(process.env);
  const l2 = l2status();
  const shell = process.platform === 'win32'
    ? { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { bin: '/bin/sh', args: ['-c', command] };
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (res) => {
      if (settled) return; settled = true;
      try { clearTimeout(timer); } catch (_) {}
      resolve(res);
    };
    try {
      child = spawner()(shell.bin, shell.args, {
        cwd: r.abs, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      finish({ ok: false, code: 'spawn', error: 'bash: lancement impossible (' + String((e && e.message) || e).slice(0, 120) + ').' });
      return;
    }
    const killHow = { how: null };
    const killer = () => { killHow.how = killTree(child); };
    if (ctx.run) ctx.run.killFns.push(killer);
    if (ctx.sessionKill) ctx.sessionKill.push(killer);
    const timer = setTimeout(() => {
      timedOut = true;
      killer();
      finish({ ok: false, code: 'timeout', error: 'bash: delai depasse (' + timeoutMs + ' ms), processus tue.', summary: 'tuee (timeout).', data: { killed: true, timeoutMs, ms: Date.now() - t0 } });
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // Drain-and-discard past the caps: never destroy the pipe (that would
    // SIGPIPE the child and lie about its exit code).
    child.stdout.on('data', (c) => { if (stdout.length < 262144) stdout = (stdout + c).slice(0, 262144); });
    child.stderr.on('data', (c) => { if (stderr.length < 65536) stderr = (stderr + c).slice(0, 65536); });
    child.on('error', (e) => finish({ ok: false, code: 'spawn', error: 'bash: ' + String((e && e.message) || e).slice(0, 150) }));
    child.on('exit', (code, signal) => {
      if (timedOut) return;
      const ms = Date.now() - t0;
      const full = stdout + (stderr ? '\n[stderr]\n' + stderr : '');
      let output = full;
      let truncated = false;
      if (output.length > MAX_BASH_BYTES) {
        output = output.slice(0, MAX_BASH_BYTES);
        truncated = true;
      }
      if (ctx.log) {
        try {
          ctx.log.info('bash exec', { level: 'L1', l2via: l2.via || 'none', code, ms, outChars: full.length, truncated, cmd: maskSecrets(command).slice(0, 200) }, ctx.corr);
        } catch (_) {}
      }
      if (code !== 0) {
        finish({ ok: false, code: 'exit_' + code, error: 'bash: sortie ' + code + (signal ? ' (' + signal + ')' : '') + '.\n' + output.slice(-2000), summary: 'sortie ' + code + '.', data: { code, signal, ms, truncated, output } });
        return;
      }
      finish({ ok: true, data: { code: 0, ms, truncated, output }, summary: 'bash ok (' + ms + ' ms).' });
    });
  });
}

async function hTodo(ctx, args) {
  const op = args.op;
  if (['add', 'list', 'done', 'clear'].indexOf(op) === -1) return { ok: false, code: 'bad_args', error: 'todo: op add|list|done|clear requis.' };
  const s = ctx.store.get(ctx.sessionId);
  if (!s) return { ok: false, code: 'not_found', error: 'todo: session introuvable.' };
  if (!s.meta) s.meta = {};
  if (!Array.isArray(s.meta.todos)) s.meta.todos = [];
  if (op === 'list') return { ok: true, data: { todos: s.meta.todos }, summary: s.meta.todos.length + ' taches.' };
  if (op === 'clear') {
    const n = s.meta.todos.length;
    ctx.store.update(ctx.sessionId, (x) => { x.meta.todos = []; });
    return { ok: true, data: { cleared: n }, summary: 'liste effacee (' + n + ').' };
  }
  if (op === 'add') {
    if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, code: 'bad_args', error: 'todo add: text requis.' };
    if (s.meta.todos.length >= 100) return { ok: false, code: 'too_many', error: 'todo: liste pleine (100).' };
    const item = { id: 't' + (s.meta.todoSeq = (s.meta.todoSeq || 0) + 1), text: args.text.trim().slice(0, 500), done: false, at: new Date().toISOString() };
    ctx.store.update(ctx.sessionId, (x) => { x.meta.todos.push(item); x.meta.todoSeq = s.meta.todoSeq; });
    return { ok: true, data: { item }, summary: 'tache ajoutee (' + item.id + ').' };
  }
  const id = String(args.id || '');
  const it = s.meta.todos.find((t) => t.id === id);
  if (!it) return { ok: false, code: 'not_found', error: 'todo: tache introuvable : ' + id.slice(0, 20) };
  ctx.store.update(ctx.sessionId, (x) => { const f = x.meta.todos.find((t) => t.id === id); if (f) f.done = true; });
  return { ok: true, data: { id }, summary: 'tache terminee (' + id + ').' };
}

// ---------------------------------------------------------------------------
// Tool table: metadata + arg path (for boundary) + handler.
// ---------------------------------------------------------------------------
const TOOLS = {
  read: { description: 'Lit un fichier du projet (borne, tronque). Marque le fichier comme lu.', danger: 'read', mutating: false, pathArg: 'file', defDir: '.', handler: hRead },
  list: { description: 'Liste un dossier du projet (borne).', danger: 'read', mutating: false, pathArg: 'dir', defDir: '.', handler: hList },
  glob: { description: 'Recherche de fichiers par motif (*, ?, **).', danger: 'read', mutating: false, pathArg: 'dir', defDir: '.', handler: hGlob },
  grep: { description: 'Recherche textuelle (regex) dans le projet, bornee.', danger: 'read', mutating: false, pathArg: 'path', defDir: '.', handler: hGrep },
  write: { description: 'Cree ou remplace un fichier. Remplacement refuse si non lu pendant la session (diff affiche).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hWrite },
  edit: { description: 'Remplace une chaine exacte unique (echec clair si absente ou ambigue).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hEdit },
  patch: { description: 'Applique un diff unifie strict (multi-fichiers, creation, suppression).', danger: 'write', mutating: true, pathArg: null, defDir: null, handler: hPatch },
  bash: { description: 'Execute une commande (fenetre masquee, delai, sortie tronquee, annulable, sandbox P8 L1).', danger: 'execute', mutating: true, pathArg: 'cwd', defDir: '.', handler: hBash },
  todo: { description: 'Liste de taches de session (add/list/done/clear).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hTodo },
};

function toolNames() { return Object.keys(TOOLS); }

function toOpenAISchema() {
  const str = (d) => ({ type: 'string', description: d });
  const schemas = {
    read: { file: str('Project-relative file path.'), offset: { type: 'integer' }, limit: { type: 'integer' } },
    list: { dir: str('Project-relative directory (default root).'), recursive: { type: 'boolean' }, limit: { type: 'integer' } },
    glob: { pattern: str('Glob pattern, e.g. src/**/*.js.'), dir: str('Base directory.'), limit: { type: 'integer' } },
    grep: { pattern: str('Regular expression.'), path: str('File or directory to search.'), limit: { type: 'integer' } },
    write: { file: str('Project-relative file path.'), content: str('Full new content.') },
    edit: { file: str('Project-relative file path.'), old: str('Exact unique string to replace.'), new: str('Replacement.') },
    patch: { patch: str('Unified diff text.') },
    bash: { command: str('Shell command.'), cwd: str('Working directory.'), timeoutMs: { type: 'integer' } },
    todo: { op: str('add|list|done|clear.'), text: str('Task text (add).'), id: str('Task id (done).') },
  };
  const required = { read: ['file'], glob: ['pattern'], grep: ['pattern'], write: ['file', 'content'], edit: ['file', 'old', 'new'], patch: ['patch'], bash: ['command'], todo: ['op'] };
  return toolNames().map((n) => ({ type: 'function', function: { name: n, description: TOOLS[n].description, parameters: { type: 'object', properties: schemas[n], required: required[n] || [] } } }));
}

function markReadFiles(ctx, rels) {
  if (!rels || !rels.length) return;
  try {
    ctx.store.update(ctx.sessionId, (s) => {
      if (!s.meta) s.meta = {};
      if (!Array.isArray(s.meta.readFiles)) s.meta.readFiles = [];
      for (const r of rels) {
        if (s.meta.readFiles.indexOf(r) === -1) s.meta.readFiles.push(r);
      }
      while (s.meta.readFiles.length > 500) s.meta.readFiles.shift();
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Pipeline: boundary -> P8 verdicts -> P25 deny -> permission -> checkpoint ->
// execute -> record. Returns:
// { status:'done', call } | { status:'need-approval', request } |
// { status:'denied', reason, code } | { status:'error', reason, code }.
// ---------------------------------------------------------------------------
async function executeTool(ctx, toolName, args, opts) {
  opts = opts || {};
  args = args && typeof args === 'object' ? args : {};
  const t0 = Date.now();
  const def = TOOLS[toolName];
  if (!def) return { status: 'error', reason: 'outil inconnu : ' + String(toolName).slice(0, 40), code: 'unknown_tool' };
  if (!ctx.root) return { status: 'denied', reason: 'aucun dossier de projet sur cette session.', code: 'no_project' };

  // 1. Boundary resolution for path-bearing tools.
  let resolved = { ok: true, abs: ctx.root, rel: '', flavor: 'posix' };
  if (def.pathArg) {
    const raw = args[def.pathArg] === undefined || args[def.pathArg] === null || args[def.pathArg] === '' ? def.defDir : args[def.pathArg];
    if (raw === null || raw === undefined) return { status: 'error', reason: toolName + ': chemin requis (' + def.pathArg + ').', code: 'bad_args' };
    resolved = resolveInRoot(ctx.root, raw);
    if (!resolved.ok) {
      recordCall(ctx, toolName, args, false, resolved.code, Date.now() - t0);
      return { status: 'denied', reason: toolName + ' refuse : ' + resolved.reason, code: resolved.code };
    }
  }

  // 2. Anti-overwrite gate (P25-c): an existing file can only be replaced by
  // `write` after being read during the session. Runs BEFORE permissions:
  // even an allow rule cannot bypass it.
  if (toolName === 'write' && resolved.ok) {
    let exists = false;
    try { exists = fs.statSync(resolved.abs).isFile(); } catch (_) { exists = false; }
    if (exists) {
      const readFiles = (ctx.session && ctx.session.meta && Array.isArray(ctx.session.meta.readFiles)) ? ctx.session.meta.readFiles : [];
      if (readFiles.indexOf(resolved.rel) === -1) {
        const reason = 'write refuse : ' + resolved.rel + ' existe et n\'a pas ete lu pendant la session. Lisez-le d\'abord (protection contre l\'ecrasement).';
        const call = recordCall(ctx, toolName, args, false, 'not_read', Date.now() - t0, reason);
        call.error = reason;
        return { status: 'error', reason, code: 'not_read', call };
      }
    }
  }

  // 3. P8 verdicts (when the module is present).
  const mod = p8();
  let p8verdict = null;
  try {
    if (mod) {
      if (toolName === 'bash') p8verdict = mod.evaluateBash(args.command, { projectRoot: ctx.root });
      else if (toolName === 'write' || toolName === 'edit' || toolName === 'patch') {
        const ps = toolName === 'patch' ? [] : [resolved.abs];
        p8verdict = mod.evaluateEdit(ps, { projectRoot: ctx.root });
      }
    }
  } catch (_) { p8verdict = null; }

  // 4. P25 default deny list (shell).
  let denyHit = null;
  if (toolName === 'bash') denyHit = perm.matchDenyList(args.command);

  // 5. Permission.
  const pattern = perm.patternOf(toolName, args, resolved);
  const sessionRules = ctx.sessionRules || new Set();
  const projectRules = ctx.projectRules || new Set();
  const chk = perm.check({ tool: toolName, pattern, p8verdict, denyList: denyHit, sessionRules, projectRules });
  if (chk.decision === 'deny') {
    recordCall(ctx, toolName, args, false, 'denied', Date.now() - t0);
    return { status: 'denied', reason: chk.reason, code: 'denied' };
  }
  if (chk.decision === 'ask' && !opts.preApproved) {
    const request = {
      id: 'appr-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(16),
      sessionId: ctx.sessionId, tool: toolName, pattern, at: new Date().toISOString(),
      summary: toolName + ' : ' + (pattern.text || '?').slice(0, 160),
      diff: null, args: cappedArgs(toolName, args),
    };
    // Overwrite diff preview: show it BEFORE the operator decides (P25-c).
    if ((toolName === 'write' || toolName === 'edit') && resolved.ok) {
      try {
        const oldText = fs.readFileSync(resolved.abs, 'utf8');
        const preview = toolName === 'write' ? String(args.content || '') : previewEdit(oldText, args.old, args.new);
        if (preview !== null) request.diff = diffLines(oldText, preview).slice(0, 20000);
      } catch (_) { request.diff = toolName === 'write' ? '(nouveau fichier)' : null; }
    }
    if (toolName === 'patch' && typeof args.patch === 'string') request.diff = args.patch.slice(0, 20000);
    if (toolName === 'bash') request.l2 = l2status();
    return { status: 'need-approval', request };
  }

  // 6. Checkpoint before the first mutating execution of the series.
  if (def.mutating && ctx.run && !ctx.run.checkpointed && typeof ctx.checkpoint === 'function') {
    try { await ctx.checkpoint(); } catch (e) {
      return { status: 'error', reason: 'instantane impossible : ' + String((e && e.message) || e).slice(0, 150), code: 'checkpoint' };
    }
  }

  // 7. Execute.
  let res = null;
  try { res = await def.handler(ctx, args, resolved); }
  catch (e) { res = { ok: false, code: 'exception', error: toolName + ': ' + String((e && e.message) || e).slice(0, 200) }; }
  const ms = Date.now() - t0;
  if (res.markRead) markReadFiles(ctx, res.markRead);
  if (res.created && ctx.run) { for (const c of res.created) { if (ctx.run.created.indexOf(c) === -1) ctx.run.created.push(c); } }
  const call = recordCall(ctx, toolName, args, !!res.ok, res.ok ? 'ok' : (res.code || 'error'), ms, res.summary || res.error);
  call.result = res.ok ? (res.data || null) : null;
  call.error = res.ok ? null : (res.error || 'echec.');
  call.diff = res.diff || null;
  if (ctx.log) {
    try {
      ctx.log[res.ok ? 'info' : 'warn']('tool ' + (res.ok ? 'ok' : 'fail'), { tool: toolName, target: pattern.text.slice(0, 120), code: call.code, ms, rule: (chk.rule || 'none') + (opts.preApproved ? '+approved' : '') }, ctx.corr);
    } catch (_) {}
  }
  if (!res.ok) return { status: 'error', reason: res.error, code: res.code || 'error', call };
  return { status: 'done', call };
}

function recordCall(ctx, toolName, args, ok, code, ms, summary) {
  const call = { tool: toolName, target: toolTarget(toolName, args), ok: !!ok, code, ms, at: new Date().toISOString(), summary: String(summary || '').slice(0, 300) };
  if (ctx.run) ctx.run.calls.push(call);
  return call;
}

function toolTarget(toolName, args) {
  args = args || {};
  const v = args.file || args.dir || args.path || args.cwd || args.pattern || args.command || args.op || args.scope || '';
  return String(v).slice(0, 200);
}

function cappedArgs(toolName, args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const v = args[k];
    out[k] = typeof v === 'string' ? v.slice(0, 4000) : v;
  }
  if ((toolName === 'write') && typeof out.content === 'string' && args.content.length > 4000) out.contentTruncated = true;
  if ((toolName === 'patch') && typeof out.patch === 'string' && args.patch.length > 4000) out.patchTruncated = true;
  return out;
}

function previewEdit(oldText, oldStr, newStr) {
  if (typeof oldStr !== 'string' || !oldStr || typeof newStr !== 'string') return null;
  const parts = String(oldText).split(oldStr);
  if (parts.length - 1 !== 1) return null;
  return parts.join(newStr);
}

// Snapshot before the first mutating execution of a series (P25-d). The run
// sidecar (<name>.run.json) records creations for honest undo.
async function ensureSeriesCheckpoint(ctx) {
  if (!ctx.run || ctx.run.checkpointed) return ctx.run ? ctx.run.checkpointName : null;
  const snap = ckpt.snapshotProject(ctx.root, {});
  // Sequence-prefixed name: listing order == creation order (same-ms safe).
  let seq = 0;
  try { seq = ckpt.listSnapshots(ctx.home, ctx.sessionId).filter((n) => n.slice(-4) !== '.run').length; } catch (_) { seq = 0; }
  const name = String(seq).padStart(6, '0') + '-c' + Date.now().toString(36) + Math.floor(Math.random() * 0xffff).toString(16);
  ckpt.saveSnapshot(ctx.home, ctx.sessionId, name, snap);
  ctx.run.checkpointed = true;
  ctx.run.checkpointName = name;
  ctx.run.snapshot = snap;
  if (ctx.log) {
    try { ctx.log.info('checkpoint', { session: ctx.sessionId, name, files: Object.keys(snap.files).length, truncated: snap.truncated }, ctx.corr); } catch (_) {}
  }
  return name;
}

function saveRunSidecar(ctx) {
  if (!ctx.run || !ctx.run.checkpointName) return;
  try {
    ckpt.saveSnapshot(ctx.home, ctx.sessionId, ctx.run.checkpointName + '.run', {
      at: new Date().toISOString(), turn: ctx.run.id, created: ctx.run.created.slice(),
      calls: ctx.run.calls.map((c) => ({ tool: c.tool, target: c.target, ok: c.ok, code: c.code })),
    });
  } catch (_) {}
}

module.exports = {
  TOOLS,
  toolNames,
  toOpenAISchema,
  executeTool,
  ensureSeriesCheckpoint,
  saveRunSidecar,
  diffLines,
  parsePatch,
  applyHunks,
  globToRegExp,
  p8Available,
  l2status,
  setSpawnFn,
  filterEnvFallback,
  MAX_READ_BYTES,
  MAX_BASH_BYTES,
  BASH_DEFAULT_TIMEOUT,
  BASH_MAX_TIMEOUT,
};
