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

// P69-B4: le journal du superviseur etait ecrit dans <exe>/../logs, c'est-a-dire
// "C:\\Program Files\\logs" une fois installe — dossier NON inscriptible sans
// elevation, et toutes les erreurs etaient avalees : le journal etait muet.
// Il suit desormais le dossier de logs UNIQUE du produit (P33), exactement
// comme backend/server.js et techLog.js.
function resolveLogDir() {
  const env = process.env.SUDO_STUDIO_LOGS;
  if (env) return env;
  if (typeof process.pkg !== 'undefined') {
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'SudoStudio', 'logs');
    }
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'sudo-studio', 'logs');
  }
  return path.join(__dirname, '..', '..', 'logs');
}

function resolveAuditPath() {
  const dir = resolveLogDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* signale plus bas */ }
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
    // P69-B5: battement de coeur (port separe) : distingue OCCUPE de MORT.
    this.heartbeatUrl = opts.heartbeatUrl ||
      (process.env.SUDO_HB_URL || 'http://127.0.0.1:' + (process.env.SUDO_HB_PORT || 6001));
    this.crashLogPath = opts.crashLogPath || path.join(resolveLogDir(), 'runtime_crash.log');
    this.lastCallPath = opts.lastCallPath || path.join(resolveLogDir(), 'last_call.json');
    this.child = null;
    this.childExit = null;   // {code, signal, atIso}
    this.lastBusyAt = 0;
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
    // P62-B3: renseigne par server.js (RAM libre, temps depuis la derniere
    // requete, veille detectee). Injecte pour rester testable sans process.
    this.diagFn = typeof opts.diagFn === 'function' ? opts.diagFn : null;
    this.lastRequestAt = 0;

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
    try {
      fs.appendFileSync(this.auditPath, line);
    } catch (e) {
      // P69-B4: un journal muet n'est pas un journal. On crie (console + tech).
      const why = 'audit write FAILED (' + this.auditPath + '): ' + ((e && e.message) || String(e));
      if (!this._auditWarned) {
        this._auditWarned = true;
        this.log('[SUPERVISOR][ERREUR] ' + why);
        this.tlog('error', 'supervisor audit write failed', { path: this.auditPath, why });
      }
    }
    this.log('[SUPERVISOR] ' + msg);
  }

  tlog(level, msg, fields) { // P21-f: structured tech-journal mirror (best effort)
    if (!this.tech) return;
    try {
      const fn = this.tech[level] ? this.tech[level].bind(this.tech) : this.tech.info.bind(this.tech);
      fn(msg, fields || {});
    } catch (_) { /* never break supervision */ }
  }

  // P62-B3: pourquoi on relance, avec la RAM libre et le silence du client.
  diag(extra) {
    let d = { ramFreeMB: null, sinceLastRequestS: null, suspend: null };
    try { d.ramFreeMB = Math.round(require('os').freemem() / (1024 * 1024)); } catch (_) {}
    if (this.lastRequestAt) d.sinceLastRequestS = Math.round((this.now() - this.lastRequestAt) / 1000);
    if (this.diagFn) {
      try { const x = this.diagFn() || {}; d = Object.assign(d, x); } catch (_) {}
    }
    return Object.assign(d, extra || {});
  }

  noteRequest(atMs) { // P62-B3: appele a chaque requete recue
    this.lastRequestAt = Number(atMs) || this.now();
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

  // P69-B5: le battement de coeur repond meme pendant une generation. Il est
  // la seule source qui distingue "occupe" de "mort".
  async probeHeartbeat(timeoutMs) {
    try {
      const r = await this.httpGet(this.heartbeatUrl + '/hb', timeoutMs || 1500);
      if (r && r.status === 200 && r.data && r.data.alive) return { alive: true, data: r.data };
      return { alive: false, data: (r && r.data) || null, why: 'status ' + (r && r.status) };
    } catch (e) {
      return { alive: false, data: null, why: ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e)) };
    }
  }

  async pollTick() {
    if (!this.running || this.restarting) return;
    // 1) le battement de coeur : vivant, meme si la generation occupe tout ?
    const hb = await this.probeHeartbeat();
    if (hb.alive) {
      if (hb.data && hb.data.busy) {
        // OCCUPE : ce n'est pas une panne. On ne relance JAMAIS un runtime vivant.
        this.lastBusyAt = this.now();
        this.lastBusy = { phase: hb.data.phase, call: hb.data.call || null, at: new Date(this.now()).toISOString() };
        this.consecutiveFailures = 0;
        this.lastOk = true;
        this.lastError = null;
        this.everHealthy = true;
        return;
      }
      // Vivant et libre : on confirme quand meme /health (etat du modele).
    }
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
        let reason;
        if (hb.alive) {
          // Le battement de coeur repond mais /health non : processus vivant,
          // serveur principal bloque. C'est un blocage, pas une mort.
          reason = 'heartbeat alive but /health failing x' + n + ' (' + this.lastError + ')';
        } else if (e && e.code === 'ECONNREFUSED') {
          reason = 'health refused x' + n + ' (process exited: ' + this.describeExit() + ')';
        } else {
          reason = 'health failing x' + n + ' (' + this.lastError + ')';
        }
        this.tlog('warn', 'runtime unhealthy (stop detected)', { reason, consecutiveFailures: n, lastError: this.lastError });
        await this.maybeRestart(reason);
      }
    }
  }

  // P69-A1: ce que le parent sait de la mort de l'enfant.
  describeExit() {
    if (!this.childExit) return 'code inconnu (processus lance hors superviseur)';
    const x = this.childExit;
    let s2 = 'exit=' + (x.code === null || x.code === undefined ? 'null' : x.code);
    if (x.signal) s2 += ' signal=' + x.signal;
    if (typeof x.code === 'number') {
      s2 += ' (0x' + (x.code >>> 0).toString(16).toUpperCase() + ')';
      if ((x.code >>> 0) === 0xC0000005) s2 += ' ACCESS_VIOLATION';
      if ((x.code >>> 0) === 0xC0000409) s2 += ' STACK_BUFFER_OVERRUN';
      if ((x.code >>> 0) === 0xC000001D) s2 += ' ILLEGAL_INSTRUCTION';
    }
    return s2;
  }

  // Le dernier appel laisse par le runtime (last_call.json) : la preuve de ce
  // qui tournait au moment du plantage.
  readLastCall() {
    try { return JSON.parse(fs.readFileSync(this.lastCallPath, 'utf8')); } catch (_) { return null; }
  }

  // Dernieres lignes du fichier de crash natif (faulthandler).
  tailCrashLog(maxLines) {
    try {
      const txt = fs.readFileSync(this.crashLogPath, 'utf8');
      const lines = txt.trim().split(/\r?\n/);
      return lines.slice(-(maxLines || 12));
    } catch (_) { return null; }
  }

  crashContext() {
    let ramFreeMB = null;
    try { ramFreeMB = Math.round(os.freemem() / (1024 * 1024)); } catch (_) {}
    return {
      exit: this.describeExit(),
      childExit: this.childExit,
      ramFreeMB,
      lastCall: this.readLastCall(),
      crashTail: this.tailCrashLog(12),
    };
  }

  async maybeRestart(reason, opts) {
    // P48(4): an explicit "Restart now" (manual) bypasses the boot grace
    // (the user asked); the 10-minute restart cap still applies (safety).
    const manual = !!(opts && opts.manual);
    const nowTs = this.now();
    if (!manual && nowTs - this.startedAt < this.graceMs) {
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
    // P62-B3: la CAUSE est journalisee avec la RAM libre et le temps depuis
    // la derniere requete (une veille ressemble a un long silence).
    const dg = this.diag({ attempt: attemptNo });
    // P69-A1: la medecine legale avant toute relance (code de sortie, RAM,
    // appel en cours, fin du fichier de crash). Aucun secret, aucun jeton.
    const cx = this.crashContext();
    const cxLine = 'crash ctx: ' + cx.exit + ' ram_free_mb=' + cx.ramFreeMB +
      ' last_call=' + (cx.lastCall ? JSON.stringify(cx.lastCall) : 'aucun');
    this.audit(cxLine);
    this.tlog('error', 'crash context', {
      exit: cx.exit, ramLibreMo: cx.ramFreeMB, dernierAppel: cx.lastCall || null,
      finDuFichierDeCrash: cx.crashTail || null,
    });
    this.audit('RESTART attempt#' + attemptNo + ' in window, backoff=' + backoff +
      'ms, reason=' + reason + ' ram_free_mb=' + dg.ramFreeMB +
      ' since_last_req_s=' + dg.sinceLastRequestS);
    this.tlog('warn', 'restart attempt', { attempt: attemptNo, backoffMs: backoff, reason,
      ramLibreMo: dg.ramFreeMB, secondesDepuisDerniereRequete: dg.sinceLastRequestS,
      veille: dg.suspend || null });
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
        const t0 = this.now();
        const child = this.spawnFn(this.runtimeExePath);
        this.childExit = null;
        if (child && typeof child.on === 'function') {
          this.child = child;
          child.on('exit', (code, signal) => {
            this.childExit = { code, signal, atIso: new Date(this.now()).toISOString(),
              uptimeMs: this.now() - t0 };
            this.audit('CHILD EXIT ' + this.describeExit() + ' afterMs=' + (this.now() - t0) +
              ' last_call=' + (this.readLastCall() ? 'present' : 'none'));
            this.tlog('error', 'runtime child exited', {
              exit: this.describeExit(), code, signal, uptimeMs: this.now() - t0,
              dernierAppel: this.readLastCall() || null,
            });
          });
        }
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
    const restartMs = this.now() - nowTs;
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
      ' reason=' + reason + ' detail=' + detail + ' duration_ms=' + restartMs);
    const dg2 = this.diag();
    this.tlog(ok ? 'info' : 'error', 'restart done', { ok, reason, detail, dureeMs: restartMs,
      ramLibreMo: dg2.ramFreeMB, secondesDepuisDerniereRequete: dg2.sinceLastRequestS,
      killResult: killResult === null || killResult === undefined ? null : String(killResult).slice(0, 200),
      spawnOk, exitCode, codeDeSortie: this.describeExit() });
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
      busy: this.lastBusy || null,
      childExit: this.childExit,
      heartbeatUrl: this.heartbeatUrl,
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
  resolveLogDir,
  toHHMM,
};
