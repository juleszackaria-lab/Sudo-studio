/**
 * SUDO STUDIO - PROMPT 48: titlebar brand text + app-first window.title +
 * English tree + supervised-runtime wait.
 * A: STEP 2d CSS block (ps1) | B: window.title template (3 files agree) |
 * D: waitForRuntime unit | E: runTurn kill/restart integration (stub) |
 * F: engine runtime.wait -> step | G: wiring greps | H: supervisor manual.
 * Item 3 (tree labels) is covered by test-p47 C6/C8 (rewritten for P48).
 * Real unit + integration tests where possible; H2-style source greps for
 * the Windows-only ps1/server call sites. ASCII-only.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// -- A: titlebar brand CSS (customize-vscodium.ps1 STEP 2d) --------------------
const ps1 = read('scripts/customize-vscodium.ps1');
check('A1: STEP 2d block with marker present',
    ps1.indexOf('STEP 2d') !== -1 && ps1.indexOf('P48-TITLEBAR-BRAND') !== -1);
check('A2: selector puts "Sudo Studio" before the menu',
    ps1.indexOf('.titlebar-left .menubar::before') !== -1 &&
    ps1.indexOf('content:"Sudo Studio"') !== -1);
const cssBlock = ps1.slice(ps1.indexOf('/* P48-TITLEBAR-BRAND'), ps1.indexOf("'@", ps1.indexOf('/* P48-TITLEBAR-BRAND')));
check('A3: theme variables only (no hard-coded color/size)',
    cssBlock.indexOf('var(--vscode-titleBar-activeForeground)') !== -1 &&
    cssBlock.indexOf('var(--vscode-font-size)') !== -1 &&
    cssBlock.indexOf('font-size:inherit') !== -1 &&
    cssBlock.indexOf('#') === -1);
check('A4: narrow-window hide (text disappears before the menu)',
    cssBlock.indexOf('@media (max-width:') !== -1 &&
    cssBlock.indexOf('display:none') !== -1);
check('A5: fail-closed (missing file/anchor refuses the build)',
    ps1.indexOf('[2d] FAIL') !== -1 &&
    (ps1.match(/exit 2/g) || []).length >= 3);
const mfPs1 = read('scripts/ci/build-manifest.ps1');
check('A6: pack-time gate requires the brand CSS marker',
    mfPs1.indexOf('P48-TITLEBAR-BRAND') !== -1);
const verPs1 = read('scripts/verify/verify-installed.ps1');
check('A7: installed-package verifier requires the brand CSS marker',
    verPs1.indexOf('P48-TITLEBAR-BRAND') !== -1);

// -- B: window.title app-first template (3 files agree) -------------------------
const P48TITLE = "'${appName}${separator}${dirty}${activeEditorShort}${separator}${rootName}'";
const CLASSIC = "'${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}'";
check('B1: customize ps1 ships the P48 template',
    ps1.indexOf('"window.title"         = ' + P48TITLE) !== -1);
check('B2: pack-time gate expects the P48 template',
    mfPs1.indexOf("$cfgD.'window.title' -ne " + P48TITLE) !== -1 &&
    mfPs1.indexOf('app-first template') !== -1);
check('B3: installed-package verifier expects the P48 template',
    verPs1.indexOf("$cfgV.'window.title' -ne " + P48TITLE) !== -1);
check('B4: app name leads the template',
    P48TITLE.indexOf("'${appName}${separator}") === 0);
check('B5: classic template gone from all three files',
    ps1.indexOf(CLASSIC) === -1 && mfPs1.indexOf(CLASSIC) === -1 &&
    verPs1.indexOf(CLASSIC) === -1);

// -- D: waitForRuntime unit (fake probe/sleep, real logic) ----------------------
const { waitForRuntime } = require('../../sudo-agent/src/providers');
const OFFLINE = { ok: false, code: 'runtime_offline', error: 'down' };
async function main() {
    // D1: recovers on attempt 3, exact progress messages.
    {
        const msgs = [];
        let n = 0;
        const r = await waitForRuntime({ type: 'local', baseUrl: 'http://127.0.0.1:9' }, {
            attempts: 5, delayMs: 1, probeTimeoutMs: 10,
            sleep: async () => {},
            probeFn: async () => (++n < 3 ? OFFLINE : { ok: true, models: ['m'], details: [] }),
            onProgress: (a, m, msg) => msgs.push(msg),
        });
        check('D1: recovers mid-wait with exact attempt messages',
            r.recovered === true && r.attemptsMade === 3 &&
            JSON.stringify(msgs) === JSON.stringify([
                'Runtime restarting, attempt 1/5',
                'Runtime restarting, attempt 2/5',
                'Runtime restarting, attempt 3/5',
            ]), JSON.stringify(msgs));
    }
    // D2: persistent outage -> 5 attempts, 50s sleep budget (<= 60s total).
    {
        const sleeps = [];
        const r = await waitForRuntime({ type: 'local', baseUrl: 'http://127.0.0.1:9' }, {
            sleep: async (ms) => sleeps.push(ms),
            probeFn: async () => OFFLINE,
        });
        const total = sleeps.reduce((a, b) => a + b, 0);
        check('D2: gives up after 5 attempts within the 60s budget',
            r.recovered === false && r.attemptsMade === 5 && sleeps.length === 5 &&
            total === 50000 && r.probe && r.probe.code === 'runtime_offline',
            'sleeps=' + JSON.stringify(sleeps));
    }
    // D3: non-restart verdict -> immediate return (no wait).
    {
        let probes = 0;
        const r = await waitForRuntime({ type: 'local', baseUrl: 'http://127.0.0.1:9' }, {
            delayMs: 1, sleep: async () => {},
            probeFn: async () => (++probes, { ok: false, code: 'bad_config', error: 'bad' }),
            onProgress: () => {},
        });
        check('D3: bad_config returns immediately (no restart episode)',
            r.recovered === false && r.attemptsMade === 1 && probes === 1 &&
            r.probe.code === 'bad_config');
    }
    // D4: cloud configs never wait.
    {
        let progressed = 0;
        const r = await waitForRuntime({ type: 'cloud', baseUrl: 'https://x' }, {
            onProgress: () => { progressed++; },
        });
        check('D4: cloud provider never waits',
            r.recovered === false && r.attemptsMade === 0 && progressed === 0);
    }
    // D5: up-but-loading (no_model after offline) keeps waiting, then resumes.
    {
        const seq = [OFFLINE, { ok: false, code: 'no_model', error: 'empty' },
            { ok: true, models: ['m'], details: [] }];
        let i = 0;
        const r = await waitForRuntime({ type: 'local', baseUrl: 'http://127.0.0.1:9' }, {
            attempts: 5, delayMs: 1, sleep: async () => {},
            probeFn: async () => seq[Math.min(i++, seq.length - 1)],
            onProgress: () => {},
        });
        check('D5: no_model-after-offline keeps waiting, then recovers',
            r.recovered === true && r.attemptsMade === 3);
    }
    // D6: user abort stops the wait.
    {
        const r = await waitForRuntime({ type: 'local', baseUrl: 'http://127.0.0.1:9' }, {
            attempts: 5, delayMs: 60000, sleep: async () => {},
            probeFn: async () => OFFLINE,
            shouldAbort: () => true,
            onProgress: () => {},
        });
        check('D6: abort flag stops the wait immediately',
            r.aborted === true && r.recovered === false && r.attemptsMade === 0);
    }

    // -- E: runTurn vs stub runtime (kill -> wait -> restart -> resume) ---------
    const { runTurn } = require('../../sudo-agent/src/loop');
    const { createStore } = require('../../sudo-agent/src/store');
    const mkStub = () => http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
            });
            return;
        }
        res.writeHead(404); res.end('nope');
    });
    const listenPort = (srv) => new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
    // E1: runtime dies, "supervisor" restarts it mid-wait -> turn resumes.
    {
        const store = createStore();
        let srv = mkStub();
        const port = await listenPort(srv);
        const provider = { type: 'local', baseUrl: 'http://127.0.0.1:' + port, model: '' };
        await new Promise((r) => srv.close(r)); // runtime dies
        const s = store.create({ title: 'p48e1' });
        const evts = [];
        setTimeout(() => { srv = mkStub(); srv.listen(port, '127.0.0.1'); }, 250);
        const t0 = Date.now();
        const r = await runTurn({ store, provider, sessionId: s.id, prompt: 'hi',
            corr: 'p48e1', log: null, runs: new Map(),
            runtimeWait: { attempts: 5, delayMs: 100, probeTimeoutMs: 200 },
            onEvent: (e) => evts.push(e.type + (e.message ? ':' + e.message : '')) });
        const waits = evts.filter((e) => e.indexOf('runtime.wait:Runtime restarting, attempt ') === 0);
        check('E1: turn waits on runtime.wait events then resumes',
            r.status === 'done' && waits.length >= 1 &&
            evts.indexOf('turn.start') !== -1 && evts.indexOf('turn.done') !== -1 &&
            Date.now() - t0 < 15000, JSON.stringify(evts));
        await new Promise((r) => srv.close(r));
    }
    // E2: runtime stays dead -> turn.error runtime_offline after N waits.
    {
        const store = createStore();
        const srv = mkStub();
        const port = await listenPort(srv);
        await new Promise((r) => srv.close(r)); // stays dead
        const provider = { type: 'local', baseUrl: 'http://127.0.0.1:' + port, model: '' };
        const s = store.create({ title: 'p48e2' });
        const evts = [];
        const r = await runTurn({ store, provider, sessionId: s.id, prompt: 'hi',
            corr: 'p48e2', log: null, runs: new Map(),
            runtimeWait: { attempts: 3, delayMs: 20, probeTimeoutMs: 100 },
            onEvent: (e) => evts.push(e.type + ':' + (e.message || e.code || '')) });
        const waits = evts.filter((e) => e.indexOf('runtime.wait:') === 0);
        check('E2: persistent outage fails clean as runtime_offline',
            r.status === 'error' && r.code === 'runtime_offline' && waits.length === 3 &&
            evts[evts.length - 1] === 'turn.error:runtime_offline', JSON.stringify(evts));
    }

    // -- F: engine maps runtime.wait to a panel step -----------------------------
    {
        const { AgentEngine } = require('../../sudo-ai-extension/src/agent/AgentEngine');
        const eng = new AgentEngine({ server: null, provider: null });
        const steps = [];
        eng.on('step', (d) => steps.push(d));
        eng._onSse('s1', 'runtime.wait',
            { attempt: 2, maxAttempts: 5, message: 'Runtime restarting, attempt 2/5' }, () => {});
        check('F1: runtime.wait becomes a runtime-restart step with the exact text',
            steps.length === 1 && steps[0].phase === 'runtime-restart' &&
            steps[0].message === 'Runtime restarting, attempt 2/5',
            JSON.stringify(steps));
    }

    // -- H: supervisor manual restart --------------------------------------------
    {
        const { RuntimeSupervisor } = require('../supervisor/runtimeSupervisor');
        const mk = () => new RuntimeSupervisor({
            graceMs: 120000, pollMs: 60000,
            httpGet: async () => ({ status: 200, data: {} }),
            httpPost: async () => ({ status: 200, data: {} }),
            spawnFn: () => true, killFn: async () => 'stub',
            sleep: async () => {}, now: () => 1000000, log: () => {},
            runtimeExePath: '/nonexistent-p48',
            stateFilePath: '/tmp/p48-state.json', auditPath: '/tmp/p48-audit.log',
        });
        const a = mk(); a.startedAt = 1000000; a.running = true;
        const ra = await a.maybeRestart('auto');
        check('H1: automatic restart still honors the boot grace',
            ra.action === 'suppressed_grace');
        const b = mk(); b.startedAt = 1000000; b.running = true; b.waitHealthyMs = 5;
        b.httpGet = async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); };
        const rb = await b.maybeRestart('manual', { manual: true });
        check('H2: manual Restart now bypasses the boot grace',
            rb.action === 'restarted', JSON.stringify(rb.action));
        const c = mk(); c.startedAt = 0; c.running = true;
        c.restartAttempts = [999000, 999100, 999200, 999300, 999400];
        const rc = await c.maybeRestart('manual', { manual: true });
        check('H3: manual restart still honors the 10-minute cap',
            rc.action === 'suppressed_cap');
    }

    console.log('\nP48: ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
}

// -- G: wiring (H2-style source greps for the thin call sites) ------------------
const srvSrc = read('sudo-agent/src/server.js');
check('G1: server pre-check waits on runtime_offline with progress events',
    srvSrc.indexOf("pre.code !== 'runtime_offline'") !== -1 &&
    srvSrc.indexOf('waitForRuntime(provider') !== -1 &&
    srvSrc.indexOf("emit('runtime.wait'") !== -1);
const loopSrc = read('sudo-agent/src/loop.js');
check('G2: loop waits at turn start + all 3 turn bodies',
    (loopSrc.match(/waitAndRetry\(\{/g) || []).length === 5); // P49: +1 repair site (same P48 rule)
const engSrc = read('sudo-ai-extension/src/agent/AgentEngine.js');
check('G3: engine maps runtime.wait to a step',
    engSrc.indexOf("type === 'runtime.wait'") !== -1 &&
    engSrc.indexOf("phase: 'runtime-restart'") !== -1);
const noBat = ['sudo-ai-extension/src/panels/RuntimePanel.js',
    'sudo-ai-extension/src/agent/AgentEngine.js', 'sudo-agent/src/providers.js',
    'sudo-agent/src/loop.js', 'sudo-agent/src/server.js',
    'backend/routes/models.routes.js', 'backend/routes/supervisor.routes.js'];
check('G4: no start.bat order in agent/chat/runtime sources',
    noBat.every((f) => read(f).indexOf('start.bat') === -1),
    JSON.stringify(noBat.filter((f) => read(f).indexOf('start.bat') !== -1)));
const rtSrc = read('sudo-ai-extension/src/panels/RuntimePanel.js');
check('G5: Restart now button wired to the supervisor endpoint',
    rtSrc.indexOf('Restart now') !== -1 &&
    rtSrc.indexOf("case 'supervisorRestart'") !== -1 &&
    rtSrc.indexOf('/api/supervisor/runtime-restart') !== -1 &&
    read('backend/routes/supervisor.routes.js').indexOf("router.post('/api/supervisor/runtime-restart'") !== -1);
check('G6: download-503 fix no longer orders start.bat',
    read('backend/routes/models.routes.js').indexOf('Restart now in the Runtime panel') !== -1);

main().catch((e) => { fail++; console.log('FAIL P48 async harness :: ' + (e && e.stack || e)); process.exitCode = 1; });
