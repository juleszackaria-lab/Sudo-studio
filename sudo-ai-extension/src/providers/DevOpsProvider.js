const vscode = require('vscode');

/**
 * DevOpsProvider - TreeDataProvider for the sudoStudioDevOps sidebar view.
 *
 * TASK 5: single static item ("Open DevOps") that opens the full
 * DevOpsPanel webview. Fully static: no backend dependency, so the tree can
 * never be empty due to a service outage.
 */
class DevOpsProvider {
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
        const item = new vscode.TreeItem('Open DevOps', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('rocket');
        item.command = {
            command: 'sudoStudio.openDevOpsPanel',
            title: 'Open DevOps'
        };
        item.contextValue = 'openDevOps';
        item.tooltip = 'Open the DevOps panel';
        return item;
    }
}

module.exports = { DevOpsProvider };
