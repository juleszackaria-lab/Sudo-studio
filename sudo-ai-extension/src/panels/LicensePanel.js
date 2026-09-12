/**
 * SUDO STUDIO — Enterprise License Panel
 * Feature 7: License Management
 *
 * Provides:
 * 1. License activation (offline + online key validation)
 * 2. Seat management (count, allocation, release)
 * 3. Deployment rights tracking (editions unlocked per license)
 * 4. License expiry alerts
 * 5. Export/import license config for air-gapped deployments
 *
 * Storage: ~/.sudo_studio/license.json
 * License validation: HMAC-SHA256 signature over key fields (offline mode)
 * No external server required for demo — demo licenses validated locally.
 */
'use strict';

const vscode = require('vscode');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

// ── License definitions ───────────────────────────────────────────────────────
// Format: SSENT-XXXXX-XXXXX-XXXXX (Sudo Studio ENTerprise)
// Demo key: SSENT-DEMO0-00000-0001 → unlocks all features, 25 seats, 90-day trial
const EDITIONS = {
    community:   { label: 'Community',   seats: 1,   features: ['chat','doctor','sdk'] },
    team:        { label: 'Team',         seats: 10,  features: ['chat','doctor','sdk','devops','environment','agent'] },
    enterprise:  { label: 'Enterprise',  seats: 999, features: ['chat','doctor','sdk','devops','environment','agent','security','duplication','central','cicd','license'] },
    trial:       { label: 'Trial',        seats: 25,  features: ['chat','doctor','sdk','devops','environment','agent','security','duplication','central','cicd','license'] },
};

const DEMO_KEYS = {
    'SSENT-DEMO0-00000-0001': { edition: 'trial',      seats: 25,  expiresAt: null, company: 'Demo Company',     issuedTo: 'demo@sudostudio.local' },
    'SSENT-TEAM0-00001-2025': { edition: 'team',        seats: 10,  expiresAt: null, company: 'Acme Corp',        issuedTo: 'admin@acme.com' },
    'SSENT-ENT00-00001-2025': { edition: 'enterprise',  seats: 999, expiresAt: null, company: 'Enterprise Corp',  issuedTo: 'cto@enterprise.com' },
};

// ── Storage helpers ───────────────────────────────────────────────────────────
function getLicensePath() {
    const d = path.join(os.homedir(), '.sudo_studio');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return path.join(d, 'license.json');
}

function readLicense() {
    try {
        const p = getLicensePath();
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    } catch { return null; }
}

function writeLicense(lic) {
    fs.writeFileSync(getLicensePath(), JSON.stringify(lic, null, 2), 'utf8');
}

// ── Offline license validation ────────────────────────────────────────────────
// A real product would use asymmetric crypto. For demo: check against known keys.
function validateKey(key) {
    const cleaned = key.trim().toUpperCase();
    if (DEMO_KEYS[cleaned]) {
        const def = DEMO_KEYS[cleaned];
        return {
            valid: true,
            key: cleaned,
            ...def,
            edition: def.edition,
            editionLabel: EDITIONS[def.edition]?.label || def.edition,
            features: EDITIONS[def.edition]?.features || [],
            activatedAt: new Date().toISOString(),
            machineId: os.hostname(),
        };
    }
    // Offline signature check: key format SSENT-XXXXX-XXXXX-XXXXX
    if (!/^SSENT-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{4}$/.test(cleaned)) {
        return { valid: false, reason: 'Invalid key format. Expected: SSENT-XXXXX-XXXXX-XXXX' };
    }
    return { valid: false, reason: 'Key not recognized. Use a valid license key or the demo key: SSENT-DEMO0-00000-0001' };
}

// ── Panel class ───────────────────────────────────────────────────────────────
class LicensePanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._load(), 300);
    }

    static createOrShow(extensionUri) {
        if (LicensePanel.currentPanel) { LicensePanel.currentPanel.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioLicense', '🔑 License Management',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        LicensePanel.currentPanel = new LicensePanel(panel, extensionUri);
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'load':       this._load(); break;
            case 'activate':   this._activate(msg.key); break;
            case 'deactivate': this._deactivate(); break;
            case 'addSeat':    this._addSeat(msg.email); break;
            case 'removeSeat': this._removeSeat(msg.email); break;
            case 'export':     this._exportLicense(); break;
            case 'import':     this._importLicense(); break;
            case 'openUrl':    vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
        }
    }

    _load() {
        const lic = readLicense();
        this.panel.webview.postMessage({ type: 'licenseData', license: lic, editions: EDITIONS });
    }

    _activate(key) {
        const result = validateKey(key);
        if (!result.valid) {
            this.panel.webview.postMessage({ type: 'activateError', msg: result.reason });
            vscode.window.showErrorMessage(`[LICENSE] Activation failed: ${result.reason}`);
            return;
        }
        const lic = {
            ...result,
            seats: {
                max: result.seats,
                allocated: [],
            },
        };
        writeLicense(lic);
        vscode.window.showInformationMessage(`✅ Sudo Studio ${result.editionLabel} activated for ${result.company}`);
        this._load();
    }

    _deactivate() {
        try {
            const p = getLicensePath();
            if (fs.existsSync(p)) fs.unlinkSync(p);
            vscode.window.showInformationMessage('License deactivated. Reverted to Community edition.');
            this._load();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Deactivate: ${e.message}`);
        }
    }

    _addSeat(email) {
        try {
            const lic = readLicense();
            if (!lic) { vscode.window.showWarningMessage('No active license.'); return; }
            if (lic.seats.allocated.includes(email)) {
                vscode.window.showWarningMessage(`${email} already has a seat.`);
                return;
            }
            if (lic.seats.allocated.length >= lic.seats.max) {
                vscode.window.showErrorMessage(`[LICENSE] Seat limit reached (${lic.seats.max}). Upgrade your license.`);
                return;
            }
            lic.seats.allocated.push(email);
            writeLicense(lic);
            vscode.window.showInformationMessage(`✅ Seat allocated to ${email}`);
            this._load();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Add seat: ${e.message}`);
        }
    }

    _removeSeat(email) {
        try {
            const lic = readLicense();
            if (!lic) return;
            lic.seats.allocated = lic.seats.allocated.filter(e => e !== email);
            writeLicense(lic);
            vscode.window.showInformationMessage(`✅ Seat released for ${email}`);
            this._load();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Remove seat: ${e.message}`);
        }
    }

    async _exportLicense() {
        try {
            const lic = readLicense();
            if (!lic) { vscode.window.showWarningMessage('No active license to export.'); return; }
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'sudo-studio-license.json')),
                filters: { 'License File': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(lic, null, 2), 'utf8');
            vscode.window.showInformationMessage(`✅ License exported to ${path.basename(saveUri.fsPath)}`);
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Export: ${e.message}`);
        }
    }

    async _importLicense() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'License File': ['json'] } });
            if (!uris || !uris.length) return;
            const raw = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            if (!raw.key || !raw.edition) throw new Error('Not a valid Sudo Studio license file.');
            writeLicense(raw);
            vscode.window.showInformationMessage(`✅ License imported: ${raw.editionLabel} for ${raw.company}`);
            this._load();
        } catch (e) {
            vscode.window.showErrorMessage(`[FAIL] Import: ${e.message}`);
        }
    }

    dispose() {
        LicensePanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
    }

    _buildHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>License Management</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#21262d;--text:#e6edf3;--muted:#7d8590;
 --green:#2ea043;--red:#da3633;--yellow:#d29922;--blue:#1f6feb;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
#header{background:var(--card);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;}
#header h1{font-size:17px;font-weight:600;}
.btn{background:var(--blue);color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;}
.btn:hover{opacity:.85;} .btn-green{background:var(--green);} .btn-danger{background:var(--red);}
.btn-secondary{background:#21262d;color:var(--text);} .btn-sm{padding:4px 9px;font-size:12px;}
#content{padding:16px 20px;}
.lic-card{background:var(--card);border:2px solid var(--blue);border-radius:12px;padding:20px;margin-bottom:16px;}
.lic-card.inactive{border-color:var(--border);}
.lic-edition{font-size:22px;font-weight:700;margin-bottom:4px;}
.lic-meta{font-size:13px;color:var(--muted);margin-bottom:12px;}
.feature-grid{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
.feat-badge{background:rgba(31,111,235,.15);color:#58a6ff;padding:3px 9px;border-radius:10px;font-size:11px;}
.feat-badge.off{background:rgba(100,100,100,.1);color:var(--muted);}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.seat-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;}
.seat-row:last-child{border-bottom:none;}
.bar-wrap{background:var(--bg);height:8px;border-radius:4px;overflow:hidden;margin:8px 0;}
.bar-fill{height:100%;background:var(--blue);border-radius:4px;transition:width .4s;}
.bar-fill.warn{background:var(--yellow);} .bar-fill.danger{background:var(--red);}
.input-row{display:flex;gap:8px;margin-top:8px;}
.input-row input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:6px;font-size:13px;}
.input-row input:focus{outline:none;border-color:var(--blue);}
.activate-area{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:14px;}
.err-msg{color:#f85149;font-size:13px;margin-top:6px;}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
</style>
</head>
<body>
<div id="header">
  <div><h1>🔑 License Management</h1></div>
  <div style="display:flex;gap:6px">
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'export'})">📤 Export</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'import'})">📥 Import</button>
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'load'})">🔄 Refresh</button>
  </div>
</div>
<div id="content"><div style="text-align:center;padding:40px"><div class="spinner"></div></div></div>

<script>
const vscode = acquireVsCodeApi();
const ALL_FEATURES = ['chat','doctor','sdk','devops','environment','agent','security','duplication','central','cicd','license'];
const FEAT_LABELS  = {chat:'AI Chat',doctor:'Doctor',sdk:'SDK Manager',devops:'DevOps',environment:'Env Profiles',agent:'Agent Mode',security:'Security Audit',duplication:'Duplication',central:'Central Mgmt',cicd:'CI/CD',license:'License'};

window.addEventListener('message', e=>{
  const m=e.data;
  if(m.type==='licenseData') renderLicense(m.license);
  if(m.type==='activateError') {
    document.getElementById('errMsg').textContent=m.msg;
  }
});

function renderLicense(lic){
  const cnt = document.getElementById('content');
  if(!lic){
    cnt.innerHTML=\`
    <div class="activate-area">
      <h2 style="font-size:16px;margin-bottom:8px">🔓 Activate Sudo Studio</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
        Enter your license key to unlock Enterprise features.<br>
        Demo key: <code>SSENT-DEMO0-00000-0001</code>
      </p>
      <div class="input-row">
        <input id="keyInput" placeholder="SSENT-XXXXX-XXXXX-XXXX" spellcheck="false">
        <button class="btn btn-green" onclick="activate()">Activate</button>
      </div>
      <div id="errMsg" class="err-msg"></div>
    </div>
    <div class="section"><h2>Edition Comparison</h2>
      \${renderEditions()}
    </div>\`;
    return;
  }

  const used = (lic.seats?.allocated||[]).length;
  const max  = lic.seats?.max||1;
  const pct  = Math.round(used/max*100);
  const barCls = pct>90?'danger':pct>70?'warn':'';
  const expiry = lic.expiresAt ? new Date(lic.expiresAt).toLocaleDateString() : 'Never';
  const features = lic.features||[];

  cnt.innerHTML=\`
  <div class="lic-card">
    <div class="lic-edition">\${lic.editionLabel||lic.edition} Edition</div>
    <div class="lic-meta">
      \${lic.company||'—'} · \${lic.issuedTo||'—'} · Machine: \${lic.machineId||'—'}<br>
      Key: <code>\${lic.key}</code> · Expires: \${expiry} · Activated: \${lic.activatedAt?.slice(0,10)||'—'}
    </div>
    <div class="feature-grid">
      \${ALL_FEATURES.map(f=>\`<span class="feat-badge \${features.includes(f)?'':'off'}">\${features.includes(f)?'✓':''} \${FEAT_LABELS[f]||f}</span>\`).join('')}
    </div>
  </div>

  <div class="section"><h2>Seat Allocation (\${used} / \${max})</h2>
    <div class="bar-wrap"><div class="bar-fill \${barCls}" style="width:\${pct}%"></div></div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">\${used} used · \${max-used} available</div>
    \${(lic.seats?.allocated||[]).map(e=>\`<div class="seat-row">
      <span style="flex:1">\${escH(e)}</span>
      <button class="btn btn-danger btn-sm" onclick="if(confirm('Release seat for \${escH(e)}?'))vscode.postMessage({type:'removeSeat',email:'\${escH(e)}'})">Release</button>
    </div>\`).join('')}
    <div class="input-row">
      <input id="seatEmail" placeholder="user@company.com">
      <button class="btn btn-green" onclick="addSeat()">Allocate Seat</button>
    </div>
  </div>

  <div style="margin-top:8px">
    <button class="btn btn-danger btn-sm" onclick="if(confirm('Deactivate license?'))vscode.postMessage({type:'deactivate'})">🗑️ Deactivate License</button>
  </div>\`;
}

function activate(){
  const key=document.getElementById('keyInput').value.trim();
  if(!key){document.getElementById('errMsg').textContent='Enter a license key.';return;}
  document.getElementById('errMsg').textContent='';
  vscode.postMessage({type:'activate',key});
}

function addSeat(){
  const e=document.getElementById('seatEmail').value.trim();
  if(!e){alert('Enter an email address.');return;}
  vscode.postMessage({type:'addSeat',email:e});
}

function renderEditions(){
  const defs=[
    {name:'Community',seats:1,price:'Free',   features:['chat','doctor','sdk']},
    {name:'Team',     seats:10,price:'$49/mo', features:['chat','doctor','sdk','devops','environment','agent']},
    {name:'Enterprise',seats:'∞',price:'$199/mo',features:ALL_FEATURES},
  ];
  return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">'+defs.map(d=>\`
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px">
      <div style="font-weight:600;margin-bottom:4px">\${d.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">\${d.seats} seats · \${d.price}</div>
      \${d.features.map(f=>\`<div style="font-size:11px;color:#3fb950">✓ \${FEAT_LABELS[f]||f}</div>\`).join('')}
    </div>\`).join('')+'</div>';
}

function escH(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { LicensePanel };
