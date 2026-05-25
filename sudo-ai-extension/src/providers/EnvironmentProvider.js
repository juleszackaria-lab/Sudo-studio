const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class EnvironmentProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
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
                this.createCurrentEnvironmentSection(),
                this.createActionsSection(),
                this.createSnapshotsSection()
            ];
        }

        if (element.contextValue === 'currentEnv') {
            return this.getCurrentEnvironmentDetails();
        }

        if (element.contextValue === 'actionsSection') {
            return this.getActions();
        }

        if (element.contextValue === 'snapshotsSection') {
            return this.getSnapshots();
        }

        return [];
    }

    createCurrentEnvironmentSection() {
        const item = new vscode.TreeItem('Current Environment', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.contextValue = 'currentEnv';
        return item;
    }

    createActionsSection() {
        const item = new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('gear');
        item.contextValue = 'actionsSection';
        return item;
    }

    createSnapshotsSection() {
        const item = new vscode.TreeItem('Snapshots', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('database');
        item.description = '0 saved';
        item.contextValue = 'snapshotsSection';
        return item;
    }

    getCurrentEnvironmentDetails() {
        return [
            this.createInfoItem('OS', process.platform, 'device-desktop'),
            this.createInfoItem('Node.js', process.version, 'symbol-method'),
            this.createInfoItem('Architecture', process.arch, 'cpu'),
            this.createInfoItem('Working Dir', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'None', 'folder')
        ];
    }

    getActions() {
        return [
            this.createActionItem('Export Environment', 'sudoStudio.exportEnvironment', 'export'),
            this.createActionItem('Import Environment', 'sudoStudio.importEnvironment', 'import'),
            this.createActionItem('Create Snapshot', 'sudoStudio.createSnapshot', 'save'),
            this.createActionItem('Backup Environment', 'sudoStudio.backupEnvironment', 'archive'),
            this.createActionItem('Restore Environment', 'sudoStudio.restoreEnvironment', 'history'),
            this.createActionItem('Clone Environment', 'sudoStudio.cloneEnvironment', 'repo-clone')
        ];
    }

    getSnapshots() {
        // TODO: Load from backend
        const item = new vscode.TreeItem('No snapshots available', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'empty';
        return [item];
    }

    createInfoItem(label, value, icon) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = value;
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
}

module.exports = { EnvironmentProvider };
