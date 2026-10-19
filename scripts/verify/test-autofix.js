/**
 * SUDO STUDIO - P36(c) functional test: AutoFix (on INSTALLED files).
 *
 * Uses the INSTALLED extension engine (EXT_DIR/src/doctor/autoFix.js).
 * NOTHING is really installed: all subprocess calls go through an injected
 * stub execFn that only records its arguments.
 *
 * Asserts:
 *  1. dry-run plans WITHOUT executing (0 exec calls), rows status 'dry-run',
 *     journal holds the planned commands, AUTOFIX_DRYRUN audited
 *  2. stubbed execution journals commands + exit codes + outputs
 *     (tech 'step'/'verify' entries, AUTOFIX_STEP/AUTOFIX_DONE audits)
 *  3. the engine can NEVER open a browser (static check: no open call)
 *  4. unknown tools resolve to null (never a blind command)
 *
 * Usage: node test-autofix.js [--ext <dir>]
 * Exit: 0 = all PASS, 1 = any FAIL. Prints one JSON report on stdout.
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function makeStubs() {
    const execCalls = [];
    const audits = [];
    const tech = [];
    return {
        execCalls, audits, tech,
        execFn: async (cmd, opts) => {
            execCalls.push(String(cmd));
            return { code: 0, stdout: 'v99.0.0-teststub', stderr: '' };
        },
        audit: (action, detail) => audits.push({ a: String(action), d: String(detail || '') }),
        techLog: {
            info: (msg, fields) => tech.push({ level: 'info', msg: String(msg), fields: fields || {} }),
            warn: (msg, fields) => tech.push({ level: 'warn', msg: String(msg), fields: fields || {} }),
        },
    };
}

(async () => {
    let af;
    try {
        af = require(path.join(EXT_DIR, 'src', 'doctor', 'autoFix.js'));
        check('autofix-module-loads', true, 'from installed files');
    } catch (e) {
        check('autofix-module-loads', false, String((e && e.message) || e).slice(0, 200));
        console.log(JSON.stringify({ suite: 'p36-autofix', extDir: EXT_DIR, checks }, null, 2));
        process.exit(1);
    }

    // Pick a real known tool with an online installer for this assertion set.
    // resolveFix is pure (no execution), so probing candidates is free.
    const candidates = ['Git', 'Node.js', 'Python', 'npm'];
    let tool = null;
    for (const c of candidates) {
        const f = af.resolveFix(c);
        if (f && (f.apt || (f.winget && f.winget.id))) { tool = c; break; }
    }
    check('known-tool-resolves', !!tool, tool ? ('using ' + tool) : 'no installable tool found');

    // 4. unknown tool: null, never a blind command
    const unk = af.resolveFix('DefinitelyNotATool-zzz');
    check('unknown-tool-null', unk === null && af.isKnownTool('DefinitelyNotATool-zzz') === false,
        unk === null ? 'resolveFix=null' : 'resolved?!');

    if (tool) {
        // 1a. dry-run, offline Windows flavour: zero execution
        const s1 = makeStubs();
        const d1 = await af.fixAll([tool], {
            platform: 'win32', hasInternet: () => false,
            offlineDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p36-af-')), 'empty'),
            execFn: s1.execFn, audit: s1.audit, techLog: s1.techLog, dryRun: true,
        });
        const dryRows = (d1.rows || []).every((r) => r.status === 'dry-run');
        check('dryrun-zero-exec', s1.execCalls.length === 0,
            'exec calls=' + s1.execCalls.length);
        check('dryrun-rows-marked', dryRows && (d1.rows || []).length > 0,
            (d1.rows || []).map((r) => r.issue + ':' + r.status + ':' + r.method).join(','));
        check('dryrun-audited', s1.audits.some((x) => x.a === 'AUTOFIX_DRYRUN'),
            s1.audits.map((x) => x.a).join(','));
        check('dryrun-journaled', s1.tech.some((t) => t.msg === 'dry-run plan'),
            s1.tech.map((t) => t.msg).join(','));

        // 1b. dry-run, online Linux flavour: a runnable command is PLANNED (not run)
        const s2 = makeStubs();
        const d2 = await af.fixAll([tool], {
            platform: 'linux', hasInternet: () => true,
            execFn: s2.execFn, audit: s2.audit, techLog: s2.techLog, dryRun: true,
        });
        const plannedCmds = (d2.planned || []).map((p) => p.cmd || '').join(' ');
        check('dryrun-plans-command', s2.execCalls.length === 0 && /apt-get|brew|winget/.test(plannedCmds),
            'exec=0 planned=[' + plannedCmds.slice(0, 120) + '] terminal=' + String(d2.terminalCmd || 'null').slice(0, 80));

        // 2. stubbed execution: journal holds commands + codes + outputs
        const s3 = makeStubs();
        const r3 = await af.fixAll([tool], {
            platform: 'linux', hasInternet: () => true,
            installTimeoutMs: 30000,
            execFn: s3.execFn, audit: s3.audit, techLog: s3.techLog,
        });
        const step = s3.tech.filter((t) => t.msg === 'step');
        const verify = s3.tech.filter((t) => t.msg === 'verify');
        const stepOk = step.length > 0 && step.every((t) =>
            typeof t.fields.cmd === 'string' && typeof t.fields.code === 'number' &&
            typeof t.fields.out === 'string');
        const verifyOk = verify.length > 0 && verify.every((t) =>
            typeof t.fields.checkCmd === 'string' && typeof t.fields.output === 'string' &&
            typeof t.fields.ok === 'boolean');
        check('exec-runs-stub', s3.execCalls.length > 0,
            s3.execCalls.length + ' stubbed call(s): ' + s3.execCalls.slice(0, 3).join(' | ').slice(0, 160));
        check('journal-step-cmd-code-out', stepOk,
            step.length ? JSON.stringify(step[0].fields).slice(0, 200) : 'no step entry');
        check('journal-verify-cmd-output', verifyOk,
            verify.length ? JSON.stringify(verify[0].fields).slice(0, 200) : 'no verify entry');
        const stepAudits = s3.audits.filter((x) => x.a === 'AUTOFIX_STEP');
        check('audit-step-verify', stepAudits.length >= 2 &&
            stepAudits.some((x) => x.d.indexOf('code=') !== -1) &&
            s3.audits.some((x) => x.a === 'AUTOFIX_DONE'),
            s3.audits.map((x) => x.a).join(',') + ' stepDetails=' +
            (stepAudits[0] ? stepAudits[0].d.slice(0, 100) : 'none'));
        check('exec-status-recorded', true, 'row status=' +
            ((r3.rows || []).map((r) => r.status).join(',') || 'none') + ' (stub, informational)');
    }

    // 3. the engine can never open a browser (static: no open call exists)
    try {
        const src = fs.readFileSync(path.join(EXT_DIR, 'src', 'doctor', 'autoFix.js'), 'utf8');
        // URL-opening calls only (the legit UAC elevation 'Start-Process
        // powershell -Verb RunAs' is an installer launch, not a browser).
        const bad = ['openExternal', 'xdg-open', 'cmd /c start', 'Start-Process http',
            'start ""', 'open(\'http', 'open("http'].filter((p) => src.indexOf(p) !== -1);
        check('never-opens-browser', bad.length === 0,
            bad.length ? ('found: ' + bad.join(',')) : 'no URL-open call in engine');
    } catch (e) {
        check('never-opens-browser', false, String((e && e.message) || e).slice(0, 120));
    }

    console.log(JSON.stringify({ suite: 'p36-autofix', extDir: EXT_DIR, checks }, null, 2));
    process.exit(checks.some((c) => c.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => {
    check('harness-no-crash', false, String((e && e.message) || e).slice(0, 200));
    console.log(JSON.stringify({ suite: 'p36-autofix', extDir: EXT_DIR, checks }, null, 2));
    process.exit(1);
});
