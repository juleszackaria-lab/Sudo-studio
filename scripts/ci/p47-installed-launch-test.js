/**
 * P47-6: real automatic test on the INSTALLED editor (Windows).
 *
 * Launches the installed editor with a temporary --user-data-dir for
 * ~30 s, then scans its logs. FAILS when the Sudo Studio extension
 * reports a view/container registration error (the proven root cause:
 * "property icon is mandatory and must be of type string" /
 * "View container ... does not exist and all views ...").
 *
 * Usage:
 *   node scripts/ci/p47-installed-launch-test.js --editor "C:\...\SudoStudio.exe"
 *     --install-dir "C:\..." [--extensions-dir ...] [--timeout-s 30] [--out-dir ...]
 *   node scripts/ci/p47-installed-launch-test.js --self-test   (scanner only, any OS)
 *
 * Exit: 0 PASS | 1 FAIL (registration error) | 2 INCONCLUSIVE/usage.
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    if (i + 1 >= process.argv.length || process.argv[i + 1].startsWith('--')) return true;
    return process.argv[i + 1];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Proven registration-error signatures (owner evidence, installed editor).
const FAIL_PATTERNS = [
    'property icon is mandatory',
    'does not exist and all views',
    'Unknown viewsContainer',
    'Unknown view:',
];
const POSITIVE_RE = /Sudo Studio (build|Enterprise fully activated)/;

function listLogs(root) {
    const out = [];
    const walk = (d) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        ents.forEach((e) => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.log$/i.test(e.name)) out.push(p);
        });
    };
    walk(root);
    return out;
}

function scanLogs(logsRoot) {
    const files = listLogs(logsRoot);
    const hits = [];
    let positive = false;
    files.forEach((f) => {
        let txt = '';
        try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
        if (POSITIVE_RE.test(txt)) positive = true;
        txt.split('\n').forEach((ln, i) => {
            FAIL_PATTERNS.forEach((pat) => {
                if (ln.indexOf(pat) !== -1) {
                    hits.push({ file: path.basename(f), line: i + 1, pat, text: ln.slice(0, 200) });
                }
            });
        });
    });
    return { files: files.length, hits, positive };
}

function selfTest() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p47scan-'));
    const good = path.join(tmp, 'w1');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'exthost.log'),
        '[info] Sudo Studio build 4.6 commit abc date 2026-10-22\n[info] Sudo Studio Enterprise fully activated!\n');
    const r1 = scanLogs(tmp);
    const ok1 = r1.files === 1 && r1.hits.length === 0 && r1.positive === true;
    console.log((ok1 ? 'PASS' : 'FAIL') + ' self-test/healthy-logs files=' + r1.files + ' positive=' + r1.positive);
    fs.writeFileSync(path.join(good, 'renderer.log'),
        "[error] property icon is mandatory and must be of type string\n[error] View container 'sudo-studio' does not exist and all views registered to it will be added to Explorer\n");
    const r2 = scanLogs(tmp);
    const ok2 = r2.hits.length === 2 && r2.positive === true;
    console.log((ok2 ? 'PASS' : 'FAIL') + ' self-test/sick-logs hits=' + r2.hits.length);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!ok1 || !ok2) { console.log('SELF-TEST FAILED'); process.exitCode = 1; return; }
    console.log('SELF-TEST PASSED');
}

async function main() {
    if (arg('self-test', false)) { selfTest(); return; }
    const editor = arg('editor');
    const installDir = arg('install-dir');
    if (!editor || !installDir) {
        console.error('missing required args: --editor <exe> --install-dir <dir>');
        process.exitCode = 2;
        return;
    }
    const timeoutS = parseInt(arg('timeout-s', '30'), 10) || 30;
    const outDir = arg('out-dir', process.cwd());
    const extDir = arg('extensions-dir', path.join(installDir, 'extensions'));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'p47userdata-'));
    console.log('[P47] editor: ' + editor);
    console.log('[P47] user-data-dir: ' + userData);
    const child = spawn(editor, [
        '--no-first-run',
        '--new-window',
        '--disable-gpu',
        '--extensions-dir=' + extDir,
        '--user-data-dir=' + userData,
    ], {
        stdio: 'ignore',
        windowsHide: true,
        env: Object.assign({}, process.env, { SUDO_STUDIO_ROOT: installDir }),
    });
    console.log('[P47] editor pid ' + child.pid + ', waiting ' + timeoutS + 's...');
    await sleep(timeoutS * 1000);
    try {
        if (process.platform === 'win32') execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' });
        else child.kill('SIGKILL');
    } catch (_) { /* already gone */ }
    await sleep(3000);
    const logsRoot = path.join(userData, 'logs');
    if (!fs.existsSync(logsRoot)) {
        console.log('[P47] INCONCLUSIVE: no logs dir at ' + logsRoot);
        process.exitCode = 2;
        return;
    }
    const res = scanLogs(logsRoot);
    console.log('[P47] scanned ' + res.files + ' log files, positive=' + res.positive);
    res.hits.forEach((h) => console.log('[P47] HIT ' + h.file + ':' + h.line + ' [' + h.pat + '] ' + h.text));
    try {
        const dest = path.join(outDir, 'p47-launch-logs');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'scan.json'), JSON.stringify(res, null, 1).slice(0, 20000));
    } catch (_) { /* evidence copy is best-effort */ }
    if (res.hits.length) {
        console.log('[P47] FAIL: extension registration error in installed editor logs');
        process.exitCode = 1;
        return;
    }
    if (!res.positive) {
        console.log('[P47] INCONCLUSIVE: extension activation line not found in logs');
        process.exitCode = 2;
        return;
    }
    console.log('[P47] PASS: no registration error, extension activated');
}

main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exitCode = 2; });
