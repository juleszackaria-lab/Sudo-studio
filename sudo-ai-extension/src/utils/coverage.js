/**
 * SUDO STUDIO - Real test-coverage measurement (TASK 7d).
 * Runs the project's own toolchain (c8 / coverage.py / flutter) and parses
 * REAL output. Never invents a percentage: when nothing can be measured,
 * returns { measured: false, reason }.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { exec } = require('child_process');

function run(cmd, opts = {}) {
    return new Promise(resolve => {
        exec(cmd, { timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err && err.code });
        });
    });
}

// -- project detection -------------------------------------------------------
function detectCandidates(wsRoot) {
    const cands = [];
    if (!wsRoot) return cands;
    const has = f => { try { return fs.existsSync(path.join(wsRoot, f)); } catch { return false; } };
    if (has('package.json')) {
        let testScript = null;
        try { testScript = JSON.parse(fs.readFileSync(path.join(wsRoot, 'package.json'), 'utf8')).scripts?.test || null; } catch { /* unreadable */ }
        cands.push({ kind: 'node', testScript });
    }
    if (has('pubspec.yaml')) cands.push({ kind: 'flutter' });
    if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('pytest.ini')) cands.push({ kind: 'python' });
    return cands;
}

async function toolAvailable(kind) {
    if (kind === 'node') {
        const r = await run('npx --version', { timeout: 15000 });
        return r.ok ? null : 'npx not available';
    }
    if (kind === 'python') {
        const r = await run('python3 -m coverage --version', { timeout: 15000 });
        if (r.ok) return null;
        const r2 = await run('coverage --version', { timeout: 15000 });
        return r2.ok ? null : 'coverage.py not installed (pip install coverage)';
    }
    if (kind === 'flutter') {
        const r = await run('flutter --version', { timeout: 20000 });
        return r.ok ? null : 'flutter not installed';
    }
    return 'unknown kind';
}

function buildCommand(kind, wsRoot, outDir) {
    if (kind === 'node') return `npx --yes c8 --reporter=json --reports-dir="${outDir}" npm test --silent`;
    if (kind === 'python') return `python3 -m coverage run -m pytest -q && python3 -m coverage json -o "${path.join(outDir, 'coverage.json')}"`;
    if (kind === 'flutter') return 'flutter test --coverage';
    return null;
}

// -- parsers (pure: file/text in, numbers out) --------------------------------
function parseC8Json(file) {  // c8 --reporter=json (istanbul format)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = [];
    let cov = 0, tot = 0;
    for (const [f, entry] of Object.entries(data)) {
        const s = (entry && entry.s) || {};
        const ids = Object.keys(s);
        if (!ids.length) continue;
        const c = ids.filter(id => s[id] > 0).length;
        files.push({ file: f, covered: c, total: ids.length, pct: Math.round(c / ids.length * 1000) / 10 });
        cov += c; tot += ids.length;
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    return { files, covered: cov, total: tot, totalPct: tot ? Math.round(cov / tot * 1000) / 10 : 0 };
}

function parseCoverageJson(file) {  // coverage.py json report
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = [];
    let cov = 0, tot = 0;
    for (const [f, entry] of Object.entries((data && data.files) || {})) {
        const sum = entry.summary || {};
        const c = sum.covered_lines || 0, t = sum.num_statements || 0;
        files.push({ file: f, covered: c, total: t, pct: t ? Math.round(c / t * 1000) / 10 : 0 });
        cov += c; tot += t;
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    return { files, covered: cov, total: tot, totalPct: tot ? Math.round(cov / tot * 1000) / 10 : 0 };
}

function parseLcov(text) {  // flutter coverage/lcov.info
    const files = [];
    let cur = null;
    const flush = () => {
        if (cur && cur.total > 0) files.push({ file: cur.file, covered: cur.covered, total: cur.total, pct: Math.round(cur.covered / cur.total * 1000) / 10 });
        cur = null;
    };
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) { if (cur) flush(); cur = { file: line.slice(3), covered: 0, total: 0 }; }
        else if (line.startsWith('LF:')) { if (cur) cur.total = parseInt(line.slice(3), 10) || 0; }
        else if (line.startsWith('LH:')) { if (cur) cur.covered = parseInt(line.slice(3), 10) || 0; }
        else if (line === 'end_of_record') flush();
    }
    if (cur) flush();
    const cov = files.reduce((a, f) => a + f.covered, 0);
    const tot = files.reduce((a, f) => a + f.total, 0);
    files.sort((a, b) => a.file.localeCompare(b.file));
    return { files, covered: cov, total: tot, totalPct: tot ? Math.round(cov / tot * 1000) / 10 : 0 };
}

// -- runners ------------------------------------------------------------------
function mkOutDir() {
    const d = path.join(os.tmpdir(), `sudo-cov-${process.pid}-${Date.now()}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

async function measure(wsRoot, opts = {}) {
    const timeoutMs = opts.timeoutMs || 180000;
    const started = Date.now();
    const candidates = detectCandidates(wsRoot);
    if (!candidates.length) {
        return { measured: false, reason: 'Non mesurable : type de projet non detecte (ni package.json, ni pubspec.yaml, ni requirements/pyproject/setup.py)', candidates: [] };
    }
    const tried = [];
    for (const cand of candidates) {
        if (cand.kind === 'node' && !cand.testScript) {
            tried.push({ kind: 'node', reason: 'package.json has no "test" script' });
            continue;
        }
        const missing = await toolAvailable(cand.kind);
        if (missing) { tried.push({ kind: cand.kind, reason: missing }); continue; }
        const outDir = mkOutDir();
        try {
            const cmd = buildCommand(cand.kind, wsRoot, outDir);
            const r = await run(cmd, { cwd: wsRoot, timeout: timeoutMs });
            let parsed = null;
            if (cand.kind === 'node') {
                const f = path.join(outDir, 'coverage-final.json');
                if (fs.existsSync(f)) parsed = parseC8Json(f);
            } else if (cand.kind === 'python') {
                const f = path.join(outDir, 'coverage.json');
                if (fs.existsSync(f)) parsed = parseCoverageJson(f);
            } else if (cand.kind === 'flutter') {
                const f = path.join(wsRoot, 'coverage', 'lcov.info');
                if (fs.existsSync(f)) parsed = parseLcov(fs.readFileSync(f, 'utf8'));
            }
            if (parsed && parsed.total > 0) {
                return {
                    measured: true, kind: cand.kind, tool: cmd.split(' ')[0], cmd,
                    testsOk: r.ok, files: parsed.files.slice(0, 100),
                    covered: parsed.covered, total: parsed.total, totalPct: parsed.totalPct,
                    durationMs: Date.now() - started, candidates: candidates.map(c => c.kind),
                };
            }
            tried.push({ kind: cand.kind, reason: `tool ran but produced no usable data (exit ok=${r.ok}, hint: ${(r.stderr || r.stdout || '').slice(0, 160)})` });
        } catch (e) {
            tried.push({ kind: cand.kind, reason: 'runner error: ' + (e && e.message ? e.message.slice(0, 160) : 'unknown') });
        } finally {
            rmrf(outDir);
        }
    }
    return { measured: false, reason: 'Non mesurable : ' + tried.map(t => `${t.kind} (${t.reason})`).join('; '), candidates: candidates.map(c => c.kind), tried };
}

module.exports = { detectCandidates, toolAvailable, buildCommand, parseC8Json, parseCoverageJson, parseLcov, measure };
