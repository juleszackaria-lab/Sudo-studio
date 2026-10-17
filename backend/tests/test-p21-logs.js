/**
 * MISSION PROMPT 21 - Uniform structured journals, diagnostics, runtime watch.
 * Covers: line format v1 (human + JSON, tz, level, component, corr, fields),
 * session headers, 10x10MB rotation, secret filter, diagnostic .zip export,
 * logs viewer, supervisor journaling, autofix/sdk/duplication journaling.
 * ASCII-only. Run: node backend/tests/test-p21-logs.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-'));
process.env.SUDO_STUDIO_LOGS = path.join(TMP_ROOT, 'shared');
fs.mkdirSync(process.env.SUDO_STUDIO_LOGS, { recursive: true });
const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension');
const RUNTIME_PY = path.join(__dirname, '..', 'runtime');

// ---- vscode + axios mocks (panels) ----
const vscodeMock = {
  ViewColumn: { One: 1 },
  window: {
    panels: [],
    createWebviewPanel(vt, title) {
      const p = { viewType: vt, title, revealed: 0, disposed: false,
        webview: { html: '', posted: [], async postMessage(m) { this.posted.push(m); return true; }, onDidReceiveMessage() {} },
        reveal() { this.revealed++; }, onDidDispose() {}, dispose() { this.disposed = true; } };
      vscodeMock.window.panels.push(p);
      return p;
    },
    async showInformationMessage() { return undefined; },
    async showWarningMessage() { return undefined; },
    showErrorMessage() {},
    createTerminal() { return { show() {}, sendText() {} }; },
  },
  env: { async openExternal() {}, clipboard: { async writeText() {} } },
  workspace: { getConfiguration() { return { get: (k, d) => d, update: async () => {} }; } },
  commands: { executed: [], async executeCommand(n, ...a) { vscodeMock.commands.executed.push([n, ...a]); } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
};
const axiosMock = { async post() { return { data: {} }; }, async get() { const e = new Error('x'); e.code = 'X'; throw e; } };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  if (req === 'axios') return axiosMock;
  return origLoad.call(this, req, parent, isMain);
};

const bTech = require('../utils/techLog');
const xTech = require('../../sudo-ai-extension/src/utils/techLog');
const { writeZip, readZip } = require('../../sudo-ai-extension/src/utils/minizip');
const { buildDiagnosticBundle, exportDiagnosticsZip } = require('../../sudo-ai-extension/src/utils/diagExport');
const { LogsPanel, listLogFiles, getTail } = require('../../sudo-ai-extension/src/panels/LogsPanel');
const { RuntimeSupervisor } = require('../supervisor/runtimeSupervisor');
const { fixAll } = require('../../sudo-ai-extension/src/doctor/autoFix');
const { DoctorPanel } = require('../../sudo-ai-extension/src/panels/DoctorPanel');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}
function subdir(n) { const d = path.join(TMP_ROOT, n); fs.mkdirSync(d, { recursive: true }); return d; }
function techCollector() {
  const got = [];
  const mk = (level) => (msg, fields) => got.push({ level, msg, fields: fields || {} });
  return { got, tech: { info: mk('info'), warn: mk('warn'), error: mk('error') } };
}
// Scripted exec for autofix scenarios.
function mockExec(scenarios) {
  return async (cmd) => {
    for (const s of scenarios) {
      if (cmd.includes(s.match)) {
        if (s.action) await s.action(cmd);
        return { code: s.code !== undefined ? s.code : 0, stdout: s.stdout || '', stderr: s.stderr || '', timedOut: !!s.timedOut };
      }
    }
    return { code: 1, stdout: '', stderr: 'UNSCRIPTED: ' + cmd.slice(0, 100) };
  };
}
function psRun(codes, outputs) {
  return async (cmd) => {
    const flat = cmd.replace(/''/g, "'");
    const m = flat.match(/'([^']+\.ps1)'/);
    const ps1 = fs.readFileSync(m[1], 'utf8');
    const ids = [...ps1.matchAll(/STEP ([A-Za-z0-9_]+)/g)].map((x) => x[1]);
    const lm = ps1.match(/\$log = '((?:''|[^'])+)'/);
    const log = lm[1].replace(/''/g, "'");
    const lines = ['START'];
    for (const id of ids) {
      if (outputs && outputs[id] !== undefined) lines.push('OUTPUT ' + id, outputs[id], 'ENDOUTPUT ' + id);
      lines.push('DONE ' + id + ' code=' + (codes && codes[id] !== undefined ? codes[id] : 0));
    }
    lines.push('END');
    fs.writeFileSync(log, lines.join('\n'), 'utf8');
  };
}

async function main() {
  const savedPath = process.env.PATH; // autofix mocks clobber PATH (mocked refreshPath)
  // ------------------------------------------------- A. uniform line format (P21-a)
  const dA = subdir('a');
  const la = bTech.createLogger({ dir: dA, component: 'backend', corr: 'req-abc12345' });
  la.info('hello world', { code: 0, durationMs: 45 });
  const lineA = fs.readFileSync(path.join(dA, 'backend.log'), 'utf8').trim();
  check('A1: human line = tz ts + level + component + corr + msg + fields',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[INFO \] \[backend\] \[req-abc12345\] hello world \| code=0 durationMs=45$/.test(lineA), lineA);
  const jA = JSON.parse(fs.readFileSync(path.join(dA, 'backend.jsonl'), 'utf8').trim());
  check('A2: JSON twin carries the same event',
    jA.v === 1 && jA.level === 'info' && jA.component === 'backend' && jA.corr === 'req-abc12345' &&
    jA.msg === 'hello world' && jA.fields.code === 0 && jA.fields.durationMs === 45 && /[+-]\d{2}:\d{2}$/.test(jA.ts), jA);
  const ev = { ts: '2026-10-17T10:00:00.000+00:00', level: 'warn', component: 'sdk', corr: 'c1', msg: 'm', fields: { a: 1 } };
  check('A3: backend + extension mirrors are format-identical (v1)',
    bTech.FORMAT_VERSION === 1 && xTech.FORMAT_VERSION === 1 &&
    bTech.formatHuman(ev) === xTech.formatHuman(ev) && bTech.formatJson(ev) === xTech.formatJson(ev) &&
    bTech.maskSecrets('x sk-abc1234567890 y') === xTech.maskSecrets('x sk-abc1234567890 y'));
  const kid = la.child('sess-kid0001');
  kid.error('kaboom', {});
  const kidLines = fs.readFileSync(path.join(dA, 'backend.log'), 'utf8').trim().split('\n');
  check('A4: child logger keeps its correlation id',
    kidLines.length === 2 && kidLines[1].includes('[sess-kid0001]') && kidLines[1].includes('[ERROR]'), kidLines[1]);

  // ------------------------------------------------- B. session header (P21-b)
  const dB = subdir('b');
  const lb = bTech.createLogger({ dir: dB, component: 'backend' });
  const facts = bTech.gatherSessionInfo({ build: 'test-build-9', model: 'mock-model', ports: { backend: 5000, runtime: 6000 }, policies: { edition: 'dev' } });
  lb.sessionHeader(facts);
  const headB = fs.readFileSync(path.join(dB, 'backend.log'), 'utf8');
  check('B1: header has build/os/cpu/llamacpp/ram/model/ports/policies',
    headB.includes('session start') && headB.includes('test-build-9') && headB.includes('mock-model') &&
    headB.includes('5000') && headB.includes('dev') && /ramMB: total=\d+ free=\d+/.test(headB) && headB.includes('cpu: '), headB.slice(0, 400));
  const jB = JSON.parse(fs.readFileSync(path.join(dB, 'backend.jsonl'), 'utf8').trim());
  check('B1b: header JSON record is a session record', jB.fields.type === 'session' && jB.fields.facts.build === 'test-build-9');
  lb.sessionHeader(bTech.gatherSessionInfo({ build: 'x', model: 'm', policies: { token: 'sk-fakePOLICY999999' } }));
  const headB2 = fs.readFileSync(path.join(dB, 'backend.log'), 'utf8');
  check('B2: header secrets are masked', !headB2.includes('fakePOLICY999999') && headB2.includes('[REDACTED]'));
  lb.info('keep-me', {});
  lb.sessionHeader(facts);
  const headB3 = fs.readFileSync(path.join(dB, 'backend.log'), 'utf8');
  check('B3: restart appends, never truncates',
    headB3.includes('keep-me') && headB3.split('session start').length === 4, headB3.length);

  // ------------------------------------------------- C. rotation + persistence (P21-c)
  check('C1: rotation defaults are 10 files x 10 MB',
    bTech.DEFAULT_MAX_FILES === 10 && bTech.DEFAULT_MAX_BYTES === 10 * 1024 * 1024 &&
    xTech.DEFAULT_MAX_FILES === 10 && xTech.DEFAULT_MAX_BYTES === 10 * 1024 * 1024);
  const dC = subdir('c');
  const lc = bTech.createLogger({ dir: dC, component: 'rot', maxBytes: 400, maxFiles: 4 });
  for (let i = 0; i < 60; i++) lc.info('pad line number ' + i, { i });
  const rotFiles = fs.readdirSync(dC).sort();
  const cur = fs.readFileSync(path.join(dC, 'rot.log'), 'utf8');
  check('C2: rotation chain capped, newest kept, oldest dropped',
    rotFiles.length === 8 && rotFiles.includes('rot.log.3') && !rotFiles.includes('rot.log.4') &&
    cur.includes('pad line number 59') && !cur.includes('pad line number 0') &&
    rotFiles.filter((n) => n.startsWith('rot.jsonl')).length === 4, rotFiles.join(','));
  const savedLogs = process.env.SUDO_STUDIO_LOGS;
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.SUDO_STUDIO_LOGS = '/tmp/p21-override-x';
  const ov = bTech.resolveLogsDir({});
  process.env.SUDO_STUDIO_LOGS = '';
  process.env.LOCALAPPDATA = '/tmp/fake-local';
  const win = bTech.resolveLogsDir({ platform: 'win32' });
  const pos = bTech.resolveLogsDir({ platform: 'linux' });
  process.env.SUDO_STUDIO_LOGS = savedLogs;
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
  check('C3: single documented dir (override > %LOCALAPPDATA% > home)',
    ov === '/tmp/p21-override-x' && win === path.join('/tmp/fake-local', 'SudoStudio', 'logs') &&
    pos === path.join(os.homedir(), '.sudo_studio', 'logs'), { ov, win, pos });
  const dC4 = subdir('c4');
  bTech.createLogger({ dir: dC4, component: 'per' }).info('before restart', {});
  bTech.createLogger({ dir: dC4, component: 'per' }).sessionHeader(bTech.gatherSessionInfo({}));
  const per = fs.readFileSync(path.join(dC4, 'per.log'), 'utf8');
  check('C4: second boot keeps old lines + appends header', per.includes('before restart') && per.includes('session start'));

  // ------------------------------------------------- D. secret filter (P21-d)
  const forms = [
    ['sk-', 'key sk-fakeD1AAAABBBBCCCC end'],
    ['ghp_', 'tok ghp_fAK3D100000000000000000000 end'],
    ['gsk_', 'tok gsk_fAK3D200000000000000000000 end'],
    ['xoxb-', 'tok xoxb-fAK3D30000000000000000 end'],
    ['AKIA', 'aws AKIAIOSFODNN7EXAMPLE end'],
    ['AIza', 'gkey AIzaSyD-EXAMPLEKEY1234567890 end'],
    ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-fake-1234567890 end'],
    ['password=', 'login password=hunter2-secret!'],
    ['api_key json', '{"api_key": "ValeurFausse-API-KEY-12345"}'],
    ['Bearer', 'Authorization: Bearer fakeBEARERabcdef123456'],
    ['URL creds', 'db postgres://fakeu:fakepD1@db.internal:5432/app'],
    ['PEM', 'k -----BEGIN RSA PRIVATE KEY-----\nfakePEM-D1-BODY\n-----END RSA PRIVATE KEY----- end'],
  ];
  const dFails = forms.filter(([, s]) => {
    const m = bTech.maskSecrets(s);
    const secret = s.split(' ').find((w) => /fake|hunter|AKIA|AIza|eyJ|BEGIN|ValeurFausse|fakepD1|fakeu/.test(w));
    return m.includes(secret);
  });
  check('D1: every secret form is masked', dFails.length === 0, dFails.map((f) => f[0]));
  check('D1b: URL keeps scheme+host, PEM keeps a marker',
    bTech.maskSecrets('postgres://u:p@h/db').includes('postgres://[REDACTED]@h/db') &&
    bTech.maskSecrets('-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----').includes('[REDACTED-PRIVATE-KEY]'));
  const deep = bTech.maskSecretsDeep({ a: { password: 'fakeDEEP1', list: ['x', 'sk-fakeDEEP2AAAAA'], ok: 1 }, authorization: 'Bearer fakeDEEP3' }, 0);
  check('D2: nested fields masked (keys + values + arrays)',
    JSON.stringify(deep).includes('[REDACTED]') && !/fakeDEEP/.test(JSON.stringify(deep)), JSON.stringify(deep).slice(0, 200));
  const dD = subdir('d');
  const INJ = 'INJECTED-D3';
  for (const c of ['backend', 'sdk', 'autofix']) {
    const L = bTech.createLogger({ dir: dD, component: c });
    L.info('request failed', { cmd: 'deploy --token sk-INJECTED-D3-SECRET-abc123', code: 1 });
    L.sessionHeader(bTech.gatherSessionInfo({ build: 'b',
      policies: { note: 'pw password=INJECTED-D3-PW url=https://u:INJECTED-D3@h/x' } }));
  }
  let leaked = [];
  for (const f of fs.readdirSync(dD)) {
    if (fs.readFileSync(path.join(dD, f), 'utf8').includes(INJ)) leaked.push(f);
  }
  const redCount = fs.readdirSync(dD).reduce((n, f) => n + (fs.readFileSync(path.join(dD, f), 'utf8').match(/\[REDACTED\]/g) || []).length, 0);
  check('D3: injected request secret in NO file, redaction markers present', leaked.length === 0 && redCount >= 6, { leaked, redCount });

  // ------------------------------------------------- E. diagnostic export (P21-e)
  const dE = subdir('e');
  fs.writeFileSync(path.join(dE, 'backend.log'), 'b1 secret=INJECTED-FAKE-SECRET-E3-ZZ\nb2 ok\n');
  fs.writeFileSync(path.join(dE, 'backend.log.1'), 'old rotated line\n');
  fs.writeFileSync(path.join(dE, 'backend.log.2'), 'too old, excluded\n');
  fs.writeFileSync(path.join(dE, 'sdk.log'), 'sdk line\n');
  fs.writeFileSync(path.join(dE, 'backend.jsonl'), '{"v":1}\n');
  fs.writeFileSync(path.join(dE, 'notes.txt'), 'not a log\n');
  const OPTS_E = { logsDir: dE, tailLines: 50,
    getExtensionVersion: () => '9.9.9-test',
    getBackendInfo: () => ({ version: 'be-1', health: 'ok' }),
    getRuntimeState: () => ({ model: 'mock', token: 'INJECTED-FAKE-SECRET-E3-ZZ' }),
    getConfig: () => ({ offlineInstallersDir: 'C:\\x', apiKey: 'INJECTED-FAKE-SECRET-E3-ZZ' }),
    nowIso: () => '2026-10-17T00:00:00.000+00:00' };
  const bundle = buildDiagnosticBundle(OPTS_E);
  const names = bundle.files.map((f) => f.name).sort();
  check('E1: bundle file list is exact (current+.1 tails, no jsonl, no strays)',
    JSON.stringify(names) === JSON.stringify(['config-sanitized.json', 'logs/backend.log.1.tail.log', 'logs/backend.log.tail.log',
      'logs/sdk.log.tail.log', 'manifest.json', 'runtime-state.json', 'versions.json']) &&
    JSON.stringify(bundle.manifest.files) === JSON.stringify(names), names);
  const zipPath = path.join(dE, 'diag.zip');
  const out = exportDiagnosticsZip(OPTS_E, zipPath);
  const back = readZip(fs.readFileSync(zipPath));
  const backNames = back.map((e) => e.name).sort();
  const contentsOk = back.every((e) => {
    const src = bundle.files.find((f) => f.name === e.name) || { data: '' };
    return e.data.toString('utf8') === String(src.data);
  });
  check('E2: zip roundtrips names + contents', out.bytes > 100 && JSON.stringify(backNames) === JSON.stringify(names) && contentsOk, backNames);
  const zipLeak = back.filter((e) => e.data.toString('utf8').includes('INJECTED-FAKE-SECRET-E3-ZZ'));
  const zipRed = back.reduce((n, e) => n + (e.data.toString('utf8').match(/\[REDACTED\]/g) || []).length, 0);
  check('E3: zero secrets in the zip, redactions present', zipLeak.length === 0 && zipRed >= 3, { zipLeak: zipLeak.map((e) => e.name), zipRed });
  check('E4: no project content, manifest says so',
    backNames.every((n) => /^(manifest|versions|config-sanitized|runtime-state)\.json$|^logs\/[\w-]+\.log(\.\d+)?\.tail\.log$/.test(n)) &&
    bundle.manifest.projectContent === 'never included' && bundle.manifest.secrets === 'masked ([REDACTED])');
  const dE5 = subdir('e5');
  fs.writeFileSync(path.join(dE5, 'big.log'), Array.from({ length: 5000 }, (_, i) => 'row' + i).join('\n') + '\n');
  const b5 = buildDiagnosticBundle({ logsDir: dE5, tailLines: 100 });
  const tailEntry = b5.files.find((f) => f.name === 'logs/big.log.tail.log');
  check('E5: tails are bounded', !!tailEntry && tailEntry.data.split('\n').length === 100 && tailEntry.data.endsWith('row4999'));

  // ------------------------------------------------- F. logs viewer (P21-e)
  const dF = subdir('f');
  fs.writeFileSync(path.join(dF, 'backend.log'),
    '2026-10-17T10:00:00.000+00:00 [INFO ] [backend] [-] up\n' +
    '2026-10-17T10:00:01.000+00:00 [WARN ] [backend] [-] slow\n' +
    '2026-10-17T10:00:02.000+00:00 [ERROR] [backend] [-] down\n' +
    'plain line without level\n');
  fs.writeFileSync(path.join(dF, 'sdk.log'), '2026-10-17T10:00:00.000+00:00 [INFO ] [sdk] [-] ok\n');
  const listed = listLogFiles(dF);
  check('F1: viewer lists component logs with sizes',
    listed.length === 2 && listed[0].component === 'backend' && listed[0].size > 0 && listed[1].name === 'sdk.log', listed);
  const errTail = getTail(dF, 'backend.log', 100, 'ERROR');
  const allTail = getTail(dF, 'backend.log', 100, 'ALL');
  check('F2: level filter keeps only errors', errTail.lines.length === 1 && errTail.lines[0].includes('down') && allTail.lines.length === 4, errTail);
  check('F3: bad names and escapes rejected',
    getTail(dF, '../../x.log', 10, 'ALL').error && getTail(dF, 'notes.txt', 10, 'ALL').error && getTail(dF, 'nope.log', 10, 'ALL').error);
  LogsPanel.currentPanel = undefined;
  vscodeMock.window.panels.length = 0;
  LogsPanel.createOrShow(undefined, { logsDir: dF });
  const lp = LogsPanel.currentPanel;
  const lpanel = vscodeMock.window.panels[0];
  await lp.handleMessage({ type: 'load' });
  await lp.handleMessage({ type: 'getTail', file: 'sdk.log', maxLines: 50, level: 'INFO' });
  const posted = lpanel.webview.posted;
  check('F4: panel serves files + filtered tail',
    posted.some((m) => m.type === 'files' && m.files.length === 2 && m.dir === dF) &&
    posted.some((m) => m.type === 'tail' && m.file === 'sdk.log' && m.lines.length === 1), posted.map((m) => m.type));
  const clientJs = lpanel.webview.html.split('<script>')[1].split('</scr' + 'ipt>')[0];
  let parses = true;
  let perr = '';
  try { new vm.Script(clientJs); } catch (e) { parses = false; perr = e.message; }
  const lhtml = lpanel.webview.html;
  check('F5: viewer client parses + has filters/refresh', parses &&
    clientJs.includes("type: 'getTail'") && clientJs.includes('function refresh()') &&
    clientJs.includes("=== 'tail'") && lhtml.includes('>Refresh<'), perr);
  try { lp.dispose(); } catch (_) {}
  LogsPanel.currentPanel = undefined;

  // ------------------------------------------------- G. supervisor journal (P21-f)
  const dG = subdir('g');
  const auditFile = path.join(dG, 'supervisor-audit.log');
  const col1 = techCollector();
  let spawns = [];
  let sleeps = [];
  let polls = 0;
  const failingGet = async () => { polls++; const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
  const sup = new RuntimeSupervisor({
    runtimeUrl: 'http://127.0.0.1:6000', runtimeExePath: path.join(dG, 'runtime.exe'),
    auditPath: auditFile, graceMs: 0, pollMs: 60000, failThreshold: 3, backoffsMs: [2000], waitHealthyMs: 1,
    httpGet: failingGet, httpPost: async () => ({ status: 200, data: {} }),
    spawnFn: (p) => { spawns.push(p); return true; }, killFn: async () => 'killed leftovers',
    sleep: async (ms) => { sleeps.push(ms); }, now: () => Date.now(),
    log: () => {}, tech: col1.tech,
  });
  fs.writeFileSync(path.join(dG, 'runtime.exe'), 'fake');
  sup.start();
  // Drive 3 failing polls manually (deterministic, no timers).
  await sup.pollTick(); await sup.pollTick(); await sup.pollTick();
  // waitHealthy keeps failing (httpGet always fails) -> restart done ok=false.
  const msgs = col1.got.map((g) => g.msg);
  const done = col1.got.find((g) => g.msg === 'restart done');
  check('G1: stop + attempt + outcome journaled with reason/codes',
    msgs.includes('supervisor start') && msgs.includes('runtime unhealthy (stop detected)') &&
    msgs.includes('restart attempt') && !!done && done.fields.ok === false &&
    done.fields.spawnOk === true && 'exitCode' in done.fields && 'killResult' in done.fields &&
    /health refused x3/.test(col1.got.find((g) => g.msg === 'restart attempt').fields.reason), msgs);
  check('G2: legacy audit file still appended', /START/.test(fs.readFileSync(auditFile, 'utf8')) && /RESTART/.test(fs.readFileSync(auditFile, 'utf8')));
  sup.stop();
  const col3 = techCollector();
  const sup3 = new RuntimeSupervisor({ auditPath: path.join(dG, 'a3.log'), graceMs: 0, maxRestarts: 1, windowMs: 60000,
    httpGet: failingGet, spawnFn: () => true, killFn: async () => 'k', sleep: async () => {}, log: () => {}, tech: col3.tech });
  sup3.running = true; sup3.startedAt = Date.now() - 1000;
  sup3.restartAttempts = [Date.now()];
  await sup3.maybeRestart('health refused x3 (process likely exited)');
  check('G3: suppressed restarts journaled with reason',
    col3.got.some((g) => g.msg === 'restart suppressed' && g.fields.why === 'cap' && /health refused/.test(g.fields.reason)), col3.got);
  const prod = new RuntimeSupervisor({ auditPath: path.join(dG, 'aprod.log'), log: () => {} });
  const detectBoundMs = prod.failThreshold * prod.pollMs + prod.backoffsMs[0];
  check('G4: prod defaults respawn in under 30 s (3x5s + 2s backoff)',
    prod.failThreshold === 3 && prod.pollMs === 5000 && prod.backoffsMs[0] === 2000 && detectBoundMs === 17000 && detectBoundMs < 30000,
    { detectBoundMs });
  check('G5: STOP journaled', col1.got.some((g) => g.msg === 'supervisor stop'));
  try { sup3.stop(); } catch (_) {}

  // ------------------------------------------------- H. autofix / sdk / duplication (P21-g)
  const colH = techCollector();
  const WIN_BASE = [
    { match: 'winget --version', stdout: 'v1.7.10661' },
    { match: 'GetEnvironmentVariable', stdout: 'C:\\W' },
    { match: 'python --version', stdout: 'Python 3.11.0' },
  ];
  const rh = await fixAll(['Python'], { platform: 'win32',
    execFn: mockExec([{ match: 'net session', code: 0 }, { match: '-File ', action: psRun({}, { S0: 'ok line' }) }, ...WIN_BASE]),
    hasInternet: async () => true, techLog: colH.tech, installTimeoutMs: 5000 });
  const stepH = colH.got.find((g) => g.msg === 'step');
  check('H1: autofix step journaled (cmd, code, tail, ms)',
    rh.rows[0].status === 'fixed' && colH.got.some((g) => g.msg === 'precheck') &&
    !!stepH && stepH.fields.cmd.includes('winget install -e --id Python.Python.3.11') &&
    stepH.fields.code === 0 && typeof stepH.fields.batchMs === 'number' && stepH.fields.out.includes('ok line') &&
    colH.got.some((g) => g.msg === 'verify' && g.fields.ok === true), colH.got.map((g) => g.msg));
  const colH2 = techCollector();
  const rh2 = await fixAll(['Python'], { platform: 'win32',
    execFn: mockExec([{ match: 'net session', code: 0 },
      { match: '-File ', action: psRun({ S0: 1 }, { S0: 'ERROR 0x80070005 denied' }) }, ...WIN_BASE]),
    hasInternet: async () => true, techLog: colH2.tech, installTimeoutMs: 5000 });
  const failStep = colH2.got.find((g) => g.msg === 'step');
  check('H2: failing step journaled with cause + stderr',
    rh2.rows[0].status === 'failed' && !!failStep && failStep.level === 'warn' &&
    failStep.fields.code === 1 && failStep.fields.out.includes('0x80070005'), failStep);
  // H3: DoctorPanel wires the extension tech journal.
  xTech._resetSharedForTests();
  xTech.setTechEnabled(true);
  const depsH3 = DoctorPanel.prototype._engineDeps.call({});
  check('H3: panel engine deps carry the autofix tech journal',
    depsH3 && depsH3.techLog && typeof depsH3.techLog.info === 'function' && depsH3.techLog !== xTech.NOOP);
  const rh3 = await fixAll(['Python'], { ...depsH3, platform: 'win32',
    execFn: mockExec([{ match: 'net session', code: 0 }, { match: '-File ', action: psRun({}) }, ...WIN_BASE]),
    hasInternet: async () => true, installTimeoutMs: 5000 });
  const autoLog = fs.readFileSync(path.join(process.env.SUDO_STUDIO_LOGS, 'autofix.log'), 'utf8');
  check('H3b: panel-driven fix writes autofix.log entries',
    rh3.rows[0].status === 'fixed' && autoLog.includes('precheck') && autoLog.includes('winget install -e --id Python.Python.3.11'), autoLog.slice(0, 200));
  xTech._resetSharedForTests();
  // H4: enterprise SDK installer journals detection commands.
  process.env.PATH = savedPath; // autofix mocks clobber PATH; restore for real exec
  bTech._resetSharedForTests();
  bTech.setTechEnabled(true);
  delete require.cache[require.resolve('../installers/sdkInstaller.enterprise')];
  const sdkEnt = require('../installers/sdkInstaller.enterprise');
  const det = await sdkEnt.detectSDK('nodejs');
  const sdkLog = fs.readFileSync(path.join(process.env.SUDO_STUDIO_LOGS, 'sdk.log'), 'utf8');
  check('H4: sdk installer journals exact cmd + code',
    det.installed === true && sdkLog.includes('cmd=node --version') && sdkLog.includes('code=0') && /durationMs=\d+/.test(sdkLog), sdkLog.slice(0, 220));
  bTech._resetSharedForTests();
  // H5: execLogged unit (same helper family as duplication).
  const colH5 = techCollector();
  const fifty = Array.from({ length: 50 }, (_, i) => 'D' + i).join('\n');
  const rok = await bTech.execLogged(async () => ({ stdout: fifty, stderr: 'w1' }), colH5.tech, 'my-cmd --x', {});
  const eok = colH5.got[0];
  let rethrown = null;
  try {
    await bTech.execLogged(async () => { const e = new Error('nope'); e.code = 3; e.stderr = 'bad stderr'; throw e; }, colH5.tech, 'bad-cmd', {});
  } catch (e) { rethrown = e; }
  const efail = colH5.got[1];
  check('H5: execLogged journals cmd/code/ms/tail30 and rethrows identically',
    rok && eok.fields.cmd === 'my-cmd --x' && eok.fields.code === 0 && typeof eok.fields.durationMs === 'number' &&
    eok.fields.out.includes('D49') && !eok.fields.out.split('\n').includes('D0') && eok.fields.out.includes('w1') &&
    rethrown && rethrown.code === 3 && efail.level === 'warn' && efail.fields.code === 3 && efail.fields.out.includes('bad stderr'));

  // ------------------------------------------------- I. python runtime journal (static)
  const p21py = fs.readFileSync(path.join(RUNTIME_PY, 'p21_journal.py'), 'utf8');
  const srvPy = fs.readFileSync(path.join(RUNTIME_PY, 'server.py'), 'utf8');
  const srvEnt = fs.readFileSync(path.join(RUNTIME_PY, 'server.enterprise.py'), 'utf8');
  check('I1: python journal = same shape + mask + rotation + corr + header, wired in both servers',
    p21py.includes('[%(levelname)s] [runtime] [%(p21corr)s]') && p21py.includes('RotatingFileHandler') &&
    p21py.includes('BACKUP_COUNT = 9') && p21py.includes('before_request_corr') && p21py.includes('def session_header') &&
    srvPy.includes('p21_journal.install()') && srvPy.includes('before_request_corr') && srvPy.includes('session_header') &&
    srvEnt.includes('p21_journal.install()') && srvEnt.includes('before_request_corr') && srvEnt.includes('session_header'));

  console.log('\nP21: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; })
  .finally(() => { try { LogsPanel.currentPanel = undefined; } catch (_) {} process.exit(process.exitCode || 0); });
