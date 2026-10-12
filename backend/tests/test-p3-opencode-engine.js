/**
 * MISSION P3 - OpenCode engine: offline config, permissions, honest status,
 * AGENTS.md, undo, old-logic deletion. Mocks + guarded real-server test
 * (SUDO_OPENCODE_BIN must point at the v1.19.0 binary).
 * Run:  node backend/tests/test-p3-opencode-engine.js
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME; // hermetic central dir + audit

const {
  OpenCodeDriver, buildOpenCodeConfig, buildSpawnEnv, seedPluginInstallSkip,
  OPENCODE_VERSION,
} = require('../../sudo-ai-extension/src/agent/OpenCodeDriver');
const { AgentEngine, STATUS, _p3helpers } = require('../../sudo-ai-extension/src/agent/AgentEngine');
const { EventEmitter } = require('events');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}

function makeProject(withAgents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-proj-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
  if (withAgents) fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\nAlways be honest.\n');
  return dir;
}

// Fake driver: captures calls, plays scripted answers, emits permissions.
class FakeDriver extends EventEmitter {
  constructor(projectRoot) {
    super();
    this.projectRoot = projectRoot;
    this.calls = [];
    this.startedSpec = null;
    this.postAnswer = { info: { id: 'asst_1', role: 'assistant' }, parts: [] };
    this.postError = null;
    this.postHook = null; // fn(body) executed inside postMessage (may write files)
  }
  async start(spec) { this.calls.push(['start']); this.startedSpec = spec; }
  async stop() { this.calls.push(['stop']); }
  async createSession(title) { this.calls.push(['createSession', title]); return { id: 'ses_1' }; }
  async postMessage(sid, body) {
    this.calls.push(['postMessage', sid, body]);
    if (this.postHook) await this.postHook(body);
    if (this.gate) await this.gate; // test holds the run (like server paused on approvals)
    if (this.postError) throw this.postError;
    return this.postAnswer;
  }
  hold() { this.gate = new Promise((res) => { this._release = res; }); }
  release() { if (this._release) this._release(); this.gate = null; }
  async revertMessage(sid, mid) { this.calls.push(['revert', sid, mid]); return true; }
  async replyPermission(sid, pid, response) {
    this.calls.push(['reply', sid, pid, response]); return true;
  }
  startEvents() { this.calls.push(['startEvents']); }
  stopEvents() { this.calls.push(['stopEvents']); }
}

const LOCAL_MODELS = { data: { data: [{ id: 'tiny-local' }] } };
function fakeHttpForLocal() {
  return { get: async () => LOCAL_MODELS, post: async () => ({ data: { reply: 'x' } }) };
}

async function main() {
  console.log('OPENCODE_VERSION=' + OPENCODE_VERSION);

  // ------------------------------------------------- A. config builder
  const lc = buildOpenCodeConfig({ providerType: 'local', baseUrl: 'http://127.0.0.1:6000/v1', model: 'm' });
  check('A1: local uses bundled openai + baseURL override',
    lc.provider.openai.options.baseURL === 'http://127.0.0.1:6000/v1' && !lc.provider.openai.npm
    && lc.model === 'openai/m' && lc.enabled_providers.join() === 'openai', lc.model);
  const cc = buildOpenCodeConfig({ providerType: 'cloud', baseUrl: 'https://c.example.com/v1', model: 'cm', apiKey: 'K' });
  check('A2: cloud uses bundled openai-compatible + key in memory',
    cc.provider['sudo-cloud'].npm === '@ai-sdk/openai-compatible'
    && cc.provider['sudo-cloud'].options.apiKey === 'K'
    && cc.enabled_providers.join() === 'sudo-cloud');
  check('A3: offline flags', lc.autoupdate === false && lc.share === 'disabled'
    && lc.permission.webfetch === 'deny' && lc.permission.websearch === 'deny'
    && lc.permission.external_directory === 'deny'
    && lc.permission.edit === 'ask' && lc.permission.bash === 'ask');
  check('A4: plan agent is read-only', lc.agent.plan.permission.edit === 'deny'
    && lc.agent.plan.permission.bash === 'deny' && lc.agent.plan.permission.task === 'deny');
  check('A5: whitelist + snapshots + no mcp', lc.provider.openai.whitelist.join() === 'm'
    && lc.snapshot === true && JSON.stringify(lc.mcp) === '{}' && !('$schema' in lc));

  const env = buildSpawnEnv('/tmp/fakeoc', lc, 'pw');
  check('A6: spawn env disables every network path',
    env.HOME === '/tmp/fakeoc' && env.OPENCODE_CONFIG_CONTENT.indexOf('"autoupdate":false') !== -1
    && env.OPENCODE_DISABLE_MODELS_FETCH === 'true' && env.OPENCODE_DISABLE_AUTOUPDATE === 'true'
    && env.OPENCODE_DISABLE_PROJECT_CONFIG === 'true' && env.OPENCODE_DISABLE_LSP_DOWNLOAD === 'true'
    && env.npm_config_registry === 'http://127.0.0.1:9/');

  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-seed-'));
  seedPluginInstallSkip(path.join(seedDir, 'oc'));
  const pkg = JSON.parse(fs.readFileSync(path.join(seedDir, 'oc', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(seedDir, 'oc', 'package-lock.json'), 'utf8'));
  check('A7: pre-seed declares+locks plugin pkg',
    pkg.dependencies['@opencode-ai/plugin'] === OPENCODE_VERSION
    && lock.packages[''].dependencies['@opencode-ai/plugin'] === OPENCODE_VERSION
    && fs.existsSync(path.join(seedDir, 'oc', 'node_modules', '.sudo-keep')));

  // ------------------------------------------------- B. permissions
  const proj = makeProject(true);
  const fd = new FakeDriver(proj);
  const eng = new AgentEngine({ projectRoot: proj, driver: fd });
  eng._http = fakeHttpForLocal;
  let approvals = [];
  eng.on('approval_needed', (d) => approvals.push(d));
  fd.hold();
  const runP = eng.run('create lib/auth/auth_service.dart');
  for (let i = 0; i < 100 && !fd.calls.some((c) => c[0] === 'postMessage'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // outside-project write -> auto deny, no user question
  fd.emit('permission', { id: 'p1', type: 'external_directory', title: 't', pattern: '/etc/x', metadata: {} });
  await new Promise((r) => setTimeout(r, 200));
  check('B1: external_directory auto-denied',
    fd.calls.some((c) => c[0] === 'reply' && c[2] === 'p1' && c[3] === 'reject') && approvals.length === 0);
  // outside edit path -> auto deny
  fd.emit('permission', { id: 'p2', type: 'edit', title: 'e', pattern: '/tmp/evil.txt', metadata: {} });
  await new Promise((r) => setTimeout(r, 200));
  check('B2: edit outside project auto-denied',
    fd.calls.some((c) => c[0] === 'reply' && c[2] === 'p2' && c[3] === 'reject') && approvals.length === 0);
  // inside edit -> ask user, then 4 answers
  fd.emit('permission', { id: 'p3', type: 'edit', title: 'e', pattern: 'lib/main.dart', metadata: {} });
  await new Promise((r) => setTimeout(r, 200));
  check('B3: inside edit asks user', approvals.length === 1 && approvals[0].action === 'edit');
  await eng.resolveApproval('project');
  check('B4: project answer -> once + allowlist written',
    fd.calls.some((c) => c[0] === 'reply' && c[2] === 'p3' && c[3] === 'once'));
  const allows = JSON.parse(fs.readFileSync(path.join(TMP_HOME, '.sudo_studio', 'central', 'opencode-project-allows.json'), 'utf8'));
  const key = _p3helpers.projectKey(proj);
  check('B5: allowlist stored outside project', !!(allows[key] || []).some((a) => a.tool === 'edit'));
  // same ask again -> auto-once, no new question
  fd.emit('permission', { id: 'p4', type: 'edit', title: 'e', pattern: 'lib/main.dart', metadata: {} });
  await new Promise((r) => setTimeout(r, 200));
  check('B6: project rule auto-allows, no re-ask',
    fd.calls.some((c) => c[0] === 'reply' && c[2] === 'p4' && c[3] === 'once') && approvals.length === 1);
  // once + session + reject paths
  for (const [pid, ans, expect] of [['p5', true, 'once'], ['p6', 'session', 'always'], ['p7', false, 'reject']]) {
    fd.emit('permission', { id: pid, type: 'bash', title: 'b', pattern: 'ls', metadata: {} });
    await new Promise((r) => setTimeout(r, 150));
    await eng.resolveApproval(ans);
  }
  check('B7: once/session/reject mapped',
    fd.calls.some((c) => c[2] === 'p5' && c[3] === 'once')
    && fd.calls.some((c) => c[2] === 'p6' && c[3] === 'always')
    && fd.calls.some((c) => c[2] === 'p7' && c[3] === 'reject'));
  fd.release();
  const summary = await runP;
  check('B8: clean run -> TERMINE', summary.status === STATUS.DONE, summary);

  // ------------------------------------------------- C. honest status
  async function runWith(answer, err, hook) {
    const p = makeProject(false);
    const d = new FakeDriver(p);
    d.postAnswer = answer; d.postError = err || null; d.postHook = hook || null;
    const e = new AgentEngine({ projectRoot: p, driver: d });
    e._http = fakeHttpForLocal;
    if (hook) { const h = hook; d.postHook = async (body) => h(p, body); }
    const s = await e.run('do things');
    return { s, d, e, p };
  }
  const toolErr = { info: { id: 'a2', role: 'assistant' },
    parts: [{ type: 'tool', tool: 'edit', state: { status: 'error', error: 'boom' } }] };
  let r = await runWith(toolErr, null, async () => {});
  check('C1: tool error + no files -> ECHEC', r.s.status === STATUS.FAIL && /tool error/.test(r.s.reason), r.s);
  r = await runWith(toolErr, null, async (p) => { fs.writeFileSync(path.join(p, 'x.txt'), 'x'); });
  check('C2: tool error + files -> PARTIEL', r.s.status === STATUS.PARTIAL && r.s.filesModified.length === 1, r.s);
  r = await runWith({ info: { id: 'a3', role: 'assistant', error: { message: 'conn reset' } }, parts: [] });
  check('C3: model error -> ECHEC', r.s.status === STATUS.FAIL && /model error/.test(r.s.reason), r.s);
  r = await runWith(null, new Error('opencode server unreachable (ECONNREFUSED)'));
  check('C4: connection failure -> ECHEC immediate', r.s.status === STATUS.FAIL && /model connection/.test(r.s.reason), r.s);
  // plan mode touching files -> PARTIEL
  const pp = makeProject(false);
  const pd = new FakeDriver(pp);
  pd.postHook = async () => { fs.writeFileSync(path.join(pp, 'y.txt'), 'y'); };
  const pe = new AgentEngine({ projectRoot: pp, driver: pd, mode: 'plan' });
  pe._http = fakeHttpForLocal;
  const ps = await pe.run('analyze');
  const pbody = pd.calls.find((c) => c[0] === 'postMessage')[2];
  check('C5: plan pins agent + disables write tools',
    pbody.agent === 'plan' && pbody.tools.edit === false && pbody.tools.bash === false);
  check('C6: plan modifying files -> PARTIEL', ps.status === STATUS.PARTIAL, ps);

  // ------------------------------------------------- D. AGENTS.md + diff + undo
  const dp = makeProject(true);
  const dd = new FakeDriver(dp);
  let seenSystem = '';
  dd.postHook = async (body) => {
    seenSystem = body.system || '';
    fs.writeFileSync(path.join(dp, 'lib', 'auth_service.dart'), 'class A {}\n');
  };
  const de = new AgentEngine({ projectRoot: dp, driver: dd });
  de._http = fakeHttpForLocal;
  const ds = await de.run('create auth service');
  check('D1: AGENTS.md injected as system', seenSystem.indexOf('Always be honest.') !== -1);
  check('D2: real before/after file list',
    ds.filesModified.length === 1 && ds.filesModified[0].replace(/\\/g, '/') === 'lib/auth_service.dart', ds.filesModified);
  check('D3: model pinned per message',
    dd.startedSpec.model === 'tiny-local'
    && dd.calls.find((c) => c[0] === 'postMessage')[2].model.modelID === 'tiny-local');
  const undo = await de.undoLastRun();
  const reverts = dd.calls.filter((c) => c[0] === 'revert').map((c) => c[2]);
  check('D4: undo reverts run messages in reverse',
    undo.ok === true && reverts.length === 2 && reverts[0] === 'asst_1' && reverts[1].startsWith('usr_'), reverts);

  // ------------------------------------------------- E. query/chatQuery kept (P2 paths)
  const { getAIProviderService, _resetAIProviderServiceForTests } = require('../../sudo-ai-extension/src/services/AIProviderService');
  const { setExtensionContext } = require('../../sudo-ai-extension/src/services/extensionContext');
  const secrets = new Map();
  setExtensionContext({ secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } } });
  _resetAIProviderServiceForTests();
  const svc = getAIProviderService();
  svc.httpClient = { post: async () => ({ data: { choices: [{ message: { content: 'CLOUD' } }], usage: { total_tokens: 3 } } }),
    get: async () => ({ data: { data: [{ id: 'm' }] } }) };
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['c.example.com'], updatedBy: 't' });
  const added = await svc.addProvider({ name: 'C', baseUrl: 'https://c.example.com', model: 'm' }, 'K');
  svc.setActive(added.id);
  const qe = new AgentEngine({ projectRoot: makeProject(false) });
  const qr = await qe.chatQuery('hello');
  check('E1: chatQuery cloud path kept', qr.ok === true && qr.reply === 'CLOUD' && qr.mock === false, qr);
  const qe2 = new AgentEngine({ projectRoot: makeProject(false) });
  qe2._http = () => { throw new Error('no axios in sandbox'); };
  svc.setActive('local');
  const qr2 = await qe2.chatQuery('hi');
  check('E2: chatQuery local path errors handled', qr2.ok === false && !!qr2.error, qr2);

  // ------------------------------------------------- F. old logic deleted
  const src = fs.readFileSync(path.join(__dirname, '../../sudo-ai-extension/src/agent/AgentEngine.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const markers = ['AGENT_STATE_DIR', 'ai_generate', 'caffolding', 'buildCICDFiles', 'class FileTool',
    'class AgentState', '.sudo/agent', 'SudoTools', 'MCPClient', 'FALLBACK', 'TEMPLATES'];
  const found = markers.filter((m) => code.indexOf(m) !== -1);
  check('F1: old logic markers absent from code', found.length === 0, found);
  check('F2: .bak deleted', !fs.existsSync(path.join(__dirname, '../../sudo-ai-extension/src/agent/AgentEngine.v2.bak.js')));

  // ------------------------------------------------- G. real server (guarded)
  const bin = process.env.SUDO_OPENCODE_BIN;
  if (bin && fs.existsSync(bin)) {
    const gp = makeProject(false);
    const drv = new OpenCodeDriver({ projectRoot: gp, binary: bin, home: fs.mkdtempSync(path.join(os.tmpdir(), 'p3-oc-')) });
    await drv.start({ providerType: 'local', baseUrl: 'http://127.0.0.1:6000/v1', model: 'probe-model' });
    const cfg = await drv.getConfig();
    check('G1: real server applies offline config', cfg.autoupdate === false && cfg.share === 'disabled', cfg.share);
    const sess = await drv.createSession('p3-probe');
    check('G2: real session create', !!sess.id);
    await drv.deleteSession(sess.id);
    let stray = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name));
        else stray.push(path.relative(gp, path.join(d, f.name)));
      }
    })(gp);
    stray = stray.filter((f) => f !== path.join('lib', 'main.dart'));
    check('G3: real server writes nothing in project', stray.length === 0, stray);
    await drv.stop();
    check('G4: version pin enforced', OPENCODE_VERSION === '1.19.0');
  } else {
    console.log('SKIP G: set SUDO_OPENCODE_BIN=/tmp/oc-test/bin/opencode for real-server checks');
  }

  console.log('\nP3: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
