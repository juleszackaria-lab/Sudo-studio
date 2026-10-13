/**
 * MISSION P4 - Sudo Agent conversation UI: theme-only styling, send/queue,
 * streaming parts, 4-choice approvals, diff/undo, header selectors, VS Code
 * surface (activity bar, status bar, keybinding, dashboard). Mocked vscode.
 * Run:  node backend/tests/test-p4-agent-ui.js
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');

// ---- vscode mock (installed before requiring the panel) ----
const vscodeMock = {
  ViewColumn: { One: 1, Beside: 2 },
  window: {
    activeTextEditor: null,
    createdPanels: [],
    createWebviewPanel(viewType, title, column, options) {
      const p = new FakePanel(viewType, title, column, options);
      vscodeMock.window.createdPanels.push(p);
      return p;
    },
    views: {},
    registerWebviewViewProvider(id, provider) { vscodeMock.window.views[id] = provider; },
  },
  commands: {
    registered: {},
    executed: [],
    registerCommand(name, fn) { vscodeMock.commands.registered[name] = fn; },
    async executeCommand(name, ...args) { vscodeMock.commands.executed.push([name, ...args]); },
  },
  workspace: { workspaceFolders: [] },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file' }),
    joinPath: (...parts) => parts.map((x) => (typeof x === 'string' ? x : (x && x.fsPath) || '')).join('/'),
  },
};
class FakePanel {
  constructor(viewType, title, column, options) {
    this.viewType = viewType; this.title = title; this.column = column; this.options = options;
    this.revealed = 0; this.disposed = false;
    this.webview = {
      html: '', cspSource: 'mockcsp',
      posted: [],
      async postMessage(m) { this.posted.push(m); },
      asWebviewUri: (u) => ({ toString: () => 'mockuri/' + u }),
      handler: null,
      onDidReceiveMessage(fn) { this.handler = fn; },
    };
    this._disposeFn = null;
  }
  reveal() { this.revealed++; }
  onDidDispose(fn) { this._disposeFn = fn; }
  dispose() { this.disposed = true; }
}
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  return origLoad.call(this, req, parent, isMain);
};

const { AgentPanel, getWebviewHtml, DiffStore } = require('../../sudo-ai-extension/src/agent/AgentPanel');
const { AgentActivityView } = require('../../sudo-ai-extension/src/agent/AgentActivityView');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}
const posted = (panel) => panel.panel.webview.posted;
const ofType = (panel, t) => posted(panel).filter((m) => m.type === t);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

class FakeEngine extends EventEmitter {
  constructor() { super(); this.calls = []; this.driver = new EventEmitter(); this._pending = []; }
  async run(task) {
    this.calls.push(['run', task]);
    await new Promise((res) => this._pending.push(res));
    return { status: 'TERMINE' };
  }
  release() { this._pending.splice(0).forEach((res) => res()); }
  async stop() { this.calls.push(['stop']); }
  async resolveApproval(c) { this.calls.push(['resolveApproval', c]); return { ok: true, response: c }; }
  setMode(m) { this.calls.push(['setMode', m]); }
  async undoLastRun() { this.calls.push(['undo']); return { ok: true, restored: ['a.txt'] }; }
}
function fakeHttp(models = [{ id: 'm1' }, { id: 'm2' }]) {
  return {
    get: async (url) => (url.endsWith('/health') ? { data: { ok: true } } : { data: { data: models } }),
  };
}
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-proj-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
  return dir;
}

const panels = [];
async function main() {
  const proj = makeProject();
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: proj } }];

  // ------------------------------------------------- A. HTML static
  const html = getWebviewHtml({ nonce: 'N', cspSource: 'CSP', codiconUri: 'CODI' });
  check('A1: codicon stylesheet linked', html.includes('<link rel="stylesheet" href="CODI">'));
  check('A2: no gradient', !/gradient/i.test(html));
  check('A3: no shadow effects', !/box-shadow|text-shadow/i.test(html));
  check('A4: no hex colors (theme vars only)', !/#[0-9a-fA-F]{3,8}\b/.test(html),
    (html.match(/#[0-9a-fA-F]{3,8}\b/g) || []).slice(0, 3));
  check('A5: theme vars used', (html.match(/--vscode-/g) || []).length > 20);
  check('A6: codicon classes used', (html.match(/codicon codicon-/g) || []).length >= 5);
  check('A7: 4 approval labels', ['Autoriser une fois', 'Autoriser pour toute la session',
    'Toujours autoriser dans ce projet', 'Refuser'].every((x) => html.includes(x)));
  check('A8: diff + undo labels', html.includes('Voir le diff') && html.includes('Annuler le run'));
  check('A9: header + composer ids', ['modeSel', 'providerSel', 'agentInput', 'btnSend', 'btnStop', 'rtTxt']
    .every((id) => html.includes('id="' + id + '"')));
  check('A10: Enter sends, Shift+Enter newline, input cleared',
    html.includes('e.key === "Enter" && !e.shiftKey') && html.includes('input.value = ""'));
  try {
    const m = html.match(/<script nonce="N">([\s\S]*?)<\/script>/);
    new Function(m[1]); // compile only
    check('A11: webview JS parses', true);
  } catch (e) { check('A11: webview JS parses', false, e.message); }
  check('A12: visible keyboard focus', html.includes(':focus-visible'));
  check('A13: reduced motion respected', html.includes('prefers-reduced-motion'));
  const offScale = html.match(/\b(10|14|15|13\.5|11\.5|12\.5|9|7|5)px/g) || [];
  check('A14: 4px spacing scale only', offScale.length === 0, offScale.slice(0, 4));
  // P13 supersedes the 880px column with an 820px centered column (spec rule c).
  check('A15: centered column + responsive', html.includes('max-width:820px')
    && html.includes('@media (max-width: 640px)'));
  check('A16: aria roles/labels', html.includes('role="log"') && html.includes('aria-label='));
  check('A17: composer footer + rt button', html.includes('class="crow"')
    && html.includes('id="hint"') && html.includes('<button id="rt"'));

  // ------------------------------------------------- B. panel creation
  const engines = [];
  const ap = AgentPanel.createOrShow({ fsPath: EXT }, {
    http: fakeHttp(), engineFactory: (o) => { const e = new FakeEngine(); engines.push(e); return e; },
  });
  panels.push(ap);
  const created = vscodeMock.window.createdPanels[0];
  check('B1: editor tab created (no emoji title)', created.viewType === 'sudoStudioAgent'
    && created.title === 'Sudo Agent' && created.options.enableScripts === true);
  check('B2: html set with composer', created.webview.html.includes('id="agentInput"')
    && created.webview.html.includes('mockuri/'));
  await tick(80);
  const prov = ofType(ap, 'providers')[0];
  check('B3: providers posted (local default)', !!prov && prov.providers.length === 1
    && prov.providers[0].id === 'local' && prov.activeId === 'local', prov);
  const rt = ofType(ap, 'runtime')[0];
  check('B4: runtime status posted', !!rt && rt.kind === 'local' && rt.online === true
    && rt.models.join() === 'm1,m2', rt);
  check('B5: mode posted', ofType(ap, 'mode')[0].mode === 'build');

  // ------------------------------------------------- C. send + queue + drain
  const eng = () => engines[0];
  await ap.handleMessage({ type: 'send', text: 'task one' });
  await tick();
  check('C1: send runs engine once', eng().calls.filter((c) => c[0] === 'run').length === 1
    && eng().calls[0][1].prompt === 'task one', eng().calls[0]);
  check('C2: started + running state', ofType(ap, 'started').length === 1
    && ofType(ap, 'runState').pop().running === true);
  await ap.handleMessage({ type: 'send', text: 'task two' });
  await tick();
  check('C3: second message queued, no second run', eng().calls.filter((c) => c[0] === 'run').length === 1
    && ofType(ap, 'runState').pop().queued === 1);
  eng().emit('done', { status: 'TERMINE', reason: 'finished', reply: 'did it',
    filesModified: ['lib/main.dart'], sessionId: 's1', mode: 'build' });
  eng().release();
  await tick();
  check('C4: done renders reply + files + noModel=false',
    ofType(ap, 'done').length === 1 && ofType(ap, 'done')[0].reply === 'did it'
    && ofType(ap, 'done')[0].noModel === false);
  check('C5: queue drained automatically', eng().calls.filter((c) => c[0] === 'run').length === 2
    && eng().calls[1][1].prompt === 'task two');
  eng().emit('done', { status: 'TERMINE', reason: 'ok', reply: '', filesModified: [], sessionId: 's2', mode: 'build' });
  eng().release();
  await tick();
  check('C6: idle after drain', ofType(ap, 'runState').pop().running === false
    && ofType(ap, 'runState').pop().queued === 0);

  // ------------------------------------------------- D. stop clears queue
  await ap.handleMessage({ type: 'send', text: 'long task' });
  await tick();
  await ap.handleMessage({ type: 'send', text: 'waiting task' });
  await tick();
  await ap.handleMessage({ type: 'stop' });
  await tick();
  check('D1: stop calls engine + clears queue', eng().calls.some((c) => c[0] === 'stop')
    && ofType(ap, 'runState').pop().queued === 0);
  const runsBefore = eng().calls.filter((c) => c[0] === 'run').length;
  eng().emit('done', { status: 'ECHEC', reason: 'stopped by user', reply: '', filesModified: [], sessionId: null, mode: 'build' });
  eng().release();
  await tick();
  check('D2: no run after stop', eng().calls.filter((c) => c[0] === 'run').length === runsBefore);

  // ------------------------------------------------- E. approvals FIFO
  await ap.handleMessage({ type: 'send', text: 'approval task' });
  await tick();
  eng().emit('approval_needed', { id: 'a1', action: 'edit', title: 'Edit file', description: 'lib/main.dart' });
  eng().emit('approval_needed', { id: 'a2', action: 'bash', title: 'Run cmd', description: 'ls' });
  await tick();
  const ap1 = ofType(ap, 'approval').find((m) => m.id === 'a1');
  const ap2 = ofType(ap, 'approval').find((m) => m.id === 'a2');
  check('E1: two cards, only oldest actionable', !!ap1 && !!ap2 && ap1.actionable === true && ap2.actionable === false);
  await ap.handleMessage({ type: 'approve', id: 'a2', choice: 'once' });
  await tick();
  check('E2: out-of-order refused', !eng().calls.some((c) => c[0] === 'resolveApproval')
    && ofType(ap, 'error').length >= 1);
  await ap.handleMessage({ type: 'approve', id: 'a1', choice: 'session' });
  await tick();
  check('E3: oldest resolves + next becomes actionable',
    eng().calls.some((c) => c[0] === 'resolveApproval' && c[1] === 'session')
    && ofType(ap, 'approvalResolved').pop().choice === 'session'
    && ofType(ap, 'actionable').pop().id === 'a2');
  await ap.handleMessage({ type: 'approve', id: 'a2', choice: 'project' });
  await tick();
  check('E4: project choice forwarded', eng().calls.some((c) => c[0] === 'resolveApproval' && c[1] === 'project'));
  eng().emit('done', { status: 'TERMINE', reason: 'ok', reply: '', filesModified: [], sessionId: 's3', mode: 'build' });
  eng().release();
  await tick();

  // ------------------------------------------------- F. streaming filter
  const partsBefore = ofType(ap, 'part').length;
  eng().driver.emit('bus', { type: 'message.part.updated',
    properties: { messageID: 'm', part: { id: 'p1', type: 'text', text: 'Hello' } } });
  eng().driver.emit('bus', { type: 'message.updated', properties: { info: { id: 'm' } } });
  eng().driver.emit('bus', { type: 'session.updated', properties: {} });
  await tick();
  check('F1: only part updates forwarded', ofType(ap, 'part').length === partsBefore + 1
    && ofType(ap, 'part').pop().properties.part.text === 'Hello');

  // ------------------------------------------------- G. no-model state
  await ap.handleMessage({ type: 'send', text: 'needs model' });
  await tick();
  eng().emit('done', { status: 'ECHEC', reason: 'NO_MODEL_LOADED (load a model in Runtime)',
    reply: '', filesModified: [], sessionId: null, mode: 'build' });
  eng().release();
  await tick();
  check('G1: no-model flag mapped', ofType(ap, 'done').pop().noModel === true);

  // ------------------------------------------------- H. diff
  const store = new DiffStore(proj);
  store.snapshot();
  fs.writeFileSync(path.join(proj, 'lib', 'main.dart'), 'void main() { print(1); }\n');
  check('H1: before-content kept', store.getBefore(path.join('lib', 'main.dart')) === 'void main() {}\n');
  ap._diffStore = store;
  ap.projectRoot = proj;
  vscodeMock.commands.executed.length = 0;
  await ap.handleMessage({ type: 'openDiff', file: path.join('lib', 'main.dart') });
  const diffCall = vscodeMock.commands.executed.find((c) => c[0] === 'vscode.diff');
  check('H2: native diff opened with before/after', !!diffCall && diffCall.length === 4
    && /avant -> apres/.test(diffCall[3]), diffCall && diffCall[3]);
  const beforeTmp = diffCall[1].fsPath;
  check('H3: before-temp holds old content', fs.readFileSync(beforeTmp, 'utf8') === 'void main() {}\n');
  vscodeMock.commands.executed.length = 0;
  await ap.handleMessage({ type: 'openDiff', file: '../outside.txt' });
  check('H4: outside-project diff refused', vscodeMock.commands.executed.length === 0
    && ofType(ap, 'error').length >= 1);

  // ------------------------------------------------- I. undo
  await ap.handleMessage({ type: 'undo' });
  await tick();
  check('I1: undo forwarded + result posted', eng().calls.some((c) => c[0] === 'undo')
    && ofType(ap, 'undoResult').pop().ok === true);

  // ------------------------------------------------- J. provider + mode + no-workspace
  const { getAIProviderService } = require('../../sudo-ai-extension/src/services/AIProviderService');
  const { setExtensionContext } = require('../../sudo-ai-extension/src/services/extensionContext');
  const secrets = new Map();
  setExtensionContext({ secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } } });
  const svc = getAIProviderService();
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['c.example.com'], updatedBy: 't' });
  const added = await svc.addProvider({ name: 'C', baseUrl: 'https://c.example.com', model: 'cm' }, 'K');
  await ap.handleMessage({ type: 'setProvider', id: added.id });
  await tick();
  check('J1: provider switch re-posts list', ofType(ap, 'providers').pop().activeId === added.id
    && svc.getActive().id === added.id);
  await ap.handleMessage({ type: 'setMode', mode: 'plan' });
  await tick();
  check('J2: mode switch reaches engine + ui', eng().calls.some((c) => c[0] === 'setMode' && c[1] === 'plan')
    && ofType(ap, 'mode').pop().mode === 'plan');
  vscodeMock.workspace.workspaceFolders = [];
  const runsPrev = eng().calls.filter((c) => c[0] === 'run').length;
  await ap.handleMessage({ type: 'send', text: 'no folder' });
  await tick();
  check('J3: no folder = clean error, no run', eng().calls.filter((c) => c[0] === 'run').length === runsPrev
    && /Ouvrir un dossier/.test(ofType(ap, 'error').pop().message));
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: proj } }];

  // ------------------------------------------------- K. activity view
  const av = new AgentActivityView({ fsPath: EXT });
  const fakeView = { webview: { options: null, html: '', handler: null,
    onDidReceiveMessage(fn) { this.handler = fn; } } };
  av.resolveWebviewView(fakeView);
  check('K1: launcher html (button + shortcut)', fakeView.webview.html.includes('id="openBtn"')
    && fakeView.webview.html.includes('Ouvrir Sudo Agent') && fakeView.webview.html.includes('Ctrl'));
  vscodeMock.commands.executed.length = 0;
  fakeView.webview.handler({ type: 'open' });
  check('K2: launcher opens agent tab', vscodeMock.commands.executed.some((c) => c[0] === 'sudoAgent.open'));

  // ------------------------------------------------- L. VS Code surface (static)
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const cmds = pkg.contributes.commands.map((c) => c.command);
  check('L1: sudoAgent commands declared', cmds.includes('sudoAgent.open') && cmds.includes('sudoAgent.stop'));
  const kb = (pkg.contributes.keybindings || []).find((k) => k.command === 'sudoAgent.open');
  check('L2: keybinding ctrl+alt+a', !!kb && kb.key === 'ctrl+alt+a', kb);
  const cont = pkg.contributes.viewsContainers.activitybar.find((v) => v.id === 'sudo-agent');
  check('L3: activity container + icons on disk', !!cont && cont.title === 'Sudo Agent'
    && fs.existsSync(path.join(EXT, cont.icon.light)) && fs.existsSync(path.join(EXT, cont.icon.dark)));
  check('L4: launcher view declared', (pkg.contributes.views['sudo-agent'] || []).some((v) => v.id === 'sudoAgentLauncher'));
  check('L5: old agent title cleaned', pkg.contributes.commands.find((c) => c.command === 'sudoStudio.openAgentPanel').title === 'Sudo Agent');
  const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  check('L6: extension wires agent commands + view + status bar',
    extSrc.includes("'sudoAgent.open'") && extSrc.includes('registerWebviewViewProvider')
    && extSrc.includes('setupAgentBar') && extSrc.includes('$(comment-discussion) Agent'));
  const dashSrc = fs.readFileSync(path.join(EXT, 'src', 'providers', 'DashboardProvider.js'), 'utf8');
  check('L7: dashboard entry first', dashSrc.indexOf("'Sudo Agent'") !== -1
    && dashSrc.indexOf("'Sudo Agent'") < dashSrc.indexOf('Open AI Chat'));
  check('L8: codicons bundled', fs.existsSync(path.join(EXT, 'media', 'codicon.css'))
    && fs.existsSync(path.join(EXT, 'media', 'codicon.ttf')));
  const panelSrc = fs.readFileSync(path.join(EXT, 'src', 'agent', 'AgentPanel.js'), 'utf8');
  check('L9: old protocol gone', !/startTask|approveAction|rejectAction/.test(panelSrc));

  // ------------------------------------------------- M. ASCII sources
  for (const f of ['src/agent/AgentPanel.js', 'src/agent/AgentActivityView.js', 'src/agent/AgentEngine.js',
      'resources/agent-light.svg', 'resources/agent-dark.svg', 'THIRD_PARTY_NOTICES.md']) {
    const s = fs.readFileSync(path.join(EXT, f), 'utf8');
    const bad = [...new Set([...s].filter((c) => c.codePointAt(0) > 127))];
    check('M: ASCII ' + f, bad.length === 0, bad.slice(0, 3));
  }
  const agentDashboardLine = dashSrc.split('\n').find((l) => l.includes('Sudo Agent'));
  check('M: ASCII dashboard agent line', [...agentDashboardLine].every((c) => c.codePointAt(0) < 128));

  for (const p of panels) { try { p.dispose(); } catch (_) {} }
  AgentPanel.currentPanel = undefined;
  console.log('\nP4: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { AgentPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
