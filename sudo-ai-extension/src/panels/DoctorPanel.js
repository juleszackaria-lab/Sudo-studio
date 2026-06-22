/**
 * SUDO STUDIO - Doctor Panel
 * Real-time system diagnostics with AutoFix buttons.
 */
const vscode = require('vscode');
const axios  = require('axios');
const { exec } = require('child_process');
const os = require('os');

class DoctorPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);
    }

    static createOrShow(extensionUri) {
        const column = vscode.ViewColumn.One;
        if (DoctorPanel.currentPanel) {
            DoctorPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoDoctor', '🩺 System Doctor', column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DoctorPanel.currentPanel = new DoctorPanel(panel, extensionUri);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'runDiagnostic': await this.runDiagnostic(); break;
            case 'autoFix':       await this.autoFix(msg.issue); break;
            case 'installSDK':    await this.installSDK(msg.sdk); break;
        }
    }

    async runDiagnostic() {
        this.panel.webview.postMessage({ type: 'diagStarted' });
        const results = await this._gatherDiagnostics();
        this.panel.webview.postMessage({ type: 'diagResults', results });
    }

    async _gatherDiagnostics() {
        const checks = [];

        // Helper
        const check = (name, cmd) => new Promise(resolve => {
            exec(cmd, { timeout: 5000 }, (err, stdout) => {
                if (!err && stdout.trim()) {
                    resolve({ name, status: 'ok', value: stdout.trim().split('\n')[0] });
                } else {
                    resolve({ name, status: 'error', value: 'Not found' });
                }
            });
        });

        const isWin = process.platform === 'win32';

        checks.push(
            check('Node.js',     isWin ? 'node --version' : 'node --version'),
            check('npm',         isWin ? 'npm --version' : 'npm --version'),
            check('Python',      isWin ? 'python --version 2>&1' : 'python3 --version'),
            check('pip',         isWin ? 'pip --version' : 'pip3 --version'),
            check('Git',         'git --version'),
            check('Docker',      'docker --version')
        );

        const results = await Promise.all(checks);

        // Backend check
        try {
            await axios.get('http://localhost:5000/api/system/health', { timeout: 2000 });
            results.push({ name: 'Backend (port 5000)', status: 'ok', value: 'Running' });
        } catch (_) {
            results.push({ name: 'Backend (port 5000)', status: 'error', value: 'Not running', fix: 'startBackend' });
        }

        // Runtime check
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 2000 });
            const m = r.data.model || {};
            const label = m.loaded ? `Running · ${m.name || 'model'}` : (m.loading ? `Loading (${m.download_progress||0}%)` : 'Running (no model)');
            results.push({ name: 'AI Runtime (port 6000)', status: m.loaded || m.loading ? 'ok' : 'warn', value: label, fix: m.loaded ? null : 'downloadModel' });
        } catch (_) {
            results.push({ name: 'AI Runtime (port 6000)', status: 'error', value: 'Not running', fix: 'startRuntime' });
        }

        // System info
        results.push({ name: 'Platform', status: 'info', value: `${os.platform()} ${os.arch()}` });
        results.push({ name: 'RAM',      status: 'info', value: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB free` });

        return results;
    }

    async autoFix(issue) {
        this.panel.webview.postMessage({ type: 'fixStarted', issue });
        
        const isWin = process.platform === 'win32';
        let cmd = null;
        let msg = '';

        switch (issue) {
            case 'Node.js':
                if (isWin) {
                    vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/en/download/'));
                    msg = 'Ouverture du site Node.js pour téléchargement Windows';
                } else {
                    cmd = 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs';
                    msg = 'Installation de Node.js via nodesource...';
                }
                break;
            case 'Python':
                if (isWin) {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
                    msg = 'Ouverture du site Python pour téléchargement Windows';
                } else {
                    cmd = 'sudo apt-get install -y python3 python3-pip';
                    msg = 'Installation de Python3...';
                }
                break;
            case 'Git':
                if (isWin) {
                    vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/download/win'));
                    msg = 'Ouverture du site Git pour Windows';
                } else {
                    cmd = 'sudo apt-get install -y git';
                    msg = 'Installation de Git...';
                }
                break;
            case 'Docker':
                vscode.env.openExternal(vscode.Uri.parse('https://docs.docker.com/get-docker/'));
                msg = 'Ouverture du site Docker';
                break;
            case 'downloadModel':
                try {
                    await axios.post('http://localhost:6000/download',
                        { model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }, { timeout: 5000 });
                    msg = '⬇ Téléchargement du modèle démarré...';
                } catch (e) {
                    msg = `Impossible de contacter le runtime: ${e.message}`;
                }
                break;
            default:
                msg = `Aucune correction automatique disponible pour: ${issue}`;
        }

        if (cmd) {
            vscode.window.showInformationMessage(`AutoFix: ${msg}`);
            const terminal = vscode.window.createTerminal('Sudo AutoFix');
            terminal.show();
            terminal.sendText(cmd);
            msg += ' (voir le terminal)';
        } else if (msg) {
            vscode.window.showInformationMessage(`AutoFix: ${msg}`);
        }

        this.panel.webview.postMessage({ type: 'fixDone', issue, message: msg });
    }

    // FIX BUG: installSDK method was missing — handleMessage case 'installSDK' called this.installSDK()
    // which threw TypeError: this.installSDK is not a function
    async installSDK(sdkId) {
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const sdkCmds = {
            'Node.js':  isWin ? 'winget install OpenJS.NodeJS.LTS' : isMac ? 'brew install node' : 'sudo apt-get install -y nodejs npm',
            'Python':   isWin ? 'winget install Python.Python.3.11' : isMac ? 'brew install python@3.11' : 'sudo apt-get install -y python3 python3-pip',
            'Git':      isWin ? 'winget install Git.Git' : isMac ? 'brew install git' : 'sudo apt-get install -y git',
            'Docker':   'start https://www.docker.com/products/docker-desktop'
        };
        const cmd = sdkCmds[sdkId];
        if (!cmd) {
            vscode.window.showInformationMessage(`SDK not recognized: ${sdkId}`);
            return;
        }
        const terminal = vscode.window.createTerminal(`Install ${sdkId}`);
        terminal.show();
        terminal.sendText(cmd);
        vscode.window.showInformationMessage(`⚡ Installing ${sdkId}... Check the terminal.`);
        this.panel.webview.postMessage({ type: 'fixDone', issue: sdkId, message: `Installing ${sdkId} via terminal` });
    }

    dispose() {
        DoctorPanel.currentPanel = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d && d.dispose());
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>System Doctor</title>
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
body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--vscode-editor-background);
    color:var(--vscode-editor-foreground);
    padding:0; min-height:100vh;
}
#header {
    padding:14px 16px;
    background:var(--vscode-sideBar-background);
    border-bottom:1px solid var(--vscode-panel-border);
    display:flex; justify-content:space-between; align-items:center;
}
#header h1 { font-size:16px; font-weight:600; }
.score-card {
    margin:16px; padding:16px;
    background:var(--vscode-editorWidget-background);
    border-radius:10px; text-align:center;
    border:1px solid var(--vscode-panel-border);
}
.score-value { font-size:48px; font-weight:700; }
.score-label { font-size:12px; opacity:.7; margin-top:4px; }
#results { padding:0 16px 16px; display:flex; flex-direction:column; gap:8px; }
.check-item {
    padding:10px 14px; border-radius:8px;
    background:var(--vscode-editorWidget-background);
    border:1px solid var(--vscode-panel-border);
    display:flex; justify-content:space-between; align-items:center;
    gap:8px;
}
.check-left { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
.check-icon { font-size:16px; flex-shrink:0; }
.check-name { font-size:13px; font-weight:500; }
.check-value { font-size:11px; opacity:.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; }
.check-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.badge {
    font-size:10px; padding:2px 8px; border-radius:10px; font-weight:600;
}
.badge.ok   { background:#4caf5030; color:#4caf50; }
.badge.error{ background:#f4433630; color:#f44336; }
.badge.warn { background:#ff980030; color:#ff9800; }
.badge.info { background:#2196f330; color:#2196f3; }
.fix-btn {
    padding:4px 10px; font-size:11px; cursor:pointer; border:none; border-radius:5px;
    background:var(--vscode-button-background); color:var(--vscode-button-foreground);
    font-weight:500; transition:opacity .2s;
}
.fix-btn:hover { opacity:.8; }
.fix-btn:disabled { opacity:.4; cursor:not-allowed; }
.action-bar {
    padding:16px; display:flex; gap:8px;
}
.btn {
    flex:1; padding:10px; font-size:13px; cursor:pointer; border:none; border-radius:7px;
    font-weight:600; transition:opacity .2s;
}
.btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.btn:hover { opacity:.85; }
#status-msg {
    margin:0 16px 12px; padding:10px 14px;
    background:var(--vscode-editorWidget-background);
    border-radius:8px; font-size:12px; opacity:.8;
    display:none;
}
#status-msg.show { display:block; }
.spinner { display:inline-block; animation:spin .8s linear infinite; }
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="header">
    <h1>🩺 System Doctor</h1>
    <span id="lastCheck" style="font-size:11px;opacity:.6;"></span>
</div>

<div class="action-bar">
    <button class="btn btn-primary" onclick="runDiag()" id="diagBtn">▶ Run Diagnostic</button>
    <button class="btn btn-secondary" onclick="autoFixAll()">🔧 AutoFix All</button>
</div>

<div id="status-msg"></div>

<div class="score-card" id="scoreCard" style="display:none">
    <div class="score-value" id="scoreValue">—</div>
    <div class="score-label">Health Score</div>
</div>

<div id="results"></div>

<script>
const vscode = acquireVsCodeApi();
let lastResults = [];

function runDiag() {
    document.getElementById('diagBtn').disabled = true;
    document.getElementById('diagBtn').textContent = '⟳ Running...';
    setStatus('🔍 Analyse en cours...');
    document.getElementById('scoreCard').style.display = 'none';
    document.getElementById('results').innerHTML = '';
    vscode.postMessage({ type: 'runDiagnostic' });
}

function autoFixAll() {
    const errors = lastResults.filter(r => (r.status === 'error' || r.status === 'warn') && r.fix);
    if (errors.length === 0) {
        setStatus('✅ Aucun problème à corriger!');
        return;
    }
    errors.forEach(r => fixIssue(r.fix || r.name));
}

function fixIssue(issue) {
    setStatus('🔧 Correction en cours: ' + issue);
    vscode.postMessage({ type: 'autoFix', issue });
}

function setStatus(msg) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4000);
}

function calcScore(results) {
    const ok = results.filter(r => r.status === 'ok').length;
    const total = results.filter(r => r.status !== 'info').length;
    return total > 0 ? Math.round((ok / total) * 100) : 100;
}

function renderResults(results) {
    lastResults = results;
    const container = document.getElementById('results');
    container.innerHTML = '';

    const score = calcScore(results);
    const scoreEl = document.getElementById('scoreCard');
    const scoreVal = document.getElementById('scoreValue');
    scoreEl.style.display = 'block';
    scoreVal.textContent = score + '/100';
    scoreVal.style.color = score >= 80 ? '#4caf50' : score >= 50 ? '#ff9800' : '#f44336';

    results.forEach(r => {
        const div = document.createElement('div');
        div.className = 'check-item';

        const icon = r.status === 'ok' ? '✅' : r.status === 'error' ? '❌' : r.status === 'warn' ? '⚠️' : 'ℹ️';

        let fixBtn = '';
        if (r.status === 'error' || r.status === 'warn') {
            fixBtn = \`<button class="fix-btn" onclick="fixIssue('\${r.fix || r.name}')" id="fix-\${r.name.replace(/\s+/g,'_')}">
                AutoFix
            </button>\`;
        }

        div.innerHTML = \`
            <div class="check-left">
                <span class="check-icon">\${icon}</span>
                <div>
                    <div class="check-name">\${r.name}</div>
                    <div class="check-value">\${r.value}</div>
                </div>
            </div>
            <div class="check-right">
                <span class="badge \${r.status}">\${r.status.toUpperCase()}</span>
                \${fixBtn}
            </div>\`;
        container.appendChild(div);
    });
}

window.addEventListener('message', ev => {
    const msg = ev.data;
    switch(msg.type) {
        case 'diagStarted':
            document.getElementById('results').innerHTML = '<div style="padding:16px;text-align:center;opacity:.6;"><span class="spinner">⟳</span> Analyse système...</div>';
            break;
        case 'diagResults':
            document.getElementById('diagBtn').disabled = false;
            document.getElementById('diagBtn').textContent = '▶ Run Diagnostic';
            document.getElementById('lastCheck').textContent = 'Dernière analyse: ' + new Date().toLocaleTimeString();
            renderResults(msg.results);
            break;
        case 'fixStarted':
            setStatus('🔧 Correction: ' + msg.issue);
            break;
        case 'fixDone':
            setStatus('✅ ' + msg.message);
            setTimeout(runDiag, 2000);
            break;
    }
});

// Auto-run on open
runDiag();
</script>
</body>
</html>`;
    }
}

module.exports = { DoctorPanel };
