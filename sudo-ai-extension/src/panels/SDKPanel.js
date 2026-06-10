/**
 * SUDO STUDIO - SDK Manager Panel
 * Real Install/Repair/Uninstall buttons with terminal integration.
 * Detects installed tools via exec(), shows real versions.
 * No backend required - works standalone.
 */
const vscode = require('vscode');
const { exec } = require('child_process');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// SDK definitions: name, detection command, install commands
const SDK_DEFS = [
    {
        id: 'nodejs',
        name: 'Node.js',
        icon: '🟢',
        description: 'JavaScript runtime for backend and tooling. Required for the extension.',
        detectCmd: 'node --version',
        installCmd: IS_WIN
            ? 'winget install OpenJS.NodeJS.LTS'
            : IS_MAC
                ? 'brew install node'
                : 'sudo apt-get install -y nodejs npm',
        repairCmd: IS_WIN
            ? 'winget reinstall OpenJS.NodeJS.LTS'
            : IS_MAC
                ? 'brew reinstall node'
                : 'sudo apt-get install --reinstall -y nodejs npm',
        uninstallCmd: IS_WIN
            ? 'winget uninstall OpenJS.NodeJS.LTS'
            : IS_MAC
                ? 'brew uninstall node'
                : 'sudo apt-get remove -y nodejs npm',
        url: 'https://nodejs.org'
    },
    {
        id: 'python',
        name: 'Python',
        icon: '🐍',
        description: 'Required for the AI runtime (TinyLlama model inference).',
        detectCmd: IS_WIN ? 'python --version' : 'python3 --version',
        installCmd: IS_WIN
            ? 'winget install Python.Python.3.11'
            : IS_MAC
                ? 'brew install python@3.11'
                : 'sudo apt-get install -y python3 python3-pip',
        repairCmd: IS_WIN
            ? 'winget reinstall Python.Python.3.11'
            : IS_MAC
                ? 'brew reinstall python@3.11'
                : 'sudo apt-get install --reinstall -y python3 python3-pip',
        uninstallCmd: IS_WIN
            ? 'winget uninstall Python.Python.3.11'
            : IS_MAC
                ? 'brew uninstall python@3.11'
                : 'sudo apt-get remove -y python3 python3-pip',
        url: 'https://python.org'
    },
    {
        id: 'git',
        name: 'Git',
        icon: '📚',
        description: 'Version control system. Used for project management.',
        detectCmd: 'git --version',
        installCmd: IS_WIN
            ? 'winget install Git.Git'
            : IS_MAC
                ? 'brew install git'
                : 'sudo apt-get install -y git',
        repairCmd: IS_WIN
            ? 'winget reinstall Git.Git'
            : IS_MAC
                ? 'brew reinstall git'
                : 'sudo apt-get install --reinstall -y git',
        uninstallCmd: IS_WIN
            ? 'winget uninstall Git.Git'
            : IS_MAC
                ? 'brew uninstall git'
                : 'sudo apt-get remove -y git',
        url: 'https://git-scm.com'
    },
    {
        id: 'docker',
        name: 'Docker',
        icon: '🐳',
        description: 'Container platform for building and running applications.',
        detectCmd: 'docker --version',
        installCmd: IS_WIN
            ? 'start https://www.docker.com/products/docker-desktop'
            : IS_MAC
                ? 'brew install --cask docker'
                : 'curl -fsSL https://get.docker.com | sh',
        repairCmd: IS_WIN
            ? 'start https://www.docker.com/products/docker-desktop'
            : IS_MAC
                ? 'brew reinstall --cask docker'
                : 'sudo systemctl restart docker',
        uninstallCmd: IS_WIN
            ? 'winget uninstall Docker.DockerDesktop'
            : IS_MAC
                ? 'brew uninstall --cask docker'
                : 'sudo apt-get remove -y docker-ce docker-ce-cli',
        url: 'https://www.docker.com/products/docker-desktop'
    },
    {
        id: 'flutter',
        name: 'Flutter',
        icon: '🎨',
        description: 'Cross-platform UI framework for mobile, web and desktop apps.',
        detectCmd: 'flutter --version',
        installCmd: IS_WIN
            ? 'winget install Google.Flutter'
            : IS_MAC
                ? 'brew install --cask flutter'
                : 'sudo snap install flutter --classic',
        repairCmd: IS_WIN
            ? 'winget reinstall Google.Flutter'
            : IS_MAC
                ? 'brew reinstall --cask flutter'
                : 'sudo snap refresh flutter',
        uninstallCmd: IS_WIN
            ? 'winget uninstall Google.Flutter'
            : IS_MAC
                ? 'brew uninstall --cask flutter'
                : 'sudo snap remove flutter',
        url: 'https://flutter.dev'
    },
    {
        id: 'java',
        name: 'Java (JDK)',
        icon: '☕',
        description: 'Java Development Kit for building Java/Kotlin/Android apps.',
        detectCmd: 'java --version',
        installCmd: IS_WIN
            ? 'winget install Microsoft.OpenJDK.21'
            : IS_MAC
                ? 'brew install openjdk@21'
                : 'sudo apt-get install -y openjdk-21-jdk',
        repairCmd: IS_WIN
            ? 'winget reinstall Microsoft.OpenJDK.21'
            : IS_MAC
                ? 'brew reinstall openjdk@21'
                : 'sudo apt-get install --reinstall -y openjdk-21-jdk',
        uninstallCmd: IS_WIN
            ? 'winget uninstall Microsoft.OpenJDK.21'
            : IS_MAC
                ? 'brew uninstall openjdk@21'
                : 'sudo apt-get remove -y openjdk-21-jdk',
        url: 'https://adoptium.net'
    },
    {
        id: 'rust',
        name: 'Rust',
        icon: '🦀',
        description: 'Systems programming language focused on safety and performance.',
        detectCmd: 'rustc --version',
        installCmd: IS_WIN
            ? 'winget install Rustlang.Rustup'
            : 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
        repairCmd: IS_WIN
            ? 'rustup update'
            : 'rustup update',
        uninstallCmd: 'rustup self uninstall',
        url: 'https://rustup.rs'
    },
    {
        id: 'go',
        name: 'Go',
        icon: '🔵',
        description: 'Fast, statically typed language from Google. Great for microservices.',
        detectCmd: 'go version',
        installCmd: IS_WIN
            ? 'winget install GoLang.Go'
            : IS_MAC
                ? 'brew install go'
                : 'sudo apt-get install -y golang-go',
        repairCmd: IS_WIN
            ? 'winget reinstall GoLang.Go'
            : IS_MAC
                ? 'brew reinstall go'
                : 'sudo apt-get install --reinstall -y golang-go',
        uninstallCmd: IS_WIN
            ? 'winget uninstall GoLang.Go'
            : IS_MAC
                ? 'brew uninstall go'
                : 'sudo apt-get remove -y golang-go',
        url: 'https://go.dev'
    },
    {
        id: 'pip',
        name: 'pip (Python packages)',
        icon: '📦',
        description: 'Python package installer. Used to install AI/ML dependencies.',
        detectCmd: IS_WIN ? 'pip --version' : 'pip3 --version',
        installCmd: IS_WIN
            ? 'python -m ensurepip --upgrade'
            : 'python3 -m ensurepip --upgrade',
        repairCmd: IS_WIN
            ? 'python -m pip install --upgrade pip'
            : 'python3 -m pip install --upgrade pip',
        uninstallCmd: 'echo "pip is part of Python - uninstall Python instead"',
        url: 'https://pip.pypa.io'
    },
    {
        id: 'transformers',
        name: 'AI Libraries (transformers + torch)',
        icon: '🧠',
        description: 'HuggingFace transformers + PyTorch. Required for local AI inference.',
        detectCmd: IS_WIN
            ? 'python -c "import transformers; print(transformers.__version__)"'
            : 'python3 -c "import transformers; print(transformers.__version__)"',
        installCmd: IS_WIN
            ? 'pip install transformers torch --index-url https://download.pytorch.org/whl/cpu'
            : 'pip3 install transformers torch --index-url https://download.pytorch.org/whl/cpu',
        repairCmd: IS_WIN
            ? 'pip install --upgrade transformers torch'
            : 'pip3 install --upgrade transformers torch',
        uninstallCmd: IS_WIN
            ? 'pip uninstall -y transformers torch'
            : 'pip3 uninstall -y transformers torch',
        url: 'https://huggingface.co/docs/transformers'
    }
];

class SDKPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.sdkStatus = {}; // id -> { installed, version }

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables
        );

        // Auto-detect on open
        setTimeout(() => this.detectAll(), 300);
    }

    static createOrShow(extensionUri) {
        if (SDKPanel.currentPanel) {
            SDKPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioSDK',
            '📦 SDK Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        SDKPanel.currentPanel = new SDKPanel(panel, extensionUri);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'refresh':    await this.detectAll(); break;
            case 'install':    await this.runAction(msg.sdkId, 'install'); break;
            case 'repair':     await this.runAction(msg.sdkId, 'repair'); break;
            case 'uninstall':  await this.runAction(msg.sdkId, 'uninstall'); break;
            case 'openUrl':    vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
        }
    }

    // Detect a single SDK
    detectSDK(sdk) {
        return new Promise(resolve => {
            exec(sdk.detectCmd, { timeout: 5000 }, (err, stdout) => {
                if (!err && stdout.trim()) {
                    const version = stdout.trim().split('\n')[0].replace(/^v/, '');
                    resolve({ id: sdk.id, installed: true, version });
                } else {
                    resolve({ id: sdk.id, installed: false, version: null });
                }
            });
        });
    }

    // Detect all SDKs in parallel
    async detectAll() {
        this.panel.webview.postMessage({ type: 'detecting' });
        const results = await Promise.all(SDK_DEFS.map(s => this.detectSDK(s)));
        results.forEach(r => { this.sdkStatus[r.id] = r; });

        // Send full SDK list with status
        const sdks = SDK_DEFS.map(def => ({
            ...def,
            installed: this.sdkStatus[def.id]?.installed || false,
            version: this.sdkStatus[def.id]?.version || null
        }));
        this.panel.webview.postMessage({ type: 'sdksLoaded', sdks });
    }

    // Run install/repair/uninstall via terminal
    async runAction(sdkId, action) {
        const sdk = SDK_DEFS.find(s => s.id === sdkId);
        if (!sdk) return;

        let cmd;
        if (action === 'install')   cmd = sdk.installCmd;
        if (action === 'repair')    cmd = sdk.repairCmd;
        if (action === 'uninstall') cmd = sdk.uninstallCmd;

        if (!cmd) return;

        // Confirm uninstall
        if (action === 'uninstall') {
            const ok = await vscode.window.showWarningMessage(
                `Uninstall ${sdk.name}?`,
                { modal: true },
                'Yes, Uninstall'
            );
            if (ok !== 'Yes, Uninstall') return;
        }

        this.panel.webview.postMessage({ type: 'actionStarted', sdkId, action });

        // Open terminal and run command
        const terminal = vscode.window.createTerminal(`${action} ${sdk.name}`);
        terminal.show();
        terminal.sendText(cmd);

        vscode.window.showInformationMessage(
            `⚡ Running: ${action} ${sdk.name}. Check the terminal for progress.`,
            'Re-detect After'
        ).then(sel => {
            if (sel === 'Re-detect After') this.detectAll();
        });

        // Auto re-detect after 15s
        setTimeout(() => this.detectAll(), 15000);
    }

    dispose() {
        SDKPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SDK Manager</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    padding: 0;
    min-height: 100vh;
}
#header {
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 16px 20px;
    display: flex; align-items: center; justify-content: space-between;
}
#header h1 { font-size: 18px; font-weight: 600; }
#header p { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.top-actions { display: flex; gap: 8px; }
.btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 8px 16px; border-radius: 6px;
    cursor: pointer; font-size: 13px; font-weight: 500;
    transition: opacity 0.2s; white-space: nowrap;
}
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
.btn-success { background: #388e3c; color: #fff; }
.btn-warn    { background: #f57c00; color: #fff; }
.btn-danger  { background: #c62828; color: #fff; }
.btn-sm { padding: 5px 10px; font-size: 12px; }

#statusBar {
    padding: 8px 20px; font-size: 12px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; align-items: center; gap: 8px;
}
#detectionSpinner { display: none; }
#detectionSpinner.show { display: inline-block; }

.spinner-inline {
    width: 14px; height: 14px; border: 2px solid var(--vscode-panel-border);
    border-top-color: var(--vscode-button-background);
    border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

#content { padding: 16px 20px; }

.section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
    margin: 16px 0 10px;
}

.sdk-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
}

.sdk-card {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px; padding: 14px;
    transition: border-color 0.2s, box-shadow 0.2s;
}
.sdk-card:hover {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
.sdk-card.installed { border-left: 3px solid #4caf50; }
.sdk-card.not-installed { border-left: 3px solid #888; }

.sdk-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.sdk-icon { font-size: 26px; flex-shrink: 0; }
.sdk-info { flex: 1; min-width: 0; }
.sdk-name { font-size: 14px; font-weight: 600; }
.sdk-version {
    font-size: 11px; margin-top: 1px;
    color: var(--vscode-descriptionForeground);
}
.sdk-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    font-weight: 600; white-space: nowrap; flex-shrink: 0;
}
.badge-ok   { background: rgba(76,175,80,0.2);  color: #4caf50; }
.badge-miss { background: rgba(158,158,158,0.2); color: #9e9e9e; }

.sdk-desc {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    line-height: 1.4; margin-bottom: 12px;
}

.sdk-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.action-row { display: flex; align-items: center; gap: 6px; width: 100%; }

.progress-bar-wrap {
    width: 100%; height: 4px;
    background: var(--vscode-panel-border);
    border-radius: 2px; margin-top: 8px; display: none;
    overflow: hidden;
}
.progress-bar-wrap.show { display: block; }
.progress-fill {
    height: 100%; width: 0%;
    background: var(--vscode-button-background);
    animation: progress-anim 2s ease-in-out infinite;
}
@keyframes progress-anim {
    0%   { width: 5%;   margin-left: 0; }
    50%  { width: 50%;  margin-left: 30%; }
    100% { width: 5%;   margin-left: 90%; }
}

.install-all-bar {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px; padding: 14px 16px;
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; gap: 12px; flex-wrap: wrap;
}
.install-all-bar p { font-size: 13px; flex: 1; }
.install-all-bar .count {
    font-weight: 700; color: var(--vscode-button-background);
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
</style>
</head>
<body>
<div id="header">
    <div>
        <h1>📦 SDK Manager</h1>
        <p>Install and manage development tools</p>
    </div>
    <div class="top-actions">
        <button class="btn btn-secondary" onclick="refresh()" id="refreshBtn">🔄 Refresh</button>
        <button class="btn btn-success" onclick="installMissing()" id="installAllBtn" style="display:none">⬇ Install Missing</button>
    </div>
</div>

<div id="statusBar">
    <div id="detectionSpinner"><div class="spinner-inline"></div></div>
    <span id="statusText">Detecting installed SDKs...</span>
</div>

<div id="content">
    <div id="sdkGrid" class="sdk-grid">
        <!-- Cards injected by JS -->
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let sdks = [];

function refresh() {
    document.getElementById('refreshBtn').disabled = true;
    vscode.postMessage({ type: 'refresh' });
}

function installMissing() {
    const missing = sdks.filter(s => !s.installed);
    if (!missing.length) return;
    missing.forEach(s => vscode.postMessage({ type: 'install', sdkId: s.id }));
}

function installSDK(id)   { vscode.postMessage({ type: 'install',   sdkId: id }); }
function repairSDK(id)    { vscode.postMessage({ type: 'repair',    sdkId: id }); }
function uninstallSDK(id) { vscode.postMessage({ type: 'uninstall', sdkId: id }); }
function openUrl(url)     { vscode.postMessage({ type: 'openUrl',   url }); }

function renderSDKs(data) {
    sdks = data;
    const grid = document.getElementById('sdkGrid');
    grid.innerHTML = '';
    
    const missing = data.filter(s => !s.installed);
    const installAllBtn = document.getElementById('installAllBtn');
    installAllBtn.style.display = missing.length > 0 ? 'block' : 'none';
    installAllBtn.textContent = '⬇ Install Missing (' + missing.length + ')';

    data.forEach(sdk => {
        const card = document.createElement('div');
        card.className = 'sdk-card ' + (sdk.installed ? 'installed' : 'not-installed');
        card.id = 'card-' + sdk.id;

        const versionText = sdk.installed
            ? (sdk.version || '✓ Installed')
            : 'Not installed';

        const actionsHtml = sdk.installed ? \`
            <div class="action-row">
                <button class="btn btn-secondary btn-sm" onclick="repairSDK('\${sdk.id}')">🔧 Repair</button>
                <button class="btn btn-danger btn-sm" onclick="uninstallSDK('\${sdk.id}')">🗑 Remove</button>
                <button class="btn btn-secondary btn-sm" onclick="openUrl('\${sdk.url || '#'}')">🌐 Docs</button>
            </div>
        \` : \`
            <div class="action-row">
                <button class="btn btn-success btn-sm" style="flex:1" onclick="installSDK('\${sdk.id}')">📥 Install Now</button>
                <button class="btn btn-secondary btn-sm" onclick="openUrl('\${sdk.url || '#'}')">🌐 Docs</button>
            </div>
        \`;

        card.innerHTML = \`
            <div class="sdk-top">
                <div class="sdk-icon">\${sdk.icon || '📦'}</div>
                <div class="sdk-info">
                    <div class="sdk-name">\${sdk.name}</div>
                    <div class="sdk-version">\${versionText}</div>
                </div>
                <span class="sdk-badge \${sdk.installed ? 'badge-ok' : 'badge-miss'}">
                    \${sdk.installed ? '✓ OK' : '✗ Missing'}
                </span>
            </div>
            <div class="sdk-desc">\${sdk.description || ''}</div>
            <div class="sdk-actions">
                \${actionsHtml}
            </div>
            <div class="progress-bar-wrap" id="progress-\${sdk.id}">
                <div class="progress-fill"></div>
            </div>
        \`;
        grid.appendChild(card);
    });

    // Stats
    const ok = data.filter(s => s.installed).length;
    document.getElementById('statusText').textContent =
        ok + '/' + data.length + ' SDKs installed · Last check: ' + new Date().toLocaleTimeString();
    document.getElementById('refreshBtn').disabled = false;
    document.getElementById('detectionSpinner').classList.remove('show');
}

window.addEventListener('message', ev => {
    const msg = ev.data;
    switch (msg.type) {
        case 'detecting':
            document.getElementById('detectionSpinner').classList.add('show');
            document.getElementById('statusText').textContent = 'Detecting...';
            document.getElementById('refreshBtn').disabled = true;
            break;
        case 'sdksLoaded':
            renderSDKs(msg.sdks);
            break;
        case 'actionStarted':
            const bar = document.getElementById('progress-' + msg.sdkId);
            if (bar) bar.classList.add('show');
            break;
    }
});
</script>
</body>
</html>`;
    }
}

module.exports = { SDKPanel };
