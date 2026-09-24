const vscode = require('vscode');

/**
 * DuplicationProvider — TreeDataProvider for the sudoStudioDuplication sidebar view.
 *
 * Pattern mirrors EnvironmentProvider (sections + quick-action items).
 * Fully static: no backend dependency, so the tree can never be empty
 * due to a service outage. Actions open the full DuplicationPanel webview,
 * which contains the Export / Import & Compare / Template sections.
 */
class DuplicationProvider {
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
        item.iconPath = new vscode.ThemeIcon('copy');
        item.contextValue = 'actionsSection';
        return item;
    }

    getActions() {
        return [
            this.createActionItem('Export Profile', 'sudoStudio.openDuplicationPanel', 'export'),
            this.createActionItem('Import & Compare', 'sudoStudio.openDuplicationPanel', 'import'),
            this.createActionItem('Clone Enterprise Env', 'sudoStudio.cloneEnterprise', 'repo-clone'),
            this.createActionItem('Open Duplication Panel', 'sudoStudio.openDuplicationPanel', 'package')
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

module.exports = { DuplicationProvider };
