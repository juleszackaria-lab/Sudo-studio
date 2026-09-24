const vscode = require('vscode');

/**
 * SecurityProvider — TreeDataProvider for the sudoStudioSecurity sidebar view.
 *
 * Pattern mirrors EnvironmentProvider (sections + quick-action items).
 * Fully static: no backend dependency, so the tree can never be empty
 * due to a service outage. Actions open the full SecurityPanel webview.
 */
class SecurityProvider {
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
            return [
                this.createActionsSection(),
                this.createCoverageSection()
            ];
        }

        if (element.contextValue === 'actionsSection') {
            return this.getActions();
        }

        if (element.contextValue === 'coverageSection') {
            return this.getCoverage();
        }

        return [];
    }

    createActionsSection() {
        const item = new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('shield');
        item.contextValue = 'actionsSection';
        return item;
    }

    createCoverageSection() {
        const item = new vscode.TreeItem('Coverage', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('search');
        item.contextValue = 'coverageSection';
        return item;
    }

    getActions() {
        return [
            this.createActionItem('Run Security Audit', 'sudoStudio.runSecurityAudit', 'shield'),
            this.createActionItem('Open Security Panel', 'sudoStudio.openSecurityPanel', 'lock')
        ];
    }

    getCoverage() {
        // Mirrors what SecurityPanel._runAudit() actually scans.
        return [
            this.createInfoItem('Hardcoded secrets', 'API keys, tokens', 'key'),
            this.createInfoItem('.gitignore gaps', '.env, keys, certs', 'search'),
            this.createInfoItem('npm audit', 'vulnerable deps', 'package')
        ];
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

module.exports = { SecurityProvider };
