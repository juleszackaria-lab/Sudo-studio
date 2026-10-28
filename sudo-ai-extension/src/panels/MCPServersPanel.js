/**
 * SUDO STUDIO - MCP Servers page (MISSION P50-1).
 * List/add/test/delete global MCP servers (stdio + remote HTTP) through the
 * supervised sudo-agent server, and store HTTP bearer tokens in the OS
 * credential vault (Windows Credential Manager) via /keyring endpoints.
 * Secrets are only handled as password inputs and go straight to the vault;
 * they are NEVER displayed, logged, or echoed back. ASCII-only source
 * (accents via \u escapes).
 */
'use strict';

const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const { getAgentHost } = require('../agent/agentHost');

class MCPServersPanel {
    static currentPanel = undefined;

    static createOrShow(extensionUri) {
        if (MCPServersPanel.currentPanel) {
            MCPServersPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            MCPServersPanel.currentPanel._pushAll();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoMcpServers', 'Serveurs MCP',
            vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
        );
        MCPServersPanel.currentPanel = new MCPServersPanel(panel, extensionUri);
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
            MCPServersPanel.currentPanel = undefined;
            this.disposables.forEach(d => d && d.dispose());
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

    async _call(pathname, opts) {
        const srv = this._server();
        let r;
        try { r = await srv.request(pathname, opts || {}); }
        catch (e) { throw new Error('serveur agent injoignable : ' + e.message); }
        if (!r || r.status < 200 || r.status >= 300) {
            throw new Error((r && r.body && r.body.error) || ('erreur HTTP ' + (r && r.status)));
        }
        return r.body || {};
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'load': await this._pushAll(); break;
            case 'addServer': {
                const body = { name: msg.name, transport: msg.transport };
                if (msg.transport === 'http') {
                    body.url = msg.url;
                    if (msg.tokenTarget) body.tokenTarget = msg.tokenTarget;
                } else {
                    body.command = msg.command;
                    if (msg.args && msg.args.length) body.args = msg.args;
                    if (msg.cwd) body.cwd = msg.cwd;
                }
                await this._call('/mcp/servers', { method: 'POST', body });
                this._post({ type: 'info', text: 'Serveur MCP ajout\u00e9.' });
                await this._pushAll(); break;
            }
            case 'deleteServer': {
                await this._call('/mcp/servers/' + encodeURIComponent(msg.name), { method: 'DELETE' });
                this._post({ type: 'info', text: 'Serveur MCP supprim\u00e9.' });
                await this._pushAll(); break;
            }
            case 'testServer': {
                this._post({ type: 'testResult', name: msg.name, pending: true });
                try {
                    const r = await this._call('/mcp/servers/' + encodeURIComponent(msg.name) + '/test',
                        { method: 'POST', body: {}, timeoutMs: 60000 });
                    this._post({ type: 'testResult', name: msg.name, ok: true, tools: r.tools || [], ms: r.ms || 0 });
                } catch (e) {
                    this._post({ type: 'testResult', name: msg.name, ok: false, error: e.message });
                }
                break;
            }
            case 'setToken': {
                await this._call('/keyring/secret', { method: 'POST', body: { target: msg.target, secret: msg.secret } });
                this._post({ type: 'info', text: 'Jeton enregistr\u00e9 dans le trousseau.' });
                this._post({ type: 'tokenCleared' });
                await this._pushAll(); break;
            }
            case 'deleteToken': {
                await this._call('/keyring/secret', { method: 'DELETE', body: { target: msg.target } });
                this._post({ type: 'info', text: 'Jeton supprim\u00e9 du trousseau.' });
                await this._pushAll(); break;
            }
            default: break;
        }
    }

    async _pushAll() {
        try {
            const data = await this._call('/mcp/servers', { method: 'GET' });
            let ring = { available: false, platform: process.platform };
            try { ring = await this._call('/keyring/status', { method: 'GET' }); }
            catch (_) { /* keyring status best-effort */ }
            // Redacted by the server (names only); never contains secrets.
            this._post({ type: 'mcpData', servers: data.servers || [], keyring: ring });
        } catch (e) {
            this._post({ type: 'mcpData', servers: [], keyring: { available: false }, agentError: e.message });
        }
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
.badge{padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;}
.badge-stdio{background:rgba(63,185,80,.15);color:var(--ok);border:1px solid rgba(63,185,80,.35);}
.badge-http{background:rgba(31,111,235,.15);color:var(--accent);border:1px solid rgba(31,111,235,.4);}
.btn{background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;}
.btn-sec{background:transparent;color:var(--text);border:1px solid var(--border);}
.btn-danger{background:transparent;color:var(--err);border:1px solid var(--err);}
.btn-sm{padding:3px 8px;font-size:11px;}
input,select,textarea{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:5px 8px;font-size:12px;}
.form-grid{display:grid;grid-template-columns:110px 1fr;gap:7px;align-items:center;font-size:12px;}
#msg{font-size:12px;min-height:18px;margin-bottom:8px;}
#msg.err{color:var(--err);} #msg.ok{color:var(--ok);}
.mono{font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all;}
.muted{color:var(--muted);}
#ringBanner{display:none;border-radius:6px;padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:12px;}
#ringBanner.off{display:block;background:rgba(248,81,73,.12);border:1px solid var(--err);}
#ringBanner.on{display:block;background:rgba(63,185,80,.12);border:1px solid var(--ok);}
.testres{font-size:11px;margin-top:4px;}
.testres.ok{color:var(--ok);} .testres.err{color:var(--err);}
</style></head><body>
${guardSnippet()}
<h1>\u{1F50C} Serveurs MCP</h1>
<div id="msg"></div>
<div id="ringBanner"></div>

<div class="section"><div class="section-title">Serveurs configur\u00e9s (fichier global, jamais dans le projet)</div><div id="slist"><span class="muted">Chargement...</span></div></div>

<div class="section"><div class="section-title">Ajouter un serveur</div>
<div class="form-grid">
<span>Nom</span><input id="fName" placeholder="ex : github-mcp" />
<span>Transport</span><select id="fTransport" onchange="syncTransport()"><option value="stdio">stdio (processus local)</option><option value="http">http (serveur distant)</option></select>
<span id="lCmd">Commande</span><input id="fCommand" placeholder="ex : npx" />
<span id="lArgs">Arguments</span><textarea id="fArgs" rows="2" style="width:100%" placeholder="un argument par ligne"></textarea>
<span id="lCwd">Dossier</span><input id="fCwd" placeholder="optionnel" />
<span id="lUrl" style="display:none">URL</span><input id="fUrl" style="display:none" placeholder="https://..." />
<span id="lTok" style="display:none">Cible jeton</span><input id="fTokenTarget" style="display:none" placeholder="ex : SudoStudio/mcp/github-mcp" />
</div>
<div style="margin-top:8px"><button class="btn" onclick="addServer()">Ajouter</button>
<span class="muted" style="font-size:11px">http distant = https obligatoire ; pas de secret ici.</span></div></div>

<div class="section"><div class="section-title">Jeton HTTP (trousseau OS, jamais affich\u00e9)</div>
<div class="form-grid">
<span>Cible</span><input id="tTarget" placeholder="ex : SudoStudio/mcp/github-mcp" />
<span>Jeton</span><input id="tSecret" type="password" placeholder="coll\u00e9 puis oubli\u00e9 : va au trousseau uniquement" />
</div>
<div style="margin-top:8px"><button class="btn" onclick="setToken()">Enregistrer</button>
<button class="btn btn-danger btn-sm" onclick="deleteToken()">Supprimer</button></div></div>

<div class="section"><div class="section-title">R\u00e8gles</div>
<div class="muted" style="font-size:12px">Chaque appel d'outil MCP passe par les permissions de l'agent et la liste d'autorisation admin (fichier <span class="mono">mcp_policy.json</span>, ferm\u00e9e par d\u00e9faut). Tout est journalis\u00e9. Les jetons ne sont jamais \u00e9crits dans la configuration ni dans les journaux.</div></div>

<script>
const vscode = acquireVsCodeApi();
function vsc(m){ vscode.postMessage(m); }
function showMsg(t, ok){ const e=document.getElementById('msg'); e.textContent=t||''; e.className=ok===true?'ok':(ok===false?'err':''); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
vsc({type:'load'});

function syncTransport(){
  const http = document.getElementById('fTransport').value === 'http';
  const show = (id, v) => { document.getElementById(id).style.display = v ? '' : 'none'; };
  show('lCmd', !http); show('fCommand', !http); show('lArgs', !http); show('fArgs', !http); show('lCwd', !http); show('fCwd', !http);
  show('lUrl', http); show('fUrl', http); show('lTok', http); show('fTokenTarget', http);
}

function addServer(){
  const transport = document.getElementById('fTransport').value;
  const name = document.getElementById('fName').value.trim();
  if (!name) { showMsg('Nom requis.', false); return; }
  showMsg('');
  const msg = { type:'addServer', name, transport };
  if (transport === 'http') {
    msg.url = document.getElementById('fUrl').value.trim();
    msg.tokenTarget = document.getElementById('fTokenTarget').value.trim();
    if (!msg.url) { showMsg('URL requise.', false); return; }
  } else {
    msg.command = document.getElementById('fCommand').value.trim();
    msg.args = document.getElementById('fArgs').value.split('\\n').map(s=>s.trim()).filter(Boolean);
    msg.cwd = document.getElementById('fCwd').value.trim();
    if (!msg.command) { showMsg('Commande requise.', false); return; }
  }
  vsc(msg);
}
function deleteServer(name){ if (confirm('Supprimer le serveur MCP \\u00ab ' + name + ' \\u00bb ?')) { showMsg(''); vsc({type:'deleteServer', name}); } }
function testServer(name){ showMsg(''); vsc({type:'testServer', name}); }
function setToken(){
  const target = document.getElementById('tTarget').value.trim();
  const secret = document.getElementById('tSecret').value;
  if (!target || !secret) { showMsg('Cible + jeton requis.', false); return; }
  showMsg('');
  vsc({type:'setToken', target, secret});
}
function deleteToken(){
  const target = document.getElementById('tTarget').value.trim();
  if (!target) { showMsg('Cible requise.', false); return; }
  if (!confirm('Supprimer le jeton \\u00ab ' + target + ' \\u00bb du trousseau ?')) return;
  showMsg('');
  vsc({type:'deleteToken', target});
}

function renderList(servers){
  const box = document.getElementById('slist');
  if (!servers.length) { box.innerHTML = '<span class="muted">Aucun serveur MCP configur\u00e9.</span>'; return; }
  let h = '';
  for (const s of servers) {
    const badge = s.transport === 'http' ? '<span class="badge badge-http">http</span>' : '<span class="badge badge-stdio">stdio</span>';
    const detail = s.transport === 'http' ? esc(s.url||'') : esc(s.command||'');
    const allow = (s.allowlist === '*') ? 'autoris\u00e9s : *' : ('autoris\u00e9s : ' + (s.allowlist||[]).length + ' outil(s)');
    const tok = s.hasTokenTarget ? ' \u00b7 cible jeton configur\u00e9e' : '';
    h += '<div class="row" style="align-items:flex-start"><div style="flex:1">' + badge + ' <b>' + esc(s.name) + '</b>'
      + '<div class="mono muted">' + detail + '</div>'
      + '<div class="muted" style="font-size:11px">' + esc(allow) + esc(tok) + '</div>'
      + '<div class="testres" id="tres-' + esc(s.name) + '"></div></div>'
      + '<button class="btn btn-sec btn-sm" onclick="testServer(\\'' + esc(s.name) + '\\')">Tester</button>'
      + '<button class="btn btn-danger btn-sm" onclick="deleteServer(\\'' + esc(s.name) + '\\')">Supprimer</button></div>';
  }
  box.innerHTML = h;
}

window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type === 'mcpData') {
    renderList(m.servers || []);
    const b = document.getElementById('ringBanner');
    if (m.agentError) {
      b.className = 'off'; b.textContent = 'Serveur agent : ' + m.agentError;
    } else if (m.keyring && m.keyring.available) {
      b.className = 'on'; b.textContent = 'Trousseau OS disponible : les jetons sont chiffr\u00e9s par le syst\u00e8me.';
    } else {
      b.className = 'off'; b.textContent = 'Trousseau OS indisponible sur cette machine : les serveurs HTTP \u00e0 jeton sont d\u00e9sactiv\u00e9s (erreur claire, pas de mode d\u00e9grad\u00e9 silencieux).';
    }
  } else if (m.type === 'testResult') {
    const el = document.getElementById('tres-' + (m.name||''));
    if (m.pending) { if (el) { el.className='testres'; el.textContent='Test en cours...'; } }
    else if (m.ok) { if (el) { el.className='testres ok'; el.textContent='OK (' + (m.ms||0) + ' ms) : ' + (m.tools||[]).slice(0,12).join(', ') + ((m.tools||[]).length > 12 ? '...' : ''); } }
    else { if (el) { el.className='testres err'; el.textContent='ECHEC : ' + (m.error||''); } }
  } else if (m.type === 'info') { showMsg(m.text, true); }
  else if (m.type === 'error') { showMsg(m.text, false); }
  else if (m.type === 'tokenCleared') { document.getElementById('tSecret').value=''; }
});
</script>
</body></html>`;
    }
}

module.exports = { MCPServersPanel };
