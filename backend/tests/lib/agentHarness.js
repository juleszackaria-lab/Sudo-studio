/**
 * SUDO STUDIO - P61: shared harness that drives the REAL packaged agent
 * (sudo-agent/src/loop.js) against a fake provider, in a temporary project.
 *
 * Nothing is stubbed inside the agent: same loop, same tools, same
 * permissions, same journal. Only the model is fake - which is exactly what
 * the P61 rules allow ("un harnais a modele simule ne prouve que le
 * comportement de l'agent").
 *
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');

process.env.SUDO_AGENT_CTX_TOKENS = process.env.SUDO_AGENT_CTX_TOKENS || '32768';

const { runTurn, resolveTurnApproval } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));
const { createFakeProvider, providerOf } = require('./fakeProvider');

function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

const call = (name, args) => ({ call: { name, args: args || {} } });
const calls = (...list) => ({ calls: list.map(([name, args]) => ({ name, args: args || {} })) });
const text = (content) => ({ text: content });

/**
 * opts: { project (dir), files {rel:content}, script [], autoApprove,
 *         env {}, waitMs, sessionTitle }
 */
function createWorld(opts) {
    opts = opts || {};
    const proj = opts.project || tmp('p61proj');
    for (const rel of Object.keys(opts.files || {})) {
        const full = path.join(proj, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, opts.files[rel]);
    }
    const home = tmp('p61home');
    const logsDir = path.join(home, 'logs');
    const log = createLogger({ logsDir, component: 'agent' });
    const store = new SessionStore({ storeDir: path.join(home, 'store') });
    const s = store.create({ title: opts.sessionTitle || 'p61', projectRoot: proj });
    const rules = new Map();
    rules.set(s.id, new Set());
    const w = {
        proj, home, logsDir, log, store, sessionId: s.id, rules,
        pending: new Map(), waiters: new Map(), seq: 0, events: [],
    };
    w.toolsCtx = () => ({ home, sessionRules: rules, pending: w.pending, waiters: w.waiters });

    w.turn = async (prompt, script, o) => {
        o = o || {};
        const fake = await createFakeProvider(script);
        const events = [];
        const saved = {};
        for (const k of Object.keys(o.env || {})) { saved[k] = process.env[k]; process.env[k] = o.env[k]; }
        try {
            w.seq += 1;
            const p = runTurn({
                store, sessionId: w.sessionId, prompt,
                corr: o.corr || ('p61-' + w.seq),
                provider: providerOf(fake),
                toolsCtx: w.toolsCtx(), runs: new Map(), log,
                onEvent: (e) => { try { events.push(e); w.events.push(e); } catch (_) {} },
                maxIt: o.maxIt,
                runtimeWait: o.runtimeWait,
            });
            const auto = o.autoApprove;
            if (auto) {
                let settled = false;
                p.then(() => { settled = true; }, () => { settled = true; });
                const t0 = Date.now();
                const limit = o.waitMs || 25000;
                while (!settled && Date.now() - t0 < limit) {
                    for (const id of Array.from(w.waiters.keys())) {
                        try { resolveTurnApproval(w.toolsCtx(), id, auto); } catch (_) {}
                    }
                    await new Promise((r) => setTimeout(r, 20));
                }
            }
            const out = await p;
            const end = store.get(w.sessionId);
            let journal = '';
            try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
            // Tool executions of the run: meta.lastRun.calls is the on-disk
            // record (works on old and new code alike).
            const lastRun = (end && end.meta && end.meta.lastRun) || {};
            const calls = Array.isArray(lastRun.calls) ? lastRun.calls : [];
            return { out, end, events, chats: fake.chats, journal, calls, lastRun,
                msgs: (end && end.messages) || [] };
        } finally {
            for (const k of Object.keys(o.env || {})) {
                if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
            }
            await fake.close();
        }
    };

    w.read = (rel) => { try { return fs.readFileSync(path.join(proj, rel), 'utf8'); } catch (_) { return null; } };
    w.exists = (rel) => fs.existsSync(path.join(proj, rel));
    w.meta = () => { const cur = store.get(w.sessionId); return (cur && cur.meta) || {}; };
    return w;
}

/** Tool calls the agent really executed (from meta.lastRun.calls). */
function executed(result) {
    if (!result) return [];
    if (Array.isArray(result.calls)) return result.calls;
    const lr = result.lastRun || (result.end && result.end.meta && result.end.meta.lastRun) || {};
    return Array.isArray(lr.calls) ? lr.calls : [];
}

/** Count entries of the journal (one line per tool execution). */
function journalLines(journal, needle) {
    return String(journal || '').split('\n').filter((l) => l.indexOf(needle) !== -1);
}

/** Last assistant text stored in the session (what the user sees). */
function lastAssistant(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'assistant' && msgs[i].content) return String(msgs[i].content);
    }
    return '';
}

module.exports = { createWorld, call, calls, text, executed, journalLines, lastAssistant, tmp, AGENT_SRC, ROOT };
