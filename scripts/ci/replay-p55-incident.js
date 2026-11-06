/**
 * replay-p55-incident.js - P55(5): rejeu EXACT de l'incident + mesure du
 * comportement du moteur (avant / apres).
 *
 * Incident observe sur le PC de test (modele local Qwen2.5-Coder 1,5B),
 * demande "Ajoute des tests au projet et lance-les" :
 *   Erreur du fournisseur (HTTP 500) : {"error":{"code":500,
 *   "message":"tool call JSON invalid after retry: 'arguments' must be an
 *   object","type":"server_error"}}
 *
 * Le banc demarre le VRAI serveur d'agent (sudo-agent/src/server.js) du
 * repertoire demande, avec un fournisseur factice qui reproduit l'incident, et
 * mesure ce que l'utilisateur voit :
 *   - le tour se termine-t-il par une erreur brute relayee (turn.error) ?
 *   - combien d'appels fournisseur ont ete tentes ?
 *   - des fichiers ont-ils ete ecrits par le format de secours ?
 *   - le statut final est-il honnete (succes seulement si du travail existe) ?
 *
 * Scenarios :
 *   incident      toute requete AVEC outils -> HTTP 500 (le chemin contraint
 *                 casse) ; requete SANS outil -> bloc "FICHIER: chemin".
 *   transitoire   la 1re requete avec outils -> HTTP 500, les suivantes
 *                 renvoient un appel valide (read puis done).
 *
 * Usage:
 *   node replay-p55-incident.js --repo ~/Sudo-studio [--rev 71dd8b0|--dir chemin]
 *        [--scenario incident|transitoire] [--prompt "..."] [--json]
 *
 * Sortie : une ligne de mesures + le detail. Zero dependance, ASCII.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const HOST = '127.0.0.1';
const DEFAULT_PROMPT = 'Ajoute des tests au projet et lance-les';
const INCIDENT_500 = {
    error: {
        code: 500,
        message: "tool call JSON invalid after retry: 'arguments' must be an object",
        type: 'server_error',
    },
};
const FALLBACK_TEXT = [
    'FICHIER: test/demo.test.js',
    '"use strict";',
    'const assert = require("assert");',
    'assert.strictEqual(1 + 1, 2);',
    'console.log("tests ok");',
    'FIN FICHIER',
].join('\n');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    if (i + 1 >= process.argv.length || String(process.argv[i + 1]).startsWith('--')) return true;
    return process.argv[i + 1];
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -- fournisseur factice ----------------------------------------------------
function fakeProvider(scenario) {
    const payloads = [];
    const plainLog = [];
    let toolReq = 0;
    let plainReq = 0;
    let fallbackServed = 0;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        if (req.method === 'GET' && u.pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-coder-1.5b', n_ctx: 4096 }] }));
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
            const send500 = () => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(INCIDENT_500));
            };
            const sendJson = (msg) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
            };
            if (hasTools) {
                toolReq += 1;
                if (scenario === 'incident') { send500(); return; }
                if (scenario === 'transitoire' && toolReq === 1) { send500(); return; }
                const names = body.tools.map((t) => (t && t.function && t.function.name) || '');
                const says = JSON.stringify(body.messages || '');
                const wantsDone = names.indexOf('done') !== -1 && toolReq >= 2;
                if (wantsDone) {
                    sendJson({ role: 'assistant', content: null, tool_calls: [{ id: 'c_done', type: 'function',
                        function: { name: 'done', arguments: JSON.stringify({ summary: 'tests ajoutes et lances' }) } }] });
                    return;
                }
                const tool = names.indexOf('list') !== -1 ? 'list' : (names.indexOf('read') !== -1 ? 'read' : names[0]);
                const args = tool === 'read' ? { file: 'package.json' } : {};
                sendJson({ role: 'assistant', content: null, tool_calls: [{ id: 'c_' + toolReq, type: 'function',
                    function: { name: tool, arguments: JSON.stringify(args) } }] });
                void says;
                return;
            }
            // Requete SANS outil : sonde de sante, compression ou voie de
            // secours. La voie de secours porte la consigne "FICHIER:" et elle
            // marche toujours (un modele local repond tres bien en texte).
            plainReq += 1;
            const saysFallback = /FICHIER\s*:/i.test(raw) || /format de secours/i.test(raw);
            plainLog.push({ n: plainReq, saysFallback, served: fallbackServed,
                len: raw.length,
                tail: String((body.messages || []).slice(-1)[0] && (body.messages || []).slice(-1)[0].content || '').slice(0, 80) });
            if (!saysFallback) { sendJson({ role: 'assistant', content: 'ok' }); return; }
            fallbackServed += 1;
            const fbText = fallbackServed > 4 ? 'AUCUN FICHIER' : FALLBACK_TEXT;
            plainLog.push({ n: plainReq, saysFallback: true, served: fallbackServed,
                len: raw.length, tail: 'REPONSE=' + fbText.length + 'c' });
            sendJson({ role: 'assistant', content: fbText });
            return;
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, HOST, () => resolve({
            url: 'http://' + HOST + ':' + srv.address().port,
            payloads, plainLog,
            toolReq: () => toolReq,
            plainReq: () => plainReq,
            close: () => new Promise((r) => srv.close(() => r())),
        }));
    });
}

// -- utilitaires HTTP -------------------------------------------------------
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

function httpJson(port, token, method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: HOST, port, method, path: p,
            headers: Object.assign({ Authorization: 'Bearer ' + token },
                data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        }, (res) => {
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

function ssePost(port, token, p, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        let raw = '';
        let status = null;
        const req = http.request({
            host: HOST, port, method: 'POST', path: p,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            status = res.statusCode;
            res.on('data', (c) => { raw += c.toString('utf8'); });
            res.on('end', () => {
                const events = [];
                const named = [];
                for (const line of raw.split('\n')) {
                    const t = line.trim();
                    if (t.startsWith('event:')) named.push(t.slice(6).trim());
                    if (!t.startsWith('data:')) continue;
                    const payload = t.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try { events.push(JSON.parse(payload)); } catch (_) { /* ignore */ }
                }
                resolve({ status, events, named, raw });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 120000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.write(data);
        req.end();
    });
}

const TOKEN = 'p55-replay-token-0123456789';

function walk(dir, acc, base) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
    for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, acc, base);
        else acc.push(path.relative(base, full).replace(/\\/g, '/'));
    }
    return acc;
}

async function runCase(opts) {
    const provider = await fakeProvider(opts.scenario);
    const home = tmp('p55rhome');
    const proj = tmp('p55rproj');
    fs.writeFileSync(path.join(proj, 'package.json'),
        JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node test/demo.test.js' } }, 'utf8'), 'utf8');
    fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n', 'utf8');
    const env = Object.assign({}, process.env, {
        SUDO_AGENT_TOKEN: TOKEN,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: provider.url, model: 'qwen2.5-coder-1.5b' }),
        SUDO_STUDIO_HOME: home,
        SUDO_STUDIO_LOGS: path.join(home, 'logs'),
        SUDO_AGENT_STORE: path.join(home, 'store'),
    });
    const child = spawn(process.execPath, [path.join(opts.dir, 'sudo-agent', 'src', 'server.js')],
        { cwd: opts.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { scenario: opts.scenario, dir: opts.dir };
    try {
        const hs = await agentHandshake(child);
        const s = await httpJson(hs.port, TOKEN, 'POST', '/sessions', { title: 'p55', projectRoot: proj });
        const sid = s.body.id;
        // L'operateur approuve "une fois" chaque demande pendant la pause
        // (le flux SSE reste ouvert, la politique du produit est respectee).
        const decisions = [];
        let polling = true;
        const poller = (async () => {
            while (polling) {
                await sleep(250);
                let pend = null;
                try { pend = await httpJson(hs.port, TOKEN, 'GET', '/sessions/' + sid + '/approvals'); }
                catch (_) { continue; }
                const list = (pend && pend.body && pend.body.pending) || [];
                for (const rq of list) {
                    try {
                        await httpJson(hs.port, TOKEN, 'POST', '/sessions/' + sid + '/approvals',
                            { requestId: rq.id, decision: opts.decision || 'once' });
                        decisions.push(rq.tool + ':' + ((rq.pattern && rq.pattern.text) || ''));
                    } catch (_) { /* ignore */ }
                }
            }
        })();
        const t0 = Date.now();
        const turn = await ssePost(hs.port, TOKEN, '/sessions/' + sid + '/messages',
            { prompt: opts.prompt || DEFAULT_PROMPT }, 120000);
        polling = false;
        try { await poller; } catch (_) {}
        out.decisions = decisions;
        out.ms = Date.now() - t0;
        const turnErrors = turn.events.filter((e) => e && e.type === 'turn.error');
        const done = turn.events.filter((e) => e && (e.type === 'turn.done' || e.type === 'run.done')).pop() || null;
        const st = await httpJson(hs.port, TOKEN, 'GET', '/sessions/' + sid + '/status');
        const files = walk(proj, [], proj).filter((f) => f.indexOf('test/') === 0 || /test|spec/i.test(f));
        out.httpStatus = turn.status;
        out.calls = provider.payloads.length;
        out.toolRequests = provider.toolReq();
        out.plainRequests = provider.plainReq();
        out.toolChoice = provider.payloads.map((p) => (p && p.tool_choice === undefined ? '(absent)' : String(p.tool_choice))).join('|');
        out.events = turn.named.join(',').slice(0, 200);
        out.turnError = turnErrors.length ? String(turnErrors[0].message || turnErrors[0].code || '').slice(0, 200) : '';
        out.errorCode = turnErrors.length ? String(turnErrors[0].code || '') : '';
        out.runStatus = (st.body && (st.body.status || st.body.runStatus)) || (done && (done.status || done.runStatus)) || '';
        out.stopReason = (st.body && (st.body.stopReason || st.body.reason)) || (done && (done.stopReason || done.reason)) || '';
        out.createdFiles = files;
        out.plainLog = provider.plainLog;
        out.fallbackText = /FICHIER\s*:/i.test(turn.raw) ? 'oui' : 'non';
    } catch (e) {
        out.error = String((e && e.message) || e).slice(0, 300);
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        await provider.close();
        if (process.argv.indexOf('--keep') !== -1) {
            out.homeDir = home;
            out.projDir = proj;
            let jr = '';
            try {
                const jrec = require(path.join(opts.dir, 'sudo-agent', 'src', 'journal.js'));
                void jrec;
            } catch (_) { /* ignore */ }
            try {
                const files = walk(home, [], home).filter((f) => /journal|log/i.test(f));
                for (const f of files.slice(0, 3)) {
                    jr += '\n== ' + f + ' ==\n' + fs.readFileSync(path.join(home, f), 'utf8').slice(-3000);
                }
            } catch (_) { /* ignore */ }
            out.journal = jr;
        }
    }
    return out;
}

function worktreeFor(repo, rev) {
    const dir = path.join(tmp('p55rwt'), 'wt');
    execSync('git -C ' + JSON.stringify(repo) + ' worktree add --detach ' + JSON.stringify(dir) + ' ' + rev, { stdio: 'pipe' });
    return dir;
}

(async () => {
    const repo = String(arg('repo', process.cwd()));
    const scenario = String(arg('scenario', 'incident'));
    const prompt = String(arg('prompt', DEFAULT_PROMPT));
    const asJson = process.argv.indexOf('--json') !== -1;
    const rev = arg('rev', '');
    let dir = String(arg('dir', repo));
    let wt = null;
    if (rev) { wt = worktreeFor(repo, rev); dir = wt; }
    let row = null;
    try {
        row = await runCase({ dir, scenario, prompt });
        row.rev = rev || '(arbre de travail)';
    } finally {
        if (wt) { try { execSync('git -C ' + JSON.stringify(repo) + ' worktree remove --force ' + wt, { stdio: 'pipe' }); } catch (_) {} }
    }
    if (asJson) { console.log(JSON.stringify(row, null, 2)); return; }
    if (row.error) { console.log('ERREUR BANC :: ' + row.error); process.exit(0); }
    console.log('source           : ' + row.rev);
    console.log('scenario         : ' + row.scenario);
    console.log('statut HTTP      : ' + row.httpStatus);
    console.log('appels moteur    : ' + row.calls + ' (avec outils ' + row.toolRequests + ', sans outil ' + row.plainRequests + ')');
    console.log('tool_choice      : ' + row.toolChoice);
    console.log('erreur du tour   : ' + (row.turnError ? 'OUI :: ' + row.turnError : 'non'));
    console.log('code d\'erreur    : ' + (row.errorCode || '-'));
    console.log('statut du run    : ' + (row.runStatus || '-') + '  (arret: ' + (row.stopReason || '-') + ')');
    console.log('bloc FICHIER     : ' + row.fallbackText);
    console.log('fichiers crees   : ' + (row.createdFiles.length ? row.createdFiles.join(', ') : 'aucun'));
    console.log('duree            : ' + row.ms + ' ms');
    console.log('evenements       : ' + row.events);
    if (row.plainLog) for (const l of row.plainLog) console.log('  sans outil #' + l.n + ' secours=' + l.saysFallback + ' deja=' + l.served + ' len=' + l.len + ' :: ' + l.tail.replace(/\n/g, ' / '));
    if (row.journal) console.log('--- journal ---' + row.journal);
    if (row.homeDir) console.log('home conserve    : ' + row.homeDir + '  projet: ' + row.projDir);
})().catch((e) => { console.log('ERREUR BANC :: ' + String((e && e.message) || e).slice(0, 300)); });
