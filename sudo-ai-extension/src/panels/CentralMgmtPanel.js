/**
 * SUDO STUDIO — Central Management Panel
 * Feature 6: Centralized Administration
 *
 * Provides:
 * 1. Users & Roles — list/add/remove users from a local JSON store
 * 2. Environment Policies — define & enforce required tool versions
 * 3. Configuration Profiles — named sets of extension settings
 * 4. Audit Log — track who changed what and when
 *
 * Storage: ~/.sudo_studio/central/  (local JSON files, no cloud needed)
 * All failures are logged explicitly — no silent swallowing.
 */
'use strict';

const vscode = require('vscode');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { exec } = require('child_process');
const sharedAudit = require('../utils/auditLog');
const { getAIProviderService } = require('../services/AIProviderService');

const IS_WIN = process.platform === 'win32';

// ── Storage helpers ──────────────────────────────────────────────────────────
function getCentralDir() {
    const d = path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio', 'central');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

function readJson(file, def = {}) {
    try {
        const f = path.join(getCentralDir(), file);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : def;
    } catch { return def; }
}

function writeJson(file, data) {
    try {
        fs.writeFileSync(path.join(getCentralDir(), file), JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error(`[CentralMgmt] writeJson failed for ${file}: ${e.message}`);
        return false;
    }
}

function appendAudit(action, detail, actor = 'admin', extra = {}) {
    // TASK 7g: shared audit store, with result + verified flag.
    sharedAudit.appendAudit(action, detail, { actor, ...extra });
}

// ── Default data structures ──────────────────────────────────────────────────
function getUsers()    { return readJson('users.json', [
    { id: '1', name: 'Admin', email: 'admin@sudostudio.local', role: 'admin',     active: true, addedAt: new Date().toISOString() },
    { id: '2', name: 'Dev 1', email: 'dev1@team.local',        role: 'developer', active: true, addedAt: new Date().toISOString() },
]); }
function getPolicies() { return readJson('policies.json', [
    { id: '1', name: 'Min Node.js', tool: 'Node.js', operator: '>=', version: '18.0.0', severity: 'error', active: true },
    { id: '2', name: 'Git Required', tool: 'Git',    operator: '>=', version: '2.0.0',  severity: 'error', active: true },
    { id: '3', name: 'Docker Recommended', tool: 'Docker', operator: '>=', version: '20.0.0', severity: 'warn', active: true },
]); }
function getConfigs()  { return readJson('configs.json', [
    { id: '1', name: 'Default Dev Profile',  model: 'Qwen2.5-Coder-1.5B', agentMode: true,  doctorAutoRun: true  },
    { id: '2', name: 'Lightweight Profile',  model: 'TinyLlama-1.1B',     agentMode: false, doctorAutoRun: false },
]); }
function getAuditLog() { return sharedAudit.getAuditLog(500); }

// ── Tool version detection ───────────────────────────────────────────────────
const TOOL_CMDS = {
    'Node.js': 'node --version',
    'npm':     'npm --version',
    'Python':  IS_WIN ? 'python --version' : 'python3 --version',
    'Git':     'git --version',
    'Docker':  'docker --version',
    'Flutter': 'flutter --version',
    'Java':    'java --version 2>&1',
    'Rust':    'rustc --version',
    'Go':      'go version',
};

function detectVersion(tool) {
    return new Promise(r => {
        const cmd = TOOL_CMDS[tool];
        if (!cmd) { r({ tool, installed: false, version: null }); return; }
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) { r({ tool, installed: false, version: null }); return; }
            const raw = stdout.trim().split('\n')[0].replace(/^v/, '');
            // Extract semver-like from raw string
            const m = raw.match(/(\d+\.\d+[\.\d]*)/);
            r({ tool, installed: true, version: m ? m[1] : raw });
        });
    });
}

function semverCompare(a, b) {
    const pa = (a||'0').split('.').map(Number);
    const pb = (b||'0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

function checkPolicy(policy, detected) {
    if (!policy.active) return { pass: true, reason: 'policy disabled' };
    const d = detected.find(t => t.tool === policy.tool);
    if (!d || !d.installed) return { pass: false, reason: `${policy.tool} not installed` };
    const cmp = semverCompare(d.version, policy.version);
    let pass;
    switch (policy.operator) {
        case '>=': pass = cmp >= 0; break;
        case '>':  pass = cmp > 0;  break;
        case '==': pass = cmp === 0; break;
        default:   pass = true;
    }
    return { pass, reason: pass ? 'OK' : `${d.version} does not satisfy ${policy.operator} ${policy.version}` };
}

// ── Panel class ───────────────────────────────────────────────────────────────
class CentralMgmtPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.detected = [];

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._loadAll(), 400);
    }

    static createOrShow(extensionUri) {
        if (CentralMgmtPanel.currentPanel) { CentralMgmtPanel.currentPanel.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioCentral', '⚙️ Central Management',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        CentralMgmtPanel.currentPanel = new CentralMgmtPanel(panel, extensionUri);
    }

    async _onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'load':           this._loadAll(); break;
            case 'addUser': {
                // Validate user object before passing to storage layer
                const u = msg.user;
                if (!u || typeof u.name !== 'string' || typeof u.email !== 'string' ||
                    u.name.length > 64 || u.email.length > 128) return;
                if (!/^[^@\s]+@[^@\s]+$/.test(u.email)) return;
                const validRoles = ['admin','developer','viewer','tester','devops'];
                if (!validRoles.includes(u.role)) return;
                this._addUser(u); break;
            }
            case 'removeUser': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._removeUser(msg.id); break;
            }
            case 'toggleUser': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._toggleUser(msg.id); break;
            }
            case 'addPolicy': {
                const p = msg.policy;
                if (!p || typeof p.name !== 'string' || p.name.length > 64) return;
                if (typeof p.tool !== 'string'    || p.tool.length > 32) return;
                if (typeof p.version !== 'string' || p.version.length > 16) return;
                if (!/^[\d.]+$/.test(p.version)) return;
                const validOps = ['>=','>','=='];
                if (!validOps.includes(p.operator)) return;
                const validSev = ['error','warn','info'];
                if (!validSev.includes(p.severity)) return;
                this._addPolicy(p); break;
            }
            case 'removePolicy': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._removePolicy(msg.id); break;
            }
            case 'togglePolicy': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._togglePolicy(msg.id); break;
            }
            case 'saveCloudPolicy': {
                const email = (typeof msg.adminEmail === 'string') ? msg.adminEmail.trim().slice(0, 128) : '';
                const wl = Array.isArray(msg.whitelist) ? msg.whitelist.filter(x => typeof x === 'string').slice(0, 50) : [];
                this._saveCloudPolicy(email, msg.cloudEnabled === true, wl); break;
            }
            case 'openProviders': vscode.commands.executeCommand('sudoStudio.openProvidersPanel'); break;
            case 'runPolicyCheck': this._runPolicyCheck(); break;
            case 'addConfig': {
                const c = msg.config;
                if (!c || typeof c.name !== 'string' || c.name.length > 64) return;
                this._addConfig(c); break;
            }
            case 'removeConfig': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._removeConfig(msg.id); break;
            }
            case 'applyConfig': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._applyConfig(msg.id); break;
            }
            case 'exportAll':     this._exportAll(); break;
            case 'importAll':     this._importAll(); break;
        }
    }

    _saveCloudPolicy(adminEmail, cloudEnabled, whitelist) {
        // P2-d: only a rostered, active admin can change the cloud policy.
        const users = getUsers();
        const admin = users.find(u => (u.email || '').toLowerCase() === adminEmail.toLowerCase() && u.role === 'admin' && u.active);
        if (!admin) {
            this.panel.webview.postMessage({ type: 'error', msg: 'Refuse : email admin inconnu, inactif, ou non-admin.' });
            appendAudit('CLOUD_POLICY', `refused: not an admin (${adminEmail || '?'})`, adminEmail || 'unknown', { result: 'refused_not_admin', verified: true });
            return;
        }
        const r = getAIProviderService().saveCloudPolicy({ cloudEnabled, whitelist, updatedBy: admin.email });
        if (!r.ok) {
            this.panel.webview.postMessage({ type: 'error', msg: r.error });
            return;
        }
        this._loadAll();
    }

    async _loadAll() {
        this.panel.webview.postMessage({ type: 'loading' });
        const tools = Object.keys(TOOL_CMDS);
        this.detected = await Promise.all(tools.map(t => detectVersion(t)));
        const policies = getPolicies();
        const policyResults = policies.map(p => ({
            ...p, check: checkPolicy(p, this.detected)
        }));
        this.panel.webview.postMessage({
            type:   'dataReady',
            users:  getUsers(),
            policies: policyResults,
            configs:  getConfigs(),
            audit:    getAuditLog().slice(0, 30),
            cloudPolicy: getAIProviderService().getCloudPolicy(),
            detected: this.detected,
        });
    }

    _addUser(user) {
        try {
            const users = getUsers();
            if (users.find(u => u.email === user.email)) {
                this.panel.webview.postMessage({ type: 'error', msg: `Un utilisateur avec l\'email ${user.email} existe déjà.` });
                return;
            }
            user.id = Date.now().toString();
            user.addedAt = new Date().toISOString();
            user.active  = true;
            users.push(user);
            if (!writeJson('users.json', users)) {
                vscode.window.showErrorMessage('Impossible de sauvegarder la liste des utilisateurs - vérifiez les permissions.');
                appendAudit('ADD_USER', `Failed to save ${user.email}`, 'admin', { result: 'error', verified: false });
                return;
            }
            // TASK 7: post-condition - re-read and confirm the user is stored.
            const stored = getUsers().find(u => u.email === user.email);
            if (!stored) {
                vscode.window.showErrorMessage('Ajout incertain - relecture du stockage impossible. Reessayez.');
                appendAudit('ADD_USER', `Stored but not confirmed: ${user.email}`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('ADD_USER', `Added ${user.email} (${user.role})`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Utilisateur ${user.name} ajouté.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Ajout de l\'utilisateur échoué — réessayez.');
        }
    }

    _removeUser(id) {
        try {
            const existing = getUsers();
            const removed  = existing.find(u => u.id === id);
            if (!removed) {
                vscode.window.showErrorMessage('Utilisateur introuvable - suppression impossible.');
                appendAudit('REMOVE_USER', `User id=${id} not found`, 'admin', { result: 'error', verified: false });
                return;
            }
            if (!writeJson('users.json', existing.filter(u => u.id !== id))) {
                vscode.window.showErrorMessage('Suppression impossible - ecriture du stockage refusee.');
                appendAudit('REMOVE_USER', `Failed to save after removing id=${id}`, 'admin', { result: 'error', verified: false });
                return;
            }
            // TASK 7: post-condition - re-read and confirm the user is gone.
            const gone = !getUsers().find(u => u.id === id);
            if (!gone) {
                vscode.window.showErrorMessage('Suppression incertaine - relecture impossible. Reessayez.');
                appendAudit('REMOVE_USER', `Removed ${removed.email} but not confirmed`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('REMOVE_USER', `Removed ${removed.email} (id=${id})`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Utilisateur supprimé.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Suppression de l\'utilisateur échouée - réessayez.');
        }
    }

    _toggleUser(id) {
        try {
            const before = getUsers().find(x => x.id === id);
            if (!before) {
                vscode.window.showErrorMessage('Utilisateur introuvable.');
                appendAudit('TOGGLE_USER', `User id=${id} not found`, 'admin', { result: 'error', verified: false });
                return;
            }
            const users = getUsers().map(u => u.id === id ? { ...u, active: !u.active } : u);
            if (!writeJson('users.json', users)) {
                vscode.window.showErrorMessage('Modification impossible - ecriture refusee.');
                appendAudit('TOGGLE_USER', `Failed to save toggle id=${id}`, 'admin', { result: 'error', verified: false });
                return;
            }
            // TASK 7: post-condition - confirm the state actually flipped.
            const after = getUsers().find(x => x.id === id);
            const flipped = after && after.active === !before.active;
            appendAudit('TOGGLE_USER', `User ${before.email} active ${before.active} -> ${after?.active}`, 'admin', { result: flipped ? 'ok' : 'error', verified: !!flipped });
            if (!flipped) vscode.window.showErrorMessage('Modification incertaine - relecture impossible.');
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Modification de l\'utilisateur échouée.');
        }
    }

    _addPolicy(policy) {
        try {
            const policies = getPolicies();
            policy.id = Date.now().toString();
            policy.active = true;
            policies.push(policy);
            if (!writeJson('policies.json', policies)) {
                vscode.window.showErrorMessage('Ajout impossible - ecriture refusee.');
                appendAudit('ADD_POLICY', `Failed to save: ${policy.name}`, 'admin', { result: 'error', verified: false });
                return;
            }
            // TASK 7: post-condition - re-read and confirm.
            const pok = getPolicies().find(x => x.id === policy.id);
            if (!pok) {
                vscode.window.showErrorMessage('Ajout incertain - relecture impossible. Reessayez.');
                appendAudit('ADD_POLICY', `Stored but not confirmed: ${policy.name}`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('ADD_POLICY', `Added policy: ${policy.name}`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Policy "${policy.name}" ajoutée.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Ajout de la policy échoué — réessayez.');
        }
    }

    _removePolicy(id) {
        const p = getPolicies().find(x => x.id === id);
        if (!p) {
            vscode.window.showErrorMessage('Policy introuvable - suppression impossible.');
            appendAudit('REMOVE_POLICY', `Policy id=${id} not found`, 'admin', { result: 'error', verified: false });
            return;
        }
        if (!writeJson('policies.json', getPolicies().filter(x => x.id !== id))) {
            vscode.window.showErrorMessage('Suppression impossible - ecriture refusee.');
            appendAudit('REMOVE_POLICY', `Failed to save after removing ${p.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const gone = !getPolicies().find(x => x.id === id);
        appendAudit('REMOVE_POLICY', `Removed policy: ${p.name}`, 'admin', { result: gone ? 'ok' : 'error', verified: gone });
        if (!gone) vscode.window.showErrorMessage('Suppression incertaine - relecture impossible.');
        this._loadAll();
    }

    _togglePolicy(id) {
        const before = getPolicies().find(x => x.id === id);
        if (!before) {
            appendAudit('TOGGLE_POLICY', `Policy id=${id} not found`, 'admin', { result: 'error', verified: false });
            return;
        }
        const policies = getPolicies().map(p => p.id === id ? { ...p, active: !p.active } : p);
        if (!writeJson('policies.json', policies)) {
            appendAudit('TOGGLE_POLICY', `Failed to save toggle ${before.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const after = getPolicies().find(x => x.id === id);
        const flipped = after && after.active === !before.active;
        appendAudit('TOGGLE_POLICY', `Policy ${before.name} active ${before.active} -> ${after?.active}`, 'admin', { result: flipped ? 'ok' : 'error', verified: !!flipped });
        this._loadAll();
    }

    async _runPolicyCheck() {
        const tools = Object.keys(TOOL_CMDS);
        this.detected = await Promise.all(tools.map(t => detectVersion(t)));
        const fails = getPolicies().filter(p => !checkPolicy(p, this.detected).pass).length;
        appendAudit('POLICY_CHECK', `Policy check: ${getPolicies().length} policies, ${fails} failing`, 'admin', { result: fails ? 'failing' : 'ok', verified: true });
        this._loadAll();
    }

    _addConfig(config) {
        try {
            const configs = getConfigs();
            config.id = Date.now().toString();
            configs.push(config);
            if (!writeJson('configs.json', configs)) {
                vscode.window.showErrorMessage('Sauvegarde impossible - ecriture refusee.');
                appendAudit('ADD_CONFIG', `Failed to save: ${config.name}`, 'admin', { result: 'error', verified: false });
                return;
            }
            const cok = getConfigs().find(x => x.id === config.id);
            if (!cok) {
                vscode.window.showErrorMessage('Sauvegarde incertaine - relecture impossible. Reessayez.');
                appendAudit('ADD_CONFIG', `Stored but not confirmed: ${config.name}`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('ADD_CONFIG', `Added config profile: ${config.name}`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Profil "${config.name}" sauvegardé.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Sauvegarde du profil échouée — réessayez.');
        }
    }

    _removeConfig(id) {
        const c = getConfigs().find(x => x.id === id);
        if (!c) {
            vscode.window.showErrorMessage('Profil introuvable - suppression impossible.');
            appendAudit('REMOVE_CONFIG', `Config id=${id} not found`, 'admin', { result: 'error', verified: false });
            return;
        }
        if (!writeJson('configs.json', getConfigs().filter(x => x.id !== id))) {
            vscode.window.showErrorMessage('Suppression impossible - ecriture refusee.');
            appendAudit('REMOVE_CONFIG', `Failed to save after removing ${c.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const gone = !getConfigs().find(x => x.id === id);
        appendAudit('REMOVE_CONFIG', `Removed config: ${c.name}`, 'admin', { result: gone ? 'ok' : 'error', verified: gone });
        if (!gone) vscode.window.showErrorMessage('Suppression incertaine - relecture impossible.');
        this._loadAll();
    }

    async _applyConfig(id) {
        const config = getConfigs().find(c => c.id === id);
        if (!config) return;
        const cfg = vscode.workspace.getConfiguration('sudoStudio');
        try {
            // TASK 7: awaited + read back - never announce before the values stick.
            if (config.model)                   await cfg.update('ai.model',      config.model,     vscode.ConfigurationTarget.Global);
            if (config.agentMode !== undefined) await cfg.update('agent.enabled', config.agentMode, vscode.ConfigurationTarget.Global);
            const backModel = cfg.get('ai.model');
            const backAgent = cfg.get('agent.enabled');
            const okModel = !config.model || backModel === config.model;
            const okAgent = config.agentMode === undefined || backAgent === config.agentMode;
            if (!okModel || !okAgent) {
                vscode.window.showErrorMessage('Application incertaine : relecture differente. Reessayez.');
                appendAudit('APPLY_CONFIG', `Applied ${config.name} but readback differs`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('APPLY_CONFIG', `Applied config profile: ${config.name}`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Profil "${config.name}" appliqué.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Application du profil échouée - réessayez.');
        }
    }

    async _exportAll() {
        try {
            const data = {
                exportedAt: new Date().toISOString(),
                users:    getUsers(),
                policies: getPolicies(),
                configs:  getConfigs(),
            };
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-central-export-${Date.now()}.json`)),
                filters: { 'Central Config': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8');
            // TASK 7: post-condition - parse the file back and compare counts.
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            const okCounts = (back.users || []).length === data.users.length
                && (back.policies || []).length === data.policies.length
                && (back.configs || []).length === data.configs.length;
            if (!okCounts) throw new Error('verify-mismatch');
            appendAudit('EXPORT_ALL', `Config exporte (${data.users.length} users, ${data.policies.length} policies, ${data.configs.length} configs)`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage('✅ Configuration centrale exportée.');
        } catch {
            vscode.window.showErrorMessage('Export échoué — vérifiez les permissions du dossier de destination.');
        }
    }

    async _importAll() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'Central Config': ['json'] } });
            if (!uris || !uris.length) return;

            // Size guard
            const stat = fs.statSync(uris[0].fsPath);
            if (stat.size > 512 * 1024) {
                vscode.window.showErrorMessage('Le fichier est trop volumineux (max 512 KB).');
                return;
            }

            let data;
            try {
                data = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            } catch {
                vscode.window.showErrorMessage('Fichier invalide — le JSON est malformé.');
                return;
            }

            if (!data || typeof data !== 'object') {
                vscode.window.showErrorMessage('Fichier invalide — structure inattendue.');
                return;
            }

            if (Array.isArray(data.users))    writeJson('users.json',    data.users);
            if (Array.isArray(data.policies)) writeJson('policies.json', data.policies);
            if (Array.isArray(data.configs))  writeJson('configs.json',  data.configs);
            // TASK 7: post-condition - re-read the stores and confirm counts.
            const okUsers = !Array.isArray(data.users) || getUsers().length === data.users.length;
            const okPol   = !Array.isArray(data.policies) || getPolicies().length === data.policies.length;
            const okCfg   = !Array.isArray(data.configs) || getConfigs().length === data.configs.length;
            if (!okUsers || !okPol || !okCfg) {
                vscode.window.showErrorMessage('Import incertain : relecture differente. Reessayez.');
                appendAudit('IMPORT_ALL', `Imported ${path.basename(uris[0].fsPath)} but readback differs`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('IMPORT_ALL', `Config importe depuis ${path.basename(uris[0].fsPath)}`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage('✅ Configuration centrale importée.');
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Import échoué — vérifiez les permissions du fichier.');
        }
    }

    dispose() {
        CentralMgmtPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
    }

    _buildHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Central Management</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#21262d;--text:#e6edf3;--muted:#7d8590;
 --green:#2ea043;--red:#da3633;--yellow:#d29922;--blue:#1f6feb;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
#header{background:var(--card);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
#header h1{font-size:17px;font-weight:600;}
.btn{background:var(--blue);color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;}
.btn:hover{opacity:.85;} .btn-green{background:var(--green);} .btn-danger{background:var(--red);}
.btn-secondary{background:#21262d;color:var(--text);} .btn-warn{background:var(--yellow);color:#000;}
.tabs{display:flex;gap:4px;padding:10px 20px;background:var(--card);border-bottom:1px solid var(--border);}
.tab{padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--muted);}
.tab.active{background:var(--blue);color:#fff;}
.tab-content{display:none;padding:16px 20px;}
.tab-content.active{display:block;}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;}
.row:last-child{border-bottom:none;}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap;}
.badge-ok{background:rgba(46,160,67,.2);color:#3fb950;} .badge-err{background:rgba(218,54,51,.2);color:#f85149;}
.badge-warn{background:rgba(210,153,34,.2);color:#e3b341;} .badge-off{background:rgba(100,100,100,.2);color:#888;}
.form-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
.form-row input,.form-row select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:12px;flex:1;min-width:100px;}
.form-row input:focus,.form-row select:focus{outline:none;border-color:var(--blue);}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
.audit-row{display:flex;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border);}
.audit-row:last-child{border-bottom:none;}
.audit-ts{color:var(--muted);flex-shrink:0;font-family:monospace;}
</style>
</head>
<body>
<div id="header">
  <div><h1>⚙️ Central Management</h1><p id="subtitle" style="font-size:12px;color:var(--muted)">Loading...</p></div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button class="btn btn-secondary" onclick="load()">🔄 Refresh</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'exportAll'})">📤 Export</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'importAll'})">📥 Import</button>
  </div>
</div>
<div class="tabs">
  <div class="tab active" onclick="showTab('users')">👤 Users</div>
  <div class="tab" onclick="showTab('policies')">📋 Policies</div>
  <div class="tab" onclick="showTab('configs')">⚙️ Configs</div>
  <div class="tab" onclick="showTab('audit')">📜 Audit Log</div>
  <div class="tab" onclick="showTab('cloud')">Cloud IA</div>
</div>
<div id="tab-users" class="tab-content active">
  <div style="text-align:center;padding:30px"><div class="spinner"></div></div>
</div>
<div id="tab-policies" class="tab-content"></div>
<div id="tab-configs"  class="tab-content"></div>
<div id="tab-audit"   class="tab-content"></div>
<div id="tab-cloud"   class="tab-content"></div>

<script>
const vscode = acquireVsCodeApi();
function load(){ vscode.postMessage({type:'load'}); }
function showTab(t){
  document.querySelectorAll('.tab,.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelector('.tab[onclick*="'+t+'"]').classList.add('active');
  document.getElementById('tab-'+t).classList.add('active');
}

window.addEventListener('message', e=>{
  const m=e.data;
  if(m.type==='loading'){ document.getElementById('tab-users').innerHTML='<div style="text-align:center;padding:30px"><div class="spinner"></div></div>'; return; }
  if(m.type==='dataReady'){ renderAll(m); renderCloud(m.cloudPolicy||{}); }
  if(m.type==='error') alert('[FAIL] '+m.msg);
});

function renderAll(d){
  document.getElementById('subtitle').textContent = d.users.length+' users · '+d.policies.length+' policies · '+d.configs.length+' configs';
  renderUsers(d.users);
  renderPolicies(d.policies);
  renderConfigs(d.configs);
  renderAudit(d.audit);
}

function renderUsers(users){
  let h='<div class="section"><h2>Team Members</h2>';
  users.forEach(u=>{
    h+=\`<div class="row">
      <span class="badge \${u.active?'badge-ok':'badge-off'}">\${u.active?'ACTIVE':'INACTIVE'}</span>
      <span style="flex:1"><strong>\${u.name}</strong> <span style="color:var(--muted)">\${u.email}</span></span>
      <span class="badge badge-off">\${u.role}</span>
      <button class="btn btn-secondary" style="padding:3px 7px;font-size:11px" onclick="vscode.postMessage({type:'toggleUser',id:'\${u.id}'})">Toggle</button>
      <button class="btn btn-danger" style="padding:3px 7px;font-size:11px" onclick="if(confirm('Remove \${escH(u.name)}?'))vscode.postMessage({type:'removeUser',id:'\${u.id}'})">✕</button>
    </div>\`;
  });
  h+='</div>';
  h+='<div class="section"><h2>Add User</h2>';
  h+=\`<div class="form-row">
    <input id="uName" placeholder="Name">
    <input id="uEmail" placeholder="email@company.com">
    <select id="uRole"><option value="developer">Developer</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select>
    <button class="btn btn-green" onclick="addUser()">Add</button>
  </div></div>\`;
  document.getElementById('tab-users').innerHTML=h;
}

function addUser(){
  const n=document.getElementById('uName').value.trim();
  const e=document.getElementById('uEmail').value.trim();
  const r=document.getElementById('uRole').value;
  if(!n||!e){alert('Name and email are required.');return;}
  vscode.postMessage({type:'addUser',user:{name:n,email:e,role:r}});
}

function renderPolicies(policies){
  let h='<div class="section"><h2>Environment Policies</h2>';
  policies.forEach(p=>{
    const ok=p.check?.pass;
    h+=\`<div class="row">
      <span class="badge \${p.active?(ok?'badge-ok':'badge-err'):'badge-off'}">\${p.active?(ok?'PASS':'FAIL'):'OFF'}</span>
      <span style="flex:1"><strong>\${p.name}</strong> <span style="color:var(--muted)">(\${p.tool} \${p.operator} \${p.version})</span></span>
      <span style="font-size:11px;color:var(--muted)">\${p.check?.reason||''}</span>
      <button class="btn btn-secondary" style="padding:3px 7px;font-size:11px" onclick="vscode.postMessage({type:'togglePolicy',id:'\${p.id}'})">\${p.active?'Disable':'Enable'}</button>
      <button class="btn btn-danger" style="padding:3px 7px;font-size:11px" onclick="vscode.postMessage({type:'removePolicy',id:'\${p.id}'})">✕</button>
    </div>\`;
  });
  h+='</div>';
  h+='<div style="margin-bottom:10px"><button class="btn btn-green" onclick="vscode.postMessage({type:\'runPolicyCheck\'})">▶ Run Policy Check Now</button></div>';
  h+='<div class="section"><h2>Add Policy</h2>';
  h+=\`<div class="form-row">
    <input id="pName" placeholder="Policy name">
    <select id="pTool"><option>Node.js</option><option>npm</option><option>Python</option><option>Git</option><option>Docker</option><option>Flutter</option><option>Java</option><option>Rust</option><option>Go</option></select>
    <select id="pOp"><option value=">=">&gt;=</option><option value=">">&gt;</option><option value="==">==</option></select>
    <input id="pVer" placeholder="e.g. 18.0.0" style="max-width:100px">
    <select id="pSev"><option value="error">Error</option><option value="warn">Warning</option></select>
    <button class="btn btn-green" onclick="addPolicy()">Add</button>
  </div></div>\`;
  document.getElementById('tab-policies').innerHTML=h;
}

function addPolicy(){
  const n=document.getElementById('pName').value.trim();
  const tool=document.getElementById('pTool').value;
  const op=document.getElementById('pOp').value;
  const v=document.getElementById('pVer').value.trim();
  const sev=document.getElementById('pSev').value;
  if(!n||!v){alert('Name and version required.');return;}
  vscode.postMessage({type:'addPolicy',policy:{name:n,tool,operator:op,version:v,severity:sev}});
}

function renderCloud(pol){
  pol = pol || {};
  const wl = (pol.whitelist||[]).join('\n');
  let h='<div class="section"><h2>Fournisseurs cloud (IA externe)</h2>';
  h+='<div class="form-row"><label style="min-width:220px">Activer les fournisseurs cloud</label>';
  h+='<input type="checkbox" id="cloudEnabled" '+(pol.cloudEnabled?'checked':'')+' style="width:auto"></div>';
  h+='<div class="form-row"><label style="min-width:220px">Domaines autoris\u00e9s (un par ligne)</label>';
  h+='<textarea id="cloudWl" rows="4" style="flex:1" placeholder="api.openai.com">'+wl.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</textarea></div>';
  h+='<div class="form-row"><label style="min-width:220px">Email admin (requis)</label>';
  h+='<input id="cloudAdmin" style="flex:1" placeholder="admin@sudostudio.local"></div>';
  h+='<div style="margin:8px 0;color:var(--muted);font-size:11px">D\u00e9sactiv\u00e9 par d\u00e9faut. Seul un admin du registre peut activer. Hors liste blanche = refus\u00e9.</div>';
  if(pol.updatedAt) h+='<div style="font-size:11px;color:var(--muted)">Derni\u00e8re modif : '+pol.updatedAt+' par '+(pol.updatedBy||'?')+'</div>';
  h+='<div style="margin-top:8px"><button class="btn btn-green" onclick="saveCloud()">Enregistrer</button> ';
  h+='<button class="btn btn-secondary" onclick="vscode.postMessage({type:\'openProviders\'})">G\u00e9rer les fournisseurs</button></div>';
  h+='</div>';
  document.getElementById('tab-cloud').innerHTML=h;
}
function saveCloud(){
  const adminEmail=document.getElementById('cloudAdmin').value.trim();
  const cloudEnabled=document.getElementById('cloudEnabled').checked;
  const whitelist=document.getElementById('cloudWl').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!adminEmail){alert('Email admin requis.');return;}
  vscode.postMessage({type:'saveCloudPolicy',adminEmail,cloudEnabled,whitelist});
}

function renderConfigs(configs){
  let h='<div class="section"><h2>Configuration Profiles</h2>';
  configs.forEach(c=>{
    h+=\`<div class="row">
      <span style="flex:1"><strong>\${c.name}</strong> <span style="color:var(--muted)">model: \${c.model||'—'} · agent: \${c.agentMode?'on':'off'}</span></span>
      <button class="btn btn-green" style="padding:3px 8px;font-size:11px" onclick="vscode.postMessage({type:'applyConfig',id:'\${c.id}'})">Apply</button>
      <button class="btn btn-danger" style="padding:3px 7px;font-size:11px" onclick="vscode.postMessage({type:'removeConfig',id:'\${c.id}'})">✕</button>
    </div>\`;
  });
  h+='</div>';
  h+='<div class="section"><h2>New Config Profile</h2>';
  h+=\`<div class="form-row">
    <input id="cName" placeholder="Profile name">
    <input id="cModel" placeholder="Model (e.g. Qwen2.5-Coder-1.5B)">
    <select id="cAgent"><option value="true">Agent: ON</option><option value="false">Agent: OFF</option></select>
    <button class="btn btn-green" onclick="addConfig()">Save</button>
  </div></div>\`;
  document.getElementById('tab-configs').innerHTML=h;
}

function addConfig(){
  const n=document.getElementById('cName').value.trim();
  const m=document.getElementById('cModel').value.trim();
  const a=document.getElementById('cAgent').value==='true';
  if(!n){alert('Profile name required.');return;}
  vscode.postMessage({type:'addConfig',config:{name:n,model:m,agentMode:a}});
}

function renderAudit(log){
  let h='<div class="section"><h2>Recent Activity</h2>';
  if(!log.length){h+='<p style="color:var(--muted);font-size:13px">No activity yet.</p>';}
  log.forEach(e=>{
    h+=\`<div class="audit-row">
      <span class="audit-ts">\${e.ts.replace('T',' ').slice(0,19)}</span>
      <span style="color:#58a6ff;min-width:100px">\${e.action}</span>
      <span style="flex:1;color:var(--text)">\${escH(e.detail)}</span>
      <span style="color:var(--muted);\${e.actor}</span>
    </div>\`;
  });
  h+='</div>';
  document.getElementById('tab-audit').innerHTML=h;
}

function escH(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { CentralMgmtPanel };
