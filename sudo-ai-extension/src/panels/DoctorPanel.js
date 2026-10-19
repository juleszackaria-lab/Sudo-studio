/**
 * SUDO STUDIO - Doctor Panel
 * Real-time system diagnostics with AutoFix buttons.
 */
const vscode = require('vscode');
const { guardSnippet } = require('../utils/webviewGuard');
const bf = require('../utils/backendFallback'); // P30(d)
const axios  = require('axios');
const { exec } = require('child_process');
const os = require('os');
const { fixAll, fixOne, isKnownTool } = require('../doctor/autoFix');
const { appendAudit } = require('../utils/auditLog');
const { sharedLog } = require('../utils/techLog'); // P21-g: NOOP until extension activation enables it

class DoctorPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this._dlPollMs = 2000;    // test seam: model-download verify polling
        this._dlPollTries = 15;
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

    // P30(d): race the load against the 5 s bound; overlay if backend down.
    _p30Ensure() { return bf.ensureBackend(this.panel, () => this.runDiagnostic()); }

    async handleMessage(msg) {
        if (bf.handlePanelMessage(this.panel, msg, () => this._p30Ensure())) return;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'runDiagnostic': await this._p30Ensure(); break;
            case 'autoFix':       await this.autoFix(msg.issue); break;
            case 'autoFixAll':    await this.autoFixAll(); break;
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
            const r = await axios.get('http://127.0.0.1:6000/health', { timeout: 2000 });
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

    // PROMPT 7: every fix is EXECUTED by the app (winget/offline installers),
    // verified with --version, and audited. The browser is never opened.
    _engineDeps(onProgress) {
        let offlineDir = '';
        try {
            offlineDir = vscode.workspace.getConfiguration('sudoStudio').get('offlineInstallersDir', '') || '';
        } catch (_) { offlineDir = ''; }
        return {
            platform: process.platform,
            offlineDir: offlineDir || undefined, // engine default (~/.sudo_studio/installers) otherwise
            onProgress: onProgress || (() => {}),
            techLog: sharedLog('autofix'), // P21-g: structured tech journal (NOOP in tests)
            audit: (action, detail, result) => {
                try { appendAudit(action, detail, { actor: 'admin', result, verified: true }); }
                catch (_) { /* audit never breaks the fix */ }
            },
            askElevation: async (text) => {
                const choice = await vscode.window.showInformationMessage(
                    'AutoFix - elevation requise : ' + text,
                    { modal: true }, 'Elever et continuer', 'Annuler');
                return choice === 'Elever et continuer';
            },
        };
    }

    _manualRow(issue) {
        if (issue === 'startBackend' || issue === 'startRuntime') {
            const cmd = issue === 'startBackend'
                ? 'cd backend && node server.js'
                : 'cd backend/runtime && python server.py';
            return { issue, status: 'manual', method: 'none',
                reason: 'demarrage manuel requis : ' + cmd };
        }
        return { issue, status: 'manual', method: 'none',
            reason: 'aucune correction automatique disponible pour : ' + issue };
    }

    _auditRow(row) {
        try {
            appendAudit(row.status === 'fixed' ? 'AUTOFIX_OK' : 'AUTOFIX_MANUAL',
                row.issue + ' [' + (row.method || 'none') + '] ' + row.reason,
                { actor: 'admin', result: row.status === 'fixed' ? 'ok' : row.status, verified: true });
        } catch (_) {}
    }

    _rowLabel(row) {
        const head = row.status === 'fixed' ? 'Corrige' : row.status === 'restart' ? 'Redemarrage requis'
            : row.status === 'manual' ? 'Action manuelle requise' : 'Echec';
        return head + ' (' + row.issue + ') : ' + row.reason;
    }

    async _downloadModelFix() {
        const issue = 'downloadModel';
        try {
            await axios.post('http://127.0.0.1:6000/download',
                { model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }, { timeout: 5000 });
        } catch (e) {
            const row = { issue, status: 'failed', method: 'runtime', reason: 'runtime injoignable : ' + e.message };
            this._auditRow(row);
            return row;
        }
        for (let i = 0; i < this._dlPollTries; i++) {
            await new Promise((r) => setTimeout(r, this._dlPollMs));
            try {
                const r = await axios.get('http://127.0.0.1:6000/health', { timeout: 3000 });
                const m = (r.data && r.data.model) || {};
                if (m.loaded || m.loading) {
                    const row = { issue, status: 'fixed', method: 'runtime',
                        reason: 'telechargement ' + (m.loaded ? 'termine' : 'en cours (' + (m.download_progress || 0) + '%)') };
                    this._auditRow(row);
                    return row;
                }
            } catch (_) { /* keep polling */ }
        }
        const row = { issue, status: 'failed', method: 'runtime',
            reason: 'aucun chargement constate cote runtime apres ' + Math.round(this._dlPollMs * this._dlPollTries / 1000) + ' s' };
        this._auditRow(row);
        return row;
    }

    async autoFix(issue) {
        this.panel.webview.postMessage({ type: 'fixStarted', issue });
        let row;
        if (isKnownTool(issue)) {
            const out = await fixOne(issue, this._engineDeps((p) => {
                try { this.panel.webview.postMessage({ type: 'fixProgress', ...p, scope: 'one' }); }
                catch (_) {}
            }));
            if (out.terminalCmd) this._showTerminal(out.terminalCmd);
            row = out.row;
        } else if (issue === 'downloadModel') {
            row = await this._downloadModelFix();
        } else {
            row = this._manualRow(issue);
            this._auditRow(row);
        }
        const msg = this._rowLabel(row);
        vscode.window.showInformationMessage('AutoFix: ' + msg);
        this.panel.webview.postMessage({ type: 'fixDone', issue, message: msg, ok: row.status === 'fixed', row });
    }

    _showTerminal(cmd) {
        try {
            const terminal = vscode.window.createTerminal('Sudo AutoFix');
            terminal.show();
            terminal.sendText(cmd);
        } catch (_) {}
    }

    async autoFixAll() {
        const results = await this._gatherDiagnostics();
        const wanted = [];
        for (const r of results) {
            // NOTE: tool rows carry no `fix` field (only a name) - the old
            // client filtered on r.fix and silently skipped them (PROMPT 7
            // proven bug "Auto Fix All ne corrige pas tout"). Map to fix||name.
            if (r.status === 'error' || r.status === 'warn') {
                const key = r.fix || r.name;
                if (key && !wanted.includes(key)) wanted.push(key);
            }
        }
        this.panel.webview.postMessage({ type: 'fixAllStarted', total: wanted.length, issues: wanted });
        if (!wanted.length) {
            this.panel.webview.postMessage({ type: 'fixAllDone', rows: [] });
            return;
        }
        const rows = [];
        const pushRow = (row) => {
            rows.push(row);
            try { this.panel.webview.postMessage({ type: 'fixAllRow', row, done: rows.length, total: wanted.length }); }
            catch (_) {}
        };
        const tools = wanted.filter(isKnownTool);
        if (tools.length) {
            const out = await fixAll(tools, this._engineDeps((p) => {
                try { this.panel.webview.postMessage({ type: 'fixProgress', ...p, scope: 'all' }); }
                catch (_) {}
            }));
            if (out.terminalCmd) this._showTerminal(out.terminalCmd);
            for (const r of out.rows) pushRow(r);
        }
        for (const issue of wanted.filter((w) => !isKnownTool(w))) {
            if (issue === 'downloadModel') pushRow(await this._downloadModelFix());
            else { const row = this._manualRow(issue); this._auditRow(row); pushRow(row); }
        }
        rows.sort((a, b) => wanted.indexOf(a.issue) - wanted.indexOf(b.issue));
        try {
            appendAudit('AUTOFIX_ALL_DONE',
                'tableau final : ' + rows.map((r) => r.issue + '=' + r.status).join(', '),
                { actor: 'admin', result: 'ok', verified: true });
        } catch (_) {}
        this.panel.webview.postMessage({ type: 'fixAllDone', rows });
    }

    // PROMPT 7: installSDK is executed + verified through the same engine
    // (the old Docker branch opened a browser page - never again).
    async installSDK(sdkId) {
        const known = { 'Node.js': 'Node.js', Python: 'Python', Git: 'Git', Docker: 'Docker' };
        const issue = known[sdkId];
        if (!issue) {
            vscode.window.showInformationMessage(`SDK not recognized: ${sdkId}`);
            return;
        }
        await this.autoFix(issue);
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
${guardSnippet()}
<div id="header">
    <h1>🩺 System Doctor</h1>
    <span id="lastCheck" style="font-size:11px;opacity:.6;"></span>
</div>

<div class="action-bar">
    <button class="btn btn-primary" onclick="runDiag()" id="diagBtn">▶ Run Diagnostic</button>
    <button class="btn btn-secondary" onclick="autoFixAll()">🔧 AutoFix All</button>
</div>

<div id="status-msg"></div>
<div id="fixprogress"></div>
<div id="fixreport"></div>

<div class="score-card" id="scoreCard" style="display:none">
    <div class="score-value" id="scoreValue">—</div>
    <div class="score-label">Health Score</div>
</div>

<div id="results"></div>

<script>
const vscode = acquireVsCodeApi();
window.__sudoBackendInit && window.__sudoBackendInit(vscode);
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
    document.getElementById('fixreport').innerHTML = '';
    setStatus('Correction de tous les problemes en cours...');
    vscode.postMessage({ type: 'autoFixAll' });
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

function fixBadge(status) {
    if (status === "fixed") return "ok";
    if (status === "failed") return "error";
    if (status === "restart") return "warn";
    return "info";
}

function fixLabel(status) {
    if (status === "fixed") return "CORRIGÉ";
    if (status === "failed") return "ÉCHEC";
    if (status === "restart") return "REDÉMARRAGE";
    return "MANUEL";
}

function showFixProgress(done, total, label) {
    const host = document.getElementById("fixprogress");
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.setAttribute("style", "padding:12px 16px;font-size:12px;");
    const txt = document.createElement("div");
    txt.textContent = label + " (" + done + "/" + total + ")";
    const bar = document.createElement("div");
    bar.setAttribute("style", "background:#21262d;border-radius:6px;margin-top:6px;");
    const fill = document.createElement("div");
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.setAttribute("style", "width:" + pct + "%;background:#2ea043;border-radius:6px;height:8px;");
    bar.appendChild(fill);
    wrap.appendChild(txt);
    wrap.appendChild(bar);
    host.appendChild(wrap);
}

function renderFixTable(rows) {
    const host = document.getElementById("fixreport");
    host.innerHTML = "";
    const box = document.createElement("div");
    box.setAttribute("style", "margin:0 16px 16px;padding:12px 14px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:8px;");
    const title = document.createElement("div");
    title.setAttribute("style", "font-size:13px;font-weight:600;margin-bottom:8px;");
    title.textContent = "Résultat AutoFix";
    box.appendChild(title);
    if (!rows.length) {
        const none = document.createElement("div");
        none.setAttribute("style", "font-size:12px;opacity:.7;");
        none.textContent = "Aucun problème à corriger.";
        box.appendChild(none);
    }
    rows.forEach(function(r) {
        const div = document.createElement("div");
        div.className = "check-item";
        const left = document.createElement("div");
        left.className = "check-left";
        const inner = document.createElement("div");
        const nm = document.createElement("div");
        nm.className = "check-name";
        nm.textContent = r.issue;
        const rs = document.createElement("div");
        rs.setAttribute("style", "font-size:11px;opacity:.6;white-space:normal;");
        rs.textContent = r.reason;
        inner.appendChild(nm);
        inner.appendChild(rs);
        left.appendChild(inner);
        const right = document.createElement("div");
        right.className = "check-right";
        const badge = document.createElement("span");
        badge.className = "badge " + fixBadge(r.status);
        badge.textContent = fixLabel(r.status);
        right.appendChild(badge);
        div.appendChild(left);
        div.appendChild(right);
        box.appendChild(div);
    });
    host.appendChild(box);
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
            setStatus((msg.ok === false ? 'A VERIFIER : ' : 'OK : ') + msg.message);
            setTimeout(runDiag, 2000);
            break;
        case 'fixProgress':
            showFixProgress(msg.index || 0, msg.total || 0, (msg.phase || '') + ' : ' + (msg.issue || ''));
            break;
        case 'fixAllStarted':
            document.getElementById('fixreport').innerHTML = '';
            showFixProgress(0, msg.total || 0, 'Préparation');
            break;
        case 'fixAllRow':
            showFixProgress(msg.done, msg.total, msg.row.issue + ' : ' + msg.row.status);
            break;
        case 'fixAllDone':
            document.getElementById('fixprogress').innerHTML = '';
            renderFixTable(msg.rows || []);
            setTimeout(runDiag, 2500);
            break;
    }
});

// Auto-run on open
runDiag();
</script>
${bf.webviewSnippet()}
</body>
</html>`;
    }
}

module.exports = { DoctorPanel };
