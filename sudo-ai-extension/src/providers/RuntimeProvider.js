const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class RuntimeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
        
        // Listen to runtime state changes
        this.state.on('runtime:update', () => this.refresh());
        
        // Refresh every 5 seconds for live metrics
        setInterval(() => this.refresh(), 5000);
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
                this.createStatusSection(),
                this.createModelsSection(),
                this.createMetricsSection(),
                this.createActionsSection()
            ];
        }

        if (element.contextValue === 'statusSection') {
            return this.getStatusDetails();
        }

        if (element.contextValue === 'modelsSection') {
            return this.getModels();
        }

        if (element.contextValue === 'metricsSection') {
            return this.getMetrics();
        }

        if (element.contextValue === 'actionsSection') {
            return this.getActions();
        }

        return [];
    }

    createStatusSection() {
        const runtimeState = this.state.getRuntimeState();
        const item = new vscode.TreeItem('Runtime Status', vscode.TreeItemCollapsibleState.Expanded);
        
        const statusIcon = runtimeState.status === 'healthy' ? 'check' : 
                          runtimeState.status === 'unhealthy' ? 'error' : 'warning';
        item.iconPath = new vscode.ThemeIcon(statusIcon);
        item.description = runtimeState.status || 'unknown';
        item.contextValue = 'statusSection';
        return item;
    }

    createModelsSection() {
        const runtimeState = this.state.getRuntimeState();
        const item = new vscode.TreeItem('AI Models', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-misc');
        item.description = runtimeState.modelLoaded ? runtimeState.modelName : 'None loaded';
        item.contextValue = 'modelsSection';
        return item;
    }

    createMetricsSection() {
        const item = new vscode.TreeItem('Performance Metrics', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('graph');
        item.contextValue = 'metricsSection';
        return item;
    }

    createActionsSection() {
        const item = new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('gear');
        item.contextValue = 'actionsSection';
        return item;
    }

    getStatusDetails() {
        const runtimeState = this.state.getRuntimeState();
        return [
            this.createInfoItem('Status', runtimeState.status || 'Unknown', 
                runtimeState.status === 'healthy' ? 'check' : 'warning'),
            this.createInfoItem('Port', runtimeState.port || '6000', 'plug'),
            this.createInfoItem('Model Loaded', runtimeState.modelLoaded ? 'Yes' : 'No', 
                runtimeState.modelLoaded ? 'check' : 'x'),
            this.createInfoItem('Uptime', this.formatUptime(runtimeState.uptime), 'clock')
        ];
    }

    async getModels() {
        try {
            const models = await this.backend.listModels();
            return models.map(model => {
                const item = new vscode.TreeItem(model.name, vscode.TreeItemCollapsibleState.None);
                item.description = model.size || 'Local';
                item.iconPath = new vscode.ThemeIcon('symbol-class');
                item.tooltip = `${model.name}\nSize: ${model.size || 'Unknown'}`;
                item.contextValue = 'model';
                return item;
            });
        } catch (error) {
            const runtimeState = this.state.getRuntimeState();
            const item = new vscode.TreeItem(
                runtimeState.modelName || 'default', 
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            item.contextValue = 'model';
            return [item];
        }
    }

    getMetrics() {
        const runtimeState = this.state.getRuntimeState();
        return [
            this.createInfoItem('CPU Usage', runtimeState.cpuUsage || 'N/A', 'pulse'),
            this.createInfoItem('RAM Usage', runtimeState.ramUsage || 'N/A', 'database'),
            this.createInfoItem('GPU Usage', runtimeState.gpuUsage || 'N/A', 'cpu'),
            this.createInfoItem('Requests', runtimeState.totalRequests || '0', 'graph'),
            this.createInfoItem('Avg Latency', runtimeState.avgLatency || 'N/A', 'dashboard')
        ];
    }

    getActions() {
        return [
            this.createActionItem('Restart Runtime', 'sudoStudio.restartRuntime', 'refresh'),
            this.createActionItem('View Logs', 'sudoStudio.viewRuntimeLogs', 'output'),
            this.createActionItem('Health Check', 'sudoStudio.checkRuntimeHealth', 'pulse'),
            this.createActionItem('Reload Model', 'sudoStudio.reloadModel', 'sync'),
            this.createActionItem('Clear Cache', 'sudoStudio.clearRuntimeCache', 'trash')
        ];
    }

    createInfoItem(label, value, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = String(value);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = 'info';
        return item;
    }

    createActionItem(label, command, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = {
            command,
            title: label
        };
        item.contextValue = 'action';
        return item;
    }

    formatUptime(seconds) {
        if (!seconds) return 'N/A';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
}

module.exports = { RuntimeProvider };
