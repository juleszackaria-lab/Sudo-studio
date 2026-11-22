#!/usr/bin/env node
/**
 * P69-C7 : l'API survit au plantage du MOTEUR.
 *
 * Ce harnais lance `api_front.py` (l'API) qui lance lui-meme un faux moteur
 * (`_fake_engine.py`). On tue le moteur, on regarde ce que voit le client, et
 * on verifie que l'API, elle, n'est jamais tombee.
 *
 * Chaque cas a son controle negatif : un "l'API repond encore" n'a de valeur
 * que si "sans le front, on aurait une connexion coupee" est montre aussi.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'backend', 'runtime');
let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function req(port, method, p, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ hostname: '127.0.0.1', port, path: p, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: timeoutMs || 120000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(raw); } catch (_) { j = null; }
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, json: null, raw: 'delai' }); });
    r.on('error', (e) => resolve({ status: 0, json: null, raw: String(e.code || e.message) }));
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitUp(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    const r = await req(port, 'GET', '/health', undefined, 3000);
    if (r.status === 200) return r;
    await sleep(300);
  }
  return null;
}

(async () => {
  // Le front est du Python : sans Flask il ne peut pas demarrer. On le DIT
  // (jamais un silence) et le job CI installe Flask pour que ce cas ne se
  // produise pas.
  const hasFlask = spawnSync(process.env.PYTHON_BIN || 'python3', ['-c', 'import flask'], { encoding: 'utf8' });
  if (hasFlask.status !== 0) {
    console.log('SKIP test-p69-engine-isolation.js - Flask absent : le front ne peut pas demarrer.');
    console.log('         Installation : python3 -m pip install flask requests');
    process.exit(0);
  }
  const tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'p69-iso-'));
  const apiPort = await freePort();
  const enginePort = await freePort();
  const fake = path.join(__dirname, '_fake_engine.py');

  const env = Object.assign({}, process.env, {
    SUDO_STUDIO_LOGS: tmpLogs,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: RUNTIME,
    SUDO_ENGINE_CMD: fake,   // le front lance CE moteur-la, qu'on peut tuer
  });
  const front = spawn(process.env.PYTHON_BIN || 'python3',
    [path.join(RUNTIME, 'api_front.py'), '--port', String(apiPort),
     '--engine-port', String(enginePort)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let frontOut = '';
  front.stdout.on('data', (c) => { frontOut += c; });
  front.stderr.on('data', (c) => { frontOut += c; });

  const h = await waitUp(apiPort, 40000);
  check('I1 le front repond /health', !!h && h.status === 200, h ? JSON.stringify(h.json).slice(0, 200) : 'aucune reponse');
  check('I2 /health dit que le moteur est vivant', !!h && h.json && h.json.engine && h.json.engine.alive === true,
    h && h.json ? JSON.stringify(h.json).engine : '');

  const call = await req(apiPort, 'POST', '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'bonjour' }], max_tokens: 8 });
  check('I3 un appel passe par le front', call.status === 200 && call.json && call.json.choices,
    'status=' + call.status + ' ' + call.raw.slice(0, 160));

  const eng = await req(apiPort, 'GET', '/engine', undefined, 5000);
  const pid = eng.json && eng.json.pid;
  check('I4 le pid du moteur est expose', Number.isInteger(pid) && pid > 0, JSON.stringify(eng.json));

  // ---- mort du moteur ---------------------------------------------------
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* deja mort */ }
  await sleep(2500);   // le veilleur detecte et relance

  const h2 = await req(apiPort, 'GET', '/health', undefined, 5000);
  check('I5 l API repond ENCORE apres la mort du moteur (200, jamais coupee)',
    h2.status === 200, 'status=' + h2.status + ' ' + h2.raw.slice(0, 120));
  check('I6 /health nomme la mort du moteur',
    !!h2.json && h2.json.engine && /KILL|SIGKILL|signal|code/i.test(String(h2.json.engine.last_exit_name || '')),
    JSON.stringify(h2.json && h2.json.engine));

  const down = await req(apiPort, 'POST', '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'bonjour' }], max_tokens: 8 }, 20000);
  // soit le moteur est deja revenu (200), soit on recoit un 503 EXPLICITE.
  check('I7 pendant la panne : 503 explicite ou deja revenu (jamais une connexion coupee)',
    down.status === 200 || down.status === 503,
    'status=' + down.status + ' ' + down.raw.slice(0, 160));
  if (down.status === 503) {
    check('I7b le 503 dit que le moteur a plante et qu il est relance',
      !!down.json && down.json.error && down.json.error.type === 'engine_unavailable'
      && /plante/.test(String(down.json.error.message)) && /relance/.test(String(down.json.error.message)),
      JSON.stringify(down.json && down.json.error).slice(0, 240));
  } else {
    check('I7b le 503 dit que le moteur a plante et qu il est relance', true, 'moteur deja revenu : 200');
  }

  // ---- reprise ----------------------------------------------------------
  let back = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const r = await req(apiPort, 'POST', '/v1/chat/completions',
      { messages: [{ role: 'user', content: 'encore' }], max_tokens: 8 }, 20000);
    if (r.status === 200) { back = r; break; }
    await sleep(1000);
  }
  const restartMs = Date.now() - t0;
  check('I8 apres relance, l appel suivant passe', !!back && back.status === 200, 'restart=' + restartMs + 'ms');

  const info = await req(apiPort, 'GET', '/engine', undefined, 5000);
  check('I9 la relance est comptee et le nouveau pid est different',
    !!info.json && info.json.restarts >= 1 && info.json.pid !== pid,
    JSON.stringify(info.json));

  const hb = await req(apiPort, 'GET', '/hb', undefined, 5000);
  check('I10 le battement de coeur du front reste serviable',
    hb.status === 200 && hb.json && hb.json.alive === true, JSON.stringify(hb.json));

  check('I11 le front n a jamais quitte (processus vivant)',
    front.exitCode === null, 'exit=' + front.exitCode);

  // ---- controle negatif : sans front, on tombe avec le moteur -----------
  const rawPort = await freePort();
  const raw = spawn(process.env.PYTHON_BIN || 'python3',
    [fake, '--port', String(rawPort)], { env, stdio: 'ignore' });
  await waitUp(rawPort, 20000);
  const okDirect = await req(rawPort, 'POST', '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'x' }] }, 10000);
  try { process.kill(raw.pid, 'SIGKILL'); } catch (_) {}
  await sleep(800);
  const deadDirect = await req(rawPort, 'POST', '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'x' }] }, 8000);
  check('I12 CONTROLE NEGATIF : sans front, la mort du moteur coupe la connexion',
    okDirect.status === 200 && deadDirect.status === 0,
    'avant=' + okDirect.status + ' apres=' + deadDirect.status + ' (' + deadDirect.raw + ')');

  // ---- traces -----------------------------------------------------------
  const frontLog = path.join(tmpLogs, 'runtime-front.log');
  const hasLog = fs.existsSync(frontLog) ? fs.readFileSync(frontLog, 'utf8') : '';
  check('I13 la mort et la relance sont ecrites dans runtime-front.log',
    /MOTEUR MORT/.test(hasLog) && /RELANCE/.test(hasLog), (hasLog || '(aucun journal)').slice(-200));

  // ---- I14 : pas de SECOND moteur sur le meme port (orage de relances) --
  {
    const dupPort = apiPort;   // ce port est deja servi par `front`
    const dup = spawn(process.env.PYTHON_BIN || 'python3',
      [path.join(RUNTIME, 'api_front.py'), '--port', String(dupPort),
       '--engine-port', String(await freePort())], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let dupOut = '';
    dup.stdout.on('data', (c) => { dupOut += c; });
    dup.stderr.on('data', (c) => { dupOut += c; });
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), 25000);
      dup.on('exit', () => { clearTimeout(t); res(true); });
    });
    check('I14 un second front sur un port deja servi refuse de demarrer (aucun second moteur)',
      exited && /deja en service|deja un runtime/i.test(dupOut),
      (dupOut || '(rien)').slice(-160));
    try { dup.kill('SIGKILL'); } catch (_) {}
  }

  // ---- I15 : moteur casse -> relances SUSPENDUES, et c'est dit ----------
  {
    const badPort = await freePort();
    const badEngine = await freePort();
    const bad = spawn(process.env.PYTHON_BIN || 'python3',
      [path.join(RUNTIME, 'api_front.py'), '--port', String(badPort),
       '--engine-port', String(badEngine)],
      { env: Object.assign({}, env, { SUDO_ENGINE_CMD: path.join(__dirname, '_broken_engine.py') }),
        stdio: ['ignore', 'pipe', 'pipe'] });
    await waitUp(badPort, 25000);
    let seen = null;
    const t0b = Date.now();
    while (Date.now() - t0b < 30000) {
      const r = await req(badPort, 'GET', '/engine', undefined, 5000);
      if (r.json && r.json.restart_suspended === true) { seen = r.json; break; }
      await sleep(1000);
    }
    check('I15 un moteur qui meurt immediatement suspend les relances, avec la raison',
      !!seen && /immediatement/.test(String(seen.suspend_reason || '')),
      JSON.stringify(seen));
    const hbBad = await req(badPort, 'GET', '/health', undefined, 5000);
    check('I15b l API repond toujours et dit que le moteur est absent',
      hbBad.status === 200 && hbBad.json && hbBad.json.engine && hbBad.json.engine.alive === false,
      JSON.stringify(hbBad.json && hbBad.json.engine));
    try { bad.kill('SIGKILL'); } catch (_) {}
  }

  try { front.kill('SIGKILL'); } catch (_) {}
  try { raw.kill('SIGKILL'); } catch (_) {}

  console.log('');
  if (failures.length === 0) {
    console.log('P69-C7 isolation du moteur: ' + pass + ' checks passed (all green)');
    process.exit(0);
  }
  console.log('P69-C7 isolation du moteur: ' + pass + ' checks passed, ' + failures.length + ' FAILED');
  failures.forEach((f) => console.log('  - ' + f));
  console.log('--- sortie du front ---');
  console.log(frontOut.slice(-2000));
  process.exit(1);
})().catch((e) => { console.log('ERREUR ' + (e && e.stack || e)); process.exit(1); });
