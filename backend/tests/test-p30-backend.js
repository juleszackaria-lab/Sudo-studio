/**
 * SUDO STUDIO - P30: backend that always starts, never a black screen.
 * A: root cause pins (P28 deletion, no gitignore/case/pkg cause, marker)
 * B: --selftest audit (live PASS + voluntary FAIL fixtures + units)
 * C: crash handler (exit 1, stdout + unified + local journal)
 * D: 6 panels fallback (static wiring + reason matrix + live ensureBackend)
 * E: CI wiring (01 runs the suite + gates the artifact on --selftest)
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(__dirname, '..');
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const selftest = require('../selftest.js');
const crashHandler = require('../crashHandler.js');
const bf = require('../../sudo-ai-extension/src/utils/backendFallback.js');

// -- A: root cause ---------------------------------------------------------------
const serverJs = read('backend/server.js');
check('A1: dead require gone (call shape absent)', () => {
  assert.ok(!serverJs.includes("require('./ai/aiModelsManager')"));
});
check('A2: archaeology pins (no backend/ai, no gitignore/case cause)', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(!files.split('\n').some((f) => f.indexOf('backend/ai/') === 0), 'backend/ai/ must be gone');
  const gi = read('.gitignore').split('\n');
  assert.ok(!gi.some((l) => /^backend\/ai\/.*\.js$/.test(l.trim())), 'no js exclusion');
  const pkg = JSON.parse(read('backend/package.json'));
  assert.ok(pkg.pkg.targets.indexOf('node18-win-x64') !== -1, 'pkg target pinned');
});
check('A3: P30(a) root-cause marker in server.js', () => {
  assert.ok(serverJs.includes('P30(a)'));
  assert.ok(serverJs.includes('772ee6f'));
});

// -- B: selftest ------------------------------------------------------------------
check('B1: live audit of server.js has zero fatal', () => {
  const res = selftest.audit(path.join(BACKEND, 'server.js'));
  assert.strictEqual(res.fatal.length, 0, JSON.stringify(res.fatal.slice(0, 3)));
  assert.ok(res.files.length > 20, 'tree walked');
  assert.ok(res.resolved > 100, 'requires resolved');
});
check('B2: node server.js --selftest exits 0 with PASS', () => {
  const r = spawnSync(process.execPath, ['server.js', '--selftest'], { cwd: BACKEND, encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(r.status, 0, 'exit=' + r.status + ' ' + (r.stderr || '').slice(0, 300));
  assert.ok(r.stdout.indexOf('SELFTEST PASS') !== -1);
});
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p30-selftest-'));
  for (const k of Object.keys(files)) fs.writeFileSync(path.join(dir, k), files[k]);
  return dir;
}
check('B3: voluntary FAIL - bare missing require is fatal + listed', () => {
  const dir = makeFixture({ 'a.js': "const x = require('./missing-xyz');\nmodule.exports = x;\n" });
  const res = selftest.audit(path.join(dir, 'a.js'));
  assert.strictEqual(res.fatal.length, 1);
  assert.strictEqual(res.fatal[0].spec, './missing-xyz');
  const rep = selftest.printReport(res);
  assert.ok(rep.indexOf('SELFTEST FAIL') !== -1 && rep.indexOf('./missing-xyz') !== -1);
  const r = spawnSync(process.execPath, ['-e', "require(" + JSON.stringify(path.join(BACKEND, 'selftest.js')) + ").runAndExit(" + JSON.stringify(path.join(dir, 'a.js')) + ")"],
    { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 1, 'runAndExit must exit 1');
  assert.ok(r.stdout.indexOf('./missing-xyz') !== -1);
});
check('B4: safeRequire miss is a warning, not fatal', () => {
  const dir = makeFixture({ 'b.js': "const r = safeRequire('./nope-zzz', 'x');\n" });
  const res = selftest.audit(path.join(dir, 'b.js'));
  assert.strictEqual(res.fatal.length, 0);
  assert.strictEqual(res.warnings.length, 1);
  assert.strictEqual(res.warnings[0].via, 'safeRequire');
});
check('B5: try/catch miss is a warning, not fatal', () => {
  const dir = makeFixture({ 'c.js': "try { require('./nope-try'); } catch (e) { /* optional */ }\n" });
  const res = selftest.audit(path.join(dir, 'c.js'));
  assert.strictEqual(res.fatal.length, 0);
  assert.strictEqual(res.warnings.length, 1);
  assert.strictEqual(res.warnings[0].via, 'try/catch');
});
check('B6: dynamic require is unverifiable, not fatal', () => {
  const dir = makeFixture({ 'd.js': "const m = require(name + '.js');\n" });
  const res = selftest.audit(path.join(dir, 'd.js'));
  assert.strictEqual(res.fatal.length, 0);
  assert.strictEqual(res.dynamic.length, 1);
});
check('B7: tryRanges units (strings/regex/templates/unbalanced)', () => {
  const tr = selftest.tryRanges;
  const inT = selftest.inTry;
  assert.strictEqual(tr('try { require("x"); } catch (e) {}').balanced, true);
  let r = tr('try { require("x"); } catch (e) {}');
  assert.ok(inT(r.ranges, 14), 'inside try body');
  assert.ok(!inT(r.ranges, 2), 'outside (the try keyword itself)');
  r = tr('var s = "try { not code }"; require("y");');
  assert.strictEqual(r.ranges.length, 0, 'try in string ignored');
  r = tr('var re = /a{2,3}/; try { require("z"); } catch (e) {}');
  assert.strictEqual(r.balanced, true, 'regex braces ignored');
  assert.strictEqual(r.ranges.length, 1);
  r = tr('var t = `v=${o.a + {b: 1}.b}`; try { require("w"); } catch (e) {}');
  assert.strictEqual(r.balanced, true, 'template braces handled');
  assert.strictEqual(r.ranges.length, 1);
  assert.strictEqual(tr('function f() { try { x(').balanced, false, 'unbalanced detected');
});
check('B8: stripComments (code-like comment content)', () => {
  const sc = selftest.stripComments;
  const src = 'var a = \'*/*\'; // require("./ghost")\n/* require("./ghost2") */ var b = 1;\n';
  const clean = sc(src);
  assert.strictEqual(clean.length, src.length, 'offsets preserved');
  assert.ok(clean.indexOf('ghost') === -1, 'comment requires stripped');
  assert.ok(clean.indexOf("'*/*'") !== -1, 'string kept');
  const col = selftest.collectRequires(src);
  assert.strictEqual(col.literals.length, 0, 'no false literals');
});

// -- C: crash handler ---------------------------------------------------------------
function crashChild(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p30-crash-'));
  const script =
    "require(" + JSON.stringify(path.join(BACKEND, 'crashHandler.js')) + ")" +
    ".setup({ localLog: " + JSON.stringify(path.join(dir, 'local.log')) +
    ", unifiedLog: " + JSON.stringify(path.join(dir, 'unified.log')) + " });\n" +
    (kind === 'throw' ? "setTimeout(() => { throw new Error('P30-CRASH-PROBE'); }, 50);\n" :
     kind === 'reject' ? "Promise.reject(new Error('P30-REJECT-PROBE'));\n" :
     kind === 'modulenotfound' ? "require('./does-not-exist-p30');\n" :
     "process.emit('uncaughtException', Object.assign(new Error('x'), { code: 'EPIPE' }));\nconsole.log('STILL-ALIVE');\n");
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  return { r, dir };
}
check('C1: uncaughtException -> exit 1, stdout + both journals', () => {
  const { r, dir } = crashChild('throw');
  assert.strictEqual(r.status, 1, 'exit=' + r.status);
  assert.ok(r.stdout.indexOf('FATAL uncaughtException: P30-CRASH-PROBE') !== -1, 'stdout');
  assert.ok(fs.readFileSync(path.join(dir, 'unified.log'), 'utf8').indexOf('P30-CRASH-PROBE') !== -1, 'unified');
  assert.ok(fs.readFileSync(path.join(dir, 'local.log'), 'utf8').indexOf('P30-CRASH-PROBE') !== -1, 'local');
});
check('C2: unhandledRejection -> exit 1 with FATAL', () => {
  const { r } = crashChild('reject');
  assert.strictEqual(r.status, 1, 'exit=' + r.status);
  assert.ok(r.stdout.indexOf('FATAL unhandledRejection: P30-REJECT-PROBE') !== -1);
});
check('C3: P29 crash shape (MODULE_NOT_FOUND) -> exit 1, readable', () => {
  const { r } = crashChild('modulenotfound');
  assert.strictEqual(r.status, 1, 'exit=' + r.status + ' (was silent 0 before P30)');
  assert.ok(r.stdout.indexOf('FATAL uncaughtException: Cannot find module') !== -1);
});
check('C4: EPIPE stays suppressed (process survives)', () => {
  const { r } = crashChild('epipe');
  assert.strictEqual(r.status, 0, 'exit=' + r.status);
  assert.ok(r.stdout.indexOf('STILL-ALIVE') !== -1);
});
check('C5: unified dir honors SUDO_STUDIO_LOGS', () => {
  const old = process.env.SUDO_STUDIO_LOGS;
  process.env.SUDO_STUDIO_LOGS = path.join('X', 'Y');
  try {
    assert.strictEqual(crashHandler.resolveUnifiedDir(), path.join('X', 'Y'));
  } finally {
    if (old === undefined) delete process.env.SUDO_STUDIO_LOGS;
    else process.env.SUDO_STUDIO_LOGS = old;
  }
});
check('C6: server.js wires crashHandler + keeps no silent handler', () => {
  assert.ok(serverJs.indexOf("require('./crashHandler').setup") !== -1);
  assert.ok(serverJs.indexOf('_inErrorHandler') === -1, 'old inline handler replaced');
});

// -- D: panels ------------------------------------------------------------------------
const PANELS = [
  ['DoctorPanel', 'runDiagnostic'], ['SDKPanel', 'detectAll'],
  ['CentralMgmtPanel', '_loadAll'], ['SecurityPanel', '_runAudit'], ['DuplicationPanel', '_scanLocal'],
];
check('D1: 5 loading panels wired (require + ensure + routing + snippet + init)', () => {
  for (const [p, load] of PANELS) {
    const src = read('sudo-ai-extension/src/panels/' + p + '.js');
    assert.ok(src.indexOf("require('../utils/backendFallback')") !== -1, p + ' require');
    assert.ok(src.indexOf('_p30Ensure') !== -1, p + ' ensure');
    assert.ok(src.indexOf('handlePanelMessage(this.panel, msg') !== -1, p + ' routing');
    assert.ok(src.indexOf('${bf.webviewSnippet()}') !== -1, p + ' snippet');
    assert.ok(src.indexOf('__sudoBackendInit(vscode)') !== -1, p + ' init');
    assert.ok(src.indexOf('() => this.' + load + '()') !== -1, p + ' load=' + load);
    assert.ok(src.indexOf('<script>') !== -1 && src.indexOf('<script>') < src.indexOf('${bf.webviewSnippet()}'),
      p + ' panel script stays first');
  }
});
check('D1b: DevOps (static, backend-free) has snippet + routing only', () => {
  const src = read('sudo-ai-extension/src/panels/DevOpsPanel.js');
  assert.ok(src.indexOf("require('../utils/backendFallback')") !== -1, 'require');
  assert.ok(src.indexOf('handlePanelMessage(this.panel, msg') !== -1, 'routing');
  assert.ok(src.indexOf('${bf.webviewSnippet()}') !== -1, 'snippet');
  assert.ok(src.indexOf('__sudoBackendInit(vscode)') !== -1, 'init');
  assert.ok(src.indexOf('_p30Ensure') === -1, 'no ensure (nothing to load)');
});
check('D2: snippet carries message + 2 buttons + protocol', () => {
  const s = bf.webviewSnippet();
  assert.ok(s.indexOf('Backend indisponible :') !== -1);
  assert.ok(s.indexOf('id="sbfRetry"') !== -1 && s.indexOf('id="sbfLogs"') !== -1);
  assert.ok(s.indexOf('R\u00e9essayer') !== -1, 'Reessayer rendered');
  assert.ok(s.indexOf('Ouvrir les journaux') !== -1);
  for (const t of ['sudoBackendRetry', 'sudoOpenLogs', 'sudoBackendUnavailable', 'sudoBackendOk']) {
    assert.ok(s.indexOf(t) !== -1, t);
  }
});
check('D3: shortReason + isBackendDown matrix', () => {
  assert.strictEqual(bf.shortReason({ code: 'ECONNREFUSED' }), 'connexion refus\u00e9e');
  assert.strictEqual(bf.shortReason({ code: 'ETIMEDOUT' }), 'd\u00e9lai d\u00e9pass\u00e9 (5 s)');
  assert.strictEqual(bf.shortReason({ code: 'ENOTFOUND' }), 'r\u00e9seau injoignable');
  assert.strictEqual(bf.shortReason({ code: 'ECONNRESET' }), 'connexion perdue');
  assert.strictEqual(bf.shortReason({ response: { status: 500 } }), 'HTTP 500');
  assert.strictEqual(bf.shortReason(new Error('boom')), 'boom');
  assert.strictEqual(bf.TIMEOUT_MS, 5000);
  assert.ok(bf.isBackendDown({ code: 'ECONNREFUSED' }));
  assert.ok(bf.isBackendDown({ code: 'EAI_AGAIN' }));
  assert.ok(bf.isBackendDown({ request: {}, message: 'socket hang up' }));
  assert.ok(bf.isBackendDown(new Error('connect ETIMEDOUT 1.2.3.4')));
  assert.ok(!bf.isBackendDown(new Error('boom-load')));
  assert.ok(!bf.isBackendDown(null));
});
function fakePanel() {
  const posted = [];
  return { panel: { webview: { postMessage: (m) => posted.push(m) } }, posted };
}
function tick(ms) { return new Promise((r) => setTimeout(r, ms)); }
function deferred() {
  let res, rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  return { promise: p, resolve: res, reject: rej };
}
async function main() {
  {
    const { panel, posted } = fakePanel();
    let ran = false;
    const ok = await bf.ensureBackend(panel, async () => { ran = true; });
    assert.strictEqual(ok, true);
    assert.strictEqual(ran, true);
    assert.strictEqual(posted.length, 0, 'fast success posts nothing');
    n++; console.log('ok - D4a: fast load runs + posts nothing');
  }
  {
    const { panel, posted } = fakePanel();
    const e = new Error('connect ECONNREFUSED 127.0.0.1:5000');
    e.code = 'ECONNREFUSED';
    const ok = await bf.ensureBackend(panel, async () => { throw e; });
    assert.strictEqual(ok, false);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'sudoBackendUnavailable');
    assert.strictEqual(posted[0].reason, 'connexion refus\u00e9e');
    n++; console.log('ok - D4b: refused load -> Unavailable + short reason');
  }
  {
    const { panel, posted } = fakePanel();
    let threw = null;
    try {
      await bf.ensureBackend(panel, async () => { throw new Error('boom-load'); });
    } catch (e) { threw = e; }
    assert.ok(threw && threw.message === 'boom-load', 'foreign error re-thrown');
    assert.strictEqual(posted.length, 0, 'no overlay for foreign errors');
    n++; console.log('ok - D4c: foreign error re-thrown, nothing posted');
  }
  {
    const { panel, posted } = fakePanel();
    const d = deferred();
    const ok = await bf.ensureBackend(panel, () => d.promise, { timeoutMs: 60 });
    assert.strictEqual(ok, false);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'sudoBackendUnavailable');
    assert.strictEqual(posted[0].reason, 'd\u00e9lai d\u00e9pass\u00e9 (60 ms)');
    d.resolve();
    await tick(50);
    assert.strictEqual(posted.length, 2, 'late success hides the overlay');
    assert.strictEqual(posted[1].type, 'sudoBackendOk');
    n++; console.log('ok - D4d: hang -> Unavailable at bound, late Ok hides it');
  }
  {
    const { panel, posted } = fakePanel();
    const d = deferred();
    const ok1 = await bf.ensureBackend(panel, () => d.promise, { timeoutMs: 60 });
    assert.strictEqual(ok1, false);
    const ok2 = await bf.ensureBackend(panel, async () => true, { timeoutMs: 5000 });
    assert.strictEqual(ok2, true);
    d.resolve();
    await tick(50);
    const types = posted.map((m) => m.type);
    assert.ok(types.indexOf('sudoBackendUnavailable') !== -1 && types.indexOf('sudoBackendOk') !== -1, types.join(','));
    n++; console.log('ok - D4e: retry success after Unavailable posts Ok');
  }
  {
    const { panel, posted } = fakePanel();
    const e = new Error('sync refused');
    e.code = 'ECONNREFUSED';
    const ok = await bf.ensureBackend(panel, () => { throw e; });
    assert.strictEqual(ok, false);
    assert.strictEqual(posted[0].type, 'sudoBackendUnavailable');
    n++; console.log('ok - D4f: sync backend-down throw -> Unavailable');
  }
  console.log('\nP30-backend: ' + n + ' checks passed (all green)');
}

check('D5: retry/logs routing + openLogsFolder command exists', () => {
  const { panel } = fakePanel();
  let reloaded = false;
  assert.strictEqual(bf.handlePanelMessage(panel, { type: 'sudoBackendRetry' }, () => { reloaded = true; }), true);
  assert.strictEqual(reloaded, true);
  let opened = null;
  const fakeCmds = { executeCommand: (c) => { opened = c; } };
  assert.strictEqual(bf.handlePanelMessage(panel, { type: 'sudoOpenLogs' }, null, fakeCmds), true);
  assert.strictEqual(opened, 'sudoStudio.openLogsFolder');
  assert.strictEqual(bf.handlePanelMessage(panel, { type: 'other' }, null), false);
  assert.strictEqual(bf.handlePanelMessage(panel, null, null), false);
  const ext = read('sudo-ai-extension/extension.js');
  assert.ok(ext.indexOf('sudoStudio.openLogsFolder') !== -1, 'command registered');
});
check('D6: new P30 files are ASCII-only', () => {
  for (const f of ['backend/selftest.js', 'backend/crashHandler.js',
    'sudo-ai-extension/src/utils/backendFallback.js', 'backend/tests/test-p30-backend.js']) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, f + ' byte ' + i);
  }
});

// -- E: CI wiring -----------------------------------------------------------------------
check('E1: 01 runs the suite + gates the artifact on --selftest', () => {
  const yml = read('.github/workflows/01-backend-build.yml');
  const suite = yml.indexOf('tests/test-p30-backend.js');
  const self = yml.indexOf('backend.exe --selftest');
  const up = yml.indexOf('Upload backend artifact');
  assert.ok(suite !== -1 && self !== -1 && up !== -1);
  assert.ok(self < up, 'selftest gates the upload');
});

main().catch((e) => { console.error('P30-backend FAILED: ' + (e && e.message)); process.exit(1); });
