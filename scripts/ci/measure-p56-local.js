/**
 * measure-p56-local.js - P56: raw measurement on the 60-line specification
 * with a REAL local model.
 *
 * This script does NOT fake anything: it starts the real agent server against
 * the local model you point it at, pastes scripts/ci/fixtures/spec-60.md,
 * validates the plan ("lancer"), and prints the raw numbers of what happened
 * (steps, files, build/test results, wall time per step, memory).
 *
 *   SUDO_AGENT_PROVIDER='{"type":"local","baseUrl":"http://127.0.0.1:11434/v1","model":"qwen2.5-coder:7b"}' \
 *   node scripts/ci/measure-p56-local.js [--out mesure.json] [--keep]
 *
 * Without a local runtime this script cannot produce numbers: it says so and
 * exits 2 (never invents a measurement). ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'sudo-agent', 'src');
const FIXTURE = path.join(__dirname, 'fixtures', 'spec-60.md');
const HOST = '127.0.0.1';
const TOKEN = 'p56-measure-' + Date.now();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--') ? process.argv[i + 1] : true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, method, path: p,
      headers: Object.assign({ Authorization: 'Bearer ' + TOKEN },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { try { req.destroy(new Error('http timeout')); } catch (_) {} });
    if (data) req.write(data);
    req.end();
  });
}
function ssePost(port, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let raw = '';
    const req = http.request({ host: HOST, port, method: 'POST', path: p,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const settle = () => {
        const events = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { events.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
        }
        resolve(events);
      };
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', settle);
      res.on('aborted', settle);
      res.on('close', settle);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 3600000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.write(data);
    req.end();
  });
}
function boot(env) {
  const ch = spawn(process.execPath, [path.join(SRC, 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  ch.errBuf = '';
  ch.stdout.on('data', () => {});
  ch.stderr.on('data', (c) => { ch.errBuf += c.toString('utf8'); if (ch.errBuf.length > 100000) ch.errBuf = ch.errBuf.slice(-50000); });
  return ch;
}
function handshake(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('handshake timeout :: ' + child.errBuf.slice(-400))), timeoutMs || 60000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl).trim())); } catch (e) { reject(new Error('bad handshake')); }
    });
    child.on('exit', (code) => reject(new Error('exited (' + code + ') :: ' + child.errBuf.slice(-400))));
  });
}
function rssKb(pid) {
  try { return parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim(), 10) || 0; }
  catch (_) { return 0; }
}

(async () => {
  const outFile = arg('out', null);
  const keep = process.argv.indexOf('--keep') !== -1;
  const provRaw = process.env.SUDO_AGENT_PROVIDER;
  if (!provRaw) {
    console.log('AUCUNE MESURE : aucun modele local configure.');
    console.log('Renseignez SUDO_AGENT_PROVIDER (JSON) vers un runtime local, par exemple :');
    console.log('  SUDO_AGENT_PROVIDER=\'{"type":"local","baseUrl":"http://127.0.0.1:11434/v1","model":"qwen2.5-coder:7b"}\' \\');
    console.log('  node scripts/ci/measure-p56-local.js --out mesure.json');
    process.exit(2);
  }
  let prov = null;
  try { prov = JSON.parse(provRaw); } catch (e) { console.log('SUDO_AGENT_PROVIDER illisible : ' + e.message); process.exit(2); }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p56m-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'p56m-proj-'));
  const env = Object.assign({}, process.env, {
    SUDO_AGENT_TOKEN: TOKEN,
    SUDO_AGENT_PORT: '0',
    SUDO_STUDIO_HOME: home,
    SUDO_STUDIO_LOGS: path.join(home, 'logs'),
    SUDO_AGENT_STORE: path.join(home, 'store'),
  });
  const child = boot(env);
  const out = { provider: { type: prov.type, model: prov.model || null }, at: new Date().toISOString(), startedAt: Date.now() };
  try {
    const hs = await handshake(child);
    const port = hs.port;
    out.port = port;
    const s = await httpJson(port, 'POST', '/sessions', { title: 'mesure p56', projectRoot: proj });
    const sid = s.body.id;
    out.rssBeforeKb = rssKb(child.pid);

    // L'operateur (ce script) accorde les approbations demandees, comme un
    // utilisateur qui fait confiance au projet genere.
    let stop = false;
    const operator = (async () => {
      while (!stop) {
        await sleep(250);
        let list = [];
        try { const r = await httpJson(port, 'GET', '/sessions'); list = (r.body.sessions || []).map((x) => x.id); } catch (_) { continue; }
        for (const id of list) {
          let pend = null;
          try { pend = await httpJson(port, 'GET', '/sessions/' + id + '/approvals'); } catch (_) { continue; }
          for (const rq of ((pend.body && pend.body.pending) || [])) {
            out.approvals = (out.approvals || 0) + 1;
            try { await httpJson(port, 'POST', '/sessions/' + id + '/approvals', { requestId: rq.id, decision: 'project' }); } catch (_) {}
          }
        }
      }
    })();

    const brief = fs.readFileSync(FIXTURE, 'utf8');
    out.specLines = brief.split('\n').filter((l) => l.length > 0).length;
    let t0 = Date.now();
    const ev1 = await ssePost(port, '/sessions/' + sid + '/messages', { prompt: brief }, 600000);
    out.planMs = Date.now() - t0;
    const planMsg = ev1.filter((e) => e && e.type === 'message.done').pop() || {};
    const planEvt = ev1.filter((e) => e && e.type === 'job.plan').pop() || {};
    out.plan = { steps: planEvt.steps || 0, requirements: planEvt.requirements || 0, sections: planEvt.sections || 0,
      chars: String(planMsg.text || '').length };

    t0 = Date.now();
    const ev2 = await ssePost(port, '/sessions/' + sid + '/messages', { prompt: 'lancer' }, 3600000);
    out.runMs = Date.now() - t0;
    const done = ev2.filter((e) => e && e.type === 'turn.done').pop() || {};
    out.status = done.status || '';
    out.stopReason = done.stopReason || '';
    const steps = ev2.filter((e) => e && e.type === 'job.step');
    out.stepsStarted = steps.filter((e) => e.status === 'start').length;
    out.stepsDone = steps.filter((e) => e.status === 'done').length;
    out.stepsFailed = steps.filter((e) => e.status === 'failed').length;

    // Etat sur disque : verite terrain (et duree par etape).
    const jobDir = path.join(proj, '.sudo-agent', 'jobs');
    if (fs.existsSync(jobDir)) {
      const f = fs.readdirSync(jobDir).filter((x) => /\.json$/.test(x)).map((x) => path.join(jobDir, x))[0];
      if (f) {
        const st = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.job = { id: st.id, status: st.status,
          steps: st.steps.map((x) => ({ n: x.i + 1, status: x.status, attempts: x.attempts, ms: x.ms, calls: x.calls, files: x.files.length, test: x.test })) };
        out.totalStepMs = st.steps.reduce((a, x) => a + (x.ms || 0), 0);
      }
    }
    out.filesCreated = (() => {
      try {
        return execFileSync('bash', ['-lc', 'cd ' + JSON.stringify(proj) + ' && find . -type f -not -path "./.sudo-agent/*" | wc -l']).toString().trim();
      } catch (_) { return null; }
    })();
    // Build/tests reels sur le projet produit (si un manifeste existe).
    out.tests = { ran: false };
    try {
      const pkg = path.join(proj, 'package.json');
      if (fs.existsSync(pkg)) {
        const t = Date.now();
        let code = 0;
        let outTxt = '';
        try { outTxt = execFileSync('npm', ['test', '--silent'], { cwd: proj, encoding: 'utf8', timeout: 600000 }); }
        catch (e) { code = (e && e.status) || 1; outTxt = String((e && (e.stdout || e.message)) || e); }
        out.tests = { ran: true, code, ms: Date.now() - t, tail: outTxt.slice(-800) };
      }
    } catch (_) { /* ignore */ }
    out.rssAfterKb = rssKb(child.pid);
    stop = true;
    try { await operator; } catch (_) {}
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    out.endedAt = Date.now();
    const text = JSON.stringify(out, null, 2);
    console.log(text);
    if (outFile && outFile !== true) { try { fs.writeFileSync(String(outFile), text + '\n', 'utf8'); } catch (_) {} }
    if (!keep) {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {}
    } else {
      console.log('conserves : ' + home + ' | ' + proj);
    }
  }
})().catch((e) => {
  console.log('ERREUR MESURE :: ' + String((e && e.stack) || e).slice(0, 900));
  process.exit(1);
});
