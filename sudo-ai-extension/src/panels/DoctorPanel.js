const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class DoctorPanel {
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
    }

    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DoctorPanel.currentPanel) {
            DoctorPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sudoStudioDoctor',
            '🩺 System Doctor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        DoctorPanel.currentPanel = new DoctorPanel(panel, extensionUri);
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'runDoctor':
                await this.runDiagnostic();
                break;
            case 'autoFix':
                await this.runAutoFix(message.issueType, message.issue);
                break;
        }
    }

    async runDiagnostic() {
        try {
            this.panel.webview.postMessage({ type: 'loading', show: true });

            const result = await this.backend.runDoctor();

            this.panel.webview.postMessage({
                type: 'diagnosticComplete',
                data: result
            });

            this.state.updateSystemState({
                score: result.score,
                issues: result.issues || []
            });

        } catch (error) {
            this.panel.webview.postMessage({
                type: 'error',
                message: `Diagnostic failed: ${error.message}`
            });
        } finally {
            this.panel.webview.postMessage({ type: 'loading', show: false });
        }
    }

    async runAutoFix(issueType, issue) {
        try {
            this.panel.webview.postMessage({
                type: 'fixLoading',
                issueType: issueType,
                show: true
            });

            const result = await this.backend.autoFix(issueType, issue);

            this.panel.webview.postMessage({
                type: 'fixComplete',
                issueType: issueType,
                success: result.success,
                message: result.message
            });

            if (result.success) {
                vscode.window.showInformationMessage(`AutoFix successful: ${result.message}`);
                // Re-run diagnostic
                setTimeout(() => this.runDiagnostic(), 1000);
            }

        } catch (error) {
            this.panel.webview.postMessage({
                type: 'fixComplete',
                issueType: issueType,
                success: false,
                message: error.message
            });
            vscode.window.showErrorMessage(`AutoFix failed: ${error.message}`);
        }
    }

    dispose() {
        DoctorPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>System Doctor</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
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
            font-size: 14px;
        }
        
        .action-bar {
            display: flex;
            gap: 12px;
            margin-bottom: 32px;
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
            transition: background 0.2s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .score-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
            text-align: center;
        }
        
        .score-value {
            font-size: 64px;
            font-weight: 700;
            margin: 16px 0;
        }
        
        .score-value.excellent {
            color: #4caf50;
        }
        
        .score-value.good {
            color: #8bc34a;
        }
        
        .score-value.warning {
            color: #ff9800;
        }
        
        .score-value.critical {
            color: #f44336;
        }
        
        .score-label {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .score-description {
            margin-top: 12px;
            font-size: 16px;
        }
        
        .issues-container {
            display: grid;
            gap: 16px;
        }
        
        .issue-card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            transition: transform 0.2s;
        }
        
        .issue-card:hover {
            transform: translateY(-2px);
        }
        
        .issue-card.critical {
            border-left: 4px solid #f44336;
        }
        
        .issue-card.warning {
            border-left: 4px solid #ff9800;
        }
        
        .issue-card.info {
            border-left: 4px solid #2196f3;
        }
        
        .issue-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
        }
        
        .issue-title {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .issue-severity {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
            text-transform: uppercase;
        }
        
        .issue-severity.critical {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }
        
        .issue-severity.warning {
            background: rgba(255, 152, 0, 0.2);
            color: #ff9800;
        }
        
        .issue-severity.info {
            background: rgba(33, 150, 243, 0.2);
            color: #2196f3;
        }
        
        .issue-description {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
            line-height: 1.6;
        }
        
        .issue-actions {
            display: flex;
            gap: 8px;
        }
        
        .btn-fix {
            background: #4caf50;
            color: white;
        }
        
        .btn-fix:hover {
            background: #45a049;
        }
        
        .btn-small {
            padding: 6px 12px;
            font-size: 13px;
        }
        
        .loading {
            display: none;
            text-align: center;
            padding: 40px;
        }
        
        .loading.show {
            display: block;
        }
        
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
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 16px;
            opacity: 0.5;
        }
        
        .empty-state h3 {
            font-size: 20px;
            margin-bottom: 8px;
        }
        
        .success-state {
            background: var(--vscode-sideBar-background);
            border: 1px solid #4caf50;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            margin: 20px 0;
        }
        
        .success-state .icon {
            font-size: 48px;
            margin-bottom: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            <span>🩺</span>
            System Doctor
        </h1>
        <p>Comprehensive system diagnostics and automated fixes</p>
    </div>
    
    <div class="action-bar">
        <button class="btn" onclick="runDoctor()" id="runButton">
            <span>▶</span>
            Run Full Diagnostic
        </button>
    </div>
    
    <div id="loading" class="loading">
        <div class="spinner"></div>
        <p>Running comprehensive system diagnostic...</p>
    </div>
    
    <div id="results" style="display: none;">
        <div class="score-card">
            <div class="score-label">System Health Score</div>
            <div class="score-value" id="scoreValue">--</div>
            <div class="score-description" id="scoreDescription"></div>
        </div>
        
        <div id="issuesContainer">
            <h2 style="margin-bottom: 16px; font-size: 20px;">Issues Detected</h2>
            <div class="issues-container" id="issuesList"></div>
        </div>
    </div>
    
    <div id="emptyState" class="empty-state">
        <div class="empty-state-icon">🩺</div>
        <h3>Ready to diagnose your system</h3>
        <p>Click "Run Full Diagnostic" to start a comprehensive health check</p>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function runDoctor() {
            vscode.postMessage({ type: 'runDoctor' });
        }
        
        function autoFix(issueType, issue) {
            vscode.postMessage({
                type: 'autoFix',
                issueType: issueType,
                issue: issue
            });
        }
        
        function getScoreClass(score) {
            if (score >= 90) return 'excellent';
            if (score >= 70) return 'good';
            if (score >= 50) return 'warning';
            return 'critical';
        }
        
        function getScoreDescription(score) {
            if (score >= 90) return 'Excellent - Your system is in great shape!';
            if (score >= 70) return 'Good - Minor issues detected';
            if (score >= 50) return 'Warning - Some issues need attention';
            return 'Critical - Immediate action required';
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'loading':
                    document.getElementById('loading').classList.toggle('show', message.show);
                    document.getElementById('runButton').disabled = message.show;
                    break;
                    
                case 'diagnosticComplete':
                    displayResults(message.data);
                    break;
                    
                case 'fixLoading':
                    const fixButton = document.querySelector(\`[data-issue-type="\${message.issueType}"]\`);
                    if (fixButton) {
                        fixButton.disabled = message.show;
                        fixButton.textContent = message.show ? '⏳ Fixing...' : '🔧 AutoFix';
                    }
                    break;
                    
                case 'fixComplete':
                    if (message.success) {
                        const card = document.querySelector(\`[data-issue-type="\${message.issueType}"]\`)?.closest('.issue-card');
                        if (card) {
                            card.style.opacity = '0.5';
                            card.innerHTML += '<div class="success-state"><div class="icon">✅</div><p>Fixed successfully!</p></div>';
                        }
                    }
                    break;
                    
                case 'error':
                    alert('Error: ' + message.message);
                    break;
            }
        });
        
        function displayResults(data) {
            document.getElementById('emptyState').style.display = 'none';
            document.getElementById('results').style.display = 'block';
            
            const score = data.score || 0;
            const scoreValue = document.getElementById('scoreValue');
            scoreValue.textContent = score;
            scoreValue.className = 'score-value ' + getScoreClass(score);
            
            document.getElementById('scoreDescription').textContent = getScoreDescription(score);
            
            const issuesList = document.getElementById('issuesList');
            issuesList.innerHTML = '';
            
            const issues = data.issues || [];
            
            if (issues.length === 0) {
                issuesList.innerHTML = '<div class="success-state"><div class="icon">✅</div><h3>No issues detected!</h3><p>Your system is running smoothly</p></div>';
            } else {
                issues.forEach(issue => {
                    const card = document.createElement('div');
                    card.className = 'issue-card ' + (issue.severity || 'warning');
                    
                    const severity = issue.severity || 'warning';
                    const title = issue.title || issue.type || 'Unknown Issue';
                    const description = issue.description || issue.message || 'No details available';
                    const fixable = issue.fixable || issue.auto_fixable || false;
                    
                    card.innerHTML = \`
                        <div class="issue-header">
                            <div class="issue-title">
                                <span>\${getSeverityIcon(severity)}</span>
                                <span>\${title}</span>
                            </div>
                            <span class="issue-severity \${severity}">\${severity}</span>
                        </div>
                        <div class="issue-description">\${description}</div>
                        <div class="issue-actions">
                            \${fixable ? \`<button class="btn btn-fix btn-small" data-issue-type="\${issue.type}" onclick="autoFix('\${issue.type}', \${JSON.stringify(issue).replace(/"/g, '&quot;')})">🔧 AutoFix</button>\` : ''}
                            <button class="btn btn-small">📋 Details</button>
                        </div>
                    \`;
                    
                    issuesList.appendChild(card);
                });
            }
        }
        
        function getSeverityIcon(severity) {
            switch (severity) {
                case 'critical': return '🔴';
                case 'warning': return '⚠️';
                case 'info': return 'ℹ️';
                default: return '•';
            }
        }
    </script>
</body>
</html>`;
    }
}

module.exports = { DoctorPanel };
