/**
 * P31(d): agent server test against the INSTALLED product (Windows CI).
 * Own silent install/uninstall (independent from smoke-install.ps1), then:
 *   resolve : the installed extension's AgentServer resolves server.js to
 *             <install>\sudo-agent\src\server.js (P31-a), file on disk.
 *   missing : server.js deliberately renamed -> start() rejects with the
 *             exact 'server.js introuvable a <path>' (P31-b), spawn never
 *             attempted; the file is restored byte-identical (sha256).
 *   e2e     : real installed server (product .exe, ELECTRON_RUN_AS_NODE) +
 *             scripted stub provider: handshake, /health, turn 1 ECHEC
 *             (need_approval, nothing written), approval executes the write,
 *             turn 2 TERMINE, project copy holds ONLY the requested file.
 * Stdlib only, ASCII only. Exit 0 = all PASS, 1 = any FAIL.
 * Usage:
 *   node agent-e2e.js --installer <SudoStudio-Setup.exe> --installDir <dir>
 *     --outDir <dir> [--mode all|resolve|missing|e2e] [--skipInstall] [--skipUninstall]
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const checks = [];
let nFail = 0;
function say(line) { process.stdout.write(line + '\n'); }
function rec(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) nFail++;
  say('[AGENT-E2E] ' + name + ' ' + (ok ? 'PASS' : 'FAIL') + (detail ? ' ' + detail : ''));
}
function fail(name, detail) { rec(name, false, detail); }
function args() {
  const out = { mode: 'all', skipInstall: false, skipUninstall: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--installer') out.installer = a[++i];
    else if (a[i] === '--installDir') out.installDir = a[++i];
    else if (a[i] === '--outDir') out.outDir = a[++i];
    else if (a[i] === '--mode') out.mode = a[++i];
    else if (a[i] === '--skipInstall') out.skipInstall = true;
    else if (a[i] === '--skipUninstall') out.skipUninstall = true;
    else { say('unknown arg: ' + a[i]); process.exit(2); }
  }
  for (const k of ['installer', 'installDir', 'outDir']) {
    if (!out[k]) { say('missing --' + k); process.exit(2); }
  }
  if (['all', 'resolve', 'missing', 'e2e'].indexOf(out.mode) === -1) { say('bad --mode'); process.exit(2); }
  return out;
}
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitFor(cond, timeoutMs, stepMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function poll() {
      let v = false;
      try { v = cond(); } catch (_) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(poll, stepMs || 2000);
    })();
  });
}

async function doInstall(o) {
  if (o.skipInstall) { rec('install', true, 'skipped by flag'); return true; }
  if (!fs.existsSync(o.installer)) { fail('install', 'installer not found: ' + o.installer); return false; }
  if (fs.existsSync(o.installDir)) { fail('install', 'install dir already exists: ' + o.installDir); return false; }
  const log = path.join(o.outDir, 'innosetup-e2e.log');
  const r = spawnSync(o.installer, ['/SILENT', '/NORESTART', '/DIR=' + o.installDir, '/LOG=' + log], { timeout: 600000 });
  const exe = path.join(o.installDir, 'SudoStudio.exe');
  if (!r || r.status !== 0 || !fs.existsSync(exe)) {
    fail('install', 'exit=' + (r && r.status) + ' exe=' + fs.existsSync(exe));
    return false;
  }
  rec('install', true, 'exit=0 dir=' + o.installDir);
  return true;
}

async function doUninstall(o) {
  if (o.skipUninstall) { rec('uninstall', true, 'skipped by flag'); return true; }
  const unins = path.join(o.installDir, 'unins000.exe');
  if (!fs.existsSync(unins)) { fail('uninstall', 'unins000.exe missing'); return false; }
  const r = spawnSync(unins, ['/SILENT', '/NORESTART'], { timeout: 300000 });
  const gone = await waitFor(() => !fs.existsSync(path.join(o.installDir, 'SudoStudio.exe')) &&
    !fs.existsSync(path.join(o.installDir, 'backend.exe')) &&
    !fs.existsSync(path.join(o.installDir, 'runtime.exe')), 180000, 5000);
  if (!gone) { fail('uninstall', 'exes remain'); return false; }
  rec('uninstall', true, 'exit=' + (r && r.status));
  return true;
}

function loadAgentServer(o) {
  const installed = path.join(o.installDir, 'extensions', 'sudo-ai', 'src', 'agent', 'AgentServer.js');
  const repo = path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'agent', 'AgentServer.js');
  // The installer ships the extension SOURCE (sudo-ai-extension/); start.bat
  // syncs it to extensions\sudo-ai on first launch. Either file is the same
  // shipped code; prefer the installed one, fall back to the repo one.
  const file = fs.existsSync(installed) ? installed : repo;
  return { mod: require(file), file };
}

async function modeResolve(o) {
  const { mod, file } = loadAgentServer(o);
  const extDir = path.join(o.installDir, 'extensions', 'sudo-ai');
  const got = mod.defaultServerJs(extDir);
  const want = path.join(o.installDir, 'sudo-agent', 'src', 'server.js');
  rec('resolve-require', true, file);
  if (got !== want) { fail('resolve-path', 'got ' + got + ' want ' + want); return; }
  rec('resolve-path', true, got);
  if (!fs.existsSync(want)) { fail('resolve-exists', 'not on disk: ' + want); return; }
  rec('resolve-exists', true, sha256(want).slice(0, 12));
  const srv = new mod.AgentServer({ provider: { type: 'local' }, extensionDir: extDir });
  const t = srv.resolveTarget();
  if (t.args[0] !== want) { fail('resolve-target', t.args[0]); return; }
  rec('resolve-target', true, t.mode + ' ' + t.args[0]);
}

async function modeMissing(o) {
  const { mod, file } = loadAgentServer(o);
  rec('missing-require', true, file);
  const extDir = path.join(o.installDir, 'extensions', 'sudo-ai');
  const want = path.join(o.installDir, 'sudo-agent', 'src', 'server.js');
  if (!fs.existsSync(want)) { fail('missing-setup', 'not on disk: ' + want); return; }
  const before = sha256(want);
  const hidden = want + '.p31-hidden';
  const lines = [];
  const log = { info: (m) => lines.push('I ' + m), warn: (m) => lines.push('W ' + m), error: (m) => lines.push('E ' + m) };
  fs.renameSync(want, hidden);
  try {
    let spawned = false;
    const srv = new mod.AgentServer({ provider: { type: 'local' }, extensionDir: extDir,
      logger: log, spawnFn: () => { spawned = true; throw new Error('must not spawn'); } });
    let err = null;
    try { await srv.start(); } catch (e) { err = e; }
    try { srv.stop(); } catch (_) {}
    const wantMsg = 'server.js introuvable \u00e0 ' + want;
    if (!err) { fail('missing-message', 'start() did not reject'); return; }
    if (err.message !== wantMsg) { fail('missing-message', 'got: ' + err.message); return; }
    rec('missing-message', true, 'exact message');
    if (spawned) { fail('missing-no-spawn', 'spawn attempted'); return; }
    rec('missing-no-spawn', true, 'never attempted');
    if (!lines.some((l) => l === 'E ' + wantMsg)) { fail('missing-journal', JSON.stringify(lines)); return; }
    rec('missing-journal', true, 'exact path journaled');
  } finally {
    if (fs.existsSync(hidden)) fs.renameSync(hidden, want);
  }
  if (!fs.existsSync(want) || sha256(want) !== before) { fail('missing-restored', 'not byte-identical'); return; }
  rec('missing-restored', true, 'sha256 ' + before.slice(0, 12));
}

function stubProvider(script) {
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
  return stub;
}

function launchInstalled(o, serverJs, token, providerJson, errFile) {
  const exe = path.join(o.installDir, 'SudoStudio.exe');
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    SUDO_AGENT_TOKEN: token,
    SUDO_AGENT_PORT: '0',
    SUDO_AGENT_PROVIDER: providerJson,
    SUDO_STUDIO_HOME: path.join(o.outDir, 'agent-home'),
    SUDO_AGENT_STORE: path.join(o.outDir, 'agent-store'),
    SUDO_STUDIO_LOGS: path.join(o.outDir, 'agent-logs'),
  });
  for (const k of Object.keys(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE') continue;
    if (/^ELECTRON_/i.test(k) || k === 'NODE_OPTIONS') delete env[k];
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(exe, [serverJs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  const errStream = fs.createWriteStream(errFile);
  child.stderr.on('data', (c) => { try { errStream.write(c); } catch (_) {} });
  return child;
}

async function modeE2e(o) {
  const serverJs = path.join(o.installDir, 'sudo-agent', 'src', 'server.js');
  if (!fs.existsSync(serverJs)) { fail('e2e-setup', 'no installed server.js: ' + serverJs); return; }
  const script = [
    { content: '', tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file: 'hello.txt', content: 'bonjour e2e\n' }) } }] },
    { content: '', tool_calls: [{ id: 'call-2', type: 'function',
      function: { name: 'done', arguments: JSON.stringify({ summary: 'hello.txt demande, approbation requise' }) } }] },
    { content: 'termine.', tool_calls: [] },
  ];
  const stub = stubProvider(script);
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = 'http://127.0.0.1:' + stub.address().port;
  const token = crypto.randomBytes(32).toString('hex');
  const provider = JSON.stringify({ type: 'local', baseUrl: stubUrl, model: 'scripted-e2e' });
  const errFile = path.join(o.outDir, 'agent-stderr.log');
  const child = launchInstalled(o, serverJs, token, provider, errFile);
  let port = 0;
  try {
    let out = '';
    const t0 = Date.now();
    const hs = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), 120000);
      child.stdout.on('data', (c) => {
        out += c.toString('utf8');
        const nl = out.indexOf('\n');
        if (nl !== -1) { clearTimeout(to); resolve(out.slice(0, nl)); }
      });
      child.on('exit', (code) => { clearTimeout(to); resolve('EXIT:' + code); });
    });
    if (!hs || hs.indexOf('EXIT:') === 0) {
      fail('e2e-handshake', 'no handshake (' + (hs || 'timeout ' + (Date.now() - t0) + 'ms') + '), see agent-stderr.log');
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(hs.trim()); } catch (_) { parsed = null; }
    if (!parsed || parsed.ready !== true || !parsed.port) { fail('e2e-handshake', 'bad: ' + hs.slice(0, 200)); return; }
    port = parsed.port;
    rec('e2e-handshake', true, 'port=' + port);
    const api = (method, pth, body) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: pth, method, timeout: 30000,
        headers: Object.assign({ Authorization: 'Bearer ' + token },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let b = null;
          try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = { _raw: raw.slice(0, 200) }; }
          resolve({ status: res.statusCode, body: b });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    const sse = (pth, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: pth, method: 'POST', timeout: 120000,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload), Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ' ' + raw.slice(0, 200))));
          return;
        }
        let buf = '', cur = 'message';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line.indexOf('event:') === 0) { cur = line.slice(6).trim() || 'message'; continue; }
            if (line.indexOf('data:') !== 0) continue;
            let obj = null;
            try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (cur === 'turn.done') { try { res.destroy(); } catch (_) {} resolve(obj); return; }
            if (cur === 'turn.error') { try { res.destroy(); } catch (_) {} reject(new Error(obj.error || 'turn.error')); return; }
            cur = 'message';
          }
        });
        res.on('end', () => reject(new Error('stream ended without turn.done')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    const h = await api('GET', '/health');
    if (h.status !== 200 || !h.body || h.body.ok !== true) { fail('e2e-health', JSON.stringify(h.body)); return; }
    rec('e2e-health', true, 'ok');
    const proj = path.join(o.outDir, 'test-proj');
    if (fs.existsSync(proj)) fs.rmSync(proj, { recursive: true, force: true });
    fs.mkdirSync(proj, { recursive: true });
    const s = await api('POST', '/sessions', { title: 'p31-ci', projectRoot: proj });
    if (s.status !== 201) { fail('e2e-session', JSON.stringify(s.body)); return; }
    const sid = s.body.id;
    rec('e2e-session', true, sid);
    const t1 = await sse('/sessions/' + sid + '/messages', { prompt: 'cree hello.txt' });
    if (t1.status !== 'ECHEC' || !/need_approval/.test(t1.reason || '')) {
      fail('e2e-turn1', 'want honest ECHEC/need_approval, got ' + t1.status + ' ' + (t1.reason || '')); return;
    }
    if (fs.existsSync(path.join(proj, 'hello.txt'))) { fail('e2e-turn1', 'written before approval'); return; }
    rec('e2e-turn1', true, 'honest ECHEC, nothing written');
    const pend = await api('GET', '/sessions/' + sid + '/approvals');
    if (pend.status !== 200 || !pend.body || pend.body.pending.length !== 1) {
      fail('e2e-approval-pending', JSON.stringify(pend.body)); return;
    }
    const dec = await api('POST', '/sessions/' + sid + '/approvals', { requestId: pend.body.pending[0].id, decision: 'once' });
    if (dec.status !== 200 || dec.body.status !== 'executed') { fail('e2e-approve', JSON.stringify(dec.body)); return; }
    if (!fs.existsSync(path.join(proj, 'hello.txt')) ||
        fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8') !== 'bonjour e2e\n') {
      fail('e2e-approve', 'bad content'); return;
    }
    rec('e2e-approve', true, 'executed, scripted content');
    const t2 = await sse('/sessions/' + sid + '/messages', { prompt: 'confirme.' });
    if (t2.status !== 'TERMINE') { fail('e2e-turn2', 'got ' + t2.status + ' ' + (t2.reason || '')); return; }
    rec('e2e-turn2', true, 'TERMINE');
    const left = [];
    (function walk(d, rel) {
      for (const f of fs.readdirSync(d)) {
        const a = path.join(d, f), r = rel ? rel + '/' + f : f;
        if (fs.statSync(a).isDirectory()) walk(a, r); else left.push(r);
      }
    })(proj, '');
    if (left.length !== 1 || left[0] !== 'hello.txt') { fail('e2e-only-file', JSON.stringify(left)); return; }
    rec('e2e-only-file', true, 'hello.txt only');
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
    await sleep(1500);
    try { child.kill('SIGKILL'); } catch (_) {}
    await new Promise((r) => stub.close(r));
  }
}

async function main() {
  const o = args();
  fs.mkdirSync(o.outDir, { recursive: true });
  say('installer: ' + o.installer);
  say('installdir: ' + o.installDir);
  say('mode: ' + o.mode);
  if (!await doInstall(o)) return done(o);
  try {
    if (o.mode === 'all' || o.mode === 'resolve') await modeResolve(o).catch((e) => fail('resolve', String((e && e.message) || e)));
    if (o.mode === 'all' || o.mode === 'missing') await modeMissing(o).catch((e) => fail('missing', String((e && e.message) || e)));
    if (o.mode === 'all' || o.mode === 'e2e') await modeE2e(o).catch((e) => fail('e2e', String((e && e.stack) || e).slice(0, 500)));
  } finally {
    await doUninstall(o);
  }
  done(o);
}
function done(o) {
  const lines = ['Sudo Studio agent-e2e summary', 'date: ' + new Date().toISOString(), ''];
  for (const c of checks) lines.push('[' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.name + ' ' + c.detail);
  lines.push('');
  lines.push('FAIL=' + nFail);
  fs.writeFileSync(path.join(o.outDir, 'e2e-summary.txt'), lines.join('\n'), 'utf8');
  if (nFail > 0) { say('AGENT-E2E RESULT: FAIL (' + nFail + ' failed)'); process.exit(1); }
  say('AGENT-E2E RESULT: SUCCESS (' + checks.length + ' checks)');
}
main().catch((e) => { say('AGENT-E2E RESULT: FAIL (' + String((e && e.stack) || e).slice(0, 500) + ')'); process.exit(1); });
