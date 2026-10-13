/**
 * SUDO STUDIO - Agent engine (MISSION P3: OpenCode-based, replaces v3 logic).
 *
 * The old in-house logic (hardcoded fallback plan, scaffolding generator,
 * embedded templates, ai_generate, self-declared verification, sessions in
 * .sudo/agent) is DELETED. This engine drives a pinned local OpenCode server
 * (see OpenCodeDriver + opencode.manifest.json) inside the open project:
 * - Build (default, asks before edits/bash) / Plan (read-only) modes
 * - per-tool permissions: once / session / always-in-project / deny
 * - writes outside the project are always auto-denied
 * - undo of the last run via opencode message revert (native snapshots)
 * - HONEST status: TERMINE only if the run finished AND no unresolved tool
 *   error AND the real before/after file list is reported; else ECHEC/PARTIEL.
 * - project AGENTS.md is injected as system instructions.
 *
 * Kept API (existing UI keeps loading until PROMPT 4): constructor({projectRoot}),
 * run(task), stop(), resolveApproval(x), events step/tool_call/error/
 * approval_needed/done, plus query()/chatQuery() (P2 model-call paths).
 * ASCII-only.
 */
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getAIProviderService } = require('../services/AIProviderService');
const { getSecretsStore } = require('../services/extensionContext');
const { getCentralDir } = require('../utils/auditLog');
const { OpenCodeDriver, RUNTIME_BASE_URL } = require('./OpenCodeDriver');
const sandbox = require('./sandbox'); // P8: command policy + audit + watchdog

const AI_TIMEOUT_MS = 120000;
const STATUS = { DONE: 'TERMINE', FAIL: 'ECHEC', PARTIAL: 'PARTIEL' };
const MAX_SNAPSHOT_FILES = 50000;

// ---------------------------------------------------------------- helpers

function readAgentsMd(projectRoot) {
    try {
        const p = path.join(projectRoot, 'AGENTS.md');
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').slice(0, 20000);
    } catch (_) { /* none */ }
    return '';
}

function snapshotFiles(root) {
    const out = new Map();
    let truncated = false;
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (out.size >= MAX_SNAPSHOT_FILES) { truncated = true; return; }
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full);
            if (e.name === '.git' && rel.split(path.sep).indexOf('.git') === 0) continue;
            try {
                if (e.isDirectory()) { walk(full); continue; }
                if (!e.isFile()) continue;
                const st = fs.statSync(full);
                out.set(rel, { size: st.size, mtime: st.mtimeMs });
            } catch (_) { /* transient */ }
        }
    };
    walk(root);
    return { files: out, truncated };
}

function diffSnapshots(before, after) {
    const added = [], modified = [], deleted = [];
    for (const [rel, a] of after.files) {
        const b = before.files.get(rel);
        if (!b) added.push(rel);
        else if (b.size !== a.size || b.mtime !== a.mtime) modified.push(rel);
    }
    for (const rel of before.files.keys()) {
        if (!after.files.has(rel)) deleted.push(rel);
    }
    added.sort(); modified.sort(); deleted.sort();
    return { added, modified, deleted };
}

function isPathInside(root, p) {
    try {
        const r = path.resolve(root);
        const q = path.resolve(r, p);
        return q === r || q.startsWith(r + path.sep);
    } catch (_) { return false; }
}

/** Collect candidate paths from an opencode permission request. */
function extractPaths(perm) {
    const found = [];
    const push = (v) => {
        if (typeof v === 'string' && v && v.length < 1024) found.push(v);
        else if (Array.isArray(v)) v.forEach(push);
    };
    if (perm) {
        push(perm.pattern);
        const md = perm.metadata || {};
        for (const k of Object.keys(md)) {
            if (/path|file|dir|cwd|root/i.test(k)) push(md[k]);
        }
    }
    return found;
}

function allowsPath() {
    return path.join(getCentralDir(), 'opencode-project-allows.json');
}

function loadAllows() {
    try {
        const d = JSON.parse(fs.readFileSync(allowsPath(), 'utf8'));
        if (d && typeof d === 'object') return d;
    } catch (_) { /* none */ }
    return {};
}

function projectKey(root) {
    return crypto.createHash('sha1').update(path.resolve(root)).digest('hex');
}

// ---------------------------------------------------------------- engine

class AgentEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || null;
        this.runtimeUrl = options.runtimeUrl || 'http://127.0.0.1:6000';
        this.mode = options.mode === 'plan' ? 'plan' : 'build';
        this.driver = options.driver || new OpenCodeDriver({
            projectRoot: this.projectRoot, extensionDir: options.extensionDir || null,
        });
        this._stopped = false;
        this._pending = [];   // [{perm, sessionId, resolve}]
        this._lastRun = null; // {sessionId, messageIDs, before, after}
        this._permListener = null;
        // P8 sandbox: active level (UI badge), policy lists, run watchdog.
        this.sandboxState = null;
        this._sandboxExtra = { allow: [], block: [] };
        this._runTimer = null;
        this._finished = false;
        this._sandboxDenyReason = null;
        this._sandboxDenyCommand = null;
        this._sandboxAllowReason = null;
        this._sandboxAllowCommand = null;
    }

    setMode(m) {
        if (m === 'plan' || m === 'build') this.mode = m;
    }

    // -- P2 model-call paths (kept) -------------------------------------------
    _http() { return require('axios'); }

    async query(prompt, systemContext = '', options = {}) {
        const max_tokens  = options.max_tokens  || 1024;
        const temperature = options.temperature || 0.1;
        // P2-a: cloud provider routing (shared selector). Local path below unchanged.
        try {
            const _svc = getAIProviderService();
            if (_svc.getActive().type !== 'local') {
                const _msgs = [];
                if (systemContext) _msgs.push({ role: 'system', content: 'CONTEXT:\n' + systemContext });
                _msgs.push({ role: 'user', content: prompt.trim() });
                const _r = await _svc.complete({ messages: _msgs, max_tokens, temperature, purpose: 'agent' });
                return { ok: true, reply: _r.reply, model: _r.model, mock: false, provider: _r.provider, masked: _r.masked };
            }
        } catch (_e) { return { ok: false, error: _e.message, reply: null }; }
        const fullPrompt = (systemContext ? 'CONTEXT:\n' + systemContext + '\n\n' : '') +
            'User: ' + prompt.trim() + '\nAssistant:';
        const payload = { message: fullPrompt, prompt: fullPrompt, input: fullPrompt, max_tokens, temperature };
        try {
            const r = await this._http().post(`${this.runtimeUrl}/infer`, payload, { timeout: AI_TIMEOUT_MS });
            const reply = r.data.reply || r.data.response || '';
            const mock  = r.data.mock === true;
            return { ok: true, reply, model: r.data.model, mock };
        } catch (e) {
            if (e.code === 'ECONNREFUSED') return { ok: false, error: 'Runtime offline', reply: null };
            if (e.code === 'ECONNABORTED' || (e.message || '').includes('timeout')) {
                return { ok: false, error: `Timeout after ${AI_TIMEOUT_MS}ms`, reply: null };
            }
            if (e.response && e.response.status === 503) {
                return { ok: false, noModel: true, error: 'NO_MODEL_LOADED', reply: null };
            }
            return { ok: false, error: e.message, reply: null };
        }
    }

    async chatQuery(question) {
        const logs = [];
        logs.push(`[CHAT] Querying AI: ${question.slice(0, 100)}...`);
        // P2-a: cloud provider routing (shared selector). Local path below unchanged.
        try {
            const _svc = getAIProviderService();
            if (_svc.getActive().type !== 'local') {
                const _r = await _svc.complete({ prompt: question, max_tokens: 512, temperature: 0.2, purpose: 'agent' });
                logs.push(`[CHAT] Cloud response (${(_r.reply || '').length} chars) via ${_r.provider}`);
                return { ok: true, logs, reply: _r.reply, mock: false, provider: _r.provider };
            }
        } catch (_e) { logs.push('[CHAT] ERROR: ' + _e.message); return { ok: false, error: _e.message, logs }; }
        try {
            const r = await this._http().post('http://127.0.0.1:6000/infer', {
                message: question, max_tokens: 512, temperature: 0.2
            }, { timeout: AI_TIMEOUT_MS });
            const reply = r.data.reply || r.data.response || '';
            logs.push(`[CHAT] Response (${reply.length} chars): ${reply.slice(0, 300)}`);
            return { ok: true, logs, reply, mock: r.data.mock === true };
        } catch (e) {
            logs.push(`[CHAT] ERROR: ${e.message}`);
            return { ok: false, error: e.message, logs };
        }
    }

    // -- main run ---------------------------------------------------------------
    async _providerSpec() {
        const svc = getAIProviderService();
        const active = svc.getActive();
        if (!active || active.type === 'local') {
            // Fast pre-check: runtime + loaded model, else fail in seconds.
            let model = null;
            try {
                const r = await this._http().get(`${this.runtimeUrl}/v1/models`, { timeout: 5000 });
                const ids = ((r.data && r.data.data) || []).map(m => m.id).filter(Boolean);
                if (!ids.length) throw new Error('NO_MODEL_LOADED');
                model = ids[0];
            } catch (e) {
                throw new Error(e.message === 'NO_MODEL_LOADED'
                    ? 'NO_MODEL_LOADED (load a model in Runtime)'
                    : 'Runtime offline (http://127.0.0.1:6000 unreachable)');
            }
            return { providerType: 'local', baseUrl: RUNTIME_BASE_URL, model, providerID: 'openai', modelID: model };
        }
        const chk = svc.checkCloudAllowed(active);
        if (!chk.ok) throw new Error(chk.error);
        let key = null;
        try { key = await getSecretsStore().get('sudoAi.provider.' + active.id); } catch (_) { key = null; }
        if (!key) throw new Error('no API key in SecretStorage for provider ' + active.name);
        return { providerType: 'cloud', baseUrl: active.baseUrl.replace(/\/+$/, ''),
            model: active.model, apiKey: key, providerID: 'sudo-cloud', modelID: active.model };
    }

    async run(task, opts = {}) {
        const prompt = typeof task === 'string' ? task : (task.prompt || '');
        const mode = opts.mode || (typeof task === 'object' && task.mode) || this.mode || 'build';
        this._stopped = false;
        this._pending = [];
        this._lastRun = null;
        this._finished = false;
        this._emit('step', { phase: 'start', message: `Sudo Agent (OpenCode) started - mode=${mode}` });
        if (!prompt.trim()) return this._finish(STATUS.FAIL, 'empty task', [], null);
        if (!this.projectRoot || !fs.existsSync(this.projectRoot)) {
            return this._finish(STATUS.FAIL, 'no project folder open (open a folder first)', [], null);
        }
        let spec;
        try {
            spec = await this._providerSpec();
        } catch (e) {
            return this._finish(STATUS.FAIL, e.message, [], null);
        }
        try {
            // P8: sandbox level requested by the UI (auto/l1/l2) + policy lists.
            spec.sandbox = {
                mode: opts.sandboxMode === 'l1' || opts.sandboxMode === 'l2'
                    ? opts.sandboxMode : 'auto',
            };
            if (opts.localOnly !== undefined) spec.sandbox.localOnly = !!opts.localOnly;
            this._sandboxExtra = this._loadSandboxLists();
            await this.driver.start(spec);
        } catch (e) {
            return this._finish(STATUS.FAIL, 'agent server: ' + e.message, [], null);
        }
        // P8: report the REAL active level to the UI badge (never faked).
        try {
            this.sandboxState = this.driver.getSandboxState();
            this._emit('sandbox', Object.assign({ requested: spec.sandbox.mode }, this.sandboxState));
        } catch (_) { /* stub drivers in tests may lack getSandboxState */ }
        // P8: run-level watchdog (delai maximal). The timer promise rejects
        // the postMessage race below, so a hung model call cannot wedge run().
        // Unref'd so tests and idle hosts never hang; noop-caught so a timer
        // firing before the race attaches is still a handled rejection.
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs)
            : sandbox.RUN_TIMEOUT_DEFAULT_MS;
        const runT0 = Date.now();
        let timedOut = false;
        this._clearRunTimer();
        const runTimer = new Promise((_, reject) => {
            this._runTimer = setTimeout(() => {
                timedOut = true;
                reject(this._timeoutRun(timeoutMs));
            }, timeoutMs);
            if (this._runTimer && typeof this._runTimer.unref === 'function') {
                this._runTimer.unref();
            }
        });
        runTimer.catch(() => {});
        const before = snapshotFiles(this.projectRoot);
        let session;
        try {
            session = await this.driver.createSession(prompt.slice(0, 80));
        } catch (e) {
            return this._finish(STATUS.FAIL, 'session: ' + e.message, [], null);
        }
        const sid = session.id;
        const agentsMd = readAgentsMd(this.projectRoot);
        const system = (agentsMd ? agentsMd + '\n\n' : '') +
            (mode === 'plan' ? 'READ-ONLY MODE: analyze and propose, do not modify anything.' : '');
        const userMid = 'usr_' + crypto.randomBytes(8).toString('hex');
        const body = {
            messageID: userMid,
            model: { providerID: spec.providerID, modelID: spec.modelID },
            agent: mode === 'plan' ? 'plan' : 'build',
            system,
            parts: [{ type: 'text', text: prompt }],
        };
        if (mode === 'plan') {
            body.tools = { write: false, edit: false, apply_patch: false, bash: false, task: false };
        }
        this._permListener = (perm) => this._onPermission(sid, perm).catch((e) => {
            this._emit('error', { message: 'permission flow: ' + e.message });
        });
        this.driver.on('permission', this._permListener);
        this.driver.on('bus', this._onBus.bind(this));
        this.driver.startEvents();
        let resp;
        try {
            resp = await Promise.race([this.driver.postMessage(sid, body), runTimer]);
        } catch (e) {
            this._cleanupEvents();
            if (timedOut) return this._finish(STATUS.FAIL, e.message, [], sid);
            if (this._stopped) return this._finish(STATUS.FAIL, 'stopped by user', [], sid);
            return this._finish(STATUS.FAIL, 'model connection: ' + e.message, [], sid);
        }
        this._auditToolParts(resp, Date.now() - runT0);
        this._cleanupEvents();
        const after = snapshotFiles(this.projectRoot);
        const files = diffSnapshots(before, after);
        const flat = [...files.added, ...files.modified, ...files.deleted];
        this._lastRun = { sessionId: sid, messageIDs: [userMid, resp && resp.info && resp.info.id].filter(Boolean),
            before, after };
        // -- honest verdict --
        const info = (resp && resp.info) || {};
        const parts = (resp && resp.parts) || [];
        const toolErrors = parts.filter(p => p && p.type === 'tool' && p.state && p.state.status === 'error');
        // P4-d/c: assistant text for the conversation UI (additive; verdict logic unchanged).
        const reply = parts
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text).join('\n').slice(0, 20000);
        if (info.error) {
            const em = (info.error && (info.error.data || info.error.message)) || info.error;
            return this._finish(STATUS.FAIL, 'model error: ' + JSON.stringify(em).slice(0, 300), flat, sid, reply);
        }
        const finishReason = parts.filter(p => p && p.type === 'step-finish').map(p => p.reason).join(',');
        if (toolErrors.length) {
            const first = toolErrors[0].state && toolErrors[0].state.error;
            const reason = `${toolErrors.length} tool error(s); first: ${String(first).slice(0, 200)}`;
            if (!flat.length) return this._finish(STATUS.FAIL, reason, flat, sid, reply);
            return this._finish(STATUS.PARTIAL, reason + ` | step-finish: ${finishReason || '?'}`, flat, sid, reply);
        }
        if (mode === 'plan' && flat.length) {
            return this._finish(STATUS.PARTIAL, 'plan mode modified files (should be read-only)', flat, sid, reply);
        }
        return this._finish(STATUS.DONE,
            `finished (${parts.length} parts${finishReason ? ', ' + finishReason : ''})`, flat, sid, reply);
    }

    _finish(status, reason, filesModified, sessionId, reply = '') {
        if (this._finished) return { status, reason, filesModified, sessionId };
        this._finished = true;
        this._clearRunTimer();
        const summary = { status, reason, reply, filesModified, sessionId, mode: this.mode,
            at: new Date().toISOString() };
        this._emit('done', summary);
        return summary;
    }

    _onBus(ev) {
        if (!ev) return;
        if (ev.type === 'message.updated' && ev.properties && ev.properties.info) {
            const info = ev.properties.info;
            this._emit('step', { phase: 'message', message: `${info.role} message ${info.id}` });
        }
    }

    // -- P8 sandbox helpers -------------------------------------------------------
    _loadSandboxLists() {
        try {
            const file = path.join(getCentralDir(), 'central_policies.json');
            const raw = fs.readFileSync(file, 'utf8');
            return sandbox.coerceLists(JSON.parse(raw));
        } catch (_) {
            return { allow: [], block: [] };
        }
    }

    _clearRunTimer() {
        if (this._runTimer) {
            try { clearTimeout(this._runTimer); } catch (_) {}
            this._runTimer = null;
        }
    }

    _timeoutRun(timeoutMs) {
        this._runTimer = null;
        this._stopped = true;
        this._emit('step', { phase: 'timeout', message: 'delai maximal depasse, arret du run' });
        sandbox.auditTimeout({ afterMs: timeoutMs });
        for (const p of this._pending.splice(0)) {
            try { p.resolve(); } catch (_) {}
            try { this.driver.replyPermission(p.sessionId, p.perm.id, 'reject').catch(() => {}); }
            catch (_) {}
        }
        try { this._cleanupEvents(); } catch (_) {}
        try {
            const r = this.driver.stop();
            if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (_) {}
        return new Error('delai maximal depasse (' + Math.round(timeoutMs / 1000) + 's)');
    }

    _auditToolParts(resp, runElapsedMs) {
        try {
            const parts = (resp && resp.parts) || [];
            for (const p of parts) {
                if (!p || p.type !== 'tool') continue;
                const ex = sandbox.extractToolExec(p);
                sandbox.auditExec({ tool: ex.tool, command: ex.command, status: ex.status,
                    exitCode: ex.exitCode, timeMs: ex.timeMs, observedAtMs: runElapsedMs });
            }
        } catch (_) { /* audit never breaks the run */ }
    }

    _isCommandPerm(perm) {
        const t = String((perm && perm.type) || '');
        if (t === 'bash' || t === 'shell' || t === 'execute' || t === 'exec' ||
            t === 'command' || t === 'run') return true;
        const fileish = ['edit', 'write', 'read', 'glob', 'grep', 'apply_patch', 'task',
            'webfetch', 'websearch', 'external_directory', 'todowrite', 'todoread', 'create'];
        if (fileish.indexOf(t) !== -1) return false;
        // Unknown tool carrying a command-looking pattern: inspect, ask by default.
        return sandbox.extractCommand(perm) !== '';
    }

    // -- permissions --------------------------------------------------------------
    _projectAllows() {
        const all = loadAllows();
        return all[projectKey(this.projectRoot)] || [];
    }

    _evaluatePermission(perm) {
        if (!perm) return null;
        // "Always in this project": driver-side allowlist (global storage, never the project).
        const allows = this._projectAllows();
        const pat = Array.isArray(perm.pattern) ? perm.pattern.join(',') : (perm.pattern || '');
        if (allows.some(a => a.tool === perm.type && (a.pattern || '') === pat)) return 'once';
        // Writes outside the project: always refused.
        if (perm.type === 'external_directory') return 'deny';
        // P8: symlink-aware containment for file tools (legacy check kept below).
        if (perm.type === 'edit' || perm.type === 'write' || perm.type === 'apply_patch' ||
            perm.type === 'create') {
            const v = sandbox.evaluateEdit(extractPaths(perm), { projectRoot: this.projectRoot });
            if (v.verdict === 'deny') {
                this._sandboxDenyReason = v.reason;
                return 'deny';
            }
        }
        if (perm.type === 'edit') {
            for (const p of extractPaths(perm)) {
                if (!isPathInside(this.projectRoot, p)) return 'deny';
            }
        }
        // P8: command allow/block lists + danger patterns for shell tools.
        if (this._isCommandPerm(perm)) {
            const cmd = sandbox.extractCommand(perm);
            const v = sandbox.evaluateBash(cmd, { projectRoot: this.projectRoot,
                extraAllow: this._sandboxExtra.allow, extraBlock: this._sandboxExtra.block });
            if (v.verdict === 'deny') {
                this._sandboxDenyReason = v.reason;
                this._sandboxDenyCommand = cmd;
                return 'deny';
            }
            if (v.verdict === 'allow') {
                this._sandboxAllowReason = v.reason;
                this._sandboxAllowCommand = cmd;
                return 'once';
            }
        }
        return null; // ask the user
    }

    async _onPermission(sessionId, perm) {
        const auto = this._evaluatePermission(perm);
        if (auto === 'deny') {
            await this.driver.replyPermission(sessionId, perm.id, 'reject');
            const reason = this._sandboxDenyReason || 'outside project';
            this._sandboxDenyReason = null;
            this._emit('step', { phase: 'permission', message: `auto-denied ${perm.type} (${reason})` });
            sandbox.auditPerm({ tool: perm.type, verdict: 'deny', reason,
                command: this._sandboxDenyCommand || '' });
            this._sandboxDenyCommand = null;
            return;
        }
        if (auto === 'once') {
            await this.driver.replyPermission(sessionId, perm.id, 'once');
            const why = this._sandboxAllowReason;
            this._sandboxAllowReason = null;
            this._emit('step', { phase: 'permission',
                message: why ? `auto-allowed ${perm.type} (${why})`
                    : `auto-allowed ${perm.type} (project rule)` });
            if (why) {
                sandbox.auditPerm({ tool: perm.type, verdict: 'allow', reason: why,
                    command: this._sandboxAllowCommand || '' });
            }
            this._sandboxAllowCommand = null;
            return;
        }
        await new Promise((resolve) => {
            this._pending.push({ perm, sessionId, resolve });
            this._emit('approval_needed', {
                id: perm.id, action: perm.type, title: perm.title || perm.type,
                description: JSON.stringify({ pattern: perm.pattern || null,
                    metadata: perm.metadata || null }).slice(0, 500),
            });
        });
    }

    async resolveApproval(resp) {
        const next = this._pending.shift();
        if (!next) return { ok: false, error: 'no pending approval' };
        let opencode = 'reject';
        if (resp === true || resp === 'once') opencode = 'once';
        else if (resp === 'session' || resp === 'always') opencode = 'always';
        else if (resp === 'project') {
            opencode = 'once';
            try {
                const all = loadAllows();
                const k = projectKey(this.projectRoot);
                all[k] = all[k] || [];
                const pat = Array.isArray(next.perm.pattern) ? next.perm.pattern.join(',') : (next.perm.pattern || '');
                if (!all[k].some(a => a.tool === next.perm.type && (a.pattern || '') === pat)) {
                    all[k].push({ tool: next.perm.type, pattern: pat });
                    fs.writeFileSync(allowsPath(), JSON.stringify(all, null, 2));
                }
            } catch (_) { /* allowlist is best-effort */ }
        }
        try {
            await this.driver.replyPermission(next.sessionId, next.perm.id, opencode);
        } finally {
            next.resolve();
        }
        // P8: user decisions are audited like automatic ones (actor=user).
        sandbox.auditPerm({ tool: next.perm.type,
            verdict: opencode === 'reject' ? 'deny' : 'allow',
            reason: 'decision utilisateur (' + opencode + ')',
            command: this._isCommandPerm(next.perm) ? sandbox.extractCommand(next.perm) : '',
            actor: 'user' });
        return { ok: true, response: opencode };
    }

    // -- undo -----------------------------------------------------------------------
    async undoLastRun() {
        const run = this._lastRun;
        if (!run) return { ok: false, error: 'no run to undo' };
        try {
            for (const mid of [...run.messageIDs].reverse()) {
                await this.driver.revertMessage(run.sessionId, mid);
            }
        } catch (e) {
            return { ok: false, error: 'revert failed: ' + e.message };
        }
        const now = snapshotFiles(this.projectRoot);
        const restored = diffSnapshots(now, run.after);
        const files = [...restored.added, ...restored.modified, ...restored.deleted];
        this._lastRun = null;
        return { ok: true, restored: files };
    }

    stop() {
        this._stopped = true;
        this._clearRunTimer();
        for (const p of this._pending.splice(0)) {
            try { p.resolve(); } catch (_) {}
            this.driver.replyPermission(p.sessionId, p.perm.id, 'reject').catch(() => {});
        }
        this._cleanupEvents();
        return this.driver.stop();
    }

    _cleanupEvents() {
        try {
            if (this._permListener) this.driver.removeListener('permission', this._permListener);
            this.driver.removeAllListeners('bus');
        } catch (_) {}
        try { this.driver.stopEvents(); } catch (_) {}
        this._permListener = null;
    }

    _emit(event, data) {
        this.emit(event, data);
    }
}

module.exports = {
    AgentEngine, STATUS,
    _p3helpers: { snapshotFiles, diffSnapshots, isPathInside, extractPaths, readAgentsMd, projectKey },
};
