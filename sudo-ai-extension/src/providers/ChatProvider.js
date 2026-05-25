const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class ChatProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
        
        // Listen to chat state changes
        this.state.on('chat:update', () => this.refresh());
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            return [
                this.createNewChatItem(),
                this.createModelSection(),
                this.createHistorySection()
            ];
        }

        if (element.contextValue === 'modelSection') {
            return this.getAvailableModels();
        }

        if (element.contextValue === 'historySection') {
            return this.getChatHistory();
        }

        return [];
    }

    createNewChatItem() {
        const item = new vscode.TreeItem('New Chat', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.command = {
            command: 'sudoStudio.openChat',
            title: 'Open AI Chat'
        };
        item.contextValue = 'newChat';
        return item;
    }

    createModelSection() {
        const chatState = this.state.getChatState();
        const item = new vscode.TreeItem('AI Models', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('symbol-misc');
        item.description = chatState.currentModel || 'default';
        item.contextValue = 'modelSection';
        return item;
    }

    createHistorySection() {
        const chatState = this.state.getChatState();
        const count = chatState.history?.length || 0;
        const item = new vscode.TreeItem('Chat History', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('history');
        item.description = `${count} messages`;
        item.contextValue = 'historySection';
        return item;
    }

    async getAvailableModels() {
        try {
            const models = await this.backend.listModels();
            return models.map(model => {
                const item = new vscode.TreeItem(model.name, vscode.TreeItemCollapsibleState.None);
                item.description = model.size || 'Local';
                item.iconPath = new vscode.ThemeIcon('symbol-class');
                item.command = {
                    command: 'sudoStudio.selectModel',
                    title: 'Select Model',
                    arguments: [model.name]
                };
                item.contextValue = 'model';
                return item;
            });
        } catch (error) {
            const item = new vscode.TreeItem('default', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            item.contextValue = 'model';
            return [item];
        }
    }

    getChatHistory() {
        const chatState = this.state.getChatState();
        const history = chatState.history || [];
        
        return history.slice(-10).reverse().map((entry, index) => {
            const preview = entry.user?.substring(0, 50) || 'Message';
            const item = new vscode.TreeItem(preview, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('comment');
            item.tooltip = entry.user;
            item.contextValue = 'historyItem';
            return item;
        });
    }
}

module.exports = { ChatProvider };
