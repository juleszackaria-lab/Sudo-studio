const vscode = require('vscode');

/**
 * SudoStudioProvider - TreeDataProvider for the unified "Sudo Studio"
 * sidebar view (P38-c).
 *
 * Single compact tree with the 6 quick-open entries (Chat, Runtime,
 * System Doctor, SDK Manager, DevOps, Project Analysis). Each item opens
 * the same full panel as the former one-button views (Chat history lives
 * on in the Chat panel itself). Fully static: no backend dependency, so
 * the tree can never be empty due to a service outage.
 */
class SudoStudioProvider {
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
        return [
            this.createItem('AI Chat', 'comment-discussion', 'sudoStudio.openChat', 'Open AI Chat'),
            this.createItem('AI Runtime', 'server-process', 'sudoStudio.openRuntimePanel', 'Open AI Runtime'),
            this.createItem('System Doctor', 'pulse', 'sudoStudio.runDoctor', 'Open System Doctor'),
            this.createItem('SDK Manager', 'package', 'sudoStudio.openSDKPanel', 'Open SDK Manager'),
            this.createItem('DevOps', 'rocket', 'sudoStudio.openDevOpsPanel', 'Open DevOps'),
            this.createItem('Project Analysis', 'graph', 'sudoStudio.openAnalysisPanel', 'Open Project Analysis'),
        ];
    }

    createItem(label, icon, command, title) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = { command, title };
        item.contextValue = 'sudoStudioNav';
        item.tooltip = title;
        return item;
    }
}

module.exports = { SudoStudioProvider };
