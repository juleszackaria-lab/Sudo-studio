/**
 * panel-render-test.js - P35(f): render every extension panel of the
 * INSTALLED package and fail on blank panel / console error / old logo.
 *
 * Zero-dependency Node (global fetch/WebSocket + http/crypto/child_process).
 * The editor is launched with --remote-debugging-port and driven over CDP:
 * each panel is opened via the command palette (typed substring + Enter),
 * then its webview target(s) are inspected (title, innerText length, guard
 * overlay, console errors, JS exceptions) and screenshotted.
 * Extra installed-package proofs: old-logo zero (smoke markers), product.json
 * commit == build manifest, "Sudo Studio" shortcuts, install dir pristine
 * (no writes during the run), window title.
 *
 * Usage:
 *   node panel-render-test.js --install-dir <dir> --live-dir <dir>
 *     --user-data-dir <dir> --out-dir <dir> [--debug-port 9222]
 *     [--label run1] [--skip-shortcuts]
 *
 * The live extensions dir must already exist (job copies the shipped master
 * there, exactly like start.bat). Backend may be up or down; panels must
 * render either way (fallback overlay counts as rendered, and is reported).
 * Exit 0 = all green, 1 = any failure. report.json + screenshots always.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const OLD_LOGO_SVG_SHA256 = '88bb8eb6c643403be96d1d218a564c28a05f3b31368aad10c0db0bc1efbed75f';
const TEXT_EXTS = new Set(['.js', '.json', '.css', '.html', '.svg', '.xml', '.ts', '.nls', '.txt', '.md']);
const MIN_TEXT_LEN = 10;

const PANELS = [
  ['doctor', 'Run System Doctor'],
  ['sdk', 'Open SDK Manager Panel'],
  ['sdkinstall', 'SDK Install'],
  ['agent', 'Sudo Agent: Ouvrir'],
  ['chat', 'Open AI Chat'],
  ['runtime', 'Runtime & Models'],
  ['devops', 'DevOps Automation'],
  ['env', 'Reproductible'],
  ['security', 'Run Security Audit'],
  ['duplication', 'Enterprise Duplication'],
  ['central', 'Central Management'],
  ['license', 'License Management'],
  ['providers', 'AI Providers'],
  ['analysis', 'Full Panel'],
  ['logs', 'Voir les journaux'],
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  if (i + 1 >= process.argv.length || process.argv[i + 1].startsWith('--')) return true;
  return process.argv[i + 1];
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('ws error: ' + (e && e.message)));
      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else if (m.method) {
          this.events.push(m);
        }
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 15000);
    });
  }
  drainErrors() {
    const errs = [];
    const warns = [];
    for (const m of this.events) {
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params && m.params.type) || '';
        const args = ((m.params && m.params.args) || []).map((a) => {
          if (a && typeof a.value !== 'undefined') return String(a.value).slice(0, 300);
          return (a && (a.description || a.type) || '?').slice(0, 300);
        }).join(' | ');
        if (t === 'error') errs.push('console.error: ' + args);
        else if (t === 'warning') warns.push('console.warn: ' + args);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        errs.push('exception: ' + ((d && (d.text || (d.exception && d.exception.description))) || '?').slice(0, 300));
      }
    }
    this.events = [];
    return { errs, warns };
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function listTargets(port) {
  return httpGetJson('http://127.0.0.1:' + port + '/json/list');
}

async function paletteState(main) {
  try {
    const r = await main.send('Runtime.evaluate', {
      expression: '(() => { const rows = document.querySelectorAll(".quick-input-list .monaco-list-row");' +
        ' return { rows: rows.length, first: rows.length ? rows[0].innerText.slice(0, 120) : "" }; })()',
      returnByValue: true,
    });
    return (r && r.result && r.result.value) || {};
  } catch (_) { return {}; }
}

async function pressEscape(main) {
  const e = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 };
  await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, e));
  await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, e));
  await sleep(800);
}

async function openPaletteAndRun(main, substr, first) {
  // Ctrl+Shift+P
  const o = { key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 };
  const openOnce = async () => {
    await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, o));
    await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, o));
    await sleep(first ? 2500 : 1200);
    await main.send('Input.insertText', { text: substr });
    await sleep(2500);
  };
  await pressEscape(main); // defocus webviews / close stale pickers
  await openOnce();
  let st = await paletteState(main);
  if (!st.rows) { // retry once: close + reopen + retype
    await pressEscape(main);
    await openOnce();
    st = await paletteState(main);
  }
  const e = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 };
  await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r' }, e));
  await main.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, e));
  await sleep(first ? 14000 : 8000);
  return st;
}

async function evalWebview(cdp) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: '({t: document.title, n: (document.body?document.body.innerText.length:0), ' +
      'fatal: !(document.getElementById("ssFatal")||{hidden:true}).hidden, ' +
      'fb: !(document.getElementById("sudoBackendFallback")||{hidden:true}).hidden})',
    returnByValue: true,
  });
  return (r && r.result && r.result.value) || {};
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
}

function snapshotInstall(root) {
  const snap = {};
  for (const p of walkFiles(root)) {
    try {
      const st = fs.statSync(p);
      snap[path.relative(root, p)] = st.size + ':' + Math.floor(st.mtimeMs);
    } catch (_) {}
  }
  return snap;
}

function oldLogoCheck(root) {
  const hits = [];
  let svgEq = null;
  for (const p of walkFiles(root)) {
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.size >= 64 * 1024 * 1024) continue;
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    const gA = t.indexOf('path6008') !== -1 && t.indexOf('Gradient_1') !== -1;
    const gB = t.indexOf('#78AEED') !== -1 && t.indexOf('#1D6BCA') !== -1 && t.indexOf('linearGradient') !== -1;
    if (gA || gB) hits.push(path.relative(root, p) + ' (markers)');
    if (ext === '.svg') {
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (h === OLD_LOGO_SVG_SHA256) hits.push(path.relative(root, p) + ' (old fingerprint)');
    }
  }
  try {
    const a = fs.readFileSync(path.join(root, 'resources', 'app', 'out', 'media', 'code-icon.svg'));
    const b = fs.readFileSync(path.join(root, 'resources', 'sudo-icon.svg'));
    svgEq = a.equals(b);
  } catch (_) { svgEq = false; }
  return { hits, svgEq, pass: hits.length === 0 && svgEq === true };
}

function shellFolder(kind) {
  const ps = "[Environment]::GetFolderPath('" + kind + "')";
  return execSync('powershell -NoProfile -Command "' + ps + '"', { encoding: 'utf8' }).trim();
}

function readJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // PS5.1 Set-Content UTF8 BOM
  return JSON.parse(t);
}

async function main() {
  const installDir = arg('install-dir');
  const liveDir = arg('live-dir');
  const userDataDir = arg('user-data-dir');
  const outDir = arg('out-dir');
  const port = parseInt(arg('debug-port', '9222'), 10);
  const label = arg('label', 'run1');
  const skipShortcuts = arg('skip-shortcuts', false) === true;
  if (!installDir || !liveDir || !userDataDir || !outDir) {
    console.error('missing required args');
    process.exit(2);
  }
  if (typeof WebSocket === 'undefined') {
    console.error('FATAL: no global WebSocket (need Node 21+)');
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const report = { label, installDir, panels: [], failures: [], pass: true };
  const fail = (m) => { report.failures.push(m); report.pass = false; console.log('[PANEL-FAIL] ' + m); };

  // Preconditions: live extension + exe.
  // --live-dir accepts the extensions ROOT (contains sudo-ai/) or the
  // sudo-ai dir itself (job versions drifted); --extensions-dir gets root.
  let extRoot = liveDir;
  let extDir = path.join(liveDir, 'sudo-ai');
  if (!fs.existsSync(path.join(extDir, 'package.json')) &&
      fs.existsSync(path.join(liveDir, 'package.json'))) {
    extDir = liveDir;
    extRoot = path.dirname(liveDir);
  }
  report.liveDirs = { arg: liveDir, extRoot, extDir };
  console.log('[PANEL] live root=' + extRoot + ' ext=' + extDir);
  for (const f of ['package.json', 'extension.js']) {
    if (!fs.existsSync(path.join(extDir, f))) fail('live copy missing: ' + f);
  }
  let exe = path.join(installDir, 'SudoStudio.exe');
  if (!fs.existsSync(exe)) exe = path.join(installDir, 'VSCodium.exe');
  if (!fs.existsSync(exe)) { fail('no editor exe'); }
  let manifestCommit = null;
  try {
    manifestCommit = readJson(path.join(installDir, 'build-manifest.json')).sudo_studio_commit;
  } catch (_) { fail('build-manifest unreadable'); }
  report.manifestCommit = manifestCommit;

  const before = snapshotInstall(installDir);
  console.log('[PANEL] install snapshot: ' + Object.keys(before).length + ' files');

  // Launch editor.
  const logsDir = path.resolve(outDir, 'ext-logs'); // absolute: outside install (pristine) + uploaded
  fs.mkdirSync(logsDir, { recursive: true });
  const child = spawn(exe, [
    '--remote-debugging-port=' + port,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--new-window',
    '--disable-gpu',
    '--extensions-dir=' + extRoot,
    '--user-data-dir=' + userDataDir,
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, {
      SUDO_STUDIO_ROOT: installDir,
      SUDO_STUDIO_LOGS: logsDir,
    }),
  });
  console.log('[PANEL] editor pid ' + child.pid);
  const killEditor = () => {
    try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (_) {}
  };
  process.on('exit', killEditor);

  try {
    // Wait for CDP.
    let targets = null;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      try { targets = await listTargets(port); if (targets && targets.length) break; } catch (_) {}
    }
    if (!targets || !targets.length) { fail('cdp never came up'); throw new Error('no-cdp'); }
    const mainT = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://')) || targets[0];
    report.windowTitle = mainT.title || '';
    for (let i = 0; i < 15 && report.windowTitle.indexOf('Sudo Studio') === -1; i++) {
      await sleep(2000);
      try {
        const re = await listTargets(port);
        const mt = re.find((t) => t.id === mainT.id) ||
          re.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
        if (mt && mt.title) report.windowTitle = mt.title;
      } catch (_) {}
    }
    console.log('[PANEL] window title: ' + report.windowTitle);
    if (report.windowTitle.indexOf('Sudo Studio') === -1) fail('window title lacks "Sudo Studio": ' + report.windowTitle);
    const main = new Cdp(mainT.webSocketDebuggerUrl);
    await main.connect();
    await main.send('Runtime.enable');
    await main.send('Log.enable');
    await main.send('Page.enable');
    main.drainErrors(); // flush startup noise

    const seen = new Set(targets.map((t) => t.id));
    let first = true;
    for (const [id, substr] of PANELS) {
      const rec = { id, substr, pass: true };
      try {
        const pst = await openPaletteAndRun(main, substr, first);
        rec.palette = pst;
        first = false;
        if (pst && pst.rows === 0) { rec.pass = false; rec.error = 'palette no match: ' + substr; }
        let now = await listTargets(port);
        let fresh = now.filter((t) => !seen.has(t.id) && t.webSocketDebuggerUrl && !(t.url || '').startsWith('devtools://'));
        if (!fresh.length) { // slow webview registration: second chance
          await sleep(6000);
          now = await listTargets(port);
          fresh = now.filter((t) => !seen.has(t.id) && t.webSocketDebuggerUrl && !(t.url || '').startsWith('devtools://'));
        }
        fresh.forEach((t) => seen.add(t.id));
        if (!fresh.length) { rec.pass = false; rec.error = 'no new webview target'; }
        let best = null;
        // Inspect page-type targets first (webviews); workers rarely usable.
        fresh.sort((a, b) => ((b.type === 'page') - (a.type === 'page')));
        for (const t of fresh) {
          const c = new Cdp(t.webSocketDebuggerUrl);
          try {
            await c.connect();
            await c.send('Runtime.enable');
            await sleep(2500);
            const ev = await evalWebview(c);
            const { errs, warns } = c.drainErrors();
            const info = { type: t.type || '', url: (t.url || '').slice(0, 120), title: ev.t || '', textLen: ev.n || 0, fatal: !!ev.fatal, fb: !!ev.fb, errs, warns, shot: null };
            try { // screenshot is evidence only; webviews may reject it (-32000)
              const shot = await c.send('Page.captureScreenshot', { format: 'png' });
              const shotPath = path.join(outDir, label + '-' + id + '.png');
              fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
              info.shot = path.basename(shotPath);
            } catch (se) { info.shotErr = String(se && se.message || se).slice(0, 120); }
            if (!best || (info.textLen || 0) > (best.textLen || 0)) best = info;
            (rec.targets = rec.targets || []).push(info);
          } catch (e) {
            (rec.targets = rec.targets || []).push({ type: t.type || '', url: (t.url || '').slice(0, 120), error: String(e && e.message || e).slice(0, 200) });
          } finally { c.close(); }
        }
        try { // whole-window evidence (main target is top-level: always works)
          const ws = await main.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(outDir, label + '-' + id + '-window.png'), Buffer.from(ws.data, 'base64'));
          rec.windowShot = true;
        } catch (_) { rec.windowShot = false; }
        rec.best = best;
        if (rec.pass && !best) {
          rec.pass = false;
          const terr = (rec.targets || []).map((x) => x.error).filter(Boolean)[0];
          rec.error = 'webview inspection failed' + (terr ? ': ' + terr : ' (no usable target)');
        }
        if (rec.pass && best) {
          if (best.fatal) { rec.pass = false; rec.error = 'guard fatal overlay visible'; }
          else if ((best.textLen || 0) < MIN_TEXT_LEN) { rec.pass = false; rec.error = 'blank (textLen=' + best.textLen + ')'; }
          const allErrs = (rec.targets || []).reduce((a, x) => a.concat(x.errs || []), []);
          if (allErrs.length) { rec.pass = false; rec.error = allErrs[0]; rec.allErrs = allErrs; }
        }
      } catch (e) {
        rec.pass = false;
        rec.error = String(e && e.message || e).slice(0, 200);
      }
      report.panels.push(rec);
      console.log('[PANEL-' + (rec.pass ? 'PASS' : 'FAIL') + '] ' + id + ' textLen=' + ((rec.best && rec.best.textLen) || 0) +
        ' fatal=' + ((rec.best && rec.best.fatal) || false) + ' fb=' + ((rec.best && rec.best.fb) || false) +
        (rec.error ? ' :: ' + rec.error : ''));
      if (!rec.pass) fail('panel ' + id + ': ' + (rec.error || '?'));
    }
    try { // workbench-side errors (command failures, host crashes): diagnostic only
      const me = main.drainErrors();
      report.mainErrs = (me.errs || []).slice(0, 8);
      report.mainWarns = (me.warns || []).slice(0, 4);
    } catch (_) {}
    main.close();

    // Old logo + titlebar svg.
    const ol = oldLogoCheck(installDir);
    report.oldLogo = { hits: ol.hits.slice(0, 8), svgEq: ol.svgEq };
    console.log('[PANEL] old-logo hits=' + ol.hits.length + ' svgEq=' + ol.svgEq);
    if (!ol.pass) fail('old logo present: ' + (ol.hits[0] || 'svg mismatch'));

    // product.json commit.
    try {
      const pj = readJson(path.join(installDir, 'resources', 'app', 'product.json'));
      report.product = { nameShort: pj.nameShort, commit: pj.commit };
      if (pj.nameShort !== 'Sudo Studio') fail('product nameShort=' + pj.nameShort);
      if (manifestCommit && pj.commit !== manifestCommit) fail('product commit != manifest (' + pj.commit + ')');
    } catch (e) { fail('product.json unreadable'); }

    // Shortcuts (installed run only).
    if (!skipShortcuts) {
      try {
        const desk = shellFolder('Desktop');
        const sm = shellFolder('StartMenu');
        const dlnk = path.join(desk, 'Sudo Studio.lnk');
        const slnk = path.join(sm, 'Programs', 'Sudo Studio', 'Sudo Studio.lnk');
        report.shortcuts = { desktop: fs.existsSync(dlnk), startmenu: fs.existsSync(slnk) };
        console.log('[PANEL] shortcuts desktop=' + report.shortcuts.desktop + ' startmenu=' + report.shortcuts.startmenu);
        if (!report.shortcuts.desktop) fail('desktop shortcut "Sudo Studio.lnk" missing');
        if (!report.shortcuts.startmenu) fail('start-menu shortcut missing');
      } catch (e) { fail('shortcut check error: ' + String(e.message || e).slice(0, 150)); }
    }

    // Install pristine.
    const after = snapshotInstall(installDir);
    const diffs = [];
    for (const k of Object.keys(after)) {
      if (!(k in before)) diffs.push('added: ' + k);
      else if (after[k] !== before[k]) diffs.push('modified: ' + k);
    }
    for (const k of Object.keys(before)) { if (!(k in after)) diffs.push('deleted: ' + k); }
    report.pristine = { diffs: diffs.slice(0, 15), count: diffs.length };
    console.log('[PANEL] install diffs=' + diffs.length);
    if (diffs.length) fail('install dir written during run: ' + diffs.slice(0, 5).join('; '));
  } finally {
    killEditor();
  }

  fs.writeFileSync(path.join(outDir, 'report-' + label + '.json'), JSON.stringify(report, null, 1));
  console.log('[PANEL] ' + label + ': ' + (report.pass ? 'SUCCESS' : 'FAILURE') +
    ' (' + report.panels.filter((p) => p.pass).length + '/' + report.panels.length + ' panels)');
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
