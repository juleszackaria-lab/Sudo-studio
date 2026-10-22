/**
 * SUDO STUDIO - PROMPT 45 suite: secret-scan precision.
 * A: maquis-pos-like Next.js fixture. Required true fakes (sk-...,
 *    JWT_SECRET=<jwt>, 64-hex, postgres URL with password) ALL found;
 *    every observed FP family silent (.next, .map, SQL alphabets incl. a
 *    doubled hex alphabet, bracket/template/self/camel references, env
 *    reads, placeholders, UUID, colors, integrity hashes); .env literals
 *    (flat, PascalCase, camelCase) still flag.
 * B: "Show generated folders" toggle (panel rescan + CLI flag).
 * C: severity counts new vs legacy on the fixture (--before/after).
 * D: headless CLI proof tool runs (after/before/show-generated --json).
 * Hermetic (own TMP_HOME, fixture DB), vscode mocked. ASCII-only.
 * Run: node backend/tests/test-p45-precision.js
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p45-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p45-fx-'));
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
const AUTHV = 'Q7wE9rT2yU5iO8pA3sD6fG1hJ4kL0zXcVb';
const OIDCJWT = 'eyJhbGciOiJIUzI1NiJ9.eyJvaWQiOiJmYWtlLXA0NS0wMDEifQ.ZmFrZS1zaWduYXR1cmUtcDQ1LTAwMQ';
const PGW = 'postgres://maquis:S3cr3t-xQ9@db.internal:5432/maquisdb';
const REALSK = 'sk-fake-p45-key-abcdef12';
const REALJWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXA0NTY3OCJ9.c2lnbmF0dXJlLXA0NS1mYWtl';
const HEXB = 'f3a9c1e74b52d680'.repeat(4);
const PGR = 'postgres://app:P45letmein@db.internal:5432/shopdb';
const LOWTOK = 'kM9nB4vC7xZ2aQ8wE5rT1yU6iO3pL0sDgFhJcKeNdSmQv';
const NEXTTOK = 'zA4bC6dE8fG0hJ2kL4mN6pQ8rS0tU2vW4xY6zA8bC0dE2';
const MAPTOK = 'mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3';
const HUNTER = 'hunter2099';
const PASCAL = 'SuperSecret1';
const CAMELLIT = 'mySecretValue123';
const SECRETS = [AUTHV, OIDCJWT, 'S3cr3t-xQ9', REALSK, REALJWT,
    HEXB, 'P45letmein', LOWTOK, NEXTTOK, MAPTOK, HUNTER, PASCAL, CAMELLIT];

// -- fixture advisory DB (empty: no matches on fixtures) ---------------------
const today = new Date().toISOString().slice(0, 10);
const dbFresh = path.join(FX, 'db-fresh.json');
fs.writeFileSync(dbFresh, JSON.stringify({ generatedAt: today, advisories: [] }));
process.env.SUDO_ADVISORIES_PATH = dbFresh;

// -- vscode mock --------------------------------------------------------------
const vscodeMock = { workspace: { workspaceFolders: [] }, window: {},
    ViewColumn: { One: 1 }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } };
vscodeMock.window.showInformationMessage = () => {};
vscodeMock.window.showErrorMessage = () => {};
vscodeMock.window.showWarningMessage = () => {};
vscodeMock.window.showSaveDialog = async () => null;
vscodeMock.window.showOpenDialog = async () => null;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeMock;
    return origLoad.call(this, req, parent, isMain);
};
const ss = require('../../sudo-ai-extension/src/utils/securityScore');
const { SecurityPanel } = require('../../sudo-ai-extension/src/panels/SecurityPanel');

// -- fixture project (maquis-pos-like Next.js) --------------------------------
const P45 = path.join(FX, 'shop');
wf(P45, '.env.local', 'AUTH_SECRET=' + AUTHV + '\nVERCEL_OIDC_TOKEN=' + OIDCJWT +
    '\nDATABASE_URL=' + PGW + '\n');
wf(P45, '.gitignore', '.next\nnode_modules\n');
wf(P45, '.next/cache/fetch-1.json', '{"data":"' + NEXTTOK + '"}');
wf(P45, '.next/prerender-manifest.json', '{"version":4,"routes":{"/":"' + NEXTTOK.slice(0, 40) + '"}}');
wf(P45, 'dist/bundle.js.map', '{"version":3,"sources":["b.js"],"mappings":"' + MAPTOK +
    '"}\n//# sourceMappingURL=bundle.js.map\n');
wf(P45, 'migrations/002.sql', 'CREATE TABLE t2 (id INT);\n' +
    "v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';\n" +
    "v_hex constant text := '0123456789ABCDEF0123456789ABCDEF';\n");
wf(P45, 'src/refs.js', [
    'const API_TOKEN = configuration["API_TOKEN"];',
    "const BACKUP_KEY = settings['BACKUP_KEY'];",
    'const DEPLOY_TOKEN = myArray[10];',
    'const SESSION_KEY = `${SESSION_KEY}`;',
    'const FALLBACK_KEY = `fallbackSecret42`;',
    'const API_KEY = "API_KEY";',
    'OTHER_KEY = OTHER_KEY',
    'const CLIENT_TOKEN = clientConfigValue;',
    'WEBHOOK_SECRET = webhookSecretRef;',
    'const WHATSAPP_TOKEN = envVars["WHATSAPP_TOKEN"];',
    '',
].join('\n'));
wf(P45, 'src/env.js', 'const AUTH_TOKEN = process.env.AUTH_TOKEN;\n' +
    'const DEPLOY_KEY = Deno.env.get("DEPLOY_KEY");\n');
wf(P45, 'config/placeholders.env', 'API_KEY=your-secret-here\nBACKUP_TOKEN=changeme\n' +
    'ADMIN_KEY=<insert-key-here>\nDEMO_KEY=example\nTKEY=xxx\n');
wf(P45, 'secrets/real.env', 'SERVICE_KEY=' + REALSK + '\nJWT_SECRET=' + REALJWT +
    '\nHEXKEY=' + HEXB + '\nDATABASE_URL=' + PGR + '\n');
wf(P45, 'secrets/plain.env', 'PASSWORD=' + HUNTER + '\nTOKEN=' + PASCAL +
    '\nBACKUP_KEY=' + CAMELLIT + '\n');
wf(P45, 'notes/low.txt', 'build-id: ' + LOWTOK + '\n');

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
function sevTable(list) {
    const t = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const h of list) t[h.severity] = (t[h.severity] || 0) + 1;
    return t;
}

async function main() {
    const { audit } = await auditOn(P45);
    const vis = audit.secrets;
    const hid = audit.secretsHidden || [];

    // -- A: true findings kept, every FP family silent -----------------------
    const envHits = vis.filter((h) => h.file === '.env.local');
    check('A1: .env.local triple found (high/critical, unignored)',
        envHits.length === 3 && envHits.map((h) => h.line).join(',') === '1,2,3' &&
        envHits.every((h) => h.confidence === 'high' && h.severity === 'critical' && h.ignored === false),
        JSON.stringify(envHits.map((h) => h.label + '/' + h.severity)));
    const realHits = vis.filter((h) => h.file === 'secrets/real.env');
    check('A2: required battery all found (sk-/JWT/hex64/postgres-URL)',
        realHits.length === 4 && realHits.map((h) => h.line).join(',') === '1,2,3,4' &&
        // Pre-existing P41 grading (P41-A2 pins the same 4 lines): the
        // bare HEXKEY name is not word-matched, so the 64-hex goes
        // through generic entropy (medium), never dropped, never masked.
        realHits[2].label === 'High-Entropy String' && realHits[2].confidence === 'medium',
        JSON.stringify(realHits.map((h) => h.label + '/' + h.confidence)));
    const plainHits = vis.filter((h) => h.file === 'secrets/plain.env');
    check('A3: .env literals still flag (flat, PascalCase, camelCase)',
        plainHits.length === 3 && plainHits.map((h) => h.line).join(',') === '1,2,3',
        JSON.stringify(plainHits.map((h) => h.label + '/' + h.severity)));
    const fpHits = vis.filter((h) => h.file === 'src/refs.js');
    check('A4: references silent, plain backtick literal flags (line 5)',
        fpHits.length === 1 && fpHits[0].line === 5,
        JSON.stringify(fpHits.map((h) => h.line + ':' + h.label)));
    const fpFiles = ['src/env.js', 'migrations/002.sql', 'dist/bundle.js.map',
        'config/placeholders.env', '.next/cache/fetch-1.json', '.next/prerender-manifest.json'];
    const otherFp = vis.concat(hid).filter((h) => fpFiles.indexOf(h.file) !== -1);
    check('A5: env/SQL/sourcemap/placeholder/.next files all silent',
        otherFp.length === 0, JSON.stringify(otherFp));
    check('A6: generated dirs excluded and counted (.next + dist)',
        (audit.secretsMeta.skipped.generatedDirs || 0) === 2 &&
        (audit.secretsMeta.generatedDirs || []).sort().join(',') === '.next,dist' &&
        vis.concat(hid).every((h) => h.file.indexOf('.next') !== 0 && h.file.indexOf('dist/') !== 0),
        JSON.stringify(audit.secretsMeta));
    check('A7: low-confidence masked, never dropped',
        hid.length === 1 && hid[0].file === 'notes/low.txt' && hid[0].confidence === 'low' &&
        vis.every((h) => h.confidence !== 'low'),
        JSON.stringify(vis.map((h) => h.file + ':' + h.line)));
    check('A8: no raw value anywhere in the audit', (function () {
        const blob = JSON.stringify(audit);
        return SECRETS.every((v) => blob.indexOf(v) === -1);
    })());

    // -- B: Show generated folders -------------------------------------------
    const lp = barePanel().p;
    const shown = await lp._scanSecrets(P45, { showGenerated: true });
    const genHits = shown.filter((h) => h.file.indexOf('.next') === 0);
    check('B1: toggle scans generated dirs, findings badged GENERATED',
        genHits.length >= 2 && genHits.every((h) => h.generated === true),
        JSON.stringify(genHits.map((h) => h.file + ':' + h.line)));
    check('B2: shown scan finds strictly more than the default scan',
        shown.length > vis.length, 'shown=' + shown.length + ' default=' + vis.length);
    const auditShown = Object.assign({}, audit, { showGenerated: true, secrets: shown });
    const hGen = renderHtml(auditShown, false);
    const hDef = renderHtml(audit, false);
    check('B3: render offers the toggle (unchecked) + GENERATED badge (checked)',
        hDef.indexOf('Show generated folders') !== -1 && hDef.indexOf('checked') === -1 &&
        hGen.indexOf('Show generated folders') !== -1 && hGen.indexOf('checked') !== -1 &&
        hGen.indexOf('GENERATED') !== -1 && SECRETS.every((v) => hGen.indexOf(v) === -1));

    // -- C: severity counts new vs legacy ------------------------------------
    const legacy = await barePanel().p._scanSecrets(P45, { legacy: true });
    const tNew = sevTable(vis);
    const tOld = sevTable(legacy);
    const tShown = sevTable(shown);
    console.log('SEV-NEW critical=' + tNew.critical + ' high=' + tNew.high +
        ' medium=' + tNew.medium + ' low=' + tNew.low + ' hidden=' + hid.length);
    console.log('SEV-SHOWN critical=' + tShown.critical + ' high=' + tShown.high +
        ' medium=' + tShown.medium + ' low=' + tShown.low + ' (toggle on, GENERATED badged)');
    console.log('SEV-OLD critical=' + tOld.critical + ' high=' + tOld.high +
        ' medium=' + tOld.medium + ' low=' + tOld.low);
    check('C1: new mix is 6 critical + 4 high + 1 medium + 1 masked-low',
        tNew.critical === 6 && tNew.high === 4 && tNew.medium === 1 && tNew.low === 0 && hid.length === 1,
        JSON.stringify(tNew));
    check('C2: legacy sees strictly more, all unignored critical',
        legacy.length > vis.length + hid.length &&
        legacy.filter((h) => !h.ignored).every((h) => h.severity === 'critical'),
        'legacy=' + legacy.length + ' new=' + (vis.length + hid.length));

    // -- D: headless CLI proof tool ------------------------------------------
    const cli = path.join(__dirname, '..', '..', 'scripts', 'security-scan.js');
    const runCli = (args) => JSON.parse(execFileSync(process.execPath, [cli, P45].concat(args),
        { encoding: 'utf8', timeout: 60000 }));
    const jAfter = runCli(['--json']);
    check('D1: CLI after matches the panel scan',
        jAfter.visible === vis.length && jAfter.hiddenLowConfidence === hid.length &&
        (jAfter.mode || '').indexOf('P45') !== -1, 'visible=' + jAfter.visible);
    const jBefore = runCli(['--before', '--json']);
    check('D2: CLI before matches the legacy scan',
        jBefore.visible === legacy.length, 'before=' + jBefore.visible);
    const jGen = runCli(['--show-generated', '--json']);
    check('D3: CLI --show-generated surfaces .next findings',
        jGen.showGenerated === true && jGen.visible === shown.length &&
        (jGen.findings || []).some((f) => f.file.indexOf('.next') === 0 && f.generated === true),
        'shown=' + jGen.visible);

    // -- E: unit battery (new shapes + alphabet boundary) --------------------
    const saPat = ss.EXTRA_SECRET_PATTERNS.find((p) => p.label === 'Secret Assignment');
    const saHit = (line) => { const m = line.match(saPat.re); return !!m && saPat.check(m); };
    check('E1: bracket/template/self/camel references silent, literals hit',
        saHit('const API_TOKEN = configuration["API_TOKEN"];') === false &&
        saHit("const BACKUP_KEY = settings['BACKUP_KEY'];") === false &&
        saHit('const DEPLOY_TOKEN = myArray[10];') === false &&
        saHit('const SESSION_KEY = `${SESSION_KEY}`;') === false &&
        saHit('const API_KEY = "API_KEY";') === false &&
        saHit('OTHER_KEY = OTHER_KEY') === false &&
        saHit('const CLIENT_TOKEN = clientConfigValue;') === false &&
        saHit('WEBHOOK_SECRET = webhookSecretRef;') === false &&
        saHit('const WHATSAPP_TOKEN = envVars["WHATSAPP_TOKEN"];') === false &&
        saHit('TOKEN=mySecretValue123') === true &&
        saHit('const X_KEY = "mySecretValue123"') === true &&
        saHit('const FALLBACK_KEY = `fallbackSecret42`;') === true &&
        saHit('PASSWORD=hunter2099') === true &&
        saHit('TOKEN=SuperSecret1') === true);
    check('E2: alphabet boundary (hex-double silent, true hex found)',
        ss.looksLikeAlphabet('0123456789ABCDEF0123456789ABCDEF') === true &&
        ss.looksLikeAlphabet(HEXB) === false &&
        ss.findHighEntropyToken("v_hex constant text := '0123456789ABCDEF0123456789ABCDEF';") === null &&
        ss.findHighEntropyToken('BACKUP_HEX=' + HEXB) === HEXB);

    assert.ok(pass > 0, 'suite ran');
}

main().then(() => {
    console.log(fail === 0 ? '\nP45: ' + pass + ' checks passed (all green)'
        : '\nP45: ' + pass + ' passed, ' + fail + ' FAILED');
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
