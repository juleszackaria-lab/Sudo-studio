const vscode = require('vscode');

/**
 * SDKProvider - TreeDataProvider for the sudoStudioSDK sidebar view.
 *
 * TASK 5: single static item ("Open SDK Manager") that opens the full
 * SDKPanel webview. Fully static: no backend dependency, so the tree can
 * never be empty due to a service outage.
 */
class SDKProvider {
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
        const item = new vscode.TreeItem('Open SDK Manager', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('package');
        item.command = {
            command: 'sudoStudio.openSDKPanel',
            title: 'Open SDK Manager'
        };
        item.contextValue = 'openSDKManager';
        item.tooltip = 'Open the SDK Manager panel';
        return item;
    }
}

module.exports = { SDKProvider };
