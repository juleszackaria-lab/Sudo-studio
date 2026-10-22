/**
 * MISSION PROMPT 40 - Elevated step WITHOUT a script file: batch through
 * -EncodedCommand, journal pre-created before elevation in a folder both
 * levels can reach, precise no-start diagnosis (execution policy, winget,
 * Defender), real winget-source connectivity probe, Docker prerequisites.
 * Mocked exec + local HTTP server. ASCII-only.
 * Run: node backend/tests/test-p40-elevated.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p40-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const LOGDIR = path.join(TMP_HOME, 'elevated-logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const { fixAll, buildEncodedLaunch, decodeEncodedLaunch, encodedLauncher,
  probeWingetSource, defaultHasInternet, diagnoseElevatedNoStart } =
  require('../../sudo-ai-extension/src/doctor/autoFix');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}

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
// Simulate the elevated batch: decode the -EncodedCommand payload, write DONE markers to $log.
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
    journalSettleMs: o.journalSettleMs !== undefined ? o.journalSettleMs : 50, // P44: fast tests, PC uses 5000
  };
}
const WIN_BASE = [
  { match: 'winget --version', stdout: 'v1.7.10661' },
  { match: 'GetEnvironmentVariable', stdout: 'C:\\Windows\\System32' },
];

async function main() {
  const savedPath = process.env.PATH;

  // ------------------------------------------------- A. EncodedCommand roundtrip (P40-a)
  const sample = "$log = 'C:\\logs\\a.log'\nWrite-Host \"STEP S0\"\n& winget install -e --id X.Y ; exit $LASTEXITCODE";
  const b64 = buildEncodedLaunch(sample);
  check('A1: payload is strict base64', /^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 0);
  check('A2: decode(encode(x)) === x incl. quotes/$/newlines',
    decodeEncodedLaunch('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64) === sample);
  const plain = encodedLauncher(false, b64);
  check('A3: non-elevated launcher = direct powershell, no RunAs, no -File',
    plain === 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64);
  const elev = encodedLauncher(true, b64);
  check('A4: elevated launcher = one RunAs process, no -File',
    /^powershell -NoProfile -Command /.test(elev) && /RunAs/.test(elev) &&
    /-EncodedCommand/.test(elev) && !/-File /.test(elev) && !/\.ps1/.test(elev), elev.slice(0, 300)); // P44: array form
  check('A5: elevated payload decodes back to the batch', decodeEncodedLaunch(elev) === sample);

  // ------------------------------------------------- B. journal pre-created, no script file (P40-a)
  let calls = [];
  let audits = [];
  let capturedLog = '';
  const depsB = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: async (cmd) => {
        capturedLog = decodeEncodedLaunch(cmd).match(/\$log = '((?:''|[^'])+)'/)[1].replace(/''/g, "'");
        await psRun({})(cmd);
      } },
      ...WIN_BASE,
      { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'python -m pip --version', stdout: 'pip 24.0' },
    ], calls),
    audit: (a, d, r) => audits.push({ a, d, r }),
  });
  const rb = await fixAll(['Python'], depsB);
  check('B1: one encoded launch, zero -File call',
    calls.filter((c) => c.includes('-EncodedCommand ')).length === 1 &&
    !calls.some((c) => c.includes('-File ')), calls.map((c) => c.slice(0, 80)));
  check('B2: journal audited with the pre-created folder',
    audits.some((x) => x.a === 'AUTOFIX_LOGDIR' && x.d.indexOf(LOGDIR) === 0), audits);
  check('B3: decoded batch points $log inside that folder', capturedLog.indexOf(LOGDIR) === 0, capturedLog);
  check('B4: journal cleaned after run', capturedLog && !fs.existsSync(capturedLog));
  check('B5: step still fixed', rb.rows.length === 1 && rb.rows[0].status === 'fixed', rb.rows);

  // ------------------------------------------------- C. elevation chain: harmless order, log pre-exists (P40 preuves)
  calls = [];
  let logPreExisted = null;
  let decodedC = '';
  let elevCount = 0;
  const depsC = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      { match: 'EncodedCommand', action: async (cmd) => {
        decodedC = decodeEncodedLaunch(cmd);
        const lp = decodedC.match(/\$log = '((?:''|[^'])+)'/)[1].replace(/''/g, "'");
        logPreExisted = fs.existsSync(lp); // engine must create it BEFORE elevation
        await psRun({})(cmd);
      } },
      ...WIN_BASE,
      { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'python -m pip --version', stdout: 'pip 24.0' },
      { match: 'git --version', stdout: 'git version 2.40.0' },
    ], calls),
    askElevation: async () => { elevCount++; return true; },
  });
  const rc = await fixAll(['Python', 'Git'], depsC);
  check('C1: journal file pre-exists at launch time (created before elevation)', logPreExisted === true);
  check('C2: single RunAs launch carries the whole batch',
    calls.filter((c) => c.includes('RunAs')).length === 1 && elevCount === 1 &&
    /Python\.Python\.3/.test(decodedC) && /Git\.Git/.test(decodedC));
  check('C3: batch references no .ps1 file', decodedC && !/\.ps1/.test(decodedC));
  check('C4: all fixed after elevation', rc.rows.every((r) => r.status === 'fixed'), rc.rows);

  // ------------------------------------------------- D. granted UAC + empty journal -> precise cause (P40-b)
  calls = [];
  audits = [];
  const depsD = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 1 },
      // Elevated child writes NOTHING (the PC symptom): code 0, empty journal.
      { match: 'EncodedCommand', code: 0, stdout: '', stderr: '' },
      { match: 'winget --version', stdout: 'v1.7.10661' },
      { match: 'Get-ExecutionPolicy -List', stdout: 'MachinePolicy        Restricted\nUserPolicy           Undefined\nProcess              Undefined' },
      { match: 'Get-WinEvent', stdout: '1116\n1117' },
      ...WIN_BASE,
    ], calls),
    askElevation: async () => true,
    audit: (a, d, r) => audits.push({ a, d, r }),
  });
  const rd = await fixAll(['Python'], depsD);
  const noStart = audits.find((x) => x.a === 'AUTOFIX_NOSTART');
  check('D1: no-start diagnostics audited', !!noStart && /politique d'execution/.test(noStart.d), noStart);
  check('D2: reason names the execution policy', rd.rows[0].status === 'failed' &&
    /script non execute/.test(rd.rows[0].reason) && /MachinePolicy.*Restricted/.test(rd.rows[0].reason), rd.rows[0].reason);
  check('D3: reason quotes winget + Defender probes',
    /winget : v1\.7/.test(rd.rows[0].reason) && /Defender : evenements recents : 1116,1117/.test(rd.rows[0].reason),
    rd.rows[0].reason);
  check('D4: every probe ran without elevation (plain commands, no RunAs)',
    calls.filter((c) => c.includes('RunAs')).length === 1 &&
    calls.some((c) => c.includes('Get-ExecutionPolicy')) && calls.some((c) => c.includes('Get-WinEvent')));
  const diagDirect = await diagnoseElevatedNoStart(mockExec([
    { match: 'Get-ExecutionPolicy', code: 1 },
    { match: 'winget --version', code: 1 },
    { match: 'Get-WinEvent', code: 1 },
  ]));
  check('D5: no-start diag never silent even when probes fail',
    /illisible \(code 1\)/.test(diagDirect) && /absent \(code 1\)/.test(diagDirect) &&
    /journal illisible \(code 1\)/.test(diagDirect), diagDirect);

  // ------------------------------------------------- E. real connectivity probe (P40-d)
  const srv = http.createServer((req, res) => { res.statusCode = 404; res.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const srvPort = srv.address().port;
  const up = await probeWingetSource({ protocol: 'http:', host: '127.0.0.1', port: srvPort, path: '/cache', timeoutMs: 2000 });
  check('E1: ANY http answer counts as reachable', up.ok === true && /HTTP 404/.test(up.detail) &&
    typeof up.ms === 'number' && up.ms >= 0, up);
  await new Promise((r) => srv.close(r));
  const down = await probeWingetSource({ protocol: 'http:', host: '127.0.0.1', port: srvPort, path: '/cache', timeoutMs: 800 });
  check('E2: closed port -> ok=false with precise detail', down.ok === false && /injoignable/.test(down.detail) &&
    /127\.0\.0\.1/.test(down.detail), down);
  const badHost = await probeWingetSource({ protocol: 'http:', host: 'nonexistent-winget-test.invalid', timeoutMs: 800 });
  check('E3: bad host -> ok=false, never throws', badHost.ok === false && typeof badHost.detail === 'string' &&
    badHost.detail.length > 0, badHost);
  let internetBool = null;
  try { internetBool = await defaultHasInternet(); } catch (_) { internetBool = 'THREW'; }
  check('E4: defaultHasInternet resolves a boolean, never throws', typeof internetBool === 'boolean', internetBool);
  // Wiring: injected test used when provided, real probe otherwise (precheck journal).
  audits = [];
  await fixAll(['Python'], engineDeps({
    execFn: mockExec([{ match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE, { match: 'python --version', stdout: 'Python 3.11.0' },
      { match: 'python -m pip --version', stdout: 'pip 24.0' }]),
    hasInternet: async () => true,
    audit: (a, d, r) => audits.push({ a, d, r }),
  }));
  const pre = audits.find((x) => x.a === 'AUTOFIX_PRECHECK');
  check('E5: precheck journals network source', !!pre && /reseau=oui/.test(pre.d) && /test fourni/.test(pre.d), pre && pre.d);

  // ------------------------------------------------- F. Docker prerequisites (P40-e)
  audits = [];
  const depsF1 = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'HyperVRequirementVirtualizationFirmwareEnabled', stdout: 'True' },
      { match: 'wsl --status', stdout: 'Default Version: 2' },
      { match: 'docker --version', stdout: 'Docker version 24.0.0' },
    ]),
    audit: (a, d, r) => audits.push({ a, d, r }),
  });
  const rf1 = await fixAll(['Docker'], depsF1);
  const prereq = audits.find((x) => x.a === 'AUTOFIX_PREREQ');
  check('F1: Docker prereqs audited up front', !!prereq && /virtualisation=oui/.test(prereq.d) &&
    /wsl2=oui/.test(prereq.d) && /redemarrage/.test(prereq.d), prereq);
  check('F2: reboot warning rides on the Docker row',
    rf1.rows[0].status === 'fixed' && /prerequis Docker/.test(rf1.rows[0].reason) &&
    /redemarrage/.test(rf1.rows[0].reason), rf1.rows[0].reason);
  const depsF2 = engineDeps({
    execFn: mockExec([
      { match: 'net session', code: 0 },
      { match: 'EncodedCommand', action: psRun({}) },
      ...WIN_BASE,
      { match: 'HyperVRequirementVirtualizationFirmwareEnabled', stdout: 'False' },
      { match: 'wsl --status', code: 1 },
    ]),
  });
  const rf2 = await fixAll(['Docker'], depsF2);
  check('F3: virtualization off -> manual row keeps its cause + prereq suffix',
    rf2.rows[0].status === 'manual' && /virtualisation desactivee/.test(rf2.rows[0].reason) &&
    /prerequis Docker/.test(rf2.rows[0].reason), rf2.rows[0].reason);
  let dryCalls = 0;
  audits = [];
  const rf3 = await fixAll(['Docker'], engineDeps({
    execFn: async () => { dryCalls++; return { code: 0, stdout: '', stderr: '' }; },
    audit: (a, d, r) => audits.push({ a, d, r }),
    dryRun: true,
  }));
  check('F4: dry-run executes nothing, audits no prereq',
    dryCalls === 0 && !audits.some((x) => x.a === 'AUTOFIX_PREREQ') &&
    rf3.rows[0].status === 'dry-run', { dryCalls, audits: audits.map((x) => x.a) });

  process.env.PATH = savedPath;
  console.log('\nP40: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { process.exit(process.exitCode || 0); });
