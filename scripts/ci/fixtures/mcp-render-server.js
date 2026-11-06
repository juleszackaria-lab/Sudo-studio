#!/usr/bin/env node
/**
 * Serveur MCP "render" factice (P57-8) - stdio JSON-RPC, zero dependance.
 *
 * Outils exposes :
 *   deploy(service, commit)  -> declenche un deploiement (respecte RENDER_TOKEN
 *                              s'il est present : preuve que le secret arrive
 *                              par l'environnement, jamais par le modele)
 *   status(deployId)         -> etat du deploiement
 *
 * Deux modes de panne, pour les tests :
 *   MCP_RENDER_OFFLINE=1  -> repond une erreur a chaque requete (serveur
 *                            "hors ligne" vu par l'agent)
 *   MCP_RENDER_SLOW_MS=n  -> delai avant reponse
 *
 * Le serveur n'ecrit QUE sur stdout (protocole) : les traces vont sur stderr.
 */
'use strict';

const OFFLINE = process.env.MCP_RENDER_OFFLINE === '1';
const SLOW = parseInt(process.env.MCP_RENDER_SLOW_MS || '0', 10) || 0;
const HAS_TOKEN = !!(process.env.RENDER_TOKEN && String(process.env.RENDER_TOKEN).length > 0);
const deploys = new Map();
let seq = 0;

function send(obj) {
    try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) { /* ignore */ }
}

function toolList() {
    return [
        { name: 'deploy', description: 'Declenche un deploiement Render pour un service.',
            inputSchema: { type: 'object', properties: { service: { type: 'string' }, commit: { type: 'string' } }, required: ['service'] } },
        { name: 'status', description: 'Etat d un deploiement Render.', inputSchema: { type: 'object', properties: { deployId: { type: 'string' } }, required: ['deployId'] } },
    ];
}

function call(name, args) {
    if (OFFLINE) {
        const e = new Error('render: connexion refusee (serveur hors ligne)');
        e.code = -32000;
        throw e;
    }
    if (name === 'deploy') {
        if (!HAS_TOKEN) {
            return { content: [{ type: 'text', text: 'ERREUR : jeton Render absent (variable RENDER_TOKEN non injectee).' }], isError: true };
        }
        seq += 1;
        const id = 'dep_' + seq;
        deploys.set(id, { service: String(args.service || '?'), commit: String(args.commit || 'HEAD'), state: 'live' });
        return { content: [{ type: 'text', text: JSON.stringify({ deployId: id, service: args.service, commit: args.commit || 'HEAD', state: 'live', url: 'https://' + String(args.service || 'app') + '.onrender.com' }) }] };
    }
    if (name === 'status') {
        const d = deploys.get(String(args.deployId || ''));
        if (!d) return { content: [{ type: 'text', text: 'ERREUR : deploiement inconnu ' + String(args.deployId || '') }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(Object.assign({ deployId: args.deployId }, d)) }] };
    }
    throw new Error('outil inconnu : ' + name);
}

let buf = '';
process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        const respond = () => {
            if (msg.id === undefined || msg.id === null) return; // notification
            try {
                if (msg.method === 'initialize') {
                    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'render', version: '1.0.0' } } });
                } else if (msg.method === 'tools/list') {
                    send({ jsonrpc: '2.0', id: msg.id, result: { tools: toolList() } });
                } else if (msg.method === 'tools/call') {
                    const p = msg.params || {};
                    try {
                        const r = call(String(p.name || ''), p.arguments || {});
                        send({ jsonrpc: '2.0', id: msg.id, result: r });
                    } catch (e) {
                        send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32000, message: String((e && e.message) || e) } });
                    }
                } else {
                    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'methode inconnue : ' + String(msg.method) } });
                }
            } catch (e) {
                send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } });
            }
        };
        if (SLOW > 0) setTimeout(respond, SLOW); else respond();
    }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.on('error', () => { /* ignore */ });
