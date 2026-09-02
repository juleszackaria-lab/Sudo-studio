/**
 * SUDO STUDIO — AgentPanel v1.0
 * WebView panel for the autonomous programming agent.
 * Shows task, plan, tools, terminal output, and final report.
 * Uses CSP nonce (same pattern as ChatPanel).
 */
'use strict';

const vscode = require('vscode');
const { AgentEngine } = require('./AgentEngine');

class AgentPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel        = panel;
        this.extensionUri = extensionUri;
        this.disposables  = [];
        this.engine       = null;
        this._running     = false;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);
    }

    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;

        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel.panel.reveal(column);
            return AgentPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'sudoStudioAgent',
            '🤖 Sudo Agent',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri);
        return AgentPanel.currentPanel;
    }

    async handleMessage(msg) {
        console.log('[AGENT_PANEL] Message:', msg.type);
        switch (msg.type) {
            case 'startTask':   await this.startTask(msg.task); break;
            case 'stopAgent':   this.stopAgent(); break;
            case 'approveAction': this.approveAction(true);  break;
            case 'rejectAction':  this.approveAction(false); break;
            case 'clearLog':    this.post({ type: 'clear' }); break;
        }
    }

    async startTask(task) {
        console.log('[AGENT_PANEL] startTask called — task:', task);
        if (!task || !task.trim()) {
            this.post({ type: 'error', message: 'Veuillez saisir une tâche.' });
            return;
        }
        if (this._running) {
            this.post({ type: 'error', message: 'Un agent est déjà en cours.' });
            return;
        }

        // Workspace is preferred but not mandatory.
        // Fall back to the extension's own directory so the agent
        // can still run tasks like "explain this code" or "generate a Dockerfile".
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        const projectRoot = wsFolder
            ? wsFolder.uri.fsPath
            : (this.extensionUri ? require('path').dirname(this.extensionUri.fsPath) : process.cwd());

        console.log('[AGENT_PANEL] projectRoot:', projectRoot, '| wsFolder:', wsFolder ? wsFolder.uri.fsPath : 'none (using fallback)');

        if (!wsFolder) {
            this.post({
                type: 'step',
                phase: 'analyze',
                message: '⚠️ Aucun workspace ouvert — l\'agent travaillera en mode autonome (sans accès au projet). Ouvrez un dossier via File > Open Folder pour des résultats optimaux.'
            });
        }

        this._running = true;
        this.post({ type: 'started', task });
        console.log('[AGENT_PANEL] Engine starting...');

        this.engine = new AgentEngine({
            projectRoot,
        });

        // Wire all engine events to the WebView
        this.engine.on('step',     d => { console.log('[AGENT_ENGINE] step:', d.phase, d.message); this.post({ type: 'step', ...d }); });
        this.engine.on('tool_call',d => { console.log('[AGENT_ENGINE] tool_call:', d.tool, JSON.stringify(d.args||{}).slice(0,80)); this.post({ type: 'tool_call', ...d }); });
        this.engine.on('progress', d => { console.log('[AGENT_ENGINE] progress:', d.pct + '%'); this.post({ type: 'progress', ...d }); });
        this.engine.on('error',    d => { console.log('[AGENT_ENGINE] error:', d.message); this.post({ type: 'agentError', ...d }); });
        this.engine.on('approval_needed', d => {
            console.log('[AGENT_ENGINE] approval_needed:', d.action);
            this.post({ type: 'approval_needed', action: d.action, description: d.description });
        });
        this.engine.on('done', d => {
            console.log('[AGENT_ENGINE] done — status:', d.status);
            this._running = false;
            this.post({ type: 'done', ...d });
        });

        try {
            console.log('[AGENT_PANEL] Calling engine.run()...');
            await this.engine.run(task);
            console.log('[AGENT_PANEL] engine.run() completed');
        } catch (e) {
            console.error('[AGENT_PANEL] engine.run() threw:', e.message);
            this._running = false;
            this.post({ type: 'agentError', message: e.message, phase: 'engine' });
        }
    }

    stopAgent() {
        if (this.engine) this.engine.stop();
        this._running = false;
    }

    approveAction(approved) {
        if (this.engine) this.engine.resolveApproval(approved);
        this.post({ type: 'approvalResolved', approved });
    }

    post(msg) {
        try { this.panel.webview.postMessage(msg); } catch (_) {}
    }

    dispose() {
        AgentPanel.currentPanel = undefined;
        if (this.engine) this.engine.stop();
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
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Sudo Agent</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src http://localhost:*;">
<style>
:root {
    --bg: #0d1117; --card: #161b22; --border: #21262d;
    --green: #2ea043; --blue: #1f6feb; --red: #f85149;
    --orange: #d29922; --text: #e6edf3; --muted: #7d8590;
    --accent: #58a6ff; --radius: 8px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }

/* Header */
#header { padding:10px 14px; background:var(--card); border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
#header h1 { font-size:15px; font-weight:600; }
.hbtns { display:flex; gap:6px; }

/* Task input */
#taskArea { padding:10px 14px; background:var(--card); border-bottom:1px solid var(--border); flex-shrink:0; }
.task-row { display:flex; gap:8px; }
#taskInput { flex:1; background:#0d1117; color:var(--text); border:1px solid var(--border); border-radius:var(--radius); padding:9px 12px; font-size:13.5px; font-family:inherit; resize:none; min-height:38px; max-height:90px; }
#taskInput:focus { outline:none; border-color:var(--blue); }

/* Buttons */
.btn { padding:8px 14px; min-height:38px; border:none; border-radius:var(--radius); cursor:pointer; font-size:13px; font-weight:500; white-space:nowrap; }
.btn-primary { background:var(--green); color:#fff; }
.btn-danger  { background:#c62828; color:#fff; display:none; }
.btn-danger.show { display:inline-block; }
.btn-secondary { background:var(--card); color:var(--text); border:1px solid var(--border); }
.btn:hover { opacity:.85; }
.btn:disabled { opacity:.45; cursor:not-allowed; }
.sbtn { padding:4px 9px; font-size:11px; cursor:pointer; border:none; border-radius:4px; background:var(--card); color:var(--text); border:1px solid var(--border); }
.sbtn:hover { opacity:.8; }

/* Progress bar */
#progressBar { height:3px; background:var(--border); flex-shrink:0; display:none; }
#progressBar.show { display:block; }
#progressFill { height:100%; background:var(--green); transition:width .3s; width:0; }

/* Main layout */
#main { flex:1; display:flex; overflow:hidden; }

/* Plan sidebar */
#planSide { width:230px; border-right:1px solid var(--border); padding:10px; overflow-y:auto; flex-shrink:0; display:flex; flex-direction:column; gap:6px; }
#planSide h3 { font-size:12px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
.plan-step { padding:7px 10px; border-radius:6px; font-size:12px; background:var(--card); border:1px solid var(--border); display:flex; gap:6px; align-items:flex-start; }
.plan-step.running { border-color:var(--blue); background:#1f2937; }
.plan-step.done    { opacity:.5; }
.plan-step .step-icon { flex-shrink:0; }

/* Activity feed */
#feed { flex:1; overflow-y:auto; padding:10px 14px; display:flex; flex-direction:column; gap:6px; }
.feed-item { padding:8px 12px; border-radius:6px; font-size:12.5px; display:flex; gap:8px; align-items:flex-start; border:1px solid var(--border); }
.feed-item.phase-start    { background:#1a2332; border-color:#1f6feb; }
.feed-item.phase-plan     { background:#1a2a1a; border-color:var(--green); }
.feed-item.phase-step     { background:var(--card); }
.feed-item.phase-analyze  { background:#1a2332; }
.feed-item.phase-verify   { background:#1a2a1a; }
.feed-item.phase-diagnose { background:#2a1a1a; border-color:var(--orange); }
.feed-item.phase-iterate  { background:var(--card); }
.feed-item.tool-call      { background:#1c1a2a; border-color:#7c3aed; font-family:monospace; font-size:11.5px; }
.feed-item.done-success   { background:#1a2a1a; border-color:var(--green); }
.feed-item.done-failed    { background:#2a1a1a; border-color:var(--red); }
.feed-item.done-stopped   { background:var(--card); }
.feed-item.approval       { background:#2a2000; border-color:var(--orange); }
.feed-icon { flex-shrink:0; }
.feed-content { flex:1; line-height:1.4; }
.feed-content strong { font-weight:600; }
.feed-content pre { margin:4px 0; white-space:pre-wrap; word-break:break-all; font-size:11px; color:var(--muted); max-height:150px; overflow-y:auto; }

/* Approval buttons */
.approval-btns { display:flex; gap:6px; margin-top:6px; }

/* Badges */
.badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:10px; }
.badge-green  { background:rgba(46,160,67,.2); color:var(--green); }
.badge-red    { background:rgba(248,81,73,.2); color:var(--red); }
.badge-orange { background:rgba(210,153,34,.2); color:var(--orange); }
.badge-blue   { background:rgba(31,111,235,.2); color:var(--accent); }
.badge-purple { background:rgba(124,58,237,.2); color:#a78bfa; }

/* Final report */
#reportPanel { display:none; }
#reportPanel.show { display:block; padding:14px; background:var(--card); border-top:1px solid var(--border); max-height:260px; overflow-y:auto; }
#reportPanel h3 { font-size:13px; font-weight:600; margin-bottom:8px; }
.report-section { margin-bottom:8px; }
.report-section h4 { font-size:11px; color:var(--muted); margin-bottom:3px; }
.report-section ul { list-style:none; padding:0; }
.report-section li { font-size:12px; padding:2px 0; }
.report-section li::before { content:'• '; color:var(--muted); }

/* Empty state */
#empty { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:10px; color:var(--muted); text-align:center; padding:20px; }
.empty-icon { font-size:44px; opacity:.5; }
.suggestions { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:10px; max-width:440px; }
.suggestion-btn { padding:8px 10px; border-radius:8px; font-size:12px; cursor:pointer; text-align:left; background:var(--card); color:var(--text); border:1px solid var(--border); }
.suggestion-btn:hover { opacity:.8; }

::-webkit-scrollbar { width:5px; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
</style>
</head>
<body>

<div id="header">
    <h1>🤖 Sudo Agent — Mode Autonome</h1>
    <div class="hbtns">
        <button class="sbtn" id="modeChatBtn">💬 Retour Chat</button>
        <button class="sbtn" id="clearLogBtn">🗑 Effacer</button>
    </div>
</div>

<div id="taskArea">
    <div class="task-row">
        <textarea id="taskInput" rows="1" placeholder="Décrivez la tâche... ex: Trouve pourquoi les tests échouent et corrige le problème"></textarea>
        <button class="btn btn-primary" id="startBtn">▶ Lancer</button>
        <button class="btn btn-danger" id="stopBtn">⏹ Stop</button>
    </div>
</div>

<div id="progressBar"><div id="progressFill"></div></div>

<div id="main">
    <div id="planSide">
        <h3>Plan</h3>
        <div id="planSteps">
            <div style="color:var(--muted);font-size:11px;padding:8px 0">Aucune tâche en cours</div>
        </div>
    </div>
    <div id="feed">
        <div class="empty" id="emptyState">
            <div class="empty-icon">🤖</div>
            <div style="font-size:15px;font-weight:600">Sudo Agent</div>
            <div style="font-size:12px">Décrivez une tâche et l'agent l'exécutera de manière autonome</div>
            <div class="suggestions" id="suggestionsGrid">
                <button class="suggestion-btn" data-task="Analyse ce projet et donne un rapport de qualité">🔍 Analyser le projet</button>
                <button class="suggestion-btn" data-task="Lance les tests et corrige les erreurs trouvées">🧪 Corriger les tests</button>
                <button class="suggestion-btn" data-task="Vérifie si le backend démarre correctement">🚀 Vérifier le backend</button>
                <button class="suggestion-btn" data-task="Trouve et corrige les problèmes de sécurité">🔒 Audit sécurité</button>
                <button class="suggestion-btn" data-task="Génère un Dockerfile optimisé pour ce projet">🐳 Générer Dockerfile</button>
                <button class="suggestion-btn" data-task="Vérifie et met à jour les dépendances vulnérables">📦 Mettre à jour les dépendances</button>
            </div>
        </div>
    </div>
</div>

<div id="reportPanel">
    <h3 id="reportTitle">Rapport Final</h3>
    <div id="reportContent"></div>
</div>

<script nonce="${nonce}">
console.log('[AGENT] Script starting...');

let vscode;
try {
    vscode = acquireVsCodeApi();
    window._vscode = vscode;
    console.log('[AGENT] VSCode API acquired');
} catch(e) {
    vscode = window._vscode;
    console.warn('[AGENT] Reusing cached vscode API');
}

const taskInput = document.getElementById('taskInput');
const startBtn  = document.getElementById('startBtn');
const stopBtn   = document.getElementById('stopBtn');
const feed      = document.getElementById('feed');
const planSteps = document.getElementById('planSteps');
const progressFill = document.getElementById('progressFill');
const progressBar  = document.getElementById('progressBar');
let running = false;
let currentPlan = [];

function vscPost(msg) {
    if (!vscode) return;
    try { vscode.postMessage(msg); } catch(e) { console.error('[AGENT] postMessage error:', e.message); }
}

// ── Button wiring ───────────────────────────────────────────────────────────
if (startBtn) startBtn.addEventListener('click', function() {
    const task = taskInput ? taskInput.value.trim() : '';
    console.log('[AGENT] Start clicked — task:', task);
    if (!task) { addFeedItem('agentError', '❌', 'Saisissez une tâche avant de lancer.'); return; }
    vscPost({ type: 'startTask', task });
});
if (stopBtn)  stopBtn.addEventListener('click',  function() { vscPost({ type: 'stopAgent' }); });
if (document.getElementById('modeChatBtn')) {
    document.getElementById('modeChatBtn').addEventListener('click', function() {
        vscPost({ type: 'openChat' });
    });
}
if (document.getElementById('clearLogBtn')) {
    document.getElementById('clearLogBtn').addEventListener('click', function() {
        vscPost({ type: 'clearLog' });
    });
}

// Suggestion buttons
document.getElementById('suggestionsGrid').querySelectorAll('.suggestion-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        const task = btn.getAttribute('data-task');
        if (taskInput) { taskInput.value = task; taskInput.style.height = 'auto'; taskInput.style.height = Math.min(taskInput.scrollHeight, 90) + 'px'; }
    });
});

// Textarea resize + Enter
if (taskInput) {
    taskInput.addEventListener('input', function() {
        taskInput.style.height = 'auto';
        taskInput.style.height = Math.min(taskInput.scrollHeight, 90) + 'px';
    });
    taskInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (startBtn) startBtn.click();
        }
    });
}

console.log('[AGENT] Listeners attached');

// ── Feed rendering ──────────────────────────────────────────────────────────
function removeEmpty() {
    const e = document.getElementById('emptyState');
    if (e) e.remove();
}

function addFeedItem(cls, icon, content, extra) {
    removeEmpty();
    const item = document.createElement('div');
    item.className = 'feed-item ' + cls;
    let html = '<span class="feed-icon">' + icon + '</span><div class="feed-content">' + escHtml(content);
    if (extra) html += '<pre>' + escHtml(extra) + '</pre>';
    html += '</div>';
    item.innerHTML = html;
    feed.appendChild(item);
    feed.scrollTop = feed.scrollHeight;
    return item;
}

function addApprovalItem(action, description) {
    removeEmpty();
    const item = document.createElement('div');
    item.className = 'feed-item approval';
    item.innerHTML = '<span class="feed-icon">⚠️</span><div class="feed-content">' +
        '<strong>Autorisation requise</strong><br>' +
        escHtml(action) + ': ' + escHtml(description) +
        '<div class="approval-btns">' +
        '<button id="approveBtn" class="btn btn-primary" style="padding:5px 12px;font-size:12px;min-height:28px">✅ Approuver</button>' +
        '<button id="rejectBtn"  class="btn btn-danger"  style="padding:5px 12px;font-size:12px;min-height:28px;display:inline-block">❌ Refuser</button>' +
        '</div></div>';
    feed.appendChild(item);
    feed.scrollTop = feed.scrollHeight;

    item.querySelector('#approveBtn').addEventListener('click', function() {
        vscPost({ type: 'approveAction' });
        item.querySelector('.approval-btns').innerHTML = '<span class="badge badge-green">✅ Approuvé</span>';
    });
    item.querySelector('#rejectBtn').addEventListener('click', function() {
        vscPost({ type: 'rejectAction' });
        item.querySelector('.approval-btns').innerHTML = '<span class="badge badge-red">❌ Refusé</span>';
    });
}

function renderPlan(plan) {
    planSteps.innerHTML = '';
    plan.forEach(function(step) {
        const el = document.createElement('div');
        el.className = 'plan-step ' + (step.status || '');
        el.id = 'plan-step-' + step.step;
        const icon = step.status === 'done' ? '✅' : step.status === 'running' ? '⟳' : '○';
        el.innerHTML = '<span class="step-icon">' + icon + '</span><span>' + escHtml(step.description) + '</span>';
        planSteps.appendChild(el);
    });
}

function updatePlanStep(stepNum, status) {
    const el = document.getElementById('plan-step-' + stepNum);
    if (!el) return;
    el.className = 'plan-step ' + status;
    const icon = status === 'done' ? '✅' : status === 'running' ? '⟳' : '○';
    const iconEl = el.querySelector('.step-icon');
    if (iconEl) iconEl.textContent = icon;
}

function showReport(data) {
    const panel = document.getElementById('reportPanel');
    const title = document.getElementById('reportTitle');
    const content = document.getElementById('reportContent');

    const emoji = { success: '✅', failed: '❌', stopped: '⏹' };
    title.textContent = (emoji[data.status] || '❓') + ' Rapport Final — ' + (data.status || '').toUpperCase();

    let html = '';
    if (data.filesModified && data.filesModified.length) {
        html += '<div class="report-section"><h4>Fichiers modifiés</h4><ul>' +
            data.filesModified.map(function(f) { return '<li>' + escHtml(f) + '</li>'; }).join('') + '</ul></div>';
    }
    if (data.commandsRun && data.commandsRun.length) {
        html += '<div class="report-section"><h4>Commandes exécutées</h4><ul>' +
            data.commandsRun.map(function(c) { return '<li><code>' + escHtml(c) + '</code></li>'; }).join('') + '</ul></div>';
    }
    if (data.summary && data.summary.errors && data.summary.errors.length) {
        html += '<div class="report-section"><h4>Erreurs rencontrées</h4><ul>' +
            data.summary.errors.map(function(e) {
                const txt = typeof e === 'string' ? e : (e.cmd + ' → ' + (e.stderr || '').slice(0,100));
                return '<li>' + escHtml(txt) + '</li>';
            }).join('') + '</ul></div>';
    }
    if (data.summary && data.summary.logs && data.summary.logs.length) {
        html += '<div class="report-section"><h4>Log agent</h4><pre style="font-size:10px;color:var(--muted);max-height:100px;overflow-y:auto">' +
            escHtml(data.summary.logs.join('\n')) + '</pre></div>';
    }
    content.innerHTML = html || '<p style="font-size:12px;color:var(--muted)">Aucun détail disponible.</p>';
    panel.classList.add('show');
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setRunning(v) {
    running = v;
    if (startBtn) startBtn.disabled = v;
    if (stopBtn)  stopBtn.classList.toggle('show', v);
    progressBar.classList.toggle('show', v);
    if (!v) { progressFill.style.width = '0'; }
}

// ── Messages from extension ─────────────────────────────────────────────────
window.addEventListener('message', function(ev) {
    const msg = ev.data;
    console.log('[AGENT] Message from ext — type:', msg.type);

    switch (msg.type) {
        case 'started':
            setRunning(true);
            document.getElementById('reportPanel').classList.remove('show');
            planSteps.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px 0">Construction du plan...</div>';
            addFeedItem('phase-start', '🚀', 'Tâche démarrée: ' + msg.task);
            break;

        case 'step':
            addFeedItem('phase-' + (msg.phase||'step'), phaseIcon(msg.phase), msg.message);
            break;

        case 'tool_call':
            addFeedItem('tool-call', toolIcon(msg.tool), '[' + msg.tool + '] ' + (msg.args ? JSON.stringify(msg.args).slice(0,100) : ''), msg.result);
            break;

        case 'progress':
            progressFill.style.width = (msg.pct || 0) + '%';
            break;

        case 'approval_needed':
            addApprovalItem(msg.action, msg.description);
            break;

        case 'approvalResolved':
            break;

        case 'done':
            setRunning(false);
            currentPlan.forEach(function(s) { updatePlanStep(s.step, 'done'); });
            const doneClass = 'done-' + (msg.status || 'stopped');
            const doneEmoji = msg.emoji || (msg.status === 'success' ? '✅' : '❌');
            addFeedItem(doneClass, doneEmoji, 'Terminé — STATUS: ' + (msg.status||'').toUpperCase());
            showReport(msg);
            break;

        case 'agentError':
            setRunning(false);
            addFeedItem('done-failed', '❌', 'Erreur agent [' + (msg.phase||'?') + ']: ' + msg.message);
            break;

        case 'error':
            addFeedItem('done-failed', '❌', msg.message);
            break;

        case 'clear':
            feed.innerHTML = '';
            planSteps.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px 0">Aucune tâche en cours</div>';
            document.getElementById('reportPanel').classList.remove('show');
            break;

        // Plan update from step phase
    }

    // Update plan if step has data.plan
    if (msg.data && msg.data.plan) {
        currentPlan = msg.data.plan;
        renderPlan(msg.data.plan);
    }
    // Update plan step status
    if (msg.data && msg.data.step) {
        const s = msg.data.step;
        if (s.step !== undefined) updatePlanStep(s.step, s.status || 'running');
    }
});

function phaseIcon(phase) {
    const icons = { start:'🚀', analyze:'🔍', plan:'📋', step:'▶', verify:'✅', diagnose:'🩺', iterate:'🔄', stop:'⏹' };
    return icons[phase] || '•';
}
function toolIcon(tool) {
    const icons = { read_file:'📄', write_file:'✏️', run_command:'⚡', ai_edit:'🤖', git:'🌿', approval:'⚠️' };
    return icons[tool] || '🔧';
}

console.log('[AGENT] Init complete');
</script>
</body>
</html>`;
    }
}

module.exports = { AgentPanel };
