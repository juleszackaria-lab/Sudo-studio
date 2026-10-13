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

function defaultHasInternet() {
    const dns = require('dns');
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3000);
        dns.resolve('winget.microsoft.com', () => {
            if (!done) { done = true; clearTimeout(t); resolve(true); }
        });
    });
}

function defaultAudit() { /* wired by the panel */ }

// -- helpers -------------------------------------------------------------------------------
function tail(s, n) {
    const lines = String(s || '').trim().split('\n');
    return lines.slice(-(n || 3)).join(' | ').slice(0, 300);
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
    L.push('function L($s) { Add-Content -Path $log -Value $s }');
    L.push("L 'START'");
    for (const s of steps) {
        L.push('L ' + psQuote('STEP ' + s.id));
        L.push(s.cmd);
        L.push("L ('DONE " + s.id + " code=' + $LASTEXITCODE)");
    }
    L.push("L 'END'");
    return L.join('\r\n');
}

function parsePsLog(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/DONE (\S+) code=(-?\d+)/);
        if (m) out[m[1]] = parseInt(m[2], 10);
    }
    return out;
}

// -- main API -----------------------------------------------------------------------------------------
/**
 * Fix a list of tool issues sequentially (7d). deps:
 * { platform, execFn, hasInternet, askElevation(text)->bool, audit(action,detail,result),
 *   offlineDir, onProgress({index,total,issue,phase,row}), installTimeoutMs }
 * Returns { rows:[{issue,status,reason,method}], terminalCmd } - terminalCmd is set
 * only for the non-Windows no-sudo fallback (the panel shows it in a terminal).
 */
async function fixAll(issues, deps) {
    deps = deps || {};
    const platform = deps.platform || process.platform;
    const execFn = deps.execFn || defaultExec;
    const audit = deps.audit || defaultAudit;
    const onProgress = deps.onProgress || (() => {});
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
    const push = (row) => {
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

    let online = false;
    try { online = (deps.hasInternet || defaultHasInternet)(); online = online && typeof online.then === 'function' ? await online : !!online; }
    catch (_) { online = false; }

    // Plan each issue: method + command (or immediate manual/failed row).
    const plan = [];
    let wingetPresent = false;
    if (isWin && online) {
        try { wingetPresent = (await execFn('winget --version', { timeout: 15000 })).code === 0; }
        catch (_) { wingetPresent = false; }
    }
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
            const why = online && !wingetPresent ? 'winget introuvable et ' : 'hors ligne et ';
            plan.push({ issue, kind: 'manual-missing', fix: f,
                reason: why + "installateur hors ligne manquant : " + f.offline.file + " attendu dans " + offlineDir });
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
            const scriptFile = path.join(os.tmpdir(), tag + '.ps1');
            const logFile = path.join(os.tmpdir(), tag + '.log');
            try { fs.writeFileSync(logFile, '', 'utf8'); } catch (_) {}
            const steps = runnable.map((p, i) => ({ id: 'S' + i, cmd: p.cmd }));
            const byId = {};
            runnable.forEach((p, i) => { byId['S' + i] = p; });
            try { fs.writeFileSync(scriptFile, buildPsScript(steps, logFile), 'utf8'); }
            catch (e) {
                for (const p of runnable) push({ issue: p.issue, status: 'failed', method: p.kind, reason: "script temporaire impossible : " + e.message });
                return finish();
            }
            let launch;
            if (elevated) {
                launch = await execFn('powershell -NoProfile -Command ' +
                    psQuote('Start-Process powershell -Verb RunAs -Wait -ArgumentList ' +
                        psQuote('-NoProfile -ExecutionPolicy Bypass -File ' + psQuote(scriptFile))),
                    { timeout: installTimeout });
            } else {
                launch = await execFn('powershell -NoProfile -ExecutionPolicy Bypass -File ' + psQuote(scriptFile),
                    { timeout: installTimeout });
            }
            let parsed = {};
            try { parsed = parsePsLog(fs.readFileSync(logFile, 'utf8')); } catch (_) { parsed = {}; }
            try { fs.unlinkSync(scriptFile); } catch (_) {}
            try { fs.unlinkSync(logFile); } catch (_) {}
            if (elevated && launch.code !== 0 && Object.keys(parsed).length === 0) {
                // UAC prompt itself refused/cancelled: nothing ran.
                audit('AUTOFIX_ELEVATION', 'UAC refusee (code ' + launch.code + ')', 'refused');
                for (const p of runnable) {
                    progress(ordered.indexOf(p.issue), p.issue, 'done');
                    push({ issue: p.issue, status: 'manual', method: p.kind, reason: "elevation UAC refusee" });
                }
                return finish();
            }
            for (const [id, p] of Object.entries(byId)) {
                results[p.issue] = Object.prototype.hasOwnProperty.call(parsed, id)
                    ? { code: parsed[id] } : { code: null };
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
                const r = await execFn(cmd, { timeout: installTimeout });
                results[p.issue] = { code: r.code, out: tail(r.stdout + '\n' + r.stderr) };
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
            const row = { issue: p.issue, status: 'failed', method: p.kind, reason: "etape interrompue (aucun resultat)" };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        await refreshPath(execFn, platform, (p.fix && p.fix.pathHints) || []);
        const v = await verifyCheck(execFn, p.checkCmd, p.fbCmd, DEFAULT_VERIFY_TIMEOUT_MS);
        const vtxt = v.ok ? v.output : v.output;
        if (RESTART_CODES[res.code]) {
            const row = { issue: p.issue, status: 'restart', method: p.kind,
                reason: "installe (code " + res.code + ") mais redemarrage requis pour finaliser" + (v.ok ? " - verifie : " + vtxt : "") };
            progress(ordered.indexOf(p.issue), p.issue, 'done', row);
            push(row);
            continue;
        }
        if (res.code !== 0) {
            const row = { issue: p.issue, status: 'failed', method: p.kind,
                reason: "installation echouee (code " + res.code + ")" + (res.out ? " : " + res.out : "") };
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
    defaultOfflineDir, FIXES };
