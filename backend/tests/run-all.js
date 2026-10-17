#!/usr/bin/env node
/**
 * SUDO STUDIO - single test composer (P28).
 *
 * Runs every runnable suite with plain node (zero test-runner dependency):
 *   - backend/tests/test-p*.js  (static suites, no live server needed)
 *   - backend/tests/test-p12-ux.js, test-p13-agent-ui.js (same dir)
 *   - test-extension-complete.js (repo root, needs cwd=repo root)
 *   - backend/tests/test-ai-flow.js ONLY when SUDO_LIVE=1
 *     (live end-to-end: needs the Python runtime on :6000 AND the
 *     backend on its port; without them it fails honestly with
 *     ECONNREFUSED instead of passing).
 *
 * Exit code: 0 when every executed suite passes, 1 otherwise.
 * Usage:
 *   cd backend && npm test            # static suites
 *   cd backend && SUDO_LIVE=1 npm test # static + live AI flow
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testsDir = __dirname;
const repoRoot = path.join(testsDir, '..', '..');

const suites = fs.readdirSync(testsDir)
    .filter((f) => /^test-p.*\.js$/.test(f))
    .sort()
    .map((f) => ({ file: path.join(testsDir, f), cwd: testsDir }));

suites.push({ file: path.join(repoRoot, 'test-extension-complete.js'), cwd: repoRoot });

if (process.env.SUDO_LIVE === '1') {
    suites.push({ file: path.join(testsDir, 'test-ai-flow.js'), cwd: testsDir });
} else {
    console.log('SKIP test-ai-flow.js (live E2E needs runtime+backend; rerun with SUDO_LIVE=1)');
}

let failed = 0;
for (const s of suites) {
    const name = path.relative(repoRoot, s.file);
    console.log('\n' + '='.repeat(64));
    console.log('SUITE ' + name);
    console.log('='.repeat(64));
    const r = spawnSync(process.execPath, [s.file], { cwd: s.cwd, stdio: 'inherit' });
    if (r.status !== 0) {
        console.log('>>> FAILED ' + name + ' (exit ' + r.status + ')');
        failed++;
    } else {
        console.log('>>> PASSED ' + name);
    }
}

console.log('\n' + '='.repeat(64));
console.log('TOTAL: ' + suites.length + ' suites, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
