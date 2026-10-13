/**
 * SUDO STUDIO - PROMPT 10 suite: real security score.
 * A: formula | B: secret scanner | C: security files + tests | D: dep lines |
 * E: panel protocol | F: JSON+HTML exports | G: client | H: no hardcoded value.
 * Hermetic (SUDO_STUDIO_HOME + SUDO_ADVISORIES_PATH), vscode mocked.
 * ASCII-only. No "ninety" literal anywhere in this file (see H1).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-fx-'));
function wf(root, rel, content) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// -- fixture advisory DBs (fresh + stale) ------------------------------------
const today = new Date().toISOString().slice(0, 10);
const ADVS = [
    { ecosystem: 'npm', package: 'left-pad', vulnerable: '<9.0.0', cve: 'CVE-TEST-1',
        severity: 'high', summary: 'fixture advisory', fixedIn: '9.0.0' },
    { ecosystem: 'pip', package: 'requests', vulnerable: '<99.0', cve: 'CVE-TEST-2',
        severity: 'critical', summary: 'fixture advisory 2', fixedIn: '99.0' },
];
const dbFresh = path.join(FX, 'db-fresh.json');
fs.writeFileSync(dbFresh, JSON.stringify({ generatedAt: today, advisories: ADVS }));
const dbStale = path.join(FX, 'db-stale.json');
fs.writeFileSync(dbStale, JSON.stringify({ generatedAt: '2020-01-01', advisories: ADVS }));
process.env.SUDO_ADVISORIES_PATH = dbFresh;

// -- vscode mock + localAudit facade (DB removable for the unavailable path) --
const vscodeMock = { workspace: { workspaceFolders: [] }, window: {},
    ViewColumn: { One: 1 }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } };
const warned = [];
vscodeMock.window.showInformationMessage = () => {};
vscodeMock.window.showErrorMessage = () => {};
vscodeMock.window.showWarningMessage = (m) => warned.push(m);
vscodeMock.window.showSaveDialog = async () => null;
vscodeMock.window.showOpenDialog = async () => null;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeMock;
    return origLoad.call(this, req, parent, isMain);
};
const laPath = require.resolve('../../sudo-ai-extension/src/utils/localAudit');
const realLA = require(laPath);
let forceNullDb = false;
require.cache[laPath].exports = Object.assign({}, realLA, {
    loadAdvisories: (...a) => (forceNullDb
        ? { db: null, from: null, error: 'test: removed' }
        : realLA.loadAdvisories(...a)),
});
const ss = require('../../sudo-ai-extension/src/utils/securityScore');
const { SecurityPanel } = require('../../sudo-ai-extension/src/panels/SecurityPanel');
const { getAuditLog } = require('../../sudo-ai-extension/src/utils/auditLog');

// -- fixtures -----------------------------------------------------------------
const P = path.join(FX, 'proj');
wf(P, 'requirements.txt', 'flask==3.0.0\n');
wf(P, 'main.py', 'print(1)\n');
wf(P, 'tests/test_x.py', 'def test_x(): pass\n');
wf(P, '.gitignore', '.env\n.env.production\n');
const N = path.join(FX, 'node');
wf(N, 'package.json', JSON.stringify({ name: 'n', scripts: { test: 'jest' } }));
wf(N, 'package-lock.json', JSON.stringify({ packages: {
    '': {}, 'node_modules/left-pad': { version: '1.3.0' } } }));
wf(N, '.gitignore', '.env\n');
const S = path.join(FX, 'scan');
wf(S, '.env', 'API_KEY=sk-test123\n');
wf(S, '.env.production', '# prod\nAUTH_TOKEN=abcdefghi\n');
wf(S, 'quoted.js', 'const k = "x";\napi_key="ABCDEFGHIJKLMNOP"\n');
wf(S, 'place.env', 'API_KEY=your_key_here\n');
wf(S, 'empty.env', 'API_KEY=\n');
wf(S, 'short.env', 'API_KEY=abc\n');
wf(S, 'key.pem', '-----BEGIN RSA PRIVATE KEY-----\n');
wf(S, 'tok.js', 'const t = "ghp_' + 'a'.repeat(36) + '";\n');
const F1 = path.join(FX, 'f-nogi'); wf(F1, 'main.py', 'x\n');
const F2 = path.join(FX, 'f-env'); wf(F2, '.env.production', 'K=V\n'); wf(F2, '.gitignore', '.env\n');
const F3 = path.join(FX, 'f-envok'); wf(F3, '.env.production', 'K=V\n'); wf(F3, '.gitignore', '.env.production\n');
const F4 = path.join(FX, 'f-node-u'); wf(F4, 'package.json', '{}');
const F5 = path.join(FX, 'f-node-l'); wf(F5, 'package.json', '{}'); wf(F5, 'package-lock.json', '{}');
const F6 = path.join(FX, 'f-py-u'); wf(F6, 'requirements.txt', 'flask>=3.0\n');
const F7 = path.join(FX, 'f-py-l'); wf(F7, 'requirements.txt', 'flask==3.0.0\n');
const F8 = path.join(FX, 'f-glob'); wf(F8, '.env.production', 'K=V\n'); wf(F8, '.gitignore', '.env*\n');

async function main() {
    const dbOk = { date: today, source: 'test', stale: false };
    const cleanFiles = { noGitignore: false, unignoredProdEnv: [], unlocked: [] };
    const cleanIn = { secrets: [], advisories: [], files: cleanFiles, hasTests: true, db: dbOk };

    // -- A: formula ------------------------------------------------------------
    const a1 = ss.computeSecurityScore(cleanIn);
    check('A1: clean project scores full with ok status',
        a1.status === 'ok' && a1.score === 100 && a1.penalties.length === 0);
    const a2 = ss.computeSecurityScore(Object.assign({}, cleanIn, {
        secrets: [{ label: 'Generic API Key (unquoted)', file: '.env', line: 1 }] }));
    check('A2: one high secret costs 8 and cites file+line',
        a2.score === 92 && a2.penalties.length === 1 && a2.penalties[0].points === 8 &&
        a2.penalties[0].file === '.env' && a2.penalties[0].line === 1 && a2.penalties[0].applied);
    const a3 = ss.computeSecurityScore(Object.assign({}, cleanIn, {
        secrets: [{ label: 'Private Key (PEM)', file: 'k.pem', line: 3 }] }));
    check('A3: one critical secret costs 15', a3.score === 85);
    const a4 = ss.computeSecurityScore(Object.assign({}, cleanIn, {
        advisories: [{ package: 'x', version: '1', severity: 'weird', source: 'l' }] }));
    check('A4: unknown advisory severity counts as medium (2)', a4.score === 98);
    const many = [];
    for (let i = 0; i < 2; i++) many.push({ label: 'Private Key (PEM)', file: 'k' + i, line: 1 });
    for (let i = 0; i < 4; i++) many.push({ label: 'GitHub Token', file: 't' + i, line: 1 });
    const a5 = ss.computeSecurityScore(Object.assign({}, cleanIn, { secrets: many }));
    const a5drop = a5.penalties.filter((p) => !p.applied).length;
    check('A5: secrets capped (38 applied of 62, rest listed)',
        a5.appliedByCat.secrets === 38 && a5.score === 62 && a5drop === 3 &&
        a5.penalties.length === 6);
    const advs = [];
    for (let i = 0; i < 5; i++) advs.push({ package: 'c' + i, version: '1', severity: 'critical', source: 'l' });
    for (let i = 0; i < 4; i++) advs.push({ package: 'h' + i, version: '1', severity: 'high', source: 'l' });
    const a6 = ss.computeSecurityScore(Object.assign({}, cleanIn, { advisories: advs }));
    check('A6: advisories capped (30 applied of 70)',
        a6.appliedByCat.advisories === 30 && a6.score === 70 &&
        a6.penalties.filter((p) => !p.applied).length === 6);
    const a7 = ss.computeSecurityScore(Object.assign({}, cleanIn, { files: {
        noGitignore: true, unignoredProdEnv: ['.env.production'],
        unlocked: [{ ecosystem: 'node', manifest: 'package.json' }] } }));
    const a7drop = a7.penalties.filter((p) => !p.applied);
    check('A7: files capped (15 applied, gitignore dropped last)',
        a7.appliedByCat.files === 15 && a7.score === 85 && a7drop.length === 1 &&
        a7drop[0].detail.indexOf('.gitignore') !== -1);
    const maxed = ss.computeSecurityScore({ secrets: many.concat(many), advisories: advs.concat(advs),
        files: { noGitignore: true, unignoredProdEnv: ['.env.production', '.env'],
            unlocked: [{ ecosystem: 'node', manifest: 'package.json' }] },
        hasTests: false, db: dbOk });
    check('A8: maxed input stays non-negative and deterministic',
        maxed.score >= 0 && maxed.appliedByCat.secrets <= 40 &&
        maxed.appliedByCat.advisories <= 30 && maxed.appliedByCat.files <= 15);
    const a9 = ss.computeSecurityScore(Object.assign({}, cleanIn, { db: null }));
    check('A9: missing DB is unavailable with null score, never a number',
        a9.status === 'unavailable' && a9.score === null &&
        a9.reason.indexOf('avis') !== -1 && a9.penalties.length === 0);
    const a10 = ss.computeSecurityScore(Object.assign({}, cleanIn,
        { db: { date: '2020-01-01', source: 'test', stale: true } }));
    check('A10: stale DB is partial with computed score + dated reason',
        a10.status === 'partial' && a10.score === 100 &&
        a10.reason.indexOf('2020-01-01') !== -1 && a10.reason.indexOf('180') !== -1);
    const r1 = ss.computeSecurityScore(cleanIn);
    const r2 = ss.computeSecurityScore(cleanIn);
    delete r1.computedAt; delete r2.computedAt;
    check('A11: scoring is deterministic',
        JSON.stringify(r1) === JSON.stringify(r2));
    const a12 = ss.computeSecurityScore(Object.assign({}, cleanIn, { advisories: [
        { package: 'left-pad', version: '1.3.0', severity: 'high',
            source: 'package-lock.json', line: 7, cve: 'CVE-TEST-1', fixedIn: '9.0.0' } ] }));
    check('A12: advisory penalty cites lockfile + line',
        a12.score === 95 && a12.penalties[0].file === 'package-lock.json' &&
        a12.penalties[0].line === 7);

    // -- B: secret scanner (via the panel, proof secret included) ----------------
    function barePanel() {
        const fp = { webview: { html: '', posted: [],
            async postMessage(m) { this.posted.push(m); return true; },
            onDidReceiveMessage() {} },
        onDidDispose() {}, reveal() {}, dispose() {} };
        return new SecurityPanel(fp, null);
    }
    const scanP = barePanel();
    const hits = await scanP._scanSecrets(S);
    const byFile = (f) => hits.filter((h) => h.file === f);
    const envHit = byFile('.env')[0];
    check('B1: proof secret flagged with file+line+severity',
        byFile('.env').length === 1 && envHit.line === 1 &&
        envHit.label === 'Generic API Key (unquoted)' && envHit.severity === 'high' &&
        envHit.snippet.indexOf('sk-test123') === -1);
    check('B2: placeholder value skipped', byFile('place.env').length === 0);
    const qHits = byFile('quoted.js').filter((h) => h.line === 2);
    check('B3: quoted value is a single hit (no duplicate)',
        qHits.length === 1 && qHits[0].label === 'Generic API Key');
    const prodHit = byFile('.env.production')[0];
    check('B4: .env.production is scanned (line 2)',
        byFile('.env.production').length === 1 && prodHit.line === 2);
    check('B5: PEM key is critical',
        byFile('key.pem').length === 1 && byFile('key.pem')[0].severity === 'critical');
    check('B6: shared patterns still work (GitHub token)',
        byFile('tok.js').length === 1 && byFile('tok.js')[0].label === 'GitHub Token');
    check('B7: empty assignment skipped', byFile('empty.env').length === 0);
    check('B8: short value skipped', byFile('short.env').length === 0);
    check('B9: unknown label defaults to medium',
        ss.severityOfSecret('no-such-label') === 'medium');

    // -- C: security files + tests ----------------------------------------------
    check('C1: missing .gitignore detected',
        ss.checkSecurityFiles(F1).noGitignore === true);
    const c2 = ss.computeSecurityScore(Object.assign({}, cleanIn,
        { files: ss.checkSecurityFiles(F2), hasTests: true }));
    check('C2: unignored .env.production costs 10',
        ss.checkSecurityFiles(F2).unignoredProdEnv.join(',') === '.env.production' &&
        c2.appliedByCat.files === 10);
    check('C3: ignored .env.production is clean',
        ss.checkSecurityFiles(F3).unignoredProdEnv.length === 0);
    check('C4: node without lockfile is unlocked',
        ss.checkSecurityFiles(F4).unlocked.length === 1 &&
        ss.checkSecurityFiles(F4).unlocked[0].ecosystem === 'node');
    check('C5: node with lockfile is locked',
        ss.checkSecurityFiles(F5).unlocked.length === 0);
    check('C6: unpinned requirements without lock is unlocked',
        ss.checkSecurityFiles(F6).unlocked.length === 1);
    check('C7: fully pinned requirements counts as locked',
        ss.checkSecurityFiles(F7).unlocked.length === 0);
    check('C8: .env* glob covers prod env files',
        ss.checkSecurityFiles(F8).unignoredProdEnv.length === 0);
    check('C9: tests detected (dir, script) or absent',
        ss.hasTests(P) === true && ss.hasTests(N) === true && ss.hasTests(F1) === false);

    // -- D: dependency line citations --------------------------------------------
    const d1 = ss.locateDepLine(N, 'package-lock.json', 'left-pad', '1.3.0');
    const d1line = d1 ? fs.readFileSync(path.join(N, 'package-lock.json'), 'utf8').split('\n')[d1 - 1] : '';
    check('D1: lockfile line points at the package',
        typeof d1 === 'number' && d1 > 0 && d1line.indexOf('left-pad') !== -1);
    check('D2: requirements line is exact',
        ss.locateDepLine(P, 'requirements.txt', 'flask', '3.0.0') === 1);
    check('D3: missing lockfile gives no line',
        ss.locateDepLine(F1, 'package-lock.json', 'x', '1') === null);

    // -- E: panel protocol (clean -> secret -> vuln -> clean) --------------------
    async function auditOn(dir) {
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
        const fp = { webview: { html: '', posted: [],
            async postMessage(m) { this.posted.push(m); return true; },
            onDidReceiveMessage() {} },
        onDidDispose() {}, reveal() {}, dispose() {} };
        const p = new SecurityPanel(fp, null);
        await p._runAudit();
        const found = fp.webview.posted.filter((m) => m.type === 'auditResult');
        assert.ok(found.length >= 1, 'auditResult posted for ' + dir);
        return { p, audit: found[0].audit };
    }
    const e1 = await auditOn(P);
    check('E1: clean project scores full from the fixture DB',
        e1.audit.scoreResult.status === 'ok' && e1.audit.scoreResult.score === 100 &&
        e1.audit.score === 100 && e1.audit.localAudit.dbDate === today &&
        e1.audit.localAudit.dbEntries === 2 && e1.audit.localAudit.stale === false);
    wf(P, '.env', 'API_KEY=sk-test123\n');
    const e2 = await auditOn(P);
    const e2pen = e2.audit.scoreResult.penalties.filter((x) => x.category === 'Secret')[0];
    check('E2: added secret drops the score and is cited',
        e2.audit.scoreResult.score === 92 && !!e2pen && e2pen.file === '.env' &&
        e2pen.line === 1 && e2pen.points === 8 && e2pen.applied);
    wf(P, 'requirements.txt', 'flask==3.0.0\nrequests==2.31.0\n');
    const e3 = await auditOn(P);
    const e3pen = e3.audit.scoreResult.penalties.filter((x) => x.category === 'Dependance')[0];
    check('E3: vulnerable dep drops it further with file+line',
        e3.audit.scoreResult.score === 82 && !!e3pen &&
        e3pen.file === 'requirements.txt' && e3pen.line === 2 &&
        e3pen.detail.indexOf('requests@2.31.0') !== -1);
    fs.unlinkSync(path.join(P, '.env'));
    wf(P, 'requirements.txt', 'flask==3.0.0\n');
    const e4 = await auditOn(P);
    check('E4: removing both restores the clean score',
        e4.audit.scoreResult.score === 100 &&
        e4.audit.scoreResult.penalties.length === 0);
    check('E5: scores differ along the sequence',
        e1.audit.score !== e2.audit.score && e2.audit.score !== e3.audit.score &&
        e4.audit.score === e1.audit.score);
    forceNullDb = true;
    let e6;
    try { e6 = await auditOn(P); } finally { forceNullDb = false; }
    check('E6: removed DB is non-calculable, never a number',
        e6.audit.scoreResult.status === 'unavailable' && e6.audit.score === null &&
        e6.audit.scoreResult.reason.indexOf('avis') !== -1);
    process.env.SUDO_ADVISORIES_PATH = dbStale;
    const e7 = await auditOn(P);
    process.env.SUDO_ADVISORIES_PATH = dbFresh;
    check('E7: stale DB is partial with the score still shown',
        e7.audit.scoreResult.status === 'partial' && e7.audit.score === 100 &&
        e7.audit.scoreResult.reason.indexOf('2020-01-01') !== -1);
    const e8a = await auditOn(F1);
    const e8b = await auditOn(P);
    check('E8: two different projects score differently',
        e8a.audit.score !== e8b.audit.score &&
        e8a.audit.scoreResult.appliedByCat.files === 5 &&
        e8a.audit.scoreResult.appliedByCat.tests === 5);
    const e9 = await auditOn(P);
    check('E9: re-running recalculates (stable when unchanged)',
        e9.audit.scoreResult.score === 100 && e9.audit.scoreResult.status === 'ok');
    vscodeMock.workspace.workspaceFolders = [];
    const fp10 = { webview: { html: '', posted: [],
        async postMessage(m) { this.posted.push(m); return true; },
        onDidReceiveMessage() {} },
    onDidDispose() {}, reveal() {}, dispose() {} };
    const p10 = new SecurityPanel(fp10, null);
    await p10._runAudit();
    const a10b = fp10.webview.posted.filter((m) => m.type === 'auditResult')[0].audit;
    check('E10: no folder is unavailable with a clear reason',
        a10b.scoreResult.status === 'unavailable' && a10b.score === null &&
        a10b.scoreResult.reason.indexOf('dossier') !== -1);

    // -- F: JSON + HTML exports ---------------------------------------------------
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: P } }];
    const ex = await auditOn(P);
    const jPath = path.join(FX, 'report.json');
    vscodeMock.window.showSaveDialog = async () => ({ fsPath: jPath });
    await ex.p._exportReport('json');
    const back = JSON.parse(fs.readFileSync(jPath, 'utf8'));
    check('F1: JSON export round-trips the score',
        back.scoreResult.score === 100 && !!back.exportedAt && Array.isArray(back.secrets));
    const hPath = path.join(FX, 'report.html');
    vscodeMock.window.showSaveDialog = async () => ({ fsPath: hPath });
    await ex.p._exportReport('html');
    const hBack = fs.readFileSync(hPath, 'utf8');
    check('F2: HTML export is standalone with score + why-table',
        hBack.indexOf('Pourquoi ce score') !== -1 && hBack.indexOf('100 / 100') !== -1 &&
        hBack.indexOf('</html>') !== -1 && hBack.indexOf('Calcule le') !== -1);
    const acts = getAuditLog(500).map((e) => e.action);
    check('F3: both exports are audited',
        acts.filter((a) => a === 'SECURITY_EXPORT_REPORT').length === 2);
    const fresh = barePanel();
    const wBefore = warned.length;
    await fresh._exportReport('json');
    check('F4: export without results warns instead of crashing',
        warned.length === wBefore + 1);
    vscodeMock.window.showSaveDialog = async () => null;
    await ex.p._exportReport('json');
    check('F5: cancelled dialog is a silent no-op', true);

    // -- G: client ------------------------------------------------------------------
    const html = SecurityPanel.prototype._buildHtml.call({});
    const clientJs = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const clientFile = path.join(FX, 'client-extract.js');
    fs.writeFileSync(clientFile, clientJs);
    const chk = spawnSync(process.execPath, ['--check', clientFile]);
    check('G1: security client script compiles', chk.status === 0);
    check('G2: client renders why-table + export actions',
        clientJs.indexOf('Pourquoi ce score') !== -1 &&
        clientJs.indexOf('openWhyFile') !== -1 &&
        clientJs.indexOf('exportReportHtml') !== -1);
    check('G3: client shows the non-calculable banner',
        clientJs.indexOf('Score non calculable') !== -1);

    // -- H: no hardcoded value in the score code --------------------------------------
    const nineZero = String.fromCharCode(57, 48);
    const scoreSrc = fs.readFileSync(
        path.join(__dirname, '../../sudo-ai-extension/src/utils/securityScore.js'), 'utf8');
    check('H1: score module contains no hardcoded ninety', scoreSrc.indexOf(nineZero) === -1);
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    check('H2: this suite contains no hardcoded ninety', selfSrc.indexOf(nineZero) === -1);
    assert.ok(pass > 0, 'suite ran');

}

main().then(() => {
    console.log(fail === 0 ? '\nP10: ' + pass + ' checks passed (all green)'
        : '\nP10: ' + pass + ' passed, ' + fail + ' FAILED');
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
