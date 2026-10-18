/**
 * SUDO STUDIO - P29: installer/launcher/packaging checks.
 * A: backend crash fix (dead require + legacy block + fake chat removed) + live boot
 * B: STEP 2c title-bar logo (gen-A + gen-B artwork identity)
 * C: start.bat (installed-first extension, loud timeouts, editor monitor+cleanup)
 * D: installer.iss (kill by exe path + lock verification)
 * E: build-manifest wiring (backend line + extension command + launcher header)
 * F: canonical agent server path (doc + dev-side resolution)
 * G: smoke script (checks present, fail-fast exit code, ASCII)
 * H: agent handshake protocol (live: stdout JSON + authed /health)
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function httpGet(port, urlPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {}, timeout: 5000 }, (res) => {
            let s = '';
            res.on('data', (d) => { s += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: s }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
    });
}
async function waitHttp(port, urlPath, timeoutMs, headers) {
    const t0 = Date.now();
    for (;;) {
        try {
            const r = await httpGet(port, urlPath, headers);
            if (r.status === 200) return r;
        } catch (_) { /* retry */ }
        if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for 127.0.0.1:' + port + urlPath);
        await sleep(500);
    }
}

// -- A: backend crash fix -----------------------------------------------------
const serverJs = read('backend/server.js');
check('A1: no dead aiModelsManager require', () => {
    assert.ok(!serverJs.includes("require('./ai/aiModelsManager')"));
});
check('A2: no legacy route registrations', () => {
    assert.ok(!serverJs.includes("app.get('/api/models"));
    assert.ok(!serverJs.includes("app.post('/api/models"));
    assert.ok(!serverJs.includes("app.post('/api/chat'"));
    assert.ok(!serverJs.includes("app.delete('/api/models"));
    assert.ok(serverJs.includes('P29(b)'));
});
check('A3: no simulated replies', () => {
    assert.ok(!serverJs.includes('simul\u00e9e'));
    assert.ok(!serverJs.includes('simul\u00e9:'));
});

// -- B: STEP 2c ---------------------------------------------------------------
const ps1 = read('scripts/customize-vscodium.ps1');
check('B1: gen-B (1.97.2) markers present', () => {
    assert.ok(ps1.includes('#78AEED') && ps1.includes('#1D6BCA'));
    assert.ok(ps1.includes('$oldSvgMarkers1972') && ps1.includes('$isGenB'));
});
check('B2: gen-A markers kept (P20 compat)', () => {
    assert.ok(ps1.includes('path6008') && ps1.includes('Gradient_1'));
    assert.ok(ps1.includes('0 old-logo occurrences remain'));
});
check('B3: identity rule matches 1.97.2 art, not the replacement', () => {
    const genA = ['path6008', 'gradient_1'];
    const genB = ['#78aeed', '#1d6bca', 'lineargradient'];
    const isOld = (s) => {
        const t = s.toLowerCase();
        return genA.every((m) => t.includes(m)) || genB.every((m) => t.includes(m));
    };
    // Real 1.97.2 vector shape (minified, no ids, blue stops).
    const art1972 = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100">' +
        '<defs><linearGradient id="a"><stop offset="0" stop-color="#78AEED"/>' +
        '<stop offset="1" stop-color="#1D6BCA"/></linearGradient></defs><path d="M1 2"/></svg>';
    assert.strictEqual(isOld(art1972), true);
    const sudo = read('resources/sudo-icon.svg');
    assert.strictEqual(isOld(sudo), false);
});
check('B4: per-file post-verify present', () => {
    assert.ok(ps1.includes('still carry old-logo art'));
});

// -- C: start.bat --------------------------------------------------------------
const bat = read('start.bat');
check('C1: extension installed-first + loud error', () => {
    assert.ok(bat.includes('if exist "%V_DEV%\\package.json"'));
    assert.ok(bat.includes('Extension missing (both paths)'));
    assert.ok(!bat.includes('Extension source missing'));
});
check('C2: backend timeout is an error with log path', () => {
    assert.ok(!bat.includes('continuing to launch'));
    assert.ok(bat.includes('[ERROR] Backend timeout - editor opening WITHOUT backend'));
    assert.ok(bat.includes('logs\\backend.log'));
});
check('C3: editor monitor + precise cleanup', () => {
    assert.ok(bat.includes(':mon_loop'));
    assert.ok(bat.includes('--extensions-dir'));
    assert.ok(bat.includes('ExecutablePath -like'));
    assert.ok(bat.includes('exit /b 0'));
});
check('C4: P21 journal path + manifest commit in header', () => {
    assert.ok(bat.includes('SudoStudio\\logs\\runtime.log'));
    assert.ok(bat.includes('BUILD_COMMIT'));
    assert.ok(bat.includes('Build commit: %BUILD_COMMIT%'));
});

// -- D: installer.iss ----------------------------------------------------------
const iss = read('installer.iss');
check('D1: kill-by-path + lock check present', () => {
    assert.ok(iss.includes('procedure KillSudoProcesses'));
    assert.ok(iss.includes('function PrepareToInstall'));
    assert.ok(iss.includes('function AnyExeLocked'));
    assert.ok(iss.includes('function FileLocked'));
});
check('D2: uninstall kills before removing', () => {
    assert.ok(iss.includes('usUninstall'));
    const un = iss.slice(iss.indexOf('procedure CurUninstallStepChanged'));
    assert.ok(un.includes('KillSudoProcesses'));
});
check('D3: all four exes covered', () => {
    for (const e of ['backend.exe', 'runtime.exe', 'SudoStudio.exe', 'VSCodium.exe']) {
        assert.ok(iss.includes(e), e);
    }
});

// -- E: build-manifest wiring ---------------------------------------------------
check('E1: backend logs build commit first', () => {
    assert.ok(serverJs.includes('build-manifest.json'));
    assert.ok(serverJs.includes('sudo_studio_commit'));
    assert.ok(serverJs.includes('build: commit='));
});
check('E2: extension command contributed', () => {
    const pkg = JSON.parse(read('sudo-ai-extension/package.json'));
    const cmds = pkg.contributes.commands;
    const c = cmds.find((x) => x.command === 'sudoStudio.showBuildInfo');
    assert.ok(c);
    assert.strictEqual(c.category, 'Sudo');
});
check('E3: extension command registered + reads manifest', () => {
    const ext = read('sudo-ai-extension/extension.js');
    assert.ok(ext.includes("['sudoStudio.showBuildInfo',"));
    assert.ok(ext.includes('function showBuildInfo()'));
    assert.ok(ext.includes('build-manifest.json'));
});
check('E4: launcher header carries the commit', () => {
    assert.ok(bat.includes('build-manifest.json'));
});

// -- F: canonical agent path ----------------------------------------------------
check('F1: canonical path documented', () => {
    const ag = read('sudo-ai-extension/src/agent/AgentServer.js');
    assert.ok(ag.includes('extensions\\sudo-agent\\src\\server.js'));
    assert.ok(ag.includes('P29(f)'));
});
check('F2: dev-side resolution hits the real file', () => {
    const { defaultServerJs } = require('../../sudo-ai-extension/src/agent/AgentServer.js');
    const p = defaultServerJs();
    assert.strictEqual(p, path.join(ROOT, 'sudo-agent', 'src', 'server.js'));
    assert.ok(fs.existsSync(p));
});

// -- G: smoke script -------------------------------------------------------------
const smoke = read('scripts/smoke/smoke-install.ps1');
check('G1: all mission checks present', () => {
    for (const c of ['silent-install', 'backend-health', 'runtime-health', 'agent-handshake',
        'expected-files', 'clean-uninstall', 'editor-close-cleanup', 'build-manifest',
        'runtime-p21-journal', 'brand-product.json', 'brand-titlebar-svg']) {
        assert.ok(smoke.includes("'" + c + "'"), c);
    }
});
check('G2: fail exit + summary + transcript', () => {
    assert.ok(smoke.includes('exit 1'));
    assert.ok(smoke.includes('summary.txt'));
    assert.ok(smoke.includes('Start-Transcript'));
});
check('G3: new P29 files are ASCII-only', () => {
    for (const f of ['scripts/smoke/smoke-install.ps1', 'docs/p29-packager-patch.md',
        'backend/tests/test-p29-packaging.js']) {
        const buf = fs.readFileSync(path.join(ROOT, f));
        for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, f + ' byte ' + i);
    }
});

// -- H: live protocol proofs ------------------------------------------------------
async function main() {
    const port = 15029;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(ROOT, 'backend'),
        env: Object.assign({}, process.env, { PORT: String(port) }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    try {
        await waitHttp(port, '/api/system/health', 30000);
        const legacy = await httpGet(port, '/api/models', {});
        assert.strictEqual(legacy.status, 404);
        assert.ok(out.includes('build: commit=') || out.includes('build: dev'), 'boot line');
        n++; console.log('ok - A4: backend boots, health 200, legacy 404');
    } finally {
        child.kill('SIGKILL');
        await sleep(500);
        if (!child.killed && child.exitCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} }
    }

    const token = 'p29-smoke-token-0123456789abcdef';
    const agent = spawn(process.execPath, ['src/server.js'], {
        cwd: path.join(ROOT, 'sudo-agent'),
        env: Object.assign({}, process.env, {
            SUDO_AGENT_TOKEN: token, SUDO_AGENT_PORT: '0', SUDO_AGENT_PROVIDER: '{}',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let aout = '';
    agent.stdout.on('data', (d) => { aout += d; });
    try {
        let hs = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            const line = aout.split('\n').find((l) => l.indexOf('{"ready":true') === 0);
            if (line) { hs = JSON.parse(line); break; }
            await sleep(250);
        }
        assert.ok(hs && hs.port, 'handshake line');
        const r = await httpGet(hs.port, '/health', { Authorization: 'Bearer ' + token });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(JSON.parse(r.body).ok, true);
        n++; console.log('ok - H1: agent handshake protocol (stdout JSON + authed /health)');
    } finally {
        agent.kill('SIGKILL');
        await sleep(500);
        if (!agent.killed && agent.exitCode === null) { try { process.kill(agent.pid, 'SIGKILL'); } catch (_) {} }
    }
    console.log('\nP29-packaging: ' + n + ' checks passed (all green)');
}

main().catch((e) => { console.error('P29-packaging FAILED: ' + (e && e.message)); process.exit(1); });
