/**
 * SUDO STUDIO - Agent Extensions page (MISSION P54, replaces the P50 MCP page).
 *
 * ONE page, FIVE tabs, each with a short built-in guide (3 steps):
 *   1. MCP Servers  - local (command + args) or remote (URL) servers, tokens in
 *                     the OS vault (never in a file or a log), enable/disable,
 *                     "Test connection" showing the exposed tools, connected /
 *                     offline / error state, "mcpServers" JSON import/export,
 *                     ready-to-fill presets, per-tool permission (ask/allow/
 *                     deny), admin allowlist + network policy, audited calls,
 *                     hidden-window children, server-prefixed tool names and an
 *                     explicit exposure choice (NONE by default, so small
 *                     models keep a small context).
 *   2. Skills       - folders with SKILL.md, global or per project, preview +
 *                     activation, descriptions only in the context (the full
 *                     text loads on demand through the `skill` tool), import
 *                     from a Git repo (needs Internet) or from a folder / zip
 *                     offline, with the content shown before activation.
 *   3. Commands     - markdown prompt templates with arguments, global or per
 *                     project, called as "/name".
 *   4. Agents       - custom agents (name, instructions, allowed tools, model
 *                     or provider) and sub-agent calls. Build and Plan stay the
 *                     default agents.
 *   5. Rules        - AGENTS.md (project) + global rules, "Generate AGENTS.md"
 *                     from the project analysis, never overwriting without a
 *                     diff and a confirmation.
 *
 * Common: export / import of the whole configuration, offline tolerance (a
 * remote server shows "offline" and never blocks the agent), and full
 * compatibility with the engine-managed task loop (P49/P52).
 *
 * ASCII-only source (accents via \u escapes), like the other panels.
 */
'use strict';

const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const { getAgentHost } = require('../agent/agentHost');

const GUIDES = {
    mcp: [
        '1. Choisissez un mod\u00e8le pr\u00eat (\u00e9tabli) ou saisissez la commande d\'un serveur local, ou l\'URL d\'un serveur distant.',
        '2. Testez la connexion : les outils expos\u00e9s s\'affichent ; choisissez ceux \u00e0 montrer au mod\u00e8le (aucun par d\u00e9faut).',
        '3. Activez le serveur. Les jetons vont dans le trousseau ; chaque appel est journalis\u00e9 dans l\'audit log.',
    ],
    skills: [
        '1. Importez un dossier contenant SKILL.md (dossier local, zip hors ligne, ou d\u00e9p\u00f4t Git si Internet est disponible).',
        '2. Relisez l\'aper\u00e7u : le contenu exact est affich\u00e9 avant toute activation.',
        '3. Activez : seules les descriptions entrent dans le contexte, le texte complet se charge \u00e0 la demande.',
    ],
    commands: [
        '1. Cr\u00e9ez une commande : un nom, une description et un mod\u00e8le de consigne en markdown.',
        '2. Utilisez $1, $2 ou ${argument} dans le mod\u00e8le pour les arguments.',
        '3. Appelez-la dans le chat avec /nom vos arguments.',
    ],
    agents: [
        '1. D\u00e9finissez un agent : nom, instructions, outils autoris\u00e9s, mod\u00e8le ou fournisseur.',
        '2. Build et Plan restent les agents par d\u00e9faut ; vos agents s\'ajoutent \u00e0 c\u00f4t\u00e9.',
        '3. Appelez-le depuis l\'agent principal (outil subagent avec le champ agent) ou en parall\u00e8le.',
    ],
    rules: [
        '1. AGENTS.md d\u00e9crit les r\u00e8gles du projet ; les r\u00e8gles globales s\'appliquent partout.',
        '2. "G\u00e9n\u00e9rer" produit un brouillon \u00e0 partir de l\'analyse r\u00e9elle du projet.',
        '3. Rien n\'est \u00e9cras\u00e9 sans diff affich\u00e9 et confirmation explicite.',
    ],
};

class AgentExtensionsPanel {
    static currentPanel = undefined;

    static createOrShow(extensionUri) {
        if (AgentExtensionsPanel.currentPanel) {
            AgentExtensionsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            AgentExtensionsPanel.currentPanel._pushAll();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoAgentExtensions', 'Agent Extensions',
            vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
        );
        AgentExtensionsPanel.currentPanel = new AgentExtensionsPanel(panel, extensionUri);
    }

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.panel.webview.html = this.getHtmlContent();
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (wvFallback.handlePanelMessage(null, msg)) return;
            try { await this._onMessage(msg); }
            catch (e) { this._post({ type: 'error', text: e.message }); }
        }, null, this.disposables);
        this.panel.onDidDispose(() => {
            AgentExtensionsPanel.currentPanel = undefined;
            this.disposables.forEach((d) => d && d.dispose());
        });
        setTimeout(() => this._pushAll(), 300);
    }

    _post(msg) { try { this.panel.webview.postMessage(msg); } catch (_) { /* ignore */ } }

    _server() {
        const host = getAgentHost();
        const srv = host && typeof host.getServer === 'function' ? host.getServer() : null;
        if (!srv) throw new Error('serveur agent indisponible (extension en cours de d\u00e9marrage ?).');
        return srv;
    }

    _root() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) return null;
        return folders[0].uri.fsPath;
    }

    _q() {
        const root = this._root();
        return root ? '?projectRoot=' + encodeURIComponent(root) : '';
    }

    async _call(pathname, opts) {
        const srv = this._server();
        let r;
        try { r = await srv.request(pathname, opts || {}); }
        catch (e) { throw new Error('serveur agent injoignable : ' + e.message); }
        const body = (r && r.body) || {};
        if (!r || r.status < 200 || r.status >= 300) {
            const err = body.error || ('erreur HTTP ' + (r && r.status));
            const e2 = new Error(err);
            e2.body = body;
            e2.status = r && r.status;
            throw e2;
        }
        return body;
    }

    async _pushAll() {
        await Promise.all([
            this._pushMcp(), this._pushSkills(), this._pushCommands(),
            this._pushAgents(), this._pushRules(),
        ]).catch(() => { /* each loader reports its own error */ });
    }

    async _pushMcp() {
        try {
            const servers = await this._call('/mcp/servers');
            const presets = await this._call('/extensions/mcp/presets');
            let tools = { servers: {} };
            try { tools = await this._call('/extensions/mcp/tools'); } catch (_) { tools = { servers: {} }; }
            let policy = null;
            try { policy = await this._call('/permissions'); } catch (_) { policy = null; }
            let keyringOk = false;
            try { const k = await this._call('/keyring/status'); keyringOk = !!k.available; } catch (_) {}
            this._post({ type: 'mcp', servers: servers.servers || [], presets: presets.presets || [],
                tools: tools.servers || {}, policy, keyringOk });
        } catch (e) { this._post({ type: 'mcp', error: e.message, servers: [], presets: [], tools: {} }); }
    }

    async _pushSkills() {
        try {
            const r = await this._call('/skills' + this._q());
            this._post({ type: 'skills', skills: r.skills || [], staged: r.staged || [] });
        } catch (e) { this._post({ type: 'skills', error: e.message, skills: [], staged: [] }); }
    }

    async _pushCommands() {
        try {
            const r = await this._call('/extensions/commands' + this._q());
            this._post({ type: 'commands', commands: r.commands || [] });
        } catch (e) { this._post({ type: 'commands', error: e.message, commands: [] }); }
    }

    async _pushAgents() {
        try {
            const r = await this._call('/extensions/agents');
            this._post({ type: 'agents', agents: r.agents || [] });
        } catch (e) { this._post({ type: 'agents', error: e.message, agents: [] }); }
    }

    async _pushRules() {
        try {
            const r = await this._call('/extensions/rules' + this._q());
            this._post({ type: 'rules', project: r.project || { exists: false, text: '' }, global: r.global || '' });
        } catch (e) { this._post({ type: 'rules', error: e.message, project: { exists: false, text: '' }, global: '' }); }
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'load': await this._pushAll(); break;
            // -- MCP ------------------------------------------------------
            case 'mcpAdd': {
                const body = { name: msg.name, transport: msg.transport };
                if (msg.transport === 'http') {
                    body.url = msg.url;
                    if (msg.tokenTarget) body.tokenTarget = msg.tokenTarget;
                } else {
                    body.command = msg.command;
                    if (msg.args && msg.args.length) body.args = msg.args;
                }
                await this._call('/mcp/servers', { method: 'POST', body });
                // A token typed in the (masked) field goes straight to the OS
                // vault, then the field is cleared. It is never written to a
                // file, never journaled, never echoed back to the page.
                if (msg.token && body.tokenTarget) {
                    await this._call('/keyring/secret', { method: 'POST', body: { target: body.tokenTarget, secret: msg.token } });
                }
                this._post({ type: 'tokenCleared' });
                this._post({ type: 'info', text: 'Serveur MCP ajout\u00e9 (inactif pour le mod\u00e8le tant que rien n\'est expos\u00e9).' });
                await this._pushMcp(); break;
            }
            case 'mcpDelete': {
                await this._call('/mcp/servers/' + encodeURIComponent(msg.name), { method: 'DELETE' });
                this._post({ type: 'info', text: 'Serveur MCP supprim\u00e9.' });
                await this._pushMcp(); break;
            }
            case 'mcpEnable': {
                await this._call('/mcp/servers/' + encodeURIComponent(msg.name), { method: 'POST', body: { enabled: !!msg.enabled } });
                await this._pushMcp(); break;
            }
            case 'mcpTest': {
                this._post({ type: 'mcpTest', name: msg.name, pending: true });
                try {
                    const r = await this._call('/mcp/servers/' + encodeURIComponent(msg.name) + '/test',
                        { method: 'POST', body: {}, timeoutMs: 60000 });
                    this._post({ type: 'mcpTest', name: msg.name, ok: true, tools: r.tools || [], ms: r.ms || 0 });
                } catch (e) {
                    this._post({ type: 'mcpTest', name: msg.name, ok: false, error: e.message });
                }
                break;
            }
            case 'mcpExpose': {
                await this._call('/extensions/mcp/tools', { method: 'POST', body: { server: msg.name, expose: msg.tools || [] } });
                this._post({ type: 'info', text: 'Outils expos\u00e9s au mod\u00e8le mis \u00e0 jour.' });
                await this._pushMcp(); break;
            }
            case 'mcpDecision': {
                await this._call('/extensions/mcp/tools', { method: 'POST', body: { server: msg.name, tool: msg.tool, decision: msg.decision } });
                await this._pushMcp(); break;
            }
            case 'mcpExport': {
                const r = await this._call('/extensions/mcp/export');
                this._post({ type: 'json', text: JSON.stringify(r, null, 2) }); break;
            }
            case 'mcpImport': {
                let doc = null;
                try { doc = JSON.parse(msg.text || '{}'); }
                catch (_) { this._post({ type: 'error', text: 'JSON invalide.' }); break; }
                const r = await this._call('/extensions/mcp/import', { method: 'POST', body: doc });
                this._post({ type: 'info', text: 'Import\u00e9s : ' + (r.added || []).join(', ') +
                    ((r.refused || []).length ? ' ; refus\u00e9s : ' + r.refused.map((x) => x.name).join(', ') : '') });
                await this._pushMcp(); break;
            }
            case 'mcpAskToken': {
                // The secret is typed in the editor input box with password
                // masking: it never enters the webview, a file, or a log.
                const target = String(msg.target || '').trim();
                if (!target) { this._post({ type: 'error', text: 'cible de jeton manquante.' }); break; }
                const secret = await vscode.window.showInputBox({
                    password: true, ignoreFocusOut: true,
                    prompt: 'Jeton pour ' + target + ' (stock\u00e9 dans le trousseau du syst\u00e8me)',
                    placeHolder: 'collez le jeton puis validez',
                });
                if (!secret) { this._post({ type: 'info', text: 'Aucun jeton saisi.' }); break; }
                await this._call('/keyring/secret', { method: 'POST', body: { target: target, secret: secret } });
                this._post({ type: 'info', text: 'Jeton enregistr\u00e9 dans le trousseau (jamais \u00e9crit sur disque ni journalis\u00e9).' });
                this._post({ type: 'tokenCleared' });
                await this._pushMcp(); break;
            }
            case 'mcpDeleteToken': {
                await this._call('/keyring/secret', { method: 'DELETE', body: { target: String(msg.target || '') } });
                this._post({ type: 'info', text: 'Jeton supprim\u00e9 du trousseau.' });
                this._post({ type: 'tokenCleared' });
                await this._pushMcp(); break;
            }
            // -- Skills ---------------------------------------------------
            case 'skillPreview': {
                const r = await this._call('/skills/preview', { method: 'POST', body: { source: msg.source } });
                this._post({ type: 'skillPreview', preview: r }); break;
            }
            case 'skillActivate': {
                const body = { stagingId: msg.stagingId, scope: msg.scope || 'global' };
                if (msg.name) body.name = msg.name;
                if (msg.scope === 'project') body.projectRoot = this._root();
                await this._call('/skills/activate', { method: 'POST', body });
                this._post({ type: 'info', text: 'Comp\u00e9tence activ\u00e9e (descriptions seulement dans le contexte).' });
                await this._pushSkills(); break;
            }
            case 'skillToggle': {
                await this._call('/skills/active', { method: 'POST', body: {
                    scope: msg.scope, name: msg.name, active: !!msg.active, projectRoot: this._root() } });
                await this._pushSkills(); break;
            }
            case 'skillPickFolder': {
                const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
                    canSelectMany: false, openLabel: 'Importer ce dossier de comp\u00e9tences' });
                if (pick && pick.length) this._post({ type: 'skillSource', source: pick[0].fsPath });
                break;
            }
            // -- Commands -------------------------------------------------
            case 'commandSave': {
                await this._call('/extensions/commands' + this._q(), { method: 'POST', body: {
                    scope: msg.scope || 'global', name: msg.name, description: msg.description,
                    template: msg.template, args: msg.args || [] } });
                this._post({ type: 'info', text: 'Commande enregistr\u00e9e : /' + msg.name });
                await this._pushCommands(); break;
            }
            case 'commandDelete': {
                await this._call('/extensions/commands/' + encodeURIComponent(msg.name) + this._q(),
                    { method: 'DELETE', body: { scope: msg.scope || 'global' } });
                await this._pushCommands(); break;
            }
            case 'commandPreview': {
                const r = await this._call('/extensions/commands/' + encodeURIComponent(msg.name) + this._q() +
                    (this._q() ? '&' : '?') + 'args=' + encodeURIComponent(msg.args || ''));
                this._post({ type: 'commandPreview', preview: r.preview || '', missing: r.missing || [] }); break;
            }
            case 'commandInsert': {
                this._post({ type: 'insertChat', text: msg.text || '' }); break;
            }
            // -- Agents ---------------------------------------------------
            case 'agentSave': {
                await this._call('/extensions/agents', { method: 'POST', body: {
                    name: msg.name, description: msg.description, instructions: msg.instructions,
                    tools: msg.tools || [], model: msg.model || '', provider: msg.provider || '' } });
                this._post({ type: 'info', text: 'Agent enregistr\u00e9 : ' + msg.name });
                await this._pushAgents(); break;
            }
            case 'agentDelete': {
                await this._call('/extensions/agents/' + encodeURIComponent(msg.name), { method: 'DELETE' });
                await this._pushAgents(); break;
            }
            // -- Rules ----------------------------------------------------
            case 'rulesSave': {
                try {
                    const r = await this._call('/extensions/rules' + this._q(), { method: 'POST', body: {
                        scope: msg.scope || 'project', text: msg.text, confirm: msg.confirm === true } });
                    this._post({ type: 'info', text: 'R\u00e8gles enregistr\u00e9es (' + (r.bytes || 0) + ' octets).' });
                    await this._pushRules();
                } catch (e) {
                    if (e.body && e.body.code === 'confirm_required') {
                        this._post({ type: 'rulesDiff', diff: e.body.diff, reason: e.status });
                    } else throw e;
                }
                break;
            }
            case 'rulesGenerate': {
                const r = await this._call('/extensions/rules/generate' + this._q(), { method: 'POST', body: {} });
                this._post({ type: 'rulesGenerated', text: r.text, diff: r.diff, exists: r.exists }); break;
            }
            // -- whole configuration --------------------------------------
            case 'exportAll': {
                const r = await this._call('/extensions/export' + this._q());
                this._post({ type: 'json', text: JSON.stringify(r, null, 2) }); break;
            }
            case 'importAll': {
                let doc = null;
                try { doc = JSON.parse(msg.text || '{}'); }
                catch (_) { this._post({ type: 'error', text: 'JSON invalide.' }); break; }
                const r = await this._call('/extensions/import' + this._q(), { method: 'POST', body: doc });
                const rep = r.report || {};
                this._post({ type: 'info', text: 'Import termin\u00e9 : ' +
                    (rep.commands || []).filter((c) => c.ok).length + ' commande(s), ' +
                    (rep.agents || []).filter((a) => a.ok).length + ' agent(s).' });
                await this._pushAll(); break;
            }
            case 'copyJson': {
                await vscode.env.clipboard.writeText(msg.text || '');
                this._post({ type: 'info', text: 'Copi\u00e9 dans le presse-papiers.' }); break;
            }
            default: break;
        }
    }

    getHtmlContent() {
        const guides = JSON.stringify(GUIDES);
        return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#1f6feb;--ok:#3fb950;--err:#f85149;--warn:#d29922;}
body{background:var(--bg);color:var(--text);font-family:var(--vscode-font-family);padding:14px;margin:0;font-size:12px;}
h1{font-size:16px;margin:0 0 10px;}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;}
.tab{background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;}
.tab.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}
.pane{display:none;} .pane.active{display:block;}
.section{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;}
.section-title{font-size:13px;font-weight:700;margin-bottom:8px;}
.guide{background:rgba(31,111,235,.10);border:1px solid rgba(31,111,235,.4);border-radius:8px;padding:10px 12px;margin-bottom:12px;}
.guide ol{margin:0;padding-left:18px;} .guide li{margin:2px 0;}
.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.row:last-child{border-bottom:none;}
.badge{padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600;}
.b-ok{background:rgba(63,185,80,.15);color:var(--ok);border:1px solid rgba(63,185,80,.35);}
.b-err{background:rgba(248,81,73,.15);color:var(--err);border:1px solid rgba(248,81,73,.35);}
.b-warn{background:rgba(210,153,34,.15);color:var(--warn);border:1px solid rgba(210,153,34,.4);}
.b-mut{background:rgba(139,148,158,.15);color:var(--muted);border:1px solid var(--border);}
.btn{background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px;}
.btn-sec{background:transparent;color:var(--text);border:1px solid var(--border);}
.btn-danger{background:transparent;color:var(--err);border:1px solid var(--err);}
.btn-sm{padding:3px 8px;font-size:11px;}
input,select,textarea{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:5px 8px;font-size:12px;font-family:inherit;}
textarea{width:100%;box-sizing:border-box;min-height:90px;}
.grid{display:grid;grid-template-columns:150px 1fr;gap:7px;align-items:center;}
.mono{font-family:var(--vscode-editor-font-family);font-size:11px;}
#msg{min-height:18px;margin-bottom:8px;} #msg.err{color:var(--err);} #msg.ok{color:var(--ok);}
.muted{color:var(--muted);}
table.t{width:100%;border-collapse:collapse;font-size:11px;} table.t td,table.t th{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left;}
pre.diff{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;max-height:220px;overflow:auto;font-size:11px;}
.d-add{color:var(--ok);} .d-del{color:var(--err);}
</style></head><body>
${guardSnippet()}
<h1>Agent Extensions</h1>
<div id="msg"></div>
<div class="tabs">
<button class="tab active" data-tab="mcp" onclick="showTab('mcp')">MCP Servers</button>
<button class="tab" data-tab="skills" onclick="showTab('skills')">Skills</button>
<button class="tab" data-tab="commands" onclick="showTab('commands')">Commands</button>
<button class="tab" data-tab="agents" onclick="showTab('agents')">Agents</button>
<button class="tab" data-tab="rules" onclick="showTab('rules')">Rules</button>
</div>

<div class="pane active" id="pane-mcp">
  <div class="guide"><ol id="guide-mcp"></ol></div>
  <div class="section"><div class="section-title">Serveurs MCP</div>
    <div id="mcpList" class="muted">Chargement...</div>
    <div id="mcpKeyring" class="muted" style="margin-top:8px"></div>
  </div>
  <div class="section"><div class="section-title">Ajouter un serveur</div>
    <div class="grid">
      <label>Mod&egrave;le pr&ecirc;t</label><select id="preset" onchange="fillPreset()"><option value="">-- choisir --</option></select>
      <label>Nom</label><input id="srvName" placeholder="github" />
      <label>Transport</label><select id="srvTransport"><option value="stdio">local (commande)</option><option value="http">distant (URL)</option></select>
      <label>Commande</label><input id="srvCommand" placeholder="npx" />
      <label>Arguments</label><input id="srvArgs" placeholder="-y @scope/serveur ." />
      <label>URL</label><input id="srvUrl" placeholder="https://..." />
      <label>Cible du jeton</label><input id="srvTokenTarget" placeholder="mcp/github/token" />
      <label>Jeton (trousseau)</label><input id="srvToken" type="password" autocomplete="off" placeholder="coll\u00e9 puis ajout\u00e9 au trousseau" />
    </div>
    <div class="row"><button class="btn" onclick="addServer()">Ajouter</button>
      <span class="muted" id="presetNote"></span></div>
  </div>
  <div class="section"><div class="section-title">Import / export (format "mcpServers")</div>
    <textarea id="mcpJson" placeholder='{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}'></textarea>
    <div class="row"><button class="btn btn-sec" onclick="mcpExport()">Exporter</button>
      <button class="btn" onclick="mcpImport()">Importer ce JSON</button></div>
  </div>
</div>

<div class="pane" id="pane-skills">
  <div class="guide"><ol id="guide-skills"></ol></div>
  <div class="section"><div class="section-title">Comp&eacute;tences install&eacute;es</div>
    <div id="skillList" class="muted">Chargement...</div>
  </div>
  <div class="section"><div class="section-title">Importer</div>
    <div class="grid">
      <label>Source</label><input id="skillSource" placeholder="chemin de dossier, .zip, ou URL de d&eacute;p&ocirc;t Git (Internet)" />
      <label>Port&eacute;e</label><select id="skillScope"><option value="global">globale</option><option value="project">projet</option></select>
    </div>
    <div class="row"><button class="btn btn-sec" onclick="pickFolder()">Choisir un dossier</button>
      <button class="btn" onclick="skillPreview()">Aper&ccedil;u</button>
      <span class="muted">Le contenu est affich&eacute; avant activation.</span></div>
    <div id="skillPreviewBox"></div>
  </div>
</div>

<div class="pane" id="pane-commands">
  <div class="guide"><ol id="guide-commands"></ol></div>
  <div class="section"><div class="section-title">Commandes personnalis&eacute;es (/nom)</div>
    <div id="cmdList" class="muted">Chargement...</div>
  </div>
  <div class="section"><div class="section-title">Cr&eacute;er / modifier</div>
    <div class="grid">
      <label>Nom</label><input id="cmdName" placeholder="revue" />
      <label>Description</label><input id="cmdDesc" placeholder="Relit un fichier et propose des corrections" />
      <label>Arguments</label><input id="cmdArgs" placeholder="file, focus" />
      <label>Port&eacute;e</label><select id="cmdScope"><option value="global">globale</option><option value="project">projet</option></select>
    </div>
    <textarea id="cmdTemplate" placeholder="Relis \${file} et concentre-toi sur \${focus}.&#10;Termine par un resume des points bloquants."></textarea>
    <div class="row"><button class="btn" onclick="saveCommand()">Enregistrer</button></div>
  </div>
</div>

<div class="pane" id="pane-agents">
  <div class="guide"><ol id="guide-agents"></ol></div>
  <div class="section"><div class="section-title">Agents</div>
    <div id="agentList" class="muted">Chargement...</div>
  </div>
  <div class="section"><div class="section-title">Cr&eacute;er / modifier un agent</div>
    <div class="grid">
      <label>Nom</label><input id="agName" placeholder="Revue" />
      <label>Description</label><input id="agDesc" placeholder="Relit le code sans le modifier" />
      <label>Outils autoris&eacute;s</label><input id="agTools" placeholder="read, list, grep" />
      <label>Mod&egrave;le</label><input id="agModel" placeholder="(d&eacute;faut du fournisseur actif)" />
      <label>Fournisseur</label><input id="agProvider" placeholder="local | cloud" />
    </div>
    <textarea id="agInstructions" placeholder="Instructions de l'agent (role, methode, format de sortie)..."></textarea>
    <div class="row"><button class="btn" onclick="saveAgent()">Enregistrer</button>
      <span class="muted">Build et Plan restent les agents par d&eacute;faut.</span></div>
  </div>
</div>

<div class="pane" id="pane-rules">
  <div class="guide"><ol id="guide-rules"></ol></div>
  <div class="section"><div class="section-title">AGENTS.md (projet)</div>
    <div id="rulesState" class="muted"></div>
    <textarea id="rulesProject" placeholder="# AGENTS.md ..."></textarea>
    <div class="row"><button class="btn" onclick="saveRules('project')">Enregistrer</button>
      <button class="btn btn-sec" onclick="generateRules()">G&eacute;n&eacute;rer AGENTS.md</button>
      <span class="muted">Aucun &eacute;crasement sans diff et confirmation.</span></div>
    <div id="rulesDiff"></div>
  </div>
  <div class="section"><div class="section-title">R&egrave;gles globales</div>
    <textarea id="rulesGlobal" placeholder="Regles valables pour tous les projets..."></textarea>
    <div class="row"><button class="btn" onclick="saveRules('global')">Enregistrer</button></div>
  </div>
</div>

<div class="section"><div class="section-title">Configuration compl&egrave;te</div>
  <div class="row"><button class="btn btn-sec" onclick="exportAll()">Exporter tout</button>
    <button class="btn" onclick="importAll()">Importer ce JSON</button></div>
  <textarea id="allJson" placeholder="Collez ici une configuration export&eacute;e (MCP + skills + commandes + agents + r&egrave;gles)."></textarea>
</div>

<script>
const vscode = acquireVsCodeApi();
const GUIDES = ${guides};
let STATE = { servers: [], tools: {}, presets: [], skills: [], staged: [], commands: [], agents: [], rules: null };

function showTab(id){
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === id);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('active', p.id === 'pane-' + id);
  try { vscode.setState({ tab: id }); } catch(_) {}
}
(function restoreGuide(){
  for (const k of Object.keys(GUIDES)) {
    const ol = document.getElementById('guide-' + k);
    if (!ol) continue;
    ol.innerHTML = GUIDES[k].map(function (s) { return '<li>' + esc(s.replace(/^\\d+\\.\\s*/, '')) + '</li>'; }).join('');
  }
  try { const st = vscode.getState(); if (st && st.tab) showTab(st.tab); } catch(_) {}
})();
function esc(s){ return String(s === undefined || s === null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function msg(text, cls){ const m = document.getElementById('msg'); m.textContent = text || ''; m.className = cls || ''; }
function post(m){ vscode.postMessage(m); }

function renderMcp(){
  const box = document.getElementById('mcpList');
  const list = STATE.servers || [];
  if (!list.length) { box.innerHTML = '<span class="muted">Aucun serveur. Ajoutez-en un ci-dessous ou importez un JSON.</span>'; return; }
  let h = '<table class="t"><tr><th>Nom</th><th>Transport</th><th>&Eacute;tat</th><th>Outils expos&eacute;s au mod&egrave;le</th><th>Actions</th></tr>';
  for (const s of list) {
    const t = (STATE.tools && STATE.tools[s.name]) || {};
    const enabled = t.enabled !== false;
    const stateBadge = enabled ? '<span class="badge b-ok">activ&eacute;</span>' : '<span class="badge b-mut">d&eacute;sactiv&eacute;</span>';
    const expose = (t.expose || []);
    const allowed = (t.allowed || []);
    const chips = (allowed.length ? (allowed[0] === '*' ? ['tous (admin)'] : allowed) : []);
    let ex = '';
    if (chips.length) {
      ex = chips.map(function (n) {
        const on = expose.indexOf(n) !== -1;
        const dec = (t.decisions && t.decisions[n]) || 'ask';
        return '<label class="mono" style="margin-right:8px"><input type="checkbox" ' + (on ? 'checked' : '') +
          ' onchange="toggleExpose(\\'' + esc(s.name) + '\\',\\'' + esc(n) + '\\',this.checked)"> ' + esc(n) +
          ' <select onchange="setDecision(\\'' + esc(s.name) + '\\',\\'' + esc(n) + '\\',this.value)" style="font-size:10px">' +
          '<option value="ask"' + (dec === 'ask' ? ' selected' : '') + '>demander</option>' +
          '<option value="allow"' + (dec === 'allow' ? ' selected' : '') + '>autoriser</option>' +
          '<option value="deny"' + (dec === 'deny' ? ' selected' : '') + '>refuser</option></select></label>';
      }).join('');
    } else {
      ex = '<span class="muted">aucun (liste administrateur vide)</span>';
    }
    h += '<tr><td class="mono">' + esc(s.name) + '</td><td>' + esc(s.transport) + '</td><td>' + stateBadge + '</td>' +
      '<td>' + ex + '</td><td>' +
      ((t.tokenTarget)
        ? '<button class="btn btn-sm btn-sec" onclick="askToken(\\'' + esc(t.tokenTarget) + '\\')">Jeton</button> ' +
          '<button class="btn btn-sm btn-sec" onclick="delToken(\\'' + esc(t.tokenTarget) + '\\')">Oublier le jeton</button> '
        : '') +
      '<button class="btn btn-sm btn-sec" onclick="testServer(\\'' + esc(s.name) + '\\')">Tester la connexion</button> ' +
      '<button class="btn btn-sm btn-sec" onclick="enableServer(\\'' + esc(s.name) + '\\',' + (!enabled) + ')">' + (enabled ? 'D&eacute;sactiver' : 'Activer') + '</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="delServer(\\'' + esc(s.name) + '\\')">Supprimer</button></td></tr>';
  }
  h += '</table><div id="mcpTest"></div>';
  box.innerHTML = h;
  const kr = document.getElementById('mcpKeyring');
  kr.innerHTML = STATE.keyringOk
    ? 'Trousseau syst&egrave;me disponible : les jetons y sont stock&eacute;s (jamais dans un fichier ni un journal).'
    : 'Trousseau indisponible sur ce syst&egrave;me : les serveurs distants qui exigent un jeton resteront hors ligne.';
}

function renderSkills(){
  const box = document.getElementById('skillList');
  const list = STATE.skills || [];
  if (!list.length) { box.innerHTML = '<span class="muted">Aucune comp&eacute;tence. Importez un dossier contenant SKILL.md.</span>'; return; }
  let h = '<table class="t"><tr><th>Nom</th><th>Port&eacute;e</th><th>Description</th><th>Active</th><th></th></tr>';
  for (const s of list) {
    h += '<tr><td class="mono">' + esc(s.name) + '</td><td>' + esc(s.scope) + '</td><td>' +
      esc(s.description || (s.broken ? 'invalide : ' + s.broken : '')) + '</td><td>' +
      (s.broken ? '<span class="badge b-err">invalide</span>' : (s.active ? '<span class="badge b-ok">oui</span>' : '<span class="badge b-mut">non</span>')) +
      '</td><td>' + (s.broken ? '' : '<button class="btn btn-sm btn-sec" onclick="toggleSkill(\\'' + esc(s.scope) + '\\',\\'' + esc(s.name) + '\\',' + (!s.active) + ')">' +
        (s.active ? 'D&eacute;sactiver' : 'Activer') + '</button>') + '</td></tr>';
  }
  box.innerHTML = h + '</table>';
}

function renderCommands(){
  const box = document.getElementById('cmdList');
  const list = STATE.commands || [];
  if (!list.length) { box.innerHTML = '<span class="muted">Aucune commande. Cr&eacute;ez la premi&egrave;re ci-dessous.</span>'; return; }
  let h = '<table class="t"><tr><th>Commande</th><th>Port&eacute;e</th><th>Description</th><th></th></tr>';
  for (const c of list) {
    h += '<tr><td class="mono">/' + esc(c.name) + '</td><td>' + esc(c.scope) + '</td><td>' + esc(c.descriptionText || c.description || '') +
      '</td><td><button class="btn btn-sm btn-sec" onclick="previewCommand(\\'' + esc(c.name) + '\\')">Aper&ccedil;u</button> ' +
      '<button class="btn btn-sm btn-danger" onclick="delCommand(\\'' + esc(c.name) + '\\',\\'' + esc(c.scope) + '\\')">Supprimer</button></td></tr>';
  }
  box.innerHTML = h + '</table><div id="cmdPreview"></div>';
}

function renderAgents(){
  const box = document.getElementById('agentList');
  const list = STATE.agents || [];
  let h = '<table class="t"><tr><th>Agent</th><th>Type</th><th>Outils</th><th>Description</th><th></th></tr>';
  for (const a of list) {
    h += '<tr><td class="mono">' + esc(a.name) + '</td><td>' + (a.builtin ? '<span class="badge b-ok">par d&eacute;faut</span>' : '<span class="badge b-warn">personnalis&eacute;</span>') +
      '</td><td class="mono">' + esc((a.tools || []).join(', ') || 'tous') + '</td><td>' + esc(a.description || '') + '</td><td>' +
      (a.builtin ? '' : '<button class="btn btn-sm btn-danger" onclick="delAgent(\\'' + esc(a.name) + '\\')">Supprimer</button>') + '</td></tr>';
  }
  box.innerHTML = h + '</table>';
}

function renderRules(){
  if (!STATE.rules) return;
  const p = STATE.rules.project || {};
  document.getElementById('rulesProject').value = p.text || '';
  document.getElementById('rulesGlobal').value = STATE.rules.global || '';
  document.getElementById('rulesState').innerHTML = p.exists
    ? 'AGENTS.md existe (' + (p.text || '').length + ' octets) : toute &eacute;criture demande une confirmation apr&egrave;s diff.'
    : 'AGENTS.md absent : la premi&egrave;re &eacute;criture le cr&eacute;e.';
}

function fillPreset(){
  const id = document.getElementById('preset').value;
  const p = (STATE.presets || []).filter(function (x) { return x.id === id; })[0];
  const note = document.getElementById('presetNote');
  if (!p) { note.textContent = ''; return; }
  document.getElementById('srvTransport').value = p.transport;
  document.getElementById('srvName').value = id;
  if (p.transport === 'http') { document.getElementById('srvUrl').value = p.url || ''; }
  else {
    document.getElementById('srvCommand').value = p.command || '';
    document.getElementById('srvArgs').value = (p.args || []).join(' ');
  }
  document.getElementById('srvTokenTarget').value = p.tokenTarget || '';
  note.textContent = p.note || '';
}

function addServer(){
  const transport = document.getElementById('srvTransport').value;
  const m = { type: 'mcpAdd', name: document.getElementById('srvName').value.trim(), transport: transport };
  if (transport === 'http') {
    m.url = document.getElementById('srvUrl').value.trim();
    m.tokenTarget = document.getElementById('srvTokenTarget').value.trim();
    const tok = document.getElementById('srvToken');
    if (tok && tok.value) m.token = tok.value;
  } else {
    m.command = document.getElementById('srvCommand').value.trim();
    m.args = document.getElementById('srvArgs').value.trim() ? document.getElementById('srvArgs').value.trim().split(/\\s+/) : [];
  }
  if (!m.name) { msg('Nom requis.', 'err'); return; }
  post(m);
}
function askToken(target){
  if (!target) { msg('Aucune cible de jeton pour ce serveur.', 'err'); return; }
  post({ type: 'mcpAskToken', target: target });
}
function delToken(target){
  if (!target) { msg('Aucune cible de jeton pour ce serveur.', 'err'); return; }
  post({ type: 'mcpDeleteToken', target: target });
}
function testServer(name){
  document.getElementById('mcpTest').innerHTML = '<span class="muted">Test de ' + esc(name) + '...</span>';
  post({ type: 'mcpTest', name: name });
}
function enableServer(name, enabled){ post({ type: 'mcpEnable', name: name, enabled: enabled }); }
function delServer(name){ post({ type: 'mcpDelete', name: name }); }
function mcpExport(){ post({ type: 'mcpExport' }); }
function mcpImport(){ post({ type: 'mcpImport', text: document.getElementById('mcpJson').value }); }
function setDecision(server, tool, decision){ post({ type: 'mcpDecision', server: server, tool: tool, decision: decision }); }
function toggleExpose(server, tool, on){
  const t = (STATE.tools && STATE.tools[server]) || {};
  const cur = (t.expose || []).slice();
  const i = cur.indexOf(tool);
  if (on && i === -1) cur.push(tool);
  if (!on && i !== -1) cur.splice(i, 1);
  post({ type: 'mcpExpose', name: server, tools: cur });
}
function pickFolder(){ post({ type: 'skillPickFolder' }); }
function skillPreview(){
  const src = document.getElementById('skillSource').value.trim();
  if (!src) { msg('Source requise.', 'err'); return; }
  post({ type: 'skillPreview', source: src });
}
function activateSkill(id){
  post({ type: 'skillActivate', stagingId: id, scope: document.getElementById('skillScope').value });
  document.getElementById('skillPreviewBox').innerHTML = '';
}
function toggleSkill(scope, name, active){ post({ type: 'skillToggle', scope: scope, name: name, active: active }); }
function saveCommand(){
  const name = document.getElementById('cmdName').value.trim();
  const template = document.getElementById('cmdTemplate').value;
  if (!name || !template.trim()) { msg('Nom et mod&egrave;le requis.', 'err'); return; }
  post({ type: 'commandSave', name: name, description: document.getElementById('cmdDesc').value.trim(),
    template: template, scope: document.getElementById('cmdScope').value,
    args: document.getElementById('cmdArgs').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) });
}
function delCommand(name, scope){ post({ type: 'commandDelete', name: name, scope: scope }); }
function previewCommand(name){ post({ type: 'commandPreview', name: name, args: '' }); }
function saveAgent(){
  const name = document.getElementById('agName').value.trim();
  if (!name) { msg('Nom requis.', 'err'); return; }
  post({ type: 'agentSave', name: name, description: document.getElementById('agDesc').value.trim(),
    instructions: document.getElementById('agInstructions').value,
    tools: document.getElementById('agTools').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    model: document.getElementById('agModel').value.trim(), provider: document.getElementById('agProvider').value.trim() });
}
function delAgent(name){ post({ type: 'agentDelete', name: name }); }
function saveRules(scope){
  const text = document.getElementById(scope === 'global' ? 'rulesGlobal' : 'rulesProject').value;
  post({ type: 'rulesSave', scope: scope, text: text, confirm: false });
}
function confirmRules(){
  const text = document.getElementById('rulesProject').value;
  post({ type: 'rulesSave', scope: 'project', text: text, confirm: true });
  document.getElementById('rulesDiff').innerHTML = '';
}
function generateRules(){ post({ type: 'rulesGenerate' }); }
function exportAll(){ post({ type: 'exportAll' }); }
function importAll(){ post({ type: 'importAll', text: document.getElementById('allJson').value }); }

window.addEventListener('message', function (ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'mcp':
      STATE.servers = m.servers || []; STATE.tools = m.tools || {}; STATE.presets = m.presets || [];
      STATE.keyringOk = !!m.keyringOk;
      document.getElementById('preset').innerHTML = '<option value="">-- choisir --</option>' +
        (STATE.presets || []).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.label) +
          (p.needsToken ? ' (necessite Internet et un jeton)' : (p.needsInternet ? ' (necessite Internet)' : '')) + '</option>'; }).join('');
      renderMcp(); if (m.error) msg(m.error, 'err'); break;
    case 'mcpTest': {
      const box = document.getElementById('mcpTest');
      if (!box) break;
      if (m.pending) { box.innerHTML = '<span class="muted">Connexion...</span>'; break; }
      box.innerHTML = m.ok
        ? '<span class="badge b-ok">connect&eacute;</span> outils expos&eacute;s : <span class="mono">' + esc((m.tools || []).join(', ') || 'aucun') + '</span> <span class="muted">(' + m.ms + ' ms)</span>'
        : '<span class="badge b-err">erreur / hors ligne</span> <span class="muted">' + esc(m.error || '') + '</span>';
      break;
    }
    case 'skills': STATE.skills = m.skills || []; STATE.staged = m.staged || []; renderSkills(); if (m.error) msg(m.error, 'err'); break;
    case 'skillPreview': {
      const p = m.preview || {};
      const files = (p.files || []).map(function (f) { return '<li class="mono">' + esc(f) + '</li>'; }).join('');
      document.getElementById('skillPreviewBox').innerHTML =
        '<div class="section"><div class="section-title">Aper&ccedil;u : ' + esc(p.name || '') + '</div>' +
        '<div class="muted">Fichiers :</div><ul>' + files + '</ul>' +
        '<pre class="diff">' + esc((p.excerpt || '').slice(0, 4000)) + '</pre>' +
        '<div class="row"><button class="btn" onclick="activateSkill(\\'' + esc(p.stagingId || '') + '\\')">Activer cette comp&eacute;tence</button>' +
        '<span class="muted">Relisez le contenu : il sera appliqu&eacute; par l\\'agent.</span></div></div>';
      break;
    }
    case 'commands': STATE.commands = m.commands || []; renderCommands(); if (m.error) msg(m.error, 'err'); break;
    case 'commandPreview': {
      const box = document.getElementById('cmdPreview');
      if (box) box.innerHTML = '<pre class="diff">' + esc(m.preview || '(vide)') + '</pre>' +
        ((m.missing || []).length ? '<div class="muted">Arguments manquants : ' + esc(m.missing.join(', ')) + '</div>' : '');
      break;
    }
    case 'agents': STATE.agents = m.agents || []; renderAgents(); if (m.error) msg(m.error, 'err'); break;
    case 'rules': STATE.rules = { project: m.project, global: m.global }; renderRules(); if (m.error) msg(m.error, 'err'); break;
    case 'rulesGenerated': {
      document.getElementById('rulesProject').value = m.text || '';
      const d = m.diff || { lines: [] };
      document.getElementById('rulesDiff').innerHTML = '<div class="muted">Brouillon g&eacute;n&eacute;r&eacute; (' +
        (m.exists ? 'AGENTS.md existe : confirmation requise' : 'fichier absent') + ')</div>' +
        '<pre class="diff">' + d.lines.map(function (l) {
          return '<span class="' + (l.charAt(0) === '+' ? 'd-add' : (l.charAt(0) === '-' ? 'd-del' : '')) + '">' + esc(l) + '</span>';
        }).join('\\n') + '</pre>' +
        '<div class="row"><button class="btn" onclick="confirmRules()">Confirmer et &eacute;crire</button></div>';
      break;
    }
    case 'rulesDiff': {
      const d = m.diff || { lines: [] };
      document.getElementById('rulesDiff').innerHTML = '<div class="muted">AGENTS.md existe d&eacute;j&agrave; : relisez le diff puis confirmez.</div>' +
        '<pre class="diff">' + d.lines.map(function (l) {
          return '<span class="' + (l.charAt(0) === '+' ? 'd-add' : (l.charAt(0) === '-' ? 'd-del' : '')) + '">' + esc(l) + '</span>';
        }).join('\\n') + '</pre>' +
        '<div class="row"><button class="btn" onclick="confirmRules()">Confirmer et &eacute;crire</button></div>';
      break;
    }
    case 'tokenCleared': {
      const el = document.getElementById('srvToken');
      if (el) el.value = '';
      const el2 = document.getElementById('srvTokenTarget');
      if (el2 && m.keepTarget !== true) el2.value = el2.value;
      break;
    }
    case 'json': document.getElementById('allJson').value = m.text || ''; msg('JSON pret (\u00e0 copier ou compl\u00e9ter).', 'ok'); break;
    case 'skillSource': document.getElementById('skillSource').value = m.source || ''; break;
    case 'info': msg(m.text || '', 'ok'); break;
    case 'error': msg(m.text || '', 'err'); break;
    default: break;
  }
});
post({ type: 'load' });
</script>
</body></html>`;
    }
}

module.exports = { AgentExtensionsPanel, GUIDES };
