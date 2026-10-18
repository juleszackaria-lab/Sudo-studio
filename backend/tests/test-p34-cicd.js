/**
 * SUDO STUDIO - P34: generated CI YAML is valid and fits the project.
 * A: (a) quoted "on" trigger (unquoted parses as bool true under YAML 1.1
 *    -> editor schema flags the file with "!") for all 5 stacks
 * B: (b) REAL per-stack steps (install, checks, tests, build)
 * C: (b) no secrets/values, no dangerous fakes, actionlint-clean shape
 * D: (c) no blind overwrite: identical=no-op, else diff + confirm
 * E: java build-tool detection (maven vs gradle)
 * Structural pins (actionlint itself runs where the binary exists; the 0-error
 * outputs for the 5 stacks are mission evidence, produced at dev time).
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
process.env.SUDO_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-audit-'));
let n = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { n++; console.log('ok - ' + name); }); }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'p34-' + name + '-')); }

// -- harness: stub vscode + axios, load the real panel --------------------------
function loadPanel(st) {
  const modPath = path.join(ROOT, 'sudo-ai-extension/src/panels/DevOpsPanel.js');
  delete require.cache[modPath];
  const calls = { diff: [], warns: [], infos: [], posts: [] };
  const vs = {
    window: {
      showWarningMessage: async (m) => { calls.warns.push(m); return st.warnAnswer; },
      showInformationMessage: (m) => { calls.infos.push(m); return { then: (cb) => cb(undefined) }; },
      showErrorMessage: async (m) => { calls.errs = calls.errs || []; calls.errs.push(m); },
      showTextDocument: async () => {},
    },
    workspace: {
      workspaceFolders: st.wsRoot ? [{ uri: { fsPath: st.wsRoot } }] : undefined,
      openTextDocument: async () => ({ uri: {} }),
    },
    commands: { executeCommand: async (...a) => { calls.diff.push(a); } },
    Uri: { file: (p) => ({ fsPath: p }) },
    ViewColumn: { One: 1 },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') return vs;
    if (request === 'axios') return { get: async () => { throw new Error('stub'); } };
    return origLoad.apply(this, arguments);
  };
  let mod;
  try { mod = require(modPath); } finally { Module._load = origLoad; }
  return { DevOpsPanel: mod.DevOpsPanel, calls };
}

async function generate(stack, extra) {
  const { DevOpsPanel } = loadPanel({});
  let out = null;
  const fake = {
    projectInfo: Object.assign({ name: 'demoapp', stack, port: 3000 }, extra || {}),
    writeFile: async (p, c) => { out = { p, c }; },
  };
  await DevOpsPanel.prototype.generateGithubActions.call(fake, {});
  return out;
}

const STACKS = ['nextjs', 'nodejs', 'python', 'flutter', 'java'];
const GEN = {};
async function main() {
  for (const s of STACKS) GEN[s] = await generate(s === 'java' ? 'java' : s, s === 'java' ? { buildTool: 'maven' } : {});
  GEN['java-gradle'] = await generate('java', { buildTool: 'gradle' });

  // -- A: quoted trigger ------------------------------------------------------
  await check('A1: "on" is quoted (bool coercion = the PC "!") on all 5', () => {
    for (const s of STACKS) {
      assert.ok(GEN[s].c.includes('\n"on":\n'), s + ' quoted');
      assert.ok(!/(^|\n)on:\n/.test(GEN[s].c), s + ' no bare on:');
      assert.strictEqual(GEN[s].p, '.github/workflows/ci-cd.yml', s + ' path');
    }
  });

  // -- B: real per-stack steps --------------------------------------------------
  await check('B1: nextjs = clean install + lint/test + STRICT build', () => {
    const c = GEN.nextjs.c;
    for (const m of ['setup-node@v4', 'npm ci', 'npm run lint --if-present',
        'npm test --if-present', "run: npm run build\n"]) assert.ok(c.includes(m), m);
  });
  await check('B2: nodejs keeps build lenient (--if-present)', () => {
    assert.ok(GEN.nodejs.c.includes('npm run build --if-present'), 'lenient build');
  });
  await check('B3: python = pip + ruff errors + guarded pytest/build', () => {
    const c = GEN.python.c;
    for (const m of ['setup-python@v5', 'requirements.txt', 'ruff check . --select E,F',
        'python -m pytest -q', 'no tests directory - skipping', 'python -m build']) {
      assert.ok(c.includes(m), m);
    }
    assert.ok(!c.includes('pytest --if-present'), 'bogus flag gone');
  });
  await check('B4: flutter = pub get + analyze + test + web release', () => {
    const c = GEN.flutter.c;
    for (const m of ['subosito/flutter-action@v2', 'flutter pub get', 'flutter analyze',
        'flutter test', 'flutter build web --release']) assert.ok(c.includes(m), m);
  });
  await check('B5: java maven = setup-java + verify + package', () => {
    const c = GEN.java.c;
    for (const m of ["distribution: 'temurin'", "java-version: '17'", "cache: 'maven'",
        'mvn -B -ntp verify', 'mvn -B -ntp package -DskipTests']) assert.ok(c.includes(m), m);
  });
  await check('B6: java gradle = setup-java + build + assemble', () => {
    const c = GEN['java-gradle'].c;
    for (const m of ["cache: 'gradle'", 'gradle build --no-daemon', 'gradle assemble --no-daemon']) {
      assert.ok(c.includes(m), m);
    }
  });
  await check('B7: docker tags use the sanitized app name', async () => {
    const o = await generate('nodejs', { name: 'My Demo App!' });
    assert.ok(o.c.includes('/my-demo-app:latest'), 'sanitized tag');
    const o2 = await generate('nodejs', { name: '!!!' });
    assert.ok(o2.c.includes('/app:latest'), 'fallback tag');
  });
  await check('B8: generation-time probe picks maven vs gradle from disk', async () => {
    const d1 = tmp('pom'); fs.writeFileSync(path.join(d1, 'pom.xml'), '<p/>');
    const m = await generate('java', { root: d1 });
    assert.ok(m.c.includes('mvn -B -ntp verify'), 'pom -> maven');
    const d2 = tmp('gradle'); fs.writeFileSync(path.join(d2, 'build.gradle.kts'), '// kts');
    const g = await generate('java', { root: d2 });
    assert.ok(g.c.includes('gradle build --no-daemon'), 'kts -> gradle');
  });

  // -- C: secrets/shape ---------------------------------------------------------
  await check('C1: secret REFERENCES only, no values, no deploy fake', () => {
    for (const s of STACKS) {
      const c = GEN[s].c;
      for (const bad of ['ghp_', 'BEGIN PRIVATE', 'Add your deploy step', 'password: hunter',
          'DOCKERHUB_TOKEN: ', 'token: abc']) assert.ok(!c.includes(bad), s + ' ' + bad);
      for (const ln of c.split('\n')) {
        if (/password/i.test(ln)) assert.ok(ln.includes('secrets.'), s + ': ' + ln.trim());
      }
      assert.ok(c.includes('HAS_DOCKERHUB'), s + ' env gate');
    }
  });
  await check('C2: jobs test -> build -> docker(main-only), no secrets in if:', () => {
    for (const s of STACKS) {
      const c = GEN[s].c;
      assert.ok(c.includes('needs: test') && c.includes('needs: build'), s + ' chain');
      assert.ok(c.includes("if: github.ref == 'refs/heads/main'"), s + ' main-only');
      for (const ln of c.split('\n')) {
        if (/^\s*if:/.test(ln)) assert.ok(!ln.includes('secrets.'), s + ': ' + ln.trim());
      }
    }
  });

  // -- D: no blind overwrite ------------------------------------------------------
  async function writeCase(setup) {
    const ws = tmp('ws');
    const { DevOpsPanel, calls } = loadPanel({ wsRoot: ws, warnAnswer: setup.answer });
    const posts = [];
    const fake = { panel: { webview: { postMessage: (m) => posts.push(m) } } };
    if (setup.existing !== undefined) {
      fs.mkdirSync(path.join(ws, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.github', 'workflows', 'ci-cd.yml'), setup.existing);
    }
    await DevOpsPanel.prototype.writeFile.call(fake, '.github/workflows/ci-cd.yml', setup.content, 'yaml', true);
    return { calls, posts, file: path.join(ws, '.github', 'workflows', 'ci-cd.yml') };
  }
  await check('D1: identical content = no-op (info, no diff, no prompt)', async () => {
    const r = await writeCase({ existing: 'same', content: 'same', answer: 'Oui' });
    assert.strictEqual(r.calls.diff.length, 0, 'no diff');
    assert.strictEqual(r.calls.warns.length, 0, 'no prompt');
    assert.ok(r.calls.infos.some((m) => /deja a jour/.test(m)), 'info shown');
    assert.ok(r.posts.some((m) => m.type === 'fileUpToDate'), 'up-to-date posted');
    assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'same', 'untouched');
  });
  await check('D2: different + Oui = diff shown, then overwritten, tmp cleaned', async () => {
    const r = await writeCase({ existing: 'old', content: 'new', answer: 'Oui' });
    assert.strictEqual(r.calls.diff.length, 1, 'one diff');
    assert.strictEqual(r.calls.diff[0][0], 'vscode.diff', 'diff command');
    assert.ok(String(r.calls.diff[0][3]).includes('existant / nouveau'), 'diff title');
    assert.strictEqual(r.calls.warns.length, 1, 'one prompt');
    assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'new', 'overwritten');
    assert.ok(!fs.existsSync(r.calls.diff[0][2].fsPath), 'tmp cleaned');
    assert.ok(r.posts.some((m) => m.type === 'fileGenerated'), 'generated posted');
  });
  await check('D3: different + Annuler = diff shown, file kept, tmp cleaned', async () => {
    const r = await writeCase({ existing: 'old', content: 'new', answer: 'Annuler' });
    assert.strictEqual(r.calls.diff.length, 1, 'diff shown first');
    assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'old', 'kept');
    assert.ok(!fs.existsSync(r.calls.diff[0][2].fsPath), 'tmp cleaned');
    assert.ok(r.posts.some((m) => m.type === 'fileCancelled'), 'cancelled posted');
  });
  await check('D4: new file = written, no diff, no prompt', async () => {
    const r = await writeCase({ content: 'fresh', answer: 'Oui' });
    assert.strictEqual(r.calls.diff.length, 0, 'no diff');
    assert.strictEqual(r.calls.warns.length, 0, 'no prompt');
    assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'fresh', 'written');
  });

  // -- E: build-tool detection ------------------------------------------------------
  await check('E1: detectProject records maven vs gradle', async () => {
    for (const [f, want] of [['pom.xml', 'maven'], ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle']]) {
      const ws = tmp('det');
      fs.writeFileSync(path.join(ws, f), 'x');
      const { DevOpsPanel } = loadPanel({ wsRoot: ws });
      const posts = [];
      const fake = { panel: { webview: { postMessage: (m) => posts.push(m) } }, projectInfo: null };
      await DevOpsPanel.prototype.detectProject.call(fake);
      assert.strictEqual(fake.projectInfo.stack, 'java', f);
      assert.strictEqual(fake.projectInfo.buildTool, want, f);
    }
  });

  console.log('P34 passed: ' + n + ' checks');
}

main().catch((e) => { console.error('P34-cicd FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
