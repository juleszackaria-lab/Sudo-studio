const vscode = require('vscode');

/**
 * LicenseProvider — TreeDataProvider for the sudoStudioLicense sidebar view.
 *
 * Pattern mirrors EnvironmentProvider (sections + quick-action items).
 * Fully static: no backend dependency, so the tree can never be empty
 * due to a service outage. Actions open the full LicensePanel webview,
 * which contains Activation / Edition / Seat Allocation sections.
 */
class LicenseProvider {
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
        item.iconPath = new vscode.ThemeIcon('key');
        item.contextValue = 'actionsSection';
        return item;
    }

    getActions() {
        return [
            this.createActionItem('Activate License', 'sudoStudio.openLicensePanel', 'key'),
            this.createActionItem('Manage Seats', 'sudoStudio.openLicensePanel', 'account'),
            this.createActionItem('Open License Management', 'sudoStudio.openLicensePanel', 'lock')
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

module.exports = { LicenseProvider };
