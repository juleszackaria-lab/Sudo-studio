/**
 * MISSION P2 - AI providers: registry, SecretStorage keys, admin policy,
 * secret filter, audit. Hermetic: temp HOME + injected centralDir/secrets/http.
 * Run:  node backend/tests/test-p2-providers.js
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Hermetic home BEFORE requiring auditLog (SUDO_STUDIO_HOME override).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;
const CENTRAL = path.join(TMP_HOME, 'central-test');

const {
  AIProviderService, POLICY_MSG, LOCAL_ID,
} = require('../../sudo-ai-extension/src/services/AIProviderService');
const { maskSecrets } = require('../../sudo-ai-extension/src/utils/secretFilter');
const { getAuditLog } = require('../../sudo-ai-extension/src/utils/auditLog');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}

// ---------------------------------------------------------------- fakes
function makeFakeSecrets() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : undefined),
    store: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
    __map: map,
  };
}

function makeFakeHttp() {
  const calls = [];
  const routes = {}; // 'GET url' / 'POST url' -> async ({url, body, opts}) => ({data}) | throws
  const fake = {
    get: async (url, opts) => {
      calls.push({ method: 'GET', url, opts });
      const h = routes['GET ' + url];
      if (!h) throw Object.assign(new Error('no route GET ' + url), { code: 'ENOROUTE' });
      return h({ url, opts });
    },
    post: async (url, body, opts) => {
      calls.push({ method: 'POST', url, body, opts });
      const h = routes['POST ' + url];
      if (!h) throw Object.assign(new Error('no route POST ' + url), { code: 'ENOROUTE' });
      return h({ url, body, opts });
    },
    __calls: calls,
    __routes: routes,
  };
  return fake;
}

const KEY_A = 'sk-test-KEY-A-aaaa1111';
const KEY_B = 'sk-test-KEY-B-bbbb2222';
const GHP = 'ghp_' + 'A'.repeat(36);
const AWS = 'AKIA' + 'B'.repeat(16);

async function main() {
  console.log('POLICY_MSG=' + POLICY_MSG);
  check('policy message is mission-exact (ASCII)', POLICY_MSG === "Interdit par la politique de l'administrateur", POLICY_MSG);
  check('local id', LOCAL_ID === 'local');

  const secrets = makeFakeSecrets();
  const http = makeFakeHttp();
  const svc = new AIProviderService({ centralDir: CENTRAL, secretsStore: secrets, httpClient: http, actor: 'tester@local' });

  // ------------------------------------------------- A. policy defaults
  const pol0 = svc.getCloudPolicy();
  check('A1: cloud disabled by default', pol0.cloudEnabled === false && Array.isArray(pol0.whitelist) && pol0.whitelist.length === 0, pol0);
  const chk0 = svc.checkCloudAllowed({ baseUrl: 'https://api.example.com' });
  check('A2: cloud refused when disabled', chk0.ok === false && chk0.error === POLICY_MSG, chk0);
  const bad = svc.saveCloudPolicy({ cloudEnabled: true, whitelist: 'not-an-array', updatedBy: 'admin@x' });
  check('A3: non-array whitelist coerced to []', bad.ok === true && bad.policy.whitelist.length === 0, bad.policy);
  const norm = svc.saveCloudPolicy({ cloudEnabled: false, whitelist: ['  API.Example.COM ', 'sub.foo.io/path'], updatedBy: 'a' });
  check('A4: whitelist normalized (lower/trim/no path)',
    norm.ok && norm.policy.whitelist.includes('api.example.com') && norm.policy.whitelist.includes('sub.foo.io'),
    norm.policy && norm.policy.whitelist);
  const svc2 = new AIProviderService({ centralDir: CENTRAL, secretsStore: secrets, httpClient: http });
  check('A5: policy persists across instances', svc2.getCloudPolicy().whitelist.includes('api.example.com'));

  // ------------------------------------------------- B. CRUD + secrets
  const add1 = await svc.addProvider({ name: 'Test Cloud', baseUrl: 'https://api.example.com', model: 'm1' }, KEY_A);
  check('B1: addProvider ok', add1.ok === true && /^p\w+$/.test(add1.id), add1);
  const idA = add1.id;
  const storeRaw = fs.readFileSync(path.join(CENTRAL, 'ai_providers.json'), 'utf8');
  check('B2: key NOT in store file', storeRaw.indexOf(KEY_A) === -1 && storeRaw.indexOf('Test Cloud') !== -1);
  check('B3: key in SecretStorage only', (await secrets.get('sudoAi.provider.' + idA)) === KEY_A);
  const addNoKey = await svc.addProvider({ name: 'NoKey', baseUrl: 'https://k.example.com', model: 'm' }, '');
  check('B4: addProvider without key refused', addNoKey.ok === false, addNoKey);
  const addBadUrl = await svc.addProvider({ name: 'BadUrl', baseUrl: 'not-a-url', model: 'm' }, KEY_A);
  check('B5: addProvider bad URL refused', addBadUrl.ok === false, addBadUrl);
  const addDup = await svc.addProvider({ name: 'test cloud', baseUrl: 'https://dup.example.com', model: 'm' }, KEY_A);
  check('B6: duplicate name refused', addDup.ok === false, addDup);
  const upd = await svc.updateProvider(idA, { name: 'Test Cloud', baseUrl: 'https://api.example.com', model: 'm2' }, KEY_B);
  check('B7: updateProvider rotates key', upd.ok === true && (await secrets.get('sudoAi.provider.' + idA)) === KEY_B, upd);
  const listed = svc.listProviders();
  check('B8: listProviders never exposes keys', JSON.stringify(listed).indexOf(KEY_A) === -1 && JSON.stringify(listed).indexOf(KEY_B) === -1);
  check('B9: local provider always listed', listed.providers.some((p) => p.id === 'local' && p.type === 'local'));
  const add2 = await svc.addProvider({ name: 'Other Cloud', baseUrl: 'https://other.com', model: 'mx' }, KEY_A);
  check('B10: second provider ok', add2.ok === true, add2);
  const idB = add2.id;
  const delLocal = await svc.deleteProvider('local');
  check('B11: cannot delete local', delLocal.ok === false, delLocal);

  // ------------------------------------------------- C. setActive + gate
  const selOff = svc.setActive(idA);
  check('C1: setActive cloud refused when policy off', selOff.ok === false && selOff.error === POLICY_MSG, selOff);
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['api.example.com'], updatedBy: 'admin@local' });
  const selOther = svc.setActive(idB);
  check('C2: non-whitelisted domain refused', selOther.ok === false && selOther.error === POLICY_MSG, selOther);
  const selA = svc.setActive(idA);
  check('C3: whitelisted provider selectable', selA.ok === true && svc.getActive().id === idA, selA);
  const selSub = svc.checkCloudAllowed({ baseUrl: 'https://sub.api.example.com' });
  check('C4: subdomain of whitelisted allowed', selSub.ok === true, selSub);
  const selLocal = svc.setActive('local');
  check('C5: local always selectable', selLocal.ok === true && svc.getActive().type === 'local');
  const selMissing = svc.setActive('nope');
  check('C6: unknown provider refused', selMissing.ok === false, selMissing);

  // ------------------------------------------------- D. complete() cloud
  svc.setActive(idA);
  http.__routes['POST https://api.example.com/v1/chat/completions'] = async ({ body, opts }) => ({
    data: { choices: [{ message: { content: 'HELLO' } }], usage: { total_tokens: 42 } },
  });
  const r1 = await svc.complete({ prompt: 'bonjour', purpose: 'agent' });
  check('D1: cloud complete ok', r1.ok === true && r1.reply === 'HELLO' && r1.usage.total_tokens === 42, r1);
  const c1 = http.__calls[http.__calls.length - 1];
  check('D2: Bearer auth + model sent',
    c1.opts.headers.Authorization === 'Bearer ' + KEY_B && c1.body.model === 'm2', c1.opts.headers);
  const r2 = await svc.complete({ prompt: 'my token is ' + GHP + ' end', purpose: 'chat' });
  const c2 = http.__calls[http.__calls.length - 1];
  const sent2 = JSON.stringify(c2.body);
  check('D3: secret masked before cloud send',
    sent2.indexOf(GHP) === -1 && sent2.indexOf('[SECRET MASQUE:GitHub Token]') !== -1
    && r2.masked.includes('GitHub Token'), sent2.slice(0, 200));
  svc.setFilterEnabled(false);
  const r3 = await svc.complete({ prompt: 'raw ' + GHP, purpose: 'chat' });
  const sent3 = JSON.stringify(http.__calls[http.__calls.length - 1].body);
  check('D4: filter OFF passes raw through', sent3.indexOf(GHP) !== -1 && r3.masked.length === 0);
  svc.setFilterEnabled(true);
  const nCalls = http.__calls.length;
  svc.saveCloudPolicy({ cloudEnabled: false, whitelist: [], updatedBy: 'admin@local' });
  let threw = null;
  try { await svc.complete({ prompt: 'x', purpose: 'chat' }); } catch (e) { threw = e; }
  check('D5: policy-off blocks send, no HTTP',
    !!threw && threw.message === POLICY_MSG && http.__calls.length === nCalls, threw && threw.message);
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['api.example.com'], updatedBy: 'admin@local' });
  http.__routes['POST https://api.example.com/v1/chat/completions'] = async () => {
    throw { response: { status: 401, data: { error: 'bad key' } } };
  };
  let err401 = null;
  try { await svc.complete({ prompt: 'x', purpose: 'chat' }); } catch (e) { err401 = e; }
  check('D6: cloud HTTP error surfaced, key never in message',
    !!err401 && err401.message.indexOf('HTTP 401') !== -1 && err401.message.indexOf(KEY_B) === -1, err401 && err401.message);

  // ------------------------------------------------- E. complete() local
  svc.setActive('local');
  let localGot = null;
  const rL = await svc.complete({
    prompt: 'local secret ' + GHP, purpose: 'agent',
    localFn: async () => { localGot = 'local secret ' + GHP; return { reply: 'LOCAL-OK', model: 'm-local', usage: { total_tokens: 7 } }; },
  });
  check('E1: local delegates to localFn unfiltered (cloud-only filter)',
    rL.ok === true && rL.reply === 'LOCAL-OK' && localGot.indexOf(GHP) !== -1, rL);
  let noFn = null;
  try { await svc.complete({ prompt: 'x' }); } catch (e) { noFn = e; }
  check('E2: local without localFn errors clearly', !!noFn && /local path/.test(noFn.message), noFn && noFn.message);

  // ------------------------------------------------- F. testConnection
  http.__routes['GET https://api.example.com/v1/models'] = async ({ opts }) => {
    assert.strictEqual(opts.headers.Authorization, 'Bearer ' + KEY_B);
    return { data: { data: [{ id: 'm1' }, { id: 'm2' }] } };
  };
  const t1 = await svc.testConnection(idA);
  check('F1: cloud test ok with Bearer + models', t1.ok === true && t1.models.length === 2, t1);
  svc.saveCloudPolicy({ cloudEnabled: false, whitelist: [], updatedBy: 'admin@local' });
  const callsBefore = http.__calls.length;
  const t2 = await svc.testConnection(idA);
  check('F2: test refused when policy off, no HTTP',
    t2.ok === false && t2.error === POLICY_MSG && http.__calls.length === callsBefore, t2);
  svc.saveCloudPolicy({ cloudEnabled: true, whitelist: ['api.example.com'], updatedBy: 'admin@local' });
  http.__routes['GET http://127.0.0.1:6000/v1/models'] = async () => ({ data: { data: [{ id: 'tiny' }] } });
  const t3 = await svc.testConnection('local');
  check('F3: local test hits runtime (no policy gate)', t3.ok === true && t3.models[0] === 'tiny', t3);

  // ------------------------------------------------- G. audit (metadata only)
  const log = getAuditLog(500);
  const out = log.find((e) => e.action === 'ai.outgoing_call' && e.result === 'ok' && /provider=Test Cloud/.test(e.detail));
  check('G1: outgoing call audited {provider,model,tokens,result}',
    !!out && /model=m2/.test(out.detail) && /tokens=42/.test(out.detail) && out.actor === 'tester@local', out);
  const whole = JSON.stringify(log);
  check('G2: no key, no secret, no prompt content in audit',
    whole.indexOf(KEY_A) === -1 && whole.indexOf(KEY_B) === -1 && whole.indexOf(GHP) === -1
    && whole.indexOf('bonjour') === -1, whole.length + ' chars scanned');
  check('G3: policy + select + test refusals audited',
    log.some((e) => e.action === 'ai.cloud_policy') && log.some((e) => e.result === 'refused_policy'));

  // ------------------------------------------------- H. filter unit
  const f1 = maskSecrets('key ' + AWS + ' end');
  check('H1: AWS masked with label',
    f1.text.indexOf(AWS) === -1 && f1.text.indexOf('[SECRET MASQUE:AWS Access Key]') !== -1
    && f1.masked.length === 1, f1);
  const f2 = maskSecrets('clean text, nothing here');
  check('H2: clean text untouched', f2.text === 'clean text, nothing here' && f2.masked.length === 0);
  const f3 = maskSecrets(null);
  check('H3: non-string safe', f3.text === '' && f3.masked.length === 0);
  const pv = svc.previewFilter('show ' + GHP);
  check('H4: previewFilter masks without sending', pv.text.indexOf('[SECRET MASQUE:') !== -1, pv.text);

  // ------------------------------------------------- I. delete cleans secrets
  const delB = await svc.deleteProvider(idB);
  check('I1: delete ok + secrets wiped',
    delB.ok === true && (await secrets.get('sudoAi.provider.' + idB)) === undefined
    && !svc.listProviders().providers.some((p) => p.id === idB), delB);

  console.log('\nP2: ' + pass + ' checks passed' + (process.exitCode ? ' (WITH FAILURES)' : ' (all green)'));
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
