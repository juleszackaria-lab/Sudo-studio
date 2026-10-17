// Sudo Agent session store (P24). Sessions live OUTSIDE any project, under the
// global Sudo Studio home: <SUDO_STUDIO_HOME|~>/.sudo_studio/agent/sessions/.
// Atomic writes (tmp + rename). Stdlib only. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[0-9a-f]{16}$/;
const MAX_TITLE = 200;
const MAX_MESSAGES = 500;

function resolveHome(opts) {
  opts = opts || {};
  if (opts.home) return String(opts.home);
  if (process.env.SUDO_STUDIO_HOME) return String(process.env.SUDO_STUDIO_HOME);
  try { return os.homedir(); } catch (_) { return process.cwd(); }
}

function resolveStoreDir(opts) {
  opts = opts || {};
  if (opts.storeDir) return String(opts.storeDir);
  if (process.env.SUDO_AGENT_STORE) return String(process.env.SUDO_AGENT_STORE);
  return path.join(resolveHome(opts), '.sudo_studio', 'agent', 'sessions');
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

class SessionStore {
  constructor(opts) {
    opts = opts || {};
    this.dir = resolveStoreDir(opts);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(id) {
    return path.join(this.dir, id + '.json');
  }

  _writeAtomic(file, obj) {
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }

  _read(id) {
    if (!validId(id)) return null;
    try {
      const raw = fs.readFileSync(this._file(id), 'utf8');
      const s = JSON.parse(raw);
      if (!s || s.id !== id || !Array.isArray(s.messages)) return null;
      return s;
    } catch (_) { return null; }
  }

  // projectRoot is metadata ONLY: the store never touches that directory.
  create(opts) {
    opts = opts || {};
    const title = typeof opts.title === 'string' && opts.title.trim()
      ? opts.title.trim().slice(0, MAX_TITLE)
      : 'Session ' + nowIso().slice(0, 16).replace('T', ' ');
    const projectRoot = typeof opts.projectRoot === 'string' && opts.projectRoot
      ? String(opts.projectRoot).slice(0, 1024)
      : null;
    const t = nowIso();
    const s = { id: newId(), title, projectRoot, createdAt: t, updatedAt: t, messages: [], meta: { readFiles: [], todos: [], lastRun: null } };
    this._writeAtomic(this._file(s.id), s);
    return s;
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => ID_RE.test(f.replace(/\.json$/, '')) && f.endsWith('.json')); }
    catch (_) { return []; }
    const out = [];
    for (const f of files) {
      const s = this._read(f.slice(0, -5));
      if (s) out.push({ id: s.id, title: s.title, projectRoot: s.projectRoot, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  get(id) {
    return this._read(id);
  }

  append(id, msg) {
    const s = this._read(id);
    if (!s) return null;
    const role = msg && msg.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') return null;
    if (!msg || typeof msg.content !== 'string') return null;
    const entry = { role, content: msg.content.slice(0, 200000), at: nowIso(), aborted: msg.aborted === true };
    // Tool transcript linkage (P25), capped.
    if (typeof msg.tool_call_id === 'string' && msg.tool_call_id) entry.tool_call_id = msg.tool_call_id.slice(0, 128);
    if (typeof msg.name === 'string' && msg.name) entry.name = msg.name.slice(0, 64);
    if (Array.isArray(msg.tool_calls)) entry.tool_calls = msg.tool_calls.slice(0, 20).map((c) => ({
      id: String((c && c.id) || '').slice(0, 128),
      name: String((c && c.name) || '').slice(0, 64),
      argsText: String((c && c.argsText) || '').slice(0, 20000),
    }));
    s.messages.push(entry);
    while (s.messages.length > MAX_MESSAGES) s.messages.shift();
    s.updatedAt = nowIso();
    this._writeAtomic(this._file(id), s);
    return s;
  }

  // Generic atomic mutation (P25 session meta: readFiles, todos, lastRun).
  update(id, fn) {
    const s = this._read(id);
    if (!s) return null;
    try { fn(s); } catch (_) { return null; }
    if (!s.meta || typeof s.meta !== 'object') s.meta = {};
    s.updatedAt = nowIso();
    this._writeAtomic(this._file(id), s);
    return s;
  }

  remove(id) {
    if (!validId(id)) return false;
    try { fs.unlinkSync(this._file(id)); return true; }
    catch (_) { return false; }
  }

  count() {
    return this.list().length;
  }
}

function createStore(opts) {
  return new SessionStore(opts);
}

module.exports = { createStore, SessionStore, resolveStoreDir, validId };
