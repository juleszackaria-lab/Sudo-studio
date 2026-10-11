const vscode = require('vscode');

/**
 * DoctorProvider - TreeDataProvider for the sudoStudioDoctor sidebar view.
 *
 * TASK 6: single static item ("Open System Doctor") that opens the full
 * DoctorPanel webview (the diagnostic runs and displays in the main page).
 * Fully static: no backend dependency, so the tree can never be empty due
 * to a service outage.
 */
class DoctorProvider {
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
        if (element) {
            return [];
        }
        return [this.createOpenItem()];
    }

    createOpenItem() {
        const item = new vscode.TreeItem('Open System Doctor', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.command = {
            command: 'sudoStudio.runDoctor',
            title: 'Open System Doctor'
        };
        item.contextValue = 'openSystemDoctor';
        item.tooltip = 'Open the System Doctor page';
        return item;
    }
}

module.exports = { DoctorProvider };
