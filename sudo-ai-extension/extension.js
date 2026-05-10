const vscode = require('vscode');
const axios = require('axios');

/**
 * SUDO AI EXTENSION - PHASE 4
 * Extension VSCodium pour interaction avec l'IA locale
 */

let chatPanel = null;
let currentModel = null;
let conversationHistory = [];
let authToken = null;
let backendConnected = false;

/**
 * Activation de l'extension
 */
function activate(context) {
    console.log('Sudo AI extension is now active!');

    // Charger la configuration
    const config = vscode.workspace.getConfiguration('sudoAi');
    const backendUrl = config.get('backendUrl', 'http://localhost:5000');
    currentModel = config.get('defaultModel', 'llama3');

    // Obtenir le token d'authentification et vérifier la connexion
    await initializeConnection(backendUrl);

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

    // Ajouter toutes les commandes au contexte
    context.subscriptions.push(
        explainCodeCmd,
        fixCodeCmd,
        generateCodeCmd,
        refactorCodeCmd,
        askQuestionCmd,
        openChatCmd,
        selectModelCmd,
        refreshModelsCmd
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
 * Initialise la connexion au backend
 */
async function initializeConnection(backendUrl) {
    try {
        // Obtenir un token de développement
        const tokenResponse = await axios.get(`${backendUrl}/api/auth/dev-token`, { timeout: 3000 });
        authToken = tokenResponse.data.token;
        
        // Vérifier la connexion au backend
        const response = await axios.get(`${backendUrl}/api/system/status`, { 
            timeout: 3000,
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.data.backend) {
            backendConnected = true;
            vscode.window.showInformationMessage('Sudo AI: Connected to backend ✓');
        }
    } catch (error) {
        backendConnected = false;
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
            const chatContainer = document.getElementById('chat-container');
            
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
            
            function addMessage(text, isUser, metadata) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + (isUser ? 'user' : 'ai');
                
                let content = text;
                if (metadata && !isUser) {
                    content += `<div style="margin-top: 8px; font-size: 0.85em; opacity: 0.7;">`;
                    content += `Model: ${metadata.model || 'unknown'} | ${metadata.latency || 'N/A'}`;
                    content += `</div>`;
                }
                
                messageDiv.innerHTML = content;
                chatContainer.appendChild(messageDiv);
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }
            
            // Listen for messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.type) {
                    case 'user-message':
                        addMessage(message.text, true);
                        break;
                    case 'ai-message':
                        addMessage(message.text, false, {
                            model: message.model,
                            latency: message.latency
                        });
                        break;
                    case 'error':
                        addMessage(message.text, false, { model: 'error' });
                        break;
                }
            });
            
            document.getElementById('message-input').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') sendMessage();
            });
            
            // Welcome message
            addMessage('Hello! I\'m Sudo AI. Ask me anything!', false);
        </script>
    </body>
    </html>`;
}

/**
 * Gère les messages du chat
 */
async function handleChatMessage(text) {
    if (!text || !text.trim()) return;
    
    const config = vscode.workspace.getConfiguration('sudoAi');
    const backendUrl = config.get('backendUrl', 'http://localhost:5000');
    
    try {
        // Ajouter le message utilisateur au chat
        if (chatPanel && chatPanel.webview) {
            chatPanel.webview.postMessage({
                type: 'user-message',
                text: text
            });
        }
        
        // Envoyer au backend
        const response = await axios.post(`${backendUrl}/api/ai/chat`, {
            message: text,
            model: currentModel,
            context: ''
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            timeout: 60000
        });
        
        const result = response.data;
        
        // Ajouter la réponse au chat
        if (chatPanel && chatPanel.webview) {
            chatPanel.webview.postMessage({
                type: 'ai-message',
                text: result.reply,
                model: result.model_used,
                latency: result.latency
            });
        }
        
        // Ajouter à l'historique
        conversationHistory.push({
            user: text,
            assistant: result.reply,
            model: result.model_used
        });
        
    } catch (error) {
        console.error('Chat error:', error);
        
        if (chatPanel && chatPanel.webview) {
            chatPanel.webview.postMessage({
                type: 'error',
                text: `Error: ${error.response?.data?.message || error.message}`
            });
        }
    }
}

/**
 * Récupère le token d'authentification
 */
function getAuthToken() {
    return authToken || 'fallback-token';
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
