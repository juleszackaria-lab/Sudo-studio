/**
 * SUDO STUDIO - PROMPT 18 suite: real secret detection.
 * A: 4 prompt secret types | B: gitignore reduces severity | C: standalone,
 * dotfile, extensionless | D: clean project | E: scan honesty |
 * F: missing advisory DB | G: real panel render | H: masked exports+logs |
 * I: units + no-ninety self-check.
 * Hermetic (own TMP_HOME, fixture DB path), vscode mocked. ASCII-only: the
 * exact P18-e French string is built with \xe9 escapes (data stays exact).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p18-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p18-fx-'));
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

// -- fake secrets (realistic shape, never real; no ninety literal anywhere) --
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtILTEyMzQ1Njc4In0.ZmFrZS1zaWduYXR1cmUtMTIzNDU2Nzg';
const SKV = 'sk-fake-test-key-87654321';
const HEX64 = 'abcdef12345678'.repeat(4) + 'a1b2c3d4';
const PGURL = 'postgres://fakeuser:fakepass1234@db.internal:5432/appdb';
const SKBARE = 'sk-fake-standalone-55667788';
const DOCKTOK = 'fake-docker-token-abcdef12345678';
const RCSECRET = 'topsecret-fake-value-12345678';
const SECRETS = [JWT, SKV, HEX64, PGURL, 'fakepass1234', SKBARE, DOCKTOK, RCSECRET];
const E_MISSING = 'Vuln\xe9rabilit\xe9s : non \xe9valu\xe9es (base d\'avis absente)';

// -- fixture advisory DB (empty: no matches on fixtures) -----------------------
const today = new Date().toISOString().slice(0, 10);
const dbFresh = path.join(FX, 'db-fresh.json');
fs.writeFileSync(dbFresh, JSON.stringify({ generatedAt: today, advisories: [] }));
process.env.SUDO_ADVISORIES_PATH = dbFresh;

// -- vscode mock + localAudit facade (DB removable) ----------------------------
const vscodeMock = { workspace: { workspaceFolders: [] }, window: {},
    ViewColumn: { One: 1 }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } };
let dialogPath = null;
vscodeMock.window.showInformationMessage = () => {};
vscodeMock.window.showErrorMessage = () => {};
vscodeMock.window.showWarningMessage = () => {};
vscodeMock.window.showSaveDialog = async () => (dialogPath ? { fsPath: dialogPath } : null);
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

// -- fixtures ------------------------------------------------------------------
const LEAK = path.join(FX, 'leak');
wf(LEAK, '.env', 'JWT_SECRET=' + JWT + '\nSASPAY_CLIENT_SECRET=' + SKV +
    '\nBACKUP_HEX=' + HEX64 + '\nDATABASE_URL=' + PGURL + '\n');
wf(LEAK, '.myapprc', 'SECRET=' + RCSECRET + '\n');
wf(LEAK, 'Dockerfile', 'ENV API_TOKEN=' + DOCKTOK + '\n');
wf(LEAK, 'notes.txt', HEX64 + '\n');
wf(LEAK, 'app.js', 'const t = "' + JWT + '";\n');
wf(LEAK, 'legacy.txt', 'mirror of ' + SKBARE + ' for recovery\n');

const CLEAN = path.join(FX, 'clean');
wf(CLEAN, 'index.js', 'console.log("hello");\n');
wf(CLEAN, 'README.md', '# Clean\nhello world\n');
wf(CLEAN, 'tests/t.js', 'const assert = require("assert");\nassert(1);\n');
wf(CLEAN, '.gitignore', '.env\n');

const HONEST = path.join(FX, 'honest');
wf(HONEST, 'ok.txt', 'hello\n');
fs.writeFileSync(path.join(HONEST, 'big.log'), 'x'.repeat(1150000));
const LOCKHASH = 'aB3dE5fG7hJ9kL1mN4pQ6rS8tU0vW2xY4zA6bC8';
wf(HONEST, 'package-lock.json', '{"integrity": "sha512-' + LOCKHASH + '"}');
fs.writeFileSync(path.join(HONEST, 'img.dat'),
    Buffer.concat([Buffer.from('AKIAFAKEFAKEFAKE1234'), Buffer.alloc(64), Buffer.from('tail')]));

function barePanel() {
    const fp = { webview: { html: '', posted: [],
        async postMessage(m) { this.posted.push(m); return true; },
        onDidReceiveMessage() {} },
    onDidDispose() {}, reveal() {}, dispose() {} };
    return { fp, p: new SecurityPanel(fp, null) };
}
async function auditOn(dir) {
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
    const { fp, p } = barePanel();
    await p._runAudit();
    const found = fp.webview.posted.filter((m) => m.type === 'auditResult');
    assert.ok(found.length >= 1, 'auditResult posted for ' + dir);
    return { p, audit: found[0].audit };
}
function renderHtml(audit) {
    const html0 = SecurityPanel.prototype._buildHtml.call({});
    const clientJs = html0.match(/<script>([\s\S]*?)<\/script>/)[1];
    const store = {};
    const mkEl = () => ({ _h: '',
        set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
        textContent: '', disabled: true });
    global.document = { getElementById: (id) => (store[id] || (store[id] = mkEl())) };
    global.window = { addEventListener: () => {} };
    global.acquireVsCodeApi = () => ({ postMessage: () => {} });
    let out = '';
    eval(clientJs + '\nrenderAudit(' + JSON.stringify(audit) +
        ');out = document.getElementById("content").innerHTML;');
    delete global.document; delete global.window; delete global.acquireVsCodeApi;
    return out;
}

async function main() {
    // -- A: the 4 prompt secret types (.env NOT git-ignored -> critical) ------
    const aA = await auditOn(LEAK);
    const envHits = aA.audit.secrets.filter((h) => h.file === '.env');
    check('A1: all 4 prompt secrets detected with file+line',
        envHits.length === 4 &&
        envHits.map((h) => h.line).join(',') === '1,2,3,4');
    check('A2: one hit per line with the right labels',
        envHits[0].label === 'Secret Assignment' &&
        envHits[1].label === 'Secret Assignment' &&
        envHits[2].label === 'High-Entropy String' &&
        envHits[3].label === 'URL with Credentials');
    check('A3: not git-ignored -> max severity on all 9 hits',
        aA.audit.secrets.length === 9 &&
        aA.audit.secrets.every((h) => h.severity === 'critical' && h.ignored === false));
    check('A4: values never survive in hits/snippets',
        SECRETS.every((v) => JSON.stringify(aA.audit.secrets).indexOf(v) === -1));
    check('A5: 6 files analyzed (dotfiles + extensionless counted)',
        aA.audit.secretsMeta && aA.audit.secretsMeta.scanned === 6 &&
        aA.audit.secretsMeta.error === null);
    const secPen = aA.audit.scoreResult.penalties.filter((x) => x.category === 'Secret');
    check('A6: heavily penalized score (50, secrets 30 applied, issues 17)',
        aA.audit.score === 50 && aA.audit.scoreResult.appliedByCat.secrets === 30 &&
        secPen.length === 9 && secPen.filter((x) => x.applied).length === 2 &&
        secPen[0].file === '.env' && secPen[0].line === 1 && aA.audit.issues === 17);

    // -- B: same project with .env git-ignored -> reduced but still flagged ---
    wf(LEAK, '.gitignore', '.env\n');
    const aB = await auditOn(LEAK);
    const envB = aB.audit.secrets.filter((h) => h.file === '.env');
    check('B1: still all 4 flagged with file+line',
        envB.length === 4 && envB.map((h) => h.line).join(',') === '1,2,3,4');
    check('B2: ignored -> base severity (high/high/medium/high), kept labels',
        envB.every((h) => h.ignored === true && h.severity !== 'critical') &&
        envB[0].severity === 'high' && envB[2].severity === 'medium' &&
        envB[3].severity === 'high');
    const dockB = aB.audit.secrets.filter((h) => h.file === 'Dockerfile')[0];
    check('B3: unignored files stay critical',
        dockB && dockB.severity === 'critical' && dockB.ignored === false);
    check('B4: 7 analyzed, score improved (57) but still penalized',
        aB.audit.secretsMeta.scanned === 7 && aB.audit.score === 57 &&
        aB.audit.score > aA.audit.score && aB.audit.issues === 16);

    // -- C: standalone patterns, dotfile, extensionless ------------------------
    const one = (f) => aB.audit.secrets.filter((h) => h.file === f);
    check('C1: bare sk- key + bare JWT detected',
        one('legacy.txt').length === 1 && one('legacy.txt')[0].label === 'Generic Secret Key (sk-)' &&
        one('app.js').length === 1 && one('app.js')[0].label === 'JWT Token');
    check('C2: bare high-entropy hex detected',
        one('notes.txt').length === 1 && one('notes.txt')[0].label === 'High-Entropy String');
    check('C3: dotfile + extensionless Dockerfile scanned',
        one('.myapprc').length === 1 && one('Dockerfile').length === 1 &&
        one('Dockerfile')[0].line === 1);

    // -- D: clean project ------------------------------------------------------
    const aD = await auditOn(CLEAN);
    check('D1: 0 secrets, 4 analyzed, nothing skipped, score 100',
        aD.audit.secrets.length === 0 && aD.audit.secretsMeta.scanned === 4 &&
        aD.audit.secretsSkipped === 0 && aD.audit.score === 100);

    // -- E: scan honesty -------------------------------------------------------
    const eP = barePanel().p;
    const eHits = await eP._scanSecrets(HONEST);
    const eMeta = eP._lastSecretsMeta;
    check('E1: large + binary skipped and counted, lockfile hash silent',
        eHits.length === 0 && eMeta.scanned === 2 &&
        eMeta.skipped.large === 1 && eMeta.skipped.binary === 1);
    check('E2: the lockfile hash WOULD hit (skip is what saves it)',
        ss.findHighEntropyToken(LOCKHASH) === LOCKHASH);
    const eP2 = barePanel().p;
    const eHits2 = await eP2._scanSecrets(path.join(FX, 'nope-missing'));
    check('E3: unreadable root errors instead of fake-clean',
        eHits2.length === 0 && eP2._lastSecretsMeta.error !== null &&
        eP2._lastSecretsMeta.scanned === 0);

    // -- F: missing advisory DB -----------------------------------------------
    forceNullDb = true;
    let aF;
    try { aF = await auditOn(CLEAN); } finally { forceNullDb = false; }
    check('F1: missing DB flags, exact text, null score (never a number)',
        aF.audit.localAudit.missingDb === true &&
        aF.audit.localAudit.missingText === E_MISSING &&
        aF.audit.scoreResult.status === 'unavailable' && aF.audit.score === null);

    // -- G: real panel render --------------------------------------------------
    const hA = renderHtml(aA.audit);
    check('G1: render cites file:line + severity + masked snippet',
        hA.indexOf('.env:1') !== -1 && hA.indexOf('CRITICAL') !== -1 &&
        hA.indexOf('NOT IGNORED') !== -1 && hA.indexOf('[REDACTED]') !== -1 &&
        hA.indexOf('file(s) analyzed') !== -1);
    check('G2: render leaks no secret value',
        SECRETS.every((v) => hA.indexOf(v) === -1));
    const hD = renderHtml(aD.audit);
    check('G3: clean render states the analyzed count',
        hD.indexOf('No secrets detected in 4 file(s).') !== -1);
    const hF = renderHtml(aF.audit);
    check('G4: missing-DB render shows the exact P18-e string',
        hF.indexOf(E_MISSING) !== -1);
    const hH = renderHtml((await auditOn(HONEST)).audit);
    check('G5: partial scan is labeled, never silent',
        hH.indexOf('Partial scan:') !== -1 && hH.indexOf('large: 1') !== -1);

    // -- H: masked exports + audit log -----------------------------------------
    const sPath = path.join(FX, 'sudo-secrets.json');
    dialogPath = sPath;
    await aB.p._exportSecrets();
    const sBack = fs.readFileSync(sPath, 'utf8');
    check('H1: secrets export masked + carries scan meta',
        SECRETS.every((v) => sBack.indexOf(v) === -1) &&
        sBack.indexOf('"scanned": 7') !== -1);
    const rPath = path.join(FX, 'sudo-report.json');
    dialogPath = rPath;
    await aB.p._exportReport('json');
    const rBack = fs.readFileSync(rPath, 'utf8');
    check('H2: report export masked', SECRETS.every((v) => rBack.indexOf(v) === -1));
    dialogPath = null;
    const acts = getAuditLog(500).filter((e) => e.action === 'SECURITY_AUDIT');
    check('H3: audit log lines carry counts, never values',
        acts.length >= 1 && SECRETS.every((v) =>
            acts.every((e) => JSON.stringify(e).indexOf(v) === -1)));

    // -- I: units --------------------------------------------------------------
    check('I1: gitignore matcher (exact, glob, dir, negation, depth)',
        ss.isIgnoredByGitignore('.env', '.env\n') === true &&
        ss.isIgnoredByGitignore('certs/x.pem', '*.pem\n') === true &&
        ss.isIgnoredByGitignore('build/o.js', 'build/\n') === true &&
        ss.isIgnoredByGitignore('keep.env', '.env*\n!keep.env\n') === false &&
        ss.isIgnoredByGitignore('sub/.env', '.env\n') === true &&
        ss.isIgnoredByGitignore('.env.production', '.env\n') === false);
    check('I2: secret names (compounds yes, lookalikes no)',
        ss.looksLikeSecretName('JWT_SECRET') && ss.looksLikeSecretName('apiKey') &&
        !ss.looksLikeSecretName('MONKEY') && !ss.looksLikeSecretName('DATABASE_URL'));
    check('I3: entropy helper (flat zero, hex found, prose silent)',
        ss.shannonEntropy('aaaaaaaa') === 0 &&
        ss.findHighEntropyToken('id=' + HEX64) === HEX64 &&
        ss.findHighEntropyToken('just a normal sentence here') === null &&
        ss.findHighEntropyToken('abcdefghijklmnopqrstuvwxyzabcdefghijklmn') === null);
    const nineZero = String.fromCharCode(57, 48);
    check('I4: this suite contains no hardcoded ninety',
        fs.readFileSync(__filename, 'utf8').indexOf(nineZero) === -1);
    assert.ok(pass > 0, 'suite ran');
}

main().then(() => {
    console.log(fail === 0 ? '\nP18: ' + pass + ' checks passed (all green)'
        : '\nP18: ' + pass + ' passed, ' + fail + ' FAILED');
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
