// P43 context: (1) runtime fit-based n_ctx for <=3B (markers; the math is
// unit-tested in test_p1_openai_mock.py), (2) QUESTIONS = deterministic
// context + ONE streamed call (no free tools), (3) per-part budgets, terse
// systems on small, "suite : lignes X-Y" read hints, saturation rescue that
// NEVER abandons, (4) AI recommendations already single-call+bounded
// (markers). Hermetic: fixture COPIES in tmp, mock provider, real logger.
// ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const pmap = require(path.join(AGENT_SRC, 'projectmap.js'));
const modes = require(path.join(AGENT_SRC, 'modes.js'));
const profiles = require(path.join(AGENT_SRC, 'profiles.js'));
const { executeTool } = require(path.join(AGENT_SRC, 'tools.js'));
const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));

const HOST = '127.0.0.1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p43-'));

function tmp(sub) {
  const d = path.join(TMP, sub + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// -- disposable fixture project (a COPY, never a real user project) ---------
function fixtureProject() {
  const dir = tmp('proj');
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'maquis-pos', dependencies: { next: '14.0.0', react: '18.2.0' }, scripts: { dev: 'next dev' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Maquis POS\nPoint of sale.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'next.config.mjs'), 'export default {};\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default function P() {}\n', 'utf8');
  const big = [];
  for (let i = 1; i <= 10; i++) big.push('ligne ' + i);
  fs.writeFileSync(path.join(dir, 'long.txt'), big.join('\n') + '\n', 'utf8');
  return dir;
}

// -- scripted mock provider (JSON for chatOnce, SSE for streamChat) ---------
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
        if (next.fail) { // provider outage simulation
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"boom"}');
          return;
        }
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

async function driveTurn(proj, prompt, responses, opts) {
  opts = opts || {};
  const home = tmp('home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ dir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const mock = await mockProvider({ responses });
  const events = [];
  const oldCtx = process.env.SUDO_AGENT_CTX_TOKENS;
  if (opts.ctxTokens !== undefined) process.env.SUDO_AGENT_CTX_TOKENS = String(opts.ctxTokens);
  try {
    const out = await runTurn({
      store, sessionId: s.id, prompt, corr: 'p43',
      provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: 'mock-model' },
      toolsCtx: { home, sessionRules: new Map(), pending: new Map() },
      runs: new Map(), log,
      onEvent: (e) => { try { events.push(e); } catch (_) {} },
    });
    const end = store.get(s.id);
    const last = end.messages[end.messages.length - 1];
    let journal = '';
    try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
    return { out, last, chats: mock.chats, journal, events };
  } finally {
    if (opts.ctxTokens !== undefined) {
      if (oldCtx === undefined) delete process.env.SUDO_AGENT_CTX_TOKENS;
      else process.env.SUDO_AGENT_CTX_TOKENS = oldCtx;
    }
    await mock.close();
  }
}

// File journal lines are flat text: "... msg | k=v k=v ...".
function journalFields(journal, msg) {
  for (const line of String(journal || '').split('\n')) {
    if (line.indexOf(' ' + msg + ' |') === -1) continue;
    const fields = {};
    const re = /([A-Za-z_][A-Za-z0-9_]*)=(-?\d+)/g;
    let m = null;
    while ((m = re.exec(line)) !== null) fields[m[1]] = parseInt(m[2], 10);
    return fields;
  }
  return null;
}

// -- Q. questions path -------------------------------------------------------
async function tQuestionSingleCall() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'explique ce projet', [{ content: 'REPONSE-Q-OK' }]);
  assert(r.out.status === 'done' && r.out.runStatus === 'TERMINE', 'question TERMINE, got ' + JSON.stringify(r.out));
  assert(r.chats.length === 1, 'ONE model call, got ' + r.chats.length);
  assert(!('tools' in r.chats[0]) || r.chats[0].tools === undefined, 'no tools on the question call');
  assert(r.last.role === 'assistant' && r.last.content === 'REPONSE-Q-OK', 'answer stored');
  const deltas = r.events.filter((e) => e && e.type === 'message.delta');
  assert(deltas.length >= 1, 'streamed deltas, got ' + r.events.length + ' events');
  assert(r.journal.indexOf('question envoyee') !== -1, 'journal sent');
  assert(r.journal.indexOf('question repondue') !== -1, 'journal answered');
  assert(r.journal.indexOf('budget parties') === -1, 'no loop budget on questions');
}

async function tQuestionContext() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'explique ce projet', [{ content: 'ok' }]);
  const sys = sysTexts(r.chats[0]);
  assert(sys.indexOf('[carte du projet]') !== -1, 'map injected');
  assert(sys.indexOf('[contexte precharge') !== -1, 'preload injected');
  assert(sys.indexOf('[contexte question]') !== -1, 'question context injected');
  assert(sys.indexOf('Point of sale') !== -1, 'README head present');
  assert(sys.indexOf('"react": "18.2.0"') !== -1 || sys.indexOf('react') !== -1, 'manifest head present');
  assert(r.journal.indexOf('carte projet injectee') !== -1, 'map proof line kept');
  assert(r.journal.indexOf('contexte general precharge') !== -1, 'preload proof line kept');
}

async function tQuestionDeterministic() {
  const dir = fixtureProject();
  const r1 = await driveTurn(dir, 'explique ce projet', [{ content: 'a' }]);
  const r2 = await driveTurn(dir, 'explique ce projet', [{ content: 'b' }]);
  const q = (r) => (r.chats[0].messages || []).filter((m) => m.role === 'system' && String(m.content || '').indexOf('[contexte question]') === 0).map((m) => m.content).join('');
  assert(q(r1).length > 100, 'context built');
  assert(q(r1) === q(r2), 'same project -> same bytes');
}

async function tTaskKeepsLoop() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'corrige le bug login', [{ content: 'ok-task' }]);
  // P49-1/2: a task takes the loop path, but free text is no longer a valid
  // ACTION output: the scripted model never calls a tool, so the verdict is
  // honestly PARTIEL (no_tool), never TERMINE.
  assert(r.out.runStatus === 'PARTIEL', 'task without tool calls => PARTIEL, got ' + JSON.stringify(r.out));
  const doneEv = r.events.filter((e) => e && e.type === 'turn.done').pop() || {};
  assert(String(doneEv.reason || '').indexOf('AUCUNE MODIFICATION') === 0, 'honest reason, got: ' + doneEv.reason);
  assert(r.last.role === 'assistant' && r.last.content.indexOf('AUCUNE MODIFICATION') === 0, 'honest text stored');
  assert(r.last.content.indexOf('Proposition :') !== -1, 'proposal stored');
  assert(Array.isArray(r.chats[0].tools) && r.chats[0].tools.length >= 6, 'loop call has tool schemas');
  assert(r.journal.indexOf('budget parties') !== -1, 'loop journals its budget');
  assert(r.journal.indexOf('question envoyee') === -1, 'no question path for tasks');
  assert(r.journal.indexOf('intention classee') !== -1, 'classification journaled');
}

async function tQuestionProviderDown() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'explique ce projet', [{ fail: true }]);
  assert(r.out.status === 'done' && r.out.runStatus === 'PARTIEL', 'down => PARTIEL, got ' + JSON.stringify(r.out));
  assert(r.last.content.indexOf('generee sans IA') !== -1, 'labelled fallback');
  assert(r.last.content.indexOf('pas repondu') !== -1, 'question intro, got: ' + r.last.content.slice(0, 200));
  assert(r.journal.indexOf('question echouee') !== -1, 'journal failure');
  assert(r.journal.indexOf('reponse secours deterministe') !== -1, 'journal fallback');
}

async function tQuestionEmpty() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'resume ce projet', [{ content: '' }]);
  assert(r.out.runStatus === 'PARTIEL', 'empty => PARTIEL');
  assert(r.last.content.indexOf('generee sans IA') !== -1, 'empty => fallback text');
}

// -- S. saturation rescue ----------------------------------------------------
async function tSaturationRescue() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'corrige le bug login', [{ content: 'RESCUE-CTX-OK' }], { ctxTokens: 200 });
  assert(r.out.status === 'done' && r.out.runStatus === 'PARTIEL', 'saturated => PARTIEL, got ' + JSON.stringify(r.out));
  assert(r.last.role === 'assistant' && r.last.content === 'RESCUE-CTX-OK', 'minimal rescue answered, got: ' + String(r.last.content).slice(0, 120));
  assert(r.chats.length === 1, 'rescue is the only call, got ' + r.chats.length);
  assert(!('tools' in r.chats[0]) || r.chats[0].tools === undefined, 'rescue has no tools');
  assert(r.journal.indexOf('reponse secours contexte') !== -1, 'journal rescue');
  assert(r.journal.indexOf('rien a resumer') === -1, 'never "rien a resumer"');
}

async function tSaturationFallback() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'corrige le bug login', [{ content: '' }], { ctxTokens: 200 });
  assert(r.out.runStatus === 'PARTIEL', 'rescue failed => PARTIEL');
  assert(r.last.content.indexOf('generee sans IA') !== -1, 'labelled last resort');
  assert(r.last.content.indexOf('Contexte sature') !== -1, 'context intro, got: ' + r.last.content.slice(0, 200));
  assert(r.journal.indexOf('reponse secours deterministe') !== -1, 'journal last resort');
}

async function tBudgetTable() {
  const dir = fixtureProject();
  const r = await driveTurn(dir, 'corrige le bug login', [{ content: 'ok' }]);
  const b = journalFields(r.journal, 'budget parties');
  assert(b && typeof b === 'object', 'budget line parsed');
  for (const k of ['system', 'tools', 'map', 'history', 'results', 'total']) {
    assert(typeof b[k] === 'number' && b[k] >= 0, 'part ' + k + ' numeric, got ' + JSON.stringify(b));
  }
  assert(b.total === b.system + b.tools + b.map + b.history + b.results, 'total = sum of parts');
  assert(b.system > 0 && b.tools > 0 && b.map > 0, 'system/tools/map non-empty');
}

// -- U. units ----------------------------------------------------------------
async function tUnitsBudget() {
  const b = profiles.tokenBudget({ system: 400, tools: 400, map: 800, history: 1000, results: 0 });
  assert(b.system === 100 && b.tools === 100 && b.map === 200 && b.history === 250 && b.results === 0 && b.total === 650, 'parts math, got ' + JSON.stringify(b));
  const e = profiles.tokenBudget();
  assert(e.total === 0, 'empty => zero');
}

async function tUnitsModes() {
  assert(modes.modeSystem('build') === modes.buildSystem(), 'default build unchanged');
  assert(modes.modeSystem('plan') === modes.planSystem(), 'default plan unchanged');
  assert(modes.modeSystem('build', 'small') === modes.buildSystemSmall(), 'small build wired');
  assert(modes.modeSystem('plan', 'small') === modes.planSystemSmall(), 'small plan wired');
  assert(modes.buildSystemSmall().indexOf('BUILD mode') !== -1, 'small keeps mode identity');
  assert(modes.planSystemSmall().indexOf('PLAN mode') !== -1, 'small keeps mode identity');
  assert(modes.buildSystemSmall().length < modes.buildSystem().length / 2, 'small is terse');
}

async function tUnitsQuestionContext() {
  const dir = fixtureProject();
  const m = pmap.buildProjectMap(dir);
  assert(m.ok, 'map ok');
  const q1 = pmap.buildQuestionContext(dir, m);
  const q2 = pmap.buildQuestionContext(dir, m);
  assert(q1.text.indexOf('[contexte question]') === 0, 'header');
  assert(q1.files.indexOf('README.md') !== -1 && q1.files.indexOf('package.json') !== -1, 'key files, got ' + q1.files.join(','));
  assert(q1.text.indexOf('Point of sale') !== -1, 'README head');
  assert(q1.text === q2.text, 'deterministic');
  assert(q1.text.length <= 7000, 'bounded, got ' + q1.text.length);
  const qe = pmap.buildQuestionContext(path.join(dir, 'nope'), null);
  assert(qe.text.indexOf('[contexte question]') === 0 && qe.files.length === 0, 'missing root safe');
}

async function tUnitsFallbackWhy() {
  const m = pmap.buildProjectMap(fixtureProject());
  const loop = pmap.deterministicFallback({ map: m, calls: [], loopKey: 'read|x' });
  assert(loop.indexOf('generee sans IA') !== -1 && loop.indexOf('Boucle repetitive') !== -1, 'loop text kept');
  const ctx = pmap.deterministicFallback({ map: m, calls: [], why: 'context' });
  assert(ctx.indexOf('generee sans IA') !== -1 && ctx.indexOf('Contexte sature') !== -1, 'context intro');
  const q = pmap.deterministicFallback({ map: m, calls: [], why: 'question' });
  assert(q.indexOf('generee sans IA') !== -1 && q.indexOf('pas repondu') !== -1, 'question intro');
}

async function tUnitsReadHint() {
  const dir = fixtureProject();
  const home = tmp('home');
  const store = new SessionStore({ dir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: dir });
  const ctx = { root: dir, sessionId: s.id, session: s, store, log: null, corr: 't',
    run: { calls: [], created: [] }, home, mode: 'build',
    sessionRules: new Set(), projectRules: new Set() };
  const cut = await executeTool(ctx, 'read', { file: 'long.txt', offset: 0, limit: 2 }, {});
  assert(cut.status === 'done', 'truncated read done');
  assert(cut.call.summary.indexOf('suite : lignes 3-4') !== -1, 'hint in summary, got: ' + cut.call.summary);
  assert(cut.call.result.continuation === 'suite : lignes 3-4', 'hint structured');
  const full = await executeTool(ctx, 'read', { file: 'long.txt' }, {});
  assert(full.status === 'done' && full.call.summary.indexOf('suite :') === -1, 'no hint when complete');
}

async function tUnitsRouting() {
  assert(pmap.isGeneralQuestion('explique ce projet') === true, 'explain routes questions');
  assert(pmap.isGeneralQuestion('resume ce projet') === true, 'summarize routes questions');
  assert(pmap.isGeneralQuestion('corrige le bug login') === false, 'fix keeps loop');
  assert(pmap.isGeneralQuestion('cree un fichier x') === false, 'create keeps loop');
}

// -- R. markers (runtime / extension / bench / P43-4) ------------------------
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
async function tMarkersRuntime() {
  const oc = src('backend/runtime/openai_compat.py');
  assert(oc.indexOf('def auto_n_ctx') !== -1, 'policy fn');
  assert(oc.indexOf('def kv_bytes_per_token') !== -1, 'KV table fn');
  assert(oc.indexOf('P43_KV_MARGIN_GB') !== -1, 'margin const');
  const se = src('backend/runtime/server.enterprise.py');
  assert(se.indexOf('auto_n_ctx(') !== -1, 'loader calls policy');
  assert(se.indexOf('[GGUF] policy') !== -1, 'policy journaled');
  assert(se.indexOf('kv_check') !== -1, 'measured cross-check');
  assert(se.indexOf('"n_ctx":') !== -1 && se.indexOf('state.n_ctx') !== -1, '/health exposes effective n_ctx');
}
async function tMarkersExtension() {
  const rp = src('sudo-ai-extension/src/panels/RuntimePanel.js');
  assert(rp.indexOf('_lastNctx') !== -1, 'effective n_ctx remembered');
  assert(rp.indexOf('re-transmit the effective n_ctx') !== -1, 'restart re-transmits');
}
async function tMarkersP43d() {
  const pa = src('sudo-ai-extension/src/panels/ProjectAnalysisPanel.js');
  assert(pa.indexOf('http://127.0.0.1:6000/infer') !== -1, 'single /infer call');
  assert(pa.indexOf('max_tokens: 400') !== -1, 'bounded reply');
  assert(pa.indexOf('timeout: 60000') !== -1, '60s deadline');
  assert(pa.indexOf('_aiContextFromAnalysis') !== -1, 'deterministic context');
  assert(pa.indexOf('aiRecommendations') !== -1 && pa.indexOf('aiError') !== -1, 'states shown');
  assert(pa.indexOf('this._aiRunning = false') !== -1, 'never stuck');
}
async function tMarkersBench() {
  const b = src('scripts/bench-agent.ps1');
  for (const k of ['TrialsPerCell', 'Fast', 'StateFile', 'T1-explain', 'T5-summarize',
      'pass', 'results', 'resume', 'approv']) {
    assert(b.indexOf(k) !== -1, 'bench marker ' + k);
  }
}
async function tMarkersNoGiveUp() {
  for (const f of ['loop.js', 'tools.js', 'projectmap.js', 'compress.js', 'modes.js', 'profiles.js']) {
    const s = src('sudo-agent/src/' + f);
    assert(s.indexOf('rien a resumer') === -1, 'no give-up string in ' + f);
  }
}

// -- runner ------------------------------------------------------------------
async function main() {
  const tests = [
    ['Q1 single streamed call', tQuestionSingleCall],
    ['Q2 question context', tQuestionContext],
    ['Q3 deterministic', tQuestionDeterministic],
    ['Q4 tasks keep loop', tTaskKeepsLoop],
    ['Q5 provider down', tQuestionProviderDown],
    ['Q6 empty reply', tQuestionEmpty],
    ['S1 saturation rescue', tSaturationRescue],
    ['S2 saturation fallback', tSaturationFallback],
    ['S3 budget table', tBudgetTable],
    ['U1 tokenBudget', tUnitsBudget],
    ['U2 terse modes', tUnitsModes],
    ['U3 buildQuestionContext', tUnitsQuestionContext],
    ['U4 fallback why', tUnitsFallbackWhy],
    ['U5 read hint', tUnitsReadHint],
    ['U6 routing', tUnitsRouting],
    ['R1 runtime markers', tMarkersRuntime],
    ['R2 extension markers', tMarkersExtension],
    ['R3 P43-4 markers', tMarkersP43d],
    ['R4 bench markers', tMarkersBench],
    ['R5 no give-up', tMarkersNoGiveUp],
  ];
  let pass = 0;
  const fails = [];
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('ok - ' + name); }
    catch (e) { fails.push(name); console.log('FAIL - ' + name + ' :: ' + ((e && e.message) || e)); }
  }
  console.log(pass + '/' + tests.length + ' P43 tests passed' + (fails.length ? ' FAILS: ' + fails.join(', ') : ''));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
