const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class DashboardProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
        
        // Listen to state changes
        this.state.on('state:change', () => this.refresh());
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            // Root level - show main sections
            return [
                this.createStatusItem(),
                this.createQuickActionsSection(),
                this.createMetricsSection()
            ];
        }

        if (element.contextValue === 'quickActions') {
            return this.getQuickActions();
        }

        if (element.contextValue === 'metrics') {
            return this.getMetrics();
        }

        return [];
    }

    createStatusItem() {
        const backendState = this.state.getBackendState();
        const runtimeState = this.state.getRuntimeState();
        
        const item = new vscode.TreeItem('System Status', vscode.TreeItemCollapsibleState.None);
        
        const backendIcon = backendState.connected ? '$(check)' : '$(x)';
        const runtimeIcon = runtimeState.status === 'healthy' ? '$(check)' : '$(x)';
        
        item.description = `Backend ${backendIcon} | Runtime ${runtimeIcon}`;
        item.iconPath = new vscode.ThemeIcon(
            backendState.connected && runtimeState.status === 'healthy' ? 'check' : 'warning'
        );
        item.contextValue = 'status';
        
        return item;
    }

    createQuickActionsSection() {
        const item = new vscode.TreeItem('Quick Actions', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('zap');
        item.contextValue = 'quickActions';
        return item;
    }

    createMetricsSection() {
        const item = new vscode.TreeItem('Metrics', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('graph');
        item.contextValue = 'metrics';
        return item;
    }

    getQuickActions() {
        return [
            this.createActionItem('Open AI Chat', 'sudoStudio.openChat', 'comment-discussion'),
            this.createActionItem('Run System Doctor', 'sudoStudio.runDoctor', 'pulse'),
            this.createActionItem('Install SDK', 'sudoStudio.installSDK', 'cloud-download'),
            this.createActionItem('Generate Docker', 'sudoStudio.generateDocker', 'file-code'),
            this.createActionItem('Analyze Project', 'sudoStudio.analyzeProject', 'search')
        ];
    }

    getMetrics() {
        const backendState = this.state.getBackendState();
        const runtimeState = this.state.getRuntimeState();
        
        return [
            this.createMetricItem('Backend', backendState.connected ? 'Online' : 'Offline', 
                backendState.connected ? 'check' : 'x'),
            this.createMetricItem('Runtime', runtimeState.status, 
                runtimeState.status === 'healthy' ? 'check' : 'x'),
            this.createMetricItem('Model', runtimeState.modelLoaded ? runtimeState.modelName : 'None', 
                runtimeState.modelLoaded ? 'check' : 'x')
        ];
    }

    createActionItem(label, command, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = {
            command,
            title: label
        };
        return item;
    }

    createMetricItem(label, value, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = value;
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
    }
}

module.exports = { DashboardProvider };
