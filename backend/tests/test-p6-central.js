/**
 * MISSION PROMPT 6 - Central Management: 4 working tabs, 10s max load with
 * error + Retry (never infinite), users CRUD, enforced policies (model allow
 * list + cloud gate), org config, filterable audit + CSV/JSON export,
 * dashboard entries. Mocked vscode. Run: node backend/tests/test-p6-central.js
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');
const CENTRAL = path.join(TMP_HOME, '.sudo_studio', 'central');

// ---- vscode mock ----
class FakePanel {
  constructor(viewType, title) {
    this.viewType = viewType; this.title = title; this.revealed = 0;
    this.webview = {
      html: '', posted: [],
      async postMessage(m) { this.posted.push(m); return true; },
      onDidReceiveMessage() {},
    };
  }
  reveal() { this.revealed++; }
  onDidDispose() {}
  dispose() {}
}
const vscodeMock = {
  ViewColumn: { One: 1 },
  ConfigurationTarget: { Global: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class { constructor(l, c) { this.label = l; this.collapsibleState = c; } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  window: {
    panels: [],
    errors: [], infos: [],
    savePath: null, openPaths: null,
    createWebviewPanel(vt, title) { const p = new FakePanel(vt, title); vscodeMock.window.panels.push(p); return p; },
    showErrorMessage(m) { vscodeMock.window.errors.push(m); },
    showInformationMessage(m) { vscodeMock.window.infos.push(m); },
    async showSaveDialog() { return vscodeMock.window.savePath ? { fsPath: vscodeMock.window.savePath } : undefined; },
    async showOpenDialog() { return vscodeMock.window.openPaths; },
  },
  workspace: {
    store: {},
    getConfiguration() {
      return {
        update: async (k, v) => { vscodeMock.workspace.store[k] = v; },
        get: (k) => vscodeMock.workspace.store[k],
      };
    },
  },
  commands: { executed: [], async executeCommand(n, ...a) { vscodeMock.commands.executed.push([n, ...a]); } },
  Uri: { file: (p) => ({ fsPath: p }) },
};
const fakeAxios = {
  __calls: [],
  interceptors: { response: { use() {} } },
  get: async (url) => { fakeAxios.__calls.push(['GET', url]); const e = new Error('connect ECONNREFUSED ' + url); e.code = 'ECONNREFUSED'; throw e; },
  post: async (url) => { fakeAxios.__calls.push(['POST', url]); const e = new Error('connect ECONNREFUSED ' + url); e.code = 'ECONNREFUSED'; throw e; },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  if (req === 'axios') return fakeAxios;
  return origLoad.call(this, req, parent, isMain);
};

const { CentralMgmtPanel, filterAudit, buildAuditCsv, isModelAllowed,
  getCentralPolicies, getOrg } = require('../../sudo-ai-extension/src/panels/CentralMgmtPanel');
const { RuntimePanel } = require('../../sudo-ai-extension/src/panels/RuntimePanel');
const { DashboardProvider } = require('../../sudo-ai-extension/src/providers/DashboardProvider');
const { AIProviderService, POLICY_MSG, _resetAIProviderServiceForTests } = require('../../sudo-ai-extension/src/services/AIProviderService');
const { appendAudit: sharedAppend } = require('../../sudo-ai-extension/src/utils/auditLog');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await tick(100); }
}
function readStore(f, d) {
  try { return JSON.parse(fs.readFileSync(path.join(CENTRAL, f), 'utf8')); } catch (_) { return d; }
}
function audit() { return readStore('audit.json', []); }

async function main() {
  // Legacy tool policies on disk BEFORE first load (migration test).
  fs.mkdirSync(CENTRAL, { recursive: true });
  const legacyTools = [{ id: '9', name: 'Min Node', tool: 'Node.js', operator: '>=', version: '18.0.0' }];
  fs.writeFileSync(path.join(CENTRAL, 'policies.json'), JSON.stringify(legacyTools));

  // ------------------------------------------------- A. creation + 4 tabs + client parses
  const cp = CentralMgmtPanel.createOrShow({ fsPath: EXT });
  const created = vscodeMock.window.panels[0];
  check('A1: panel identity (ASCII title)', created.viewType === 'sudoStudioCentral' && created.title === 'Central Management');
  const html = created.webview.html;
  check('A2: exactly 4 tabs, no cloud tab',
    ['tabbtn-users', 'tabbtn-policies', 'tabbtn-config', 'tabbtn-audit'].every((t) => html.includes(t))
    && !html.includes('tabbtn-cloud') && !html.includes('runPolicyCheck'));
  const clientJs = html.split('<script>')[1].split('</scr' + 'ipt>')[0];
  let parses = true; let parseErr = '';
  try { new vm.Script(clientJs); } catch (e) { parses = false; parseErr = e.message; }
  check('A3: client script parses (root cause fixed)', parses, parseErr);
  check('A4: retry + error + tabs + backend UI present',
    clientJs.includes('loadError') && clientJs.includes('essayer') && clientJs.includes('showTab')
    && clientJs.includes('backendStatus') && clientJs.includes('data-act=\\"retry\\"')
    && html.includes('backendPill') && html.includes('errbar'));
  check('A5: original killer pattern gone', !html.includes("type:'runPolicyCheck'") && !html.includes("type:'openProviders'"));
  const posted = created.webview.posted;
  const first = await waitFor(() => posted.find((m) => m.type === 'dataReady'));
  check('A6: real load delivers dataReady', !!first, posted.map((m) => m.type));
  check('A7: dataReady shape (4 tabs data)', !!first && Array.isArray(first.users)
    && !!first.centralPolicies && Array.isArray(first.centralPolicies.allowedModels)
    && !!first.org && Array.isArray(first.configs) && Array.isArray(first.audit)
    && first.cloudPolicy !== undefined && !!first.backend);
  check('A8: backend down detected for real', !!first && first.backend.online === false);
  cp._checkBackend = async () => ({ online: false, detail: 'test' }); // fast + hermetic from here
  const send = async (m) => { await cp._onMessage(m); await tick(60); };

  // ------------------------------------------------- I. legacy migration (non-destructive)
  check('I1: legacy tools preserved, old file untouched',
    JSON.stringify(readStore('policies.tools.legacy.json', null)) === JSON.stringify(legacyTools)
    && JSON.stringify(readStore('policies.json', null)) === JSON.stringify(legacyTools));
  check('I2: migration audited', audit().some((e) => e.action === 'POLICY_MIGRATE' && e.result === 'ok'));

  // ------------------------------------------------- B. guarded load (10 s + retry)
  const realFetch = cp._fetchAll.bind(cp);
  posted.length = 0;
  cp._fetchAll = async () => { throw new Error('boom-load'); };
  await send({ type: 'load' });
  const err1 = posted.find((m) => m.type === 'loadError');
  check('B1: load failure posts loadError (never silent)', !!err1 && /boom-load/.test(err1.message));
  check('B2: load failure audited', audit().some((e) => e.action === 'CENTRAL_LOAD' && e.result === 'error'));
  posted.length = 0;
  cp._fetchAll = () => new Promise(() => {});
  cp._loadTimeoutMs = 60;
  await send({ type: 'load' });
  await tick(150);
  check('B3: hanging load times out (no infinite spinner)',
    posted.some((m) => m.type === 'loadError' && /timeout/.test(m.message)), posted.map((m) => m.type));
  posted.length = 0;
  cp._fetchAll = realFetch; cp._loadTimeoutMs = 10000;
  await send({ type: 'load' });
  check('B4: retry after failure loads again', posted.some((m) => m.type === 'dataReady'));
  posted.length = 0;
  const before = vscodeMock.window.panels.length;
  const cp2 = CentralMgmtPanel.createOrShow({ fsPath: EXT }, 'audit');
  await tick(60);
  check('B5: openAuditLog reuses panel + switches tab',
    cp2 === cp && vscodeMock.window.panels.length === before
    && posted.some((m) => m.type === 'showTab' && m.tab === 'audit'));

  // ------------------------------------------------- C. users CRUD
  await send({ type: 'saveOrg', org: { orgName: 'Acme', defaultRole: 'tester', auditRetentionDays: 30 } });
  check('C0: org saved + audited', getOrg().orgName === 'Acme' && getOrg().defaultRole === 'tester'
    && audit().some((e) => e.action === 'ORG_SAVE' && e.result === 'ok'));
  await send({ type: 'addUser', user: { name: 'Nora', email: 'nora@acme.test' } });
  let users = readStore('users.json', []);
  check('C1: user created with org default role',
    users.some((u) => u.email === 'nora@acme.test' && u.role === 'tester' && u.active === true));
  const nora = users.find((u) => u.email === 'nora@acme.test');
  vscodeMock.window.errors.length = 0;
  await send({ type: 'addUser', user: { name: 'Dup', email: 'NORA@acme.test', role: 'viewer' } });
  check('C2: duplicate email refused + audited',
    readStore('users.json', []).filter((u) => u.email.toLowerCase() === 'nora@acme.test').length === 1
    && audit().some((e) => e.action === 'ADD_USER' && e.result === 'refused_duplicate'));
  await send({ type: 'setUserRole', id: nora.id, role: 'developer' });
  check('C3: role changed + audited', readStore('users.json', []).find((u) => u.id === nora.id).role === 'developer'
    && audit().some((e) => e.action === 'USER_ROLE' && /tester -> developer/.test(e.detail)));
  await send({ type: 'setUserRole', id: '1', role: 'viewer' });
  check('C4: last admin keeps role (refused + audited)',
    readStore('users.json', []).find((u) => u.id === '1').role === 'admin'
    && audit().some((e) => e.action === 'USER_ROLE' && e.result === 'refused_last_admin'));
  await send({ type: 'toggleUser', id: nora.id });
  check('C5: user deactivated + audited', readStore('users.json', []).find((u) => u.id === nora.id).active === false
    && audit().some((e) => e.action === 'TOGGLE_USER' && e.result === 'ok'));
  await send({ type: 'toggleUser', id: '1' });
  check('C6: last active admin stays active',
    readStore('users.json', []).find((u) => u.id === '1').active === true
    && audit().some((e) => e.action === 'TOGGLE_USER' && e.result === 'refused_last_admin'));
  await send({ type: 'removeUser', id: nora.id });
  check('C7: user removed + audited', !readStore('users.json', []).find((u) => u.id === nora.id)
    && audit().some((e) => e.action === 'REMOVE_USER' && e.result === 'ok'));
  await send({ type: 'removeUser', id: '1' });
  check('C8: last admin not removed', !!readStore('users.json', []).find((u) => u.id === '1')
    && audit().some((e) => e.action === 'REMOVE_USER' && e.result === 'refused_last_admin'));

  // ------------------------------------------------- D. policies (models, rules, cloud)
  check('D0: empty allow-list allows all (fail-open default)', isModelAllowed('whatever-model') === true);
  await send({ type: 'addModel', model: 'ModelA' });
  check('D1: model allow-listed + audited', getCentralPolicies().allowedModels.join() === 'ModelA'
    && audit().some((e) => e.action === 'MODEL_ALLOW' && e.result === 'ok'));
  check('D2: allow-list enforced by helper', isModelAllowed('modela') === true && isModelAllowed('EvilModel') === false);
  posted.length = 0;
  await send({ type: 'addModel', model: 'MODELA' });
  check('D3: duplicate model refused', getCentralPolicies().allowedModels.length === 1
    && posted.some((m) => m.type === 'error'));
  await send({ type: 'removeModel', model: 'modela' });
  check('D4: model removed + audited', getCentralPolicies().allowedModels.length === 0
    && audit().some((e) => e.action === 'MODEL_REMOVE' && e.result === 'ok'));
  await send({ type: 'addRule', rule: { name: 'Cap steps', type: 'maxSteps', value: '25' } });
  let rules = getCentralPolicies().agentRules;
  check('D5: agent rule added + audited', rules.length === 1 && rules[0].value === '25' && rules[0].active === true
    && audit().some((e) => e.action === 'RULE_ADD' && e.result === 'ok'));
  await send({ type: 'toggleRule', id: rules[0].id });
  check('D6: rule toggled + audited', getCentralPolicies().agentRules[0].active === false
    && audit().some((e) => e.action === 'RULE_TOGGLE' && e.result === 'ok'));
  await send({ type: 'removeRule', id: rules[0].id });
  check('D7: rule removed + audited', getCentralPolicies().agentRules.length === 0
    && audit().some((e) => e.action === 'RULE_REMOVE' && e.result === 'ok'));
  posted.length = 0;
  await send({ type: 'saveCloudPolicy', adminEmail: 'nobody@acme.test', cloudEnabled: true, whitelist: ['x.io'] });
  check('D8: cloud change by non-admin refused + audited', posted.some((m) => m.type === 'error')
    && audit().some((e) => e.action === 'CLOUD_POLICY' && e.result === 'refused_not_admin'));
  await send({ type: 'saveCloudPolicy', adminEmail: 'admin@sudostudio.local', cloudEnabled: true, whitelist: ['api.example.com'] });
  posted.length = 0;
  await send({ type: 'load' });
  const reloaded = posted.find((m) => m.type === 'dataReady');
  check('D9: cloud policy saved by admin + reloaded',
    !!reloaded && reloaded.cloudPolicy.cloudEnabled === true
    && reloaded.cloudPolicy.whitelist.join() === 'api.example.com');

  // ------------------------------------------------- E. config + retention + profiles
  const oldEntry = { ts: '2020-01-01T00:00:00.000Z', actor: 'ghost', action: 'OLD', detail: 'old', result: 'ok', verified: true };
  const full = readStore('audit.json', []);
  fs.writeFileSync(path.join(CENTRAL, 'audit.json'), JSON.stringify([oldEntry, ...full], null, 2));
  posted.length = 0;
  await send({ type: 'load' });
  const withAudit = posted.find((m) => m.type === 'dataReady');
  check('E1: retention window applied (30 j)', !!withAudit && withAudit.audit.every((e) => e.action !== 'OLD'));
  await send({ type: 'addConfig', config: { name: 'Prof1', model: 'M1', agentMode: true } });
  const cfgs = readStore('configs.json', []);
  check('E2: AI profile kept (add)', cfgs.some((c) => c.name === 'Prof1'));
  await send({ type: 'applyConfig', id: cfgs.find((c) => c.name === 'Prof1').id });
  check('E3: profile applied to settings + audited',
    vscodeMock.workspace.store['ai.model'] === 'M1' && vscodeMock.workspace.store['agent.enabled'] === true
    && audit().some((e) => e.action === 'APPLY_CONFIG' && e.result === 'ok'));

  // ------------------------------------------------- F. audit filters + exports + import roundtrip
  const sample = [
    { ts: '2026-10-10T10:00:00.000Z', actor: 'alice', action: 'ADD_USER', detail: 'x', result: 'ok', verified: true },
    { ts: '2026-10-11T10:00:00.000Z', actor: 'bob', action: 'REMOVE_USER', detail: 'y', result: 'error', verified: false },
    { ts: '2026-10-12T10:00:00.000Z', actor: 'alice', action: 'ADD_USER', detail: 'z', result: 'refused_policy', verified: true },
  ];
  check('F1: filter by user/action/date/result',
    filterAudit(sample, { user: 'ali' }).length === 2
    && filterAudit(sample, { action: 'remove' }).length === 1
    && filterAudit(sample, { from: '2026-10-11', to: '2026-10-11' }).length === 1
    && filterAudit(sample, { result: 'ok' }).length === 1
    && filterAudit(sample, {}).length === 3);
  const csv = buildAuditCsv([{ ts: 't', actor: 'a"b', action: 'x,y', detail: 'l1\nl2', result: 'ok', verified: true }]);
  check('F2: CSV quoting', csv.split('\n')[0] === 'ts,actor,action,detail,result,verified'
    && csv.includes('"a""b"') && csv.includes('"x,y"') && csv.includes('"l1\nl2"'));
  vscodeMock.window.savePath = path.join(TMP_HOME, 'audit.csv');
  await send({ type: 'exportAudit', format: 'csv', filters: {} });
  const csvFile = fs.readFileSync(vscodeMock.window.savePath, 'utf8');
  check('F3: CSV export written + verified + audited',
    csvFile.split('\n')[0] === 'ts,actor,action,detail,result,verified' && csvFile.includes('ADD_USER')
    && audit().some((e) => e.action === 'AUDIT_EXPORT' && /CSV/.test(e.detail)));
  vscodeMock.window.savePath = path.join(TMP_HOME, 'audit.json');
  await send({ type: 'exportAudit', format: 'json', filters: { action: 'ADD_USER' } });
  const jsonRows = JSON.parse(fs.readFileSync(vscodeMock.window.savePath, 'utf8'));
  check('F4: JSON export honors filters',
    jsonRows.length >= 1 && jsonRows.every((r) => r.action === 'ADD_USER'));
  vscodeMock.window.savePath = path.join(TMP_HOME, 'central-export.json');
  await send({ type: 'exportAll' });
  const exp = JSON.parse(fs.readFileSync(vscodeMock.window.savePath, 'utf8'));
  check('F5: full export works (users+policies+org+configs)',
    Array.isArray(exp.users) && !!exp.policies && !!exp.org && Array.isArray(exp.configs)
    && audit().some((e) => e.action === 'EXPORT_ALL' && e.result === 'ok'));
  fs.writeFileSync(path.join(CENTRAL, 'users.json'), JSON.stringify([], null, 2));
  vscodeMock.window.openPaths = [{ fsPath: vscodeMock.window.savePath }];
  await send({ type: 'importAll' });
  check('F6: import restores + audited', readStore('users.json', []).length === exp.users.length
    && audit().some((e) => e.action === 'IMPORT_ALL' && e.result === 'ok'));

  // ------------------------------------------------- G. enforcement (6d)
  await send({ type: 'addModel', model: 'ModelA' });
  const realPost = fakeAxios.post;
  let httpCalls = [];
  fakeAxios.post = async (url, body) => { httpCalls.push([url, body]); return { data: {} }; };
  const rp = Object.create(RuntimePanel.prototype);
  const rpPosted = [];
  rp.panel = { webview: { postMessage: async (m) => rpPosted.push(m) } };
  rp.fetchStatus = async () => {};
  rp._startDownloadPoll = () => {};
  rp._stopDownloadPoll = () => {};
  await rp.downloadModel('EvilModel');
  check('G1: forbidden model download refused, no HTTP',
    httpCalls.length === 0 && rpPosted.some((m) => m.type === 'error' && /bloque/.test(m.text)));
  check('G2: refusal audited (refused_policy)',
    audit().some((e) => e.action === 'MODEL_BLOCKED' && e.result === 'refused_policy' && /EvilModel/.test(e.detail)));
  await rp.downloadModel('ModelA');
  check('G3: allowed model download proceeds',
    httpCalls.length === 1 && /\/download$/.test(httpCalls[0][0]) && rpPosted.some((m) => m.type === 'downloadStarted'));
  httpCalls = []; rpPosted.length = 0;
  await rp.switchModel('EvilModel');
  check('G4: forbidden model load refused, no HTTP',
    httpCalls.length === 0 && rpPosted.some((m) => m.type === 'error'));
  await rp.switchModel('ModelA');
  check('G5: allowed model load proceeds',
    httpCalls.length === 1 && /\/reload$/.test(httpCalls[0][0]));
  fakeAxios.post = realPost;
  // Cloud-off blocks API key USE (add stays allowed, P2-B1 preserved).
  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-svc-'));
  const secrets = { map: {}, async store(k, v) { this.map[k] = v; }, async get(k) { return this.map[k] || null; }, async delete(k) { delete this.map[k]; } };
  const fakeHttp = { calls: 0, post: async () => { fakeHttp.calls++; return { data: { choices: [{ message: { content: 'HI' } }], usage: { total_tokens: 5 } } }; } };
  const svc = new AIProviderService({ centralDir: svcDir, secretsStore: secrets, httpClient: fakeHttp });
  const added = await svc.addProvider({ name: 'Cl', baseUrl: 'https://api.example.com', model: 'm' }, 'KEY-1');
  check('G6: add provider allowed while cloud off (key stored, P2-B1 kept)', added.ok === true);
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['api.example.com'], updatedBy: 'admin@local' });
  check('G7: cloud provider selectable while on', svc.setActive(added.id).ok === true);
  svc.saveCloudPolicy({ cloudEnabled: false, whitelist: [], updatedBy: 'admin@local' });
  let threw = null;
  try { await svc.complete({ prompt: 'hi' }); } catch (e) { threw = e; }
  check('G8: cloud-off blocks key use (no HTTP)', !!threw && threw.message === POLICY_MSG && fakeHttp.calls === 0);
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['api.example.com'], updatedBy: 'admin@local' });
  const okR = await svc.complete({ prompt: 'hi' });
  check('G9: cloud-on + whitelist allows use', okR.ok === true && okR.reply === 'HI' && fakeHttp.calls === 1);

  // ------------------------------------------------- H. dashboard + wiring
  const items = DashboardProvider.prototype.getQuickActions.call(
    { createActionItem: DashboardProvider.prototype.createActionItem });
  const labels = items.map((i) => [i.label, i.command && i.command.command]);
  check('H1: dashboard has unique central + audit entries',
    labels.some(([l, c]) => l === 'Open Central Management' && c === 'sudoStudio.openCentralMgmtPanel')
    && labels.some(([l, c]) => l === 'Open Audit Log' && c === 'sudoStudio.openAuditLog')
    && labels.filter(([l]) => l === 'Open Audit Log').length === 1);
  check('H2: new entries after Open AI Chat (P4-L7 safe)',
    labels.findIndex(([l]) => l === 'Sudo Agent') < labels.findIndex(([l]) => l.indexOf('Open AI Chat') !== -1)
    && labels.findIndex(([l]) => l.indexOf('Open AI Chat') !== -1) < labels.findIndex(([l]) => l === 'Open Central Management'));
  const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  check('H3: extension registers + handles openAuditLog',
    extSrc.includes("'sudoStudio.openAuditLog'") && extSrc.includes("createOrShow(context.extensionUri, 'audit')"));
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  check('H4: package.json contributes openAuditLog',
    (pkg.contributes.commands || []).some((c) => c.command === 'sudoStudio.openAuditLog'));

  // ------------------------------------------------- B6. STEP-1 trap on fixed code (LAST: mutates HOME)
  const TRAP = path.join(TMP_HOME, 'trapfile');
  fs.writeFileSync(TRAP, 'x');
  let trapRej = null;
  const rejHook = (e) => { trapRej = e; };
  process.on('unhandledRejection', rejHook);
  process.env.SUDO_STUDIO_HOME = TRAP;
  _resetAIProviderServiceForTests();
  let trapThrew = false;
  try { sharedAppend('TRAP_TEST', 'x', {}); } catch (_) { trapThrew = true; }
  check('B6: shared audit never throws on trap home', trapThrew === false);
  try { cp.dispose(); } catch (_) {}
  CentralMgmtPanel.currentPanel = undefined;
  const trapCp = CentralMgmtPanel.createOrShow({ fsPath: EXT });
  const trapPosted = vscodeMock.window.panels[vscodeMock.window.panels.length - 1].webview.posted;
  const trapReady = await waitFor(() => trapPosted.find((m) => m.type === 'dataReady' || m.type === 'loadError'), 15000);
  check('B7: trap home answers degraded (never silent)',
    !!trapReady && trapReady.type === 'dataReady' && trapReady.users.length === 2 && trapReady.cloudPolicy === null,
    trapReady && trapReady.type);
  await tick(400);
  check('B8: no unhandled rejection on trap path', trapRej === null, trapRej && String(trapRej).slice(0, 120));
  process.removeListener('unhandledRejection', rejHook);
  try { trapCp.dispose(); } catch (_) {}
  CentralMgmtPanel.currentPanel = undefined;
  console.log('\nP6: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { CentralMgmtPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
