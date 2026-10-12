/**
 * MISSION P5 - Sudo Chat with project access: plan-mode engine, auto context
 * (active file, selection, problems), @file/@folder mentions, guided prompt,
 * agent handoff, intents kept, old unguided path removed. Mocked vscode.
 * Run:  node backend/tests/test-p5-chat.js
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');

// ---- vscode mock ----
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
  },
  languages: { diagnostics: [], getDiagnostics() { return vscodeMock.languages.diagnostics; } },
  commands: {
    executed: [],
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
  }
  reveal() { this.revealed++; }
  onDidDispose(fn) { this._disposeFn = fn; }
  dispose() { this.disposed = true; }
}
function fakeCtx() {
  const store = {};
  return { globalState: { get: (k, d) => (k in store ? store[k] : d), update: async (k, v) => { store[k] = v; } }, _store: store };
}
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  return origLoad.call(this, req, parent, isMain);
};

const { ChatPanel, parseMentions, buildChatPrompt } = require('../../sudo-ai-extension/src/panels/ChatPanel');
const { AgentPanel } = require('../../sudo-ai-extension/src/agent/AgentPanel');

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
  async undoLastRun() { this.calls.push(['undo']); return { ok: true, restored: [] }; }
  async chatQuery(prompt) { this.calls.push(['chatQuery', prompt]); return { ok: true, reply: 'fallback reply' }; }
}
function fakeHttp() {
  return { get: async (url) => (url.endsWith('/health') ? { data: { ok: true } } : { data: { data: [{ id: 'm1' }] } }) };
}
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-proj-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {\n  runApp(App());\n}\n');
  fs.writeFileSync(path.join(dir, 'lib', 'app.dart'), 'class App {}\n');
  fs.writeFileSync(path.join(dir, 'my doc.txt'), 'hello doc\n');
  return dir;
}

const panels = [];
async function main() {
  const proj = makeProject();
  const mainDart = path.join(proj, 'lib', 'main.dart');
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: proj } }];
  vscodeMock.window.activeTextEditor = {
    document: { uri: { fsPath: mainDart }, getText: () => 'runApp(App());' },
    selection: { isEmpty: false, start: { line: 1 }, end: { line: 1 } },
  };
  vscodeMock.languages.diagnostics = [
    [{ fsPath: mainDart }, [{ severity: 0, range: { start: { line: 0 } }, message: 'oops broken' }]],
  ];

  // ------------------------------------------------- A. creation (chat variant)
  const engines = [];
  const ctx = fakeCtx();
  const cp = ChatPanel.createOrShow({ fsPath: EXT }, ctx, {
    http: fakeHttp(), engineFactory: (o) => { const e = new FakeEngine(); engines.push(e); return e; },
  });
  panels.push(cp);
  const created = vscodeMock.window.createdPanels[0];
  check('A1: chat tab (no emoji)', created.viewType === 'sudoStudioChat' && created.title === 'Sudo Chat');
  const html = created.webview.html;
  check('A2: chat variant markers', html.includes('planbadge') && html.includes('id="toAgentBtn"')
    && html.includes('id="ctxbar"') && !html.includes('id="modeSel"'));
  await tick(80);
  check('A3: providers + runtime posted', ofType(cp, 'providers').length === 1
    && ofType(cp, 'runtime').length === 1 && ofType(cp, 'runtime')[0].online === true);

  // ------------------------------------------------- B. plan run with context
  const eng = () => engines[0];
  await cp.handleMessage({ type: 'send', text: 'explique @lib/main.dart' });
  await tick();
  check('B1: engine runs in plan mode', eng().calls.filter((c) => c[0] === 'run').length === 1
    && eng().calls[0][1].mode === 'plan', eng().calls[0] && eng().calls[0][1].mode);
  const prompt = eng().calls[0][1].prompt;
  check('B2: active file injected', prompt.includes('[FICHIER ACTIF]') && prompt.includes('runApp(App());'), prompt.slice(0, 120));
  check('B3: selection injected', prompt.includes('[SELECTION]') && prompt.includes(':2-2'));
  check('B4: problems injected', prompt.includes('[PROBLEMES]') && prompt.includes('oops broken'));
  check('B5: mention resolved', prompt.includes('[MENTIONS]') && prompt.includes('@lib/main.dart ->'));
  check('B6: guided prompt (french, citations, je ne sais pas)',
    prompt.includes('TOUJOURS en francais') && prompt.includes('chemin:ligne-debut-fin')
    && prompt.includes('"je ne sais pas"') && prompt.includes('lecture seule'));
  check('B7: context chips posted', ofType(cp, 'context').length === 1
    && ofType(cp, 'context')[0].hasSelection === true && ofType(cp, 'context')[0].problems === 1);
  check('B8: started plan', ofType(cp, 'started').length === 1 && ofType(cp, 'started')[0].mode === 'plan');

  // ------------------------------------------------- C. mentions (unit)
  const m1 = parseMentions('voir @lib et @nope.txt et @../out', proj);
  check('C1: dir mention lists entries', m1[0].status === 'dir' && m1[0].names.includes('main.dart'), m1[0]);
  check('C2: missing + outside flagged', m1[1].status === 'missing' && m1[2].status === 'outside');
  const m2 = parseMentions('lire @"my doc.txt" svp', proj);
  check('C3: quoted mention with space', m2.length === 1 && m2[0].status === 'file'
    && m2[0].content.includes('hello doc'), m2[0].status);
  const pr = buildChatPrompt({ root: proj, mentions: m1 }, 'q?');
  check('C4: prompt renders mention states', pr.includes('INTROUVABLE') && pr.includes('hors projet')
    && pr.includes('[MENTIONS] aucune') === false);

  // ------------------------------------------------- D. queue + done (no undo)
  await cp.handleMessage({ type: 'send', text: 'deuxieme question' });
  await tick();
  check('D1: queued while running', eng().calls.filter((c) => c[0] === 'run').length === 1
    && ofType(cp, 'runState').pop().queued === 1);
  eng().emit('done', { status: 'TERMINE', reason: 'ok', reply: 'la reponse', filesModified: [], sessionId: 's9', mode: 'plan' });
  eng().release();
  await tick();
  const done = ofType(cp, 'done')[0];
  check('D2: done without undo (plan)', !!done && done.reply === 'la reponse' && done.sessionId === null);
  const histStore = ctx._store['sudoChat.history'] || [];
  check('D3: history in conversation order (u1,a1,u2)', histStore.length === 3
    && histStore[0].role === 'user' && histStore[0].content === 'explique @lib/main.dart'
    && histStore[1].role === 'assistant' && histStore[1].content === 'la reponse'
    && histStore[2].role === 'user' && histStore[2].content === 'deuxieme question',
    histStore.map((h) => h.role + ':' + String(h.content).slice(0, 20)));
  check('D4: queue drained in plan', eng().calls.filter((c) => c[0] === 'run').length === 2
    && eng().calls[1][1].mode === 'plan');
  eng().emit('done', { status: 'TERMINE', reason: 'ok', reply: 'r2', filesModified: [], sessionId: null, mode: 'plan' });
  eng().release();
  await tick();
  const histStore2 = ctx._store['sudoChat.history'] || [];
  check('D5: second answer appended (u1,a1,u2,a2)', histStore2.length === 4
    && histStore2[3].role === 'assistant' && histStore2[3].content === 'r2',
    histStore2.map((h) => h.role + ':' + String(h.content).slice(0, 20)));

  // ------------------------------------------------- E. history replay
  const ctx2 = fakeCtx();
  ctx2._store['sudoChat.history'] = [
    { role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' },
  ];
  const cp2 = ChatPanel.createOrShow({ fsPath: EXT }, ctx2, { http: fakeHttp() });
  check('E0: singleton reused (no dup panel)', cp2 === cp);
  ChatPanel.currentPanel = undefined;
  const cp3 = ChatPanel.createOrShow({ fsPath: EXT }, ctx2, { http: fakeHttp() });
  panels.push(cp3);
  await tick(350);
  const hist = ofType(cp3, 'history')[0];
  check('E1: history replayed', !!hist && hist.turns.length === 2 && hist.turns[1].content === 'old a');

  // ------------------------------------------------- F. no-folder fallback
  vscodeMock.workspace.workspaceFolders = [];
  vscodeMock.window.activeTextEditor = null;
  await cp.handleMessage({ type: 'send', text: 'question generale' });
  await tick();
  const cq = eng().calls.filter((c) => c[0] === 'chatQuery');
  check('F1: chatQuery fallback with guidance', cq.length === 1 && cq[0][1].includes('Aucun dossier')
    && cq[0][1].includes('je ne sais pas') && cq[0][1].includes('question generale'));
  check('F2: fallback renders + idle', ofType(cp, 'history').some((m) => (m.turns || []).some((t) => t.content === 'fallback reply'))
    && ofType(cp, 'runState').pop().running === false);
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: proj } }];
  vscodeMock.window.activeTextEditor = {
    document: { uri: { fsPath: mainDart }, getText: () => '' },
    selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
  };

  // ------------------------------------------------- G. agent handoff
  const origCreate = AgentPanel.createOrShow;
  let agentOpened = null;
  const sentToAgent = [];
  AgentPanel.createOrShow = (uri) => { agentOpened = uri; return { sendExternal: async (t) => sentToAgent.push(t) }; };
  await cp.handleMessage({ type: 'send', text: 'question a transferer' });
  await tick();
  await cp.handleMessage({ type: 'toAgent' });
  await tick();
  check('G1: agent tab opened + question forwarded', !!agentOpened && sentToAgent.join() === 'question a transferer');
  AgentPanel.createOrShow = origCreate;
  eng().emit('done', { status: 'TERMINE', reason: 'ok', reply: 'r3', filesModified: [], sessionId: null, mode: 'plan' });
  eng().release();
  await tick();

  // ------------------------------------------------- H. intents kept
  const runsBefore = eng().calls.filter((c) => c[0] === 'run').length;
  vscodeMock.commands.executed.length = 0;
  await cp.handleMessage({ type: 'send', text: 'diagnostique mon syst\u00e8me' });
  await tick(800);
  check('H1: intent opens panel, no engine run',
    eng().calls.filter((c) => c[0] === 'run').length === runsBefore
    && vscodeMock.commands.executed.some((c) => c[0] === 'sudoStudio.runDoctor'));
  check('H2: intent reply is clean (no emoji)', ofType(cp, 'history').some((m) =>
    (m.turns || []).some((t) => /System Doctor/.test(t.content || '') && ![...t.content].some((ch) => ch.codePointAt(0) > 127))));

  // ------------------------------------------------- I. approvals defensive + provider
  eng().emit('approval_needed', { id: 'x1', action: 'read', title: 'Read', description: 'f' });
  await tick();
  check('I1: approval card supported', ofType(cp, 'approval').some((m) => m.id === 'x1' && m.actionable === true));
  await cp.handleMessage({ type: 'approve', id: 'x1', choice: 'once' });
  await tick();
  check('I2: approval forwarded', eng().calls.some((c) => c[0] === 'resolveApproval' && c[1] === 'once'));
  await cp.handleMessage({ type: 'setProvider', id: 'local' });
  await tick();
  check('I3: provider switch re-posts', ofType(cp, 'providers').pop().activeId === 'local');

  // ------------------------------------------------- J. old path gone + ASCII
  const src = fs.readFileSync(path.join(EXT, 'src', 'panels', 'ChatPanel.js'), 'utf8');
  const gone = ['/infer-stream', '_sendToAI', 'aiMessage', "'generating'", 'admin123', 'localhost:5000', '_tryLogin'];
  const still = gone.filter((g) => src.includes(g));
  check('J1: unguided path removed', still.length === 0, still);
  const bad = [...new Set([...src].filter((c) => c.codePointAt(0) > 127))];
  check('J2: ASCII source', bad.length === 0, bad.slice(0, 3));
  const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  check('J3: extension wiring intact', extSrc.includes('ChatPanel.createOrShow(context.extensionUri, context)'));

  for (const p of panels) { try { p.dispose(); } catch (_) {} }
  ChatPanel.currentPanel = undefined;
  console.log('\nP5: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { ChatPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
