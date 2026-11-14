/**
 * SUDO STUDIO - P63 : REPRODUCTION AVANT CORRECTION (preuve A).
 *
 * Lance les situations exactes de G1/G2/G3/G5 contre le code d AVANT, dans un
 * worktree du commit precedent :
 *   git worktree add /tmp/p63-before e6c3d48
 *   P63_REPO=/tmp/p63-before node scripts/ci/p63-reproduction-avant.js
 *
 * Sortie attendue (celle du paquet installe au 14/11/2026) :
 *   G1 statut rendu : TERMINE / reponse "Mode build / Termine / TERMINE (build)"
 *   G1 etapes 5..12 executees : false / 1 appel modele parent / pas d INCOMPLET
 *   G2 statut etape : failed ("runtime indisponible"), compte en echec
 *   G3 .sudo-agent dans le projet : true
 *   G5 aucune ligne hors perimetre dans le plan
 *
 * ASCII only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = process.env.P63_REPO || '/tmp/p63-before';
const SRC = path.join(REPO, 'sudo-agent', 'src');
process.env.SUDO_AGENT_CTX_TOKENS = '32768';
const { runTurn } = require(path.join(SRC, 'loop.js'));
const { createLogger } = require(path.join(SRC, 'journal.js'));
const { SessionStore } = require(path.join(SRC, 'store.js'));
const job = require(path.join(SRC, 'job.js'));
const spec = require(path.join(SRC, 'spec.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p + '-'));
const pad = (n) => String(n).padStart(2, '0');
const call = (name, args) => ({ toolCalls: [{ name, args: args || {} }] });

function mockProvider() {
  const chats = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      chats.push(body);
      const all = String((body.messages || []).map((m) => String(m.content || '')).join('\n'));
      const m = /(?:execute l etape|etape)\s+(\d+)\s*\/\s*(\d+)/i.exec(all);
      let msg = { content: 'Mode build / Termine / TERMINE (build)' };
      if (m) {
        const n = Number(m[1]);
        msg = { content: '', tool_calls: [{ id: 'c' + chats.length, type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ file: 'f' + pad(n) + '.txt', content: 'F' + n + '\n' }) } }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, chats })));
}

async function g1() {
  const proj = tmp('beforeproj');
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  const reqs = [];
  for (let i = 1; i <= 12; i++) reqs.push({ id: 'R' + i, text: 'E' + i, section: 1 });
  const meta = { id: 'spec-b1', title: 'T', requirements: reqs, sections: [{ n: 1, title: 'But' }], lines: 5 };
  const steps = [];
  for (let i = 0; i < 12; i++) steps.push({ i, section: 1, reqs: ['R' + (i + 1)], text: 'Creer f' + pad(i + 1) + '.txt', complex: false });
  const st = job.create(proj, meta, steps, {});
  for (let i = 0; i < 4; i++) { st.steps[i].status = 'done'; st.coverage[i].status = 'fait'; fs.writeFileSync(path.join(proj, 'f' + pad(i + 1) + '.txt'), 'F' + (i + 1) + '\n'); }
  st.status = 'partial';
  job.save(proj, st);

  const mock = await mockProvider();
  const home = tmp('bh');
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const rules = new Map();
  rules.set(s.id, new Set(steps.map((x, i) => 'write|file|f' + pad(i + 1) + '.txt')));
  const out = await runTurn({ store, sessionId: s.id, prompt: 'continu', corr: 'before',
    provider: { type: 'local', baseUrl: 'http://127.0.0.1:' + mock.port, model: 'mock-model' },
    toolsCtx: { home, sessionRules: rules, pending: new Map(), waiters: new Map() },
    runs: new Map(), log: createLogger({ logsDir: path.join(home, 'logs'), component: 'agent' }), onEvent: () => {} });
  const sess = store.get(s.id);
  const last = String(sess.messages[sess.messages.length - 1].content || '');
  console.log('G1 statut rendu           : ' + out.runStatus);
  console.log('G1 reponse finale         : ' + last.replace(/\n/g, ' | ').slice(0, 140));
  console.log('G1 etapes 5..12 executees : ' + [5, 6, 7, 8].every((i) => fs.existsSync(path.join(proj, 'f' + pad(i) + '.txt'))));
  console.log('G1 appels modele parent   : ' + mock.chats.filter((c) => !/(?:execute l etape|etape)\s+\d+\s*\/\s*\d+/i.test(
    String((c.messages || []).map((m) => String(m.content || '')).join('\n')))).length);
  console.log('G1 contient INCOMPLET     : ' + /INCOMPLET/.test(last));
  mock.srv.close();
}

async function g2() {
  const proj = tmp('beforeg2');
  const reqs = [{ id: 'R1', text: 'E1', section: 1 }];
  const meta = { id: 'spec-g2', title: 'T', requirements: reqs, sections: [{ n: 1, title: 'B' }], lines: 3 };
  const st = job.create(proj, meta, [{ i: 0, section: 1, reqs: ['R1'], text: 'Creer a.txt', complex: false }], {});
  const res = await job.run({ root: proj, state: st, runStep: async () => ({ ok: false, files: [], error: 'runtime indisponible',
    interruptedByRuntime: true, runtimeDownMs: 150000 }) });
  const s2 = job.load(proj, st.id).steps[0];
  console.log('G2 statut etape           : ' + s2.status + ' :: ' + String(s2.detail || '').slice(0, 110));
  console.log('G2 bilan                  : ' + String(res.report).split('\n')[0]);
  console.log('G2 compte l etape en echec: ' + (res.failed === 1));
}

async function g3() {
  const proj = tmp('beforeg3');
  const meta = { id: 'spec-g3', title: 'T', requirements: [{ id: 'R1', text: 'E1', section: 1 }],
    sections: [{ n: 1, title: 'B' }], lines: 3 };
  job.create(proj, meta, [{ i: 0, section: 1, reqs: ['R1'], text: 'Creer a.txt', complex: false }], {});
  spec.ingest(proj, '# Cahier\n\n## 1. But\n- Exigence 1 : faire un truc.\n', {});
  const listing = fs.readdirSync(proj);
  console.log('G3 contenu du projet      : ' + listing.join(','));
  console.log('G3 .sudo-agent dans projet: ' + fs.existsSync(path.join(proj, '.sudo-agent')));
}

async function g5() {
  const proj = tmp('beforeg5');
  const brief = '# Cahier des charges\n\n## 1. Objectif\nLivrer.\n\n- Exigence 1 : creer le module a.\n' +
    '- Exigence 2 : creer le module b.\n- Exigence 3 : publier sur le Play Store.\n';
  const meta = spec.ingest(proj, brief, {});
  const steps = spec.planSteps(meta);
  const txt = spec.planText(meta, steps);
  console.log('G5 nb d exigences du plan : ' + (meta.requirements || []).length);
  console.log('G5 nb d etapes annoncees  : ' + steps.length + ' | affiche : ' + (String(txt).match(/(\d+) etape\(s\) a executer/) || [])[1]);
  console.log('G5 ligne hors perimetre   : ' + (/HORS PERIMETRE/.test(txt) ? 'oui' : 'non'));
}

(async () => { await g1(); await g2(); await g3(); await g5(); })().catch((e) => { console.error('FATAL', e); process.exit(1); });
