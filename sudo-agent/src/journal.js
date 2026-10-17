// Sudo Agent journal (P24). Original implementation of the P21 log format v1.
// Same contract as backend/utils/techLog.js and the extension mirror:
// human lines "TS [LEVEL] [component] [corr] msg | k=v ...", session banner,
// secret masking before ANY write, rotation BEFORE append (10 x 10 MB).
// Stdlib only. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FORMAT_VERSION = 1;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 10;               // current + 9 rotated

function resolveHome(opts) {
  opts = opts || {};
  if (opts.home) return String(opts.home);
  if (process.env.SUDO_STUDIO_HOME) return String(process.env.SUDO_STUDIO_HOME);
  try { return os.homedir(); } catch (_) { return process.cwd(); }
}

function resolveLogsDir(opts) {
  opts = opts || {};
  if (opts.logsDir) return String(opts.logsDir);
  if (process.env.SUDO_STUDIO_LOGS) return String(process.env.SUDO_STUDIO_LOGS);
  return path.join(resolveHome(opts), '.sudo_studio', 'logs');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Secret filter: mask before ANY write. Fail closed.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  // PEM private keys (multiline) first.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]'],
  // URLs with credentials: keep scheme + host, drop user:pass.
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/g, '$1[REDACTED]@'],
  // Known token shapes: OpenAI, GitHub, Groq, Slack, AWS, Google, JWT, hex bearer.
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

// ---------------------------------------------------------------------------
// Line format (v1)
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
// Correlation ids
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
// Session facts. Never throws, never includes secrets.
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
  try { info.ramTotalMB = Math.round(os.totalmem() / 1048576); }
  catch (_) { info.ramTotalMB = -1; }
  try { info.ramFreeMB = Math.round(os.freemem() / 1048576); }
  catch (_) { info.ramFreeMB = -1; }
  try {
    const p = opts.provider && typeof opts.provider === 'object' ? opts.provider : null;
    info.provider = p ? { type: String(p.type || '?'), model: String(p.model || '') } : 'none';
  } catch (_) { info.provider = '?'; }
  try { info.port = opts.port !== undefined ? opts.port : '?'; } catch (_) { info.port = '?'; }
  return maskSecretsDeep(info, 0);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
class AgentLogger {
  constructor(opts) {
    opts = opts || {};
    this.component = String(opts.component || 'agent').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'agent';
    this.dir = resolveLogsDir(opts);
    this.corr = opts.corr || null;
    this.maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
    this.fileOk = ensureDir(this.dir);
    if (!this.fileOk) {
      try { process.stderr.write('[agent-journal] WARNING: cannot use ' + this.dir + '\n'); } catch (_) {}
    }
    this.base = path.join(this.dir, this.component);
  }

  _rotate(file) {
    try {
      const st = fs.statSync(file);
      if (!st || st.size < this.maxBytes) return;
    } catch (_) { return; }
    try {
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = i === 1 ? file : file + '.' + (i - 1);
        const dst = file + '.' + i;
        try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch (_) {}
      }
    } catch (_) {}
  }

  _append(file, line) {
    if (!this.fileOk) return false;
    try {
      this._rotate(file); // rotate first when full: the current file always exists after a write
      fs.appendFileSync(file, line + '\n', 'utf8');
      return true;
    } catch (_) { return false; }
  }

  log(level, msg, fields, corr) {
    const e = {
      ts: tsWithTz(new Date()),
      level: String(level || 'info'),
      component: this.component,
      corr: corr || this.corr || null,
      msg: maskSecrets(msg),
      fields: maskSecretsDeep(fields || {}, 0),
    };
    const human = formatHuman(e);
    this._append(this.base + '.log', human);
    this._append(this.base + '.jsonl', formatJson(e));
    return e;
  }

  info(msg, fields, corr) { return this.log('info', msg, fields, corr); }
  warn(msg, fields, corr) { return this.log('warn', msg, fields, corr); }
  error(msg, fields, corr) { return this.log('error', msg, fields, corr); }

  child(corr) {
    const c = new AgentLogger({ logsDir: this.dir, component: this.component, corr: corr || newCorr('sess'), maxBytes: this.maxBytes, maxFiles: this.maxFiles });
    c.fileOk = this.fileOk;
    return c;
  }

  // Session header: appended on every boot, never truncates.
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
      '# cpu: ' + flatField(facts.cpu) + ' | provider: ' + flatField(typeof facts.provider === 'object' ? JSON.stringify(facts.provider) : facts.provider),
      '# ramMB: total=' + flatField(facts.ramTotalMB) + ' free=' + flatField(facts.ramFreeMB) + ' | port: ' + flatField(facts.port),
    ].join('\n');
    if (!this.fileOk) {
      try { process.stderr.write(banner + '\n'); } catch (_) {}
      return e;
    }
    this._append(this.base + '.log', banner);
    this._append(this.base + '.jsonl', formatJson(e));
    return e;
  }
}

const NOOP = {
  log() {}, info() {}, warn() {}, error() {}, child() { return NOOP; }, sessionHeader() {},
};

function createLogger(opts) {
  try { return new AgentLogger(opts || {}); }
  catch (_) { return NOOP; }
}

module.exports = {
  FORMAT_VERSION,
  createLogger,
  newCorr,
  corrFromReq,
  maskSecrets,
  maskSecretsDeep,
  formatHuman,
  formatJson,
  gatherSessionInfo,
  resolveLogsDir,
  resolveHome,
  AgentLogger,
  NOOP,
};
