/**
 * SUDO STUDIO - PROMPT 9: deterministic project analysis (no AI).
 * Pure Node (no vscode): streaming directory walk with progress, cancel
 * (AbortSignal), timeout and file caps; per-language file/line stats, tree
 * rollup, biggest files, entry points, tests, CI, README, TODO/FIXME,
 * dependency versions from lockfiles (+ unlocked/unpinned flags).
 * Every number is verifiable: skip set + caps are reported in meta.
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Directories skipped BY NAME at any depth (dependency caches, VCS, outputs).
const SKIP_DIRS = ['node_modules', '.git', 'build', '.dart_tool', 'venv', '.venv',
    'dist', '.next', 'out', 'target', '__pycache__', '.idea', '.vscode', '.gradle',
    'Pods', '.svn', '.hg', 'coverage', '.nyc_output', '.tox', '.eggs'];

const EXT_LANG = {
    '.dart': 'dart',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.vue': 'vue', '.svelte': 'svelte',
    '.py': 'python', '.pyw': 'python',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.hh': 'cpp',
    '.m': 'objc', '.mm': 'objc',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
    '.md': 'markdown', '.markdown': 'markdown', '.rst': 'text', '.txt': 'text',
    '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
    '.sql': 'sql',
    '.gradle': 'gradle',
};

function langOf(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (EXT_LANG[ext]) return EXT_LANG[ext];
    const base = path.basename(String(fileName || ''));
    if (base === 'Dockerfile' || base.indexOf('Dockerfile.') === 0) return 'docker';
    if (base === 'Makefile' || base === 'makefile' || base === 'CMakeLists.txt') return 'make';
    if (base === 'Jenkinsfile') return 'groovy';
    return 'other';
}

function fail(code, message, partial) {
    const e = new Error(message);
    e.code = code;
    if (partial) e.partial = partial;
    return e;
}

function toPosix(p) {
    return String(p || '').replace(/\\/g, '/');
}

async function tick() {
    return new Promise((r) => setImmediate(r));
}

function isTestFile(relPosix) {
    const lower = relPosix.toLowerCase();
    if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(lower)) return true;
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    return /(\.test\.|\.spec\.|_test\.|test_.*\.|-test\.)/.test(base) ||
        /(test\.java|tests\.cs|_test\.go|_test\.dart|_test\.py|test_.*\.py)$/.test(base);
}

function ciSystem(relPosix) {
    const l = relPosix.toLowerCase();
    if (l.indexOf('.github/workflows/') === 0 && /\.(yml|yaml)$/.test(l)) return 'github-actions';
    if (l === '.gitlab-ci.yml') return 'gitlab-ci';
    if (/^jenkinsfile/.test(l)) return 'jenkins';
    if (l === 'azure-pipelines.yml' || l === 'azure-pipelines.yaml') return 'azure-pipelines';
    if (l === '.circleci/config.yml') return 'circleci';
    if (l === 'bitbucket-pipelines.yml') return 'bitbucket';
    if (l === '.travis.yml') return 'travis';
    if (l.indexOf('.buildkite/') === 0) return 'buildkite';
    return null;
}

function entryKind(relPosix) {
    const l = relPosix.toLowerCase();
    const base = l.slice(l.lastIndexOf('/') + 1);
    if (l === 'lib/main.dart') return 'flutter';
    if (l === 'src/index.js' || l === 'src/index.ts' || l === 'src/index.jsx' ||
        l === 'src/index.tsx' || l === 'src/main.js' || l === 'src/main.ts' ||
        l === 'index.js' || l === 'server.js' || l === 'app.js' ||
        l === 'src/server.js' || l === 'src/app.js') return 'node';
    if ((base === 'manage.py' || base === 'app.py' || base === 'main.py' ||
        base === 'wsgi.py' || base === 'asgi.py') && l.indexOf('/') === -1) return 'python';
    if (/application\.java$/.test(base) || (base === 'main.java' && l.indexOf('src/main/java') !== -1)) {
        return 'java';
    }
    if (base === 'program.cs') return 'csharp';
    if (base === 'main.go' && (l.indexOf('/') === -1 || l.indexOf('cmd/') === 0)) return 'go';
    if (base === 'main.rs' && l === 'src/main.rs') return 'rust';
    return null;
}

function trackBiggest(list, entry, cap) {
    list.push(entry);
    list.sort((a, b) => b.bytes - a.bytes);
    if (list.length > cap) list.length = cap;
}

/**
 * Analyze a project directory. Options:
 * { onProgress({files,dirs,current}), signal, timeoutMs=120000,
 *   maxFiles=200000, maxFileBytes=2097152, maxErrors=20 }
 * Throws coded errors: ANALYSIS_NOT_FOUND / ANALYSIS_ABORTED /
 * ANALYSIS_TIMEOUT (the last two carry .partial with counters so far).
 */
async function analyzeProject(root, opts = {}) {
    const t0 = Date.now();
    const o = {
        onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
        signal: opts.signal || null,
        timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000,
        maxFiles: Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 200000,
        maxFileBytes: Number(opts.maxFileBytes) > 0 ? Number(opts.maxFileBytes) : 2097152,
        maxErrors: 20,
    };
    const abs = path.resolve(String(root || ''));
    let st;
    try { st = fs.statSync(abs); }
    catch (_) { throw fail('ANALYSIS_NOT_FOUND', 'dossier introuvable: ' + abs); }
    if (!st.isDirectory()) throw fail('ANALYSIS_NOT_FOUND', 'pas un dossier: ' + abs);

    const skip = new Set(SKIP_DIRS);
    const acc = {
        files: 0, dirs: 0, lines: 0, skippedLarge: 0, binary: 0,
        byLang: {}, tree: new Map(), treeOverflow: 0, biggest: [],
        entries: [], tests: [], testDirs: new Map(), ci: [], readme: null,
        todo: 0, fixme: 0, todoSample: [], errors: [], truncated: false,
        manifests: { csproj: [], requirements: [], gradleLock: false },
    };
    const seenEntries = new Set();
    let lastYield = 0;

    const finalize = () => buildReport(abs, acc, t0, o);
    const checkStop = (relPosix) => {
        if (o.signal && o.signal.aborted) {
            throw fail('ANALYSIS_ABORTED',
                'analyse annulee apres ' + acc.files + ' fichiers', finalize());
        }
        if (Date.now() - t0 > o.timeoutMs) {
            throw fail('ANALYSIS_TIMEOUT',
                'delai maximal depasse (' + Math.round(o.timeoutMs / 1000) + 's, ' +
                acc.files + ' fichiers)', finalize());
        }
        if (acc.files >= o.maxFiles) {
            acc.truncated = true;
            return false; // stop the walk, keep a valid (partial) report
        }
        if (o.onProgress && acc.files - lastYield >= 25) {
            lastYield = acc.files;
            try { o.onProgress({ files: acc.files, dirs: acc.dirs, current: relPosix || '' }); }
            catch (_) { /* progress must never break the walk */ }
        }
        return true;
    };

    const stack = [abs];
    try {
        while (stack.length) {
            const dir = stack.pop();
            let dirents;
            try {
                dirents = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e) {
                if (acc.errors.length < o.maxErrors) {
                    acc.errors.push({ path: toPosix(path.relative(abs, dir)) || '.',
                        error: String((e && e.message) || e).slice(0, 120) });
                }
                continue;
            }
            acc.dirs++;
            for (const e of dirents) {
                if (skip.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    stack.push(full);
                    continue;
                }
                if (!e.isFile() && !e.isSymbolicLink()) continue;
                const rel = toPosix(path.relative(abs, full));
                if (checkStop(rel) === false) { stack.length = 0; break; }
                processFile(abs, full, rel, acc, o, seenEntries);
            }
            await tick(); // keep the event loop alive: no UI freeze
        }
    } catch (e) {
        if (e && (e.code === 'ANALYSIS_ABORTED' || e.code === 'ANALYSIS_TIMEOUT')) throw e;
        throw e;
    }
    if (o.onProgress) {
        try { o.onProgress({ files: acc.files, dirs: acc.dirs, current: '' }); }
        catch (_) {}
    }
    return finalize();
}

function processFile(abs, full, rel, acc, o, seenEntries) {
    let size = 0;
    try { size = fs.statSync(full).size; }
    catch (_) { return; }
    const lang = langOf(rel);
    acc.files++;
    const slot = acc.byLang[lang] || (acc.byLang[lang] = { files: 0, lines: 0 });
    slot.files++;
    // Tree rollup (depth <= 2).
    const segs = rel.split('/');
    const key = segs.length > 2 ? segs[0] + '/' + segs[1] : (segs.length > 1 ? segs[0] : '.');
    if (acc.tree.has(key)) acc.tree.set(key, acc.tree.get(key) + 1);
    else if (acc.tree.size < 60) acc.tree.set(key, 1);
    else acc.treeOverflow++;
    // Manifest side-collections (bounded).
    const lower = rel.toLowerCase();
    if (/\.csproj$/.test(lower) && acc.manifests.csproj.length < 20) {
        acc.manifests.csproj.push(rel);
    }
    if ((/^requirements.*\.txt$/.test(lower) || /^requirements\/.*\.txt$/.test(lower)) &&
        acc.manifests.requirements.length < 20) {
        acc.manifests.requirements.push(rel);
    }
    if (lower === 'gradle.lockfile') acc.manifests.gradleLock = true;
    // Entry points / tests / CI / README.
    const ek = entryKind(rel);
    if (ek && !seenEntries.has(rel)) { seenEntries.add(rel); acc.entries.push({ type: ek, path: rel }); }
    if (isTestFile(rel)) {
        acc.tests.push(rel);
        const d = segs.length > 1 ? segs.slice(0, -1).join('/') : '.';
        acc.testDirs.set(d, (acc.testDirs.get(d) || 0) + 1);
    }
    const ci = ciSystem(rel);
    if (ci && acc.ci.length < 40) acc.ci.push({ path: rel, system: ci });
    if (!acc.readme && segs.length === 1 && /^readme/i.test(lower)) {
        acc.readme = { present: true, path: rel, bytes: size };
    }
    // Content scan (bounded, text only).
    let lines = null;
    if (size > o.maxFileBytes) {
        acc.skippedLarge++;
    } else {
        let buf;
        try {
            if (size > 64 * 1024 * 1024) { acc.skippedLarge++; buf = null; }
            else buf = fs.readFileSync(full);
        } catch (_) { buf = null; }
        if (buf) {
            const head = buf.subarray(0, Math.min(buf.length, 8192));
            if (head.indexOf(0) !== -1) {
                acc.binary++;
            } else {
                const text = buf.toString('utf8');
                const parts = text.split('\n');
                lines = parts.length;
                acc.lines += lines;
                slot.lines += lines;
                for (let i = 0; i < parts.length && acc.todoSample.length < 30; i++) {
                    const ln = parts[i];
                    if (/\bTODO\b/.test(ln)) {
                        acc.todo++;
                        acc.todoSample.push({ path: rel, line: i + 1, kind: 'TODO',
                            text: ln.trim().slice(0, 120) });
                    } else if (/\bFIXME\b/.test(ln)) {
                        acc.fixme++;
                        acc.todoSample.push({ path: rel, line: i + 1, kind: 'FIXME',
                            text: ln.trim().slice(0, 120) });
                    }
                }
            }
        }
    }
    trackBiggest(acc.biggest, { path: rel, bytes: size, lines }, 10);
}

function readText(abs, rel) {
    try { return fs.readFileSync(path.join(abs, rel), 'utf8'); }
    catch (_) { return null; }
}

function exists(abs, rel) {
    try { return fs.existsSync(path.join(abs, rel)); }
    catch (_) { return false; }
}

function detectTypes(abs, acc) {
    const types = [];
    const has = (f) => exists(abs, f);
    if (has('package.json')) types.push({ type: 'node', markers: ['package.json'] });
    if (has('pubspec.yaml')) types.push({ type: 'flutter', markers: ['pubspec.yaml'] });
    if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile') || has('setup.py')) {
        const mk = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].filter(has);
        types.push({ type: 'python', markers: mk });
    }
    if (has('pom.xml')) types.push({ type: 'java-maven', markers: ['pom.xml'] });
    if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle')) {
        types.push({ type: 'java-gradle',
            markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle'].filter(has) });
    }
    if (acc.manifests.csproj.length) {
        types.push({ type: 'csharp', markers: acc.manifests.csproj.slice(0, 5) });
    }
    if (has('go.mod')) types.push({ type: 'go', markers: ['go.mod'] });
    if (has('Cargo.toml')) types.push({ type: 'rust', markers: ['Cargo.toml'] });
    return types;
}

function isExactPin(range) {
    const r = String(range || '').trim();
    if (!r) return false;
    if (/^(https?:|git\+|file:|link:|workspace:|npm:)/i.test(r)) return true;
    return /^\d+\.\d+\.\d+/.test(r);
}

// -- lockfile parsers (line/regex based, no new dependency) -----------------
function parsePackageLock(text) {
    // package-lock.json v2/v3: packages["node_modules/<name>"].version
    try {
        const j = JSON.parse(text);
        const out = {};
        const pkgs = (j && j.packages) || {};
        for (const k of Object.keys(pkgs)) {
            const mm = /^node_modules\/(.+)$/.exec(k);
            if (mm && pkgs[k] && pkgs[k].version) out[mm[1]] = String(pkgs[k].version);
        }
        const deps = (j && j.dependencies) || {};
        for (const k of Object.keys(deps)) {
            if (!out[k] && deps[k] && deps[k].version) out[k] = String(deps[k].version);
        }
        return out;
    } catch (_) { return null; }
}

function parseYarnLock(text) {
    // yarn v1: "name@range:" ... "  version "x"" (berry: "  version: x")
    const out = {};
    const lines = String(text || '').split('\n');
    let names = [];
    for (const ln of lines) {
        const h = /^(?:"([^"]+)"|(\S+)):?\s*$/.exec(ln);
        if (h && ln[0] !== ' ' && ln[0] !== '\t' && ln.trim()) {
            const head = (h[1] || h[2] || '').trim().replace(/:$/, '');
            names = head.split(/,\s*/).map((s) => {
                const at = s.lastIndexOf('@');
                return at > 0 ? s.slice(0, at).replace(/^"|"$/g, '') : null;
            }).filter(Boolean);
            continue;
        }
        const v = /^\s+version\s+["']?([^"'\s]+)["']?\s*$/.exec(ln) ||
            /^\s+version:\s+["']?([^"'\s]+)["']?\s*$/.exec(ln);
        if (v && names.length) {
            for (const n of names) { if (!out[n]) out[n] = v[1]; }
            names = [];
        }
        if (!ln.trim()) names = [];
    }
    return out;
}

function parsePnpmLock(text) {
    // packages:\n  name@1.2.3:\n (v6+) or /name/1.2.3: (older, skipped)
    const out = {};
    const lines = String(text || '').split('\n');
    let inPkgs = false;
    for (const ln of lines) {
        if (/^packages:\s*$/.test(ln)) { inPkgs = true; continue; }
        if (/^\S/.test(ln)) inPkgs = false;
        if (!inPkgs) continue;
        const m = /^\s{2}([^@\s][^:]*?)@([^:\s]+):\s*$/.exec(ln);
        if (m) out[m[1]] = m[2].replace(/\(.*\)$/, '');
    }
    return out;
}

function parsePubspecLock(text) {
    const out = {};
    const lines = String(text || '').split('\n');
    let inPkgs = false;
    let cur = null;
    for (const ln of lines) {
        if (/^packages:\s*$/.test(ln)) { inPkgs = true; cur = null; continue; }
        if (/^sdks:\s*$/.test(ln)) { inPkgs = false; cur = null; continue; }
        if (/^\S/.test(ln) && ln.trim()) { inPkgs = false; cur = null; continue; }
        if (!inPkgs) continue;
        const h = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(ln);
        if (h) { cur = h[1]; continue; }
        const v = /^    version:\s*["']?([^"'\s]+)["']?/.exec(ln);
        if (v && cur && !out[cur]) out[cur] = v[1];
    }
    return out;
}

function parsePubspecDeps(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    let section = null; // 'deps' | 'dev' | null
    let current = null;
    const nameOk = (s) => /^[A-Za-z0-9_.-]+$/.test(s);
    const unq = (s) => String(s).replace(/^["']|["']$/g, '');
    for (const ln of lines) {
        const trimmed = ln.trim();
        const indent = ln.length - ln.trimStart().length;
        if (indent === 0 && (trimmed === 'dependencies:' || trimmed === 'dev_dependencies:')) {
            section = trimmed === 'dependencies:' ? 'deps' : 'dev';
            current = null;
            continue;
        }
        if (indent === 0) { section = null; current = null; continue; }
        if (!section) continue;
        if (indent === 2) {
            const ci = trimmed.indexOf(':');
            if (ci > 0 && nameOk(trimmed.slice(0, ci).trim())) {
                const val = unq(trimmed.slice(ci + 1).trim());
                current = { name: trimmed.slice(0, ci).trim(),
                    range: val === 'null' ? '' : val,
                    dev: section === 'dev', detail: '' };
                out.push(current);
            } else {
                current = null;
            }
            continue;
        }
        if (current && indent > 2 && trimmed) {
            const ci = trimmed.indexOf(':');
            if (ci > 0) {
                const k = trimmed.slice(0, ci).trim();
                const v = unq(trimmed.slice(ci + 1).trim());
                if (k === 'version' && v && !current.range) current.range = v;
                else if (k) current.detail = (current.detail ? current.detail + ' ' : '') + (v ? k + ': ' + v : k);
            }
        }
    }
    return out;
}

function parseRequirements(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const ln = raw.split('#')[0].trim();
        if (!ln || /^(-r|--requirement|^-)/.test(ln)) continue;
        const m = /^([A-Za-z0-9_.-]+)\s*(.*)$/.exec(ln);
        if (m) out.push({ name: m[1].toLowerCase(), range: (m[2] || '').trim() });
    }
    return out;
}

function parsePoetryLock(text) {
    const out = {};
    const blocks = String(text || '').split('[[package]]');
    for (const b of blocks) {
        const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(b);
        const v = /^\s*version\s*=\s*"([^"]+)"/m.exec(b);
        if (n && v && !out[n[1].toLowerCase()]) out[n[1].toLowerCase()] = v[1];
    }
    return out;
}

function parsePipfileLock(text) {
    try {
        const j = JSON.parse(text);
        const out = {};
        for (const sec of ['default', 'develop']) {
            const d = (j && j[sec]) || {};
            for (const k of Object.keys(d)) {
                const ver = d[k] && d[k].version;
                if (ver) out[String(k).toLowerCase()] = String(ver).replace(/^==/, '');
            }
        }
        return out;
    } catch (_) { return null; }
}

function parsePomDeps(text) {
    const out = [];
    const blocks = String(text || '').split('<dependency>');
    for (const b of blocks.slice(1)) {
        const g = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(b);
        const a = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(b);
        const v = /<version>\s*([^<]+?)\s*<\/version>/.exec(b);
        if (a) {
            out.push({ name: ((g ? g[1].trim() + ':' : '') + a[1].trim()),
                range: v ? v[1].trim() : '' });
            if (out.length >= 200) break;
        }
    }
    return out;
}

function parseGradleDeps(text) {
    const out = [];
    const re = /(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|debugImplementation)\s*[({\s]['"]([^'":\s]+):([^'":\s]+):([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null && out.length < 200) {
        out.push({ name: m[2] + ':' + m[3], range: m[4], configuration: m[1],
            dev: /^test/i.test(m[1]), detail: '' });
    }
    return out;
}

function parseGradleLockfile(text) {
    const out = {};
    for (const ln of String(text || '').split('\n')) {
        const t = ln.trim();
        if (!t || t[0] === '#') continue;
        const m = /^([^:]+):([^:]+):([^:=,\s]+)/.exec(t);
        if (m) out[m[1] + ':' + m[2]] = m[3];
    }
    return out;
}

function parseCsprojDeps(text) {
    const out = [];
    const re = /<PackageReference\s+[^>]*?Include="([^"]+)"[^>]*?Version="([^"]+)"[^>]*?\/?>/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null && out.length < 200) {
        out.push({ name: m[1], range: m[2] });
    }
    const re2 = /<PackageReference\s+[^>]*?Version="([^"]+)"[^>]*?Include="([^"]+)"[^>]*?\/?>/gi;
    while ((m = re2.exec(String(text || ''))) !== null && out.length < 200) {
        if (!out.some((d) => d.name === m[2])) out.push({ name: m[2], range: m[1] });
    }
    return out;
}

function parseNugetLock(text) {
    try {
        const j = JSON.parse(text);
        const out = {};
        const deps = (j && j.dependencies) || {};
        for (const target of Object.keys(deps)) {
            const d = deps[target] || {};
            for (const k of Object.keys(d)) {
                const r = d[k] && (d[k].resolved || d[k].requested);
                if (r && !out[k]) out[k] = String(r);
            }
        }
        return out;
    } catch (_) { return null; }
}

function parseGoMod(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    let inReq = false;
    for (const ln of lines) {
        const t = ln.trim();
        if (/^require\s*\($/.test(t)) { inReq = true; continue; }
        if (inReq && t === ')') { inReq = false; continue; }
        let m = inReq ? /^\s*(\S+)\s+(\S+)/.exec(ln) : /^require\s+(\S+)\s+(\S+)/.exec(t);
        if (m) out.push({ name: m[1], range: m[2] });
        if (out.length >= 200) break;
    }
    return out;
}

function parseCargoDeps(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    let inDeps = false;
    for (const ln of lines) {
        if (/^\[(dev-dependencies|dependencies)\]/.test(ln.trim())) { inDeps = true; continue; }
        if (/^\[/.test(ln.trim())) inDeps = false;
        if (!inDeps) continue;
        const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(ln);
        if (m) out.push({ name: m[1], range: m[2] });
        const m2 = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(ln);
        if (m2 && !out.some((d) => d.name === m2[1])) out.push({ name: m2[1], range: m2[2] });
        if (out.length >= 200) break;
    }
    return out;
}

function parseCargoLock(text) {
    const out = {};
    const blocks = String(text || '').split('[[package]]');
    for (const b of blocks) {
        const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(b);
        const v = /^\s*version\s*=\s*"([^"]+)"/m.exec(b);
        if (n && v && !out[n[1]]) out[n[1]] = v[1];
    }
    return out;
}

function quotedParts(s) {
    const r = [];
    let cur = '';
    let q = null;
    for (const ch of String(s || '')) {
        if (q) {
            if (ch === q) { r.push(cur); cur = ''; q = null; }
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            q = ch;
        }
    }
    return r;
}

function pep508Name(req) {
    const s = String(req || '').trim();
    let i = 0;
    while (i < s.length && /[A-Za-z0-9_.-]/.test(s.charAt(i))) i++;
    const nm = s.slice(0, i).toLowerCase();
    if (!nm) return null;
    let extra = s.slice(i).trim();
    if (extra.charAt(0) === '[') {
        const ce = extra.indexOf(']');
        if (ce !== -1) extra = extra.slice(ce + 1).trim();
    }
    if (extra.charAt(0) === ';') extra = '';
    return { name: nm, range: extra };
}

function parsePyprojectDeps(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    let section = '';
    let collecting = false;
    let collectDev = false;
    const poetryDev = (sec) => {
        if (sec === 'tool.poetry.dependencies') return false;
        if (sec === 'tool.poetry.dev-dependencies') return true;
        if (sec.indexOf('tool.poetry.group.') === 0 && sec.slice(-13) === '.dependencies') {
            return sec.slice(18, -13) !== 'main';
        }
        return null;
    };
    for (const raw of lines) {
        const ln = raw.split('#')[0];
        const tr = ln.trim();
        if (!tr) continue;
        if (tr.charAt(0) === '[' && tr.charAt(tr.length - 1) === ']') {
            section = tr.slice(1, -1).trim();
            collecting = false;
            continue;
        }
        if (section === 'project' && tr.indexOf('dependencies') === 0 && tr.indexOf('=') !== -1 &&
                tr.slice(tr.indexOf('=') + 1).indexOf('[') !== -1) {
            collecting = true;
            collectDev = false;
        } else if (section === 'project.optional-dependencies' && tr.indexOf('=') !== -1 &&
                tr.slice(tr.indexOf('=') + 1).indexOf('[') !== -1) {
            collecting = true;
            collectDev = true;
        }
        if (collecting) {
            for (const q of quotedParts(tr)) {
                const p = pep508Name(q);
                if (p) out.push({ name: p.name, range: p.range, dev: collectDev, detail: '' });
            }
            if (tr.indexOf(']') !== -1) collecting = false;
            continue;
        }
        const pd = poetryDev(section);
        if (pd !== null && tr.indexOf('=') !== -1) {
            const k = tr.slice(0, tr.indexOf('=')).trim().toLowerCase();
            if (k && k !== 'python' && /^[a-z0-9_.-]+$/.test(k)) {
                const v = tr.slice(tr.indexOf('=') + 1).trim();
                let range = '';
                let detail = '';
                if (v.charAt(0) === '{') {
                    const vi = v.indexOf('version');
                    const qs = quotedParts(vi !== -1 ? v.slice(vi) : v);
                    if (vi !== -1 && qs.length) range = qs[0];
                    else detail = v.slice(0, 80);
                } else {
                    const qs = quotedParts(v);
                    range = qs.length ? qs[0] : v;
                }
                out.push({ name: k, range, dev: pd, detail });
            }
            continue;
        }
    }
    return out;
}

function stampDeps(manifest, source, locked) {
    const map = {};
    for (const l of locked || []) map[String(l.name).toLowerCase()] = l.version;
    for (const d of manifest) {
        if (d.source == null) d.source = source;
        if (d.dev == null) d.dev = false;
        if (d.locked == null) {
            const k = String(d.name).toLowerCase();
            d.locked = Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
        }
        if (d.detail == null) d.detail = '';
    }
}

function splitLocked(manifest, lockedMap) {
    const locked = [];
    const unlocked = [];
    for (const d of manifest) {
        if (lockedMap && lockedMap[d.name] != null) locked.push({ name: d.name, version: lockedMap[d.name] });
        else unlocked.push(d.name);
    }
    return { locked, unlocked };
}

function collectDeps(abs, acc, types) {
    const out = [];
    const want = new Set(types.map((t) => t.type));
    const capList = (arr) => arr.slice(0, 200);

    if (want.has('node')) {
        let manifest = [];
        let scripts = [];
        try {
            const pkg = JSON.parse(readText(abs, 'package.json') || '{}');
            for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
                const d = pkg[sec] || {};
                for (const k of Object.keys(d)) {
                    manifest.push({ name: k, range: String(d[k]), section: sec,
                    dev: sec === 'devDependencies', source: 'package.json', locked: null, detail: '' });
                }
            }
            scripts = Object.keys(pkg.scripts || {}).slice(0, 40);
        } catch (_) { /* invalid manifest: reported empty, never throws */ }
        let lockfile = null;
        let lockedMap = null;
        for (const lf of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
            const t = readText(abs, lf);
            if (t == null) continue;
            const parsed = lf === 'package-lock.json' ? parsePackageLock(t)
                : lf === 'yarn.lock' ? parseYarnLock(t) : parsePnpmLock(t);
            if (parsed) { lockfile = lf; lockedMap = parsed; break; }
        }
        const { locked, unlocked } = splitLocked(manifest, lockedMap);
        stampDeps(manifest, 'package.json', locked);
        out.push({ ecosystem: 'node', manifest: 'package.json', scripts,
            manifestDeps: capList(manifest), lockfile, locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => !isExactPin(d.range)).map((d) => d.name)),
            note: lockfile ? '' : 'aucun verrouillage (ni package-lock.json, ni yarn.lock, ni pnpm-lock.yaml)' });
    }
    if (want.has('flutter')) {
        const manifest = parsePubspecDeps(readText(abs, 'pubspec.yaml') || '');
        const lockText = readText(abs, 'pubspec.lock');
        const lockedMap = lockText != null ? parsePubspecLock(lockText) : null;
        const { locked, unlocked } = splitLocked(manifest, lockedMap);
        stampDeps(manifest, 'pubspec.yaml', locked);
        out.push({ ecosystem: 'flutter', manifest: 'pubspec.yaml', scripts: [],
            manifestDeps: capList(manifest), lockfile: lockText != null ? 'pubspec.lock' : null,
            locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => !isExactPin(d.range) && d.range).map((d) => d.name)),
            note: lockText != null ? '' : 'aucun verrouillage (pubspec.lock absent)' });
    }
    if (want.has('python')) {
        let manifest = [];
        for (const rf of acc.manifests.requirements) {
            for (const d of parseRequirements(readText(abs, rf) || '')) {
                d.dev = false; d.source = rf; d.detail = ''; manifest.push(d);
            }
        }
        const pyt = readText(abs, 'pyproject.toml');
        if (pyt) {
            for (const d of parsePyprojectDeps(pyt)) { d.source = 'pyproject.toml'; manifest.push(d); }
        }
        if (!manifest.length) {
            const pip = readText(abs, 'Pipfile');
            if (pip) {
                const m = pip.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/gm) || [];
                for (const ln of m) {
                    const mm = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/.exec(ln);
                    if (mm) manifest.push({ name: mm[1].toLowerCase(), range: mm[2] });
                }
            }
        }
        let lockfile = null;
        let lockedMap = null;
        for (const d of manifest) { if (d.source == null) { d.dev = false; d.source = 'Pipfile'; d.detail = ''; } }
        for (const lf of ['poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock']) {
            const t = readText(abs, lf);
            if (t == null) continue;
            const parsed = lf === 'Pipfile.lock' ? parsePipfileLock(t) : parsePoetryLock(t);
            if (parsed) { lockfile = lf; lockedMap = parsed; break; }
        }
        const lower = (s) => String(s).toLowerCase();
        const locked = [];
        const unlocked = [];
        for (const d of manifest) {
            if (lockedMap && lockedMap[lower(d.name)] != null) {
                d.locked = lockedMap[lower(d.name)];
                locked.push({ name: d.name, version: d.locked });
            } else { d.locked = null; unlocked.push(d.name); }
        }
        const pinnedByEq = manifest.filter((d) => /^==/.test(d.range.trim())).length;
        stampDeps(manifest, 'requirements.txt', locked);
        out.push({ ecosystem: 'python',
            manifest: [acc.manifests.requirements[0], pyt ? 'pyproject.toml' : null].filter(Boolean).join(' + ') ||
                (readText(abs, 'Pipfile') ? 'Pipfile' : 'requirements.txt'),
            scripts: [], manifestDeps: capList(manifest), lockfile,
            locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => !/^==/.test(d.range.trim())).map((d) => d.name)),
            note: lockfile ? '' : (pinnedByEq === manifest.length && manifest.length
                ? 'epingle via == mais aucun verrouillage transitif (poetry.lock/Pipfile.lock/uv.lock absent)'
                : 'aucun verrouillage (poetry.lock/Pipfile.lock/uv.lock absent)') });
    }
    if (want.has('java-maven')) {
        const manifest = parsePomDeps(readText(abs, 'pom.xml') || '');
        stampDeps(manifest, 'pom.xml', []);
        out.push({ ecosystem: 'java-maven', manifest: 'pom.xml', scripts: [],
            manifestDeps: capList(manifest), lockfile: null, locked: [], unlocked: capList(manifest.map((d) => d.name)),
            unpinned: capList(manifest.filter((d) => !isExactPin(d.range)).map((d) => d.name)),
            note: 'Maven ne versionne pas de verrouillage (pas de lockfile standard)' });
    }
    if (want.has('java-gradle')) {
        let manifest = [];
        for (const gf of ['build.gradle', 'build.gradle.kts']) {
            for (const d of parseGradleDeps(readText(abs, gf) || '')) { d.source = gf; manifest.push(d); }
        }
        const lockText = acc.manifests.gradleLock ? readText(abs, 'gradle.lockfile') : null;
        const lockedMap = lockText != null ? parseGradleLockfile(lockText) : null;
        const { locked, unlocked } = splitLocked(manifest, lockedMap);
        stampDeps(manifest, 'build.gradle', locked);
        out.push({ ecosystem: 'java-gradle', manifest: 'build.gradle', scripts: [],
            manifestDeps: capList(manifest), lockfile: lockText != null ? 'gradle.lockfile' : null,
            locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => /[+]|latest|SNAPSHOT/i.test(d.range)).map((d) => d.name)),
            note: lockText != null ? '' : 'aucun verrouillage (gradle.lockfile absent)' });
    }
    if (want.has('csharp')) {
        let manifest = [];
        for (const cs of acc.manifests.csproj) {
            for (const d of parseCsprojDeps(readText(abs, cs) || '')) { d.source = cs; manifest.push(d); }
        }
        const lockText = readText(abs, 'packages.lock.json');
        const lockedMap = lockText != null ? parseNugetLock(lockText) : null;
        const { locked, unlocked } = splitLocked(manifest, lockedMap);
        stampDeps(manifest, acc.manifests.csproj[0] || '*.csproj', locked);
        out.push({ ecosystem: 'csharp', manifest: acc.manifests.csproj[0] || '*.csproj', scripts: [],
            manifestDeps: capList(manifest), lockfile: lockText != null ? 'packages.lock.json' : null,
            locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => /[*]/.test(d.range)).map((d) => d.name)),
            note: lockText != null ? '' : 'aucun verrouillage (packages.lock.json absent)' });
    }
    if (want.has('go')) {
        const manifest = parseGoMod(readText(abs, 'go.mod') || '');
        const hasSum = exists(abs, 'go.sum');
        stampDeps(manifest, 'go.mod', hasSum ? manifest.map((d) => ({ name: d.name, version: d.range })) : []);
        out.push({ ecosystem: 'go', manifest: 'go.mod', scripts: [],
            manifestDeps: capList(manifest), lockfile: hasSum ? 'go.sum' : null,
            locked: hasSum ? capList(manifest.map((d) => ({ name: d.name, version: d.range }))) : [],
            unlocked: hasSum ? [] : capList(manifest.map((d) => d.name)),
            unpinned: [],
            note: hasSum ? 'versions depuis go.mod, empreintes dans go.sum' : 'go.sum absent (empreintes non verrouillees)' });
    }
    if (want.has('rust')) {
        const manifest = parseCargoDeps(readText(abs, 'Cargo.toml') || '');
        const lockText = readText(abs, 'Cargo.lock');
        const lockedMap = lockText != null ? parseCargoLock(lockText) : null;
        const { locked, unlocked } = splitLocked(manifest, lockedMap);
        stampDeps(manifest, 'Cargo.toml', locked);
        out.push({ ecosystem: 'rust', manifest: 'Cargo.toml', scripts: [],
            manifestDeps: capList(manifest), lockfile: lockText != null ? 'Cargo.lock' : null,
            locked: capList(locked), unlocked: capList(unlocked),
            unpinned: capList(manifest.filter((d) => !isExactPin(d.range)).map((d) => d.name)),
            note: lockText != null ? '' : 'aucun verrouillage (Cargo.lock absent)' });
    }
    return out;
}

function buildReport(abs, acc, t0, o) {
    const types = detectTypes(abs, acc);
    const tree = [...acc.tree.entries()]
        .map(([p, files]) => ({ path: p, files }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 40);
    const frameworks = [];
    try {
        const names = new Set();
        for (const d of collectDeps(abs, acc, types)) {
            for (const m of d.manifestDeps) names.add(String(m.name).toLowerCase());
        }
        const known = { jest: 'jest', vitest: 'vitest', mocha: 'mocha', pytest: 'pytest',
            'flutter_test': 'flutter_test', test: 'dart-test', junit: 'junit', testng: 'testng',
            xunit: 'xunit', nunit: 'nunit', mstest: 'mstest', phpunit: 'phpunit', rspec: 'rspec',
            jasmine: 'jasmine', karma: 'karma', cypress: 'cypress', playwright: 'playwright' };
        for (const n of names) { if (known[n]) frameworks.push(known[n]); }
        if (types.some((t) => t.type === 'go') && acc.tests.length) frameworks.push('go-test');
    } catch (_) { /* frameworks are best-effort */ }
    return {
        version: 1,
        root: abs,
        name: path.basename(abs),
        analyzedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        truncated: acc.truncated,
        meta: { skippedDirs: SKIP_DIRS.slice(), maxFiles: o.maxFiles,
            maxFileBytes: o.maxFileBytes, timeoutMs: o.timeoutMs },
        types,
        stats: { files: acc.files, dirs: acc.dirs, lines: acc.lines,
            skippedLarge: acc.skippedLarge, binary: acc.binary, byLang: acc.byLang },
        tree, treeOverflow: acc.treeOverflow,
        biggest: acc.biggest,
        entryPoints: acc.entries.slice(0, 40),
        tests: { count: acc.tests.length,
            dirs: [...acc.testDirs.entries()].map(([p, c]) => ({ path: p, count: c }))
                .sort((a, b) => b.count - a.count).slice(0, 20),
            frameworks: frameworks.sort(),
            sample: acc.tests.slice(0, 20) },
        ci: acc.ci,
        readme: acc.readme || { present: false },
        todos: { count: acc.todo + acc.fixme, todo: acc.todo, fixme: acc.fixme,
            sample: acc.todoSample },
        deps: collectDeps(abs, acc, types),
        errors: acc.errors,
    };
}

// -- AGENTS.md (consumed by the agent + chat via readAgentsMd) ----------------
function buildAgentsMd(report) {
    const r = report || {};
    const L = [];
    L.push('# ' + (r.name || 'Project'));
    L.push('');
    L.push('> Fichier genere par Sudo Studio (analyse deterministe, sans IA).');
    L.push('> L agent et le chat utilisent ce fichier comme contexte projet.');
    L.push('');
    const types = (r.types || []).map((t) => t.type + ' (' + (t.markers || []).join(', ') + ')');
    L.push('## Types de projet');
    L.push(types.length ? types.map((t) => '- ' + t).join('\n') : '- (non detecte)');
    L.push('');
    const st = r.stats || {};
    const langs = Object.entries(st.byLang || {})
        .map(([lang, v]) => ({ lang, files: v.files, lines: v.lines }))
        .sort((a, b) => b.lines - a.lines);
    L.push('## Statistiques');
    L.push('- Fichiers: ' + (st.files || 0) + ' | Lignes: ' + (st.lines || 0) +
        ' | Dossiers parcourus: ' + (st.dirs || 0));
    for (const l of langs.slice(0, 12)) {
        L.push('- ' + l.lang + ': ' + l.files + ' fichiers, ' + l.lines + ' lignes');
    }
    L.push('');
    L.push('## Structure (resume)');
    for (const t of (r.tree || []).slice(0, 15)) {
        L.push('- ' + t.path + ': ' + t.files + ' fichiers');
    }
    L.push('');
    L.push('## Points d entree');
    const eps = r.entryPoints || [];
    L.push(eps.length ? eps.map((e) => '- [' + e.type + '] ' + e.path).join('\n') : '- (non detecte)');
    L.push('');
    const tests = r.tests || {};
    L.push('## Tests');
    L.push('- Fichiers de test: ' + (tests.count || 0) +
        ((tests.frameworks || []).length ? ' (' + tests.frameworks.join(', ') + ')' : ''));
    const node = (r.deps || []).find((d) => d.ecosystem === 'node');
    if (node && node.scripts && node.scripts.length) {
        L.push('- Scripts npm: ' + node.scripts.join(', '));
    }
    L.push('');
    L.push('## Dependances');
    for (const d of (r.deps || [])) {
        L.push('- ' + d.ecosystem + ' (' + d.manifest + '): ' +
            (d.manifestDeps || []).length + ' declarees, ' +
            (d.locked || []).length + ' verrouillees' +
            (d.lockfile ? ' [' + d.lockfile + ']' : ' [SANS VERROUILLAGE]'));
        if ((d.unlocked || []).length) {
            L.push('  non verrouillees: ' + d.unlocked.slice(0, 10).join(', ') +
                (d.unlocked.length > 10 ? '...' : ''));
        }
    }
    if (!(r.deps || []).length) L.push('- (aucune dependance detectee)');
    L.push('');
    const todos = r.todos || {};
    L.push('## Dette visible');
    L.push('- TODO: ' + (todos.todo || 0) + ' | FIXME: ' + (todos.fixme || 0));
    const ci = r.ci || [];
    L.push('');
    L.push('## CI');
    L.push(ci.length ? ci.map((c) => '- [' + c.system + '] ' + c.path).join('\n') : '- (aucune)');
    L.push('');
    return L.join('\n');
}

// Minimal line diff for the overwrite-confirmation view.
function diffLines(oldText, newText) {
    const a = String(oldText == null ? '' : oldText).split('\n');
    const b = String(newText == null ? '' : newText).split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre &&
        a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    return {
        same: pre === a.length && pre === b.length,
        oldLines: a.length,
        newLines: b.length,
        commonPrefix: pre,
        commonSuffix: suf,
        oldMiddle: a.slice(pre, a.length - suf),
        newMiddle: b.slice(pre, b.length - suf),
    };
}

// Facts-only prompt for the optional AI summary: aggregates from (a)-(c),
// NEVER file contents.
function aiSummaryPrompt(report) {
    const r = report || {};
    const st = r.stats || {};
    const langs = Object.entries(st.byLang || {})
        .map(([lang, v]) => lang + '=' + v.files + 'f/' + v.lines + 'l').join(', ');
    const deps = (r.deps || []).map((d) =>
        d.ecosystem + ': ' + (d.manifestDeps || []).length + ' deps' +
        (d.lockfile ? ' verrouillees(' + d.lockfile + ')' : ' SANS VERROUILLAGE') +
        ((d.unlocked || []).length ? ' non-verrouillees=' + d.unlocked.slice(0, 8).join(',') : '')
    ).join(' ; ');
    const lines = [
        'Resume ce projet en 5-8 lignes (public: developpeur). Faits uniquement,',
        'aucune invention. Donnees deterministes :',
        '- nom: ' + (r.name || '?') + ' ; types: ' +
            ((r.types || []).map((t) => t.type).join(', ') || 'inconnu'),
        '- fichiers: ' + (st.files || 0) + ' ; lignes: ' + (st.lines || 0) +
            ' ; langages: ' + (langs || 'aucun'),
        '- tests: ' + ((r.tests && r.tests.count) || 0) +
            ' ; CI: ' + ((r.ci || []).map((c) => c.system).join(', ') || 'aucune') +
            ' ; README: ' + (r.readme && r.readme.present ? 'oui' : 'non'),
        '- TODO/FIXME: ' + ((r.todos && r.todos.count) || 0),
        '- dependances: ' + (deps || 'aucune'),
        '- points d entree: ' + ((r.entryPoints || []).map((e) => e.path).join(', ') || 'aucun'),
    ];
    return lines.join('\n').slice(0, 4000);
}

module.exports = {
    SKIP_DIRS,
    EXT_LANG,
    langOf,
    analyzeProject,
    buildAgentsMd,
    diffLines,
    aiSummaryPrompt,
};
