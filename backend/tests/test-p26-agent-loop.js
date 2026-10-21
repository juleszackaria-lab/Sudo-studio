// P26 agent loop: Build/Plan modes, size profiles, context budget +
// compression, one action per step, repeat-loop detection, verify loop,
// MCP client (stdio), deploy gate. All file tests run on disposable
// fixture COPIES in tmp (git repos), never on a real user project.
// Hermetic: loopback only. ASCII only.
// Forbidden-brand needle built dynamically so this spec stays clean.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_DIR = path.join(ROOT, 'sudo-agent');
const AGENT_SRC = path.join(AGENT_DIR, 'src');
const SERVER_JS = path.join(AGENT_SRC, 'server.js');

const NEEDLE = 'open' + 'code';
const HOST = '127.0.0.1';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-'));
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

// -- disposable fixture project (a COPY, git repo) --------------------------------
function fixtureProject(extra) {
  const dir = tmp('proj');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nHello.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const x = 1;\nconsole.log(x);\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'alpha\nbeta\nalpha beta\n', 'utf8');
  if (extra) {
    for (const k of Object.keys(extra)) {
      const f = path.join(dir, k);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, extra[k], 'utf8');
    }
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

// -- HTTP ------------------------------------------------------------------
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
    const req = http.request({ host: HOST, port, path: p, method: 'POST', timeout: timeoutMs || 90000,
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

// -- scripted mock provider (P26: configurable models + raw tool calls) -----
function mockProvider(opts) {
  opts = opts || {};
  const chats = [];
  const queue = (opts.responses || []).slice();
  const models = opts.models || [{ id: 'mock-model' }];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        chats.push(body);
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'legacy-ok' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const next = queue.length ? queue.shift() : { content: 'default-done' };
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((t, i) => ({ id: t.id || ('call-' + chats.length + '-' + i),
            type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
        }
        if (next.rawCalls) {
          msg.tool_calls = next.rawCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argsText } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: msg }] }));
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

// -- agent server ------------------------------------------------------------
function spawnAgent(opts) {
  opts = opts || {};
  const token = crypto.randomBytes(32).toString('hex');
  const home = opts.home || tmp('home');
  const logsDir = path.join(home, 'logs');
  const storeDir = path.join(home, 'store');
  const provider = opts.provider !== undefined ? opts.provider : { type: 'local', baseUrl: 'http://' + HOST + ':6000', model: '' };
  const env = Object.assign({}, process.env, {
    SUDO_AGENT_TOKEN: token,
    SUDO_AGENT_PORT: '0',
    SUDO_AGENT_PROVIDER: JSON.stringify(provider),
    SUDO_STUDIO_HOME: home,
    SUDO_STUDIO_LOGS: logsDir,
    SUDO_AGENT_STORE: storeDir,
  }, opts.env || {});
  const child = track(spawn(process.execPath, [SERVER_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  return { child, token, home, logsDir, storeDir };
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

async function boot(provider, env) {
  const a = spawnAgent({ provider, env });
  const hs = await waitHandshake(a.child);
  return { a, hs, port: hs.port, token: a.token };
}

async function newSession(port, token, projectRoot, title) {
  const r = await httpJson(port, token, 'POST', '/sessions', { title: title || 't', projectRoot });
  assert(r.status === 201, 'session create: ' + r.status);
  return r.body.id;
}

async function callTool(port, token, sid, tool, args) {
  return httpJson(port, token, 'POST', '/sessions/' + sid + '/tools/call', { tool, args });
}

async function approve(port, token, sid, requestId, decision) {
  return httpJson(port, token, 'POST', '/sessions/' + sid + '/approvals', { requestId, decision });
}

async function setMode(port, token, sid, mode) {
  return httpJson(port, token, 'POST', '/sessions/' + sid + '/mode', { mode });
}

async function pollFile(file, re, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let s = '';
    try { s = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (re.test(s)) return s;
    if (Date.now() - t0 > (timeoutMs || 3000)) throw new Error('poll timeout for ' + re + ' in ' + path.basename(file));
    await sleep(80);
  }
}

// -- sample MCP echo server (stdio JSON-RPC, fixture) -------------------------
function mcpEchoScript() {
  const f = path.join(tmp('mcp'), 'echo-server.js');
  fs.writeFileSync(f, [
    "'use strict';",
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c;',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) !== -1) {',
    '    const line = buf.slice(0, nl).trim();',
    '    buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    let m = null;',
    '    try { m = JSON.parse(line); } catch (_) { continue; }',
    '    if (m.id === undefined) continue;',
    '    let result = {};',
    '    if (m.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "1" } };',
    '    else if (m.method === "tools/list") result = { tools: [{ name: "echo", description: "repeat text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };',
    '    else if (m.method === "tools/call") result = { content: [{ type: "text", text: "echo:" + ((m.params && m.params.arguments && m.params.arguments.text) || "") }] };',
    '    else result = {};',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");',
    '  }',
    '});',
    '',
  ].join('\n'), 'utf8');
  return f;
}

function writeAgentFile(home, name, obj) {
  const d = path.join(home, '.sudo_studio', 'agent');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), JSON.stringify(obj), 'utf8');
}

// -- tests ------------------------------------------------------------------
const tests = [];
function t(id, name, fn) { tests.push({ id, name, fn }); }

// A: static + units ------------------------------------------------------------
t('A1', 'P26 sources: ASCII only, no forbidden brand', () => {
  const files = ['modes.js', 'profiles.js', 'compress.js', 'verify.js', 'mcp.js', 'loop.js', 'tools.js', 'server.js', 'store.js', 'providers.js', 'permissions.js'];
  const re = new RegExp(NEEDLE, 'i');
  for (const f of files) {
    const buf = fs.readFileSync(path.join(AGENT_SRC, f));
    for (let i = 0; i < buf.length; i++) assert(buf[i] < 128, f + ': non-ASCII byte');
    assert(!re.test(buf.toString('utf8')), f + ': brand leak');
  }
});

t('A2', 'modes: distinct Build/Plan prompts, get/set', () => {
  const modes = require(path.join(AGENT_SRC, 'modes.js'));
  assert(modes.buildSystem() !== modes.planSystem(), 'prompts differ');
  assert(modes.planSystem().indexOf('PROPOSE') !== -1, 'plan proposes');
  assert(modes.PLAN_REFUSED.indexOf('bash') !== -1 && modes.PLAN_REFUSED.indexOf('read') === -1, 'refused set');
  assert(modes.getMode({}) === 'build', 'default build');
  assert(modes.getMode({ meta: { mode: 'plan' } }) === 'plan', 'plan kept');
  assert(modes.getMode({ meta: { mode: 'evil' } }) === 'build', 'unknown falls back');
});

t('A3', 'profiles: size detection, ctx resolution, budget', () => {
  const p = require(path.join(AGENT_SRC, 'profiles.js'));
  assert(p.parseParamsB('Qwen2.5-Coder-1.5B-Instruct') === 1.5, 'parse 1.5B');
  assert(p.parseParamsB('llama-3-8b') === 8, 'parse 8b');
  assert(p.parseParamsB('gpt-4o') === null, 'no params');
  assert(p.selectProfile({ modelId: 'qwen-1.5b', providerType: 'local' }) === 'small', '1.5b small');
  assert(p.selectProfile({ modelId: 'llama-8b', providerType: 'local' }) === 'full', '8b full');
  assert(p.selectProfile({ modelId: 'mystery', providerType: 'local' }) === 'small', 'unknown local small');
  assert(p.selectProfile({ modelId: 'mystery', providerType: 'cloud' }) === 'full', 'unknown cloud full');
  assert(p.selectProfile({ modelId: 'llama-8b', providerType: 'local', override: 'small' }) === 'small', 'override wins');
  assert(p.profileTools('small').length === 6 && p.profileTools('full').length === 9, 'tool counts');
  assert(p.profileTools('small').indexOf('patch') === -1, 'small drops patch');
  assert(p.resolveCtxTokens({ override: '999', probeNctx: 111, providerType: 'local' }) === 999, 'override first');
  assert(p.resolveCtxTokens({ probeNctx: 1234, providerType: 'local' }) === 1234, 'probe second');
  assert(p.resolveCtxTokens({ providerType: 'local' }) === 2048, 'local default');
  assert(p.resolveCtxTokens({ providerType: 'cloud' }) === 8000, 'cloud default');
  const e1 = p.estimateTokens([{ role: 'user', content: 'hi' }], 0);
  const e2 = p.estimateTokens([{ role: 'user', content: 'x'.repeat(4000) }], 4000);
  assert(e2 > e1 && e1 > 0, 'estimate grows');
});

t('A4', 'verify: check detection + deploy detection units', () => {
  const v = require(path.join(AGENT_SRC, 'verify.js'));
  const d1 = tmp('v1');
  fs.writeFileSync(path.join(d1, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }), 'utf8');
  assert(v.detectChecks(d1).map((c) => c.command).join(',') === 'npm test', 'npm test');
  const d2 = tmp('v2');
  fs.writeFileSync(path.join(d2, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');
  assert(v.detectChecks(d2).length === 0, 'no test script -> none');
  const d3 = tmp('v3');
  fs.writeFileSync(path.join(d3, 'pubspec.yaml'), 'name: x\n', 'utf8');
  assert(v.detectChecks(d3).length === 2, 'flutter two checks');
  const d4 = tmp('v4');
  fs.writeFileSync(path.join(d4, 'Makefile'), 'test:\n\techo ok\n', 'utf8');
  fs.writeFileSync(path.join(d4, '.sudo-verify'), 'node custom.js\n', 'utf8');
  assert(v.detectChecks(d4).map((c) => c.command).join(',') === 'node custom.js', '.sudo-verify wins');
  assert(v.detectChecks(tmp('v5')).length === 0, 'empty -> none');
  assert(v.detectDeploy('npm run deploy') === true, 'npm run deploy');
  assert(v.detectDeploy('npm test') === false, 'npm test not deploy');
  assert(v.detectDeploy('docker push img') === true, 'docker push');
  assert(v.detectDeploy('docker build .') === false, 'docker build not deploy');
  assert(v.detectDeploy('kubectl apply -f k.yaml') === true, 'kubectl apply');
  assert(v.detectDeploy('./deploy.sh prod') === true, 'deploy.sh');
  assert(v.detectDeploy('echo deploying soon') === false, 'echo not deploy');
});

t('A5', 'verify: deploy network policy defaults deny', () => {
  const v = require(path.join(AGENT_SRC, 'verify.js'));
  assert(v.deployAllowed(tmp('np1')) === false, 'missing policy denies');
  const h = tmp('np2');
  writeAgentFile(h, 'net_policy.json', { deployAllowed: true });
  assert(v.deployAllowed(h) === true, 'explicit allow');
});

t('A6', 'mcp: allowlist fail-closed units', () => {
  const mcp = require(path.join(AGENT_SRC, 'mcp.js'));
  assert(mcp.isAllowed(tmp('mp1'), 's', 't') === false, 'missing policy denies');
  const h = tmp('mp2');
  writeAgentFile(h, 'mcp_policy.json', { allowed: { a: ['x'], b: '*' } });
  assert(mcp.isAllowed(h, 'a', 'x') === true, 'listed allowed');
  assert(mcp.isAllowed(h, 'a', 'y') === false, 'unlisted denied');
  assert(mcp.isAllowed(h, 'b', 'anything') === true, 'star allowed');
  assert(mcp.isAllowed(h, 'c', 'x') === false, 'unknown server denied');
  assert(JSON.stringify(Object.keys(mcp.loadConfig(tmp('mp3')))) === '[]', 'missing config empty');
});

// B: modes -------------------------------------------------------------------
t('B1', 'plan mode: write refused (plan_mode), no poison, file untouched', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'write', args: { file: 'plan.txt', content: 'x' } }] },
    { content: 'noted, plan only' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const mr = await setMode(port, token, sid, 'plan');
    assert(mr.status === 200 && mr.body.mode === 'plan', 'mode set');
    const codes = [];
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'write it' }, (ev, o) => {
      if (ev === 'tool.result') codes.push(o.code);
    });
    assert(done.status === 'TERMINE', 'TERMINE not poisoned, got ' + done.status);
    assert(codes.indexOf('plan_mode') !== -1, 'plan_mode refusal seen');
    assert(!fs.existsSync(path.join(proj, 'plan.txt')), 'file untouched');
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    assert(g.body.meta.lastRun.stopReason === 'declared', 'stopReason declared');
  } finally { killChild(a.child); await mock.close(); }
});

t('B2', 'mode endpoint: switch, invalid, unknown', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({});
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    let r = await setMode(port, token, sid, 'plan');
    assert(r.status === 200 && r.body.mode === 'plan', 'to plan');
    r = await setMode(port, token, sid, 'build');
    assert(r.status === 200 && r.body.mode === 'build', 'to build');
    r = await setMode(port, token, sid, 'evil');
    assert(r.status === 400, 'invalid rejected');
    r = await setMode(port, token, 'no-such-session', 'plan');
    assert(r.status === 404, 'unknown session');
  } finally { killChild(a.child); await mock.close(); }
});

t('B3', 'default mode is build: write asks (not plan-refused)', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'write', args: { file: 'n.txt', content: 'x' } }] },
    { content: 'waiting' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const codes = [];
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'write it' }, (ev, o) => {
      if (ev === 'tool.result') codes.push(o.code);
    });
    assert(codes.indexOf('need_approval') !== -1, 'write asked, got ' + JSON.stringify(codes));
    assert(done.status === 'ECHEC', 'approval need mid-turn -> ECHEC, got ' + done.status);
  } finally { killChild(a.child); await mock.close(); }
});

// C: one action per step --------------------------------------------------------
t('C1', 'two calls in one step: first runs, second skipped, transcript valid', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }, { name: 'read', args: { file: 'README.md' } }] },
    { content: 'done' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    let starts = 0;
    const codes = [];
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'read both' }, (ev, o) => {
      if (ev === 'tool.start') starts += 1;
      if (ev === 'tool.result') codes.push(o.code || 'ok');
    });
    assert(starts === 1, 'one execution, got ' + starts);
    assert(codes.length === 2 && codes[0] === 'ok' && codes[1] === 'skipped', 'ok+skipped, got ' + JSON.stringify(codes));
    assert(done.status === 'TERMINE', 'skipped does not poison');
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    const tools = g.body.messages.filter((m) => m.role === 'tool');
    assert(tools.length === 2 && tools[1].content.indexOf('une seule action') !== -1, 'skipped tool message stored');
  } finally { killChild(a.child); await mock.close(); }
});

// D: repeat-loop detection ------------------------------------------------------
t('D1', 'same tool+target 3x -> PARTIEL loop', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }] },
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }] },
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }] },
    { content: 'rescue answer' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    let starts = 0;
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'loop' }, (ev) => {
      if (ev === 'tool.start') starts += 1;
    });
    assert(done.status === 'PARTIEL', 'PARTIEL, got ' + done.status);
    assert(done.stopReason === 'loop', 'stopReason loop, got ' + done.stopReason);
    assert(done.reason.indexOf('boucle repetitive') !== -1, 'loop reason');
    assert(starts === 2, 'third call never executed, got ' + starts);
    // P39 evolution: a 4th no-tools rescue round answers from collected
    // context, so a loop never ends without a reply.
    assert(mock.chats.length === 4, 'three steps + rescue, got ' + mock.chats.length);
    assert(!('tools' in mock.chats[3]) || mock.chats[3].tools === undefined, 'rescue has no tools');
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    const msgs = g.body.messages;
    assert(msgs[msgs.length - 1].content === 'rescue answer', 'rescue reply stored');
  } finally { killChild(a.child); await mock.close(); }
});

// E: profiles -----------------------------------------------------------------
t('E1', 'small profile: 6 terse tools for 1.5B', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [{ content: 'done' }] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: 'qwen-1.5b' });
  try {
    const sid = await newSession(port, token, proj);
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'hi' }, () => {});
    const tools = mock.chats[0].tools || [];
    const names = tools.map((x) => x.function.name);
    assert(names.length === 6, 'six tools, got ' + names.length);
    assert(names.indexOf('patch') === -1 && names.indexOf('todo') === -1, 'no patch/todo');
    for (const x of tools) assert(x.function.description.length < 60, 'terse: ' + x.function.name);
    await pollFile(path.join(a.logsDir, 'agent.log'), /profile=small/, 3000);
  } finally { killChild(a.child); await mock.close(); }
});

t('E2', 'full profile: 9 tools for 8B', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [{ content: 'done' }] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: 'llama-8b' });
  try {
    const sid = await newSession(port, token, proj);
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'hi' }, () => {});
    const names = (mock.chats[0].tools || []).map((x) => x.function.name);
    assert(names.length === 9 && names.indexOf('patch') !== -1, 'nine tools, got ' + names.length);
    await pollFile(path.join(a.logsDir, 'agent.log'), /profile=full/, 3000);
  } finally { killChild(a.child); await mock.close(); }
});

t('E3', 'probe n_ctx drives budget: compression at >75%', async () => {
  const proj = fixtureProject();
  // Fixed overhead ~630 tokens (small schemas + mode system). n_ctx=2000:
  // seeds stay under 1500, the final prompt crosses it, post-compress fits.
  const mock = await mockProvider({
    models: [{ id: 'm', n_ctx: 2000 }],
    responses: [
      { content: 'ok1' }, { content: 'ok2' }, { content: 'ok3' }, { content: 'ok4' },
      { content: 'SUMMARY AlphaBeta decisions/files/errors kept' },
      { content: 'done after compress' },
    ],
  });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'S1 ' + 'y'.repeat(697) }, () => {});
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'S2 ' + 'y'.repeat(697) }, () => {});
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'S3 ' + 'y'.repeat(697) }, () => {});
    await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'S4 ' + 'y'.repeat(697) }, () => {});
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'BIG ' + 'x'.repeat(1196) }, () => {});
    assert(done.status === 'TERMINE', 'TERMINE after compress, got ' + done.status + ' ' + done.reason);
    assert(mock.chats.length === 6, 'summarizer + final chats, got ' + mock.chats.length);
    const sum = mock.chats[4];
    assert(!sum.tools, 'summarizer sent without tools');
    assert(sum.messages[0].content.indexOf('MODIFIED FILES') !== -1, 'summary prompt keeps files');
    assert(sum.messages[0].content.indexOf('ongoing errors') !== -1, 'summary prompt keeps errors');
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    assert(g.body.messages[0].content.indexOf('[Resume') !== -1, 'history spliced');
    assert(g.body.messages[0].content.indexOf('AlphaBeta') !== -1, 'summary stored');
    assert(g.body.messages.length <= 7, 'history compacted, got ' + g.body.messages.length);
    const log = await pollFile(path.join(a.logsDir, 'agent.log'), /contexte compresse/, 3000);
    assert(/ctx=2000/.test(log), 'probe n_ctx reached the budget');
  } finally { killChild(a.child); await mock.close(); }
});

// F: verify loop ---------------------------------------------------------------
async function preApprove(port, token, sid, tool, args) {
  const r = await callTool(port, token, sid, tool, args);
  assert(r.body.status === 'need-approval', 'pre-approve asks for ' + tool);
  const ap = await approve(port, token, sid, r.body.request.id, 'session');
  assert(ap.body.status === 'executed' || ap.body.status === 'error' || ap.body.code, 'pre-approve executes ' + tool);
  return ap;
}

t('F1', 'verify loop: real npm test runs and passes after edit', async () => {
  const proj = fixtureProject({
    'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node check.js' } }),
    'check.js': 'console.log("checks ok");\n',
  });
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }] },
    { content: '', toolCalls: [{ name: 'edit', args: { file: 'notes.txt', old: 'alpha\nbeta', new: 'alpha\nBETA' } }] },
    { content: 'edited' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    await preApprove(port, token, sid, 'edit', { file: 'notes.txt', old: 'alpha beta', new: 'ALPHA BETA' });
    await preApprove(port, token, sid, 'bash', { command: 'npm test' });
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'fix notes' }, () => {});
    assert(done.status === 'TERMINE', 'TERMINE, got ' + done.status + ' ' + done.reason);
    assert(fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8').indexOf('BETA') !== -1, 'edit applied');
    await pollFile(path.join(a.logsDir, 'agent.log'), /verify pass/, 5000);
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    assert(g.body.meta.lastRun.stopReason === 'declared', 'stopReason declared');
  } finally { killChild(a.child); await mock.close(); }
});

t('F2', 'scenario: fix the failing test via verify feedback', async () => {
  const proj = fixtureProject({
    'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node check.js' } }),
    'check.js': 'const ok = require("fs").readFileSync("flag.txt", "utf8").trim() === "ok";\nif (!ok) { console.error("CHECK FAIL: flag is not ok"); process.exit(1); }\nconsole.log("checks ok");\n',
    'flag.txt': 'ko\n',
  });
  // First attempt writes the wrong value; the verify loop catches it and the
  // model corrects after the failure feedback.
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'read', args: { file: 'flag.txt' } }] },
    { content: '', toolCalls: [{ name: 'write', args: { file: 'flag.txt', content: 'yes\n' } }] },
    { content: 'fixed?' },
    { content: '', toolCalls: [{ name: 'write', args: { file: 'flag.txt', content: 'ok\n' } }] },
    { content: 'fixed' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    // Session rules first (direct calls), then restore the failing state.
    // Read-before-write: the anti-overwrite gate requires a prior read.
    await callTool(port, token, sid, 'read', { file: 'flag.txt' });
    await preApprove(port, token, sid, 'write', { file: 'flag.txt', content: 'ok\n' });
    await preApprove(port, token, sid, 'bash', { command: 'npm test' });
    fs.writeFileSync(path.join(proj, 'flag.txt'), 'ko\n', 'utf8');
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'make the checks pass' }, () => {});
    assert(done.status === 'TERMINE', 'TERMINE, got ' + done.status + ' ' + done.reason);
    assert(fs.readFileSync(path.join(proj, 'flag.txt'), 'utf8').trim() === 'ok', 'flag fixed');
    assert(done.filesModified.some((f) => f.indexOf('flag.txt') !== -1), 'flag.txt reported modified');
    const sawFeedback = mock.chats.some((c) => JSON.stringify(c.messages || []).indexOf('VERIFICATION ECHOUEE') !== -1);
    assert(sawFeedback, 'model received verify failures');
    const sawOutput = mock.chats.some((c) => JSON.stringify(c.messages || []).indexOf('CHECK FAIL') !== -1);
    assert(sawOutput, 'model received the failing output');
    await pollFile(path.join(a.logsDir, 'agent.log'), /verify fail, retry/, 5000);
    await pollFile(path.join(a.logsDir, 'agent.log'), /verify pass/, 5000);
  } finally { killChild(a.child); await mock.close(); }
});

t('F3', 'verify without approval -> PARTIEL verify_approval + pending', async () => {
  const proj = fixtureProject({ '.sudo-verify': 'node -e "process.exit(0)"\n' });
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'write', args: { file: 'v.txt', content: 'v' } }] },
    { content: 'written' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    await preApprove(port, token, sid, 'write', { file: 'v.txt', content: 'v' });
    fs.unlinkSync(path.join(proj, 'v.txt'));
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'write v' }, () => {});
    assert(done.status === 'PARTIEL', 'PARTIEL, got ' + done.status);
    assert(done.stopReason === 'verify_approval', 'stopReason, got ' + done.stopReason);
    const pend = await httpJson(port, token, 'GET', '/sessions/' + sid + '/approvals');
    assert(pend.body.pending.length === 1, 'verify request pending');
  } finally { killChild(a.child); await mock.close(); }
});

t('F4', 'no check detected -> TERMINE + journal', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', toolCalls: [{ name: 'write', args: { file: 'w.txt', content: 'w' } }] },
    { content: 'written' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    await preApprove(port, token, sid, 'write', { file: 'w.txt', content: 'w' });
    fs.unlinkSync(path.join(proj, 'w.txt'));
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'write w' }, () => {});
    assert(done.status === 'TERMINE', 'TERMINE, got ' + done.status);
    await pollFile(path.join(a.logsDir, 'agent.log'), /aucune commande detectee/, 3000);
  } finally { killChild(a.child); await mock.close(); }
});

// G: MCP ----------------------------------------------------------------------
t('G1', 'MCP sample server: connect + tool call + journal', async () => {
  const proj = fixtureProject();
  const echo = mcpEchoScript();
  const home = tmp('home');
  writeAgentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  writeAgentFile(home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
  const mock = await mockProvider({});
  const a = spawnAgent({ home, provider: { type: 'local', baseUrl: mock.url, model: '' } });
  const hs = await waitHandshake(a.child);
  try {
    const sid = await newSession(hs.port, a.token, proj);
    const r = await callTool(hs.port, a.token, sid, 'mcp__echo__echo', { text: 'hi' });
    assert(r.body.status === 'need-approval', 'MCP asks first');
    const ap = await approve(hs.port, a.token, sid, r.body.request.id, 'once');
    assert(ap.body.status === 'executed', 'MCP executed, got ' + JSON.stringify(ap.body).slice(0, 200));
    assert(String(ap.body.call.result).indexOf('echo:hi') !== -1, 'echo result');
    await pollFile(path.join(a.logsDir, 'agent.log'), /mcp appel echo\/echo ok/, 5000);
  } finally { killChild(a.child); await mock.close(); }
});

t('G2', 'MCP spawn: hidden window opts + JSON-RPC round trip (seam)', async () => {
  const mcp = require(path.join(AGENT_SRC, 'mcp.js'));
  const home = tmp('home');
  writeAgentFile(home, 'mcp.json', { servers: { srv: { command: 'ELIDED', args: [] } } });
  writeAgentFile(home, 'mcp_policy.json', { allowed: { srv: ['echo'] } });
  let captured = null;
  const stdout = new EventEmitter();
  const fake = {
    pid: 4242, killed: false, kill() {},
    on() {}, stdout, stderr: new EventEmitter(),
    stdin: { write(line) {
      let m = null;
      try { m = JSON.parse(String(line).trim()); } catch (_) { return; }
      if (m.id === undefined) return;
      let result = {};
      if (m.method === 'initialize') result = { capabilities: {} };
      else if (m.method === 'tools/list') result = { tools: [{ name: 'echo' }] };
      else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'echo:' + ((m.params.arguments && m.params.arguments.text) || '') }] };
      setImmediate(() => stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'));
    } },
  };
  mcp.setMcpSpawn((cmd, args, opts) => { captured = { cmd, args, opts }; return fake; });
  try {
    const r = await mcp.callTool(home, 'srv', 'echo', { text: 'hi' }, { timeoutMs: 5000 }, null);
    assert(r.ok && r.text === 'echo:hi', 'round trip');
    assert(captured && captured.cmd === 'ELIDED', 'command from global config');
    assert(captured.opts.windowsHide === true, 'hidden window');
    assert(captured.opts.shell === false, 'no shell');
    assert(!('SUDO_AGENT_TOKEN' in (captured.opts.env || {})), 'token filtered from env');
  } finally {
    mcp.setMcpSpawn(null);
    mcp.disconnectAll(null);
  }
});

t('G3', 'MCP allowlist refusal: denied, server untouched', async () => {
  const proj = fixtureProject();
  const echo = mcpEchoScript();
  const home = tmp('home');
  writeAgentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  writeAgentFile(home, 'mcp_policy.json', { allowed: {} });
  const mock = await mockProvider({});
  const a = spawnAgent({ home, provider: { type: 'local', baseUrl: mock.url, model: '' } });
  const hs = await waitHandshake(a.child);
  try {
    const sid = await newSession(hs.port, a.token, proj);
    const r = await callTool(hs.port, a.token, sid, 'mcp__echo__echo', { text: 'hi' });
    assert(r.body.status === 'denied' && r.body.code === 'mcp_not_allowed', 'allowlist denies');
    const pend = await httpJson(hs.port, a.token, 'GET', '/sessions/' + sid + '/approvals');
    assert(pend.body.pending.length === 0, 'no approval request');
  } finally { killChild(a.child); await mock.close(); }
});

t('G4', 'MCP unknown server: clear error', async () => {
  const proj = fixtureProject();
  const home = tmp('home');
  writeAgentFile(home, 'mcp.json', { servers: {} });
  writeAgentFile(home, 'mcp_policy.json', { allowed: { ghost: ['tool'] } });
  const mock = await mockProvider({});
  const a = spawnAgent({ home, provider: { type: 'local', baseUrl: mock.url, model: '' } });
  const hs = await waitHandshake(a.child);
  try {
    const sid = await newSession(hs.port, a.token, proj);
    const r = await callTool(hs.port, a.token, sid, 'mcp__ghost__tool', {});
    assert(r.body.status === 'need-approval', 'allowed tool asks');
    const ap = await approve(hs.port, a.token, sid, r.body.request.id, 'once');
    assert(ap.body.status === 'error' && String(ap.body.reason).indexOf('serveur MCP inconnu') !== -1, 'clear error, got ' + JSON.stringify(ap.body).slice(0, 200));
  } finally { killChild(a.child); await mock.close(); }
});

// H: deploy gate ----------------------------------------------------------------
t('H1', 'deploy without network policy -> denied, no request', async () => {
  const proj = fixtureProject({ 'package.json': JSON.stringify({ scripts: { deploy: 'node -e "0"' } }) });
  const mock = await mockProvider({});
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const r = await callTool(port, token, sid, 'bash', { command: 'npm run deploy' });
    assert(r.body.status === 'denied' && r.body.code === 'deploy_policy', 'policy denies');
    const pend = await httpJson(port, token, 'GET', '/sessions/' + sid + '/approvals');
    assert(pend.body.pending.length === 0, 'no request created');
  } finally { killChild(a.child); await mock.close(); }
});

t('H2', 'deploy with policy: asks every time, single-use approval, real run', async () => {
  const proj = fixtureProject({ 'package.json': JSON.stringify({ scripts: { deploy: 'node -e "require(\'fs\').writeFileSync(\'deployed.txt\',\'yes\')"' } }) });
  const home = tmp('home');
  writeAgentFile(home, 'net_policy.json', { deployAllowed: true });
  const mock = await mockProvider({});
  const a = spawnAgent({ home, provider: { type: 'local', baseUrl: mock.url, model: '' } });
  const hs = await waitHandshake(a.child);
  try {
    const sid = await newSession(hs.port, a.token, proj);
    const r1 = await callTool(hs.port, a.token, sid, 'bash', { command: 'npm run deploy' });
    assert(r1.body.status === 'need-approval', 'deploy asks (policy open)');
    assert(r1.body.request.deploy === true, 'deploy flagged');
    assert(r1.body.request.summary.indexOf('[DEPLOIEMENT]') === 0, 'deploy summary');
    const ap = await approve(hs.port, a.token, sid, r1.body.request.id, 'session');
    assert(ap.body.status === 'executed', 'approved deploy runs');
    assert(ap.body.note && ap.body.note.indexOf('unique') !== -1, 'single-use note');
    assert(fs.readFileSync(path.join(proj, 'deployed.txt'), 'utf8') === 'yes', 'deploy really ran');
    const r2 = await callTool(hs.port, a.token, sid, 'bash', { command: 'npm run deploy' });
    assert(r2.body.status === 'need-approval', 'asks again: no rule stored');
  } finally { killChild(a.child); await mock.close(); }
});

t('H3', 'non-deploy command unaffected by missing policy', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({});
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const r = await callTool(port, token, sid, 'bash', { command: 'echo hello' });
    assert(r.body.status === 'need-approval' && r.body.request.deploy === false, 'normal ask');
  } finally { killChild(a.child); await mock.close(); }
});

// I: JSON-constraint retries ------------------------------------------------------
t('I1', 'malformed tool args -> retry hint -> recovered TERMINE', async () => {
  const proj = fixtureProject();
  const mock = await mockProvider({ responses: [
    { content: '', rawCalls: [{ id: 'bad-1', name: 'read', argsText: '{oops not json' }] },
    { content: '', toolCalls: [{ name: 'read', args: { file: 'notes.txt' } }] },
    { content: 'done' },
  ] });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const codes = [];
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'read notes' }, (ev, o) => {
      if (ev === 'tool.result') codes.push(o.code || 'ok');
    });
    assert(codes[0] === 'bad_args' && codes[1] === 'ok', 'bad then ok, got ' + JSON.stringify(codes));
    assert(done.status === 'TERMINE', 'recovered TERMINE, got ' + done.status);
    const g = await httpJson(port, token, 'GET', '/sessions/' + sid);
    const first = g.body.messages.filter((m) => m.role === 'tool')[0].content;
    assert(first.indexOf('JSON strict') !== -1, 'retry hint fed back');
  } finally { killChild(a.child); await mock.close(); }
});

t('I2', 'never-valid model -> PARTIEL max_iters (honest)', async () => {
  const proj = fixtureProject();
  const bad = [];
  for (let i = 0; i < 8; i++) bad.push({ content: '', rawCalls: [{ id: 'b' + i, name: 'read', argsText: '{bad' + i }] });
  const mock = await mockProvider({ responses: bad });
  const { a, port, token } = await boot({ type: 'local', baseUrl: mock.url, model: '' });
  try {
    const sid = await newSession(port, token, proj);
    const done = await ssePost(port, token, '/sessions/' + sid + '/messages', { prompt: 'go' }, () => {});
    assert(done.status === 'PARTIEL', 'PARTIEL, got ' + done.status);
    assert(done.stopReason === 'max_iters', 'max_iters, got ' + done.stopReason);
  } finally { killChild(a.child); await mock.close(); }
});

// J: harness contract ---------------------------------------------------------------
t('J1', 'measure harness runs the mock matrix (valid 20/20, mixed 16/20)', async () => {
  const run = (kind) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(AGENT_DIR, 'scripts', 'measure-toolcalls.js'), '--mock', kind, '--trials', '20'],
      { cwd: AGENT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(kind + ' exit ' + code + ': ' + err.slice(-300)))));
  });
  const valid = await run('valid');
  assert(/exec_ok: 20\/20/.test(valid), 'valid matrix 20/20');
  const mixed = await run('mixed');
  assert(/exec_ok: 16\/20/.test(mixed), 'mixed matrix 16/20, got ' + mixed.split('\n').slice(-4).join(' / '));
});

// -- runner ------------------------------------------------------------------
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
  console.log('---');
  console.log('P26: ' + pass + '/' + tests.length + ' passed' + (fails.length ? ' FAILS: ' + fails.join(' ') : ''));
  process.exit(fails.length ? 1 : 0);
}

main();
