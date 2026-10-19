/**
 * SUDO STUDIO - AI Providers page (MISSION P2 a,b,e).
 * Configure Local + custom OpenAI-compatible providers, test connections
 * (real calls), toggle the secret filter, view recent audit entries.
 * API keys are only handled as password inputs and go straight to
 * SecretStorage via AIProviderService; they are NEVER displayed, logged,
 * or echoed back. ASCII-only source (accents via \u escapes).
 */
'use strict';

const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const { getAIProviderService } = require('../services/AIProviderService');
const { getAuditLog } = require('../utils/auditLog');

class ProvidersPanel {
    static currentPanel = undefined;

    static createOrShow(extensionUri) {
        if (ProvidersPanel.currentPanel) {
            ProvidersPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            ProvidersPanel.currentPanel._pushAll();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoProviders', 'Fournisseurs IA',
            vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
        );
        ProvidersPanel.currentPanel = new ProvidersPanel(panel, extensionUri);
    }

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.svc = getAIProviderService();
        this.panel.webview.html = this.getHtmlContent();
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (wvFallback.handlePanelMessage(null, msg)) return;
            try { await this._onMessage(msg); }
            catch (e) { this._post({ type: 'error', text: e.message }); }
        }, null, this.disposables);
        this.panel.onDidDispose(() => {
            ProvidersPanel.currentPanel = undefined;
            this.disposables.forEach(d => d && d.dispose());
        });
        setTimeout(() => this._pushAll(), 300);
    }

    _post(msg) { try { this.panel.webview.postMessage(msg); } catch (_) { /* ignore */ } }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'load': await this._pushAll(); break;
            case 'addProvider': {
                const r = await this.svc.addProvider(
                    { name: msg.name, baseUrl: msg.baseUrl, model: msg.model }, msg.key);
                if (!r.ok) { this._post({ type: 'error', text: r.error }); break; }
                this._post({ type: 'info', text: 'Fournisseur ajout\u00e9.' });
                await this._pushAll(); break;
            }
            case 'updateProvider': {
                const patch = {};
                if (msg.name !== undefined) patch.name = msg.name;
                if (msg.baseUrl !== undefined) patch.baseUrl = msg.baseUrl;
                if (msg.model !== undefined) patch.model = msg.model;
                const r = await this.svc.updateProvider(msg.id, patch, msg.key || undefined);
                if (!r.ok) { this._post({ type: 'error', text: r.error }); break; }
                this._post({ type: 'info', text: 'Fournisseur mis \u00e0 jour.' });
                await this._pushAll(); break;
            }
            case 'deleteProvider': {
                const r = await this.svc.deleteProvider(msg.id);
                if (!r.ok) { this._post({ type: 'error', text: r.error }); break; }
                this._post({ type: 'info', text: 'Fournisseur supprim\u00e9.' });
                await this._pushAll(); break;
            }
            case 'setActive': {
                const r = this.svc.setActive(msg.id);
                if (!r.ok) { this._post({ type: 'error', text: r.error }); break; }
                await this._pushAll(); break;
            }
            case 'testProvider': {
                this._post({ type: 'testResult', id: msg.id, pending: true });
                const r = await this.svc.testConnection(msg.id);
                this._post({ type: 'testResult', id: msg.id, ok: r.ok, models: r.models || [], error: r.error || null });
                await this._pushAudit(); break;
            }
            case 'toggleFilter': {
                const r = this.svc.setFilterEnabled(msg.enabled !== false);
                if (!r.ok) { this._post({ type: 'error', text: r.error }); break; }
                await this._pushAll(); break;
            }
            case 'previewFilter': {
                const f = this.svc.previewFilter(msg.text || '');
                this._post({ type: 'filterPreview', text: f.text, masked: f.masked });
                break;
            }
            case 'openCentral':
                vscode.commands.executeCommand('sudoStudio.openCentralMgmtPanel'); break;
            default: break;
        }
    }

    async _pushAll() {
        const list = this.svc.listProviders();
        this._post({
            type: 'providersData',
            providers: list.providers,
            activeId: list.activeId,
            filterEnabled: list.filterEnabled,
            policy: this.svc.getCloudPolicy(),
        });
        await this._pushAudit();
    }

    async _pushAudit() {
        const entries = getAuditLog(60).filter(e => (e.action || '').startsWith('ai.')).slice(0, 10);
        this._post({ type: 'auditData', entries });
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#1f6feb;--ok:#3fb950;--err:#f85149;--warn:#d29922;}
body{background:var(--bg);color:var(--text);font-family:var(--vscode-font-family);padding:14px;margin:0;}
h1{font-size:16px;margin:0 0 10px;}
.section{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;}
.section-title{font-size:13px;font-weight:700;margin-bottom:8px;}
.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px;}
.row:last-child{border-bottom:none;}
.badge{padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600;}
.badge-local{background:rgba(63,185,80,.15);color:var(--ok);border:1px solid rgba(63,185,80,.35);}
.badge-cloud{background:rgba(31,111,235,.15);color:var(--accent);border:1px solid rgba(31,111,235,.4);}
.badge-active{background:var(--ok);color:#04140a;}
.btn{background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;}
.btn-sec{background:transparent;color:var(--text);border:1px solid var(--border);}
.btn-danger{background:transparent;color:var(--err);border:1px solid var(--err);}
.btn-sm{padding:3px 8px;font-size:11px;}
input,select,textarea{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:5px 8px;font-size:12px;}
.form-grid{display:grid;grid-template-columns:110px 1fr;gap:7px;align-items:center;font-size:12px;}
#banner{display:none;background:rgba(210,153,34,.14);border:1px solid var(--warn);border-radius:6px;padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:12px;}
#msg{font-size:12px;min-height:18px;margin-bottom:8px;}
#msg.err{color:var(--err);} #msg.ok{color:var(--ok);}
.mono{font-family:var(--vscode-editor-font-family);font-size:11px;}
table.audit{width:100%;font-size:11px;border-collapse:collapse;}
table.audit td,table.audit th{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left;vertical-align:top;}
.muted{color:var(--muted);}
</style></head><body>
${guardSnippet()}
<h1>\u{1F517} Fournisseurs IA</h1>
<div id="msg"></div>
<div id="banner"></div>

<div class="section"><div class="section-title">Fournisseur actif (agent + chat)</div>
<div class="row"><select id="activeSel" style="flex:1"></select>
<button class="btn btn-sm" onclick="setActive()">Appliquer</button></div>
<div class="muted" style="font-size:11px">Le produit reste 100% hors ligne par d\u00e9faut (Local).</div></div>

<div class="section"><div class="section-title">Fournisseurs configur\u00e9s</div><div id="plist"></div></div>

<div class="section"><div class="section-title">Ajouter un fournisseur (API compatible OpenAI)</div>
<div class="form-grid">
<span>Nom</span><input id="fName" placeholder="ex : OpenAI prod" />
<span>Base URL</span><input id="fUrl" placeholder="https://api.openai.com" />
<span>Mod\u00e8le</span><input id="fModel" placeholder="ex : gpt-4o-mini" />
<span>Cl\u00e9 API</span><input id="fKey" type="password" placeholder="jamais affich\u00e9e, trousseau chiffr\u00e9 uniquement" />
</div>
<div style="margin-top:8px"><button class="btn" onclick="addProvider()">Ajouter</button>
<span class="muted" style="font-size:11px">La cl\u00e9 va uniquement dans SecretStorage.</span></div></div>

<div class="section"><div class="section-title">Filtre secrets avant envoi (cloud uniquement)</div>
<div class="row"><input type="checkbox" id="filterCb" onchange="toggleFilter(this.checked)" />
<label for="filterCb">Masquer les secrets d\u00e9tect\u00e9s dans les requ\u00eates cloud (recommand\u00e9)</label></div>
<div class="section-title" style="margin-top:8px">Aper\u00e7u du filtre (aucun envoi)</div>
<textarea id="filterIn" rows="3" style="width:100%" placeholder="Collez un texte avec un faux secret..."></textarea>
<div style="margin-top:6px"><button class="btn btn-sec btn-sm" onclick="previewFilter()">Aper\u00e7u filtr\u00e9</button></div>
<div id="filterOut" class="mono" style="margin-top:6px;white-space:pre-wrap"></div></div>

<div class="section"><div class="section-title">Politique admin</div><div id="policyBox" class="muted" style="font-size:12px"></div>
<div style="margin-top:6px"><button class="btn btn-sec btn-sm" onclick="vsc({type:'openCentral'})">G\u00e9rer dans Gestion centralis\u00e9e</button></div></div>

<div class="section"><div class="section-title">Derniers appels sortants (audit, sans contenu)</div>
<div id="auditBox"><span class="muted">Chargement...</span></div></div>

<script>
const vscode = acquireVsCodeApi();
function vsc(m){ vscode.postMessage(m); }
function showMsg(t, ok){ const e=document.getElementById('msg'); e.textContent=t||''; e.className=ok===true?'ok':(ok===false?'err':''); }
vsc({type:'load'});

let PROVIDERS=[], ACTIVE='local';
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function setActive(){ const id=document.getElementById('activeSel').value; showMsg(''); vsc({type:'setActive', id}); }
function addProvider(){
  const name=document.getElementById('fName').value, baseUrl=document.getElementById('fUrl').value,
        model=document.getElementById('fModel').value, key=document.getElementById('fKey').value;
  document.getElementById('fKey').value='';
  showMsg(''); vsc({type:'addProvider', name, baseUrl, model, key});
}
function delProvider(id){ if(confirm('Supprimer ce fournisseur ? (la cl\u00e9 sera effac\u00e9e du trousseau)')) vsc({type:'deleteProvider', id}); }
function editProvider(id){
  const p=PROVIDERS.find(x=>x.id===id); if(!p) return;
  const name=prompt('Nom :', p.name); if(name===null) return;
  const baseUrl=prompt('Base URL :', p.baseUrl); if(baseUrl===null) return;
  const model=prompt('Mod\u00e8le :', p.model); if(model===null) return;
  const key=prompt('Nouvelle cl\u00e9 API (vide = inchang\u00e9e) :', '');
  vsc({type:'updateProvider', id, name, baseUrl, model, key: key||undefined});
}
function testProvider(id){ vsc({type:'testProvider', id}); }
function toggleFilter(on){ vsc({type:'toggleFilter', enabled:on}); }
function previewFilter(){ vsc({type:'previewFilter', text: document.getElementById('filterIn').value}); }

function renderList(){
  const box=document.getElementById('plist');
  box.innerHTML=PROVIDERS.map(p=>{
    const isA = p.id===ACTIVE;
    return '<div class="row"><span class="badge '+(p.type==='local'?'badge-local':'badge-cloud')+'">'+(p.type==='local'?'LOCAL':'CLOUD')+'</span>'
      +'<span style="flex:1"><strong>'+esc(p.name)+'</strong><br><span class="muted mono">'+esc(p.baseUrl)+' \u00b7 '+esc(p.model)+'</span></span>'
      +(isA?'<span class="badge badge-active">ACTIF</span>':'')
      +'<button class="btn btn-sec btn-sm" onclick="testProvider(\\''+p.id+'\\')">Tester</button>'
      +(p.type!=='local'?'<button class="btn btn-sec btn-sm" onclick="editProvider(\\''+p.id+'\\')">Modifier</button>'
        +'<button class="btn btn-danger btn-sm" onclick="delProvider(\\''+p.id+'\\')">Suppr.</button>':'')
      +'<div id="test-'+p.id+'" class="mono" style="width:100%;font-size:11px"></div></div>';
  }).join('');
  const sel=document.getElementById('activeSel');
  sel.innerHTML=PROVIDERS.map(p=>'<option value="'+p.id+'"'+(p.id===ACTIVE?' selected':'')+'>'+esc(p.name)+' ('+esc(p.model)+')</option>').join('');
  const b=document.getElementById('banner');
  const act=PROVIDERS.find(p=>p.id===ACTIVE);
  if(act && act.type!=='local'){ b.style.display='block'; b.textContent='Mode connect\u00e9 : '+act.name; }
  else b.style.display='none';
}

window.addEventListener('message', ev=>{
  const m=ev.data;
  if(m.type==='providersData'){
    PROVIDERS=m.providers||[]; ACTIVE=m.activeId||'local';
    document.getElementById('filterCb').checked = m.filterEnabled!==false;
    const pol=m.policy||{cloudEnabled:false,whitelist:[]};
    document.getElementById('policyBox').textContent =
      'Fournisseurs cloud : '+(pol.cloudEnabled?'ACTIV\u00c9S':'d\u00e9sactiv\u00e9s')
      +(pol.whitelist&&pol.whitelist.length?(' \u00b7 domaines : '+pol.whitelist.join(', ')):'')
      +(pol.updatedBy?(' \u00b7 par '+pol.updatedBy):'');
    renderList();
  } else if(m.type==='testResult'){
    const el=document.getElementById('test-'+m.id);
    if(el) el.textContent = m.pending?'Test en cours (appel r\u00e9el)...':(m.ok?('OK \u00b7 mod\u00e8les: '+(m.models||[]).join(', ')||'(aucun)'):'ERREUR: '+(m.error||'?'));
    showMsg('');
  } else if(m.type==='filterPreview'){
    document.getElementById('filterOut').textContent = (m.masked&&m.masked.length?('[masqu\u00e9s: '+m.masked.join(', ')+']\\n'):'[aucun secret d\u00e9tect\u00e9]\\n') + (m.text||'');
  } else if(m.type==='auditData'){
    const rows=(m.entries||[]).map(e=>'<tr><td class="mono">'+esc((e.ts||'').slice(0,19).replace('T',' '))+'</td><td>'+esc(e.actor||'')+'</td><td class="mono">'+esc(e.action||'')+'</td><td class="mono">'+esc(e.detail||'')+'</td><td>'+esc(e.result||'')+'</td></tr>').join('');
    document.getElementById('auditBox').innerHTML='<table class="audit"><tr><th>Heure</th><th>User</th><th>Action</th><th>D\u00e9tail</th><th>R\u00e9sultat</th></tr>'+(rows||'<tr><td colspan="5" class="muted">Aucun appel pour le moment.</td></tr>')+'</table>';
  } else if(m.type==='error'){ showMsg(m.text,false);
  } else if(m.type==='info'){ showMsg(m.text,true); }
});
</script></body></html>`;
    }
}

module.exports = { ProvidersPanel };
