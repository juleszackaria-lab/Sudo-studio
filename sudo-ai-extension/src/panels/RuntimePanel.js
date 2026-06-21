/**
 * SUDO STUDIO - Runtime & Model Manager Panel
 * Shows: Runtime status, CPU/RAM, AI models list, download, switch, restart
 * Works standalone (no backend required - calls port 6000 directly)
 */
const vscode = require('vscode');
const axios  = require('axios');
const os     = require('os');

const AVAILABLE_MODELS = [
    { id: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0', name: 'TinyLlama 1.1B', size: '~600MB', desc: 'Rapide, léger, CPU compatible. Recommandé.', recommended: true },
    { id: 'Qwen/Qwen2.5-Coder-1.5B-Instruct',   name: 'Qwen2.5 Coder 1.5B', size: '~1.5GB', desc: 'Optimisé pour le code. Excellent qualité.' },
    { id: 'microsoft/phi-2',                      name: 'Phi-2 2.7B',        size: '~2.7GB', desc: 'Modèle Microsoft très capable.' },
    { id: 'deepseek-ai/deepseek-coder-1.3b-instruct', name: 'DeepSeek Coder 1.3B', size: '~1.3GB', desc: 'Spécialisé code, DeepSeek AI.' },
    { id: 'mistralai/Mistral-7B-Instruct-v0.2',  name: 'Mistral 7B',        size: '~7GB',  desc: 'Puissant mais nécessite 8GB RAM+.' },
    { id: 'meta-llama/Llama-3.2-1B-Instruct',    name: 'Llama 3.2 1B',      size: '~1.2GB', desc: 'Meta Llama 3.2, compact et efficace.' },
];

class RuntimePanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this._pollTimer = null;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Initial status fetch + poll
        setTimeout(() => this.fetchStatus(), 400);
        this._pollTimer = setInterval(() => this.fetchStatus(), 4000);
    }

    static createOrShow(extensionUri) {
        if (RuntimePanel.currentPanel) {
            RuntimePanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoRuntimePanel', '🤖 Runtime & Models',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        RuntimePanel.currentPanel = new RuntimePanel(panel, extensionUri);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'refresh':         await this.fetchStatus(); break;
            case 'downloadModel':   await this.downloadModel(msg.modelId); break;
            case 'switchModel':     await this.switchModel(msg.modelId); break;
            case 'restartRuntime':  await this.restartRuntime(); break;
            case 'fetchLogs':       await this.fetchLogs(); break;
            case 'clearCache':      await this.clearCache(); break;
        }
    }

    async fetchStatus() {
        // System stats
        const totalMem = Math.round(os.totalmem() / 1024 / 1024);
        const freeMem  = Math.round(os.freemem() / 1024 / 1024);
        const usedMem  = totalMem - freeMem;
        const ramPct   = Math.round((usedMem / totalMem) * 100);

        // Runtime health
        let runtimeData = null;
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            runtimeData = r.data;
        } catch (_) { /* offline */ }

        this.panel.webview.postMessage({
            type: 'statusUpdate',
            runtime: runtimeData,
            system: {
                platform: `${os.platform()} ${os.arch()}`,
                cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
                cpuCount: os.cpus().length,
                totalMem,
                usedMem,
                freeMem,
                ramPct
            },
            models: AVAILABLE_MODELS
        });
    }

    async downloadModel(modelId) {
        if (!modelId) return;
        try {
            await axios.post('http://localhost:6000/download', { model: modelId }, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'downloadStarted', modelId });
            vscode.window.showInformationMessage(`⬇️ Downloading ${modelId}...`);
        } catch (e) {
            this.panel.webview.postMessage({ type: 'runtimeError', text: `Cannot reach runtime: ${e.message}` });
            vscode.window.showErrorMessage(`Runtime offline. Start runtime.exe first.`);
        }
    }

    async switchModel(modelId) {
        try {
            await axios.post('http://localhost:6000/reload', { model: modelId }, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'switchStarted', modelId });
            vscode.window.showInformationMessage(`🔄 Switching to ${modelId}...`);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to switch model: ${e.message}`);
        }
    }

    async restartRuntime() {
        const confirm = await vscode.window.showWarningMessage(
            'Restart the AI runtime? This will interrupt any ongoing inference.',
            'Restart', 'Cancel'
        );
        if (confirm !== 'Restart') return;

        // On Windows, kill the process and restart via terminal
        const terminal = vscode.window.createTerminal('Restart Runtime');
        terminal.show();
        if (process.platform === 'win32') {
            terminal.sendText('taskkill /f /im runtime.exe 2>nul & timeout /t 2 & start "" runtime.exe');
        } else {
            terminal.sendText('pkill -f "server.enterprise.py" ; sleep 2 ; python3 backend/runtime/server.enterprise.py &');
        }
        this.panel.webview.postMessage({ type: 'restarting' });
        vscode.window.showInformationMessage('Runtime restart initiated...');
    }

    async fetchLogs() {
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            const info = JSON.stringify(r.data, null, 2);
            this.panel.webview.postMessage({ type: 'logsData', logs: info });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'logsData', logs: `Runtime offline: ${e.message}` });
        }
    }

    async clearCache() {
        try {
            const modelsDir = require('path').join(require('os').homedir(), '.sudo_studio', 'models');
            vscode.window.showInformationMessage(`Models cache is at: ${modelsDir}`);
        } catch (e) {}
    }

    dispose() {
        RuntimePanel.currentPanel = undefined;
        clearInterval(this._pollTimer);
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Runtime & Models</title>
<style>
/* ─── SUDO STUDIO DARK THEME ─────────────────────────────────── */
:root {
    --ss-bg: #0d1117; --ss-card-bg: #161b22; --ss-border: #21262d;
    --ss-btn-green: #2ea043; --ss-btn-blue: #1f6feb;
    --ss-text: #e6edf3; --ss-text-muted: #7d8590;
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
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); padding:0; min-height:100vh; }
#header { background:var(--vscode-sideBar-background); border-bottom:1px solid var(--vscode-panel-border); padding:14px 18px; display:flex; align-items:center; justify-content:space-between; }
#header h1 { font-size:17px; font-weight:600; }
.btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:500; transition:opacity .2s; white-space:nowrap; }
.btn:hover { opacity:.85; }
.btn:disabled { opacity:.4; cursor:not-allowed; }
.btn-sec { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.btn-danger { background:#b71c1c; color:#fff; }
.btn-sm { padding:5px 10px; font-size:11px; }
#content { padding:16px 18px; display:flex; flex-direction:column; gap:16px; }
.card { background:var(--vscode-sideBar-background); border:1px solid var(--vscode-panel-border); border-radius:10px; padding:14px 16px; }
.card-title { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--vscode-descriptionForeground); margin-bottom:12px; display:flex; align-items:center; gap:6px; }
.status-row { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.big-dot { width:12px; height:12px; border-radius:50%; flex-shrink:0; }
.big-dot.online  { background:#4caf50; }
.big-dot.loading { background:#ff9800; animation:pulse 1s infinite; }
.big-dot.offline { background:#f44336; }
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.status-name { font-size:16px; font-weight:600; }
.status-sub  { font-size:12px; color:var(--vscode-descriptionForeground); margin-top:2px; }
.metrics-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.metric { background:var(--vscode-editorWidget-background); border-radius:8px; padding:10px 12px; }
.metric-label { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--vscode-descriptionForeground); margin-bottom:4px; }
.metric-value { font-size:20px; font-weight:700; }
.metric-sub { font-size:10px; color:var(--vscode-descriptionForeground); margin-top:2px; }
.bar-wrap { height:5px; background:var(--vscode-panel-border); border-radius:3px; overflow:hidden; margin-top:6px; }
.bar-fill { height:100%; border-radius:3px; transition:width .5s; }
.actions-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
.model-card { background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-panel-border); border-radius:8px; padding:12px 14px; display:flex; align-items:center; gap:12px; margin-bottom:8px; }
.model-card.active { border-color:#4caf50; border-left:3px solid #4caf50; }
.model-info { flex:1; min-width:0; }
.model-name { font-size:13px; font-weight:600; display:flex; align-items:center; gap:6px; }
.model-meta { font-size:11px; color:var(--vscode-descriptionForeground); margin-top:2px; }
.badge-rec { font-size:10px; padding:1px 6px; background:rgba(76,175,80,.2); color:#4caf50; border-radius:8px; }
.badge-active { font-size:10px; padding:1px 6px; background:rgba(33,150,243,.2); color:#2196f3; border-radius:8px; }
.model-actions { display:flex; gap:6px; flex-shrink:0; }
.dl-bar-wrap { height:4px; background:var(--vscode-panel-border); border-radius:2px; overflow:hidden; margin-top:6px; display:none; }
.dl-bar-wrap.show { display:block; }
.dl-bar-fill { height:100%; background:#ff9800; animation:loading-anim 1.5s ease-in-out infinite; }
@keyframes loading-anim{0%{width:10%;margin-left:0}50%{width:50%;margin-left:25%}100%{width:10%;margin-left:85%}}
#logsBox { display:none; margin-top:12px; background:var(--vscode-terminal-background,#1e1e1e); color:var(--vscode-terminal-foreground,#ccc); padding:10px; border-radius:6px; font-family:monospace; font-size:11px; max-height:200px; overflow:auto; white-space:pre-wrap; }
#logsBox.show { display:block; }
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
</style>
</head>
<body>
<div id="header">
    <div>
        <h1>🤖 Runtime &amp; Models</h1>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">Gérez le runtime IA et les modèles installés</div>
    </div>
    <div style="display:flex;gap:8px">
        <button class="btn btn-sec" onclick="refresh()">🔄 Refresh</button>
        <button class="btn btn-danger btn-sm" onclick="restartRuntime()">⚡ Restart</button>
    </div>
</div>

<div id="content">
    <!-- Runtime Status Card -->
    <div class="card">
        <div class="card-title">⚡ Runtime Status</div>
        <div class="status-row">
            <div class="big-dot offline" id="rtDot"></div>
            <div>
                <div class="status-name" id="rtName">Vérification...</div>
                <div class="status-sub" id="rtSub">port 6000</div>
            </div>
        </div>
        <div class="actions-row">
            <button class="btn btn-sm" onclick="fetchLogs()">📋 Voir Logs</button>
            <button class="btn btn-sec btn-sm" onclick="clearCache()">🗑 Cache Info</button>
        </div>
        <div id="logsBox"></div>
    </div>

    <!-- System Metrics -->
    <div class="card">
        <div class="card-title">📊 Ressources Système</div>
        <div class="metrics-grid">
            <div class="metric">
                <div class="metric-label">RAM Utilisée</div>
                <div class="metric-value" id="ramVal">—</div>
                <div class="metric-sub" id="ramSub">Chargement...</div>
                <div class="bar-wrap"><div class="bar-fill" id="ramBar" style="width:0%;background:#2196f3"></div></div>
            </div>
            <div class="metric">
                <div class="metric-label">RAM Libre</div>
                <div class="metric-value" id="ramFreeVal">—</div>
                <div class="metric-sub" id="cpuSub">CPU</div>
            </div>
            <div class="metric">
                <div class="metric-label">Plateforme</div>
                <div class="metric-value" id="platVal" style="font-size:13px">—</div>
            </div>
            <div class="metric">
                <div class="metric-label">Processeurs</div>
                <div class="metric-value" id="cpuVal">—</div>
                <div class="metric-sub" id="cpuModel">—</div>
            </div>
        </div>
    </div>

    <!-- Active Model -->
    <div class="card" id="activeModelCard" style="display:none">
        <div class="card-title">✅ Modèle Actif</div>
        <div id="activeModelInfo"></div>
    </div>

    <!-- Available Models -->
    <div class="card">
        <div class="card-title">📦 Modèles Disponibles</div>
        <div id="modelsList"></div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentModelId = null;

function refresh()        { vscode.postMessage({ type: 'refresh' }); }
function restartRuntime() { vscode.postMessage({ type: 'restartRuntime' }); }
function fetchLogs()      { vscode.postMessage({ type: 'fetchLogs' }); }
function clearCache()     { vscode.postMessage({ type: 'clearCache' }); }
function downloadModel(id){ vscode.postMessage({ type: 'downloadModel', modelId: id }); }
function switchModel(id)  { vscode.postMessage({ type: 'switchModel', modelId: id }); }

function renderStatus(rt, sys, models) {
    // System metrics
    document.getElementById('ramVal').textContent = sys.usedMem >= 1024
        ? (sys.usedMem/1024).toFixed(1) + ' GB'
        : sys.usedMem + ' MB';
    document.getElementById('ramFreeVal').textContent = sys.freeMem >= 1024
        ? (sys.freeMem/1024).toFixed(1) + ' GB'
        : sys.freeMem + ' MB';
    document.getElementById('ramSub').textContent = 'sur ' + (sys.totalMem >= 1024 ? (sys.totalMem/1024).toFixed(0)+'GB' : sys.totalMem+'MB') + ' total';
    document.getElementById('ramBar').style.width = sys.ramPct + '%';
    document.getElementById('platVal').textContent = sys.platform;
    document.getElementById('cpuVal').textContent = sys.cpuCount + ' cœurs';
    document.getElementById('cpuModel').textContent = (sys.cpuModel || '').split('@')[0].trim().substring(0, 30);
    document.getElementById('cpuSub').textContent = 'Libre: ' + sys.freeMem + ' MB';

    // Runtime status
    const dot = document.getElementById('rtDot');
    const name = document.getElementById('rtName');
    const sub = document.getElementById('rtSub');

    if (!rt) {
        dot.className = 'big-dot offline';
        name.textContent = 'Runtime Hors Ligne';
        sub.textContent = 'Lancez runtime.exe ou python server.enterprise.py';
    } else {
        const m = rt.model || {};
        if (m.loading) {
            dot.className = 'big-dot loading';
            name.textContent = 'Chargement du modèle... ' + (m.download_progress||0) + '%';
            sub.textContent = m.name || 'modèle';
        } else if (m.loaded) {
            dot.className = 'big-dot online';
            name.textContent = 'Runtime Actif';
            sub.textContent = m.name + ' · ' + (m.device || 'cpu') + ' · uptime: ' + formatUptime(rt.uptime_seconds);
            currentModelId = m.name;
        } else {
            dot.className = 'big-dot offline';
            name.textContent = 'Runtime démarré — aucun modèle';
            sub.textContent = 'Téléchargez un modèle ci-dessous';
        }
    }

    // Active model card
    if (rt && rt.model && rt.model.loaded) {
        document.getElementById('activeModelCard').style.display = 'block';
        document.getElementById('activeModelInfo').innerHTML =
            '<div class="model-card active"><div class="model-info"><div class="model-name">' +
            (rt.model.name||'unknown') + ' <span class="badge-active">actif</span></div>' +
            '<div class="model-meta">Device: ' + (rt.model.device||'cpu') +
            ' · Requêtes: ' + (rt.requests_served||0) + '</div></div>' +
            '<div class="model-actions"><button class="btn btn-sec btn-sm" onclick="switchModel(\'TinyLlama/TinyLlama-1.1B-Chat-v1.0\')">🔄 Changer</button></div></div>';
    } else {
        document.getElementById('activeModelCard').style.display = 'none';
    }

    // Models list
    const list = document.getElementById('modelsList');
    list.innerHTML = '';
    models.forEach(m => {
        const isActive = rt && rt.model && rt.model.loaded &&
            (rt.model.name === m.id || rt.model.name === m.name);
        const isLoading = rt && rt.model && rt.model.loading && rt.model.name === m.id;
        const pct = isLoading ? (rt.model.download_progress || 0) : 0;

        const card = document.createElement('div');
        card.className = 'model-card' + (isActive ? ' active' : '');
        card.innerHTML = \`
            <div class="model-info">
                <div class="model-name">
                    \${m.name}
                    \${m.recommended ? '<span class="badge-rec">⭐ Recommandé</span>' : ''}
                    \${isActive ? '<span class="badge-active">✓ Actif</span>' : ''}
                </div>
                <div class="model-meta">\${m.size} · \${m.desc}</div>
                <div class="dl-bar-wrap \${isLoading ? 'show' : ''}" id="dlbar-\${m.id.replace(/[^a-z0-9]/gi,'_')}">
                    <div class="dl-bar-fill"></div>
                </div>
            </div>
            <div class="model-actions">
                \${isActive
                    ? '<button class="btn btn-sec btn-sm" disabled>✓ Actif</button>'
                    : isLoading
                        ? '<button class="btn btn-sec btn-sm" disabled>⬇ ' + pct + '%</button>'
                        : '<button class="btn btn-sm" onclick="downloadModel(\\'' + m.id + '\\')">⬇ Télécharger</button>'
                }
            </div>
        \`;
        list.appendChild(card);
    });
}

function formatUptime(s) {
    if (!s) return 'N/A';
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return h + 'h ' + m + 'm';
}

window.addEventListener('message', ev => {
    const msg = ev.data;
    switch (msg.type) {
        case 'statusUpdate':
            renderStatus(msg.runtime, msg.system, msg.models);
            break;
        case 'logsData':
            const lb = document.getElementById('logsBox');
            lb.textContent = msg.logs;
            lb.classList.add('show');
            break;
        case 'downloadStarted':
            vscode.postMessage({ type: 'refresh' });
            break;
        case 'restarting':
            document.getElementById('rtName').textContent = 'Redémarrage...';
            document.getElementById('rtDot').className = 'big-dot loading';
            break;
        case 'runtimeError':
            document.getElementById('rtName').textContent = 'Erreur: ' + msg.text;
            break;
    }
});
</script>
</body>
</html>`;
    }
}

module.exports = { RuntimePanel };
