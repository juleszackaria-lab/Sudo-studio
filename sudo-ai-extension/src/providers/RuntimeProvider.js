const vscode = require('vscode');

/**
 * RuntimeProvider - TreeDataProvider for the sudoStudioRuntime sidebar view.
 *
 * TASK 6: single static item ("Open Runtime") that opens the full
 * RuntimePanel webview (Runtime & Modeles IA page). Fully static: no
 * backend dependency, so the tree can never be empty due to a service
 * outage. Statuses and metrics live only in the main page.
 */
class RuntimeProvider {
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
        const item = new vscode.TreeItem('Open Runtime', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('server-process');
        item.command = {
            command: 'sudoStudio.openRuntimePanel',
            title: 'Open Runtime'
        };
        item.contextValue = 'openRuntime';
        item.tooltip = 'Open the Runtime & Models page';
        return item;
    }
}

module.exports = { RuntimeProvider };
