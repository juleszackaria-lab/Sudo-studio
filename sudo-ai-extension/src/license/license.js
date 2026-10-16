/**
 * SUDO STUDIO - PROMPT 11: offline signed license core (Ed25519).
 * Extension copy. Mirrors backend/src/license/license.js exactly
 * (same API, same file format, same embedded public key); the two runtimes
 * cannot share a file, so the logic is duplicated and cross-tested.
 * Key format: base64url(payloadJSON).base64url(signature64). No network.
 * ASCII-only.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Product public key (SPKI DER, base64). Fingerprint (sha256 of this string):
// 8dfdd22ff8f8b930b139b3000c2864377f274c5ecd20e9601488450944d6607f
// Issued by license-keygen (packaging repo); the private key is NOT here.
const PRODUCT_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAXbGrEFi6Whz37yivKduewtifwT3m0hzYIjqvT5uyzFA=';

const EDITIONS = {
    community: { label: 'Community', features: ['chat', 'doctor', 'sdk'] },
    team: { label: 'Team', features: ['chat', 'doctor', 'sdk', 'devops', 'environment', 'agent'] },
    enterprise: { label: 'Enterprise', features: ['chat', 'doctor', 'sdk', 'devops', 'environment',
        'agent', 'security', 'duplication', 'central', 'cicd', 'license'] },
};
const EDITION_ORDER = ['community', 'team', 'enterprise'];
const ROLLBACK_SKEW_MS = 5 * 60 * 1000;
const MAX_KEY_LEN = 4096;

function b64uEncode(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
    try {
        if (typeof s !== 'string' || !/^[A-Za-z0-9\-_]*$/.test(s) || s.length % 4 === 1) return null;
        return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch { return null; }
}
function machineId() {
    try { return os.hostname() || 'unknown'; } catch { return 'unknown'; }
}
function licenseDir() {
    const d = path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio');
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* read-only env */ }
    return d;
}
function licensePath() { return path.join(licenseDir(), 'license.json'); }
function sealPath() { return path.join(licenseDir(), 'license-seal.json'); }
function sealKeyPath() { return path.join(licenseDir(), 'license-seal.key'); }
function revokedPath() { return path.join(licenseDir(), 'revoked.json'); }

function readJson(p) {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return { __corrupt: true }; }
}

// -- verification ---------------------------------------------------------------
function verifyLicenseKey(key, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const localMachine = o.machineId || machineId();
    const revokedIds = Array.isArray(o.revokedIds) ? o.revokedIds : readRevokedIds();
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LEN ||
            !/^[A-Za-z0-9\-_.]+$/.test(key)) {
        return { valid: false, reason: 'format de cle invalide' };
    }
    const parts = key.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { valid: false, reason: 'format de cle invalide' };
    }
    const rawPayload = b64uDecode(parts[0]);
    if (!rawPayload) return { valid: false, reason: 'charge illisible (base64)' };
    let p;
    try { p = JSON.parse(rawPayload.toString('utf8')); }
    catch { return { valid: false, reason: 'charge illisible (JSON)' }; }
    if (!p || typeof p !== 'object') return { valid: false, reason: 'charge illisible (JSON)' };
    for (const f of ['licenseId', 'client', 'edition', 'seats', 'issuedAt', 'expiresAt']) {
        if (p[f] === undefined || p[f] === null || p[f] === '') {
            return { valid: false, reason: 'champ manquant ou invalide : ' + f };
        }
    }
    if (typeof p.licenseId !== 'string' || typeof p.client !== 'string') {
        return { valid: false, reason: 'champ manquant ou invalide : licenseId/client' };
    }
    const edition = String(p.edition).toLowerCase();
    if (!EDITIONS[edition]) return { valid: false, reason: 'edition inconnue : ' + p.edition };
    if (!Number.isInteger(p.seats) || p.seats < 1) {
        return { valid: false, reason: 'postes invalides' };
    }
    const issuedMs = Date.parse(p.issuedAt);
    const expMs = Date.parse(p.expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expMs)) {
        return { valid: false, reason: 'dates d\'emission/expiration invalides' };
    }
    if (p.features !== undefined) {
        if (!Array.isArray(p.features)) return { valid: false, reason: 'fonctionnalites invalides' };
        const allowed = EDITIONS[edition].features;
        for (const f of p.features) {
            if (allowed.indexOf(f) === -1) {
                return { valid: false, reason: 'fonctionnalites incoherentes avec l\'edition' };
            }
        }
    }
    const sig = b64uDecode(parts[1]);
    let pub;
    try {
        pub = crypto.createPublicKey({ key: Buffer.from(o.publicKeySpkiB64 || PRODUCT_PUBLIC_KEY_SPKI_B64, 'base64'),
            format: 'der', type: 'spki' });
    } catch { return { valid: false, reason: 'cle publique produit illisible' }; }
    let sigOk = false;
    try {
        sigOk = !!sig && sig.length === 64 &&
            crypto.verify(null, Buffer.from(parts[0], 'utf8'), pub, sig);
    } catch { sigOk = false; }
    if (!sigOk) return { valid: false, reason: 'signature invalide' };
    if (expMs <= now) return { valid: false, reason: 'expiree le ' + p.expiresAt };
    if (issuedMs > now + ROLLBACK_SKEW_MS) return { valid: false, reason: 'emise dans le futur' };
    if (revokedIds.indexOf(p.licenseId) !== -1) return { valid: false, reason: 'revoquee' };
    if (p.machineId !== undefined && p.machineId !== null && p.machineId !== '') {
        if (String(p.machineId) !== String(localMachine)) {
            return { valid: false, reason: 'machine differente (cle liee a ' + p.machineId + ')' };
        }
    }
    return { valid: true, payload: { licenseId: p.licenseId, client: p.client, edition,
        seats: p.seats, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
        features: Array.isArray(p.features) ? p.features.slice() : EDITIONS[edition].features.slice(),
        machineId: p.machineId || null } };
}

// -- revocation ------------------------------------------------------------------
function readRevokedIds() {
    const r = readJson(revokedPath());
    if (!r || r.__corrupt || !Array.isArray(r.revoked)) return [];
    return r.revoked.filter((x) => typeof x === 'string');
}
function importRevocationList(obj) {
    if (!obj || !Array.isArray(obj.revoked)) {
        return { ok: false, reason: 'liste de revocation invalide (attendu {revoked: [...]})' };
    }
    const ids = obj.revoked.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 128);
    if (ids.length !== obj.revoked.length) {
        return { ok: false, reason: 'liste de revocation invalide (identifiants)' };
    }
    const merged = readRevokedIds();
    for (const id of ids) if (merged.indexOf(id) === -1) merged.push(id);
    try {
        fs.writeFileSync(revokedPath(),
            JSON.stringify({ format: 1, revoked: merged, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch { return { ok: false, reason: 'ecriture impossible (permissions)' }; }
    return { ok: true, added: ids.filter((x) => merged.indexOf(x) !== -1).length, total: merged.length };
}

// -- clock seal (tamper-evident last-seen) -----------------------------------------
function readSealKey() {
    try {
        const p = sealKeyPath();
        if (fs.existsSync(p)) {
            const k = fs.readFileSync(p);
            if (k.length >= 16) return k;
        }
        const k = crypto.randomBytes(32);
        fs.writeFileSync(p, k, { mode: 0o600 });
        try { fs.chmodSync(p, 0o600); } catch { /* best effort on win32 */ }
        return k;
    } catch { return null; }
}
function signTs(ts, key) {
    return crypto.createHmac('sha256', key).update('lastSeen:' + ts, 'utf8').digest('hex');
}
function readSeal() {
    const s = readJson(sealPath());
    if (s === null) return null;
    if (s.__corrupt || typeof s.ts !== 'number' || typeof s.sig !== 'string') return { corrupt: true };
    return s;
}
function writeSeal(ts) {
    const key = readSealKey();
    if (!key) return false;
    try {
        fs.writeFileSync(sealPath(), JSON.stringify({ ts, sig: signTs(ts, key) }), 'utf8');
        return true;
    } catch { return false; }
}
function checkSeal(now) {
    const key = readSealKey();
    if (!key) return { ok: false, reason: 'sceau illisible (cle indisponible)' };
    const s = readSeal();
    if (s && s.corrupt) return { ok: false, reason: 'sceau d\'horodatage corrompu' };
    if (s) {
        let expect = null;
        try { expect = signTs(s.ts, key); } catch { expect = null; }
        if (!expect || expect !== s.sig) return { ok: false, reason: 'sceau d\'horodatage corrompu' };
        if (now < s.ts - ROLLBACK_SKEW_MS) {
            return { ok: false, reason: 'recul d\'horloge detecte (derniere date vue : ' +
                new Date(s.ts).toISOString() + ')', rollback: true };
        }
    }
    return { ok: true };
}

// -- stored license ---------------------------------------------------------------
function readStoredLicense() {
    const r = readJson(licensePath());
    if (!r || r.__corrupt) return r;
    return r;
}
function writeStoredLicense(obj) {
    fs.writeFileSync(licensePath(), JSON.stringify(obj, null, 2), 'utf8');
}

function baseStatus(edition) {
    return { state: 'none', edition, editionLabel: EDITIONS[edition].label,
        features: EDITIONS[edition].features.slice(), client: null, licenseId: null,
        seatsMax: 1, seatsAllocated: [], issuedAt: null, expiresAt: null,
        machineId: null, activatedAt: null, reason: null, lastSeen: null,
        revokedCount: readRevokedIds().length };
}

function getStatus(opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const stored = readStoredLicense();
    if (stored === null) {
        const s = baseStatus('community');
        s.reason = 'aucune licence active';
        return s;
    }
    if (stored.__corrupt || typeof stored !== 'object' || typeof stored.key !== 'string') {
        const s = baseStatus('community');
        s.state = 'invalid';
        s.reason = 'etat de licence illisible';
        return s;
    }
    const v = verifyLicenseKey(stored.key, { now, revokedIds: readRevokedIds(),
        publicKeySpkiB64: o.publicKeySpkiB64, machineId: o.machineId });
    if (!v.valid) {
        const s = baseStatus('community');
        s.state = v.reason.indexOf('expiree') === 0 ? 'expired'
            : v.reason === 'revoquee' ? 'revoked'
            : v.reason.indexOf('machine differente') === 0 ? 'machine-mismatch' : 'invalid';
        s.reason = v.reason;
        return s;
    }
    const seal = checkSeal(now);
    if (!seal.ok) {
        const s = baseStatus('community');
        s.state = seal.rollback ? 'rollback' : 'seal-broken';
        s.reason = seal.reason;
        return s;
    }
    writeSeal(now);
    const alloc = stored.seats && Array.isArray(stored.seats.allocated)
        ? stored.seats.allocated.filter((e) => typeof e === 'string').slice(0, v.payload.seats) : [];
    return { state: 'active', edition: v.payload.edition,
        editionLabel: EDITIONS[v.payload.edition].label,
        features: EDITIONS[v.payload.edition].features.slice(),
        client: v.payload.client, licenseId: v.payload.licenseId,
        seatsMax: v.payload.seats, seatsAllocated: alloc,
        issuedAt: v.payload.issuedAt, expiresAt: v.payload.expiresAt,
        machineId: v.payload.machineId || machineId(), activatedAt: stored.activatedAt || null,
        reason: null, lastSeen: new Date(now).toISOString(),
        revokedCount: readRevokedIds().length };
}

function activate(key, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const seal = checkSeal(now);
    if (!seal.ok) return { ok: false, reason: seal.reason };
    const v = verifyLicenseKey(key, { now, revokedIds: readRevokedIds(),
        publicKeySpkiB64: o.publicKeySpkiB64, machineId: o.machineId });
    if (!v.valid) return { ok: false, reason: v.reason };
    const stored = { key, activatedAt: new Date(now).toISOString(),
        seats: { max: v.payload.seats, allocated: [] } };
    try { writeStoredLicense(stored); }
    catch { return { ok: false, reason: 'ecriture impossible (permissions)' }; }
    const back = readStoredLicense();
    if (!back || back.key !== key) return { ok: false, reason: 'relecture differente' };
    writeSeal(now);
    return { ok: true, status: getStatus(o) };
}

function deactivate() {
    try {
        const p = licensePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: !fs.existsSync(p) };
    } catch { return { ok: false }; }
}

// -- editions ----------------------------------------------------------------------
function minEditionFor(feature) {
    for (const e of EDITION_ORDER) {
        if (EDITIONS[e].features.indexOf(feature) !== -1) return e;
    }
    return null;
}
function hasFeature(feature, status) {
    const st = status || getStatus();
    if (st.state !== 'active') {
        return EDITIONS.community.features.indexOf(feature) !== -1;
    }
    return st.features.indexOf(feature) !== -1;
}
function guardFeature(feature, status) {
    const need = minEditionFor(feature);
    if (!need) {
        return { allowed: false, feature, edition: 'community', need: null,
            message: 'Fonctionnalite inconnue : ' + feature };
    }
    if (hasFeature(feature, status)) {
        const st = status || getStatus();
        return { allowed: true, feature, edition: st.edition, need, message: null };
    }
    const st = status || getStatus();
    return { allowed: false, feature, edition: st.edition, need,
        message: 'N\u00e9cessite l\'\u00e9dition ' + EDITIONS[need].label };
}

module.exports = {
    PRODUCT_PUBLIC_KEY_SPKI_B64, EDITIONS, EDITION_ORDER, ROLLBACK_SKEW_MS,
    b64uEncode, b64uDecode, machineId, licenseDir,
    verifyLicenseKey, readRevokedIds, importRevocationList,
    readSeal, writeSeal, checkSeal,
    readStoredLicense, writeStoredLicense,
    getStatus, activate, deactivate,
    minEditionFor, hasFeature, guardFeature,
};
