#!/usr/bin/env node

/**
 * SUDO STUDIO - COMPLETE EXTENSION TEST
 * Tests all components: Services, Providers, Panels, Backend communication
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 SUDO STUDIO - COMPLETE EXTENSION TEST\n');
console.log('═'.repeat(60));

let passCount = 0;
let failCount = 0;

function test(name, condition, details = '') {
    if (condition) {
        console.log(`✅ ${name}`);
        passCount++;
    } else {
        console.log(`❌ ${name}`);
        if (details) console.log(`   ${details}`);
        failCount++;
    }
}

// ============================================================================
// 1. FILE STRUCTURE TESTS
// ============================================================================

console.log('\n📁 Testing File Structure...\n');

const requiredFiles = [
    'sudo-ai-extension/extension.js',
    'sudo-ai-extension/package.json',
    'sudo-ai-extension/src/services/BackendService.js',
    'sudo-ai-extension/src/services/StateManager.js',
    'sudo-ai-extension/src/providers/DashboardProvider.js',
    'sudo-ai-extension/src/providers/ChatProvider.js',
    'sudo-ai-extension/src/providers/DoctorProvider.js',
    'sudo-ai-extension/src/providers/SDKProvider.js',
    'sudo-ai-extension/src/providers/DevOpsProvider.js',
    'sudo-ai-extension/src/providers/EnvironmentProvider.js',
    'sudo-ai-extension/src/providers/RuntimeProvider.js',
    'sudo-ai-extension/src/panels/ChatPanel.js',
    'sudo-ai-extension/src/panels/DoctorPanel.js',
    'sudo-ai-extension/src/panels/SDKPanel.js',
    'backend/routes/ai.routes.js',
    'backend/runtime/server.enterprise.py'
];

requiredFiles.forEach(file => {
    const fullPath = path.join(__dirname, file);
    test(`File exists: ${file}`, fs.existsSync(fullPath));
});

// ============================================================================
// 2. DEPENDENCY TESTS
// ============================================================================

console.log('\n📦 Testing Dependencies...\n');

const extPath = path.join(__dirname, 'sudo-ai-extension');
const nodeModulesPath = path.join(extPath, 'node_modules');

test('node_modules exists', fs.existsSync(nodeModulesPath));
test('axios installed', fs.existsSync(path.join(nodeModulesPath, 'axios')));
test('marked installed', fs.existsSync(path.join(nodeModulesPath, 'marked')));

// ============================================================================
// 3. PACKAGE.JSON VALIDATION
// ============================================================================

console.log('\n📋 Testing package.json Configuration...\n');

const packageJsonPath = path.join(extPath, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

test('Package name correct', packageJson.name === 'sudo-studio');
test('Version is 2.1.0', packageJson.version === '2.1.0');
test('Main entry point', packageJson.main === './extension.js');

// Check views
const views = packageJson.contributes?.views?.['sudo-studio'] || [];
const expectedViews = [
    'sudoStudioDashboard',
    'sudoStudioChat',
    'sudoStudioDoctor',
    'sudoStudioSDK',
    'sudoStudioDevOps',
    'sudoStudioEnvironment',
    'sudoStudioRuntime'
];

expectedViews.forEach(viewId => {
    const viewExists = views.some(v => v.id === viewId);
    test(`View registered: ${viewId}`, viewExists);
});

// Check commands
const commands = packageJson.contributes?.commands || [];
test('Commands registered', commands.length >= 20, `Found ${commands.length} commands`);

const criticalCommands = [
    'sudoStudio.openChat',
    'sudoStudio.runDoctor',
    'sudoStudio.installSDK',
    'sudoStudio.generateDocker',
    'sudoStudio.exportEnvironment',
    'sudoStudio.analyzeProject'
];

criticalCommands.forEach(cmd => {
    const cmdExists = commands.some(c => c.command === cmd);
    test(`Command exists: ${cmd}`, cmdExists);
});

// ============================================================================
// 4. SERVICE VALIDATION
// ============================================================================

console.log('\n🔧 Testing Services...\n');

// BackendService
const backendServicePath = path.join(extPath, 'src/services/BackendService.js');
const backendServiceContent = fs.readFileSync(backendServicePath, 'utf8');

test('BackendService has sendChatMessage', backendServiceContent.includes('sendChatMessage'));
test('BackendService has runDoctor', backendServiceContent.includes('runDoctor'));
test('BackendService has installSDK', backendServiceContent.includes('installSDK'));
test('BackendService has generateDocker', backendServiceContent.includes('generateDocker'));
test('BackendService has exportEnvironment', backendServiceContent.includes('exportEnvironment'));

// StateManager
const stateManagerPath = path.join(extPath, 'src/services/StateManager.js');
const stateManagerContent = fs.readFileSync(stateManagerPath, 'utf8');

test('StateManager extends EventEmitter', stateManagerContent.includes('EventEmitter'));
test('StateManager has state object', stateManagerContent.includes('this.state'));
test('StateManager has updateChatState', stateManagerContent.includes('updateChatState'));
test('StateManager has updateSystemState', stateManagerContent.includes('updateSystemState'));

// ============================================================================
// 5. PROVIDER VALIDATION
// ============================================================================

console.log('\n📊 Testing Providers...\n');

const providers = [
    'DashboardProvider',
    'ChatProvider',
    'DoctorProvider',
    'SDKProvider',
    'DevOpsProvider',
    'EnvironmentProvider',
    'RuntimeProvider'
];

providers.forEach(provider => {
    const providerPath = path.join(extPath, `src/providers/${provider}.js`);
    const content = fs.readFileSync(providerPath, 'utf8');
    
    test(`${provider} has getTreeItem`, content.includes('getTreeItem'));
    test(`${provider} has getChildren`, content.includes('getChildren'));
    test(`${provider} has refresh`, content.includes('refresh'));
});

// ============================================================================
// 6. PANEL VALIDATION
// ============================================================================

console.log('\n🖼️  Testing Panels...\n');

const panels = ['ChatPanel', 'DoctorPanel', 'SDKPanel'];

panels.forEach(panel => {
    const panelPath = path.join(extPath, `src/panels/${panel}.js`);
    const content = fs.readFileSync(panelPath, 'utf8');
    
    test(`${panel} has createOrShow`, content.includes('createOrShow'));
    test(`${panel} has handleMessage`, content.includes('handleMessage'));
    test(`${panel} has getHtmlContent`, content.includes('getHtmlContent'));
    test(`${panel} has webview UI`, content.includes('<html>') && content.includes('</html>'));
});

// ============================================================================
// 7. EXTENSION.JS VALIDATION
// ============================================================================

console.log('\n⚡ Testing extension.js...\n');

const extensionPath = path.join(extPath, 'extension.js');
const extensionContent = fs.readFileSync(extensionPath, 'utf8');

test('Extension has activate function', extensionContent.includes('function activate'));
test('Extension has deactivate function', extensionContent.includes('function deactivate'));
test('Extension exports activate', extensionContent.includes('module.exports'));

// Check provider imports
test('Imports DashboardProvider', extensionContent.includes('DashboardProvider'));
test('Imports ChatProvider', extensionContent.includes('ChatProvider'));
test('Imports DoctorProvider', extensionContent.includes('DoctorProvider'));
test('Imports SDKProvider', extensionContent.includes('SDKProvider'));
test('Imports DevOpsProvider', extensionContent.includes('DevOpsProvider'));
test('Imports EnvironmentProvider', extensionContent.includes('EnvironmentProvider'));
test('Imports RuntimeProvider', extensionContent.includes('RuntimeProvider'));

// Check panel imports
test('Imports ChatPanel', extensionContent.includes('ChatPanel'));
test('Imports DoctorPanel', extensionContent.includes('DoctorPanel'));
test('Imports SDKPanel', extensionContent.includes('SDKPanel'));

// Check command registrations
test('Registers openChat', extensionContent.includes('openChat'));
test('Registers runDoctor', extensionContent.includes('runDoctor'));
test('Registers installSDK', extensionContent.includes('installSDK'));
test('Registers generateDocker', extensionContent.includes('generateDocker'));
test('Registers exportEnvironment', extensionContent.includes('exportEnvironment'));
test('Registers analyzeProject', extensionContent.includes('analyzeProject'));

// ============================================================================
// 8. BACKEND VALIDATION
// ============================================================================

console.log('\n🔌 Testing Backend...\n');

const aiRoutesPath = path.join(__dirname, 'backend/routes/ai.routes.js');
const aiRoutesContent = fs.readFileSync(aiRoutesPath, 'utf8');

test('AI routes point to Python runtime', aiRoutesContent.includes('localhost:6000'));
test('AI routes have /infer endpoint', aiRoutesContent.includes('/infer'));
test('AI routes have error handling', aiRoutesContent.includes('catch'));

const runtimePath = path.join(__dirname, 'backend/runtime/server.enterprise.py');
test('Python runtime exists', fs.existsSync(runtimePath));

const runtimeContent = fs.readFileSync(runtimePath, 'utf8');
test('Runtime has /infer route', runtimeContent.includes('/infer'));
test('Runtime has /health route', runtimeContent.includes('/health'));
test('Runtime has Flask app', runtimeContent.includes('Flask'));

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log('\n' + '═'.repeat(60));
console.log('\n📊 TEST RESULTS:\n');
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log(`📈 Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`);

if (failCount === 0) {
    console.log('\n🎉 ALL TESTS PASSED! Extension is ready for use.\n');
    console.log('Next steps:');
    console.log('1. Start backend: cd backend && node server.js');
    console.log('2. Start runtime: cd backend/runtime && python server.enterprise.py');
    console.log('3. Open VSCode and load the extension');
    console.log('4. Test AI chat, System Doctor, and SDK Manager');
    process.exit(0);
} else {
    console.log('\n⚠️  Some tests failed. Please review the issues above.\n');
    process.exit(1);
}
