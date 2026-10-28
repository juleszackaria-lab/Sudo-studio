// Sudo Agent long-running processes (P50-3). Tracked child processes with
// live output polling, stop, and total-life timeout. Output is split
// stdout/stderr with per-stream offsets (poll returns only NEW bytes).
// Buffers are capped (drain-and-discard past the cap, never SIGPIPE the
// child). Non-zero exit and timeout surface as failures WITH extracted
// build diagnostics, feeding the bounded fix loop in loop.js.
// Stdlib only, ASCII only. No require() of tools.js (cycle).
'use strict';

const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ID_RE = /^[0-9a-f]{16}$/;
const MAX_PROCS = 10;
const MAX_BUF = 1024 * 1024;      // per-stream buffer cap
const MAX_POLL_BYTES = 64 * 1024; // per-poll return cap (per stream)
const DEFAULT_TIMEOUT = 600000;   // 10 min total life
const MAX_TIMEOUT = 3600000;      // 1 h
const MAX_DIAG_LINES = 30;
const MAX_DIAG_CHARS = 8000;

const procs = new Map(); // id -> proc record

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

function filterEnv(input) {
  const out = {};
  const src = input || {};
  for (const k of Object.keys(src)) {
    if (k === 'SUDO_AGENT_TOKEN') continue;
    if (/secret|token|password|passwd|private[_-]?key|api[_-]?key|authorization|credential/i.test(k)) continue;
    out[k] = src[k];
  }
  return out;
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

function shellFor(command) {
  return process.platform === 'win32'
    ? { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { bin: '/bin/sh', args: ['-c', command] };
}

// opts: { command, cwd, timeoutMs?, label? }. Returns { ok, id?, pid?, error? }.
function startProc(opts) {
  opts = opts || {};
  const command = opts.command;
  if (typeof command !== 'string' || !command.trim()) return { ok: false, code: 'bad_args', error: 'commande requise.' };
  if (command.length > 8000) return { ok: false, code: 'too_big', error: 'commande trop longue.' };
  if (!opts.cwd || typeof opts.cwd !== 'string') return { ok: false, code: 'bad_args', error: 'dossier requis.' };
  if (procs.size >= MAX_PROCS) return { ok: false, code: 'too_many', error: 'trop de processus suivis (' + MAX_PROCS + ' max).' };
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, parseInt(opts.timeoutMs, 10) || DEFAULT_TIMEOUT));
  const shell = shellFor(command);
  let child = null;
  try {
    child = spawn(shell.bin, shell.args, {
      cwd: opts.cwd, env: filterEnv(process.env), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], detached: false, shell: false,
    });
  } catch (e) {
    return { ok: false, code: 'spawn', error: 'lancement impossible (' + String((e && e.message) || e).slice(0, 120) + ').' };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const rec = { id, label: String(opts.label || '').slice(0, 80), command: String(command).slice(0, 300),
    child, pid: child.pid || 0, t0: Date.now(), timeoutMs,
    out: '', outOff: 0, err: '', errOff: 0, outBytes: 0, errBytes: 0, truncated: false,
    exitCode: null, signal: null, timedOut: false, killed: false, done: false, timer: null };
  child.stdout.on('data', (c) => {
    rec.outBytes += c.length;
    if (rec.out.length < MAX_BUF) rec.out = (rec.out + c).slice(0, MAX_BUF);
    else rec.truncated = true;
  });
  child.stderr.on('data', (c) => {
    rec.errBytes += c.length;
    if (rec.err.length < MAX_BUF) rec.err = (rec.err + c).slice(0, MAX_BUF);
    else rec.truncated = true;
  });
  child.on('error', (e) => {
    if (rec.done) return;
    rec.done = true;
    rec.exitCode = null; rec.signal = null;
    rec.spawnError = String((e && e.message) || e).slice(0, 160);
    if (rec.timer) { try { clearTimeout(rec.timer); } catch (_) {} rec.timer = null; }
  });
  child.on('exit', (code, signal) => {
    if (rec.done) return;
    rec.done = true;
    rec.exitCode = code; rec.signal = signal || null;
    if (rec.timer) { try { clearTimeout(rec.timer); } catch (_) {} rec.timer = null; }
  });
  rec.timer = setTimeout(() => {
    if (rec.done) return;
    rec.timedOut = true;
    rec.killed = true;
    killTree(child);
    // exit event follows and marks done; force-mark in case it never comes.
    setTimeout(() => {
      if (!rec.done) { rec.done = true; rec.exitCode = null; rec.signal = 'SIGKILL'; }
      rec.timer = null;
    }, 2000).unref();
  }, timeoutMs);
  if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  procs.set(id, rec);
  return { ok: true, id, pid: rec.pid };
}

function takeNew(rec, which) {
  const buf = which === 'err' ? rec.err : rec.out;
  const offKey = which === 'err' ? 'errOff' : 'outOff';
  const fresh = buf.slice(rec[offKey], rec[offKey] + MAX_POLL_BYTES);
  rec[offKey] += fresh.length;
  return fresh;
}

// Returns new output since the last poll. Never throws for unknown ids:
// it reports ok:false instead (model-safe).
function pollProc(id) {
  if (!validId(id)) return { ok: false, code: 'bad_args', error: 'identifiant de processus invalide.' };
  const rec = procs.get(id);
  if (!rec) return { ok: false, code: 'unknown_proc', error: 'processus inconnu (termine et libere, ou jamais demarre).' };
  const out = takeNew(rec, 'out');
  const err = takeNew(rec, 'err');
  const base = { running: !rec.done, out, err, outBytes: rec.outBytes, errBytes: rec.errBytes,
    truncated: rec.truncated, ms: Date.now() - rec.t0, pid: rec.pid, label: rec.label,
    exitCode: rec.exitCode, signal: rec.signal, timedOut: rec.timedOut, killed: rec.killed };
  if (!rec.done) return Object.assign({ ok: true }, base);
  if (rec.timedOut) return Object.assign({ ok: false, code: 'timeout',
    error: 'delai depasse (' + rec.timeoutMs + ' ms), processus tue.' }, base);
  if (rec.spawnError) return Object.assign({ ok: false, code: 'spawn', error: rec.spawnError }, base);
  if (rec.killed) return Object.assign({ ok: true, stopped: true }, base);
  if (rec.exitCode !== 0) return Object.assign({ ok: false, code: 'exit_' + rec.exitCode,
    error: 'sortie ' + rec.exitCode + (rec.signal ? ' (' + rec.signal + ')' : '') + '.' }, base);
  return Object.assign({ ok: true }, base);
}

function stopProc(id) {
  if (!validId(id)) return { ok: false, code: 'bad_args', error: 'identifiant de processus invalide.' };
  const rec = procs.get(id);
  if (!rec) return { ok: false, code: 'unknown_proc', error: 'processus inconnu.' };
  if (rec.done) return { ok: true, stopped: false, already: true, exitCode: rec.exitCode, ms: Date.now() - rec.t0 };
  rec.killed = true;
  killTree(rec.child);
  if (rec.timer) { try { clearTimeout(rec.timer); } catch (_) {} rec.timer = null; }
  return { ok: true, stopped: true, pid: rec.pid, ms: Date.now() - rec.t0 };
}

function listProcs() {
  const out = [];
  for (const rec of procs.values()) {
    out.push({ id: rec.id, label: rec.label, pid: rec.pid, running: !rec.done,
      exitCode: rec.exitCode, ms: Date.now() - rec.t0, outBytes: rec.outBytes, errBytes: rec.errBytes });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Forget finished processes (frees ids). Running ones are untouched.
function reapProcs() {
  let n = 0;
  for (const [id, rec] of procs) {
    if (rec.done) { procs.delete(id); n += 1; }
  }
  return n;
}

function stopAll() {
  const ids = [];
  for (const [id, rec] of procs) {
    try { if (!rec.done) { rec.killed = true; killTree(rec.child); } } catch (_) {}
    try { if (rec.timer) clearTimeout(rec.timer); } catch (_) {}
    ids.push(id);
  }
  procs.clear();
  return ids;
}

// Build-failure diagnostics: error-shaped lines + tail. Pure function.
function extractErrors(text, maxLines) {
  const lines = String(text || '').split('\n');
  const errs = [];
  const re = /error|erreur|failed|failure|echec|traceback|exception|fatal|ERR!|E\d{4}|TS\d+|CS\d+|undefined reference|ld returned|make(\[\d+\])?: \*\*\*/i;
  for (const ln of lines) {
    if (errs.length >= (maxLines || MAX_DIAG_LINES)) break;
    if (re.test(ln)) errs.push(ln.slice(0, 300));
  }
  const tail = lines.slice(-10).map((l) => l.slice(0, 300));
  let diag = '';
  if (errs.length) diag = 'lignes d erreur (' + errs.length + ') :\n' + errs.join('\n');
  const tailText = tail.join('\n').trim();
  if (tailText) diag += (diag ? '\n\n' : '') + 'fin de sortie :\n' + tailText;
  return { errors: errs, tail, text: diag.slice(0, MAX_DIAG_CHARS) };
}

module.exports = {
  startProc, pollProc, stopProc, listProcs, reapProcs, stopAll,
  extractErrors, validId, _procs: procs,
  MAX_PROCS, DEFAULT_TIMEOUT, MAX_TIMEOUT,
};
