/**
 * SUDO STUDIO - P36(c) functional test: License (on INSTALLED files).
 *
 * Uses the INSTALLED extension license module (EXT_DIR/src/license/license.js)
 * with a FRESH Ed25519 test pair generated per run (tmp only, never persisted,
 * never printed). The installed verifier accepts a public-key override
 * (opts.publicKeySpkiB64), so the whole issue/verify cycle is exercised
 * WITHOUT any production secret.
 *
 * Asserts:
 *  1. valid Team key ACCEPTED, valid Enterprise key ACCEPTED
 *  2. expired key REFUSED, tampered key REFUSED, invented key REFUSED
 *  3. Team and Enterprise editions APPLIED (feature gating differs from Community)
 *  4. NOTHING secret-looking is printed (no key material on stdout)
 *
 * Usage: node test-license.js [--ext <dir>]
 * Exit: 0 = all PASS, 1 = any FAIL. Prints one JSON report on stdout.
 * ASCII-only.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}
const EXT_DIR = argVal('--ext', process.env.P36_EXT_DIR ||
    path.join(__dirname, '..', '..', 'sudo-ai-extension'));

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail: detail || '' });
}

// -- fresh test-only issuer (mirrors the keygen format, test pair only) ------
function b64u(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const kp = crypto.generateKeyPairSync('ed25519');
const TEST_PUB_SPKI_B64 = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
function issue(payload) {
    const seg = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), kp.privateKey);
    return seg + '.' + b64u(sig);
}
function payloadFor(edition, expiresAt) {
    return {
        licenseId: 'TEST-' + edition.toUpperCase() + '-001',
        client: 'p36-test-client',
        edition,
        seats: 5,
        issuedAt: new Date(Date.now() - 86400000).toISOString(),
        expiresAt: expiresAt || new Date(Date.now() + 30 * 86400000).toISOString(),
    };
}

let lic;
try {
    lic = require(path.join(EXT_DIR, 'src', 'license', 'license.js'));
    check('license-module-loads', true, 'from installed files');
} catch (e) {
    check('license-module-loads', false, String((e && e.message) || e).slice(0, 200));
    console.log(JSON.stringify({ suite: 'p36-license', extDir: EXT_DIR, checks }, null, 2));
    process.exit(1);
}
const V = (key, now) => lic.verifyLicenseKey(key, { publicKeySpkiB64: TEST_PUB_SPKI_B64, now });

// 1. valid keys accepted
const team = issue(payloadFor('team'));
const ent = issue(payloadFor('enterprise'));
const vTeam = V(team);
const vEnt = V(ent);
check('valid-team-accepted', vTeam.valid === true && vTeam.payload.edition === 'team',
    vTeam.valid ? 'edition=team' : ('refused: ' + vTeam.reason));
check('valid-enterprise-accepted', vEnt.valid === true && vEnt.payload.edition === 'enterprise',
    vEnt.valid ? 'edition=enterprise' : ('refused: ' + vEnt.reason));

// 2a. expired refused (signed yesterday-expiring key, verified at fixed now)
const expired = issue(payloadFor('team', new Date(Date.now() - 3600000).toISOString()));
const vExp = V(expired);
check('expired-refused', vExp.valid === false && /expir/i.test(vExp.reason || ''),
    vExp.valid ? 'WRONGLY ACCEPTED' : ('refused: ' + vExp.reason));

// 2b. tampered refused (flip one char in the payload segment, keep format valid)
const tparts = team.split('.');
const tampered = tparts[0].slice(0, 10) +
    (tparts[0][10] === 'A' ? 'B' : 'A') + tparts[0].slice(11) + '.' + tparts[1];
const vTam = V(tampered);
check('tampered-refused', vTam.valid === false,
    vTam.valid ? 'WRONGLY ACCEPTED' : ('refused: ' + vTam.reason));

// 2c. invented refused (format-valid random body + random 64-byte signature)
const invented = b64u(Buffer.from(JSON.stringify(payloadFor('enterprise')), 'utf8')) +
    '.' + b64u(crypto.randomBytes(64));
const vInv = V(invented);
check('invented-refused', vInv.valid === false && /signature/i.test(vInv.reason || ''),
    vInv.valid ? 'WRONGLY ACCEPTED' : ('refused: ' + vInv.reason));

// 2d. garbage refused (bad format)
const vGar = V('not-a-key!!');
check('garbage-refused', vGar.valid === false,
    vGar.valid ? 'WRONGLY ACCEPTED' : ('refused: ' + vGar.reason));

// 3. Team / Enterprise applied: feature gating differs from Community.
// Statuses are DERIVED from the verified payloads above (key -> verify -> gating).
let featDetail = '';
let featOk = false;
try {
    const st = (v) => ({ state: 'active', edition: v.payload.edition, features: v.payload.features });
    const teamStatus = st(vTeam);
    const entStatus = st(vEnt);
    const commStatus = { state: 'none' }; // no license = community features
    const rows = [
        'community=' + ['doctor', 'agent', 'security'].map((f) => (lic.hasFeature(f, commStatus) ? '1' : '0')).join(''),
        'team=' + ['doctor', 'agent', 'security'].map((f) => (lic.hasFeature(f, teamStatus) ? '1' : '0')).join(''),
        'enterprise=' + ['doctor', 'agent', 'security'].map((f) => (lic.hasFeature(f, entStatus) ? '1' : '0')).join(''),
    ].join(' ');
    const g = lic.guardFeature('agent', commStatus);
    featOk = lic.hasFeature('doctor', commStatus) === true &&      // control: free feature
        lic.hasFeature('agent', commStatus) === false &&
        lic.hasFeature('agent', teamStatus) === true &&            // Team unlocks agent
        lic.hasFeature('security', teamStatus) === false &&
        lic.hasFeature('security', entStatus) === true &&          // Enterprise unlocks security
        g.allowed === false && g.need === 'team';                  // honest upgrade path
    featDetail = rows + ' guard(agent@community)=' + (g.allowed ? 'allowed?' : ('refused,need=' + g.need));
} catch (e) {
    featDetail = 'hasFeature error: ' + String((e && e.message) || e).slice(0, 120);
}
check('team-enterprise-applied', featOk, featDetail);

// 4. no secret material on stdout: scan our own report for key patterns
const report = JSON.stringify({ suite: 'p36-license', extDir: EXT_DIR, checks });
const leak = /sk-.{8}|BEGIN .{0,20}PRIVATE|eyJ[A-Za-z0-9_-]{10}|[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/.test(report);
check('no-secret-on-stdout', !leak, leak ? 'LEAK DETECTED' : 'report holds verdicts only');

console.log(JSON.stringify({ suite: 'p36-license', extDir: EXT_DIR, checks }, null, 2));
process.exit(checks.some((c) => c.verdict === 'FAIL') ? 1 : 0);
