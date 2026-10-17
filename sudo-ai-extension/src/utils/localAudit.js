/**
 * SUDO STUDIO - Local (offline) vulnerability audit (TASK 7b).
 * Matches locked dependency versions against an advisory DB. No network. Ever.
 * DB resolution order:
 *   1. $SUDO_ADVISORIES_PATH (tests / power users)
 *   2. ~/.sudo_studio/advisories.json (imported via the Security panel)
 *   3. embedded src/data/advisories.json
 * P23: per-ecosystem version matching (semver / PEP 440 / Maven),
 * lockfile parsers for go / crates / maven / nuget, 90-day staleness,
 * and uncovered-ecosystem reporting (never "0 vuln" when unevaluated).
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EMBEDDED_DB = path.join(__dirname, '..', 'data', 'advisories.json');
const STALE_DAYS  = 90; // P23: warn when the base is older than 90 days
const MAX_PKGS    = 5000;

function userDbPath() {
    return path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio', 'advisories.json');
}

function loadAdvisories() {
    const candidates = [];
    if (process.env.SUDO_ADVISORIES_PATH) candidates.push({ p: process.env.SUDO_ADVISORIES_PATH, from: 'env-override' });
    candidates.push({ p: userDbPath(), from: 'imported' });
    candidates.push({ p: EMBEDDED_DB, from: 'embedded' });
    for (const { p, from } of candidates) {
        try {
            if (!p || !fs.existsSync(p)) continue;
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db || !Array.isArray(db.advisories)) continue;
            return { db, from };
        } catch { /* try next candidate */ }
    }
    return { db: null, from: null, error: 'no usable advisory database found' };
}

function dbIsStale(generatedAt, maxDays = STALE_DAYS) {
    const t = Date.parse(generatedAt || '');
    if (!Number.isFinite(t)) return true;
    return (Date.now() - t) / 86400000 > maxDays;
}

// -- versions: numeric prefix compare ("v1.2.3", "=2.0", "1.0-beta" all OK) --
function parseVersion(v) {
    const m = String(v || '').trim().replace(/^[v=\s]+/, '').match(/^(\d+(?:\.\d+)*)/);
    if (!m) return null;
    return m[1].split('.').map(n => parseInt(n, 10));
}

function cmpVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return null;
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}


// -- P23: per-ecosystem version comparison (mission requirement e) --
// semver: npm, pub, crates, go, nuget. pep440: pip. maven: maven.
// Each comparator returns -1/0/1, or null when a side is unparseable
// (callers then refuse to match: never flag blindly).

function splitSemver(v) {
    let s = String(v || '').trim().replace(/^[v=\s]+/, '');
    const plus = s.indexOf('+');
    if (plus >= 0) s = s.slice(0, plus);              // build metadata ignored
    let pre = null;
    const dash = s.indexOf('-');
    if (dash >= 0) { pre = s.slice(dash + 1); s = s.slice(0, dash); }
    if (!s) return null;
    const core = [];
    for (const part of s.split('.')) {
        if (!/^\d+$/.test(part)) return null;
        core.push(parseInt(part, 10));
    }
    if (pre !== null && !/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(pre)) return null;
    return { core, pre };
}

function cmpSemverPre(a, b) {
    if (a === b) return 0;
    if (a === null) return 1;    // release > prerelease
    if (b === null) return -1;
    const pa = a.split('.'), pb = b.split('.');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = pa[i], y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) {
            const d = parseInt(x, 10) - parseInt(y, 10);
            if (d) return d < 0 ? -1 : 1;
        } else if (nx !== ny) {
            return nx ? -1 : 1;  // numeric identifiers < alphanumeric
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

function compareSemver(a, b) {
    const A = splitSemver(a), B = splitSemver(b);
    if (!A || !B) return null;
    const n = Math.max(A.core.length, B.core.length);
    for (let i = 0; i < n; i++) {
        const x = A.core[i] || 0, y = B.core[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return cmpSemverPre(A.pre, B.pre);
}

// PEP 440 (pip): [epoch!]release[pre][post][dev], zero-padded release,
// a<alpha, b<beta, c/pre/rc<preview ordered as pre; final > pre;
// any post > no post; no dev > any dev. Unparseable -> null.
function splitPep440(v) {
    let s = String(v || '').trim().toLowerCase().replace(/^[v=\s]+/, '');
    if (!s) return null;
    let epoch = 0;
    const em = s.match(/^(\d+)!(.*)$/);
    if (em) { epoch = parseInt(em[1], 10); s = em[2]; }
    const rm = s.match(/^(\d+(?:[._-]\d+)*)(.*)$/);
    if (!rm) return null;
    const release = rm[1].split(/[._-]/).map((x) => parseInt(x, 10));
    let rest = rm[2].replace(/^[._-]+/, '');
    let pre = null;
    const pm = rest.match(/^(alpha|beta|preview|pre|rc|a|b|c)([._-]?\d*)(.*)$/);
    if (pm) {
        const w = pm[1];
        const rank = (w === 'a' || w === 'alpha') ? 0 : (w === 'b' || w === 'beta') ? 1 : 2;
        const num = pm[2].replace(/^[._-]+/, '');
        pre = [rank, num ? parseInt(num, 10) : 0];
        rest = pm[3].replace(/^[._-]+/, '');
    }
    let post = null;
    const om = rest.match(/^(post|r|rev)[._-]?(\d+)(.*)$/);
    if (om) { post = parseInt(om[2], 10); rest = om[3].replace(/^[._-]+/, ''); }
    let dev = null;
    const dm = rest.match(/^dev[._-]?(\d*)(.*)$/);
    if (dm) { dev = dm[1] ? parseInt(dm[1], 10) : 0; rest = dm[2]; }
    if (rest && rest[0] === '+') rest = '';  // local version: tolerated, ignored
    if (rest) return null;
    return { epoch, release, pre, post, dev };
}

function comparePep440(a, b) {
    const A = splitPep440(a), B = splitPep440(b);
    if (!A || !B) return null;
    if (A.epoch !== B.epoch) return A.epoch < B.epoch ? -1 : 1;
    const n = Math.max(A.release.length, B.release.length);
    for (let i = 0; i < n; i++) {
        const x = A.release[i] || 0, y = B.release[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    const pk = (s) => s.pre || (s.dev !== null ? [-1, 0] : [3, 0]); // X.devN < X.pre < X
    const pa = pk(A), pb = pk(B);
    if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
    if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
    const oa = A.post === null ? -1 : A.post, ob = B.post === null ? -1 : B.post;
    if (oa !== ob) return oa < ob ? -1 : 1;
    if ((A.dev === null) !== (B.dev === null)) return A.dev === null ? 1 : -1;
    if (A.dev !== null && A.dev !== B.dev) return A.dev < B.dev ? -1 : 1;
    return 0;
}

// Maven ComparableVersion approximation: dot/dash separated tokens with
// digit<->letter transitions splitting tokens; qualifier order
// alpha < beta < milestone < rc < snapshot < release < sp; unknown
// qualifiers sort just above release, lexically. Unparseable -> null.
const MAVEN_RANK = { a: 0, alpha: 0, b: 1, beta: 1, m: 2, milestone: 2,
    rc: 3, cr: 3, snapshot: 4, '': 5, ga: 5, final: 5, release: 5, sp: 6 };

function mavenTokens(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    const toks = [];
    let cur = '', isNum = null;
    const flush = () => {
        if (cur !== '') toks.push(isNum ? parseInt(cur, 10) : cur);
        cur = ''; isNum = null;
    };
    for (const ch of s) {
        if (ch >= '0' && ch <= '9') {
            if (isNum === false) flush();
            isNum = true; cur += ch;
        } else if (ch >= 'a' && ch <= 'z') {
            if (isNum === true) flush();
            isNum = false; cur += ch;
        } else if (ch === '.' || ch === '-') {
            flush();
        } else {
            return null;
        }
    }
    flush();
    while (toks.length) {  // strip trailing null-equivalents
        const last = toks[toks.length - 1];
        if (last === 0 || last === '' || last === 'ga' || last === 'final' || last === 'release') toks.pop();
        else break;
    }
    return toks;
}

function compareMaven(a, b) {
    const A = mavenTokens(a), B = mavenTokens(b);
    if (!A || !B) return null;
    const rankOf = (t) => Object.prototype.hasOwnProperty.call(MAVEN_RANK, t) ? MAVEN_RANK[t] : 5.5;
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
        let x = i < A.length ? A[i] : null;
        let y = i < B.length ? B[i] : null;
        if (x === null && y === null) continue;
        if (x === null) x = (typeof y === 'number') ? 0 : '';
        if (y === null) y = (typeof x === 'number') ? 0 : '';
        if (typeof x === 'number' && typeof y === 'number') {
            if (x !== y) return x < y ? -1 : 1;
        } else if (typeof x === 'string' && typeof y === 'string') {
            const rx = rankOf(x), ry = rankOf(y);
            if (rx !== ry) return rx < ry ? -1 : 1;
            if (rx === 5.5 && x !== y) return x < y ? -1 : 1;
        } else {
            return (typeof x === 'number') ? 1 : -1;  // number > string
        }
    }
    return 0;
}

function satisfiesRange(version, range, ecosystem) {
    // Comma-separated AND of <,<=,>,>=,= conditions. Unknown -> false (never flag blindly).
    const cmp = ecosystem === 'pip' ? comparePep440 : ecosystem === 'maven' ? compareMaven : compareSemver;
    const parts = String(range || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    for (const part of parts) {
        const m = part.match(/^(<=|>=|<|>|=)?\s*(.+)$/);
        if (!m) return false;
        const op = m[1] || '=';
        const c = cmp(version, m[2]);
        if (c === null) return false;
        const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
        if (!ok) return false;
    }
    return true;
}

// -- lockfile parsers: each returns [{name, version, source}]; version may be null --
function parsePackageLock(file) {
    const pkgs = [];
    let lock;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return pkgs; }
    if (!lock || typeof lock !== 'object') return pkgs;
    const push = (name, version) => {
        if (name && pkgs.length < MAX_PKGS) pkgs.push({ name, version: version || null, source: path.basename(file) });
    };
    if (lock.packages && typeof lock.packages === 'object') {
        for (const [k, v] of Object.entries(lock.packages)) {
            const m = k.match(/^node_modules\/(.+)$/);
            if (m && !m[1].includes('node_modules/')) push(m[1], v && v.version);
        }
    }
    if (lock.dependencies && typeof lock.dependencies === 'object' && pkgs.length === 0) {
        for (const [name, v] of Object.entries(lock.dependencies)) push(name, v && v.version);
    }
    return pkgs;
}

function parseRequirements(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        if (!line || line.startsWith('-')) continue;
        const m = line.match(/^([A-Za-z0-9_.\-]+)\s*(==|~=|>=|<=|>|<|!=)?\s*([^;\s]*)/);
        if (!m) continue;
        // Only pinned (==) versions can be matched; others recorded with null version.
        pkgs.push({ name: m[1].toLowerCase(), version: m[2] === '==' && m[3] ? m[3].trim() : null, source: path.basename(file) });
        if (pkgs.length >= MAX_PKGS) break;
    }
    return pkgs;
}

function parsePoetryLock(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '[[package]]') {
            if (cur && cur.name) pkgs.push(cur);
            cur = { name: null, version: null, source: path.basename(file) };
            continue;
        }
        if (cur && line.startsWith('name =')) cur.name = line.split('=')[1].trim().replace(/['"]/g, '').toLowerCase();
        else if (cur && line.startsWith('version =')) cur.version = line.split('=')[1].trim().replace(/['"]/g, '');
        if (pkgs.length >= MAX_PKGS) break;
    }
    if (cur && cur.name && pkgs.length < MAX_PKGS) pkgs.push(cur);
    return pkgs.filter(p => p.name);
}

function parsePubspecLock(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    let inPkgs = false, cur = null;
    const flush = () => { if (cur && cur.name && cur.version) pkgs.push(cur); cur = null; };
    for (const raw of text.split('\n')) {
        if (/^packages:/.test(raw)) { inPkgs = true; continue; }
        if (!inPkgs) continue;
        if (/^\S/.test(raw)) { flush(); break; }  // next top-level section
        const nm = raw.match(/^ {2}([A-Za-z0-9_]+):\s*$/);
        if (nm) { flush(); cur = { name: nm[1].toLowerCase(), version: null, source: path.basename(file) }; continue; }
        const vm = raw.match(/^\s+version:\s*["']?([^"'\s]+)["']?/);
        if (vm && cur && !cur.version) cur.version = vm[1];
        if (pkgs.length >= MAX_PKGS) break;
    }
    flush();
    return pkgs;
}


function parseGoMod(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    let inRequire = false;
    for (const raw of text.split('\n')) {
        const line = raw.split('//')[0].trim();
        if (!line) continue;
        if (/^require\s*\(\s*$/.test(line)) { inRequire = true; continue; }
        let req = line;
        if (/^require\s+\S/.test(line)) req = line.replace(/^require\s+/, '');
        else if (!inRequire) continue;
        if (/^\)\s*$/.test(req)) { inRequire = false; continue; }
        const m = req.match(/^(\S+)\s+(v\S+)\s*$/);
        if (m && pkgs.length < MAX_PKGS) pkgs.push({ name: m[1], version: m[2], source: path.basename(file) });
        if (pkgs.length >= MAX_PKGS) break;
    }
    return pkgs;
}

function parseCargoLock(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '[[package]]') {
            if (cur && cur.name && cur.version) pkgs.push(cur);
            cur = { name: null, version: null, source: path.basename(file) };
            continue;
        }
        if (cur && !cur.name) {
            const m = line.match(/^name\s*=\s*"([^"]+)"/);
            if (m) cur.name = m[1];
        } else if (cur && !cur.version) {
            const m = line.match(/^version\s*=\s*"([^"]+)"/);
            if (m) cur.version = m[1];
        }
        if (pkgs.length >= MAX_PKGS) break;
    }
    if (cur && cur.name && cur.version && pkgs.length < MAX_PKGS) pkgs.push(cur);
    return pkgs;
}

function parsePomXml(file) {
    // Lightweight <dependency> extraction (no XML parser: dependency-free).
    // Property versions (${...}) need a full Maven model -> null version.
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    const blocks = text.match(/<dependency>[\s\S]*?<\/dependency>/g) || [];
    for (const b of blocks) {
        const g = b.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/);
        const a = b.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/);
        const v = b.match(/<version>\s*([^<]+?)\s*<\/version>/);
        if (!g || !a) continue;
        const ver = v ? v[1].trim() : null;
        pkgs.push({ name: g[1].trim() + ':' + a[1].trim(),
            version: ver && !ver.includes('$') ? ver : null, source: path.basename(file) });
        if (pkgs.length >= MAX_PKGS) break;
    }
    return pkgs;
}

function parseNugetLock(file) {
    const pkgs = [];
    let lock;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return pkgs; }
    const deps = (lock && lock.dependencies) || {};
    const seen = new Set();
    for (const fw of Object.values(deps)) {
        if (!fw || typeof fw !== 'object') continue;
        for (const [id, meta] of Object.entries(fw)) {
            const k = String(id).toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            const ver = meta && typeof meta.resolved === 'string' ? meta.resolved : null;
            pkgs.push({ name: String(id), version: ver, source: path.basename(file) });
            if (pkgs.length >= MAX_PKGS) return pkgs;
        }
    }
    return pkgs;
}

function parsePackagesConfig(file) {
    const pkgs = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return pkgs; }
    const patterns = [
        /<package\s+[^>]*id="([^"]+)"[^>]*version="([^"]+)"/g,
        /<package\s+[^>]*version="([^"]+)"[^>]*id="([^"]+)"/g,
    ];
    const seen = new Set();
    patterns.forEach((re, pi) => {
        let m;
        while ((m = re.exec(text)) && pkgs.length < MAX_PKGS) {
            const id = pi === 0 ? m[1] : m[2], ver = pi === 0 ? m[2] : m[1];
            const k = id.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            pkgs.push({ name: id, version: ver, source: path.basename(file) });
        }
    });
    return pkgs;
}

function collectPackages(wsRoot) {
    const all = [];
    if (!wsRoot) return all;
    const eco = (list, ecosystem) => list.forEach(p => all.push({ ecosystem, ...p }));
    eco(parsePackageLock(path.join(wsRoot, 'package-lock.json')), 'npm');
    eco(parseRequirements(path.join(wsRoot, 'requirements.txt')), 'pip');
    eco(parsePoetryLock(path.join(wsRoot, 'poetry.lock')), 'pip');
    eco(parsePubspecLock(path.join(wsRoot, 'pubspec.lock')), 'pub');
    eco(parseGoMod(path.join(wsRoot, 'go.mod')), 'go');
    eco(parseCargoLock(path.join(wsRoot, 'Cargo.lock')), 'crates');
    eco(parsePomXml(path.join(wsRoot, 'pom.xml')), 'maven');
    eco(parseNugetLock(path.join(wsRoot, 'packages.lock.json')), 'nuget');
    eco(parsePackagesConfig(path.join(wsRoot, 'packages.config')), 'nuget');
    return all.slice(0, MAX_PKGS);
}

function dbEcosystems(db) {
    const s = new Set();
    if (db && Array.isArray(db.advisories)) {
        for (const a of db.advisories) {
            if (a && a.ecosystem) s.add(String(a.ecosystem));
        }
    }
    return [...s].sort();
}

// Ecosystems scanned in the workspace but absent from the DB: their
// packages were NOT evaluated (never reported as clean).
function uncoveredEcosystems(packages, db) {
    const covered = new Set(dbEcosystems(db));
    const counts = new Map();
    for (const p of packages || []) {
        if (!p || !p.ecosystem || covered.has(p.ecosystem)) continue;
        counts.set(p.ecosystem, (counts.get(p.ecosystem) || 0) + 1);
    }
    return [...counts.entries()].map(([ecosystem, count]) => ({ ecosystem, count }))
        .sort((x, y) => (x.ecosystem < y.ecosystem ? -1 : 1));
}

function matchAdvisories(packages, db) {
    const matches = [];
    if (!db || !Array.isArray(db.advisories)) return matches;
    const byEcoName = new Map();
    for (const a of db.advisories) {
        if (!a || !a.package || !a.vulnerable) continue;
        const k = (a.ecosystem || 'npm') + '|' + String(a.package).toLowerCase();
        if (!byEcoName.has(k)) byEcoName.set(k, []);
        byEcoName.get(k).push(a);
    }
    for (const p of packages) {
        if (!p || !p.version) continue;  // unpinned/unknown -> cannot match, never flag
        const list = byEcoName.get(p.ecosystem + '|' + String(p.name).toLowerCase()) || [];
        for (const a of list) {
            if (satisfiesRange(p.version, a.vulnerable, p.ecosystem)) {
                matches.push({
                    package: p.name, version: p.version, ecosystem: p.ecosystem, source: p.source,
                    id: a.id || 'n/a', cve: a.cve || 'n/a', severity: a.severity || 'unknown',
                    summary: a.summary || '', fixedIn: a.fixedIn || 'n/a',
                });
            }
        }
    }
    return matches;
}

module.exports = {
    loadAdvisories, userDbPath, dbIsStale, STALE_DAYS,
    parseVersion, cmpVersions, satisfiesRange,
    parsePackageLock, parseRequirements, parsePoetryLock, parsePubspecLock,
    parseGoMod, parseCargoLock, parsePomXml, parseNugetLock, parsePackagesConfig,
    compareSemver, comparePep440, compareMaven,
    dbEcosystems, uncoveredEcosystems,
    collectPackages, matchAdvisories, EMBEDDED_DB,
};
