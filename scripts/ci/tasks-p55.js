/**
 * tasks-p55.js - P55(5): 12 TACHES DE REFERENCE, deterministes.
 *
 * Chaque tache : une copie de projet (Flutter, Next.js, Node), la demande
 * reelle de l'utilisateur, un fournisseur SCRIPTE (les appels qu'un bon modele
 * ferait, dans l'ordre) et des attentes verifiables (fichiers, contenu,
 * commandes reellement lancees, statut final honnete).
 *
 * Les outils de build absents du banc (flutter, npm) sont remplaces par des
 * doublures qui ENREGISTRENT la commande et rendent une sortie realiste :
 * on prouve ainsi que l'agent lance bien la commande attendue, sans reseau.
 *
 * Usage :
 *   node scripts/ci/tasks-p55.js [--only T01,T04] [--json] [--keep]
 * Sortie : une ligne PASS/FAIL par tache + tableau final. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const TOKEN = 'p55-tasks-token-0123456789';

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

// -- projets de reference ---------------------------------------------------
const PROJECTS = {
    flutter: {
        files: {
            'pubspec.yaml': 'name: demo_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
            'lib/main.dart': 'import \'material.dart\';\nvoid main() => runApp(const App());\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) => MaterialApp(home: CounterPage());\n}\n',
            'lib/counter.dart': 'class Counter {\n  int value = 0;\n  void increment() => value++;\n}\n',
            'lib/theme.dart': 'import \'package:flutter/material.dart\';\nconst Color primary = Color(0xFF2196F3);\nfinal ThemeData appTheme = ThemeData(primarySwatch: Colors.blue);\n',
        },
    },
    next: {
        files: {
            'package.json': JSON.stringify({ name: 'site', dependencies: { next: '14.0.0', react: '18.0.0' }, devDependencies: { jest: '29.0.0' }, scripts: { test: 'jest', dev: 'next dev' } }, null, 2) + '\n',
            'app/layout.tsx': 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html><body>{children}</body></html>);\n}\n',
            'app/page.tsx': 'export default function Home() {\n  return (<main className="bg-[#2196F3] p-4"><h1>Accueil</h1></main>);\n}\n',
            'app/globals.css': ':root {\n  --primary: #2196F3;\n}\nbody { color: var(--primary); }\n',
            'tailwind.config.js': 'module.exports = { theme: { extend: { colors: { primary: "#2196F3" } } } };\n',
            'lib/math.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
        },
    },
    node: {
        files: {
            'package.json': JSON.stringify({ name: 'lib', version: '1.0.0', dependencies: {}, scripts: { test: 'node --test' } }, null, 2) + '\n',
            'index.js': 'const { add } = require("./src/math");\nmodule.exports = { add, describe: () => "lib" };\n',
            'src/math.js': 'function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\nmodule.exports = { add, sub };\n',
            'src/greet.js': 'function getUser(name) { return "Bonjour " + name; }\nmodule.exports = { getUser };\n',
            'src/use-greet.js': 'const { getUser } = require("./greet");\nfunction hello(n) { return getUser(n); }\nmodule.exports = { hello };\n',
            'test/math.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("../src/math");\ntest("addition", () => { assert.strictEqual(add(1, 1), 3); });\n',
        },
    },
};

// -- shims (flutter, npm, npx) : enregistrent la commande, sortie realiste ---
function makeShims() {
    const dir = tmp('p55-shims');
    const log = path.join(dir, 'commands.log');
    fs.writeFileSync(log, '', 'utf8');
    const mk = (name, body) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, '#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> ' + JSON.stringify(log) + '\n' + body + '\n', { mode: 0o755 });
    };
    mk('flutter', 'echo "00:01 +2: All tests passed!"; exit 0');
    mk('npm', 'case "$1" in\n  test) echo "PASS test/math.test.js"; echo "Tests: 2 passed, 2 total"; exit 0;;\n  install) echo "added 1 package in 1s"; exit 0;;\n  *) echo "npm $*"; exit 0;;\nesac');
    mk('npx', 'echo "npx $*"; exit 0');
    return { dir, log };
}

// -- fournisseur scripte ----------------------------------------------------
function scriptedProvider(script) {
    const payloads = [];
    let i = 0;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        if (req.method === 'GET' && u.pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', n_ctx: 8192 }] }));
            return;
        }
        if (req.method !== 'POST' || u.pathname !== '/v1/chat/completions') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
        }
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch (_) { body = {}; }
            payloads.push(body);
            const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
            const sendText = (t) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: t }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
            };
            if (!hasTools) { sendText('ok'); return; }
            const step = script[Math.min(i, script.length - 1)];
            i += 1;
            const msg = { role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function',
                function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, HOST, () => resolve({
            url: 'http://' + HOST + ':' + srv.address().port,
            payloads,
            get used() { return i; },
            close: () => new Promise((r) => srv.close(() => r())),
        }));
    });
}

// -- utilitaires agent ------------------------------------------------------
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
            try { resolve(JSON.parse(out.slice(0, nl).trim())); }
            catch (e) { reject(new Error('bad handshake: ' + out.slice(0, 200))); }
        });
        child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
        child.on('exit', (code) => reject(new Error('exited (code ' + code + ') :: ' + errText.slice(-400))));
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
        req.setTimeout(timeoutMs || 120000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.write(data);
        req.end();
    });
}

// -- 12 taches --------------------------------------------------------------
const TASKS = [
    {
        id: 'T01', project: 'flutter', name: 'Flutter : ajouter des tests et les lancer',
        prompt: 'Ajoute des tests au projet et lance-les',
        script: [
            { tool: 'list', args: {} },
            { tool: 'read', args: { file: 'lib/counter.dart' } },
            { tool: 'write', args: { file: 'test/counter_test.dart', content: 'import \'package:flutter_test/flutter_test.dart\';\nimport \'package:demo_app/counter.dart\';\n\nvoid main() {\n  test(\'increment ajoute 1\', () {\n    final c = Counter();\n    c.increment();\n    expect(c.value, 1);\n  });\n}\n' } },
            { tool: 'bash', args: { command: 'flutter test' } },
            { tool: 'done', args: { summary: 'tests ajoutes (test/counter_test.dart) et lances : 2 passed' } },
        ],
        expect: { files: ['test/counter_test.dart'], match: { 'test/counter_test.dart': /expect\(c\.value, 1\)/ },
            commands: [/flutter test/], status: 'TERMINE' },
    },
    {
        id: 'T02', project: 'next', name: 'Next.js : ajouter des tests et les lancer',
        prompt: 'Ajoute des tests au projet et lance-les',
        script: [
            { tool: 'list', args: {} },
            { tool: 'read', args: { file: 'lib/math.js' } },
            { tool: 'write', args: { file: '__tests__/math.test.js', content: 'const { add } = require("../lib/math");\ntest("add", () => { expect(add(2, 2)).toBe(4); });\n' } },
            { tool: 'bash', args: { command: 'npm test' } },
            { tool: 'done', args: { summary: 'test ajoute (__tests__/math.test.js), npm test : 2 passed' } },
        ],
        expect: { files: ['__tests__/math.test.js'], match: { '__tests__/math.test.js': /expect\(add\(2, 2\)\)/ },
            commands: [/npm test/], status: 'TERMINE' },
    },
    {
        id: 'T03', project: 'node', name: 'Node : ajouter des tests et les lancer (node --test reel)',
        prompt: 'Ajoute des tests au projet et lance-les',
        script: [
            { tool: 'read', args: { file: 'src/math.js' } },
            { tool: 'write', args: { file: 'test/sub.test.js', content: 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sub } = require("../src/math");\ntest("soustraction", () => { assert.strictEqual(sub(3, 1), 2); });\n' } },
            { tool: 'bash', args: { command: 'npm test' } },
            { tool: 'done', args: { summary: 'test/test/sub.test.js ajoute, npm test lance' } },
        ],
        expect: { files: ['test/sub.test.js'], match: { 'test/sub.test.js': /strictEqual\(sub\(3, 1\), 2\)/ },
            commands: [/npm test/], status: 'TERMINE' },
    },
    {
        id: 'T04', project: 'next', name: 'Next.js : changer la couleur principale en vert',
        prompt: 'Change la couleur principale en vert',
        script: [
            { tool: 'grep', args: { pattern: '#2196F3' } },
            { tool: 'read', args: { file: 'app/globals.css' } },
            { tool: 'edit', args: { file: 'app/globals.css', old: '--primary: #2196F3;', new: '--primary: #22C55E;' } },
            { tool: 'edit', args: { file: 'tailwind.config.js', old: 'primary: "#2196F3"', new: 'primary: "#22C55E"' } },
            { tool: 'edit', args: { file: 'app/page.tsx', old: 'bg-[#2196F3]', new: 'bg-[#22C55E]' } },
            { tool: 'done', args: { summary: 'couleur principale passee a #22C55E (globals.css, tailwind, page)' } },
        ],
        expect: { match: { 'app/globals.css': /--primary:\s*#22C55E/, 'tailwind.config.js': /#22C55E/, 'app/page.tsx': /#22C55E/ },
            absent: { 'app/globals.css': /#2196F3/ }, status: 'TERMINE' },
    },
    {
        id: 'T05', project: 'flutter', name: 'Flutter : changer la couleur principale en vert',
        prompt: 'Change la couleur principale en vert',
        script: [
            { tool: 'grep', args: { pattern: '0xFF2196F3' } },
            { tool: 'read', args: { file: 'lib/theme.dart' } },
            { tool: 'edit', args: { file: 'lib/theme.dart', old: 'const Color primary = Color(0xFF2196F3);', new: 'const Color primary = Color(0xFF22C55E);' } },
            { tool: 'edit', args: { file: 'lib/theme.dart', old: 'ThemeData(primarySwatch: Colors.blue)', new: 'ThemeData(primarySwatch: Colors.green)' } },
            { tool: 'done', args: { summary: 'ThemeData et couleur primaire passes au vert' } },
        ],
        expect: { match: { 'lib/theme.dart': /0xFF22C55E/ }, absent: { 'lib/theme.dart': /0xFF2196F3/ }, status: 'TERMINE' },
    },
    {
        id: 'T06', project: 'node', name: 'Node : renommer getUser en fetchUser partout',
        prompt: 'Renomme getUser en fetchUser dans tous les fichiers',
        script: [
            { tool: 'grep', args: { pattern: 'getUser' } },
            { tool: 'edit', args: { file: 'src/greet.js', old: 'function getUser(name)', new: 'function fetchUser(name)' } },
            { tool: 'edit', args: { file: 'src/greet.js', old: 'module.exports = { getUser };', new: 'module.exports = { fetchUser };' } },
            { tool: 'edit', args: { file: 'src/use-greet.js', old: 'const { getUser } = require("./greet");', new: 'const { fetchUser } = require("./greet");' } },
            { tool: 'edit', args: { file: 'src/use-greet.js', old: 'return getUser(n);', new: 'return fetchUser(n);' } },
            { tool: 'done', args: { summary: 'getUser renomme en fetchUser (2 fichiers)' } },
        ],
        expect: { match: { 'src/greet.js': /fetchUser/, 'src/use-greet.js': /fetchUser/ },
            absent: { 'src/greet.js': /getUser/, 'src/use-greet.js': /getUser/ }, status: 'TERMINE' },
    },
    {
        id: 'T07', project: 'next', name: 'Next.js : ajouter une page A propos',
        prompt: 'Ajoute une page A propos',
        script: [
            { tool: 'list', args: {} },
            { tool: 'write', args: { file: 'app/a-propos/page.tsx', content: 'export default function APropos() {\n  return (<main className="p-4"><h1>A propos</h1><p>Ce site presente le projet.</p></main>);\n}\n' } },
            { tool: 'edit', args: { file: 'app/page.tsx', old: '<h1>Accueil</h1>', new: '<h1>Accueil</h1><a href="/a-propos">A propos</a>' } },
            { tool: 'done', args: { summary: 'page A propos creee et liee depuis l accueil' } },
        ],
        expect: { files: ['app/a-propos/page.tsx'], match: { 'app/a-propos/page.tsx': /A propos/, 'app/page.tsx': /href="\/a-propos"/ }, status: 'TERMINE' },
    },
    {
        id: 'T08', project: 'node', name: 'Node : reparer un test qui echoue',
        prompt: 'Le test addition echoue, repare-le',
        script: [
            { tool: 'bash', args: { command: 'npm test' } },
            { tool: 'read', args: { file: 'test/math.test.js' } },
            { tool: 'read', args: { file: 'src/math.js' } },
            { tool: 'edit', args: { file: 'test/math.test.js', old: 'assert.strictEqual(add(1, 1), 3);', new: 'assert.strictEqual(add(1, 1), 2);' } },
            { tool: 'bash', args: { command: 'npm test' } },
            { tool: 'done', args: { summary: 'assertion corrigee (1+1=2), npm test relance' } },
        ],
        expect: { match: { 'test/math.test.js': /add\(1, 1\), 2\)/ }, commands: [/npm test/], status: 'TERMINE' },
    },
    {
        id: 'T09', project: 'node', name: 'Node : ajouter une dependance',
        prompt: 'Ajoute la dependance dayjs',
        script: [
            { tool: 'read', args: { file: 'package.json' } },
            { tool: 'edit', args: { file: 'package.json', old: '"dependencies": {},', new: '"dependencies": {\n    "dayjs": "^1.11.10"\n  },' } },
            { tool: 'bash', args: { command: 'npm install' } },
            { tool: 'done', args: { summary: 'dayjs ^1.11.10 ajoutee aux dependances, npm install lance' } },
        ],
        expect: { match: { 'package.json': /"dayjs":/ }, commands: [/npm install/], status: 'TERMINE' },
    },
    {
        id: 'T10', project: 'flutter', name: 'Flutter : ajouter un composant (widget)',
        prompt: 'Ajoute un composant bouton qui affiche un libelle',
        script: [
            { tool: 'list', args: {} },
            { tool: 'write', args: { file: 'lib/widgets/label_button.dart', content: 'import \'package:flutter/material.dart\';\n\nclass LabelButton extends StatelessWidget {\n  const LabelButton({super.key, required this.label, this.onPressed});\n  final String label;\n  final VoidCallback? onPressed;\n  @override\n  Widget build(BuildContext context) => ElevatedButton(onPressed: onPressed, child: Text(label));\n}\n' } },
            { tool: 'done', args: { summary: 'widget LabelButton ajoute dans lib/widgets/' } },
        ],
        expect: { files: ['lib/widgets/label_button.dart'], match: { 'lib/widgets/label_button.dart': /class LabelButton/ }, status: 'TERMINE' },
    },
    {
        id: 'T11', project: 'next', name: 'Next.js : ajouter un composant et l utiliser',
        prompt: 'Ajoute un composant carte et utilise-le sur la page d accueil',
        script: [
            { tool: 'write', args: { file: 'app/components/card.tsx', content: 'export default function Card({ title }: { title: string }) {\n  return (<div className="border p-2"><h2>{title}</h2></div>);\n}\n' } },
            { tool: 'read', args: { file: 'app/page.tsx' } },
            { tool: 'edit', args: { file: 'app/page.tsx', old: 'import', new: 'import Card from "./components/card";\nimport' } },
            { tool: 'edit', args: { file: 'app/page.tsx', old: '<h1>Accueil</h1>', new: '<h1>Accueil</h1><Card title="Bienvenue" />' } },
            { tool: 'done', args: { summary: 'composant Card cree et utilise sur l accueil' } },
        ],
        expect: { files: ['app/components/card.tsx'], match: { 'app/components/card.tsx': /function Card/, 'app/page.tsx': /<Card title="Bienvenue" \/>/ }, status: 'TERMINE' },
    },
    {
        id: 'T12', project: 'node', name: 'Node : demander une modification hors recette (controle honnete)',
        prompt: 'Ajoute une fonction multiply dans src/math.js et un test qui la couvre',
        script: [
            { tool: 'read', args: { file: 'src/math.js' } },
            { tool: 'edit', args: { file: 'src/math.js', old: 'module.exports = { add, sub };', new: 'function multiply(a, b) { return a * b; }\nmodule.exports = { add, sub, multiply };' } },
            { tool: 'write', args: { file: 'test/multiply.test.js', content: 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { multiply } = require("../src/math");\ntest("multiplication", () => { assert.strictEqual(multiply(2, 3), 6); });\n' } },
            { tool: 'bash', args: { command: 'npm test' } },
            { tool: 'done', args: { summary: 'multiply ajoutee avec son test, npm test lance' } },
        ],
        expect: { match: { 'src/math.js': /function multiply/, 'test/multiply.test.js': /multiply\(2, 3\), 6/ },
            commands: [/npm test/], status: 'TERMINE' },
    },
];

// -- execution d'une tache --------------------------------------------------
async function runTask(task, opts) {
    const shims = makeShims();
    const provider = await scriptedProvider(task.script);
    const home = tmp('p55th');
    const proj = tmp('p55tp');
    const spec = PROJECTS[task.project];
    for (const rel of Object.keys(spec.files)) write(proj, rel, spec.files[rel]);
    const env = Object.assign({}, process.env, {
        PATH: shims.dir + path.delimiter + process.env.PATH,
        SUDO_AGENT_TOKEN: TOKEN,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: provider.url, model: 'scripted' }),
        SUDO_STUDIO_HOME: home,
        SUDO_STUDIO_LOGS: path.join(home, 'logs'),
        SUDO_AGENT_STORE: path.join(home, 'store'),
    });
    const child = spawn(process.execPath, [path.join(opts.dir, 'sudo-agent', 'src', 'main.js')].filter((p) => fs.existsSync(p)).concat(
        fs.existsSync(path.join(opts.dir, 'sudo-agent', 'src', 'main.js')) ? [] : [path.join(opts.dir, 'sudo-agent', 'src', 'server.js')]),
    { cwd: opts.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { id: task.id, name: task.name, status: '', stopReason: '', created: [], commands: [], fail: [] };
    try {
        const hs = await agentHandshake(child);
        const s = await httpJson(hs.port, 'POST', '/sessions', { title: task.id, projectRoot: proj });
        const sid = s.body.id;
        let polling = true;
        const poller = (async () => {
            while (polling) {
                await sleep(250);
                let pend = null;
                try { pend = await httpJson(hs.port, 'GET', '/sessions/' + sid + '/approvals'); } catch (_) { continue; }
                for (const rq of ((pend.body && pend.body.pending) || [])) {
                    try { await httpJson(hs.port, 'POST', '/sessions/' + sid + '/approvals', { requestId: rq.id, decision: 'once' }); } catch (_) { /* ignore */ }
                }
            }
        })();
        const turn = await ssePost(hs.port, '/sessions/' + sid + '/messages', { prompt: task.prompt }, 150000);
        polling = false;
        try { await poller; } catch (_) {}
        const done = turn.events.filter((e) => e && (e.type === 'turn.done' || e.type === 'run.done')).pop() || {};
        const err = turn.events.filter((e) => e && e.type === 'turn.error').pop();
        out.status = String(done.status || (err ? 'ERREUR' : ''));
        out.stopReason = String(done.stopReason || done.reason || (err ? err.code : ''));
        out.turnText = String((turn.events.filter((e) => e && e.type === 'message.done').pop() || {}).text || '').slice(0, 200);
        // fichiers reellement crees
        const walk = (d, acc) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f, acc); else acc.push(path.relative(proj, f).replace(/\\/g, '/'));
            }
            return acc;
        };
        const initial = Object.keys(spec.files);
        out.created = walk(proj, []).filter((f) => initial.indexOf(f) === -1);
        try { out.commands = fs.readFileSync(shims.log, 'utf8').split('\n').filter(Boolean); } catch (_) { out.commands = []; }
        // attentes
        for (const f of (task.expect.files || [])) {
            if (out.created.indexOf(f) === -1) out.fail.push('fichier absent: ' + f);
        }
        for (const f of Object.keys(task.expect.match || {})) {
            const c = readOr(proj, f);
            if (c === null) out.fail.push('fichier introuvable: ' + f);
            else if (!task.expect.match[f].test(c)) out.fail.push('contenu inattendu: ' + f);
        }
        for (const f of Object.keys(task.expect.absent || {})) {
            const c = readOr(proj, f);
            if (c !== null && task.expect.absent[f].test(c)) out.fail.push('valeur obsolete restante: ' + f);
        }
        for (const re of (task.expect.commands || [])) {
            if (!out.commands.some((c) => re.test(c))) out.fail.push('commande non lancee: ' + re);
        }
        if (task.expect.status && out.status !== task.expect.status) out.fail.push('statut ' + out.status + ' != ' + task.expect.status);
        out.proj = proj;
        out.home = home;
    } catch (e) {
        out.fail.push('banc: ' + String((e && e.message) || e).slice(0, 200));
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        try { await provider.close(); } catch (_) {}
    }
    out.ok = out.fail.length === 0;
    return out;
}

(async () => {
    const dir = String(arg('dir', path.join(__dirname, '..', '..')));
    const only = String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
    const asJson = process.argv.indexOf('--json') !== -1;
    const tasks = only.length ? TASKS.filter((t) => only.indexOf(t.id) !== -1) : TASKS;
    const rows = [];
    for (const task of tasks) {
        const row = await runTask(task, { dir });
        rows.push(row);
        if (!asJson) {
            console.log((row.ok ? 'PASS ' : 'FAIL ') + row.id + '  ' + row.name);
            if (row.created.length) console.log('        fichiers: ' + row.created.join(', '));
            if (row.commands.length) console.log('        commandes: ' + row.commands.join(' | ').slice(0, 160));
            console.log('        statut: ' + row.status + ' (' + row.stopReason + ')');
            for (const f of row.fail) console.log('        ! ' + f);
        }
    }
    const ok = rows.filter((r) => r.ok).length;
    if (asJson) { console.log(JSON.stringify(rows, null, 2)); }
    else console.log('\n== ' + ok + '/' + rows.length + ' taches conformes ==');
    process.exit(ok === rows.length ? 0 : 1);
})().catch((e) => { console.log('ERREUR BANC :: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
