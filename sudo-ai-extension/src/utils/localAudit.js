/**
 * SUDO STUDIO - Local (offline) vulnerability audit (TASK 7b).
 * Matches locked dependency versions against an advisory DB. No network. Ever.
 * DB resolution order:
 *   1. $SUDO_ADVISORIES_PATH (tests / power users)
 *   2. ~/.sudo_studio/advisories.json (imported via the Security panel)
 *   3. embedded src/data/advisories.json
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EMBEDDED_DB = path.join(__dirname, '..', 'data', 'advisories.json');
const STALE_DAYS  = 180;
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

function satisfiesRange(version, range) {
    // Comma-separated AND of <,<=,>,>=,= conditions. Unknown -> false (never flag blindly).
    const parts = String(range || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    for (const part of parts) {
        const m = part.match(/^(<=|>=|<|>|=)?\s*(.+)$/);
        if (!m) return false;
        const op = m[1] || '=';
        const c = cmpVersions(version, m[2]);
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

function collectPackages(wsRoot) {
    const all = [];
    if (!wsRoot) return all;
    const eco = (list, ecosystem) => list.forEach(p => all.push({ ecosystem, ...p }));
    eco(parsePackageLock(path.join(wsRoot, 'package-lock.json')), 'npm');
    eco(parseRequirements(path.join(wsRoot, 'requirements.txt')), 'pip');
    eco(parsePoetryLock(path.join(wsRoot, 'poetry.lock')), 'pip');
    eco(parsePubspecLock(path.join(wsRoot, 'pubspec.lock')), 'pub');
    return all.slice(0, MAX_PKGS);
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
            if (satisfiesRange(p.version, a.vulnerable)) {
                matches.push({
                    package: p.name, version: p.version, ecosystem: p.ecosystem, source: p.source,
                    cve: a.cve || 'n/a', severity: a.severity || 'unknown',
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
    collectPackages, matchAdvisories, EMBEDDED_DB,
};
