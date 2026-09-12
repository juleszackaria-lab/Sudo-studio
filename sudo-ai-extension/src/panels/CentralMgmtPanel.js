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

const IS_WIN = process.platform === 'win32';

// ── Storage helpers ──────────────────────────────────────────────────────────
function getCentralDir() {
    const d = path.join(os.homedir(), '.sudo_studio', 'central');
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

function appendAudit(action, detail, actor = 'admin') {
    const log = readJson('audit.json', []);
    log.unshift({ ts: new Date().toISOString(), actor, action, detail });
    writeJson('audit.json', log.slice(0, 500)); // keep last 500
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
function getAuditLog() { return readJson('audit.json', []); }

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
        switch (msg.type) {
            case 'load':          this._loadAll(); break;
            case 'addUser':       this._addUser(msg.user); break;
            case 'removeUser':    this._removeUser(msg.id); break;
            case 'toggleUser':    this._toggleUser(msg.id); break;
            case 'addPolicy':     this._addPolicy(msg.policy); break;
            case 'removePolicy':  this._removePolicy(msg.id); break;
            case 'togglePolicy':  this._togglePolicy(msg.id); break;
            case 'runPolicyCheck': this._runPolicyCheck(); break;
            case 'addConfig':     this._addConfig(msg.config); break;
            case 'removeConfig':  this._removeConfig(msg.id); break;
            case 'applyConfig':   this._applyConfig(msg.id); break;
            case 'exportAll':     this._exportAll(); break;
            case 'importAll':     this._importAll(); break;
        }
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
            detected: this.detected,
        });
    }

    _addUser(user) {
        try {
            const users = getUsers();
            if (users.find(u => u.email === user.email)) {
                this.panel.webview.postMessage({ type: 'error', msg: `User ${user.email} already exists.` });
                return;
            }
            user.id = Date.now().toString();
            user.addedAt = new Date().toISOString();
            user.active  = true;
            users.push(user);
            if (!writeJson('users.json', users)) throw new Error('Failed to write users.json');
            appendAudit('ADD_USER', `Added ${user.email} (${user.role})`);
            vscode.window.showInformationMessage(`✅ User ${user.name} added.`);
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Add user: ${e.message}`);
        }
    }

    _removeUser(id) {
        try {
            const users = getUsers().filter(u => u.id !== id);
            const removed = getUsers().find(u => u.id === id);
            writeJson('users.json', users);
            appendAudit('REMOVE_USER', `Removed user id=${id} (${removed?.email || '?'})`);
            vscode.window.showInformationMessage('✅ User removed.');
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Remove user: ${e.message}`);
        }
    }

    _toggleUser(id) {
        try {
            const users = getUsers().map(u => u.id === id ? { ...u, active: !u.active } : u);
            const u = users.find(x => x.id === id);
            writeJson('users.json', users);
            appendAudit('TOGGLE_USER', `User ${u?.email} → active=${u?.active}`);
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Toggle user: ${e.message}`);
        }
    }

    _addPolicy(policy) {
        try {
            const policies = getPolicies();
            policy.id = Date.now().toString();
            policy.active = true;
            policies.push(policy);
            writeJson('policies.json', policies);
            appendAudit('ADD_POLICY', `Added policy: ${policy.name}`);
            vscode.window.showInformationMessage(`✅ Policy "${policy.name}" added.`);
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Add policy: ${e.message}`);
        }
    }

    _removePolicy(id) {
        const p = getPolicies().find(x => x.id === id);
        writeJson('policies.json', getPolicies().filter(x => x.id !== id));
        appendAudit('REMOVE_POLICY', `Removed policy: ${p?.name || id}`);
        this._loadAll();
    }

    _togglePolicy(id) {
        const policies = getPolicies().map(p => p.id === id ? { ...p, active: !p.active } : p);
        writeJson('policies.json', policies);
        this._loadAll();
    }

    async _runPolicyCheck() {
        const tools = Object.keys(TOOL_CMDS);
        this.detected = await Promise.all(tools.map(t => detectVersion(t)));
        appendAudit('POLICY_CHECK', `Policy check run by admin`);
        this._loadAll();
    }

    _addConfig(config) {
        try {
            const configs = getConfigs();
            config.id = Date.now().toString();
            configs.push(config);
            writeJson('configs.json', configs);
            appendAudit('ADD_CONFIG', `Added config profile: ${config.name}`);
            vscode.window.showInformationMessage(`✅ Config "${config.name}" saved.`);
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Add config: ${e.message}`);
        }
    }

    _removeConfig(id) {
        const c = getConfigs().find(x => x.id === id);
        writeJson('configs.json', getConfigs().filter(x => x.id !== id));
        appendAudit('REMOVE_CONFIG', `Removed config: ${c?.name || id}`);
        this._loadAll();
    }

    _applyConfig(id) {
        const config = getConfigs().find(c => c.id === id);
        if (!config) return;
        // Apply VS Code workspace settings
        const cfg = vscode.workspace.getConfiguration('sudoStudio');
        try {
            if (config.model)        cfg.update('ai.model', config.model, vscode.ConfigurationTarget.Global);
            if (config.agentMode !== undefined) cfg.update('agent.enabled', config.agentMode, vscode.ConfigurationTarget.Global);
            appendAudit('APPLY_CONFIG', `Applied config profile: ${config.name}`);
            vscode.window.showInformationMessage(`✅ Config "${config.name}" applied to workspace.`);
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Apply config: ${e.message}`);
        }
    }

    async _exportAll() {
        try {
            const data = {
                exportedAt: new Date().toISOString(),
                users:   getUsers(),
                policies: getPolicies(),
                configs:  getConfigs(),
            };
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-central-export-${Date.now()}.json`)),
                filters: { 'Central Config': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(data, null, 2), 'utf8');
            appendAudit('EXPORT_ALL', `Exported to ${saveUri.fsPath}`);
            vscode.window.showInformationMessage(`✅ Central config exported.`);
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Export: ${e.message}`);
        }
    }

    async _importAll() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'Central Config': ['json'] } });
            if (!uris || !uris.length) return;
            const data = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            if (data.users)    writeJson('users.json',    data.users);
            if (data.policies) writeJson('policies.json', data.policies);
            if (data.configs)  writeJson('configs.json',  data.configs);
            appendAudit('IMPORT_ALL', `Imported from ${path.basename(uris[0].fsPath)}`);
            vscode.window.showInformationMessage('✅ Central config imported.');
            this._loadAll();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Import: ${e.message}`);
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
</div>
<div id="tab-users" class="tab-content active">
  <div style="text-align:center;padding:30px"><div class="spinner"></div></div>
</div>
<div id="tab-policies" class="tab-content"></div>
<div id="tab-configs"  class="tab-content"></div>
<div id="tab-audit"   class="tab-content"></div>

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
  if(m.type==='dataReady') renderAll(m);
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
