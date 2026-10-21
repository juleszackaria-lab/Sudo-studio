/**
 * MISSION PROMPT 19 - AutoFix diagnosis (Python, pip, Docker): every step journaled
 * (exact command, exit code, last-30 output, duration, elevation), winget/network/
 * offline pre-detection, precise causes instead of "etape interrompue", strict
 * --version gate. Mocked exec + panel. ASCII-only.
 * Run: node backend/tests/test-p19-autofix.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');
const OFFLINE = path.join(TMP_HOME, 'installers');
fs.mkdirSync(OFFLINE, { recursive: true });

// ---- vscode + axios mocks (panel proof only) ----
const vscodeMock = {
  ViewColumn: { One: 1 },
  window: {
    panels: [], infos: [],
    createWebviewPanel(vt, title) {
      const p = { viewType: vt, title, revealed: 0,
        webview: { html: '', posted: [], async postMessage(m) { this.posted.push(m); return true; }, onDidReceiveMessage() {} },
        reveal() { this.revealed++; }, onDidDispose() {}, dispose() {} };
      vscodeMock.window.panels.push(p);
      return p;
    },
    async showInformationMessage(m) { vscodeMock.window.infos.push(m); return undefined; },
    showErrorMessage() {},
    createTerminal() { return { show() {}, sendText() {} }; },
  },
  env: { async openExternal() {} },
  workspace: { getConfiguration() { return { get: (k, d) => d, update: async () => {} }; } },
  commands: { async executeCommand() {} },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
};
const axiosMock = { async post() { return { data: {} }; }, async get(u) { const e = new Error('x'); e.code = 'X'; throw e; } };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  if (req === 'axios') return axiosMock;
  return origLoad.call(this, req, parent, isMain);
};

const { fixAll, buildPsScript, parsePsLog, parsePsStepOutputs, diagnoseMissingStep, decodeEncodedLaunch } =
  require('../../sudo-ai-extension/src/doctor/autoFix');
const { DoctorPanel } = require('../../sudo-ai-extension/src/panels/DoctorPanel');

let pass = 0;
const ALL_ROWS = [];
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}
function collect(rows) { for (const r of rows || []) ALL_ROWS.push(r); }

// Scripted exec: first substring match wins; supports code/stdout/stderr/timedOut/throw/action.
function mockExec(scenarios, calls) {
  return async (cmd, opts) => {
    (calls || []).push(cmd);
    for (const s of scenarios) {
      if (cmd.includes(s.match)) {
        if (s.throw) throw new Error(s.throw);
        if (s.action) await s.action(cmd);
        return { code: s.code !== undefined ? s.code : 0, stdout: s.stdout || '', stderr: s.stderr || '',
          timedOut: !!s.timedOut };
      }
    }
    return { code: 1, stdout: '', stderr: 'UNSCRIPTED: ' + cmd.slice(0, 120) };
  };
}
// Simulate the PowerShell batch run: DONE markers + optional OUTPUT sections.
function psRun(codes, outputs) {
  return async (cmd) => {
    const script = decodeEncodedLaunch(cmd);
    const ids = [...script.matchAll(/STEP ([A-Za-z0-9_]+)/g)].map((x) => x[1]);
    const lm = script.match(/\$log = '((?:''|[^'])+)'/);
    const log = lm[1].replace(/''/g, "'");
    const lines = ['START'];
    for (const id of ids) {
      if (outputs && outputs[id] !== undefined && outputs[id] !== null) {
        lines.push('OUTPUT ' + id, outputs[id], 'ENDOUTPUT ' + id);
      }
      if (!codes || codes[id] !== null) lines.push('DONE ' + id + ' code=' + (codes && codes[id] !== undefined ? codes[id] : 0));
    }
    lines.push('END');
    fs.writeFileSync(log, lines.join('\n'), 'utf8');
  };
}
const WIN_BASE = [
  { match: 'winget --version', stdout: 'v1.7.10661' },
  { match: 'GetEnvironmentVariable', stdout: 'C:\\Windows\\System32' },
];
const WIN_VERIFY = [
  { match: 'python -m pip --version', stdout: 'pip 24.0' },
  { match: 'python --version', stdout: 'Python 3.11.0' },
  { match: 'pip --version', stdout: 'pip 24.0' },
  { match: 'docker --version', stdout: 'Docker version 24.0.0' },
];
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

async function main() {
  const savedPath = process.env.PATH;

  // ------------------------------------------------- A. pre-detection journal (P19-b)
  fs.writeFileSync(path.join(OFFLINE, 'dummy-tool.exe'), 'x');
  let audits = [];
  const depsA1 = engineDeps({
    execFn: mockExec([{ match: 'net session', code: 0 }, { match: 'EncodedCommand', action: psRun({}) }, ...WIN_BASE, ...WIN_VERIFY]),
    audit: (a, d, r) => audits.push({ a, d, r }),
  });
  const ra1 = await fixAll(['Python'], depsA1);
  collect(ra1.rows);
  const pre1 = audits.find((e) => e.a === 'AUTOFIX_PRECHECK');
  check('A1: precheck journals exact winget text + network + offline listing',
    !!pre1 && pre1.d.includes('v1.7.10661') && pre1.d.includes('reseau=oui') &&
    pre1.d.includes(OFFLINE) && pre1.d.includes('dummy-tool.exe') && pre1.r === 'ok', pre1);

  // winget absent + online + installer present -> offline fallback, precheck flags missing.
  const crypto = require('crypto');
  const pyf = path.join(OFFLINE, 'python-3.11-setup.exe');
  fs.writeFileSync(pyf, 'fake-installer');
  fs.writeFileSync(pyf + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(pyf)).digest('hex') + '  f\n');
  audits = [];
  const ra2 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'winget --version', code: 1 }, { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) }, ...WIN_BASE, ...WIN_VERIFY]),
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  collect(ra2.rows);
  const pre2 = audits.find((e) => e.a === 'AUTOFIX_PRECHECK');
  check('A2: winget absent -> precheck missing + offline fallback still fixes',
    !!pre2 && /absent \(code 1\)/.test(pre2.d) && pre2.r === 'missing' &&
    ra2.rows[0].status === 'fixed' && ra2.rows[0].method === 'offline', { pre2, row: ra2.rows[0] });

  // offline mode: winget not probed, said explicitly.
  audits = [];
  const ra3 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'net session', code: 0 }, { match: 'EncodedCommand', action: psRun({}) }, ...WIN_BASE, ...WIN_VERIFY]),
    hasInternet: async () => false,
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  collect(ra3.rows);
  const pre3 = audits.find((e) => e.a === 'AUTOFIX_PRECHECK');
  check('A3: offline -> winget not probed, network flagged',
    !!pre3 && pre3.d.includes('non teste (hors ligne)') && pre3.d.includes('reseau=non'), pre3);

  // winget absent + online + installer missing -> exact required message.
  const OFFLINE_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-off-'));
  const ra4 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'winget --version', code: 1 }, { match: 'net session', code: 0 }]),
    offlineDir: OFFLINE_EMPTY,
  }));
  collect(ra4.rows);
  check('A4: exact winget-absent message with expected filename',
    ra4.rows[0].status === 'manual' &&
    ra4.rows[0].reason === "winget absent : importez 'python-3.11-setup.exe' (installateur Python) dans : " + OFFLINE_EMPTY,
    ra4.rows[0].reason);

  // ------------------------------------------------- B. precise causes (P19-c)
  // B1: legacy unparseable DONE (empty code) -> 9009, precise failure.
  const rb1 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: async (cmd) => {
        const lm = decodeEncodedLaunch(cmd).match(/\$log = '((?:''|[^'])+)'/);
        fs.writeFileSync(lm[1].replace(/''/g, "'"), 'START\nSTEP S0\nDONE S0 code=\nEND', 'utf8');
      } },
      ...WIN_BASE, ...WIN_VERIFY,
    ]),
  }));
  collect(rb1.rows);
  check('B1: empty DONE code -> 9009 failure, never silent',
    rb1.rows[0].status === 'failed' && /code 9009/.test(rb1.rows[0].reason), rb1.rows[0]);

  // B2: step stderr surfaced in the reason.
  const rb2 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({ S0: 1 }, { S0: 'ERROR: winget install failed 0x80070005 access denied' }) },
      ...WIN_BASE, ...WIN_VERIFY,
    ]),
  }));
  collect(rb2.rows);
  check('B2: program stderr quoted in the failure reason',
    rb2.rows[0].status === 'failed' && rb2.rows[0].reason.includes('0x80070005 access denied'), rb2.rows[0].reason);

  // B3: timeout -> "delai depasse".
  const rb3 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', code: 1, timedOut: true, stdout: '', stderr: 'killed by timeout' },
      ...WIN_BASE, ...WIN_VERIFY,
    ]),
  }));
  collect(rb3.rows);
  check('B3: timeout -> delai depasse with duration',
    rb3.rows[0].status === 'failed' && /delai depasse \(\d+ ms\)/.test(rb3.rows[0].reason), rb3.rows[0].reason);

  // B4: non-elevated launch failure -> code + stderr tail.
  const rb4 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', code: 1, stdout: '', stderr: 'cannot run script: policy block' },
      ...WIN_BASE, ...WIN_VERIFY,
    ]),
  }));
  collect(rb4.rows);
  check('B4: launch failure -> code + stderr tail',
    rb4.rows[0].status === 'failed' && rb4.rows[0].reason.includes('lancement echoue (code 1)') &&
    rb4.rows[0].reason.includes('policy block'), rb4.rows[0].reason);

  // B5: START but no DONE -> interrupted script + last lines.
  const rb5 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: async (cmd) => {
        const lm = decodeEncodedLaunch(cmd).match(/\$log = '((?:''|[^'])+)'/);
        fs.writeFileSync(lm[1].replace(/''/g, "'"), 'START\nSTEP S0\nOUTPUT S0\nwinget line one\ninterrupted here', 'utf8');
      } },
      ...WIN_BASE, ...WIN_VERIFY,
    ]),
  }));
  collect(rb5.rows);
  check('B5: START without DONE -> interrupted script + last lines',
    rb5.rows[0].status === 'failed' && rb5.rows[0].reason.includes('etape non executee') &&
    rb5.rows[0].reason.includes('dernieres lignes') && rb5.rows[0].reason.includes('interrupted here'), rb5.rows[0].reason);

  check('B6: generic message gone from every row', ALL_ROWS.every((r) => !/aucun resultat/.test(r.reason)),
    ALL_ROWS.map((r) => r.reason));

  // ------------------------------------------------- C. per-step journal (P19-a)
  // C1: elevated batch step entry (exact cmd, code, batch ms, elevation granted).
  audits = [];
  const rc1 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'net session', code: 1 }, { match: 'EncodedCommand', action: psRun({}) }, ...WIN_BASE, ...WIN_VERIFY]),
    askElevation: async () => true,
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  collect(rc1.rows);
  const st1 = audits.find((e) => e.a === 'AUTOFIX_STEP' && e.d.includes('Python [winget]'));
  check('C1: elevated step journaled (exact cmd, code, ms, elevation)',
    !!st1 && st1.d.includes('winget install -e --id Python.Python.3.11') && st1.d.includes('code=0') &&
    /lot_ms=\d+/.test(st1.d) && st1.d.includes('elevation=accordee') && st1.r === 'ok', st1);

  // C2: admin run -> elevation not required.
  const stA1 = audits.find((e) => e.a === 'AUTOFIX_STEP' && e.d.includes('[winget:verification]'));
  check('C2: verify step journaled with exact check command',
    !!stA1 && stA1.d.includes('cmd=python --version') && /duree_ms=\d+/.test(stA1.d) && stA1.r === 'ok', stA1);

  // C3: 50-line output -> last 30 only in the journal.
  const fifty = Array.from({ length: 50 }, (_, i) => 'L' + String(i + 1).padStart(2, '0')).join('\n');
  audits = [];
  const rc3 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}, { S0: fifty }) }, ...WIN_BASE, ...WIN_VERIFY]),
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  collect(rc3.rows);
  const st3 = audits.find((e) => e.a === 'AUTOFIX_STEP' && e.d.includes('Python [winget]'));
  check('C3: journal keeps the last 30 lines, drops the first ones',
    !!st3 && st3.d.includes('L50') && !st3.d.includes('L01') && st3.d.includes('elevation=non requise'), st3 && st3.d.slice(0, 300));

  // C4: posix step (exact sudo cmd, code, ms, stderr in tail).
  audits = [];
  const calls5 = [];
  const rc5 = await fixAll(['Python'], engineDeps({
    platform: 'linux',
    execFn: mockExec([
      { match: 'sudo -n true', code: 0 },
      { match: 'apt-get install', code: 0, stdout: 'reading packages', stderr: 'warn-line: no cache' },
      { match: 'python3 --version', stdout: 'Python 3.11.0' },
    ], calls5),
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  collect(rc5.rows);
  const st5 = audits.find((e) => e.a === 'AUTOFIX_STEP' && e.d.includes('Python [apt]'));
  check('C4: posix step journaled (exact sudo cmd, code, ms, stderr tail)',
    !!st5 && st5.d.includes('sudo apt-get install -y python3 python3-pip') && st5.d.includes('code=0') &&
    /duree_ms=\d+/.test(st5.d) && st5.d.includes('warn-line: no cache') && st5.r === 'ok', st5);

  // ------------------------------------------------- D. verify gate (P19-d)
  calls5.length = 0;
  const callsD = [];
  const rd1 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'net session', code: 0 }, { match: 'EncodedCommand', action: psRun({}) }, ...WIN_BASE, ...WIN_VERIFY], callsD),
  }));
  collect(rd1.rows);
  check('D1: python fixed only via exact python --version gate',
    rd1.rows[0].status === 'fixed' && rd1.rows[0].reason.includes('Python 3.11') &&
    callsD.some((c) => c.includes('python --version')), { row: rd1.rows[0], callsD });

  const callsPip = [];
  const rd2 = await fixAll(['pip'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'python -m pip --version', code: 1, stdout: '', stderr: 'no pip' },
      { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'pip --version', code: 1, stdout: '', stderr: 'no pip' },
    ], callsPip),
  }));
  collect(rd2.rows);
  const pipRow = rd2.rows.find((r) => r.issue === 'pip');
  check('D2: pip install ok but pip --version fails -> failed, never fixed',
    pipRow && pipRow.status === 'failed' && /verification echouee/.test(pipRow.reason) &&
    callsPip.some((c) => c.includes('pip --version')), pipRow);

  const callsDk = [];
  const rd3 = await fixAll(['Docker'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'HyperVRequirement', throw: 'exec lost' },
      { match: 'docker --version', code: 1, stdout: '', stderr: 'no docker' },
    ], callsDk),
  }));
  collect(rd3.rows);
  check('D3: docker install ok but docker --version fails -> failed',
    rd3.rows[0].status === 'failed' && /verification echouee/.test(rd3.rows[0].reason) &&
    callsDk.some((c) => c.includes('docker --version')), rd3.rows[0]);

  check('D4: exact gate commands used (python/pip/docker --version)',
    callsD.some((c) => /(^| )python --version/.test(c)) && callsPip.some((c) => /(^| )pip --version/.test(c)) &&
    callsDk.some((c) => c.includes('docker --version')));

  // ------------------------------------------------- E. units + panel display
  const ps = buildPsScript([{ id: 'S0', cmd: 'do-x' }], 'L:\\f.log');
  check('E1: ps template captures output + null-safe DONE; parsers roundtrip',
    ps.includes('OUTPUT S0') && ps.includes('ENDOUTPUT S0') && ps.includes('$null -eq') &&
    ps.includes('DONE S0 code=') && parsePsLog('DONE S0 code=\n').S0 === 9009 &&
    parsePsLog('DONE S0 code=3010\n').S0 === 3010 &&
    JSON.stringify(parsePsStepOutputs('START\nOUTPUT S0\na\nb\nENDOUTPUT S0\nOUTPUT S1\norphan\n')) ===
      JSON.stringify({ S0: 'a\nb', S1: 'orphan' }), ps.slice(0, 200));

  const dgT = diagnoseMissingStep(999, { timedOut: true }, '', true, {}, 'winget');
  const dgL = diagnoseMissingStep(5, { code: 3, stderr: 'boom' }, '', true, {}, 'winget');
  const dgE = diagnoseMissingStep(5, { code: 0 }, '', true, {}, 'winget');
  const dgP = diagnoseMissingStep(5, { code: 0 }, 'START\nDONE S0 code=0\nSTEP S1', true, { S0: 0 }, 'winget');
  check('E2: diagnoseMissingStep covers timeout/launch/empty/partial',
    /delai depasse \(999 ms\)/.test(dgT.reason) && /lancement echoue \(code 3\)/.test(dgL.reason) &&
    dgL.reason.includes('boom') && /n'a rien ecrit/.test(dgE.reason) &&
    /1 etape\(s\) terminee\(s\)/.test(dgP.reason));

  const engSrc = fs.readFileSync(path.join(EXT, 'src', 'doctor', 'autoFix.js'), 'utf8');
  check('E3: generic message fully removed from the engine',
    !engSrc.includes('aucun resultat') && !engSrc.includes('etape interrompue'));

  // E4: panel shows the precise cause in the final row.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    DoctorPanel.currentPanel = undefined;
    vscodeMock.window.panels.length = 0;
    DoctorPanel.createOrShow({ fsPath: EXT });
    const dp = DoctorPanel.currentPanel;
    const panel = vscodeMock.window.panels[0];
    const realDeps = dp._engineDeps.bind(dp);
    dp._engineDeps = (p) => ({ ...realDeps(p),
      execFn: mockExec([
        { match: 'net session', code: 0 },
        { match: 'EncodedCommand', code: 1, timedOut: true, stdout: '', stderr: 'killed' },
        ...WIN_BASE, ...WIN_VERIFY,
      ]),
      hasInternet: async () => true,
    });
    await dp.handleMessage({ type: 'autoFix', issue: 'Python' });
    const done = panel.webview.posted.find((m) => m.type === 'fixDone');
    check('E4: panel row shows precise cause (Echec + delai depasse)',
      !!done && done.ok === false && /^Echec \(Python\) : delai depasse/.test(done.message) &&
      /delai depasse/.test(done.row.reason), done);
    try { dp.dispose(); } catch (_) {}
    DoctorPanel.currentPanel = undefined;
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env.PATH = savedPath;
  }

  console.log('\nP19: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { DoctorPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
