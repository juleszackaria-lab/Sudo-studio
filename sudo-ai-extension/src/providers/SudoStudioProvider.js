const vscode = require('vscode');
const { GROUPS } = require('../views/sidebarModel');

/**
 * SudoStudioProvider - TreeDataProvider for the single "Sudo Studio"
 * sidebar view (P47).
 *
 * One grouped tree listing every feature exactly once. Each entry fires
 * an EXISTING contributed command (no new logic). Fully static: no
 * backend dependency, so the tree can never be empty due to a service
 * outage. Groups start expanded so the full list is visible at a glance;
 * "Sudo: Reset Layout" collapses them back.
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
        if (!element) {
            return GROUPS.map((g) => this.createGroup(g));
        }
        if (element.contextValue === 'p47group' && element.groupId) {
            const g = GROUPS.find((x) => x.id === element.groupId);
            if (g) return g.entries.map((e) => this.createEntry(e));
        }
        return [];
    }

    createGroup(g) {
        const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(g.icon);
        item.contextValue = 'p47group';
        item.groupId = g.id;
        item.tooltip = g.label;
        return item;
    }

    createEntry(e) {
        const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(e.icon);
        item.command = { command: e.command, title: e.label };
        item.contextValue = 'p47entry';
        item.tooltip = e.label;
        return item;
    }
}

module.exports = { SudoStudioProvider };
