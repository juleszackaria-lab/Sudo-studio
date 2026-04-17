const vscode = require('vscode');
const axios = require('axios');

/**
 * SUDO AI EXTENSION - PHASE 4
 * Extension VSCodium pour interaction avec l'IA locale
 */

let chatPanel = null;
let currentModel = null;
let conversationHistory = [];

/**
 * Activation de l'extension
 */
function activate(context) {
    console.log('Sudo AI extension is now active!');

    // Charger la configuration
    const config = vscode.workspace.getConfiguration('sudoAi');
    const backendUrl = config.get('backendUrl', 'http://localhost:5000');
    currentModel = config.get('defaultModel', 'llama3');

    // Vérifier la connexion au backend au démarrage
    checkBackendConnection(backendUrl);

    // Enregistrer les commandes

    // 1. Explain Code
    let explainCodeCmd = vscode.commands.registerCommand('sudo-ai.explainCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const code = editor.document.getText(selection);

        if (!code) {
            vscode.window.showWarningMessage('Please select some code first');
            return;
        }

        await sendToAI('Explain this code:', code, 'explain');
    });

    // 2. Fix Code
    let fixCodeCmd = vscode.commands.registerCommand('sudo-ai.fixCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const code = editor.document.getText(selection);

        if (!code) {
            vscode.window.showWarningMessage('Please select some code first');
            return;
        }

        await sendToAI('Fix and improve this code:', code, 'fix');
    });

    // 3. Generate Code
    let generateCodeCmd = vscode.commands.registerCommand('sudo-ai.generateCode', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'What code would you like to generate?',
            placeHolder: 'e.g., Create a React component for a login form'
        });

        if (!prompt) return;

        await sendToAI(prompt, '', 'generate');
    });

    // 4. Refactor Code
    let refactorCodeCmd = vscode.commands.registerCommand('sudo-ai.refactorCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const code = editor.document.getText(selection);

        if (!code) {
            vscode.window.showWarningMessage('Please select some code first');
            return;
        }

        await sendToAI('Refactor this code to improve readability and performance:', code, 'refactor');
    });

    // 5. Ask Question
    let askQuestionCmd = vscode.commands.registerCommand('sudo-ai.askQuestion', async () => {
        const question = await vscode.window.showInputBox({
            prompt: 'What would you like to ask?',
            placeHolder: 'e.g., How do I use async/await in JavaScript?'
        });

        if (!question) return;

        await sendToAI(question, '', 'question');
    });

    // 6. Open Chat
    let openChatCmd = vscode.commands.registerCommand('sudo-ai.openChat', () => {
        openChatPanel(context);
    });

    // 7. Select Model
    let selectModelCmd = vscode.commands.registerCommand('sudo-ai.selectModel', async () => {
        const config = vscode.workspace.getConfiguration('sudoAi');
        const backendUrl = config.get('backendUrl');

        try {
            // Récupérer la liste des modèles disponibles
            const response = await axios.get(`${backendUrl}/api/ai/models`, {
                headers: { 'Authorization': `Bearer ${getAuthToken()}` }
            });

            const models = response.data.models;
            const availableModels = models.filter(m => m.available);

            if (availableModels.length === 0) {
                vscode.window.showWarningMessage('No AI models available. Please start Ollama or vLLM.');
                return;
            }

            const modelOptions = availableModels.map(m => ({
                label: m.name,
                description: `${m.type} - ${m.status}`,
                detail: m.recommended_for === 'code' ? '(Recommended for code)' : ''
            }));

            const selected = await vscode.window.showQuickPick(modelOptions, {
                placeHolder: 'Select an AI model'
            });

            if (selected) {
                currentModel = selected.label;
                vscode.window.showInformationMessage(`Switched to model: ${currentModel}`);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load models: ${error.message}`);
        }
    });

    // 8. Refresh Models
    let refreshModelsCmd = vscode.commands.registerCommand('sudo-ai.refreshModels', async () => {
        vscode.window.showInformationMessage('Refreshing AI models...');
        await vscode.commands.executeCommand('sudo-ai.selectModel');
    });

    // 9. Download Model (NEW)
    let downloadModelCmd = vscode.commands.registerCommand('sudo-ai.downloadModel', async () => {
        const config = vscode.workspace.getConfiguration('sudoAi');
        const backendUrl = config.get('backendUrl');

        try {
            // Récupérer la liste des modèles disponibles
            const response = await axios.get(`${backendUrl}/api/models/list`, {
                headers: { 'Authorization': `Bearer ${getAuthToken()}` }
            });

            const available = response.data.available;
            const notInstalled = available.filter(m => !m.installed);

            if (notInstalled.length === 0) {
                vscode.window.showInformationMessage('All models are already installed!');
                return;
            }

            // Créer les options de sélection
            const modelOptions = notInstalled.map(m => ({
                label: m.displayName,
                description: `${m.size} - ${m.type}`,
                detail: `${m.description}${m.recommended ? ' (Recommended)' : ''}`,
                model: m.name
            }));

            const selected = await vscode.window.showQuickPick(modelOptions, {
                placeHolder: 'Select a model to download'
            });

            if (!selected) return;

            // Confirmer le téléchargement
            const confirm = await vscode.window.showInformationMessage(
                `Download ${selected.label} (${selected.description})?\n\nThis may take 2-10 minutes depending on your connection.`,
                'Yes', 'No'
            );

            if (confirm !== 'Yes') return;

            // Démarrer le téléchargement
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${selected.label}...`,
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ increment: 10, message: 'Starting download...' });

                    const installResponse = await axios.post(`${backendUrl}/api/models/install`, {
                        model: selected.model
                    }, {
                        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
                    });

                    progress.report({ increment: 30, message: 'Downloading model files...' });

                    // Polling pour vérifier le statut
                    let installed = false;
                    let attempts = 0;
                    const maxAttempts = 60; // 10 minutes max (10s * 60)

                    while (!installed && attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s
                        
                        try {
                            const statusResponse = await axios.get(
                                `${backendUrl}/api/models/install/status/${selected.model}`,
                                { headers: { 'Authorization': `Bearer ${getAuthToken()}` } }
                            );
                            
                            installed = statusResponse.data.installed;
                            progress.report({ 
                                increment: 1, 
                                message: installed ? 'Installation complete!' : 'Still downloading...'
                            });
                        } catch (error) {
                            // Continue polling
                        }
                        
                        attempts++;
                    }

                    if (installed) {
                        vscode.window.showInformationMessage(
                            `${selected.label} installed successfully! You can now use it.`
                        );
                    } else {
                        vscode.window.showWarningMessage(
                            `${selected.label} is still installing in the background. Check Ollama logs for progress.`
                        );
                    }

                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to download ${selected.label}: ${error.response?.data?.message || error.message}`
                    );
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to load models: ${error.response?.data?.message || error.message}`
            );
        }
    });

    // 10. Analyze Project (NEW)
    let analyzeProjectCmd = vscode.commands.registerCommand('sudo-ai.analyzeProject', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const projectPath = workspaceFolders[0].uri.fsPath;
        const config = vscode.workspace.getConfiguration('sudoAi');
        const backendUrl = config.get('backendUrl');

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Analyzing project...',
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 30 });

                const response = await axios.post(`${backendUrl}/api/project/analyze`, {
                    projectPath,
                    deep: true
                }, {
                    headers: { 'Authorization': `Bearer ${getAuthToken()}` },
                    timeout: 60000
                });

                progress.report({ increment: 70 });

                const analysis = response.data;
                
                // Afficher les résultats
                const panel = vscode.window.createWebviewPanel(
                    'projectAnalysis',
                    'Project Analysis',
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );

                panel.webview.html = getProjectAnalysisHtml(analysis);

            } catch (error) {
                vscode.window.showErrorMessage(
                    `Project analysis failed: ${error.response?.data?.message || error.message}`
                );
            }
        });
    });

    // 11. Doctor (NEW)
    let doctorCmd = vscode.commands.registerCommand('sudo-ai.doctor', async () => {
        const config = vscode.workspace.getConfiguration('sudoAi');
        const backendUrl = config.get('backendUrl');

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Running system diagnostics...',
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 20, message: 'Checking backend...' });

                const statusResponse = await axios.get(`${backendUrl}/api/system/status`, {
                    timeout: 5000
                });

                progress.report({ increment: 30, message: 'Checking AI services...' });

                const aiHealthResponse = await axios.get(`${backendUrl}/api/ai/health`, {
                    headers: { 'Authorization': `Bearer ${getAuthToken()}` },
                    timeout: 5000
                });

                progress.report({ increment: 50 });

                // Afficher les résultats
                const backendOk = statusResponse.data.backend;
                const aiOk = aiHealthResponse.data.overall_status === 'operational';

                let message = '✅ System Health Check:\n\n';
                message += `Backend: ${backendOk ? '✅ OK' : '❌ ERROR'}\n`;
                message += `AI Services: ${aiOk ? '✅ OK' : '⚠️ DEGRADED'}\n`;
                message += `Models Available: ${aiHealthResponse.data.models_available}/${aiHealthResponse.data.models_total}\n`;

                vscode.window.showInformationMessage(message);

            } catch (error) {
                vscode.window.showErrorMessage(
                    `Doctor check failed: ${error.message}\n\nMake sure Sudo Studio backend is running.`
                );
            }
        });
    });

    // Ajouter toutes les commandes au contexte
    context.subscriptions.push(
        explainCodeCmd,
        fixCodeCmd,
        generateCodeCmd,
        refactorCodeCmd,
        askQuestionCmd,
        openChatCmd,
        selectModelCmd,
        refreshModelsCmd,
        downloadModelCmd,
        analyzeProjectCmd,
        doctorCmd
    );

    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = `$(robot) Sudo AI: ${currentModel}`;
    statusBarItem.command = 'sudo-ai.selectModel';
    statusBarItem.tooltip = 'Click to change AI model';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    console.log('Sudo AI: All commands registered successfully');
}

/**
 * Vérifie la connexion au backend
 */
async function checkBackendConnection(backendUrl) {
    try {
        const response = await axios.get(`${backendUrl}/api/system/status`, { timeout: 3000 });
        if (response.data.backend) {
            vscode.window.showInformationMessage('Sudo AI: Connected to backend ✓');
        }
    } catch (error) {
        vscode.window.showWarningMessage(
            'Sudo AI: Cannot connect to backend. Please start the Sudo Studio server.'
        );
    }
}

/**
 * Envoie une requête à l'IA
 */
async function sendToAI(message, context, type) {
    const config = vscode.workspace.getConfiguration('sudoAi');
    const backendUrl = config.get('backendUrl');

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Sudo AI (${currentModel}): Processing...`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ increment: 30 });

            const response = await axios.post(`${backendUrl}/api/ai/chat`, {
                message,
                context,
                model: currentModel
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getAuthToken()}`
                },
                timeout: 60000
            });

            progress.report({ increment: 40 });

            const result = response.data;
            conversationHistory.push({ message, context, reply: result.reply });

            progress.report({ increment: 30 });

            // Afficher le résultat
            showResult(result, type);

        } catch (error) {
            vscode.window.showErrorMessage(
                `Sudo AI Error: ${error.response?.data?.message || error.message}`
            );
        }
    });
}

/**
 * Affiche le résultat de l'IA
 */
function showResult(result, type) {
    const panel = vscode.window.createWebviewPanel(
        'sudoAiResult',
        `Sudo AI Result (${result.model_used})`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    panel.webview.html = getResultHtml(result, type);
}

/**
 * HTML pour afficher les résultats
 */
function getResultHtml(result, type) {
    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: var(--vscode-font-family);
                padding: 20px;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
            }
            .header {
                border-bottom: 1px solid var(--vscode-panel-border);
                padding-bottom: 10px;
                margin-bottom: 20px;
            }
            .model-info {
                color: var(--vscode-descriptionForeground);
                font-size: 0.9em;
            }
            .content {
                line-height: 1.6;
                white-space: pre-wrap;
            }
            pre {
                background-color: var(--vscode-textCodeBlock-background);
                padding: 15px;
                border-radius: 5px;
                overflow-x: auto;
            }
            code {
                font-family: var(--vscode-editor-font-family);
            }
            .metadata {
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid var(--vscode-panel-border);
                font-size: 0.85em;
                color: var(--vscode-descriptionForeground);
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Sudo AI: ${type.charAt(0).toUpperCase() + type.slice(1)}</h2>
            <div class="model-info">
                Model: ${result.model_used} | Mode: ${result.mode} | Latency: ${result.latency}
            </div>
        </div>
        <div class="content">
            ${formatReply(result.reply)}
        </div>
        <div class="metadata">
            <p><strong>Timestamp:</strong> ${result.timestamp}</p>
            <p><strong>Reply length:</strong> ${result.metadata.reply_length} characters</p>
        </div>
    </body>
    </html>`;
}

/**
 * Formate la réponse (détecte et met en forme le code)
 */
function formatReply(reply) {
    // Détecte les blocs de code markdown
    return reply.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang || 'text'}">${escapeHtml(code)}</code></pre>`;
    }).replace(/\n/g, '<br>');
}

/**
 * Échappe le HTML
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Ouvre le panel de chat
 */
function openChatPanel(context) {
    if (chatPanel) {
        chatPanel.reveal(vscode.ViewColumn.Two);
        return;
    }

    chatPanel = vscode.window.createWebviewPanel(
        'sudoAiChat',
        'Sudo AI Chat',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    chatPanel.webview.html = getChatHtml();

    // Gérer les messages du webview
    chatPanel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'sendMessage':
                    await handleChatMessage(message.text);
                    break;
                case 'selectModel':
                    await vscode.commands.executeCommand('sudo-ai.selectModel');
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    chatPanel.onDidDispose(() => {
        chatPanel = null;
    });
}

/**
 * HTML pour le chat
 */
function getChatHtml() {
    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body {
                font-family: var(--vscode-font-family);
                padding: 0;
                margin: 0;
                display: flex;
                flex-direction: column;
                height: 100vh;
            }
            #chat-container {
                flex: 1;
                overflow-y: auto;
                padding: 20px;
            }
            #input-container {
                padding: 15px;
                border-top: 1px solid var(--vscode-panel-border);
                display: flex;
                gap: 10px;
            }
            #message-input {
                flex: 1;
                padding: 10px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
            }
            button {
                padding: 10px 20px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 4px;
                cursor: pointer;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .message {
                margin-bottom: 15px;
                padding: 10px;
                border-radius: 5px;
            }
            .message.user {
                background: var(--vscode-input-background);
                text-align: right;
            }
            .message.ai {
                background: var(--vscode-textCodeBlock-background);
            }
        </style>
    </head>
    <body>
        <div id="chat-container"></div>
        <div id="input-container">
            <input type="text" id="message-input" placeholder="Ask Sudo AI anything..." />
            <button onclick="sendMessage()">Send</button>
            <button onclick="selectModel()">Model</button>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            
            function sendMessage() {
                const input = document.getElementById('message-input');
                const text = input.value.trim();
                if (!text) return;
                
                vscode.postMessage({ command: 'sendMessage', text });
                input.value = '';
            }
            
            function selectModel() {
                vscode.postMessage({ command: 'selectModel' });
            }
            
            document.getElementById('message-input').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') sendMessage();
            });
        </script>
    </body>
    </html>`;
}

/**
 * Gère les messages du chat
 */
async function handleChatMessage(text) {
    // TODO: Envoyer au backend et recevoir la réponse
    // Pour l'instant, simplement logger
    console.log('Chat message:', text);
}

/**
 * Récupère le token d'authentification
 * TODO: Implémenter un système de login pour récupérer le token JWT
 */
function getAuthToken() {
    // Pour l'instant, on peut utiliser un token mock
    // En production, il faudrait un système de login
    return 'mock-token-for-development';
}

/**
 * HTML pour l'analyse de projet
 */
function getProjectAnalysisHtml(analysis) {
    const issuesHtml = analysis.issues.map(issue => `
        <div class="issue ${issue.severity}">
            <strong>[${issue.severity.toUpperCase()}]</strong> ${issue.type}: ${issue.message}
        </div>
    `).join('');

    const recommendationsHtml = analysis.recommendations.map(rec => `
        <li>${rec}</li>
    `).join('');

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body {
                font-family: var(--vscode-font-family);
                padding: 20px;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
            }
            .header {
                border-bottom: 2px solid var(--vscode-panel-border);
                padding-bottom: 15px;
                margin-bottom: 20px;
            }
            .section {
                margin: 20px 0;
                padding: 15px;
                background-color: var(--vscode-textCodeBlock-background);
                border-radius: 5px;
            }
            .metric {
                display: inline-block;
                margin: 10px 15px 10px 0;
                padding: 8px 12px;
                background-color: var(--vscode-button-background);
                border-radius: 4px;
            }
            .issue {
                padding: 10px;
                margin: 8px 0;
                border-left: 4px solid;
                border-radius: 3px;
            }
            .issue.high {
                border-left-color: #f14c4c;
                background-color: rgba(241, 76, 76, 0.1);
            }
            .issue.medium {
                border-left-color: #ff9800;
                background-color: rgba(255, 152, 0, 0.1);
            }
            .issue.low {
                border-left-color: #4caf50;
                background-color: rgba(76, 175, 80, 0.1);
            }
            ul {
                line-height: 1.8;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>📊 Project Analysis</h1>
            <p><strong>Path:</strong> ${analysis.projectPath}</p>
            <p><strong>Type:</strong> ${analysis.analysis_type}</p>
            <p><strong>Time:</strong> ${new Date(analysis.timestamp).toLocaleString()}</p>
        </div>

        <div class="section">
            <h2>📁 Structure</h2>
            <div class="metric">Files: ${analysis.structure.files_count}</div>
            <div class="metric">Directories: ${analysis.structure.directories_count}</div>
            <div class="metric">Lines: ${analysis.structure.total_lines}</div>
        </div>

        <div class="section">
            <h2>📦 Dependencies</h2>
            <div class="metric">Total: ${analysis.dependencies.total}</div>
            <div class="metric">Outdated: ${analysis.dependencies.outdated}</div>
            <div class="metric">Vulnerable: ${analysis.dependencies.vulnerable}</div>
            <div class="metric">Unused: ${analysis.dependencies.unused}</div>
        </div>

        <div class="section">
            <h2>⚠️ Issues (${analysis.issues.length})</h2>
            ${issuesHtml || '<p>No issues found!</p>'}
        </div>

        <div class="section">
            <h2>💡 Recommendations</h2>
            <ul>
                ${recommendationsHtml}
            </ul>
        </div>

        <div class="section">
            <h2>📈 Metrics</h2>
            <div class="metric">Complexity: ${analysis.metrics.complexity}</div>
            <div class="metric">Maintainability: ${analysis.metrics.maintainability}/100</div>
            <div class="metric">Test Coverage: ${analysis.metrics.test_coverage}%</div>
            <div class="metric">Bundle Size: ${analysis.metrics.bundle_size}</div>
        </div>
    </body>
    </html>`;
}

/**
 * Désactivation de l'extension
 */
function deactivate() {
    console.log('Sudo AI extension is now deactivated');
}

module.exports = {
    activate,
    deactivate
};
