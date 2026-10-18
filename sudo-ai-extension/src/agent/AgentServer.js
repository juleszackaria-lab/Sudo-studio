// AgentServer (P24): spawns and supervises the sudo-agent core server.
// Runtime (MINI node): the product executable itself in Electron-as-Node mode
// (ELECTRON_RUN_AS_NODE=1) - never the PC's Node.js, no second Node bundled.
// Hidden window (windowsHide), token + provider config via ENVIRONMENT only
// (never the command line), handshake on stdout, auto-restart with backoff.
// No vscode dependency: pure Node, unit-testable. ASCII only.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';

function defaultServerJs() {
  // P29(f) CANONICAL agent server path (single source of truth):
  //   dev      : <repo>/sudo-agent/src/server.js
  //   installed: {install}\extensions\sudo-agent\src\server.js
  // (__dirname = .../sudo-ai/src/agent, so up3 = the dir CONTAINING sudo-ai.)
  // The packager MUST copy sudo-agent/src to extensions\sudo-agent\src
  // (NOT to the install root). The smoke test asserts this exact file.
  return path.resolve(__dirname, '..', '..', '..', 'sudo-agent', 'src', 'server.js');
}

function defaultExe() {
  // Packaged layout (bundled later by packaging): <extension>/sudo-agent/sudo-agent.exe
  return path.resolve(__dirname, '..', '..', 'sudo-agent', 'sudo-agent.exe');
}

function safeLogger(l) {
  if (l && typeof l.info === 'function' && typeof l.warn === 'function' && typeof l.error === 'function') return l;
  return { info() {}, warn() {}, error() {} };
}

class AgentServer {
  constructor(opts) {
    opts = opts || {};
    if (!opts.provider || typeof opts.provider !== 'object') throw new Error('AgentServer: provider config required');
    this.provider = opts.provider;
    this.serverPath = opts.serverPath || null;
    this.useNode = opts.useNode;
    // MINI node: an explicit runtime, else SUDO_AGENT_NODE, else the host
    // binary itself (process.execPath). Under a real extension host that is
    // the product .exe, run with ELECTRON_RUN_AS_NODE=1 (see _spawnOnce);
    // under plain node (dev scripts, tests) it is node and the flag is a
    // harmless no-op. The PC's PATH 'node' is never used by default.
    this.nodePath = opts.nodePath || process.env.SUDO_AGENT_NODE || process.execPath;
    this.lastError = null; // last start failure (for the status bar), cleared on success
    this.extraArgs = Array.isArray(opts.args) ? opts.args.slice() : [];
    this.home = opts.home || null;
    this.logsDir = opts.logsDir || null;
    this.storeDir = opts.storeDir || null;
    this.version = opts.version || null;
    this.spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
    this.log = safeLogger(opts.logger);
    this.backoffBaseMs = opts.backoffBaseMs || 1000;
    this.backoffMaxMs = opts.backoffMaxMs || 30000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs || 15000;
    this.killTimeoutMs = opts.killTimeoutMs || 5000;
    this.child = null;
    this.token = null;
    this.port = null;
    this.pid = null;
    this.stopped = false;
    this.attempts = 0;
    this.restartTimer = null;
    this._lastSpawn = null; // { cmd, args, windowsHide } - memory only, never logged
    this.startup = null;
  }

  resolveTarget() {
    let sp = this.serverPath;
    if (!sp) {
      try { sp = fs.existsSync(defaultExe()) ? defaultExe() : defaultServerJs(); }
      catch (_) { sp = defaultServerJs(); }
    }
    const wantNode = this.useNode === true || (this.useNode !== false && /\.js$/i.test(sp));
    if (wantNode) return { cmd: this.nodePath, args: [sp].concat(this.extraArgs), mode: 'node', runAsNode: true };
    return { cmd: sp, args: this.extraArgs.slice(), mode: 'exe' };
  }

  get started() { return !!this.child && !!this.port; }

  start() {
    if (this.child) return Promise.resolve({ port: this.port, pid: this.pid });
    if (this.startup) return this.startup;
    this.stopped = false;
    this.startup = this._spawnOnce().then(
      (r) => { this.startup = null; this.attempts = 0; this.lastError = null; return r; },
      (e) => {
        this.startup = null;
        this.lastError = String((e && e.message) || e);
        try { this.log.error('agent server start failed: ' + this.lastError); } catch (_) {}
        this._scheduleRestart('start-failed');
        throw e;
      }
    );
    return this.startup;
  }

  // Observable state for the status bar (P27): ready / starting / error+reason.
  state() {
    if (this.started) return { status: 'ready', detail: 'port ' + this.port };
    if (this.startup) return { status: 'starting', detail: 'attempt #' + (this.attempts + 1) };
    if (this.stopped) return { status: 'stopped', detail: '' };
    if (this.lastError) return { status: 'error', detail: this.lastError };
    return { status: 'starting', detail: 'not started yet' };
  }

  _spawnOnce() {
    return new Promise((resolve, reject) => {
      let target = null;
      try { target = this.resolveTarget(); } catch (e) { reject(e); return; }
      const token = crypto.randomBytes(32).toString('hex');
      const env = Object.assign({}, process.env, {
        SUDO_AGENT_TOKEN: token,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify(this.provider),
      });
      if (target.runAsNode) {
        // Electron-as-Node mode: drop editor-inherited ELECTRON_* (except the
        // flag we set) and NODE_OPTIONS, which could inject flags into the
        // agent. PATH/SystemRoot/TEMP and the rest are kept: agent tools and
        // the verify loop need them, and Windows children need SystemRoot.
        for (const k of Object.keys(env)) {
          if (k === 'ELECTRON_RUN_AS_NODE') continue;
          if (/^ELECTRON_/i.test(k) || k === 'NODE_OPTIONS') delete env[k];
        }
        env.ELECTRON_RUN_AS_NODE = '1';
      }
      if (this.home) env.SUDO_STUDIO_HOME = this.home;
      if (this.logsDir) env.SUDO_STUDIO_LOGS = this.logsDir;
      if (this.storeDir) env.SUDO_AGENT_STORE = this.storeDir;
      if (this.version) env.SUDO_AGENT_VERSION = this.version;
      const spawnOpts = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env };
      this._lastSpawn = { cmd: target.cmd, args: target.args.slice(), windowsHide: true };
      let child = null;
      try { child = this.spawnFn(target.cmd, target.args, spawnOpts); } catch (e) { reject(e); return; }
      if (!child || !child.stdout) { reject(new Error('spawn failed (no child process)')); return; }

      let out = '';
      let errText = '';
      let settled = false;
      const fail = (msg) => {
        if (settled) return; settled = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        reject(new Error(msg));
      };
      const timer = setTimeout(() => {
        fail('agent server handshake timeout (' + this.handshakeTimeoutMs + 'ms)' + (errText ? ' stderr: ' + errText.slice(-300) : ''));
      }, this.handshakeTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      child.stdout.on('data', (c) => {
        if (settled) return;
        out += c.toString('utf8');
        const nl = out.indexOf('\n');
        if (nl === -1) return;
        settled = true;
        clearTimeout(timer);
        let hs = null;
        try { hs = JSON.parse(out.slice(0, nl).trim()); } catch (_) { hs = null; }
        if (!hs || hs.ready !== true || !hs.port) {
          try { child.kill('SIGTERM'); } catch (_) {}
          reject(new Error('agent server bad handshake'));
          return;
        }
        this.child = child;
        this.token = token;
        this.port = hs.port;
        this.pid = hs.pid || child.pid || null;
        try { this.log.info('agent server started (port ' + hs.port + ', pid ' + this.pid + ')'); } catch (_) {}
        child.on('exit', (code, signal) => this._onExit(code, signal));
        child.stderr.on('data', (cc) => {
          const t = cc.toString('utf8').trim();
          if (t) { try { this.log.warn('agent server stderr: ' + t.slice(0, 300)); } catch (_) {} }
        });
        resolve({ port: this.port, pid: this.pid });
      });
      child.stderr.on('data', (c) => { errText += c.toString('utf8'); if (errText.length > 2048) errText = errText.slice(-2048); });
      child.on('error', (e) => fail('agent server spawn error: ' + String((e && e.message) || e)));
      child.on('exit', (code) => { if (!settled) fail('agent server exited during handshake (code ' + code + ')' + (errText ? ' stderr: ' + errText.slice(-300) : '')); });
    });
  }

  _onExit(code, signal) {
    const was = { port: this.port, pid: this.pid };
    this.child = null; this.token = null; this.port = null; this.pid = null;
    try { this.log.warn('agent server exited (code ' + code + ' signal ' + signal + ' port ' + was.port + ')'); } catch (_) {}
    if (this.stopped) return;
    this._scheduleRestart('exit');
  }

  _scheduleRestart(reason) {
    if (this.stopped) return;
    if (this.restartTimer) return;
    this.attempts += 1;
    const delay = Math.min(this.backoffBaseMs * Math.pow(2, this.attempts - 1), this.backoffMaxMs);
    try { this.log.warn('agent server restart #' + this.attempts + ' in ' + delay + 'ms (' + reason + ')'); } catch (_) {}
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.start().catch(() => {});
    }, delay);
    if (this.restartTimer && typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) { try { clearTimeout(this.restartTimer); } catch (_) {} this.restartTimer = null; }
    const child = this.child;
    this.child = null; this.token = null; this.port = null; this.pid = null;
    if (!child) return;
    try { this.log.info('agent server stopping'); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, this.killTimeoutMs);
  }

  _checkStarted() {
    if (!this.child || !this.port || !this.token) throw new Error('agent server not started');
  }

  request(pathname, opts) {
    opts = opts || {};
    this._checkStarted();
    const method = opts.method || 'GET';
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const timeoutMs = opts.timeoutMs || 30000;
    const port = this.port;
    const token = this.token;
    return new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port, path: pathname, method, timeout: timeoutMs,
        headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) { try { res.destroy(); } catch (_) {} } });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { _raw: raw.slice(0, 500) }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // SSE client for POST /sessions/:id/messages. Resolves on turn.done,
  // rejects on turn.error / HTTP error / timeout.
  stream(pathname, body, onEvent, opts) {
    opts = opts || {};
    this._checkStarted();
    const timeoutMs = opts.timeoutMs || 120000;
    const port = this.port;
    const token = this.token;
    const payload = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
      let done = false;
      const win = (r) => { if (!done) { done = true; resolve(r); } };
      const fail = (e) => { if (!done) { done = true; reject(e); } };
      const req = http.request({ host: HOST, port, path: pathname, method: 'POST', timeout: timeoutMs,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = { error: raw.slice(0, 300) }; }
            const e = new Error((parsed && parsed.error) || ('HTTP ' + res.statusCode));
            e.code = parsed && parsed.code;
            e.status = res.statusCode;
            fail(e);
          });
          return;
        }
        let buf = '';
        let curEvent = 'message';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line.startsWith('event:')) { curEvent = line.slice(6).trim() || 'message'; continue; }
            if (!line.startsWith('data:')) continue;
            let obj = null;
            try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            try { if (onEvent) onEvent(curEvent, obj); } catch (_) {}
            if (curEvent === 'turn.done') { win(obj); try { res.destroy(); } catch (_) {} return; }
            if (curEvent === 'turn.error') {
              const e = new Error((obj && obj.error) || 'turn error');
              e.code = obj && obj.code;
              fail(e);
              try { res.destroy(); } catch (_) {}
              return;
            }
            curEvent = 'message';
          }
        });
        res.on('end', () => fail(new Error('stream ended without turn.done')));
        res.on('error', fail);
      });
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
      req.on('error', fail);
      req.write(payload);
      req.end();
    });
  }

  // Fire-and-forget launch for extension activation: returns the instance
  // immediately; failures are journaled, never thrown to the caller.
  static launch(opts) {
    const inst = new AgentServer(opts);
    inst.startup = inst.start().catch(() => {});
    return inst;
  }
}

module.exports = { AgentServer, HOST, defaultServerJs, defaultExe };
