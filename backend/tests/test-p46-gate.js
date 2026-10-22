/**
 * P46: delivery gate that tests the INSTALLED product - static validation.
 * The gate itself runs on Windows CI (install + exes + editor); this suite
 * validates everything checkable without Windows: file presence, ASCII-only,
 * delimiter balance, required line markers, P36-matrix compatibility of
 * verify-installed.ps1, manifest touch field, and the server/runtime
 * prerequisites each P46 line relies on. ASCII only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let n = 0;
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function check(name, fn) {
  n++;
  try { fn(); console.log('ok ' + n + ' ' + name); }
  catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

// Strip PS comments + strings, keeping $(...) code spliced in (for balance).
function stripPS(src) {
  let out = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const c = src[i];
    if (c === '<' && src[i + 1] === '#') { // block comment <# ... #>
      i += 2;
      while (i < len && !(src[i] === '#' && src[i + 1] === '>')) i++;
      i += 2;
      continue;
    }
    if (c === '#') { // line comment (PS '#' never appears in operators)
      while (i < len && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'") { // single-quoted: '' escape, no interpolation
      i++;
      while (i < len) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      out += "''";
      continue;
    }
    if (c === '"') { // double-quoted: ` escape, $(...) stays code
      i++;
      while (i < len) {
        if (src[i] === '`' && i + 1 < len) { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '(') {
          let depth = 0;
          i += 2;
          out += ' $(';
          while (i < len) {
            if (src[i] === '(') depth++;
            if (src[i] === ')') { if (depth === 0) { i++; break; } depth--; }
            out += src[i];
            i++;
          }
          out += ')';
          continue;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function assertBalanced(name, code) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) stack.push({ c, i });
    else if (c === '}' || c === ')' || c === ']') {
      assert.ok(stack.length > 0, name + ': unbalanced ' + c + ' at ' + i);
      const t = stack.pop();
      assert.strictEqual(pairs[t.c], c, name + ': ' + t.c + ' closed by ' + c);
    }
  }
  assert.strictEqual(stack.length, 0, name + ': ' + stack.length + ' unclosed');
}

function assertAscii(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, rel + ' byte ' + i);
}

const VERIFY = 'scripts/verify/verify-installed.ps1';
const GATE = 'scripts/verify/p46-gate.ps1';
const MANIFEST = 'scripts/ci/build-manifest.ps1';
const verify = read(VERIFY);
const gate = read(GATE);
const manifest = read(MANIFEST);

// -- A: presence + hygiene ----------------------------------------------------
check('A1: P46 scripts exist', () => {
  assert.ok(fs.existsSync(path.join(ROOT, VERIFY)));
  assert.ok(fs.existsSync(path.join(ROOT, GATE)));
});
check('A2: ASCII-only', () => { [VERIFY, GATE, MANIFEST].forEach(assertAscii); });
check('A3: delimiters balanced', () => {
  assertBalanced('verify', stripPS(verify));
  assertBalanced('gate', stripPS(gate));
  assertBalanced('manifest', stripPS(manifest));
});
check('A4: PS5.1 headers (Requires + Stop)', () => {
  for (const s of [verify, gate]) {
    assert.ok(s.includes('#Requires -Version 5.1'), 'requires');
    assert.ok(s.includes("$ErrorActionPreference = 'Stop'"), 'stop');
  }
});

// -- B: verify-installed.ps1 lines P46-1..9 -----------------------------------
check('B1: all 9 line ids emitted', () => {
  for (const l of ['P46-1', 'P46-2', 'P46-3', 'P46-4', 'P46-5', 'P46-6', 'P46-7', 'P46-8', 'P46-9']) {
    assert.ok(verify.includes("'" + l + "'"), l);
  }
});
check('B2: L1 selftest (exit 0 + SELFTEST PASS)', () => {
  assert.ok(verify.includes('--selftest') && verify.includes('SELFTEST PASS'));
  assert.ok(verify.includes('ExitCode -ne 0'), 'exit check');
});
check('B3: L2 agent handshake (Electron-as-Node, no literal token)', () => {
  assert.ok(verify.includes('ELECTRON_RUN_AS_NODE'));
  assert.ok(verify.includes('[Guid]::NewGuid'), 'random token');
  assert.ok(verify.includes('ready') && verify.includes('/health'));
  assert.ok(!/ghp_[A-Za-z0-9]{10,}/.test(verify), 'no ghp token value');
  assert.ok(!/gho_[A-Za-z0-9]{10,}/.test(verify), 'no gho token value');
  assert.ok(!verify.includes('SUDO_AGENT_TOKEN = "'), 'no literal token');
});
check('B4: L3 editor log scan (30 s + 3 registration patterns)', () => {
  for (const m of ['Start-Sleep -Seconds 30', 'must be of type', 'does not exist', 'user-data-dir']) {
    assert.ok(verify.includes(m), m);
  }
  assert.ok(verify.includes('\\bicon\\b') || verify.includes('icon'), 'icon pattern');
  // P42(5): the proven container rejection is a WARNING, so warn context
  // must count for 'does not exist' (icon stays error-only).
  assert.ok(verify.includes('\\bwarn\\b'), 'warn context for does-not-exist');
});
check('B5: L4 panels via panel-render-test.js', () => {
  assert.ok(verify.includes('panel-render-test.js'));
  assert.ok(verify.includes('report-p46.json'), 'report parse');
});
check('B6: L5 branding (container + views + old logo)', () => {
  for (const m of ['sudo-studio', 'viewsContainers', 'code-icon.svg', 'path6008', '88bb8eb6']) {
    assert.ok(verify.includes(m), m);
  }
  // P42: string-only container icon + About commit/date + title defaults.
  for (const m of ['must be a string path', 'configurationDefaults', 'commit/date (About dialog)']) {
    assert.ok(verify.includes(m), m);
  }
});
check('B7: L6 journal header + n_ctx requested==real', () => {
  for (const m of ['# === session start ===', '/reload', 'n_ctx', 'requested=4096', '/models']) {
    assert.ok(verify.includes(m), m);
  }
});
check('B8: L7 manifest hashes + commits + freshness', () => {
  for (const m of ['Get-FileHash', 'component commit mismatch', 'runtime.touch', 'stale runtime']) {
    assert.ok(verify.includes(m), m);
  }
});
check('B9: L8 never uninstalls here', () => {
  assert.ok(verify.includes('uninstall-clean') && verify.includes('CI gate only'));
  assert.ok(!verify.includes('unins000.exe'), 'no uninstaller call');
});
check('B10: L9 result integrity (no-secret scan, refuse to write)', () => {
  for (const m of ['verify-result.json', 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY', 'REFUSING to write']) {
    assert.ok(verify.includes(m), m);
  }
});
check('B11: heavy checks gated behind -Full (matrix < 120 s safe)', () => {
  assert.ok(verify.includes('[switch]$Full'), 'switch');
  const gated = (verify.match(/if \(-not \$Full\)/g) || []).length;
  assert.ok(gated >= 3, 'gated blocks: ' + gated);
});
check('B12: P36-matrix compat (files/probes/verdict + params)', () => {
  for (const m of ['Add-Probe', 'not running (start the app first)', 'verdict', '[string]$OutFile']) {
    assert.ok(verify.includes(m), m);
  }
});
check('B13: never writes inside the install dir', () => {
  for (const line of verify.split('\n')) {
    if (/Set-Content|WriteAllText/.test(line)) {
      assert.ok(line.indexOf('$InstallDir') === -1, 'write to install: ' + line.trim().slice(0, 80));
    }
    if (line.indexOf('Copy-Item') !== -1) {
      // First path is the source (reading the install is fine); any
      // further $InstallDir occurrence would be a write destination.
      const srcPos = line.indexOf('Join-Path $InstallDir');
      const rest = srcPos === -1 ? line : line.slice(srcPos + 'Join-Path $InstallDir'.length);
      assert.ok(rest.indexOf('$InstallDir') === -1, 'copy into install: ' + line.trim().slice(0, 80));
    }
  }
});

// -- C: p46-gate.ps1 orchestration --------------------------------------------
check('C1: install + snapshot + pristine + uninstall lines', () => {
  for (const m of ['silent-install', 'Snapshot-Dir', 'P46-8a', 'install-pristine', 'P46-8b', 'uninstall-no-files', 'uninstall-no-processes']) {
    assert.ok(gate.includes(m), m);
  }
});
check('C2: runs the SHIPPED verifier in -Full, imports its lines', () => {
  assert.ok(gate.includes("Join-Path $InstallDir 'verify-installed.ps1'"), 'shipped path');
  assert.ok(gate.includes('-Full'), 'full flag');
  assert.ok(gate.includes('verify-result.json') && gate.includes('gate-result.json'));
});
check('C3: backend + runtime started and awaited', () => {
  assert.ok(gate.includes('backend.exe') && gate.includes('runtime.exe'));
  assert.ok(gate.includes('localhost:5000') && gate.includes('localhost:6000'));
});
check('C4: publish blocked on any FAIL', () => {
  assert.ok(gate.includes('PUBLISH BLOCKED'));
  assert.ok(/exit 1/.test(gate), 'exit 1');
});
check('C5: diagnostics always collected', () => {
  for (const m of ['gate-transcript.txt', 'backend.log', 'runtime.log', 'innosetup.log', 'GATE-EVIDENCE']) {
    assert.ok(gate.includes(m), m);
  }
});

// -- D: manifest touch field ---------------------------------------------------
check('D1: build-manifest embeds the runtime touch date', () => {
  assert.ok(manifest.includes('touch = $runtimeTouch'), 'schema');
  assert.ok(manifest.includes("git -C $SourceDir log -1 --format='%cI'"), 'git log');
  assert.ok(manifest.includes('backend/runtime'), 'path');
});

// -- E: prerequisites in product code ------------------------------------------
check('E1: backend --selftest wired (P46-1)', () => {
  const srv = read('backend/server.js');
  assert.ok(srv.includes('--selftest'), 'flag');
  assert.ok(fs.existsSync(path.join(ROOT, 'backend/selftest.js')), 'selftest.js');
});
check('E2: runtime /reload n_ctx + /models n_ctx + [GGUF] journal (P46-6)', () => {
  const ent = read('backend/runtime/server.enterprise.py');
  assert.ok(ent.includes("clamp_n_ctx(data.get('n_ctx'))"), 'reload clamp');
  assert.ok(ent.includes('"n_ctx":                state.n_ctx'), 'models field');
  assert.ok(ent.includes('[GGUF] n_ctx='), 'journal line');
});
check('E3: agent server handshake shape (P46-2)', () => {
  const srv = read('sudo-agent/src/server.js');
  assert.ok(srv.includes('ready: true') && srv.includes('process.stdout.write'), 'ready line');
});
check('E4: panel script accepts the flags the gate passes (P46-4)', () => {
  const pr = read('scripts/ci/panel-render-test.js');
  for (const f of ['install-dir', 'live-dir', 'user-data-dir', 'out-dir', 'label']) {
    assert.ok(pr.includes('--' + f), f);
  }
});

console.log('P46: ' + n + ' checks evaluated');
if (process.exitCode) console.log('P46: FAILURES PRESENT');
else console.log('P46: all green (static only - Windows CI proves behaviour)');
