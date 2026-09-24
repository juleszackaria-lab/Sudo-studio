const vscode = require('vscode');

/**
 * CentralProvider — TreeDataProvider for the sudoStudioCentral sidebar view.
 *
 * Pattern mirrors EnvironmentProvider (sections + quick-action items).
 * Fully static: no backend dependency, so the tree can never be empty
 * due to a service outage. Actions open the full CentralMgmtPanel webview,
 * which contains Team Members / Policies / Config sections.
 */
class CentralProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            return [this.createActionsSection()];
        }

        if (element.contextValue === 'actionsSection') {
            return this.getActions();
        }

        return [];
    }

    createActionsSection() {
        const item = new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('settings-gear');
        item.contextValue = 'actionsSection';
        return item;
    }

    getActions() {
        return [
            this.createActionItem('Manage Users', 'sudoStudio.openCentralMgmtPanel', 'account'),
            this.createActionItem('Manage Policies', 'sudoStudio.openCentralMgmtPanel', 'settings-gear'),
            this.createActionItem('Open Central Management', 'sudoStudio.openCentralMgmtPanel', 'organization')
        ];
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

module.exports = { CentralProvider };
