/** PROMPT 12 UX suite (ASCII-only): catalogue Charged, duplication, uptime. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execSync } = require('child_process');

process.env.SUDO_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-home-'));

// Mutable vscode stub (configured per test).
const vscodeStub = {
    window: { showOpenDialog: async () => undefined,
        showInformationMessage: () => {}, showWarningMessage: () => {}, showErrorMessage: () => {} },
    workspace: {},
    Uri: { file: (p) => ({ fsPath: p }) },
    ViewColumn: {},
};
const origLoad = Module._load;
const axiosStub = { get: async () => ({ data: {} }), post: async () => ({ data: {} }),
    defaults: {}, interceptors: { request: { use: () => {} }, response: { use: () => {} } } };
Module._load = function (req, ...rest) {
    if (req === 'vscode') return vscodeStub;
    if (req === 'axios') return axiosStub;
    return origLoad.call(this, req, ...rest);
};

const Dup = require('../../sudo-ai-extension/src/panels/DuplicationPanel.js');
const Rt = require('../../sudo-ai-extension/src/panels/RuntimePanel.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function mkFixture(n) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-src-'));
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(src, 'f' + i + '.txt'), 'content-' + i);
    fs.mkdirSync(path.join(src, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node_modules', 'x', 'junk.js'), 'junk');
    fs.mkdirSync(path.join(src, 'build'));
    fs.writeFileSync(path.join(src, 'build', 'out.bin'), 'o');
    fs.mkdirSync(path.join(src, '.dart_tool'));
    fs.writeFileSync(path.join(src, '.dart_tool', 'pkg'), 'p');
    try { fs.symlinkSync(path.join(src, 'f0.txt'), path.join(src, 'link.txt')); } catch {}
    return src;
}
function mkPanel(captured) {
    const p = Object.create(Dup.DuplicationPanel.prototype);
    p.panel = { webview: { postMessage: (m) => captured.push(m) } };
    return p;
}

(async () => {
// B1: default exclusions
check('B1-excludes', JSON.stringify(Dup.DUP_DEFAULT_EXCLUDES) === JSON.stringify(['node_modules', 'build', '.dart_tool']));

// B2: collect skips excluded dirs + symlinks
const src = mkFixture(60);
const list = Dup.collectDupFiles(src, Dup.DUP_DEFAULT_EXCLUDES);
check('B2-collect', list.files.length === 60 && list.skippedSymlinks === 1,
    JSON.stringify({ n: list.files.length, sym: list.skippedSymlinks }));

// B3: verify all-match on a real copy
const destB3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-d3-'));
for (const rel of list.files) {
    fs.mkdirSync(path.dirname(path.join(destB3, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(destB3, rel));
}
const rep = Dup.verifyDupCopy(src, list.files, destB3);
check('B3-verify-ok', rep.checked === 25 && rep.matched === 25 && rep.destCount === 60,
    JSON.stringify({ c: rep.checked, m: rep.matched, d: rep.destCount }));

// B4: tamper detected
fs.writeFileSync(path.join(destB3, 'f0.txt'), 'TAMPERED!!!');
const rep2 = Dup.verifyDupCopy(src, list.files, destB3);
check('B4-tamper', rep2.matched === rep2.checked - 1 && rep2.mismatches.includes('f0.txt'),
    JSON.stringify({ m: rep2.matched, c: rep2.checked, mm: rep2.mismatches }));

// B5: end-to-end _duplicateProject success (30 files -> empty dir)
const src5 = mkFixture(30);
const dest5 = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-d5-'));
vscodeStub.workspace = { workspaceFolders: [{ uri: { fsPath: src5 } }] };
vscodeStub.window.showOpenDialog = async () => [{ fsPath: dest5 }];
const cap5 = [];
await mkPanel(cap5)._duplicateProject();
const done5 = cap5.find((m) => m.type === 'duplicateDone');
const prog5 = cap5.filter((m) => m.type === 'duplicateProgress');
const onDisk = Dup.collectDupFiles(dest5, []).files.length;
check('B5-e2e-success', !!done5 && done5.success === true && done5.report.copied === 30 &&
    done5.report.matched === done5.report.checked && done5.report.destCount === 30 &&
    prog5.length > 0 && prog5[prog5.length - 1].total === 30 && onDisk === 30 &&
    !fs.existsSync(path.join(dest5, 'node_modules')),
    JSON.stringify(done5 && done5.report));

// B6: cancel = silent no-op
vscodeStub.window.showOpenDialog = async () => undefined;
const cap6 = [];
await mkPanel(cap6)._duplicateProject();
check('B6-cancel-noop', cap6.length === 0, 'posted=' + cap6.length);

// B7: guards (dest==src / dest-in-src / non-empty dest)
let errs = [];
vscodeStub.window.showErrorMessage = (m) => errs.push(m);
vscodeStub.window.showOpenDialog = async () => [{ fsPath: src5 }];
const cap7a = [];
await mkPanel(cap7a)._duplicateProject();
const d7a = cap7a.find((m) => m.type === 'duplicateDone');
vscodeStub.window.showOpenDialog = async () => [{ fsPath: path.join(src5, 'sub') }];
const cap7b = [];
await mkPanel(cap7b)._duplicateProject();
const d7b = cap7b.find((m) => m.type === 'duplicateDone');
const nonEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-ne-'));
fs.writeFileSync(path.join(nonEmpty, 'x.txt'), 'x');
vscodeStub.window.showOpenDialog = async () => [{ fsPath: nonEmpty }];
const cap7c = [];
await mkPanel(cap7c)._duplicateProject();
const d7c = cap7c.find((m) => m.type === 'duplicateDone');
check('B7-guards', !!d7a && d7a.success === false && !!d7b && d7b.success === false &&
    !!d7c && d7c.success === false && errs.length === 3,
    JSON.stringify([d7a && d7a.error, d7b && d7b.error, d7c && d7c.error]));

// B8: no workspace = warning, no crash
vscodeStub.workspace = {};
let warns = [];
vscodeStub.window.showWarningMessage = (m) => warns.push(m);
const cap8 = [];
await mkPanel(cap8)._duplicateProject();
check('B8-no-workspace', cap8.length === 0 && warns.length === 1);

// B9: client action label + handlers
const html = Object.create(Dup.DuplicationPanel.prototype)._buildHtml();
check('B9-client', html.includes('Dupliquer ce projet vers un nouveau dossier...') &&
    html.includes("m.type==='duplicateProgress'") && html.includes("m.type==='duplicateDone'") &&
    html.includes('renderDupDone(m)') && html.includes('dupliquer') === false /* ASCII guard */);

// B10: fmtUptime export
check('B10-uptime', Rt.fmtUptime(33180) === '9 h 13 min' && Rt.fmtUptime(805) === '13 min 25 s' &&
    Rt.fmtUptime(45) === '45 s' && Rt.fmtUptime(0) === '0 s',
    JSON.stringify([Rt.fmtUptime(33180), Rt.fmtUptime(805), Rt.fmtUptime(45), Rt.fmtUptime(0)]));

// B11: loaded model labelled Charge (button), no RAM badge when loaded, uptime via fmtUptime
const rhtml = Object.create(Rt.RuntimePanel.prototype).getHtmlContent();
const rsrc = fs.readFileSync('../../sudo-ai-extension/src/panels/RuntimePanel.js', 'utf8');
check('B11-runtime-client', rhtml.includes('Charg\u00e9') && rhtml.includes('if (!isLoaded)') &&
    rhtml.includes('if (!canLoad && !isLoaded)') &&
    rsrc.includes('fmtUptime(r.data.uptime_seconds)') && !rsrc.includes('uptime_seconds || 0}s'));

// B12: python server comparable-RAM wiring (source asserts + compile)
const py = fs.readFileSync('../runtime/server.enterprise.py', 'utf8');
const needles = ['def comparable_ram_gb', 'def _current_model_ram_gb', '"ram_comparable_gb"',
    '"ram_current_model_gb"', 'is_current', 'compare_ram', 'ram_fits(model["ram_gb"], compare_ram)'];
const missing = needles.filter((n) => !py.includes(n));
let compiled = false;
try { execSync('python3 -m py_compile ../runtime/server.enterprise.py'); compiled = true; } catch {}
check('B12-server', missing.length === 0 && compiled, 'missing=' + JSON.stringify(missing));

console.log(`\nP12: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exit(1); });
