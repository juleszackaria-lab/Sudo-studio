'use strict';
// AgentEngine (P27): drives the sudo-agent HTTP server (local child process).
//
// This replaces the P3 third-party engine (deleted with its driver): there
// is no subprocess here, no driver, no TUI scraping. Transport is an
// AgentServer instance (owns port/token/auth + supervision); the engine only
// speaks HTTP (JSON + SSE) and translates server events into panel events.
//
// Server vocabulary (sudo-agent): sessions, modes (build|plan), SSE events
// turn.start / message.delta / message.done / tool.start / tool.result /
// turn.done / turn.error, approvals polling (GET/POST .../approvals),
// undo (POST .../undo), abort (POST .../abort).
//
// Panel vocabulary (kept from P4/P5 contracts):
//   methods: run() / query() / chatQuery() / stop() / setMode() /
//            resolveApproval() / undoLastRun() / listSessions() / deleteSession()
//   legacy events (.on): delta / step / tool / approval_needed /
//            approval_resolved / done / error
//   raw events (opts.onEvent): { type: delta|tool|perm|turn|done|error, ... }
//
// One in-flight run per engine (chat and agent share a single loaded model:
// a second run is refused with a clear message, never queued silently).
// Source is ASCII-only (P4 M-check).

const { EventEmitter } = require('events');

const SERVER_OFFLINE =
    'Serveur agent hors ligne. Relancez-le (bouton Relancer) puis reessayez.';
const NO_SESSION =
    'Session agent introuvable (supprimee ou expiree). Relancez une tache.';
const DECISIONS = ['once', 'session', 'project', 'deny'];

function shortText(v, n) {
    const t = String(v == null ? '' : v);
    return t.length > n ? t.slice(0, n) + '...' : t;
}

// Map a provider-gate failure (extension side: policy / key / license /
// local probe) to a panel reason. NO_MODEL / offline markers are preserved
// so panels keep their noModel mapping (P4 G1).
function mapGateError(e) {
    const msg = shortText((e && e.message) || e, 400) || 'Provider inutilisable.';
    if (/NO_MODEL_LOADED|aucun modele|no[ _-]?model/i.test(msg)) {
        return { kind: 'provider', noModel: true,
            reason: 'NO_MODEL_LOADED (' + msg + ')' };
    }
    if (/offline|hors ligne|injoignable|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
        return { kind: 'provider', reason: 'Runtime offline (' + msg + ')' };
    }
    return { kind: 'provider', reason: msg };
}

// Map a server-call failure (stream() rejection or request() transport
// error) to { kind, reason, noModel }.
function mapServerError(e, stopRequested) {
    const code = (e && e.code) || '';
    const status = (e && e.status) || 0;
    const msg = shortText((e && e.message) || e, 400);
    if (stopRequested && (code === 'aborted' || /abort/i.test(msg))) {
        return { kind: 'stopped', reason: 'Interrompu par l\'utilisateur.' };
    }
    if (status === 409) {
        return { kind: 'busy', reason: 'Un tour est deja en cours sur cette session.' };
    }
    if (code === 'no_model') {
        return { kind: 'provider', noModel: true,
            reason: 'NO_MODEL_LOADED (Aucun modele charge sur le runtime local.)' };
    }
    if (code === 'runtime_offline') {
        return { kind: 'provider',
            reason: 'Runtime offline (runtime local hors ligne : demarrez le runtime.)' };
    }
    if (code === 'bad_config' || status === 503) {
        return { kind: 'provider', reason: 'Provider mal configure : ' + (msg || 'verifiez le provider actif.') };
    }
    if (code === 'provider_error' || code === 'provider_unreachable' || status === 502) {
        return { kind: 'provider', reason: msg || 'Erreur du fournisseur.' };
    }
    if (/ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|ECONNRESET|EPIPE/i.test(msg) ||
            code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        return { kind: 'server', reason: SERVER_OFFLINE };
    }
    if (status === 404) {
        return { kind: 'server', reason: NO_SESSION };
    }
    return { kind: 'error', reason: msg || 'Echec du tour.' };
}

class AgentEngine extends EventEmitter {
    constructor(opts = {}) {
        super();
        this._server = opts.server || null;
        // Gate: async () => cfg, throws localized errors (policy/key/license).
        // A plain object means "no gate" (tests / direct use).
        this._provider = opts.provider || null;
        this._projectRoot = opts.projectRoot || null;
        this._mode = opts.mode === 'plan' ? 'plan' : 'build';
        this._onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
        this._pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 900;
        this._streamTimeoutMs = Number(opts.streamTimeoutMs) > 0
            ? Number(opts.streamTimeoutMs) : 600000;
        this._running = false;
        this._stopRequested = false;
        this._sessionIds = { build: null, plan: null }; // mode -> session id
        this._sessionRoots = {}; // session id -> projectRoot at creation
        this._lastSessionId = null;
        this._lastMode = this._mode;
        this._pending = new Map(); // reqId -> { sessionId, request }
        this._decided = []; // outcomes of this/last run (for continueAfterApproval)
        this._pollTimer = null;
        this._pollFails = 0;
    }

    // -- configuration ------------------------------------------------------
    setServer(srv) { this._server = srv || null; }
    setProjectRoot(p) { this._projectRoot = p || null; }
    setMode(m) {
        if (m === 'plan') this._mode = 'plan';
        else if (m === 'build' || m === 'agent') this._mode = 'build';
    }
    get mode() { return this._mode; }
    isRunning() { return this._running; }
    lastSessionId() { return this._lastSessionId; }

    _serverReady() {
        return !!(this._server && this._server.started && this._server.port);
    }

    // -- events ---------------------------------------------------------------
    _raw(type, obj) {
        if (!this._onEvent) return;
        try { this._onEvent(Object.assign({ type }, obj)); } catch (_) {}
    }
    _leg(name, data) {
        // 'error' without listeners throws on EventEmitter: guard it.
        if (name === 'error' && this.listenerCount('error') === 0) return;
        try { this.emit(name, data); } catch (_) {}
    }

    // Terminal failure: emits error + done (both vocabularies) and returns
    // the { ok:false } result. Panels show the message; kind 'server' also
    // offers the Relancer button.
    _fail(kind, reason, extra = {}) {
        this._running = false;
        this._stopPoll();
        const d = Object.assign({
            status: 'ECHEC', reason, reply: '', sessionId: this._lastSessionId,
            filesModified: [], filesRead: [], turns: 0, mode: this._lastMode,
            noModel: false, kind,
        }, extra);
        this._raw('error', { message: reason, kind, sessionId: d.sessionId });
        this._leg('error', { message: reason, kind, sessionId: d.sessionId });
        this._raw('done', Object.assign({ ok: false }, d));
        this._leg('done', d);
        return Object.assign({ ok: false, error: reason }, d);
    }

    // -- runs -----------------------------------------------------------------
    // options: { prompt, mode ('build'|'plan'), resumeSessionId, title }.
    // Returns { ok, status, reason, reply, sessionId, filesModified,
    //           filesRead, turns, mode, noModel, kind? }.
    async run(opts = {}) {
        const prompt = opts.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return this._fail('error', 'Prompt vide.');
        }
        if (this._running) {
            return this._fail('busy', 'Une tache agent est deja en cours. ' +
                'Attendez sa fin ou arretez-la avant d\'en lancer une autre.');
        }
        const mode = opts.mode === 'plan' ? 'plan'
            : (opts.mode === 'build' ? 'build' : this._mode);
        const serverMode = mode; // server modes are build|plan (P26-a)
        if (!this._serverReady()) {
            return this._fail('server', SERVER_OFFLINE);
        }
        this._running = true;
        this._stopRequested = false;
        this._lastMode = mode;
        this._decided = [];
        if (typeof this._provider === 'function') {
            try { await this._provider(); }
            catch (e) {
                const m = mapGateError(e);
                return this._fail(m.kind, m.reason, { noModel: !!m.noModel, mode });
            }
        }
        // Session: resume when asked and compatible, else reuse the cached
        // per-mode session when the project matches, else create.
        let sid = opts.resumeSessionId || null;
        const cached = this._sessionIds[mode] || null;
        if (!sid && cached && this._sessionRoots[cached] === (this._projectRoot || null)) {
            sid = cached;
        }
        try {
            if (!sid) {
                const r = await this._server.request('/sessions', {
                    method: 'POST', timeoutMs: 15000,
                    body: { title: opts.title || (mode === 'plan' ? 'Chat' : 'Agent'),
                        projectRoot: this._projectRoot },
                });
                if (r.status !== 201 || !r.body || !r.body.id) {
                    const e = new Error((r.body && r.body.error) || ('HTTP ' + r.status));
                    e.status = r.status;
                    throw e;
                }
                sid = r.body.id;
                this._sessionIds[mode] = sid;
                this._sessionRoots[sid] = this._projectRoot || null;
            }
            this._lastSessionId = sid;
            this._sessionIds[mode] = sid; // explicit resume becomes current
            this._sessionRoots[sid] = this._projectRoot || null;
            const m = await this._server.request('/sessions/' + sid + '/mode', {
                method: 'POST', timeoutMs: 15000, body: { mode: serverMode },
            });
            if (m.status !== 200) {
                const e = new Error((m.body && m.body.error) || ('HTTP ' + m.status));
                e.status = m.status;
                throw e;
            }
        } catch (e) {
            const mapped = mapServerError(e, false);
            return this._fail(mapped.kind, mapped.reason,
                { noModel: !!mapped.noModel, mode });
        }
        // Stream the turn.
        this._raw('turn', { phase: 'start', sessionId: sid, mode });
        this._leg('step', { phase: 'start', message: 'Tour en cours...' });
        let fullText = '';
        let doneText = null;
        this._startPoll(sid);
        let turnDone = null;
        try {
            turnDone = await this._server.stream('/sessions/' + sid + '/messages',
                { prompt }, (type, obj) => this._onSse(sid, type, obj, (t) => { fullText += t; }),
                { timeoutMs: this._streamTimeoutMs });
            if (turnDone && typeof turnDone.text === 'string') doneText = turnDone.text;
        } catch (e) {
            const mapped = mapServerError(e, this._stopRequested);
            try { await this._pollOnce(sid); } catch (_) {}
            return this._fail(mapped.kind, mapped.reason,
                { noModel: !!mapped.noModel, sessionId: sid, mode });
        }
        try { await this._pollOnce(sid); } catch (_) {}
        this._stopPoll();
        this._running = false;
        const filesModified = (turnDone && Array.isArray(turnDone.filesModified))
            ? turnDone.filesModified : [];
        let filesRead = [];
        try {
            const g = await this._server.request('/sessions/' + sid, { timeoutMs: 15000 });
            const rf = g && g.body && g.body.meta && g.body.meta.readFiles;
            if (Array.isArray(rf)) filesRead = rf.slice();
        } catch (_) {}
        const ok = !!(turnDone && turnDone.status === 'TERMINE');
        const d = { status: (turnDone && turnDone.status) || 'PARTIEL',
            reason: (turnDone && turnDone.reason) || '', reply: doneText != null ? doneText : fullText,
            sessionId: sid, filesModified, filesRead, turns: 1, mode,
            unresolved: (turnDone && turnDone.unresolvedErrors) || [] };
        this._raw('turn', { phase: 'end', sessionId: sid, mode, status: d.status });
        this._leg('step', { phase: 'end',
            message: ok ? 'Termine.' : ('Termine : ' + (d.reason || 'partiel') + '.') });
        this._raw('done', Object.assign({ ok }, d));
        this._leg('done', d);
        return Object.assign({ ok }, d);
    }

    // Legacy alias: single agent run. systemContext (project brief, files)
    // is prepended to the prompt.
    async query(prompt, systemContext = '', options = {}) {
        const head = (typeof systemContext === 'string' && systemContext)
            ? systemContext + '\n' : '';
        return this.run({ prompt: head + prompt, mode: options.mode || 'build',
            resumeSessionId: options.resumeSessionId, title: options.title });
    }

    // Read-only question: plan mode on the shared chat session. Returns
    // { ok, reply, sessionId, filesRead, ... } (panel contract P5).
    async chatQuery(prompt, opts = {}) {
        const r = await this.run({ prompt, mode: 'plan',
            resumeSessionId: this._sessionIds.plan || undefined,
            title: opts.title || 'Chat' });
        // Keep the { ok, reply, error } shape panels expect.
        if (!r.ok && !r.error) r.error = r.reason;
        return r;
    }

    _onSse(sid, type, obj, addText) {
        const o = obj || {};
        if (type === 'message.delta' && typeof o.text === 'string') {
            addText(o.text);
            this._raw('delta', { text: o.text, sessionId: sid });
            this._leg('delta', { text: o.text });
        } else if (type === 'message.done' && typeof o.text === 'string') {
            this._raw('delta', { text: '', done: true, sessionId: sid });
        } else if (type === 'tool.start') {
            const d = { phase: 'start', tool: o.tool || '?', callId: o.callId || '',
                atime: Date.now() };
            this._raw('tool', Object.assign({ sessionId: sid }, d));
            this._leg('tool', d);
            this._leg('step', { phase: 'tool', message: 'Outil : ' + d.tool });
        } else if (type === 'tool.result') {
            const d = { phase: 'end', tool: o.tool || '?', callId: o.callId || '',
                status: o.ok ? 'ok' : 'error', code: o.code || '',
                summary: shortText(o.summary || '', 300), atime: Date.now() };
            this._raw('tool', Object.assign({ sessionId: sid }, d));
            this._leg('tool', d);
        } else if (type === 'turn.start') {
            this._raw('turn', { phase: 'turn-start', sessionId: sid, turnId: o.turnId || '' });
        } else if (type === 'runtime.wait') {
            // P48(4): the runtime is restarting under supervision; the turn
            // waits (<=60s) and resumes transparently. Panels already
            // forward 'step' to their webviews (no panel change needed).
            this._leg('step', { phase: 'runtime-restart',
                message: typeof o.message === 'string' && o.message
                    ? o.message : 'Runtime restarting, attempt ' +
                        (o.attempt || '?') + '/' + (o.maxAttempts || '?') });
        }
        // turn.done resolves stream(); turn.error rejects it (both handled
        // by the caller). Nothing else to do here.
    }

    // -- approvals (poll-based: the loop never blocks, requests land in --
    // -- the server pending map; allow-decisions execute server-side) -------
    _startPoll(sid) {
        this._stopPoll();
        this._pollFails = 0;
        const tick = async () => {
            this._pollTimer = null;
            if (!this._running) return;
            try { await this._pollOnce(sid); this._pollFails = 0; }
            catch (_) {
                this._pollFails += 1;
                if (this._pollFails >= 5) return; // stream will fail anyway
            }
            if (this._running) {
                this._pollTimer = setTimeout(tick, this._pollMs);
                if (this._pollTimer && typeof this._pollTimer.unref === 'function') {
                    try { this._pollTimer.unref(); } catch (_) {}
                }
            }
        };
        this._pollTimer = setTimeout(tick, this._pollMs);
        if (this._pollTimer && typeof this._pollTimer.unref === 'function') {
            try { this._pollTimer.unref(); } catch (_) {}
        }
    }
    _stopPoll() {
        if (this._pollTimer) { try { clearTimeout(this._pollTimer); } catch (_) {} }
        this._pollTimer = null;
    }
    async _pollOnce(sid) {
        if (!this._serverReady()) return;
        const r = await this._server.request('/sessions/' + sid + '/approvals',
            { timeoutMs: 10000 });
        if (r.status !== 200 || !r.body || !Array.isArray(r.body.pending)) return;
        for (const req of r.body.pending) {
            if (!req || !req.id || this._pending.has(req.id)) continue;
            this._pending.set(req.id, { sessionId: sid, request: req });
            const d = { reqId: req.id, sessionId: sid, tool: req.tool || '?',
                summary: shortText(req.summary || '', 400),
                detail: shortText(req.pattern && req.pattern.text ? req.pattern.text : '', 400),
                diff: typeof req.diff === 'string' ? req.diff.slice(0, 20000) : null,
                deploy: req.deploy === true,
                choices: DECISIONS.slice(), atime: Date.now() };
            this._raw('perm', Object.assign({ phase: 'request' }, d));
            this._leg('approval_needed', d);
        }
    }

    // choice: once|session|project|deny (4 inline choices, P4 contract).
    // reqId defaults to the oldest pending request.
    async resolveApproval(choice, reqId = null) {
        if (DECISIONS.indexOf(choice) === -1) {
            return { ok: false, error: 'Decision invalide (' + String(choice) + ').' };
        }
        let id = reqId;
        if (!id) {
            const first = this._pending.keys().next();
            if (first.done) return { ok: false, error: 'Aucune approbation en attente.' };
            id = first.value;
        }
        const pend = this._pending.get(id);
        if (!pend) return { ok: false, error: 'Demande inconnue ou expiree.' };
        if (!this._serverReady()) return { ok: false, error: SERVER_OFFLINE };
        let r;
        try {
            r = await this._server.request('/sessions/' + pend.sessionId + '/approvals',
                { method: 'POST', timeoutMs: 60000,
                    body: { requestId: id, decision: choice } });
        } catch (e) {
            const mapped = mapServerError(e, false);
            return { ok: false, error: mapped.reason };
        }
        if (!r || (r.status !== 200) || !r.body || r.body.status === undefined && r.body.error) {
            return { ok: false, error: (r && r.body && r.body.error) || ('HTTP ' + (r && r.status)) };
        }
        this._pending.delete(id);
        const status = (r.body && r.body.status) || 'ok';
        const outcome = { reqId: id, tool: pend.request.tool || '?',
            summary: shortText(pend.request.summary || '', 200), decision: choice,
            status, detail: shortText(
                (r.body && (r.body.reason || (r.body.call && r.body.call.summary))) || '', 300) };
        this._decided.push(outcome);
        this._raw('perm', Object.assign({ phase: 'resolved' }, outcome));
        this._leg('approval_resolved', outcome);
        return Object.assign({ ok: true }, outcome);
    }

    pendingApprovals() {
        return Array.from(this._pending.keys());
    }

    // Follow-up turn informing the model of approval outcomes (avoids blind
    // retries: the model gets each executed/denied result in context).
    async continueAfterApproval() {
        if (!this._decided.length) {
            return { ok: false, error: 'Aucune approbation traitee a poursuivre.' };
        }
        const lines = this._decided.map((o) =>
            '- ' + o.tool + ' (' + o.reqId + ') : decision=' + o.decision +
            ' statut=' + o.status + (o.detail ? ' : ' + o.detail : ''));
        this._decided = [];
        return this.run({ prompt: 'Approbations traitees :\n' + lines.join('\n') +
            '\nPoursuis la tache en tenant compte de ces resultats.',
        mode: this._lastMode, resumeSessionId: this._lastSessionId || undefined });
    }

    // -- stop / undo / sessions -------------------------------------------------
    async stop() {
        if (!this._running) return { ok: true, stopped: false };
        this._stopRequested = true;
        if (this._serverReady() && this._lastSessionId) {
            try {
                await this._server.request('/sessions/' + this._lastSessionId + '/abort',
                    { method: 'POST', timeoutMs: 10000, body: {} });
            } catch (_) {}
        }
        return { ok: true, stopped: true };
    }

    async undoLastRun(scope = 'last') {
        const sid = this._lastSessionId;
        if (!sid) return { ok: false, error: 'Aucun run agent a annuler.' };
        if (!this._serverReady()) return { ok: false, error: SERVER_OFFLINE };
        const sc = scope === 'session' ? 'session' : 'last';
        let r;
        try {
            r = await this._server.request('/sessions/' + sid + '/undo',
                { method: 'POST', timeoutMs: 60000, body: { scope: sc } });
        } catch (e) {
            const mapped = mapServerError(e, false);
            return { ok: false, error: mapped.reason };
        }
        if (!r || r.status !== 200 || !r.body) {
            return { ok: false, error: (r && r.body && r.body.error) || ('HTTP ' + (r && r.status)) };
        }
        return { ok: true, scope: sc, snapshot: r.body.snapshot || null,
            restored: r.body.restored || [], deleted: r.body.deleted || [],
            verified: r.body.verified !== false };
    }

    async listSessions() {
        if (!this._serverReady()) throw new Error(SERVER_OFFLINE);
        const r = await this._server.request('/sessions', { timeoutMs: 15000 });
        if (r.status !== 200 || !r.body || !Array.isArray(r.body.sessions)) {
            throw new Error((r.body && r.body.error) || ('HTTP ' + r.status));
        }
        return r.body.sessions.map((s) => ({ id: s.id, title: s.title || '',
            projectRoot: s.projectRoot || null, createdAt: s.createdAt || '',
            updatedAt: s.updatedAt || '', messageCount: s.messageCount || 0 }));
    }

    async deleteSession(id) {
        if (!id) throw new Error('Session sans identifiant.');
        if (!this._serverReady()) throw new Error(SERVER_OFFLINE);
        const r = await this._server.request('/sessions/' + id,
            { method: 'DELETE', timeoutMs: 15000 });
        if (r.status !== 200) {
            throw new Error((r.body && r.body.error) || ('HTTP ' + r.status));
        }
        for (const m of ['build', 'plan']) {
            if (this._sessionIds[m] === id) this._sessionIds[m] = null;
        }
        delete this._sessionRoots[id];
        if (this._lastSessionId === id) this._lastSessionId = null;
        return { ok: true, removed: true };
    }
}

module.exports = { AgentEngine };
