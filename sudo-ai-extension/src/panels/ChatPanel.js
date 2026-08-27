/**
 * SUDO STUDIO - Chat Panel v3
 * Full-featured AI chat with:
 * - Immediate user message display (fixed send button)
 * - Retry last message
 * - Stop generation
 * - Persistent conversation history (VSCode memento)
 * - Markdown + syntax highlighting (highlight.js via CDN)
 * - Intent routing: "analyse projet", "docteur", "autofix", "dockerfile" etc.
 * - Multi-conversation (New Chat)
 * - Dual-path AI: backend:5000 → fallback runtime:6000
 * - Model download progress bar
 */
const vscode = require('vscode');
const axios  = require('axios');
const { exec } = require('child_process');

const IS_WIN = process.platform === 'win32';

class ChatPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri, ctx) {
        this.panel        = panel;
        this.extensionUri = extensionUri;
        this.ctx          = ctx;
        this.disposables  = [];
        this.authToken    = null;
        this.abortCtrl    = null;   // for stop generation
        this.history      = [];     // [{role, content}]
        this.lastUserMsg  = '';

        // Restore history from storage
        if (ctx) {
            this.history = ctx.globalState.get('sudoChat.history', []);
        }

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Send existing history to webview after a tick
        setTimeout(() => {
            this.history.forEach(h => {
                if (h.role === 'user') {
                    this.panel.webview.postMessage({ type: 'userMessage', text: h.content, noScroll: true });
                } else {
                    this.panel.webview.postMessage({ type: 'aiMessage', text: h.content, model: h.model || 'AI', mock: h.mock, noScroll: true });
                }
            });
            this.sendStatus();
        }, 200);

        this._tryLogin();
        // Poll status every 5s
        this._statusInterval = setInterval(() => this.sendStatus(), 5000);
    }

    static createOrShow(extensionUri, ctx) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioChat',
            '💬 Sudo AI Chat',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, ctx);
    }

    async _tryLogin() {
        try {
            const r = await axios.post('http://localhost:5000/api/auth/login',
                { username: 'admin', password: 'admin123' }, { timeout: 3000 });
            this.authToken = r.data.token;
        } catch (_) { this.authToken = null; }
    }

    async handleMessage(message) {
        console.log('[EXT] handleMessage received — type:', message.type);
        switch (message.type) {
            case 'sendMessage':   await this.handleChat(message.text); break;
            case 'retryLast':     await this.retryLast(); break;
            case 'stopGeneration': this.stopGeneration(); break;
            case 'clearChat':     this.clearHistory(); break;
            case 'checkStatus':   await this.sendStatus(); break;
            case 'downloadModel': await this.downloadModel(message.modelId); break;
            case 'runDoctor':     vscode.commands.executeCommand('sudoStudio.runDoctor'); break;
            case 'analyzeProject': vscode.commands.executeCommand('sudoStudio.analyzeProject'); break;
            case 'openDevOps':    vscode.commands.executeCommand('sudoStudio.openDevOpsPanel'); break;
            case 'openSDK':       vscode.commands.executeCommand('sudoStudio.openSDKPanel'); break;
            case 'openRuntime':   vscode.commands.executeCommand('sudoStudio.openRuntimePanel'); break;
            case 'openEnvironment': vscode.commands.executeCommand('sudoStudio.openEnvironmentPanel'); break;
            case 'openAgentMode': vscode.commands.executeCommand('sudoStudio.openAgentPanel'); break;
        }
    }

    // ── Intent routing ─────────────────────────────────────────────────────
    _detectIntent(text) {
        const t = text.toLowerCase();
        if (/analys[ez]|scan|inspecte|examine|audit.*(projet|code|workspace|dossier)/.test(t))
            return 'analyzeProject';
        if (/doctor|docteur|diagnos|santé|health|problème.*système|système.*problème/.test(t))
            return 'openDoctor';
        if (/autofix|auto.?fix|corrige.*auto|répare.*auto|fix.*(all|tout|auto)/.test(t))
            return 'autoFix';
        if (/dockerfile|docker.?compose|docker-compose/.test(t))
            return 'genDocker';
        if (/github.?action|ci.?cd|pipeline|gitlab.?ci|jenkins|workflow/.test(t))
            return 'genCICD';
        if (/kubernetes|kubectl|k8s|helm|deployment.?yaml/.test(t))
            return 'genKubernetes';
        if (/install.*sdk|sdk.*install|installe.*node|installe.*python|installe.*flutter/.test(t))
            return 'openSDK';
        if (/runtime|modèle|model.*status|status.*model|télécharge.*model|download.*model/.test(t))
            return 'openRuntime';
        if (/environnement.*reproductible|reproduc|snapshot.*env|exporte.*env|import.*profil|synchronis.*env|ça marche chez moi|marche.pas.chez|sync.*équipe|team.*sync/.test(t))
            return 'openEnvironment';
        return null;
    }

    async handleChat(text) {
        if (!text || !text.trim()) return;
        console.log('[EXT] handleChat — text[:60]:', text.slice(0,60));
        this.lastUserMsg = text;

        // Show user message immediately
        this.panel.webview.postMessage({ type: 'userMessage', text });
        this._addHistory('user', text);

        // Check for intent shortcuts
        const intent = this._detectIntent(text);
        if (intent) {
            // FIX BUG: _handleIntent never sent 'generating: false' to the WebView,
            // so sendBtn stayed disabled forever after an intent was detected.
            // Always wrap in try/finally so generating is always reset.
            try {
                await this._handleIntent(intent, text);
            } finally {
                // aiMessage sent by _handleIntent already calls setGenerating(false)
                // in the WebView, but send an explicit reset as belt-and-braces.
                this.panel.webview.postMessage({ type: 'generating', show: false });
            }
            return;
        }

        // Normal AI call
        this.panel.webview.postMessage({ type: 'generating', show: true });
        this.abortCtrl = new AbortController();

        try {
            const reply = await this._sendToAI(text);

            // FIX BUG: _sendToAI could return undefined (ECONNREFUSED with no authToken)
            // which caused "Cannot read property 'reply' of undefined" → unhandled crash.
            if (!reply) {
                throw new Error(
                    'Runtime IA hors ligne (port 6000).\n' +
                    'Vérifiez que runtime.exe est lancé depuis start.bat.'
                );
            }

            this.panel.webview.postMessage({ type: 'generating', show: false });
            this.panel.webview.postMessage({
                type: 'aiMessage',
                text: reply.reply || reply.response || 'Pas de reponse.',
                model: reply.model === 'mock' ? 'Sudo AI (chargement modele)' : (reply.model || 'AI'),
                latency: reply.latency_ms,
                mock: reply.mock || false,
                loading: reply.loading || false,
                progress: reply.download_progress
            });
            this._addHistory('assistant', reply.reply || reply.response || '', reply.model, reply.mock);
        } catch (e) {
            // FIX BUG: always reset generating state FIRST, then show error/stop message.
            // Previously 'generating: false' was sent but the WebView 'error' case
            // didn't call setGenerating(false), leaving sendBtn permanently disabled.
            this.panel.webview.postMessage({ type: 'generating', show: false });
            if (e.name === 'AbortError' || e.message === 'STOPPED') {
                this.panel.webview.postMessage({ type: 'aiMessage', text: '⏹ Génération arrêtée.', model: 'system' });
            } else {
                this.panel.webview.postMessage({
                    type: 'aiMessage',
                    text: `❌ ${e.message}\n\nVérifiez que runtime.exe est lancé (port 6000).`,
                    model: 'system',
                    mock: true
                });
            }
        }
    }

    async _handleIntent(intent, text) {
        const replies = {
            analyzeProject: '🔍 **Analyse du projet en cours...**\n\nJ\'ouvre le panneau d\'analyse. Résultats dans un instant.',
            openDoctor:     '🩺 **Ouverture du System Doctor...**\n\nDiagnostic en cours.',
            autoFix:        '🔧 **AutoFix lancé...**\n\nDétection et correction automatique des problèmes.',
            genDocker:      '🐳 **Génération Dockerfile...**\n\nJ\'ouvre le panneau DevOps pour générer les fichiers Docker.',
            genCICD:        '⚙️ **Génération CI/CD...**\n\nJ\'ouvre le panneau DevOps.',
            genKubernetes:  '☸️ **Génération Kubernetes...**\n\nJ\'ouvre le panneau DevOps.',
            openSDK:        '📦 **SDK Manager...**\n\nJ\'ouvre le gestionnaire de SDKs.',
            openRuntime:    '🤖 **Runtime Manager...**\n\nJ\'ouvre le panneau de gestion du runtime IA.',
            openEnvironment: '🔄 **Environnements Reproductibles...**\n\nJ\'ouvre le panneau de synchronisation d\'environnement. Scannez, exportez et comparez vos environnements développeur.'
        };

        const reply = replies[intent] || '✅ Action lancée.';
        this.panel.webview.postMessage({ type: 'aiMessage', text: reply, model: 'Sudo AI', mock: false });
        this._addHistory('assistant', reply, 'Sudo AI');

        // Execute the actual action
        setTimeout(() => {
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
            }
        }, 500);
    }

    async retryLast() {
        if (!this.lastUserMsg) return;
        // Remove last exchange from history
        while (this.history.length && this.history[this.history.length - 1].role === 'assistant') {
            this.history.pop();
        }
        if (this.history.length && this.history[this.history.length - 1].role === 'user') {
            this.history.pop();
        }
        this.panel.webview.postMessage({ type: 'retryMessage' });
        await this.handleChat(this.lastUserMsg);
    }

    stopGeneration() {
        if (this.abortCtrl) {
            this.abortCtrl.abort();
            this.abortCtrl = null;
        }
        this.panel.webview.postMessage({ type: 'generating', show: false });
    }

    clearHistory() {
        this.history = [];
        if (this.ctx) this.ctx.globalState.update('sudoChat.history', []);
        this.panel.webview.postMessage({ type: 'clearDone' });
    }

    _addHistory(role, content, model, mock) {
        this.history.push({ role, content, model, mock, ts: Date.now() });
        // Keep last 50 messages
        if (this.history.length > 50) this.history = this.history.slice(-50);
        if (this.ctx) this.ctx.globalState.update('sudoChat.history', this.history);
    }

    async sendStatus() {
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            this.panel.webview.postMessage({ type: 'status', data: r.data });
        } catch (_) {
            // Don't immediately show offline - runtime may still be starting
            // The status bar polling handles graceful offline detection
            this.panel.webview.postMessage({
                type: 'status',
                data: { status: 'starting', model: { loaded: false, loading: true, download_progress: 0 } }
            });
        }
    }

    async downloadModel(modelId) {
        try {
            await axios.post('http://localhost:6000/download',
                { model: modelId || 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'downloadStarted' });
            vscode.window.showInformationMessage(`⬇️ Downloading ${modelId}... Check status bar.`);
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', text: `Cannot reach runtime port 6000: ${e.message}` });
        }
    }

    async _sendToAI(text) {
        // PRIMARY PATH: Direct call to Python runtime on port 6000
        console.log('[EXT] _sendToAI — calling http://localhost:6000/infer');
        // This is always tried first — no auth required, most reliable
        const payload = { message: text, prompt: text, input: text, max_tokens: 512, temperature: 0.7 };

        // FIX BUG: AbortController signal was never passed to axios — Stop button had no effect.
        // Now we pass signal so axios cancels the request when abortCtrl.abort() is called.
        const signal = this.abortCtrl ? this.abortCtrl.signal : undefined;

        try {
            const r = await axios.post('http://localhost:6000/infer', payload, { timeout: 120000, signal });
            console.log('[EXT] /infer response — status:', r.status, '| reply[:60]:', (r.data.reply||'').slice(0,60));
            return r.data;
        } catch (e) {
            // If aborted by Stop button, rethrow as AbortError for proper UI handling
            if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
                const err = new Error('STOPPED');
                err.name = 'AbortError';
                throw err;
            }
            console.warn('[EXT] /infer error — code:', e.code, '| msg:', e.message);
            if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOTFOUND') {
                // Runtime is up but returned an error — still return what we got
                if (e.response && e.response.data) return e.response.data;
                throw new Error(`Runtime error: ${e.message}`);
            }
        }

        // FALLBACK PATH: Try backend:5000 proxy if runtime is down
        if (this.authToken) {
            try {
                const r = await axios.post('http://localhost:5000/api/ai/chat',
                    { message: text, model: 'default' },
                    { headers: { Authorization: `Bearer ${this.authToken}` }, timeout: 30000, signal });
                return r.data;
            } catch (e2) {
                if (e2.name === 'CanceledError' || e2.code === 'ERR_CANCELED') {
                    const err = new Error('STOPPED');
                    err.name = 'AbortError';
                    throw err;
                }
                /* otherwise ignore fallback error */
            }
        }

        throw new Error(
            'Runtime IA hors ligne (port 6000).\n' +
            'Vérifiez que runtime.exe est lancé depuis start.bat.'
        );
    }

    dispose() {
        ChatPanel.currentPanel = undefined;
        clearInterval(this._statusInterval);
        this.panel.dispose();
        this.disposables.forEach(d => d && d.dispose());
    }

    getHtmlContent() {
        // ── CSP NONCE ────────────────────────────────────────────────────────
        // VSCode WebView enforces "script-src 'nonce-XXXX'" — any <script> tag
        // without the matching nonce is silently blocked, which means
        // acquireVsCodeApi() never runs, sendMsg() is never defined, and the
        // keydown listener is never attached → button does nothing, Enter adds newline.
        // Fix: generate a per-load nonce and inject it into both the CSP meta tag
        // and the <script> tag.
        const nonce = (function() {
            let n = '';
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
            return n;
        })();

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sudo AI Chat</title>
<!-- FIX SESSION 14: CSP nonce required — without it the entire <script> block is
     silently blocked by VSCode WebView, making every button/keydown dead. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https:; connect-src http://localhost:*;">
<style>
/* ─── SUDO STUDIO DARK THEME OVERRIDE ─────────────────────── */
:root {
    --ss-bg: #0d1117; --ss-card-bg: #161b22; --ss-border: #21262d;
    --ss-btn-green: #2ea043; --ss-btn-blue: #1f6feb;
    --ss-text: #e6edf3; --ss-text-muted: #7d8590; --ss-radius: 8px;
    --ss-input-bg: #0d1117; --ss-success: #3fb950; --ss-warning: #d29922;
    --ss-error: #f85149; --ss-accent: #58a6ff;
    /* Map vscode vars to our dark theme */
    --vscode-editor-background: #0d1117;
    --vscode-editor-foreground: #e6edf3;
    --vscode-sideBar-background: #161b22;
    --vscode-panel-border: #21262d;
    --vscode-editorWidget-background: #161b22;
    --vscode-button-background: #2ea043;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #21262d;
    --vscode-button-secondaryForeground: #e6edf3;
    --vscode-input-background: #0d1117;
    --vscode-input-foreground: #e6edf3;
    --vscode-input-border: #21262d;
    --vscode-focusBorder: #1f6feb;
    --vscode-descriptionForeground: #7d8590;
    --vscode-textCodeBlock-background: #161b22;
    --vscode-scrollbarSlider-background: #21262d;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
#header {
    padding: 10px 14px; background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; justify-content: space-between; align-items: center; flex-shrink:0;
}
#header h1 { font-size:15px; font-weight:600; }
.hdr-btns { display:flex; gap:6px; }
#statusBar {
    padding: 5px 14px; font-size:11px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; align-items: center; gap: 8px; flex-shrink:0;
}
.dot { width:8px; height:8px; border-radius:50%; background:#888; flex-shrink:0; }
.dot.online  { background:#4caf50; }
.dot.loading { background:#ff9800; animation:pulse 1s infinite; }
.dot.offline { background:#f44336; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
#dlBar { display:none; padding:6px 14px; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--vscode-panel-border); flex-shrink:0; }
#dlBar.show { display:block; }
.dl-track { height:5px; background:var(--vscode-panel-border); border-radius:3px; overflow:hidden; }
.dl-fill   { height:100%; background:#4caf50; transition:width .3s; width:0; }
#chat {
    flex:1; overflow-y:auto; padding:14px;
    display:flex; flex-direction:column; gap:10px;
}
.empty {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    height:100%; gap:10px; color:var(--vscode-descriptionForeground); text-align:center;
}
.empty-icon { font-size:44px; opacity:.5; }
.quick-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px; max-width:380px; }
.qb {
    padding:8px 10px; border-radius:8px; font-size:12px; cursor:pointer; text-align:left;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:1px solid var(--vscode-panel-border); transition:opacity .2s;
    display:flex; align-items:center; gap:6px;
}
.qb:hover { opacity:.8; }
.msg { display:flex; gap:8px; animation:fadeIn .2s; }
.msg.user { flex-direction:row-reverse; }
@keyframes fadeIn { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
.av {
    width:28px; height:28px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:12px; font-weight:700; flex-shrink:0;
}
.msg.user .av { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.msg.ai  .av { background:linear-gradient(135deg,#7c3aed,#4f46e5); color:#fff; }
.bubble {
    max-width:82%; background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border); border-radius:12px;
    padding:10px 13px; font-size:13.5px; line-height:1.55; word-break:break-word;
}
.msg.user .bubble {
    background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none;
}
.bubble pre { margin:8px 0; border-radius:6px; overflow:auto; }
.bubble code:not([class]) {
    background:var(--vscode-textCodeBlock-background); padding:1px 5px;
    border-radius:3px; font-size:12px; font-family:monospace;
}
.bubble p { margin:4px 0; }
.bubble ul,.bubble ol { margin:6px 0 6px 18px; }
.meta { font-size:10px; opacity:.55; margin-top:5px; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.badge { font-size:10px; padding:1px 6px; border-radius:8px; background:rgba(255,152,0,.2); color:#ff9800; }
.copy-btn {
    float:right; margin:-2px 0 0 8px; font-size:10px; padding:2px 7px; cursor:pointer; border:none;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border-radius:4px;
}
.copy-btn:hover { opacity:.8; }
#genWrap { display:none; padding:8px 14px; flex-shrink:0; }
#genWrap.show { display:flex; align-items:center; gap:8px; }
.dot-wave { display:flex; gap:3px; align-items:center; }
.dot-wave span { width:6px; height:6px; border-radius:50%; background:var(--vscode-button-background); animation:dw 1.2s infinite; }
.dot-wave span:nth-child(2){animation-delay:.2s}
.dot-wave span:nth-child(3){animation-delay:.4s}
@keyframes dw { 0%,80%,100%{opacity:.2;transform:scale(.8)} 40%{opacity:1;transform:scale(1)} }
#inputArea {
    padding:10px 14px; background:var(--vscode-sideBar-background);
    border-top:1px solid var(--vscode-panel-border); flex-shrink:0;
}
.input-row { display:flex; gap:6px; align-items:flex-end; }
#msgInput {
    flex:1; background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:8px;
    padding:9px 12px; font-size:13.5px; font-family:inherit;
    resize:none; min-height:38px; max-height:110px;
}
#msgInput:focus { outline:none; border-color:var(--vscode-focusBorder); }
.ibtn {
    padding:9px 15px; min-height:38px; border:none; border-radius:8px;
    cursor:pointer; font-size:13px; font-weight:500; white-space:nowrap;
}
#sendBtn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); transition:opacity .2s; }
#sendBtn:hover { opacity:.85; }
#sendBtn:disabled { opacity:.45; cursor:not-allowed; }
#stopBtn { display:none; background:#c62828; color:#fff; }
#stopBtn.show { display:block; }
.sbtn {
    padding:4px 9px; font-size:11px; cursor:pointer; border:none; border-radius:4px;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
}
.sbtn:hover { opacity:.8; }
::-webkit-scrollbar { width:6px; }
::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); border-radius:3px; }
</style>
</head>
<body>
<div id="header">
    <h1>🤖 Sudo AI Chat</h1>
    <div class="hdr-btns">
        <button class="sbtn" id="agentModeBtn" title="Mode Agent Autonome" style="background:#1f6feb;color:#fff;border-color:#1f6feb">🤖 Agent</button>
        <button class="sbtn" id="newChatBtn" title="Nouvelle conversation">✨ New</button>
        <button class="sbtn" id="retryBtn" title="Réessayer">↩ Retry</button>
        <button class="sbtn" id="statusBtn">⟳ Status</button>
        <button class="sbtn" id="clearBtn">🗑 Clear</button>
    </div>
</div>

<div id="statusBar">
    <div class="dot" id="dot"></div>
    <span id="statusTxt">Vérification runtime...</span>
    <button class="sbtn" id="dlBtn" style="display:none">⬇ Download Model</button>
</div>

<div id="dlBar">
    <div style="font-size:10px;margin-bottom:3px" id="dlLabel">Téléchargement modèle...</div>
    <div class="dl-track"><div class="dl-fill" id="dlFill"></div></div>
</div>

<div id="chat">
    <div class="empty" id="emptyState">
        <div class="empty-icon">🤖</div>
        <div style="font-size:16px;font-weight:600">Sudo AI Assistant</div>
        <div style="font-size:12px;opacity:.7">Posez une question ou choisissez une action rapide</div>
        <div class="quick-grid" id="quickGrid">
            <button class="qb" data-prompt="Analyse ce projet">🔍 Analyser le projet</button>
            <button class="qb" data-prompt="Diagnostique mon système">🩺 System Doctor</button>
            <button class="qb" data-prompt="Crée un Dockerfile">🐳 Dockerfile</button>
            <button class="qb" data-prompt="Génère un pipeline CI/CD GitHub Actions">⚙️ CI/CD Pipeline</button>
            <button class="qb" data-prompt="Corrige automatiquement les erreurs">🔧 AutoFix</button>
            <button class="qb" data-vscpost='{"type":"openRuntime"}'>🤖 Runtime &amp; Modèles</button>
            <button class="qb" data-vscpost='{"type":"openSDK"}'>📦 SDK Manager</button>
            <button class="qb" data-vscpost='{"type":"openDevOps"}'>🚀 DevOps Panel</button>
            <button class="qb" data-vscpost='{"type":"openEnvironment"}'>🔄 Env Reproductible</button>
        </div>
    </div>
</div>

<div id="genWrap">
    <div class="dot-wave"><span></span><span></span><span></span></div>
    <span style="font-size:12px;opacity:.7">Sudo AI réfléchit...</span>
</div>

<div id="inputArea">
    <div class="input-row">
        <textarea id="msgInput" rows="1" placeholder="Message... (Entrée = envoyer, Shift+Entrée = nouvelle ligne)"></textarea>
        <button class="ibtn" id="sendBtn">Envoyer</button>
        <button class="ibtn" id="stopBtn">⏹ Stop</button>
    </div>
</div>

<script nonce="${nonce}">
// ── DIAGNOSTIC SESSION 15 ────────────────────────────────────────────────
// Every step logs to console so Help→Toggle Dev Tools shows exact failure.
console.log('[CHAT] Script starting — nonce OK, DOM loading...');

// ── FIX: acquireVsCodeApi() throws if called twice (panel reveal/reload).
// Without try/catch the ENTIRE script crashes here and nothing below runs.
// Always guard with try/catch and cache in window._vscode.
let vscode;
try {
    vscode = acquireVsCodeApi();
    window._vscode = vscode;
    console.log('[CHAT] acquireVsCodeApi() OK — vscode:', typeof vscode);
} catch(e) {
    // Already acquired — reuse the cached instance.
    vscode = window._vscode;
    console.warn('[CHAT] acquireVsCodeApi() threw (already acquired) — reusing cached:', typeof vscode, '| error:', e.message);
}
if (!vscode) {
    console.error('[CHAT] FATAL: vscode API unavailable — postMessage will fail');
}

const chat  = document.getElementById('chat');
const input = document.getElementById('msgInput');
console.log('[CHAT] DOM refs — chat:', chat ? 'OK' : 'NULL', '| input(msgInput):', input ? 'OK' : 'NULL');

let generating = false;

function vscPost(msg) {
    if (!vscode) { console.error('[CHAT] vscPost: vscode undefined, cannot send', msg); return; }
    try {
        vscode.postMessage(msg);
        console.log('[CHAT] vscPost OK — type:', msg.type);
    } catch(e) {
        console.error('[CHAT] vscPost ERROR:', e.message, '| msg:', JSON.stringify(msg));
    }
}

function sendMsg() {
    console.log('[CHAT] sendMsg() called — generating:', generating);
    if (!input) { console.error('[CHAT] sendMsg: input#msgInput not found'); return; }
    const t = input.value.trim();
    console.log('[CHAT] sendMsg text:', JSON.stringify(t));
    if (!t || generating) {
        console.log('[CHAT] sendMsg: aborted — empty:', !t, '| generating:', generating);
        return;
    }
    input.value = ''; input.style.height = 'auto';
    setGenerating(true);
    vscPost({ type: 'sendMessage', text: t });
    // Safety timeout: auto-reset if no aiMessage in 130s
    const _safetyTimer = setTimeout(() => {
        if (generating) {
            setGenerating(false);
            console.warn('[CHAT] Safety timeout: reset generating after 130s');
        }
    }, 130000);
    window._sendSafetyTimer = _safetyTimer;
}
function retryLast()    { vscPost({ type: 'retryLast' }); }
function stopGen()      {
    vscPost({ type: 'stopGeneration' });
    setGenerating(false);
    if (window._sendSafetyTimer) { clearTimeout(window._sendSafetyTimer); window._sendSafetyTimer = null; }
}
function clearChat()    { vscPost({ type: 'clearChat' }); }
function checkStatus()  { vscPost({ type: 'checkStatus' }); }
function downloadModel(){ vscPost({ type: 'downloadModel', modelId: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }); }
function usePrompt(t)   {
    console.log('[CHAT] usePrompt:', JSON.stringify(t));
    if (input) { input.value = t; input.focus(); sendMsg(); }
}
function newChat()      { vscPost({ type: 'clearChat' }); }

function setGenerating(v) {
    generating = v;
    document.getElementById('sendBtn').disabled = v;
    document.getElementById('genWrap').classList.toggle('show', v);
    document.getElementById('stopBtn').classList.toggle('show', v);
    // Cancel safety timer whenever generating is turned off
    if (!v && window._sendSafetyTimer) {
        clearTimeout(window._sendSafetyTimer);
        window._sendSafetyTimer = null;
    }
}

// ── FIX SESSION 14+15: Replace ALL inline onclick= with addEventListener ──
// VSCode WebView CSP blocks onclick="..." HTML attributes (inline handlers).
// Every button must be wired via JS addEventListener AFTER the script loads.

// Send button
const sendBtnEl = document.getElementById('sendBtn');
if (sendBtnEl) {
    sendBtnEl.addEventListener('click', function(e) { e.preventDefault(); sendMsg(); });
    console.log('[CHAT] sendBtn listener attached');
} else { console.error('[CHAT] sendBtn NOT FOUND in DOM'); }

// Stop button
const stopBtnEl = document.getElementById('stopBtn');
if (stopBtnEl) {
    stopBtnEl.addEventListener('click', function(e) { e.preventDefault(); stopGen(); });
    console.log('[CHAT] stopBtn listener attached');
} else { console.error('[CHAT] stopBtn NOT FOUND in DOM'); }

// Header buttons
['newChatBtn','retryBtn','statusBtn','clearBtn'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('click', function() {
            if (id === 'newChatBtn') newChat();
            else if (id === 'retryBtn') retryLast();
            else if (id === 'statusBtn') checkStatus();
            else if (id === 'clearBtn') clearChat();
        });
        console.log('[CHAT] ' + id + ' listener attached');
    } else { console.warn('[CHAT] ' + id + ' not found'); }
});

// Agent mode button
const agentModeEl = document.getElementById('agentModeBtn');
if (agentModeEl) {
    agentModeEl.addEventListener('click', function() {
        vscPost({ type: 'openAgentMode' });
    });
    console.log('[CHAT] agentModeBtn listener attached');
}

// Download Model button
const dlBtnEl = document.getElementById('dlBtn');
if (dlBtnEl) {
    dlBtnEl.addEventListener('click', function() { downloadModel(); });
}

// Quick-action buttons — use data attributes, delegate via event bubbling
function bindQuickGrid(container) {
    container.querySelectorAll('.qb').forEach(function(btn) {
        btn.addEventListener('click', function() {
            const prompt = btn.getAttribute('data-prompt');
            const post   = btn.getAttribute('data-vscpost');
            if (prompt) { usePrompt(prompt); }
            else if (post) { try { vscPost(JSON.parse(post)); } catch(_) {} }
        });
    });
}
// Bind initial quick-grid (in #emptyState)
const initialGrid = document.getElementById('quickGrid');
if (initialGrid) bindQuickGrid(initialGrid.parentElement);

// Keyboard: Enter = send, Shift+Enter = newline
if (input) {
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            console.log('[CHAT] Enter key detected → sendMsg()');
            sendMsg();
        }
    });
    input.addEventListener('input', function() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
    console.log('[CHAT] keydown+input listeners attached on #msgInput');
    input.focus();
} else {
    console.error('[CHAT] FATAL: #msgInput not found — keyboard send impossible');
}

console.log('[CHAT] Script init complete — all listeners attached');

// ── Rendering ─────────────────────────────────────────────────────────────
function addMsg(html, isUser, meta, noScroll) {
    removeEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (isUser ? 'user' : 'ai');
    const av = document.createElement('div');
    av.className = 'av';
    av.textContent = isUser ? 'U' : 'AI';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = html;
    if (meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.innerHTML = meta;
        b.appendChild(m);
    }
    if (!isUser) {
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
            navigator.clipboard.writeText(b.innerText.replace(/Copy$/, '').trim());
            btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Copy', 1500);
        };
        b.insertBefore(btn, b.firstChild);
    }
    wrap.appendChild(av);
    wrap.appendChild(b);
    chat.appendChild(wrap);
    if (!noScroll) chat.scrollTop = chat.scrollHeight;
    // Syntax highlight
    b.querySelectorAll('pre code').forEach(block => {
        if (window.hljs) window.hljs.highlightElement(block);
    });
}

function renderMarkdown(text) {
    // FIX SESSION 16: All regex rewritten using new RegExp() constructor to avoid
    // template-literal escape interpretation bugs. This function body lives inside
    // the outer getHtmlContent() template literal, so Node.js evaluates escapes:
    //   backslash+backtick  => raw backtick  => opens unclosed template literal
    //   backslash-n in /.../ => literal newline => "Invalid regular expression: missing /"
    //   backslash-star-star  => ** => parsed as block-comment start
    //   backslash-d         => d  => backslash stripped, no longer matches digits
    // Using new RegExp(string) avoids all of these because the string is NOT
    // re-interpreted as a regex literal by the WebView JavaScript parser.

    // Escape HTML first — these simple char-class regexes are safe
    let t = text
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Code blocks: triple-backtick lang newline code triple-backtick
    // Uses new RegExp() to avoid backtick/newline issues in template literal context
    var reCB = new RegExp('\\x60{3}(\\w*)\\n?([\\s\\S]*?)\\x60{3}', 'g');
    t = t.replace(reCB, function(_, lang, code) {
        return '<pre><code class="language-' + (lang || 'text') + '">' + code.trim() + '</code></pre>';
    });

    // Inline code: single-backtick code single-backtick
    // Uses new RegExp() to avoid backtick in regex literal
    var reIC = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
    t = t.replace(reIC, '<code>$1</code>');

    // Bold: **text** — avoid ** being parsed as block comment /*...*/
    var reBold = new RegExp('[*][*]([^*]+)[*][*]', 'g');
    t = t.replace(reBold, '<strong>$1</strong>');

    // Italic: *text* (single star, not double) — same issue
    var reItalic = new RegExp('(?<![*])[*]([^*]+)[*](?![*])', 'g');
    t = t.replace(reItalic, '<em>$1</em>');

    // Headers — these are safe as regex literals (no backtick/star issues)
    t = t.replace(/^### (.+)$/gm, '<strong>$1</strong>');
    t = t.replace(/^## (.+)$/gm, '<strong style="font-size:1.1em">$1</strong>');
    t = t.replace(/^# (.+)$/gm,  '<strong style="font-size:1.2em">$1</strong>');

    // Lists
    t = t.replace(/^[*-] (.+)$/gm, '• $1');

    // Numbered lists — avoid \d (stripped to d by template literal)
    var reNum = new RegExp('^[0-9]+[.] (.+)$', 'gm');
    t = t.replace(reNum, function(_, c) { return '› ' + c; });

    // Line breaks — use new RegExp with double-escaped backslash-n (avoids template literal evaluation)
    var reNL = new RegExp('\\n', 'g');
    t = t.replace(reNL, '<br>');
    return t;
}

function removeEmpty() {
    const e = document.getElementById('emptyState');
    if (e) e.remove();
}

// ── Status ─────────────────────────────────────────────────────────────────
function updateStatus(data) {
    const dot = document.getElementById('dot');
    const txt = document.getElementById('statusTxt');
    const dlBtn = document.getElementById('dlBtn');
    const dlBar = document.getElementById('dlBar');
    const dlFill = document.getElementById('dlFill');
    const dlLabel = document.getElementById('dlLabel');

    if (!data || data.status === 'offline') {
        dot.className = 'dot offline';
        txt.textContent = 'Runtime hors ligne - lancez runtime.exe';
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
        return;
    }
    if (data.status === 'starting') {
        dot.className = 'dot loading';
        txt.textContent = 'Runtime en demarrage... (3-5 min pour TinyLlama)';
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
        return;
    }
    const m = data.model || {};
    if (m.loading) {
        dot.className = 'dot loading';
        const pct = m.download_progress || 0;
        txt.textContent = '⬇ Chargement modèle ' + pct + '%...';
        dlBar.classList.add('show');
        dlFill.style.width = pct + '%';
        dlLabel.textContent = 'Chargement: ' + (m.name || 'TinyLlama') + ' — ' + pct + '%';
        dlBtn.style.display = 'none';
    } else if (m.loaded) {
        dot.className = 'dot online';
        txt.textContent = '\u2705 IA pr\u00eate \u00b7 ' + (m.name || 'mod\u00e8le') + ' \u00b7 ' + (m.device || 'cpu');
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
    } else {
        dot.className = 'dot offline';
        txt.textContent = '⚠ Aucun modèle — cliquez Download';
        dlBtn.style.display = 'inline-block';
        dlBar.classList.remove('show');
    }
}

// ── Messages from extension ───────────────────────────────────────────────
window.addEventListener('message', ev => {
    const msg = ev.data;
    console.log('[CHAT] Message from extension — type:', msg.type, '| keys:', Object.keys(msg).join(','));
    switch (msg.type) {
        case 'userMessage':
            addMsg(msg.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(new RegExp('\\n','g'),'<br>'),

                true, null, msg.noScroll);
            break;
        case 'aiMessage': {
            console.log('[CHAT] aiMessage received — model:', msg.model, '| mock:', msg.mock, '| text[:60]:', (msg.text||'').slice(0,60));
            let meta = '';
            if (msg.model) meta += msg.model;
            if (msg.latency && msg.latency > 0) meta += (meta ? ' · ' : '') + msg.latency + 'ms';
            if (msg.mock && msg.loading) {
                meta += '<span class="badge" style="background:rgba(33,150,243,.2);color:#2196f3">Chargement modele...</span>';
            } else if (msg.mock) {
                meta += '<span class="badge">Mode basique</span>';
            }
            if (msg.progress !== undefined && msg.progress > 0 && msg.progress < 100) {
                meta += (meta ? ' · ' : '') + msg.progress + '%';
            }
            addMsg(renderMarkdown(msg.text), false, meta, msg.noScroll);
            setGenerating(false);
            break;
        }
        case 'error':
            // FIX BUG: 'error' case never called setGenerating(false) — button stayed
            // disabled forever after any network error. Fixed: always reset.
            addMsg('<span style="color:var(--vscode-errorForeground)">' +
                msg.text.replace(new RegExp('\\n','g'),'<br>') + '</span>', false);
            setGenerating(false);
            if (window._sendSafetyTimer) { clearTimeout(window._sendSafetyTimer); window._sendSafetyTimer = null; }
            break;
        case 'generating':
            if (!msg.show) setGenerating(false);
            break;
        case 'status':
            updateStatus(msg.data);
            break;
        case 'downloadStarted':
            document.getElementById('dlBtn').style.display = 'none';
            document.getElementById('dlBar').classList.add('show');
            break;
        case 'clearDone':
            chat.innerHTML = '';
            const es = document.createElement('div');
            es.className = 'empty'; es.id = 'emptyState';
            // FIX: Build buttons programmatically — no inline onclick= (blocked by CSP)
            const esIcon  = document.createElement('div'); esIcon.className = 'empty-icon'; esIcon.textContent = '🤖';
            const esTitle = document.createElement('div'); esTitle.style.cssText = 'font-size:16px;font-weight:600'; esTitle.textContent = 'Nouvelle conversation';
            const esGrid  = document.createElement('div'); esGrid.className = 'quick-grid';
            const esItems = [
                { label: '🔍 Analyser le projet',   prompt: 'Analyse ce projet' },
                { label: '🩺 System Doctor',         prompt: 'Diagnostique mon système' },
                { label: '🐳 Dockerfile',             prompt: 'Crée un Dockerfile' },
                { label: '⚙️ CI/CD',                 prompt: 'Génère un pipeline CI/CD' },
                { label: '🔧 AutoFix',               prompt: 'Corrige automatiquement' },
                { label: '🤖 Modèles IA',            vscpost: {type:'openRuntime'} }
            ];
            esItems.forEach(function(item) {
                const b = document.createElement('button');
                b.className = 'qb'; b.textContent = item.label;
                b.addEventListener('click', function() {
                    if (item.prompt)  { usePrompt(item.prompt); }
                    else if (item.vscpost) { vscPost(item.vscpost); }
                });
                esGrid.appendChild(b);
            });
            es.appendChild(esIcon); es.appendChild(esTitle); es.appendChild(esGrid);
            chat.appendChild(es);
            break;
        case 'retryMessage':
            // Remove last AI message from DOM
            const msgs = chat.querySelectorAll('.msg.ai');
            if (msgs.length) msgs[msgs.length-1].remove();
            break;
    }
});

// FIX BUG: Removed duplicate WebView-side poll (setInterval checkStatus every 5s).
// The Extension Host already polls every 5s via this._statusInterval and pushes 
// status updates to the WebView. Having both caused double the network requests.
// Initial status check on open is already handled in constructor setTimeout.
// NOTE: input.focus() is now inside the if(input) block above.
</script>
</body>
</html>`;
    }
}

module.exports = { ChatPanel };
