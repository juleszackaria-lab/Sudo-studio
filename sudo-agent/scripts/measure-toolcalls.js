// Tool-call success measurement (P26 proofs): N trials against a real or
// mocked provider through a real agent server. Each trial = fresh session,
// one turn asking for exactly one `read` call. Prints the FULL table plus
// unrounded fractions. Stdlib only, ASCII only.
//
// Usage:
//   node scripts/measure-toolcalls.js --base-url http://127.0.0.1:5000 \
//     --model Qwen2.5-Coder-1.5B --trials 20 --label local-1.5b
//   node scripts/measure-toolcalls.js --mock valid --trials 20
//   node scripts/measure-toolcalls.js --mock mixed --trials 20
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER_JS = path.join(__dirname, '..', 'src', 'server.js');
const HOST = '127.0.0.1';
const PROMPT = 'Call the read tool with {"file": "README.md"} exactly once, then reply DONE.';

function args() {
  const out = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const m = /^--([a-z-]+)(=(.*))?$/.exec(raw[i] || '');
    if (!m) continue;
    out[m[1]] = m[3] !== undefined ? m[3] : (raw[i + 1] && raw[i + 1][0] !== '-' ? raw[++i] : 'true');
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -- internal scripted mock provider (harness self-test; labeled MOCK) -------
function startMock(kind, trials) {
  const responses = [];
  for (let t = 0; t < trials; t++) {
    const m = t % 5;
    if (kind === 'mixed' && m === 0) {
      responses.push({ content: 'DONE without tools' });
    } else if (kind === 'mixed' && m === 1) {
      responses.push({ rawCalls: [{ id: 'bad-' + t, name: 'read', argsText: '{oops not json' }] });
      responses.push({ toolCalls: [{ name: 'read', args: { file: 'README.md' } }] });
      responses.push({ content: 'DONE' });
    } else {
      responses.push({ toolCalls: [{ name: 'read', args: { file: 'README.md' } }] });
      responses.push({ content: 'DONE' });
    }
  }
  let n = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1.5b', n_ctx: 2048 }] }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'DONE' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const next = n < responses.length ? responses[n++] : { content: 'DONE' };
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((t, i) => ({ id: 'c' + n + '-' + i, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
        }
        if (next.rawCalls) {
          msg.tool_calls = next.rawCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argsText } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-x', choices: [{ message: msg }] }));
      });
      return;
    }
    res.writeHead(404, {}); res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, HOST, () => resolve({ server: srv, url: 'http://' + HOST + ':' + srv.address().port }));
  });
}

// -- HTTP helpers -------------------------------------------------------------
function httpJson(port, token, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, path: p, method, timeout: timeoutMs || 30000,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
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
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sseTurn(port, token, sid, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const evts = [];
    let done = false;
    const win = (r) => { if (!done) { done = true; resolve(r); } };
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const payload = JSON.stringify({ prompt });
    const req = http.request({ host: HOST, port, path: '/sessions/' + sid + '/messages', method: 'POST', timeout: timeoutMs,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { fail(new Error('HTTP ' + res.statusCode)); return; }
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
          evts.push({ type: cur, obj });
          if (cur === 'turn.done') { win({ done: obj, evts }); try { res.destroy(); } catch (_) {} return; }
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

function getModels(baseUrl) {
  return new Promise((resolve) => {
    const u = new URL(baseUrl + '/v1/models');
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request(u, { method: 'GET', timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          resolve(Array.isArray(d.data) ? d.data : []);
        } catch (_) { resolve([]); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve([]); });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function main() {
  const o = args();
  const trials = Math.max(1, Math.min(100, parseInt(o.trials || '20', 10) || 20));
  const label = o.mock ? ('MOCK-' + o.mock) : String(o.label || 'run');
  const trialTimeout = parseInt(o['trial-timeout'] || '120000', 10) || 120000;

  let mock = null;
  let baseUrl = o['base-url'];
  let model = o.model || '';
  let type = o.type || 'local';
  let apiKey = o['api-key'] || null;
  if (o.mock) {
    if (o.mock !== 'valid' && o.mock !== 'mixed') throw new Error('--mock must be valid|mixed');
    mock = await startMock(o.mock, trials);
    baseUrl = mock.url;
    model = 'mock-1.5b';
    type = 'local';
  }
  if (!baseUrl) throw new Error('missing --base-url (or --mock valid|mixed)');

  const listed = await getModels(baseUrl);
  const listedStr = listed.length ? listed.map((m) => m.id + (m.n_ctx ? ' (n_ctx=' + m.n_ctx + ')' : '')).join(', ') : '<empty>';

  // Fixture project (disposable tmp copy, never a real project).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# Fixture\n\nFirst line here.\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'alpha\n', 'utf8');

  // Agent server.
  const token = crypto.randomBytes(32).toString('hex');
  const home = path.join(tmp, 'home');
  const provider = { type, baseUrl, model, apiKey };
  const child = spawn(process.execPath, [SERVER_JS], {
    env: Object.assign({}, process.env, {
      SUDO_AGENT_TOKEN: token, SUDO_AGENT_PORT: '0',
      SUDO_AGENT_PROVIDER: JSON.stringify(provider),
      SUDO_STUDIO_HOME: home,
      SUDO_STUDIO_LOGS: path.join(home, 'logs'),
      SUDO_AGENT_STORE: path.join(home, 'store'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('agent handshake timeout')), 15000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl).trim()).port); }
      catch (e) { reject(new Error('bad handshake')); }
    });
    child.on('exit', () => reject(new Error('agent exited during handshake')));
  });

  console.log('MEASURE tool-calls | label=' + label + ' | trials=' + trials);
  console.log('provider: type=' + type + ' model=' + (model || '(auto)') + ' models=[' + listedStr + ']');
  console.log('trial | called | valid | exec_ok | iters | ms | status | note');
  const rows = [];
  for (let t = 1; t <= trials; t++) {
    const t0 = Date.now();
    let called = 0, valid = 0, execOk = 0, status = '?', note = '';
    try {
      const s = await httpJson(port, token, 'POST', '/sessions', { title: 'm' + t, projectRoot: proj });
      if (s.status !== 201) throw new Error('session ' + s.status);
      const r = await sseTurn(port, token, s.body.id, PROMPT, trialTimeout);
      status = (r.done && r.done.status) || '?';
      for (const e of r.evts) {
        if (e.type === 'tool.start') called += 1;
        if (e.type === 'tool.result' && e.obj && e.obj.ok) {
          valid += 1;
          if (e.obj.tool === 'read') execOk += 1;
        }
        if (e.type === 'tool.result' && e.obj && !e.obj.ok && !note) note = String(e.obj.code || 'tool-fail');
      }
      if (!called) note = note || 'no tool call';
      else if (!valid) note = note || 'no valid result';
    } catch (e) {
      status = 'ERROR';
      note = String((e && e.message) || e).slice(0, 60);
    }
    const ms = Date.now() - t0;
    rows.push({ t, called: called > 0 ? 1 : 0, valid: valid > 0 ? 1 : 0, execOk: execOk > 0 ? 1 : 0, iters: called, ms, status, note });
    console.log(t + ' | ' + (called > 0 ? 1 : 0) + ' | ' + (valid > 0 ? 1 : 0) + ' | ' + (execOk > 0 ? 1 : 0) + ' | ' + called + ' | ' + ms + ' | ' + status + ' | ' + note);
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const n = rows.length;
  const pct = (x) => (100 * x / n).toFixed(1) + '%';
  console.log('---');
  console.log('SUMMARY label=' + label + ' n=' + n);
  console.log('called : ' + sum('called') + '/' + n + ' (' + pct(sum('called')) + ')');
  console.log('valid  : ' + sum('valid') + '/' + n + ' (' + pct(sum('valid')) + ')');
  console.log('exec_ok: ' + sum('execOk') + '/' + n + ' (' + pct(sum('execOk')) + ')');

  try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (_) {}
  if (mock) { try { mock.server.close(); } catch (_) {} await sleep(200); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

main().then(() => {}, (e) => { console.error('MEASURE FAILED: ' + ((e && e.message) || e)); process.exit(1); });
