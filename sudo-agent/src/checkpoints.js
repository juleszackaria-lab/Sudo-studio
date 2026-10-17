// Sudo Agent checkpoints (P25-d). Before each modification series, a snapshot
// (hashes + contents) is stored OUTSIDE the project. Undo restores the last
// series or the whole session; every restored file is hash-verified.
// Stdlib only. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STORED_FILE = 256 * 1024;
const SKIP_DIRS = ['.git', 'node_modules', '.sudo_studio', '__pycache__'];

function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function checkpointsDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent', 'checkpoints');
}

function sessionDir(home, sessionId) {
  return path.join(process.env.SUDO_AGENT_CHECKPOINTS || checkpointsDir(home), String(sessionId));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Walk project files (no symlink-dir following). Returns { files, truncated }.
// files: rel -> { hash, size, binary }.
function walkFiles(root, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  const files = {};
  let count = 0;
  let truncated = false;
  const skip = new Set((opts.skipDirs || SKIP_DIRS).map((s) => String(s).toLowerCase()));
  const visit = (dir, rel) => {
    if (truncated) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (truncated) return;
      const name = e.name;
      const full = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      try {
        if (e.isSymbolicLink()) continue; // never follow / store symlinks
        if (e.isDirectory()) {
          if (skip.has(name.toLowerCase())) continue;
          visit(full, r);
        } else if (e.isFile()) {
          count += 1;
          if (count > maxFiles) { truncated = true; return; }
          let buf = null;
          try { buf = fs.readFileSync(full); } catch (_) { continue; }
          files[r] = { hash: hashContent(buf), size: buf.length, binary: isBinary(buf) };
        }
      } catch (_) { /* skip unreadable */ }
    }
  };
  visit(root, '');
  return { files, truncated };
}

// Full snapshot with restorable contents (base64, capped).
function snapshotProject(root, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const maxStored = opts.maxStoredFile || DEFAULT_MAX_STORED_FILE;
  const walk = walkFiles(root, opts);
  const contents = {};
  const hashOnly = [];
  let bytes = 0;
  let bytesTruncated = false;
  const rels = Object.keys(walk.files).sort();
  for (const rel of rels) {
    const meta = walk.files[rel];
    if (meta.size > maxStored) { hashOnly.push(rel); continue; }
    if (bytes + meta.size > maxBytes) { bytesTruncated = true; hashOnly.push(rel); continue; }
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      contents[rel] = buf.toString('base64');
      bytes += meta.size;
    } catch (_) { hashOnly.push(rel); }
  }
  return {
    at: new Date().toISOString(),
    root: String(root),
    files: walk.files,
    contents,
    hashOnly,
    truncated: walk.truncated,
    bytesTruncated,
    bytes,
  };
}

function saveSnapshot(home, sessionId, name, snap) {
  const dir = sessionDir(home, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function loadSnapshot(home, sessionId, name) {
  const file = path.join(sessionDir(home, sessionId), name + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listSnapshots(home, sessionId) {
  try {
    return fs.readdirSync(sessionDir(home, sessionId))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch (_) { return []; }
}

// Compare a snapshot against current tree: changed / created / deleted rels.
function diffSnapshot(root, snap, opts) {
  const walk = walkFiles(root, opts);
  const changed = [];
  const created = [];
  const deleted = [];
  for (const rel of Object.keys(walk.files)) {
    if (!snap.files[rel]) created.push(rel);
    else if (walk.files[rel].hash !== snap.files[rel].hash) changed.push(rel);
  }
  for (const rel of Object.keys(snap.files)) {
    if (!walk.files[rel]) deleted.push(rel);
  }
  changed.sort(); created.sort(); deleted.sort();
  return { changed, created, deleted, truncated: walk.truncated };
}

// Restore: rewrite snapshotted contents, delete recorded creations, verify.
// opts.created: rels created during the series (safe to delete).
// Returns { restored:[{rel,ok}], deleted:[rel], unverified:[rel], errors:[] }.
function restoreSnapshot(root, snap, opts) {
  opts = opts || {};
  const createdSet = new Set(Array.isArray(opts.created) ? opts.created : []);
  const out = { restored: [], deleted: [], unverified: [], errors: [] };
  const rels = Object.keys(snap.files).sort();
  for (const rel of rels) {
    const meta = snap.files[rel];
    const full = path.join(root, rel);
    let current = null;
    try { current = fs.readFileSync(full); } catch (_) { current = null; }
    if (current && hashContent(current) === meta.hash) {
      out.restored.push({ rel, ok: true });
      continue; // untouched: nothing to do, verified
    }
    if (!Object.prototype.hasOwnProperty.call(snap.contents, rel)) {
      out.unverified.push(rel); // hash-only (too big): cannot restore honestly
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(snap.contents[rel], 'base64'));
      const back = fs.readFileSync(full);
      const ok = hashContent(back) === meta.hash;
      out.restored.push({ rel, ok });
      if (!ok) out.errors.push('hash mismatch apres restauration: ' + rel);
    } catch (e) {
      out.restored.push({ rel, ok: false });
      out.errors.push('restauration impossible: ' + rel + ' (' + String((e && e.message) || e).slice(0, 120) + ')');
    }
  }
  // Delete files created during the series (recorded only, never guessed).
  for (const rel of Array.from(createdSet).sort()) {
    if (Object.prototype.hasOwnProperty.call(snap.files, rel)) continue;
    const full = path.join(root, rel);
    try {
      if (fs.existsSync(full)) {
        const st = fs.statSync(full);
        if (st.isDirectory()) continue; // never delete directories blindly
        fs.unlinkSync(full);
        out.deleted.push(rel);
      }
    } catch (e) {
      out.errors.push('suppression impossible: ' + rel + ' (' + String((e && e.message) || e).slice(0, 120) + ')');
    }
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_STORED_FILE,
  SKIP_DIRS,
  hashContent,
  checkpointsDir,
  sessionDir,
  walkFiles,
  snapshotProject,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  diffSnapshot,
  restoreSnapshot,
};
