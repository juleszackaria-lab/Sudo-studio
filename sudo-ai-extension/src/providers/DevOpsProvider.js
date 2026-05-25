const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class DevOpsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
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
                this.createDockerSection(),
                this.createCICDSection(),
                this.createKubernetesSection(),
                this.createTemplatesSection()
            ];
        }

        if (element.contextValue === 'dockerSection') {
            return this.getDockerActions();
        }

        if (element.contextValue === 'cicdSection') {
            return this.getCICDActions();
        }

        if (element.contextValue === 'kubernetesSection') {
            return this.getKubernetesActions();
        }

        if (element.contextValue === 'templatesSection') {
            return this.getTemplates();
        }

        return [];
    }

    createDockerSection() {
        const item = new vscode.TreeItem('Docker', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('package');
        item.contextValue = 'dockerSection';
        return item;
    }

    createCICDSection() {
        const item = new vscode.TreeItem('CI/CD', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('git-merge');
        item.contextValue = 'cicdSection';
        return item;
    }

    createKubernetesSection() {
        const item = new vscode.TreeItem('Kubernetes', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('server');
        item.contextValue = 'kubernetesSection';
        return item;
    }

    createTemplatesSection() {
        const item = new vscode.TreeItem('Templates', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.contextValue = 'templatesSection';
        return item;
    }

    getDockerActions() {
        return [
            this.createActionItem('Generate Dockerfile', 'sudoStudio.generateDocker', 'file-code'),
            this.createActionItem('Generate docker-compose.yml', 'sudoStudio.generateDockerCompose', 'file-code'),
            this.createActionItem('Build Docker Image', 'sudoStudio.buildDocker', 'package'),
            this.createActionItem('Optimize Dockerfile', 'sudoStudio.optimizeDocker', 'zap')
        ];
    }

    getCICDActions() {
        return [
            this.createActionItem('Generate GitHub Actions', 'sudoStudio.generateCICD', 'github', ['github']),
            this.createActionItem('Generate GitLab CI', 'sudoStudio.generateCICD', 'file-code', ['gitlab']),
            this.createActionItem('Generate Jenkins Pipeline', 'sudoStudio.generateCICD', 'file-code', ['jenkins']),
            this.createActionItem('Generate CircleCI Config', 'sudoStudio.generateCICD', 'file-code', ['circleci'])
        ];
    }

    getKubernetesActions() {
        return [
            this.createActionItem('Generate Deployment', 'sudoStudio.generateKubernetes', 'server', ['deployment']),
            this.createActionItem('Generate Service', 'sudoStudio.generateKubernetes', 'server', ['service']),
            this.createActionItem('Generate Ingress', 'sudoStudio.generateKubernetes', 'server', ['ingress']),
            this.createActionItem('Generate Full Stack', 'sudoStudio.generateKubernetes', 'server', ['full'])
        ];
    }

    getTemplates() {
        return [
            this.createActionItem('Microservices Template', 'sudoStudio.applyTemplate', 'file-directory', ['microservices']),
            this.createActionItem('Serverless Template', 'sudoStudio.applyTemplate', 'file-directory', ['serverless']),
            this.createActionItem('Monorepo Template', 'sudoStudio.applyTemplate', 'file-directory', ['monorepo']),
            this.createActionItem('Full-Stack Template', 'sudoStudio.applyTemplate', 'file-directory', ['fullstack'])
        ];
    }

    createActionItem(label, command, icon, args = []) {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = {
            command,
            title: label,
            arguments: args
        };
        item.contextValue = 'action';
        return item;
    }
}

module.exports = { DevOpsProvider };
