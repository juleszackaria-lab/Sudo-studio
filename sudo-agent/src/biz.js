// Sudo Agent business tools (P50-5). Self-contained IDE operations exposed
// to the agent: analyze (project structure), secaudit (leaked secrets +
// dependency advisories), mkignore (stack-aware .gitignore), ci (workflow
// generation), doctor (environment probes), sdk (SDK status + install).
// Logic mirrors the extension panels; the code is standalone (the agent
// ships as its own executable and cannot require extension files).
// Findings NEVER include raw secret values (redacted hints only), and the
// journal must only ever receive counts. Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');

const SKIP_DIRS = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'out', '.sudo_studio', 'coverage', '.next'];

// ---- shared walk ----------------------------------------------------------
function walkFiles(root, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 20000;
  const maxBytes = opts.maxBytes || 1024 * 1024;
  const out = [];
  let skipped = 0;
  const walk = (rel) => {
    if (out.length >= maxFiles) return;
    const abs = rel ? path.join(root, rel) : root;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= maxFiles) { skipped += 1; continue; }
      if (e.isSymbolicLink()) { skipped += 1; continue; }
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.indexOf(e.name) !== -1) continue;
        walk(r);
        continue;
      }
      if (!e.isFile()) continue;
      let size = -1;
      try { size = fs.statSync(path.join(root, r)).size; } catch (_) { skipped += 1; continue; }
      if (size > maxBytes) { skipped += 1; continue; }
      out.push({ rel: r, size });
    }
  };
  walk('');
  return { files: out, skipped };
}

function readTextCapped(abs, maxBytes) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = fs.readFileSync(abs);
    for (let i = 0; i < Math.min(buf.length, 8192); i++) {
      if (buf[i] === 0) return null; // binary
    }
    return buf.toString('utf8');
  } catch (_) { return null; }
}

// ---- analyze ---------------------------------------------------------------
const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.java': 'java',
  '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.rb': 'ruby', '.swift': 'swift', '.kt': 'kotlin',
  '.dart': 'dart', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'xml',
  '.md': 'markdown', '.html': 'html', '.css': 'css', '.sh': 'shell', '.ps1': 'powershell',
  '.sql': 'sql', '.toml': 'toml', '.ini': 'ini', '.gradle': 'gradle',
};
const ENTRY_NAMES = ['index.js', 'main.js', 'app.js', 'server.js', 'main.py', 'app.py',
  'main.go', 'Main.java', 'main.rs', 'lib/main.dart', 'program.cs', 'main.c', 'main.cpp'];
const MANIFEST_NAMES = ['package.json', 'package-lock.json', 'requirements.txt', 'pyproject.toml',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'pom.xml', 'pubspec.yaml', 'Gemfile', 'composer.json'];

function analyze(root) {
  const t0 = Date.now();
  const w = walkFiles(root, { maxFiles: 20000, maxBytes: 1024 * 1024 });
  const byLang = {};
  let lines = 0;
  let todo = 0;
  let fixme = 0;
  const biggest = [];
  const entries = [];
  const tests = [];
  const ci = [];
  const manifests = [];
  let readme = null;
  let dirs = 0;
  const seenDirs = new Set();
  for (const f of w.files) {
    const d = path.posix.dirname(f.rel);
    if (!seenDirs.has(d)) { seenDirs.add(d); dirs += 1; }
    const base = path.posix.basename(f.rel);
    const ext = path.posix.extname(f.rel).toLowerCase();
    const lang = EXT_LANG[ext] || 'other';
    const text = readTextCapped(path.join(root, f.rel), 1024 * 1024);
    if (text === null) continue;
    const n = text.split('\n').length;
    lines += n;
    if (!byLang[lang]) byLang[lang] = { files: 0, lines: 0 };
    byLang[lang].files += 1;
    byLang[lang].lines += n;
    if (/TODO/.test(text)) todo += 1;
    if (/FIXME/.test(text)) fixme += 1;
    biggest.push({ rel: f.rel, lines: n });
    if (ENTRY_NAMES.indexOf(f.rel) !== -1 || ENTRY_NAMES.indexOf(base) !== -1) entries.push(f.rel);
    if (MANIFEST_NAMES.indexOf(base) !== -1) manifests.push(f.rel);
    if (/(^|\/)tests?\//.test('/' + f.rel) || /[_.-]test\.|^test[_.-]/i.test(base)) tests.push(f.rel);
    if (f.rel === '.github/workflows/ci.yml' || f.rel === '.github/workflows/ci-cd.yml' || base === '.gitlab-ci.yml') ci.push(f.rel);
    if (/^readme\.md$/i.test(base) && !readme) readme = f.rel;
  }
  biggest.sort((a, b) => b.lines - a.lines);
  return { files: w.files.length, dirs, lines, skipped: w.skipped, byLang,
    manifests: manifests.sort(), entries: entries.sort(), tests: tests.slice(0, 200),
    ci, readme, todo, fixme, biggest: biggest.slice(0, 10), ms: Date.now() - t0 };
}

// ---- secaudit ---------------------------------------------------------------
// Labels + shapes mirror the extension secret patterns (same 14 families).
const SECRET_PATTERNS = [
  { label: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { label: 'AWS Secret Key', re: /aws.{0,20}secret.{0,20}['"][0-9a-zA-Z/+]{40}['"]/i },
  { label: 'Generic API Key', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/i },
  { label: 'Private Key (PEM)', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: 'Bearer Token', re: /bearer\s+[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/i },
  { label: 'Database Password', re: /(db_pass|database_password|mysql_pass|pg_pass)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { label: 'Slack Webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]+/ },
  { label: 'Stripe Key', re: /(?:r|s)k_(live|test)_[0-9a-zA-Z]{24,}/ },
  { label: 'Google API Key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { label: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'PyPI Token', re: /pypi-[A-Za-z0-9_-]{20,}/ },
  { label: 'NPM Token', re: /_authToken\s*=\s*[^\s'"]+/ },
  { label: 'Database URL', re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^/\s:]+:[^/\s@]+@[^/\s]+/i },
];

// Embedded advisory snapshot (same curated entries as the extension data
// file, format 1). Coverage is intentionally small; the report says so.
const ADVISORY_DB = {
  generatedAt: '2026-10-11',
  note: 'Sudo Studio embedded snapshot, hand-curated from public CVE records. Coverage is intentionally small (npm+pip, 8 entries).',
  advisories: [
    { ecosystem: 'npm', package: 'lodash', vulnerable: '<4.17.21', cve: 'CVE-2020-8203', severity: 'high', summary: 'Prototype pollution in lodash', fixedIn: '4.17.21' },
    { ecosystem: 'npm', package: 'minimist', vulnerable: '<1.2.6', cve: 'CVE-2021-44906', severity: 'critical', summary: 'Prototype pollution in minimist option parsing', fixedIn: '1.2.6' },
    { ecosystem: 'npm', package: 'node-fetch', vulnerable: '<2.6.7', cve: 'CVE-2022-0235', severity: 'high', summary: 'Sensitive information exposure via crafted URL (2.x line)', fixedIn: '2.6.7' },
    { ecosystem: 'npm', package: 'semver', vulnerable: '<7.5.2', cve: 'CVE-2022-25883', severity: 'high', summary: 'Regular expression denial of service (ReDoS)', fixedIn: '7.5.2' },
    { ecosystem: 'pip', package: 'requests', vulnerable: '<2.31.0', cve: 'CVE-2023-32681', severity: 'medium', summary: 'Unintended leak of Proxy-Authorization header to destination', fixedIn: '2.31.0' },
    { ecosystem: 'pip', package: 'urllib3', vulnerable: '<1.26.18', cve: 'CVE-2023-45803', severity: 'medium', summary: 'Request body leaked across redirects (1.x line)', fixedIn: '1.26.18' },
    { ecosystem: 'pip', package: 'urllib3', vulnerable: '>=2.0.0,<2.0.7', cve: 'CVE-2023-45803', severity: 'medium', summary: 'Request body leaked across redirects (2.x line)', fixedIn: '2.0.7' },
    { ecosystem: 'pip', package: 'pyyaml', vulnerable: '<5.4', cve: 'CVE-2020-14343', severity: 'high', summary: 'Arbitrary code execution via yaml.full_load with python/object/new', fixedIn: '5.4' },
  ],
};

function numParts(v) {
  return String(v || '').split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
function cmpVer(a, b) {
  const pa = numParts(a);
  const pb = numParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
// Comma-AND of <,<=,>,>=,= atoms (no OR, no wildcards: unknown => false).
function satisfiesRange(version, range) {
  const atoms = String(range || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!atoms.length) return false;
  for (const a of atoms) {
    const m = /^(<=|>=|<|>|=)?\s*([0-9][0-9A-Za-z.\-]*)$/.exec(a);
    if (!m) return false;
    const op = m[1] || '=';
    const c = cmpVer(String(version).split('-')[0], m[2].split('-')[0]);
    if (op === '<' && !(c < 0)) return false;
    if (op === '<=' && !(c <= 0)) return false;
    if (op === '>' && !(c > 0)) return false;
    if (op === '>=' && !(c >= 0)) return false;
    if (op === '=' && !(c === 0)) return false;
  }
  return true;
}

function cleanSpec(spec) {
  return String(spec || '').trim().replace(/^[~^<>=v\s]+/, '').split(' ')[0];
}

function parseDeps(root) {
  const npm = {};
  const pip = {};
  const uncovered = [];
  const pj = readTextCapped(path.join(root, 'package.json'), 512 * 1024);
  if (pj) {
    try {
      const d = JSON.parse(pj);
      for (const sec of ['dependencies', 'devDependencies']) {
        const o = d && d[sec];
        if (o && typeof o === 'object') {
          for (const k of Object.keys(o)) npm[k] = { spec: String(o[k]), version: cleanSpec(o[k]), from: 'package.json' };
        }
      }
    } catch (_) {}
  }
  const lock = readTextCapped(path.join(root, 'package-lock.json'), 4 * 1024 * 1024);
  if (lock) {
    try {
      const d = JSON.parse(lock);
      const pkgs = (d && d.packages) || {};
      for (const k of Object.keys(pkgs)) {
        if (!k || k === '') continue;
        const name = k.replace(/^node_modules\//, '');
        if (name && pkgs[k] && pkgs[k].version) npm[name] = { spec: pkgs[k].version, version: cleanSpec(pkgs[k].version), from: 'package-lock.json' };
      }
      const deps = (d && d.dependencies) || {};
      for (const k of Object.keys(deps)) {
        if (deps[k] && deps[k].version) npm[k] = { spec: deps[k].version, version: cleanSpec(deps[k].version), from: 'package-lock.json' };
      }
    } catch (_) {}
  }
  const req = readTextCapped(path.join(root, 'requirements.txt'), 512 * 1024);
  if (req) {
    for (const line of req.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.\-]+)\s*==\s*([A-Za-z0-9_.\-+]+)/.exec(line);
      if (m) pip[m[1].toLowerCase()] = { spec: '==' + m[2], version: m[2], from: 'requirements.txt' };
      else if (/^\s*[A-Za-z0-9_.\-]+/.test(line) && line.trim() && line.trim()[0] !== '#') uncovered.push('pip:' + line.trim().slice(0, 60) + ' (non epingle)');
    }
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) uncovered.push('pyproject.toml (non analyse)');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) uncovered.push('Cargo.toml (non analyse)');
  if (fs.existsSync(path.join(root, 'go.mod'))) uncovered.push('go.mod (non analyse)');
  return { npm, pip, uncovered: uncovered.slice(0, 50) };
}

function scanSecrets(root) {
  const w = walkFiles(root, { maxFiles: 2000, maxBytes: 256 * 1024 });
  const findings = [];
  for (const f of w.files) {
    const text = readTextCapped(path.join(root, f.rel), 256 * 1024);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && findings.length < 100; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      for (const p of SECRET_PATTERNS) {
        let m = null;
        try { m = p.re.exec(line); } catch (_) { m = null; }
        if (m) {
          findings.push({ rel: f.rel, line: i + 1, label: p.label,
            hint: String(m[0]).slice(0, 4) + '...' + ' (' + m[0].length + ' car.)' });
          break;
        }
      }
    }
    if (findings.length >= 100) break;
  }
  return { findings, filesScanned: w.files.length, skipped: w.skipped, capped: findings.length >= 100 };
}

function secaudit(root) {
  const t0 = Date.now();
  const sec = scanSecrets(root);
  const deps = parseDeps(root);
  const advisories = [];
  const check = (eco, table) => {
    for (const name of Object.keys(table)) {
      for (const adv of ADVISORY_DB.advisories) {
        if (adv.ecosystem !== eco) continue;
        if (adv.package.toLowerCase() !== name.toLowerCase()) continue;
        const v = table[name].version;
        if (v && satisfiesRange(v, adv.vulnerable)) {
          advisories.push({ ecosystem: eco, package: name, version: v,
            cve: adv.cve, severity: adv.severity, summary: adv.summary, fixedIn: adv.fixedIn });
          break;
        }
      }
    }
  };
  check('npm', deps.npm);
  check('pip', deps.pip);
  return { secrets: sec.findings, secretFiles: sec.filesScanned, secretsCapped: sec.capped,
    deps: { npm: Object.keys(deps.npm).length, pip: Object.keys(deps.pip).length },
    advisories, uncovered: deps.uncovered,
    db: { generatedAt: ADVISORY_DB.generatedAt, entries: ADVISORY_DB.advisories.length, note: ADVISORY_DB.note },
    ms: Date.now() - t0 };
}

// ---- mkignore ---------------------------------------------------------------
const IGNORE_BASE = ['.env', '.env.*', '*.pem', '*.key', '.DS_Store', 'Thumbs.db', '.vscode/*', '!.vscode/extensions.json'];
const IGNORE_STACKS = {
  node: ['node_modules/', 'dist/', 'coverage/', '*.log', 'npm-debug.log*', '.npm/'],
  python: ['__pycache__/', '*.pyc', '.venv/', 'venv/', '*.egg-info/', '.pytest_cache/', '.coverage'],
  java: ['target/', '*.class', '*.jar', '.gradle/', 'build/'],
  go: ['bin/', '*.exe', '*.test', 'vendor/'],
  rust: ['target/', 'Cargo.lock'],
  dotnet: ['bin/', 'obj/', '*.user', '.vs/'],
  dart: ['.dart_tool/', 'build/', '*.g.dart'],
};
function detectStacks(root) {
  const stacks = [];
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) stacks.push('node');
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) stacks.push('python');
  if (has('pom.xml') || has('build.gradle')) stacks.push('java');
  if (has('go.mod')) stacks.push('go');
  if (has('Cargo.toml')) stacks.push('rust');
  if (has('pubspec.yaml')) stacks.push('dart');
  try {
    const files = fs.readdirSync(root);
    if (files.some((f) => /\.csproj$|\.sln$/.test(f))) stacks.push('dotnet');
  } catch (_) {}
  return stacks;
}

function mkignore(root, stack) {
  let stacks = [];
  if (stack) {
    if (!IGNORE_STACKS[stack]) return { ok: false, error: 'stack inconnue (' + Object.keys(IGNORE_STACKS).join('|') + ').' };
    stacks = [stack];
  } else {
    stacks = detectStacks(root);
  }
  const wanted = IGNORE_BASE.concat(...stacks.map((s) => IGNORE_STACKS[s]));
  const giPath = path.join(root, '.gitignore');
  let existing = '';
  let existed = false;
  try {
    const st = fs.statSync(giPath);
    if (!st.isFile()) return { ok: false, error: '.gitignore n est pas un fichier.' };
    existing = fs.readFileSync(giPath, 'utf8');
    existed = true;
  } catch (_) { existing = ''; existed = false; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const added = wanted.filter((w) => !have.has(w));
  if (!added.length) return { ok: true, stacks, added: [], existed, path: '.gitignore' };
  const marker = '# ajoute par Sudo Studio (' + (stacks.join('+') || 'base') + ')';
  const out = (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + marker + '\n' + added.join('\n') + '\n';
  try { fs.writeFileSync(giPath, out, 'utf8'); }
  catch (e) { return { ok: false, error: 'ecriture .gitignore impossible.' }; }
  return { ok: true, stacks, added, existed, path: '.gitignore' };
}

// ---- ci ----------------------------------------------------------------------
function detectPm(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}
function hasTestScript(root) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return !!(d && d.scripts && d.scripts.test);
  } catch (_) { return false; }
}
function githubYml(stacks, pm, testScript) {
  const steps = [];
  if (stacks.indexOf('node') !== -1) {
    steps.push('      - uses: actions/checkout@v4\n'
      + '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          cache: ' + pm + '\n'
      + '      - run: ' + (pm === 'npm' ? 'npm ci' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'pnpm install --frozen-lockfile') + '\n'
      + (testScript ? '      - run: ' + (pm === 'yarn' ? 'yarn' : pm + ' run') + ' test\n' : ''));
  }
  if (stacks.indexOf('python') !== -1) {
    steps.push('      - uses: actions/checkout@v4\n'
      + '      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.11"\n'
      + '      - run: pip install -r requirements.txt\n'
      + '      - run: python -m pytest -q\n');
  }
  if (!steps.length) {
    steps.push('      - uses: actions/checkout@v4\n      - run: echo "aucune stack detectee : completez ce workflow"\n');
  }
  return '# Genere par Sudo Studio. Verifiez avant usage.\nname: ci\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n' + steps.join('');
}
function gitlabYml(stacks, pm, testScript) {
  const lines = ['# Genere par Sudo Studio. Verifiez avant usage.', 'stages: [build, test]'];
  if (stacks.indexOf('node') !== -1) {
    lines.push('node-build:', '  image: node:20', '  stage: build',
      '  script:', '    - ' + (pm === 'npm' ? 'npm ci' : pm + ' install'));
    if (testScript) lines.push('node-test:', '  image: node:20', '  stage: test', '  script:', '    - ' + (pm === 'yarn' ? 'yarn test' : pm + ' test'));
  }
  if (stacks.indexOf('python') !== -1) {
    lines.push('python-test:', '  image: python:3.11', '  stage: test', '  script:', '    - pip install -r requirements.txt', '    - python -m pytest -q');
  }
  if (lines.length === 2) lines.push('check:', '  stage: build', '  script:', '    - echo "aucune stack detectee : completez ce workflow"');
  return lines.join('\n') + '\n';
}
function ciPathFor(provider) {
  return provider === 'gitlab' ? '.gitlab-ci.yml' : '.github/workflows/ci.yml';
}
function ci(root, provider) {
  const prov = provider || 'github';
  if (prov !== 'github' && prov !== 'gitlab') return { ok: false, error: 'fournisseur invalide (github|gitlab).' };
  const rel = ciPathFor(prov);
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) return { ok: false, error: rel + ' existe deja (refus d ecraser).' };
  const stacks = detectStacks(root);
  const pm = detectPm(root);
  const testScript = stacks.indexOf('node') !== -1 && hasTestScript(root);
  const content = prov === 'gitlab' ? gitlabYml(stacks, pm, testScript) : githubYml(stacks, pm, testScript);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  } catch (_) { return { ok: false, error: 'ecriture ' + rel + ' impossible.' }; }
  return { ok: true, path: rel, provider: prov, stacks, pm, testScript };
}

// ---- doctor --------------------------------------------------------------------
function probe(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const win = (v) => { if (!done) { done = true; resolve(v); } };
    let child = null;
    try {
      child = execFile(bin, args || [], { timeout: timeoutMs || 5000, windowsHide: true }, (err, stdout) => {
        if (err) { win({ ok: false }); return; }
        const first = String(stdout || '').trim().split('\n')[0].slice(0, 120);
        win(first ? { ok: true, value: first } : { ok: false });
      });
    } catch (_) { win({ ok: false }); return; }
    setTimeout(() => { try { if (child) child.kill('SIGKILL'); } catch (_) {} win({ ok: false }); }, (timeoutMs || 5000) + 500);
  });
}
function httpHealth(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const win = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(url, { timeout: timeoutMs || 2000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; if (raw.length > 8192) { try { res.destroy(); } catch (_) {} } });
      res.on('end', () => win({ ok: res.statusCode >= 200 && res.statusCode < 300, data: raw.slice(0, 2000) }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} win({ ok: false }); });
    req.on('error', () => win({ ok: false }));
  });
}
async function doctor() {
  const isWin = process.platform === 'win32';
  const defs = [
    ['Node.js', 'node', ['--version']],
    ['npm', 'npm', ['--version']],
    ['Python', isWin ? 'python' : 'python3', ['--version']],
    ['pip', isWin ? 'pip' : 'pip3', ['--version']],
    ['Git', 'git', ['--version']],
    ['Docker', 'docker', ['--version']],
  ];
  const checks = [];
  for (const [name, bin, args] of defs) {
    const r = await probe(bin, args, 5000);
    checks.push(r.ok ? { name, status: 'ok', value: r.value } : { name, status: 'error', value: 'introuvable' });
  }
  const backend = await httpHealth('http://127.0.0.1:5000/api/system/health', 2000);
  checks.push(backend.ok
    ? { name: 'Backend (port 5000)', status: 'ok', value: 'en ligne' }
    : { name: 'Backend (port 5000)', status: 'error', value: 'hors ligne' });
  const rt = await httpHealth('http://127.0.0.1:6000/health', 2000);
  if (!rt.ok) checks.push({ name: 'Runtime IA (port 6000)', status: 'error', value: 'hors ligne' });
  else {
    let label = 'en ligne (modele inconnu)';
    let st = 'warn';
    try {
      const d = JSON.parse(rt.data);
      const m = (d && d.model) || {};
      if (m.loaded) { label = 'en ligne : ' + String(m.name || 'modele'); st = 'ok'; }
      else if (m.loading) label = 'chargement (' + (m.download_progress || 0) + '%)';
      else label = 'en ligne (aucun modele)';
    } catch (_) {}
    checks.push({ name: 'Runtime IA (port 6000)', status: st, value: label });
  }
  checks.push({ name: 'Plateforme', status: 'info', value: os.platform() + ' ' + os.arch() });
  checks.push({ name: 'RAM', status: 'info',
    value: Math.round(os.totalmem() / 1073741824) + ' Go total, ' + Math.round(os.freemem() / 1073741824) + ' Go libres' });
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(os.tmpdir());
      checks.push({ name: 'Disque', status: 'info', value: Math.round(s.bfree * s.bsize / 1073741824) + ' Go libres' });
    }
  } catch (_) {}
  return { checks };
}

// ---- sdk -------------------------------------------------------------------------
// Catalog mirrors the extension SDK page (ids + probes + per-OS commands).
const SDKS = [
  { id: 'nodejs', name: 'Node.js', detect: ['node', ['--version']], win: 'winget install OpenJS.NodeJS.LTS', mac: 'brew install node', linux: 'sudo apt-get install -y nodejs npm' },
  { id: 'python', name: 'Python', detect: ['python', ['--version']], win: 'winget install Python.Python.3.11', mac: 'brew install python@3.11', linux: 'sudo apt-get install -y python3 python3-pip' },
  { id: 'git', name: 'Git', detect: ['git', ['--version']], win: 'winget install Git.Git', mac: 'brew install git', linux: 'sudo apt-get install -y git' },
  { id: 'docker', name: 'Docker', detect: ['docker', ['--version']], win: 'winget install Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements', mac: 'brew install --cask docker', linux: null },
  { id: 'flutter', name: 'Flutter', detect: ['flutter', ['--version']], win: 'winget install Google.Flutter', mac: 'brew install --cask flutter', linux: null },
  { id: 'java', name: 'Java (JDK)', detect: ['java', ['--version']], win: 'winget install Microsoft.OpenJDK.21', mac: 'brew install openjdk@21', linux: 'sudo apt-get install -y openjdk-21-jdk' },
  { id: 'rust', name: 'Rust', detect: ['rustc', ['--version']], win: 'winget install Rustlang.Rustup', mac: null, linux: null },
  { id: 'go', name: 'Go', detect: ['go', ['version']], win: 'winget install GoLang.Go', mac: 'brew install go', linux: 'sudo apt-get install -y golang-go' },
  { id: 'pip', name: 'pip', detect: ['pip', ['--version']], win: 'python -m ensurepip --upgrade', mac: 'python3 -m ensurepip --upgrade', linux: 'python3 -m ensurepip --upgrade' },
  { id: 'transformers', name: 'AI Libraries', detect: ['python', ['-c', 'import transformers']], win: 'python -m pip install transformers torch', mac: 'python3 -m pip install transformers torch', linux: 'python3 -m pip install transformers torch' },
  { id: 'android-sdk', name: 'Android SDK', detect: ['sdkmanager', ['--version']], win: null, mac: null, linux: null },
];
function sdkById(id) { return SDKS.find((s) => s.id === id) || null; }
function sdkCommandFor(entry) {
  if (process.platform === 'win32') return entry.win;
  if (process.platform === 'darwin') return entry.mac;
  return entry.linux;
}
// Fail-closed argv split for catalog commands: single binary + simple args,
// NO shell metacharacters, else null (refuse to run).
function sdkSplitWin(cmd) {
  if (typeof cmd !== 'string' || !cmd) return null;
  if (/[|&;<>()$`"'\\!]/.test(cmd)) return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length < 2 || parts[0].toLowerCase() !== 'winget') return null;
  if (parts.some((p) => p.length > 200)) return null;
  return { bin: 'winget', args: parts.slice(1) };
}
async function sdkStatus(id) {
  const list = id ? [sdkById(id)] : SDKS.slice();
  if (id && !list[0]) return { ok: false, error: 'sdk inconnu : ' + id };
  const out = [];
  for (const e of list) {
    let bin = e.detect[0];
    let args = e.detect[1];
    if ((e.id === 'python' || e.id === 'pip' || e.id === 'transformers') && process.platform !== 'win32') {
      bin = e.id === 'pip' ? 'pip3' : 'python3';
    }
    const r = await probe(bin, args, 8000);
    out.push({ id: e.id, name: e.name, installed: r.ok, version: r.ok ? r.value : '' });
  }
  return { ok: true, sdks: out };
}
function sdkInstall(id, opts) {
  opts = opts || {};
  const e = sdkById(id);
  if (!e) return Promise.resolve({ ok: false, error: 'sdk inconnu : ' + id });
  const cmd = sdkCommandFor(e);
  if (!cmd) return Promise.resolve({ ok: false, error: 'installation ' + id + ' non automatisee : utilisez la page SDK.' });
  if (opts.dry) return Promise.resolve({ ok: true, dry: true, id, command: cmd });
  // Live runs: Windows winget only (no shell, argv-split, fail-closed).
  // Anything else: clear refusal, the SDK page owns it.
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'installation live reservee a Windows (winget) : ' + cmd });
  }
  const split = sdkSplitWin(cmd);
  if (!split) return Promise.resolve({ ok: false, error: 'commande catalogue non executable sans shell (refus).' });
  const timeoutMs = Math.min(600000, Math.max(30000, parseInt(opts.timeoutMs, 10) || 300000));
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(split.bin, split.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ ok: false, error: 'lancement impossible (' + String((err && err.message) || err).slice(0, 120) + ').' });
      return;
    }
    let out = '';
    let errT = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (c) => { out = (out + c).slice(-16384); });
    child.stderr.on('data', (c) => { errT = (errT + c).slice(-16384); });
    child.on('error', (er) => { try { clearTimeout(timer); } catch (_) {} resolve({ ok: false, error: 'winget: ' + String((er && er.message) || er).slice(0, 160) }); });
    child.on('exit', (code) => {
      try { clearTimeout(timer); } catch (_) {}
      if (code === 0) resolve({ ok: true, id, code: 0, tail: (out + errT).slice(-2000) });
      else resolve({ ok: false, error: 'winget sortie ' + code + '.\n' + (out + errT).slice(-2000), code });
    });
  });
}

module.exports = {
  analyze, secaudit, mkignore, detectStacks, ci, ciPathFor, doctor, probe,
  sdkStatus, sdkInstall, sdkById, sdkSplitWin, SDKS, ADVISORY_DB,
  satisfiesRange, parseDeps, scanSecrets,
};
