/**
 * SUDO STUDIO - P29 complement item 4: per-component integrity manifest.
 * A: build-manifest.ps1 (verify + refuse + write, P20 brand gate inside)
 * B: packager doc (supersedes inline P29-P3, call + refusal + proofs)
 * C: smoke section 4 asserts the new schema (commits + brand)
 * D: new files ASCII-only
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const bs = String.fromCharCode(92);
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// -- A: manifest script ---------------------------------------------------------
const ps1 = read('scripts/ci/build-manifest.ps1');
check('A1: mandatory params (build dir, expected commit, both run ids)', () => {
  for (const m of ['$BuildDir', '$SudoStudioCommit', '$BackendRunId', '$RuntimeRunId',
      '$SourceDir', '$EditorVersion', '$Token', '$Repo']) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A2: refusal helper + machine lines', () => {
  for (const m of ['function Deny', '[MANIFEST] FAIL', '[MANIFEST] PASS', 'exit 1']) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A3: 12 required component files (extension + root agent + art)', () => {
  for (const m of ['backend.exe', 'runtime.exe', 'SudoStudio.exe', 'start.bat',
      'extensions' + bs + 'sudo-ai' + bs + 'package.json',
      'sudo-agent' + bs + 'src' + bs + 'server.js',
      'resources' + bs + 'app' + bs + 'product.json',
      'code-icon.svg', 'sudo-icon.svg', 'icon.ico', 'sudo-robot.svg']) {
    assert.ok(ps1.includes(m), m);
  }
  assert.ok(!ps1.includes('extensions' + bs + 'sudo-agent'), 'P31 root layout, no old path');
});
check('A4: run commits must equal the source checkout (both runs)', () => {
  for (const m of ['actions/runs/', 'head_sha', 'conclusion', 'created_at',
      're-dispatch 01/02 after the last merge', '$beRun', '$rtRun']) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A5: P20 brand gate in the final package', () => {
  for (const m of ["nameShort -ne 'Sudo Studio'", 'differs from sudo-icon.svg',
      'sudo-studio', 'views still under explorer', 'check-exe-icon.ps1',
      'robot container views=']) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A6: manifest schema (components x5 + brand + files x6)', () => {
  for (const m of ['sudo_studio_commit', 'packager_commit', 'components',
      'backend', 'runtime', 'editor', 'extension', 'agent',
      'run_id', 'container', 'logoSvgMatch', 'exeIcon', 'robotIcon',
      'build-manifest.json']) {
    assert.ok(ps1.includes(m), m);
  }
});

// -- B: packager doc --------------------------------------------------------------
const doc = read('docs/p29c4-packager-patch.md');
check('B1: doc supersedes P29-P3 with the script call', () => {
  for (const m of ['SUPERSEDES', 'build-manifest.ps1 -BuildDir', '-SudoStudioCommit',
      'BACKEND_RUN_ID', 'RUNTIME_RUN_ID', 'GH_TOKEN', 'actions:read',
      'P31 ROOT layout']) {
    assert.ok(doc.includes(m), m);
  }
});
check('B2: doc states refusal semantics + schema + proofs', () => {
  for (const m of ['[MANIFEST] FAIL', 'never runs', 'logoSvgMatch',
      'exeIcon', 'run_id', 'brand=P20-OK', 'SUCCESS requires']) {
    assert.ok(doc.includes(m), m);
  }
});

// -- C: smoke section 4 -------------------------------------------------------------
const smoke = read('scripts/smoke/smoke-install.ps1');
check('C1: smoke asserts component commits + brand block', () => {
  for (const m of ['components block incomplete', 'component commit mismatch',
      'brand block invalid', 'container/product invalid',
      'components=5 brand=P20-OK', "'backend', 'runtime', 'extension', 'agent'"]) {
    assert.ok(smoke.includes(m), m);
  }
});

// -- D: hygiene -----------------------------------------------------------------------
check('D1: new P29c4 files are ASCII-only', () => {
  for (const f of ['scripts/ci/build-manifest.ps1', 'docs/p29c4-packager-patch.md',
      'backend/tests/test-p29c-manifest.js']) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, f + ' byte ' + i);
  }
});

console.log('P29c4 passed: ' + n + ' checks');
