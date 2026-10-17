/**
 * SUDO STUDIO - PROMPT 16 (e): edition behavior without a license (Community).
 * Hermetic (temp SUDO_STUDIO_HOME). Covers:
 *  A: exact refusal messages ("Necessite l'edition X" with accents)
 *  B: real requireFeature middleware 403s for every gated feature
 *  C: static wiring (backend routes + UI handlers + revocation gate)
 *  D: HTTP end-to-end over real express routers (SKIPPED if express missing);
 *     allow-path simulates Team status (P11-style seam: a real Team key needs
 *     the production private key, which never exists here - see section E)
 *  E: unknown-production-key refusal (cross-key) + single-key hygiene
 * ASCII-only (accents via \u escapes).
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-ed-'));
process.env.SUDO_STUDIO_HOME = HOME;

const lic = require('../src/license/license');
const { requireFeature } = require('../middleware/license.middleware');
const ROOT = path.join(__dirname, '..', '..');

const MSG_TEAM = 'N\u00e9cessite l\u0027\u00e9dition Team';
const MSG_ENT = 'N\u00e9cessite l\u0027\u00e9dition Enterprise';

const QUEUE = [];
function check(name, fn) { QUEUE.push([name, fn]); }
function runMw(feature) {
    const res = { code: null, body: null,
        status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    let nexted = false;
    requireFeature(feature)({}, res, () => { nexted = true; });
    return { nexted, res };
}

// -- A: exact messages -----------------------------------------------------------
check('A1: Community refusal messages carry accents + edition label', () => {
    const st = lic.getStatus();
    assert.strictEqual(st.edition, 'community');
    assert.strictEqual(lic.guardFeature('agent', st).message, MSG_TEAM);
    assert.strictEqual(lic.guardFeature('central', st).message, MSG_ENT);
});
check('A2: unknown feature message is explicit, never empty', () => {
    const g = lic.guardFeature('nope');
    assert.strictEqual(g.allowed, false);
    assert.ok(g.message && g.message.length > 5);
});

// -- B: middleware 403s ------------------------------------------------------------
const GATED = [
    ['devops', 'team', MSG_TEAM], ['environment', 'team', MSG_TEAM],
    ['agent', 'team', MSG_TEAM], ['security', 'enterprise', MSG_ENT],
    ['duplication', 'enterprise', MSG_ENT], ['central', 'enterprise', MSG_ENT],
    ['cicd', 'enterprise', MSG_ENT], ['license', 'enterprise', MSG_ENT],
];
check('B1: all 8 gated features 403 without a license (exact message + need)', () => {
    for (const [feat, need, msg] of GATED) {
        const r = runMw(feat);
        assert.strictEqual(r.nexted, false, feat);
        assert.strictEqual(r.res.code, 403, feat);
        assert.strictEqual(r.res.body.error, msg, feat);
        assert.strictEqual(r.res.body.need, need, feat);
    }
});
check('B2: community features stay open without a license', () => {
    for (const feat of ['chat', 'doctor', 'sdk']) {
        assert.strictEqual(runMw(feat).nexted, true, feat);
    }
});

// -- C: static wiring ---------------------------------------------------------------
function src(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
// P28: 5 simulated devops routes deleted; only the real /generate remains.
check('C1: the only devops route carries requireFeature(devops); fakes gone', () => {
    const t = src('backend/routes/devops.routes.js');
    assert.strictEqual((t.match(/requireFeature\('devops'\)/g) || []).length, 1);
    for (const dead of ['/simulate', '/metrics', '/deploy', '/deployments', '/rollback']) {
        assert.ok(!t.includes("'" + dead + "'"), dead + ' route deleted');
    }
});
check('C2: /generate splits cicd types to the enterprise gate', () => {
    const t = src('backend/routes/devops.routes.js');
    assert.ok(t.includes("guardFeature('cicd')"));
    assert.ok(t.includes("type === 'github-actions'"));
    assert.ok(t.includes("type === 'gitlab-ci'"));
});
check('C3: UI handlers gate before opening any panel', () => {
    const t = src('sudo-ai-extension/extension.js');
    const pairs = [['openDevOpsPanel', 'devops'], ['openAgentPanel', 'agent'],
        ['generateCICD', 'cicd'], ['openCentralMgmtPanel', 'central'],
        ['openSecurityPanel', 'security'], ['openDuplicationPanel', 'duplication']];
    for (const [fn, feat] of pairs) {
        const i = t.indexOf('function ' + fn);
        const g = t.indexOf("guardFeature('" + feat + "')", i);
        assert.ok(i !== -1 && g !== -1 && g - i < 400, fn + '/' + feat);
    }
});
check('C4: license panel stays open by design (activation path, P11 H7/H8)', () => {
    const t = src('sudo-ai-extension/src/panels/LicensePanel.js');
    assert.strictEqual(t.indexOf('guardFeature'), -1);
    assert.ok(t.indexOf('P11 H7/H8') !== -1);
});

// -- D: HTTP end-to-end ---------------------------------------------------------------
let express = null;
try { express = require('express'); } catch { express = null; }
function bearer() {
    const jwt = require('jsonwebtoken');
    const authMw = require('../middleware/auth.middleware');
    const secret = authMw.JWT_SECRET || process.env.JWT_SECRET || 'sudo-studio-local-dev-secret-2024';
    return 'Bearer ' + jwt.sign({ username: 'tester', role: 'admin' }, secret, { expiresIn: '5m' });
}
function httpCall(port, method, p, body, auth) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (auth) headers.Authorization = auth;
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
        const req = require('http').request({ host: '127.0.0.1', port, path: p, method, headers },
            (r) => { let b = ''; r.on('data', (c) => { b += c; });
                r.on('end', () => resolve({ code: r.statusCode, body: JSON.parse(b) })); });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
async function withApp(routerNames, fn) {
    const app = express();
    app.use(express.json());
    for (const rn of routerNames) app.use(require('../routes/' + rn));
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    try {
        await fn(srv.address().port);
    } finally {
        srv.close();
    }
}
check('D1: HTTP 403s without a license (real routers + real JWT)', async () => {
    if (!express) { console.log('SKIP D1: express not installed'); return; }
    const auth = bearer();
    await withApp(['devops.routes', 'environment.routes'], async (port) => {
        // P28: GET /api/devops/metrics was a simulated endpoint and was deleted;
        // the 403-without-license pin now uses the real /generate route only.
        let r = await httpCall(port, 'POST', '/api/devops/generate', { type: 'dockerfile' }, auth);
        assert.strictEqual(r.code, 403);
        assert.strictEqual(r.body.need, 'team');
        r = await httpCall(port, 'GET', '/api/environment/status', null, auth);
        assert.strictEqual(r.code, 403);
        assert.strictEqual(r.body.error, MSG_TEAM);
    });
});
check('D2: HTTP cicd split under simulated Team (real handler code)', async () => {
    if (!express) { console.log('SKIP D2: express not installed'); return; }
    const realGuard = lic.guardFeature;
    const teamSt = { state: 'active', edition: 'team',
        features: lic.EDITIONS.team.features.slice() };
    lic.guardFeature = (f) => realGuard(f, teamSt);
    try {
        const auth = bearer();
        await withApp(['devops.routes'], async (port) => {
            let r = await httpCall(port, 'POST', '/api/devops/generate', { type: 'dockerfile' }, auth);
            assert.strictEqual(r.code, 200, 'team allows devops types');
            assert.strictEqual(r.body.filename, 'Dockerfile');
            r = await httpCall(port, 'POST', '/api/devops/generate', { type: 'github-actions' }, auth);
            assert.strictEqual(r.code, 403, 'team refused for cicd types');
            assert.strictEqual(r.body.error, MSG_ENT);
            assert.strictEqual(r.body.need, 'enterprise');
        });
    } finally {
        lic.guardFeature = realGuard;
    }
});

// -- E: unknown-key refusal + single-key hygiene -----------------------------------------
function signWith(kp, payloadObj) {
    const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const a = b64u(JSON.stringify(payloadObj));
    return a + '.' + b64u(crypto.sign(null, Buffer.from(a), kp.privateKey));
}
function spkiB64(kp) {
    return kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}
function testPayload() {
    const now = Date.now();
    return { licenseId: 'LIC-X', client: 'x', edition: 'team', seats: 1,
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 86400000).toISOString() };
}
check('E1: key from an unknown pair is refused (dev-build simulation)', () => {
    const dev = crypto.generateKeyPairSync('ed25519');
    const prod = crypto.generateKeyPairSync('ed25519');
    const devKey = signWith(dev, testPayload());
    const prodKey = signWith(prod, testPayload());
    assert.strictEqual(lic.verifyLicenseKey(devKey, { publicKeySpkiB64: spkiB64(dev) }).valid, true);
    assert.strictEqual(lic.verifyLicenseKey(prodKey, { publicKeySpkiB64: spkiB64(dev) }).valid, false);
    assert.strictEqual(lic.verifyLicenseKey(devKey, { publicKeySpkiB64: spkiB64(prod) }).valid, false);
});
check('E2: exactly one embedded product key per license.js, no env override', () => {
    for (const p of ['backend/src/license/license.js', 'sudo-ai-extension/src/license/license.js']) {
        const t = src(p);
        assert.strictEqual((t.match(/PRODUCT_PUBLIC_KEY_SPKI_B64 = '/g) || []).length, 1, p);
        assert.ok(!/process\.env\.[A-Z_]*(KEY|LICENSE|PUB)/.test(t), p);
    }
});

(async () => {
    let n = 0;
    for (const [name, fn] of QUEUE) {
        await fn();
        n++;
        console.log('PASS ' + name);
    }
    console.log('\nP16-editions: ' + n + ' checks passed (all green)');
})().catch((e) => { console.error('P16 FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
