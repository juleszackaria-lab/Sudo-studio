/**
 * SUDO STUDIO - COMPLETE ENTERPRISE AI PLATFORM
 * Version finale avec tous les panels, providers, et fonctionnalités connectées
 */

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const { spawn } = require('child_process');
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
const { EnvironmentPanel }     = require('./src/panels/EnvironmentPanel');

// Global instances
let backend, state, context;
let providers = {};
let statusBarItem = null;       // VSCode status bar for AI state
let runtimePollTimer = null;    // Polls port 6000 every 5s
let runtimeProcess = null;      // Child process for auto-started runtime
let startupProcess = null;      // Child process for start.bat/start.sh

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

        // Status bar for AI runtime
        setupStatusBar(ctx);

        // AUTO-START: Launch runtime automatically via spawn()
        autoStartRuntime();

        // Auto-start runtime model download check
        setTimeout(() => autoEnsureModelDownload(), 3000);

        // Show welcome message — confirmation that Sudo AI is loaded and connected
        vscode.window.showInformationMessage(
            '✅ Sudo AI prêt — Backend et Runtime connectés',
            'Ouvrir Chat', 'Ouvrir Runtime'
        ).then(selection => {
            if (selection === 'Ouvrir Chat') openChat();
            else if (selection === 'Ouvrir Runtime') openRuntimePanel();
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
        ['sudoStudio.openRuntimePanel',      openRuntimePanel],
        ['sudoStudio.openDevOpsPanel',       openDevOpsPanel],
        ['sudoStudio.openAnalysisPanel',     openAnalysisPanel],
        ['sudoStudio.openEnvironmentPanel',  openEnvironmentPanel],
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
// AUTO-START RUNTIME — child_process.spawn()
// ============================================================================

/**
 * Auto-starts the Python AI runtime (port 6000) and Node.js backend (port 5000)
 * via start.bat (Windows) or start.sh (Linux/Mac).
 * 
 * Workflow:
 * 1. Check if port 6000 already responding → skip launch if yes
 * 2. Detect OS → select start.bat or start.sh
 * 3. Detect extension root (where start.bat/start.sh lives)
 * 4. Spawn the startup script
 * 5. Poll port 6000 every 3s for up to 120s
 * 6. Show progress in VS Code notifications + status bar
 * 7. On timeout → show clear error with manual instructions
 */
async function autoStartRuntime() {
    try {
        // First: check if runtime already running
        const alreadyUp = await checkPort(6000, 2000);
        if (alreadyUp) {
            console.log('[AutoStart] Runtime already running on port 6000 - skipping launch');
            return;
        }

        // Find the root directory (where start.bat/start.sh lives)
        // Extension is in: <root>/sudo-ai-extension/
        // Start scripts are in: <root>/
        let rootDir = null;
        
        // Try to find root from extension context
        if (context && context.extensionPath) {
            const extPath = context.extensionPath;
            // Extension path might be <root>/sudo-ai-extension
            const parentDir = path.dirname(extPath);
            if (fs.existsSync(path.join(parentDir, 'start.bat')) || 
                fs.existsSync(path.join(parentDir, 'start.sh'))) {
                rootDir = parentDir;
            } else if (fs.existsSync(path.join(extPath, 'start.bat')) || 
                       fs.existsSync(path.join(extPath, 'start.sh'))) {
                rootDir = extPath;
            }
        }
        
        // Fallback: workspace folder
        if (!rootDir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            if (fs.existsSync(path.join(wsRoot, 'start.bat')) || 
                fs.existsSync(path.join(wsRoot, 'start.sh'))) {
                rootDir = wsRoot;
            }
        }

        if (!rootDir) {
            console.warn('[AutoStart] Could not find root directory with start scripts');
            // Fall back to launching Python runtime directly
            await autoStartRuntimeDirect();
            return;
        }

        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        
        let scriptPath, cmd, args;
        
        if (isWindows) {
            scriptPath = path.join(rootDir, 'start.bat');
            if (!fs.existsSync(scriptPath)) {
                await autoStartRuntimeDirect();
                return;
            }
            cmd = 'cmd.exe';
            args = ['/c', scriptPath];
        } else {
            scriptPath = path.join(rootDir, 'start.sh');
            if (!fs.existsSync(scriptPath)) {
                // Make start.sh executable if it exists
                await autoStartRuntimeDirect();
                return;
            }
            // Ensure executable
            try { fs.chmodSync(scriptPath, '755'); } catch(e) {}
            cmd = '/bin/bash';
            args = [scriptPath];
        }

        console.log(`[AutoStart] Launching startup script: ${scriptPath}`);
        
        // Update status bar
        if (statusBarItem) {
            statusBarItem.text = '$(loading~spin) Sudo AI: démarrage...';
            statusBarItem.tooltip = 'Démarrage automatique du runtime IA en cours...';
        }

        // Show notification
        vscode.window.showInformationMessage(
            '⏳ Démarrage du runtime IA Sudo Studio...',
            'Voir les logs'
        ).then(selection => {
            if (selection === 'Voir les logs') {
                const terminal = vscode.window.createTerminal('Sudo Studio Logs');
                terminal.show();
                if (!isWindows) {
                    terminal.sendText(`tail -f "${rootDir}/logs/runtime.log" 2>/dev/null || echo "Logs not yet available"`);
                }
            }
        });

        // Spawn the startup script (detached so it survives if extension host restarts)
        startupProcess = spawn(cmd, args, {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: rootDir,
            windowsHide: false
        });

        startupProcess.stdout && startupProcess.stdout.on('data', (data) => {
            console.log(`[AutoStart] ${data.toString().trim()}`);
        });

        startupProcess.stderr && startupProcess.stderr.on('data', (data) => {
            console.warn(`[AutoStart] STDERR: ${data.toString().trim()}`);
        });

        startupProcess.on('error', (err) => {
            console.error(`[AutoStart] Process error: ${err.message}`);
        });

        startupProcess.on('exit', (code) => {
            console.log(`[AutoStart] Startup script exited with code: ${code}`);
        });

        // Poll port 6000 every 3 seconds for up to 120 seconds
        await pollForRuntime(120);

    } catch (error) {
        console.error('[AutoStart] Error:', error.message);
    }
}

/**
 * Direct Python runtime launch (fallback when start scripts not found)
 * Launches server.enterprise.py directly via python/python3
 */
async function autoStartRuntimeDirect() {
    try {
        // Find server.enterprise.py
        let runtimeScript = null;
        const possiblePaths = [
            path.join(context.extensionPath, '..', 'backend', 'runtime', 'server.enterprise.py'),
            path.join(context.extensionPath, 'backend', 'runtime', 'server.enterprise.py'),
        ];
        
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            possiblePaths.push(path.join(wsRoot, 'backend', 'runtime', 'server.enterprise.py'));
        }
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                runtimeScript = p;
                break;
            }
        }
        
        if (!runtimeScript) {
            console.warn('[AutoStart] server.enterprise.py not found in expected locations');
            return;
        }

        const isWindows = process.platform === 'win32';
        const pythonCmd = isWindows ? 'python' : 'python3';
        const runtimeDir = path.dirname(runtimeScript);

        console.log(`[AutoStart] Direct launch: ${pythonCmd} ${runtimeScript}`);
        
        if (statusBarItem) {
            statusBarItem.text = '$(loading~spin) Sudo AI: démarrage direct...';
        }

        runtimeProcess = spawn(pythonCmd, [runtimeScript, '--port', '6000'], {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: runtimeDir
        });

        runtimeProcess.stdout && runtimeProcess.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            console.log(`[Runtime] ${msg}`);
        });

        runtimeProcess.stderr && runtimeProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.warn(`[Runtime] ${msg}`);
        });

        runtimeProcess.on('error', (err) => {
            console.error(`[Runtime] Process error: ${err.message}`);
            if (err.code === 'ENOENT') {
                vscode.window.showErrorMessage(
                    '❌ Python non trouvé. Installez Python 3.11+ puis relancez VS Code.',
                    'Télécharger Python'
                ).then(sel => {
                    if (sel === 'Télécharger Python') {
                        vscode.env.openExternal(vscode.Uri.parse('https://python.org/downloads'));
                    }
                });
            }
        });

        runtimeProcess.on('exit', (code) => {
            console.log(`[Runtime] Process exited with code: ${code}`);
            if (code !== 0 && statusBarItem) {
                statusBarItem.text = '$(x) Sudo AI: hors ligne';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            }
        });

        // Poll for runtime
        await pollForRuntime(120);
        
    } catch (error) {
        console.error('[AutoStart Direct] Error:', error.message);
    }
}

/**
 * Check if a port is responding (HTTP GET /health or /)
 */
async function checkPort(port, timeoutMs = 3000) {
    try {
        const urls = [`http://localhost:${port}/health`, `http://localhost:${port}/`];
        for (const url of urls) {
            try {
                await axios.get(url, { timeout: timeoutMs });
                return true;
            } catch (e) {
                if (e.response) return true; // Got a response (even error) = port is open
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Poll port 6000 every 3s for up to maxSeconds
 * Updates status bar with progress
 */
async function pollForRuntime(maxSeconds) {
    const startTime = Date.now();
    const maxMs = maxSeconds * 1000;
    let elapsed = 0;

    console.log(`[AutoStart] Polling port 6000 for up to ${maxSeconds}s...`);

    while (elapsed < maxMs) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        elapsed = Date.now() - startTime;

        const isUp = await checkPort(6000, 2000);
        
        if (isUp) {
            console.log('[AutoStart] ✅ Runtime ready on port 6000!');
            
            if (statusBarItem) {
                statusBarItem.text = '$(loading~spin) Sudo AI: chargement modèle...';
                statusBarItem.tooltip = 'Runtime IA démarré - chargement du modèle...';
                statusBarItem.backgroundColor = undefined;
            }

            vscode.window.showInformationMessage(
                '✅ Sudo Studio prêt ! Le runtime IA répond sur le port 6000.',
                'Ouvrir Chat'
            ).then(sel => {
                if (sel === 'Ouvrir Chat') openChat();
            });

            // Trigger model download if needed
            setTimeout(() => autoEnsureModelDownload(), 2000);
            return;
        }

        // Update progress
        const elapsedSec = Math.round(elapsed / 1000);
        const pct = Math.round((elapsed / maxMs) * 100);
        
        if (statusBarItem) {
            statusBarItem.text = `$(loading~spin) Sudo AI: démarrage ${elapsedSec}s...`;
            statusBarItem.tooltip = `Démarrage en cours... ${elapsedSec}/${maxSeconds}s écoulés`;
        }

        console.log(`[AutoStart] Still waiting... ${elapsedSec}s elapsed`);
    }

    // Timeout reached
    console.error('[AutoStart] ❌ Timeout: runtime not responding after 120s');
    
    if (statusBarItem) {
        statusBarItem.text = '$(x) Sudo AI: timeout';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        statusBarItem.tooltip = 'Démarrage échoué - voir message d\'erreur';
    }

    const isWindows = process.platform === 'win32';
    vscode.window.showErrorMessage(
        '❌ Runtime IA non démarré après 120 secondes.',
        'Lancer manuellement', 'Aide'
    ).then(sel => {
        if (sel === 'Lancer manuellement') {
            const terminal = vscode.window.createTerminal('Sudo Studio Runtime');
            terminal.show();
            if (isWindows) {
                terminal.sendText('cd /d "%~dp0" && start.bat');
            } else {
                terminal.sendText('cd "$(dirname "$0")" && ./start.sh');
            }
        } else if (sel === 'Aide') {
            vscode.window.showInformationMessage(
                'Pour démarrer manuellement:\n' +
                '• Windows: double-cliquez sur start.bat\n' +
                '• Linux/Mac: ./start.sh\n' +
                '• Manuel: cd backend/runtime && python3 server.enterprise.py',
                { modal: true }
            );
        }
    });
}

// ============================================================================
// STATUS BAR + AUTO MODEL DOWNLOAD
// ============================================================================

/**
 * Creates a persistent status bar item at the bottom of VSCode showing
 * the AI runtime state in real-time.
 */
function setupStatusBar(ctx) {
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.command = 'sudoStudio.openRuntimePanel';
    statusBarItem.text   = '$(loading~spin) Sudo AI...';
    statusBarItem.tooltip = 'Sudo Studio AI Runtime — cliquez pour ouvrir';
    statusBarItem.show();
    ctx.subscriptions.push(statusBarItem);

    // Poll runtime every 5 seconds
    runtimePollTimer = setInterval(() => pollRuntimeStatus(), 5000);
    pollRuntimeStatus(); // immediate first check
}

async function pollRuntimeStatus() {
    if (!statusBarItem) return;
    try {
        const r = await axios.get('http://localhost:6000/health', { timeout: 2500 });
        const d = r.data;
        const m = d.model || {};
        if (m.loaded) {
            const short = (m.name || 'IA').split('/').pop().substring(0, 20);
            statusBarItem.text    = `$(check) Sudo AI: ${short}`;
            statusBarItem.tooltip = `IA prête · ${m.name} · ${m.device || 'cpu'}\nCliquez pour ouvrir Runtime`;
            statusBarItem.backgroundColor = undefined;
        } else if (m.loading) {
            const pct = m.download_progress || 0;
            statusBarItem.text    = `$(loading~spin) Sudo AI: chargement ${pct}%`;
            statusBarItem.tooltip = `Téléchargement modèle ${m.name || ''} — ${pct}%\nCliquez pour ouvrir Runtime`;
            statusBarItem.backgroundColor = undefined;
        } else {
            statusBarItem.text    = '$(warning) Sudo AI: aucun modèle';
            statusBarItem.tooltip = 'Runtime actif mais aucun modèle chargé\nCliquez pour télécharger';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        // Refresh runtime provider tree
        providers.runtime?.refresh();
    } catch (_) {
        statusBarItem.text    = '$(x) Sudo AI: hors ligne';
        statusBarItem.tooltip = 'Runtime hors ligne (port 6000)\nVérifiez que runtime.exe est lancé';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}

/**
 * On activation: if runtime is reachable but no model is loaded,
 * automatically trigger model download with user notification.
 */
async function autoEnsureModelDownload() {
    try {
        const r = await axios.get('http://localhost:6000/health', { timeout: 3000 });
        const m = r.data.model || {};
        if (!m.loaded && !m.loading) {
            // Runtime is up but no model — auto-trigger download
            await axios.post('http://localhost:6000/download',
                { model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' },
                { timeout: 5000 }
            );
            vscode.window.showInformationMessage(
                '⬇️ Sudo AI: Téléchargement de TinyLlama (~600MB) démarré automatiquement.',
                'Voir progression'
            ).then(sel => {
                if (sel === 'Voir progression') openRuntimePanel();
            });
            // Update status bar
            if (statusBarItem) {
                statusBarItem.text    = '$(loading~spin) Sudo AI: téléchargement...';
                statusBarItem.tooltip = 'Téléchargement TinyLlama 1.1B en cours...';
                statusBarItem.backgroundColor = undefined;
            }
        }
    } catch (_) {
        // Runtime offline — not an error, start.bat may still be booting
    }
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
// COMMAND HANDLERS - Environment  (LOCAL implementation — no backend needed)
// All operations write/read JSON snapshots to ~/.sudo_studio/snapshots/
// ============================================================================

/** Return the path to the snapshots directory, creating it if needed. */
function getSnapshotsDir() {
    const base = path.join(
        process.env.USERPROFILE || process.env.HOME || require('os').homedir(),
        '.sudo_studio', 'snapshots'
    );
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    return base;
}

/** Collect current environment data into a plain JS object. */
function collectEnvData(label) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const runtimeState = state.getRuntimeState ? state.getRuntimeState() : {};
    const backendState = state.getBackendState ? state.getBackendState() : {};

    const envVars = {};
    ['PATH','NODE_ENV','JAVA_HOME','ANDROID_HOME','FLUTTER_ROOT',
     'PYTHONPATH','GOPATH','CARGO_HOME'].forEach(k => {
        if (process.env[k]) envVars[k] = process.env[k];
    });

    return {
        label:          label || 'snapshot',
        timestamp:      new Date().toISOString(),
        sudoStudioVer:  '1.0.0',
        workspace:      workspaceRoot,
        envVars,
        runtimeState,
        backendState,
        platform:       process.platform,
        nodeVersion:    process.version,
    };
}

async function exportEnvironment() {
    try {
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
                path.join(
                    vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ||
                    require('os').homedir(),
                    `sudo-env-${Date.now()}.json`
                )
            ),
            filters: { 'Environment JSON': ['json'] }
        });
        if (!saveUri) return;

        const data = collectEnvData('manual-export');
        fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8');

        vscode.window.showInformationMessage(
            `✅ Environment exported to ${path.basename(saveUri.fsPath)}`,
            'Open File'
        ).then(sel => {
            if (sel === 'Open File') {
                vscode.workspace.openTextDocument(saveUri.fsPath)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export environment: ${error.message}`);
    }
}

async function importEnvironment() {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Environment JSON': ['json'] }
    });
    if (!fileUri || fileUri.length === 0) return;

    try {
        const raw  = fs.readFileSync(fileUri[0].fsPath, 'utf8');
        const data = JSON.parse(raw);

        if (!data.timestamp || !data.sudoStudioVer) {
            vscode.window.showWarningMessage('⚠️ File does not appear to be a Sudo Studio environment snapshot.');
            return;
        }

        // Apply runtime / backend state if present
        if (data.runtimeState && Object.keys(data.runtimeState).length) {
            state.updateRuntimeState(data.runtimeState);
        }

        const snapshotAge = Math.round(
            (Date.now() - new Date(data.timestamp).getTime()) / 1000 / 60
        );

        vscode.window.showInformationMessage(
            `✅ Environment imported (snapshot from ${snapshotAge} min ago, workspace: ${data.workspace || 'n/a'})`
        );
        providers.dashboard?.refresh();
        providers.runtime?.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to import environment: ${error.message}`);
    }
}

async function createSnapshot() {
    const name = await vscode.window.showInputBox({
        prompt: 'Snapshot name (letters, digits, hyphens)',
        placeHolder: 'before-major-update',
        validateInput: v => /^[\w\-]+$/.test(v) ? null : 'Use only letters, digits, hyphens'
    });
    if (!name) return;

    try {
        const dir  = getSnapshotsDir();
        const ts   = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `${name}_${ts}.json`);
        const data = collectEnvData(name);
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

        vscode.window.showInformationMessage(
            `✅ Snapshot "${name}" saved`,
            'View Snapshots'
        ).then(sel => {
            if (sel === 'View Snapshots') {
                vscode.workspace.openTextDocument(file)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });
        providers.environment?.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create snapshot: ${error.message}`);
    }
}

async function backupEnvironment() {
    // Alias: auto-named snapshot stored in ~/.sudo_studio/snapshots/
    try {
        const dir  = getSnapshotsDir();
        const ts   = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `backup_${ts}.json`);
        const data = collectEnvData('auto-backup');
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        vscode.window.showInformationMessage(`✅ Backup saved: ${path.basename(file)}`);
        providers.environment?.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Backup failed: ${error.message}`);
    }
}

async function restoreEnvironment() {
    try {
        const dir = getSnapshotsDir();
        const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse()
            : [];

        if (files.length === 0) {
            vscode.window.showWarningMessage('No snapshots found. Create one first with "Create Snapshot".');
            return;
        }

        const selected = await vscode.window.showQuickPick(
            files.map(f => ({ label: f, description: path.join(dir, f) })),
            { placeHolder: 'Select snapshot to restore' }
        );
        if (!selected) return;

        const raw  = fs.readFileSync(selected.description, 'utf8');
        const data = JSON.parse(raw);

        if (data.runtimeState && Object.keys(data.runtimeState).length) {
            state.updateRuntimeState(data.runtimeState);
        }

        vscode.window.showInformationMessage(
            `✅ Restored snapshot "${selected.label}" (created: ${data.timestamp || 'unknown'})`
        );
        providers.dashboard?.refresh();
        providers.runtime?.refresh();
        providers.environment?.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Restore failed: ${error.message}`);
    }
}

async function cloneEnvironment() {
    // Export current env to a new file, then let user choose destination
    try {
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
                path.join(
                    require('os').homedir(),
                    `sudo-env-clone-${Date.now()}.json`
                )
            ),
            filters: { 'Environment JSON': ['json'] }
        });
        if (!saveUri) return;

        const data = collectEnvData('clone');
        fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        vscode.window.showInformationMessage(
            `✅ Environment cloned to ${path.basename(saveUri.fsPath)}. ` +
            `Share this file and use Import on another machine.`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Clone failed: ${error.message}`);
    }
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

function openEnvironmentPanel() {
    // Pass auth token from backend service if available
    const authToken = backend ? backend.authToken : null;
    EnvironmentPanel.createOrShow(context.extensionUri, authToken);
}

// ============================================================================
// Extension deactivation
// ============================================================================

function deactivate() {
    if (runtimePollTimer) { clearInterval(runtimePollTimer); runtimePollTimer = null; }
    if (statusBarItem)    { statusBarItem.dispose(); statusBarItem = null; }
    // Kill auto-started processes on extension deactivation
    if (runtimeProcess)   { try { runtimeProcess.kill(); } catch(e) {} runtimeProcess = null; }
    if (startupProcess)   { try { startupProcess.kill(); } catch(e) {} startupProcess = null; }
    console.log('Sudo Studio deactivated');
}

module.exports = {
    activate,
    deactivate
};
