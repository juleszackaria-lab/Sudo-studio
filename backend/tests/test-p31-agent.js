/**
 * SUDO STUDIO - P31: the agent server really starts in the installed product.
 * A: single install-root resolution (dev + installed, one documented place)
 * B: missing server.js -> exact message + journal, spawn never attempted
 * C: last-30 stderr + journal path surfaced (server state + Agent panel)
 * D: REAL end-to-end: stub provider + real server.js via real AgentServer
 *    (handshake, approval flow, honest ECHEC then TERMINE, file asserts)
 * E: "Extension source missing" emitter pinned gone + loud error present
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'p31-' + name + '-')); }

const agentMod = require('../../sudo-ai-extension/src/agent/AgentServer.js');
const { AgentServer, defaultServerJs, defaultExe, resolveInstallRoot } = agentMod;
const SERVER_JS = path.join(ROOT, 'sudo-agent', 'src', 'server.js');

// -- A: single resolution point ---------------------------------------------------
check('A1: dev default hits the real file', () => {
  assert.strictEqual(defaultServerJs(), SERVER_JS);
  assert.ok(fs.existsSync(SERVER_JS));
});
check('A2: installed-shape extension dir resolves to the install root', () => {
  const fake = path.join(tmp('root'), 'extensions', 'sudo-ai');
  assert.strictEqual(resolveInstallRoot(fake), path.dirname(path.dirname(fake)));
  assert.strictEqual(defaultServerJs(fake),
    path.join(path.dirname(path.dirname(fake)), 'sudo-agent', 'src', 'server.js'));
});
check('A3: SUDO_STUDIO_ROOT env is honored', () => {
  const old = process.env.SUDO_STUDIO_ROOT;
  const abs = path.join(tmp('envroot'), 'fake-root');
  process.env.SUDO_STUDIO_ROOT = abs;
  try {
    assert.strictEqual(resolveInstallRoot(null), abs);
  } finally {
    if (old === undefined) delete process.env.SUDO_STUDIO_ROOT;
    else process.env.SUDO_STUDIO_ROOT = old;
  }
});
check('A4: explicit extension dir beats the env', () => {
  const old = process.env.SUDO_STUDIO_ROOT;
  process.env.SUDO_STUDIO_ROOT = path.join('X', 'env-root');
  try {
    const fake = path.join(tmp('exp'), 'extensions', 'sudo-ai');
    assert.strictEqual(resolveInstallRoot(fake), path.dirname(path.dirname(fake)));
  } finally {
    if (old === undefined) delete process.env.SUDO_STUDIO_ROOT;
    else process.env.SUDO_STUDIO_ROOT = old;
  }
});
check('A5: one documented location, wrong P29(f) canonical gone', () => {
  const ag = read('sudo-ai-extension/src/agent/AgentServer.js');
  assert.ok(ag.includes('P31(a)'));
  assert.ok(ag.includes('<installRoot>/sudo-agent/src/server.js'));
  assert.ok(!ag.includes('P29(f) CANONICAL'), 'wrong canonical claim removed');
  assert.ok(ag.includes('resolveInstallRoot'));
});
check('A6: defaultExe shares the same single root', () => {
  const fake = path.join(tmp('exe'), 'extensions', 'sudo-ai');
  const root = resolveInstallRoot(fake);
  assert.strictEqual(defaultExe(fake), path.join(root, 'sudo-agent', 'sudo-agent.exe'));
  assert.strictEqual(path.dirname(defaultServerJs(fake)), path.join(root, 'sudo-agent', 'src'));
});
check('A7: extension.js wires extensionDir + journalPath at both launch sites', () => {
  const ext = read('sudo-ai-extension/extension.js');
  assert.strictEqual(ext.split('agentServerOpts(provider, agentLog)').length - 1, 3, 'helper + 2 calls');
  assert.ok(ext.includes('context.extensionPath'));
  assert.ok(ext.includes("agentLog.base + '.log'"));
});

// -- B: missing server.js -----------------------------------------------------------
function capLogger() {
  const lines = [];
  return { lines,
    info: (m) => lines.push(['info', String(m)]),
    warn: (m) => lines.push(['warn', String(m)]),
    error: (m) => lines.push(['error', String(m)]) };
}
async function main() {
  {
    const log = capLogger();
    let spawned = false;
    const missing = path.join(tmp('miss'), 'nope', 'server.js');
    const srv = new AgentServer({ provider: { type: 'local' }, serverPath: missing,
      logger: log, spawnFn: () => { spawned = true; throw new Error('must not spawn'); } });
    let err = null;
    try { await srv.start(); } catch (e) { err = e; }
    srv.stop();
    assert.ok(err, 'start rejects');
    assert.strictEqual(err.message, 'server.js introuvable \u00e0 ' + missing);
    assert.strictEqual(spawned, false, 'spawn never attempted');
    assert.ok(log.lines.some((l) => l[0] === 'error' && l[1] === 'server.js introuvable \u00e0 ' + missing),
      'exact path in journal: ' + JSON.stringify(log.lines));
    assert.ok(log.lines.some((l) => l[0] === 'info' && l[1] === 'agent server target: ' + missing),
      'resolved path journaled');
    n++; console.log('ok - B1: missing file -> exact message, journal, no spawn');
  }
  check('B2: resolveTarget stays total (P27 compat, check happens at spawn)', () => {
    const srv = new AgentServer({ provider: { type: 'local' }, serverPath: '/tmp/x.js' });
    const t = srv.resolveTarget();
    assert.strictEqual(t.mode, 'node');
    assert.strictEqual(t.args[0], '/tmp/x.js');
  });

  // -- C: stderr tail ----------------------------------------------------------------
  {
    const log = capLogger();
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter(); fake.stderr = new EventEmitter();
    fake.pid = 4242; fake.kill = () => {};
    const srv = new AgentServer({ provider: { type: 'local' }, serverPath: SERVER_JS,
      logger: log, journalPath: path.join('J', 'agent.log'),
      handshakeTimeoutMs: 5000, killTimeoutMs: 50, spawnFn: () => fake });
    const p = srv.start().catch((e) => e);
    for (let i = 1; i <= 40; i++) fake.stderr.emit('data', Buffer.from('line-' + i + '\n'));
    fake.emit('exit', 1);
    const err = await p;
    assert.ok(err && /exited during handshake/.test(err.message));
    const st = srv.state();
    assert.strictEqual(st.status, 'error');
    assert.strictEqual(st.stderrTail.length, 30, 'last 30, got ' + st.stderrTail.length);
    assert.strictEqual(st.stderrTail[0], 'line-11');
    assert.strictEqual(st.stderrTail[29], 'line-40');
    assert.strictEqual(st.journalPath, path.join('J', 'agent.log'));
    srv.stop();
    n++; console.log('ok - C1: failure state carries last-30 stderr + journal path');
  }
  {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter(); fake.stderr = new EventEmitter();
    fake.pid = 4243; fake.kill = () => {}; fake.on = fake.addListener.bind(fake);
    const srv = new AgentServer({ provider: { type: 'local' }, serverPath: SERVER_JS,
      handshakeTimeoutMs: 2000, killTimeoutMs: 50, spawnFn: () => fake });
    const p = srv.start();
    fake.stdout.emit('data', Buffer.from(JSON.stringify({ ready: true, host: '127.0.0.1', port: 41555, pid: 4243 }) + '\n'));
    await p;
    assert.strictEqual(srv.state().status, 'ready');
    assert.strictEqual(srv.lastFailure, null, 'snapshot cleared on success');
    srv.stop();
    n++; console.log('ok - C2: success clears the failure snapshot');
  }

  // -- D: real end-to-end --------------------------------------------------------------
  const script = [
    { content: '', tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file: 'hello.txt', content: 'bonjour e2e\n' }) } }] },
    { content: 'fichier demande.', tool_calls: [] },
    { content: 'termine.', tool_calls: [] },
  ];
  let chatCalls = 0;
  const stub = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'scripted-e2e' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const step = script[Math.min(chatCalls, script.length - 1)];
        chatCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: step.content, tool_calls: step.tool_calls } }] }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = 'http://127.0.0.1:' + stub.address().port;
  const proj = tmp('proj'); // the test project COPY (starts empty)
  const srv = new AgentServer({
    provider: { type: 'local', baseUrl: stubUrl, model: 'scripted-e2e' },
    serverPath: SERVER_JS, nodePath: process.execPath, useNode: true,
    home: tmp('home'), storeDir: tmp('store'), logsDir: tmp('logs'),
    handshakeTimeoutMs: 20000, killTimeoutMs: 2000,
  });
  function api(method, pth, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: pth, method,
        headers: Object.assign({ Authorization: 'Bearer ' + srv.token },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { _raw: raw.slice(0, 200) }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  try {
    await srv.start();
    assert.ok(srv.port > 0, 'handshake gave a port');
    n++; console.log('ok - D1: real server starts, handshake ok (port ' + srv.port + ')');
    const h = await api('GET', '/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.ok, true);
    n++; console.log('ok - D2: token-authed /health ok');
    const s = await api('POST', '/sessions', { title: 'p31', projectRoot: proj });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    const sid = s.body.id;
    const t1 = await srv.stream('/sessions/' + sid + '/messages', { prompt: 'cree hello.txt' }, () => {}, { timeoutMs: 60000 });
    assert.strictEqual(t1.status, 'ECHEC', 'honest: not executed, got ' + t1.status);
    assert.ok(/need_approval/.test(t1.reason || ''), 'reason names it: ' + t1.reason);
    assert.ok(!fs.existsSync(path.join(proj, 'hello.txt')), 'nothing written before approval');
    n++; console.log('ok - D3: turn 1 honestly ECHEC (need_approval), nothing written');
    const pend = await api('GET', '/sessions/' + sid + '/approvals');
    assert.strictEqual(pend.status, 200);
    assert.strictEqual(pend.body.pending.length, 1, JSON.stringify(pend.body));
    const reqId = pend.body.pending[0].id;
    n++; console.log('ok - D4: exactly one pending approval (' + reqId + ')');
    const dec = await api('POST', '/sessions/' + sid + '/approvals', { requestId: reqId, decision: 'once' });
    assert.strictEqual(dec.status, 200);
    assert.strictEqual(dec.body.status, 'executed', JSON.stringify(dec.body));
    assert.strictEqual(fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8'), 'bonjour e2e\n');
    n++; console.log('ok - D5: approval executes the write with scripted content');
    const t2 = await srv.stream('/sessions/' + sid + '/messages', { prompt: 'confirme.' }, () => {}, { timeoutMs: 60000 });
    assert.strictEqual(t2.status, 'TERMINE', 'got ' + t2.status + ' ' + t2.reason);
    n++; console.log('ok - D6: turn 2 TERMINE, honest');
    const left = [];
    (function walk(d, rel) {
      for (const f of fs.readdirSync(d)) {
        const a = path.join(d, f), r = rel ? rel + '/' + f : f;
        if (fs.statSync(a).isDirectory()) walk(a, r); else left.push(r);
      }
    })(proj, '');
    assert.deepStrictEqual(left, ['hello.txt'], 'no file outside the request: ' + JSON.stringify(left));
    n++; console.log('ok - D7: project holds ONLY the requested file');
  } finally {
    srv.stop();
    await new Promise((r) => stub.close(r));
  }
  console.log('\nP31-agent: ' + n + ' checks passed (all green)');
}

// -- C (static + panel behavior, sync part) ----------------------------------------------
check('C3: panel renders serverError (tail + journal + relaunch)', () => {
  const src = read('sudo-ai-extension/src/agent/AgentPanel.js');
  assert.ok(src.includes('function renderServerError(m)'));
  assert.ok(src.includes('m.type === "serverError"'));
  assert.ok(src.includes('Dernier stderr ('));
  assert.ok(src.includes('Journal : '));
  assert.ok(src.includes('Relancer le serveur'));
  assert.ok(src.includes('className = "srvpre"'));
  assert.ok(src.includes('_srvErrShown'));
});
check('C4: run-state hook posts serverError once per distinct error', () => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return {};
    return origLoad.call(this, request, parent, isMain);
  };
  let panelMod, hostMod;
  try {
    panelMod = require('../../sudo-ai-extension/src/agent/AgentPanel.js');
    hostMod = require('../../sudo-ai-extension/src/agent/agentHost.js');
  } finally {
    Module._load = origLoad;
  }
  const posted = [];
  const fakeThis = { _running: false, _queue: [],
    _post: (m) => posted.push(m), _srvErrShown: undefined };
  hostMod.setAgentHost({ serverState: () => ({ status: 'error', detail: 'boom',
    stderrTail: ['l1', 'l2'], journalPath: path.join('J', 'agent.log') }) });
  try {
    panelMod.AgentPanel.prototype._postRunState.call(fakeThis);
    panelMod.AgentPanel.prototype._postRunState.call(fakeThis);
    const errs = posted.filter((m) => m.type === 'serverError');
    assert.strictEqual(errs.length, 1, 'posted once, got ' + errs.length);
    assert.strictEqual(errs[0].message, 'Serveur agent : boom');
    assert.deepStrictEqual(errs[0].stderrTail, ['l1', 'l2']);
    assert.strictEqual(errs[0].journalPath, path.join('J', 'agent.log'));
    hostMod.setAgentHost({ serverState: () => ({ status: 'error', detail: 'boom-2', stderrTail: [], journalPath: null }) });
    panelMod.AgentPanel.prototype._postRunState.call(fakeThis);
    assert.strictEqual(posted.filter((m) => m.type === 'serverError').length, 1, 'no details -> silent');
    hostMod.setAgentHost({ serverState: () => ({ status: 'error', detail: 'boom-2', stderrTail: ['x'], journalPath: null }) });
    panelMod.AgentPanel.prototype._postRunState.call(fakeThis);
    assert.strictEqual(posted.filter((m) => m.type === 'serverError').length, 2, 'new detail shown');
  } finally {
    hostMod.resetAgentHost();
  }
});

// -- E: the old emitter ---------------------------------------------------------------------
check('E1: pre-P29 emitter gone, loud error present (P31(e))', () => {
  // "Extension source missing" was emitted by start.bat PHASE 5 (extension
  // sync) when %V_SRC%\package.json was absent. P29 replaced it with a loud
  // error naming both expected paths; the PC log line comes from a stale
  // pre-P29 installed start.bat (fixed by reinstalling from current CI).
  const bat = read('start.bat');
  assert.ok(!bat.includes('Extension source missing'));
  assert.ok(bat.includes('Extension missing (both paths)'));
  assert.ok(bat.includes('Looked for:'));
});

check('E2: smoke pins the root layout + agent-e2e modes exist', () => {
  const smoke = read('scripts/smoke/smoke-install.ps1');
  const e2e = read('scripts/smoke/agent-e2e.js');
  const bs = String.fromCharCode(92);
  assert.ok(smoke.includes("Join-Path $InstallDir 'sudo-agent" + bs + "src" + bs + "server.js'"));
  assert.ok(smoke.indexOf('extensions' + bs + 'sudo-agent') === -1, 'old wrong path gone');
  for (const m of ['resolve-path', 'missing-message', 'missing-restored', 'e2e-handshake', 'e2e-turn2', 'e2e-only-file', 'AGENT-E2E RESULT']) {
    assert.ok(e2e.includes(m), m);
  }
});
check('E3: packager patch doc carries the 03 job (P31-d wiring)', () => {
  const doc = read('docs/p31-packager-patch.md');
  for (const m of ['smoke-windows', 'smoke-install.ps1', 'agent-e2e.js', 'setup-node', 'SudoStudio-Installer', 'supersedes P29-P1', 'AGENT-E2E RESULT: SUCCESS']) {
    assert.ok(doc.includes(m), m);
  }
});

main().catch((e) => { console.error('P31-agent FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
