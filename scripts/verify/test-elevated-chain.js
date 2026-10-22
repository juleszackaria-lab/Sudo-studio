/**
 * SUDO STUDIO - P44: REAL elevation-chain test with a HARMLESS command.
 *
 * Exercises the SHIPPED engine (src/doctor/autoFix.js: buildPsScript +
 * encodedLauncher) for real: journal pre-created BEFORE launch, one batch
 * step running `whoami` (read-only, proves WHICH user ran it), START/DONE/
 * END markers read back. Prints Get-ExecutionPolicy -List, winget
 * --version and the FULL journal (P44 preuves).
 *
 *   node test-elevated-chain.js [--direct] [--elevated] [--timeout ms]
 *     [--engine <path/to/autoFix.js>] [--keep]
 *
 * --direct (default): no UAC, CI-safe. --elevated: pops ONE UAC prompt
 * (owner clicks Yes) and proves the RunAs array form really starts.
 * Non-Windows: SKIP, exit 0. Exit 0 = chain PASS, 1 = FAIL (journal kept
 * and its path printed). ASCII-only.
 */
'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.indexOf(name) !== -1; }

const ELEVATED = hasFlag('--elevated');
const TIMEOUT = parseInt(argVal('--timeout', ELEVATED ? '120000' : '60000'), 10) || 60000;
const KEEP = hasFlag('--keep');
const ENGINE = argVal('--engine', path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'doctor', 'autoFix.js'));

function run(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    exec(cmd, { timeout: timeoutMs || 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''), stderr: String(stderr || ''),
        timedOut: !!(err && err.killed), ms: Date.now() - t0 });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const verdicts = [];
  const check = (name, ok, detail) => {
    verdicts.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 300) });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).slice(0, 300) : ''));
  };
  if (process.platform !== 'win32') {
    console.log('SKIP test-elevated-chain: Windows only (platform=' + process.platform + ')');
    process.exit(0);
  }
  console.log('engine: ' + ENGINE);
  console.log('mode: ' + (ELEVATED ? 'elevated (ONE UAC prompt: click Yes)' : 'direct (no UAC)'));
  let af = null;
  try {
    af = require(ENGINE);
    check('engine-loads', !!(af && af.encodedLauncher && af.buildPsScript));
  } catch (e) {
    check('engine-loads', false, String((e && e.message) || e).slice(0, 200));
    process.exit(1);
  }

  // P44 preuves: policy + winget, exactly as the engine probes them.
  const pol = await run(
    'powershell -NoProfile -Command "Get-ExecutionPolicy -List | ForEach-Object { $_.Scope + \'=\' + $_.ExecutionPolicy }"');
  console.log('--- Get-ExecutionPolicy -List (code=' + pol.code + ') ---');
  console.log((pol.stdout || '(empty)') + (pol.stderr ? '\n[stderr] ' + pol.stderr : ''));
  const wg = await run('winget --version');
  console.log('--- winget --version (code=' + wg.code + ') ---');
  console.log(((wg.stdout || '').trim() || '(empty)') + (wg.stderr ? '\n[stderr] ' + wg.stderr : ''));

  // Journal pre-created BEFORE launch, both-levels folder when possible.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p44-chain-'));
  const logFile = path.join(logDir, 'chain.log');
  fs.writeFileSync(logFile, '', 'utf8');
  check('journal-precreated', fs.existsSync(logFile), logFile);

  // Harmless batch: whoami only. Printed in full: auditable, no surprise.
  const batch = af.buildPsScript([{ id: 'S0', cmd: 'whoami' }], logFile);
  const b64 = af.buildEncodedLaunch(batch);
  const launcher = af.encodedLauncher(ELEVATED, b64);
  console.log('--- decoded batch (harmless: whoami) ---');
  console.log(batch);
  console.log('--- launcher (b64 len ' + b64.length + ') ---');
  console.log(launcher.slice(0, 300) + (launcher.length > 300 ? '...[truncated]' : ''));
  try {
    check('launcher-decodes', af.decodeEncodedLaunch(launcher) === batch);
  } catch (e) {
    check('launcher-decodes', false, String((e && e.message) || e).slice(0, 120));
  }

  if (ELEVATED) console.log('UAC: une invite elevation va apparaitre, cliquez Oui.');
  const launch = await run(launcher, TIMEOUT);
  console.log('launch: code=' + launch.code + ' ms=' + launch.ms +
    (launch.timedOut ? ' TIMEDOUT' : '') +
    (launch.stdout.trim() ? ' stdout=' + launch.stdout.trim().slice(0, 200) : '') +
    (launch.stderr.trim() ? ' stderr=' + launch.stderr.trim().slice(0, 200) : ''));

  // Settle up to 5 s for the END marker (P44-2), then read the FULL journal.
  let text = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try { text = fs.readFileSync(logFile, 'utf8'); } catch (_) { text = ''; }
    if (/END/.test(text)) break;
    await sleep(250);
  }
  try { text = fs.readFileSync(logFile, 'utf8'); } catch (_) { text = ''; }
  console.log('--- FULL journal (' + text.length + ' chars) ---');
  console.log(text || '(EMPTY)');
  console.log('--- end journal ---');

  check('journal-has-START', /^START/m.test(text));
  const done = text.match(/^DONE S0 code=(-?\d*)/m);
  check('journal-has-DONE-S0-code-0', !!done && done[1] === '0', done ? done[0] : 'no DONE marker');
  check('journal-has-END', /^END/m.test(text));
  check('journal-has-whoami-output', /OUTPUT S0/.test(text) && /\\/m.test(text), 'step output block present');
  check('launch-ok', launch.code === 0 && !launch.timedOut, 'code=' + launch.code);

  const failed = verdicts.some((v) => !v.ok);
  if (!failed && !KEEP) {
    try { fs.unlinkSync(logFile); fs.rmdirSync(logDir); } catch (_) {}
  } else {
    console.log('journal kept at: ' + logFile);
  }
  console.log(failed ? 'CHAIN: FAIL' : 'CHAIN: PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
