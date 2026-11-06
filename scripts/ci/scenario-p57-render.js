/**
 * scenario-p57-render.js - P57(8): scenario complet "deploie ce projet sur Render".
 *
 * Vrai serveur d'agent + fournisseur SCRIPTE (les appels qu'un bon modele
 * ferait) + un VRAI serveur MCP local (fixture stdio) + le skill render-deploy
 * installe et actif + un jeton dans un trousseau factice (seam) :
 *
 *   1. la demande "deploie ce projet sur Render" fait proposer le skill et le
 *      MCP des la premiere requete (digest + propositions) ;
 *   2. le modele charge le skill (skill_load) ;
 *   3. il verifie le build (bash), pousse le depot (git), appelle le MCP render ;
 *   4. le jeton arrive au serveur MCP par l'ENVIRONNEMENT (jamais par le modele,
 *      jamais par le journal) ;
 *   5. l'audit contient chaque appel d'extension, masque ;
 *   6. variante "serveur hors ligne" : erreur claire, le tour continue et
 *      bascule sur la ligne de commande (format honnete).
 *
 * Usage : node scripts/ci/scenario-p57-render.js [--offline] [--json] [--keep]
 * Sortie : PASS/FAIL par controle + tableau. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'sudo-agent', 'src');
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-render-server.js');
const SKILL_SRC = path.join(REPO, 'sudo-agent', 'skills', 'render-deploy', 'SKILL.md');
const TOKEN = 'p57-scenario-token-0123456789';
const HOST = '127.0.0.1';
const SECRET = 'rnd_p57_live_token_XYZ789';

const mcpMod = require(path.join(SRC, 'mcp.js'));
const skillsMod = require(path.join(SRC, 'skills.js'));
const agentsMod = require(path.join(SRC, 'agents.js'));
const extMod = require(path.join(SRC, 'extensions.js'));

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    if (i + 1 >= process.argv.length || String(process.argv[i + 1]).startsWith('--')) return true;
    return process.argv[i + 1];
}
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p + '-')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function write(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('PASS ' + name); }
    else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 300)); }
}

// -- fournisseur scripte : les appels d'un bon modele, dans l'ordre ----------
function scriptedProvider(script) {
    const payloads = [];
    let i = 0;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        if (req.method === 'GET' && u.pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted-p57', n_ctx: 8192 }] }));
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
            // un script qui "consomme" une reponse d'outil avant d'avancer
            const lastMsg = (body.messages || []).slice(-1)[0] || {};
            if (step && step.waitForToolResult && lastMsg.role !== 'tool' && lastMsg.role !== 'user') { sendText('...'); return; }
            i += 1;
            const fn = (step && step.tool && !script[Math.min(i - 1, script.length - 1)].repeat) ? step : step;
            const args = fn.args && typeof fn.args === 'function' ? fn.args(payloads) : (fn.args || {});
            const msg = { role: 'assistant', content: null,
                tool_calls: [{ id: 'c' + i, type: 'function', function: { name: fn.tool, arguments: JSON.stringify(args) } }] };
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

function agentHandshake(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        let out = '';
        let errText = '';
        const timer = setTimeout(() => reject(new Error('handshake timeout :: ' + errText.slice(-400))), timeoutMs || 20000);
        child.stdout.on('data', (c) => {
            out += c.toString('utf8');
            const nl = out.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            try { resolve(JSON.parse(out.slice(0, nl).trim())); } catch (e) { reject(new Error('bad handshake')); }
        });
        child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
        child.on('exit', (code) => reject(new Error('exited (' + code + ') :: ' + errText.slice(-400))));
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
        req.setTimeout(timeoutMs || 180000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.write(data);
        req.end();
    });
}

// -- scenario ---------------------------------------------------------------
(async () => {
    const offline = process.argv.indexOf('--offline') !== -1;
    const asJson = process.argv.indexOf('--json') !== -1;
    const keep = process.argv.indexOf('--keep') !== -1;

    const home = tmp('p57sh');
    const proj = tmp('p57sp');
    // projet reel : package.json + build qui passe
    write(proj, 'package.json', JSON.stringify({ name: 'demo-render', version: '1.0.0', scripts: { build: 'node -e "process.exit(0)"', test: 'node test/smoke.test.js' } }, null, 2) + '\n');
    write(proj, 'index.js', 'module.exports = () => "ok";\n');
    write(proj, 'test/smoke.test.js', 'const assert = require("assert");\nassert.strictEqual(require("../index")(), "ok");\nconsole.log("smoke ok");\n');
    write(proj, 'AGENTS.md', 'Regles projet : build vert obligatoire avant deploiement.\n');

    // extensions : skill actif, MCP render, commande, agent
    const agentHome = path.join(home, '.sudo_studio', 'agent');
    fs.mkdirSync(path.join(agentHome, 'skills', 'render-deploy'), { recursive: true });
    fs.copyFileSync(SKILL_SRC, path.join(agentHome, 'skills', 'render-deploy', 'SKILL.md'));
    skillsMod.setActive(home, proj, 'global', 'render-deploy', true);
    mcpMod.saveConfig(home, {
        render: { command: process.execPath, args: [FIXTURE], description: 'Deploiement Render (API)', enabled: true,
            secretEnv: { RENDER_TOKEN: 'SudoStudio/mcp/render' },
            env: offline ? { MCP_RENDER_OFFLINE: '1' } : {} },
    });
    fs.mkdirSync(agentHome, { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'mcp_policy.json'), JSON.stringify({ allowed: { render: ['deploy', 'status'] } }), 'utf8');
    fs.mkdirSync(path.join(agentHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'commands', 'deploiement.md'),
        '---\nname: deploiement\ndescription: Deploie le projet sur Render\nargs: service\n---\nDeploie ${service} sur Render (skill render-deploy).\n', 'utf8');
    agentsMod.saveAgent(home, { name: 'Deployeur', description: 'Agent de deploiement', instructions: 'Deploie avec preuves.', tools: ['read', 'list', 'bash', 'mcp_call', 'skill_load', 'done'] });

    // Trousseau : sur cet hote (Linux) le Credential Manager Windows n'existe
    // pas ; le moteur accepte un ASSISTANT DE CREDENTIALS local (contrat
    // git-credential). Le jeton vit dans un processus, jamais dans un fichier
    // de configuration ni dans le contexte du modele.
    const helper = path.join(home, 'cred-helper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\n'
        + 'case "$1" in\n'
        + '  get) if [ "$2" = "SudoStudio/mcp/render" ]; then printf "%s" "' + SECRET + '"; exit 0; fi; exit 1;;\n'
        + '  set) cat > /dev/null; exit 0;;\n'
        + '  delete) exit 0;;\n'
        + 'esac\nexit 1\n', { mode: 0o700 });
    process.env.SUDO_AGENT_KEYRING_HELPER = helper;

    // script du "bon modele"
    const buildCmd = 'node -e "process.exit(0)"';
    const script = [
        { tool: 'extensions_list', args: {} },
        { tool: 'skill_load', args: { name: 'render-deploy' } },
        { tool: 'bash', args: { command: buildCmd } },
        { tool: 'mcp_call', args: { serveur: 'render', outil: 'deploy', arguments: { service: 'demo-render', commit: 'HEAD' } } },
        offline
            ? { tool: 'bash', args: { command: 'echo "render deploys create demo-render"' } }
            : { tool: 'mcp_call', args: { serveur: 'render', outil: 'status', arguments: { deployId: 'dep_1' } } },
        { tool: 'done', args: { summary: offline
            ? 'serveur MCP render hors ligne : bascule ligne de commande, deploiement lance non confirme'
            : 'deploiement Render live (dep_1) verifie' } },
    ];
    const provider = await scriptedProvider(script);

    const env = Object.assign({}, process.env, {
        SUDO_AGENT_TOKEN: TOKEN,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: provider.url, model: 'scripted-p57' }),
        SUDO_STUDIO_HOME: home,
        SUDO_STUDIO_LOGS: path.join(home, 'logs'),
        SUDO_AGENT_STORE: path.join(home, 'store'),
        SUDO_AGENT_KEYRING_HELPER: helper,
    });
    const child = spawn(process.execPath, [path.join(SRC, 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { offline, steps: [] };
    try {
        const hs = await agentHandshake(child);
        out.port = hs.port;

        // 1. resume d'en-tete AVANT le tour
        const sum0 = await httpJson(hs.port, 'GET', '/extensions/summary');
        out.summary0 = sum0.body;
        check('en-tete : "1 MCP, 1 skill actif"', sum0.body && sum0.body.mcpEnabled === 1 && sum0.body.skillsActive === 1
            && sum0.body.label === '1 MCP, 1 skill actif', sum0.body);

        const reg = await httpJson(hs.port, 'GET', '/extensions/registry?q=' + encodeURIComponent('deploie ce projet sur Render'));
        const sug = (reg.body && reg.body.suggestions) || [];
        check('registre : skill + MCP proposes pour "deploie sur Render"',
            sug.some((x) => x.kind === 'skill' && x.name === 'render-deploy') && sug.some((x) => x.kind === 'mcp' && x.name === 'render'),
            sug.map((x) => x.kind + ':' + x.name));

        const s = await httpJson(hs.port, 'POST', '/sessions', { title: 'p57', projectRoot: proj });
        const sid = s.body.id;
        let polling = true;
        const approvals = [];
        const poller = (async () => {
            while (polling) {
                await sleep(200);
                let pend = null;
                try { pend = await httpJson(hs.port, 'GET', '/sessions/' + sid + '/approvals'); } catch (_) { continue; }
                for (const rq of ((pend.body && pend.body.pending) || [])) {
                    approvals.push(rq.tool + ':' + String((rq.pattern && rq.pattern.text) || ''));
                    try { await httpJson(hs.port, 'POST', '/sessions/' + sid + '/approvals', { requestId: rq.id, decision: 'once' }); } catch (_) { /* ignore */ }
                }
            }
        })();
        const t0 = Date.now();
        const turn = await ssePost(hs.port, '/sessions/' + sid + '/messages', { prompt: 'deploie ce projet sur Render' }, 180000);
        polling = false;
        try { await poller; } catch (_) {}
        out.ms = Date.now() - t0;
        out.approvals = approvals;

        const toolStarts = turn.events.filter((e) => e && e.type === 'tool.start').map((e) => e.tool);
        const toolResults = turn.events.filter((e) => e && e.type === 'tool.result');
        const done = turn.events.filter((e) => e && (e.type === 'turn.done' || e.type === 'run.done')).pop() || {};
        const err = turn.events.filter((e) => e && e.type === 'turn.error').pop();
        out.status = done.status;
        out.stopReason = done.stopReason || done.reason;
        out.tools = toolStarts;
        out.turnError = err ? String(err.code || err.message) : '';

        check('tour sans erreur bloquante', !err, err && (err.code || err.message));
        check('le modele a charge le skill', toolStarts.indexOf('skill_load') !== -1, toolStarts);
        check('le modele a verifie le build (bash)', toolStarts.indexOf('bash') !== -1, toolStarts);
        check('le modele a appele le MCP (mcp_call)', toolStarts.indexOf('mcp_call') !== -1, toolStarts);

        // 2. la premiere requete porte bien le digest + les propositions
        const first = provider.payloads.find((p) => Array.isArray(p.messages));
        const firstSys = first ? first.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n') : '';
        check('1re requete : digest des extensions present', /EXTENSIONS DISPONIBLES/.test(firstSys)
            && /render-deploy/.test(firstSys) && /MCP/.test(firstSys), firstSys.slice(0, 200));
        check('1re requete : extensions pertinentes proposees', /EXTENSIONS PERTINENTES/.test(firstSys)
            && /skill render-deploy/.test(firstSys), firstSys.slice(0, 300));
        check('contexte : corps du skill ABSENT avant chargement',
            firstSys.indexOf('Pousser le depot') === -1, 'le corps complet a fuite dans le 1er prompt');
        // le corps arrive APRES skill_load, dans une reponse d'outil
        const afterSkill = provider.payloads.find((p) => JSON.stringify(p.messages || []).indexOf('Pousser le depot') !== -1);
        check('skill charge a la demande (corps apres skill_load)', !!afterSkill, 'corps jamais charge');

        // 3. resultats d'outils : le deploiement rendu, sans jeton
        const dep = toolResults.find((e) => e.tool === 'mcp_call');
        const allResults = JSON.stringify(toolResults);
        if (!offline) {
            check('MCP : deploiement rendu (dep_1 live)', /dep_1/.test(allResults) && /live/.test(allResults), allResults.slice(0, 200));
            check('aucune sortie ne contient le jeton', allResults.indexOf(SECRET) === -1, 'jeton expose au modele');
            check('statut final honnete TERMINE', out.status === 'TERMINE', [out.status, out.stopReason]);
        } else {
            check('MCP hors ligne : erreur claire dans le resultat', /hors ligne|connexion refusee|echec/i.test(allResults), allResults.slice(0, 300));
            check('MCP hors ligne : le tour CONTINUE (bascule CLI)', toolStarts.filter((x) => x === 'bash').length >= 2, toolStarts);
            check('MCP hors ligne : pas de tour en erreur', !err, out.turnError);
        }

        // 4. audit
        const audit = await httpJson(hs.port, 'GET', '/extensions/audit?limit=50');
        const entries = (audit.body && audit.body.entries) || [];
        out.audit = entries.map((e) => e.kind + ':' + (e.tool || e.op || e.name || '') + ':' + (e.code || ''));
        const raw = entries.map((e) => JSON.stringify(e)).join('\n');
        check('audit : appels MCP journalises', entries.some((e) => e.kind === 'mcp'), out.audit);
        check('audit : skill et decouverte journalises', entries.some((e) => e.kind === 'skill')
            && entries.some((e) => e.kind === 'discover'), out.audit);
        check('audit : jeton absent', raw.indexOf(SECRET) === -1, 'jeton dans l audit !');
        check('audit : aucune entree ne fuit le secret', !/rnd_p57/.test(raw), raw.slice(0, 200));

        // 5. le journal du moteur ne contient pas le jeton
        let logRaw = '';
        try { logRaw = fs.readFileSync(path.join(home, 'logs', 'agent.jsonl'), 'utf8'); } catch (_) { logRaw = ''; }
        check('journal moteur : jeton absent', logRaw.indexOf(SECRET) === -1, 'jeton dans agent.jsonl');
        check('journal moteur : appels d extensions traces', /mcp_call|mention|extensions visibles/.test(logRaw), logRaw.slice(0, 120));
    } catch (e) {
        check('scenario sans exception de banc', false, String((e && e.message) || e).slice(0, 300));
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        try { await provider.close(); } catch (_) {}
        try { require(path.join(SRC, 'mcp.js')).disconnectAll(null); } catch (_) {}
        if (!keep) {
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        } else {
            console.log('conserve : home=' + home + ' projet=' + proj);
        }
    }
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else console.log('\nscenario : ' + (offline ? 'MCP HORS LIGNE' : 'MCP EN LIGNE') + ' | statut=' + out.status
        + ' | outils=' + (out.tools || []).join(',') + ' | ' + (out.ms || 0) + ' ms');
    console.log('== ' + pass + ' PASS, ' + fail + ' FAIL ==');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.log('ERREUR :: ' + String((e && e.stack) || e).slice(0, 600));
    process.exit(1);
});
