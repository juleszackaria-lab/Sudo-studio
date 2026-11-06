/**
 * bisect-p55-toolchoice.js - P55(1): localiser PAR GIT le changement qui a
 * transforme une sortie de modele imparfaite en rejet strict (HTTP 500).
 *
 * Methode (deterministe, sans llama.cpp) : pour chaque commit candidat, on
 * demarre le VRAI serveur d'agent (sudo-agent/src/server.js) du commit, on lui
 * donne un fournisseur factice qui ENREGISTRE la charge utile recue, on lui
 * envoie la demande exacte de l'incident ("Ajoute des tests au projet et
 * lance-les") et on lit ce que le moteur exige du runtime :
 *   - tool_choice envoye ('required' => le runtime prend le chemin JSON
 *     contraint, ou une sortie imparfaite finit en 500 apres UN essai) ;
 *   - presence de l'outil reply/done (capacite de sortie honnete) ;
 *   - statut final du tour.
 *
 * Le second mode (--incident) rejoue l'incident : le fournisseur factice
 * renvoie EXACTEMENT le corps d'erreur 500 observe sur le PC de test, et on
 * mesure la reaction du moteur (ECHEC net / reprise / abandon).
 *
 * Usage:
 *   node bisect-p55-toolchoice.js --repo <chemin du depot> [--revs a,b,c]
 *        [--prompt "..."] [--incident] [--json]
 *   node bisect-p55-toolchoice.js --all      (mode 'worktree' non utilise ici)
 *
 * Sortie : une ligne par commit + un tableau final. Zero dependance, ASCII.
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

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    if (i + 1 >= process.argv.length || String(process.argv[i + 1]).startsWith('--')) return true;
    return process.argv[i + 1];
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -- fake provider (records every payload) ----------------------------------
function fakeProvider(mode) {
    const payloads = [];
    let calls = 0;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        if (req.method === 'GET' && u.pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-coder-1.5b', n_ctx: 4096 }] }));
            return;
        }
        if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch (_) { body = {}; }
                calls += 1;
                payloads.push(body);
                if (mode === 'incident' && calls === 1) {
                    // The exact refusal seen on the test PC (HTTP 500).
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(INCIDENT_500));
                    return;
                }
                if (mode === 'incident' && calls > 6) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(INCIDENT_500));
                    return;
                }
                // Otherwise: a valid, minimal tool call (the runtime would have
                // produced one); the point of the run is the REQUEST payload.
                const wantsCall = Array.isArray(body.tools) && body.tools.length
                    && body.tool_choice !== 'none';
                const msg = wantsCall
                    ? { content: null, tool_calls: [{ id: 'call_b1', type: 'function',
                        function: { name: pickTool(body.tools, mode), arguments: '{}' } }] }
                    : { content: 'Voici une reponse en texte.' };
                if (body.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n\n');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: msg }] }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
    return new Promise((resolve) => {
        srv.listen(0, HOST, () => resolve({
            url: 'http://' + HOST + ':' + srv.address().port,
            payloads,
            close: () => new Promise((r) => srv.close(() => r())),
        }));
    });
}

function pickTool(tools, mode) {
    const names = tools.map((t) => (t && t.function && t.function.name) || '').filter(Boolean);
    if (mode === 'incident') {
        // after the 500: try a harmless read, then finish
        if (names.indexOf('list') !== -1) return 'list';
        if (names.indexOf('read') !== -1) return 'read';
    }
    if (names.indexOf('list') !== -1) return 'list';
    if (names.indexOf('read') !== -1) return 'read';
    return names[0] || 'read';
}

// -- agent server -----------------------------------------------------------
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
        child.on('exit', (code) => reject(new Error('exited (code ' + code + ') :: ' + errText.slice(-300))));
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
        let status = null;
        let raw = '';
        const done = { value: null };
        const req = http.request({
            host: HOST, port, method: 'POST', path: p,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            status = res.statusCode;
            res.on('data', (c) => { raw += c.toString('utf8'); });
            res.on('end', () => {
                let last = null;
                const events = [];
                for (const line of raw.split('\n')) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const payload = t.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const ev = JSON.parse(payload);
                        events.push(ev);
                        last = ev;
                    } catch (_) { /* ignore */ }
                }
                const named = raw.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice(6).trim());
                done.value = last;
                resolve({ status, last, raw, events, named });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 60000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
        req.write(data);
        req.end();
    });
}

const TOKEN = 'p55-bisect-token-0123456789';

async function runOnce(repoDir, rev, opts) {
    opts = opts || {};
    const provider = await fakeProvider(opts.incident ? 'incident' : 'normal');
    const home = tmp('p55home');
    const proj = tmp('p55proj');
    fs.writeFileSync(path.join(proj, 'package.json'),
        JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n', 'utf8');
    const env = Object.assign({}, process.env, {
        SUDO_AGENT_TOKEN: TOKEN,
        SUDO_AGENT_PORT: '0',
        SUDO_AGENT_PROVIDER: JSON.stringify({ type: 'local', baseUrl: provider.url, model: 'qwen2.5-coder-1.5b' }),
        SUDO_STUDIO_HOME: home,
        SUDO_STUDIO_LOGS: path.join(home, 'logs'),
        SUDO_AGENT_STORE: path.join(home, 'store'),
    });
    const child = spawn(process.execPath, [path.join(repoDir, 'sudo-agent', 'src', 'server.js')],
        { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = null;
    try {
        const hs = await agentHandshake(child);
        const s = await httpJson(hs.port, TOKEN, 'POST', '/sessions', { title: 'p55', projectRoot: proj });
        const sid = s.body.id;
        const t0 = Date.now();
        const turn = await ssePost(hs.port, TOKEN, '/sessions/' + sid + '/messages',
            { prompt: opts.prompt || DEFAULT_PROMPT }, 90000);
        const ms = Date.now() - t0;
        const sends = provider.payloads;
        const toolChoices = sends.map((p2) => (p2 && p2.tool_choice === undefined ? '(absent)' : String(p2.tool_choice)));
        const tools0 = (sends[0] && Array.isArray(sends[0].tools)) ? sends[0].tools : [];
        result = {
            rev,
            calls: sends.length,
            toolChoice: toolChoices.join(' | ') || '(aucun appel)',
            forcedJson: toolChoices.some((x) => x === 'required'),
            toolCount: tools0.length,
            hasReply: tools0.some((t) => t && t.function && (t.function.name === 'reply' || t.function.name === 'done')),
            events: turn.named.join(',').slice(0, 120),
            status: (turn.last && (turn.last.status || turn.last.runStatus)) || (turn.status === 200 ? 'TERMINE?' : 'HTTP ' + turn.status),
            reason: (turn.last && (turn.last.reason || turn.last.stopReason)) || '',
            errorCode: (function () {
                const err = turn.events.filter((e) => e && (e.type === 'turn.error' || e.code)).pop();
                return err ? String(err.code || err.type) : '';
            })(),
            ms,
        };
    } catch (e) {
        result = { rev, error: String((e && e.message) || e).slice(0, 200), calls: provider.payloads.length };
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        await provider.close();
    }
    return result;
}

function worktreeFor(repo, rev) {
    const dir = path.join(tmp('p55wt'), 'wt');
    execSync('git -C ' + JSON.stringify(repo) + ' worktree add --detach ' + JSON.stringify(dir) + ' ' + rev,
        { stdio: 'pipe' });
    return dir;
}

function removeWorktree(repo, dir) {
    try { execSync('git -C ' + JSON.stringify(repo) + ' worktree remove --force ' + JSON.stringify(dir), { stdio: 'pipe' }); }
    catch (_) { /* best effort */ }
}

(async () => {
    const repo = String(arg('repo', process.cwd()));
    const revs = String(arg('revs', 'b8e60c5,e653162,fb23235,6449dae,e673dc6,71dd8b0')).split(',').map((s) => s.trim()).filter(Boolean);
    const prompt = String(arg('prompt', DEFAULT_PROMPT));
    const incident = process.argv.indexOf('--incident') !== -1;
    const asJson = process.argv.indexOf('--json') !== -1;
    const rows = [];
    for (const rev of revs) {
        let dir = null;
        let row = null;
        try {
            dir = worktreeFor(repo, rev);
            row = await runOnce(dir, rev, { prompt, incident });
        } catch (e) {
            row = { rev, error: String((e && e.message) || e).slice(0, 200) };
        } finally {
            if (dir) removeWorktree(repo, dir);
        }
        rows.push(row);
        if (!asJson) {
            console.log(row.error
                ? (rev + '  ERROR ' + row.error)
                : (rev + '  tool_choice=' + row.toolChoice + '  tools=' + row.toolCount +
                   '  reply/done=' + row.hasReply + '  status=' + row.status +
                   '  err=' + (row.errorCode || '-') + '  events=' + (row.events || '-') +
                   '  calls=' + row.calls));
        }
        await sleep(200);
    }
    if (asJson) console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
})();
