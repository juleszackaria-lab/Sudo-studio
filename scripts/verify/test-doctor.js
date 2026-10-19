/**
 * SUDO STUDIO - P36(c) functional test: Doctor (on INSTALLED files).
 *
 * Instantiates the INSTALLED DoctorPanel (EXT_DIR/src/panels/DoctorPanel.js)
 * with a stubbed `vscode` host and compares its diagnostics against
 * INDEPENDENT shell commands (same binaries, run by this script, not by
 * the panel) plus an independent raw-http backend probe (not axios).
 *
 * Asserts:
 *  1. every tool row matches the independent shell result (version or absent)
 *  2. the backend row is CONSISTENT with the independent probe
 *     (absolute ok required only with --require-backend, i.e. in CI where
 *     the matrix runner starts backend.exe first)
 *  3. the runtime row is recorded (up => not 'error'; down => 'error')
 *  4. RAM/Platform rows present; panel never crashes
 *
 * Usage: node test-doctor.js [--ext <dir>] [--require-backend]
 * Exit: 0 = all PASS, 1 = any FAIL. Prints one JSON report on stdout.
 * ASCII-only.
 */
'use strict';

const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const Module = require('module');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const EXT_DIR = argVal('--ext', process.env.P36_EXT_DIR ||
    path.join(__dirname, '..', '..', 'sudo-ai-extension'));
const REQUIRE_BACKEND = process.argv.indexOf('--require-backend') !== -1;

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail: detail || '' });
}

// -- stub vscode host (the panel only needs these for diagnostics) -----------
const vscodeStub = {
    window: { showInformationMessage: async () => undefined },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    ViewColumn: { One: 1 },
    Uri: { file: (p) => ({ fsPath: p }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, isMain);
};

// -- independent shell probe (same binaries, our own exec) --------------------
const isWin = process.platform === 'win32';
const TOOLS = [
    ['Node.js', 'node --version'],
    ['npm', 'npm --version'],
    ['Python', isWin ? 'python --version 2>&1' : 'python3 --version'],
    ['pip', isWin ? 'pip --version' : 'pip3 --version'],
    ['Git', 'git --version'],
    ['Docker', 'docker --version'],
];
function shellProbe(cmd) {
    try {
        const out = execSync(cmd, { timeout: 8000, encoding: 'utf8' }).trim().split('\n')[0];
        return out ? { present: true, value: out } : { present: false, value: '' };
    } catch (_) {
        return { present: false, value: '' };
    }
}
function httpProbe(url, timeoutMs) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode !== null && res.statusCode < 500);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

(async () => {
    let DoctorPanel;
    try {
        DoctorPanel = require(path.join(EXT_DIR, 'src', 'panels', 'DoctorPanel.js')).DoctorPanel;
        check('doctor-module-loads', true, 'from installed files');
    } catch (e) {
        check('doctor-module-loads', false, String((e && e.message) || e).slice(0, 200));
        console.log(JSON.stringify({ suite: 'p36-doctor', extDir: EXT_DIR, checks }, null, 2));
        process.exit(1);
    }

    const posted = [];
    const fakePanel = {
        webview: {
            html: '',
            postMessage: (m) => posted.push(m),
            onDidReceiveMessage: () => {},
            asWebviewUri: (u) => u,
        },
        onDidDispose: () => {},
        reveal: () => {},
    };
    let inst;
    try {
        inst = new DoctorPanel(fakePanel, { fsPath: EXT_DIR });
        check('doctor-instantiates', true, 'constructor ok');
    } catch (e) {
        check('doctor-instantiates', false, String((e && e.message) || e).slice(0, 200));
        console.log(JSON.stringify({ suite: 'p36-doctor', extDir: EXT_DIR, checks }, null, 2));
        process.exit(1);
    }

    let rows = null;
    try {
        rows = await inst._gatherDiagnostics();
        check('diagnostics-returned', Array.isArray(rows) && rows.length >= 8,
            Array.isArray(rows) ? (rows.length + ' rows') : typeof rows);
    } catch (e) {
        check('diagnostics-returned', false, String((e && e.message) || e).slice(0, 200));
        console.log(JSON.stringify({ suite: 'p36-doctor', extDir: EXT_DIR, checks }, null, 2));
        process.exit(1);
    }
    const byName = {};
    for (const r of rows) byName[r.name] = r;

    // 1. tools vs independent shell
    for (const [name, cmd] of TOOLS) {
        const row = byName[name];
        const shell = shellProbe(cmd);
        if (!row) {
            check('tool-' + name, false, 'row missing from diagnostics');
            continue;
        }
        const panelSaysPresent = row.status === 'ok';
        const match = (panelSaysPresent === shell.present) &&
            (!shell.present || (row.value || '') === shell.value);
        check('tool-' + name, match,
            'panel=' + row.status + ':' + String(row.value || '').slice(0, 40) +
            ' shell=' + (shell.present ? shell.value.slice(0, 40) : 'absent'));
    }

    // 2. backend vs independent raw-http probe
    const backendUp = await httpProbe('http://127.0.0.1:5000/api/system/health', 3000);
    const bRow = byName['Backend (port 5000)'];
    if (!bRow) {
        check('backend-consistent', false, 'row missing');
    } else {
        const consistent = (bRow.status === 'ok') === backendUp;
        const absolute = !REQUIRE_BACKEND || (backendUp && bRow.status === 'ok');
        check('backend-consistent', consistent && absolute,
            'probe=' + (backendUp ? 'up' : 'down') + ' panel=' + bRow.status +
            (REQUIRE_BACKEND ? ' (required)' : ' (informational)'));
    }

    // 3. runtime recorded honestly
    const runtimeUp = await httpProbe('http://127.0.0.1:6000/health', 3000);
    const rRow = byName['AI Runtime (port 6000)'];
    if (!rRow) {
        check('runtime-recorded', false, 'row missing');
    } else {
        const ok = runtimeUp ? rRow.status !== 'error' : rRow.status === 'error';
        check('runtime-recorded', ok,
            'probe=' + (runtimeUp ? 'up' : 'down') + ' panel=' + rRow.status +
            ':' + String(rRow.value || '').slice(0, 50));
    }

    // 4. system rows present
    check('system-rows', !!byName.Platform && !!byName.RAM,
        'platform=' + (byName.Platform ? byName.Platform.value : '?') +
        ' ram=' + (byName.RAM ? String(byName.RAM.value).slice(0, 40) : '?'));

    console.log(JSON.stringify({ suite: 'p36-doctor', extDir: EXT_DIR, checks }, null, 2));
    process.exit(checks.some((c) => c.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => {
    check('harness-no-crash', false, String((e && e.message) || e).slice(0, 200));
    console.log(JSON.stringify({ suite: 'p36-doctor', extDir: EXT_DIR, checks }, null, 2));
    process.exit(1);
});
