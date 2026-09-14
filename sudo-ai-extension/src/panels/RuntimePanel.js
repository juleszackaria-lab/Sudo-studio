/**
 * SUDO STUDIO - Runtime & Model Manager Panel v2
 * Complete rebuild: model catalogue, working buttons, auto-select best local model.
 * 100% offline for all scan/select logic — network only for explicit Download.
 */
const vscode = require('vscode');
const axios  = require('axios');
const os     = require('os');

// Full model catalogue matching server.enterprise.py MODEL_CATALOGUE
const MODEL_CATALOGUE = [
    { id: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',        name: 'Qwen2.5 Coder 1.5B Q4',       sizeGb: 1.0,  ramGb: 1.5,  type: 'gguf', desc: '⭐ Recommandé — Code spécialisé, très léger',  recommended: true },
    { id: 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',      name: 'Qwen2.5 Coder 3B Q4',         sizeGb: 2.0,  ramGb: 3.0,  type: 'gguf', desc: 'Meilleure qualité code, 3GB RAM' },
    { id: 'bartowski/phi-3-mini-4k-instruct-GGUF',          name: 'Phi-3 Mini 4K',               sizeGb: 2.2,  ramGb: 4.0,  type: 'gguf', desc: 'Microsoft Phi-3 Mini, rapide' },
    { id: 'meta-llama/Llama-3.2-3B-Instruct',               name: 'Llama 3.2 3B',                sizeGb: 3.0,  ramGb: 4.0,  type: 'hf',   desc: 'Meta Llama 3.2 3B usage général' },
    { id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',       name: 'Qwen2.5 Coder 7B Q4',         sizeGb: 4.7,  ramGb: 5.5,  type: 'gguf', desc: 'Qwen 7B code — haute qualité' },
    { id: 'bartowski/CodeLlama-7b-Instruct-GGUF',           name: 'CodeLlama 7B Instruct',        sizeGb: 3.8,  ramGb: 6.0,  type: 'gguf', desc: 'Meta CodeLlama 7B — refactoring' },
    { id: 'bartowski/mistral-7b-instruct-v0.2-GGUF',        name: 'Mistral 7B v0.2',              sizeGb: 4.1,  ramGb: 6.0,  type: 'gguf', desc: 'Mistral 7B usage général' },
    { id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',      name: 'Llama 3.1 8B Instruct',        sizeGb: 4.9,  ramGb: 7.0,  type: 'gguf', desc: 'Meta Llama 3.1 8B — très polyvalent' },
    { id: 'bartowski/deepseek-coder-v2-lite-instruct-GGUF',  name: 'DeepSeek Coder V2 Lite',       sizeGb: 8.0,  ramGb: 9.0,  type: 'gguf', desc: 'DeepSeek Coder V2 — top code completion' },
    { id: 'bartowski/Meta-Llama-3.1-13B-Instruct-GGUF',     name: 'Llama 3.1 13B Instruct',       sizeGb: 7.9,  ramGb: 10.0, type: 'gguf', desc: 'Meta Llama 3.1 13B — puissant' },
    { id: 'bartowski/CodeLlama-13b-Instruct-GGUF',           name: 'CodeLlama 13B Instruct',       sizeGb: 7.3,  ramGb: 10.0, type: 'gguf', desc: 'Meta CodeLlama 13B — meilleur code CPU' },
    { id: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',       name: 'Qwen2.5 Coder 14B Q4',        sizeGb: 9.0,  ramGb: 10.0, type: 'gguf', desc: 'Qwen 14B code — top tier' },
    { id: 'mistralai/Mistral-7B-Instruct-v0.2',              name: 'Mistral 7B v0.2 (HF)',         sizeGb: 14.0, ramGb: 16.0, type: 'hf',   desc: 'Mistral HF format — 16GB RAM nécessaire' },
];

class RuntimePanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel        = panel;
        this.extensionUri = extensionUri;
        this.disposables  = [];
        this._pollTimer   = null;
        this._catalogue   = [];   // cached from /models/catalogue
        this._lastHealth  = null;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Initial status fetch + poll every 4s
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
        console.log('[RUNTIME] handleMessage:', msg.type);
        switch (msg.type) {
            case 'refresh':        await this.fetchStatus(); break;
            case 'downloadModel':  await this.downloadModel(msg.modelId); break;
            case 'switchModel':    await this.switchModel(msg.modelId); break;
            case 'restartRuntime': await this.restartRuntime(); break;
            case 'fetchLogs':      await this.fetchLogs(); break;
            case 'cacheInfo':      await this.fetchCacheInfo(); break;
            case 'autoSelect':     await this.autoSelectBestModel(); break;
        }
    }

    // ── System info (offline — uses Node.js os module) ───────────────────────
    _getSystemInfo() {
        try {
            const totalMem = Math.round(os.totalmem() / 1024 / 1024);
            const freeMem  = Math.round(os.freemem()  / 1024 / 1024);
            const usedMem  = totalMem - freeMem;
            const ramPct   = Math.round((usedMem / totalMem) * 100);
            const cpus     = os.cpus();
            const cpuModel = cpus && cpus.length > 0 ? cpus[0].model : 'Unknown';
            const cpuCount = cpus ? cpus.length : 0;
            const platform = process.platform === 'win32' ? 'Windows'
                           : process.platform === 'darwin' ? 'macOS' : 'Linux';
            return { totalMem, freeMem, usedMem, ramPct, cpuModel, cpuCount, platform, ok: true };
        } catch (e) {
            console.error('[RUNTIME] _getSystemInfo failed:', e.message);
            return { totalMem: 0, freeMem: 0, usedMem: 0, ramPct: 0, cpuModel: 'Error', cpuCount: 0, platform: 'Unknown', ok: false, error: e.message };
        }
    }

    // ── Fetch runtime status from port 6000 ─────────────────────────────────
    async fetchStatus() {
        const sysInfo = this._getSystemInfo();

        let runtimeData = null;
        let catalogueData = null;
        let runtimeError = null;

        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            runtimeData = r.data;
            this._lastHealth = r.data;
        } catch (e) {
            runtimeError = e.code === 'ECONNREFUSED'
                ? 'Runtime hors ligne (port 6000). Lancez start.bat.'
                : `Erreur connexion runtime: ${e.message}`;
            console.warn('[RUNTIME] fetchStatus /health failed:', e.message);
        }

        // Try to get catalogue (includes local scan)
        try {
            const rc = await axios.get('http://localhost:6000/models/catalogue', { timeout: 5000 });
            catalogueData = rc.data;
            this._catalogue = catalogueData.catalogue || [];
        } catch (e) {
            console.warn('[RUNTIME] fetchStatus /models/catalogue failed:', e.message);
            // Build local catalogue from static list + system RAM
            const freeGb = sysInfo.freeMem / 1024;
            this._catalogue = MODEL_CATALOGUE.map(m => ({
                ...m,
                size_gb: m.sizeGb,
                ram_gb:  m.ramGb,
                downloaded: false,
                can_load: freeGb >= m.ramGb,
                currently_loaded: false,
            }));
        }

        this.panel.webview.postMessage({
            type:         'statusUpdate',
            sysInfo,
            runtimeData,
            runtimeError,
            catalogue:    this._catalogue,
            catalogueMeta: catalogueData ? {
                ramAvailableGb: catalogueData.ram_available_gb,
                bestLocalModel: catalogueData.best_local_model,
                mockMode:       catalogueData.mock_mode,
                modelsDir:      catalogueData.models_dir,
            } : null,
        });
    }

    async downloadModel(modelId) {
        if (!modelId) return;
        console.log('[RUNTIME] downloadModel:', modelId);
        try {
            const r = await axios.post('http://localhost:6000/download',
                { model: modelId }, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'downloadStarted', modelId });
            vscode.window.showInformationMessage(
                `⬇️ Téléchargement démarré: ${modelId}. Progression dans le panneau.`
            );
        } catch (e) {
            const msg = e.response?.data?.detail || e.message;
            this.panel.webview.postMessage({ type: 'error', text: `Erreur téléchargement: ${msg}` });
            vscode.window.showErrorMessage(`Erreur téléchargement ${modelId}: ${msg}`);
        }
    }

    async switchModel(modelId) {
        if (!modelId) return;
        console.log('[RUNTIME] switchModel:', modelId);
        try {
            await axios.post('http://localhost:6000/reload',
                { model: modelId, force_download: false }, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'actionDone', action: 'switch', modelId });
            vscode.window.showInformationMessage(`🔄 Chargement modèle: ${modelId}`);
            setTimeout(() => this.fetchStatus(), 1000);
        } catch (e) {
            const msg = e.response?.data?.error || e.message;
            this.panel.webview.postMessage({ type: 'error', text: `Erreur chargement modèle: ${msg}` });
        }
    }

    async autoSelectBestModel() {
        console.log('[RUNTIME] autoSelectBestModel');
        try {
            // Try /models/catalogue first (it finds best local model)
            const rc = await axios.get('http://localhost:6000/models/catalogue', { timeout: 5000 });
            const best = rc.data.best_local_model;
            if (best) {
                await this.switchModel(best);
                this.panel.webview.postMessage({ type: 'autoSelectDone', modelId: best });
            } else {
                this.panel.webview.postMessage({ type: 'info', text: 'Aucun modèle local trouvé. Téléchargez un modèle depuis le catalogue.' });
            }
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', text: `Auto-sélection échouée: ${e.message}` });
        }
    }

    async restartRuntime() {
        console.log('[RUNTIME] restartRuntime');
        try {
            // Reload current model
            await axios.post('http://localhost:6000/reload', {}, { timeout: 5000 });
            this.panel.webview.postMessage({ type: 'actionDone', action: 'restart' });
            vscode.window.showInformationMessage('🔄 Runtime en cours de redémarrage...');
            setTimeout(() => this.fetchStatus(), 2000);
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', text: `Runtime non joignable sur port 6000: ${e.message}. Relancez start.bat.` });
        }
    }

    async fetchLogs() {
        console.log('[RUNTIME] fetchLogs');
        try {
            // Try to get logs from health endpoint
            const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            const logs = r.data.detection_log || [];
            const modelInfo = r.data.model || {};
            const logText = [
                `=== Runtime Health ===`,
                `Status: ${r.data.status}`,
                `Mock mode: ${r.data.mock_mode}`,
                `Model loaded: ${modelInfo.loaded}`,
                `Model name: ${modelInfo.name || 'N/A'}`,
                `Download progress: ${modelInfo.download_progress || 0}%`,
                `Error: ${modelInfo.error || 'none'}`,
                `RAM available: ${r.data.system?.ram_available_gb || 'N/A'} GB`,
                `RAM total: ${r.data.system?.ram_total_gb || 'N/A'} GB`,
                `Requests served: ${r.data.requests_served || 0}`,
                `Uptime: ${r.data.uptime_seconds || 0}s`,
                ``,
                `=== Detection Log ===`,
                ...(logs.length > 0 ? logs : ['(aucun log de détection disponible)']),
            ].join('\n');
            this.panel.webview.postMessage({ type: 'logsData', text: logText });
        } catch (e) {
            this.panel.webview.postMessage({
                type: 'logsData',
                text: `Runtime non joignable (port 6000): ${e.message}\n\nVérifiez que start.bat a lancé runtime.exe.`
            });
        }
    }

    async fetchCacheInfo() {
        console.log('[RUNTIME] fetchCacheInfo');
        try {
            const r = await axios.get('http://localhost:6000/scan', { timeout: 8000 });
            const d = r.data;
            const lines = [
                `=== Cache Info ===`,
                `Models dir: ${d.models_dir || 'N/A'}`,
                `Total modèles trouvés: ${d.total_found || 0}`,
                `Modèles valides: ${d.valid_count || 0}`,
                ``,
                `=== Meilleur candidat ===`,
                d.best_candidate
                    ? `${d.best_candidate.model_id} (${d.best_candidate.size_mb || 0} MB, source: ${d.best_candidate.source})`
                    : 'Aucun modèle valide trouvé',
                ``,
                `=== Tous les modèles ===`,
                ...(d.all_models || []).map(m =>
                    `  ${m.valid ? '✅' : '❌'} ${m.model_id} — ${m.size_mb || 0} MB [${m.source}]`
                ),
                ``,
                `=== Scan log ===`,
                ...(d.scan_log || ['(vide)']),
            ].join('\n');
            this.panel.webview.postMessage({ type: 'logsData', text: lines });
        } catch (e) {
            this.panel.webview.postMessage({
                type: 'logsData',
                text: `Cache Info — Runtime non joignable: ${e.message}`
            });
        }
    }

    dispose() {
        RuntimePanel.currentPanel = undefined;
        clearInterval(this._pollTimer);
        this.panel.dispose();
        this.disposables.forEach(d => d && d.dispose());
    }

    getHtmlContent() {
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
<title>Runtime & Models</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src http://localhost:*;">
<style>
:root {
    --bg: #0d1117; --card: #161b22; --border: #21262d;
    --green: #2ea043; --blue: #1f6feb; --orange: #d29922;
    --red: #f85149; --text: #e6edf3; --muted: #7d8590;
    --success: #3fb950; --accent: #58a6ff;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:var(--bg); color:var(--text); font-size:13px; padding:16px; overflow-y:auto; }
h2 { font-size:15px; font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.section { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:14px; }
.section-title { font-size:12px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; margin-bottom:10px; }
.stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.stat { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; }
.stat-label { font-size:10px; color:var(--muted); margin-bottom:2px; }
.stat-value { font-size:14px; font-weight:700; }
.stat-value.ok { color:var(--success); }
.stat-value.warn { color:var(--orange); }
.stat-value.err { color:var(--red); }
.ram-bar { height:6px; background:var(--border); border-radius:3px; margin-top:6px; overflow:hidden; }
.ram-fill { height:100%; border-radius:3px; transition:width .5s; }
.btn-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
.btn { padding:6px 12px; border:none; border-radius:6px; cursor:pointer; font-size:12px; font-weight:500; }
.btn-primary { background:var(--blue); color:#fff; }
.btn-success { background:var(--green); color:#fff; }
.btn-secondary { background:var(--border); color:var(--text); }
.btn-orange { background:#5a3e00; color:var(--orange); border:1px solid var(--orange); }
.btn:hover { opacity:.85; }
.btn:disabled { opacity:.45; cursor:not-allowed; }
#statusBadge { padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600; display:inline-flex; align-items:center; gap:5px; }
#statusBadge.online  { background:rgba(63,185,80,.15); color:var(--success); border:1px solid rgba(63,185,80,.3); }
#statusBadge.loading { background:rgba(210,153,34,.15); color:var(--orange); border:1px solid rgba(210,153,34,.3); }
#statusBadge.offline { background:rgba(248,81,73,.15); color:var(--red); border:1px solid rgba(248,81,73,.3); }
#statusBadge.mock { background:rgba(210,153,34,.2); color:var(--orange); border:1px solid var(--orange); }
.model-card { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:8px; }
.model-card.recommended { border-color:rgba(46,160,67,.4); }
.model-card.loaded { border-color:var(--success); background:rgba(63,185,80,.05); }
.model-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.model-name { font-weight:700; font-size:13px; display:flex; align-items:center; gap:6px; }
.model-size { font-size:11px; color:var(--muted); }
.model-desc { font-size:11px; color:var(--muted); margin-bottom:8px; }
.model-badges { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:8px; }
.badge { padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; }
.badge-rec  { background:rgba(46,160,67,.2); color:var(--success); }
.badge-dl   { background:rgba(63,185,80,.15); color:var(--success); }
.badge-notdl{ background:rgba(125,133,144,.15); color:var(--muted); }
.badge-loaded { background:rgba(31,111,235,.2); color:var(--accent); }
.badge-canload { background:rgba(46,160,67,.1); color:var(--success); }
.badge-noram  { background:rgba(248,81,73,.1); color:var(--red); }
.badge-gguf { background:rgba(88,166,255,.1); color:var(--accent); }
.dl-bar { height:4px; background:var(--border); border-radius:2px; margin-bottom:8px; overflow:hidden; display:none; }
.dl-bar.show { display:block; }
.dl-fill { height:100%; background:var(--green); transition:width .3s; width:0; }
#logsBox { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px; font-family:monospace; font-size:11px; color:var(--muted); max-height:300px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; display:none; margin-top:10px; }
#logsBox.show { display:block; }
.spin { display:inline-block; animation:spin 1s linear infinite; }
@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
.mock-warning { background:#2d1a00; border:1px solid var(--orange); border-radius:6px; padding:10px 14px; margin-bottom:10px; color:var(--orange); display:none; }
.mock-warning.show { display:flex; align-items:center; gap:8px; }
</style>
</head>
<body>
<h2>🤖 Runtime & Modèles IA</h2>

<div class="mock-warning" id="mockWarning">
    <span style="font-size:18px">⚠️</span>
    <div>
        <div style="font-weight:700">Mode Mock actif</div>
        <div id="mockWarningText" style="font-size:11px;margin-top:2px">Aucun modèle chargé — le Chat retourne des réponses simulées.</div>
    </div>
</div>

<!-- Runtime Status -->
<div class="section">
    <div class="section-title">État Runtime</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span id="statusBadge" class="offline">⚫ Hors ligne</span>
        <span id="modelName" style="font-size:12px;color:var(--muted)">—</span>
    </div>
    <div id="dlBar" class="dl-bar"><div id="dlFill" class="dl-fill"></div></div>
    <div id="dlLabel" style="font-size:10px;color:var(--muted);display:none;margin-bottom:6px"></div>
    <div class="btn-row">
        <button class="btn btn-primary" id="btnRefresh">🔄 Rafraîchir</button>
        <button class="btn btn-secondary" id="btnAutoSelect" title="Sélectionner automatiquement le meilleur modèle local">⚡ Auto-sélect</button>
        <button class="btn btn-secondary" id="btnRestart">↺ Restart</button>
        <button class="btn btn-secondary" id="btnLogs">📋 Logs</button>
        <button class="btn btn-secondary" id="btnCache">💾 Cache Info</button>
    </div>
    <div id="logsBox"></div>
</div>

<!-- System Resources -->
<div class="section">
    <div class="section-title">Ressources Système</div>
    <div class="stat-grid">
        <div class="stat">
            <div class="stat-label">RAM Libre / Total</div>
            <div class="stat-value" id="ramStat">Chargement...</div>
            <div class="ram-bar"><div class="ram-fill" id="ramFill" style="background:var(--green)"></div></div>
        </div>
        <div class="stat">
            <div class="stat-label">Processeur</div>
            <div class="stat-value" id="cpuStat" style="font-size:11px">Chargement...</div>
        </div>
        <div class="stat">
            <div class="stat-label">Plateforme</div>
            <div class="stat-value" id="platformStat">Chargement...</div>
        </div>
        <div class="stat">
            <div class="stat-label">Requêtes servies</div>
            <div class="stat-value" id="reqStat">—</div>
        </div>
    </div>
</div>

<!-- Model Catalogue -->
<div class="section">
    <div class="section-title">Catalogue Modèles</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:10px" id="catalogueInfo">
        Modèles disponibles pour Sudo AI. Les modèles téléchargés s'utilisent 100% hors ligne.
    </div>
    <div id="catalogueList">
        <div style="color:var(--muted);font-size:12px;padding:12px;text-align:center"><span class="spin">⟳</span> Scan en cours...</div>
    </div>
</div>

<script nonce="${nonce}">
console.log('[RUNTIME] Script starting...');

let vscode;
try { vscode = acquireVsCodeApi(); window._vscode = vscode; }
catch(e) { vscode = window._vscode; }

function vscPost(msg) {
    try { vscode.postMessage(msg); } catch(e) { console.error('[RUNTIME] vscPost error:', e); }
}

// ── Button listeners ──────────────────────────────────────────────────────
document.getElementById('btnRefresh').addEventListener('click', function() {
    this.textContent = '⟳ Rafraîchir';
    vscPost({ type: 'refresh' });
    console.log('[RUNTIME] Refresh requested');
});

document.getElementById('btnAutoSelect').addEventListener('click', function() {
    this.disabled = true;
    this.textContent = '⟳ Sélection...';
    vscPost({ type: 'autoSelect' });
    setTimeout(() => { this.disabled = false; this.textContent = '⚡ Auto-sélect'; }, 5000);
    console.log('[RUNTIME] AutoSelect requested');
});

document.getElementById('btnRestart').addEventListener('click', function() {
    this.disabled = true;
    this.textContent = '⟳ Restart...';
    vscPost({ type: 'restartRuntime' });
    setTimeout(() => { this.disabled = false; this.textContent = '↺ Restart'; }, 8000);
    console.log('[RUNTIME] Restart requested');
});

document.getElementById('btnLogs').addEventListener('click', function() {
    const logsBox = document.getElementById('logsBox');
    if (logsBox.classList.contains('show')) {
        logsBox.classList.remove('show');
        this.textContent = '📋 Logs';
    } else {
        this.textContent = '📋 Chargement...';
        vscPost({ type: 'fetchLogs' });
        console.log('[RUNTIME] FetchLogs requested');
    }
});

document.getElementById('btnCache').addEventListener('click', function() {
    const logsBox = document.getElementById('logsBox');
    logsBox.classList.remove('show');
    this.textContent = '⟳ Scan...';
    vscPost({ type: 'cacheInfo' });
    console.log('[RUNTIME] CacheInfo requested');
    setTimeout(() => { this.textContent = '💾 Cache Info'; }, 6000);
});

console.log('[RUNTIME] All button listeners attached');

// ── Status update renderer ────────────────────────────────────────────────
function updateRuntime(data) {
    const badge = document.getElementById('statusBadge');
    const modelName = document.getElementById('modelName');
    const dlBar   = document.getElementById('dlBar');
    const dlFill  = document.getElementById('dlFill');
    const dlLabel = document.getElementById('dlLabel');
    const mockWarn = document.getElementById('mockWarning');
    const mockText = document.getElementById('mockWarningText');
    const reqStat  = document.getElementById('reqStat');

    if (!data) {
        badge.className = 'offline'; badge.textContent = '⚫ Hors ligne';
        modelName.textContent = 'Runtime non joignable (port 6000)';
        if (mockWarn) { mockWarn.classList.add('show'); if(mockText) mockText.textContent = 'Runtime hors ligne. Lancez start.bat pour démarrer le runtime.'; }
        return;
    }

    const m = data.model || {};
    if (m.loading) {
        badge.className = 'loading'; badge.textContent = '🔄 Chargement';
        const pct = m.download_progress || 0;
        modelName.textContent = (m.name || 'modèle') + ' — ' + pct + '%';
        dlBar.classList.add('show');
        dlFill.style.width = pct + '%';
        dlLabel.style.display = 'block';
        dlLabel.textContent = 'Chargement en cours: ' + pct + '%...';
        if (mockWarn) { mockWarn.classList.add('show'); if(mockText) mockText.textContent = 'Modèle en cours de chargement (' + pct + '%) — réponses simulées en attendant.'; }
    } else if (m.loaded) {
        badge.className = 'online'; badge.textContent = '🟢 En ligne';
        modelName.textContent = (m.name || m.model || 'modèle chargé') + ' · ' + (m.device || 'cpu');
        dlBar.classList.remove('show');
        dlLabel.style.display = 'none';
        if (mockWarn) mockWarn.classList.remove('show');
    } else {
        badge.className = 'mock'; badge.textContent = '⚠️ Mock Mode';
        const errTxt = m.error ? m.error.slice(0, 80) : 'Aucun modèle chargé';
        modelName.textContent = errTxt;
        dlBar.classList.remove('show');
        dlLabel.style.display = 'none';
        if (mockWarn) {
            mockWarn.classList.add('show');
            if (mockText) mockText.textContent = 'Aucun modèle chargé. ' + (m.error ? 'Erreur: ' + m.error.slice(0,100) : 'Téléchargez et chargez un modèle depuis le catalogue ci-dessous.');
        }
    }
    if (reqStat) reqStat.textContent = data.requests_served || 0;
}

function updateSystem(sys) {
    if (!sys) {
        document.getElementById('ramStat').textContent = 'Erreur lecture';
        document.getElementById('cpuStat').textContent = 'Erreur lecture';
        document.getElementById('platformStat').textContent = 'Erreur lecture';
        return;
    }
    const freeGb = (sys.freeMem / 1024).toFixed(1);
    const totalGb = (sys.totalMem / 1024).toFixed(1);
    const ramEl = document.getElementById('ramStat');
    ramEl.textContent = freeGb + ' GB / ' + totalGb + ' GB';
    ramEl.className = 'stat-value ' + (sys.ramPct > 85 ? 'err' : sys.ramPct > 65 ? 'warn' : 'ok');

    const ramFill = document.getElementById('ramFill');
    ramFill.style.width = sys.ramPct + '%';
    ramFill.style.background = sys.ramPct > 85 ? 'var(--red)' : sys.ramPct > 65 ? 'var(--orange)' : 'var(--green)';

    const cpuEl = document.getElementById('cpuStat');
    cpuEl.textContent = sys.cpuCount + 'x ' + (sys.cpuModel || '').slice(0, 30);
    document.getElementById('platformStat').textContent = sys.platform || 'N/A';
}

function renderCatalogue(catalogue, meta) {
    const list = document.getElementById('catalogueList');
    const infoEl = document.getElementById('catalogueInfo');

    if (!catalogue || catalogue.length === 0) {
        list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px">Catalogue non disponible — runtime hors ligne.</div>';
        return;
    }

    const ramAvailGb = meta ? meta.ramAvailableGb : 0;
    const bestLocal  = meta ? meta.bestLocalModel : null;

    if (infoEl) {
        const downloaded = catalogue.filter(m => m.downloaded).length;
        infoEl.textContent = downloaded > 0
            ? downloaded + ' modèle(s) téléchargé(s) · RAM disponible: ' + (ramAvailGb || '?') + ' GB · 100% offline'
            : 'Aucun modèle téléchargé · RAM disponible: ' + (ramAvailGb || '?') + ' GB · Téléchargez pour utiliser hors ligne';
    }

    list.innerHTML = catalogue.map(function(m) {
        const isLoaded   = m.currently_loaded || false;
        const isDl       = m.downloaded       || false;
        const canLoad    = m.can_load !== undefined ? m.can_load : (ramAvailGb >= (m.ram_gb || m.ramGb || 99));
        const isBest     = m.id === bestLocal;
        const sizeGb     = m.size_gb || m.sizeGb || 0;
        const ramGb      = m.ram_gb  || m.ramGb  || 0;

        const cardClass = isLoaded ? 'model-card loaded' : (m.recommended ? 'model-card recommended' : 'model-card');

        let badges = '';
        if (m.recommended) badges += '<span class="badge badge-rec">⭐ Recommandé</span>';
        if (isBest && !isLoaded) badges += '<span class="badge badge-rec">🏆 Meilleur local</span>';
        if (isLoaded) badges += '<span class="badge badge-loaded">✅ Actif</span>';
        if (isDl)     badges += '<span class="badge badge-dl">💾 Téléchargé</span>';
        else          badges += '<span class="badge badge-notdl">☁️ Non téléchargé</span>';
        if (m.type === 'gguf') badges += '<span class="badge badge-gguf">GGUF</span>';
        if (canLoad)  badges += '<span class="badge badge-canload">✅ RAM ok</span>';
        else          badges += '<span class="badge badge-noram">❌ RAM insuffisante (' + ramGb + 'GB)</span>';

        let actionBtns = '';
        if (!isDl) {
            actionBtns = '<button class="btn btn-primary btn-dl" data-id="' + m.id + '" title="Nécessite une connexion internet">⬇ Télécharger (' + sizeGb + 'GB)</button>';
        } else if (!isLoaded) {
            actionBtns = '<button class="btn btn-success btn-load" data-id="' + m.id + '" ' + (!canLoad ? 'disabled title="RAM insuffisante"' : '') + '>▶ Charger</button>';
        } else {
            actionBtns = '<button class="btn btn-secondary" disabled>✅ Chargé</button>';
        }

        return '<div class="' + cardClass + '">' +
            '<div class="model-header">' +
                '<div class="model-name">' + m.name + '</div>' +
                '<div class="model-size">~' + sizeGb + 'GB · ' + ramGb + 'GB RAM</div>' +
            '</div>' +
            '<div class="model-desc">' + (m.description || m.desc || '') + '</div>' +
            '<div class="model-badges">' + badges + '</div>' +
            '<div class="btn-row">' + actionBtns + '</div>' +
        '</div>';
    }).join('');

    // Wire up download and load buttons
    list.querySelectorAll('.btn-dl').forEach(function(btn) {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            console.log('[RUNTIME] Download clicked:', id);
            vscPost({ type: 'downloadModel', modelId: id });
            this.disabled = true;
            this.textContent = '⟳ Téléchargement...';
        });
    });
    list.querySelectorAll('.btn-load').forEach(function(btn) {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            console.log('[RUNTIME] Load clicked:', id);
            vscPost({ type: 'switchModel', modelId: id });
            this.disabled = true;
            this.textContent = '⟳ Chargement...';
        });
    });

    console.log('[RUNTIME] Catalogue rendered — ' + catalogue.length + ' models');
}

// ── Messages from extension ───────────────────────────────────────────────
window.addEventListener('message', function(ev) {
    const msg = ev.data;
    console.log('[RUNTIME] Message received — type:', msg.type);

    switch (msg.type) {
        case 'statusUpdate': {
            updateSystem(msg.sysInfo);
            updateRuntime(msg.runtimeData);
            if (msg.runtimeError) {
                document.getElementById('statusBadge').className = 'offline';
                document.getElementById('statusBadge').textContent = '⚫ Hors ligne';
                document.getElementById('modelName').textContent = msg.runtimeError;
                console.warn('[RUNTIME] Runtime error:', msg.runtimeError);
            }
            if (msg.catalogue) {
                renderCatalogue(msg.catalogue, msg.catalogueMeta);
            }
            // Refresh button back to normal
            const refreshBtn = document.getElementById('btnRefresh');
            if (refreshBtn) refreshBtn.textContent = '🔄 Rafraîchir';
            break;
        }
        case 'logsData': {
            const logsBox = document.getElementById('logsBox');
            logsBox.textContent = msg.text || '(vide)';
            logsBox.classList.add('show');
            document.getElementById('btnLogs').textContent = '📋 Masquer Logs';
            document.getElementById('btnCache').textContent = '💾 Cache Info';
            break;
        }
        case 'downloadStarted':
            console.log('[RUNTIME] Download started for', msg.modelId);
            break;
        case 'actionDone':
            console.log('[RUNTIME] Action done:', msg.action);
            if (msg.action === 'restart') {
                document.getElementById('btnRestart').disabled = false;
                document.getElementById('btnRestart').textContent = '↺ Restart';
            }
            break;
        case 'autoSelectDone':
            console.log('[RUNTIME] Auto-selected:', msg.modelId);
            document.getElementById('btnAutoSelect').disabled = false;
            document.getElementById('btnAutoSelect').textContent = '⚡ Auto-sélect';
            break;
        case 'error':
            console.error('[RUNTIME] Error:', msg.text);
            document.getElementById('modelName').textContent = msg.text || 'Erreur inconnue';
            break;
        case 'info':
            document.getElementById('modelName').textContent = msg.text || '';
            break;
    }
});

console.log('[RUNTIME] Script init complete');
</script>
</body>
</html>`;
    }
}

module.exports = { RuntimePanel };
