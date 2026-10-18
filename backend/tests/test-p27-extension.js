/**
 * MISSION P27 - extension wired to the sudo-agent server, former server deleted.
 * A: absence of the former server (sources + workflows + manifests) |
 * B: AgentEngine vs fake server (run/chat/approvals/undo/sessions/errors) |
 * C: AgentServer node default + observable state |
 * D: Agent/Chat panels wiring (resume/reject-map/sessions/relaunch/no-sandbox) |
 * E: agentHost registry. Hermetic + mocked vscode. ASCII-only.
 * Run: node backend/tests/test-p27-extension.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'sudo-ai-extension');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (!cond) {
    fail++;
    console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''));
  } else { pass++; console.log('PASS ' + name); }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ---- vscode mock (installed before requiring the panels) ----
class FakePanel {
  constructor(viewType, title) {
    this.viewType = viewType; this.title = title;
    this.revealed = 0; this.disposed = false;
    this.webview = {
      html: '', cspSource: 'mockcsp', posted: [],
      async postMessage(m) { this.posted.push(m); },
      asWebviewUri: (u) => ({ toString: () => 'mockuri/' + u }),
      handler: null,
      onDidReceiveMessage(fn) { this.handler = fn; },
    };
  }
  reveal() { this.revealed++; }
  onDidDispose() {}
  dispose() { this.disposed = true; }
}
const vscodeMock = {
  ViewColumn: { One: 1, Beside: 2 },
  window: {
    activeTextEditor: null,
    createWebviewPanel: (t, title) => new FakePanel(t, title),
  },
  commands: { executed: [], async executeCommand(n, ...a) { vscodeMock.commands.executed.push([n, ...a]); } },
  workspace: { workspaceFolders: [] },
  languages: { getDiagnostics: () => [] },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file' }),
    joinPath: (...parts) => parts.map((x) => (typeof x === 'string' ? x : (x && x.fsPath) || '')).join('/'),
  },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  return origLoad.call(this, req, parent, isMain);
};

const { AgentEngine } = require('../../sudo-ai-extension/src/agent/AgentEngine');
const { AgentServer } = require('../../sudo-ai-extension/src/agent/AgentServer');
const { AgentPanel } = require('../../sudo-ai-extension/src/agent/AgentPanel');
const { ChatPanel } = require('../../sudo-ai-extension/src/panels/ChatPanel');
const agentHost = require('../../sudo-ai-extension/src/agent/agentHost');
const sandbox = require('../../sudo-ai-extension/src/agent/sandbox');

const ofType = (panel, t) => panel.panel.webview.posted.filter((m) => m.type === t);
const panels = [];
function track(p) { panels.push(p); return p; }

// ---- fake agent server -------------------------------------------------------
function makeFakeServer(script = {}) {
  const calls = [];
  const st = Object.assign({ pending: [], sessions: [{ id: 's1', title: 'Agent', messageCount: 3 }] }, script);
  const fake = {
    started: script.started !== false,
    port: 41234,
    calls,
    state() { return this.started ? { status: 'ready', detail: 'port 41234' } : { status: 'stopped', detail: '' }; },
    async request(p, o) {
      o = o || {};
      calls.push([(o.method || 'GET'), p, o.body || null]);
      if (st.onRequest) { const r = await st.onRequest(p, o); if (r) return r; }
      if (p === '/sessions' && o.method === 'POST') {
        const id = 's' + (st.sessions.length + 1);
        st.sessions.push({ id, title: (o.body && o.body.title) || '', messageCount: 0 });
        return { status: 201, body: { id } };
      }
      if (p === '/sessions' && !o.method) return { status: 200, body: { sessions: st.sessions } };
      const m = p.match(/^\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
      if (m && !m[2] && o.method === 'DELETE') {
        st.sessions = st.sessions.filter((s) => s.id !== m[1]);
        return { status: 200, body: { removed: true } };
      }
      if (m && !m[2] && !o.method) {
        const s = st.sessions.find((x) => x.id === m[1]);
        if (!s) return { status: 404, body: { error: 'session introuvable.' } };
        return { status: 200, body: Object.assign({ meta: { readFiles: st.readFiles || [] } }, s) };
      }
      if (m && m[2] === '/mode') return { status: 200, body: { mode: o.body.mode } };
      if (m && m[2] === '/approvals' && !o.method) return { status: 200, body: { pending: st.pending } };
      if (m && m[2] === '/approvals') return { status: 200, body: st.approvalResult || { status: 'executed', call: { summary: 'fait' } } };
      if (m && m[2] === '/undo') return { status: 200, body: { snapshot: 'n1', restored: ['a.txt'], deleted: [], verified: true } };
      if (m && m[2] === '/abort') return { status: 200, body: { aborted: true } };
      return { status: 404, body: { error: '?' } };
    },
    async stream(p, body, cb) {
      calls.push(['STREAM', p, body]);
      if (st.gate) await st.gate;
      if (st.streamError) {
        const e = new Error(st.streamError.message || 'x');
        e.code = st.streamError.code; e.status = st.streamError.status;
        throw e;
      }
      for (const [type, obj] of (st.events || [
        ['turn.start', { turnId: 't1' }],
        ['message.delta', { text: 'bonjour' }],
        ['tool.start', { callId: 'c1', tool: 'read' }],
        ['tool.result', { callId: 'c1', tool: 'read', ok: true, summary: 'lu 1 fichier' }],
      ])) cb(type, obj);
      return st.turnDone || { status: 'TERMINE', reason: '', filesModified: ['a.txt'] };
    },
  };
  return { fake, st };
}
const okProvider = async () => ({ type: 'local', baseUrl: 'http://127.0.0.1:6000', model: '' });

function collectEngine(eng) {
  const got = { raw: [], legacy: [] };
  const old = eng._onEvent;
  eng._onEvent = (e) => { got.raw.push(e); if (old) { try { old(e); } catch (_) {} } };
  for (const n of ['delta', 'step', 'tool', 'approval_needed', 'approval_resolved', 'done', 'error']) {
    eng.on(n, (d) => got.legacy.push([n, d]));
  }
  return got;
}

// ---- fake panel engine (host-side panel tests) -------------------------------
class FakeEngine extends EventEmitter {
  constructor() { super(); this.calls = []; this._pending = []; this._sid = 'sess-1'; }
  async run(task) {
    this.calls.push(['run', task]);
    await new Promise((res) => this._pending.push(res));
    return { status: 'TERMINE' };
  }
  release() { this._pending.splice(0).forEach((res) => res()); }
  async stop() { this.calls.push(['stop']); }
  async resolveApproval(c) { this.calls.push(['resolveApproval', c]); return { ok: true, status: 'executed' }; }
  setMode(m) { this.calls.push(['setMode', m]); }
  async undoLastRun() { this.calls.push(['undo']); return { ok: true, restored: ['a.txt'] }; }
  async continueAfterApproval() { this.calls.push(['continue']); return { ok: true }; }
  async listSessions() { this.calls.push(['listSessions']); return [{ id: 'sess-1', title: 'T1', messageCount: 2 }]; }
  async deleteSession(id) { this.calls.push(['deleteSession', id]); return { ok: true, removed: true }; }
  lastSessionId() { return this._sid; }
}
const fakeHttp = { get: async (url) => (url.endsWith('/health') ? { data: { ok: true } } : { data: { data: [{ id: 'm1' }] } }) };
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-proj-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  return dir;
}

async function main() {
  // ================= A: the former server is gone =================
  const shipped = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|json|yml|yaml|md|html|css|ps1|sh|py|ts)$/.test(f.name)) continue;
      shipped.push(p);
    }
  };
  walk(path.join(EXT, 'src'));
  walk(path.join(ROOT, 'sudo-agent', 'src'));
  walk(path.join(ROOT, '.github'));
  shipped.push(path.join(EXT, 'extension.js'), path.join(EXT, 'package.json'));
  const needle = Buffer.from('b3BlbmNvZGU=', 'base64').toString('utf8'); // decoded at runtime
  const hits = [];
  for (const f of shipped) {
    let s = '';
    try { s = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    if (s.toLowerCase().indexOf(needle) !== -1) hits.push(path.relative(ROOT, f));
  }
  check('A1: no former-server name in shipped sources/workflows', hits.length === 0, hits.slice(0, 4));
  check('A2: driver + manifest + P3 suite deleted',
    !fs.existsSync(path.join(EXT, 'src', 'agent', 'OpenCodeDriver.js')) &&
    !fs.existsSync(path.join(EXT, 'opencode.manifest.json')) &&
    !fs.existsSync(path.join(ROOT, 'backend', 'tests', 'test-p3-opencode-engine.js')));
  const tp = fs.readFileSync(path.join(EXT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  check('A3: THIRD_PARTY keeps the MIT mention + codicons, closure dropped',
    tp.indexOf('MIT License') !== -1 && tp.toLowerCase().indexOf(needle) !== -1 &&
    tp.indexOf('Codicons') !== -1 && tp.indexOf('2.2 Full list') === -1);
  const gone = ['buildDockerSpawn', 'buildWsbBundle', 'buildOcWrapperCmd', 'cmdQuote',
    'buildFwAddArgs', 'buildFwRemoveArgs', 'pickContainerEnv'];
  const kept = ['evaluateBash', 'evaluateEdit', 'filterSpawnEnv', 'pickL2', 'detectL2',
    'detectDocker', 'detectWsb', 'buildJobLauncherPs1', 'runasProbe',
    'auditPerm', 'auditExec', 'auditTimeout', 'extractToolExec'];
  check('A4: sandbox builders deleted, verdicts + detection kept',
    gone.every((k) => sandbox[k] === undefined) && kept.every((k) => typeof sandbox[k] === 'function'));

  // ================= B: engine vs fake server =================
  {
    const { fake } = makeFakeServer();
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 15 });
    const got = collectEngine(eng);
    const r = await eng.run({ prompt: 'fais ceci', mode: 'build' });
    check('B1: run ok + reply + files + readFiles',
      r.ok === true && r.reply === 'bonjour' && JSON.stringify(r.filesModified) === '["a.txt"]' &&
      r.sessionId === 's2' && Array.isArray(r.filesRead));
    const modes = fake.calls.filter((c) => c[1] && c[1].endsWith('/mode'));
    check('B2: session created then build mode set',
      fake.calls.some((c) => c[0] === 'POST' && c[1] === '/sessions') &&
      modes.length === 1 && modes[0][2].mode === 'build');
    const rawTypes = got.raw.map((e) => e.type).join(',');
    check('B3: raw events turn/delta/tool/done',
      rawTypes.indexOf('turn') !== -1 && rawTypes.indexOf('delta') !== -1 &&
      rawTypes.indexOf('tool') !== -1 && rawTypes.slice(-4) === 'done');
    check('B4: legacy delta/tool/done emitted',
      got.legacy.some((x) => x[0] === 'delta' && x[1].text === 'bonjour') &&
      got.legacy.filter((x) => x[0] === 'tool').length === 2 &&
      got.legacy.some((x) => x[0] === 'done' && x[1].status === 'TERMINE'));
  }
  {
    const { fake } = makeFakeServer({ readFiles: ['doc.md'] });
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 15 });
    const r = await eng.chatQuery('ou est le main ?');
    const modes = fake.calls.filter((c) => c[1] && c[1].endsWith('/mode'));
    check('B5: chatQuery = plan mode + reply + filesRead',
      r.ok === true && r.reply === 'bonjour' && modes[0][2].mode === 'plan' &&
      JSON.stringify(r.filesRead) === '["doc.md"]');
    const r2 = await eng.query('contexte projet', 'sys ctx');
    check('B6: query() legacy alias prepends context in build',
      r2.ok === true && fake.calls.some((c) => c[0] === 'STREAM' &&
        c[2].prompt.indexOf('sys ctx') === 0 && c[2].prompt.indexOf('contexte projet') !== -1));
  }
  {
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const { fake } = makeFakeServer({ gate, pollMs: 5 });
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 5 });
    const p1 = eng.run({ prompt: 'long', mode: 'build' });
    await tick(30);
    const busy = await eng.run({ prompt: 'second', mode: 'build' });
    check('B7: concurrent run refused with busy kind',
      busy.ok === false && busy.kind === 'busy' && /deja en cours/.test(busy.error));
    release();
    const r1 = await p1;
    check('B8: first run completes after release', r1.ok === true);
  }
  {
    const eng = new AgentEngine({ server: null, provider: okProvider });
    const errs = [];
    eng.on('error', (d) => errs.push(d));
    const dones = [];
    eng.on('done', (d) => dones.push(d));
    const r = await eng.run({ prompt: 'x' });
    check('B9: no server => kind server + error + done',
      r.ok === false && r.kind === 'server' && /hors ligne/.test(r.error) &&
      errs.length === 1 && dones.length === 1 && dones[0].status === 'ECHEC');
  }
  {
    const { fake } = makeFakeServer();
    const eng = new AgentEngine({ server: fake, projectRoot: '/tmp', pollMs: 15,
      provider: async () => { throw new Error('usage cloud interdit par la strategie (liste blanche).'); } });
    const r = await eng.run({ prompt: 'x', mode: 'build' });
    check('B10: gate throw => kind provider, message preserved',
      r.ok === false && r.kind === 'provider' && /strategie/.test(r.error));
  }
  {
    const mk = (code) => {
      const { fake } = makeFakeServer({ streamError: { message: code, code, status: 502 } });
      return new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 15 });
    };
    const r1 = await mk('no_model').run({ prompt: 'x' });
    check('B11: no_model => NO_MODEL_LOADED + noModel flag',
      r1.ok === false && r1.noModel === true && r1.reason.indexOf('NO_MODEL_LOADED') === 0);
    const r2 = await mk('runtime_offline').run({ prompt: 'x' });
    check('B12: runtime_offline => Runtime offline reason',
      r2.ok === false && r2.reason.indexOf('Runtime offline') === 0);
  }
  {
    const appr = { id: 'appr-1', tool: 'bash', summary: 'bash : rm -rf /tmp/x', pattern: { text: 'rm -rf /tmp/x' }, deploy: false };
    const s = makeFakeServer({ pollMs: 5 });
    s.st.pending = [appr];
    const eng = new AgentEngine({ server: s.fake, provider: okProvider, projectRoot: '/tmp', pollMs: 5 });
    const got = collectEngine(eng);
    const p = eng.run({ prompt: 'nettoie', mode: 'build' });
    await tick(40);
    const asked = got.legacy.find((x) => x[0] === 'approval_needed');
    check('B13: poll surfaces approval request',
      !!asked && asked[1].reqId === 'appr-1' && asked[1].tool === 'bash' &&
      got.raw.some((e) => e.type === 'perm' && e.phase === 'request'));
    const res = await eng.resolveApproval('session');
    check('B14: resolveApproval posts decision + resolved events',
      res.ok === true && res.status === 'executed' &&
      s.fake.calls.some((c) => c[0] === 'POST' && c[1] === '/sessions/s2/approvals' && c[2] && c[2].decision === 'session') &&
      got.raw.some((e) => e.type === 'perm' && e.phase === 'resolved'));
    s.st.pending = [];
    const r = await p;
    check('B15: run completes after approval', r.ok === true);
    const bad = await eng.resolveApproval('sometimes');
    check('B16: invalid decision refused', bad.ok === false && /invalide/.test(bad.error));
    const cont = await eng.continueAfterApproval();
    check('B17: continueAfterApproval sends outcome follow-up',
      cont.ok === true && s.fake.calls.some((c) => c[0] === 'STREAM' &&
        c[2].prompt.indexOf('Approbations traitees') === 0 &&
        c[2].prompt.indexOf('appr-1') !== -1));
  }
  {
    const { fake } = makeFakeServer();
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 15 });
    await eng.run({ prompt: 'x', mode: 'build' });
    const u = await eng.undoLastRun();
    check('B18: undoLastRun restores via server',
      u.ok === true && JSON.stringify(u.restored) === '["a.txt"]' && u.verified === true);
    const eng2 = new AgentEngine({ server: fake, provider: okProvider });
    const u2 = await eng2.undoLastRun();
    check('B19: undo without session is a clear error', u2.ok === false && /Aucun run/.test(u2.error));
    const list = await eng.listSessions();
    check('B20: listSessions maps server list', Array.isArray(list) && list.length >= 1 && !!list[0].id);
    const del = await eng.deleteSession('s2');
    check('B21: deleteSession removes + clears cache',
      del.ok === true && eng.lastSessionId() === null);
  }
  {
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const s = makeFakeServer({ gate });
    const eng = new AgentEngine({ server: s.fake, provider: okProvider, projectRoot: '/tmp', pollMs: 5 });
    const dones = [];
    eng.on('done', (d) => dones.push(d));
    const p = eng.run({ prompt: 'long', mode: 'build' });
    await tick(30);
    const st = await eng.stop();
    release();
    const r = await p;
    check('B22: stop() posts abort', st.ok === true && st.stopped === true &&
      s.fake.calls.some((c) => c[1] === '/sessions/s2/abort'));
    void r; void dones;
  }
  {
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const { fake } = makeFakeServer({ gate, streamError: { message: 'aborted', code: 'aborted' } });
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/tmp', pollMs: 5 });
    const p = eng.run({ prompt: 'x' });
    await tick(30);
    await eng.stop();
    release();
    const r = await p;
    check('B23: aborted turn after stop => stopped kind',
      r.ok === false && r.kind === 'stopped' && /Interrompu/.test(r.error));
  }
  {
    const { fake } = makeFakeServer();
    const eng = new AgentEngine({ server: fake, provider: okProvider, projectRoot: '/projA', pollMs: 15 });
    const a = await eng.run({ prompt: 'x', mode: 'build' });
    eng.setProjectRoot('/projB');
    const b = await eng.run({ prompt: 'y', mode: 'build' });
    check('B24: project switch creates a new session',
      a.sessionId === 's2' && b.sessionId === 's3' && a.sessionId !== b.sessionId);
    const c = await eng.run({ prompt: 'z', mode: 'build', resumeSessionId: 's2' });
    check('B25: explicit resume reuses the session', c.sessionId === 's2');
  }

  // ================= C: server runtime default + state =================
  // MINI node: the P27 'node from PATH' default is REPLACED - the runtime is
  // the host binary itself (product .exe under Electron-as-Node, plain node
  // under node). Explicit overrides (C2/C3) are unchanged.
  {
    delete process.env.SUDO_AGENT_NODE;
    const s1 = new AgentServer({ provider: { type: 'local' }, serverPath: '/tmp/x.js' });
    check('C1: default runtime is the host binary, never PATH node',
      s1.nodePath === process.execPath && s1.nodePath !== 'node');
    const t1 = s1.resolveTarget();
    check('C1b: node-mode target carries the runAsNode flag',
      t1.mode === 'node' && t1.runAsNode === true && t1.cmd === process.execPath &&
      t1.args[0] === '/tmp/x.js');
    process.env.SUDO_AGENT_NODE = '/opt/node/bin/node';
    const s2 = new AgentServer({ provider: { type: 'local' }, serverPath: '/tmp/x.js' });
    check('C2: SUDO_AGENT_NODE override wins', s2.nodePath === '/opt/node/bin/node');
    delete process.env.SUDO_AGENT_NODE;
    const s3 = new AgentServer({ provider: { type: 'local' }, serverPath: '/tmp/x.js', nodePath: '/custom/node' });
    check('C3: explicit nodePath wins', s3.nodePath === '/custom/node');
    check('C4: fresh server reports starting', s3.state().status === 'starting');
  }
  {
    const { EventEmitter: EE } = require('events');
    const failing = new AgentServer({ provider: { type: 'local' }, serverPath: path.join(ROOT, 'sudo-agent', 'src', 'server.js'), // P31(b)
      handshakeTimeoutMs: 200, killTimeoutMs: 50,
      spawnFn: () => { throw new Error('spawn node ENOENT'); } });
    let err = null;
    try { await failing.start(); } catch (e) { err = e; }
    const st = failing.state();
    check('C5: spawn failure => lastError + error state',
      !!err && st.status === 'error' && /ENOENT/.test(st.detail));
    failing.stop();
    const fake = new EE();
    fake.stdout = new EE(); fake.stderr = new EE(); fake.pid = 4242; fake.kill = () => {};
    const ok = new AgentServer({ provider: { type: 'local' }, serverPath: path.join(ROOT, 'sudo-agent', 'src', 'server.js'), // P31(b)
      handshakeTimeoutMs: 2000, killTimeoutMs: 50,
      spawnFn: () => {
        setImmediate(() => fake.stdout.emit('data',
          Buffer.from(JSON.stringify({ ready: true, host: '127.0.0.1', port: 41234, pid: 4242 }) + '\n')));
        return fake;
      } });
    await ok.start();
    check('C6: ready state after handshake + lastError cleared',
      ok.state().status === 'ready' && ok.lastError === null);
    ok.stop();
    check('C7: stopped state after stop', ok.state().status === 'stopped');
  }

  // ================= D: panels =================
  const proj = makeProject();
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: proj } }];
  {
    agentHost.resetAgentHost();
    const ap = track(new AgentPanel(new FakePanel('sudoStudioAgent', 'Sudo Agent'),
      { fsPath: EXT }, { http: fakeHttp, engineFactory: () => new FakeEngine() }));
    const eng = () => ap.engine;
    await ap.handleMessage({ type: 'send', text: 'hello agent' });
    await tick();
    const runCall = eng().calls.find((c) => c[0] === 'run');
    check('D1: agent run has no sandboxMode, resume undefined initially',
      !!runCall && !('sandboxMode' in runCall[1]) && runCall[1].resumeSessionId === undefined);
    eng().emit('done', { status: 'TERMINE', reason: '', reply: 'ok', filesModified: [], sessionId: 'sess-1', mode: 'build' });
    eng().release();
    await tick();
    await ap.handleMessage({ type: 'resumeSession', id: 'sess-9' });
    check('D2: resumeSession sticks', ap._resumeSessionId === 'sess-9' &&
      ofType(ap, 'sessionResumed').pop().id === 'sess-9');
    await ap.handleMessage({ type: 'send', text: 'suite' });
    await tick();
    const run2 = eng().calls.filter((c) => c[0] === 'run').pop();
    check('D3: next run resumes the stuck session', run2[1].resumeSessionId === 'sess-9');
    eng().emit('done', { status: 'TERMINE', reason: '', reply: 'ok2', filesModified: [], sessionId: 'sess-9', mode: 'build' });
    eng().release();
    await tick();
    eng().emit('approval_needed', { reqId: 'r1', tool: 'bash', summary: 'bash : ls', detail: 'ls' });
    await tick();
    const card = ofType(ap, 'approval').pop();
    check('D4: new-shape approval renders a card',
      !!card && card.id === 'r1' && /bash/.test(card.title));
    await ap.handleMessage({ type: 'approve', id: 'r1', choice: 'reject' });
    const fwd = eng().calls.find((c) => c[0] === 'resolveApproval');
    check('D5: reject mapped to deny for the engine', !!fwd && fwd[1] === 'deny');
    await ap.handleMessage({ type: 'listSessions' });
    await tick();
    const sl = ofType(ap, 'sessions').pop();
    check('D6: sessions listed + posted', !!sl && sl.sessions.length === 1 && sl.sessions[0].id === 'sess-1');
    await ap.handleMessage({ type: 'deleteSession', id: 'sess-1' });
    await tick();
    check('D7: deleteSession forwarded + list refreshed',
      eng().calls.some((c) => c[0] === 'deleteSession' && c[1] === 'sess-1') &&
      ofType(ap, 'sessions').length >= 2);
    await ap.handleMessage({ type: 'newSession' });
    check('D8: newSession resets engine + sticky resume',
      ap.engine === null && ap._resumeSessionId === null);
    await ap.handleMessage({ type: 'setProvider', id: 'local' });
    await tick();
    check('D9: provider switch re-posts without host hooks',
      ofType(ap, 'providers').length >= 2);
  }
  {
    let relaunched = 0;
    agentHost.setAgentHost({ relaunch: async () => { relaunched++; },
      serverState: () => ({ status: 'ready', detail: 'port 1' }) });
    AgentPanel.currentPanel = undefined;
    const ap = track(new AgentPanel(new FakePanel('sudoStudioAgent', 'Sudo Agent'),
      { fsPath: EXT }, { http: fakeHttp, engineFactory: () => new FakeEngine() }));
    await ap.handleMessage({ type: 'setProvider', id: 'local' });
    await tick(30);
    check('D10: provider switch relaunches the server', relaunched === 1);
    await ap.handleMessage({ type: 'relaunchServer' });
    await tick(30);
    check('D11: manual relaunch works + server chip posted',
      relaunched === 2 && ofType(ap, 'server').length >= 1);
    agentHost.resetAgentHost();
  }
  {
    AgentPanel.currentPanel = undefined;
    const ap = track(new AgentPanel(new FakePanel('sudoStudioAgent', 'Sudo Agent'),
      { fsPath: EXT }, { http: fakeHttp, engineFactory: () => new FakeEngine() }));
    const eng = () => ap.engine;
    await ap.handleMessage({ type: 'send', text: 'boom' });
    await tick();
    eng().emit('done', { status: 'ECHEC', reason: 'Serveur agent hors ligne.', reply: '',
      filesModified: [], sessionId: null, mode: 'build', kind: 'server' });
    eng().release();
    await tick();
    const done = ofType(ap, 'done').pop();
    check('D12: server-kind done forwarded (Relancer button)',
      !!done && done.kind === 'server');
  }
  {
    ChatPanel.currentPanel = undefined;
    let factoryOpts = null;
    const cp = track(new ChatPanel(new FakePanel('sudoStudioChat', 'Sudo Chat'),
      { fsPath: EXT }, null, { http: fakeHttp, engineFactory: (o) => { factoryOpts = o; return new FakeEngine(); } }));
    const eng = () => cp.engine;
    await cp.handleMessage({ type: 'send', text: 'question ?' });
    await tick();
    const runCall = eng().calls.find((c) => c[0] === 'run');
    check('D13: chat run is plan without sandboxMode',
      !!runCall && runCall[1].mode === 'plan' && !('sandboxMode' in runCall[1]));
    check('D14: chat factory receives host wiring opts',
      !!factoryOpts && ('server' in factoryOpts) && ('provider' in factoryOpts));
    eng().emit('done', { status: 'TERMINE', reason: '', reply: 'reponse', filesModified: [],
      sessionId: 'sess-1', mode: 'plan', filesRead: ['doc.md'] });
    eng().release();
    await tick();
    const done = ofType(cp, 'done').pop();
    check('D15: chat done nulls session + forwards filesRead',
      !!done && done.sessionId === null && JSON.stringify(done.filesRead) === '["doc.md"]');
  }

  // ================= E: agentHost =================
  {
    agentHost.resetAgentHost();
    const h0 = agentHost.getAgentHost();
    check('E1: hooks empty after reset',
      h0.getServer === null && h0.relaunch === null);
    const fn = () => 1;
    agentHost.setAgentHost({ getServer: fn, relaunch: fn, unknown: fn });
    const h1 = agentHost.getAgentHost();
    check('E2: known hooks set, unknown ignored',
      h1.getServer === fn && h1.relaunch === fn && !('unknown' in h1));
    agentHost.resetAgentHost();
  }

  for (const p of panels) { try { p.dispose(); } catch (_) {} }
  AgentPanel.currentPanel = undefined;
  ChatPanel.currentPanel = undefined;
}

main().then(() => {
  console.log(fail === 0 ? `\nP27: ${pass} checks passed (all green)`
    : `\nP27: ${pass} passed, ${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
