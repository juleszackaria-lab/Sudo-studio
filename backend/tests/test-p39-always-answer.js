// P39 agent + chat always answer: project map (a), tolerant paths +
// enriched not_found (b), general-question preload (c), loop rescue +
// deterministic fallback (d). Hermetic: disposable fixture COPIES in tmp,
// mock provider on loopback, real logger into tmp. ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const pmap = require(path.join(AGENT_SRC, 'projectmap.js'));
const boundary = require(path.join(AGENT_SRC, 'boundary.js'));
const modes = require(path.join(AGENT_SRC, 'modes.js'));
const { executeTool } = require(path.join(AGENT_SRC, 'tools.js'));
const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));

const HOST = '127.0.0.1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p39-'));

function tmp(sub) {
  const d = path.join(TMP, sub + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// -- disposable fixture project (a COPY, never a real user project) ---------
function fixtureProject(kind) {
  const dir = tmp('proj');
  if (kind === 'flutter') {
    fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: scanner_num\ndescription: demo\ndependencies:\n  flutter:\n    sdk: flutter\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# ScannerNum\nScan app.\n', 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'maquis-pos', dependencies: { next: '14.0.0' }, scripts: { dev: 'next dev' } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Maquis POS\nPoint of sale.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), 'export default {};\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default function P() {}\n', 'utf8');
  }
  for (const skip of ['node_modules', '.next', 'build', 'dist', '.dart_tool', '.git']) {
    fs.mkdirSync(path.join(dir, skip, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, skip, 'inner', 'x.txt'), 'x', 'utf8');
  }
  return dir;
}

// -- scripted mock provider (same shape as the P26 suite) -------------------
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
        const next = queue.length ? queue.shift() : { content: 'default-done' };
        // P43-2: questions stream (streamChat, stream:true) -> answer SSE.
        if (body && body.stream === true) {
          const txt = String(next.content === undefined ? '' : next.content);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((t, i) => ({ id: t.id || ('call-' + chats.length + '-' + i),
            type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
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
      resolve({ server: srv, port: srv.address().port, chats,
        close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function sysTexts(body) {
  return (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
}
function toolTexts(body) {
  return (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content).join('\n---\n');
}

// -- A. project map ----------------------------------------------------------
async function tMap() {
  const dir = fixtureProject('node');
  const m = pmap.buildProjectMap(dir);
  assert(m.ok, 'map ok');
  assert(m.type === 'next.js', 'type next.js, got ' + m.type);
  assert(m.keyFiles.indexOf('package.json') !== -1, 'keys package.json');
  assert(m.keyFiles.indexOf('README.md') !== -1, 'keys README');
  assert(m.entries <= 60, 'entries<=60');
  assert(m.tokens <= pmap.MAP_TOKEN_BUDGET, 'tokens in budget');
  for (const s of pmap.MAP_SKIP) assert(m.text.indexOf(s + '/') === -1 && m.text.indexOf(s + '\n') === -1, 'skip ' + s);
  const fl = pmap.buildProjectMap(fixtureProject('flutter'));
  assert(fl.ok && fl.type === 'flutter', 'type flutter');
  const bad = pmap.buildProjectMap(path.join(dir, 'nope'));
  assert(!bad.ok, 'bad root not ok');
}

// -- B. tolerant resolution --------------------------------------------------
async function tBoundary() {
  const dir = tmp('case');
  fs.mkdirSync(path.join(dir, 'Src'));
  fs.writeFileSync(path.join(dir, 'ReadMe.MD'), 'hi', 'utf8');
  fs.writeFileSync(path.join(dir, 'Src', 'App.JS'), 'x', 'utf8');
  const f1 = boundary.fixCaseSegments(dir, path.join(dir, 'readme.md'), path.posix);
  assert(f1 === path.join(dir, 'ReadMe.MD'), 'case fix file');
  const f2 = boundary.fixCaseSegments(dir, path.join(dir, 'src', 'app.js'), path.posix);
  assert(f2 === path.join(dir, 'Src', 'App.JS'), 'case fix nested');
  assert(boundary.fixCaseSegments(dir, path.join(dir, 'nope', 'x.js'), path.posix) === null, 'partial null');
  assert(boundary.fixCaseSegments(dir, '/tmp', path.posix) === null, 'escape null');
  // posix behavior unchanged
  const r = boundary.resolveInRoot(dir, 'ReadMe.MD');
  assert(r.ok && r.rel === 'ReadMe.MD', 'posix exact');
  assert(!boundary.resolveInRoot(dir, '../x').ok, 'posix outside');
}

// -- C. enriched not_found ---------------------------------------------------
async function tTools() {
  const dir = fixtureProject('node');
  const home = tmp('home');
  const store = new SessionStore({ dir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: dir });
  const ctx = { root: dir, sessionId: s.id, session: s, store, log: null, corr: 't',
    run: { calls: [], created: [] }, home, mode: 'build',
    sessionRules: new Set(), projectRules: new Set() };
  const miss = await executeTool(ctx, 'read', { file: 'readme.md' }, {});
  assert(miss.status === 'error' && miss.code === 'not_found', 'code stays not_found');
  assert(miss.reason.indexOf('introuvable : readme.md') !== -1, 'path in message');
  assert(miss.reason.indexOf('fichiers proches : [README.md]') !== -1, 'close names, got: ' + miss.reason.slice(0, 200));
  assert(miss.reason.indexOf('contenu du dossier parent : [') !== -1, 'parent listing');
  const hit = await executeTool(ctx, 'read', { file: 'README.md' }, {});
  assert(hit.status === 'done', 'existing read still done');
  const lmiss = await executeTool(ctx, 'list', { dir: 'nodir' }, {});
  assert(lmiss.code === 'not_found' && lmiss.reason.indexOf('contenu du dossier parent') !== -1, 'list enriched');
}

// -- D. system prompts -------------------------------------------------------
async function tModes() {
  assert(modes.buildSystem().indexOf('before reading a path') !== -1, 'build lists first');
  assert(modes.planSystem().indexOf('before reading a path') !== -1, 'plan lists first');
}

// -- E/F/G/H. turn-level integration -----------------------------------------
async function driveTurn(proj, prompt, responses, opts) {
  opts = opts || {};
  const home = tmp('home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ dir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const mock = await mockProvider({ responses });
  try {
    const out = await runTurn({
      store, sessionId: s.id, prompt, corr: 'p39',
      provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
      toolsCtx: { home, sessionRules: new Map(), pending: new Map() },
      runs: new Map(), log,
    });
    const end = store.get(s.id);
    const last = end.messages[end.messages.length - 1];
    let journal = '';
    try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
    return { out, last, chats: mock.chats, journal };
  } finally {
    await mock.close();
  }
}

async function tLoopRescue() {
  const dir = fixtureProject('node');
  const same = { toolCalls: [{ name: 'read', args: { file: 'readme.md' } }] };
  const r = await driveTurn(dir, 'lis readme.md', [same, same, same, { content: 'REPONSE-SECOURS-OK' }]);
  assert(r.out.status === 'done' && r.out.runStatus === 'PARTIEL', 'loop => PARTIEL, got ' + JSON.stringify(r.out));
  assert(r.last.role === 'assistant' && r.last.content === 'REPONSE-SECOURS-OK', 'rescue answer stored');
  assert(r.chats.length === 4, '3 tool rounds + rescue, got ' + r.chats.length);
  assert(!('tools' in r.chats[3]) || r.chats[3].tools === undefined, 'rescue has no tools');
  assert(toolTexts(r.chats[1]).indexOf('fichiers proches') !== -1, 'model saw enriched error');
  assert(r.journal.indexOf('repeat loop') !== -1, 'journal loop');
  assert(r.journal.indexOf('reponse secours IA') !== -1, 'journal rescue');
  assert(sysTexts(r.chats[0]).indexOf('[carte du projet]') !== -1, 'map injected');
  assert(sysTexts(r.chats[0]).indexOf('README.md') !== -1, 'map lists README');
}

async function tLoopFallback() {
  const dir = fixtureProject('node');
  const same = { toolCalls: [{ name: 'read', args: { file: 'readme.md' } }] };
  const r = await driveTurn(dir, 'lis readme.md', [same, same, same, { content: '' }]);
  assert(r.out.runStatus === 'PARTIEL', 'fallback => PARTIEL');
  assert(r.last.role === 'assistant' && r.last.content.indexOf('generee sans IA') !== -1, 'deterministic label');
  assert(r.last.content.indexOf('read|readme.md') !== -1, 'loop key explained');
  assert(r.journal.indexOf('reponse secours deterministe') !== -1, 'journal fallback');
}

async function tPreload() {
  const dir = fixtureProject('node');
  const r = await driveTurn(dir, 'explique ce projet', [{ content: 'ok-explique' }]);
  assert(r.out.runStatus === 'TERMINE', 'general Q answered');
  assert(sysTexts(r.chats[0]).indexOf('[contexte precharge') !== -1, 'preload present');
  assert(sysTexts(r.chats[0]).indexOf('Point of sale') !== -1, 'README preloaded');
  assert(sysTexts(r.chats[0]).indexOf('next') !== -1, 'deps preloaded');
  assert(r.journal.indexOf('contexte general precharge') !== -1, 'journal preload');
  assert(r.journal.indexOf('carte projet injectee') !== -1, 'journal map');
  const r2 = await driveTurn(dir, 'corrige le test login', [{ content: 'ok-task' }]);
  assert(sysTexts(r2.chats[0]).indexOf('[contexte precharge') === -1, 'no preload for tasks');
}

async function main() {
  const tests = [tMap, tBoundary, tTools, tModes, tLoopRescue, tLoopFallback, tPreload];
  let pass = 0;
  for (const t of tests) {
    try {
      await t();
      pass += 1;
      console.log('ok - ' + t.name);
    } catch (e) {
      console.log('FAIL - ' + t.name + ' :: ' + ((e && e.message) || e));
      process.exitCode = 1;
    }
  }
  console.log(pass + '/' + tests.length + ' P39 tests passed');
}

if (require.main === module) main().catch((e) => { console.log('FATAL :: ' + ((e && e.message) || e)); process.exitCode = 1; });
module.exports = {};
