/**
 * SUDO STUDIO - P32: brand in the installed product (old logo zero,
 * single extension copy, exe icon stamped, update cleanup).
 * A: customize script STEP 2r (rcedit) + extended 2c VERIFY
 * B: check-exe-icon.ps1 (byte-exact old-gone/new-present)
 * C: installer [InstallDelete] (stale copies + old brand files)
 * D: smoke section 5b (3 new checks + fingerprint params)
 * E: packager-03 doc (single-source branding + gates + screenshots)
 * F: behavioral mirrors (data-URI decode logic + icon.ico fingerprint)
 * G: new files ASCII-only
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const bs = String.fromCharCode(92);
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const SVG_SHA = '88bb8eb6c643403be96d1d218a564c28a05f3b31368aad10c0db0bc1efbed75f';
const OLD_PNG = 'b9971d910cb2502df37d7c65b2e36c9061d030fd41699bf9dafee46551c5505c';
const NEW_PNG = 'f9a9ccc40f3a630132f9485084e33a0504493b3d7adda663950e50600b219d42';
const RCEDIT_SHA = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a';

// -- A: customize script ------------------------------------------------------
const ps1 = read('scripts/customize-vscodium.ps1');
check('A1: STEP 2r stamps the exe icon via pinned rcedit, fails loud', () => {
  for (const m of ['STEP 2r', 'rcedit', '--set-icon', RCEDIT_SHA,
      'releases/download/v2.0.0/rcedit-x64.exe', 'exit 2',
      'ci' + bs + 'check-exe-icon.ps1', 'SudoStudio.exe', 'VSCodium.exe']) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A2: new fingerprint params with the 1.97.2 defaults', () => {
  for (const m of ['$RceditPath', '$OldLogoSvgSha256', '$OldIconPngSha256',
      '$NewIconPngSha256', SVG_SHA, OLD_PNG, NEW_PNG]) {
    assert.ok(ps1.includes(m), m);
  }
});
check('A3: 2c VERIFY covers gen-B + base64 data-URI decode + svg fingerprint', () => {
  for (const m of ['#78AEED', '#1D6BCA', 'linearGradient',
      'data:image/svg', 'FromBase64String', '0 old-logo occurrences remain',
      '0 SVG files match the old-logo fingerprint', '2c-OLD-SVG']) {
    assert.ok(ps1.includes(m), m);
  }
});

// -- B: exe icon checker ------------------------------------------------------
const chk = read('scripts/ci/check-exe-icon.ps1');
check('B1: checker scans PNG blobs and verdicts both directions', () => {
  for (const m of ['P32PngBlobs', '0x89', 'BitConverter', 'ComputeHash',
      '[EXE-ICON] FAIL', '[EXE-ICON] PASS', 'exit 1',
      'old base-exe icon PNG', 'new brand icon PNG']) {
    assert.ok(chk.includes(m), m);
  }
});
check('B2: checker defaults are the pinned fingerprints', () => {
  assert.ok(chk.includes("$OldPngSha256 = '" + OLD_PNG + "'"), 'old default');
  assert.ok(chk.includes("$NewPngSha256 = '" + NEW_PNG + "'"), 'new default');
});

// -- C: installer cleanup -----------------------------------------------------
const iss = read('installer.iss');
check('C1: [InstallDelete] removes stale copies + old brand files', () => {
  assert.ok(iss.includes('[InstallDelete]'), 'section');
  const wants = ['extensions' + bs + 'sudo-ai', 'sudo-ai-extension',
    'data' + bs + 'extensions' + bs + '*sudo*',
    'resources' + bs + 'app' + bs + 'extensions' + bs + '*sudo*',
    'VSCodium.exe', 'VSCodium.VisualElementsManifest.xml', 'code.ico',
    'resources' + bs + 'win32' + bs + 'code.ico'];
  for (const m of wants) assert.ok(iss.includes(m), m);
  for (const m of ['NEVER touched', 'P31 root layout', 'models']) {
    assert.ok(iss.includes(m), m);
  }
});
check('C2: the live agent is never a delete target', () => {
  const lines = iss.split('\n').filter((l) => l.includes('sudo-agent'));
  assert.ok(lines.length > 0, 'agent mentioned');
  assert.ok(lines.every((l) => l.includes('NEVER') || !l.startsWith('Type:')), 'no Type: line deletes it');
});

// -- D: smoke section 5b ------------------------------------------------------
const smoke = read('scripts/smoke/smoke-install.ps1');
check('D1: smoke params carry the 3 fingerprints', () => {
  for (const m of ['$OldLogoSvgSha256', '$OldIconPngSha256', '$NewIconPngSha256',
      SVG_SHA, OLD_PNG, NEW_PNG]) {
    assert.ok(smoke.includes(m), m);
  }
});
check('D2: brand-oldlogo-zero (markers + b64 decode + fingerprint)', () => {
  for (const m of ['brand-oldlogo-zero', '#78AEED', 'path6008',
      'FromBase64String', 'Get-FileHash', 'markers+b64+fingerprint absent']) {
    assert.ok(smoke.includes(m), m);
  }
});
check('D3: brand-extension-single (one copy, container, no explorer views)', () => {
  for (const m of ['brand-extension-single', "'*sudo*'", 'activitybar',
      'sudo-studio', 'views still under explorer', 'container icon missing']) {
    assert.ok(smoke.includes(m), m);
  }
});
check('D4: brand-exe-icon calls the shared checker (skip when absent)', () => {
  for (const m of ['brand-exe-icon', 'check-exe-icon.ps1', 'checker not in checkout']) {
    assert.ok(smoke.includes(m), m);
  }
});

// -- E: packager doc ------------------------------------------------------------
const doc = read('docs/p32-packager-patch.md');
check('E1: doc mandates the repo script + fresh extension + gates', () => {
  for (const m of ['customize-vscodium.ps1 -VSCodiumDir build' + bs + 'SudoStudio',
      '[EXT-SHIP]', 'check-exe-icon.ps1 -ExePath', '[InstallDelete]',
      'Rebuild order', 'dummy shas']) {
    assert.ok(doc.includes(m), m);
  }
});
check('E2: doc covers the inline-ISS world + optional screenshots', () => {
  for (const m of ['$lines +=', 'screenshot-windows', 'continue-on-error',
      'Default Dark Modern', 'Default Light Modern', 'shot-out/']) {
    assert.ok(doc.includes(m), m);
  }
});
check('E3: doc explains the 3 why-P20-missed mechanisms', () => {
  for (const m of ['[VERIFY] ProductName', '--extensions-dir', 'already installed']) {
    assert.ok(doc.includes(m), m);
  }
});

// -- F: behavioral mirrors ------------------------------------------------------
// JS mirror of the PS match semantics (gen-A ids / gen-B blues+gradient).
function oldArt(s) {
  const gA = s.includes('path6008') && s.includes('Gradient_1');
  const gB = s.includes('#78AEED') && s.includes('#1D6BCA') && s.includes('linearGradient');
  return gA || gB;
}
function scanText(t) {
  if (oldArt(t)) return true;
  const re = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    if (oldArt(dec)) return true;
  }
  return false;
}
const GENB = '<svg><linearGradient><stop stop-color="#78AEED"/><stop stop-color="#1D6BCA"/></linearGradient></svg>';
const GENA = '<svg><linearGradient id="Gradient_1"><path id="path6008"/></linearGradient></svg>';
const CHEVRON_B64 = 'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDE5LjIuMCwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4IgoJIHZpZXdCb3g9IjAgMCAxNiAxNiIgc3R5bGU9ImVuYWJsZS1iYWNrZ3JvdW5kOm5ldyAwIDAgMTYgMTY7IiB4bWw6c3BhY2U9InByZXNlcnZlIj4KPHN0eWxlIHR5cGU9InRleHQvY3NzIj4KCS5zdDB7ZmlsbDojRkZGRkZGO30KCS5zdDF7ZmlsbDpub25lO30KPC9zdHlsZT4KPHRpdGxlPnVwY2hldnJvbjwvdGl0bGU+CjxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik04LDUuMWwtNy4zLDcuM0wwLDExLjZsOC04bDgsOGwtMC43LDAuN0w4LDUuMXoiLz4KPHJlY3QgY2xhc3M9InN0MSIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ii8+Cjwvc3ZnPgo=';
check('F1: mirror flags gen-A + gen-B, direct and base64-embedded', () => {
  assert.ok(scanText(GENA), 'gen-A direct');
  assert.ok(scanText(GENB), 'gen-B direct');
  assert.ok(scanText('x=data:image/svg+xml;base64,' + Buffer.from(GENB).toString('base64')), 'gen-B b64');
  assert.ok(!scanText('plain bundle text, no art'), 'clean direct');
});
check('F2: mirror stays silent on the real 1.97.2 chevron data-URI', () => {
  const uri = 'background:url(data:image/svg+xml;base64,' + CHEVRON_B64 + ')';
  assert.ok(!scanText(uri), 'chevron is generic art');
  const dec = Buffer.from(CHEVRON_B64, 'base64').toString('utf8');
  assert.ok(dec.includes('upchevron'), 'fixture is the chevron');
});
check('F3: shipped sudo-icon.svg is new art (ssRing, no old markers)', () => {
  const logo = read('resources/sudo-icon.svg');
  assert.ok(logo.includes('ssRing'), 'brand marker');
  assert.ok(!scanText(logo), 'no old art');
});
check('F4: icon.ico 256px PNG equals the NEW fingerprint (or fail loud)', () => {
  const ico = fs.readFileSync(path.join(ROOT, 'resources', 'icon.ico'));
  assert.strictEqual(ico.readUInt16LE(4), 6, '6 entries');
  let sha = null;
  for (let i = 0; i < 6; i++) {
    const w = ico[6 + i * 16] || 256;
    const sz = ico.readUInt32LE(6 + i * 16 + 8);
    const off = ico.readUInt32LE(6 + i * 16 + 12);
    if (w === 256) sha = crypto.createHash('sha256').update(ico.slice(off, off + sz)).digest('hex');
  }
  assert.strictEqual(sha, NEW_PNG, 'refresh NewIconPngSha256 if the icon changed');
});
check('F5: old fingerprints are well-formed (64 hex)', () => {
  for (const h of [SVG_SHA, OLD_PNG, NEW_PNG, RCEDIT_SHA]) {
    assert.ok(/^[0-9a-f]{64}$/.test(h), h.slice(0, 12));
  }
});

// -- G: hygiene -----------------------------------------------------------------
check('G1: new P32 files are ASCII-only', () => {
  for (const f of ['scripts/ci/check-exe-icon.ps1', 'docs/p32-packager-patch.md',
      'backend/tests/test-p32-branding.js']) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 128, f + ' byte ' + i);
  }
});

console.log('P32 passed: ' + n + ' checks');
