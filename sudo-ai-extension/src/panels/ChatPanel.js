const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class ChatPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.backend = getBackendService();
        this.state = getStateManager();
        this.disposables = [];

        // Set the webview's initial html content
        this.panel.webview.html = this.getHtmlContent();

        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Handle messages from the webview
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

        // If we already have a panel, show it
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioChat',
            '💬 Sudo AI Chat',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'sendMessage':
                await this.handleChatMessage(message.text);
                break;
            case 'clearChat':
                this.state.clearChatHistory();
                break;
            case 'selectModel':
                this.state.updateChatState({ currentModel: message.model });
                break;
            case 'stopGeneration':
                // TODO: Implement streaming stop
                break;
        }
    }

    async handleChatMessage(text) {
        if (!text || !text.trim()) return;

        try {
            // Show user message
            this.panel.webview.postMessage({
                type: 'userMessage',
                text: text
            });

            // Show loading
            this.panel.webview.postMessage({
                type: 'loading',
                show: true
            });

            // Get current model
            const chatState = this.state.getChatState();
            const currentModel = chatState.currentModel || 'default';

            // Send to backend
            const response = await this.backend.sendChatMessage(text, currentModel);

            // Hide loading
            this.panel.webview.postMessage({
                type: 'loading',
                show: false
            });

            // Show AI response
            this.panel.webview.postMessage({
                type: 'aiMessage',
                text: response.reply || response.response || 'No response',
                model: response.model_used || response.model || currentModel,
                latency: response.latency,
                tokens: response.tokens
            });

            // Update state
            this.state.addChatMessage({
                user: text,
                assistant: response.reply || response.response,
                timestamp: Date.now()
            });

        } catch (error) {
            this.panel.webview.postMessage({
                type: 'loading',
                show: false
            });

            this.panel.webview.postMessage({
                type: 'error',
                text: `Error: ${error.message}`
            });

            vscode.window.showErrorMessage(`Chat error: ${error.message}`);
        }
    }

    dispose() {
        ChatPanel.currentPanel = undefined;

        // Clean up our resources
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
    <title>Sudo AI Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        #header {
            padding: 16px 20px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        #header h1 {
            font-size: 18px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        #headerActions {
            display: flex;
            gap: 8px;
        }
        
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.2s;
        }
        
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        #chatContainer {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .message {
            display: flex;
            gap: 12px;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.user {
            flex-direction: row-reverse;
        }
        
        .message-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            flex-shrink: 0;
        }
        
        .message.user .message-avatar {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .message.ai .message-avatar {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .message-content {
            flex: 1;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 12px;
            padding: 12px 16px;
            max-width: 80%;
        }
        
        .message.user .message-content {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
        }
        
        .message-meta {
            font-size: 11px;
            opacity: 0.7;
            margin-top: 6px;
            display: flex;
            gap: 12px;
        }
        
        .message-actions {
            margin-top: 8px;
            display: flex;
            gap: 8px;
        }
        
        .message-actions button {
            padding: 4px 8px;
            font-size: 11px;
        }
        
        #loading {
            display: none;
            padding: 12px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        
        #loading.show {
            display: block;
        }
        
        .loading-dots {
            display: inline-block;
        }
        
        .loading-dots span {
            animation: blink 1.4s infinite both;
        }
        
        .loading-dots span:nth-child(2) {
            animation-delay: 0.2s;
        }
        
        .loading-dots span:nth-child(3) {
            animation-delay: 0.4s;
        }
        
        @keyframes blink {
            0%, 80%, 100% {
                opacity: 0;
            }
            40% {
                opacity: 1;
            }
        }
        
        #inputContainer {
            padding: 16px 20px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        #inputForm {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }
        
        #messageInput {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 12px;
            font-size: 14px;
            font-family: inherit;
            resize: none;
            max-height: 120px;
            min-height: 44px;
        }
        
        #messageInput:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        #sendButton {
            padding: 12px 20px;
            height: 44px;
        }
        
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 16px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon {
            font-size: 48px;
            opacity: 0.5;
        }
        
        .empty-state h2 {
            font-size: 20px;
            font-weight: 500;
        }
        
        .empty-state p {
            font-size: 14px;
            opacity: 0.7;
        }
        
        pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 8px 0;
        }
        
        code {
            font-family: 'Courier New', Courier, monospace;
            font-size: 13px;
        }
        
        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 10px;
        }
        
        ::-webkit-scrollbar-track {
            background: var(--vscode-editor-background);
        }
        
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="header">
        <h1>
            <span>🤖</span>
            <span>Sudo AI Chat</span>
        </h1>
        <div id="headerActions">
            <button class="btn btn-secondary" onclick="clearChat()">Clear Chat</button>
        </div>
    </div>
    
    <div id="chatContainer">
        <div class="empty-state">
            <div class="empty-state-icon">💬</div>
            <h2>Start a conversation</h2>
            <p>Ask me anything about your code, project, or development questions</p>
        </div>
    </div>
    
    <div id="loading">
        <span class="loading-dots">
            AI is thinking<span>.</span><span>.</span><span>.</span>
        </span>
    </div>
    
    <div id="inputContainer">
        <form id="inputForm">
            <textarea 
                id="messageInput" 
                placeholder="Type your message here... (Shift+Enter for new line)"
                rows="1"
            ></textarea>
            <button type="submit" id="sendButton" class="btn">Send</button>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const inputForm = document.getElementById('inputForm');
        const loading = document.getElementById('loading');
        
        let messageCount = 0;

        // Handle form submission
        inputForm.addEventListener('submit', (e) => {
            e.preventDefault();
            sendMessage();
        });

        // Handle Enter key (Shift+Enter for new line)
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Auto-resize textarea
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = messageInput.scrollHeight + 'px';
        });

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text) return;

            vscode.postMessage({
                type: 'sendMessage',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        function clearChat() {
            if (confirm('Are you sure you want to clear the chat history?')) {
                chatContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><h2>Start a conversation</h2><p>Ask me anything about your code, project, or development questions</p></div>';
                messageCount = 0;
                vscode.postMessage({ type: 'clearChat' });
            }
        }

        function copyCode(button, code) {
            navigator.clipboard.writeText(code);
            const originalText = button.textContent;
            button.textContent = 'Copied!';
            setTimeout(() => {
                button.textContent = originalText;
            }, 2000);
        }

        function removeEmptyState() {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) {
                emptyState.remove();
            }
        }

        function addMessage(text, isUser, metadata = {}) {
            removeEmptyState();
            
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + (isUser ? 'user' : 'ai');
            
            const avatar = document.createElement('div');
            avatar.className = 'message-avatar';
            avatar.textContent = isUser ? 'U' : 'AI';
            
            const content = document.createElement('div');
            content.className = 'message-content';
            
            // Process markdown-like formatting
            let processedText = text
                .replace(/\`\`\`([a-z]*)\n([\s\S]*?)\`\`\`/g, (match, lang, code) => {
                    return '<pre><code>' + escapeHtml(code.trim()) + '</code></pre>';
                })
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\*([^\*]+)\*/g, '<em>$1</em>')
                .replace(/\n/g, '<br>');
            
            content.innerHTML = processedText;
            
            if (metadata.model || metadata.latency) {
                const meta = document.createElement('div');
                meta.className = 'message-meta';
                if (metadata.model) {
                    meta.innerHTML += '<span>Model: ' + metadata.model + '</span>';
                }
                if (metadata.latency) {
                    meta.innerHTML += '<span>Latency: ' + Math.round(metadata.latency * 1000) + 'ms</span>';
                }
                if (metadata.tokens) {
                    meta.innerHTML += '<span>Tokens: ' + metadata.tokens + '</span>';
                }
                content.appendChild(meta);
            }
            
            if (!isUser) {
                const actions = document.createElement('div');
                actions.className = 'message-actions';
                actions.innerHTML = '<button class="btn btn-secondary" onclick="copyMessage(this)">Copy</button>';
                content.appendChild(actions);
            }
            
            messageDiv.appendChild(avatar);
            messageDiv.appendChild(content);
            
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            
            messageCount++;
        }

        function copyMessage(button) {
            const messageContent = button.closest('.message-content');
            const text = messageContent.textContent.replace(/Copy$/, '').trim();
            navigator.clipboard.writeText(text);
            button.textContent = 'Copied!';
            setTimeout(() => {
                button.textContent = 'Copy';
            }, 2000);
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'userMessage':
                    addMessage(message.text, true);
                    break;
                    
                case 'aiMessage':
                    addMessage(message.text, false, {
                        model: message.model,
                        latency: message.latency,
                        tokens: message.tokens
                    });
                    break;
                    
                case 'error':
                    addMessage(message.text, false, { model: 'error' });
                    break;
                    
                case 'loading':
                    if (message.show) {
                        loading.classList.add('show');
                    } else {
                        loading.classList.remove('show');
                    }
                    break;
            }
        });

        // Focus input on load
        messageInput.focus();
    </script>
</body>
</html>`;
    }
}

module.exports = { ChatPanel };
