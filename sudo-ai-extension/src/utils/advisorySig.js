/**
 * SUDO STUDIO - Signed advisory packages (MISSION P23).
 * Offline "Importer une base d'avis" packages are Ed25519-signed with a
 * DEDICATED keypair (distinct from the license keys). This module holds the
 * PUBLIC half and verifies packages. The private half lives only with the
 * maintainer (CLI: backend/tools/build-advisory-db.js keygen|sign).
 *
 * Signed bytes: canonical JSON (sorted keys, no whitespace) of the package
 * with the top-level "signature" field removed.
 * Import policy: well-formed + valid signature + generatedAt strictly newer
 * than the current effective DB. Anything else is refused (never imported).
 */
'use strict';

const crypto = require('crypto');

// Dedicated advisory public key (Ed25519, SPKI DER base64). Set by the
// maintainer's keygen; placeholder until the first real key is embedded.
const ADVISORY_KEY_ID = 'sudo-advisory-1';
const ADVISORY_PUBLIC_KEY_SPKI_B64 = 'PENDING-MAINTAINER-KEYGEN';

const SIG_ALG = 'ed25519';

function stableStringify(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) =>
            JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
}

// Bytes covered by the signature: everything except top-level "signature".
function canonicalPayload(pkg) {
    const copy = Object.assign({}, pkg);
    delete copy.signature;
    return Buffer.from(stableStringify(copy), 'utf8');
}

function parseDateOnly(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
    return Number.isFinite(t) ? t : null;
}

// Static shape check (no crypto): { generatedAt, advisories[] }.
function shapeOk(pkg) {
    return !!(pkg && typeof pkg === 'object' && !Array.isArray(pkg)) &&
        typeof pkg.generatedAt === 'string' && parseDateOnly(pkg.generatedAt) !== null &&
        Array.isArray(pkg.advisories);
}

// Verify the package signature. Returns { ok, reason } (never throws).
// opts.publicKeySpkiB64 overrides the embedded key (tests / rotation).
function verifyPackage(pkg, opts) {
    const o = opts || {};
    if (!shapeOk(pkg)) return { ok: false, reason: 'paquet mal forme (generatedAt/advisories[] requis)' };
    const sig = pkg.signature;
    if (!sig || typeof sig !== 'object') return { ok: false, reason: 'paquet non signe (signature absente)' };
    if (sig.alg !== SIG_ALG) return { ok: false, reason: 'algorithme de signature inconnu: ' + String(sig.alg) };
    if (typeof sig.sig !== 'string' || !sig.sig) return { ok: false, reason: 'signature vide' };
    const keyB64 = o.publicKeySpkiB64 || ADVISORY_PUBLIC_KEY_SPKI_B64;
    let pub;
    try {
        pub = crypto.createPublicKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'spki' });
    } catch {
        return { ok: false, reason: 'cle publique d\'avis invalide (non configuree ?)' };
    }
    let raw;
    try { raw = Buffer.from(sig.sig, 'base64'); } catch { return { ok: false, reason: 'signature illisible (base64)' }; }
    if (raw.length !== 64) return { ok: false, reason: 'signature de longueur invalide' };
    let valid = false;
    try { valid = crypto.verify(null, canonicalPayload(pkg), pub, raw); } catch { valid = false; }
    if (!valid) return { ok: false, reason: 'signature invalide (paquet altere ou mauvaise cle)' };
    return { ok: true, reason: 'signature valide' };
}

// Full import policy vs the current effective DB (may be null).
// current: { generatedAt } | null. opts forwarded to verifyPackage
// (tests / key rotation). Returns { ok, reason }.
function assertImportable(pkg, current, opts) {
    const v = verifyPackage(pkg, opts);
    if (!v.ok) return v;
    const next = parseDateOnly(pkg.generatedAt);
    const cur = current ? parseDateOnly(current.generatedAt) : null;
    if (cur !== null && next <= cur) {
        return { ok: false, reason: 'paquet plus ancien (' + pkg.generatedAt +
            ') que la base actuelle (' + current.generatedAt + ')' };
    }
    return { ok: true, reason: 'paquet accepte (' + pkg.advisories.length + ' avis, ' + pkg.generatedAt + ')' };
}

module.exports = {
    ADVISORY_KEY_ID, ADVISORY_PUBLIC_KEY_SPKI_B64, SIG_ALG,
    stableStringify, canonicalPayload, parseDateOnly, shapeOk,
    verifyPackage, assertImportable,
};
