/**
 * techLog.js - PROMPT 21 uniform structured technical journal.
 *
 * One line format for backend, supervisor, sdk installer, extension, autofix,
 * duplication (and later the agent server). Each event is written twice:
 * human-readable (<component>.log) and JSON (<component>.jsonl).
 *
 * Human line:
 *   2026-10-17T14:23:01.123+02:00 [INFO ] [backend] [req-a1b2c3d4] message | code=0 durationMs=45
 *   = timestamp with timezone, level, component, correlation id, message, fields.
 *
 * Storage: single documented folder (see docs/LOGS.md):
 *   win32 -> %LOCALAPPDATA%\SudoStudio\logs   (SUDO_STUDIO_LOGS overrides, tests use it)
 *   other -> ~/.sudo_studio/logs
 * Rotation: 10 files x 10 MB per component (<c>.log + .1 .. .9), append-only,
 * never truncated on restart (a new session header is appended instead).
 * Every value is secret-masked BEFORE writing (maskSecrets / maskSecretsDeep).
 *
 * Pure Node (fs/os/path/crypto only), pkg-safe (no __dirname reliance for the
 * log dir), ASCII-only source. NEVER throws on logging paths: failures fall
 * back to console or silence, never crash the caller.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FORMAT_VERSION = 1;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 10;               // current + 9 rotated
const TAIL_LINES = 30;

// ---------------------------------------------------------------------------
// Logs folder (single, documented, never inside the pkg snapshot / install root)
// ---------------------------------------------------------------------------
function resolveLogsDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (process.env.SUDO_STUDIO_LOGS) return process.env.SUDO_STUDIO_LOGS;
  const plat = opts.platform || process.platform;
  if (plat === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'SudoStudio', 'logs');
  }
  return path.join(os.homedir(), '.sudo_studio', 'logs');
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Secret filter (P21-d): mask before ANY write. Fail closed.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  // PEM private keys (multiline) first.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]'],
  // URLs with credentials: keep scheme + host, drop user:pass.
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/g, '$1[REDACTED]@'],
  // Known token shapes: OpenAI, GitHub, Groq, Slack, AWS, Google, JWT.
  [/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gsk_[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]{10,})?)\b/g, '[REDACTED]'],
  // Named assignments: password=..., "api_key": "...", secret: '...' ...
  [/((?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]'],
  // Authorization: Bearer <token> header form.
  [/([Bb]earer\s+)([A-Za-z0-9._~+/-]+=*)/g, '$1[REDACTED]'],
];

function maskSecrets(s) {
  let out = String(s === undefined || s === null ? '' : s);
  for (const [re, rep] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, rep);
  }
  return out;
}

function maskSecretsDeep(v, depth) {
  if (v === undefined || v === null) return v;
  if (typeof v === 'string') return maskSecrets(v);
  if (typeof v !== 'object' || (depth || 0) > 6) return v;
  if (Array.isArray(v)) return v.map((x) => maskSecretsDeep(x, (depth || 0) + 1));
  const o = {};
  for (const k of Object.keys(v)) {
    if (/password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie/i.test(k)) o[k] = '[REDACTED]';
    else o[k] = maskSecretsDeep(v[k], (depth || 0) + 1);
  }
  return o;
}

function tailLines(s, n) {
  const lines = String(s || '').replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-(n || TAIL_LINES)).join('\n').slice(0, 8000);
}

// ---------------------------------------------------------------------------
// Line format
// ---------------------------------------------------------------------------
function tsWithTz(d) {
  const dt = d instanceof Date ? d : new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const off = -dt.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + 'T' +
    p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds()) + '.' + p(dt.getMilliseconds(), 3) +
    sign + p(Math.floor(a / 60)) + ':' + p(a % 60);
}

function flatField(v) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
  return String(v).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function formatHuman(e) {
  const lvl = String(e.level || 'info').toUpperCase().padEnd(5, ' ').slice(0, 5);
  let line = e.ts + ' [' + lvl + '] [' + e.component + '] [' + (e.corr || '-') + '] ' + String(e.msg || '').replace(/[\r\n]+/g, ' | ');
  const f = e.fields || {};
  const keys = Object.keys(f);
  if (keys.length) line += ' | ' + keys.map((k) => k + '=' + flatField(f[k])).join(' ');
  return line;
}

function formatJson(e) {
  return JSON.stringify({ v: FORMAT_VERSION, ts: e.ts, level: e.level, component: e.component, corr: e.corr || null, msg: e.msg, fields: e.fields || {} });
}

// ---------------------------------------------------------------------------
// Correlation ids: one per request / session.
// ---------------------------------------------------------------------------
function newCorr(prefix) {
  let rnd = '';
  try { rnd = crypto.randomBytes(4).toString('hex'); }
  catch (_) { rnd = String(Date.now() % 0xffffffff).padStart(8, '0'); }
  return (prefix || 'req') + '-' + rnd;
}

function corrFromReq(req) {
  try {
    const h = req && req.headers ? (req.headers['x-correlation-id'] || req.headers['x-request-id']) : null;
    if (h && /^[A-Za-z0-9_-]{1,64}$/.test(String(h))) return String(h);
  } catch (_) { /* ignore */ }
  return newCorr('req');
}

// ---------------------------------------------------------------------------
// Session facts (P21-b). Never throws, never includes secrets.
// ---------------------------------------------------------------------------
function gatherSessionInfo(opts) {
  opts = opts || {};
  const info = {};
  try { info.build = String(opts.build || 'unknown'); } catch (_) { info.build = 'unknown'; }
  try { info.node = process.version; } catch (_) { info.node = '?'; }
  try { info.os = os.platform() + ' ' + os.release() + ' ' + os.arch(); } catch (_) { info.os = '?'; }
  try {
    const cpus = os.cpus() || [];
    info.cpu = (cpus.length ? cpus.length + 'x ' + (cpus[0].model || '?') : '?').trim();
  } catch (_) { info.cpu = '?'; }
  try { info.llamacpp = String(process.env.SUDO_LLAMACPP_VARIANT || opts.llamacpp || 'unknown'); }
  catch (_) { info.llamacpp = 'unknown'; }
  try {
    info.ramTotalMB = Math.round(os.totalmem() / 1048576);
    info.ramFreeMB = Math.round(os.freemem() / 1048576);
  } catch (_) { info.ramTotalMB = -1; info.ramFreeMB = -1; }
  try { info.model = String(opts.model !== undefined ? opts.model : 'unknown'); } catch (_) { info.model = 'unknown'; }
  try { info.ports = opts.ports !== undefined ? opts.ports : {}; } catch (_) { info.ports = {}; }
  try { info.policies = opts.policies !== undefined ? opts.policies : {}; } catch (_) { info.policies = {}; }
  return maskSecretsDeep(info, 0);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
class TechLogger {
  constructor(opts) {
    opts = opts || {};
    this.component = String(opts.component || 'app').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'app';
    this.dir = resolveLogsDir(opts);
    this.corr = opts.corr || null;
    this.maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
    this.fileOk = ensureDir(this.dir);
    if (!this.fileOk) {
      try { process.stderr.write('[techLog] WARNING: cannot use ' + this.dir + ', console fallback\n'); } catch (_) {}
    }
    this.base = path.join(this.dir, this.component);
  }

  _rotate(file) {
    try {
      let size = -1;
      try { size = fs.statSync(file).size; } catch (_) { return; }
      if (size < this.maxBytes) return;
      const oldest = file + '.' + (this.maxFiles - 1);
      try { fs.unlinkSync(oldest); } catch (_) {}
      for (let i = this.maxFiles - 2; i >= 1; i--) {
        try { fs.renameSync(file + '.' + i, file + '.' + (i + 1)); } catch (_) {}
      }
      try { fs.renameSync(file, file + '.1'); } catch (_) {}
    } catch (_) { /* rotation best effort, never crash */ }
  }

  _append(file, line) {
    try {
      this._rotate(file); // rotate first when full: the current file always exists after a write
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (_) {
      try { process.stderr.write('[techLog:' + this.component + '] ' + line.slice(0, 300) + '\n'); } catch (_) {}
    }
  }

  log(level, msg, fields, corrOverride) {
    const e = {
      ts: tsWithTz(new Date()),
      level: String(level || 'info').toLowerCase(),
      component: this.component,
      corr: corrOverride || this.corr || null,
      msg: maskSecrets(msg),
      fields: maskSecretsDeep(fields || {}, 0),
    };
    // Multiline messages: keep the JSON record whole, fold human lines.
    const human = formatHuman(e);
    if (!this.fileOk) {
      try { process.stdout.write(human + '\n'); } catch (_) {}
      return e;
    }
    this._append(this.base + '.log', human);
    this._append(this.base + '.jsonl', formatJson(e));
    return e;
  }

  info(msg, fields, corr) { return this.log('info', msg, fields, corr); }
  warn(msg, fields, corr) { return this.log('warn', msg, fields, corr); }
  error(msg, fields, corr) { return this.log('error', msg, fields, corr); }

  child(corr) {
    const c = new TechLogger({ dir: this.dir, component: this.component, corr: corr || newCorr('sess'), maxBytes: this.maxBytes, maxFiles: this.maxFiles });
    c.fileOk = this.fileOk;
    return c;
  }

  // Session header (P21-b): appended on every boot, never truncates.
  sessionHeader(info) {
    const facts = maskSecretsDeep(info && typeof info === 'object' ? info : gatherSessionInfo({}), 0);
    const e = {
      ts: tsWithTz(new Date()),
      level: 'info',
      component: this.component,
      corr: this.corr || 'session',
      msg: 'session start',
      fields: { type: 'session', format: FORMAT_VERSION, facts },
    };
    const banner = [
      '# === session start ' + e.ts + ' ===',
      '# build: ' + flatField(facts.build) + ' | node: ' + flatField(facts.node) + ' | os: ' + flatField(facts.os),
      '# cpu: ' + flatField(facts.cpu) + ' | llamacpp: ' + flatField(facts.llamacpp),
      '# ramMB: total=' + flatField(facts.ramTotalMB) + ' free=' + flatField(facts.ramFreeMB) +
        ' | model: ' + flatField(typeof facts.model === 'object' ? JSON.stringify(facts.model) : facts.model),
      '# ports: ' + flatField(typeof facts.ports === 'object' ? JSON.stringify(facts.ports) : facts.ports) +
        ' | policies: ' + flatField(typeof facts.policies === 'object' ? JSON.stringify(facts.policies) : facts.policies),
    ].join('\n');
    if (!this.fileOk) {
      try { process.stdout.write(banner + '\n'); } catch (_) {}
      return e;
    }
    this._append(this.base + '.log', banner);
    this._append(this.base + '.jsonl', formatJson(e));
    return e;
  }
}

// No-op logger (extension side before activation init; keeps tests hermetic).
const NOOP = {
  log() {}, info() {}, warn() {}, error() {}, child() { return NOOP; }, sessionHeader() {},
};

function createLogger(opts) {
  try { return new TechLogger(opts || {}); }
  catch (_) { return NOOP; }
}

// Named shared instances (one logger per component per process).
// Disabled by default: sharedLog() returns NOOP until the host enables it
// (backend server.js / extension activate). This keeps unit tests hermetic:
// they must opt in with setTechEnabled(true) + SUDO_STUDIO_LOGS=tmp.
let _techEnabled = false;
const _shared = {};
function setTechEnabled(v) { _techEnabled = !!v; }
function isTechEnabled() { return _techEnabled; }
function sharedLog(component) {
  if (!_techEnabled) return NOOP;
  const c = String(component || 'app');
  if (!_shared[c]) _shared[c] = createLogger({ component: c });
  return _shared[c];
}
function _resetSharedForTests() { for (const k of Object.keys(_shared)) delete _shared[k]; _techEnabled = false; }

// Run a shell command and journal it (P21-g): exact cmd, code, last-30 output, ms.
// execFn: async (cmd, opts) -> { stdout, stderr } (throws carry .code/.stdout/.stderr).
async function execLogged(execFn, tech, cmd, opts) {
  const t0 = Date.now();
  try {
    const r = await execFn(cmd, opts || {});
    const ms = Date.now() - t0;
    try {
      (tech || NOOP).info('exec', { cmd, code: 0, durationMs: ms, out: tailLines((r.stdout || '') + '\n' + (r.stderr || '')) });
    } catch (_) {}
    return r;
  } catch (e) {
    const ms = Date.now() - t0;
    const code = e && typeof e.code === 'number' ? e.code : 1;
    try {
      (tech || NOOP).warn('exec', { cmd, code, durationMs: ms,
        out: tailLines(((e && e.stdout) || '') + '\n' + ((e && e.stderr) || '') + '\n' + ((e && e.message) || String(e))) });
    } catch (_) {}
    throw e;
  }
}

module.exports = {
  FORMAT_VERSION, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, TAIL_LINES,
  resolveLogsDir, maskSecrets, maskSecretsDeep, tailLines,
  tsWithTz, formatHuman, formatJson, newCorr, corrFromReq,
  gatherSessionInfo, TechLogger, NOOP, createLogger, execLogged,
  setTechEnabled, isTechEnabled, sharedLog, _resetSharedForTests,
};
