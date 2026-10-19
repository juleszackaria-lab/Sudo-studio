/**
 * SUDO STUDIO - P36(a)(e)(f): matrix runner on the INSTALLED package.
 *
 * Evaluates every matrix.json line it can (source p36/smoke/manifest),
 * leaves external lines to their own gates (unit/panel-job/e2e-job),
 * leaves paper lines SKIP (doc). Writes matrix-result.json and exits 1
 * when any evaluated line is FAIL, so packaging FAILS (P36(e)).
 *
 * CI usage (03 TestFiles, after smoke, backend/runtime NOT running):
 *   node run-matrix.js --install <dir> --smoke-log <summary.txt> --out matrix-result.json
 * Sandbox usage (no install, no spawn, backend down):
 *   node run-matrix.js --ext <sudo-ai-extension dir> --no-spawn --out /tmp/m.json
 * ASCII-only.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const INSTALL = argVal('--install', null);
const EXT_DIR = argVal('--ext', INSTALL ? path.join(INSTALL, 'extensions', 'sudo-ai') : null);
const SMOKE_LOG = argVal('--smoke-log', null);
const OUT = argVal('--out', path.join(process.cwd(), 'matrix-result.json'));
const NO_SPAWN = process.argv.indexOf('--no-spawn') !== -1;

const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'matrix.json'), 'utf8'));
const deBOM = (t) => String(t).replace(/^\uFEFF/, ''); // PS5.1 UTF8 files carry BOM

// line -> { suite, checks[] } for source=p36 (suites: security/doctor/autofix/license)
const P36MAP = {
    'P36-AUDIT-4TYPES': ['security', ['auditA-4-secret-types']],
    'P36-AUDIT-REDACT': ['security', ['auditA-redaction']],
    'P36-AUDIT-GITIGNORE': ['security', ['auditA-gitignore-recommended']],
    'P36-AUDIT-VULN': ['security', ['auditA-vuln-flagged']],
    'P36-AUDIT-SCORE': ['security', ['auditA-score']],
    'P36-AUDIT-NODB': ['security', ['auditB-absent-not-evaluated', 'auditC-corrupt-not-evaluated', 'auditC2-fallback-embedded']],
    'P25-COPYTEST': ['security', ['auditB-absent-not-evaluated']],
    'P36-DOCTOR-TOOLS': ['doctor', ['tool-Node.js', 'tool-npm', 'tool-Python', 'tool-pip', 'tool-Git', 'tool-Docker']],
    'P36-DOCTOR-BACKEND': ['doctor', ['backend-consistent']],
    'P36-AUTOFIX-DRY': ['autofix', ['dryrun-zero-exec', 'dryrun-rows-marked', 'dryrun-audited', 'dryrun-journaled', 'dryrun-plans-command']],
    'P36-AUTOFIX-JOURNAL': ['autofix', ['journal-step-cmd-code-out', 'journal-verify-cmd-output', 'audit-step-verify', 'never-opens-browser']],
    'P36-LICENSE-REFUSE': ['license', ['expired-refused', 'tampered-refused', 'invented-refused', 'garbage-refused']],
    'P36-LICENSE-EDITIONS': ['license', ['team-enterprise-applied']],
};
// line -> smoke check names for source=smoke
const SMOKEMAP = {
    'P35-PERUSER': ['extension-live-copy', 'logs-single-dir'],
    'P35-BRAND': ['brand-product.json', 'brand-titlebar-svg', 'brand-oldlogo-zero', 'brand-extension-single', 'brand-exe-icon'],
    'P35-ENTRY': ['backend-build-line', 'backend-health'],
    'P29-INSTALLER': ['installer-present', 'silent-install', 'expected-files', 'clean-uninstall'],
    'P29C4-MANIFEST': ['build-manifest'],
    'P30-CRASHLOG': ['logs-single-dir'],
    'P31-AGENT-SPAWN': ['agent-handshake'],
    'P31-EDITOR': ['editor-close-cleanup'],
    'P33-LOGDIR': ['logs-single-dir', 'runtime-p21-journal'],
    'P20-BRAND': ['brand-product.json', 'brand-titlebar-svg', 'brand-oldlogo-zero', 'brand-extension-single', 'brand-exe-icon'],
    'P21-JOURNAL': ['runtime-p21-journal'],
    'P27-NODEDEV': ['agent-handshake'],
};

function httpUp(url, timeoutMs) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode !== null && res.statusCode < 500);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}
async function waitFor(url, tries, gapMs) {
    for (let i = 0; i < tries; i++) {
        if (await httpUp(url, 2500)) return true;
        await new Promise((r) => setTimeout(r, gapMs));
    }
    return false;
}

function runSuite(suite, extraArgs) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-' + suite + '.js'),
        '--ext', EXT_DIR].concat(extraArgs || []),
        { encoding: 'utf8', timeout: 180000, env: process.env });
    const out = (r.stdout || '') + (r.error ? ('\nERR:' + r.error.message) : '');
    try {
        return { json: JSON.parse(out.slice(out.indexOf('{'))), code: r.status };
    } catch (_) {
        return { json: null, code: r.status, raw: out.slice(-500) };
    }
}

function checkManifest() {
    const fails = [];
    const notes = [];
    const mfPath = path.join(INSTALL, 'build-manifest.json');
    if (!fs.existsSync(mfPath)) return { ok: false, detail: 'build-manifest.json missing' };
    let mf;
    try { mf = JSON.parse(deBOM(fs.readFileSync(mfPath, 'utf8'))); }
    catch (e) { return { ok: false, detail: 'manifest unparseable' }; }
    if (!mf.version || !mf.date || !mf.sudo_studio_commit) fails.push('missing version/date/sudo_studio_commit');
    const files = (mf.files && typeof mf.files === 'object') ? mf.files : {};
    const keys = Object.keys(files);
    if (!keys.length) fails.push('files block empty');
    let hashed = 0;
    for (const k of keys) {
        const p = path.join(INSTALL, k);
        if (!fs.existsSync(p)) { fails.push('missing file: ' + k); continue; }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toLowerCase();
        if (actual !== String(files[k]).toLowerCase()) fails.push('sha256 mismatch: ' + k);
        else hashed++;
    }
    notes.push(hashed + '/' + keys.length + ' hashes ok');
    const comps = mf.components || {};
    for (const k of ['backend', 'runtime', 'extension', 'agent']) {
        if (!comps[k] || comps[k].commit !== mf.sudo_studio_commit) fails.push('component commit mismatch: ' + k);
    }
    if (!mf.brand || mf.brand.logoSvgMatch !== true || mf.brand.exeIcon !== 'PASS' || !mf.brand.robotIcon) {
        fails.push('brand block invalid (P20)');
    }
    if (!comps.extension || comps.extension.container !== 'sudo-studio') fails.push('container invalid');
    if (!comps.editor || comps.editor.product !== 'Sudo Studio') fails.push('editor product invalid');
    return { ok: fails.length === 0, detail: (fails.length ? fails.join(' | ') : notes.join(', ')) +
        ' commit=' + (mf.sudo_studio_commit || '?') };
}

function runVerifyPs1() {
    const ps1 = path.join(INSTALL, 'verify-installed.ps1');
    if (!fs.existsSync(ps1)) {
        return { ok: false, detail: 'verify-installed.ps1 NOT shipped (packager patch missing?)' };
    }
    const outFile = path.join(fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'p36-vrf-')), 'verify-result.json');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-InstallDir', INSTALL, '-OutFile', outFile],
        { encoding: 'utf8', timeout: 120000 });
    if (!fs.existsSync(outFile)) {
        return { ok: false, detail: 'ps1 produced no result (exit=' + r.status + ')' };
    }
    try {
        const j = JSON.parse(deBOM(fs.readFileSync(outFile, 'utf8')));
        return { ok: j.verdict === 'PASS', detail: 'verdict=' + j.verdict +
            ' files=' + (j.files || []).filter((f) => f.ok).length + '/' + (j.files || []).length };
    } catch (_) {
        return { ok: false, detail: 'verify-result.json unparseable' };
    }
}

function parseSmokeLog(p) {
    const verdicts = {};
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
        const m = line.match(/\[(?:SMOKE-)?(PASS|FAIL|SKIP)\]\s+(\S+)/);
        if (m) verdicts[m[2]] = m[1];
    }
    return verdicts;
}

(async () => {
    const result = { date: new Date().toISOString(), install: INSTALL || null,
        extDir: EXT_DIR || null, lines: [], summary: {}, gate: 'FAIL' };
    const kids = [];
    let backendUp = false;
    let runtimeUp = false;
    try {
        if (!EXT_DIR || !fs.existsSync(path.join(EXT_DIR, 'package.json'))) {
            throw new Error('extension dir not found: ' + EXT_DIR);
        }
        // 1. spawn backend+runtime (CI only)
        let spawnNote = 'spawn skipped (--no-spawn)';
        if (!NO_SPAWN) {
            if (!INSTALL) throw new Error('--install required without --no-spawn');
            const be = path.join(INSTALL, 'backend.exe');
            const rt = path.join(INSTALL, 'runtime.exe');
            if (!fs.existsSync(be) || !fs.existsSync(rt)) throw new Error('backend.exe/runtime.exe missing');
            kids.push(spawn(be, [], { cwd: INSTALL, detached: true, stdio: 'ignore', windowsHide: true }));
            kids.push(spawn(rt, [], { cwd: INSTALL, detached: true, stdio: 'ignore', windowsHide: true }));
            backendUp = await waitFor('http://127.0.0.1:5000/api/system/health', 20, 2000);
            runtimeUp = await waitFor('http://127.0.0.1:6000/health', 20, 2000);
            spawnNote = 'backend=' + (backendUp ? 'up' : 'DOWN') + ' runtime=' + (runtimeUp ? 'up' : 'down');
        }
        result.spawn = spawnNote;

        // 2. p36 suites
        const suites = {};
        for (const s of ['security', 'doctor', 'autofix', 'license']) {
            suites[s] = runSuite(s, (s === 'doctor' && !NO_SPAWN) ? ['--require-backend'] : []);
        }
        const checkVerdict = (suite, name) => {
            const j = suites[suite] && suites[suite].json;
            if (!j || !Array.isArray(j.checks)) return 'SUITE-FAILED';
            const c = j.checks.filter((x) => x.name === name)[0];
            return c ? c.verdict : 'CHECK-MISSING';
        };

        // 3. manifest + verify-ps1 (need --install; ps1 needs Windows powershell)
        let manifestRes = null;
        let ps1Res = null;
        if (INSTALL) {
            manifestRes = checkManifest();
            ps1Res = (process.platform === 'win32') ? runVerifyPs1()
                : { ok: null, detail: 'SKIP (needs Windows powershell)' };
        }

        // 4. smoke log
        let smokeV = null;
        if (SMOKE_LOG && fs.existsSync(SMOKE_LOG)) smokeV = parseSmokeLog(SMOKE_LOG);

        // 5. verdicts
        for (const line of MATRIX.lines) {
            const r = { id: line.id, prompt: line.prompt, source: line.source,
                verdict: line.verdict, preuve: line.preuve || '' };
            if (line.source === 'p36') {
                const [suite, names] = P36MAP[line.id] || [];
                if (!suite) { r.verdict = 'FAIL'; r.preuve = 'runner has no mapping (BUG)'; }
                else {
                    const vs = names.map((n) => checkVerdict(suite, n));
                    const fails = names.filter((n, i) => vs[i] !== 'PASS');
                    r.verdict = fails.length ? 'FAIL' : 'PASS';
                    r.preuve = suite + ': ' + (fails.length ? ('FAIL ' + fails.join(',')) : (names.length + '/' + names.length + ' PASS'));
                    if (line.id === 'P36-DOCTOR-BACKEND') r.preuve += ' [' + (NO_SPAWN ? 'informational (no spawn)' : 'required, ' + spawnNote) + ']';
                    if (line.id === 'P25-COPYTEST') r.preuve += ' (shared with P36-AUDIT-NODB by design)';
                }
            } else if (line.source === 'manifest') {
                if (!INSTALL) { r.verdict = 'SKIP'; r.preuve = 'no --install'; }
                else if (line.id === 'P36-MANIFEST') {
                    r.verdict = manifestRes.ok ? 'PASS' : 'FAIL'; r.preuve = manifestRes.detail;
                } else if (line.id === 'P36-VERIFY-PS1') {
                    r.verdict = ps1Res.ok === null ? 'SKIP' : (ps1Res.ok ? 'PASS' : 'FAIL');
                    r.preuve = ps1Res.detail;
                }
            } else if (line.source === 'smoke') {
                if (!smokeV) { r.verdict = 'SKIP'; r.preuve = 'no smoke log provided'; }
                else {
                    const names = SMOKEMAP[line.id] || [];
                    const missing = names.filter((n) => !(n in smokeV));
                    const fails = names.filter((n) => smokeV[n] === 'FAIL');
                    const skips = names.filter((n) => smokeV[n] === 'SKIP');
                    if (fails.length || missing.length) {
                        r.verdict = 'FAIL';
                        r.preuve = 'smoke: ' + (fails.length ? ('FAIL ' + fails.join(',')) : '') +
                            (missing.length ? (' MISSING ' + missing.join(',')) : '');
                    } else if (skips.length) {
                        r.verdict = 'SKIP'; r.preuve = 'smoke SKIPped by flags: ' + skips.join(',');
                    } else { r.verdict = 'PASS'; r.preuve = 'smoke: ' + names.length + '/' + names.length + ' PASS'; }
                }
            } else if (line.source === 'panel-job') {
                r.preuve = 'reported by best-effort 03 panel job (informational, user decision 19/10)';
            } else {
                r.preuve = line.source === 'doc' ? ('SKIP: ' + (line.raison || 'paper prompt'))
                    : line.source === 'unit' ? 'enforced by pre-existing 03 gate (01+02 green, pins==main)'
                    : 'enforced by its own 03 job/step (must be green for release)';
            }
            result.lines.push(r);
        }
    } catch (e) {
        result.harnessError = String((e && e.message) || e).slice(0, 300);
        for (const line of MATRIX.lines) {
            if (!result.lines.some((x) => x.id === line.id)) {
                result.lines.push({ id: line.id, prompt: line.prompt, source: line.source,
                    verdict: (line.source === 'p36' || line.source === 'manifest') ? 'FAIL' : line.verdict,
                    preuve: 'harness: ' + result.harnessError });
            }
        }
    } finally {
        for (const k of kids) { try { process.kill(-k.pid); } catch (_) { try { k.kill(); } catch (_) {} } }
    }

    const sum = { PASS: 0, FAIL: 0, SKIP: 0, gated: 0, external: 0 };
    for (const l of result.lines) sum[l.verdict] = (sum[l.verdict] || 0) + 1;
    result.summary = sum;
    result.gate = sum.FAIL ? 'FAIL' : 'PASS';
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('matrix: ' + result.lines.length + ' lines PASS=' + sum.PASS + ' FAIL=' + sum.FAIL +
        ' SKIP=' + sum.SKIP + ' gated=' + sum.gated + ' external=' + sum.external + ' gate=' + result.gate);
    for (const l of result.lines) {
        if (l.verdict === 'FAIL') console.log('FAIL ' + l.id + ' :: ' + l.preuve);
    }
    const nonWin = result.lines.filter((l) => l.source === 'doc' || l.source === 'unit')
        .map((l) => l.id + ' [' + l.source + ']');
    console.log('non-verifiable-on-Windows-installed-package (' + nonWin.length + '): ' + nonWin.join(', '));
    process.exit(sum.FAIL ? 1 : 0);
})().catch((e) => {
    console.error('run-matrix fatal: ' + ((e && e.message) || e));
    process.exit(1);
});
