/**
 * MISSION PROMPT 44 - Elevated step that REALLY runs.
 * P44-1: RunAs -ArgumentList is an ARRAY of 5 separate arguments (the P40
 * single-string form reached the child as one argv entry -> granted UAC,
 * instant child exit, empty journal). P44-2: the journal gets up to 5 s
 * to show START before any no-start diagnosis, and the diagnosis names
 * the never-started command. P44-3: winget-9009 points at the offline
 * folder with the exact filename. P44-5: Docker prereq states
 * "redemarrage requis". Mocked exec, real timers where the wait itself
 * is under test. ASCII-only.
 * Run: node backend/tests/test-p44-autofix.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p44-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const LOGDIR = path.join(TMP_HOME, 'elevated-logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const AF_PATH = '../../sudo-ai-extension/src/doctor/autoFix';
const { fixAll, buildPsScript, buildEncodedLaunch, decodeEncodedLaunch,
  encodedLauncher, diagnoseMissingStep, readJournalSettled } = require(AF_PATH);

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}

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
function psRun(codes) {
  return async (cmd) => {
    const script = decodeEncodedLaunch(cmd);
    const ids = [...script.matchAll(/STEP ([A-Za-z0-9_]+)/g)].map((x) => x[1]);
    const lm = script.match(/\$log = '((?:''|[^'])+)'/);
    const log = lm[1].replace(/''/g, "'");
    const lines = ['START', ...ids.map((id) => 'DONE ' + id + ' code=' + (codes[id] !== undefined ? codes[id] : 0)), 'END'];
    fs.writeFileSync(log, lines.join('\n'), 'utf8');
  };
}
function engineDeps(o) {
  o = o || {};
  return {
    platform: o.platform || 'win32',
    execFn: o.execFn,
    hasInternet: o.hasInternet || (async () => true),
    askElevation: o.askElevation || (async () => false),
    audit: o.audit || (() => {}),
    offlineDir: o.offlineDir || path.join(TMP_HOME, 'installers'),
    onProgress: o.onProgress || (() => {}),
    installTimeoutMs: 5000,
    logDir: o.logDir || LOGDIR,
    dryRun: !!o.dryRun,
    journalSettleMs: o.journalSettleMs !== undefined ? o.journalSettleMs : 50,
  };
}
const WIN_BASE = [
  { match: 'winget --version', stdout: 'v1.7.10661' },
  { match: 'GetEnvironmentVariable', stdout: 'C:\\Windows\\System32' },
];

// Simulate the FIRST powershell's single-quote parsing: the outer
// -Command '...' string with '' escapes becomes the inner command line.
function outerUnescape(launcher) {
  const prefix = 'powershell -NoProfile -Command ';
  if (launcher.indexOf(prefix) !== 0) throw new Error('not an outer launcher');
  let inner = launcher.slice(prefix.length);
  if (inner[0] !== "'" || inner[inner.length - 1] !== "'") throw new Error('outer not single-quoted');
  return inner.slice(1, -1).replace(/''/g, "'");
}

async function main() {
  const savedPath = process.env.PATH;

  // ------------------------------------------------- A. RunAs array form (P44-1)
  const sample = "$log = 'C:\\logs\\a.log'\nL 'START'\nwinget install -e --id X.Y *>&1 | Select-Object -First 150";
  const b64 = buildEncodedLaunch(sample);
  const elev = encodedLauncher(true, b64);
  check('A1: elevated launcher carries an -ArgumentList ARRAY of 5 quoted args',
    elev.indexOf("-ArgumentList ''-NoProfile'',''-ExecutionPolicy'',''Bypass'',''-EncodedCommand'',''") !== -1 &&
    elev.indexOf(b64) !== -1, elev.slice(0, 260));
  check('A2: single-string form is gone (no one-element blob)',
    elev.indexOf("'-NoProfile -ExecutionPolicy") === -1, elev.slice(0, 260));
  const inner = outerUnescape(elev);
  const argPart = inner.split('-ArgumentList ')[1] || '';
  const elems = argPart.split(',').map((e) => e.trim()).filter(Boolean);
  check('A3: after outer unescape, the child gets exactly 5 argv entries',
    elems.length === 5 && elems[0] === "'-NoProfile'" && elems[1] === "'-ExecutionPolicy'" &&
    elems[2] === "'Bypass'" && elems[3] === "'-EncodedCommand'" &&
    elems[4] === "'" + b64 + "'", elems.map((e) => e.slice(0, 40)));
  check('A4: the 5th argv entry decodes back to the batch',
    Buffer.from(elems[4].slice(1, -1), 'base64').toString('utf16le') === sample);
  check('A5: decode works on the plain space form (unchanged)',
    decodeEncodedLaunch('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64) === sample);
  check('A6: decode works on the elevated array form',
    decodeEncodedLaunch(elev) === sample);
  let threw = '';
  try { decodeEncodedLaunch('powershell -NoProfile -Command Get-Date'); } catch (e) { threw = e.message; }
  check('A7: decode still throws without a payload', threw === 'EncodedCommand introuvable', threw);
  check('A8: non-elevated launcher unchanged (direct, no RunAs)',
    encodedLauncher(false, b64) === 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64);

  // ------------------------------------------------- B. settle wait + WHAT (P44-2)
  // B1: journal appears LATE (slow child flush): found, step fixed.
  let lateLog = '';
  const depsB1 = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', action: async (cmd) => {
        const script = decodeEncodedLaunch(cmd);
        const lm = script.match(/\$log = '((?:''|[^'])+)'/);
        lateLog = lm[1].replace(/''/g, "'");
        setTimeout(() => { // slow child: writes 300 ms AFTER the launch returns
          try { fs.writeFileSync(lateLog, 'START\nDONE S0 code=0\nEND', 'utf8'); } catch (_) {}
        }, 300);
      } },
      ...WIN_BASE,
      { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'python -m pip --version', stdout: 'pip 24.0' },
    ]),
    askElevation: async () => true,
    journalSettleMs: 2000,
  });
  const tB1 = Date.now();
  const rb1 = await fixAll(['Python'], depsB1);
  const eB1 = Date.now() - tB1;
  check('B1: late journal found within the settle window -> fixed',
    rb1.rows.length === 1 && rb1.rows[0].status === 'fixed', { rows: rb1.rows, ms: eB1 });
  // B2: still empty after settle -> diagnosis NAMES the unstarted command.
  let auditsB2 = [];
  const OFFB2 = path.join(TMP_HOME, 'installers-b2');
  const depsB2 = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', code: 0, stdout: '', stderr: '' }, // child writes NOTHING
      { match: 'winget --version', stdout: 'v1.7.10661' },
      { match: 'Get-ExecutionPolicy -List', stdout: 'MachinePolicy        Restricted\nProcess              Undefined' },
      { match: 'Get-WinEvent', stdout: '1116' },
    ]),
    askElevation: async () => true,
    audit: (a, d, r) => auditsB2.push({ a, d, r }),
    offlineDir: OFFB2,
    journalSettleMs: 100,
  });
  const rb2 = await fixAll(['Python'], depsB2);
  const noStartB2 = auditsB2.find((x) => x.a === 'AUTOFIX_NOSTART');
  check('B2: empty journal -> failed row naming the never-started command',
    rb2.rows[0].status === 'failed' &&
    rb2.rows[0].reason.indexOf('commande jamais demarree : winget install -e --id Python.Python.3.11') !== -1,
    rb2.rows[0].reason);
  check('B3: no-start audit lists the unstarted steps + keeps the probes',
    !!noStartB2 && noStartB2.d.indexOf('etapes non demarrees : Python:winget') !== -1 &&
    /politique d'execution/.test(noStartB2.d) && /winget : v1\.7/.test(noStartB2.d) &&
    /Defender/.test(noStartB2.d), noStartB2 && noStartB2.d);
  // B4: the PC default really is 5 s (no journalSettleMs dep -> ~5 s wait).
  const depsB4 = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', code: 0, stdout: '', stderr: '' },
      { match: 'Get-ExecutionPolicy -List', stdout: 'Process Undefined' },
      { match: 'winget --version', stdout: 'v1.7.10661' }, // present: plan keeps winget + launch
      { match: 'Get-WinEvent', code: 1 },
    ]),
    askElevation: async () => true,
  });
  delete depsB4.journalSettleMs; // exercise the engine default
  const tB4 = Date.now();
  await fixAll(['Git'], depsB4);
  const eB4 = Date.now() - tB4;
  check('B4: default settle is 5 s on an empty journal', eB4 >= 4500 && eB4 < 15000, eB4 + ' ms');
  // B5: readJournalSettled unit: immediate + missing file.
  const missing = await readJournalSettled(path.join(TMP_HOME, 'nope.log'), 0);
  check('B5: settled read, settleMs 0, missing file -> empty, logRead false',
    missing.text === '' && missing.logRead === false, missing);
  const jl = path.join(TMP_HOME, 'ready.log');
  fs.writeFileSync(jl, 'START\nDONE S0 code=0\nEND', 'utf8');
  const tB5 = Date.now();
  const ready = await readJournalSettled(jl, 2000);
  check('B6: present START returns at once (no pointless wait)',
    ready.logRead === true && /DONE S0 code=0/.test(ready.text) && (Date.now() - tB5) < 1500, ready.text);
  // B7: diagnoseMissingStep stays backward compatible (no cmd).
  const d7 = diagnoseMissingStep(905, { code: 0 }, '', true, {}, 'winget', null);
  check('B7: missing-step diagnosis without cmd keeps the legacy text',
    d7.short === 'script non execute' && /UAC validee mais script non demarre/.test(d7.reason) &&
    d7.reason.indexOf('commande jamais demarree') === -1, d7.reason);

  // ------------------------------------------------- C. winget 9009 (P44-3)
  const OFFC = path.join(TMP_HOME, 'installers-c');
  const rc1 = await fixAll(['Python'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: async (cmd) => {
        const lm = decodeEncodedLaunch(cmd).match(/\$log = '((?:''|[^'])+)'/);
        fs.writeFileSync(lm[1].replace(/''/g, "'"), 'START\nSTEP S0\nDONE S0 code=\nEND', 'utf8');
      } },
      ...WIN_BASE,
      { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'python -m pip --version', stdout: 'pip 24.0' },
    ]),
    offlineDir: OFFC,
  }));
  check('C1: winget 9009 stays failed but names the exact offline file',
    rc1.rows[0].status === 'failed' && /code 9009/.test(rc1.rows[0].reason) &&
    rc1.rows[0].reason.indexOf("importez 'python-3.11-setup.exe'") !== -1 &&
    rc1.rows[0].reason.indexOf(OFFC) !== -1, rc1.rows[0].reason);

  // ------------------------------------------------- D. Docker wording (P44-5)
  let auditsD = [];
  const rd1 = await fixAll(['Docker'], engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'HyperVRequirementVirtualizationFirmwareEnabled', stdout: 'True' },
      { match: 'wsl --status', stdout: 'Default Version: 2' },
      { match: 'docker --version', stdout: 'Docker version 24.0.0' },
    ]),
    audit: (a, d, r) => auditsD.push({ a, d, r }),
  }));
  const preD = auditsD.find((x) => x.a === 'AUTOFIX_PREREQ');
  check('D1: Docker row + prereq state the exact "redemarrage requis"',
    rd1.rows[0].status === 'fixed' &&
    rd1.rows[0].reason.indexOf('redemarrage requis') !== -1 &&
    !!preD && preD.d.indexOf('redemarrage requis') !== -1 &&
    /virtualisation=oui/.test(preD.d) && /wsl2=oui/.test(preD.d),
    { row: rd1.rows[0].reason, prereq: preD && preD.d });

  // ------------------------------------------------- E. real-probe wiring (P44-4)
  const panelSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'panels', 'DoctorPanel.js'), 'utf8');
  check('E1: panel never injects hasInternet -> engine uses the real winget-source probe',
    panelSrc.indexOf('fixAll') !== -1 && panelSrc.indexOf('hasInternet') === -1);

  // ------------------------------------------------- F. chain script markers (P44 preuves)
  const chainSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'verify', 'test-elevated-chain.js'), 'utf8');
  for (const k of ['whoami', '--elevated', '--direct', 'encodedLauncher', 'buildPsScript',
      'Get-ExecutionPolicy -List', 'winget --version', 'SKIP', 'journal-has-START', 'journal-has-END']) {
    check('F: chain script contains ' + k, chainSrc.indexOf(k) !== -1);
  }

  process.env.PATH = savedPath;
  console.log('\nP44: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { process.exit(process.exitCode || 0); });
