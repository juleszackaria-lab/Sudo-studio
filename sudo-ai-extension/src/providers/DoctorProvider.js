const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class DoctorProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
        
        // Listen to system state changes
        this.state.on('system:update', () => this.refresh());
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
                this.createRunDoctorItem(),
                this.createScoreSection(),
                this.createIssuesSection()
            ];
        }

        if (element.contextValue === 'issuesSection') {
            return this.getIssues();
        }

        return [];
    }

    createRunDoctorItem() {
        const item = new vscode.TreeItem('Run System Diagnostic', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.command = {
            command: 'sudoStudio.runDoctor',
            title: 'Run Doctor'
        };
        item.contextValue = 'runDoctor';
        return item;
    }

    createScoreSection() {
        const systemState = this.state.getSystemState();
        const score = systemState.score;
        
        const item = new vscode.TreeItem('System Health', vscode.TreeItemCollapsibleState.None);
        
        if (score !== null && score !== undefined) {
            item.description = `${score}/100`;
            const icon = score >= 80 ? 'check' : score >= 50 ? 'warning' : 'error';
            item.iconPath = new vscode.ThemeIcon(icon);
        } else {
            item.description = 'Not tested';
            item.iconPath = new vscode.ThemeIcon('question');
        }
        
        item.contextValue = 'score';
        return item;
    }

    createIssuesSection() {
        const systemState = this.state.getSystemState();
        const issuesCount = systemState.issues?.length || 0;
        
        const item = new vscode.TreeItem('Issues Detected', vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${issuesCount} found`;
        item.iconPath = new vscode.ThemeIcon(issuesCount > 0 ? 'warning' : 'check');
        item.contextValue = 'issuesSection';
        return item;
    }

    getIssues() {
        const systemState = this.state.getSystemState();
        const issues = systemState.issues || [];
        
        if (issues.length === 0) {
            const item = new vscode.TreeItem('No issues detected', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('check');
            item.contextValue = 'noIssues';
            return [item];
        }
        
        return issues.map(issue => {
            const item = new vscode.TreeItem(issue.title || issue.type, vscode.TreeItemCollapsibleState.None);
            item.description = issue.severity || 'warning';
            item.tooltip = issue.description || issue.message;
            
            const iconMap = {
                'critical': 'error',
                'warning': 'warning',
                'info': 'info'
            };
            item.iconPath = new vscode.ThemeIcon(iconMap[issue.severity] || 'warning');
            
            // Add AutoFix button if fixable
            if (issue.fixable || issue.auto_fixable) {
                item.command = {
                    command: 'sudoStudio.autoFix',
                    title: 'AutoFix',
                    arguments: [issue.type, issue]
                };
            }
            
            item.contextValue = issue.fixable ? 'fixableIssue' : 'issue';
            return item;
        });
    }
}

module.exports = { DoctorProvider };
