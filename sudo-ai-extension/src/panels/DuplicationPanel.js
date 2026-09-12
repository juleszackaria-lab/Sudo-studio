/**
 * SUDO STUDIO — Enterprise Duplication Panel
 * Feature 2: Enterprise Duplication at Scale
 *
 * Provides:
 * 1. Environment Profile Export / Import (JSON snapshot of full dev env)
 * 2. Project Template Creation (zip current workspace into a reusable template)
 * 3. Template Deploy (unzip a template into a new folder)
 * 4. Multi-Machine Sync diff (compare local env against a shared profile)
 *
 * Completely local — no backend needed.
 * All failures are explicit ([FAIL] log entries, never silent).
 */
'use strict';

const vscode = require('vscode');
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { promisify } = require('util');
const execAsync = promisify(exec);

const IS_WIN = process.platform === 'win32';

// ── Tool list for environment snapshot ──────────────────────────────────────
const TOOL_CHECKS = [
    { name: 'Node.js',  cmd: 'node --version' },
    { name: 'npm',      cmd: 'npm --version' },
    { name: 'Python',   cmd: IS_WIN ? 'python --version' : 'python3 --version' },
    { name: 'pip',      cmd: IS_WIN ? 'pip --version' : 'pip3 --version' },
    { name: 'Git',      cmd: 'git --version' },
    { name: 'Docker',   cmd: 'docker --version' },
    { name: 'Flutter',  cmd: 'flutter --version' },
    { name: 'Java',     cmd: 'java --version 2>&1' },
    { name: 'Rust',     cmd: 'rustc --version' },
    { name: 'Go',       cmd: 'go version' },
];

function detectTool(t) {
    return new Promise(r => {
        exec(t.cmd, { timeout: 5000 }, (err, stdout) => {
            r({ name: t.name, installed: !err && !!stdout.trim(), version: stdout.trim().split('\n')[0] || null });
        });
    });
}

async function buildEnvProfile(label) {
    const tools = await Promise.all(TOOL_CHECKS.map(detectTool));
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const envVars = {};
    ['PATH','JAVA_HOME','ANDROID_HOME','FLUTTER_ROOT','PYTHONPATH','GOPATH','NODE_ENV'].forEach(k => {
        if (process.env[k]) envVars[k] = process.env[k];
    });
    // Detect project type from workspace
    let projectType = 'unknown';
    if (wsRoot) {
        if (fs.existsSync(path.join(wsRoot, 'pubspec.yaml'))) projectType = 'flutter';
        else if (fs.existsSync(path.join(wsRoot, 'package.json'))) projectType = 'nodejs';
        else if (fs.existsSync(path.join(wsRoot, 'requirements.txt'))) projectType = 'python';
        else if (fs.existsSync(path.join(wsRoot, 'pom.xml'))) projectType = 'java-maven';
        else if (fs.existsSync(path.join(wsRoot, 'build.gradle'))) projectType = 'java-gradle';
        else if (fs.existsSync(path.join(wsRoot, 'Cargo.toml'))) projectType = 'rust';
        else if (fs.existsSync(path.join(wsRoot, 'go.mod'))) projectType = 'go';
        else if (fs.existsSync(path.join(wsRoot, 'Dockerfile'))) projectType = 'docker';
    }
    return {
        label:          label || 'env-profile',
        version:        '2.0',
        createdAt:      new Date().toISOString(),
        machine:        os.hostname(),
        platform:       `${os.platform()} ${os.arch()}`,
        nodeVersion:    process.version,
        sudoStudioVer:  '1.0.0',
        workspace:      wsRoot,
        projectType,
        tools,
        envVars,
        totalRam:       Math.round(os.totalmem() / 1024 / 1024 / 1024),
        cpuCores:       os.cpus().length,
    };
}

function diffProfiles(local, imported) {
    const diffs = [];
    const importedToolMap = {};
    (imported.tools || []).forEach(t => { importedToolMap[t.name] = t; });
    (local.tools || []).forEach(lt => {
        const it = importedToolMap[lt.name];
        if (!it) return;
        if (!lt.installed && it.installed) {
            diffs.push({ tool: lt.name, local: 'NOT INSTALLED', required: it.version, severity: 'error' });
        } else if (lt.installed && it.installed && lt.version !== it.version) {
            diffs.push({ tool: lt.name, local: lt.version, required: it.version, severity: 'warn' });
        }
    });
    return diffs;
}

// ── Panel class ───────────────────────────────────────────────────────────────
class DuplicationPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.localProfile = null;

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._scanLocal(), 400);
    }

    static createOrShow(extensionUri) {
        if (DuplicationPanel.currentPanel) { DuplicationPanel.currentPanel.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioDuplication', '📋 Enterprise Duplication',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DuplicationPanel.currentPanel = new DuplicationPanel(panel, extensionUri);
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'scanLocal':      await this._scanLocal(); break;
            case 'exportProfile':  await this._exportProfile(); break;
            case 'importProfile':  await this._importProfile(); break;
            case 'createTemplate': await this._createTemplate(); break;
            case 'deployTemplate': await this._deployTemplate(); break;
            case 'openUrl':        vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
        }
    }

    async _scanLocal() {
        this.panel.webview.postMessage({ type: 'scanning' });
        try {
            this.localProfile = await buildEnvProfile('local');
            this.panel.webview.postMessage({ type: 'localReady', profile: this.localProfile });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'error', msg: `Scan failed: ${e.message}` });
        }
    }

    async _exportProfile() {
        try {
            const profile = await buildEnvProfile('exported');
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-env-${Date.now()}.json`)),
                filters: { 'Environment Profile': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(profile, null, 2), 'utf8');
            vscode.window.showInformationMessage(
                `✅ Profile exported: ${path.basename(saveUri.fsPath)}`,
                'Open'
            ).then(s => { if (s === 'Open') vscode.workspace.openTextDocument(saveUri.fsPath).then(d => vscode.window.showTextDocument(d)); });
            this.panel.webview.postMessage({ type: 'exportDone', file: saveUri.fsPath });
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Export failed: ${e.message}`);
            this.panel.webview.postMessage({ type: 'error', msg: `[FAIL] Export: ${e.message}` });
        }
    }

    async _importProfile() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Environment Profile': ['json'] }
            });
            if (!uris || !uris.length) return;
            const raw      = fs.readFileSync(uris[0].fsPath, 'utf8');
            const imported = JSON.parse(raw);
            if (!imported.tools || !imported.createdAt) {
                throw new Error('File does not appear to be a valid Sudo Studio environment profile (missing tools or createdAt).');
            }
            // Compute diff against local profile
            const local = this.localProfile || await buildEnvProfile('local');
            const diffs = diffProfiles(local, imported);
            this.panel.webview.postMessage({
                type: 'diffResult', imported, local, diffs,
                file: path.basename(uris[0].fsPath)
            });
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Import failed: ${e.message}`);
            this.panel.webview.postMessage({ type: 'error', msg: `[FAIL] Import: ${e.message}` });
        }
    }

    async _createTemplate() {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!wsRoot) {
            vscode.window.showWarningMessage('Open a workspace folder first to create a template.');
            return;
        }
        const name = await vscode.window.showInputBox({
            prompt: 'Template name', placeHolder: 'my-project-template',
            validateInput: v => /^[\w\-]+$/.test(v) ? null : 'Use only letters, digits, hyphens'
        });
        if (!name) return;

        try {
            const outDir  = path.join(os.homedir(), '.sudo_studio', 'templates');
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `${name}.zip`);

            // Use PowerShell Compress-Archive on Windows, zip on Unix
            let zipCmd;
            if (IS_WIN) {
                zipCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${wsRoot}\\*' -DestinationPath '${outFile}' -Force"`;
            } else {
                zipCmd = `cd "${wsRoot}" && zip -r "${outFile}" . --exclude '.git/*' --exclude 'node_modules/*' --exclude '.dart_tool/*'`;
            }

            this.panel.webview.postMessage({ type: 'templateProgress', msg: 'Creating template zip...' });
            await execAsync(zipCmd, { timeout: 60000 });

            const stat    = fs.statSync(outFile);
            const sizeMb  = (stat.size / 1024 / 1024).toFixed(1);
            vscode.window.showInformationMessage(`✅ Template "${name}" created (${sizeMb} MB)`, 'Open Folder')
                .then(s => { if (s === 'Open Folder') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir)); });
            this.panel.webview.postMessage({ type: 'templateCreated', name, file: outFile, sizeMb });
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Template creation failed: ${e.message}`);
            this.panel.webview.postMessage({ type: 'error', msg: `[FAIL] Template: ${e.message}` });
        }
    }

    async _deployTemplate() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Template ZIP': ['zip'] }
            });
            if (!uris || !uris.length) return;

            const destUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'new-project')),
            });
            if (!destUri) return;

            if (!fs.existsSync(destUri.fsPath)) fs.mkdirSync(destUri.fsPath, { recursive: true });

            let extractCmd;
            if (IS_WIN) {
                extractCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${uris[0].fsPath}' -DestinationPath '${destUri.fsPath}' -Force"`;
            } else {
                extractCmd = `unzip -o "${uris[0].fsPath}" -d "${destUri.fsPath}"`;
            }

            this.panel.webview.postMessage({ type: 'templateProgress', msg: 'Extracting template...' });
            await execAsync(extractCmd, { timeout: 60000 });

            vscode.window.showInformationMessage(
                `✅ Template deployed to ${path.basename(destUri.fsPath)}`,
                'Open Folder'
            ).then(s => {
                if (s === 'Open Folder') {
                    vscode.commands.executeCommand('vscode.openFolder', destUri, true);
                }
            });
            this.panel.webview.postMessage({ type: 'deployDone', dest: destUri.fsPath });
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Deploy failed: ${e.message}`);
            this.panel.webview.postMessage({ type: 'error', msg: `[FAIL] Deploy: ${e.message}` });
        }
    }

    dispose() {
        DuplicationPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
    }

    _buildHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enterprise Duplication</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#21262d;--text:#e6edf3;--muted:#7d8590;
 --green:#2ea043;--red:#da3633;--yellow:#d29922;--blue:#1f6feb;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
#header{background:var(--card);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}
#header h1{font-size:17px;font-weight:600;}
.btn{background:var(--blue);color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;}
.btn:hover{opacity:.85;} .btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-green{background:var(--green);} .btn-warn{background:var(--yellow);color:#000;}
.btn-secondary{background:#21262d;color:var(--text);}
.btn-sm{padding:4px 9px;font-size:12px;}
#content{padding:16px 20px;}
.action-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:16px;}
.action-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;cursor:pointer;transition:border-color .2s;}
.action-card:hover{border-color:var(--blue);}
.action-card h3{font-size:14px;font-weight:600;margin-bottom:6px;}
.action-card p{font-size:12px;color:var(--muted);line-height:1.4;}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.tool-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;}
.tool-row:last-child{border-bottom:none;}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;}
.badge-ok{background:rgba(46,160,67,.2);color:#3fb950;}
.badge-miss{background:rgba(218,54,51,.2);color:#f85149;}
.badge-warn{background:rgba(210,153,34,.2);color:#e3b341;}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
.log-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:monospace;font-size:12px;max-height:160px;overflow-y:auto;color:#58a6ff;margin-top:8px;}
.diff-row{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border);}
.diff-row:last-child{border-bottom:none;}
</style>
</head>
<body>
<div id="header">
  <div><h1>📋 Enterprise Duplication</h1><p id="subtitle" style="font-size:12px;color:var(--muted)">Reproduce environments at scale</p></div>
  <button class="btn btn-secondary" onclick="scanLocal()">🔄 Rescan</button>
</div>
<div id="content">
  <div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Scanning environment...</p></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let localProfile = null;

function scanLocal(){ vscode.postMessage({type:'scanLocal'}); showScanning(); }
function showScanning(){ document.getElementById('content').innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Scanning...</p></div>'; }

window.addEventListener('message', e => {
  const m = e.data;
  if(m.type==='scanning')   { showScanning(); return; }
  if(m.type==='localReady') { localProfile=m.profile; renderMain(m.profile); return; }
  if(m.type==='diffResult') { renderDiff(m); return; }
  if(m.type==='templateCreated') { appendLog('Template created: '+m.file+' ('+m.sizeMb+' MB)'); return; }
  if(m.type==='deployDone')      { appendLog('Template deployed to: '+m.dest); return; }
  if(m.type==='exportDone')      { appendLog('Profile exported: '+m.file); return; }
  if(m.type==='templateProgress') { appendLog(m.msg); return; }
  if(m.type==='error')           { appendLog('[FAIL] '+m.msg); return; }
});

function appendLog(msg){
  let lb = document.getElementById('logBox');
  if(!lb) return;
  lb.innerHTML += '<div>'+escHtml(msg)+'</div>';
  lb.scrollTop = lb.scrollHeight;
}

function renderMain(p){
  const installed = (p.tools||[]).filter(t=>t.installed).length;
  const total     = (p.tools||[]).length;
  let html = \`
  <div class="action-grid">
    <div class="action-card" onclick="vscode.postMessage({type:'exportProfile'})">
      <h3>📤 Export Profile</h3>
      <p>Save a JSON snapshot of your full dev environment to share with your team.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'importProfile'})">
      <h3>📥 Import & Compare</h3>
      <p>Load a team profile and see which tools are missing or have version mismatches.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'createTemplate'})">
      <h3>📦 Create Template</h3>
      <p>Package the current workspace into a .zip template for instant team duplication.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'deployTemplate'})">
      <h3>🚀 Deploy Template</h3>
      <p>Extract a .zip template into a new folder and open it as a fresh workspace.</p>
    </div>
  </div>

  <div class="section">
    <h2>🖥️ Local Environment — \${p.machine} (\${p.platform})</h2>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      \${installed}/\${total} tools detected &nbsp;·&nbsp; Project type: <strong>\${p.projectType||'unknown'}</strong>
      &nbsp;·&nbsp; \${p.totalRam}GB RAM &nbsp;·&nbsp; \${p.cpuCores} cores
    </div>\`;
  (p.tools||[]).forEach(t=>{
    html+=\`<div class="tool-row">
      <span class="badge \${t.installed?'badge-ok':'badge-miss'}">\${t.installed?'OK':'MISSING'}</span>
      <span style="flex:1">\${t.name}</span>
      <span style="font-size:12px;color:var(--muted)">\${t.installed?(t.version||'detected'):'not found'}</span>
    </div>\`;
  });
  html+=\`</div>
  <div class="section"><h2>📋 Activity Log</h2><div class="log-box" id="logBox"><div>Ready.</div></div></div>\`;
  document.getElementById('content').innerHTML=html;
}

function renderDiff(m){
  let html=\`<div class="section"><h2>🔍 Profile Diff — \${m.file}</h2>
  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
    Imported from: \${m.imported.machine||'?'} on \${m.imported.platform||'?'} · Created: \${m.imported.createdAt||'?'}
  </div>\`;
  if(m.diffs.length===0){
    html+=\`<p style="color:#3fb950;font-size:13px">✅ Local environment matches imported profile.</p>\`;
  } else {
    m.diffs.forEach(d=>{
      html+=\`<div class="diff-row">
        <span class="badge \${d.severity==='error'?'badge-miss':'badge-warn'}">\${d.severity.toUpperCase()}</span>
        <span style="flex:1">\${d.tool}</span>
        <span style="font-size:12px;color:var(--muted)">local: \${d.local} → required: \${d.required}</span>
      </div>\`;
    });
  }
  html+=\`</div><div class="section"><h2>📋 Activity Log</h2><div class="log-box" id="logBox"><div>Diff complete.</div></div></div>\`;
  document.getElementById('content').innerHTML=html;
}

function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { DuplicationPanel };
