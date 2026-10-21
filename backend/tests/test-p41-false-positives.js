/**
 * SUDO STUDIO - PROMPT 41 suite: kill secret-scan false positives without
 * ever missing a true secret.
 * A: maquis-pos-like Next.js fixture (true .env.local + real.env findings,
 *    every documented FP silent, .next excluded, low-confidence masked).
 * B: legacy (--before) mode still reports the old noise (before/after).
 * C: score weighs confidence. D: panel render (badges, counter, toggle).
 * Hermetic (own TMP_HOME, fixture DB), vscode mocked. ASCII-only.
 * Run: node backend/tests/test-p41-false-positives.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-fx-'));
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

// -- fake secrets (realistic shape, never real) -------------------------------
const AUTHV = 'K9mQ2vX7pL4nR8tY1wE5uI3oP6aS0dFz';
const OIDCJWT = 'eyJhbGciOiJIUzI1NiJ9.eyJvaWQiOiJmYWtlLW9pZGMtMDAxIn0.ZmFrZS1zaWduYXR1cmUtb2lkYy0wMDE';
const REALSK = 'sk-fake-live-key-12345678';
const REALJWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXBzaDEyMyJ9.c2lnbmF0dXJlLWZha2UtNzg5';
const HEXB = 'c4d2e81f7a6b5930'.repeat(4);
const PGW = 'postgres://maquis:Kp9-xQ2z@db.internal:5432/maquisdb';
const PGR = 'postgres://app:Letmein2024@db.internal:5432/shopdb';
const LOWTOK = 'gH7kL2mN9pQ4rT6vX8zA1bD3eF5cG7hJ0kMn2Pq8Rs4T';
const NEXTTOK = 'aB3dE5fG7hJ9kL1mN4pQ6rS8tU0vW2xY4zA6bC8dE0f';
const MAPTOK = 'aB3dE5fG7hJ9kL1mN4pQ6rS8t';
const SECRETS = [AUTHV, OIDCJWT, 'Kp9-xQ2z', REALSK, REALJWT,
    HEXB, 'Letmein2024', LOWTOK, NEXTTOK, MAPTOK];

// -- fixture advisory DB (empty: no matches on fixtures) ---------------------
const today = new Date().toISOString().slice(0, 10);
const dbFresh = path.join(FX, 'db-fresh.json');
fs.writeFileSync(dbFresh, JSON.stringify({ generatedAt: today, advisories: [] }));
process.env.SUDO_ADVISORIES_PATH = dbFresh;

// -- vscode mock --------------------------------------------------------------
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
const ss = require('../../sudo-ai-extension/src/utils/securityScore');
const { SecurityPanel } = require('../../sudo-ai-extension/src/panels/SecurityPanel');

// -- fixture project (maquis-pos-like Next.js) --------------------------------
const P41 = path.join(FX, 'shop');
wf(P41, '.env.local', 'AUTH_SECRET=' + AUTHV + '\nVERCEL_OIDC_TOKEN=' + OIDCJWT +
    '\nDATABASE_URL=' + PGW + '\n');
wf(P41, '.gitignore', '.next\nnode_modules\n');
wf(P41, '.next/cache/fetch-1.json', '{"data":"' + NEXTTOK + '"}');
wf(P41, '.next/prerender-manifest.json', '{"version":4,"routes":{"/":"' + NEXTTOK.slice(0, 40) + '"}}');
wf(P41, 'app/page.js.map', '{"version":3,"sources":["page.js"],"mappings":"' + MAPTOK +
    '","file":"page.js"}\n//# sourceMappingURL=page.js.map\n');
wf(P41, 'app/chat.js', 'const WHATSAPP_TOKEN = getConfig("WHATSAPP_TOKEN");\n');
wf(P41, 'lib/env.js', 'const AUTH_TOKEN = process.env.AUTH_TOKEN;\n' +
    'const DEPLOY_KEY = Deno.env.get("DEPLOY_KEY");\n');
wf(P41, 'migrations/001.sql', 'CREATE TABLE t (id INT);\n' +
    "v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';\n");
wf(P41, 'package-lock.json', '{"name":"x","packages":{"":{"integrity":"sha512-' + NEXTTOK.slice(0, 40) + '"}}}');
wf(P41, 'data/ids.txt', 'run 550e8400-e29b-41d4-a716-446655440000 done\n');
wf(P41, 'styles.css', '.a{color:#a1b2c3;background:#11223344}\n');
wf(P41, 'config/placeholders.env', 'API_KEY=your-secret-here\nBACKUP_TOKEN=changeme\nADMIN_KEY=<insert-key-here>\n');
wf(P41, 'secrets/real.env', 'SERVICE_KEY=' + REALSK + '\nJWT_SECRET=' + REALJWT +
    '\nHEXKEY=' + HEXB + '\nDATABASE_URL=' + PGR + '\n');
wf(P41, 'notes/low.txt', 'build-id: ' + LOWTOK + '\n');

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
function renderHtml(audit, showHidden) {
    const html0 = SecurityPanel.prototype._buildHtml.call({});
    const blocks = [...html0.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
    const clientJs = blocks.find((b) => b.indexOf('function renderAudit') !== -1) || blocks[0];
    const store = {};
    const mkEl = () => ({ _h: '',
        set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
        textContent: '', disabled: true });
    global.document = { getElementById: (id) => (store[id] || (store[id] = mkEl())) };
    global.window = { addEventListener: () => {}, _showHidden: !!showHidden };
    global.acquireVsCodeApi = () => ({ postMessage: () => {} });
    let out = '';
    eval(clientJs + '\nrenderAudit(' + JSON.stringify(audit) +
        ');out = document.getElementById("content").innerHTML;');
    delete global.document; delete global.window; delete global.acquireVsCodeApi;
    return out;
}

async function main() {
    const { p, audit } = await auditOn(P41);
    const vis = audit.secrets;
    const hid = audit.secretsHidden || [];

    // -- A: true findings kept, every documented FP silent -------------------
    const envHits = vis.filter((h) => h.file === '.env.local');
    check('A1: .env.local triple found with file+line',
        envHits.length === 3 && envHits.map((h) => h.line).join(',') === '1,2,3' &&
        envHits.every((h) => h.confidence === 'high' && h.severity === 'critical' && h.ignored === false),
        JSON.stringify(envHits.map((h) => h.label + '/' + h.severity)));
    const realHits = vis.filter((h) => h.file === 'secrets/real.env');
    check('A2: sk-/JWT/hex64/postgres-URL all found',
        realHits.length === 4 && realHits.map((h) => h.line).join(',') === '1,2,3,4',
        JSON.stringify(realHits.map((h) => h.label + '/' + h.confidence)));
    const fpFiles = ['app/chat.js', 'lib/env.js', 'migrations/001.sql', 'app/page.js.map',
        'package-lock.json', 'data/ids.txt', 'styles.css', 'config/placeholders.env'];
    const fpHits = vis.filter((h) => fpFiles.indexOf(h.file) !== -1);
    check('A3: every documented FP file silent', fpHits.length === 0, JSON.stringify(fpHits));
    check('A4: .next excluded and counted, never scanned',
        audit.secretsMeta.scanned === 12 &&
        audit.secretsMeta.skipped.generatedDirs === 1 &&
        (audit.secretsMeta.generatedDirs || []).join(',') === '.next' &&
        vis.concat(hid).every((h) => h.file.indexOf('.next') !== 0),
        JSON.stringify(audit.secretsMeta));
    check('A5: low-confidence masked, never dropped',
        vis.length === 7 && hid.length === 1 &&
        hid[0].file === 'notes/low.txt' && hid[0].confidence === 'low' &&
        vis.every((h) => h.confidence !== 'low'),
        JSON.stringify(vis.map((h) => h.file + ':' + h.line)));
    const sPath = path.join(FX, 'p41-secrets.json');
    dialogPath = sPath;
    await p._exportSecrets();
    dialogPath = null;
    const sBack = fs.readFileSync(sPath, 'utf8');
    check('A6: masked findings exported (redacted)',
        sBack.indexOf(LOWTOK) === -1 && sBack.indexOf('"secretsHidden"') !== -1 &&
        sBack.indexOf('notes/low.txt') !== -1);
    check('A7: no raw value anywhere in the audit', (function () {
        const blob = JSON.stringify(audit);
        return SECRETS.every((v) => blob.indexOf(v) === -1);
    })());

    // -- B: legacy (--before) mode reports the old noise ---------------------
    const lp = barePanel().p;
    const legacy = await lp._scanSecrets(P41, { legacy: true });
    const legFiles = legacy.map((h) => h.file);
    check('B1: legacy sees the old noise (.next, env-read, alphabet, sourcemap)',
        legFiles.some((f) => f.indexOf('.next') === 0) &&
        legFiles.indexOf('app/chat.js') !== -1 &&
        legFiles.indexOf('lib/env.js') !== -1 &&
        legFiles.indexOf('migrations/001.sql') !== -1 &&
        legFiles.indexOf('app/page.js.map') !== -1,
        JSON.stringify(legFiles));
    check('B2: legacy finds strictly more; every unignored legacy hit critical',
        legacy.length > vis.length + hid.length &&
        legacy.filter((h) => !h.ignored).every((h) => h.severity === 'critical') &&
        legacy.some((h) => h.ignored === true),
        'legacy=' + legacy.length + ' new=' + (vis.length + hid.length));
    const sevNew = {};
    for (const h of vis) sevNew[h.severity] = (sevNew[h.severity] || 0) + 1;
    check('B3: new mix is 6 critical + 1 medium + 1 masked-low',
        sevNew.critical === 6 && sevNew.medium === 1 && hid.length === 1);

    // -- C: score weighs confidence -------------------------------------------
    const lowOnly = ss.computeSecurityScore({
        secrets: [{ label: 'High-Entropy String', severity: 'medium', confidence: 'low', file: 'x', line: 1 }],
        advisories: [], files: { noGitignore: false, unignoredProdEnv: [], unlocked: [] },
        hasTests: true, db: { date: today, source: 'test', stale: false },
    });
    check('C1: low-confidence counts half (2 pts, labeled)',
        lowOnly.score === 98 && lowOnly.penalties.length === 1 &&
        lowOnly.penalties[0].points === 2 && lowOnly.penalties[0].applied === true &&
        lowOnly.penalties[0].detail.indexOf('confiance low') !== -1,
        JSON.stringify(lowOnly.penalties));
    const noConf = ss.computeSecurityScore({
        secrets: [{ label: 'Secret Assignment', severity: 'high', file: 'x', line: 1 }],
        advisories: [], files: { noGitignore: false, unignoredProdEnv: [], unlocked: [] },
        hasTests: true, db: { date: today, source: 'test', stale: false },
    });
    check('C2: missing confidence = full weight (backward compatible)',
        noConf.score === 92 && noConf.penalties[0].points === 8);
    check('C3: fixture score weighs all (59, secrets 36 applied, issues 16)',
        audit.score === 59 && audit.scoreResult.appliedByCat.secrets === 36 && audit.issues === 16,
        'score=' + audit.score + ' applied=' + audit.scoreResult.appliedByCat.secrets + ' issues=' + audit.issues);

    // -- D: panel render -------------------------------------------------------
    const h = renderHtml(audit, false);
    check('D1: render shows confidence badges + CRITICAL + NOT IGNORED',
        h.indexOf('CONF:HIGH') !== -1 && h.indexOf('CONF:MEDIUM') !== -1 &&
        h.indexOf('CRITICAL') !== -1 && h.indexOf('NOT IGNORED') !== -1 &&
        h.indexOf('.env.local:1') !== -1);
    // P41: the masked file is still cited in the why-table (its 2 pts are
    // scored, so the score stays explainable) but gets no finding row.
    check('D2: render counts masked + generated, hides low by default',
        h.indexOf('1 finding(s) hidden (low confidence)') !== -1 &&
        h.indexOf('Show masked') !== -1 &&
        h.indexOf('1 generated folder(s) skipped: .next') !== -1 &&
        h.indexOf('notes/low.txt') !== -1 && h.indexOf('CONF:LOW') === -1);
    const hT = renderHtml(audit, true);
    check('D3: toggle reveals masked rows (redacted)',
        hT.indexOf('notes/low.txt') !== -1 && hT.indexOf('CONF:LOW') !== -1 &&
        hT.indexOf('Hide masked') !== -1 && SECRETS.every((v) => hT.indexOf(v) === -1));
    check('D4: default render leaks no value', SECRETS.every((v) => h.indexOf(v) === -1));

    assert.ok(pass > 0, 'suite ran');
}

main().then(() => {
    console.log(fail === 0 ? '\nP41: ' + pass + ' checks passed (all green)'
        : '\nP41: ' + pass + ' passed, ' + fail + ' FAILED');
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
