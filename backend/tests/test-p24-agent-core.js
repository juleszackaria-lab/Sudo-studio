// P24 Sudo Agent core: package, server, journal, registry, providers, launcher.
// Hermetic: loopback only, temp dirs, mocked providers. ASCII only.
// NOTE: the forbidden-brand needle is built dynamically ('open'+'code') so
// this spec file itself stays clean and can be included in the scan.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_DIR = path.join(ROOT, 'sudo-agent');
const SERVER_JS = path.join(AGENT_DIR, 'src', 'server.js');
const LAUNCHER_JS = path.join(ROOT, 'sudo-ai-extension', 'src', 'agent', 'AgentServer.js');
const EXT_JS = path.join(ROOT, 'sudo-ai-extension', 'extension.js');
const PROV_SVC_JS = path.join(ROOT, 'sudo-ai-extension', 'src', 'services', 'AIProviderService.js');

const NEEDLE = 'open' + 'code'; // forbidden brand, any case
const HOST = '127.0.0.1';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p24-'));
const children = [];

function tmp(sub) {
  const d = path.join(TMP, sub + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

function track(child) { children.push(child); return child; }
function killChild(child, sig) {
  try { if (child && child.exitCode === null) child.kill(sig || 'SIGKILL'); } catch (_) {}
}

// -- HTTP helpers ------------------------------------------------------------
function httpJson(port, token, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, path: p, method, timeout: timeoutMs || 15000,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { _raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function ssePost(port, token, p, body, onEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const win = (r) => { if (!done) { done = true; resolve(r); } };
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: HOST, port, path: p, method: 'POST', timeout: timeoutMs || 60000,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = { error: raw.slice(0, 200) }; }
          const e = new Error('HTTP ' + res.statusCode + ': ' + ((parsed && parsed.error) || '?'));
          e.status = res.statusCode; e.body = parsed;
          fail(e);
        });
        return;
      }
      let buf = '';
      let cur = 'message';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (line.startsWith('event:')) { cur = line.slice(6).trim() || 'message'; continue; }
          if (!line.startsWith('data:')) continue;
          let obj = null;
          try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          try { onEvent(cur, obj); } catch (_) {}
          if (cur === 'turn.done') { win(obj); try { res.destroy(); } catch (_) {} return; }
          if (cur === 'turn.error') { fail(new Error('turn.error: ' + ((obj && obj.error) || '?'))); try { res.destroy(); } catch (_) {} return; }
          cur = 'message';
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

// -- mock OpenAI-compatible provider ------------------------------------------
function mockProvider(opts) {
  opts = opts || {};
  const chats = [];
  const models = opts.models !== undefined ? opts.models : [{ id: 'mock-model' }];
  const chunks = opts.chunks || ['Hello ', 'world'];
  const chunkDelay = opts.chunkDelay || 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      if (opts.modelsStatus) { res.writeHead(opts.modelsStatus, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      const body = JSON.stringify(typeof models === 'function' ? models() : { data: models });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { chats.push(JSON.parse(raw)); } catch (_) { chats.push({ _raw: raw }); }
        const list = typeof chunks === 'function' ? chunks(chats.length) : chunks;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let i = 0;
        const next = () => {
          if (i < list.length) {
            const ev = JSON.stringify({ choices: [{ delta: { content: list[i] } }] });
            try { res.write('data: ' + ev + '\n\n'); } catch (_) {}
            i += 1;
            if (chunkDelay) setTimeout(next, chunkDelay);
            else next();
          } else {
            try { res.write('data: [DONE]\n\n'); } catch (_) {}
            try { res.end(); } catch (_) {}
          }
        };
        next();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, HOST, () => {
      const port = srv.address().port;
      resolve({ server: srv, port, url: 'http://' + HOST + ':' + port, chats,
        close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// -- agent server spawner ------------------------------------------------------
function spawnAgent(opts) {
  opts = opts || {};
  const token = opts.token || crypto.randomBytes(32).toString('hex');
  const logsDir = opts.logsDir || tmp('logs');
  const storeDir = opts.storeDir || tmp('store');
  const provider = opts.provider !== undefined ? opts.provider : { type: 'local', baseUrl: 'http://' + HOST + ':6000', model: '' };
  const env = Object.assign({}, process.env, {
    SUDO_AGENT_TOKEN: token,
    SUDO_AGENT_PORT: '0',
    SUDO_AGENT_PROVIDER: JSON.stringify(provider),
    SUDO_STUDIO_HOME: opts.home || tmp('home'),
    SUDO_STUDIO_LOGS: logsDir,
    SUDO_AGENT_STORE: storeDir,
  });
  if (opts.noToken) delete env.SUDO_AGENT_TOKEN;
  const child = track(spawn(process.execPath, [SERVER_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  return { child, token, logsDir, storeDir, env };
}

function waitHandshake(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let errText = '';
    const timer = setTimeout(() => reject(new Error('handshake timeout. stderr: ' + errText.slice(-300))), timeoutMs || 10000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl).trim())); }
      catch (e) { reject(new Error('bad handshake: ' + out.slice(0, 200))); }
    });
    child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
    child.on('exit', (code) => reject(new Error('exited during handshake (code ' + code + '). stderr: ' + errText.slice(-300))));
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const timer = setTimeout(() => reject(new Error('exit timeout')), timeoutMs || 8000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

// -- tests ---------------------------------------------------------------------
const tests = [];
function t(id, name, fn) { tests.push({ id, name, fn }); }

// A: package shape (static) -----------------------------------------------------
t('A1', 'package zero dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'package.json'), 'utf8'));
  assert(pkg.name === 'sudo-agent', 'name');
  assert(pkg.dependencies && Object.keys(pkg.dependencies).length === 0, 'runtime deps must be empty');
  assert(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, 'dev deps must be empty');
});

t('A2', 'pkg chain identical to backend (node18-win-x64)', () => {
  const a = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'package.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'package.json'), 'utf8'));
  assert(a.pkg && b.pkg, 'pkg blocks');
  assert(JSON.stringify(a.pkg.targets) === JSON.stringify(b.pkg.targets), 'targets differ: ' + JSON.stringify(a.pkg.targets));
  assert(a.pkg.targets.indexOf('node18-win-x64') !== -1, 'missing node18-win-x64');
});

t('A3', 'package files present', () => {
  const files = ['package.json', 'THIRD_PARTY_NOTICES.md', 'README.md', 'src/journal.js', 'src/store.js',
    'src/registry.js', 'src/providers.js', 'src/loop.js', 'src/server.js'];
  for (const f of files) assert(fs.existsSync(path.join(AGENT_DIR, f)), 'missing ' + f);
  assert(fs.existsSync(LAUNCHER_JS), 'missing AgentServer.js');
});

t('A4', 'forbidden brand absent except THIRD_PARTY_NOTICES (+ this spec)', () => {
  const re = new RegExp(NEEDLE, 'i');
  const hits = [];
  const scanFile = (f) => {
    const content = fs.readFileSync(f, 'utf8');
    if (re.test(content)) hits.push(path.relative(ROOT, f));
  };
  const walk = (d) => {
    for (const e of fs.readdirSync(d)) {
      const f = path.join(d, e);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else if (f !== path.join(AGENT_DIR, 'THIRD_PARTY_NOTICES.md')) scanFile(f);
    }
  };
  walk(AGENT_DIR);
  scanFile(LAUNCHER_JS);
  scanFile(PROV_SVC_JS);
  scanFile(EXT_JS);
  scanFile(__filename);
  assert(hits.length === 0, 'brand found in: ' + hits.join(', '));
});

t('A5', 'THIRD_PARTY_NOTICES attributes MIT reference', () => {
  const s = fs.readFileSync(path.join(AGENT_DIR, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert(/MIT/.test(s), 'MIT missing');
  assert(new RegExp('Copyright \\(c\\) 2025 ' + NEEDLE, 'i').test(s), 'copyright line missing');
  assert(/No .* source file was copied|no code reused/i.test(s), 'no-reuse statement missing');
});

t('A6', 'new sources are ASCII-only', () => {
  const files = ['src/journal.js', 'src/store.js', 'src/registry.js', 'src/providers.js', 'src/loop.js', 'src/server.js']
    .map((f) => path.join(AGENT_DIR, f)).concat([LAUNCHER_JS]);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    for (let i = 0; i < buf.length; i++) assert(buf[i] < 128, 'non-ASCII byte in ' + path.basename(f) + ' @' + i);
  }
});

t('A7', 'extension wiring present (launch + stop + provider config)', () => {
  const ext = fs.readFileSync(EXT_JS, 'utf8');
  assert(ext.indexOf('AgentServer.launch') !== -1, 'launch wiring missing');
  assert(ext.indexOf('agentServer.stop()') !== -1, 'stop wiring missing');
  assert(ext.indexOf('getServerProviderConfig') !== -1, 'provider config wiring missing');
  const svc = fs.readFileSync(PROV_SVC_JS, 'utf8');
  assert(svc.indexOf('async getServerProviderConfig') !== -1, 'service method missing');
});

t('A8', 'requires are stdlib-only (no third-party code to attribute)', () => {
  const Module = require('module');
  const builtin = new Set(Module.builtinModules.map((m) => m.replace(/^node:/, '')));
  const files = ['src/journal.js', 'src/store.js', 'src/registry.js', 'src/providers.js', 'src/loop.js', 'src/server.js']
    .map((f) => path.join(AGENT_DIR, f));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const target = m[1];
      if (target.startsWith('.')) continue; // relative: our own modules
      assert(builtin.has(target.replace(/^node:/, '')), 'non-stdlib require in ' + path.basename(f) + ': ' + target);
    }
  }
  assert(!fs.existsSync(path.join(AGENT_DIR, 'node_modules')), 'node_modules must not exist');
});

// B: boot + auth ------------------------------------------------------------------
t('B1', 'boots: handshake on stdout, loopback ephemeral port', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    assert(hs.ready === true, 'ready flag');
    assert(hs.host === HOST, 'host must be 127.0.0.1, got ' + hs.host);
    assert(Number.isInteger(hs.port) && hs.port > 0, 'port');
    assert(hs.pid > 0, 'pid');
  } finally { killChild(a.child); }
});

t('B2', 'auth required on /health (none + wrong token => 401)', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    const r1 = await new Promise((resolve, reject) => {
      http.get({ host: HOST, port: hs.port, path: '/health', timeout: 5000 }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });
    assert(r1.status === 401, 'no-auth got ' + r1.status);
    const r2 = await httpJson(hs.port, 'wrong-token-value-0000000000000000', 'GET', '/health');
    assert(r2.status === 401, 'wrong-token got ' + r2.status);
  } finally { killChild(a.child); }
});

t('B3', 'authed /health shape, no secrets', async () => {
  const a = spawnAgent({ provider: { type: 'local', baseUrl: 'http://' + HOST + ':6000', model: '' } });
  try {
    const hs = await waitHandshake(a.child);
    const r = await httpJson(hs.port, a.token, 'GET', '/health');
    assert(r.status === 200, 'status ' + r.status);
    assert(r.body.ok === true && typeof r.body.version === 'string', 'shape');
    assert(typeof r.body.uptimeSec === 'number' && typeof r.body.sessions === 'number', 'counters');
    assert(r.body.provider && r.body.provider.configured === true && r.body.provider.type === 'local', 'provider block');
    assert(JSON.stringify(r.body).indexOf('apiKey') === -1, 'apiKey leaked');
    assert(JSON.stringify(r.body).indexOf(a.token) === -1, 'token leaked');
  } finally { killChild(a.child); }
});

t('B4', 'refuses to boot without token (fail closed)', async () => {
  const a = spawnAgent({ noToken: true });
  try {
    const code = await waitExit(a.child, 8000);
    assert(code === 2, 'exit code ' + code);
  } finally { killChild(a.child); }
});

// C: sessions -----------------------------------------------------------------------
t('C1', 'create session: 201 + file outside project', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    const r = await httpJson(hs.port, a.token, 'POST', '/sessions', { title: 'hello' });
    assert(r.status === 201, 'status ' + r.status);
    assert(/^[0-9a-f]{16}$/.test(r.body.id), 'id shape');
    assert(r.body.title === 'hello', 'title');
    const f = path.join(a.storeDir, r.body.id + '.json');
    assert(fs.existsSync(f), 'session file missing');
  } finally { killChild(a.child); }
});

t('C2', 'list + resume full session', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', { title: 'resume-me' });
    const l = await httpJson(hs.port, a.token, 'GET', '/sessions');
    assert(l.status === 200 && l.body.sessions.length === 1 && l.body.sessions[0].id === c.body.id, 'list');
    const g = await httpJson(hs.port, a.token, 'GET', '/sessions/' + c.body.id);
    assert(g.status === 200 && g.body.title === 'resume-me' && Array.isArray(g.body.messages), 'resume');
  } finally { killChild(a.child); }
});

t('C3', 'unknown session 404; delete removes', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    const g = await httpJson(hs.port, a.token, 'GET', '/sessions/aaaaaaaaaaaaaaaa');
    assert(g.status === 404, 'get unknown: ' + g.status);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    const d = await httpJson(hs.port, a.token, 'DELETE', '/sessions/' + c.body.id);
    assert(d.status === 200 && d.body.removed === true, 'delete');
    const g2 = await httpJson(hs.port, a.token, 'GET', '/sessions/' + c.body.id);
    assert(g2.status === 404, 'get after delete: ' + g2.status);
  } finally { killChild(a.child); }
});

t('C4', 'projectRoot is metadata: project dir untouched', async () => {
  const a = spawnAgent({});
  const proj = tmp('proj');
  fs.writeFileSync(path.join(proj, 'marker.txt'), 'x', 'utf8');
  try {
    const hs = await waitHandshake(a.child);
    const r = await httpJson(hs.port, a.token, 'POST', '/sessions', { title: 't', projectRoot: proj });
    assert(r.status === 201, 'create ' + r.status);
    assert(r.body.projectRoot === proj, 'meta stored');
    const left = fs.readdirSync(proj);
    assert(left.length === 1 && left[0] === 'marker.txt', 'project polluted: ' + left.join(','));
  } finally { killChild(a.child); }
});

// D: streaming vs mock provider ---------------------------------------------------------
t('D1', 'message streams SSE turn events, full text assembled', async () => {
  const mock = await mockProvider({});
  const a = spawnAgent({ provider: { type: 'local', baseUrl: mock.url, model: '' } });
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    const seen = [];
    let full = '';
    const done = await ssePost(hs.port, a.token, '/sessions/' + c.body.id + '/messages', { prompt: 'say hi' },
      (ev, obj) => { seen.push(ev); if (ev === 'message.delta') full += obj.text; if (ev === 'message.done') full = obj.text; });
    assert(seen[0] === 'turn.start', 'first event ' + seen[0]);
    assert(seen.indexOf('message.delta') !== -1, 'no deltas: ' + seen.join(','));
    assert(seen.indexOf('message.done') !== -1 && done.aborted === false, 'done flags');
    assert(full === 'Hello world', 'assembled text: ' + JSON.stringify(full));
  } finally { killChild(a.child); await mock.close(); }
});

t('D2', 'history persists and resumes across turns', async () => {
  const mock = await mockProvider({});
  const a = spawnAgent({ provider: { type: 'local', baseUrl: mock.url, model: 'mock-model' } });
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    const id = c.body.id;
    await ssePost(hs.port, a.token, '/sessions/' + id + '/messages', { prompt: 'one' }, () => {});
    await ssePost(hs.port, a.token, '/sessions/' + id + '/messages', { prompt: 'two' }, () => {});
    assert(mock.chats.length === 2, 'chat calls ' + mock.chats.length);
    assert(mock.chats[1].messages.length === 3, '2nd call history ' + mock.chats[1].messages.length);
    assert(mock.chats[1].messages[1].role === 'assistant' && mock.chats[1].messages[1].content === 'Hello world', 'assistant persisted');
    const g = await httpJson(hs.port, a.token, 'GET', '/sessions/' + id);
    assert(g.body.messages.length === 4, 'stored messages ' + g.body.messages.length);
  } finally { killChild(a.child); await mock.close(); }
});

t('D3', 'cloud key never exposed (endpoints + journal)', async () => {
  const mock = await mockProvider({});
  const canary = 'P24CLOUDKEY9f8e7d6c5b4a3d2e1f00';
  const a = spawnAgent({ provider: { type: 'cloud', baseUrl: mock.url, model: 'mock-model', apiKey: canary } });
  try {
    const hs = await waitHandshake(a.child);
    const h = await httpJson(hs.port, a.token, 'GET', '/health');
    assert(JSON.stringify(h.body).indexOf(canary) === -1, 'canary in /health');
    const p = await httpJson(hs.port, a.token, 'GET', '/providers');
    assert(p.status === 200 && JSON.stringify(p.body).indexOf(canary) === -1, 'canary in /providers');
    assert(p.body.providers[0].type === 'cloud' && !('apiKey' in p.body.providers[0]), 'apiKey field present');
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    await ssePost(hs.port, a.token, '/sessions/' + c.body.id + '/messages', { prompt: 'hi' }, () => {});
    const log = fs.readFileSync(path.join(a.logsDir, 'agent.log'), 'utf8');
    const jsonl = fs.readFileSync(path.join(a.logsDir, 'agent.jsonl'), 'utf8');
    assert(log.indexOf(canary) === -1 && jsonl.indexOf(canary) === -1, 'canary in journal');
    assert(log.indexOf(a.token) === -1 && jsonl.indexOf(a.token) === -1, 'token in journal');
  } finally { killChild(a.child); await mock.close(); }
});

// E: abort ------------------------------------------------------------------------------
t('E1', 'abort mid-stream: flag + partial persisted', async () => {
  const mock = await mockProvider({ chunks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], chunkDelay: 250 });
  const a = spawnAgent({ provider: { type: 'local', baseUrl: mock.url, model: '' } });
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    const id = c.body.id;
    let partial = '';
    const streamP = ssePost(hs.port, a.token, '/sessions/' + id + '/messages', { prompt: 'long' },
      (ev, obj) => { if (ev === 'message.delta') partial += obj.text; if (ev === 'message.done') partial = obj.text; });
    await sleep(700);
    const ab = await httpJson(hs.port, a.token, 'POST', '/sessions/' + id + '/abort');
    assert(ab.status === 200 && ab.body.aborted === true, 'abort reply');
    const done = await streamP;
    assert(done.aborted === true, 'done.aborted');
    assert(partial.length > 0 && partial.length < 8, 'partial: ' + JSON.stringify(partial));
    const g = await httpJson(hs.port, a.token, 'GET', '/sessions/' + id);
    const last = g.body.messages[g.body.messages.length - 1];
    assert(last.role === 'assistant' && last.aborted === true, 'persisted abort flag');
  } finally { killChild(a.child); await mock.close(); }
});

// F: offline / no model ---------------------------------------------------------------------
function isRefused(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(false));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.on('error', (e) => resolve(!!(e && (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH'))));
  });
}

t('F1', 'runtime offline: immediate clear 502 (<5s), never fake success', async () => {
  // The "dead" port must really be dead: ephemeral reuse could hand it to our
  // own server or a leftover. Verify, retry with a fresh port if taken.
  let a = null;
  let hs = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dead = await closedPort();
    a = spawnAgent({ provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + dead, model: '' } });
    try {
      hs = await waitHandshake(a.child);
    } catch (e) { killChild(a.child); throw e; }
    if (hs.port !== dead) {
      try {
        if (await isRefused(dead)) break;
      } catch (_) {}
    }
    killChild(a.child);
    a = null; hs = null;
    if (attempt === 3) throw new Error('no dead port after 3 attempts');
  }
  try {
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    const t0 = Date.now();
    let err = null;
    try {
      await ssePost(hs.port, a.token, '/sessions/' + c.body.id + '/messages', { prompt: 'hi' }, () => {});
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    assert(err && err.status === 502, 'expected 502, got ' + (err && err.status));
    assert(/hors ligne|injoignable/.test(err.body.error), 'unclear error: ' + err.body.error);
    assert(ms < 5000, 'too slow: ' + ms + 'ms');
    const g = await httpJson(hs.port, a.token, 'GET', '/sessions/' + c.body.id);
    assert(g.body.messages.length === 0, 'fake message persisted');
  } finally { killChild(a.child); }
});

t('F2', 'empty model list: clear no-model 502', async () => {
  const mock = await mockProvider({ models: [] });
  const a = spawnAgent({ provider: { type: 'local', baseUrl: mock.url, model: '' } });
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    let err = null;
    try {
      await ssePost(hs.port, a.token, '/sessions/' + c.body.id + '/messages', { prompt: 'hi' }, () => {});
    } catch (e) { err = e; }
    assert(err && err.status === 502, 'expected 502, got ' + (err && err.status));
    assert(err.body.code === 'no_model', 'code ' + err.body.code);
    assert(/Aucun modele/.test(err.body.error), 'message: ' + err.body.error);
  } finally { killChild(a.child); await mock.close(); }
});

// G: registry + permissions -------------------------------------------------------------------
t('G1', 'tools registered (P25), permissions ask-mutating', async () => {
  // Since P25 the registry is populated (9 tools) and permissions are
  // ask-mutating (read-only auto, mutating ask, hard deny list).
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    const tl = await httpJson(hs.port, a.token, 'GET', '/tools');
    assert(tl.status === 200 && Array.isArray(tl.body.tools), 'tools list');
    const names = tl.body.tools.map((x) => x.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(['bash', 'edit', 'glob', 'grep', 'list', 'patch', 'read', 'todo', 'write']), 'tool names: ' + names.join(','));
    for (const x of tl.body.tools) assert(!('handler' in x), 'handler leaked');
    const pm = await httpJson(hs.port, a.token, 'GET', '/permissions');
    assert(pm.status === 200 && pm.body.mode === 'ask-mutating', 'permissions mode');
    assert(Array.isArray(pm.body.denyList) && pm.body.denyList.length >= 5, 'deny list');
  } finally { killChild(a.child); }
});

t('G2', 'registry unit: validation + handler hidden + deny', () => {
  const { createRegistry } = require(path.join(AGENT_DIR, 'src', 'registry.js'));
  const r = createRegistry();
  assert(r.listTools().length === 0, 'must start empty');
  assert(r.registerTool({}).ok === false, 'empty def accepted');
  assert(r.registerTool({ name: 'Bad Name', description: 'x', handler: () => {} }).ok === false, 'bad name accepted');
  assert(r.registerTool({ name: 'ok_tool', description: 'x' }).ok === false, 'missing handler accepted');
  assert(r.registerTool({ name: 'ok_tool', description: 'does x', handler: () => 1 }).ok === true, 'valid rejected');
  const pub = r.listTools();
  assert(pub.length === 1 && pub[0].name === 'ok_tool' && !('handler' in pub[0]), 'handler leaked');
  assert(r.check('ok_tool').allowed === false, 'step-1 check must deny');
});

// H: journal -----------------------------------------------------------------------------------
t('H1', 'P21 v1 journal: banner + line shape', async () => {
  const a = spawnAgent({});
  try {
    const hs = await waitHandshake(a.child);
    await httpJson(hs.port, a.token, 'GET', '/health');
    // Cross-process file read: poll briefly (scheduling jitter on loaded
    // machines can delay the server-side write past our first read).
    let log = '';
    let lines = [];
    for (let i = 0; i < 40; i++) {
      log = fs.readFileSync(path.join(a.logsDir, 'agent.log'), 'utf8');
      lines = log.split('\n').filter((l) => l && !l.startsWith('#'));
      if (lines.length >= 2) break;
      await sleep(50);
    }
    if (lines.length < 2) {
      try { fs.copyFileSync(path.join(a.logsDir, 'agent.log'), '/tmp/p24-h1-fail-' + process.pid + '.log'); } catch (_) {}
      try { fs.copyFileSync(path.join(a.logsDir, 'agent.jsonl'), '/tmp/p24-h1-fail-' + process.pid + '.jsonl'); } catch (_) {}
    }
    assert(lines.length >= 2, 'event lines missing (got ' + lines.length + ' after 2s, preserved to /tmp)');
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[(INFO |WARN |ERROR)\] \[agent\] \[[A-Za-z0-9_-]+\] \S/;
    for (const l of lines) assert(re.test(l), 'bad v1 line: ' + l.slice(0, 120));
    const jsonl = fs.readFileSync(path.join(a.logsDir, 'agent.jsonl'), 'utf8').trim().split('\n');
    const first = JSON.parse(jsonl[0]);
    assert(first.v === 1 && first.fields && first.fields.format === 1, 'jsonl v1 marker');
  } finally { killChild(a.child); }
});

t('H2', 'prompt content never journaled', async () => {
  const mock = await mockProvider({});
  const canary = 'P24PROMPTCANARYaa11bb22cc33';
  const a = spawnAgent({ provider: { type: 'local', baseUrl: mock.url, model: '' } });
  try {
    const hs = await waitHandshake(a.child);
    const c = await httpJson(hs.port, a.token, 'POST', '/sessions', {});
    await ssePost(hs.port, a.token, '/sessions/' + c.body.id + '/messages', { prompt: 'repeat: ' + canary }, () => {});
    const log = fs.readFileSync(path.join(a.logsDir, 'agent.log'), 'utf8');
    const jsonl = fs.readFileSync(path.join(a.logsDir, 'agent.jsonl'), 'utf8');
    assert(log.indexOf(canary) === -1 && jsonl.indexOf(canary) === -1, 'prompt leaked in journal');
  } finally { killChild(a.child); await mock.close(); }
});

t('H3', 'format parity with backend techLog v1', () => {
  const ref = require(path.join(ROOT, 'backend', 'utils', 'techLog.js'));
  const mine = require(path.join(AGENT_DIR, 'src', 'journal.js'));
  const e = { ts: '2026-10-17T10:00:00.000+00:00', level: 'info', component: 'agent', corr: 'req-ab12', msg: 'http', fields: { method: 'GET', code: 200 } };
  assert(ref.formatHuman(e) === mine.formatHuman(e), 'formatHuman differs:\n' + ref.formatHuman(e) + '\n' + mine.formatHuman(e));
  assert(ref.maskSecrets('Bearer abc123 sk-testkey000') === mine.maskSecrets('Bearer abc123 sk-testkey000'), 'maskSecrets differs');
});

t('H4', 'rotation before append (small cap)', () => {
  const { createLogger } = require(path.join(AGENT_DIR, 'src', 'journal.js'));
  const dir = tmp('rot');
  const log = createLogger({ logsDir: dir, component: 'agent', maxBytes: 300, maxFiles: 3 });
  for (let i = 0; i < 60; i++) log.info('rotation line number ' + i, { i });
  assert(fs.existsSync(path.join(dir, 'agent.log')), 'current log missing');
  assert(fs.existsSync(path.join(dir, 'agent.log.1')), 'rotated log missing');
  assert(fs.statSync(path.join(dir, 'agent.log')).size > 0, 'current log empty');
});

// I: launcher ------------------------------------------------------------------------------------
t('I1', 'spawn opts: hidden window, token via env only (injected spawn)', async () => {
  const { AgentServer } = require(LAUNCHER_JS);
  let seen = null;
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.pid = 4242;
  fake.kill = () => {};
  const spawnFn = (cmd, args, opts) => {
    seen = { cmd, args: args.slice(), windowsHide: opts.windowsHide, hasTokenEnv: !!(opts.env && opts.env.SUDO_AGENT_TOKEN) };
    setImmediate(() => fake.stdout.emit('data', Buffer.from(JSON.stringify({ ready: true, host: HOST, port: 41234, pid: 4242 }) + '\n')));
    return fake;
  };
  const srv = new AgentServer({ provider: { type: 'local', baseUrl: 'http://x', model: '' }, spawnFn, serverPath: '/tmp/x.js', handshakeTimeoutMs: 5000 });
  const r = await srv.start();
  assert(r.port === 41234, 'handshake port');
  assert(seen.windowsHide === true, 'windowsHide missing');
  assert(seen.hasTokenEnv, 'token env missing');
  assert(seen.args.join(' ').indexOf(srv.token) === -1, 'token in argv');
  assert(srv.token && srv.token.length === 64, 'token shape');
  srv.stop();
});

t('I2', 'supervision: kill => auto-restart + journal', async () => {
  const { AgentServer } = require(LAUNCHER_JS);
  const mock = await mockProvider({});
  const lines = [];
  const logger = { info: (m) => lines.push('I ' + m), warn: (m) => lines.push('W ' + m), error: (m) => lines.push('E ' + m) };
  const srv = new AgentServer({
    provider: { type: 'local', baseUrl: mock.url, model: '' },
    serverPath: SERVER_JS, useNode: true, storeDir: tmp('store'), logsDir: tmp('logs'), home: tmp('home'),
    logger, backoffBaseMs: 100, backoffMaxMs: 500, handshakeTimeoutMs: 10000, killTimeoutMs: 500,
  });
  try {
    await srv.start();
    const port1 = srv.port;
    const h1 = await srv.request('/health');
    assert(h1.status === 200, 'health before kill');
    const tok1 = srv.token;
    srv.child.kill('SIGKILL');
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) {
      await sleep(100);
      if (srv.started && srv.port !== port1) {
        try { const h = await srv.request('/health'); ok = h.status === 200; } catch (_) {}
      }
    }
    assert(ok, 'no restart within 12s (started=' + srv.started + ' port=' + srv.port + ')');
    assert(srv.token !== tok1, 'token not rotated on restart');
    const blob = lines.join('\n');
    assert(/restart #1/.test(blob), 'restart not journaled: ' + blob.slice(-400));
    assert(blob.indexOf(tok1) === -1, 'token leaked in launcher logs');
  } finally { srv.stop(); await mock.close(); }
});

t('I3', 'resolveTarget default: node + monorepo server.js (no exe yet)', () => {
  const { AgentServer } = require(LAUNCHER_JS);
  const srv = new AgentServer({ provider: { type: 'local', baseUrl: 'http://x', model: '' } });
  const tgt = srv.resolveTarget();
  assert(tgt.mode === 'node', 'mode ' + tgt.mode);
  assert(tgt.args[0] === SERVER_JS, 'server.js path: ' + tgt.args[0]);
});

// J: provider config (P2 wiring) --------------------------------------------------------------------
function fakeSecrets(map) {
  return {
    get: async (k) => (map[k] === undefined ? null : map[k]),
    store: async (k, v) => { map[k] = v; },
    delete: async (k) => { delete map[k]; },
  };
}

t('J1', 'local default config (no store)', async () => {
  const { AIProviderService } = require(PROV_SVC_JS);
  const svc = new AIProviderService({ storePath: path.join(tmp('svc'), 'ai.json'), policyPath: path.join(tmp('svc'), 'pol.json'), secretsStore: fakeSecrets({}) });
  const cfg = await svc.getServerProviderConfig();
  assert(cfg.type === 'local' && cfg.baseUrl === 'http://' + HOST + ':6000', 'local cfg: ' + JSON.stringify(cfg));
});

t('J2', 'cloud blocked by admin policy (cloudEnabled=false)', async () => {
  const { AIProviderService } = require(PROV_SVC_JS);
  const dir = tmp('svc');
  const svc = new AIProviderService({ storePath: path.join(dir, 'ai.json'), policyPath: path.join(dir, 'pol.json'), secretsStore: fakeSecrets({}) });
  svc._writeStore({ providers: [{ id: 'c1', name: 'C', type: 'cloud', baseUrl: 'https://api.example.com/v1', model: 'm' }], activeId: 'c1', filterEnabled: true });
  fs.writeFileSync(path.join(dir, 'pol.json'), JSON.stringify({ cloudEnabled: false, whitelist: [] }), 'utf8');
  let err = null;
  try { await svc.getServerProviderConfig(); } catch (e) { err = e; }
  assert(err && err.code === 'policy', 'policy not enforced: ' + (err && err.code));
});

t('J3', 'cloud allowed + whitelisted + key => cloud config', async () => {
  const { AIProviderService } = require(PROV_SVC_JS);
  const dir = tmp('svc');
  const svc = new AIProviderService({ storePath: path.join(dir, 'ai.json'), policyPath: path.join(dir, 'pol.json'),
    secretsStore: fakeSecrets({ 'sudoAi.provider.c1': 'KEY-OK-123' }) });
  svc._writeStore({ providers: [{ id: 'c1', name: 'C', type: 'cloud', baseUrl: 'https://api.example.com/v1', model: 'm' }], activeId: 'c1', filterEnabled: true });
  fs.writeFileSync(path.join(dir, 'pol.json'), JSON.stringify({ cloudEnabled: true, whitelist: ['api.example.com'] }), 'utf8');
  const cfg = await svc.getServerProviderConfig();
  assert(cfg.type === 'cloud' && cfg.apiKey === 'KEY-OK-123' && cfg.model === 'm', 'cloud cfg: ' + JSON.stringify({ type: cfg.type, model: cfg.model }));
});

t('J4', 'cloud allowed but key missing => missing_key', async () => {
  const { AIProviderService } = require(PROV_SVC_JS);
  const dir = tmp('svc');
  const svc = new AIProviderService({ storePath: path.join(dir, 'ai.json'), policyPath: path.join(dir, 'pol.json'), secretsStore: fakeSecrets({}) });
  svc._writeStore({ providers: [{ id: 'c1', name: 'C', type: 'cloud', baseUrl: 'https://api.example.com/v1', model: 'm' }], activeId: 'c1', filterEnabled: true });
  fs.writeFileSync(path.join(dir, 'pol.json'), JSON.stringify({ cloudEnabled: true, whitelist: ['api.example.com'] }), 'utf8');
  let err = null;
  try { await svc.getServerProviderConfig(); } catch (e) { err = e; }
  assert(err && err.code === 'missing_key', 'expected missing_key, got ' + (err && err.code));
});

// -- runner -------------------------------------------------------------------------------------------
async function main() {
  let pass = 0;
  const fails = [];
  for (const { id, name, fn } of tests) {
    const t0 = Date.now();
    try {
      await fn();
      pass += 1;
      console.log('PASS ' + id + ' ' + name + ' (' + (Date.now() - t0) + 'ms)');
    } catch (e) {
      fails.push(id);
      console.log('FAIL ' + id + ' ' + name + ' :: ' + String((e && e.message) || e).split('\n')[0]);
    }
  }
  for (const c of children) killChild(c);
  await sleep(300);
  for (const c of children) killChild(c, 'SIGKILL');
  console.log('---');
  console.log('P24: ' + pass + '/' + tests.length + ' passed' + (fails.length ? ' FAILS: ' + fails.join(',') : ''));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fails.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { tests };
