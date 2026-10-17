/**
 * runtimeSupervisor.js - MISSION P1-d
 *
 * Watches the Python runtime (127.0.0.1:6000). If /health fails 3 times in a
 * row (3 x 5s = 15s: process exited OR hung), the runtime is restarted:
 * best-effort kill of leftovers, backoff 2s / 5s / 10s, max 5 restarts per
 * sliding 10-minute window. After a restart the last saved model is
 * re-triggered via POST /reload (belt + suspenders over the runtime boot
 * autoload). Every event is written to backend logs AND to the dedicated
 * audit file logs/runtime-supervisor.log. status() feeds the UI banner
 * "Runtime redemarre a HH:MM (raison)" (accents added by the panel).
 *
 * All IO is injectable (httpGet/httpPost/spawnFn/killFn/sleep/now/log) so
 * the whole state machine is unit-testable without any process or network.
 *
 * ASCII-only source (project rule).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------- builtin HTTP
function httpJson(method, urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const payload = (body === undefined || body === null) ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs || 3000,
      headers,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(chunks); } catch (_) { data = chunks; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function defaultHttpGet(url, timeoutMs) { return httpJson('GET', url, null, timeoutMs); }
function defaultHttpPost(url, body, timeoutMs) { return httpJson('POST', url, body, timeoutMs); }

// ---------------------------------------------------------------- spawn / kill
function defaultSpawn(exePath) {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return true;
}

function defaultKill(imageName) {
  // Best effort: only meaningful on Windows (prod). Never throws.
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve('skip (not win32)'); return; }
    execFile('taskkill', ['/F', '/IM', imageName], () => resolve('taskkill attempted'));
  });
}

// ---------------------------------------------------------------- paths
function resolveRuntimeExe() {
  if (process.env.SUDO_RUNTIME_EXE) return process.env.SUDO_RUNTIME_EXE;
  if (typeof process.pkg !== 'undefined') {
    // Packaged layout: app/backend.exe + app/runtime.exe (see start.bat).
    return path.join(path.dirname(process.execPath), 'runtime.exe');
  }
  return null; // dev mode: nothing to spawn, watch-only
}

function resolveStateFile() {
  // Written by the runtime: save_model_state() -> model_state.json
  return path.join(os.homedir(), '.sudo_studio', 'models', 'model_state.json');
}

function resolveAuditPath() {
  const dir = (typeof process.pkg !== 'undefined')
    ? path.join(path.dirname(process.execPath), '..', 'logs')
    : path.join(__dirname, '..', '..', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return path.join(dir, 'runtime-supervisor.log');
}

function toHHMM(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------------------------------------------------------------- class
class RuntimeSupervisor {
  constructor(opts) {
    opts = opts || {};
    this.runtimeUrl = opts.runtimeUrl || 'http://127.0.0.1:6000';
    this.runtimeExePath = opts.runtimeExePath !== undefined ? opts.runtimeExePath : resolveRuntimeExe();
    this.stateFilePath = opts.stateFilePath || resolveStateFile();
    this.auditPath = opts.auditPath || resolveAuditPath();
    this.pollMs = opts.pollMs || 5000;
    this.failThreshold = opts.failThreshold || 3; // 3 x pollMs = 15s
    this.backoffsMs = opts.backoffsMs || [2000, 5000, 10000];
    this.maxRestarts = opts.maxRestarts || 5;
    this.windowMs = opts.windowMs || 10 * 60 * 1000;
    this.graceMs = opts.graceMs !== undefined ? opts.graceMs : 120000;
    this.waitHealthyMs = opts.waitHealthyMs || 120000;

    this.httpGet = opts.httpGet || defaultHttpGet;
    this.httpPost = opts.httpPost || defaultHttpPost;
    this.spawnFn = opts.spawnFn || defaultSpawn;
    this.killFn = opts.killFn || defaultKill;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || ((m) => { try { console.log(m); } catch (_) { /* ignore */ } });
    this.tech = opts.tech || null; // P21-f: TechLogger (structured journal), optional

    this.running = false;
    this.timer = null;
    this.startedAt = 0;
    this.restarting = false;
    this.consecutiveFailures = 0;
    this.consecutiveRestarts = 0;
    this.lastOk = null;
    this.lastError = null;
    this.everHealthy = false;
    this.restarts = [];         // [{atIso, atHHMM, reason, ok, detail}]
    this.restartAttempts = [];  // timestamps (sliding window for the cap)
    this.lastSuppressed = null; // {atIso, atHHMM, reason}
  }

  audit(msg) {
    const line = new Date(this.now()).toISOString() + ' ' + msg + '\n';
    try { fs.appendFileSync(this.auditPath, line); } catch (_) { /* ignore */ }
    this.log('[SUPERVISOR] ' + msg);
  }

  tlog(level, msg, fields) { // P21-f: structured tech-journal mirror (best effort)
    if (!this.tech) return;
    try {
      const fn = this.tech[level] ? this.tech[level].bind(this.tech) : this.tech.info.bind(this.tech);
      fn(msg, fields || {});
    } catch (_) { /* never break supervision */ }
  }

  exeExists() {
    try { return !!(this.runtimeExePath && fs.existsSync(this.runtimeExePath)); }
    catch (_) { return false; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.audit('START watching=' + this.runtimeUrl +
      ' exe=' + (this.runtimeExePath || '(none: watch-only)') +
      ' grace_s=' + Math.round(this.graceMs / 1000));
    this.tlog('info', 'supervisor start', { watching: this.runtimeUrl,
      exe: this.runtimeExePath || null, graceS: Math.round(this.graceMs / 1000) });
    this.timer = setInterval(() => { this.pollTick(); }, this.pollMs);
    if (this.timer && this.timer.unref) this.timer.unref();
    this.pollTick(); // immediate first check (async, guarded)
  }

  stop() {
    this.running = false;
    if (this.timer) { try { clearInterval(this.timer); } catch (_) { /* ignore */ } }
    this.timer = null;
    this.audit('STOP');
    this.tlog('info', 'supervisor stop', {});
  }

  pruneAttempts(nowTs) {
    const cutoff = nowTs - this.windowMs;
    this.restartAttempts = this.restartAttempts.filter((t) => t > cutoff);
  }

  async pollTick() {
    if (!this.running || this.restarting) return;
    try {
      const h = await this.httpGet(this.runtimeUrl + '/health', 3000);
      if (h && h.status === 200) {
        // Healthy even while loading:true - Flask answers during load.
        this.consecutiveFailures = 0;
        this.consecutiveRestarts = 0;
        this.lastOk = true;
        this.lastError = null;
        this.everHealthy = true;
        return;
      }
      throw new Error('health status ' + (h && h.status));
    } catch (e) {
      this.consecutiveFailures += 1;
      this.lastOk = false;
      this.lastError = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e));
      if (this.consecutiveFailures >= this.failThreshold) {
        const n = this.consecutiveFailures;
        const reason = (e && e.code === 'ECONNREFUSED')
          ? 'health refused x' + n + ' (process likely exited)'
          : 'health failing x' + n + ' (' + this.lastError + ')';
        this.tlog('warn', 'runtime unhealthy (stop detected)', { reason, consecutiveFailures: n, lastError: this.lastError });
        await this.maybeRestart(reason);
      }
    }
  }

  async maybeRestart(reason) {
    const nowTs = this.now();
    if (nowTs - this.startedAt < this.graceMs) {
      this.lastSuppressed = {
        atIso: new Date(nowTs).toISOString(), atHHMM: toHHMM(nowTs),
        reason: 'grace period (' + reason + ')',
      };
      this.audit('SUPPRESSED (grace): ' + reason);
      this.tlog('warn', 'restart suppressed', { why: 'grace', reason });
      return { action: 'suppressed_grace' };
    }
    this.pruneAttempts(nowTs);
    if (this.restartAttempts.length >= this.maxRestarts) {
      this.lastSuppressed = {
        atIso: new Date(nowTs).toISOString(), atHHMM: toHHMM(nowTs),
        reason: 'cap reached: ' + this.maxRestarts + ' restarts per 10 min (' + reason + ')',
      };
      this.audit('SUPPRESSED (cap): ' + reason);
      this.tlog('warn', 'restart suppressed', { why: 'cap', reason, maxRestarts: this.maxRestarts });
      return { action: 'suppressed_cap' };
    }
    this.restarting = true;
    const backoff = this.backoffsMs[Math.min(this.consecutiveRestarts, this.backoffsMs.length - 1)];
    this.restartAttempts.push(nowTs);
    const attemptNo = this.restartAttempts.length;
    this.audit('RESTART attempt#' + attemptNo + ' in window, backoff=' + backoff +
      'ms, reason=' + reason);
    this.tlog('warn', 'restart attempt', { attempt: attemptNo, backoffMs: backoff, reason });
    let ok = false;
    let detail = '';
    let killResult = null;
    let spawnOk = false;
    let exitCode = null; // detached spawn/taskkill report no exit code; 'error' on exception
    try {
      killResult = await this.killFn('runtime.exe');
      await this.sleep(backoff);
      if (!this.exeExists()) {
        detail = 'exe not found: ' + this.runtimeExePath;
      } else {
        this.spawnFn(this.runtimeExePath);
        spawnOk = true;
        const healthy = await this.waitHealthy(this.waitHealthyMs);
        if (!healthy) {
          detail = 'still unhealthy after ' + Math.round(this.waitHealthyMs / 1000) + 's';
        } else {
          detail = await this.ensureModel();
          ok = true;
        }
      }
    } catch (e) {
      detail = 'exception: ' + ((e && e.message) || String(e));
      exitCode = 'error';
    }
    if (ok) {
      this.consecutiveFailures = 0;
      this.consecutiveRestarts = 0;
      this.everHealthy = true;
      this.lastOk = true;
    } else {
      this.consecutiveRestarts += 1;
    }
    const rec = {
      atIso: new Date(this.now()).toISOString(),
      atHHMM: toHHMM(this.now()),
      reason, ok, detail,
    };
    this.restarts.push(rec);
    if (this.restarts.length > 20) this.restarts = this.restarts.slice(-20);
    this.audit('RESTART done ok=' + ok + ' at=' + rec.atHHMM +
      ' reason=' + reason + ' detail=' + detail);
    this.tlog(ok ? 'info' : 'error', 'restart done', { ok, reason, detail,
      killResult: killResult === null || killResult === undefined ? null : String(killResult).slice(0, 200),
      spawnOk, exitCode });
    this.restarting = false;
    return { action: 'restarted', ok, detail };
  }

  async waitHealthy(timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      try {
        const h = await this.httpGet(this.runtimeUrl + '/health', 3000);
        if (h && h.status === 200) return true;
      } catch (_) { /* keep waiting */ }
      await this.sleep(2000);
    }
    return false;
  }

  readSavedState() {
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const d = JSON.parse(raw);
      if (d && d.model_id) return { model_id: d.model_id, n_ctx: d.n_ctx || null };
      return null;
    } catch (_) {
      return null;
    }
  }

  async ensureModel() {
    // The runtime boot path autoloads; this is belt + suspenders: if the
    // fresh process reports loaded=false, re-trigger the last saved model.
    try {
      const h = await this.httpGet(this.runtimeUrl + '/health', 5000);
      const m = (h && h.data && h.data.model) || {};
      if (m.loaded) return 'model already loaded: ' + (m.name || '?');
      const saved = this.readSavedState();
      if (!saved) return 'no saved model, boot autoload pending';
      const body = { model: saved.model_id };
      if (saved.n_ctx) body.n_ctx = saved.n_ctx;
      const r = await this.httpPost(this.runtimeUrl + '/reload', body, 10000);
      const st = (r && r.data && r.data.status) || (r && r.status);
      return 'reload triggered for ' + saved.model_id + ' -> ' + st;
    } catch (e) {
      return 'ensureModel error: ' + ((e && e.message) || String(e));
    }
  }

  status() {
    const nowTs = this.now();
    this.pruneAttempts(nowTs);
    const last = this.restarts.length ? this.restarts[this.restarts.length - 1] : null;
    return {
      watching: this.running,
      runtimeUrl: this.runtimeUrl,
      exePath: this.runtimeExePath,
      exeFound: this.exeExists(),
      healthy: this.lastOk === true,
      consecutiveFailures: this.consecutiveFailures,
      everHealthy: this.everHealthy,
      graceActive: (nowTs - this.startedAt) < this.graceMs,
      restartsInWindow: this.restartAttempts.length,
      maxRestarts: this.maxRestarts,
      windowMinutes: Math.round(this.windowMs / 60000),
      consecutiveRestarts: this.consecutiveRestarts,
      restarts: this.restarts.slice(-5),
      lastRestart: last,
      lastSuppressed: this.lastSuppressed,
      lastError: this.lastError,
    };
  }
}

// ---------------------------------------------------------------- singleton
let _instance = null;

function getSupervisor(opts) {
  if (!_instance) _instance = new RuntimeSupervisor(opts || {});
  return _instance;
}

function _resetSupervisorForTests() {
  if (_instance) { try { _instance.stop(); } catch (_) { /* ignore */ } }
  _instance = null;
}

module.exports = {
  RuntimeSupervisor,
  getSupervisor,
  _resetSupervisorForTests,
  resolveRuntimeExe,
  resolveStateFile,
  resolveAuditPath,
  toHHMM,
};
