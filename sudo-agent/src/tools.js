// Sudo Agent tools (P25-a). read, list, glob, grep, write, edit, patch,
// bash, delete, rename, append, mkdir (+ registry-only todo/reply/done).
// Every file path is boundary-contained (boundary.js), every shell command
// goes through the P8 sandbox module when present (L1 restricted mode +
// verdicts) plus the P25 default deny list, mutating tools ask unless a
// session/project rule matches, and write is CREATE-ONLY (existing files
// go through edit/append). Stdlib only. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveInRoot } = require('./boundary');
const perm = require('./permissions');
const ckpt = require('./checkpoints');
const { maskSecrets } = require('./journal');
const { PLAN_REFUSED } = require('./modes');
const pmap = require('./projectmap');
const profiles = require('./profiles');
const verifyMod = require('./verify');
const mcpMod = require('./mcp');
const execMod = require('./exec');
const genMod = require('./gen');
const bizMod = require('./biz');

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

// P39-b: not_found is never bare: close files + parent listing (bounded).
function richNotFound(tool, ctx, r, fallbackRel) {
  const hint = pmap.notFoundHint(ctx.root, r.abs);
  return { ok: false, code: 'not_found', error: tool + ': ' + pmap.formatNotFound(r.rel || fallbackRel, hint) };
}

async function hRead(ctx, args, resolved) {
  const file = args.file;
  if (typeof file !== 'string' || !file.trim()) return { ok: false, code: 'bad_args', error: 'read: file requis.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'read refuse: ' + r.reason };
  let buf = null;
  try { buf = fs.readFileSync(r.abs); }
  catch (_) { return richNotFound('read', ctx, r, '.'); }
  if (buf.length > MAX_READ_BYTES) return { ok: false, code: 'too_big', error: 'read: fichier trop volumineux (' + buf.length + ' octets).' };
  if (!isText(buf)) return { ok: true, data: { rel: r.rel, binary: true, size: buf.length }, summary: 'fichier binaire (' + buf.length + ' octets), contenu non affiche.', markRead: [r.rel] };
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const limit = Math.min(MAX_READ_LINES, Math.max(1, parseInt(args.limit, 10) || MAX_READ_LINES));
  const slice = lines.slice(offset, offset + limit);
  // P43-3: truncated reads tell the model how to continue (offset/limit).
  // Line numbers are 1-based: next window starts right after this one.
  const cut = offset + limit < lines.length;
  const cont = cut ? ('suite : lignes ' + (offset + limit + 1) + '-' + Math.min(lines.length, offset + 2 * limit)) : '';
  return {
    ok: true,
    data: { rel: r.rel, offset, totalLines: lines.length, truncated: cut, content: slice.join('\n'), continuation: cont || undefined },
    summary: 'lu ' + r.rel + ' (' + slice.length + '/' + lines.length + ' lignes).' + (cont ? ' ' + cont + '.' : ''),
    markRead: [r.rel],
  };
}

async function hList(ctx, args, resolved) {
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'list refuse: ' + r.reason };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return richNotFound('list', ctx, r, '.'); }
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

async function hAppend(ctx, args, resolved) {
  if (typeof args.content !== 'string' || !args.content) return { ok: false, code: 'bad_args', error: 'append: content (string non vide) requis.' };
  if (args.content.length > 2 * 1024 * 1024) return { ok: false, code: 'too_big', error: 'append: contenu trop volumineux.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'append refuse: ' + r.reason };
  let oldText = '';
  let existed = false;
  try {
    const st = fs.statSync(r.abs);
    if (!st.isFile()) return { ok: false, code: 'is_dir', error: 'append refuse : ' + r.rel + ' est un dossier.' };
    existed = true;
    oldText = fs.readFileSync(r.abs, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') return { ok: false, code: 'io', error: 'append: lecture impossible.' };
  }
  const next = oldText + (oldText && oldText[oldText.length - 1] !== '\n' ? '\n' : '') + args.content;
  const diff = diffLines(oldText, next);
  try {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    const tmp = r.abs + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, r.abs);
  } catch (e) { return { ok: false, code: 'io', error: 'append: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { rel: r.rel, appended: args.content.length, bytes: next.length },
    summary: existed ? 'ajoute ' + args.content.length + ' octets a ' + r.rel + '.' : 'cree ' + r.rel + ' (' + args.content.length + ' octets).',
    diff, created: existed ? [] : [r.rel], markRead: [r.rel] };
}

async function hMkdir(ctx, args, resolved) {
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'mkdir refuse: ' + r.reason };
  try {
    const st = fs.statSync(r.abs);
    if (!st.isDirectory()) return { ok: false, code: 'is_file', error: 'mkdir refuse : ' + r.rel + ' est un fichier.' };
    return { ok: true, data: { rel: r.rel, existed: true }, summary: 'dossier ' + r.rel + ' (existait deja).' };
  } catch (e) {
    if (e && e.code !== 'ENOENT') return { ok: false, code: 'io', error: 'mkdir: ' + String((e && e.message) || e).slice(0, 150) };
  }
  try {
    fs.mkdirSync(r.abs, { recursive: true });
  } catch (e) { return { ok: false, code: 'io', error: 'mkdir: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { rel: r.rel, existed: false }, summary: 'cree dossier ' + r.rel + '.' };
}

async function hWrite(ctx, args, resolved) {
  if (typeof args.content !== 'string') return { ok: false, code: 'bad_args', error: 'write: content (string) requis.' };
  if (args.content.length > 2 * 1024 * 1024) return { ok: false, code: 'too_big', error: 'write: contenu trop volumineux.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'write refuse: ' + r.reason };
  let exists = false;
  try { exists = fs.statSync(r.abs).isFile(); } catch (_) { exists = false; }
  if (exists) {
    // P52: write is CREATE-ONLY (the gate above normally catches this;
    // defense in depth for direct handler callers).
    return { ok: false, code: 'exists', error: 'write cree uniquement : ' + r.rel + ' existe deja. Utilise edit (remplacer un bloc exact) ou append (ajouter a la fin).' };
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
  try { text = fs.readFileSync(r.abs, 'utf8'); } catch (_) { return richNotFound('edit', ctx, r, '.'); }
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

// P50-3: long-running processes (live output via exec_poll, exec_stop).
async function hExecStart(ctx, args, resolved) {
  const command = args.command;
  if (typeof command !== 'string' || !command.trim()) return { ok: false, code: 'bad_args', error: 'exec_start: command requise.' };
  if (command.length > 8000) return { ok: false, code: 'too_big', error: 'exec_start: commande trop longue.' };
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'exec_start refuse (dossier) : ' + r.reason };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, code: 'not_found', error: 'exec_start: dossier introuvable.' }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_dir', error: 'exec_start: pas un dossier.' };
  const started = execMod.startProc({ command, cwd: r.abs, timeoutMs: args.timeoutMs, label: args.label });
  if (!started.ok) return { ok: false, code: started.code, error: 'exec_start: ' + started.error };
  if (ctx.log) {
    try { ctx.log.info('exec start', { id: started.id, pid: started.pid, cmd: maskSecrets(command).slice(0, 200) }, ctx.corr); } catch (_) {}
  }
  return { ok: true, data: { id: started.id, pid: started.pid }, summary: 'processus demarre (' + started.id + ').' };
}

async function hExecPoll(ctx, args) {
  const id = args.id;
  if (!execMod.validId(id)) return { ok: false, code: 'bad_args', error: 'exec_poll: id requis.' };
  const p = execMod.pollProc(id);
  if (!p.ok && (p.code === 'bad_args' || p.code === 'unknown_proc')) return { ok: false, code: p.code, error: 'exec_poll: ' + p.error };
  const fresh = (p.out || '') + (p.err ? '\n[stderr]\n' + p.err : '');
  const data = { id, running: p.running, out: p.out || '', err: p.err || '', outBytes: p.outBytes, errBytes: p.errBytes,
    truncated: p.truncated, ms: p.ms, exitCode: p.exitCode, signal: p.signal, timedOut: p.timedOut, killed: p.killed };
  if (p.ok && p.running) return { ok: true, data, summary: 'en cours (' + p.ms + ' ms, +' + fresh.length + ' octets).' };
  if (p.ok && !p.running) {
    try { execMod.reapProcs(); } catch (_) {}
    return { ok: true, data, summary: p.stopped ? 'arrete.' : 'termine (code 0).' };
  }
  // Finished non-zero / timeout: failure WITH diagnostics (feeds the
  // bounded fix loop like a one-shot bash failure).
  const diag = execMod.extractErrors((p.out || '') + '\n' + (p.err || ''));
  data.diagnostics = diag.text;
  try { execMod.reapProcs(); } catch (_) {}
  return { ok: false, code: p.code, error: 'exec_poll: ' + p.error + (diag.text ? '\n' + diag.text.slice(0, 2000) : ''),
    summary: p.code + '.', data };
}

async function hExecStop(ctx, args) {
  const id = args.id;
  if (!execMod.validId(id)) return { ok: false, code: 'bad_args', error: 'exec_stop: id requis.' };
  const s = execMod.stopProc(id);
  if (!s.ok) return { ok: false, code: s.code, error: 'exec_stop: ' + s.error };
  if (ctx.log) {
    try { ctx.log.info('exec stop', { id, stopped: !!s.stopped }, ctx.corr); } catch (_) {}
  }
  return { ok: true, data: { id, stopped: !!s.stopped, already: !!s.already }, summary: s.stopped ? 'processus arrete.' : 'deja termine.' };
}

// P50-4: whole-project generation runs (phases + checks + restore points).
function genRootOf(resolved, tool) {
  if (!resolved.ok) return { ok: false, code: resolved.code, error: tool + ' refuse (dossier) : ' + resolved.reason };
  let st = null;
  try { st = fs.statSync(resolved.abs); } catch (_) { return { ok: false, code: 'not_found', error: tool + ': dossier introuvable.' }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_dir', error: tool + ': pas un dossier.' };
  return { ok: true, root: resolved.abs };
}

async function hGenStart(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'gen_start');
  if (!g0.ok) return g0;
  const g = genMod.startRun(g0.root, args.goal, args.stack);
  if (!g.ok) return { ok: false, code: 'bad_args', error: 'gen_start: ' + g.error };
  if (ctx.log) { try { ctx.log.info('gen start', { id: g.id }, ctx.corr); } catch (_) {} }
  return { ok: true, data: { id: g.id, phases: genMod.PHASES.slice() }, summary: 'generation demarree (' + g.id + ').' };
}

async function hGenPhase(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'gen_phase');
  if (!g0.ok) return g0;
  const g = genMod.markPhase(g0.root, args.run, args.phase, args.note);
  if (!g.ok) {
    const code = /^(phase invalide|identifiant|generation)/.test(g.error) ? 'bad_args' : 'gen_failed';
    return { ok: false, code, error: 'gen_phase: ' + g.error };
  }
  if (ctx.log) { try { ctx.log.info('gen phase', { id: args.run, phase: args.phase }, ctx.corr); } catch (_) {} }
  return { ok: true, data: { id: args.run, phase: g.phase, warning: g.warning || null, backup: g.backup },
    summary: 'phase ' + g.phase + ' marquee.' + (g.warning ? ' (' + g.warning + ')' : '') };
}

async function hGenCheck(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'gen_check');
  if (!g0.ok) return g0;
  const phase = args.phase;
  if (['deps', 'build', 'tests'].indexOf(phase) === -1) return { ok: false, code: 'bad_args', error: 'gen_check: phase deps|build|tests requise.' };
  const command = args.command;
  if (typeof command !== 'string' || !command.trim()) return { ok: false, code: 'bad_args', error: 'gen_check: command requise.' };
  if (command.length > 8000) return { ok: false, code: 'too_big', error: 'gen_check: commande trop longue.' };
  const rr = genMod.buildReport(g0.root, args.run);
  if (!rr.ok) return { ok: false, code: 'bad_args', error: 'gen_check: ' + rr.error };
  const timeoutMs = Math.min(600000, Math.max(5000, parseInt(args.timeoutMs, 10) || 120000));
  const started = execMod.startProc({ command, cwd: g0.root, timeoutMs, label: 'gen:' + String(args.run || '').slice(0, 8) });
  if (!started.ok) return { ok: false, code: started.code, error: 'gen_check: ' + started.error };
  if (ctx.run) ctx.run.killFns.push(() => { try { execMod.stopProc(started.id); } catch (_) {} });
  if (ctx.sessionKill) ctx.sessionKill.push(() => { try { execMod.stopProc(started.id); } catch (_) {} });
  const t0 = Date.now();
  let full = '';
  let p = null;
  for (;;) {
    p = execMod.pollProc(started.id);
    full += (p.out || '') + (p.err || '');
    if (full.length > 262144) full = full.slice(-262144);
    if (!p.running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  try { execMod.reapProcs(); } catch (_) {}
  const tail = full.slice(-4000);
  genMod.recordCheck(g0.root, args.run, { phase, command, code: p.exitCode, signal: p.signal, timedOut: p.timedOut, ms: Date.now() - t0, tail });
  if (ctx.log) { try { ctx.log.info('gen check', { id: args.run, phase, code: p.exitCode, ms: Date.now() - t0 }, ctx.corr); } catch (_) {} }
  if (p.ok && p.exitCode === 0) {
    return { ok: true, data: { id: args.run, phase, code: 0, ms: Date.now() - t0, tail }, summary: 'check ' + phase + ' reussi.' };
  }
  const diag = execMod.extractErrors(full);
  const code = p.timedOut ? 'timeout' : ('exit_' + p.exitCode);
  return { ok: false, code, error: 'gen_check ' + phase + ': ' + code + '.\n' + (diag.text ? diag.text.slice(0, 2000) : tail),
    summary: 'check ' + phase + ' echoue (' + code + ').', data: { id: args.run, phase, code: p.exitCode, tail } };
}

async function hGenReport(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'gen_report');
  if (!g0.ok) return g0;
  const g = genMod.buildReport(g0.root, args.run);
  if (!g.ok) return { ok: false, code: 'bad_args', error: 'gen_report: ' + g.error };
  return { ok: true, data: g.report, summary: 'rapport : ' + g.report.verdict.status + '.' };
}

async function hGenRestore(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'gen_restore');
  if (!g0.ok) return g0;
  const g = genMod.restorePhase(g0.root, args.run, args.phase, { partial: args.partial === true });
  if (!g.ok) {
    const code = /^(phase invalide|identifiant|generation)/.test(g.error) ? 'bad_args' : 'gen_failed';
    return { ok: false, code, error: 'gen_restore: ' + g.error };
  }
  if (ctx.log) { try { ctx.log.info('gen restore', { id: args.run, phase: g.phase, restored: g.restored, deleted: g.deleted }, ctx.corr); } catch (_) {} }
  return { ok: true, data: g, summary: 'restaure a ' + g.phase + ' (' + g.restored + ' fichiers, ' + g.deleted + ' supprimes).' };
}

// P50-5: IDE business tools (analyze, secaudit, mkignore, ci, doctor, sdk).
async function hAnalyze(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'analyze');
  if (!g0.ok) return g0;
  const r = bizMod.analyze(g0.root);
  if (ctx.log) { try { ctx.log.info('biz analyze', { files: r.files, langs: Object.keys(r.byLang).length, ms: r.ms }, ctx.corr); } catch (_) {} }
  return { ok: true, data: r, summary: 'analyse : ' + r.files + ' fichiers, ' + Object.keys(r.byLang).length + ' langages.' };
}

async function hSecaudit(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'secaudit');
  if (!g0.ok) return g0;
  const r = bizMod.secaudit(g0.root);
  // Journal: counts + CVE ids only. NEVER finding hints (secret-shaped).
  if (ctx.log) {
    try { ctx.log.info('biz secaudit', { secrets: r.secrets.length, advisories: r.advisories.map((a) => a.cve).slice(0, 20), files: r.secretFiles }, ctx.corr); } catch (_) {}
  }
  return { ok: true, data: r, summary: 'audit : ' + r.secrets.length + ' secret(s), ' + r.advisories.length + ' avis.' };
}

async function hMkignore(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'mkignore');
  if (!g0.ok) return g0;
  const r = bizMod.mkignore(g0.root, args.stack);
  if (!r.ok) return { ok: false, code: 'bad_args', error: 'mkignore: ' + r.error };
  if (ctx.log) { try { ctx.log.info('biz mkignore', { added: r.added.length, stacks: r.stacks }, ctx.corr); } catch (_) {} }
  return { ok: true, data: r, summary: '.gitignore : ' + r.added.length + ' entree(s) ajoutee(s).' };
}

async function hCi(ctx, args, resolved) {
  const g0 = genRootOf(resolved, 'ci');
  if (!g0.ok) return g0;
  const r = bizMod.ci(g0.root, args.provider);
  if (!r.ok) return { ok: false, code: 'bad_args', error: 'ci: ' + r.error };
  if (ctx.log) { try { ctx.log.info('biz ci', { path: r.path, stacks: r.stacks }, ctx.corr); } catch (_) {} }
  return { ok: true, data: r, summary: 'workflow ecrit : ' + r.path };
}

async function hDoctor(ctx, args) {
  const r = await bizMod.doctor();
  const ok = r.checks.filter((c) => c.status === 'ok').length;
  const err = r.checks.filter((c) => c.status === 'error').length;
  if (ctx.log) { try { ctx.log.info('biz doctor', { ok, err }, ctx.corr); } catch (_) {} }
  return { ok: true, data: r, summary: 'doctor : ' + ok + ' ok, ' + err + ' erreur(s).' };
}

async function hSdk(ctx, args) {
  const op = args.op;
  if (op !== 'status' && op !== 'install') return { ok: false, code: 'bad_args', error: 'sdk: op status|install requise.' };
  if (op === 'status') {
    const r = await bizMod.sdkStatus(args.id);
    if (!r.ok) return { ok: false, code: 'bad_args', error: 'sdk: ' + r.error };
    const n = r.sdks.filter((s) => s.installed).length;
    if (ctx.log) { try { ctx.log.info('biz sdk status', { installed: n, of: r.sdks.length }, ctx.corr); } catch (_) {} }
    return { ok: true, data: r, summary: 'sdk : ' + n + '/' + r.sdks.length + ' installes.' };
  }
  if (!args.id) return { ok: false, code: 'bad_args', error: 'sdk install: id requis.' };
  const r = await bizMod.sdkInstall(args.id, { dry: args.dry === true, timeoutMs: args.timeoutMs });
  if (!r.ok) return { ok: false, code: 'sdk_failed', error: 'sdk install: ' + r.error };
  if (ctx.log) { try { ctx.log.info('biz sdk install', { id: args.id, dry: !!r.dry }, ctx.corr); } catch (_) {} }
  return { ok: true, data: r, summary: r.dry ? 'commande : ' + r.command : 'sdk ' + args.id + ' installe.' };
}

// P50-6: direct calls cannot spawn (no turn context); the loop intercepts.
async function hSubagentDirect(ctx, args) {
  return { ok: false, code: 'loop_only', error: 'subagent : appel direct impossible (boucle agent uniquement).' };
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

// P49-5: delete a file. Guards mirror write: boundary (via resolved),
// read-this-session (no blind deletes), file-only. The series checkpoint
// (taken by executeTool before the first mutating call) is the way back.
async function hDelete(ctx, args, resolved) {
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'delete refuse: ' + r.reason };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return richNotFound('delete', ctx, r, '.'); }
  if (!st.isFile()) return { ok: false, code: 'not_file', error: 'delete refuse : ' + r.rel + ' n\'est pas un fichier (dossiers non pris en charge).' };
  const readFiles = (ctx.session && ctx.session.meta && Array.isArray(ctx.session.meta.readFiles)) ? ctx.session.meta.readFiles : [];
  if (readFiles.indexOf(r.rel) === -1) {
    return { ok: false, code: 'not_read', error: 'delete refuse : ' + r.rel + ' n\'a pas ete lu pendant la session. Lisez-le d\'abord (protection contre les suppressions aveugles).' };
  }
  let lines = 0;
  try { lines = fs.readFileSync(r.abs, 'utf8').split('\n').length; } catch (_) { lines = 0; }
  try { fs.unlinkSync(r.abs); }
  catch (e) { return { ok: false, code: 'io', error: 'delete: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { rel: r.rel, lines }, summary: 'supprime ' + r.rel + ' (' + lines + ' lignes).' };
}

// P49-5: rename/move a file. Source: exists + file + read this session.
// Target: resolved in-root, must NOT exist (anti-overwrite), parents made.
// The target counts as created (honest undo removes it on restore).
async function hRename(ctx, args, resolved) {
  const r = resolved;
  if (!r.ok) return { ok: false, code: r.code, error: 'rename refuse (source) : ' + r.reason };
  if (typeof args.to !== 'string' || !args.to.trim()) return { ok: false, code: 'bad_args', error: 'rename: to (nouveau chemin) requis.' };
  let st = null;
  try { st = fs.statSync(r.abs); } catch (_) { return richNotFound('rename', ctx, r, '.'); }
  if (!st.isFile()) return { ok: false, code: 'not_file', error: 'rename refuse : ' + r.rel + ' n\'est pas un fichier.' };
  const readFiles = (ctx.session && ctx.session.meta && Array.isArray(ctx.session.meta.readFiles)) ? ctx.session.meta.readFiles : [];
  if (readFiles.indexOf(r.rel) === -1) {
    return { ok: false, code: 'not_read', error: 'rename refuse : ' + r.rel + ' n\'a pas ete lu pendant la session. Lisez-le d\'abord.' };
  }
  const rt = resolveInRoot(ctx.root, args.to);
  if (!rt.ok) return { ok: false, code: rt.code, error: 'rename refuse (cible) : ' + rt.reason };
  let targetExists = false;
  try { targetExists = fs.statSync(rt.abs).isFile() || fs.statSync(rt.abs).isDirectory(); } catch (_) { targetExists = false; }
  if (targetExists) return { ok: false, code: 'exists', error: 'rename refuse : la cible existe deja : ' + rt.rel + '.' };
  try {
    fs.mkdirSync(path.dirname(rt.abs), { recursive: true });
    fs.renameSync(r.abs, rt.abs);
  } catch (e) { return { ok: false, code: 'io', error: 'rename: ' + String((e && e.message) || e).slice(0, 150) }; }
  return { ok: true, data: { from: r.rel, to: rt.rel }, summary: 'renomme ' + r.rel + ' -> ' + rt.rel + '.', created: [rt.rel], markRead: [rt.rel] };
}

// P49-1: final-answer tools. The turn loop intercepts them (termination);
// these handlers are backstops for direct calls (same shape, no effect).
async function hReply(ctx, args) {
  if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, code: 'bad_args', error: 'reply: text requis.' };
  return { ok: true, data: { chars: args.text.length }, summary: 'reponse finale (' + args.text.length + ' caracteres).' };
}

async function hDone(ctx, args) {
  const s = typeof args.summary === 'string' ? args.summary.trim().slice(0, 2000) : '';
  return { ok: true, data: { chars: s.length }, summary: s || 'tache terminee.' };
}

// ---------------------------------------------------------------------------
// Tool table: metadata + arg path (for boundary) + handler.
// ---------------------------------------------------------------------------
const TOOLS = {
  read: { description: 'Lit un fichier du projet (borne, tronque). Marque le fichier comme lu.', danger: 'read', mutating: false, pathArg: 'file', defDir: '.', handler: hRead },
  list: { description: 'Liste un dossier du projet (borne).', danger: 'read', mutating: false, pathArg: 'dir', defDir: '.', handler: hList },
  glob: { description: 'Recherche de fichiers par motif (*, ?, **).', danger: 'read', mutating: false, pathArg: 'dir', defDir: '.', handler: hGlob },
  grep: { description: 'Recherche textuelle (regex) dans le projet, bornee.', danger: 'read', mutating: false, pathArg: 'path', defDir: '.', handler: hGrep },
  write: { description: 'Cree un fichier (REFUSE si existant : passe par edit/append).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hWrite },
  edit: { description: 'Remplace une chaine exacte unique (echec clair si absente ou ambigue).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hEdit },
  patch: { description: 'Applique un diff unifie strict (multi-fichiers, creation, suppression).', danger: 'write', mutating: true, pathArg: null, defDir: null, handler: hPatch },
  bash: { description: 'Execute une commande (fenetre masquee, delai, sortie tronquee, annulable, sandbox P8 L1).', danger: 'execute', mutating: true, pathArg: 'cwd', defDir: '.', handler: hBash },
  exec_start: { description: 'Demarre un processus long (live: exec_poll, stop: exec_stop, delai).', danger: 'execute', mutating: true, pathArg: 'cwd', defDir: '.', handler: hExecStart },
  exec_poll: { description: 'Sortie nouvelle d un processus (non-zero => echec + diagnostics).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hExecPoll },
  exec_stop: { description: 'Arrete un processus exec_start.', danger: 'execute', mutating: true, pathArg: null, defDir: null, handler: hExecStop },
  gen_start: { description: 'Demarre une generation projet (plan->fichiers->deps->build->tests, points retour).', danger: 'execute', mutating: true, pathArg: 'cwd', defDir: '.', handler: hGenStart },
  gen_phase: { description: 'Marque une phase generation (ordre impose, instantane).', danger: 'write', mutating: true, pathArg: 'cwd', defDir: '.', handler: hGenPhase },
  gen_check: { description: 'Execute un check generation (deps|build|tests) et enregistre le code reel.', danger: 'execute', mutating: true, pathArg: 'cwd', defDir: '.', handler: hGenCheck },
  gen_report: { description: 'Rapport generation honnete (TERMINE seulement si verifie).', danger: 'read', mutating: false, pathArg: 'cwd', defDir: '.', handler: hGenReport },
  gen_restore: { description: 'Restaure le projet a une phase generation (point retour).', danger: 'write', mutating: true, pathArg: 'cwd', defDir: '.', handler: hGenRestore },
  analyze: { description: 'Analyse la structure du projet (langages, manifestes, tests, TODO).', danger: 'read', mutating: false, pathArg: 'cwd', defDir: '.', handler: hAnalyze },
  secaudit: { description: 'Audit securite : secrets exposes + dependances vulnerees (base embarquee).', danger: 'read', mutating: false, pathArg: 'cwd', defDir: '.', handler: hSecaudit },
  mkignore: { description: 'Genere/fusionne .gitignore selon la stack (jamais de suppression).', danger: 'write', mutating: true, pathArg: 'cwd', defDir: '.', handler: hMkignore },
  ci: { description: 'Genere un workflow CI selon la stack (refuse d ecraser).', danger: 'write', mutating: true, pathArg: 'cwd', defDir: '.', handler: hCi },
  doctor: { description: 'Controle l environnement (outils, backend, runtime, systeme).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hDoctor },
  sdk: { description: 'SDK : status (sondes) ou install (Windows/winget, dry possible).', danger: 'execute', mutating: true, pathArg: null, defDir: null, handler: hSdk },
  subagent: { description: 'Deleque a un/des sous-agent(s) : task (1 enfant) ou tasks[] (parallele x3).', danger: 'execute', mutating: false, pathArg: null, defDir: null, handler: hSubagentDirect },
  todo: { description: 'Liste de taches de session (add/list/done/clear).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hTodo },
  delete: { description: 'Supprime un fichier du projet (lecture prealable requise, confirmation operateur, annulable via instantane).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hDelete },
  rename: { description: 'Renomme/deplace un fichier (lecture prealable requise, cible neuve, confirmation, annulable).', danger: 'write', mutating: true, pathArg: 'from', defDir: null, handler: hRename },
  append: { description: 'Ajoute du texte a la fin d\'un fichier (cree le fichier si absent).', danger: 'write', mutating: true, pathArg: 'file', defDir: null, handler: hAppend },
  mkdir: { description: 'Cree un dossier (parents inclus, idempotent).', danger: 'write', mutating: true, pathArg: 'dir', defDir: null, handler: hMkdir },
  reply: { description: 'Reponse finale (termine le tour, sans modification).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hReply },
  done: { description: 'Tache terminee (termine le tour, sans modification).', danger: 'read', mutating: false, pathArg: null, defDir: null, handler: hDone },
};

function toolNames() { return Object.keys(TOOLS); }

function toOpenAISchema(profile) {
  const str = (d) => ({ type: 'string', description: d });
  const small = profile === 'small';
  const names = small ? profiles.profileTools('small') : toolNames().filter((n) => n !== 'todo'); // P52: the model never manages todos (registry-only tool).
  const schemas = {
    read: { file: str('Project-relative file path.'), offset: { type: 'integer' }, limit: { type: 'integer' } },
    list: { dir: str('Project-relative directory (default root).'), recursive: { type: 'boolean' }, limit: { type: 'integer' } },
    glob: { pattern: str('Glob pattern, e.g. src/**/*.js.'), dir: str('Base directory.'), limit: { type: 'integer' } },
    grep: { pattern: str('Regular expression.'), path: str('File or directory to search.'), limit: { type: 'integer' } },
    write: { file: str('Project-relative file path.'), content: str('Full new content.') },
    edit: { file: str('Project-relative file path.'), old: str('Exact unique string to replace.'), new: str('Replacement.') },
    patch: { patch: str('Unified diff text.') },
    bash: { command: str('Shell command.'), cwd: str('Working directory.'), timeoutMs: { type: 'integer' } },
    exec_start: { command: str('Shell command.'), cwd: str('Working directory.'), timeoutMs: { type: 'integer' }, label: str('Label.') },
    exec_poll: { id: str('Process id.') },
    exec_stop: { id: str('Process id.') },
    gen_start: { goal: str('Project goal.'), stack: str('Stack, e.g. node.'), cwd: str('Working directory.') },
    gen_phase: { run: str('Generation id.'), phase: str('plan|files|deps|build|tests.'), note: str('Note.'), cwd: str('Working directory.') },
    gen_check: { run: str('Generation id.'), phase: str('deps|build|tests.'), command: str('Shell command.'), timeoutMs: { type: 'integer' }, cwd: str('Working directory.') },
    gen_report: { run: str('Generation id.'), cwd: str('Working directory.') },
    gen_restore: { run: str('Generation id.'), phase: str('start|plan|files|deps|build|tests.'), partial: { type: 'boolean' }, cwd: str('Working directory.') },
    analyze: { cwd: str('Working directory.') },
    secaudit: { cwd: str('Working directory.') },
    mkignore: { stack: str('node|python|java|go|rust|dotnet|dart (default: detect).'), cwd: str('Working directory.') },
    ci: { provider: str('github|gitlab (default github).'), cwd: str('Working directory.') },
    doctor: {},
    sdk: { op: str('status|install.'), id: str('Sdk id.'), dry: { type: 'boolean' }, timeoutMs: { type: 'integer' } },
    subagent: { task: str('Task for one child.'), focus: str('Context for the child.'), readonly: { type: 'boolean' }, maxRounds: { type: 'integer' }, tasks: { type: 'array' } },
    todo: { op: str('add|list|done|clear.'), text: str('Task text (add).'), id: str('Task id (done).') },
    delete: { file: str('Project-relative file path to delete (must have been read).') },
    rename: { from: str('Project-relative source path (must have been read).'), to: str('New project-relative path (must not exist).') },
    append: { file: str('Project-relative file path.'), content: str('Text to add at the end.') },
    mkdir: { dir: str('Project-relative directory to create.') },
    reply: { text: str('Final answer text (ends the turn).') },
    done: { summary: str('Short summary of what changed (optional, ends the turn).') },
  };
  const required = { read: ['file'], glob: ['pattern'], grep: ['pattern'], write: ['file', 'content'], edit: ['file', 'old', 'new'], patch: ['patch'], bash: ['command'], exec_start: ['command'], exec_poll: ['id'], exec_stop: ['id'], gen_start: ['goal'], gen_phase: ['run', 'phase'], gen_check: ['run', 'phase', 'command'], gen_report: ['run'], gen_restore: ['run', 'phase'], sdk: ['op'], todo: ['op'], delete: ['file'], rename: ['from', 'to'], append: ['file', 'content'], mkdir: ['dir'], reply: ['text'] };
  return names.map((n) => ({ type: 'function', function: { name: n, description: (small && profiles.TERSE[n]) || TOOLS[n].description, parameters: { type: 'object', properties: schemas[n], required: required[n] || [] } } }));
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
  // P49: the store is file-backed, so ctx.session would stay stale for the
  // rest of the turn and a same-turn write after read would be refused
  // (not_read). Refresh the in-memory snapshot (proven by probe + test).
  try {
    const fresh = ctx.store.get(ctx.sessionId);
    if (fresh) ctx.session = fresh;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// MCP tool path (P26-e): mcp__server__tool. Admin allowlist first
// (fail-closed, operator rules cannot override), then the standard
// permission system, then the stdio call. MCP side effects live outside
// project snapshots: no undo is claimed for them.
// ---------------------------------------------------------------------------
async function executeMcpTool(ctx, toolName, args, opts, t0) {
  const rest = String(toolName).slice(5);
  const cut = rest.indexOf('__');
  const server = cut === -1 ? '' : rest.slice(0, cut);
  const tool = cut === -1 ? '' : rest.slice(cut + 2);
  if (!server || !tool) {
    return { status: 'error', reason: 'nom d\'outil MCP invalide : ' + String(toolName).slice(0, 60), code: 'bad_args' };
  }
  if (!ctx.root) return { status: 'denied', reason: 'aucun dossier de projet sur cette session.', code: 'no_project' };
  if (!mcpMod.isAllowed(ctx.home, server, tool)) {
    const reason = 'outil MCP non autorise (liste administrateur) : ' + server + '/' + tool;
    recordCall(ctx, toolName, args, false, 'mcp_not_allowed', Date.now() - t0, reason);
    if (ctx.log) { try { ctx.log.info('tool mcp-refused', { session: ctx.sessionId, server, tool }, ctx.corr); } catch (_) {} }
    return { status: 'denied', reason, code: 'mcp_not_allowed' };
  }
  const pattern = { kind: 'mcptool', text: (server + '/' + tool).slice(0, 300) };
  const chk = perm.check({ tool: 'mcp', pattern, p8verdict: null, denyList: null,
    sessionRules: ctx.sessionRules || new Set(), projectRules: ctx.projectRules || new Set() });
  if (chk.decision === 'deny') {
    recordCall(ctx, toolName, args, false, 'denied', Date.now() - t0);
    return { status: 'denied', reason: chk.reason, code: 'denied' };
  }
  if (chk.decision === 'ask' && !opts.preApproved) {
    const request = {
      id: 'appr-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(16),
      sessionId: ctx.sessionId, tool: toolName, pattern, at: new Date().toISOString(),
      summary: 'MCP : ' + server + '/' + tool,
      diff: null, args: cappedArgs(toolName, args), deploy: false,
    };
    return { status: 'need-approval', request };
  }
  const journal = (msg) => {
    if (ctx.log) { try { ctx.log.info('mcp', { session: ctx.sessionId, msg: String(msg).slice(0, 300) }, ctx.corr); } catch (_) {} }
  };
  let res = null;
  try {
    res = await mcpMod.callTool(ctx.home, server, tool, args, {}, journal);
  } catch (e) {
    const code = (e && e.code) || 'mcp_error';
    const reason = 'MCP ' + server + '/' + tool + ' : ' + String((e && e.message) || e).slice(0, 200);
    const call = recordCall(ctx, toolName, args, false, code, Date.now() - t0, reason);
    call.result = null;
    call.error = reason;
    return { status: 'error', reason, code, call };
  }
  const call = recordCall(ctx, toolName, args, !!res.ok, res.ok ? 'ok' : 'mcp_error', res.ms, 'MCP ' + server + '/' + tool + ' (' + res.ms + 'ms)');
  call.result = res.ok ? String(res.text || '').slice(0, 8000) : null;
  call.error = res.ok ? null : String(res.text || 'echec MCP.').slice(0, 500);
  if (!res.ok) return { status: 'error', reason: call.error, code: 'mcp_error', call };
  return { status: 'done', call };
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
  // P26-e: MCP tools (mcp__server__tool) take a dedicated path: admin
  // allowlist first, then the standard permission system, then the call.
  if (typeof toolName === 'string' && toolName.indexOf('mcp__') === 0) {
    return executeMcpTool(ctx, toolName, args, opts, t0);
  }
  const def = TOOLS[toolName];
  if (!def) return { status: 'error', reason: 'outil inconnu : ' + String(toolName).slice(0, 40), code: 'unknown_tool' };
  if (!ctx.root) return { status: 'denied', reason: 'aucun dossier de projet sur cette session.', code: 'no_project' };

  // P26-a: plan mode refuses mutating tools (clear refusal, no poisoning).
  if (ctx.mode === 'plan' && PLAN_REFUSED.indexOf(toolName) !== -1) {
    const reason = toolName + ' refuse : session en mode PLAN (proposition only, lecture seule). Basculez en mode BUILD pour modifier.';
    recordCall(ctx, toolName, args, false, 'plan_mode', Date.now() - t0, reason);
    if (ctx.log) { try { ctx.log.info('tool plan-refused', { session: ctx.sessionId, tool: toolName }, ctx.corr); } catch (_) {} }
    return { status: 'denied', reason, code: 'plan_mode' };
  }

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

  // 2. Create-only gate (P52): `write` creates, never overwrites (use
  // edit/append on existing files). Runs BEFORE permissions: even an
  // allow rule cannot bypass it.
  if (toolName === 'write' && resolved.ok) {
    let exists = false;
    try { exists = fs.statSync(resolved.abs).isFile(); } catch (_) { exists = false; }
    if (exists) {
      const reason = 'write cree uniquement : ' + resolved.rel + ' existe deja. Utilise edit (remplacer un bloc exact) ou append (ajouter a la fin).';
      const call = recordCall(ctx, toolName, args, false, 'exists', Date.now() - t0, reason);
      call.error = reason;
      return { status: 'error', reason, code: 'exists', call };
    }
  }

  // 3. P8 verdicts (when the module is present).
  const mod = p8();
  let p8verdict = null;
  try {
    if (mod) {
      if (toolName === 'bash') p8verdict = mod.evaluateBash(args.command, { projectRoot: ctx.root });
      else if (toolName === 'write' || toolName === 'edit' || toolName === 'patch' || toolName === 'append') {
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
  // P26-f: deploys are gated twice. The network policy must allow them at
  // all; when it does, the operator is STILL asked every time (a stored
  // session/project rule never auto-allows a deploy).
  let isDeploy = false;
  if (toolName === 'bash') {
    isDeploy = verifyMod.detectDeploy(args.command);
    if (isDeploy && !verifyMod.deployAllowed(ctx.home)) {
      const reason = 'deploiement refuse par la politique reseau : ' + String(args.command || '').slice(0, 160);
      recordCall(ctx, toolName, args, false, 'deploy_policy', Date.now() - t0, reason);
      if (ctx.log) { try { ctx.log.info('tool deploy-denied', { session: ctx.sessionId }, ctx.corr); } catch (_) {} }
      return { status: 'denied', reason, code: 'deploy_policy' };
    }
  }
  if ((chk.decision === 'ask' || isDeploy) && !opts.preApproved) {
    const request = {
      id: 'appr-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(16),
      sessionId: ctx.sessionId, tool: toolName, pattern, at: new Date().toISOString(),
      summary: (isDeploy ? '[DEPLOIEMENT] ' : '') + toolName + ' : ' + (pattern.text || '?').slice(0, 160),
      diff: null, args: cappedArgs(toolName, args),
      deploy: isDeploy === true,
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
    // P49-5: delete/rename previews: the operator sees WHAT disappears.
    if (toolName === 'delete' && resolved.ok) {
      try {
        const head = fs.readFileSync(resolved.abs, 'utf8').split('\n').slice(0, 40).join('\n');
        request.diff = ('(suppression de ' + (resolved.rel || '?') + ')\n' + head).slice(0, 20000);
      } catch (_) { request.diff = '(suppression de ' + (resolved.rel || '?') + ')'; }
    }
    if (toolName === 'rename') {
      request.diff = '(renomme ' + String(args.from || '?').slice(0, 200) + ' -> ' + String(args.to || '?').slice(0, 200) + ')';
    }
    if (toolName === 'append' && resolved.ok) {
      request.diff = ('(ajout : +' + String((args.content || '').length) + ' octets a la fin de ' + (resolved.rel || '?') + ')\n' + String(args.content || '')).slice(0, 20000);
    }
    if (toolName === 'mkdir') {
      request.diff = '(creation du dossier ' + String(args.dir || '?').slice(0, 200) + ')';
    }
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
      // P39-b: failures journal the full error text (incl. enriched hints).
      const fields = { tool: toolName, target: pattern.text.slice(0, 120), code: call.code, ms, rule: (chk.rule || 'none') + (opts.preApproved ? '+approved' : '') };
      if (!res.ok && res.error) fields.error = String(res.error);
      ctx.log[res.ok ? 'info' : 'warn']('tool ' + (res.ok ? 'ok' : 'fail'), fields, ctx.corr);
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
  if (toolName === 'rename' && (args.from || args.to)) return String(args.from || '') + ' -> ' + String(args.to || '').slice(0, 200);
  const v = args.file || args.from || args.dir || args.path || args.cwd || args.pattern || args.command || args.op || args.scope || args.text || '';
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
