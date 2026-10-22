/**
 * MISSION PROMPT 7 - AutoFix reel (System Doctor): every fix EXECUTED by the
 * app (winget silent / offline installers with SHA-256), single explained
 * elevation, PATH refresh + --version gate, sequential AutoFix All with final
 * table, full audit. Browser never opened. Mocked vscode + scripted exec.
 * Run: node backend/tests/test-p7-autofix.js
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const crypto = require('crypto');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');
const OFFLINE = path.join(TMP_HOME, 'installers');
fs.mkdirSync(OFFLINE, { recursive: true });

// ---- vscode mock ----
const vscodeMock = {
  ViewColumn: { One: 1 },
  window: {
    panels: [], infos: [], errors: [], terminals: [], elevationAnswer: undefined,
    createWebviewPanel(vt, title) {
      const p = { viewType: vt, title, revealed: 0,
        webview: { html: '', posted: [], async postMessage(m) { this.posted.push(m); return true; }, onDidReceiveMessage() {} },
        reveal() { this.revealed++; }, onDidDispose() {}, dispose() {} };
      vscodeMock.window.panels.push(p);
      return p;
    },
    async showInformationMessage(msg, opts, ...btns) {
      vscodeMock.window.infos.push([msg, opts, btns]);
      return vscodeMock.window.elevationAnswer;
    },
    showErrorMessage(m) { vscodeMock.window.errors.push(m); },
    createTerminal(name) {
      const t = { name, texts: [], show() {}, sendText(c) { this.texts.push(c); } };
      vscodeMock.window.terminals.push(t);
      return t;
    },
  },
  env: { opened: [], async openExternal(u) { vscodeMock.env.opened.push(String(u)); } },
  workspace: {
    getConfiguration() { return { get: (k, d) => (k === 'offlineInstallersDir' ? OFFLINE : d), update: async () => {} }; },
  },
  commands: { executed: [], async executeCommand(n, ...a) { vscodeMock.commands.executed.push([n, ...a]); } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
};
const axiosMock = {
  health: null, postCalls: [], getCalls: [],
  async post(url, body) { axiosMock.postCalls.push([url, body]); return { data: {} }; },
  async get(url) {
    axiosMock.getCalls.push(url);
    if (axiosMock.health) return { data: axiosMock.health };
    const e = new Error('connect ECONNREFUSED ' + url); e.code = 'ECONNREFUSED'; throw e;
  },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  if (req === 'axios') return axiosMock;
  return origLoad.call(this, req, parent, isMain);
};

const { fixAll, fixOne, isKnownTool, orderIssues, buildPsScript, parsePsLog, decodeEncodedLaunch: decodeLaunch } =
  require('../../sudo-ai-extension/src/doctor/autoFix');
const { DoctorPanel } = require('../../sudo-ai-extension/src/panels/DoctorPanel');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function audit() {
  try { return JSON.parse(fs.readFileSync(path.join(TMP_HOME, '.sudo_studio', 'central', 'audit.json'), 'utf8')); }
  catch (_) { return []; }
}

// Scripted exec: scenarios in order; first substring match wins.
function mockExec(scenarios, calls) {
  return async (cmd, opts) => {
    (calls || []).push(cmd);
    for (const s of scenarios) {
      if (cmd.includes(s.match)) {
        if (s.action) await s.action(cmd);
        return { code: s.code !== undefined ? s.code : 0, stdout: s.stdout || '', stderr: s.stderr || '' };
      }
    }
    return { code: 1, stdout: '', stderr: 'UNSCRIPTED: ' + cmd.slice(0, 120) };
  };
}
// Simulate the PowerShell batch run: decode the -EncodedCommand payload (P40:
// no .ps1 file anymore), parse STEP ids from it, write DONE lines to $log.
function psRun(codes) {
  return async (cmd) => {
    const script = decodeLaunch(cmd);
    const ids = [...script.matchAll(/STEP ([A-Za-z0-9_]+)/g)].map((x) => x[1]);
    const lm = script.match(/\$log = '((?:''|[^'])+)'/);
    const log = lm[1].replace(/''/g, "'");
    const lines = ['START', ...ids.map((id) => 'DONE ' + id + ' code=' + (codes[id] !== undefined ? codes[id] : 0)), 'END'];
    fs.writeFileSync(log, lines.join('\n'), 'utf8');
  };
}
const WIN_BASE = [
  { match: 'winget --version', stdout: 'v1.0.0' },
  { match: 'GetEnvironmentVariable', stdout: 'C:\\Windows\\System32\nC:\\Users\\x' },
  { match: 'HyperVRequirement', stdout: 'True' },
];
function winVerify(extra) {
  return [
    { match: 'node --version', stdout: 'v20.0.0' },
    { match: 'npm --version', stdout: '10.0.0' },
    { match: 'python --version', stdout: 'Python 3.11.0' },
    { match: 'pip --version', stdout: 'pip 24.0' },
    { match: 'python -m pip --version', stdout: 'pip 24.0' },
    { match: 'git --version', stdout: 'git version 2.40.0' },
    { match: 'docker --version', stdout: 'Docker version 24.0.0' },
    ...(extra || []),
  ];
}
function engineDeps(o) {
  o = o || {};
  return {
    platform: o.platform || 'win32',
    execFn: o.execFn,
    hasInternet: o.hasInternet || (async () => true),
    askElevation: o.askElevation || (async () => false),
    audit: o.audit || (() => {}),
    offlineDir: o.offlineDir || OFFLINE,
    onProgress: o.onProgress || (() => {}),
    installTimeoutMs: 5000,
  };
}
function writeOffline(name, content) {
  const f = path.join(OFFLINE, name);
  fs.writeFileSync(f, content || 'fake-installer-bytes');
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  fs.writeFileSync(f + '.sha256', h + '  ' + name + '\n');
  return f;
}

async function main() {
  const savedPath = process.env.PATH;

  // ------------------------------------------------- A. online Windows batch + single UAC
  let calls = [];
  let progress = [];
  let audits = [];
  const depsA = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, ...winVerify(),
    ], calls),
    askElevation: async () => { throw new Error('should not ask when admin'); },
    audit: (a, d, r) => audits.push([a, r]),
    onProgress: (p) => progress.push(p.phase + ':' + p.issue),
  });
  const ra = await fixAll(['Python', 'Docker'], depsA);
  check('A1: online batch fixes all', ra.rows.length === 2 && ra.rows.every((r) => r.status === 'fixed' && r.method === 'winget'), ra.rows);
  check('A2: one encoded launch, no script file', calls.filter((c) => c.includes('-EncodedCommand ')).length === 1
    && !calls.some((c) => c.includes('-File ')) && calls.filter((c) => c.includes('RunAs')).length === 0);
  check('A3: verify outputs in reasons', ra.rows.every((r) => /verifie : /.test(r.reason)));
  check('A4: progress sequential', progress.includes('verify:Python') && progress.indexOf('done:Python') < progress.indexOf('verify:Docker'), progress);
  check('A5: audit trail', ['AUTOFIX_START', 'AUTOFIX_PLAN', 'AUTOFIX_OK', 'AUTOFIX_DONE'].every((a) => audits.some(([x]) => x === a))
    && audits.filter(([x]) => x === 'AUTOFIX_OK').length === 2);

  // Single UAC when not admin.
  calls = [];
  let batchDecoded = '';
  let elevCount = 0;
  const depsB = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', action: async (cmd) => { batchDecoded = decodeLaunch(cmd); await psRun({})(cmd); } },
      ...WIN_BASE, ...winVerify(),
    ], calls),
    askElevation: async (t) => { elevCount++; depsB._elevText = t; return true; },
  });
  const rb = await fixAll(['Python', 'Git'], depsB);
  check('A6: single explained elevation', elevCount === 1 && /seule elevation/.test(depsB._elevText) && /Python/.test(depsB._elevText));
  check('A7: single elevated launch for all', calls.filter((c) => c.includes('RunAs')).length === 1
    && calls.filter((c) => c.includes('-EncodedCommand')).length === 1 // P44: array form, no trailing space
    && batchDecoded.includes('Python.Python.3.11') && batchDecoded.includes('Git.Git'));
  check('A8: fixed after elevation', rb.rows.every((r) => r.status === 'fixed'));

  // Refused elevation.
  calls = [];
  const depsC = engineDeps({
    execFn: mockExec([{ match: 'net session', code: 1 }, ...WIN_BASE], calls),
    askElevation: async () => false,
  });
  const rc = await fixAll(['Python', 'Git'], depsC);
  check('A9: refused elevation -> manual rows, no launch',
    rc.rows.every((r) => r.status === 'manual' && /administrateur refuses/.test(r.reason))
    && !calls.some((c) => c.includes('RunAs') || c.includes('winget install')));

  // UAC cancelled at the prompt (launch fails, empty log).
  const depsD = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', code: 1, stdout: '', stderr: 'cancelled' },
      ...WIN_BASE,
    ], []),
    askElevation: async () => true,
  });
  const rd = await fixAll(['Git'], depsD);
  check('A10: cancelled UAC -> manual UAC row', rd.rows[0].status === 'manual' && /UAC refusee/.test(rd.rows[0].reason), rd.rows[0]);

  // ------------------------------------------------- B. offline installers + SHA-256
  writeOffline('python-3.11-setup.exe');
  writeOffline('node-lts-x64.msi');
  calls = [];
  const depsE = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, ...winVerify(),
    ], calls),
    hasInternet: async () => false,
  });
  const re = await fixAll(['Python', 'Node.js'], depsE);
  check('B1: offline installs from folder', re.rows.every((r) => r.status === 'fixed' && r.method === 'offline'), re.rows);
  const psCmd = calls.find((c) => c.includes('-EncodedCommand '));
  const psf = decodeLaunch(psCmd).match(/\$log = '((?:''|[^'])+)'/);
  check('B2: journal cleaned after run', !fs.existsSync(psf[1].replace(/''/g, "'")));
  const rf = await fixAll(['Git'], engineDeps({ execFn: mockExec([{ match: 'net session', code: 0 }]), hasInternet: async () => false }));
  check('B3: missing installer -> manual with expected name',
    rf.rows[0].status === 'manual' && rf.rows[0].reason.includes('git-setup.exe') && rf.rows[0].reason.includes(OFFLINE), rf.rows[0].reason);
  fs.writeFileSync(path.join(OFFLINE, 'git-setup.exe'), 'bytes-no-sidecar');
  const rg = await fixAll(['Git'], engineDeps({ execFn: mockExec([{ match: 'net session', code: 0 }]), hasInternet: async () => false }));
  check('B4: missing sidecar -> manual .sha256', rg.rows[0].status === 'manual' && rg.rows[0].reason.includes('git-setup.exe.sha256'), rg.rows[0].reason);
  fs.writeFileSync(path.join(OFFLINE, 'git-setup.exe.sha256'), '0'.repeat(64) + '  git-setup.exe\n');
  calls = [];
  const rh = await fixAll(['Git'], engineDeps({ execFn: mockExec([{ match: 'net session', code: 0 }], calls), hasInternet: async () => false }));
  check('B5: bad hash -> failed, installer never executed',
    rh.rows[0].status === 'failed' && /SHA-256 invalide/.test(rh.rows[0].reason)
    && !calls.some((c) => c.includes('git-setup.exe')), rh.rows[0].reason);
  fs.unlinkSync(path.join(OFFLINE, 'git-setup.exe'));
  fs.unlinkSync(path.join(OFFLINE, 'git-setup.exe.sha256'));

  // winget missing -> offline fallback.
  calls = [];
  const ri = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'winget --version', code: 1 },
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, ...winVerify(),
    ], calls),
    hasInternet: async () => true,
  }));
  check('B6: no winget -> offline fallback', ri.rows[0].status === 'fixed' && ri.rows[0].method === 'offline');

  // ------------------------------------------------- C. verify gate, restart, chains, posix
  const rj = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'python --version', code: 1, stdout: '', stderr: 'not found' },
    ]),
  }));
  check('C1: install ok but --version fails -> failed (never success)', rj.rows[0].status === 'failed' && /verification echouee/.test(rj.rows[0].reason), rj.rows[0]);
  const rk = await fixAll(['Git'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({ S0: 3010 }) },
      ...WIN_BASE, ...winVerify(),
    ]),
  }));
  check('C2: exit 3010 -> restart row', rk.rows[0].status === 'restart' && /redemarrage requis/.test(rk.rows[0].reason), rk.rows[0]);
  const rl = await fixAll(['Docker'], engineDeps({
    execFn: mockExec([
      { match: 'winget --version', stdout: 'v1.0.0' },
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      { match: 'GetEnvironmentVariable', stdout: 'x' },
      { match: 'HyperVRequirement', stdout: 'False' },
      { match: 'docker --version', code: 1, stdout: '', stderr: 'no docker' },
    ]),
  }));
  check('C3: docker + virtualization off -> exact manual reason',
    rl.rows[0].status === 'manual' && /virtualisation desactivee/.test(rl.rows[0].reason), rl.rows[0].reason);
  const rm = await fixOne('pip', engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, ...winVerify(),
      { match: 'ensurepip', code: 0, stdout: 'ok' },
    ]),
  }));
  check('C4: pip pulls Python dep, both fixed',
    rm.rows.length === 2 && rm.rows.every((r) => r.status === 'fixed') && rm.row.issue === 'pip' && rm.row.method === 'ensurepip', rm.rows);
  const rn = await fixOne('npm', engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, ...winVerify(),
    ]),
  }));
  check('C5: npm fixed via Node reinstall', rn.row.status === 'fixed', rn.row);
  const ro = await fixOne('Nope', engineDeps({ execFn: mockExec([]) }));
  check('C6: unknown issue -> manual', ro.row.status === 'manual' && /inconnu/.test(ro.row.reason));
  const rp = await fixAll(['Python'], engineDeps({
    platform: 'linux',
    execFn: mockExec([{ match: 'sudo -n true', code: 1 }]),
  }));
  check('C7: linux no-passwordless-sudo -> one terminal cmd + manual',
    rp.terminalCmd.includes('apt-get install -y python3') && rp.rows[0].status === 'manual' && rp.rows[0].method === 'terminal', rp.terminalCmd);
  calls = [];
  const rq = await fixAll(['Python'], engineDeps({
    platform: 'linux',
    execFn: mockExec([
      { match: 'sudo -n true', code: 0 },
      { match: 'apt-get install', code: 0, stdout: 'done' },
      { match: 'python3 --version', stdout: 'Python 3.11.0' },
    ], calls),
  }));
  check('C8: linux headless sudo works', rq.rows[0].status === 'fixed' && calls.some((c) => c.includes('sudo apt-get')), rq.rows[0]);
  check('C9: ordering deps last', JSON.stringify(orderIssues(['pip', 'Python', 'Git'])) === JSON.stringify(['Python', 'Git', 'pip']));
  const ps = buildPsScript([{ id: 'S0', cmd: 'do-x' }], 'L:\\f.log');
  check('C10: ps template + parser roundtrip', ps.includes("DONE S0 code=") && parsePsLog('DONE S0 code=3010\n').S0 === 3010);
  check('C11: known tools', isKnownTool('Docker') && !isKnownTool('startBackend'));

  // ------------------------------------------------- D. panel wiring (win32 platform forced)
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    DoctorPanel.currentPanel = undefined;
    vscodeMock.window.panels.length = 0;
    vscodeMock.window.infos.length = 0;
    DoctorPanel.createOrShow({ fsPath: EXT });
    const dp = DoctorPanel.currentPanel;
    const panel = vscodeMock.window.panels[0];
    check('D0: panel created', panel.viewType === 'sudoDoctor');
    dp._dlPollMs = 10; dp._dlPollTries = 3;
    const realDeps = dp._engineDeps.bind(dp);
    dp._engineDeps = (p) => ({ ...realDeps(p),
      execFn: mockExec([
        { match: 'net session', code: 0 },
        { match: 'EncodedCommand', action: psRun({}) },
        ...WIN_BASE, ...winVerify(),
      ]),
      hasInternet: async () => true,
    });
    await dp.handleMessage({ type: 'autoFix', issue: 'Python' });
    const posted = panel.webview.posted;
    const done = posted.find((m) => m.type === 'fixDone');
    check('D1: autoFix executes + verifies + reports',
      posted.some((m) => m.type === 'fixStarted') && !!done && done.ok === true && /Corrige/.test(done.message), done);
    check('D2: user notified', vscodeMock.window.infos.some(([m]) => /AutoFix/.test(m)));
    // autoFixAll end-to-end with stubbed diagnostic.
    dp._gatherDiagnostics = async () => [
      { name: 'Python', status: 'error', value: 'Not found' },
      { name: 'Backend (port 5000)', status: 'error', value: 'Not running', fix: 'startBackend' },
      { name: 'AI Runtime (port 6000)', status: 'warn', value: 'Running (no model)', fix: 'downloadModel' },
    ];
    axiosMock.health = { model: { loading: true, download_progress: 10 } };
    panel.webview.posted.length = 0;
    await dp.handleMessage({ type: 'autoFixAll' });
    const p2 = panel.webview.posted;
    const allDone = p2.find((m) => m.type === 'fixAllDone');
    check('D3: autoFixAll streams progress + final table',
      p2.some((m) => m.type === 'fixAllStarted' && m.total === 3)
      && p2.filter((m) => m.type === 'fixAllRow').length === 3 && !!allDone && allDone.rows.length === 3,
      p2.map((m) => m.type));
    check('D4: table sorted in diagnostic order + mixed outcomes',
      allDone.rows.map((r) => r.issue).join() === 'Python,startBackend,downloadModel'
      && allDone.rows[0].status === 'fixed' && allDone.rows[1].status === 'manual' && allDone.rows[2].status === 'fixed',
      allDone.rows);
    check('D5: manual row carries exact command', /cd backend && node server\.js/.test(allDone.rows[1].reason));
    check('D6: audit extract written', audit().some((e) => e.action === 'AUTOFIX_ALL_DONE')
      && audit().some((e) => e.action === 'AUTOFIX_OK' && /Python/.test(e.detail)));
    panel.webview.posted.length = 0;
    await dp.handleMessage({ type: 'installSDK', sdk: 'Docker' });
    const d7 = panel.webview.posted.find((m) => m.type === 'fixDone');
    check('D7: installSDK routed to engine (no browser)', !!d7 && d7.issue === 'Docker');
    await dp.handleMessage({ type: 'installSDK', sdk: 'Nope' });
    check('D8: unknown SDK refused cleanly', vscodeMock.window.infos.some(([m]) => /not recognized/.test(m)));
    // Diagnostic intact (real commands, names must match the original set).
    delete dp._gatherDiagnostics;
    axiosMock.health = null;
    panel.webview.posted.length = 0;
    await dp.handleMessage({ type: 'runDiagnostic' });
    const diag = panel.webview.posted.find((m) => m.type === 'diagResults');
    const names = (diag.results || []).map((r) => r.name);
    check('D9: diagnostic untouched (same checks)',
      ['Node.js', 'npm', 'Python', 'pip', 'Git', 'Docker', 'Backend (port 5000)', 'AI Runtime (port 6000)', 'Platform', 'RAM']
        .every((n) => names.includes(n)), names);
    try { dp.dispose(); } catch (_) {}
    DoctorPanel.currentPanel = undefined;
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env.PATH = savedPath;
  }

  // ------------------------------------------------- E. no-browser proof + client + config
  check('E0: openExternal never called at runtime', vscodeMock.env.opened.length === 0, vscodeMock.env.opened);
  const docSrc = fs.readFileSync(path.join(EXT, 'src', 'panels', 'DoctorPanel.js'), 'utf8');
  const engSrc = fs.readFileSync(path.join(EXT, 'src', 'doctor', 'autoFix.js'), 'utf8');
  check('E1: no browser APIs/URLs in Doctor code',
    !docSrc.includes('openExternal') && !engSrc.includes('openExternal')
    && !/nodejs\.org|python\.org|git-scm|docker\.com\/get-docker|docker\.com\/products/.test(docSrc));
  const html = vscodeMock.window.panels[0].webview.html;
  const clientJs = html.split('<script>')[1].split('</scr' + 'ipt>')[0];
  let parses = true; let perr = '';
  try { new vm.Script(clientJs); } catch (e) { parses = false; perr = e.message; }
  check('E2: client parses', parses, perr);
  check('E3: progress + table UI present',
    clientJs.includes('renderFixTable') && clientJs.includes('showFixProgress')
    && clientJs.includes("type: 'autoFixAll'") && clientJs.includes("case 'fixAllDone'"));
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  check('E4: offline folder setting contributed',
    !!(pkg.contributes.configuration.properties || {})['sudoStudio.offlineInstallersDir']);
  const badAcc = [...engSrc].filter((c) => c.codePointAt(0) > 127 && !'éèêàâîôûçùÉÈÊÀ'.includes(c));
  check('E5: engine accents limited to Latin-1 French', badAcc.length === 0, [...new Set(badAcc)]);
  const banned = [...engSrc].filter((c) => /[\u2010-\u2030\u2190-\u21FF\u2600-\u27BF]/.test(c)
    || c.codePointAt(0) >= 0x1F000);
  check('E6: engine has zero banned chars', banned.length === 0, [...new Set(banned)]);

  console.log('\nP7: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { DoctorPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
