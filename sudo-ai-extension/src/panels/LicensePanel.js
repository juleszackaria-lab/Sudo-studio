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
 * License validation: Ed25519 signature, verified offline with the embedded
 * product public key (see src/license/license.js). No demo key, no bypass.
 */
'use strict';

const vscode = require('vscode');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { appendAudit } = require('../utils/auditLog');
const licCore = require('../license/license');

// ── License definitions ───────────────────────────────────────────────────────
// Key format: base64url(payload).base64url(Ed25519 signature). Editions below
// come from src/license/license.js (single source of truth).
const EDITIONS = licCore.EDITIONS;


// License state and crypto live in src/license/license.js (single source).

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
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'load':       this._load(); break;
            case 'activate': {
                // Validate key: must be a string in expected format
                const key = msg.key;
                if (typeof key !== 'string' || key.length === 0 || key.length > 4096) return;
                // License keys are base64url(payload).base64url(signature)
                if (!/^[A-Za-z0-9\-_.]+$/.test(key)) return;
                this._activate(key);
                break;
            }
            case 'deactivate': this._deactivate(); break;
            case 'addSeat': {
                const email = msg.email;
                if (typeof email !== 'string' || email.length === 0 || email.length > 128) return;
                if (!/^[^@\s]+@[^@\s]+$/.test(email)) return;
                this._addSeat(email);
                break;
            }
            case 'removeSeat': {
                const email = msg.email;
                if (typeof email !== 'string' || email.length > 128) return;
                this._removeSeat(email);
                break;
            }
            case 'export':  this._exportLicense(); break;
            case 'import':  this._importLicense(); break;
            case 'importRevocation': this._importRevocation(); break;
            case 'openUrl': {
                if (typeof msg.url !== 'string' || !/^https?:\/\//.test(msg.url)) return;
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                break;
            }
        }
    }

    _load() {
        const st = licCore.getStatus();
        const view = {
            active: st.state === 'active',
            status: st.state,
            reason: st.reason,
            edition: st.edition,
            editionLabel: st.editionLabel,
            features: st.features,
            company: st.client,
            licenseId: st.licenseId,
            seats: { max: st.seatsMax, allocated: st.seatsAllocated },
            issuedAt: st.issuedAt,
            expiresAt: st.expiresAt,
            machineId: st.machineId,
            activatedAt: st.activatedAt,
            revokedCount: st.revokedCount,
        };
        this.panel.webview.postMessage({ type: 'licenseData', license: view, editions: EDITIONS });
    }

    _activate(key) {
        const result = licCore.activate(key);
        if (!result.ok) {
            this.panel.webview.postMessage({ type: 'activateError', msg: result.reason });
            vscode.window.showErrorMessage('Activation failed - invalid key.');
            appendAudit('LICENSE_ACTIVATE', 'rejected: ' + result.reason, { result: 'error', verified: false });
            return;
        }
        appendAudit('LICENSE_ACTIVATE', `${result.status.editionLabel} for ${result.status.client}`, { result: 'ok', verified: true });
        vscode.window.showInformationMessage(`Sudo Studio ${result.status.editionLabel} active pour ${result.status.client}`);
        this._load();
    }

    _deactivate() {
        const r = licCore.deactivate();
        if (!r.ok) {
            vscode.window.showErrorMessage('Deactivation failed - file still present.');
            appendAudit('LICENSE_DEACTIVATE', 'file still present after delete', { result: 'error', verified: false });
            return;
        }
        appendAudit('LICENSE_DEACTIVATE', 'license removed (Community)', { result: 'ok', verified: true });
        vscode.window.showInformationMessage('Licence desactivee. Retour a l\'edition Community.');
        this._load();
    }

    _addSeat(email) {
        try {
            const lic = licCore.readStoredLicense();
            if (!lic) { vscode.window.showWarningMessage('Aucune licence active.'); return; }
            if (!lic.seats?.allocated) lic.seats = { max: lic.seats?.max || 1, allocated: [] };
            if (lic.seats.allocated.includes(email)) {
                vscode.window.showWarningMessage(`${email} a déjà un siège.`);
                return;
            }
            if (lic.seats.allocated.length >= lic.seats.max) {
                vscode.window.showErrorMessage(`Limite de sièges atteinte (${lic.seats.max}). Passez à une édition supérieure.`);
                return;
            }
            lic.seats.allocated.push(email);
            licCore.writeStoredLicense(lic);
            // TASK 7: post-condition - re-read and confirm the seat.
            const back = licCore.readStoredLicense();
            if (!back || !(back.seats?.allocated || []).includes(email)) {
                vscode.window.showErrorMessage('Attribution incertaine - relecture impossible. Reessayez.');
                appendAudit('LICENSE_ADD_SEAT', `seat for ${email} not confirmed`, { result: 'error', verified: false });
                return;
            }
            appendAudit('LICENSE_ADD_SEAT', `seat allocated to ${email}`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Siège alloué à ${email}`);
            this._load();
        } catch {
            vscode.window.showErrorMessage('Attribution du siège échouée — réessayez.');
        }
    }

    _removeSeat(email) {
        try {
            const lic = licCore.readStoredLicense();
            if (!lic) return;
            if (!lic.seats?.allocated) return;
            // TASK 7: never announce a release that changed nothing.
            if (!lic.seats.allocated.includes(email)) {
                vscode.window.showWarningMessage(`${email} n'a aucun siege alloue.`);
                return;
            }
            lic.seats.allocated = lic.seats.allocated.filter(e => e !== email);
            licCore.writeStoredLicense(lic);
            const back = licCore.readStoredLicense();
            const freed = back && !(back.seats?.allocated || []).includes(email);
            appendAudit('LICENSE_REMOVE_SEAT', `seat released for ${email}`, { result: freed ? 'ok' : 'error', verified: !!freed });
            if (!freed) {
                vscode.window.showErrorMessage('Liberation incertaine - relecture impossible. Reessayez.');
                return;
            }
            vscode.window.showInformationMessage(`✅ Siège libéré pour ${email}`);
            this._load();
        } catch {
            vscode.window.showErrorMessage('Libération du siège échouée — réessayez.');
        }
    }

    async _exportLicense() {
        try {
            const lic = licCore.readStoredLicense();
            if (!lic) { vscode.window.showWarningMessage('Aucune licence active à exporter.'); return; }
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'sudo-studio-license.json')),
                filters: { 'License File': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(lic, null, 2), 'utf8');
            // TASK 7: post-condition - parse the file back and confirm the key.
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            if (!back || back.key !== lic.key) throw new Error('verify-mismatch');
            appendAudit('LICENSE_EXPORT', `license exported to ${path.basename(saveUri.fsPath)}`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`✅ Licence exportée : ${path.basename(saveUri.fsPath)}`);
        } catch {
            vscode.window.showErrorMessage('Export échoué — vérifiez les permissions du dossier.');
        }
    }

    async _importLicense() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'License File': ['json'] } });
            if (!uris || !uris.length) return;
            const stat = fs.statSync(uris[0].fsPath);
            if (stat.size > 64 * 1024) {
                vscode.window.showErrorMessage('Fichier de licence invalide - trop volumineux.');
                return;
            }
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            } catch {
                vscode.window.showErrorMessage('Fichier de licence invalide - JSON malforme.');
                return;
            }
            // Re-validate the imported key (never trust edition/features in the file).
            if (!raw || typeof raw.key !== 'string') {
                vscode.window.showErrorMessage('Fichier de licence invalide - cle manquante.');
                return;
            }
            const v = licCore.verifyLicenseKey(raw.key);
            if (!v.valid) {
                vscode.window.showErrorMessage('Fichier de licence invalide - ' + v.reason);
                appendAudit('LICENSE_IMPORT', 'rejected: ' + v.reason, { result: 'error', verified: false });
                return;
            }
            const cleanLic = {
                key: raw.key,
                activatedAt: new Date().toISOString(),
                seats: {
                    max: v.payload.seats,
                    allocated: Array.isArray(raw.seats?.allocated) ? raw.seats.allocated.filter(e => typeof e === 'string' && e.length < 128).slice(0, v.payload.seats) : [],
                },
            };
            licCore.writeStoredLicense(cleanLic);
            const back = licCore.readStoredLicense();
            if (!back || back.key !== cleanLic.key) {
                vscode.window.showErrorMessage('Import incertain : relecture differente. Reessayez.');
                appendAudit('LICENSE_IMPORT', 'stored but not confirmed on re-read', { result: 'error', verified: false });
                return;
            }
            const label = licCore.EDITIONS[v.payload.edition].label;
            appendAudit('LICENSE_IMPORT', `${label} for ${v.payload.client}`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Licence importee : ${label} pour ${v.payload.client}`);
            this._load();
        } catch {
            vscode.window.showErrorMessage('Import echoue - verifiez le fichier et les permissions.');
        }
    }

    async _importRevocation() {
        // P16: intentionally NOT gated by edition (P11 H7/H8 spec): revocation only
        // ever removes rights, and the License panel must stay usable by any holder.
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'JSON': ['json'] } });
            if (!uris || !uris.length) return;
            const stat = fs.statSync(uris[0].fsPath);
            if (stat.size > 64 * 1024) {
                vscode.window.showErrorMessage('Revocation file too large.');
                return;
            }
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            } catch {
                vscode.window.showErrorMessage('Revocation file is not valid JSON.');
                return;
            }
            const r = licCore.importRevocationList(raw);
            if (!r.ok) {
                vscode.window.showErrorMessage('Revocation import failed - ' + r.reason);
                appendAudit('LICENSE_IMPORT_REVOCATION', r.reason, { result: 'error', verified: false });
                return;
            }
            appendAudit('LICENSE_IMPORT_REVOCATION', `${r.total} revoked id(s), ${r.added} new`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Revocation list imported (${r.total} ids).`);
            this._load();
        } catch {
            vscode.window.showErrorMessage('Revocation import failed.');
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
    <button class="btn btn-secondary" onclick="vscode.postMessage({type:'importRevocation'})">Revocations</button>
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
  if(!lic || !lic.active){
    const reason = (lic && lic.reason) ? lic.reason : '';
    cnt.innerHTML=\`
    <div class="activate-area">
      <h2 style="font-size:16px;margin-bottom:8px">Activate Sudo Studio</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
        Enter your license key to unlock Team and Enterprise features.<br>
        Keys are verified offline (Ed25519 signature, no server needed).<br>
        Format: <code>payload.signature</code> (base64url).
      </p>
      <div class="input-row">
        <input id="keyInput" placeholder="Paste license key (payload.signature)" spellcheck="false">
        <button class="btn btn-green" onclick="activate()">Activate</button>
      </div>
      <div id="errMsg" class="err-msg">\${escH(reason)}</div>
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
      Status: \${lic.active ? 'Actif' : 'Inactif (' + lic.status + ')'} | ID: <code>\${lic.licenseId||'-'}</code><br>
      \${lic.company||'-'} | Machine: \${lic.machineId||'-'}<br>
      Expires: \${expiry} | Activated: \${lic.activatedAt?.slice(0,10)||'-'}
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
    {name:'Community',seats:'1 poste',features:['chat','doctor','sdk']},
    {name:'Team',seats:'10 postes',features:['chat','doctor','sdk','devops','environment','agent']},
    {name:'Enterprise',seats:'Illimit&eacute;',features:ALL_FEATURES},
  ];
  return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">'+defs.map(d=>\`
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px">
      <div style="font-weight:600;margin-bottom:4px">\${d.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">\${d.seats}</div>
      \${d.features.map(f=>\`<div style="font-size:11px;color:#3fb950">✓ \${FEAT_LABELS[f]||f}</div>\`).join('')}
    </div>\`).join('')+'</div><p style="font-size:12px;color:var(--muted);margin-top:10px">Licenses are sold as one-time purchases. Your vendor sets the price - contact them for a quote.</p>';
}

function escH(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { LicensePanel };
