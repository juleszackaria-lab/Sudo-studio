'use strict';

/**
 * P47 - Single "Sudo Studio" sidebar tree: pure data model.
 *
 * No vscode dependency: this file is required by backend/tests on plain
 * node (see test-p47-sidebar.js) and rendered by SudoStudioProvider.
 *
 * Rules (owner decision):
 * - P48: tree labels are ENGLISH with NO emoji (group titles + entry
 *   titles; panel webview titles themselves are unchanged);
 * - panel openers use the English panel title without emoji;
 * - named actions keep their spec labels;
 * - every entry fires an EXISTING contributed command (no new logic);
 * - every non-internal command has >= 1 entry; internal commands stay
 *   hidden (palette/context/panel, exactly as before P47).
 *
 * ASCII-only source.
 */

const GROUPS = [
    {
        id: 'agent', label: 'Agent', icon: 'robot',
        entries: [
            { label: 'Sudo Agent', command: 'sudoStudio.openAgentPanel', icon: 'robot' },
            { label: 'Sudo Chat', command: 'sudoStudio.openChat', icon: 'comment-discussion' },
            { label: 'Agent Logs', command: 'sudoStudio.openLogsViewer', icon: 'file-text' },
        ],
    },
    {
        id: 'runtime', label: 'AI Runtime', icon: 'server-process',
        entries: [
            { label: 'Runtime & Models', command: 'sudoStudio.openRuntimePanel', icon: 'server-process' },
            { label: 'AI Providers', command: 'sudoStudio.openProvidersPanel', icon: 'plug' },
        ],
    },
    {
        id: 'projet', label: 'Project', icon: 'graph',
        entries: [
            { label: 'Project Analysis', command: 'sudoStudio.openAnalysisPanel', icon: 'graph' },
        ],
    },
    {
        id: 'env', label: 'Environment', icon: 'server-environment',
        entries: [
            { label: 'Reproducible Environment', command: 'sudoStudio.openEnvironmentPanel', icon: 'server-environment' },
            { label: 'Backup Environment', command: 'sudoStudio.backupEnvironment', icon: 'archive' },
            { label: 'Restore Environment', command: 'sudoStudio.restoreEnvironment', icon: 'history' },
            { label: 'Clone Environment', command: 'sudoStudio.cloneEnvironment', icon: 'repo-clone' },
            { label: 'Create Snapshot', command: 'sudoStudio.createSnapshot', icon: 'save' },
        ],
    },
    {
        id: 'dup', label: 'Duplication', icon: 'copy',
        entries: [
            { label: 'Enterprise Duplication', command: 'sudoStudio.openDuplicationPanel', icon: 'copy' },
        ],
    },
    {
        id: 'secu', label: 'Security', icon: 'shield',
        entries: [
            { label: 'Security Audit', command: 'sudoStudio.openSecurityPanel', icon: 'lock' },
            { label: 'Run Security Audit', command: 'sudoStudio.runSecurityAudit', icon: 'shield' },
            { label: 'Test Coverage', command: 'sudoStudio.openSecurityPanel', icon: 'search' },
        ],
    },
    {
        id: 'outils', label: 'Tools', icon: 'tools',
        entries: [
            { label: 'System Doctor', command: 'sudoStudio.runDoctor', icon: 'pulse' },
            { label: 'SDK Manager', command: 'sudoStudio.openSDKPanel', icon: 'package' },
            { label: 'SDK Install', command: 'sudoStudio.openSdkInstallPanel', icon: 'arrow-down' },
            { label: 'DevOps Automation', command: 'sudoStudio.openDevOpsPanel', icon: 'rocket' },
        ],
    },
    {
        id: 'admin', label: 'Administration', icon: 'organization',
        entries: [
            { label: 'Central Management', command: 'sudoStudio.openCentralMgmtPanel', icon: 'organization' },
            { label: 'Audit Log', command: 'sudoStudio.openAuditLog', icon: 'history' },
            { label: 'License Management', command: 'sudoStudio.openLicensePanel', icon: 'key' },
        ],
    },
    {
        id: 'logs', label: 'Logs', icon: 'output',
        entries: [
            { label: 'Open Logs Folder', command: 'sudoStudio.openLogsFolder', icon: 'folder-opened' },
            { label: 'Export Diagnostics', command: 'sudoStudio.exportDiagnostics', icon: 'export' },
        ],
    },
];

/**
 * Commands with no tree entry. Each stays contributed + registered +
 * handled exactly as before P47 (palette / editor menu / panel button).
 * Reason codes:
 *  dialog   - quickpick / inputbox / progress flow, not a page
 *  popup    - information popup, not a page
 *  ctx      - editor-context action (needs a selection / active editor)
 *  dup      - opens the same panel as another tree entry (same handler)
 *  panel    - equivalent button already inside its panel (+ palette)
 *  palette  - maintenance command, palette only (as before P47)
 *  doc      - opens an untitled editor document, not a panel
 *  layout   - window-layout command, palette only
 */
const INTERNAL_COMMANDS = {
    // popups / dialogs
    'sudoStudio.openDashboard': 'popup',
    'sudoStudio.showBuildInfo': 'popup',
    'sudoStudio.selectModel': 'dialog',
    'sudoStudio.selectAIProvider': 'dialog',
    'sudoStudio.installSDK': 'dialog',
    'sudoStudio.openMcpPanel': 'popup', // P50-1: MCP servers page
    // editor-context actions
    'sudoStudio.explainCode': 'ctx',
    'sudoStudio.fixCode': 'ctx',
    'sudoStudio.refactorCode': 'ctx',
    'sudoStudio.generateCode': 'ctx',
    'sudoStudio.generateTests': 'ctx',
    'sudoStudio.addComments': 'ctx',
    // duplicate openers (same panel already in the tree)
    'sudoAgent.open': 'dup',
    'sudoStudio.analyzeProject': 'dup',
    'sudoStudio.cloneEnterprise': 'dup',
    // panel buttons (+ palette)
    'sudoAgent.stop': 'panel',
    'sudoStudio.autoFix': 'panel',
    'sudoStudio.refreshSDKs': 'panel',
    'sudoStudio.exportEnvironment': 'panel',
    'sudoStudio.importEnvironment': 'panel',
    'sudoStudio.restartRuntime': 'panel',
    'sudoStudio.checkRuntimeHealth': 'panel',
    'sudoStudio.reloadModel': 'panel',
    'sudoStudio.refreshModels': 'panel',
    'sudoStudio.clearChatHistory': 'panel',
    'sudoStudio.generateDocker': 'panel',
    'sudoStudio.generateDockerCompose': 'panel',
    'sudoStudio.generateCICD': 'panel',
    'sudoStudio.generateKubernetes': 'panel',
    // palette-only maintenance
    'sudoStudio.refreshDashboard': 'palette',
    'sudoStudio.clearRuntimeCache': 'palette',
    'sudoStudio.buildDocker': 'palette',
    'sudoStudio.optimizeDocker': 'palette',
    'sudoStudio.applyTemplate': 'palette',
    // other surfaces
    'sudoStudio.viewRuntimeLogs': 'doc',
    'sudoStudio.resetLayout': 'layout',
};

module.exports = { GROUPS, INTERNAL_COMMANDS };
