const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class SDKPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.backend = getBackendService();
        this.state = getStateManager();
        this.disposables = [];

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );

        // Load SDKs on init
        this.refreshSDKs();
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
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SDKPanel.currentPanel = new SDKPanel(panel, extensionUri);
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'refresh':
                await this.refreshSDKs();
                break;
            case 'install':
                await this.installSDK(message.sdk);
                break;
            case 'uninstall':
                await this.uninstallSDK(message.sdk);
                break;
            case 'repair':
                await this.repairSDK(message.sdk);
                break;
        }
    }

    async refreshSDKs() {
        try {
            this.panel.webview.postMessage({ type: 'loading', show: true });
            
            const result = await this.backend.listSDKs();
            const sdks = result.sdks || [];

            this.panel.webview.postMessage({
                type: 'sdksLoaded',
                sdks: sdks
            });

            this.state.updateSystemState({ sdks });

        } catch (error) {
            // Show default SDKs
            const defaultSDKs = [
                { name: 'Node.js', installed: false, version: 'Latest LTS', description: 'JavaScript runtime environment' },
                { name: 'Python', installed: false, version: '3.11+', description: 'Python interpreter' },
                { name: 'Flutter', installed: false, version: 'Latest', description: 'Cross-platform UI framework' },
                { name: 'Java', installed: false, version: 'JDK 17+', description: 'Java Development Kit' },
                { name: 'Docker', installed: false, version: 'Latest', description: 'Container platform' },
                { name: 'Git', installed: false, version: 'Latest', description: 'Version control system' },
                { name: 'Rust', installed: false, version: 'Latest', description: 'Systems programming language' },
                { name: 'Go', installed: false, version: 'Latest', description: 'Go programming language' }
            ];

            this.panel.webview.postMessage({
                type: 'sdksLoaded',
                sdks: defaultSDKs
            });
        } finally {
            this.panel.webview.postMessage({ type: 'loading', show: false });
        }
    }

    async installSDK(sdkName) {
        try {
            this.panel.webview.postMessage({
                type: 'installProgress',
                sdk: sdkName,
                status: 'downloading',
                progress: 0
            });

            const result = await this.backend.installSDK(sdkName);

            if (result.success) {
                this.panel.webview.postMessage({
                    type: 'installComplete',
                    sdk: sdkName,
                    success: true
                });
                vscode.window.showInformationMessage(`${sdkName} installed successfully!`);
                await this.refreshSDKs();
            } else {
                throw new Error(result.message || 'Installation failed');
            }

        } catch (error) {
            this.panel.webview.postMessage({
                type: 'installComplete',
                sdk: sdkName,
                success: false,
                error: error.message
            });
            vscode.window.showErrorMessage(`Failed to install ${sdkName}: ${error.message}`);
        }
    }

    async uninstallSDK(sdkName) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to uninstall ${sdkName}?`,
            'Yes', 'No'
        );

        if (confirm !== 'Yes') return;

        try {
            const result = await this.backend.uninstallSDK(sdkName);
            if (result.success) {
                vscode.window.showInformationMessage(`${sdkName} uninstalled successfully`);
                await this.refreshSDKs();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to uninstall ${sdkName}: ${error.message}`);
        }
    }

    async repairSDK(sdkName) {
        try {
            this.panel.webview.postMessage({
                type: 'repairProgress',
                sdk: sdkName,
                status: 'repairing'
            });

            const result = await this.backend.repairSDK(sdkName);

            if (result.success) {
                vscode.window.showInformationMessage(`${sdkName} repaired successfully!`);
                await this.refreshSDKs();
            }

            this.panel.webview.postMessage({
                type: 'repairComplete',
                sdk: sdkName,
                success: result.success
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to repair ${sdkName}: ${error.message}`);
            this.panel.webview.postMessage({
                type: 'repairComplete',
                sdk: sdkName,
                success: false
            });
        }
    }

    dispose() {
        SDKPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) disposable.dispose();
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>SDK Manager</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 24px;
        }
        .header {
            margin-bottom: 32px;
        }
        .header h1 {
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header p {
            color: var(--vscode-descriptionForeground);
        }
        .action-bar {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .sdk-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 16px;
        }
        .sdk-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            padding: 20px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .sdk-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 16px rgba(0,0,0,0.2);
        }
        .sdk-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
        }
        .sdk-icon {
            font-size: 32px;
            margin-bottom: 12px;
        }
        .sdk-name {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .sdk-version {
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        .sdk-status {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
            text-transform: uppercase;
        }
        .sdk-status.installed {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }
        .sdk-status.not-installed {
            background: rgba(158, 158, 158, 0.2);
            color: #9e9e9e;
        }
        .sdk-description {
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
            line-height: 1.5;
            margin: 12px 0;
        }
        .sdk-actions {
            display: flex;
            gap: 8px;
            margin-top: 16px;
        }
        .btn-install {
            background: #4caf50;
            color: white;
            flex: 1;
        }
        .btn-install:hover {
            background: #45a049;
        }
        .btn-small {
            padding: 8px 16px;
            font-size: 13px;
        }
        .progress-bar {
            width: 100%;
            height: 4px;
            background: var(--vscode-panel-border);
            border-radius: 2px;
            margin-top: 12px;
            overflow: hidden;
            display: none;
        }
        .progress-bar.show {
            display: block;
        }
        .progress-fill {
            height: 100%;
            background: #4caf50;
            transition: width 0.3s;
            width: 0%;
        }
        .loading {
            text-align: center;
            padding: 40px;
            display: none;
        }
        .loading.show { display: block; }
        .spinner {
            border: 3px solid var(--vscode-panel-border);
            border-top: 3px solid var(--vscode-button-background);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1><span>📦</span> SDK Manager</h1>
        <p>Install and manage development tools and SDKs</p>
    </div>
    
    <div class="action-bar">
        <button class="btn" onclick="refreshSDKs()" id="refreshBtn">
            🔄 Refresh
        </button>
    </div>
    
    <div id="loading" class="loading">
        <div class="spinner"></div>
        <p>Loading SDKs...</p>
    </div>
    
    <div class="sdk-grid" id="sdkGrid"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function refreshSDKs() {
            vscode.postMessage({ type: 'refresh' });
        }
        
        function installSDK(sdkName) {
            vscode.postMessage({ type: 'install', sdk: sdkName });
        }
        
        function uninstallSDK(sdkName) {
            vscode.postMessage({ type: 'uninstall', sdk: sdkName });
        }
        
        function repairSDK(sdkName) {
            vscode.postMessage({ type: 'repair', sdk: sdkName });
        }
        
        function getSDKIcon(sdkName) {
            const icons = {
                'Node.js': '🟢',
                'Python': '🐍',
                'Flutter': '🎨',
                'Java': '☕',
                'Docker': '🐳',
                'Git': '📚',
                'Rust': '🦀',
                'Go': '🔵'
            };
            return icons[sdkName] || '📦';
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'loading':
                    document.getElementById('loading').classList.toggle('show', message.show);
                    document.getElementById('refreshBtn').disabled = message.show;
                    break;
                    
                case 'sdksLoaded':
                    displaySDKs(message.sdks);
                    break;
                    
                case 'installProgress':
                    updateProgress(message.sdk, message.progress || 0);
                    break;
                    
                case 'installComplete':
                    if (message.success) {
                        const card = document.querySelector(\`[data-sdk="\${message.sdk}"]\`);
                        if (card) {
                            card.querySelector('.sdk-status').className = 'sdk-status installed';
                            card.querySelector('.sdk-status').textContent = 'Installed';
                        }
                    }
                    hideProgress(message.sdk);
                    break;
            }
        });
        
        function displaySDKs(sdks) {
            const grid = document.getElementById('sdkGrid');
            grid.innerHTML = '';
            
            sdks.forEach(sdk => {
                const card = document.createElement('div');
                card.className = 'sdk-card';
                card.setAttribute('data-sdk', sdk.name);
                
                const installed = sdk.installed || false;
                const icon = getSDKIcon(sdk.name);
                
                card.innerHTML = \`
                    <div class="sdk-icon">\${icon}</div>
                    <div class="sdk-header">
                        <div>
                            <div class="sdk-name">\${sdk.name}</div>
                            <div class="sdk-version">\${sdk.version || 'Latest'}</div>
                        </div>
                        <span class="sdk-status \${installed ? 'installed' : 'not-installed'}">
                            \${installed ? 'Installed' : 'Not Installed'}
                        </span>
                    </div>
                    <div class="sdk-description">
                        \${sdk.description || 'Development tool'}
                    </div>
                    <div class="sdk-actions">
                        \${installed ? \`
                            <button class="btn btn-small" onclick="repairSDK('\${sdk.name}')">🔧 Repair</button>
                            <button class="btn btn-small" onclick="uninstallSDK('\${sdk.name}')">🗑️ Uninstall</button>
                        \` : \`
                            <button class="btn btn-install btn-small" onclick="installSDK('\${sdk.name}')">📥 Install</button>
                        \`}
                    </div>
                    <div class="progress-bar" id="progress-\${sdk.name}">
                        <div class="progress-fill"></div>
                    </div>
                \`;
                
                grid.appendChild(card);
            });
        }
        
        function updateProgress(sdk, progress) {
            const progressBar = document.getElementById(\`progress-\${sdk}\`);
            if (progressBar) {
                progressBar.classList.add('show');
                progressBar.querySelector('.progress-fill').style.width = progress + '%';
            }
        }
        
        function hideProgress(sdk) {
            const progressBar = document.getElementById(\`progress-\${sdk}\`);
            if (progressBar) {
                progressBar.classList.remove('show');
            }
        }
    </script>
</body>
</html>`;
    }
}

module.exports = { SDKPanel };
