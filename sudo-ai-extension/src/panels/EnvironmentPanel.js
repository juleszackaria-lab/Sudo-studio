/**
 * SUDO STUDIO - Environment Panel (Feature 6: Environnements Reproductibles)
 * Snapshot, export, sync et comparaison d'environnements développeur.
 * Élimine le problème "ça marche chez moi".
 *
 * Fonctionnalités:
 * - Scan local: détecte tous les outils installés et leurs versions
 * - Export: génère un .env-profile.json partageble avec l'équipe
 * - Import: compare un profil importé avec l'environnement actuel
 * - Sync: identifie et affiche les écarts (diffs)
 * - Actions: propose des corrections pour chaque outil manquant/désynchronisé
 */
const vscode = require('vscode');
const axios  = require('axios');
const { exec } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Tools to detect
const TOOL_DEFS = [
    { name: 'Node.js',  cmd: 'node --version',                         installHint: 'https://nodejs.org' },
    { name: 'npm',      cmd: 'npm --version',                          installHint: 'Installed with Node.js' },
    { name: 'Python',   cmd: IS_WIN ? 'python --version 2>&1' : 'python3 --version', installHint: 'https://python.org' },
    { name: 'pip',      cmd: IS_WIN ? 'pip --version' : 'pip3 --version', installHint: 'Installed with Python' },
    { name: 'Git',      cmd: 'git --version',                          installHint: 'https://git-scm.com' },
    { name: 'Docker',   cmd: 'docker --version',                       installHint: 'https://docker.com' },
    { name: 'Flutter',  cmd: 'flutter --version',                      installHint: 'https://flutter.dev' },
    { name: 'Java',     cmd: IS_WIN ? 'java --version 2>&1' : 'java --version 2>&1', installHint: 'https://adoptium.net' },
    { name: 'Rust',     cmd: 'rustc --version',                        installHint: 'https://rustup.rs' },
    { name: 'Go',       cmd: 'go version',                             installHint: 'https://go.dev' },
];

class EnvironmentPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri, authToken) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.authToken = authToken;
        this.disposables = [];
        this.currentSnapshot = null;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Auto-scan on open
        setTimeout(() => this.scanEnvironment(), 300);
    }

    static createOrShow(extensionUri, authToken) {
        if (EnvironmentPanel.currentPanel) {
            EnvironmentPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoEnvironment', '🔄 Reproductible Env',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        EnvironmentPanel.currentPanel = new EnvironmentPanel(panel, extensionUri, authToken);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'scan':         await this.scanEnvironment(); break;
            case 'exportEnv':    await this.exportEnvironment(); break;
            case 'importEnv':    await this.importEnvironment(); break;
            case 'syncCheck':    await this.syncCheck(msg.profile); break;
            case 'fixTool':      await this.fixTool(msg.tool); break;
            case 'openUrl':      vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
            case 'copyToClip':   await vscode.env.clipboard.writeText(msg.text); vscode.window.showInformationMessage('📋 Copié!'); break;
        }
    }

    // ── Local scan (no backend needed) ───────────────────────────────────
    async scanEnvironment() {
        this.panel.webview.postMessage({ type: 'scanning' });

        const tools = await Promise.all(TOOL_DEFS.map(def => this._detectTool(def)));

        const systemInfo = {
            platform: `${os.platform()} ${os.arch()}`,
            hostname: os.hostname(),
            total_ram_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
            free_ram_gb: Math.round(os.freemem() / 1024 / 1024 / 1024),
            cpu_cores: os.cpus().length,
            cpu_model: os.cpus()[0]?.model?.split('@')[0]?.trim() || 'Unknown',
            node_version: process.version
        };

        this.currentSnapshot = {
            scanned_at: new Date().toISOString(),
            system: systemInfo,
            tools
        };

        this.panel.webview.postMessage({
            type: 'scanResult',
            snapshot: this.currentSnapshot
        });
    }

    _detectTool(def) {
        return new Promise(resolve => {
            exec(def.cmd, { timeout: 5000 }, (err, stdout) => {
                if (!err && stdout.trim()) {
                    resolve({
                        name: def.name,
                        installed: true,
                        version: stdout.trim().split('\n')[0].replace(/^v/, ''),
                        installHint: def.installHint
                    });
                } else {
                    resolve({
                        name: def.name,
                        installed: false,
                        version: null,
                        installHint: def.installHint
                    });
                }
            });
        });
    }

    // ── Export ───────────────────────────────────────────────────────────
    async exportEnvironment() {
        if (!this.currentSnapshot) {
            await this.scanEnvironment();
        }

        const profile = {
            export_version: '1.0',
            exported_at: new Date().toISOString(),
            sudo_studio_version: '3.0',
            system: this.currentSnapshot.system,
            tools: this.currentSnapshot.tools
        };

        const profileJson = JSON.stringify(profile, null, 2);

        // Save to workspace or home
        const saveTargets = [];
        if (vscode.workspace.workspaceFolders?.length) {
            saveTargets.push(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.env-profile.json'));
        }
        saveTargets.push(path.join(os.homedir(), '.sudo-studio-env-profile.json'));

        const choice = await vscode.window.showQuickPick(
            saveTargets.map(p => ({ label: path.basename(p), description: path.dirname(p), path: p })),
            { placeHolder: 'Choisir où sauvegarder le profil d\'environnement' }
        );

        if (!choice) return;

        try {
            fs.writeFileSync(choice.path, profileJson, 'utf8');
            vscode.window.showInformationMessage(
                `✅ Profil exporté: ${choice.path}`,
                'Ouvrir', 'Copier le contenu'
            ).then(sel => {
                if (sel === 'Ouvrir') {
                    vscode.workspace.openTextDocument(choice.path).then(d => vscode.window.showTextDocument(d));
                } else if (sel === 'Copier le contenu') {
                    vscode.env.clipboard.writeText(profileJson);
                    vscode.window.showInformationMessage('📋 Profil copié dans le presse-papiers!');
                }
            });

            this.panel.webview.postMessage({ type: 'exportDone', path: choice.path, content: profileJson });
        } catch (e) {
            vscode.window.showErrorMessage(`Export failed: ${e.message}`);
        }
    }

    // ── Import ───────────────────────────────────────────────────────────
    async importEnvironment() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Environment Profile': ['json'] },
            openLabel: 'Importer le profil .env-profile.json'
        });

        if (!uris || !uris.length) return;

        try {
            const content = fs.readFileSync(uris[0].fsPath, 'utf8');
            const profile = JSON.parse(content);

            if (!profile.tools) {
                vscode.window.showErrorMessage('Fichier invalide — pas de champ "tools"');
                return;
            }

            this.panel.webview.postMessage({ type: 'profileImported', profile });
            vscode.window.showInformationMessage(`✅ Profil importé: ${path.basename(uris[0].fsPath)}`);

            // Auto-sync check
            await this.syncCheck(profile);
        } catch (e) {
            vscode.window.showErrorMessage(`Import failed: ${e.message}`);
        }
    }

    // ── Sync / diff check ────────────────────────────────────────────────
    async syncCheck(profile) {
        if (!this.currentSnapshot) await this.scanEnvironment();

        const diffs = [];
        for (const targetTool of (profile.tools || [])) {
            const currentTool = this.currentSnapshot.tools.find(t => t.name === targetTool.name);

            if (!currentTool || !currentTool.installed) {
                diffs.push({
                    tool: targetTool.name,
                    issue: 'not_installed',
                    target_version: targetTool.version,
                    current_version: null,
                    severity: 'error',
                    installHint: targetTool.installHint || '#'
                });
            } else if (targetTool.version && currentTool.version) {
                const targetMaj = targetTool.version.split('.')[0];
                const currentMaj = currentTool.version.split('.')[0];
                if (targetMaj !== currentMaj) {
                    diffs.push({
                        tool: targetTool.name,
                        issue: 'version_mismatch',
                        target_version: targetTool.version,
                        current_version: currentTool.version,
                        severity: 'warning',
                        installHint: targetTool.installHint || '#'
                    });
                }
            }
        }

        // System diffs
        const systemDiffs = [];
        if (profile.system) {
            if (profile.system.total_ram_gb > this.currentSnapshot.system.total_ram_gb) {
                systemDiffs.push({
                    item: 'RAM',
                    profile_value: `${profile.system.total_ram_gb} GB`,
                    current_value: `${this.currentSnapshot.system.total_ram_gb} GB`,
                    note: 'Cette machine a moins de RAM que le profil de référence'
                });
            }
        }

        this.panel.webview.postMessage({
            type: 'syncResult',
            diffs,
            systemDiffs,
            synced: diffs.length === 0 && systemDiffs.length === 0,
            profile
        });
    }

    // ── Fix individual tool ───────────────────────────────────────────────
    async fixTool(toolName) {
        const installCmds = {
            'Node.js':  IS_WIN ? 'winget install OpenJS.NodeJS.LTS' : IS_MAC ? 'brew install node' : 'sudo apt-get install -y nodejs npm',
            'Python':   IS_WIN ? 'winget install Python.Python.3.11' : IS_MAC ? 'brew install python@3.11' : 'sudo apt-get install -y python3 python3-pip',
            'Git':      IS_WIN ? 'winget install Git.Git' : IS_MAC ? 'brew install git' : 'sudo apt-get install -y git',
            'Docker':   IS_WIN ? 'start https://www.docker.com/products/docker-desktop' : IS_MAC ? 'brew install --cask docker' : 'curl -fsSL https://get.docker.com | sh',
            'Flutter':  IS_WIN ? 'winget install Google.Flutter' : IS_MAC ? 'brew install --cask flutter' : 'sudo snap install flutter --classic',
            'Java':     IS_WIN ? 'winget install Microsoft.OpenJDK.21' : IS_MAC ? 'brew install openjdk@21' : 'sudo apt-get install -y openjdk-21-jdk',
            'Rust':     IS_WIN ? 'winget install Rustlang.Rustup' : 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
            'Go':       IS_WIN ? 'winget install GoLang.Go' : IS_MAC ? 'brew install go' : 'sudo apt-get install -y golang-go',
        };

        const cmd = installCmds[toolName];
        if (!cmd) {
            vscode.window.showInformationMessage(`Installation manuelle requise pour: ${toolName}`);
            return;
        }

        const terminal = vscode.window.createTerminal(`Install ${toolName}`);
        terminal.show();
        terminal.sendText(cmd);

        vscode.window.showInformationMessage(
            `⚡ Installation de ${toolName} lancée dans le terminal.`
        );

        this.panel.webview.postMessage({ type: 'fixStarted', tool: toolName });

        // Re-scan after 20s
        setTimeout(() => this.scanEnvironment(), 20000);
    }

    dispose() {
        EnvironmentPanel.currentPanel = undefined;
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
<title>Environnements Reproductibles</title>
<style>
/* ─── SUDO STUDIO DARK THEME ─────────────────────────────────── */
:root {
    --ss-bg: #0d1117; --ss-card-bg: #161b22; --ss-border: #21262d;
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
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);min-height:100vh}
#header{background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
#header h1{font-size:17px;font-weight:600}
#header p{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:opacity .2s;white-space:nowrap}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sm{padding:5px 10px;font-size:11px}
.btn-warn{background:#f57c00;color:#fff}
.btn-success{background:#388e3c;color:#fff}
.action-bar{padding:12px 18px;display:flex;gap:8px;flex-wrap:wrap;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-panel-border)}
#content{padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:10px;padding:14px 16px}
.card-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.system-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.sys-item{background:var(--vscode-editorWidget-background);border-radius:7px;padding:9px 12px}
.sys-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:2px}
.sys-value{font-size:14px;font-weight:600}
.tool-row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:7px;margin-bottom:6px;background:var(--vscode-editorWidget-background)}
.tool-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.tool-name{font-size:13px;font-weight:500}
.tool-version{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:1px}
.tool-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge-ok{background:rgba(76,175,80,.2);color:#4caf50}
.badge-miss{background:rgba(244,67,54,.2);color:#f44336}
.badge-warn{background:rgba(255,152,0,.2);color:#ff9800}
.diff-item{padding:9px 12px;border-radius:7px;margin-bottom:6px;font-size:12px;display:flex;align-items:flex-start;gap:8px}
.diff-error{background:rgba(244,67,54,.08);border-left:3px solid #f44336}
.diff-warning{background:rgba(255,152,0,.08);border-left:3px solid #ff9800}
.diff-content{flex:1}
.diff-title{font-weight:600;margin-bottom:2px}
.diff-detail{font-size:11px;color:var(--vscode-descriptionForeground)}
.synced-banner{background:rgba(76,175,80,.1);border:1px solid rgba(76,175,80,.3);border-radius:8px;padding:12px 16px;text-align:center;color:#4caf50;font-weight:600;font-size:14px}
.spinner{width:16px;height:16px;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-button-background);border-radius:50%;animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
#statusBar{padding:6px 18px;font-size:11px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:6px}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
</style>
</head>
<body>
<div id="header">
    <div>
        <h1>🔄 Environnements Reproductibles</h1>
        <p>Snapshot · Export · Sync · Éliminez "ça marche chez moi"</p>
    </div>
</div>

<div class="action-bar">
    <button class="btn btn-success" onclick="scan()" id="scanBtn">🔍 Scanner l'environnement</button>
    <button class="btn" onclick="exportEnv()" id="exportBtn" disabled>📤 Exporter le profil</button>
    <button class="btn btn-sec" onclick="importEnv()">📥 Importer & Comparer</button>
</div>

<div id="statusBar">
    <span id="statusIcon">⏳</span>
    <span id="statusTxt">Cliquez sur "Scanner" pour démarrer l'analyse...</span>
</div>

<div id="content">
    <!-- System Info -->
    <div class="card" id="systemCard" style="display:none">
        <div class="card-title">💻 Système
            <span id="healthBadge" class="badge">—</span>
        </div>
        <div class="system-grid" id="systemGrid"></div>
    </div>

    <!-- Tools -->
    <div class="card" id="toolsCard" style="display:none">
        <div class="card-title">🛠️ Outils Détectés
            <span id="toolsCount" style="font-size:11px;font-weight:400">0/0 installés</span>
        </div>
        <div id="toolsList"></div>
    </div>

    <!-- Sync Results -->
    <div class="card" id="syncCard" style="display:none">
        <div class="card-title">⚖️ Résultat de Comparaison</div>
        <div id="syncResults"></div>
    </div>

    <!-- Empty state -->
    <div id="emptyState" style="text-align:center;padding:40px;color:var(--vscode-descriptionForeground)">
        <div style="font-size:40px;margin-bottom:12px">🔄</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">Environnements Reproductibles</div>
        <div style="font-size:12px;line-height:1.6;max-width:340px;margin:0 auto">
            Scannez votre environnement pour créer un profil partageable avec votre équipe.
            Importez un profil de référence pour détecter les écarts et synchroniser les outils.
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();

function scan()      { vscode.postMessage({ type: 'scan' }); }
function exportEnv() { vscode.postMessage({ type: 'exportEnv' }); }
function importEnv() { vscode.postMessage({ type: 'importEnv' }); }
function fixTool(t)  { vscode.postMessage({ type: 'fixTool', tool: t }); }
function openUrl(u)  { vscode.postMessage({ type: 'openUrl', url: u }); }

function setStatus(icon, txt) {
    document.getElementById('statusIcon').textContent = icon;
    document.getElementById('statusTxt').textContent = txt;
}

window.addEventListener('message', ev => {
    const msg = ev.data;
    switch (msg.type) {
        case 'scanning':
            setStatus('🔍', 'Scan de l\\'environnement en cours...');
            document.getElementById('scanBtn').disabled = true;
            document.getElementById('scanBtn').textContent = '⟳ Scanning...';
            break;

        case 'scanResult':
            renderSnapshot(msg.snapshot);
            document.getElementById('scanBtn').disabled = false;
            document.getElementById('scanBtn').textContent = '🔍 Scanner l\\'environnement';
            document.getElementById('exportBtn').disabled = false;
            break;

        case 'syncResult':
            renderSyncResult(msg.diffs, msg.systemDiffs, msg.synced, msg.profile);
            break;

        case 'exportDone':
            setStatus('✅', 'Profil exporté: ' + msg.path);
            break;

        case 'profileImported':
            setStatus('📥', 'Profil importé — comparaison en cours...');
            break;

        case 'fixStarted':
            setStatus('⚡', 'Installation de ' + msg.tool + ' lancée dans le terminal...');
            break;
    }
});

function renderSnapshot(snap) {
    document.getElementById('emptyState').style.display = 'none';

    const sys = snap.system;
    const tools = snap.tools;
    const installed = tools.filter(t => t.installed).length;
    const health = Math.round((installed / tools.length) * 100);

    // Status bar
    setStatus(health >= 80 ? '✅' : health >= 50 ? '⚠️' : '❌',
        installed + '/' + tools.length + ' outils installés · Score: ' + health + '/100');

    // System card
    document.getElementById('systemCard').style.display = 'block';
    const hBadge = document.getElementById('healthBadge');
    hBadge.textContent = health + '/100';
    hBadge.className = 'badge ' + (health >= 80 ? 'badge-ok' : health >= 50 ? 'badge-warn' : 'badge-miss');

    document.getElementById('systemGrid').innerHTML = [
        ['🖥️ Plateforme', sys.platform],
        ['💾 RAM Totale', sys.total_ram_gb + ' GB'],
        ['💾 RAM Libre', sys.free_ram_gb + ' GB'],
        ['⚙️ CPU', sys.cpu_cores + ' cœurs'],
        ['🟢 Node.js', sys.node_version],
        ['🕐 Scanné à', new Date(snap.scanned_at).toLocaleTimeString()]
    ].map(([label, value]) => \`
        <div class="sys-item">
            <div class="sys-label">\${label}</div>
            <div class="sys-value" style="font-size:12px">\${value || '—'}</div>
        </div>
    \`).join('');

    // Tools card
    document.getElementById('toolsCard').style.display = 'block';
    document.getElementById('toolsCount').textContent = installed + '/' + tools.length + ' installés';

    document.getElementById('toolsList').innerHTML = tools.map(t => \`
        <div class="tool-row">
            <div class="tool-left">
                <span style="font-size:16px">\${t.installed ? '✅' : '❌'}</span>
                <div>
                    <div class="tool-name">\${t.name}</div>
                    <div class="tool-version">\${t.installed ? t.version : 'Non installé'}</div>
                </div>
            </div>
            <div class="tool-right">
                <span class="badge \${t.installed ? 'badge-ok' : 'badge-miss'}">\${t.installed ? '✓ OK' : '✗ Manquant'}</span>
                \${!t.installed ? \`<button class="btn btn-sm btn-warn" onclick="fixTool('\${t.name}')">🔧 Installer</button>\` : ''}
            </div>
        </div>
    \`).join('');
}

function renderSyncResult(diffs, systemDiffs, synced, profile) {
    const card = document.getElementById('syncCard');
    card.style.display = 'block';
    card.scrollIntoView({ behavior: 'smooth' });

    const container = document.getElementById('syncResults');

    if (synced) {
        container.innerHTML = \`<div class="synced-banner">✅ Environnement synchronisé — Aucun écart détecté!</div>\`;
        setStatus('✅', 'Synchronisé avec le profil de référence');
        return;
    }

    setStatus('⚠️', diffs.length + ' écart(s) détecté(s) — actions requises');

    let html = '';

    if (systemDiffs.length) {
        html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin-bottom:8px">⚙️ Système</div>';
        html += systemDiffs.map(d => \`
            <div class="diff-item diff-warning">
                <span>⚠️</span>
                <div class="diff-content">
                    <div class="diff-title">\${d.item}</div>
                    <div class="diff-detail">Profil: \${d.profile_value} · Actuel: \${d.current_value} · \${d.note}</div>
                </div>
            </div>
        \`).join('');
    }

    if (diffs.length) {
        html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:10px 0 8px">🛠️ Outils</div>';
        html += diffs.map(d => \`
            <div class="diff-item \${d.severity === 'error' ? 'diff-error' : 'diff-warning'}">
                <span>\${d.severity === 'error' ? '❌' : '⚠️'}</span>
                <div class="diff-content">
                    <div class="diff-title">\${d.tool} — \${d.issue === 'not_installed' ? 'Non installé' : 'Version différente'}</div>
                    <div class="diff-detail">
                        Requis: v\${d.target_version || '?'} · Actuel: \${d.current_version || 'absent'}
                    </div>
                </div>
                <button class="btn btn-sm btn-warn" onclick="fixTool('\${d.tool}')">🔧 Fix</button>
            </div>
        \`).join('');
    }

    container.innerHTML = html;
}
</script>
</body>
</html>`;
    }
}

module.exports = { EnvironmentPanel };
