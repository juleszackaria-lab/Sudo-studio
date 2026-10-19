/**
 * SUDO STUDIO - P36(c) functional test: Security audit (on INSTALLED files).
 *
 * Drives the INSTALLED SecurityPanel (EXT_DIR/src/panels/SecurityPanel.js)
 * with a stubbed `vscode` host and fixture projects in tmp (test-only files,
 * fake secrets, deleted afterwards). "Base absente / corrompue" runs use a
 * COPY of the extension (P25: tests never mutate the real files).
 *
 * Asserts:
 *  A. real install, fixture with 4 secret types + lodash pinned vuln, no .gitignore:
 *     1. all 4 secret types detected (sk-..., JWT_SECRET, 64-hex, postgres URL)
 *     2. report holds NO raw secret (redaction), score present (0-100)
 *     3. .gitignore entries recommended when secrets not ignored
 *     4. vulnerable lodash flagged (CVE-2020-8203), npm audit never crashes
 *  B. copy without advisory DB: 'non evaluees', unreliable, NO crash
 *  C. copy with corrupted DB everywhere: same graceful outcome (P36 inference:
 *     the prompt text cuts off at 'base corrompue ='; corrupted is treated
 *     exactly like absent - skipped candidates, explicit unreliable marker)
 *  C2. corrupted env-override + healthy embedded DB: falls back to embedded
 *
 * Usage: node test-security.js [--ext <dir>]
 * Exit: 0 = all PASS, 1 = any FAIL. Prints one JSON report on stdout.
 * ASCII-only. No fixture content is printed (only counts and labels).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const EXT_DIR = argVal('--ext', process.env.P36_EXT_DIR ||
    path.join(__dirname, '..', '..', 'sudo-ai-extension'));

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail: detail || '' });
}

// -- stub vscode host (workspaceFolders switchable per run) -------------------
const vscodeStub = {
    window: {},
    workspace: { workspaceFolders: [] },
    ViewColumn: { One: 1 },
    Uri: { file: (p) => ({ fsPath: p }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, isMain);
};

function fakePanel() {
    const posted = [];
    return { posted,
        panel: {
            webview: {
                html: '',
                postMessage: (m) => posted.push(m),
                onDidReceiveMessage: () => {},
                asWebviewUri: (u) => u,
            },
            onDidDispose: () => {},
            reveal: () => {},
        } };
}

// Fake secrets (test-only, never real credentials; also used to prove redaction).
const FAKE = {
    sk: 'sk-FAKE1234567890abcdefghij1234567890abcdefghij',
    jwt: 'my0JWTFakeSecretValue0123456789abcdef',
    hex: '9f2c7b4e1a5d6f8c3b7e0a1d4f6c8b2e5a7d9c0e1f3a5b7d8c9e0f1a2b',
    pgpass: 'F4keDbPass99',
};
function writeFixtures(dir, withPackageJson) {
    fs.writeFileSync(path.join(dir, 'a.env'), 'OPENAI_KEY=' + FAKE.sk + '\n');
    fs.writeFileSync(path.join(dir, 'b.env'), 'JWT_SECRET=' + FAKE.jwt + '\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'token = "' + FAKE.hex + '"\n');
    fs.writeFileSync(path.join(dir, 'd.env'),
        'DATABASE_URL=postgres://admin:' + FAKE.pgpass + '@db.local:5432/app\n');
    if (withPackageJson) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            name: 'p36-fixture', version: '1.0.0',
            dependencies: { lodash: '4.17.20' },
        }, null, 2));
        // Local audit reads PINNED versions (lockfiles), never bare package.json.
        fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
            name: 'p36-fixture', lockfileVersion: 3, requires: true,
            packages: { '': { dependencies: { lodash: '4.17.20' } },
                'node_modules/lodash': { version: '4.17.20' } },
        }, null, 2));
    }
}

async function runAuditOn(SecPanel, extDir, projectDir, homeDir) {
    const keepHome = process.env.SUDO_STUDIO_HOME;
    process.env.SUDO_STUDIO_HOME = homeDir;
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: projectDir } }];
    const fp = fakePanel();
    const inst = new SecPanel(fp.panel, { fsPath: extDir });
    await inst._runAudit();
    const audit = inst.results;
    if (keepHome === undefined) delete process.env.SUDO_STUDIO_HOME;
    else process.env.SUDO_STUDIO_HOME = keepHome;
    return { audit, posted: fp.posted };
}

(async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p36-sec-'));
    let SecReal;
    try {
        SecReal = require(path.join(EXT_DIR, 'src', 'panels', 'SecurityPanel.js')).SecurityPanel;
        check('security-module-loads', true, 'from installed files');
    } catch (e) {
        check('security-module-loads', false, String((e && e.message) || e).slice(0, 200));
        console.log(JSON.stringify({ suite: 'p36-security', extDir: EXT_DIR, checks }, null, 2));
        process.exit(1);
    }

    // -- run A: real install, full fixture ------------------------------------
    const projA = path.join(TMP, 'projA');
    fs.mkdirSync(projA);
    writeFixtures(projA, true);
    let a;
    try {
        a = await runAuditOn(SecReal, EXT_DIR, projA, path.join(TMP, 'homeA'));
        check('auditA-no-crash', !!a.audit, 'full _runAudit completed');
    } catch (e) {
        check('auditA-no-crash', false, String((e && e.message) || e).slice(0, 200));
        a = { audit: null, posted: [] };
    }
    if (a.audit) {
        const found = {};
        for (const s of a.audit.secrets || []) found[s.file] = s.label;
        const four = ['a.env', 'b.env', 'c.txt', 'd.env'].every((f) => found[f]);
        check('auditA-4-secret-types', four,
            'a.env=' + (found['a.env'] || 'MISS') + ' b.env=' + (found['b.env'] || 'MISS') +
            ' c.txt=' + (found['c.txt'] || 'MISS') + ' d.env=' + (found['d.env'] || 'MISS'));
        const blob = JSON.stringify(a.audit);
        const leaked = [FAKE.sk, FAKE.jwt, FAKE.hex, FAKE.pgpass].filter((s) => blob.indexOf(s) !== -1);
        check('auditA-redaction', leaked.length === 0,
            leaked.length ? 'LEAKED: ' + leaked.length + ' raw secret(s)' : 'no raw secret in report');
        const gi = a.audit.gitignore || {};
        check('auditA-gitignore-recommended',
            (gi.missing || []).indexOf('.env') !== -1 && (gi.missing || []).length === 8,
            'missing=' + (gi.missing || []).length + ' (want 8, incl .env)');
        const la = a.audit.localAudit || {};
        const lodash = (la.matches || []).filter((m) => m.package === 'lodash');
        check('auditA-vuln-flagged', !la.error && lodash.length > 0 &&
            lodash.some((m) => (m.cve || '').indexOf('2020-8203') !== -1),
            la.error ? ('localAudit error: ' + la.error) :
                ('matches=' + (la.matches || []).length + ' lodash=' + lodash.length +
                 ' src=' + (la.dbSource || '?') + ' entries=' + (la.dbEntries || 0)));
        check('auditA-score', typeof a.audit.score === 'number' && a.audit.score >= 0 &&
            a.audit.score <= 100 && !!a.audit.scoreResult,
            'score=' + a.audit.score);
        const npm = a.audit.npmAudit;
        const npmOk = npm === null ||
            (typeof npm.total === 'number') || npm.unreliable === true;
        check('auditA-npm-never-crashes', npmOk,
            npm === null ? 'n/a' : (npm.unreliable ? ('unreliable: ' + npm.error) : ('total=' + npm.total)));
        check('auditA-result-posted', a.posted.some((m) => m && m.type === 'auditResult'),
            a.posted.map((m) => m && m.type).join(','));
    }

    // -- extension COPY for the missing/corrupted DB runs (P25) ----------------
    const copyDir = path.join(TMP, 'extcopy');
    fs.mkdirSync(copyDir, { recursive: true });
    fs.cpSync(path.join(EXT_DIR, 'src'), path.join(copyDir, 'src'), { recursive: true });
    try { fs.symlinkSync(path.join(EXT_DIR, 'node_modules'), path.join(copyDir, 'node_modules'), 'junction'); }
    catch (_) { /* fall through; require will fail loudly if axios is needed */ }
    let SecCopy;
    try {
        SecCopy = require(path.join(copyDir, 'src', 'panels', 'SecurityPanel.js')).SecurityPanel;
        check('copy-module-loads', true, 'copy without node_modules (+symlink fallback)');
    } catch (e) {
        check('copy-module-loads', false, String((e && e.message) || e).slice(0, 200));
        SecCopy = null;
    }

    if (SecCopy) {
        const projB = path.join(TMP, 'projB');
        fs.mkdirSync(projB);
        writeFixtures(projB, false);
        const dbPath = path.join(copyDir, 'src', 'data', 'advisories.json');

        // run B: DB absent everywhere
        try { fs.rmSync(dbPath); } catch (_) {}
        const homeB = path.join(TMP, 'homeB');
        fs.mkdirSync(path.join(homeB, '.sudo_studio'), { recursive: true });
        delete process.env.SUDO_ADVISORIES_PATH;
        let b;
        try {
            b = await runAuditOn(SecCopy, copyDir, projB, homeB);
            const la = (b.audit && b.audit.localAudit) || {};
            check('auditB-absent-not-evaluated', la.missingDb === true &&
                (la.missingText || '').indexOf('Vuln') === 0 && la.unreliable === true,
                JSON.stringify({ missingDb: la.missingDb, unreliable: la.unreliable }).slice(0, 160));
            check('auditB-no-crash', !!b.audit, 'completed without DB');
        } catch (e) {
            check('auditB-absent-not-evaluated', false, 'THREW: ' + String((e && e.message) || e).slice(0, 160));
            check('auditB-no-crash', false, 'threw');
        }

        // run C: DB corrupted everywhere (env-override + user + embedded)
        const homeC = path.join(TMP, 'homeC', '.sudo_studio');
        fs.mkdirSync(homeC, { recursive: true });
        fs.writeFileSync(path.join(homeC, 'advisories.json'), '{corrupted json');
        fs.writeFileSync(dbPath, '[also corrupted');
        const envCorrupt = path.join(TMP, 'env-corrupt.json');
        fs.writeFileSync(envCorrupt, 'nope, not json');
        process.env.SUDO_ADVISORIES_PATH = envCorrupt;
        try {
            const c = await runAuditOn(SecCopy, copyDir, projB, path.join(TMP, 'homeC'));
            const la = (c.audit && c.audit.localAudit) || {};
            check('auditC-corrupt-not-evaluated', la.missingDb === true && la.unreliable === true,
                'same graceful outcome as absent (documented inference)');
            check('auditC-no-crash', !!c.audit, 'completed with corrupted DB');
        } catch (e) {
            check('auditC-corrupt-not-evaluated', false, 'THREW: ' + String((e && e.message) || e).slice(0, 160));
            check('auditC-no-crash', false, 'threw');
        }
        delete process.env.SUDO_ADVISORIES_PATH;
    }

    // run C2: corrupted env-override + healthy embedded => fallback (real ext)
    const envBad = path.join(TMP, 'env-bad.json');
    fs.writeFileSync(envBad, '{bad json');
    process.env.SUDO_ADVISORIES_PATH = envBad;
    try {
        const projC2 = path.join(TMP, 'projC2');
        fs.mkdirSync(projC2);
        writeFixtures(projC2, true);
        const c2 = await runAuditOn(SecReal, EXT_DIR, projC2, path.join(TMP, 'homeC2'));
        const la = (c2.audit && c2.audit.localAudit) || {};
        check('auditC2-fallback-embedded', !la.error && la.dbSource === 'embedded' &&
            (la.matches || []).some((m) => m.package === 'lodash'),
            la.error ? ('error: ' + la.error) : ('src=' + la.dbSource + ' matches=' + (la.matches || []).length));
    } catch (e) {
        check('auditC2-fallback-embedded', false, 'THREW: ' + String((e && e.message) || e).slice(0, 160));
    }
    delete process.env.SUDO_ADVISORIES_PATH;

    // cleanup fixtures (fake secrets never linger)
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

    console.log(JSON.stringify({ suite: 'p36-security', extDir: EXT_DIR, checks }, null, 2));
    process.exit(checks.some((c) => c.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => {
    check('harness-no-crash', false, String((e && e.message) || e).slice(0, 200));
    console.log(JSON.stringify({ suite: 'p36-security', extDir: EXT_DIR, checks }, null, 2));
    process.exit(1);
});
