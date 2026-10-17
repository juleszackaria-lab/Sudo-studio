/**
 * SUDO STUDIO - PROMPT 10: real security scoring (deterministic, offline).
 * Pure computation + local filesystem reads. No network, no AI, no default
 * reassuring number: without a usable advisory base the score is null and
 * the status explains why. Formula documented in SECURITY_SCORING.md.
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { STALE_DAYS } = require('./localAudit');

const SCORE_VERSION = 1;
const BASE_SCORE = 100;

// Points per secret severity (labels must match utils/secretPatterns.js).
const SECRET_POINTS = { critical: 15, high: 8, medium: 4, low: 1 };
const SECRET_SEVERITY = {
    'Private Key (PEM)': 'critical',
    'AWS Access Key': 'high',
    'AWS Secret Key': 'high',
    'Generic API Key': 'high',
    'Generic API Key (unquoted)': 'high',
    'GitHub Token': 'high',
    'Bearer Token': 'high',
    'Stripe Key': 'high',
    'Google API Key': 'high',
    'Slack Token': 'high',
    'PyPI Token': 'high',
    'NPM Token': 'high',
    'Database Password': 'medium',
    'Slack Webhook': 'medium',
    'Secret Assignment': 'high',
    'Generic Secret Key (sk-)': 'high',
    'JWT Token': 'high',
    'URL with Credentials': 'high',
    'High-Entropy String': 'medium',
};
// Points per advisory severity (unknown counts as medium, documented).
const ADVISORY_POINTS = { critical: 10, high: 5, medium: 2, low: 1 };
// Category caps: subtracted points never exceed these per category.
const CAPS = { secrets: 40, advisories: 30, files: 15, tests: 5 };

// Placeholder values that are NOT secrets (exact match, case-insensitive).
const PLACEHOLDERS = new Set([
    'your_key_here', 'your_api_key', 'yourkeyhere', 'your_secret_here',
    'your_token_here', 'changeme', 'change_me', 'changeit', 'placeholder',
    'example', 'sample', 'test', 'testing', 'none', 'null', 'undefined',
    'tbd', 'todo', 'xxx',
]);

// Extra scanner patterns, kept OUT of shared secretPatterns.js so the cloud
// pre-send filter behaviour is unchanged. Shape: { label, re, check }.
const EXTRA_SECRET_PATTERNS = [
    {
        label: 'Generic API Key (unquoted)',
        // Unquoted assignments only: the lookahead rejects quoted values so
        // the shared quoted pattern stays the single hit there (no dupes).
        re: /\b(api[_-]?key|api[_-]?secret|auth[_-]?token|secret[_-]?key|access[_-]?key)\s*[:=]+\s*(?!['"])([A-Za-z0-9_\-]{8,})/i,
        valueGroup: 2,
        check(m) {
            const v = String((m && m[2]) || '');
            if (v.length < 8) return false;
            if (PLACEHOLDERS.has(v.toLowerCase())) return false;
            return true;
        },
    },
    {
        label: 'Secret Assignment',
        // P18: NAME=value where NAME carries a secret word (JWT_SECRET,
        // PASSWORD, CLIENT_SECRET, DB_TOKEN, apiKey, ...). The name is split
        // into segments so MONKEY/keyboard never match. Optional quotes.
        re: /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]+\s*['"]?([^\s'";#]{8,})['"]?/,
        valueGroup: 2,
        check(m) {
            const name = String((m && m[1]) || '');
            const v = String((m && m[2]) || '').replace(/['",;]+$/, '');
            if (v.length < 8) return false;
            if (!looksLikeSecretName(name)) return false;
            if (PLACEHOLDERS.has(v.toLowerCase())) return false;
            if (/^(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\[[^\]]*\]|%[^%]+%|true|false|null|none|undefined)$/i.test(v)) return false;
            if (/^[A-Za-z]:\\/.test(v) || v.indexOf('\\\\') !== -1) return false;
            return true;
        },
    },
    {
        label: 'Generic Secret Key (sk-)',
        // P18: sk- prefixed keys outside assignments (sk_live_..., sk-test...).
        re: /\bsk-[A-Za-z0-9_\-]{6,}/,
        check(m) {
            const v = String((m && m[0]) || '');
            if (v.length < 10) return false;
            if (PLACEHOLDERS.has(v.toLowerCase())) return false;
            return true;
        },
    },
    {
        label: 'JWT Token',
        // P18: raw JSON Web Token (header always starts with eyJ).
        re: /\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}/,
    },
    {
        label: 'URL with Credentials',
        // P18: scheme://user:pass@host (postgres, mysql, ftp, ...). Only the
        // user:pass part is the secret (valueGroup), host stays visible.
        re: /([A-Za-z][A-Za-z0-9+.\-]{1,20}:\/\/)([^/\s:@?#'\"]+:[^/\s@?#'\"]+)(@[^\s'\"]+)/,
        valueGroup: 2,
    },
];

// P18: secret-ish words matched against whole name segments (split on _ -
// and camelCase humps). 'JWT_SECRET' hits via 'secret'; 'MONKEY' is one
// segment and never hits.
const SECRET_NAME_WORDS = new Set(['secret', 'secrets', 'token', 'tokens',
    'password', 'passwd', 'pwd', 'pass', 'key', 'keys', 'apikey', 'authkey',
    'accesstoken', 'refreshtoken', 'clientsecret', 'apisecret', 'secretkey',
    'authtoken', 'sessionsecret', 'privatekey']);

function looksLikeSecretName(name) {
    const parts = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase().split(/[^a-z0-9]+/);
    for (const p of parts) if (SECRET_NAME_WORDS.has(p)) return true;
    return false;
}

// P18: Shannon entropy per character (bits). Random base64-ish text scores
// near 6; English prose and identifiers stay well below the bar.
function shannonEntropy(s) {
    const str = String(s || '');
    if (!str) return 0;
    const freq = Object.create(null);
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    let h = 0;
    for (const k in freq) {
        const p = freq[k] / str.length;
        h -= p * (Math.log(p) / Math.log(2));
    }
    return h;
}

// A token earns the entropy test only with digit/symbol/mixed-case variety,
// which rules out plain long words and most identifiers.
function looksRandomToken(tok) {
    return /[0-9]/.test(tok) || /[+=\-_]/.test(tok) ||
        (/[A-Z]/.test(tok) && /[a-z]/.test(tok));
}

const ENTROPY_B64_MIN = 20;
const ENTROPY_B64_BAR = 4.5;
const ENTROPY_HEX_MIN = 32;
const ENTROPY_HEX_BAR = 3.0;

// First high-entropy token on the line, or null. Hex first: a hex token
// also matches the base64 class, and hex tops out near 4 bits per char.
function findHighEntropyToken(line) {
    const text = String(line || '');
    let m;
    const hexRe = /[0-9a-fA-F]{32,}/g;
    while ((m = hexRe.exec(text)) !== null) {
        if (shannonEntropy(m[0]) >= ENTROPY_HEX_BAR) return m[0];
    }
    const b64Re = /[A-Za-z0-9+=\-_]{20,}/g;
    while ((m = b64Re.exec(text)) !== null) {
        if (looksRandomToken(m[0]) && shannonEntropy(m[0]) >= ENTROPY_B64_BAR) return m[0];
    }
    return null;
}

function gitignoreGlobToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; }
            else re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if ('.+^${}()|[]\\'.indexOf(c) !== -1) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    return new RegExp('^' + re + '$');
}

// P18: minimal .gitignore matcher (exact names, *, ?, **, trailing-slash
// dirs, leading slash, # comments, ! negation, last match wins). Patterns
// without a slash match the basename at any depth, like git.
function isIgnoredByGitignore(relPath, gitignoreText) {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const text = String(gitignoreText || '');
    if (!rel || !text) return false;
    const parts = rel.split('/');
    const cands = [rel];
    for (let i = 1; i < parts.length; i++) cands.push(parts.slice(0, i).join('/'));
    const base = parts[parts.length - 1];
    let ignored = false;
    for (const raw of text.split('\n')) {
        let line = raw.trim();
        if (!line || line.charAt(0) === '#') continue;
        let neg = false;
        if (line.charAt(0) === '!') {
            neg = true;
            line = line.slice(1).trim();
            if (!line) continue;
        }
        const dirOnly = line.charAt(line.length - 1) === '/';
        if (dirOnly) line = line.slice(0, -1);
        if (line.charAt(0) === '/') line = line.slice(1);
        if (!line) continue;
        const rx = gitignoreGlobToRegExp(line);
        let hit = false;
        if (line.indexOf('/') === -1) {
            if (!dirOnly && rx.test(base)) hit = true;
            if (!hit) {
                for (const c of cands) {
                    if (c === rel) continue;
                    if (rx.test(c.split('/').pop())) { hit = true; break; }
                }
            }
        } else {
            for (const c of cands) {
                if (c === rel && dirOnly) continue;
                if (rx.test(c)) { hit = true; break; }
            }
        }
        if (hit) ignored = !neg;
    }
    return ignored;
}

function severityOfSecret(label) {
    return SECRET_SEVERITY[label] || 'medium';
}

function secretPoints(severity) {
    return SECRET_POINTS[severity] || SECRET_POINTS.medium;
}

function advisoryPoints(severity) {
    const s = String(severity || '').toLowerCase();
    if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return ADVISORY_POINTS[s];
    return ADVISORY_POINTS.medium;
}

function existsSync(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

function readCapped(p, maxBytes) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > maxBytes) return null;
        return fs.readFileSync(p, 'utf8');
    } catch { return null; }
}

function requirementsUnpinned(file) {
    const text = readCapped(file, 512 * 1024);
    if (text === null) return true; // unreadable: cannot prove pinned
    for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        if (!line || line[0] === '-') continue;
        if (line.indexOf('==') === -1) return true; // a bare/loose requirement
    }
    return false;
}

// P10: missing security files. Returns plain facts (no points here).
function checkSecurityFiles(wsRoot) {
    const out = { noGitignore: false, unignoredProdEnv: [], unlocked: [] };
    if (!wsRoot) return out;
    const giText = readCapped(path.join(wsRoot, '.gitignore'), 256 * 1024);
    if (giText === null) out.noGitignore = true;
    const giLines = (giText || '').split('\n').map((l) => l.trim())
        .filter((l) => l && l[0] !== '#');
    const covered = (name) => giLines.indexOf(name) !== -1 || giLines.indexOf('.env*') !== -1;
    for (const name of ['.env.production', '.env.prod', '.env']) {
        if (existsSync(path.join(wsRoot, name)) && !covered(name)) out.unignoredProdEnv.push(name);
    }
    const has = (n) => existsSync(path.join(wsRoot, n));
    if (has('package.json') && !has('package-lock.json') && !has('yarn.lock') && !has('pnpm-lock.yaml')) {
        out.unlocked.push({ ecosystem: 'node', manifest: 'package.json' });
    }
    if (has('requirements.txt') && !has('poetry.lock') && !has('Pipfile.lock') &&
            requirementsUnpinned(path.join(wsRoot, 'requirements.txt'))) {
        out.unlocked.push({ ecosystem: 'python', manifest: 'requirements.txt' });
    }
    if (has('pubspec.yaml') && !has('pubspec.lock')) {
        out.unlocked.push({ ecosystem: 'flutter', manifest: 'pubspec.yaml' });
    }
    if (has('go.mod') && !has('go.sum')) {
        out.unlocked.push({ ecosystem: 'go', manifest: 'go.mod' });
    }
    try {
        const csproj = fs.readdirSync(wsRoot).some((e) => /\.csproj$/i.test(e));
        if (csproj && !has('packages.lock.json')) {
            out.unlocked.push({ ecosystem: 'csharp', manifest: '*.csproj' });
        }
    } catch { /* unreadable root: skip csharp check */ }
    return out;
}

// True when the project shows any sign of tests.
function hasTests(wsRoot) {
    if (!wsRoot) return false;
    for (const d of ['test', 'tests', '__tests__', 'spec', 'specs']) {
        try {
            if (fs.statSync(path.join(wsRoot, d)).isDirectory()) return true;
        } catch { /* absent */ }
    }
    try {
        const pkg = JSON.parse(readCapped(path.join(wsRoot, 'package.json'), 512 * 1024) || '{}');
        if (pkg && pkg.scripts && pkg.scripts.test) return true;
    } catch { /* no/invalid package.json */ }
    try {
        const entries = fs.readdirSync(wsRoot).slice(0, 500);
        for (const e of entries) {
            if (/(^|[._-])(tests?|spec)([._-]|$)|_test\./i.test(e)) {
                try {
                    if (fs.statSync(path.join(wsRoot, e)).isFile()) return true;
                } catch { /* raced deletion */ }
            }
        }
    } catch { /* unreadable root */ }
    return false;
}

// Best-effort 1-based line of a locked dep inside its lockfile (citations).
function locateDepLine(wsRoot, source, name, version) {
    if (!wsRoot || !source || !name) return null;
    const text = readCapped(path.join(wsRoot, path.basename(source)), 4 * 1024 * 1024);
    if (text === null) return null;
    const lines = text.split('\n');
    let nameOnly = null;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(name) === -1) continue;
        if (version && lines[i].indexOf(version) !== -1) return i + 1;
        if (nameOnly === null) nameOnly = i + 1;
    }
    return nameOnly;
}

// Greedy cap: biggest penalties first, each fully applied or listed as capped.
function applyCap(list, cap) {
    const sorted = list.slice().sort((a, b) => b.points - a.points);
    let used = 0;
    for (const p of sorted) {
        if (used + p.points <= cap) { p.applied = true; used += p.points; }
        else { p.applied = false; }
    }
    return { penalties: sorted, applied: used };
}

function unavailable(reason) {
    return {
        version: SCORE_VERSION, status: 'unavailable', score: null, reason,
        penalties: [], appliedByCat: { secrets: 0, advisories: 0, files: 0, tests: 0 },
        caps: { secrets: CAPS.secrets, advisories: CAPS.advisories, files: CAPS.files, tests: CAPS.tests },
        computedAt: new Date().toISOString(), dbDate: null, dbSource: null,
    };
}

function computeSecurityScore(input) {
    const inp = input || {};
    if (!inp.db) return unavailable('base d\'avis introuvable ou inutilisable (importez une base via le panneau)');
    const secrets = Array.isArray(inp.secrets) ? inp.secrets : [];
    const advisories = Array.isArray(inp.advisories) ? inp.advisories : [];
    const files = inp.files || { noGitignore: false, unignoredProdEnv: [], unlocked: [] };

    const secList = secrets.map((s) => {
        const sev = s.severity || severityOfSecret(s.label);
        return { points: secretPoints(sev), category: 'Secret',
            detail: (s.label || 'secret') + ' (' + sev + ')',
            file: s.file || null, line: s.line || null };
    });
    const advList = advisories.map((m) => {
        const sev = String(m.severity || 'unknown').toLowerCase();
        return { points: advisoryPoints(sev), category: 'Dependance',
            detail: (m.package || '?') + '@' + (m.version || '?') + ' ' + (m.cve || 'n/a') +
                ' (' + sev + ', corrige: ' + (m.fixedIn || 'n/a') + ')',
            file: m.source || null, line: m.line || null };
    });
    const fileList = [];
    for (const name of files.unignoredProdEnv || []) {
        fileList.push({ points: 10, category: 'Fichier',
            detail: name + ' present et non ignore (risque de fuite)', file: name, line: null });
    }
    for (const u of files.unlocked || []) {
        fileList.push({ points: 5, category: 'Fichier',
            detail: 'dependances non verrouillees (' + u.ecosystem + ': ' + u.manifest + ' sans lockfile)',
            file: u.manifest, line: null });
    }
    if (files.noGitignore) {
        fileList.push({ points: 5, category: 'Fichier',
            detail: 'pas de .gitignore (aucune protection)', file: null, line: null });
    }
    const testList = inp.hasTests ? []
        : [{ points: 5, category: 'Tests', detail: 'aucun test detecte', file: null, line: null }];

    const sec = applyCap(secList, CAPS.secrets);
    const adv = applyCap(advList, CAPS.advisories);
    const fil = applyCap(fileList, CAPS.files);
    const tst = applyCap(testList, CAPS.tests);
    const total = sec.applied + adv.applied + fil.applied + tst.applied;
    const stale = !!inp.db.stale;
    return {
        version: SCORE_VERSION,
        status: stale ? 'partial' : 'ok',
        score: Math.max(0, BASE_SCORE - total),
        reason: stale
            ? ('base d\'avis trop ancienne (du ' + (inp.db.date || '?') + ', limite ' + STALE_DAYS + ' jours)')
            : null,
        penalties: sec.penalties.concat(adv.penalties, fil.penalties, tst.penalties),
        appliedByCat: { secrets: sec.applied, advisories: adv.applied, files: fil.applied, tests: tst.applied },
        caps: { secrets: CAPS.secrets, advisories: CAPS.advisories, files: CAPS.files, tests: CAPS.tests },
        computedAt: new Date().toISOString(),
        dbDate: inp.db.date || null, dbSource: inp.db.source || null,
    };
}

function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Standalone HTML report (inline CSS, no external resource).
function buildReportHtml(report) {
    const r = report || {};
    const sr = r.scoreResult || {};
    const pens = Array.isArray(sr.penalties) ? sr.penalties : [];
    let rows = '';
    for (const p of pens) {
        const where = p.file ? escHtml(p.file) + (p.line ? ':' + p.line : '') : '-';
        const pts = p.applied ? '-' + p.points : '-' + p.points + ' (plafond atteint)';
        rows += '<tr><td>' + pts + '</td><td>' + escHtml(p.category) + '</td><td>' +
            escHtml(p.detail) + '</td><td>' + where + '</td></tr>';
    }
    if (!rows) rows = '<tr><td colspan="4">Aucune penalite.</td></tr>';
    const scoreTxt = sr.score === null || sr.score === undefined ? 'N/A' : String(sr.score);
    const statusTxt = sr.status === 'ok' ? 'Score calcule'
        : sr.status === 'partial' ? 'Score partiel : ' + (sr.reason || '')
            : 'Score non calculable : ' + (sr.reason || '');
    const caps = sr.caps || CAPS;
    return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n' +
        '<title>Rapport de securite Sudo Studio</title>\n' +
        '<style>body{font-family:sans-serif;margin:24px;color:#111;}' +
        'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #999;padding:6px 8px;text-align:left;font-size:13px;}' +
        'th{background:#eee;}.score{font-size:34px;font-weight:bold;}.meta{color:#555;font-size:12px;}</style>\n' +
        '</head>\n<body>\n' +
        '<h1>Rapport de securite</h1>\n' +
        '<p class="meta">Projet : ' + escHtml(r.wsRoot || '(aucun)') + '<br>Calcule le : ' +
        escHtml(sr.computedAt || r.timestamp || '') + '<br>Base d\'avis : ' +
        escHtml(sr.dbDate || 'absente') + ' (' + escHtml(sr.dbSource || '-') + ')</p>\n' +
        '<p class="score">' + scoreTxt + ' / 100</p>\n' +
        '<p><strong>' + escHtml(statusTxt) + '</strong></p>\n' +
        '<h2>Pourquoi ce score</h2>\n' +
        '<table>\n<tr><th>Points</th><th>Categorie</th><th>Constat</th><th>Fichier</th></tr>\n' +
        rows + '</table>\n' +
        '<p class="meta">Plafonds : secrets ' + caps.secrets + ', dependances ' + caps.advisories +
        ', fichiers ' + caps.files + ', tests ' + caps.tests + '. Formule : SECURITY_SCORING.md.</p>\n' +
        '</body>\n</html>\n';
}

module.exports = {
    SCORE_VERSION, BASE_SCORE, CAPS, SECRET_POINTS, SECRET_SEVERITY, ADVISORY_POINTS,
    EXTRA_SECRET_PATTERNS, PLACEHOLDERS,
    looksLikeSecretName, shannonEntropy, findHighEntropyToken, isIgnoredByGitignore,
    severityOfSecret, secretPoints, advisoryPoints,
    checkSecurityFiles, hasTests, locateDepLine,
    applyCap, unavailable, computeSecurityScore,
    escHtml, buildReportHtml,
};
