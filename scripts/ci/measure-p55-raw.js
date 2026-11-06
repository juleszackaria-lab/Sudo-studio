/**
 * measure-p55-raw.js - P55(5): MESURE BRUTE avec le vrai modele local.
 *
 * Rejoue les 12 taches de reference avec le modele reellement charge dans le
 * runtime (aucun script, aucune doublure) : 10 essais par tache, chaque essai
 * dans un projet neuf et une session neuve. Tous les resultats sont comptes,
 * y compris les echecs : aucune mise en forme flatteuse, aucun arrondi.
 *
 * Ce banc ne tourne PAS dans un environnement sans modele : sans --base-url
 * joignable il s'arrete en le disant (aucun chiffre invente).
 *
 * Usage (PC de test, runtime charge avec Qwen2.5-Coder-1.5B) :
 *   node scripts/ci/measure-p55-raw.js \
 *        --base-url http://127.0.0.1:5000 --model Qwen2.5-Coder-1.5B \
 *        --trials 10 --out p55-raw-measure
 *
 * Sortie : p55-raw-measure.csv (une ligne par essai) + p55-raw-measure.md
 * (tableau par tache) + resume console. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const TOKEN = 'p55-raw-token-0123456789';

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    if (i + 1 >= process.argv.length || String(process.argv[i + 1]).startsWith('--')) return true;
    return process.argv[i + 1];
}
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function write(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}
function readOr(root, rel) {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; }
}

const PROJECTS = {
    flutter: {
        'pubspec.yaml': 'name: demo_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
        'lib/main.dart': 'import \'material.dart\';\nvoid main() => runApp(const App());\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) => MaterialApp(home: CounterPage());\n}\n',
        'lib/counter.dart': 'class Counter {\n  int value = 0;\n  void increment() => value++;\n}\n',
        'lib/theme.dart': 'import \'package:flutter/material.dart\';\nconst Color primary = Color(0xFF2196F3);\nfinal ThemeData appTheme = ThemeData(primarySwatch: Colors.blue);\n',
    },
    next: {
        'package.json': JSON.stringify({ name: 'site', dependencies: { next: '14.0.0', react: '18.0.0' }, devDependencies: { jest: '29.0.0' }, scripts: { test: 'jest', dev: 'next dev' } }, null, 2) + '\n',
        'app/page.tsx': 'export default function Home() {\n  return (<main className="bg-[#2196F3] p-4"><h1>Accueil</h1></main>);\n}\n',
        'app/globals.css': ':root {\n  --primary: #2196F3;\n}\nbody { color: var(--primary); }\n',
        'tailwind.config.js': 'module.exports = { theme: { extend: { colors: { primary: "#2196F3" } } } };\n',
        'lib/math.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
    },
    node: {
        'package.json': JSON.stringify({ name: 'lib', version: '1.0.0', dependencies: {}, scripts: { test: 'node --test' } }, null, 2) + '\n',
        'index.js': 'const { add } = require("./src/math");\nmodule.exports = { add, describe: () => "lib" };\n',
        'src/math.js': 'function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\nmodule.exports = { add, sub };\n',
        'src/greet.js': 'function getUser(name) { return "Bonjour " + name; }\nmodule.exports = { getUser };\n',
        'src/use-greet.js': 'const { getUser } = require("./greet");\nfunction hello(n) { return getUser(n); }\nmodule.exports = { hello };\n',
        'test/math.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("../src/math");\ntest("addition", () => { assert.strictEqual(add(1, 1), 3); });\n',
    },
};

// Memes taches que scripts/ci/tasks-p55.js, sans script : le modele decide.
const TASKS = [
    { id: 'T01', project: 'flutter', prompt: 'Ajoute des tests au projet et lance-les', want: { files: ['test/'], match: { 'test/': /expect|testWidgets/ } } },
    { id: 'T02', project: 'next', prompt: 'Ajoute des tests au projet et lance-les', want: { files: ['__tests__/', 'tests/'], match: { 'test': /expect|assert/ } } },
    { id: 'T03', project: 'node', prompt: 'Ajoute des tests au projet et lance-les', want: { files: ['test/'], match: { 'test/': /assert|expect/ } } },
    { id: 'T04', project: 'next', prompt: 'Change la couleur principale en vert', want: { match: { 'app/globals.css': /22C55E|green/i } } },
    { id: 'T05', project: 'flutter', prompt: 'Change la couleur principale en vert', want: { match: { 'lib/theme.dart': /green|22C55E/i } } },
    { id: 'T06', project: 'node', prompt: 'Renomme getUser en fetchUser dans tous les fichiers', want: { match: { 'src/greet.js': /fetchUser/ } } },
    { id: 'T07', project: 'next', prompt: 'Ajoute une page A propos', want: { files: ['app/a-propos/'] } },
    { id: 'T08', project: 'node', prompt: 'Le test addition echoue, repare-le', want: { match: { 'test/math.test.js': /add\(1, 1\), 2\)/ } } },
    { id: 'T09', project: 'node', prompt: 'Ajoute la dependance dayjs', want: { match: { 'package.json': /dayjs/ } } },
    { id: 'T10', project: 'flutter', prompt: 'Ajoute un composant bouton qui affiche un libelle', want: { files: ['lib/'] } },
    { id: 'T11', project: 'next', prompt: 'Ajoute un composant carte et utilise-le sur la page d accueil', want: { files: ['app/'] } },
    { id: 'T12', project: 'node', prompt: 'Ajoute une fonction multiply dans src/math.js et un test qui la couvre', want: { match: { 'src/math.js': /multiply/ } } },
];

function probe(baseUrl) {
    return new Promise((resolve) => {
        let url = null;
        try { url = new URL(baseUrl.replace(/\/$/, '') + '/v1/models'); } catch (_) { resolve({ ok: false, error: 'base-url invalide' }); return; }
        const req = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname, method: 'GET', timeout: 5000 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let d = null;
                try { d = JSON.parse(raw); } catch (_) { d = null; }
                const has = !!(d && Array.isArray(d.data));
                resolve({ ok: res.statusCode === 200 && has, status: res.statusCode, models: has ? d.data.map((m) => m.id) : [] });
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e).slice(0, 120) }));
        req.setTimeout(5000, () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: 'timeout' }); });
        req.end();
    });
}

function agentHandshake(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        let out = '';
        let errText = '';
        const timer = setTimeout(() => reject(new Error('handshake timeout :: ' + errText.slice(-300))), timeoutMs || 15000);
        child.stdout.on('data', (c) => {
            out += c.toString('utf8');
            const nl = out.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            try { resolve(JSON.parse(out.slice(0, nl).trim())); } catch (e) { reject(new Error('bad handshake')); }
        });
        child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
        child.on('exit', (code) => reject(new Error('exited (' + code + ') :: ' + errText.slice(-300))));
    });
}
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
            res.on('data', (c) => { raw += c.toString('utf8'); });
            res.on('end', () => {
                const events = [];
                for (const line of raw.split('\n')) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const payload = t.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try { events.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
                }
                resolve({ events, raw });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 600000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.write(data);
        req.end();
    });
}

function walk(dir, acc, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (f.indexOf(path.join(base, '.sudo_studio')) !== -1) continue;
        if (e.isDirectory()) walk(f, acc, base);
        else acc.push(path.relative(base, f).replace(/\\/g, '/'));
    }
    return acc;
}

async function oneTrial(task, cfg) {
    const home = tmp('p55rh');
    const proj = tmp('p55rp');
    const files = PROJECTS[task.project];
    for (const rel of Object.keys(files)) write(proj, rel, files[rel]);
    const before = walk(proj, [], proj);
    const env = Object.assign({}, process.env, {
        SUDO_AGENT_TOKEN: TOKEN,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: cfg.baseUrl, model: cfg.model }),
        SUDO_STUDIO_HOME: home,
        SUDO_STUDIO_LOGS: path.join(home, 'logs'),
        SUDO_AGENT_STORE: path.join(home, 'store'),
    });
    const child = spawn(process.execPath, [path.join(cfg.dir, 'sudo-agent', 'src', 'server.js')],
        { cwd: cfg.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const row = { task: task.id, project: task.project, trial: 0, status: '', stopReason: '',
        created: '', files: 0, ok: '', seconds: 0, note: '' };
    const t0 = Date.now();
    try {
        const hs = await agentHandshake(child);
        const s = await httpJson(hs.port, 'POST', '/sessions', { title: task.id, projectRoot: proj });
        const sid = s.body.id;
        let polling = true;
        const poller = (async () => {
            while (polling) {
                await sleep(400);
                let pend = null;
                try { pend = await httpJson(hs.port, 'GET', '/sessions/' + sid + '/approvals'); } catch (_) { continue; }
                const list = (pend.body && pend.body.pending) || [];
                for (const rq of list) {
                    try { await httpJson(hs.port, 'POST', '/sessions/' + sid + '/approvals', { requestId: rq.id, decision: cfg.decision || 'once' }); } catch (_) { /* ignore */ }
                }
            }
        })();
        const turn = await ssePost(hs.port, '/sessions/' + sid + '/messages', { prompt: task.prompt }, 600000);
        polling = false;
        try { await poller; } catch (_) {}
        const done = turn.events.filter((e) => e && (e.type === 'turn.done' || e.type === 'run.done')).pop() || {};
        const err = turn.events.filter((e) => e && e.type === 'turn.error').pop();
        row.status = String(done.status || (err ? 'ERREUR' : 'INCONNU'));
        row.stopReason = String(done.stopReason || done.reason || (err ? err.code : ''));
        const after = walk(proj, [], proj);
        const created = after.filter((f) => before.indexOf(f) === -1);
        row.created = created.join(' ');
        row.files = created.length;
        // critere de reussite : les attentes de la tache sont satisfaites
        let ok = true;
        for (const pref of (task.want.files || [])) {
            const hit = created.some((f) => f.indexOf(pref.replace(/\/$/, '')) === 0 || f.indexOf(pref) !== -1);
            if (!hit) ok = false;
        }
        for (const rel of Object.keys(task.want.match || {})) {
            const rx = task.want.match[rel];
            if (rel.slice(-1) === '/') {
                const hits = created.filter((f) => f.indexOf(rel) === 0);
                if (!hits.some((f) => rx.test(readOr(proj, f) || ''))) ok = false;
            } else {
                const c = readOr(proj, rel);
                if (c === null || !rx.test(c)) ok = false;
            }
        }
        row.ok = ok ? 'oui' : 'non';
        if (err) row.note = String(err.code || err.message || '').slice(0, 80);
    } catch (e) {
        row.status = 'ERREUR';
        row.note = String((e && e.message) || e).slice(0, 120);
        row.ok = 'non';
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        row.seconds = Math.round((Date.now() - t0) / 100) / 10;
        try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    return row;
}

(async () => {
    const cfg = {
        baseUrl: String(arg('base-url', 'http://127.0.0.1:5000')),
        model: String(arg('model', 'Qwen2.5-Coder-1.5B')),
        trials: parseInt(String(arg('trials', '10')), 10),
        out: String(arg('out', 'p55-raw-measure')),
        dir: String(arg('dir', path.join(__dirname, '..', '..'))),
        decision: String(arg('decision', 'once')),
    };
    const p = await probe(cfg.baseUrl);
    if (!p.ok) {
        console.log('MESURE IMPOSSIBLE : aucun runtime joignable sur ' + cfg.baseUrl +
            ' (' + (p.error || ('HTTP ' + p.status)) + ').');
        console.log('Aucune valeur n est inventee : relancez ce banc sur le PC de test avec le modele charge.');
        process.exit(2);
    }
    console.log('modele annonce par le runtime : ' + p.models.join(', '));
    const rows = [];
    for (const task of TASKS) {
        for (let trial = 1; trial <= cfg.trials; trial++) {
            const row = await oneTrial(task, cfg);
            row.trial = trial;
            rows.push(row);
            console.log('[' + task.id + ' essai ' + trial + '/' + cfg.trials + '] statut=' + row.status +
                ' arret=' + row.stopReason + ' fichiers=' + row.files + ' attendu=' + row.ok + ' (' + row.seconds + 's)');
        }
    }
    const csv = ['tache,projet,essai,statut,arret,fichiers_crees,attendu_respecte,secondes,note'];
    for (const r of rows) {
        csv.push([r.task, r.project, r.trial, r.status, r.stopReason, r.files, r.ok, r.seconds, String(r.note || '').replace(/,/g, ';')].join(','));
    }
    fs.writeFileSync(cfg.out + '.csv', csv.join('\n') + '\n', 'utf8');
    const md = ['# P55 - mesure brute avec le modele local', '',
        'Modele : ' + p.models.join(', ') + '  |  essais par tache : ' + cfg.trials, '',
        '| Tache | Projet | Reussites | Statuts observes | Fichiers crees (moy.) | Secondes (moy.) |',
        '|---|---|---|---|---|---|'];
    for (const task of TASKS) {
        const rs = rows.filter((r) => r.task === task.id);
        const okN = rs.filter((r) => r.ok === 'oui').length;
        const stats = {};
        for (const r of rs) stats[r.status] = (stats[r.status] || 0) + 1;
        const avgF = (rs.reduce((a, r) => a + r.files, 0) / rs.length).toFixed(2);
        const avgS = (rs.reduce((a, r) => a + r.seconds, 0) / rs.length).toFixed(1);
        md.push('| ' + task.id + ' | ' + task.project + ' | ' + okN + '/' + rs.length + ' | ' +
            Object.keys(stats).map((k) => k + ' x' + stats[k]).join(', ') + ' | ' + avgF + ' | ' + avgS + ' |');
    }
    md.push('', 'Detail par essai : ' + cfg.out + '.csv (aucune ligne retiree).');
    fs.writeFileSync(cfg.out + '.md', md.join('\n') + '\n', 'utf8');
    const totalOk = rows.filter((r) => r.ok === 'oui').length;
    console.log('\n== ' + totalOk + '/' + rows.length + ' essais conformes (brut, sans arrondi) ==');
    console.log('ecrit : ' + cfg.out + '.csv et ' + cfg.out + '.md');
})().catch((e) => { console.log('ERREUR BANC :: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
