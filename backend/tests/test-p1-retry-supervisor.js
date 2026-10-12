/**
 * MISSION P1 - Mock proofs for P1-d (supervisor) + P1-e (conn retry).
 * No axios / network / process needed: fake instances + injected deps.
 * Run:  node backend/tests/test-p1-retry-supervisor.js
 * ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const connRetryBE = require('../utils/connRetry');
const connRetryEXT = require('../../sudo-ai-extension/src/utils/httpRetry');
const { RuntimeSupervisor, toHHMM, resolveStateFile } = require('../supervisor/runtimeSupervisor');

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 200) : ''));
    process.exitCode = 1;
  } else { pass++; console.log('PASS ' + name); }
}

// ---------------------------------------------------------------- fake axios
function makeFakeAxios(failuresBeforeSuccess, failErr) {
  // failuresBeforeSuccess: number of times the CALL fails before succeeding.
  const calls = [];
  const handlers = {};
  const fake = async (config) => {
    calls.push(config);
    if (calls.length <= failuresBeforeSuccess) throw { ...failErr, config };
    return { status: 200, data: { ok: true }, config };
  };
  fake.interceptors = { response: { use: (okFn, errFn) => { handlers.err = errFn; } } };
  fake.__calls = calls;
  fake.__handlers = handlers;
  return fake;
}

async function testRetryModule(mod, label) {
  // install + idempotent
  const fx = makeFakeAxios(0, {});
  check(label + ': install true', mod.installAxiosConnRetry(fx) === true);
  check(label + ': idempotent', mod.installAxiosConnRetry(fx) === true);
  check(label + ': bad instance false', mod.installAxiosConnRetry(null) === false);

  // ECONNRESET once -> retry -> success
  const fx1 = makeFakeAxios(0, {});
  mod.installAxiosConnRetry(fx1);
  const err1 = { code: 'ECONNRESET', message: 'read ECONNRESET', config: { url: 'http://x/health' } };
  const p1 = fx1.__handlers.err(err1);
  const r1 = await p1;
  check(label + ': reset retried once then ok', r1.status === 200 && fx1.__calls.length === 1 && err1.config._p1Retried === true);

  // ECONNRESET twice -> clear error, code preserved.
  // Faithful pipeline: like real axios, the retried call re-enters interceptors.
  let calls2 = 0; let h2 = null;
  const fx2 = (config) => { calls2++; return Promise.reject({ code: 'ECONNRESET', message: 'dead', config }).catch((e) => h2(e)); };
  fx2.interceptors = { response: { use: (a, b) => { h2 = b; } } };
  mod.installAxiosConnRetry(fx2);
  try { await fx2({ url: 'http://x/i' }); check(label + ': double-fail rejects', false); }
  catch (e) {
    check(label + ': double-fail clear msg', e.message === 'Connection lost (ECONNRESET) after 1 retry: http://x/i', e.message);
    check(label + ': code preserved', e.code === 'ECONNRESET');
    check(label + ': 1 initial + 1 retry transport calls', calls2 === 2, calls2);
  }

  // ECONNREFUSED also covered
  const fx3 = makeFakeAxios(0, {});
  mod.installAxiosConnRetry(fx3);
  await fx3.__handlers.err({ code: 'ECONNREFUSED', message: 'ref', config: { url: 'u' } });
  check(label + ': refused retried', fx3.__calls.length === 1);

  // non-retryable (500) -> untouched, no retry
  const fx4 = makeFakeAxios(0, {});
  mod.installAxiosConnRetry(fx4);
  const e500 = { message: 'Request failed with status code 500', response: { status: 500 }, config: { url: 'u' } };
  try { await fx4.__handlers.err(e500); check(label + ': 500 rejects', false); }
  catch (e) { check(label + ': 500 untouched', e === e500 && fx4.__calls.length === 0); }

  // error without config -> no crash
  const fx5 = makeFakeAxios(0, {});
  mod.installAxiosConnRetry(fx5);
  try { await fx5.__handlers.err({ code: 'ECONNRESET', message: 'x' }); check(label + ': noconfig rejects', false); }
  catch (e) { check(label + ': noconfig cleared', e.message.indexOf('unknown url') !== -1, e.message); }

  check(label + ': isRetryable', mod.isRetryableConnError({ code: 'ECONNRESET' }) === true
    && mod.isRetryableConnError({ code: 'ETIMEDOUT' }) === false
    && mod.isRetryableConnError(null) === false);
}

// ---------------------------------------------------------------- supervisor
function refusedErr() { const e = new Error('connect ECONNREFUSED 127.0.0.1:6000'); e.code = 'ECONNREFUSED'; return e; }

async function testSupervisor() {
  // -- A. backoff 2/5/10 + cap 5/10min, restart never heals, clock fake --
  let fakeNow = 1000000;
  const delays = [];
  const spawns = [];
  const kills = [];
  const s = new RuntimeSupervisor({
    pollMs: 5, failThreshold: 3, graceMs: 0, waitHealthyMs: 1,
    runtimeExePath: path.join(os.tmpdir(), 'p1-fake-runtime.exe'),
    auditPath: path.join(os.tmpdir(), 'p1-audit.log'),
    httpGet: async () => { throw refusedErr(); },
    httpPost: async () => ({ status: 200, data: {} }),
    spawnFn: (p) => { spawns.push(p); },
    killFn: async (img) => { kills.push(img); },
    sleep: async (ms) => { delays.push(ms); fakeNow += ms; },
    now: () => fakeNow,
    log: () => {},
  });
  fs.writeFileSync(s.runtimeExePath, 'fake');
  s.running = true; s.startedAt = fakeNow;
  for (let i = 0; i < 8; i++) await s.pollTick(); // ticks 3..8 -> attempts 1..5 then cap
  check('sup: 5 spawns then cap', spawns.length === 5, spawns.length);
  check('sup: kill called per attempt', kills.length === 5 && kills[0] === 'runtime.exe');
  const firstSleeps = [delays[0], delays[2], delays[4], delays[6], delays[8]];
  console.log('PROOF backoffs: ' + JSON.stringify(firstSleeps) + ' (each followed by 1x2000 waitHealthy probe)');
  check('sup: backoff 2/5/10/10/10', JSON.stringify(firstSleeps) === JSON.stringify([2000, 5000, 10000, 10000, 10000]), firstSleeps);
  check('sup: cap suppressed', s.lastSuppressed && s.lastSuppressed.reason.indexOf('cap reached') !== -1, s.lastSuppressed);
  check('sup: restarts recorded x5', s.restarts.length === 5 && s.restarts[0].ok === false);
  check('sup: reason names exit suspicion', s.restarts[0].reason.indexOf('likely exited') !== -1, s.restarts[0].reason);
  const st = s.status();
  check('sup: status lastRestart HH:MM', /^\d\d:\d\d$/.test(st.lastRestart.atHHMM), st.lastRestart);
  check('sup: status window count', st.restartsInWindow === 5 && st.maxRestarts === 5);
  const audit = fs.readFileSync(s.auditPath, 'utf8');
  check('sup: audit has attempts+cap', audit.indexOf('RESTART attempt#1') !== -1 && audit.indexOf('SUPPRESSED (cap)') !== -1);
  console.log('PROOF audit tail: ' + JSON.stringify(audit.trim().split('\n').slice(-2)));

  // -- B. grace suppresses --
  let nowB = 5000000;
  let spawnsB = 0;
  const g = new RuntimeSupervisor({
    failThreshold: 2, graceMs: 60000,
    httpGet: async () => { throw refusedErr(); },
    spawnFn: () => { spawnsB++; }, killFn: async () => {},
    sleep: async (ms) => { nowB += ms; }, now: () => nowB, log: () => {},
    auditPath: path.join(os.tmpdir(), 'p1-audit-b.log'),
  });
  g.running = true; g.startedAt = nowB;
  await g.pollTick(); await g.pollTick();
  check('sup: grace suppresses restart', spawnsB === 0 && g.lastSuppressed !== null);

  // -- C. restart heals + model already loaded --
  let nowC = 9000000;
  const seq = ['fail', 'fail', 'fail', 'ok-health-loaded'];
  const c = new RuntimeSupervisor({
    failThreshold: 3, graceMs: 0, waitHealthyMs: 5000,
    runtimeExePath: path.join(os.tmpdir(), 'p1-fake-runtime.exe'),
    httpGet: async (url) => {
      const step = seq.shift() || 'ok-health-loaded';
      if (step === 'fail') throw refusedErr();
      return { status: 200, data: { model: { loaded: true, name: 'M1' } } };
    },
    httpPost: async () => ({ status: 200, data: {} }),
    spawnFn: () => {}, killFn: async () => {},
    sleep: async (ms) => { nowC += ms; }, now: () => nowC, log: () => {},
    auditPath: path.join(os.tmpdir(), 'p1-audit-c.log'),
  });
  c.running = true; c.startedAt = nowC;
  await c.pollTick(); await c.pollTick(); await c.pollTick();
  check('sup: healed restart ok', c.restarts.length === 1 && c.restarts[0].ok === true, c.restarts);
  check('sup: ensureModel already-loaded', c.restarts[0].detail.indexOf('already loaded') !== -1, c.restarts[0].detail);
  check('sup: failures reset', c.consecutiveFailures === 0 && c.lastOk === true);

  // -- D. ensureModel reloads saved model when unloaded --
  const statePath = path.join(os.tmpdir(), 'p1-model_state.json');
  fs.writeFileSync(statePath, JSON.stringify({ model_id: 'Saved/Model-GGUF', n_ctx: 2048 }));
  let posted = null;
  const d = new RuntimeSupervisor({
    httpGet: async () => ({ status: 200, data: { model: { loaded: false } } }),
    httpPost: async (url, body) => { posted = { url, body }; return { status: 200, data: { status: 'reloading' } }; },
    log: () => {}, stateFilePath: statePath, auditPath: path.join(os.tmpdir(), 'p1-audit-d.log'),
  });
  const detail = await d.ensureModel();
  check('sup: reload last model', posted && posted.body.model === 'Saved/Model-GGUF' && posted.body.n_ctx === 2048
    && detail.indexOf('reload triggered') !== -1, { posted, detail });

  // -- E. exe missing -> clean failed record, no throw --
  const e = new RuntimeSupervisor({
    graceMs: 0, runtimeExePath: path.join(os.tmpdir(), 'p1-does-not-exist.exe'),
    httpGet: async () => { throw refusedErr(); },
    spawnFn: () => { throw new Error('must not spawn'); }, killFn: async () => {},
    sleep: async () => {}, now: () => 0, log: () => {},
    auditPath: path.join(os.tmpdir(), 'p1-audit-e.log'),
  });
  e.running = true; e.startedAt = -1000000;
  const r = await e.maybeRestart('test');
  check('sup: missing exe clean fail', r.ok === false && r.detail.indexOf('exe not found') !== -1, r);

  // -- F. helpers --
  check('sup: toHHMM', /^\d\d:\d\d$/.test(toHHMM(Date.now())));
  check('sup: state path', resolveStateFile().endsWith(path.join('.sudo_studio', 'models', 'model_state.json')));
}

(async () => {
  await testRetryModule(connRetryBE, 'retry-BE');
  await testRetryModule(connRetryEXT, 'retry-EXT');
  await testSupervisor();
  console.log('\n== ' + pass + ' PASS, exit=' + (process.exitCode || 0) + ' ==');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
