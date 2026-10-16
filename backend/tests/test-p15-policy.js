/**
 * SUDO STUDIO - P15 3b: backend/runtime policy enforcement tests.
 * Hermetic (temp SUDO_STUDIO_HOME). Covers:
 *  A: backend/src/policy/policy.js (model allow-list + cloud whitelist)
 *  B: backend/middleware/policy.middleware.js (403 shapes + next())
 *  C: backend/runtime/policy_gate.py via python3 (skipped if absent)
 *  D: wiring (routes + runtime call sites present in source)
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-pol-'));
const OLD_HOME = process.env.SUDO_STUDIO_HOME;
process.env.SUDO_STUDIO_HOME = HOME;
const CENTRAL = path.join(HOME, '.sudo_studio', 'central');
fs.mkdirSync(CENTRAL, { recursive: true });

const policy = require('../src/policy/policy');
const mw = require('../middleware/policy.middleware');

let n = 0;
function check(name, fn) {
    fn();
    n++;
    console.log('PASS ' + name);
}

function writeStore(file, obj) {
    fs.writeFileSync(path.join(CENTRAL, file), JSON.stringify(obj), 'utf8');
}

function mockRes() {
    return { code: 0, body: null,
        status(c) { this.code = c; return this; },
        json(b) { this.body = b; return this; } };
}

// -- A: model allow-list -------------------------------------------------------
check('A1: no store -> allow all (extension semantics)', () => {
    assert.strictEqual(policy.isModelAllowed('anything/at-all'), true);
});
writeStore('central_policies.json', { allowedModels: ['Acme/Model-A', 'other/b'] });
check('A2: listed model allowed (case-insensitive)', () => {
    assert.strictEqual(policy.isModelAllowed('acme/model-a'), true);
});
check('A3: unlisted model refused', () => {
    assert.strictEqual(policy.isModelAllowed('evil/c'), false);
});
check('A4: empty model refused when list non-empty', () => {
    assert.strictEqual(policy.isModelAllowed(''), false);
});

// -- A: cloud policy -----------------------------------------------------------
check('A5: no cloud store -> refused (default disabled)', () => {
    assert.strictEqual(policy.isCloudHostAllowed('https://api.openai.com').ok, false);
});
writeStore('cloud_policy.json', { cloudEnabled: true, whitelist: ['api.openai.com'] });
check('A6: whitelisted host allowed', () => {
    assert.strictEqual(policy.isCloudHostAllowed('https://api.openai.com/v1').ok, true);
});
check('A7: subdomain of whitelisted host allowed', () => {
    assert.strictEqual(policy.isCloudHostAllowed('https://x.api.openai.com').ok, true);
});
check('A8: non-whitelisted host refused', () => {
    const r = policy.isCloudHostAllowed('https://evil.example.com');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.indexOf('cloud') !== -1 || r.error.indexOf('politique') !== -1);
});
check('A9: malformed URL refused', () => {
    assert.strictEqual(policy.isCloudHostAllowed('not a url').ok, false);
});
writeStore('cloud_policy.json', { cloudEnabled: false, whitelist: ['api.openai.com'] });
check('A10: cloudEnabled=false refuses even whitelisted host', () => {
    assert.strictEqual(policy.isCloudHostAllowed('https://api.openai.com').ok, false);
});

// -- B: middleware ---------------------------------------------------------------
function runMw(fn, body) {
    const res = mockRes();
    let nexted = false;
    fn({ body }, res, () => { nexted = true; });
    return { res, nexted };
}
check('B1: requireModelAllowed passes listed model to next()', () => {
    const r = runMw(mw.requireModelAllowed, { model: 'other/b' });
    assert.strictEqual(r.nexted, true);
});
check('B2: requireModelAllowed 403 on forbidden model', () => {
    const r = runMw(mw.requireModelAllowed, { model: 'evil/c' });
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.res.code, 403);
    assert.strictEqual(r.res.body.policy, 'allowedModels');
});
writeStore('cloud_policy.json', { cloudEnabled: true, whitelist: ['api.openai.com'] });
check('B3: requireCloudAllowed passes whitelisted baseUrl', () => {
    const r = runMw(mw.requireCloudAllowed, { baseUrl: 'https://api.openai.com' });
    assert.strictEqual(r.nexted, true);
});
check('B4: requireCloudAllowed 403 on foreign host', () => {
    const r = runMw(mw.requireCloudAllowed, { baseUrl: 'https://evil.example.com/x' });
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.res.code, 403);
    assert.strictEqual(r.res.body.policy, 'cloudPolicy');
});

// -- C: python gate --------------------------------------------------------------
check('C1: policy_gate.py same verdicts (python3)', () => {
    let out;
    try {
        out = execFileSync('python3', ['-c',
            'import sys; sys.path.insert(0, "backend/runtime");' +
            'import policy_gate as g;' +
            'print(g.is_model_allowed("Acme/Model-A"), g.is_model_allowed("evil/c"))',
        ], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
            env: Object.assign({}, process.env, { SUDO_STUDIO_HOME: HOME }) });
    } catch (e) {
        if (e.code === 'ENOENT') { console.log('SKIP C1: no python3'); return; }
        throw e;
    }
    assert.strictEqual(out.trim(), 'True False');
});

// -- D: wiring -------------------------------------------------------------------
check('D1: models routes guarded (download + switch)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'models.routes.js'), 'utf8');
    assert.ok(src.includes("router.post('/api/models/download', verifyToken, requireModelAllowed, async"));
    assert.ok(src.includes("router.post('/api/models/switch', verifyToken, requireModelAllowed, async"));
});
check('D2: runtime guarded (reload + download)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'server.enterprise.py'), 'utf8');
    assert.ok(src.includes('import policy_gate'));
    assert.strictEqual((src.match(/policy_gate\.is_model_allowed\(model_id\)/g) || []).length, 2);
});

process.env.SUDO_STUDIO_HOME = OLD_HOME;
console.log('\nP15-policy: ' + n + ' checks passed (all green)');
