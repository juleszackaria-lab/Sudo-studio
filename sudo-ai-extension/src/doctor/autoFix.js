/**
 * SUDO STUDIO - AutoFix engine (PROMPT 7).
 *
 * Every fix is EXECUTED by the app, never a browser page:
 * - online  : silent install via winget (Windows) / brew+apt (macOS/Linux);
 * - offline : installers from a configurable folder, each verified against
 *             a SHA-256 sidecar file (<installer>.sha256) before execution.
 * - elevation: a single explained request; one elevated script on Windows.
 * - success gate: the fix counts as "fixed" ONLY if the post-check
 *   (--version or equivalent) passes with a refreshed PATH.
 * - every step is reported back (progress + final rows) and audited.
 * - dry-run (P36): pass deps.dryRun to plan without executing anything
 *   (no subprocess, no installer, no elevation); rows get status 'dry-run'.
 * - P40: the elevated step runs WITHOUT a script file (execution policies /
 *   AV / GPOs kept blocking the temp .ps1 after a granted UAC): the batch
 *   script is sent via powershell -EncodedCommand (base64 UTF-16LE, no
 *   quoting fragility), output markers go to a journal file created BEFORE
 *   elevation in a folder both levels can reach; empty journal triggers
 *   precise no-start diagnostics (execution policy, winget, Defender).
 * - P44: the RunAs -ArgumentList is an ARRAY of 5 separate arguments (the
 *   P40 single-string form reached the child as one argv entry, which
 *   powershell.exe rejects: granted UAC, instant child exit, empty
 *   journal). The journal gets up to 5 s to show START before any
 *   no-start diagnosis, and the diagnosis names the never-started
 *   command; winget-9009 points at the offline folder with the exact
 *   filename; the Docker prereq states "redemarrage requis".
 *
 * Pure module: no vscode import. All side effects are injected via `deps`
 * so plain-node tests can script every scenario (see test-p7-autofix.js).
 * New code avoids banned characters (no em-dash/curly quotes/emoji).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESTART_CODES = { 3010: true, 1641: true };
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 20000;

// -- fix definitions ---------------------------------------------------------------
const FIXES = {
    'Node.js': {
        check: { win: 'node --version', posix: 'node --version' },
        winget: { id: 'OpenJS.NodeJS.LTS' },
        offline: { file: 'node-lts-x64.msi', kind: 'msi' },
        brew: 'node', apt: 'nodejs npm',
        pathHints: ['C:\\Program Files\\nodejs'],
    },
    'npm': { aliasOf: 'Node.js', check: { win: 'npm --version', posix: 'npm --version' } },
    'Python': {
        check: { win: 'python --version 2>&1', posix: 'python3 --version' },
        winget: { id: 'Python.Python.3.11' },
        offline: { file: 'python-3.11-setup.exe', kind: 'exe', args: ['/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_pip=1'] },
        brew: 'python@3.11', apt: 'python3 python3-pip',
        pathHints: ['C:\\Program Files\\Python311', 'C:\\Program Files\\Python311\\Scripts'],
    },
    'pip': {
        dependsOn: 'Python',
        ensurepip: { win: 'python -m ensurepip --upgrade', posix: 'python3 -m ensurepip --upgrade' },
        check: { win: 'pip --version', posix: 'pip3 --version' },
        checkFallback: { win: 'python -m pip --version', posix: 'python3 -m pip --version' },
    },
    'Git': {
        check: { win: 'git --version', posix: 'git --version' },
        winget: { id: 'Git.Git' },
        offline: { file: 'git-setup.exe', kind: 'exe', args: ['/VERYSILENT', '/NORESTART'] },
        brew: 'git', apt: 'git',
        pathHints: ['C:\\Program Files\\Git\\cmd'],
    },
    'Docker': {
        check: { win: 'docker --version', posix: 'docker --version' },
        winget: { id: 'Docker.DockerDesktop' },
        offline: { file: 'DockerDesktopInstaller.exe', kind: 'exe', args: ['install', '--quiet'] },
        brew: null, apt: null, // Docker on macOS/Linux: manual (daemon setup, see reason)
        pathHints: ['C:\\Program Files\\Docker\\Docker\\resources\\bin'],
        needsVirtualization: true,
    },
};

function resolveFix(issue) {
    const f = FIXES[issue];
    if (!f) return null;
    if (f.aliasOf) {
        const base = FIXES[f.aliasOf];
        return { ...base, check: f.check, issue, via: f.aliasOf };
    }
    return { ...f, issue };
}

function isKnownTool(issue) { return !!FIXES[issue]; }

// Order installs so dependencies come first (Python before pip, Node before npm).
function orderIssues(issues) {
    const rank = (i) => {
        const f = FIXES[i];
        if (!f) return 99;
        if (f.dependsOn) return 10;
        if (f.aliasOf) return 10;
        return 1;
    };
    return [...new Set(issues)].filter(isKnownTool).sort((a, b) => rank(a) - rank(b));
}

// -- default side effects ---------------------------------------------------------------
function defaultExec(cmd, opts) {
    const { exec } = require('child_process');
    const timeout = (opts && opts.timeout) || DEFAULT_VERIFY_TIMEOUT_MS;
    return new Promise((resolve) => {
        exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
                timedOut: !!(err && err.killed),
            });
        });
    });
}

// P40-d: REAL connectivity test against the winget source host (any HTTP
// answer counts as reachable), with a DNS fallback to tell DNS failures
// apart from HTTP blocks. opts override the target for hermetic tests:
// { protocol, host, port, path, timeoutMs }. Never throws.
function probeWingetSource(opts) {
    opts = opts || {};
    const protocol = opts.protocol || 'https:';
    const host = opts.host || 'cdn.winget.microsoft.com';
    const port = opts.port || (protocol === 'http:' ? 80 : 443);
    const reqPath = opts.path || '/cache';
    const timeoutMs = opts.timeoutMs || 5000;
    const t0 = Date.now();
    const ms = () => Date.now() - t0;
    const dnsCheck = () => new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, 2000);
        try {
            require('dns').resolve(host, () => {
                if (!done) { done = true; clearTimeout(t); resolve('ok'); }
            });
        } catch (_) { clearTimeout(t); resolve('erreur'); }
    });
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok, detail) => {
            if (done) return;
            done = true;
            resolve({ ok, ms: ms(), detail: host + ' : ' + detail + ' (' + ms() + ' ms)' });
        };
        let req = null;
        try {
            const lib = protocol === 'http:' ? require('http') : require('https');
            req = lib.get({ hostname: host, port, path: reqPath, timeout: timeoutMs }, (res) => {
                try { res.resume(); } catch (_) {}
                try { if (req) req.destroy(); } catch (_) {}
                finish(true, 'HTTP ' + res.statusCode);
            });
            req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
            req.on('error', async (e) => {
                const dns = await dnsCheck();
                finish(false, 'injoignable (' + String((e && e.code) || (e && e.message) || e).slice(0, 60) + ', dns=' + dns + ')');
            });
        } catch (e) {
            finish(false, 'sonde impossible (' + String((e && e.message) || e).slice(0, 60) + ')');
        }
        setTimeout(() => finish(false, 'delai depasse (' + timeoutMs + ' ms)'), timeoutMs + 500);
    });
}

function defaultHasInternet() {
    return probeWingetSource().then(
        (p) => p.ok,
        () => false);
}

function defaultAudit() { /* wired by the panel */ }

// -- helpers -------------------------------------------------------------------------------
function tail(s, n) {
    const lines = String(s || '').trim().split('\n');
    return lines.slice(-(n || 3)).join(' | ').slice(0, 300);
}

// Last 30 lines of combined stdout+stderr for the audit journal (P19-a).
function tail30(out, err) {
    const all = (String(out || '') + '\n' + String(err || '')).replace(/\r/g, '').split('\n');
    const lines = all.map((l) => l.replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    while (lines.length && lines[0] === '') lines.shift();
    return lines.slice(-30).join('\n').slice(0, 4000);
}

function psQuote(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

function winPathJoin(parts) { return parts.join('\\'); }

function defaultOfflineDir() {
    return path.join(os.homedir(), '.sudo_studio', 'installers');
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const st = fs.createReadStream(file);
        st.on('error', reject);
        st.on('data', (d) => h.update(d));
        st.on('end', () => resolve(h.digest('hex')));
    });
}

async function verifyCheck(execFn, cmd, fallbackCmd, timeoutMs) {
    const run = async (c) => execFn(c, { timeout: timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS });
    let r = await run(cmd);
    const ok = (x) => x.code === 0 && /\d+\.\d+/.test(x.stdout);
    if (!ok(r) && fallbackCmd) r = await run(fallbackCmd);
    if (ok(r)) return { ok: true, output: r.stdout.trim().split('\n')[0].slice(0, 120) };
    return { ok: false, output: tail(r.stdout + '\n' + r.stderr) || ('exit ' + r.code) };
}

// Refresh PATH for this app process after an install (7c).
async function refreshPath(execFn, platform, hints) {
    const extra = [...(hints || [])];
    if (platform === 'win32') {
        try {
            const r = await execFn(
                'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\'); [Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
                { timeout: 15000 });
            const fresh = String(r.stdout || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join(';');
            if (fresh) process.env.PATH = fresh;
        } catch (_) { /* keep current PATH */ }
    } else {
        extra.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'));
    }
    const sep = platform === 'win32' ? ';' : ':';
    const cur = String(process.env.PATH || '').split(sep);
    for (const h of extra) {
        const withEnv = h.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
        if (withEnv && !cur.includes(withEnv)) cur.unshift(withEnv);
    }
    process.env.PATH = cur.join(sep);
}

async function isWindowsAdmin(execFn) {
    try {
        const r = await execFn('net session', { timeout: 15000 });
        return r.code === 0;
    } catch (_) { return false; }
}

async function hasPasswordlessSudo(execFn) {
    try {
        const r = await execFn('sudo -n true', { timeout: 15000 });
        return r.code === 0;
    } catch (_) { return false; }
}

async function virtualizationEnabled(execFn) {
    try {
        const r = await execFn(
            'powershell -NoProfile -Command "(Get-ComputerInfo -Property HyperVRequirementVirtualizationFirmwareEnabled).HyperVRequirementVirtualizationFirmwareEnabled"',
            { timeout: 30000 });
        return /true/i.test(r.stdout);
    } catch (_) { return null; } // unknown
}

// -- install step builders ----------------------------------------------------------------------
function wingetCmd(id) {
    return 'winget install -e --id ' + id + ' --silent --accept-package-agreements --accept-source-agreements';
}

function offlineCmd(file, kind, args) {
    const q = '"' + file + '"';
    if (kind === 'msi') return 'msiexec /i ' + q + ' /quiet /norestart';
    return q + ' ' + (args || []).join(' ');
}

// One PowerShell script, many steps, DONE markers parsed back (singleUAC: the
// whole script runs in ONE elevated process when elevation was granted).
function buildPsScript(steps, logFile) {
    const L = [];
    L.push("$ErrorActionPreference = 'Continue'");
    L.push('$log = ' + psQuote(logFile));
    L.push('function L($s) { Add-Content -Path $log -Value ([string]$s) }');
    L.push("L 'START'");
    for (const s of steps) {
        L.push('L ' + psQuote('STEP ' + s.id));
        // P19: stream this step's stdout+stderr into the log (bounded), then a
        // null-safe DONE marker (9009 = step never ran, e.g. winget missing from
        // the elevated PATH). Piping through cmdlets preserves $LASTEXITCODE.
        L.push('L ' + psQuote('OUTPUT ' + s.id));
        L.push(s.cmd + ' *>&1 | Select-Object -First 150 | ForEach-Object { L ([string]$_) }');
        L.push('L ' + psQuote('ENDOUTPUT ' + s.id));
        L.push("$code = $LASTEXITCODE; if ($null -eq $code) { $code = 9009 }; L ('DONE " + s.id + " code=' + $code)");
    }
    L.push("L 'END'");
    return L.join('\r\n');
}

function parsePsLog(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/DONE (\S+) code=(-?\d*)/);
        if (m) out[m[1]] = m[2] === '' ? 9009 : parseInt(m[2], 10);
    }
    return out;
}

// P19: per-step captured output between OUTPUT <id> / ENDOUTPUT <id> markers.
function parsePsStepOutputs(text) {
    const out = {};
    let cur = null;
    let buf = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/\r$/, '');
        let m = line.match(/^OUTPUT (\S+)\s*$/);
        if (m) { cur = m[1]; buf = []; continue; }
        m = line.match(/^ENDOUTPUT (\S+)\s*$/);
        if (m && cur === m[1]) { out[cur] = buf.join('\n'); cur = null; buf = []; continue; }
        if (cur) buf.push(line);
    }
    if (cur) { while (buf.length && buf[buf.length - 1] === '') buf.pop(); out[cur] = buf.join('\n'); }
    return out;
}

// P40-a: encode the batch script for `powershell -EncodedCommand`
// (base64 UTF-16LE). No script FILE is ever written, so execution
// policies / AV / GPOs cannot block a temp .ps1, and nested quoting
// cannot corrupt the payload. Pure, easily round-tripped in tests.
function buildEncodedLaunch(innerScript) {
    return Buffer.from(String(innerScript || ''), 'utf16le').toString('base64');
}

function encodedLauncher(elevated, b64) {
    const inner = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64;
    if (!elevated) return 'powershell ' + inner;
    // P44-1: -ArgumentList as an ARRAY of 5 separate arguments. The P40
    // single-string form ('-NoProfile -ExecutionPolicy Bypass ...' in ONE
    // quoted element) reached the elevated child as a single argv entry,
    // which powershell.exe rejects: UAC granted, child exiting at once,
    // journal left empty ("script non execute", PC audit ~905 ms). With
    // the array form the child really starts with Bypass + payload.
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', String(b64)]
        .map((a) => psQuote(a)).join(',');
    return 'powershell -NoProfile -Command ' +
        psQuote('Start-Process powershell -Verb RunAs -Wait -ArgumentList ' + args);
}

// P40-a: journal folder reachable from BOTH privilege levels (the elevated
// child may run as another admin whose %TEMP% differs). First creatable
// candidate wins; deps.logDir overrides (tests). Never throws.
function defaultElevatedLogDir() {
    const cands = [];
    if (process.env.ProgramData) cands.push(path.join(process.env.ProgramData, 'SudoStudio', 'logs'));
    if (process.env.PUBLIC) cands.push(path.join(process.env.PUBLIC, 'SudoStudio'));
    cands.push(os.tmpdir());
    for (const d of cands) {
        try {
            fs.mkdirSync(d, { recursive: true });
            fs.accessSync(d, fs.constants.W_OK);
            return d;
        } catch (_) { /* next candidate */ }
    }
    return os.tmpdir();
}

async function wslPresent(execFn) {
    try {
        const r = await execFn('wsl --status', { timeout: 15000 });
        return r.code === 0
            ? { present: true, text: 'oui' }
            : { present: false, text: 'non (code ' + r.code + ')' };
    } catch (e) {
        return { present: false, text: 'non (' + String((e && e.message) || e).slice(0, 80) + ')' };
    }
}

// P44-2: read the journal, waiting up to settleMs for the START marker
// (the elevated child can lag behind -Wait; an instant read would cry
// "script non execute" on a merely slow flush). settleMs <= 0 (tests) =
// single immediate read. Returns { text, logRead }. Never throws.
async function readJournalSettled(logFile, settleMs) {
    const once = () => {
        try { return { text: fs.readFileSync(logFile, 'utf8'), logRead: true }; }
        catch (_) { return { text: '', logRead: false }; }
    };
    let r = once();
    if (!(settleMs > 0) || /START/.test(r.text)) return r;
    const t0 = Date.now();
    while (Date.now() - t0 < settleMs) {
        await new Promise((res) => setTimeout(res, 250));
        r = once();
        if (/START/.test(r.text)) return r;
    }
    return r;
}

// P40-b: the elevated child wrote NOTHING (UAC granted, empty journal).
// Probe, WITHOUT elevation, the three usual suspects and return a precise
// one-paragraph cause. Every probe is bounded and best-effort.
async function diagnoseElevatedNoStart(execFn) {
    const parts = [];
    try {
        const p = await execFn(
            'powershell -NoProfile -Command "Get-ExecutionPolicy -List | ForEach-Object { $_.Scope + \'=\' + $_.ExecutionPolicy }"',
            { timeout: 15000 });
        parts.push('politique d\'execution : ' +
            (p.code === 0 && p.stdout.trim()
                ? p.stdout.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join('; ')
                : 'illisible (code ' + p.code + ')'));
    } catch (e) {
        parts.push('politique d\'execution : sonde impossible (' + String((e && e.message) || e).slice(0, 80) + ')');
    }
    try {
        const w = await execFn('winget --version', { timeout: 15000 });
        parts.push('winget : ' + (w.code === 0
            ? String(w.stdout || '').trim().split('\n')[0].slice(0, 80)
            : 'absent (code ' + w.code + ')'));
    } catch (e) {
        parts.push('winget : sonde impossible (' + String((e && e.message) || e).slice(0, 80) + ')');
    }
    try {
        const d = await execFn(
            'powershell -NoProfile -Command "Get-WinEvent -LogName \'Microsoft-Windows-Windows Defender/Operational\' -MaxEvents 3 -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"',
            { timeout: 15000 });
        const ids = String(d.stdout || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
        parts.push('Defender : ' + (d.code === 0
            ? (ids.length ? 'evenements recents : ' + ids.join(',') : 'aucun evenement recent')
            : 'journal illisible (code ' + d.code + ')'));
    } catch (e) {
        parts.push('Defender : sonde impossible (' + String((e && e.message) || e).slice(0, 80) + ')');
    }
    return parts.join(' | ');
}

// P40: reverse of buildEncodedLaunch (tests + journal forensics on PC).
// P44-1: tolerates the elevated array form ('-EncodedCommand','<b64>')
// as well as the plain space form ('-EncodedCommand <b64>').
function decodeEncodedLaunch(cmd) {
    const m = String(cmd || '').match(/-EncodedCommand['\s,]+'?([A-Za-z0-9+/=]+)'?/);
    if (!m) throw new Error('EncodedCommand introuvable');
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

// P19-c: precise cause for a step with no DONE marker. Optional `extra`
// (P40 no-start diagnostics) is appended to the empty-log branch, plus the
// never-started command itself (P44-2: say WHAT did not start).
function diagnoseMissingStep(launchMs, launch, logText, logRead, parsed, kind, extra, cmd) {
    const lastLog = logText ? tail(logText, 4) : '';
    if (launch && launch.timedOut) {
        return { short: 'delai depasse',
            reason: "delai depasse (" + launchMs + " ms) : " + kind + " n'a pas rendu la main (timeout)" };
    }
    if (!logRead || !/START/.test(String(logText || ''))) {
        let reason = 'script non execute (journal vide ou absent)';
        if (launch && launch.code !== 0) {
            reason += ' : lancement echoue (code ' + launch.code + ')' +
                (launch.stderr ? ' : ' + tail(launch.stderr, 3) : '');
        } else {
            reason += " : le processus fils n'a rien ecrit (UAC validee mais script non demarre - antivirus, GPO ou elevation partielle ?)";
            if (cmd) reason += ' ; commande jamais demarree : ' + String(cmd).slice(0, 200);
            if (extra) reason += ' [diagnostic : ' + extra + ']';
        }
        return { short: 'script non execute', reason };
    }
    const ran = Object.keys(parsed || {}).length;
    return { short: 'etape non executee',
        reason: "etape non executee : le script s'est interrompu (" + ran + ' etape(s) terminee(s) avant)' +
            (lastLog ? ' - dernieres lignes : ' + lastLog : '') };
}

// -- main API -----------------------------------------------------------------------------------------
/**
 * Fix a list of tool issues sequentially (7d). deps:
 * { platform, execFn, hasInternet, askElevation(text)->bool, audit(action,detail,result),
 *   offlineDir, onProgress({index,total,issue,phase,row}), installTimeoutMs,
 *   techLog } - techLog is an optional TechLogger (P21-g structured journal).
 * Returns { rows:[{issue,status,reason,method}], terminalCmd } - terminalCmd is set
 * only for the non-Windows no-sudo fallback (the panel shows it in a terminal).
 */
async function fixAll(issues, deps) {
    deps = deps || {};
    const platform = deps.platform || process.platform;
    const execFn = deps.execFn || defaultExec;
    const audit = deps.audit || defaultAudit;
    const tech = deps.techLog || null;
    const tlog = (level, msg, fields) => { // P21-g: structured tech journal (never breaks fixes)
        if (!tech) return;
        try {
            const fn = tech[level] ? tech[level].bind(tech) : tech.info.bind(tech);
            fn(msg, fields || {});
        } catch (_) { /* ignore */ }
    };
    const onProgress = deps.onProgress || (() => {});
    const dry = !!deps.dryRun; // P36: plan only, never execute
    const offlineDir = deps.offlineDir || defaultOfflineDir();
    const installTimeout = deps.installTimeoutMs || DEFAULT_INSTALL_TIMEOUT_MS;
    const isWin = platform === 'win32';

    const base = orderIssues(issues);
    // Auto-include missing dependencies (pip pulls Python) so single-issue
    // runs still converge instead of stopping on a missing dep.
    const ordered = [...base];
    for (const i of base) {
        const d = FIXES[i] && FIXES[i].dependsOn;
        if (d && !ordered.includes(d)) ordered.unshift(d);
    }
    const rows = [];
    let dockerPrereq = ''; // P40-e: computed after PLAN, appended by push
    const push = (row) => {
        // P40-e: Docker install attempts always carry the prereq announcement
        // (final table + audit; live progress toasts may predate it).
        if (row.issue === 'Docker' && dockerPrereq && (row.method === 'winget' || row.method === 'offline')) {
            row.reason += ' (' + dockerPrereq + ')';
        }
        rows.push(row);
        audit(row.status === 'fixed' ? 'AUTOFIX_OK' : row.status === 'restart' ? 'AUTOFIX_RESTART'
            : row.status === 'manual' ? 'AUTOFIX_MANUAL' : 'AUTOFIX_FAIL',
            row.issue + ' [' + (row.method || 'none') + '] ' + row.reason,
            row.status === 'fixed' ? 'ok' : row.status);
    };
    const progress = (index, issue, phase, row) => {
        try { onProgress({ index, total: ordered.length, issue, phase, row: row || null }); } catch (_) {}
    };

    if (!ordered.length) return { rows, terminalCmd: null };
    audit('AUTOFIX_START', 'Problemes: ' + ordered.join(', '), 'ok');

    // P40-d: online/offline from a REAL winget-source probe (or the injected test).
    let online = false;
    let probeDetail = 'test fourni (panneau/test)';
    try {
        if (deps.hasInternet) {
            online = !!(await deps.hasInternet());
        } else {
            const p = await probeWingetSource();
            online = p.ok;
            probeDetail = p.detail;
        }
    } catch (_) { online = false; probeDetail = 'sonde en erreur'; }

    // Plan each issue: method + command (or immediate manual/failed row).
    const plan = [];
    // P19-b pre-detection: journaled, never silent.
    let wingetPresent = false;
    let wingetText = 'non teste';
    if (isWin && online && !dry) {
        try {
            const w = await execFn('winget --version', { timeout: 15000 });
            wingetPresent = w.code === 0;
            wingetText = wingetPresent ? String(w.stdout || '').trim().split('\n')[0].slice(0, 120)
                : 'absent (code ' + w.code + ')';
        } catch (e) { wingetPresent = false; wingetText = 'absent (' + (e && e.message ? e.message : 'erreur') + ')'; }
    } else if (isWin) {
        wingetText = 'non teste (hors ligne)';
    }
    // P40-b: journal the execution policy on every real Windows run (prime
    // suspect when an elevated step never starts). Gated by !dry (P36).
    let policyText = 'non testee';
    if (isWin && !dry) {
        try {
            const p = await execFn(
                'powershell -NoProfile -Command "Get-ExecutionPolicy -List | ForEach-Object { $_.Scope + \'=\' + $_.ExecutionPolicy }"',
                { timeout: 15000 });
            policyText = (p.code === 0 && p.stdout.trim())
                ? p.stdout.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join('; ').slice(0, 300)
                : 'illisible (code ' + p.code + ')';
        } catch (e) { policyText = 'sonde impossible (' + String((e && e.message) || e).slice(0, 80) + ')'; }
    }
    let offlineList = 'dossier absent';
    try {
        if (fs.existsSync(offlineDir)) {
            const names = fs.readdirSync(offlineDir).filter((n) => !n.endsWith('.sha256'));
            offlineList = names.length ? names.length + ' fichier(s) : ' + names.slice(0, 12).join(', ') : 'dossier vide';
        }
    } catch (e) { offlineList = 'illisible (' + (e && e.message ? e.message : '?') + ')'; }
    audit('AUTOFIX_PRECHECK', 'winget=[' + wingetText + '] reseau=' + (online ? 'oui' : 'non') +
        ' (' + probeDetail + ') politique=[' + policyText + ']' +
        ' installateurs=[' + offlineDir + '] ' + offlineList,
        (wingetPresent || !isWin || !online) ? 'ok' : 'missing');
    tlog('info', 'precheck', { winget: wingetText, online, probeDetail, policy: policyText, offlineDir, offlineList, wingetPresent });
    for (const issue of ordered) {
        const f = resolveFix(issue);
        const checkCmd = isWin ? f.check.win : f.check.posix;
        const fbCmd = f.checkFallback ? (isWin ? f.checkFallback.win : f.checkFallback.posix) : null;
        // pip via ensurepip (works offline, no elevation).
        if (f.ensurepip) {
            const pyIssue = f.dependsOn;
            plan.push({ issue, kind: 'ensurepip', dep: pyIssue,
                cmd: isWin ? f.ensurepip.win : f.ensurepip.posix, checkCmd, fbCmd, fix: f,
                sudo: !isWin && platform !== 'darwin' });
            continue;
        }
        if (online && (!isWin || wingetPresent)) {
            if (isWin) {
                plan.push({ issue, kind: 'winget', cmd: wingetCmd(f.winget.id), checkCmd, fbCmd, fix: f });
            } else if (platform === 'darwin' && f.brew) {
                plan.push({ issue, kind: 'brew', cmd: 'brew install ' + f.brew, checkCmd, fbCmd, fix: f, sudo: false });
            } else if (f.apt) {
                plan.push({ issue, kind: 'apt', cmd: 'sudo apt-get install -y ' + f.apt, checkCmd, fbCmd, fix: f, sudo: true });
            } else {
                plan.push({ issue, kind: 'manual-docker-posix', fix: f });
            }
            continue;
        }
        // Offline (or winget missing): installer folder + SHA-256 sidecar.
        if (!isWin) {
            plan.push({ issue, kind: 'manual-offline-posix', fix: f });
            continue;
        }
        const file = path.join(offlineDir, f.offline.file);
        if (!fs.existsSync(file)) {
            if (online && !wingetPresent) {
                plan.push({ issue, kind: 'manual-missing', fix: f,
                    reason: "winget absent : importez '" + f.offline.file + "' (installateur " + issue + ") dans : " + offlineDir });
            } else {
                plan.push({ issue, kind: 'manual-missing', fix: f,
                    reason: 'hors ligne et installateur hors ligne manquant : ' + f.offline.file + ' attendu dans ' + offlineDir });
            }
            continue;
        }
        const sidecar = file + '.sha256';
        if (!fs.existsSync(sidecar)) {
            plan.push({ issue, kind: 'manual-sidecar', fix: f,
                reason: "somme SHA-256 manquante pour " + f.offline.file + " (" + f.offline.file + ".sha256 attendu dans " + offlineDir + ")" });
            continue;
        }
        let digest = '';
        try { digest = String(fs.readFileSync(sidecar, 'utf8')).trim().split(/\s+/)[0] || ''; }
        catch (_) { digest = ''; }
        if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
            plan.push({ issue, kind: 'manual-sidecar', fix: f,
                reason: "somme SHA-256 illisible pour " + f.offline.file + " (fichier " + f.offline.file + ".sha256 invalide)" });
            continue;
        }
        let actual = '';
        try { actual = await sha256File(file); }
        catch (e) {
            plan.push({ issue, kind: 'failed-hash', fix: f, reason: "lecture impossible de " + f.offline.file + " : " + e.message });
            continue;
        }
        if (actual.toLowerCase() !== digest.toLowerCase()) {
            plan.push({ issue, kind: 'failed-hash', fix: f,
                reason: "SHA-256 invalide pour " + f.offline.file + " (atteinte refusee, fichier non execute)" });
            continue;
        }
        plan.push({ issue, kind: 'offline', cmd: offlineCmd(file, f.offline.kind, f.offline.args), checkCmd, fbCmd, fix: f });
    }

    audit('AUTOFIX_PLAN', 'mode=' + (online ? 'online' : 'offline') + ' etapes=' +
        plan.filter((p) => p.cmd).map((p) => p.issue + ':' + p.kind).join(', '), 'ok');

    // P40-e: Docker prerequisites announced up front (virtualization, WSL2,
    // likely reboot). Gated by !dry like every other probe.
    if (isWin && !dry && plan.some((p) => p.issue === 'Docker' && p.cmd)) {
        const virt = await virtualizationEnabled(execFn);
        const wsl = await wslPresent(execFn);
        const virtTxt = virt === null ? 'inconnue' : (virt ? 'oui' : 'non');
        dockerPrereq = 'prerequis Docker : virtualisation=' + virtTxt + ', WSL2=' + wsl.text +
            ' ; redemarrage requis (probable) pour finaliser';
        audit('AUTOFIX_PREREQ', 'Docker : virtualisation=' + virtTxt + ' wsl2=' + wsl.text +
            ' redemarrage requis (probable)', virt === false ? 'missing' : 'ok');
        tlog(virt === false ? 'warn' : 'info', 'prereq', { issue: 'Docker', virtualization: virtTxt, wsl2: wsl.text });
    }

    // Immediate rows (no execution needed).
    const immediate = (p) => {
        if (p.kind === 'manual-missing' || p.kind === 'manual-sidecar') return { issue: p.issue, status: 'manual', reason: p.reason, method: 'offline' };
        if (p.kind === 'failed-hash') return { issue: p.issue, status: 'failed', reason: p.reason, method: 'offline' };
        if (p.kind === 'manual-docker-posix') {
            return { issue: p.issue, status: 'manual', method: 'none',
                reason: platform === 'darwin'
                    ? 'Docker Desktop sur macOS : installez-le depuis le .dmg officiel puis relancez le diagnostic'
                    : 'Docker sur Linux : installez docker via le depot officiel puis ajoutez votre user au groupe docker' };
        }
        if (p.kind === 'manual-offline-posix') {
            return { issue: p.issue, status: 'manual', method: 'none',
                reason: 'hors ligne : reconnectez-vous a Internet puis relancez AutoFix (' + p.issue + ')' };
        }
        return null;
    };

    // P36: dry-run returns the plan here; nothing below this line executes.
    if (dry) {
        const planned = plan.map((p) => ({ issue: p.issue, kind: p.kind,
            cmd: p.cmd || null, reason: p.reason || null }));
        audit('AUTOFIX_DRYRUN', 'Problemes: ' + ordered.join(', ') + ' (simulation)', 'ok');
        tlog('info', 'dry-run plan', { planned });
        const firstCmd = (plan.filter((p) => !!p.cmd)[0] || {}).cmd || null;
        return { rows: planned.map((p) => ({ issue: p.issue, status: 'dry-run',
            method: p.kind, reason: p.cmd || p.reason || 'plan only', cmd: p.cmd })),
            terminalCmd: firstCmd, dryRun: true, planned };
    }
    const runnable = plan.filter((p) => !!p.cmd);
    const results = {}; // issue -> { code } from batch execution

    if (runnable.length) {
        if (isWin) {
            // Single elevation gate (7b), then ONE script for all steps.
            const needAdmin = true; // machine-wide silent installs
            let elevated = false;
            if (needAdmin && !(await isWindowsAdmin(execFn))) {
                const names = runnable.map((p) => p.issue + ' (' + p.kind + ')').join(', ');
                let granted = false;
                try {
                    granted = deps.askElevation
                        ? !!(await deps.askElevation(
                            "AutoFix doit installer des outils systeme : " + names + ". " +
                            "Une seule elevation administrateur (UAC) est demandee pour tout installer d'un coup."))
                        : false;
                } catch (_) { granted = false; }
                audit('AUTOFIX_ELEVATION', granted ? 'elevation accordee' : 'elevation refusee', granted ? 'ok' : 'refused');
                tlog(granted ? 'info' : 'warn', 'elevation', { granted, issues: runnable.map((p) => p.issue) });
                if (!granted) {
                    for (const p of runnable) {
                        progress(ordered.indexOf(p.issue), p.issue, 'done');
                        push({ issue: p.issue, status: 'manual', method: p.kind, reason: "droits administrateur refuses" });
                    }
                    return finish();
                }
                elevated = true;
            }
            const tag = 'autofix-' + process.pid + '-' + Date.now();
            // P40-a: NO script file (policies/AV/GPO kept blocking the temp
            // .ps1 after a granted UAC). The batch goes through
            // -EncodedCommand; the journal is created BEFORE elevation in a
            // folder both levels can reach (deps.logDir overrides in tests).
            const logDir = deps.logDir || defaultElevatedLogDir();
            try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
            const logFile = path.join(logDir, tag + '.log');
            try { fs.writeFileSync(logFile, '', 'utf8'); } catch (_) {}
            audit('AUTOFIX_LOGDIR', logFile, 'ok');
            const steps = runnable.map((p, i) => ({ id: 'S' + i, cmd: p.cmd }));
            const byId = {};
            runnable.forEach((p, i) => { byId['S' + i] = p; });
            const b64 = buildEncodedLaunch(buildPsScript(steps, logFile));
            let launch;
            const tLaunch0 = Date.now();
            launch = await execFn(encodedLauncher(elevated, b64), { timeout: installTimeout });
            launch = launch || {};
            // P44-2: empty journal right after a code-0 launch proves
            // nothing yet: settle up to journalSettleMs (default 5 s) for
            // START. Skipped when the launch itself failed (code != 0:
            // nothing can appear later). batchMs honestly covers the wait.
            const settleMs = launch.code === 0
                ? (deps.journalSettleMs !== undefined ? deps.journalSettleMs : 5000)
                : 0;
            const settled = await readJournalSettled(logFile, settleMs);
            const launchMs = Date.now() - tLaunch0;
            const logText = settled.text;
            const logRead = settled.logRead;
            const parsed = parsePsLog(logText);
            const stepOuts = parsePsStepOutputs(logText);
            try { fs.unlinkSync(logFile); } catch (_) {}
            // P40-b: granted UAC but the child wrote NOTHING: run the precise
            // no-start diagnostics once (policy, winget, Defender).
            let noStartDiag = '';
            if (elevated && launch.code === 0 && !/START/.test(String(logText || ''))) {
                try { noStartDiag = await diagnoseElevatedNoStart(execFn); }
                catch (e) { noStartDiag = 'diagnostic impossible (' + String((e && e.message) || e).slice(0, 80) + ')'; }
                audit('AUTOFIX_NOSTART', 'etapes non demarrees : ' +
                    runnable.map((p) => p.issue + ':' + p.kind).join(', ') + ' | ' + noStartDiag, 'fail');
                tlog('warn', 'no-start', { batchMs: launchMs, diag: noStartDiag });
            }
            if (elevated && launch.code !== 0 && Object.keys(parsed).length === 0) {
                // UAC prompt itself refused/cancelled: nothing ran.
                audit('AUTOFIX_ELEVATION', 'UAC refusee (code ' + launch.code + ')' +
                    (launch.stderr ? ' : ' + tail(launch.stderr, 3) : ''), 'refused');
                tlog('warn', 'elevation', { granted: false, uacRefused: true, code: launch.code,
                    issues: runnable.map((p) => p.issue), out: tail(launch.stderr || '', 3) });
                for (const p of runnable) {
                    progress(ordered.indexOf(p.issue), p.issue, 'done');
                    push({ issue: p.issue, status: 'manual', method: p.kind, reason: "elevation UAC refusee" });
                }
                return finish();
            }
            for (const [id, p] of Object.entries(byId)) {
                const has = Object.prototype.hasOwnProperty.call(parsed, id);
                const full = stepOuts[id] || '';
                // P19-a: journal EVERY step (exact cmd, code, last-30 output, duration, elevation).
                const entry = has
                    ? { code: parsed[id], out: full ? tail(full, 5) : (launch.stderr ? tail(launch.stderr, 3) : '') }
                    : { code: null, out: '', cause: diagnoseMissingStep(launchMs, launch, logText, logRead, parsed, p.kind, noStartDiag || null, p.cmd) };
                results[p.issue] = entry;
                audit('AUTOFIX_STEP', p.issue + ' [' + p.kind + '] elevation=' + (elevated ? 'accordee' : 'non requise') +
                    ' code=' + (has ? parsed[id] : 'aucun (' + entry.cause.short + ')') +
                    ' lot_ms=' + launchMs + ' cmd=' + p.cmd +
                    (full ? '\n' + tail30(full, '') : (launch.stderr ? '\n(lancement) ' + tail(launch.stderr, 3) : '')),
                    has ? (parsed[id] === 0 ? 'ok' : 'fail') : 'fail');
                tlog(has && parsed[id] === 0 ? 'info' : 'warn', 'step', { issue: p.issue, kind: p.kind, cmd: p.cmd,
                    code: has ? parsed[id] : null, batchMs: launchMs, elevated,
                    cause: has ? null : entry.cause.short, out: full ? tail30(full, '') : tail(launch.stderr || '', 3) });
            }
        } else {
            // Non-Windows: headless when no password needed, else ONE terminal command.
            const needSudo = runnable.some((p) => p.sudo);
            let canHeadless = true;
            if (needSudo) canHeadless = await hasPasswordlessSudo(execFn);
            if (!canHeadless) {
                const chained = runnable.map((p) => p.cmd).join(' && ');
                for (const p of runnable) {
                    progress(ordered.indexOf(p.issue), p.issue, 'done');
                    push({ issue: p.issue, status: 'manual', method: 'terminal',
                        reason: "sudo requis : commande lancee dans le terminal - relancez le diagnostic apres" });
                }
                audit('AUTOFIX_TERMINAL', chained.slice(0, 300), 'ok');
                const out = finish();
                out.terminalCmd = chained;
                return out;
            }
            for (const p of runnable) {
                progress(ordered.indexOf(p.issue), p.issue, 'start');
                const cmd = (p.sudo && !/^sudo\b/.test(p.cmd)) ? 'sudo ' + p.cmd : p.cmd;
                const t0 = Date.now();
                const r = await execFn(cmd, { timeout: installTimeout });
                const ms = Date.now() - t0;
                results[p.issue] = { code: r.code, out: tail(r.stdout + '\n' + r.stderr) };
                audit('AUTOFIX_STEP', p.issue + ' [' + p.kind + '] elevation=' + (p.sudo ? 'sudo' : 'non requise') +
                    ' code=' + r.code + ' duree_ms=' + ms + ' cmd=' + cmd + '\n' + tail30(r.stdout, r.stderr),
                    r.code === 0 ? 'ok' : 'fail');
                tlog(r.code === 0 ? 'info' : 'warn', 'step', { issue: p.issue, kind: p.kind, cmd,
                    code: r.code, durationMs: ms, sudo: !!p.sudo, out: tail30(r.stdout, r.stderr) });
                progress(ordered.indexOf(p.issue), p.issue, 'done');
            }
        }
    }

    // Verify every executed step sequentially (7c): PATH refresh + --version.
    for (const p of plan) {
        const imm = immediate(p);
        if (imm) {
            progress(ordered.indexOf(p.issue), p.issue, 'done', imm);
            push(imm);
            continue;
        }
        // Dependency first (pip needs Python): if the dep row is not fixed, stop here.
        if (p.dep) {
            const depRow = rows.find((r) => r.issue === p.dep);
            if (!depRow || depRow.status !== 'fixed') {
                const row = { issue: p.issue, status: 'manual', method: p.kind,
                    reason: p.dep + " requis : corrigez " + p.dep + " d'abord (statut " + (depRow ? depRow.status : 'absent') + ")" };
                progress(ordered.indexOf(p.issue), p.issue, 'done', row);
                push(row);
                continue;
            }
        }
        progress(ordered.indexOf(p.issue), p.issue, 'verify');
        const res = results[p.issue] || { code: null };
        if (res.code === null || res.code === undefined) {
            const cause = res.cause && res.cause.reason ? res.cause.reason
                : ("resultat manquant pour " + p.kind + " (pas de marqueur DONE)" + (res.out ? ' : ' + res.out : ''));
            const row = { issue: p.issue, status: 'failed', method: p.kind, reason: cause };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        await refreshPath(execFn, platform, (p.fix && p.fix.pathHints) || []);
        const tV0 = Date.now();
        const v = await verifyCheck(execFn, p.checkCmd, p.fbCmd, DEFAULT_VERIFY_TIMEOUT_MS);
        audit('AUTOFIX_STEP', p.issue + ' [' + p.kind + ':verification] elevation=non requise' +
            ' code=' + (v.ok ? 0 : 1) + ' duree_ms=' + (Date.now() - tV0) + ' cmd=' + p.checkCmd +
            (p.fbCmd ? ' (secours : ' + p.fbCmd + ')' : '') + '\n' + String(v.output || '').slice(0, 2000),
            v.ok ? 'ok' : 'fail');
        tlog(v.ok ? 'info' : 'warn', 'verify', { issue: p.issue, kind: p.kind, checkCmd: p.checkCmd,
            fbCmd: p.fbCmd || null, ok: v.ok, durationMs: Date.now() - tV0, output: String(v.output || '').slice(0, 2000) });
        const vtxt = v.ok ? v.output : v.output;
        if (RESTART_CODES[res.code]) {
            const row = { issue: p.issue, status: 'restart', method: p.kind,
                reason: "installe (code " + res.code + ") mais redemarrage requis pour finaliser" + (v.ok ? " - verifie : " + vtxt : "") };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        if (res.code !== 0) {
            // P44-3: 9009 on a winget step = the step never ran (winget
            // missing from the child PATH, e.g. Win10 without App
            // Installer, or truncated journal): point at the offline
            // folder with the exact filename, like the plan-time message.
            let hint9009 = '';
            if (res.code === 9009 && p.kind === 'winget' && p.fix && p.fix.offline) {
                hint9009 = " : winget probablement absent pendant l'execution - importez '" +
                    p.fix.offline.file + "' (installateur " + p.issue + ") dans : " + offlineDir;
            }
            const row = { issue: p.issue, status: 'failed', method: p.kind,
                reason: "installation echouee (code " + res.code + ")" + hint9009 + (res.out && !hint9009 ? " : " + res.out : "") };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        if (v.ok) {
            const row = { issue: p.issue, status: 'fixed', method: p.kind, reason: "verifie : " + vtxt };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        // Installed but --version fails: Docker gets a virtualization post-check.
        if (p.fix && p.fix.needsVirtualization && isWin) {
            const virt = await virtualizationEnabled(execFn);
            if (virt === false) {
                const row = { issue: p.issue, status: 'manual', method: p.kind,
                    reason: "virtualisation desactivee dans le BIOS/UEFI (requise par Docker Desktop) - activez-la puis relancez" };
                progress(ordered.indexOf(p.issue), p.issue, 'done', row);
                push(row);
                continue;
            }
        }
        const row = { issue: p.issue, status: 'failed', method: p.kind,
            reason: "verification echouee apres installation : " + vtxt };
        progress(ordered.indexOf(p.issue), p.issue, 'done', row);
        push(row);
    }

    function finish() {
        const c = { fixed: 0, failed: 0, restart: 0, manual: 0 };
        for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
        audit('AUTOFIX_DONE', "corriges=" + c.fixed + " echecs=" + c.failed + " redemarrage=" + c.restart + " manuels=" + c.manual, 'ok');
        return { rows, terminalCmd: null };
    }
    return finish();
}

async function fixOne(issue, deps) {
    const r = await fixAll([issue], deps);
    const row = (r.rows || []).find((x) => x.issue === issue) || r.rows[0] ||
        { issue, status: 'manual', reason: 'correctif inconnu', method: 'none' };
    return { row, rows: r.rows || [], terminalCmd: r.terminalCmd || null };
}

module.exports = { fixAll, fixOne, isKnownTool, orderIssues, resolveFix, buildPsScript, parsePsLog,
    parsePsStepOutputs, diagnoseMissingStep, defaultOfflineDir, FIXES,
    buildEncodedLaunch, decodeEncodedLaunch, encodedLauncher, defaultElevatedLogDir, probeWingetSource,
    defaultHasInternet, diagnoseElevatedNoStart, wslPresent, readJournalSettled };
