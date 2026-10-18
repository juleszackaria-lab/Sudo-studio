/**
 * SUDO STUDIO - P33: fresh runtime artifact + journal header first +
 * single logs folder + open/export follow it.
 * A: stale-runtime guard script + packager-03 doc patch
 * B: P21 session header is the FIRST journal line, build carries the commit
 * C: single logs folder (%LOCALAPPDATA%\SudoStudio\logs) for every writer
 * D: "open logs folder" + "export diagnostics" resolve to that folder
 * E: new files ASCII-only + selftest still green with the new require
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const bs = String.fromCharCode(92);
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'p33-' + name + '-')); }

// -- A: stale-runtime guard ---------------------------------------------------
const guard = read('scripts/ci/check-runtime-fresh.ps1');
check('A1: guard compares the 02 run date with the last runtime touch', () => {
  for (const m of ['actions/runs/', 'log -1', '--format=', 'backend/runtime',
      'created_at', 'conclusion', 'success', 'GH_TOKEN', 'GITHUB_TOKEN',
      '[RUNTIME-FRESH] FAIL', '[RUNTIME-FRESH] PASS', 'Re-run workflow 02',
      'exit 1', '-lt $touchDate']) {
    assert.ok(guard.includes(m), m);
  }
});
check('A2: packager-03 doc carries the guard step + why + proofs', () => {
  const doc = read('docs/p33-packager-patch.md');
  for (const m of ['workflow_dispatch', 'check-runtime-fresh.ps1', 'RUNTIME_RUN_ID',
      'STALE', 'BEFORE the P21', 'Verify P21 journal', 'header in built runtime',
      '# === session start ===', 'GH_TOKEN', 'actions:read']) {
    assert.ok(doc.includes(m), m);
  }
  assert.ok(doc.includes('dir %LOCALAPPDATA%' + bs + 'SudoStudio' + bs + 'logs'), 'proof 3 listing');
});

// -- B: header first + build commit -------------------------------------------
const py = read('backend/runtime/server.enterprise.py');
check('B1: _p33_build_commit (env > manifest > dev, never raises)', () => {
  for (const m of ['def _p33_build_commit', 'SUDO_BUILD_COMMIT', 'build-manifest.json',
      'sudo_studio_commit', 'commit=', 'return "dev"']) {
    assert.ok(py.includes(m), m);
  }
});
check('B2: session header moved to post-parse (first journal lines)', () => {
  const parseIdx = py.indexOf('args = parser.parse_args()');
  const headIdx = py.indexOf('p21_journal.session_header');
  assert.ok(parseIdx !== -1 && headIdx !== -1 && parseIdx < headIdx, 'header after parse');
  assert.ok(!py.includes('P21-b: session header'), 'old late call site gone');
  assert.ok(py.includes('moved to post-parse'), 'move documented');
});
check('B3: build fact carries the commit', () => {
  assert.ok(py.includes("'runtime-server.enterprise.py ' + _p33_build_commit()"), 'build+commit');
});
check('B4: 02 gate boots the exe and asserts header-first', () => {
  const yml = read('.github/workflows/02-runtime-build.yml');
  for (const m of ['Verify P21 journal header in built runtime', '--no-auto-download',
      'SUDO_STUDIO_LOGS', 'SUDO_BUILD_COMMIT', 'GITHUB_SHA',
      '# === session start ===', 'first line', '# build:', '# cpu:', '# ramMB:',
      'Stop-Process']) {
    assert.ok(yml.includes(m), m);
  }
});

// -- C: single logs folder ----------------------------------------------------
const serverJs = read('backend/server.js');
check('C1: backend logDir (env > LOCALAPPDATA win32 pkg > dev, old trap gone)', () => {
  const region = serverJs.slice(serverJs.indexOf('const logDir'));
  const iEnv = region.indexOf('process.env.SUDO_STUDIO_LOGS');
  const iLocal = region.indexOf('LOCALAPPDATA');
  const iDev = region.indexOf("path.join(__dirname, '..', 'logs')");
  assert.ok(iEnv !== -1 && iLocal !== -1 && iDev !== -1, 'all three present');
  assert.ok(iEnv < iLocal && iLocal < iDev, 'precedence order');
  assert.ok(serverJs.includes("require('os')"), 'os required');
  assert.ok(!serverJs.includes("process.execPath), '..', 'logs')"), 'old pkg trap gone');
});
const bat = read('start.bat');
check('C2: launcher LOGS is the single folder + env export + migration', () => {
  assert.ok(bat.includes('set "LOGS=%LOCALAPPDATA%' + bs + 'SudoStudio' + bs + 'logs"'), 'LOGS single');
  assert.ok(bat.includes('set "SUDO_STUDIO_LOGS=%LOGS%"'), 'env export');
  const xc = bat.split('xcopy /Y /D').length - 1;
  assert.strictEqual(xc, 6, '3 sources x log+jsonl, got ' + xc);
  for (const s of ['"%ROOT%logs', '"%ROOT%..' + bs + 'logs', '.sudo_studio' + bs + 'logs']) {
    assert.ok(bat.includes(s), s);
  }
  assert.ok(bat.includes(') >> "%LOG_FILE%"'), 'append, never truncate');
  assert.ok(!bat.includes(') > "%LOG_FILE%"'), 'truncate gone');
  assert.ok(bat.includes('%LOGS%' + bs + 'backend.log'), 'Diagnose path');
  assert.ok(bat.includes('%LOGS%' + bs + 'runtime.log'), 'AI journal path');
  const direct = bat.split('\n').filter((l) => l.includes('%ROOT%logs'));
  assert.ok(direct.length > 0 && direct.every((l) => l.includes('xcopy')), 'ROOT logs only as xcopy sources');
});
const ext = read('sudo-ai-extension/extension.js');
check('C3: agent child inherits the single dir via agentServerOpts.logsDir', () => {
  const region = ext.slice(ext.indexOf('function agentServerOpts'), ext.indexOf('function relaunchAgentServer'));
  assert.ok(region.includes('opts.logsDir'), 'logsDir set');
  assert.ok(region.includes('resolveLogsDir({})'), 'single-dir resolution');
});
check('C4: runtime debug log moved to the single folder', () => {
  assert.ok(py.includes('"SudoStudio", "logs", "runtime_debug.log"'), 'single dir');
  assert.ok(!py.includes('"Programs", "SudoStudio"'), 'old Programs path gone');
});
const smoke = read('scripts/smoke/smoke-install.ps1');
check('C5: smoke asserts the single dir + copies every component log', () => {
  for (const m of ['logs-single-dir', 'journals still written under the install folder',
      'startup.log', 'backend.log', 'runtime.log', 'extension.log', 'agent.log',
      'SKIP', 'SkipEditorTest']) {
    assert.ok(smoke.includes(m), m);
  }
  assert.ok(smoke.includes("Join-Path $env:LOCALAPPDATA 'SudoStudio" + bs + 'logs' + bs + "backend.log'"), 'backend.log read');
  const legacy = smoke.split('\n').filter((l) => l.includes("Join-Path $InstallDir 'logs"));
  assert.ok(legacy.length === 1 && legacy[0].includes('$legacy ='), 'only the emptiness assert touches InstallDir logs');
});
check('C6: installer {app} logs dir left alone by design (harmless legacy)', () => {
  const iss = read('installer.iss');
  assert.ok(iss.includes('Name: "{app}' + bs + 'logs"'), 'Dirs entry still there');
});

// -- D: open/export follow the folder -----------------------------------------
check('D1: openLogsFolder resolves via resolveLogsDir', () => {
  const iOpen = ext.indexOf('function openLogsFolder');
  const iRes = ext.indexOf('resolveLogsDir({})', iOpen);
  assert.ok(iOpen !== -1 && iRes !== -1 && iRes - iOpen < 1500, 'resolve near open');
});
check('D2: export passes no logsDir (single-dir default applies)', () => {
  const call = ext.slice(ext.indexOf('async function exportDiagnostics()'), ext.indexOf('}, uri.fsPath)'));
  assert.ok(call.length > 100, 'caller found');
  assert.ok(!call.includes('logsDir'), 'no logsDir override');
  const dx = read('sudo-ai-extension/src/utils/diagExport.js');
  assert.ok(dx.includes('opts.logsDir || resolveLogsDir({})'), 'default is single dir');
});
check('D3: diag bundle really packs the 5 component logs (behavioral)', () => {
  const dir = tmp('diag');
  const five = ['startup.log', 'backend.log', 'runtime.log', 'extension.log', 'agent.log'];
  for (const f of five) fs.writeFileSync(path.join(dir, f), 'line1 ' + f + '\nline2\n');
  fs.writeFileSync(path.join(dir, 'runtime.jsonl'), '{"x":1}\n');
  fs.writeFileSync(path.join(dir, 'runtime.log.1'), 'previous rotation\n');
  fs.writeFileSync(path.join(dir, 'agent.log.2'), 'old rotation\n');
  const diag = require('../../sudo-ai-extension/src/utils/diagExport.js');
  const bundle = diag.buildDiagnosticBundle({ logsDir: dir, nowIso: () => '2026-10-18T00:00:00.000Z' });
  assert.strictEqual(bundle.manifest.logsDir, dir, 'logsDir honored');
  for (const f of five) assert.ok(bundle.manifest.files.includes('logs/' + f + '.tail.log'), f);
  assert.ok(bundle.manifest.files.includes('logs/runtime.log.1.tail.log'), 'previous rotation kept');
  assert.ok(!bundle.manifest.files.join('|').includes('jsonl'), 'no jsonl twins');
  assert.ok(!bundle.manifest.files.join('|').includes('agent.log.2'), 'no old rotations');
  assert.ok(bundle.manifest.files.includes('manifest.json'), 'manifest listed');
});

// -- E: hygiene + wiring --------------------------------------------------------
check('E1: new P33 files are ASCII-only', () => {
  for (const f of ['scripts/ci/check-runtime-fresh.ps1', 'docs/p33-packager-patch.md',
      'backend/tests/test-p33-runtime-logs.js']) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, f + ' byte ' + i);
  }
});
check('E2: backend --selftest still PASS with the new os require', () => {
  const r = spawnSync(process.execPath, ['server.js', '--selftest'],
    { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(r.status, 0, 'exit 0: ' + (r.stderr || '').slice(-300));
  assert.ok((r.stdout + r.stderr).includes('SELFTEST PASS'), 'PASS line');
});

console.log('P33 passed: ' + n + ' checks');
