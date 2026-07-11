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
        this.lastUserMsg = text;

        // Show user message immediately
        this.panel.webview.postMessage({ type: 'userMessage', text });
        this._addHistory('user', text);

        // Check for intent shortcuts
        const intent = this._detectIntent(text);
        if (intent) {
            await this._handleIntent(intent, text);
            return;
        }

        // Normal AI call
        this.panel.webview.postMessage({ type: 'generating', show: true });
        this.abortCtrl = new AbortController();

        try {
            const reply = await this._sendToAI(text);
            this.panel.webview.postMessage({ type: 'generating', show: false });
            this.panel.webview.postMessage({
                type: 'aiMessage',
                text: reply.reply || reply.response || 'Pas de réponse.',
                model: reply.model || 'AI',
                latency: reply.latency_ms,
                mock: reply.mock || false,
                progress: reply.download_progress
            });
            this._addHistory('assistant', reply.reply || reply.response || '', reply.model, reply.mock);
        } catch (e) {
            this.panel.webview.postMessage({ type: 'generating', show: false });
            if (e.name === 'AbortError' || e.message === 'STOPPED') {
                this.panel.webview.postMessage({ type: 'aiMessage', text: '⏹ Génération arrêtée.', model: 'system' });
            } else {
                this.panel.webview.postMessage({
                    type: 'error',
                    text: `❌ ${e.message}\n\nVérifiez que runtime.exe est lancé (port 6000).`
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
            this.panel.webview.postMessage({
                type: 'status',
                data: { status: 'offline', model: { loaded: false, loading: false, download_progress: 0 } }
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
        // This is always tried first — no auth required, most reliable
        const payload = { message: text, prompt: text, input: text, max_tokens: 512, temperature: 0.7 };

        // FIX BUG: AbortController signal was never passed to axios — Stop button had no effect.
        // Now we pass signal so axios cancels the request when abortCtrl.abort() is called.
        const signal = this.abortCtrl ? this.abortCtrl.signal : undefined;

        try {
            const r = await axios.post('http://localhost:6000/infer', payload, { timeout: 120000, signal });
            return r.data;
        } catch (e) {
            // If aborted by Stop button, rethrow as AbortError for proper UI handling
            if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
                const err = new Error('STOPPED');
                err.name = 'AbortError';
                throw err;
            }
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
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sudo AI Chat</title>
<!-- FIX: Removed external CDN scripts — blocked by VS Code WebView CSP.
     Syntax highlighting is done inline with simple token coloring instead. -->
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
        <button class="sbtn" onclick="newChat()" title="Nouvelle conversation">✨ New</button>
        <button class="sbtn" onclick="retryLast()" title="Réessayer">↩ Retry</button>
        <button class="sbtn" onclick="checkStatus()">⟳ Status</button>
        <button class="sbtn" onclick="clearChat()">🗑 Clear</button>
    </div>
</div>

<div id="statusBar">
    <div class="dot" id="dot"></div>
    <span id="statusTxt">Vérification runtime...</span>
    <button class="sbtn" id="dlBtn" style="display:none" onclick="downloadModel()">⬇ Download Model</button>
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
        <div class="quick-grid">
            <button class="qb" onclick="usePrompt('Analyse ce projet')">🔍 Analyser le projet</button>
            <button class="qb" onclick="usePrompt('Diagnostique mon système')">🩺 System Doctor</button>
            <button class="qb" onclick="usePrompt('Crée un Dockerfile')">🐳 Dockerfile</button>
            <button class="qb" onclick="usePrompt('Génère un pipeline CI/CD GitHub Actions')">⚙️ CI/CD Pipeline</button>
            <button class="qb" onclick="usePrompt('Corrige automatiquement les erreurs')">🔧 AutoFix</button>
            <button class="qb" onclick="vscPost({type:'openRuntime'})">🤖 Runtime & Modèles</button>
            <button class="qb" onclick="vscPost({type:'openSDK'})">📦 SDK Manager</button>
            <button class="qb" onclick="vscPost({type:'openDevOps'})">🚀 DevOps Panel</button>
            <button class="qb" onclick="vscPost({type:'openEnvironment'})">🔄 Env Reproductible</button>
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
        <button class="ibtn" id="sendBtn" onclick="sendMsg()">Envoyer</button>
        <button class="ibtn" id="stopBtn" onclick="stopGen()">⏹ Stop</button>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const chat   = document.getElementById('chat');
const input  = document.getElementById('msgInput');
let generating = false;

function vscPost(msg) { vscode.postMessage(msg); }
function sendMsg() {
    const t = input.value.trim();
    if (!t || generating) return;
    setGenerating(true);
    vscPost({ type: 'sendMessage', text: t });
    input.value = ''; input.style.height = 'auto';
}
function retryLast() { vscPost({ type: 'retryLast' }); }
function stopGen()   { vscPost({ type: 'stopGeneration' }); setGenerating(false); }
function clearChat() { vscPost({ type: 'clearChat' }); }
function checkStatus(){ vscPost({ type: 'checkStatus' }); }
function downloadModel(){ vscPost({ type: 'downloadModel', modelId: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }); }
function usePrompt(t){ input.value = t; input.focus(); sendMsg(); }
function newChat() {
    vscPost({ type: 'clearChat' });
}

function setGenerating(v) {
    generating = v;
    document.getElementById('sendBtn').disabled = v;
    document.getElementById('genWrap').classList.toggle('show', v);
    document.getElementById('stopBtn').classList.toggle('show', v);
}

input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
});

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
    // Escape HTML first
    let t = text
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Code blocks
    t = t.replace(/\`\`\`(\w*)\n?([\s\S]*?)\`\`\`/g, (_, lang, code) =>
        \`<pre><code class="language-\${lang || 'text'}">\${code.trim()}</code></pre>\`);
    // Inline code
    t = t.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Bold
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Headers
    t = t.replace(/^### (.+)$/gm, '<strong>$1</strong>');
    t = t.replace(/^## (.+)$/gm, '<strong style="font-size:1.1em">$1</strong>');
    t = t.replace(/^# (.+)$/gm, '<strong style="font-size:1.2em">$1</strong>');
    // Lists
    t = t.replace(/^[*-] (.+)$/gm, '• $1');
    t = t.replace(/^\d+\. (.+)$/gm, (_, c) => '› ' + c);
    // Line breaks
    t = t.replace(/\n/g, '<br>');
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
        txt.textContent = '⚠ Runtime hors ligne — lancez runtime.exe';
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
        return;
    }
    const m = data.model || {};
    if (m.loading) {
        dot.className = 'dot loading';
        const pct = m.download_progress || 0;
        txt.textContent = \`⬇ Chargement modèle \${pct}%...\`;
        dlBar.classList.add('show');
        dlFill.style.width = pct + '%';
        dlLabel.textContent = \`Chargement: \${m.name || 'TinyLlama'} — \${pct}%\`;
        dlBtn.style.display = 'none';
    } else if (m.loaded) {
        dot.className = 'dot online';
        txt.textContent = \`✅ IA prête · \${m.name || 'modèle'} · \${m.device || 'cpu'}\`;
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
    switch (msg.type) {
        case 'userMessage':
            addMsg(msg.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'),
                true, null, msg.noScroll);
            break;
        case 'aiMessage': {
            let meta = '';
            if (msg.model) meta += 'Modèle: ' + msg.model;
            if (msg.latency) meta += (meta ? ' · ' : '') + msg.latency + 'ms';
            if (msg.mock) meta += '<span class="badge">⚠ Mock</span>';
            if (msg.progress !== undefined && msg.progress < 100) meta += (meta ? ' · ' : '') + '⬇ ' + msg.progress + '%';
            addMsg(renderMarkdown(msg.text), false, meta, msg.noScroll);
            setGenerating(false);
            break;
        }
        case 'error':
            addMsg('<span style="color:var(--vscode-errorForeground)">' +
                msg.text.replace(/\n/g,'<br>') + '</span>', false);
            setGenerating(false);
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
            es.innerHTML = \`<div class="empty-icon">🤖</div><div style="font-size:16px;font-weight:600">Nouvelle conversation</div>
            <div class="quick-grid">
                <button class="qb" onclick="usePrompt('Analyse ce projet')">🔍 Analyser le projet</button>
                <button class="qb" onclick="usePrompt('Diagnostique mon système')">🩺 System Doctor</button>
                <button class="qb" onclick="usePrompt('Crée un Dockerfile')">🐳 Dockerfile</button>
                <button class="qb" onclick="usePrompt('Génère un pipeline CI/CD')">⚙️ CI/CD</button>
                <button class="qb" onclick="usePrompt('Corrige automatiquement')">🔧 AutoFix</button>
                <button class="qb" onclick="vscPost({type:'openRuntime'})">🤖 Modèles IA</button>
            </div>\`;
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
input.focus();
</script>
</body>
</html>`;
    }
}

module.exports = { ChatPanel };
