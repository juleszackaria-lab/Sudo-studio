const vscode = require('vscode');
const { getBackendService } = require('../services/BackendService');
const { getStateManager } = require('../services/StateManager');

class SDKProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.backend = getBackendService();
        this.state = getStateManager();
        
        // Listen to SDK state changes
        this.state.on('system:update', () => this.refresh());
        
        // Load SDKs on init
        this.refreshSDKs();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    async refreshSDKs() {
        try {
            await this.backend.listSDKs();
        } catch (error) {
            // Silent fail, will show in UI
        }
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            return [
                this.createRefreshItem(),
                this.createInstalledSection(),
                this.createAvailableSection()
            ];
        }

        if (element.contextValue === 'installedSection') {
            return this.getInstalledSDKs();
        }

        if (element.contextValue === 'availableSection') {
            return this.getAvailableSDKs();
        }

        return [];
    }

    createRefreshItem() {
        const item = new vscode.TreeItem('Refresh SDK List', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('refresh');
        item.command = {
            command: 'sudoStudio.refreshSDKs',
            title: 'Refresh'
        };
        item.contextValue = 'refresh';
        return item;
    }

    createInstalledSection() {
        const systemState = this.state.getSystemState();
        const sdks = systemState.sdks || [];
        const installedCount = sdks.filter(sdk => sdk.installed).length;
        
        const item = new vscode.TreeItem('Installed SDKs', vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${installedCount} installed`;
        item.iconPath = new vscode.ThemeIcon('check');
        item.contextValue = 'installedSection';
        return item;
    }

    createAvailableSection() {
        const systemState = this.state.getSystemState();
        const sdks = systemState.sdks || [];
        const availableCount = sdks.filter(sdk => !sdk.installed).length;
        
        const item = new vscode.TreeItem('Available SDKs', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${availableCount} available`;
        item.iconPath = new vscode.ThemeIcon('cloud-download');
        item.contextValue = 'availableSection';
        return item;
    }

    getInstalledSDKs() {
        const systemState = this.state.getSystemState();
        const sdks = systemState.sdks || [];
        const installed = sdks.filter(sdk => sdk.installed);
        
        if (installed.length === 0) {
            const item = new vscode.TreeItem('No SDKs installed', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            item.contextValue = 'empty';
            return [item];
        }
        
        return installed.map(sdk => this.createSDKItem(sdk, true));
    }

    getAvailableSDKs() {
        const systemState = this.state.getSystemState();
        const sdks = systemState.sdks || [];
        const available = sdks.filter(sdk => !sdk.installed);
        
        // Default SDKs if none loaded
        if (sdks.length === 0) {
            return [
                { name: 'Node.js', version: 'Latest LTS', description: 'JavaScript runtime' },
                { name: 'Python', version: '3.11+', description: 'Python interpreter' },
                { name: 'Flutter', version: 'Latest Stable', description: 'Cross-platform framework' },
                { name: 'Java', version: 'JDK 17+', description: 'Java Development Kit' },
                { name: 'Docker', version: 'Latest', description: 'Container platform' },
                { name: 'Git', version: 'Latest', description: 'Version control' },
                { name: 'Rust', version: 'Latest', description: 'Systems programming language' },
                { name: 'Go', version: 'Latest', description: 'Go programming language' }
            ].map(sdk => this.createSDKItem(sdk, false));
        }
        
        return available.map(sdk => this.createSDKItem(sdk, false));
    }

    createSDKItem(sdk, installed) {
        const label = sdk.name || sdk.sdk_name || 'Unknown SDK';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        
        if (installed) {
            item.description = sdk.version || 'Installed';
            item.iconPath = new vscode.ThemeIcon('check');
            item.tooltip = `${label} - ${sdk.version || 'Installed'}\n${sdk.path || ''}`;
            item.contextValue = 'installedSDK';
        } else {
            item.description = sdk.version || 'Not installed';
            item.iconPath = new vscode.ThemeIcon('cloud-download');
            item.tooltip = sdk.description || `Install ${label}`;
            item.command = {
                command: 'sudoStudio.installSDK',
                title: 'Install SDK',
                arguments: [label]
            };
            item.contextValue = 'availableSDK';
        }
        
        return item;
    }
}

module.exports = { SDKProvider };
