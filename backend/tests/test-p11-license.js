/**
 * SUDO STUDIO - PROMPT 11 suite: offline signed licenses (Ed25519).
 * A: crypto/format | B: activation/storage | C: revocation | D: clock seal |
 * E: editions | F: backend middleware | G: extension-core parity |
 * H: panel protocol | I: keygen CLI (guarded) | J: absence proofs | K: misc.
 * Ephemeral keypairs only (in-memory, never committed). Hermetic homes.
 * ASCII-only. No hard key literals in this file (see J).
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const HOME1 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-h1-'));
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-h2-'));
const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-h3-'));
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-fx-'));
process.env.SUDO_STUDIO_HOME = HOME1;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// -- ephemeral product-substitute keypair (in-memory only) ----------------------
const EPH = crypto.generateKeyPairSync('ed25519');
const EPH_PUB = EPH.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const OTHER = crypto.generateKeyPairSync('ed25519');
function b64u(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uJson(obj) { return b64u(Buffer.from(JSON.stringify(obj), 'utf8')); }
function issue(payload, priv) {
    const p1 = b64uJson(payload);
    return p1 + '.' + b64u(crypto.sign(null, Buffer.from(p1, 'utf8'), priv || EPH.privateKey));
}
const TEAM_FEATS = ['chat', 'doctor', 'sdk', 'devops', 'environment', 'agent'];
function mkPayload(over) {
    return Object.assign({ licenseId: 'LIC-T-1', client: 'TestCo', edition: 'team',
        seats: 10, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
        features: TEAM_FEATS.slice() }, over || {});
}
const OPTS = { publicKeySpkiB64: EPH_PUB };

// -- modules ---------------------------------------------------------------------
const lic = require('../src/license/license');
const licXPath = require.resolve('../../sudo-ai-extension/src/license/license');
const licX = require(licXPath);
// Facade: the panel verifies with the ephemeral key (crypto itself is tested
// separately on the real paths in A; only the module boundary is substituted).
require.cache[licXPath].exports = Object.assign({}, licX, {
    verifyLicenseKey: (k, o) => licX.verifyLicenseKey(k, Object.assign({}, o, OPTS)),
    activate: (k, o) => licX.activate(k, Object.assign({}, o, OPTS)),
    getStatus: (o) => licX.getStatus(Object.assign({}, o, OPTS)),
});
const { requireFeature } = require('../middleware/license.middleware');
const vscodeMock = { workspace: { workspaceFolders: [] }, window: {},
    ViewColumn: { One: 1 }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } };
const shown = { info: [], warn: [], err: [] };
vscodeMock.window.showInformationMessage = (m) => shown.info.push(m);
vscodeMock.window.showWarningMessage = (m) => shown.warn.push(m);
vscodeMock.window.showErrorMessage = (m) => shown.err.push(m);
vscodeMock.window.showSaveDialog = async () => null;
vscodeMock.window.showOpenDialog = async () => null;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeMock;
    return origLoad.call(this, req, parent, isMain);
};
const { LicensePanel } = require('../../sudo-ai-extension/src/panels/LicensePanel');
const { getAuditLog } = require('../../sudo-ai-extension/src/utils/auditLog');

function licFile(home) { return path.join(home, '.sudo_studio', 'license.json'); }
function snap(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

async function main() {
    // -- A: crypto + format (backend core, ephemeral key) -------------------------
    const teamKey = issue(mkPayload());
    const a1 = lic.verifyLicenseKey(teamKey, OPTS);
    check('A1: well-formed issued key verifies with payload',
        a1.valid === true && a1.payload.edition === 'team' && a1.payload.seats === 10);
    const invented = b64uJson(mkPayload({ licenseId: 'LIC-FAKE' })) + '.' + b64u(crypto.randomBytes(64));
    const a2 = lic.verifyLicenseKey(invented, OPTS);
    check('A2: invented well-formed key is REFUSED (bad signature)',
        a2.valid === false && a2.reason === 'signature invalide');
    const tamPay = mkPayload({ licenseId: 'LIC-TAMPER', edition: 'enterprise' });
    const tampered = b64uJson(tamPay) + '.' + teamKey.split('.')[1];
    const a3 = lic.verifyLicenseKey(tampered, OPTS);
    check('A3: payload with swapped edition is REFUSED (bad signature)',
        a3.valid === false && a3.reason === 'signature invalide', a3.reason);
    const a4 = lic.verifyLicenseKey(issue(mkPayload({ licenseId: 'LIC-OT' }), OTHER.privateKey), OPTS);
    check('A4: key from another keypair is REFUSED', a4.valid === false);
    check('A5: garbage format refused', lic.verifyLicenseKey('no-dots-here', OPTS).valid === false &&
        lic.verifyLicenseKey('no-dots-here', OPTS).reason === 'format de cle invalide');
    check('A6: non-JSON payload refused',
        lic.verifyLicenseKey(b64u(Buffer.from('zzz', 'utf8')) + '.' + b64u(crypto.randomBytes(64)), OPTS).reason
        === 'charge illisible (JSON)');
    const noField = mkPayload(); delete noField.seats;
    check('A7: missing field refused',
        lic.verifyLicenseKey(issue(noField), OPTS).reason === 'champ manquant ou invalide : seats');
    check('A8: unknown edition refused',
        lic.verifyLicenseKey(issue(mkPayload({ edition: 'platinum' })), OPTS).reason
        === 'edition inconnue : platinum');
    check('A9: zero seats refused',
        lic.verifyLicenseKey(issue(mkPayload({ seats: 0 })), OPTS).reason === 'postes invalides');
    check('A10: features beyond the edition refused',
        lic.verifyLicenseKey(issue(mkPayload({ features: TEAM_FEATS.concat(['central']) })), OPTS).reason
        === 'fonctionnalites incoherentes avec l\'edition');
    const a11 = lic.verifyLicenseKey(issue(mkPayload({ expiresAt: '2020-01-01T00:00:00.000Z' })), OPTS);
    check('A11: expired key refused with date',
        a11.valid === false && a11.reason.indexOf('expiree le 2020') === 0, a11.reason);
    check('A12: future-issued key refused',
        lic.verifyLicenseKey(issue(mkPayload({ issuedAt: '2035-01-01T00:00:00.000Z' })), OPTS).reason
        === 'emise dans le futur');
    const a13a = lic.verifyLicenseKey(issue(mkPayload({ machineId: 'other-box' })), OPTS);
    const a13b = lic.verifyLicenseKey(issue(mkPayload({ machineId: lic.machineId() })), OPTS);
    check('A13: foreign machine refused, local machine accepted',
        a13a.valid === false && a13a.reason.indexOf('machine differente') === 0 && a13b.valid === true);
    check('A14: revoked id refused',
        lic.verifyLicenseKey(teamKey, Object.assign({ revokedIds: ['LIC-T-1'] }, OPTS)).reason === 'revoquee');

    // -- B: activation + storage ------------------------------------------------------
    const b1 = lic.activate(teamKey, OPTS);
    check('B1: valid Team key activates and persists',
        b1.ok === true && b1.status.state === 'active' && b1.status.edition === 'team' &&
        snap(licFile(HOME1)) !== null);
    const beforeB2 = snap(licFile(HOME1));
    const b2 = lic.activate(invented, OPTS);
    check('B2: invented key refused with NO state change',
        b2.ok === false && b2.reason === 'signature invalide' && snap(licFile(HOME1)) === beforeB2);
    const expKey = issue(mkPayload({ licenseId: 'LIC-EXP', expiresAt: '2020-06-01T00:00:00.000Z' }));
    const b3 = lic.activate(expKey, OPTS);
    check('B3: expired key refused with NO state change',
        b3.ok === false && b3.reason.indexOf('expiree') === 0 && snap(licFile(HOME1)) === beforeB2);
    const b4 = lic.activate(tampered, OPTS);
    check('B4: tampered key refused with NO state change',
        b4.ok === false && snap(licFile(HOME1)) === beforeB2);
    const b5 = lic.getStatus(OPTS);
    check('B5: status re-derives edition + features from the key',
        b5.state === 'active' && b5.features.indexOf('environment') !== -1 &&
        b5.features.indexOf('central') === -1 && b5.seatsMax === 10);
    check('B6: deactivate removes the file and degrades to Community',
        lic.deactivate().ok === true && snap(licFile(HOME1)) === null &&
        lic.getStatus(OPTS).state === 'none' && lic.getStatus(OPTS).edition === 'community');
    fs.writeFileSync(licFile(HOME1), 'garbage{{{');
    check('B7: corrupt stored file is invalid, never trusted',
        lic.getStatus(OPTS).state === 'invalid');
    fs.writeFileSync(licFile(HOME1), JSON.stringify({ key: expKey, activatedAt: 'x', seats: { max: 1, allocated: [] } }));
    const b8 = lic.getStatus(OPTS);
    check('B8: stored expired key degrades to Community with reason',
        b8.state === 'expired' && b8.edition === 'community' && b8.reason.indexOf('expiree') === 0);
    lic.deactivate();

    // -- C: revocation -------------------------------------------------------------------
    const c1 = lic.importRevocationList({ revoked: ['LIC-OLD-1', 'LIC-OLD-2'] });
    check('C1: valid revocation list imports with counts',
        c1.ok === true && c1.total === 2 && lic.readRevokedIds().length === 2);
    check('C2: malformed list rejected',
        lic.importRevocationList({ nope: 1 }).ok === false &&
        lic.importRevocationList({ revoked: ['ok', 42] }).ok === false);
    const revKey = issue(mkPayload({ licenseId: 'LIC-DOOMED' }));
    assert.strictEqual(lic.activate(revKey, OPTS).ok, true);
    lic.importRevocationList({ revoked: ['LIC-DOOMED'] });
    const c3 = lic.getStatus(OPTS);
    check('C3: revoked active key degrades immediately',
        c3.state === 'revoked' && c3.edition === 'community');
    const c4 = lic.importRevocationList({ revoked: ['LIC-OLD-1', 'LIC-NEW'] });
    check('C4: re-import merges without duplicates', c4.ok === true && c4.total === 4);
    lic.deactivate();

    // -- D: clock seal -------------------------------------------------------------------
    const entKey = issue(mkPayload({ licenseId: 'LIC-E-1', edition: 'enterprise',
        seats: 50, features: lic.EDITIONS.enterprise.features.slice() }));
    assert.strictEqual(lic.activate(entKey, OPTS).ok, true);
    const sealFile = path.join(HOME1, '.sudo_studio', 'license-seal.json');
    const sealKeyFile = path.join(HOME1, '.sudo_studio', 'license-seal.key');
    check('D1: activation writes a signed seal',
        fs.existsSync(sealFile) && typeof JSON.parse(fs.readFileSync(sealFile, 'utf8')).sig === 'string');
    function signSeal(ts) {
        const k = fs.readFileSync(sealKeyFile);
        return crypto.createHmac('sha256', k).update('lastSeen:' + ts, 'utf8').digest('hex');
    }
    const future = Date.now() + 10 * 86400000;
    fs.writeFileSync(sealFile, JSON.stringify({ ts: future, sig: signSeal(future) }));
    const d2 = lic.getStatus(OPTS);
    check('D2: clock rollback detected with the last-seen date',
        d2.state === 'rollback' && d2.reason.indexOf('horloge') !== -1 &&
        d2.reason.indexOf('derniere date vue') !== -1);
    const d2b = lic.getStatus(Object.assign({ now: future + 1000 }, OPTS));
    check('D2b: no false positive once time moves past the seal', d2b.state === 'active');
    fs.writeFileSync(sealFile, JSON.stringify({ ts: Date.now() - 1000, sig: 'deadbeef' }));
    check('D3: forged seal rejected', lic.getStatus(OPTS).state === 'seal-broken');
    fs.writeFileSync(sealFile, 'nope{{{');
    check('D4: corrupt seal rejected', lic.getStatus(OPTS).state === 'seal-broken');
    fs.writeFileSync(sealFile, JSON.stringify({ ts: future, sig: signSeal(future) }));
    const beforeD5 = snap(licFile(HOME1));
    const d5 = lic.activate(entKey, OPTS);
    check('D5: activation during rollback refused with NO state change',
        d5.ok === false && d5.reason.indexOf('horloge') !== -1 && snap(licFile(HOME1)) === beforeD5);
    const near = Date.now() + 60000;
    fs.writeFileSync(sealFile, JSON.stringify({ ts: near, sig: signSeal(near) }));
    check('D6: small skew tolerated (no false rollback)',
        lic.getStatus(OPTS).state === 'active');

    // -- E: editions ------------------------------------------------------------------------
    check('E1: feature to minimal edition mapping',
        lic.minEditionFor('chat') === 'community' && lic.minEditionFor('environment') === 'team' &&
        lic.minEditionFor('central') === 'enterprise' && lic.minEditionFor('nosuch') === null);
    lic.deactivate();
    assert.strictEqual(lic.activate(teamKey, OPTS).ok, true);
    const teamSt = lic.getStatus(OPTS);
    check('E2: Team has environment, not central',
        lic.hasFeature('environment', teamSt) === true && lic.hasFeature('central', teamSt) === false);
    assert.strictEqual(lic.activate(entKey, OPTS).ok, true);
    check('E3: Enterprise has central',
        lic.hasFeature('central', lic.getStatus(OPTS)) === true);
    lic.deactivate();
    const noneSt = lic.getStatus(OPTS);
    check('E4: no license means Community base only',
        lic.hasFeature('chat', noneSt) === true && lic.hasFeature('agent', noneSt) === false);
    check('E5: unknown feature never granted',
        lic.guardFeature('nosuch').allowed === false);
    assert.strictEqual(lic.activate(teamKey, OPTS).ok, true);
    const e6 = lic.guardFeature('central');
    check('E6: blocked guard names the required edition',
        e6.allowed === false && e6.message === 'Necessite l\'edition Enterprise' && e6.need === 'enterprise');

    // -- F: backend middleware (guard seam substituted with the ephemeral key;
    // the allow/block plumbing, codes and messages stay on the real path) ------------
    const realGuard = lic.guardFeature;
    lic.guardFeature = (f) => realGuard(f, lic.getStatus(OPTS));
    function runMw(feature) {
        let nexted = false;
        const res = { code: null, body: null,
            status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
        requireFeature(feature)({}, res, () => { nexted = true; });
        return { nexted, res };
    }
    const f1 = runMw('environment');
    check('F1: Team passes the environment gate', f1.nexted === true);
    const f2 = runMw('central');
    check('F2: Team is blocked from Enterprise with the edition message',
        f2.nexted === false && f2.res.code === 403 &&
        f2.res.body.error === 'Necessite l\'edition Enterprise' && f2.res.body.need === 'enterprise');
    assert.strictEqual(lic.activate(entKey, OPTS).ok, true);
    check('F3: Enterprise passes the central gate', runMw('central').nexted === true);
    lic.deactivate();
    check('F4: no license opens base, blocks Team features',
        runMw('chat').nexted === true &&
        runMw('agent').res.body.need === 'team' && runMw('agent').nexted === false);
    fs.writeFileSync(licFile(HOME1), JSON.stringify({ key: expKey, seats: { max: 1, allocated: [] } }));
    check('F5: expired license degrades the gates to Community',
        runMw('chat').nexted === true && runMw('central').nexted === false);
    lic.deactivate();
    lic.guardFeature = realGuard;

    // -- G: extension-core parity (isolated home) ----------------------------------------------
    process.env.SUDO_STUDIO_HOME = HOME2;
    const gTeam = issue(mkPayload({ licenseId: 'LIC-G-1' }));
    check('G1: extension core verifies', licX.verifyLicenseKey(gTeam, OPTS).valid === true);
    check('G2: extension core refuses invented keys',
        licX.verifyLicenseKey(invented, OPTS).reason === 'signature invalide');
    check('G3: extension core refuses tampered keys',
        licX.verifyLicenseKey(tampered, OPTS).reason === 'signature invalide');
    assert.strictEqual(licX.activate(gTeam, OPTS).ok, true);
    const gSt = licX.getStatus(OPTS);
    check('G4: extension activation + status agree',
        gSt.state === 'active' && gSt.edition === 'team' && gSt.seatsMax === 10);
    check('G5: extension guard message matches backend',
        licX.guardFeature('central', gSt).message === 'Necessite l\'edition Enterprise');
    let g6ok = false;
    try {
        crypto.createPublicKey({ key: Buffer.from(lic.PRODUCT_PUBLIC_KEY_SPKI_B64, 'base64'),
            format: 'der', type: 'spki' });
        g6ok = lic.PRODUCT_PUBLIC_KEY_SPKI_B64 === licX.PRODUCT_PUBLIC_KEY_SPKI_B64;
    } catch { g6ok = false; }
    check('G6: both runtimes embed the same parsable product key', g6ok);
    const fp = crypto.createHash('sha256').update(lic.PRODUCT_PUBLIC_KEY_SPKI_B64).digest('hex');
    check('G7: product fingerprint is logged for confirmation (' + fp.slice(0, 12) + '...)',
        /^[0-9a-f]{64}$/.test(fp));
    process.env.SUDO_STUDIO_HOME = HOME1;

    // -- H: panel protocol (isolated home, facade key) ------------------------------------
    process.env.SUDO_STUDIO_HOME = HOME3;
    function mkPanel() {
        const fp = { webview: { html: '', posted: [],
            async postMessage(m) { this.posted.push(m); return true; },
            onDidReceiveMessage() {} },
        onDidDispose() {}, reveal() {}, dispose() {} };
        return { p: new LicensePanel(fp, null), fp };
    }
    function lastPosted(fp, type) {
        const all = fp.webview.posted.filter((m) => m.type === type);
        return all[all.length - 1];
    }
    const hTeam = issue(mkPayload({ licenseId: 'LIC-H-TEAM', client: 'PanelCo' }));
    const h1 = mkPanel();
    h1.p._activate(invented);
    check('H1: panel refuses invented keys, precise reason, no file',
        lastPosted(h1.fp, 'activateError').msg === 'signature invalide' &&
        shown.err.length > 0 && snap(licFile(HOME3)) === null &&
        getAuditLog(500).some((e) => e.action === 'LICENSE_ACTIVATE' && e.result === 'error'));
    const h2 = mkPanel();
    h2.p._activate(tampered);
    check('H2: panel refuses tampered keys with no state change',
        lastPosted(h2.fp, 'activateError').msg === 'signature invalide' && snap(licFile(HOME3)) === null);
    const h3 = mkPanel();
    h3.p._activate(expKey);
    check('H3: panel refuses expired keys with no state change',
        lastPosted(h3.fp, 'activateError').msg.indexOf('expiree') === 0 && snap(licFile(HOME3)) === null);
    const h4 = mkPanel();
    h4.p._activate(hTeam);
    const h4view = lastPosted(h4.fp, 'licenseData').license;
    check('H4: panel activates a valid Team key and shows it',
        h4view.active === true && h4view.edition === 'team' && h4view.company === 'PanelCo' &&
        snap(licFile(HOME3)) !== null &&
        getAuditLog(500).some((e) => e.action === 'LICENSE_ACTIVATE' && e.result === 'ok'));
    check('H5: panel view carries client, edition, expiry, seats, status',
        h4view.licenseId === 'LIC-H-TEAM' && h4view.expiresAt === '2030-01-01T00:00:00.000Z' &&
        h4view.seats.max === 10 && h4view.status === 'active' &&
        h4view.features.indexOf('environment') !== -1);
    const seatKey = issue(mkPayload({ licenseId: 'LIC-H-SEAT', seats: 1 }));
    const h6 = mkPanel();
    h6.p._activate(seatKey);
    const errBefore = shown.err.length;
    h6.p._addSeat('a@test.co');
    h6.p._addSeat('b@test.co');
    const h6view = lastPosted(h6.fp, 'licenseData').license;
    check('H6: seat cap enforced (1 seat)',
        h6view.seats.allocated.join(',') === 'a@test.co' && shown.err.length === errBefore + 1);
    const revFile = path.join(FX, 'revoke.json');
    fs.writeFileSync(revFile, JSON.stringify({ revoked: ['LIC-H-SEAT'] }));
    vscodeMock.window.showOpenDialog = async () => [{ fsPath: revFile }];
    await h6.p._importRevocation();
    const h7view = lastPosted(h6.fp, 'licenseData').license;
    check('H7: imported revocation degrades the panel status',
        h7view.status === 'revoked' && h7view.active === false &&
        getAuditLog(500).some((e) => e.action === 'LICENSE_IMPORT_REVOCATION' && e.result === 'ok'));
    vscodeMock.window.showOpenDialog = async () => null;
    const expFile = path.join(FX, 'lic-export.json');
    vscodeMock.window.showSaveDialog = async () => ({ fsPath: expFile });
    await h6.p._exportLicense();
    const freshFile = path.join(FX, 'lic-fresh.json');
    fs.writeFileSync(freshFile, JSON.stringify({ key: hTeam, seats: { allocated: [] } }));
    h6.p._deactivate();
    vscodeMock.window.showOpenDialog = async () => [{ fsPath: expFile }];
    await h6.p._importLicense();
    const h8stillNone = lastPosted(h6.fp, 'licenseData').license;
    vscodeMock.window.showOpenDialog = async () => [{ fsPath: freshFile }];
    await h6.p._importLicense();
    const h8view = lastPosted(h6.fp, 'licenseData').license;
    vscodeMock.window.showOpenDialog = async () => null;
    vscodeMock.window.showSaveDialog = async () => null;
    check('H8: export round-trips; revoked import refused, fresh import accepted',
        JSON.parse(fs.readFileSync(expFile, 'utf8')).key === seatKey &&
        h8stillNone.active === false && h8view.active === true && h8view.licenseId === 'LIC-H-TEAM');
    h6.p._deactivate();
    const h9view = lastPosted(h6.fp, 'licenseData').license;
    check('H9: deactivate clears the file and the view',
        snap(licFile(HOME3)) === null && h9view.active === false && h9view.edition === 'community');
    process.env.SUDO_STUDIO_HOME = HOME1;

    // -- I: keygen CLI (guarded: needs the packager checkout) ----------------------------------
    const KEYGEN = path.join(__dirname, '..', '..', '..', 'sudo-studio-packager', 'license-keygen.js');
    if (!fs.existsSync(KEYGEN)) {
        check('I1-I5: keygen CLI (SKIP, no packager checkout)', true);
    } else {
        const kgTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-kg-'));
        const kgPriv = path.join(kgTmp, 't.private.pem');
        const i2 = spawnSync(process.execPath, [KEYGEN, 'init', '--out', kgPriv], { encoding: 'utf8' });
        const modeOk = os.platform() === 'win32' ||
            ((fs.statSync(kgPriv).mode & 0o777) === 0o600);
        check('I2: keygen init writes a 0600 private key + prints the public one',
            i2.status === 0 && modeOk && i2.stdout.indexOf('fingerprint') !== -1);
        const pubLine = i2.stdout.split('\n').filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l.trim()))[0].trim();
        const i3 = spawnSync(process.execPath, [KEYGEN, 'issue', '--private', kgPriv,
            '--client', 'CliCo', '--edition', 'enterprise', '--seats', '5',
            '--expires', '2030-05-05', '--license-id', 'LIC-CLI-1'], { encoding: 'utf8' });
        const cliKey = (i3.stdout || '').trim();
        const i3v = spawnSync(process.execPath, [KEYGEN, 'verify', '--public', pubLine,
            '--key', cliKey], { encoding: 'utf8' });
        check('I3: issue then verify round-trips',
            i3.status === 0 && cliKey.split('.').length === 2 && i3v.status === 0 &&
            i3v.stdout.indexOf('VALID') === 0);
        const i4 = spawnSync(process.execPath, [KEYGEN, 'issue', '--private', kgPriv,
            '--client', 'x', '--edition', 'platinum', '--seats', '1', '--expires', '2030-01-01'],
            { encoding: 'utf8' });
        check('I4: issue rejects unknown editions', i4.status !== 0);
        const badCli = cliKey.slice(0, 30) + (cliKey[30] === 'A' ? 'B' : 'A') + cliKey.slice(31);
        const i5 = spawnSync(process.execPath, [KEYGEN, 'verify', '--public', pubLine,
            '--key', badCli], { encoding: 'utf8' });
        check('I5: verify rejects tampered keys', i5.status !== 0);
    }

    // -- J: absence proofs (patterns built dynamically, never literal) ---------------------------
    const P_DEMO = 'DEMO' + '_KEYS';
    const P_SENT = 'SS' + 'ENT';
    const P_PK = 'PRIVATE' + ' KEY';
    const P_BP = 'BEGIN' + ' PRIVATE';
    const j1 = spawnSync('git', ['grep', '-n', P_DEMO, '--', '.'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    check('J1: no hard-coded demo-key table anywhere in the repo', (j1.stdout || '').trim() === '');
    const j2 = spawnSync('git', ['grep', '-n', P_SENT, '--', '.'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    check('J2: no legacy license codes anywhere in the repo', (j2.stdout || '').trim() === '');
    const j3 = spawnSync('git', ['log', '--oneline', '-S', P_PK, '--',
        'backend/src/license', 'sudo-ai-extension/src/license',
        'sudo-ai-extension/src/panels/LicensePanel.js', 'backend/middleware/license.middleware.js'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    check('J3: private key material never committed on license paths', (j3.stdout || '').trim() === '');
    const j4 = spawnSync('git', ['grep', '-n', P_BP, '--', 'sudo-ai-extension/src',
        'backend/src', 'backend/routes', 'backend/middleware'],
        { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    check('J4: no private key blocks in app sources', (j4.stdout || '').trim() === '');
    const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
    const pkgGi = path.join(__dirname, '..', '..', '..', 'sudo-studio-packager', '.gitignore');
    check('J5: gitignore guards private keys (app required, packager if present)',
        gi.indexOf('*.private.pem') !== -1 &&
        (!fs.existsSync(pkgGi) || fs.readFileSync(pkgGi, 'utf8').indexOf('*.private.pem') !== -1));

    // -- K: misc ------------------------------------------------------------------------------------
    const kHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-hk-'));
    process.env.SUDO_STUDIO_HOME = kHome;
    lic.verifyLicenseKey(teamKey, OPTS);
    const kDir = path.join(kHome, '.sudo_studio');
    check('K1: verification alone writes nothing',
        !fs.existsSync(kDir) || fs.readdirSync(kDir).length === 0);
    const k2 = lic.getStatus(OPTS);
    check('K2: empty home is Community with no license file',
        k2.state === 'none' && !fs.existsSync(licFile(kHome)));
    assert.strictEqual(lic.activate(teamKey, OPTS).ok, true);
    assert.strictEqual(lic.activate(entKey, OPTS).ok, true);
    check('K3: re-activation cleanly upgrades the edition',
        lic.getStatus(OPTS).edition === 'enterprise');
    process.env.SUDO_STUDIO_HOME = HOME1;
    assert.ok(pass > 0, 'suite ran');

}

main().then(() => {
    console.log(fail === 0 ? '\nP11: ' + pass + ' checks passed (all green)'
        : '\nP11: ' + pass + ' passed, ' + fail + ' FAILED');
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
