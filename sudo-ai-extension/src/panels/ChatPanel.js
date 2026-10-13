/**
 * SUDO STUDIO - Sudo Chat (MISSION P5: chat with full project access).
 * The chat uses the SAME engine and providers as the agent (P3/P2), always in
 * "Plan" (read-only) mode: it really reads files (read/glob/grep/list) to
 * answer. The old unguided /infer path (raw model, no context, refusals and
 * invented answers) is REPLACED; kept from the old panel: intent shortcuts,
 * globalState history (+restore), provider switch, runtime status.
 * - automatic context: active file, selection, Problems panel, @file/@folder
 * - instruction: French, cite files read (path + lines), "je ne sais pas"
 *   instead of inventing, read-only
 * - "Passer en mode Agent" forwards the last question to the Sudo Agent tab
 * - same conversation renderer as the agent (shared getWebviewHtml variant)
 * ASCII-only.
 */
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { AgentEngine } = require('../agent/AgentEngine');
const { getWebviewHtml } = require('../agent/AgentPanel');
const { getAIProviderService } = require('../services/AIProviderService');

const RUNTIME_URL = 'http://127.0.0.1:6000';
const RUNTIME_POLL_MS = 20000;
const CAP_FILE = 12000;
const CAP_SEL = 4000;
const CAP_MENTION_FILE = 8000;
const CAP_MENTIONS = 16000;
const CAP_DIAG = 20;

// ---------------------------------------------------------------- mentions

function resolveMention(tok, root) {
    const abs = path.resolve(root, tok);
    const r = path.resolve(root);
    if (abs !== r && abs.indexOf(r + path.sep) !== 0) return { token: tok, status: 'outside' };
    try {
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
            let names = [];
            try { names = fs.readdirSync(abs).slice(0, 60); } catch (_) {}
            return { token: tok, status: 'dir', rel: path.relative(root, abs), names };
        }
        if (st.isFile()) {
            if (st.size > 256 * 1024)
                return { token: tok, status: 'too-big', rel: path.relative(root, abs), size: st.size };
            const content = fs.readFileSync(abs, 'utf8');
            if (content.indexOf('\0') !== -1)
                return { token: tok, status: 'binary', rel: path.relative(root, abs) };
            return { token: tok, status: 'file', rel: path.relative(root, abs),
                lines: content.split('\n').length, content };
        }
    } catch (_) { /* missing below */ }
    return { token: tok, status: 'missing' };
}

function parseMentions(text, root) {
    const found = [];
    const seen = new Set();
    const re = /@"([^"]+)"|@([^\s"'`<>()[\],;]+)/g;
    let m;
    let budget = CAP_MENTIONS;
    while ((m = re.exec(text)) !== null) {
        const tok = (m[1] || m[2] || '').trim().replace(/[.?,;:!]+$/, '');
        if (!tok || seen.has(tok)) continue;
        seen.add(tok);
        const r = resolveMention(tok, root);
        if (r.status === 'file' && r.content) {
            const capped = r.content.slice(0, Math.min(CAP_MENTION_FILE, budget));
            budget = Math.max(0, budget - capped.length);
            r.truncated = capped.length < r.content.length;
            r.content = capped;
        }
        found.push(r);
    }
    return found;
}

// ---------------------------------------------------------------- prompt

function buildChatPrompt(p, question) {
    const L = [];
    L.push("[ROLE] Tu es Sudo Chat, l'assistant de conversation du projet ouvert. Tu reponds TOUJOURS en francais.");
    L.push('[REGLES] 1. Lis reellement les fichiers du projet avec tes outils avant de repondre.');
    L.push('2. Cite chaque fichier utilise sous la forme chemin:ligne-debut-fin (exemple lib/main.dart:1-40).');
    L.push('3. Si l\'information demandee ne se trouve pas dans les fichiers lus, dis exactement "je ne sais pas" et ne l\'invente jamais.');
    L.push('4. Tu es en lecture seule : tu ne modifies rien, tu proposes et tu expliques.');
    L.push('[PROJET] ' + p.root);
    if (p.activeFile) {
        L.push('[FICHIER ACTIF] ' + p.activeFile.rel + ' (' + p.activeFile.lines + ' lignes' +
            (p.activeFile.truncated ? ', tronque' : '') + ')\n' + p.activeFile.content);
    } else L.push('[FICHIER ACTIF] aucun');
    if (p.selection) L.push('[SELECTION] ' + p.selection.rel + ':' + p.selection.range + '\n' + p.selection.text);
    else L.push('[SELECTION] aucune');
    if (p.problems && p.problems.length) L.push('[PROBLEMES] (' + p.problemsTotal + ' au total)\n' + p.problems.join('\n'));
    else L.push('[PROBLEMES] aucun');
    if (p.mentions && p.mentions.length) {
        const ML = ['[MENTIONS]'];
        for (const mt of p.mentions) {
            if (mt.status === 'file') {
                ML.push('@' + mt.token + ' -> ' + mt.rel + ' (' + mt.lines + ' lignes' +
                    (mt.truncated ? ', tronque' : '') + '):\n' + mt.content);
            } else if (mt.status === 'dir') {
                ML.push('@' + mt.token + ' -> dossier ' + (mt.rel || '.') + ' (' + mt.names.length + ' entrees): ' +
                    mt.names.join(', '));
            } else if (mt.status === 'missing') ML.push('@' + mt.token + ' -> INTROUVABLE dans le projet');
            else if (mt.status === 'outside') ML.push('@' + mt.token + ' -> hors projet (ignore)');
            else if (mt.status === 'too-big') ML.push('@' + mt.token + ' -> trop gros (' + mt.size + ' octets, non lu)');
            else ML.push('@' + mt.token + ' -> binaire (non lu)');
        }
        L.push(ML.join('\n'));
    } else L.push('[MENTIONS] aucune');
    L.push('[QUESTION] ' + question);
    return L.join('\n');
}

// ---------------------------------------------------------------- panel

class ChatPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri, ctx, opts = {}) {
        this.panel = panel;
        this.extensionUri = extensionUri || null;
        this.ctx = ctx || null;
        this.disposables = [];
        this._http = opts.http || null;
        this._engineFactory = opts.engineFactory || ((o) => new AgentEngine(o));
        this.engine = null;
        this.projectRoot = null;
        this._sandboxLevel = 'auto'; // P8: auto | l1 | l2 (memory only)
        this.history = [];
        this.lastUserMsg = '';
        this._running = false;
        this._queue = [];
        this._approvals = [];
        this._resolved = new Set();
        this._runtimeTimer = null;

        if (ctx) {
            try { this.history = ctx.globalState.get('sudoChat.history', []) || []; } catch (_) {}
        }
        const webview = panel.webview;
        webview.html = getWebviewHtml({
            nonce: ChatPanel._nonce(),
            cspSource: webview.cspSource,
            codiconUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css')).toString(),
            tokensUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-ui-tokens.css')).toString(),
            hljsUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'highlight.min.js')).toString(),
            variant: 'chat',
        });
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        webview.onDidReceiveMessage((m) => this.handleMessage(m), null, this.disposables);
        const replay = this.history.slice(-20).map((h) => ({
            role: h.role === 'user' ? 'user' : 'assistant', content: h.content || '',
        }));
        if (replay.length) setTimeout(() => this._post({ type: 'history', turns: replay }), 200);
        this._postProviders();
        this._checkRuntime();
        this._runtimeTimer = setInterval(() => this._checkRuntime(), RUNTIME_POLL_MS);
    }

    static _nonce() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let n = '';
        for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
        return n;
    }

    static createOrShow(extensionUri, ctx, opts) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            ChatPanel.currentPanel._checkRuntime();
            return ChatPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioChat',
            'Sudo Chat',
            column,
            { enableScripts: true, retainContextWhenHidden: true,
              localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
        );
        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, ctx, opts);
        return ChatPanel.currentPanel;
    }

    async handleMessage(msg) {
        try {
            switch (msg && msg.type) {
                case 'send': await this._handleSend(msg.text); break;
                case 'stop': this.stopChat(); break;
                case 'approve': await this._handleApprove(msg.id, msg.choice); break;
                case 'setProvider': this._handleProvider(msg.id); break;
                case 'setSandboxLevel':
                    if (msg.level === 'auto' || msg.level === 'l1' || msg.level === 'l2') {
                        this._sandboxLevel = msg.level;
                    }
                    break;
                case 'openRuntime':
                    vscode.commands.executeCommand('sudoStudio.openRuntimePanel');
                    break;
                case 'toAgent': this._handleToAgent(); break;
                case 'clear': this.clearHistory(); this._postRunState(); break;
                case 'refreshRuntime': this._checkRuntime(); break;
                default: break;
            }
        } catch (e) {
            this._post({ type: 'error', message: 'Chat: ' + e.message });
        }
    }

    async _handleSend(text) {
        text = (text || '').trim();
        if (!text) return;
        this.lastUserMsg = text;
        const intent = this._detectIntent(text);
        if (intent) {
            this._addHistory('user', text);
            this._post({ type: 'history', turns: [{ role: 'user', content: text }] });
            try {
                await this._handleIntent(intent, text);
            } finally {
                this._postRunState();
            }
            return;
        }
        const folders = vscode.workspace.workspaceFolders;
        const ws = folders && folders[0];
        if (!ws) {
            await this._chatQueryFallback(text);
            return;
        }
        const root = ws.uri.fsPath;
        if (this.engine && this.projectRoot !== root) {
            try { await this.engine.stop(); } catch (_) {}
            this.engine = null;
        }
        this.projectRoot = root;
        if (this._running) {
            this._queue.push(text);
            this._postRunState();
            return;
        }
        this._runOne(text);
    }

    async _runOne(text) {
        this._running = true;
        this._postRunState();
        try {
            this._ensureEngine();
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: 'Moteur: ' + e.message });
            this._postRunState();
            return;
        }
        const cx = this._gatherContext(text);
        this._post({ type: 'context', activeFile: cx.contextPost.activeFile,
            hasSelection: cx.contextPost.hasSelection, problems: cx.contextPost.problems });
        this._addHistory('user', text);
        this._approvals = [];
        this._resolved = new Set();
        this._post({ type: 'started', mode: 'plan' });
        try {
            await this.engine.run({ prompt: buildChatPrompt(cx, text), mode: 'plan', sandboxMode: this._sandboxLevel });
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: e.message });
            this._postRunState();
            this._drain();
        }
    }

    _ensureEngine() {
        if (this.engine) return;
        this.engine = this._engineFactory({
            projectRoot: this.projectRoot,
            extensionDir: this.extensionUri ? this.extensionUri.fsPath : null,
            mode: 'plan',
        });
        this.engine.on('step', (d) => this._post({ type: 'step', phase: d.phase, message: d.message }));
        this.engine.on('error', (d) => this._post({ type: 'error', message: d.message }));
        this.engine.on('approval_needed', (d) => this._onApproval(d));
        this.engine.on('done', (d) => this._onDone(d));
        this.engine.on('sandbox', (d) => this._post({ type: 'sandbox', level: d.level, via: d.via,
            token: d.token, job: d.job, network: d.network, note: d.note, requested: d.requested }));
        const drv = this.engine.driver;
        if (drv && typeof drv.on === 'function') drv.on('bus', (ev) => this._onBus(ev));
    }

    _onBus(ev) {
        if (!ev || typeof ev.type !== 'string') return;
        if (ev.type.indexOf('message') !== 0 || ev.type.indexOf('part') === -1) return;
        const props = ev.properties || {};
        try { if (JSON.stringify(props).length > 200000) return; } catch (_) { return; }
        this._post({ type: 'part', properties: props });
    }

    _onDone(d) {
        this._running = false;
        const reason = d.reason || '';
        const noModel = d.status === 'ECHEC' && /NO_MODEL_LOADED|Runtime offline/.test(reason);
        // sessionId nulled: no undo button in chat (plan mode modifies nothing).
        this._post({ type: 'done', status: d.status, reason, reply: d.reply || '',
            filesModified: d.filesModified || [], sessionId: null, mode: 'plan', noModel });
        this._addHistory('assistant', d.reply || reason, 'Sudo Chat');
        this._postRunState();
        this._drain();
    }

    _drain() {
        if (this._running || !this._queue.length) return;
        this._runOne(this._queue.shift());
    }

    stopChat() {
        this._queue = [];
        if (this.engine) { try { this.engine.stop(); } catch (_) {} }
        this._running = false;
        this._postRunState();
    }

    // -- approvals (not expected in plan/read-only; supported defensively) --
    _onApproval(d) {
        const a = { id: d.id, action: d.action, title: d.title, description: d.description };
        this._approvals.push(a);
        const first = this._approvals.find((x) => !this._resolved.has(x.id));
        this._post({ type: 'approval', id: a.id, action: a.action, title: a.title,
            description: a.description, actionable: !!first && first.id === a.id });
    }

    async _handleApprove(id, choice) {
        const open = this._approvals.filter((x) => !this._resolved.has(x.id));
        if (!open.length) return;
        if (open[0].id !== id) {
            this._post({ type: 'error', message: "Traitez les demandes dans l'ordre (la plus ancienne d'abord)." });
            return;
        }
        if (['once', 'session', 'project', 'reject'].indexOf(choice) === -1) {
            this._post({ type: 'error', message: 'Choix inconnu: ' + choice });
            return;
        }
        if (!this.engine) { this._post({ type: 'error', message: 'Aucun moteur actif.' }); return; }
        const r = await this.engine.resolveApproval(choice);
        if (!r || !r.ok) {
            this._post({ type: 'error', message: 'Approbation impossible: ' + ((r && r.error) || '?') });
            return;
        }
        this._resolved.add(id);
        this._post({ type: 'approvalResolved', id, choice });
        const next = this._approvals.find((x) => !this._resolved.has(x.id));
        this._post({ type: 'actionable', id: next ? next.id : null });
    }

    // -- no-folder fallback: direct model call, guided, honest about scope --
    async _chatQueryFallback(text) {
        this._running = true;
        this._postRunState();
        this._post({ type: 'context', activeFile: null, hasSelection: false, problems: 0 });
        this._post({ type: 'started', mode: 'plan' });
        try {
            this._ensureEngineForQuery();
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: 'Moteur: ' + e.message });
            this._postRunState();
            return;
        }
        const prompt = "[ROLE] Tu es Sudo Chat. Tu reponds TOUJOURS en francais. " +
            'Aucun dossier projet n\'est ouvert : reponds de facon generale, et si tu ne sais pas, dis exactement "je ne sais pas".\n' +
            '[QUESTION] ' + text;
        try {
            const r = await this.engine.chatQuery(prompt);
            this._running = false;
            if (r && r.ok) {
                this._addHistory('user', text);
                this._addHistory('assistant', r.reply || '', 'Sudo Chat');
                this._post({ type: 'history', turns: [{ role: 'assistant', content: r.reply || '' }] });
            } else {
                this._post({ type: 'error', message: (r && r.error) || 'reponse vide' });
            }
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: e.message });
        }
        this._postRunState();
        this._drain();
    }

    _ensureEngineForQuery() {
        if (this.engine) return;
        this.engine = this._engineFactory({
            projectRoot: null,
            extensionDir: this.extensionUri ? this.extensionUri.fsPath : null,
            mode: 'plan',
        });
    }

    // -- context ---------------------------------------------------------------
    _gatherContext(text) {
        const root = this.projectRoot;
        const out = { root, activeFile: null, selection: null, problems: [], problemsTotal: 0,
            mentions: [], contextPost: { activeFile: null, hasSelection: false, problems: 0 } };
        try {
            const ed = vscode.window.activeTextEditor;
            if (ed && ed.document && ed.document.uri && ed.document.uri.fsPath) {
                const abs = ed.document.uri.fsPath;
                const r = path.resolve(root);
                if (abs === r || abs.indexOf(r + path.sep) === 0) {
                    const rel = path.relative(root, abs);
                    let content = '';
                    try { content = fs.readFileSync(abs, 'utf8'); } catch (_) { content = ''; }
                    if (content.indexOf('\0') === -1 && content) {
                        out.activeFile = { rel, lines: content.split('\n').length,
                            content: content.slice(0, CAP_FILE), truncated: content.length > CAP_FILE };
                        out.contextPost.activeFile = rel;
                    }
                    const sel = ed.selection;
                    if (sel && !sel.isEmpty && ed.document.getText) {
                        try {
                            const t = ed.document.getText(sel) || '';
                            if (t.trim()) {
                                out.selection = { rel, range: (sel.start.line + 1) + '-' + (sel.end.line + 1),
                                    text: t.slice(0, CAP_SEL) };
                                out.contextPost.hasSelection = true;
                            }
                        } catch (_) {}
                    }
                }
            }
        } catch (_) {}
        try {
            const all = (vscode.languages && vscode.languages.getDiagnostics
                && vscode.languages.getDiagnostics()) || [];
            const r = path.resolve(root);
            const flat = [];
            for (const entry of all) {
                const uri = entry && entry[0];
                const diags = (entry && entry[1]) || [];
                if (!uri || !uri.fsPath) continue;
                if (uri.fsPath !== r && uri.fsPath.indexOf(r + path.sep) !== 0) continue;
                const rel = path.relative(root, uri.fsPath);
                for (const dg of diags) {
                    const sev = dg.severity === 0 ? 'erreur' : (dg.severity === 1 ? 'avertissement' : 'info');
                    const line = (dg.range && dg.range.start && typeof dg.range.start.line === 'number')
                        ? (dg.range.start.line + 1) : '?';
                    flat.push(rel + ':' + line + ' [' + sev + '] ' + String(dg.message || '').slice(0, 200));
                }
            }
            out.problemsTotal = flat.length;
            out.problems = flat.slice(0, CAP_DIAG);
            out.contextPost.problems = flat.length;
        } catch (_) {}
        try {
            out.mentions = parseMentions(text, root);
        } catch (_) { out.mentions = []; }
        return out;
    }

    // -- agent handoff ------------------------------------------------------------
    _handleToAgent() {
        try {
            const { AgentPanel } = require('../agent/AgentPanel');
            const agent = AgentPanel.createOrShow(this.extensionUri);
            if (agent && this.lastUserMsg) agent.sendExternal(this.lastUserMsg);
        } catch (e) {
            this._post({ type: 'error', message: 'Mode Agent: ' + e.message });
        }
    }

    // -- intents (kept from the old panel; replies adapted to the new UI) ------
    _detectIntent(text) {
        const t = text.toLowerCase();
        if (
            /analys[ez]\s+(le\s+|mon\s+|ce\s+)?(projet|code|workspace|dossier|r\u00e9pertoire|repo|codebase)/i.test(t) ||
            /audit\s+(du|de|le|mon|ce)\s+(code|projet|workspace)/i.test(t) ||
            /(inspecte|scanne|examine)\s+(le|mon|ce)\s+(projet|code|workspace|dossier)/i.test(t) ||
            (/^\s*(analys[ez]|scan|audit|inspecte|examine)\s*$/.test(t))
        )
            return 'analyzeProject';
        if (/doctor|docteur|diagnos|sant\u00e9|health|probl\u00e8me.*syst\u00e8me|syst\u00e8me.*probl\u00e8me/.test(t))
            return 'openDoctor';
        if (/autofix|auto.?fix|corrige.*auto|r\u00e9pare.*auto|fix.*(all|tout|auto)/.test(t))
            return 'autoFix';
        if (/dockerfile|docker.?compose|docker-compose/.test(t))
            return 'genDocker';
        if (/github.?action|ci.?cd|pipeline|gitlab.?ci|jenkins|workflow/.test(t))
            return 'genCICD';
        if (/kubernetes|kubectl|k8s|helm|deployment.?yaml/.test(t))
            return 'genKubernetes';
        if (/install.*sdk|sdk.*install|installe.*node|installe.*python|installe.*flutter/.test(t))
            return 'openSDK';
        if (/runtime|mod\u00e8le|model.*status|status.*model|t\u00e9l\u00e9charge.*model|download.*model/.test(t))
            return 'openRuntime';
        if (/environnement.*reproductible|reproduc|snapshot.*env|exporte.*env|import.*profil|synchronis.*env|\u00e7a marche chez moi|marche.pas.chez|sync.*\u00e9quipe|team.*sync/.test(t))
            return 'openEnvironment';
        return null;
    }

    async _handleIntent(intent, text) {
        const replies = {
            analyzeProject: "Analyse du projet en cours... J'ouvre le panneau d'analyse.",
            openDoctor: 'Ouverture du System Doctor... Diagnostic en cours.',
            autoFix: 'AutoFix lance... Detection et correction automatique.',
            genDocker: "Generation Dockerfile... J'ouvre le panneau DevOps.",
            genCICD: "Generation CI/CD... J'ouvre le panneau DevOps.",
            genKubernetes: "Generation Kubernetes... J'ouvre le panneau DevOps.",
            openSDK: 'SDK Manager... J ouvre le gestionnaire de SDKs.',
            openRuntime: 'Runtime Manager... J ouvre le panneau du runtime IA.',
            openEnvironment: 'Environnements Reproductibles... J ouvre le panneau de synchronisation.'
        };
        const reply = replies[intent] || 'Action lancee.';
        this._post({ type: 'history', turns: [{ role: 'assistant', content: reply }] });
        this._addHistory('assistant', reply, 'Sudo AI');
        setTimeout(() => {
            try {
                switch (intent) {
                    case 'analyzeProject': vscode.commands.executeCommand('sudoStudio.analyzeProject'); break;
                    case 'openDoctor':     vscode.commands.executeCommand('sudoStudio.runDoctor'); break;
                    case 'autoFix':        vscode.commands.executeCommand('sudoStudio.autoFix'); break;
                    case 'genDocker':
                    case 'genCICD':
                    case 'genKubernetes':  vscode.commands.executeCommand('sudoStudio.openDevOpsPanel'); break;
                    case 'openSDK':        vscode.commands.executeCommand('sudoStudio.openSDKPanel'); break;
                    case 'openRuntime':    vscode.commands.executeCommand('sudoStudio.openRuntimePanel'); break;
                    case 'openEnvironment': vscode.commands.executeCommand('sudoStudio.openEnvironmentPanel'); break;
                    default: break;
                }
            } catch (_) {}
        }, 500);
    }

    // -- history -------------------------------------------------------------------
    _addHistory(role, content, model, mock) {
        this.history.push({ role, content, model, mock, ts: Date.now() });
        if (this.history.length > 50) this.history = this.history.slice(-50);
        if (this.ctx) {
            try { this.ctx.globalState.update('sudoChat.history', this.history); } catch (_) {}
        }
    }

    clearHistory() {
        this.history = [];
        this._queue = [];
        if (this.ctx) {
            try { this.ctx.globalState.update('sudoChat.history', []); } catch (_) {}
        }
        this._post({ type: 'cleared' });
    }

    // -- providers + runtime (same selectors as the agent) -----------------------
    _postProviders() {
        try {
            const { providers, activeId } = getAIProviderService().listProviders();
            this._post({ type: 'providers',
                providers: providers.map((p) => ({ id: p.id, type: p.type, name: p.name, model: p.model })),
                activeId });
        } catch (e) {
            this._post({ type: 'error', message: 'Fournisseurs: ' + e.message });
        }
    }

    _handleProvider(id) {
        try {
            getAIProviderService().setActive(id);
        } catch (e) {
            this._post({ type: 'error', message: 'Fournisseur: ' + e.message });
            return;
        }
        this._postProviders();
    }

    async _checkRuntime() {
        let active = null;
        try { active = getAIProviderService().getActive(); } catch (_) { active = null; }
        if (active && active.type !== 'local') {
            this._post({ type: 'runtime', kind: 'cloud', provider: active.name, model: active.model });
            return;
        }
        try {
            const ax = this._http || require('axios');
            await ax.get(RUNTIME_URL + '/health', { timeout: 3000 });
            const m = await ax.get(RUNTIME_URL + '/v1/models', { timeout: 3000 });
            const ids = ((m.data && m.data.data) || []).map((x) => x.id).filter(Boolean);
            this._post({ type: 'runtime', kind: 'local', online: true, models: ids });
        } catch (_) {
            this._post({ type: 'runtime', kind: 'local', online: false, models: [] });
        }
    }

    _postRunState() {
        this._post({ type: 'runState', running: this._running, queued: this._queue.length });
    }

    _post(msg) {
        try { this.panel.webview.postMessage(msg); } catch (_) {}
    }

    post(msg) { this._post(msg); }

    dispose() {
        ChatPanel.currentPanel = undefined;
        try { if (this._runtimeTimer) clearInterval(this._runtimeTimer); } catch (_) {}
        this._runtimeTimer = null;
        if (this.engine) { try { this.engine.stop(); } catch (_) {} }
        this.engine = null;
        try { this.panel.dispose(); } catch (_) {}
        this.disposables.forEach((d) => { try { d && d.dispose(); } catch (_) {} });
    }
}

module.exports = { ChatPanel, parseMentions, buildChatPrompt };
