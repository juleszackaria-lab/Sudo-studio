/**
 * SUDO STUDIO - Chat Panel
 * Webview panel with fully functional AI chat.
 * Falls back to direct runtime call (port 6000) if backend (port 5000) is unavailable.
 */
const vscode = require('vscode');
const axios  = require('axios');

class ChatPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel        = panel;
        this.extensionUri = extensionUri;
        this.disposables  = [];
        this.authToken    = null;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Try to get auth token quietly (don't block the panel opening)
        this._tryLogin();
    }

    static createOrShow(extensionUri) {
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
        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    }

    async _tryLogin() {
        try {
            const r = await axios.post('http://localhost:5000/api/auth/login',
                { username: 'admin', password: 'admin123' },
                { timeout: 3000 });
            this.authToken = r.data.token;
        } catch (_) {
            this.authToken = null; // Will use direct runtime call
        }
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'sendMessage':
                await this.handleChat(message.text);
                break;
            case 'clearChat':
                // handled by webview JS
                break;
            case 'checkStatus':
                await this.sendStatus();
                break;
            case 'downloadModel':
                await this.downloadModel(message.modelId);
                break;
        }
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
            const r = await axios.post('http://localhost:6000/download',
                { model: modelId || 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' },
                { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'downloadStarted', data: r.data });
            vscode.window.showInformationMessage(`⬇️ Downloading model ${modelId}... Check runtime status.`);
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', text: `Cannot reach runtime on port 6000: ${e.message}` });
        }
    }

    async handleChat(text) {
        if (!text || !text.trim()) return;

        // Show user message immediately in webview
        this.panel.webview.postMessage({ type: 'userMessage', text });
        this.panel.webview.postMessage({ type: 'loading', show: true });

        try {
            const reply = await this._sendToAI(text);
            this.panel.webview.postMessage({ type: 'loading', show: false });
            this.panel.webview.postMessage({
                type: 'aiMessage',
                text: reply.reply || reply.response || 'No response.',
                model: reply.model || reply.model_used || 'AI',
                latency: reply.latency_ms || reply.latency,
                mock: reply.mock || false,
                progress: reply.download_progress
            });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'loading', show: false });
            this.panel.webview.postMessage({
                type: 'error',
                text: `❌ ${e.message}\n\nAssurez-vous que:\n1. backend.exe est lancé (port 5000)\n2. runtime.exe est lancé (port 6000)`
            });
        }
    }

    async _sendToAI(text) {
        const payload = { message: text, prompt: text, input: text, max_tokens: 256, temperature: 0.7 };

        // Strategy 1: via backend (port 5000) with auth
        if (this.authToken) {
            try {
                const r = await axios.post('http://localhost:5000/api/ai/chat',
                    { message: text, model: 'default' },
                    { headers: { Authorization: `Bearer ${this.authToken}` }, timeout: 90000 });
                return r.data;
            } catch (e) {
                if (e.code === 'ECONNREFUSED') {
                    // Backend down, try direct
                } else {
                    throw e;
                }
            }
        }

        // Strategy 2: direct to runtime (port 6000) - bypasses backend/auth
        const r = await axios.post('http://localhost:6000/infer', payload, { timeout: 90000 });
        return r.data;
    }

    dispose() {
        ChatPanel.currentPanel = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d && d.dispose());
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sudo AI Chat</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
#header {
    padding: 12px 16px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
}
#header h1 { font-size:16px; font-weight:600; }
#statusBar {
    padding: 6px 16px;
    font-size: 11px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.status-dot { width:8px; height:8px; border-radius:50%; background:#888; }
.status-dot.online  { background: #4caf50; }
.status-dot.loading { background: #ff9800; animation: pulse 1s infinite; }
.status-dot.offline { background: #f44336; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
#modelDownloadBar {
    display: none;
    padding: 8px 16px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
}
#modelDownloadBar.show { display: block; }
.progress-bar {
    height: 6px;
    background: var(--vscode-progressBar-background, #0078d4);
    border-radius: 3px;
    transition: width 0.3s;
}
#chatContainer {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.empty-state {
    display:flex; flex-direction:column; align-items:center;
    justify-content:center; height:100%; gap:12px;
    color:var(--vscode-descriptionForeground); text-align:center;
}
.empty-state-icon { font-size:40px; opacity:.6; }
.empty-state h2 { font-size:18px; font-weight:500; }
.empty-state p  { font-size:13px; opacity:.7; }
.quick-prompts { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; justify-content:center; }
.quick-prompt {
    padding:6px 12px; border-radius:16px; font-size:12px; cursor:pointer;
    background:var(--vscode-button-secondaryBackground);
    color:var(--vscode-button-secondaryForeground);
    border:1px solid var(--vscode-button-border,transparent);
    transition: opacity .2s;
}
.quick-prompt:hover { opacity:.8; }
.message { display:flex; gap:10px; animation: fadeIn .25s ease-out; }
@keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.message.user { flex-direction:row-reverse; }
.avatar {
    width:30px; height:30px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:13px; font-weight:700; flex-shrink:0;
}
.message.user .avatar { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.message.ai   .avatar { background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; }
.message-content {
    max-width:80%; background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border);
    border-radius:12px; padding:10px 14px; font-size:14px; line-height:1.5;
}
.message.user .message-content {
    background:var(--vscode-button-background);
    color:var(--vscode-button-foreground); border:none;
}
.message-meta { font-size:10px; opacity:.6; margin-top:6px; }
.mock-badge {
    display:inline-block; font-size:10px; padding:2px 6px;
    background:#ff980020; color:#ff9800; border-radius:8px; margin-left:6px;
}
pre { background:var(--vscode-textCodeBlock-background); padding:10px; border-radius:6px; overflow-x:auto; margin:6px 0; }
code { font-family:monospace; font-size:12px; }
.copy-btn {
    float:right; font-size:10px; padding:2px 6px; cursor:pointer; border:none;
    background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border-radius:4px; margin-top:-2px;
}
#loadingIndicator {
    display:none; padding:10px 16px; text-align:center;
    color:var(--vscode-descriptionForeground); font-size:13px; flex-shrink:0;
}
#loadingIndicator.show { display:block; }
.dots span { animation: blink 1.2s infinite; }
.dots span:nth-child(2){animation-delay:.2s}
.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:0}40%{opacity:1}}
#inputArea {
    padding: 12px 16px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
}
#inputForm { display:flex; gap:8px; align-items:flex-end; }
#msgInput {
    flex:1; background:var(--vscode-input-background);
    color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border);
    border-radius:8px; padding:10px 12px; font-size:14px; font-family:inherit;
    resize:none; min-height:40px; max-height:120px;
}
#msgInput:focus { outline:none; border-color:var(--vscode-focusBorder); }
#sendBtn {
    padding:10px 18px; min-height:40px;
    background:var(--vscode-button-background); color:var(--vscode-button-foreground);
    border:none; border-radius:8px; cursor:pointer; font-size:14px; font-weight:500;
    transition: opacity .2s;
}
#sendBtn:hover { opacity:.85; }
#sendBtn:disabled { opacity:.5; cursor:not-allowed; }
.btn-small {
    padding:4px 10px; font-size:11px; cursor:pointer; border:none; border-radius:4px;
    background:var(--vscode-button-secondaryBackground);
    color:var(--vscode-button-secondaryForeground); margin-left:6px;
}
.btn-small:hover { opacity:.8; }
::-webkit-scrollbar { width:8px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); border-radius:4px; }
</style>
</head>
<body>
<div id="header">
    <h1>🤖 Sudo AI Chat</h1>
    <div>
        <button class="btn-small" onclick="clearChat()">🗑 Clear</button>
        <button class="btn-small" onclick="checkStatus()">⟳ Status</button>
    </div>
</div>

<div id="statusBar">
    <div class="status-dot" id="statusDot"></div>
    <span id="statusText">Checking runtime...</span>
    <button class="btn-small" id="downloadBtn" style="display:none" onclick="downloadDefaultModel()">⬇ Download Model</button>
</div>

<div id="modelDownloadBar">
    <div style="font-size:11px;margin-bottom:4px;" id="downloadLabel">Downloading model...</div>
    <div style="background:var(--vscode-progressBar-background,#333);border-radius:3px;height:6px;">
        <div class="progress-bar" id="progressBar" style="width:0%"></div>
    </div>
</div>

<div id="chatContainer">
    <div class="empty-state" id="emptyState">
        <div class="empty-state-icon">🤖</div>
        <h2>Sudo AI Assistant</h2>
        <p>Posez vos questions sur le code, les erreurs ou le développement.</p>
        <div class="quick-prompts">
            <button class="quick-prompt" onclick="usePrompt('Explique-moi ce code')">Expliquer du code</button>
            <button class="quick-prompt" onclick="usePrompt('Corrige cette erreur')">Corriger une erreur</button>
            <button class="quick-prompt" onclick="usePrompt('Génère un Dockerfile pour Node.js')">Dockerfile Node.js</button>
            <button class="quick-prompt" onclick="usePrompt('Quel est l\\'état du système ?')">État du système</button>
        </div>
    </div>
</div>

<div id="loadingIndicator">
    <span class="dots">AI réfléchit<span>.</span><span>.</span><span>.</span></span>
</div>

<div id="inputArea">
    <form id="inputForm" onsubmit="return false;">
        <textarea id="msgInput" placeholder="Tapez votre message... (Entrée pour envoyer, Shift+Entrée pour nouvelle ligne)" rows="1"></textarea>
        <button type="button" id="sendBtn" onclick="sendMessage()">Envoyer</button>
    </form>
</div>

<script>
const vscode = acquireVsCodeApi();
const chat   = document.getElementById('chatContainer');
const input  = document.getElementById('msgInput');
const loading= document.getElementById('loadingIndicator');
let sending  = false;
let statusTimer = null;

// ── Sending ──────────────────────────────────────────────────────────────────
function sendMessage() {
    const text = input.value.trim();
    if (!text || sending) return;

    setSending(true);
    vscode.postMessage({ type: 'sendMessage', text });

    input.value = '';
    input.style.height = 'auto';
}

function setSending(val) {
    sending = val;
    document.getElementById('sendBtn').disabled = val;
    loading.classList.toggle('show', val);
}

function usePrompt(text) {
    input.value = text;
    input.focus();
}

// ── Input events ─────────────────────────────────────────────────────────────
input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ── Chat rendering ───────────────────────────────────────────────────────────
function addUserMessage(text) {
    removeEmpty();
    const div = createMessage(escapeHtml(text).replace(/\\n/g,'<br>'), true);
    chat.appendChild(div);
    scrollBottom();
}

function addAiMessage(text, model, latency, isMock, progress) {
    removeEmpty();
    setSending(false);

    let html = formatText(text);
    let meta = '';
    if (model) meta += 'Modèle: ' + model;
    if (latency) meta += (meta?' · ':'') + latency + 'ms';
    if (isMock) meta += '<span class="mock-badge">⚠ Mode Mock</span>';
    if (progress !== undefined && progress < 100)
        meta += (meta?' · ':'') + 'Téléchargement: ' + progress + '%';

    const div = createMessage(html, false, meta);
    chat.appendChild(div);
    scrollBottom();
}

function addErrorMessage(text) {
    removeEmpty();
    setSending(false);
    const div = createMessage('<span style="color:var(--vscode-errorForeground)">'+escapeHtml(text).replace(/\\n/g,'<br>')+'</span>', false);
    chat.appendChild(div);
    scrollBottom();
}

function createMessage(html, isUser, meta='') {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + (isUser ? 'user' : 'ai');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = isUser ? 'U' : 'AI';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = html;

    if (meta) {
        const m = document.createElement('div');
        m.className = 'message-meta';
        m.innerHTML = meta;
        content.appendChild(m);
    }

    if (!isUser) {
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
            navigator.clipboard.writeText(content.innerText.replace(/Copy$/, '').trim());
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy', 1500);
        };
        content.prepend(btn);
    }

    wrap.appendChild(avatar);
    wrap.appendChild(content);
    return wrap;
}

function formatText(text) {
    return escapeHtml(text)
        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>')
        .replace(/\\n/g, '<br>');
}

function escapeHtml(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function removeEmpty() {
    const e = document.getElementById('emptyState');
    if (e) e.remove();
}

function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
}

function clearChat() {
    chat.innerHTML = '';
    chat.appendChild(createEmptyState());
    vscode.postMessage({ type: 'clearChat' });
}

function createEmptyState() {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.id = 'emptyState';
    d.innerHTML = \`
        <div class="empty-state-icon">🤖</div>
        <h2>Sudo AI Assistant</h2>
        <p>Posez vos questions sur le code, les erreurs ou le développement.</p>
        <div class="quick-prompts">
            <button class="quick-prompt" onclick="usePrompt('Explique-moi ce code')">Expliquer du code</button>
            <button class="quick-prompt" onclick="usePrompt('Corrige cette erreur')">Corriger une erreur</button>
            <button class="quick-prompt" onclick="usePrompt('Génère un Dockerfile pour Node.js')">Dockerfile Node.js</button>
        </div>\`;
    return d;
}

// ── Status ────────────────────────────────────────────────────────────────────
function checkStatus() {
    vscode.postMessage({ type: 'checkStatus' });
}

function updateStatus(data) {
    const dot  = document.getElementById('statusDot');
    const txt  = document.getElementById('statusText');
    const dlBtn= document.getElementById('downloadBtn');
    const dlBar= document.getElementById('modelDownloadBar');
    const prog = document.getElementById('progressBar');
    const lbl  = document.getElementById('downloadLabel');

    if (!data || data.status === 'offline') {
        dot.className = 'status-dot offline';
        txt.textContent = '⚠ Runtime hors ligne (port 6000) — lancez runtime.exe';
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
        return;
    }

    const m = data.model || {};
    if (m.loading) {
        dot.className = 'status-dot loading';
        const pct = m.download_progress || 0;
        txt.textContent = \`⬇ Téléchargement/chargement du modèle (\${pct}%)...\`;
        dlBar.classList.add('show');
        prog.style.width = pct + '%';
        lbl.textContent = \`Chargement: \${m.name || 'modèle'}  \${pct}%\`;
        dlBtn.style.display = 'none';
    } else if (m.loaded) {
        dot.className = 'status-dot online';
        txt.textContent = \`✅ IA prête · \${m.name || 'modèle'} · \${m.device || 'cpu'}\`;
        dlBtn.style.display = 'none';
        dlBar.classList.remove('show');
    } else {
        dot.className = 'status-dot offline';
        txt.textContent = '⚠ Aucun modèle chargé — cliquez Download';
        dlBtn.style.display = 'inline-block';
        dlBar.classList.remove('show');
    }
}

function downloadDefaultModel() {
    vscode.postMessage({ type: 'downloadModel', modelId: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' });
}

// ── Messages from extension ──────────────────────────────────────────────────
window.addEventListener('message', ev => {
    const msg = ev.data;
    switch (msg.type) {
        case 'userMessage':
            addUserMessage(msg.text); break;
        case 'aiMessage':
            addAiMessage(msg.text, msg.model, msg.latency, msg.mock, msg.progress); break;
        case 'error':
            addErrorMessage(msg.text); break;
        case 'loading':
            if (!msg.show) setSending(false);
            break;
        case 'status':
            updateStatus(msg.data); break;
        case 'downloadStarted':
            document.getElementById('downloadBtn').style.display='none';
            document.getElementById('modelDownloadBar').classList.add('show');
            break;
    }
});

// ── Auto-poll status ──────────────────────────────────────────────────────────
function pollStatus() {
    checkStatus();
    statusTimer = setTimeout(pollStatus, 5000);
}
pollStatus();

// Focus
input.focus();
</script>
</body>
</html>`;
    }
}

module.exports = { ChatPanel };
