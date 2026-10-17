#!/usr/bin/env node
/**
 * SUDO STUDIO - Advisory DB builder + signer (MISSION P23).
 *
 * Builds a compact offline advisory database from the OSV bulk dumps
 * (https://osv.dev), or signs/verifies offline-update packages with the
 * DEDICATED advisory keypair (Ed25519, distinct from the license keys).
 * Pure Node.js: only built-in modules + the extension's advisorySig helper
 * (single source of truth for the signed bytes).
 *
 *   node build-advisory-db.js keygen [--key-id ID]
 *       Print a fresh Ed25519 keypair. The PUBLIC half goes into
 *       sudo-ai-extension/src/utils/advisorySig.js; the PRIVATE half
 *       never leaves the maintainer machine.
 *   node build-advisory-db.js build --out DB.json [--date YYYY-MM-DD]
 *       [--ecosystems npm,pip,...] [--cache-dir DIR] [--zip-dir DIR]
 *       [--refresh] [--max-zip-mb N]
 *       Download OSV all.zip dumps (or reuse --zip-dir files, used by
 *       hermetic tests) and write the compact DB. Prints per-ecosystem
 *       counts and the output size.
 *   node build-advisory-db.js sign --in DB.json --out PKG.json
 *       --key-file PRIV [--key-id ID]
 *       Sign a built DB into an importable package. The private key file
 *       holds base64 PKCS8 DER (or PEM); it may also come from the
 *       SUDO_ADVISORY_SIGN_KEY environment variable.
 *   node build-advisory-db.js verify --in PKG.json [--pubkey-b64 B64]
 *       Verify a package (embedded extension key by default).
 *
 * Conversion policy (documented, deterministic):
 * - withdrawn records and MAL-* (malware, not vulnerabilities) skipped.
 * - ranges of type ECOSYSTEM and SEMVER are converted; GIT ranges are
 *   skipped (commit hashes cannot be matched against versions).
 * - severity: database_specific.severity first, else CVSS v3.x vector
 *   score, else "unknown" (CVSS v4 has no cheap calculator; records
 *   without any severity stay honest instead of invented).
 * - affected entries with no usable range but a versions[] list become
 *   "=v" entries (capped); affected entries with neither are skipped
 *   and counted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { stableStringify, canonicalPayload } =
    require('../../sudo-ai-extension/src/utils/advisorySig');

const OSV_BASE = 'https://storage.googleapis.com/osv-vulnerabilities/';
// dl: OSV bucket path (case-sensitive). tag: internal ecosystem tag used by
// the matcher (PyPI stays "pip": historical matcher tag).
const ECOSYSTEMS = [
    { dl: 'npm',       tag: 'npm',    file: 'npm-all.zip' },
    { dl: 'PyPI',      tag: 'pip',    file: 'pypi-all.zip' },
    { dl: 'crates.io', tag: 'crates', file: 'crates_io-all.zip' },
    { dl: 'Go',        tag: 'go',     file: 'go-all.zip' },
    { dl: 'Maven',     tag: 'maven',  file: 'maven-all.zip' },
    { dl: 'NuGet',     tag: 'nuget',  file: 'nuget-all.zip' },
    { dl: 'Pub',       tag: 'pub',    file: 'pub-all.zip' },
];
const UPSTREAM = 'https://osv.dev (bulk dumps storage.googleapis.com/osv-vulnerabilities/*/all.zip)';
const VERSIONS_CAP = 64;      // max "=v" entries per versions-only affected
const SUMMARY_CAP = 160;      // max chars kept per summary (mission: short)
const MAX_ZIP_MB_DEFAULT = 512;
const MAX_ENTRY_UNCOMP = 64 * 1024 * 1024;
const MAX_ENTRIES = 600000;

// ---------------------------------------------------------------- args ---

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (a === '--refresh') { out.refresh = true; continue; }
        const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
        if (!m) { out._.push(a); continue; }
        if (m[2] !== undefined) out[m[1]] = m[2];
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
        else out[m[1]] = true;
    }
    return out;
}

function usage(exitCode) {
    const t = [
        'usage:',
        '  build-advisory-db.js keygen [--key-id ID]',
        '  build-advisory-db.js build --out DB.json [--date YYYY-MM-DD] [--ecosystems a,b]',
        '      [--cache-dir DIR] [--zip-dir DIR] [--refresh] [--max-zip-mb N]',
        '  build-advisory-db.js sign --in DB.json --out PKG.json --key-file PRIV [--key-id ID]',
        '  build-advisory-db.js verify --in PKG.json [--pubkey-b64 B64]',
    ].join('\n');
    (exitCode ? process.stderr : process.stdout).write(t + '\n');
    process.exit(exitCode ? 1 : 0);
}

// ------------------------------------------------- streaming zip reader ---

/**
 * Minimal ZIP reader for the OSV dumps: entries are read one at a time by
 * file offset (central directory), so a 200+ MB dump never sits fully in
 * memory. Stored + deflated entries, plain EOCD + ZIP64 (the npm dump
 * exceeds 65535 entries, so ZIP64 support is mandatory, not optional).
 */
function openZip(filePath, maxZipBytes) {
    const fd = fs.openSync(filePath, 'r');
    const close = () => { try { fs.closeSync(fd); } catch { /* ignore */ } };
    try {
        const size = fs.fstatSync(fd).size;
        if (size > maxZipBytes) throw new Error('zip too large (' + size + ' bytes)');
        if (size < 22) throw new Error('file too small to be a zip');
        const tailLen = Math.min(size, 65557 + 22);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('end-of-central-directory not found');
        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOff = tail.readUInt32LE(eocd + 16);
        if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
            // ZIP64: the locator sits right before the EOCD.
            const eocdOff = size - tailLen + eocd;
            const loc = Buffer.alloc(20);
            fs.readSync(fd, loc, 0, 20, eocdOff - 20);
            if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error('ZIP64 locator not found');
            const z64off = Number(loc.readBigUInt64LE(8));
            const z64 = Buffer.alloc(56);
            fs.readSync(fd, z64, 0, 56, z64off);
            if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 EOCD not found');
            count = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOff = Number(z64.readBigUInt64LE(48));
        }
        if (count > MAX_ENTRIES) throw new Error('too many entries (' + count + ')');
        const cd = Buffer.alloc(cdSize);
        fs.readSync(fd, cd, 0, cdSize, cdOff);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (p + 46 > cd.length) throw new Error('truncated central directory');
            if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central entry #' + i);
            const method = cd.readUInt16LE(p + 10);
            let compSize = cd.readUInt32LE(p + 20);
            let uncompSize = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const comLen = cd.readUInt16LE(p + 32);
            let localOff = cd.readUInt32LE(p + 42);
            if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
                // ZIP64 extra field (tag 0x0001): values come in the fixed
                // order uncompressed size, compressed size, local offset.
                const extra = cd.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
                let q = 0, zv = [];
                while (q + 4 <= extra.length) {
                    const tag = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
                    if (tag === 1) {
                        for (let k = 0; k + 8 <= len; k += 8) zv.push(Number(extra.readBigUInt64LE(q + 4 + k)));
                        break;
                    }
                    q += 4 + len;
                }
                let zi = 0;
                if (uncompSize === 0xffffffff) uncompSize = zv[zi++];
                if (compSize === 0xffffffff) compSize = zv[zi++];
                if (localOff === 0xffffffff) localOff = zv[zi++];
                if (![uncompSize, compSize, localOff].every(Number.isFinite)) {
                    throw new Error('bad ZIP64 extra field for entry #' + i);
                }
            }
            const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
            entries.push({ name, method, compSize, uncompSize, localOff });
            p += 46 + nameLen + extraLen + comLen;
        }
        return {
            entries,
            getData(e) {
                if (e.method !== 0 && e.method !== 8) {
                    throw new Error('unsupported zip method ' + e.method + ' for ' + e.name);
                }
                if (e.uncompSize > MAX_ENTRY_UNCOMP) throw new Error('entry too large: ' + e.name);
                const lh = Buffer.alloc(30);
                fs.readSync(fd, lh, 0, 30, e.localOff);
                if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header: ' + e.name);
                const dataOff = e.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
                const comp = Buffer.alloc(e.compSize);
                fs.readSync(fd, comp, 0, e.compSize, dataOff);
                return e.method === 8 ? zlib.inflateRawSync(comp) : comp;
            },
            close,
        };
    } catch (e) { close(); throw e; }
}

// -------------------------------------------------------------- download ---

function download(url, dest, maxBytes, redirects = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sudo-studio-advisory-builder/1.0' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirects <= 0) { reject(new Error('too many redirects')); return; }
                const next = new URL(res.headers.location, url).toString();
                download(next, dest, maxBytes, redirects - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
                return;
            }
            const tmp = dest + '.part';
            const ws = fs.createWriteStream(tmp);
            let got = 0;
            res.on('data', (c) => {
                got += c.length;
                if (got > maxBytes) {
                    res.destroy();
                    ws.destroy();
                    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                    reject(new Error('download exceeds size cap (' + maxBytes + ' bytes)'));
                }
            });
            res.on('error', (e) => { ws.destroy(); reject(e); });
            ws.on('error', reject);
            ws.on('finish', () => { fs.renameSync(tmp, dest); resolve(got); });
            res.pipe(ws);
        });
        req.on('error', reject);
    });
}

async function downloadRetry(url, dest, maxBytes, tries = 3) {
    let last = null;
    for (let i = 1; i <= tries; i++) {
        try { return await download(url, dest + '.dl', maxBytes); }
        catch (e) {
            last = e;
            process.stderr.write('  download try ' + i + '/' + tries + ' failed: ' + e.message + '\n');
            if (i < tries) await new Promise((r) => setTimeout(r, 2000 * i));
        }
    }
    throw last;
}

// ------------------------------------------------------------ cvss v3.x ---

/**
 * CVSS v3.0/v3.1 base score from a vector string (FIRST specification).
 * Temporal/environmental metrics are ignored (base only). The v3.1
 * roundup rule is applied to 3.0 vectors too: the two differ only on
 * exact-boundary scores, which cannot change a severity band here.
 * Returns a number 0..10, or null when the vector is unusable.
 */
function cvssV3Base(vector) {
    const m = /^CVSS:3\.[01]\/((?:[A-Z]+:[A-Za-z0-9]+\/?)+)$/.exec(String(vector || '').trim());
    if (!m) return null;
    const kv = {};
    for (const part of m[1].split('/')) {
        const i = part.indexOf(':');
        if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
    }
    const need = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];
    for (const k of need) if (!kv[k]) return null;
    const w = {
        AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
        AC: { L: 0.77, H: 0.44 },
        UI: { N: 0.85, R: 0.62 },
        CIA: { N: 0, L: 0.22, H: 0.56 },
    };
    const av = w.AV[kv.AV], ac = w.AC[kv.AC], ui = w.UI[kv.UI];
    const c = w.CIA[kv.C], ii = w.CIA[kv.I], a = w.CIA[kv.A];
    const changed = kv.S === 'C';
    if (kv.S !== 'U' && !changed) return null;
    const pr = kv.PR === 'N' ? 0.85 : kv.PR === 'L' ? (changed ? 0.68 : 0.62)
        : kv.PR === 'H' ? (changed ? 0.5 : 0.27) : undefined;
    if ([av, ac, pr, ui, c, ii, a].some((v) => v === undefined)) return null;
    const iss = 1 - (1 - c) * (1 - ii) * (1 - a);
    let impact;
    if (!changed) impact = 6.42 * iss;
    else {
        const d = iss - 0.029;
        impact = d <= 0 ? 0 : 7.52 * d - 3.25 * Math.pow(d, 15);
    }
    const expl = 8.22 * av * ac * pr * ui;
    if (impact <= 0) return 0;
    const raw = changed ? Math.min(1.08 * (impact + expl), 10) : Math.min(impact + expl, 10);
    // v3.1 roundup: smallest 1-decimal number >= raw.
    const scaled = Math.ceil(raw * 100000) / 100000;
    const t = scaled * 10;
    if (Math.abs(t - Math.round(t)) < 1e-9) return Math.round(t) / 10;
    return Math.ceil(t) / 10;
}

function levelFromScore(score) {
    if (score === null || score === undefined) return 'unknown';
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low'; // >0 low; 0.0 (no impact) stays an advisory: conservative low
}

const RANK = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };

function severityOf(rec, stats) {
    const ds = rec && rec.database_specific && rec.database_specific.severity;
    if (typeof ds === 'string') {
        const v = ds.trim().toUpperCase();
        if (v === 'CRITICAL' || v === 'HIGH' || v === 'MODERATE' || v === 'MEDIUM' || v === 'LOW') {
            stats.sevDbSpecific++;
            return v === 'MODERATE' || v === 'MEDIUM' ? 'medium' : v.toLowerCase();
        }
    }
    let best = null, sawV4 = false;
    const list = Array.isArray(rec.severity) ? rec.severity : [];
    for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        if (s.type === 'CVSS_V4') { sawV4 = true; continue; }
        if (s.type !== 'CVSS_V3') continue;
        const lvl = levelFromScore(cvssV3Base(s.score));
        if (lvl !== 'unknown' && (!best || RANK[lvl] > RANK[best])) best = lvl;
    }
    if (best) { stats.sevCvss3++; return best; }
    if (sawV4) stats.sevV4Only++;
    else stats.sevNone++;
    return 'unknown';
}

// ------------------------------------------------------- osv conversion ---

function segmentsFromEvents(events, stats) {
    const segs = [];
    let cur = null;
    const flush = () => { if (cur) { segs.push(cur); cur = null; } };
    for (const ev of events || []) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.introduced !== undefined) { flush(); cur = { intro: String(ev.introduced), fixed: null, last: null, limit: null }; }
        else if (!cur) continue; // fixed/last_affected without introduced: ignore
        else if (ev.fixed !== undefined) { cur.fixed = String(ev.fixed); flush(); }
        else if (ev.last_affected !== undefined) { cur.last = String(ev.last_affected); flush(); }
        else if (ev.limit !== undefined) { cur.limit = String(ev.limit); stats.limitRanges++; flush(); }
    }
    flush();
    return segs;
}

function rangeString(seg, stats) {
    const parts = [];
    if (seg.intro && seg.intro !== '0') parts.push('>=' + seg.intro);
    if (seg.fixed) parts.push('<' + seg.fixed);
    else if (seg.last) parts.push('<=' + seg.last);
    else if (seg.limit) parts.push('<' + seg.limit);
    if (!parts.length) { stats.unbounded++; return '>=0'; } // every version
    return parts.join(',');
}

function shortSummary(rec) {
    let s = typeof rec.summary === 'string' && rec.summary.trim()
        ? rec.summary : String(rec.details || '').split('\n')[0];
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP - 3) + '...' : s;
}

function idPrefix(id) {
    const m = /^([A-Z0-9]+)-/.exec(String(id || ''));
    return m ? m[1] : 'OTHER';
}

function convertRecord(rec, eco, acc, seen, stats) {
    const id = String(rec.id || '');
    if (!id || rec.withdrawn) { stats.withdrawn++; return; }
    if (id.startsWith('MAL-')) { stats.malware++; return; } // malware != vuln
    stats.kept++;
    const prefix = idPrefix(id);
    stats.prefixes[prefix] = (stats.prefixes[prefix] || 0) + 1;
    const dsrc = rec.database_specific && rec.database_specific.source;
    if (typeof dsrc === 'string' && /^https?:\/\//.test(dsrc)) {
        try {
            const h = new URL(dsrc).hostname;
            stats.hosts[h] = (stats.hosts[h] || 0) + 1;
        } catch { /* ignore bad url */ }
    }
    const sev = severityOf(rec, stats);
    const aliases = Array.isArray(rec.aliases) ? rec.aliases : [];
    const cve = aliases.find((x) => typeof x === 'string' && x.startsWith('CVE-')) || 'n/a';
    const summary = shortSummary(rec);
    const affected = Array.isArray(rec.affected) ? rec.affected : [];
    for (const aff of affected) {
        if (!aff || !aff.package || typeof aff.package.name !== 'string') { stats.badAffected++; continue; }
        const pkg = aff.package.name;
        let emitted = 0;
        for (const r of Array.isArray(aff.ranges) ? aff.ranges : []) {
            if (!r || typeof r !== 'object') continue;
            if (r.type === 'GIT') { stats.gitRanges++; continue; }
            if (r.type !== 'ECOSYSTEM' && r.type !== 'SEMVER') { stats.otherRanges++; continue; }
            for (const seg of segmentsFromEvents(r.events, stats)) {
                const vuln = rangeString(seg, stats);
                const key = eco + '|' + pkg + '|' + vuln + '|' + cve + '|' + id;
                if (seen.has(key)) { stats.deduped++; continue; }
                seen.add(key);
                acc.push({ ecosystem: eco, package: pkg, vulnerable: vuln, cve, severity: sev, summary, fixedIn: seg.fixed || 'n/a', id });
                emitted++;
            }
        }
        if (!emitted) {
            const vers = Array.isArray(aff.versions) ? aff.versions.filter((v) => typeof v === 'string') : [];
            if (vers.length) {
                stats.versionsOnly++;
                if (vers.length > VERSIONS_CAP) stats.versionsTruncated += vers.length - VERSIONS_CAP;
                for (const v of vers.slice(0, VERSIONS_CAP)) {
                    const key = eco + '|' + pkg + '|=' + v + '|' + cve + '|' + id;
                    if (seen.has(key)) { stats.deduped++; continue; }
                    seen.add(key);
                    acc.push({ ecosystem: eco, package: pkg, vulnerable: '=' + v, cve, severity: sev, summary, fixedIn: 'n/a', id });
                }
            } else {
                stats.noRange++;
            }
        }
    }
}

function newStats() {
    return { records: 0, kept: 0, withdrawn: 0, malware: 0, badJson: 0,
        ecoRanges: 0, semverRanges: 0, gitRanges: 0, otherRanges: 0, limitRanges: 0,
        versionsOnly: 0, versionsTruncated: 0, noRange: 0, badAffected: 0,
        unbounded: 0, deduped: 0,
        sevDbSpecific: 0, sevCvss3: 0, sevV4Only: 0, sevNone: 0,
        prefixes: {}, hosts: {} };
}

function convertZip(zipPath, eco, acc, seen, maxZipBytes) {
    const stats = newStats();
    const z = openZip(zipPath, maxZipBytes);
    try {
        for (const e of z.entries) {
            if (!e.name.endsWith('.json')) continue;
            stats.records++;
            let rec;
            try {
                rec = JSON.parse(z.getData(e).toString('utf8'));
            } catch { stats.badJson++; continue; }
            convertRecord(rec, eco, acc, seen, stats);
        }
    } finally { z.close(); }
    return stats;
}

// ------------------------------------------------------------------ cmds ---

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

async function cmdBuild(a) {
    const out = a.out;
    if (!out) { process.stderr.write('build needs --out DB.json\n'); process.exit(1); }
    const date = a.date || todayUtc();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) {
        process.stderr.write('bad --date (want YYYY-MM-DD)\n'); process.exit(1);
    }
    let list = ECOSYSTEMS;
    if (a.ecosystems) {
        const want = String(a.ecosystems).split(',').map((s) => s.trim().toLowerCase());
        list = ECOSYSTEMS.filter((e) => want.includes(e.tag));
        if (!list.length) { process.stderr.write('no known ecosystem in --ecosystems\n'); process.exit(1); }
    }
    const zipDir = a['zip-dir'] || null;
    const cacheDir = a['cache-dir'] || path.join(os.tmpdir(), 'osv-advisory-cache');
    const maxZipBytes = (parseInt(a['max-zip-mb'] || MAX_ZIP_MB_DEFAULT, 10) || MAX_ZIP_MB_DEFAULT) * 1024 * 1024;
    const acc = [], seen = new Set(), perEco = {}, sources = {};
    for (const e of list) {
        let zipPath;
        if (zipDir) {
            zipPath = path.join(zipDir, e.file);
            if (!fs.existsSync(zipPath)) { process.stderr.write('missing ' + zipPath + '\n'); process.exit(1); }
            process.stderr.write('[' + e.tag + '] using ' + zipPath + '\n');
        } else {
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            zipPath = path.join(cacheDir, e.file);
            if (a.refresh || !fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
                const url = OSV_BASE + e.dl + '/all.zip';
                process.stderr.write('[' + e.tag + '] downloading ' + url + '\n');
                const got = await downloadRetry(url, zipPath, maxZipBytes);
                fs.renameSync(zipPath + '.dl', zipPath);
                process.stderr.write('[' + e.tag + '] got ' + (got / 1048576).toFixed(1) + ' MB\n');
            } else {
                process.stderr.write('[' + e.tag + '] cached ' + zipPath + '\n');
            }
        }
        const before = acc.length;
        const st = convertZip(zipPath, e.tag, acc, seen, maxZipBytes);
        st.advisories = acc.length - before;
        perEco[e.tag] = st;
        sources[e.tag] = {
            dump: zipDir ? 'local:' + e.file : OSV_BASE + e.dl + '/all.zip',
            idPrefixes: st.prefixes, hosts: st.hosts,
        };
        process.stderr.write('[' + e.tag + '] records=' + st.records + ' kept=' + st.kept + ' entries=' + st.advisories + '\n');
    }
    const db = { format: 2, generatedAt: date, upstream: UPSTREAM, sources, stats: perEco, advisories: acc };
    const outDir = path.dirname(path.resolve(out));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(db));
    const bytes = fs.statSync(out).size;
    // Report: per-ecosystem size share is approximated from entry counts
    // (entries are homogeneous short JSON objects).
    const total = acc.length || 1;
    console.log('advisory DB built: ' + out);
    console.log('generatedAt: ' + date + '  entries: ' + acc.length + '  size: ' + bytes + ' bytes (' + (bytes / 1048576).toFixed(2) + ' MB)');
    console.log('eco       entries   ~bytes  records  kept  withdr  malw  gitRng  noRng  vOnly  unbnd  dedup');
    for (const e of list) {
        const st = perEco[e.tag];
        const share = Math.round(bytes * st.advisories / total);
        console.log(e.tag.padEnd(10) + String(st.advisories).padStart(7) +
            String(share).padStart(9) + String(st.records).padStart(9) +
            String(st.kept).padStart(6) + String(st.withdrawn).padStart(7) +
            String(st.malware).padStart(6) + String(st.gitRanges).padStart(7) +
            String(st.noRange).padStart(7) + String(st.versionsOnly).padStart(6) +
            String(st.unbounded).padStart(6) + String(st.deduped).padStart(6));
    }
    console.log('severity sources: db_specific=' + list.reduce((n, e) => n + perEco[e.tag].sevDbSpecific, 0) +
        ' cvss3=' + list.reduce((n, e) => n + perEco[e.tag].sevCvss3, 0) +
        ' v4-only(unknown)=' + list.reduce((n, e) => n + perEco[e.tag].sevV4Only, 0) +
        ' none(unknown)=' + list.reduce((n, e) => n + perEco[e.tag].sevNone, 0));
}

function loadPriv(input) {
    const t = String(input).trim();
    if (t.includes('PRIVATE KEY')) return crypto.createPrivateKey(t);
    return crypto.createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' });
}

function cmdKeygen(a) {
    const keyId = a['key-id'] || 'sudo-advisory-1';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    console.log('keyId: ' + keyId);
    console.log('PUBLIC_SPKI_B64=' + pubB64);
    console.log('PRIVATE_PKCS8_B64=' + privB64);
    console.log('WARNING: the PRIVATE key never leaves this machine. Store it offline.');
    console.log('Embed the PUBLIC key as ADVISORY_PUBLIC_KEY_SPKI_B64 in');
    console.log('sudo-ai-extension/src/utils/advisorySig.js (keep keyId in sync).');
}

function cmdSign(a) {
    if (!a.in || !a.out) { process.stderr.write('sign needs --in DB.json --out PKG.json\n'); process.exit(1); }
    let keyInput = null, keyFrom = null;
    if (a['key-file']) {
        keyInput = fs.readFileSync(a['key-file'], 'utf8');
        keyFrom = 'file';
    } else if (process.env.SUDO_ADVISORY_SIGN_KEY) {
        keyInput = process.env.SUDO_ADVISORY_SIGN_KEY;
        keyFrom = 'env';
    }
    if (!keyInput) { process.stderr.write('sign needs --key-file PRIV or SUDO_ADVISORY_SIGN_KEY\n'); process.exit(1); }
    const db = JSON.parse(fs.readFileSync(a.in, 'utf8'));
    if (!db || typeof db !== 'object' || !Array.isArray(db.advisories) || typeof db.generatedAt !== 'string') {
        process.stderr.write('input is not an advisory DB ({ generatedAt, advisories[] })\n'); process.exit(1);
    }
    if (db.signature) { process.stderr.write('input is already signed (refusing to double-sign)\n'); process.exit(1); }
    const priv = loadPriv(keyInput);
    const sig = crypto.sign(null, canonicalPayload(db), priv);
    const keyId = a['key-id'] || 'sudo-advisory-1';
    const pkg = Object.assign({}, db, { signature: { alg: 'ed25519', keyId, sig: sig.toString('base64') } });
    fs.writeFileSync(a.out, JSON.stringify(pkg));
    // Self-check with the exact extension verifier before claiming success.
    const { verifyPackage, ADVISORY_PUBLIC_KEY_SPKI_B64 } = require('../../sudo-ai-extension/src/utils/advisorySig');
    const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
    const chk = verifyPackage(pkg, { publicKeySpkiB64: pub });
    if (!chk.ok) { process.stderr.write('self-check FAILED: ' + chk.reason + '\n'); process.exit(1); }
    if (ADVISORY_PUBLIC_KEY_SPKI_B64 !== pub) {
        process.stderr.write('note: signing key differs from the embedded extension key (' + keyFrom + ')\n');
    }
    console.log('SIGNED ' + a.out + ' keyId=' + keyId + ' advisories=' + db.advisories.length + ' generatedAt=' + db.generatedAt);
}

function cmdVerify(a) {
    if (!a.in) { process.stderr.write('verify needs --in PKG.json\n'); process.exit(1); }
    const { verifyPackage } = require('../../sudo-ai-extension/src/utils/advisorySig');
    const pkg = JSON.parse(fs.readFileSync(a.in, 'utf8'));
    const r = verifyPackage(pkg, a['pubkey-b64'] ? { publicKeySpkiB64: a['pubkey-b64'] } : undefined);
    console.log((r.ok ? 'VALID: ' : 'INVALID: ') + r.reason);
    process.exit(r.ok ? 0 : 1);
}

async function main(argv) {
    const a = parseArgs(argv);
    const cmd = a._[0];
    if (a.help || !cmd) usage(0);
    if (cmd === 'build') await cmdBuild(a);
    else if (cmd === 'sign') cmdSign(a);
    else if (cmd === 'verify') cmdVerify(a);
    else if (cmd === 'keygen') cmdKeygen(a);
    else { process.stderr.write('unknown command: ' + cmd + '\n'); usage(1); }
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => {
        process.stderr.write('ERROR: ' + (e && e.message ? e.message : e) + '\n');
        process.exit(1);
    });
}

module.exports = { openZip, cvssV3Base, levelFromScore, severityOf, segmentsFromEvents, rangeString, convertRecord, newStats, ECOSYSTEMS };
