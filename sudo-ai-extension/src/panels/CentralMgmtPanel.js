/**
 * SUDO STUDIO - Central Management Panel (PROMPT 6 rebuild).
 *
 * 4 tabs: Users, Policies, Config, Audit Log.
 * - Every screen fails fast: 10 s max load, then a clear error with a
 *   "Reessayer" button (never an infinite spinner) + clean empty states.
 * - Users: create, deactivate, change role.
 * - Policies: allowed models, cloud on/off + whitelist (P2), agent rules.
 * - Config: organization settings (+ pre-existing AI profiles, kept).
 * - Audit Log: filterable list (user, action, date, result), CSV + JSON export.
 * - Policies are ENFORCED: isModelAllowed() gates RuntimePanel model loads;
 *   cloud-off blocks API key USE (AIProviderService.checkCloudAllowed, P2 -
 *   verified by tests, not changed here).
 * - Every admin action is written to the shared audit log.
 *
 * Storage: ~/.sudo_studio/central/ (local JSON files, no cloud needed).
 * Old tool-version policies (policies.json array) are NOT deleted: on first
 * load they are copied to policies.tools.legacy.json and left untouched.
 * New code below is ASCII-only (pre-existing French strings kept as-is).
 */
'use strict';

const vscode = require('vscode');
const { guardSnippet } = require('../utils/webviewGuard');
const bf = require('../utils/backendFallback'); // P30(d)
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const sharedAudit = require('../utils/auditLog');
const { getAIProviderService } = require('../services/AIProviderService');

const LOAD_TIMEOUT_MS = 10000;   // 6b: max load delay per screen
const AUDIT_SEND = 200;          // entries shipped to the webview (filterable)
const AUDIT_STORE = 500;         // entries kept by the shared store
const VALID_ROLES = ['admin', 'developer', 'viewer', 'tester', 'devops'];
const VALID_TABS = ['users', 'policies', 'config', 'audit'];
const VALID_RULE_TYPES = ['note', 'maxSteps', 'blockTool', 'requireApproval'];

// -- Storage helpers -----------------------------------------------------------
function getCentralDir() {
    const d = path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio', 'central');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

function readJson(file, def) {
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

function appendAudit(action, detail, actor, extra) {
    // Defense in depth: audit must never break the caller (6b: no silent death).
    try { sharedAudit.appendAudit(action, detail, { actor: actor || 'admin', ...(extra || {}) }); }
    catch (e) { console.error('[CentralMgmt] audit failed: ' + e.message); }
}

// -- Users store (shape unchanged) ----------------------------------------------
function getUsers() { return readJson('users.json', [
    { id: '1', name: 'Admin', email: 'admin@sudostudio.local', role: 'admin',     active: true, addedAt: new Date().toISOString() },
    { id: '2', name: 'Dev 1', email: 'dev1@team.local',        role: 'developer', active: true, addedAt: new Date().toISOString() },
]); }

// -- Central policies store: allowed models + agent rules -----------------------
// Empty allowedModels = every model allowed (fail-open default: current
// behavior is preserved until an admin restricts the list).
function getCentralPolicies() {
    const d = readJson('central_policies.json', null);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { allowedModels: [], agentRules: [] };
    return {
        allowedModels: Array.isArray(d.allowedModels) ? d.allowedModels.filter(x => typeof x === 'string') : [],
        agentRules: Array.isArray(d.agentRules) ? d.agentRules.filter(x => x && typeof x === 'object') : [],
    };
}

function saveCentralPolicies(p) {
    return writeJson('central_policies.json', {
        allowedModels: p.allowedModels || [],
        agentRules: p.agentRules || [],
        updatedAt: new Date().toISOString(),
    });
}

// 6d enforcement hook, used by RuntimePanel before any model download/load.
function isModelAllowed(modelId) {
    const list = getCentralPolicies().allowedModels;
    if (!list.length) return true;
    const m = String(modelId || '').trim().toLowerCase();
    if (!m) return false;
    return list.some(a => String(a).trim().toLowerCase() === m);
}

// One-time, non-destructive: old tool-version policies (array shape) are
// preserved to policies.tools.legacy.json and no longer displayed.
function migrateLegacyPolicies() {
    try {
        const dir = getCentralDir();
        const legacyFile = path.join(dir, 'policies.tools.legacy.json');
        if (fs.existsSync(legacyFile)) return;
        if (fs.existsSync(path.join(dir, 'central_policies.json'))) return;
        const oldFile = path.join(dir, 'policies.json');
        if (!fs.existsSync(oldFile)) return;
        const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
        if (!Array.isArray(old)) return;
        fs.writeFileSync(legacyFile, JSON.stringify(old, null, 2), 'utf8');
        appendAudit('POLICY_MIGRATE',
            `Anciennes politiques outils (${old.length}) preservees dans policies.tools.legacy.json`,
            'admin', { result: 'ok', verified: true });
    } catch (e) {
        console.error('[CentralMgmt] migrateLegacyPolicies: ' + e.message);
    }
}

// -- Organization settings -------------------------------------------------------
function getOrg() {
    const d = readJson('org.json', null);
    const base = { orgName: '', defaultRole: 'developer', auditRetentionDays: 365 };
    if (!d || typeof d !== 'object') return base;
    return {
        orgName: typeof d.orgName === 'string' ? d.orgName.slice(0, 80) : '',
        defaultRole: VALID_ROLES.includes(d.defaultRole) ? d.defaultRole : 'developer',
        auditRetentionDays: (Number.isFinite(+d.auditRetentionDays) && +d.auditRetentionDays >= 1 && +d.auditRetentionDays <= 3650)
            ? Math.floor(+d.auditRetentionDays) : 365,
    };
}

// -- AI profiles (pre-existing feature, kept) --------------------------------------
function getConfigs()  { return readJson('configs.json', [
    { id: '1', name: 'Default Dev Profile',  model: 'Qwen2.5-Coder-1.5B', agentMode: true,  doctorAutoRun: true  },
    { id: '2', name: 'Lightweight Profile',  model: 'TinyLlama-1.1B',     agentMode: false, doctorAutoRun: false },
]); }

function getAuditLog() { return sharedAudit.getAuditLog(AUDIT_STORE); }

// -- Audit filter + CSV (pure, shared by panel and tests) ---------------------------
function filterAudit(log, f) {
    f = f || {};
    const user = String(f.user || '').trim().toLowerCase();
    const action = String(f.action || '').trim().toLowerCase();
    const from = String(f.from || '').slice(0, 10);
    const to = String(f.to || '').slice(0, 10);
    const result = String(f.result || '');
    return (Array.isArray(log) ? log : []).filter(e => {
        if (!e || typeof e !== 'object') return false;
        if (user && String(e.actor || '').toLowerCase().indexOf(user) === -1) return false;
        if (action && String(e.action || '').toLowerCase().indexOf(action) === -1) return false;
        const day = String(e.ts || '').slice(0, 10);
        if (from && day && day < from) return false;
        if (to && day && day > to) return false;
        if (result && String(e.result || '') !== result) return false;
        return true;
    });
}

function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildAuditCsv(rows) {
    const lines = ['ts,actor,action,detail,result,verified'];
    for (const e of (rows || [])) {
        lines.push([e.ts, e.actor, e.action, e.detail, e.result, e.verified].map(csvCell).join(','));
    }
    return lines.join('\n');
}

function withTimeout(promise, ms, label) {
    let t = null;
    const gate = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); });
    return Promise.race([promise, gate]).then(
        v => { clearTimeout(t); return v; },
        e => { clearTimeout(t); throw e; });
}

// -- Panel class -------------------------------------------------------------------
class CentralMgmtPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri, initialTab) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this._initialTab = VALID_TABS.includes(initialTab) ? initialTab : null;
        this._loadTimeoutMs = LOAD_TIMEOUT_MS;

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._p30Ensure(), 400);
    }

    static createOrShow(extensionUri, initialTab) {
        if (CentralMgmtPanel.currentPanel) {
            CentralMgmtPanel.currentPanel.panel.reveal();
            if (VALID_TABS.includes(initialTab)) CentralMgmtPanel.currentPanel._postShowTab(initialTab);
            else CentralMgmtPanel.currentPanel._loadAll();
            return CentralMgmtPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioCentral', 'Central Management',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        CentralMgmtPanel.currentPanel = new CentralMgmtPanel(panel, extensionUri, initialTab);
        return CentralMgmtPanel.currentPanel;
    }

    _postShowTab(tab) {
        try { this.panel.webview.postMessage({ type: 'showTab', tab }); } catch (_) {}
    }

    // P30(d): race the load against the 5 s bound; overlay if backend down.
    _p30Ensure() { return bf.ensureBackend(this.panel, () => this._loadAll()); }

    async _onMessage(msg) {
        if (bf.handlePanelMessage(this.panel, msg, () => this._p30Ensure())) return;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'load':           this._p30Ensure(); break;
            case 'retryBackend':   this._retryBackend(); break;
            case 'addUser': {
                const u = msg.user;
                if (!u || typeof u.name !== 'string' || typeof u.email !== 'string' ||
                    u.name.length > 64 || u.email.length > 128) return;
                if (!/^[^@\s]+@[^@\s]+$/.test(u.email)) return;
                if (u.role !== undefined && !VALID_ROLES.includes(u.role)) return;
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
            case 'setUserRole': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                if (!VALID_ROLES.includes(msg.role)) return;
                this._setUserRole(msg.id, msg.role); break;
            }
            case 'addModel': {
                if (typeof msg.model !== 'string') return;
                this._addModel(msg.model); break;
            }
            case 'removeModel': {
                if (typeof msg.model !== 'string') return;
                this._removeModel(msg.model); break;
            }
            case 'addRule': {
                const r = msg.rule;
                if (!r || typeof r.name !== 'string' || r.name.length > 64) return;
                if (!VALID_RULE_TYPES.includes(r.type)) return;
                if (r.value !== undefined && (typeof r.value !== 'string' || r.value.length > 200)) return;
                this._addRule(r); break;
            }
            case 'toggleRule': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._toggleRule(msg.id); break;
            }
            case 'removeRule': {
                if (typeof msg.id !== 'string' || msg.id.length > 32) return;
                this._removeRule(msg.id); break;
            }
            case 'saveCloudPolicy': {
                const email = (typeof msg.adminEmail === 'string') ? msg.adminEmail.trim().slice(0, 128) : '';
                const wl = Array.isArray(msg.whitelist) ? msg.whitelist.filter(x => typeof x === 'string').slice(0, 50) : [];
                this._saveCloudPolicy(email, msg.cloudEnabled === true, wl); break;
            }
            case 'openProviders': vscode.commands.executeCommand('sudoStudio.openProvidersPanel'); break;
            case 'saveOrg': {
                const o = msg.org || {};
                this._saveOrg({
                    orgName: typeof o.orgName === 'string' ? o.orgName.slice(0, 80) : '',
                    defaultRole: VALID_ROLES.includes(o.defaultRole) ? o.defaultRole : 'developer',
                    auditRetentionDays: o.auditRetentionDays,
                });
                break;
            }
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
            case 'exportAudit':   this._exportAudit(msg.format, msg.filters); break;
        }
    }

    // -- guarded load: 10 s max, then error + Retry, never infinite ---------------
    async _loadAll() {
        try { await this.panel.webview.postMessage({ type: 'loading' }); } catch (_) {}
        try {
            const data = await withTimeout(this._fetchAll(), this._loadTimeoutMs, 'load timeout (10 s)');
            data.initialTab = this._initialTab;
            this._initialTab = null;
            try { await this.panel.webview.postMessage({ type: 'dataReady', ...data }); }
            catch (e) { console.error('[CentralMgmt] postMessage dataReady: ' + e.message); }
        } catch (e) {
            const message = (e && e.message) ? String(e.message).slice(0, 200) : 'unknown error';
            appendAudit('CENTRAL_LOAD', 'Echec chargement: ' + message, 'admin', { result: 'error', verified: true });
            try { await this.panel.webview.postMessage({ type: 'loadError', message }); }
            catch (_) { console.error('[CentralMgmt] postMessage loadError failed'); }
        }
    }

    // Pure-data fetch (instance seam: tests override this to fail/hang on purpose).
    async _fetchAll() {
        migrateLegacyPolicies();
        const org = getOrg();
        const cutoff = Date.now() - org.auditRetentionDays * 86400000;
        const audit = getAuditLog()
            .filter(e => { const t = new Date(e.ts).getTime(); return !Number.isFinite(t) || t >= cutoff; })
            .slice(0, AUDIT_SEND);
        let cloudPolicy = null;
        try { cloudPolicy = getAIProviderService().getCloudPolicy(); }
        catch (e) {
            console.error('[CentralMgmt] cloudPolicy unavailable: ' + e.message);
            appendAudit('CENTRAL_LOAD', 'Politique cloud indisponible: ' + e.message, 'admin', { result: 'error', verified: true });
        }
        return {
            users: getUsers(),
            centralPolicies: getCentralPolicies(),
            org,
            configs: getConfigs(),
            audit,
            cloudPolicy,           // null = section cloud indisponible (le reste charge)
            backend: await this._checkBackend(),
        };
    }

    async _checkBackend() {
        try {
            const { BackendService } = require('../services/BackendService');
            const svc = new BackendService();
            await svc.checkHealth();
            return { online: true };
        } catch (e) {
            return { online: false, detail: String((e && e.message) || e).slice(0, 120) };
        }
    }

    async _retryBackend() {
        const st = await this._checkBackend();
        appendAudit('BACKEND_RETRY', 'Test backend manuel: ' + (st.online ? 'en ligne' : 'hors ligne'),
            'admin', { result: st.online ? 'ok' : 'error', verified: true });
        try { await this.panel.webview.postMessage({ type: 'backendStatus', backend: st }); } catch (_) {}
    }

    // -- users ----------------------------------------------------------------------
    _addUser(user) {
        try {
            const org = getOrg();
            const users = getUsers();
            if (users.find(u => u.email.toLowerCase() === user.email.toLowerCase())) {
                this.panel.webview.postMessage({ type: 'error', msg: `Un utilisateur avec l'email ${user.email} existe deja.` });
                appendAudit('ADD_USER', `Refuse (doublon): ${user.email}`, 'admin', { result: 'refused_duplicate', verified: true });
                return;
            }
            const role = VALID_ROLES.includes(user.role) ? user.role : org.defaultRole;
            const nu = { id: Date.now().toString(), name: user.name.trim(), email: user.email.trim(),
                role, active: true, addedAt: new Date().toISOString() };
            users.push(nu);
            if (!writeJson('users.json', users)) {
                vscode.window.showErrorMessage('Impossible de sauvegarder la liste des utilisateurs - vérifiez les permissions.');
                appendAudit('ADD_USER', `Failed to save ${user.email}`, 'admin', { result: 'error', verified: false });
                return;
            }
            const stored = getUsers().find(u => u.email === nu.email);
            if (!stored) {
                vscode.window.showErrorMessage('Ajout incertain - relecture du stockage impossible. Reessayez.');
                appendAudit('ADD_USER', `Stored but not confirmed: ${user.email}`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('ADD_USER', `Added ${nu.email} (${nu.role})`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Utilisateur ${nu.name} ajouté.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage(`Ajout de l'utilisateur échoué - réessayez.`);
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
            if (removed.role === 'admin' && removed.active &&
                !existing.some(u => u.id !== id && u.role === 'admin' && u.active)) {
                vscode.window.showErrorMessage('Refuse : impossible de supprimer le dernier admin actif.');
                appendAudit('REMOVE_USER', `Refuse (dernier admin): ${removed.email}`, 'admin', { result: 'refused_last_admin', verified: true });
                return;
            }
            if (!writeJson('users.json', existing.filter(u => u.id !== id))) {
                vscode.window.showErrorMessage('Suppression impossible - ecriture du stockage refusee.');
                appendAudit('REMOVE_USER', `Failed to save after removing id=${id}`, 'admin', { result: 'error', verified: false });
                return;
            }
            const gone = !getUsers().find(u => u.id === id);
            if (!gone) {
                vscode.window.showErrorMessage('Suppression incertaine - relecture impossible. Reessayez.');
                appendAudit('REMOVE_USER', `Removed ${removed.email} but not confirmed`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('REMOVE_USER', `Removed ${removed.email} (id=${id})`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Utilisateur supprimé.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage(`Suppression de l'utilisateur échouée - réessayez.`);
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
            if (before.role === 'admin' && before.active &&
                !getUsers().some(u => u.id !== id && u.role === 'admin' && u.active)) {
                vscode.window.showErrorMessage('Refuse : impossible de desactiver le dernier admin actif.');
                appendAudit('TOGGLE_USER', `Refuse (dernier admin): ${before.email}`, 'admin', { result: 'refused_last_admin', verified: true });
                return;
            }
            const users = getUsers().map(u => u.id === id ? { ...u, active: !u.active } : u);
            if (!writeJson('users.json', users)) {
                vscode.window.showErrorMessage('Modification impossible - ecriture refusee.');
                appendAudit('TOGGLE_USER', `Failed to save toggle id=${id}`, 'admin', { result: 'error', verified: false });
                return;
            }
            const after = getUsers().find(x => x.id === id);
            const flipped = after && after.active === !before.active;
            appendAudit('TOGGLE_USER', `User ${before.email} active ${before.active} -> ${after && after.active}`, 'admin', { result: flipped ? 'ok' : 'error', verified: !!flipped });
            if (!flipped) vscode.window.showErrorMessage('Modification incertaine - relecture impossible.');
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage(`Modification de l'utilisateur échouée.`);
        }
    }

    _setUserRole(id, role) {
        try {
            const before = getUsers().find(x => x.id === id);
            if (!before) {
                vscode.window.showErrorMessage('Utilisateur introuvable.');
                appendAudit('USER_ROLE', `User id=${id} not found`, 'admin', { result: 'error', verified: false });
                return;
            }
            if (before.role === 'admin' && role !== 'admin' &&
                !getUsers().some(u => u.id !== id && u.role === 'admin' && u.active)) {
                vscode.window.showErrorMessage('Refuse : impossible de retirer le role au dernier admin actif.');
                appendAudit('USER_ROLE', `Refuse (dernier admin): ${before.email}`, 'admin', { result: 'refused_last_admin', verified: true });
                return;
            }
            const users = getUsers().map(u => u.id === id ? { ...u, role } : u);
            if (!writeJson('users.json', users)) {
                vscode.window.showErrorMessage('Modification impossible - ecriture refusee.');
                appendAudit('USER_ROLE', `Failed to save role id=${id}`, 'admin', { result: 'error', verified: false });
                return;
            }
            const after = getUsers().find(x => x.id === id);
            const ok = after && after.role === role;
            appendAudit('USER_ROLE', `User ${before.email} role ${before.role} -> ${role}`, 'admin', { result: ok ? 'ok' : 'error', verified: !!ok });
            if (!ok) vscode.window.showErrorMessage('Modification incertaine - relecture impossible.');
            else vscode.window.showInformationMessage(`Role de ${before.name} : ${role}.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Modification du role echouee.');
        }
    }

    // -- allowed models ---------------------------------------------------------------
    _addModel(model) {
        model = String(model).trim().slice(0, 120);
        if (!model) return;
        const p = getCentralPolicies();
        if (p.allowedModels.some(a => a.toLowerCase() === model.toLowerCase())) {
            this.panel.webview.postMessage({ type: 'error', msg: `Modele deja autorise : ${model}` });
            return;
        }
        p.allowedModels.push(model);
        if (!saveCentralPolicies(p)) {
            vscode.window.showErrorMessage('Ajout impossible - ecriture refusee.');
            appendAudit('MODEL_ALLOW', `Failed to save: ${model}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const ok = getCentralPolicies().allowedModels.some(a => a.toLowerCase() === model.toLowerCase());
        appendAudit('MODEL_ALLOW', `Modele autorise: ${model}`, 'admin', { result: ok ? 'ok' : 'error', verified: !!ok });
        if (!ok) vscode.window.showErrorMessage('Ajout incertain - relecture impossible. Reessayez.');
        else vscode.window.showInformationMessage(`Modele autorise : ${model}.`);
        this._loadAll();
    }

    _removeModel(model) {
        model = String(model).trim().slice(0, 120);
        const p = getCentralPolicies();
        const before = p.allowedModels.length;
        p.allowedModels = p.allowedModels.filter(a => a.toLowerCase() !== model.toLowerCase());
        if (p.allowedModels.length === before) {
            vscode.window.showErrorMessage('Modele introuvable dans la liste.');
            appendAudit('MODEL_REMOVE', `Model not found: ${model}`, 'admin', { result: 'error', verified: false });
            return;
        }
        if (!saveCentralPolicies(p)) {
            vscode.window.showErrorMessage('Suppression impossible - ecriture refusee.');
            appendAudit('MODEL_REMOVE', `Failed to save after removing ${model}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const gone = !getCentralPolicies().allowedModels.some(a => a.toLowerCase() === model.toLowerCase());
        appendAudit('MODEL_REMOVE', `Modele retire de la liste: ${model}`, 'admin', { result: gone ? 'ok' : 'error', verified: gone });
        if (!gone) vscode.window.showErrorMessage('Suppression incertaine - relecture impossible.');
        else vscode.window.showInformationMessage(`Modele retire : ${model}.`);
        this._loadAll();
    }

    // -- agent rules (stored + displayed + audited; see header note) --------------------
    _addRule(rule) {
        const p = getCentralPolicies();
        const nr = { id: Date.now().toString(), name: rule.name.trim(),
            type: rule.type, value: typeof rule.value === 'string' ? rule.value.trim() : '', active: true };
        p.agentRules.push(nr);
        if (!saveCentralPolicies(p)) {
            vscode.window.showErrorMessage('Ajout impossible - ecriture refusee.');
            appendAudit('RULE_ADD', `Failed to save: ${nr.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const ok = !!getCentralPolicies().agentRules.find(x => x.id === nr.id);
        appendAudit('RULE_ADD', `Regle agent ajoutee: ${nr.name} (${nr.type})`, 'admin', { result: ok ? 'ok' : 'error', verified: !!ok });
        if (!ok) vscode.window.showErrorMessage('Ajout incertain - relecture impossible. Reessayez.');
        else vscode.window.showInformationMessage(`Regle ajoutee : ${nr.name}.`);
        this._loadAll();
    }

    _toggleRule(id) {
        const before = getCentralPolicies().agentRules.find(x => x.id === id);
        if (!before) {
            appendAudit('RULE_TOGGLE', `Rule id=${id} not found`, 'admin', { result: 'error', verified: false });
            return;
        }
        const p = getCentralPolicies();
        p.agentRules = p.agentRules.map(r => r.id === id ? { ...r, active: !r.active } : r);
        if (!saveCentralPolicies(p)) {
            appendAudit('RULE_TOGGLE', `Failed to save toggle ${before.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const after = getCentralPolicies().agentRules.find(x => x.id === id);
        const flipped = after && after.active === !before.active;
        appendAudit('RULE_TOGGLE', `Regle ${before.name} active ${before.active} -> ${after && after.active}`, 'admin', { result: flipped ? 'ok' : 'error', verified: !!flipped });
        this._loadAll();
    }

    _removeRule(id) {
        const p = getCentralPolicies();
        const r = p.agentRules.find(x => x.id === id);
        if (!r) {
            vscode.window.showErrorMessage('Regle introuvable - suppression impossible.');
            appendAudit('RULE_REMOVE', `Rule id=${id} not found`, 'admin', { result: 'error', verified: false });
            return;
        }
        p.agentRules = p.agentRules.filter(x => x.id !== id);
        if (!saveCentralPolicies(p)) {
            vscode.window.showErrorMessage('Suppression impossible - ecriture refusee.');
            appendAudit('RULE_REMOVE', `Failed to save after removing ${r.name}`, 'admin', { result: 'error', verified: false });
            return;
        }
        const gone = !getCentralPolicies().agentRules.find(x => x.id === id);
        appendAudit('RULE_REMOVE', `Regle supprimee: ${r.name}`, 'admin', { result: gone ? 'ok' : 'error', verified: gone });
        if (!gone) vscode.window.showErrorMessage('Suppression incertaine - relecture impossible.');
        this._loadAll();
    }

    // -- cloud policy (P2 flow, unchanged logic; UI moved into Policies tab) ------------
    _saveCloudPolicy(adminEmail, cloudEnabled, whitelist) {
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

    // -- organization settings ------------------------------------------------------------
    _saveOrg(o) {
        const days = Math.floor(+o.auditRetentionDays);
        const data = {
            orgName: o.orgName,
            defaultRole: o.defaultRole,
            auditRetentionDays: (Number.isFinite(days) && days >= 1 && days <= 3650) ? days : 365,
            updatedAt: new Date().toISOString(),
        };
        if (!writeJson('org.json', data)) {
            vscode.window.showErrorMessage('Sauvegarde impossible - ecriture refusee.');
            appendAudit('ORG_SAVE', 'Failed to save org settings', 'admin', { result: 'error', verified: false });
            return;
        }
        const back = getOrg();
        const ok = back.orgName === data.orgName && back.defaultRole === data.defaultRole
            && back.auditRetentionDays === data.auditRetentionDays;
        appendAudit('ORG_SAVE', `Parametres org: nom="${data.orgName || '(vide)'}" roleDefaut=${data.defaultRole} retention=${data.auditRetentionDays}j`,
            'admin', { result: ok ? 'ok' : 'error', verified: !!ok });
        if (!ok) vscode.window.showErrorMessage('Sauvegarde incertaine - relecture impossible. Reessayez.');
        else vscode.window.showInformationMessage('Parametres organisation sauvegardes.');
        this._loadAll();
    }

    // -- AI profiles (pre-existing, kept) ----------------------------------------------------
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
            vscode.window.showInformationMessage(`Profil "${config.name}" sauvegardé.`);
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
            vscode.window.showInformationMessage(`Profil "${config.name}" appliqué.`);
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage('Application du profil échouée - réessayez.');
        }
    }

    // -- export / import -----------------------------------------------------------------------
    async _exportAll() {
        try {
            const data = {
                exportedAt: new Date().toISOString(),
                users:    getUsers(),
                policies: getCentralPolicies(),
                org:      getOrg(),
                configs:  getConfigs(),
            };
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-central-export-${Date.now()}.json`)),
                filters: { 'Central Config': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8');
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            const okCounts = (back.users || []).length === data.users.length
                && (back.configs || []).length === data.configs.length;
            if (!okCounts) throw new Error('verify-mismatch');
            appendAudit('EXPORT_ALL', `Config exporte (${data.users.length} users, ${data.configs.length} configs)`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage('Configuration centrale exportée.');
        } catch {
            vscode.window.showErrorMessage('Export échoué — vérifiez les permissions du dossier de destination.');
        }
    }

    async _importAll() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'Central Config': ['json'] } });
            if (!uris || !uris.length) return;
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
            if (Array.isArray(data.configs))  writeJson('configs.json',  data.configs);
            if (data.policies && typeof data.policies === 'object' && !Array.isArray(data.policies)) {
                saveCentralPolicies({ allowedModels: data.policies.allowedModels, agentRules: data.policies.agentRules });
            } else if (Array.isArray(data.policies)) {
                writeJson('policies.tools.legacy.json', data.policies);
                appendAudit('IMPORT_ALL', 'Anciennes politiques outils preservees (legacy)', 'admin', { result: 'ok', verified: true });
            }
            if (data.org && typeof data.org === 'object') {
                writeJson('org.json', { orgName: data.org.orgName || '', defaultRole: data.org.defaultRole || 'developer',
                    auditRetentionDays: data.org.auditRetentionDays || 365, updatedAt: new Date().toISOString() });
            }
            const okUsers = !Array.isArray(data.users) || getUsers().length === data.users.length;
            const okCfg   = !Array.isArray(data.configs) || getConfigs().length === data.configs.length;
            if (!okUsers || !okCfg) {
                vscode.window.showErrorMessage('Import incertain : relecture differente. Reessayez.');
                appendAudit('IMPORT_ALL', `Imported ${path.basename(uris[0].fsPath)} but readback differs`, 'admin', { result: 'error', verified: false });
                return;
            }
            appendAudit('IMPORT_ALL', `Config importe depuis ${path.basename(uris[0].fsPath)}`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage('Configuration centrale importée.');
            this._loadAll();
        } catch {
            vscode.window.showErrorMessage(`Import échoué - vérifiez les permissions du fichier.`);
        }
    }

    // -- audit export (CSV / JSON, with current filters) ------------------------------------------
    async _exportAudit(format, filters) {
        try {
            if (format !== 'csv' && format !== 'json') return;
            const rows = filterAudit(getAuditLog(), filters || {});
            const ext = format === 'csv' ? 'csv' : 'json';
            const content = format === 'csv' ? buildAuditCsv(rows) : JSON.stringify(rows, null, 2);
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-audit-${Date.now()}.${ext}`)),
                filters: format === 'csv' ? { 'CSV': ['csv'] } : { 'JSON': ['json'] },
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, content, 'utf8');
            const back = fs.readFileSync(saveUri.fsPath, 'utf8');
            const ok = format === 'json'
                ? (JSON.parse(back).length === rows.length)
                : (back.split('\n').length === rows.length + 1);
            if (!ok) throw new Error('verify-mismatch');
            appendAudit('AUDIT_EXPORT', `Audit exporte ${ext.toUpperCase()} (${rows.length} lignes)`, 'admin', { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Audit exporte (${rows.length} lignes).`);
        } catch {
            vscode.window.showErrorMessage('Export audit echoue - verifiez les permissions du dossier.');
        }
    }

    dispose() {
        CentralMgmtPanel.currentPanel = undefined;
        try { this.panel.dispose(); } catch (_) {}
        while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
    }

    // -- webview -----------------------------------------------------------------------
    // NOTE (PROMPT 6 root cause): the previous client script never parsed (a bare
    // quote inside a single-quoted string + raw newlines in strings killed the
    // whole <script> block: dead tabs, dead export, infinite spinner). The client
    // code below avoids every such construct: no escaped quotes, no backslash-n
    // (newlines via String.fromCharCode(10)), delegation instead of inline args.
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
.tabs{display:flex;gap:4px;padding:10px 20px;background:var(--card);border-bottom:1px solid var(--border);flex-wrap:wrap;}
.tab{padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--muted);}
.tab.active{background:var(--blue);color:#fff;}
.tab-content{display:none;padding:16px 20px;}
.tab-content.active{display:block;}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;flex-wrap:wrap;}
.row:last-child{border-bottom:none;}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap;}
.badge-ok{background:rgba(46,160,67,.2);color:#3fb950;} .badge-err{background:rgba(218,54,51,.2);color:#f85149;}
.badge-warn{background:rgba(210,153,34,.2);color:#e3b341;} .badge-off{background:rgba(100,100,100,.2);color:#888;}
.form-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;}
.form-row input,.form-row select,.form-row textarea{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:12px;flex:1;min-width:100px;font-family:inherit;}
.form-row input:focus,.form-row select:focus,.form-row textarea:focus{outline:none;border-color:var(--blue);}
.form-row label{font-size:12px;color:var(--muted);min-width:180px;}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
.audit-row{display:flex;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.audit-row:last-child{border-bottom:none;}
.audit-ts{color:var(--muted);flex-shrink:0;font-family:monospace;}
.errbox{border:1px solid var(--red);background:rgba(218,54,51,.08);border-radius:10px;padding:16px;margin:10px 0;font-size:13px;}
.errbox p{margin-bottom:10px;}
.empty{color:var(--muted);font-size:13px;padding:8px 0;}
#errbar{display:none;background:rgba(218,54,51,.12);border-bottom:1px solid var(--red);padding:8px 20px;font-size:12px;}
#backendPill{font-size:11px;}
</style>
</head>
<body>
${guardSnippet()}
<div id="header">
  <div><h1>Central Management</h1><p id="subtitle" style="font-size:12px;color:var(--muted)">Chargement...</p></div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
    <span id="backendPill"><span class="badge badge-off">Backend : ...</span></span>
    <button class="btn btn-secondary" onclick="load()">Actualiser</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'exportAll'})">Export</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'importAll'})">Import</button>
  </div>
</div>
<div id="errbar"></div>
<div class="tabs">
  <div class="tab active" id="tabbtn-users" onclick="showTab('users')">Utilisateurs</div>
  <div class="tab" id="tabbtn-policies" onclick="showTab('policies')">Politiques</div>
  <div class="tab" id="tabbtn-config" onclick="showTab('config')">Config</div>
  <div class="tab" id="tabbtn-audit" onclick="showTab('audit')">Audit Log</div>
</div>
<div id="tab-users" class="tab-content active">
  <div style="text-align:center;padding:30px"><div class="spinner"></div></div>
</div>
<div id="tab-policies" class="tab-content"></div>
<div id="tab-config"  class="tab-content"></div>
<div id="tab-audit"   class="tab-content"></div>
<script>
const vscode = acquireVsCodeApi();
window.__sudoBackendInit && window.__sudoBackendInit(vscode);
const NL = String.fromCharCode(10);
let waiting = false;
let loadTimer = null;
let firstData = true;
let lastData = null;

function load(){
  waiting = true;
  hideErr();
  document.getElementById("tab-users").innerHTML = spinHtml();
  document.getElementById("tab-policies").innerHTML = spinHtml();
  document.getElementById("tab-config").innerHTML = spinHtml();
  document.getElementById("tab-audit").innerHTML = spinHtml();
  vscode.postMessage({type:"load"});
  clearTimeout(loadTimer);
  loadTimer = setTimeout(function(){
    if (!waiting) return;
    waiting = false;
    showLoadError("D\u00e9lai d\u00e9pass\u00e9 (10 s) : le chargement ne r\u00e9pond pas.");
  }, 10000);
}
function spinHtml(){ return "<div style=\\"text-align:center;padding:30px\\"><div class=\\"spinner\\"></div></div>"; }

function showTab(t){
  if (t !== "users" && t !== "policies" && t !== "config" && t !== "audit") return;
  const tabs = ["users", "policies", "config", "audit"];
  for (const x of tabs) {
    document.getElementById("tabbtn-" + x).classList.toggle("active", x === t);
    document.getElementById("tab-" + x).classList.toggle("active", x === t);
  }
}

function showLoadError(msg){
  clearTimeout(loadTimer);
  waiting = false;
  const box = "<div class=\\"errbox\\"><p>" + escH(msg) + "</p>" +
    "<button class=\\"btn btn-green\\" data-act=\\"retry\\">R\u00e9essayer</button></div>";
  for (const x of ["users", "policies", "config", "audit"]) {
    document.getElementById("tab-" + x).innerHTML = box;
  }
  document.getElementById("subtitle").textContent = "Erreur de chargement";
}

function showErr(msg){
  const bar = document.getElementById("errbar");
  bar.style.display = "block";
  bar.textContent = msg;
}
function hideErr(){ document.getElementById("errbar").style.display = "none"; }

window.addEventListener("message", function(e){
  const m = e.data || {};
  if (m.type === "loading") { waiting = true; return; }
  if (m.type === "showTab") { showTab(m.tab); return; }
  if (m.type === "backendStatus") { renderBackend(m.backend); return; }
  if (m.type === "error") { showErr(m.msg || "Erreur"); return; }
  if (m.type === "loadError") { showLoadError(m.message || "Erreur de chargement"); return; }
  if (m.type === "dataReady") {
    clearTimeout(loadTimer);
    waiting = false;
    hideErr();
    lastData = m;
    renderAll(m);
    if (firstData && m.initialTab) showTab(m.initialTab);
    firstData = false;
  }
});

function renderAll(d){
  const org = d.org || {};
  const title = org.orgName ? org.orgName + " \u2014 Central" : "Central Management";
  document.getElementById("subtitle").textContent =
    title + " : " + d.users.length + " utilisateurs, " +
    (d.centralPolicies.allowedModels || []).length + " mod\u00e8les, " +
    (d.centralPolicies.agentRules || []).length + " r\u00e8gles";
  renderBackend(d.backend);
  renderUsers(d.users, org);
  renderPolicies(d.centralPolicies || {}, d.cloudPolicy);
  renderConfig(org, d.configs || []);
  renderAudit(d.audit || []);
}

function renderBackend(b){
  const pill = document.getElementById("backendPill");
  if (!b) { pill.innerHTML = ""; return; }
  if (b.online) {
    pill.innerHTML = "<span class=\\"badge badge-ok\\">Backend : en ligne</span>";
  } else {
    pill.innerHTML = "<span class=\\"badge badge-err\\">Backend : hors ligne</span> " +
      "<button class=\\"btn btn-secondary\\" style=\\"padding:2px 8px;font-size:11px\\" data-act=\\"retryBackend\\">R\u00e9essayer</button>";
  }
}

function renderUsers(users, org){
  let h = "<div class=\\"section\\"><h2>Membres de l\u2019\u00e9quipe</h2>";
  if (!users.length) h += "<p class=\\"empty\\">Aucun utilisateur pour le moment.</p>";
  for (const u of users) {
    h += "<div class=\\"row\\">" +
      "<span class=\\"badge " + (u.active ? "badge-ok" : "badge-off") + "\\">" + (u.active ? "ACTIF" : "INACTIF") + "</span>" +
      "<span style=\\"flex:1\\"><strong>" + escH(u.name) + "</strong> " +
      "<span style=\\"color:var(--muted)\\">" + escH(u.email) + "</span></span>" +
      "<select data-chg=\\"role\\" data-id=\\"ROLEID\\">" + roleOptions(u.role) + "</select>"
        .replace("ROLEID", escAttr(u.id)) +
      "<button class=\\"btn btn-secondary\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"toggleUser\\" data-id=\\"" + escAttr(u.id) + "\\">" +
        (u.active ? "D\u00e9sactiver" : "Activer") + "</button>" +
      "<button class=\\"btn btn-danger\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"removeUser\\" data-id=\\"" + escAttr(u.id) + "\\" data-name=\\"" + escAttr(u.name) + "\\">X</button>" +
      "</div>";
  }
  h += "</div>";
  h += "<div class=\\"section\\"><h2>Ajouter un utilisateur</h2>" +
    "<div class=\\"form-row\\"><input id=\\"uName\\" placeholder=\\"Nom\\">" +
    "<input id=\\"uEmail\\" placeholder=\\"email@societe.com\\">" +
    "<select id=\\"uRole\\">" + roleOptions(org.defaultRole || "developer") + "</select>" +
    "<button class=\\"btn btn-green\\" data-act=\\"addUser\\">Ajouter</button></div></div>";
  document.getElementById("tab-users").innerHTML = h;
}

function roleOptions(sel){
  const roles = ["admin", "developer", "viewer", "tester", "devops"];
  let h = "";
  for (const r of roles) h += "<option value=\\"" + r + "\\"" + (r === sel ? " selected" : "") + ">" + r + "</option>";
  return h;
}

function renderPolicies(cp, cloud){
  cp = cp || {};
  const models = cp.allowedModels || [];
  const rules = cp.agentRules || [];
  let h = "<div class=\\"section\\"><h2>Mod\u00e8les autoris\u00e9s</h2>";
  h += "<p class=\\"empty\\">Liste vide = tous les mod\u00e8les autoris\u00e9s. Sinon, seuls les mod\u00e8les list\u00e9s peuvent \u00eatre charg\u00e9s.</p>";
  if (!models.length) h += "<p class=\\"empty\\">Aucune restriction.</p>";
  for (const m of models) {
    h += "<div class=\\"row\\"><span style=\\"flex:1\\"><strong>" + escH(m) + "</strong></span>" +
      "<button class=\\"btn btn-danger\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"removeModel\\" data-id=\\"" + escAttr(m) + "\\">X</button></div>";
  }
  h += "<div class=\\"form-row\\"><input id=\\"mName\\" placeholder=\\"Nom exact du mod\u00e8le\\">" +
    "<button class=\\"btn btn-green\\" data-act=\\"addModel\\">Autoriser</button></div></div>";

  h += "<div class=\\"section\\"><h2>Fournisseurs cloud (IA externe)</h2>";
  if (!cloud) {
    h += "<p class=\\"empty\\">Politique cloud indisponible pour le moment.</p>";
  } else {
    const wl = (cloud.whitelist || []).join(NL);
    h += "<div class=\\"form-row\\"><label>Activer les fournisseurs cloud</label>" +
      "<input type=\\"checkbox\\" id=\\"cloudEnabled\\" " + (cloud.cloudEnabled ? "checked" : "") + " style=\\"width:auto;flex:none\\"></div>" +
      "<div class=\\"form-row\\"><label>Domaines autoris\u00e9s (un par ligne)</label>" +
      "<textarea id=\\"cloudWl\\" rows=\\"4\\" placeholder=\\"api.openai.com\\">" + escH(wl) + "</textarea></div>" +
      "<div class=\\"form-row\\"><label>Email admin (requis)</label>" +
      "<input id=\\"cloudAdmin\\" placeholder=\\"admin@sudostudio.local\\"></div>" +
      "<p class=\\"empty\\">D\u00e9sactiv\u00e9 par d\u00e9faut. Seul un admin du registre peut activer. Hors liste blanche = refus\u00e9. Cloud coup\u00e9 = cl\u00e9s API inutilisables.</p>";
    if (cloud.updatedAt) h += "<p class=\\"empty\\">Derni\u00e8re modif : " + escH(cloud.updatedAt) + " par " + escH(cloud.updatedBy || "?") + "</p>";
    h += "<div style=\\"margin-top:8px\\"><button class=\\"btn btn-green\\" data-act=\\"saveCloud\\">Enregistrer</button> " +
      "<button class=\\"btn btn-secondary\\" data-act=\\"openProviders\\">G\u00e9rer les fournisseurs</button></div>";
  }
  h += "</div>";

  h += "<div class=\\"section\\"><h2>R\u00e8gles de l\u2019agent</h2>";
  if (!rules.length) h += "<p class=\\"empty\\">Aucune r\u00e8gle d\u00e9finie.</p>";
  for (const r of rules) {
    h += "<div class=\\"row\\">" +
      "<span class=\\"badge " + (r.active ? "badge-ok" : "badge-off") + "\\">" + (r.active ? "ON" : "OFF") + "</span>" +
      "<span style=\\"flex:1\\"><strong>" + escH(r.name) + "</strong> " +
      "<span style=\\"color:var(--muted)\\">" + escH(r.type) + (r.value ? " = " + escH(r.value) : "") + "</span></span>" +
      "<button class=\\"btn btn-secondary\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"toggleRule\\" data-id=\\"" + escAttr(r.id) + "\\">" +
        (r.active ? "D\u00e9sactiver" : "Activer") + "</button>" +
      "<button class=\\"btn btn-danger\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"removeRule\\" data-id=\\"" + escAttr(r.id) + "\\">X</button></div>";
  }
  h += "<div class=\\"form-row\\"><input id=\\"rName\\" placeholder=\\"Nom de la r\u00e8gle\\">" +
    "<select id=\\"rType\\"><option value=\\"note\\">note</option><option value=\\"maxSteps\\">maxSteps</option>" +
    "<option value=\\"blockTool\\">blockTool</option><option value=\\"requireApproval\\">requireApproval</option></select>" +
    "<input id=\\"rValue\\" placeholder=\\"Valeur (optionnel)\\">" +
    "<button class=\\"btn btn-green\\" data-act=\\"addRule\\">Ajouter</button></div></div>";
  document.getElementById("tab-policies").innerHTML = h;
}

function renderConfig(org, configs){
  org = org || {};
  let h = "<div class=\\"section\\"><h2>Param\u00e8tres de l\u2019organisation</h2>" +
    "<div class=\\"form-row\\"><label>Nom de l\u2019organisation</label>" +
    "<input id=\\"oName\\" value=\\"" + escAttr(org.orgName || "") + "\\"></div>" +
    "<div class=\\"form-row\\"><label>R\u00f4le par d\u00e9faut (nouveaux users)</label>" +
    "<select id=\\"oRole\\">" + roleOptions(org.defaultRole || "developer") + "</select></div>" +
    "<div class=\\"form-row\\"><label>R\u00e9tention audit (jours)</label>" +
    "<input id=\\"oRetention\\" type=\\"number\\" min=\\"1\\" max=\\"3650\\" value=\\"" + (org.auditRetentionDays || 365) + "\\"></div>" +
    "<div><button class=\\"btn btn-green\\" data-act=\\"saveOrg\\">Enregistrer</button></div></div>";

  h += "<div class=\\"section\\"><h2>Profils IA</h2>";
  if (!configs.length) h += "<p class=\\"empty\\">Aucun profil.</p>";
  for (const c of configs) {
    h += "<div class=\\"row\\">" +
      "<span style=\\"flex:1\\"><strong>" + escH(c.name) + "</strong> " +
      "<span style=\\"color:var(--muted)\\">model: " + escH(c.model || "aucun") + " - agent: " + (c.agentMode ? "on" : "off") + "</span></span>" +
      "<button class=\\"btn btn-green\\" style=\\"padding:3px 8px;font-size:11px\\" data-act=\\"applyConfig\\" data-id=\\"" + escAttr(c.id) + "\\">Appliquer</button>" +
      "<button class=\\"btn btn-danger\\" style=\\"padding:3px 7px;font-size:11px\\" data-act=\\"removeConfig\\" data-id=\\"" + escAttr(c.id) + "\\">X</button></div>";
  }
  h += "</div>";
  h += "<div class=\\"section\\"><h2>Nouveau profil IA</h2>" +
    "<div class=\\"form-row\\"><input id=\\"cName\\" placeholder=\\"Nom du profil\\">" +
    "<input id=\\"cModel\\" placeholder=\\"Mod\u00e8le (ex. Qwen2.5-Coder-1.5B)\\">" +
    "<select id=\\"cAgent\\"><option value=\\"true\\">Agent: ON</option><option value=\\"false\\">Agent: OFF</option></select>" +
    "<button class=\\"btn btn-green\\" data-act=\\"addConfig\\">Sauver</button></div></div>";
  document.getElementById("tab-config").innerHTML = h;
}

function auditFilters(){
  return {
    user: document.getElementById("fUser").value,
    action: document.getElementById("fAction").value,
    from: document.getElementById("fFrom").value,
    to: document.getElementById("fTo").value,
    result: document.getElementById("fResult").value,
  };
}

function renderAudit(log){
  let h = "<div class=\\"section\\"><h2>Filtres</h2>" +
    "<div class=\\"form-row\\"><input id=\\"fUser\\" placeholder=\\"Utilisateur\\">" +
    "<input id=\\"fAction\\" placeholder=\\"Action\\">" +
    "<input id=\\"fFrom\\" type=\\"date\\"><input id=\\"fTo\\" type=\\"date\\">" +
    "<select id=\\"fResult\\"><option value=\\"\\">Tous r\u00e9sultats</option><option value=\\"ok\\">ok</option>" +
    "<option value=\\"error\\">error</option><option value=\\"refused_policy\\">refused_policy</option>" +
    "<option value=\\"refused_not_admin\\">refused_not_admin</option><option value=\\"refused_duplicate\\">refused_duplicate</option>" +
    "<option value=\\"refused_last_admin\\">refused_last_admin</option><option value=\\"failing\\">failing</option></select></div>" +
    "<div><button class=\\"btn btn-green\\" data-act=\\"auditFilter\\">Filtrer</button> " +
    "<button class=\\"btn btn-secondary\\" data-act=\\"auditReset\\">R\u00e9initialiser</button> " +
    "<button class=\\"btn btn-secondary\\" data-act=\\"auditCsv\\">Export CSV</button> " +
    "<button class=\\"btn btn-secondary\\" data-act=\\"auditJson\\">Export JSON</button></div></div>";
  h += "<div class=\\"section\\"><h2>Activit\u00e9 r\u00e9cente (<span id=\\"auditCount\\">" + log.length + "</span>)</h2><div id=\\"auditList\\">";
  h += auditRows(log);
  h += "</div></div>";
  document.getElementById("tab-audit").innerHTML = h;
}

function auditRows(log){
  if (!log.length) return "<p class=\\"empty\\">Aucune entr\u00e9e d\u2019audit.</p>";
  let h = "";
  for (const e of log) {
    const ok = e.result === "ok";
    h += "<div class=\\"audit-row\\">" +
      "<span class=\\"audit-ts\\">" + escH((e.ts || "").replace("T", " ").slice(0, 19)) + "</span>" +
      "<span style=\\"color:#58a6ff;min-width:100px\\">" + escH(e.action) + "</span>" +
      "<span style=\\"flex:1\\">" + escH(e.detail) + "</span>" +
      "<span class=\\"badge " + (ok ? "badge-ok" : "badge-err") + "\\">" + escH(e.result || "") + "</span>" +
      "<span style=\\"color:var(--muted)\\">" + escH(e.actor) + "</span></div>";
  }
  return h;
}

function applyAuditFilter(){
  if (!lastData || !lastData.audit) return;
  const f = auditFilters();
  const out = lastData.audit.filter(function(e){
    if (f.user && (e.actor || "").toLowerCase().indexOf(f.user.toLowerCase()) === -1) return false;
    if (f.action && (e.action || "").toLowerCase().indexOf(f.action.toLowerCase()) === -1) return false;
    const day = (e.ts || "").slice(0, 10);
    if (f.from && day && day < f.from) return false;
    if (f.to && day && day > f.to) return false;
    if (f.result && (e.result || "") !== f.result) return false;
    return true;
  });
  document.getElementById("auditList").innerHTML = auditRows(out);
  document.getElementById("auditCount").textContent = out.length;
}

function escH(s){ return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function escAttr(s){ return escH(s).replace(/'/g, "&#39;"); }
function val(id){ const el = document.getElementById(id); return el ? el.value : ""; }

document.addEventListener("click", function(ev){
  const el = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!el) return;
  const act = el.getAttribute("data-act");
  const id = el.getAttribute("data-id");
  if (act === "retry" || act === "retryLoad") { load(); return; }
  if (act === "retryBackend") { vscode.postMessage({type:"retryBackend"}); return; }
  if (act === "toggleUser") { vscode.postMessage({type:"toggleUser", id:id}); return; }
  if (act === "removeUser") {
    if (confirm("Supprimer " + (el.getAttribute("data-name") || "cet utilisateur") + " ?")) {
      vscode.postMessage({type:"removeUser", id:id});
    }
    return;
  }
  if (act === "addUser") {
    const n = val("uName").trim(), e = val("uEmail").trim(), r = val("uRole");
    if (!n || !e) { showErr("Nom et email requis."); return; }
    vscode.postMessage({type:"addUser", user:{name:n, email:e, role:r}}); return;
  }
  if (act === "addModel") {
    const m = val("mName").trim();
    if (!m) { showErr("Nom de mod\u00e8le requis."); return; }
    vscode.postMessage({type:"addModel", model:m}); return;
  }
  if (act === "removeModel") { vscode.postMessage({type:"removeModel", model:id}); return; }
  if (act === "addRule") {
    const n = val("rName").trim();
    if (!n) { showErr("Nom de r\u00e8gle requis."); return; }
    vscode.postMessage({type:"addRule", rule:{name:n, type:val("rType"), value:val("rValue").trim()}}); return;
  }
  if (act === "toggleRule") { vscode.postMessage({type:"toggleRule", id:id}); return; }
  if (act === "removeRule") { vscode.postMessage({type:"removeRule", id:id}); return; }
  if (act === "saveCloud") {
    const adminEmail = val("cloudAdmin").trim();
    const cloudEnabled = document.getElementById("cloudEnabled").checked;
    const whitelist = val("cloudWl").split(NL).map(function(s){ return s.trim(); }).filter(Boolean);
    if (!adminEmail) { showErr("Email admin requis."); return; }
    vscode.postMessage({type:"saveCloudPolicy", adminEmail:adminEmail, cloudEnabled:cloudEnabled, whitelist:whitelist}); return;
  }
  if (act === "openProviders") { vscode.postMessage({type:"openProviders"}); return; }
  if (act === "saveOrg") {
    vscode.postMessage({type:"saveOrg", org:{orgName:val("oName").trim(), defaultRole:val("oRole"), auditRetentionDays:val("oRetention")}}); return;
  }
  if (act === "addConfig") {
    const n = val("cName").trim();
    if (!n) { showErr("Nom de profil requis."); return; }
    vscode.postMessage({type:"addConfig", config:{name:n, model:val("cModel").trim(), agentMode:val("cAgent") === "true"}}); return;
  }
  if (act === "applyConfig") { vscode.postMessage({type:"applyConfig", id:id}); return; }
  if (act === "removeConfig") { vscode.postMessage({type:"removeConfig", id:id}); return; }
  if (act === "auditFilter") { applyAuditFilter(); return; }
  if (act === "auditReset") { renderAudit(lastData ? lastData.audit : []); return; }
  if (act === "auditCsv") { vscode.postMessage({type:"exportAudit", format:"csv", filters:auditFilters()}); return; }
  if (act === "auditJson") { vscode.postMessage({type:"exportAudit", format:"json", filters:auditFilters()}); return; }
});

document.addEventListener("change", function(ev){
  const el = ev.target && ev.target.closest ? ev.target.closest("[data-chg]") : null;
  if (!el) return;
  if (el.getAttribute("data-chg") === "role") {
    vscode.postMessage({type:"setUserRole", id:el.getAttribute("data-id"), role:el.value});
  }
});
</script>
${bf.webviewSnippet()}
</body>
</html>`;
    }
}

module.exports = { CentralMgmtPanel, filterAudit, buildAuditCsv, isModelAllowed, getCentralPolicies, getOrg, VALID_ROLES };
