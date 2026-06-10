/**
 * SUDO STUDIO - COMPLETE ENTERPRISE AI PLATFORM
 * Version finale avec tous les panels, providers, et fonctionnalités connectées
 */

const vscode = require('vscode');
const { getBackendService } = require('./src/services/BackendService');
const { getStateManager } = require('./src/services/StateManager');

// Providers
const { DashboardProvider } = require('./src/providers/DashboardProvider');
const { ChatProvider } = require('./src/providers/ChatProvider');
const { DoctorProvider } = require('./src/providers/DoctorProvider');
const { SDKProvider } = require('./src/providers/SDKProvider');
const { DevOpsProvider } = require('./src/providers/DevOpsProvider');
const { EnvironmentProvider } = require('./src/providers/EnvironmentProvider');
const { RuntimeProvider } = require('./src/providers/RuntimeProvider');

// Panels
const { ChatPanel }            = require('./src/panels/ChatPanel');
const { DoctorPanel }          = require('./src/panels/DoctorPanel');
const { SDKPanel }             = require('./src/panels/SDKPanel');
const { RuntimePanel }         = require('./src/panels/RuntimePanel');
const { DevOpsPanel }          = require('./src/panels/DevOpsPanel');
const { ProjectAnalysisPanel } = require('./src/panels/ProjectAnalysisPanel');

// Global instances
let backend, state, context;
let providers = {};

/**
 * Extension activation - POINT D'ENTRÉE PRINCIPAL
 */
async function activate(ctx) {
    context = ctx;
    console.log('🚀 Sudo Studio Enterprise - Activation starting...');

    try {
        // Initialize core services
        backend = getBackendService();
        state = getStateManager();

        // Initialize backend connection
        await initializeBackend();

        // Register all providers
        registerProviders();

        // Register all commands
        registerCommands();

        // Setup event listeners
        setupEventListeners();

        // Show welcome message
        vscode.window.showInformationMessage(
            '🚀 Sudo Studio Enterprise activated! All systems ready.',
            'Open Dashboard'
        ).then(selection => {
            if (selection === 'Open Dashboard') {
                vscode.commands.executeCommand('sudoStudio.openDashboard');
            }
        });

        console.log('✅ Sudo Studio Enterprise fully activated!');
        
    } catch (error) {
        console.error('❌ Activation error:', error);
        vscode.window.showErrorMessage(`Sudo Studio activation failed: ${error.message}`);
    }
}

/**
 * Initialize backend connection and check health
 */
async function initializeBackend() {
    try {
        console.log('🔌 Connecting to backend...');
        const connected = await backend.initialize();
        
        if (connected) {
            console.log('✅ Backend connected');
            vscode.window.showInformationMessage('✅ Backend connected successfully');
            
            // Check runtime status
            try {
                const runtimeHealth = await backend.checkRuntimeHealth();
                const isHealthy = runtimeHealth.status === 'healthy';
                const modelLoaded = runtimeHealth.model_loaded || runtimeHealth.model?.loaded || false;
                const modelName = runtimeHealth.loaded_model || runtimeHealth.model?.name || 'unknown';
                
                state.updateRuntimeState({
                    status: isHealthy ? 'healthy' : 'unhealthy',
                    modelLoaded: modelLoaded,
                    modelName: modelName,
                    port: 6000
                });
                
                if (modelLoaded) {
                    console.log(`✅ AI Runtime ready - Model: ${modelName}`);
                    vscode.window.showInformationMessage(`✅ AI Ready: ${modelName}`);
                } else {
                    console.log('⚠️ AI Runtime healthy but no model loaded');
                    vscode.window.showWarningMessage('⚠️ AI Runtime: No model loaded');
                }
            } catch (runtimeError) {
                console.error('Runtime check error:', runtimeError);
                state.updateRuntimeState({ status: 'offline' });
            }
            
        } else {
            console.log('⚠️ Backend offline');
            vscode.window.showWarningMessage(
                '⚠️ Backend offline. Start with: cd backend && node server.js',
                'Show Instructions'
            ).then(selection => {
                if (selection === 'Show Instructions') {
                    vscode.window.showInformationMessage(
                        'Backend start: cd backend && node server.js\n' +
                        'Runtime start: cd backend/runtime && python server.enterprise.py'
                    );
                }
            });
        }
    } catch (error) {
        console.error('Backend initialization error:', error);
        state.updateBackendState({ connected: false, healthy: false });
        vscode.window.showErrorMessage(`Backend error: ${error.message}`);
    }
}

/**
 * Register all tree view providers
 */
function registerProviders() {
    console.log('📊 Registering providers...');
    
    // Dashboard Provider
    providers.dashboard = new DashboardProvider();
    vscode.window.registerTreeDataProvider('sudoStudioDashboard', providers.dashboard);
    
    // Chat Provider
    providers.chat = new ChatProvider();
    vscode.window.registerTreeDataProvider('sudoStudioChat', providers.chat);
    
    // Doctor Provider
    providers.doctor = new DoctorProvider();
    vscode.window.registerTreeDataProvider('sudoStudioDoctor', providers.doctor);
    
    // SDK Provider
    providers.sdk = new SDKProvider();
    vscode.window.registerTreeDataProvider('sudoStudioSDK', providers.sdk);
    
    // DevOps Provider
    providers.devops = new DevOpsProvider();
    vscode.window.registerTreeDataProvider('sudoStudioDevOps', providers.devops);
    
    // Environment Provider
    providers.environment = new EnvironmentProvider();
    vscode.window.registerTreeDataProvider('sudoStudioEnvironment', providers.environment);
    
    // Runtime Provider
    providers.runtime = new RuntimeProvider();
    vscode.window.registerTreeDataProvider('sudoStudioRuntime', providers.runtime);
    
    console.log('✅ All providers registered');
}

/**
 * Register all extension commands
 */
function registerCommands() {
    console.log('⚡ Registering commands...');
    
    const commands = [
        // Dashboard
        ['sudoStudio.openDashboard', openDashboard],
        ['sudoStudio.refreshDashboard', refreshDashboard],
        
        // AI Chat
        ['sudoStudio.openChat', openChat],
        ['sudoStudio.selectModel', selectModel],
        ['sudoStudio.refreshModels', refreshModels],
        ['sudoStudio.clearChatHistory', clearChatHistory],
        
        // Code Actions
        ['sudoStudio.explainCode', explainCode],
        ['sudoStudio.fixCode', fixCode],
        ['sudoStudio.refactorCode', refactorCode],
        ['sudoStudio.generateCode', generateCode],
        ['sudoStudio.generateTests', generateTests],
        ['sudoStudio.addComments', addComments],
        
        // System Doctor
        ['sudoStudio.runDoctor', runDoctor],
        ['sudoStudio.autoFix', autoFix],
        
        // SDK Management
        ['sudoStudio.installSDK', installSDK],
        ['sudoStudio.refreshSDKs', refreshSDKs],
        ['sudoStudio.openSDKPanel', openSDKPanel],
        
        // DevOps
        ['sudoStudio.generateDocker', generateDocker],
        ['sudoStudio.generateDockerCompose', generateDockerCompose],
        ['sudoStudio.generateCICD', generateCICD],
        ['sudoStudio.generateKubernetes', generateKubernetes],
        ['sudoStudio.buildDocker', buildDocker],
        ['sudoStudio.optimizeDocker', optimizeDocker],
        ['sudoStudio.applyTemplate', applyTemplate],
        
        // Environment
        ['sudoStudio.exportEnvironment', exportEnvironment],
        ['sudoStudio.importEnvironment', importEnvironment],
        ['sudoStudio.createSnapshot', createSnapshot],
        ['sudoStudio.backupEnvironment', backupEnvironment],
        ['sudoStudio.restoreEnvironment', restoreEnvironment],
        ['sudoStudio.cloneEnvironment', cloneEnvironment],
        
        // Runtime
        ['sudoStudio.restartRuntime', restartRuntime],
        ['sudoStudio.viewRuntimeLogs', viewRuntimeLogs],
        ['sudoStudio.checkRuntimeHealth', checkRuntimeHealth],
        ['sudoStudio.reloadModel', reloadModel],
        ['sudoStudio.clearRuntimeCache', clearRuntimeCache],
        
        // Project
        ['sudoStudio.analyzeProject', analyzeProject],

        // New Panels (v3)
        ['sudoStudio.openRuntimePanel',   openRuntimePanel],
        ['sudoStudio.openDevOpsPanel',    openDevOpsPanel],
        ['sudoStudio.openAnalysisPanel',  openAnalysisPanel],
    ];
    
    commands.forEach(([commandName, handler]) => {
        const disposable = vscode.commands.registerCommand(commandName, handler);
        context.subscriptions.push(disposable);
    });
    
    console.log(`✅ ${commands.length} commands registered`);
}

/**
 * Setup event listeners for state changes
 */
function setupEventListeners() {
    // Refresh providers on state changes
    state.on('backend:update', () => {
        providers.dashboard?.refresh();
        providers.runtime?.refresh();
    });
    
    state.on('runtime:update', () => {
        providers.dashboard?.refresh();
        providers.runtime?.refresh();
    });
    
    state.on('chat:update', () => {
        providers.chat?.refresh();
    });
    
    state.on('system:update', () => {
        providers.doctor?.refresh();
        providers.sdk?.refresh();
    });
}

// ============================================================================
// COMMAND HANDLERS - Dashboard
// ============================================================================

function openDashboard() {
    vscode.window.showInformationMessage(
        '📊 Dashboard Overview',
        'Open Chat', 'Run Doctor', 'Manage SDKs'
    ).then(selection => {
        if (selection === 'Open Chat') openChat();
        else if (selection === 'Run Doctor') runDoctor();
        else if (selection === 'Manage SDKs') openSDKPanel();
    });
}

function refreshDashboard() {
    providers.dashboard?.refresh();
    vscode.window.showInformationMessage('Dashboard refreshed');
}

// ============================================================================
// COMMAND HANDLERS - AI Chat
// ============================================================================

function openChat() {
    ChatPanel.createOrShow(context.extensionUri, context);
}

async function selectModel(modelName) {
    if (!modelName) {
        // Show model picker
        try {
            const models = await backend.listModels();
            const modelNames = models.map(m => m.name || m);
            const selected = await vscode.window.showQuickPick(modelNames, {
                placeHolder: 'Select AI model'
            });
            if (selected) {
                state.updateChatState({ currentModel: selected });
                vscode.window.showInformationMessage(`Model changed to: ${selected}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list models: ${error.message}`);
        }
    } else {
        state.updateChatState({ currentModel: modelName });
        vscode.window.showInformationMessage(`Model changed to: ${modelName}`);
    }
}

async function refreshModels() {
    try {
        const models = await backend.listModels();
        vscode.window.showInformationMessage(`Found ${models.length} models`);
        providers.chat?.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to refresh models: ${error.message}`);
    }
}

function clearChatHistory() {
    state.clearChatHistory();
    vscode.window.showInformationMessage('Chat history cleared');
}

// ============================================================================
// COMMAND HANDLERS - Code Actions
// ============================================================================

async function explainCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No code selected');
        return;
    }
    
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    
    if (!code) {
        vscode.window.showWarningMessage('Please select code to explain');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is analyzing code...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Explain this code:\n\n\`\`\`\n${code}\n\`\`\``,
                'default'
            );
        });
        
        // Open chat panel with result
        ChatPanel.createOrShow(context.extensionUri, context);
        
        vscode.window.showInformationMessage('Code explanation ready in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to explain code: ${error.message}`);
    }
}

async function fixCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    
    if (!code) {
        vscode.window.showWarningMessage('Please select code to fix');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is fixing code...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Fix any bugs or issues in this code and provide the corrected version:\n\n\`\`\`\n${code}\n\`\`\``,
                'default'
            );
        });
        
        ChatPanel.createOrShow(context.extensionUri, context);
        vscode.window.showInformationMessage('Code fix ready in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to fix code: ${error.message}`);
    }
}

async function refactorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    
    if (!code) {
        vscode.window.showWarningMessage('Please select code to refactor');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is refactoring code...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Refactor this code for better readability and performance:\n\n\`\`\`\n${code}\n\`\`\``,
                'default'
            );
        });
        
        ChatPanel.createOrShow(context.extensionUri, context);
        vscode.window.showInformationMessage('Refactored code ready in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to refactor code: ${error.message}`);
    }
}

async function generateCode() {
    const description = await vscode.window.showInputBox({
        prompt: 'Describe the code you want to generate',
        placeHolder: 'E.g., Create a REST API endpoint for user authentication'
    });
    
    if (!description) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is generating code...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Generate code for: ${description}`,
                'default'
            );
        });
        
        ChatPanel.createOrShow(context.extensionUri, context);
        vscode.window.showInformationMessage('Generated code ready in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate code: ${error.message}`);
    }
}

async function generateTests() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    
    if (!code) {
        vscode.window.showWarningMessage('Please select code to generate tests for');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is generating tests...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Generate comprehensive unit tests for this code:\n\n\`\`\`\n${code}\n\`\`\``,
                'default'
            );
        });
        
        ChatPanel.createOrShow(context.extensionUri, context);
        vscode.window.showInformationMessage('Tests generated in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate tests: ${error.message}`);
    }
}

async function addComments() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    
    if (!code) {
        vscode.window.showWarningMessage('Please select code to add comments');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI is adding comments...',
            cancellable: false
        }, async () => {
            return await backend.sendChatMessage(
                `Add comprehensive comments and documentation to this code:\n\n\`\`\`\n${code}\n\`\`\``,
                'default'
            );
        });
        
        ChatPanel.createOrShow(context.extensionUri, context);
        vscode.window.showInformationMessage('Commented code ready in chat');
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add comments: ${error.message}`);
    }
}

// ============================================================================
// COMMAND HANDLERS - System Doctor
// ============================================================================

async function runDoctor() {
    DoctorPanel.createOrShow(context.extensionUri);
}

async function autoFix(issueType, issue) {
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `AutoFixing: ${issueType}...`,
            cancellable: false
        }, async () => {
            return await backend.autoFix(issueType, issue);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ Fixed: ${result.message}`);
        } else {
            vscode.window.showWarningMessage(`⚠️ Fix failed: ${result.message}`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`❌ AutoFix error: ${error.message}`);
    }
}

// ============================================================================
// COMMAND HANDLERS - SDK Management
// ============================================================================

function openSDKPanel() {
    SDKPanel.createOrShow(context.extensionUri);
}

async function installSDK(sdkName) {
    if (!sdkName) {
        sdkName = await vscode.window.showInputBox({
            prompt: 'Enter SDK name to install',
            placeHolder: 'E.g., Node.js, Python, Flutter, Java'
        });
    }
    
    if (!sdkName) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${sdkName}...`,
            cancellable: false
        }, async () => {
            return await backend.installSDK(sdkName);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ ${sdkName} installed successfully`);
            refreshSDKs();
        } else {
            vscode.window.showWarningMessage(`⚠️ Installation failed: ${result.message}`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`❌ Install error: ${error.message}`);
    }
}

async function refreshSDKs() {
    try {
        await backend.listSDKs();
        providers.sdk?.refresh();
        vscode.window.showInformationMessage('SDK list refreshed');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to refresh SDKs: ${error.message}`);
    }
}

// ============================================================================
// COMMAND HANDLERS - DevOps
// ============================================================================

async function generateDocker() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
    }
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Dockerfile...',
            cancellable: false
        }, async () => {
            return await backend.generateDocker(workspaceFolder.uri.fsPath);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(
                `✅ Dockerfile generated`,
                'View File'
            ).then(selection => {
                if (selection === 'View File') {
                    vscode.workspace.openTextDocument(result.file_path).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate Dockerfile: ${error.message}`);
    }
}

async function generateDockerCompose() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating docker-compose.yml...',
            cancellable: false
        }, async () => {
            return await backend.generateDockerCompose(workspaceFolder.uri.fsPath);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ docker-compose.yml generated`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate docker-compose: ${error.message}`);
    }
}

async function generateCICD(platform = 'github') {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Generating ${platform} CI/CD...`,
            cancellable: false
        }, async () => {
            return await backend.generateCICD(workspaceFolder.uri.fsPath, platform);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ ${platform} CI/CD generated`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate CI/CD: ${error.message}`);
    }
}

async function generateKubernetes(type = 'deployment') {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Generating Kubernetes ${type}...`,
            cancellable: false
        }, async () => {
            return await backend.generateKubernetes(workspaceFolder.uri.fsPath, type);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ Kubernetes ${type} generated`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate Kubernetes: ${error.message}`);
    }
}

async function buildDocker() {
    vscode.window.showInformationMessage('Docker build feature coming soon');
}

async function optimizeDocker() {
    vscode.window.showInformationMessage('Docker optimization feature coming soon');
}

async function applyTemplate(templateType) {
    vscode.window.showInformationMessage(`Applying ${templateType} template - Coming soon`);
}

// ============================================================================
// COMMAND HANDLERS - Environment
// ============================================================================

async function exportEnvironment() {
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Exporting environment...',
            cancellable: false
        }, async () => {
            return await backend.exportEnvironment();
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(
                `✅ Environment exported to ${result.file_path}`,
                'Open File'
            );
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export environment: ${error.message}`);
    }
}

async function importEnvironment() {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Environment Files': ['json', 'env'] }
    });
    
    if (!fileUri || fileUri.length === 0) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Importing environment...',
            cancellable: false
        }, async () => {
            return await backend.importEnvironment(fileUri[0].fsPath);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage('✅ Environment imported successfully');
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to import environment: ${error.message}`);
    }
}

async function createSnapshot() {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter snapshot name',
        placeHolder: 'E.g., before-major-update'
    });
    
    if (!name) return;
    
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Creating snapshot...',
            cancellable: false
        }, async () => {
            return await backend.createSnapshot(name);
        });
        
        if (result.success) {
            vscode.window.showInformationMessage(`✅ Snapshot "${name}" created`);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create snapshot: ${error.message}`);
    }
}

async function backupEnvironment() {
    vscode.window.showInformationMessage('Backup feature coming soon');
}

async function restoreEnvironment() {
    vscode.window.showInformationMessage('Restore feature coming soon');
}

async function cloneEnvironment() {
    vscode.window.showInformationMessage('Clone feature coming soon');
}

// ============================================================================
// COMMAND HANDLERS - Runtime
// ============================================================================

async function restartRuntime() {
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restarting AI Runtime...',
            cancellable: false
        }, async () => {
            return await backend.restartRuntime();
        });
        
        if (result.success) {
            vscode.window.showInformationMessage('✅ Runtime restarted successfully');
            // Refresh runtime status
            setTimeout(() => checkRuntimeHealth(), 2000);
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to restart runtime: ${error.message}`);
    }
}

async function viewRuntimeLogs() {
    try {
        const logs = await backend.getRuntimeLogs();
        const doc = await vscode.workspace.openTextDocument({
            content: logs.join('\n'),
            language: 'log'
        });
        vscode.window.showTextDocument(doc);
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to get runtime logs: ${error.message}`);
    }
}

async function checkRuntimeHealth() {
    try {
        const health = await backend.checkRuntimeHealth();
        const status = health.status || 'unknown';
        const modelLoaded = health.model_loaded || health.model?.loaded || false;
        const modelName = health.loaded_model || health.model?.name || 'none';
        
        state.updateRuntimeState({
            status: status,
            modelLoaded: modelLoaded,
            modelName: modelName
        });
        
        vscode.window.showInformationMessage(
            `Runtime: ${status} | Model: ${modelLoaded ? modelName : 'none'}`
        );
        
    } catch (error) {
        vscode.window.showErrorMessage(`Health check failed: ${error.message}`);
    }
}

async function reloadModel() {
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Reloading AI model...',
            cancellable: false
        }, async () => {
            return await backend.reloadModel();
        });
        
        if (result.success) {
            vscode.window.showInformationMessage('✅ Model reloaded successfully');
            checkRuntimeHealth();
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to reload model: ${error.message}`);
    }
}

async function clearRuntimeCache() {
    try {
        const result = await backend.clearRuntimeCache();
        if (result.success) {
            vscode.window.showInformationMessage('✅ Runtime cache cleared');
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to clear cache: ${error.message}`);
    }
}

// ============================================================================
// COMMAND HANDLERS - Project
// ============================================================================

async function analyzeProject() {
    // Open the full Project Analysis Panel (works locally, no backend needed)
    ProjectAnalysisPanel.createOrShow(context.extensionUri);
}

// ============================================================================
// COMMAND HANDLERS - New Panels v3
// ============================================================================

function openRuntimePanel() {
    RuntimePanel.createOrShow(context.extensionUri);
}

function openDevOpsPanel() {
    DevOpsPanel.createOrShow(context.extensionUri);
}

function openAnalysisPanel() {
    ProjectAnalysisPanel.createOrShow(context.extensionUri);
}

// ============================================================================
// Extension deactivation
// ============================================================================

function deactivate() {
    console.log('Sudo Studio deactivated');
}

module.exports = {
    activate,
    deactivate
};
