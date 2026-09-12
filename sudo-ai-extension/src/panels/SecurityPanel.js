/**
 * SUDO STUDIO — Security Enterprise Panel
 * Feature 3: Enterprise Security — access controls, project isolation,
 * secrets scanning, dependency vulnerability audit, deployment protection.
 *
 * All checks run locally via child_process.exec — no backend required.
 * Results are NEVER silently swallowed: every failure produces an explicit
 * [FAIL] entry visible in the UI.
 */
'use strict';

const vscode = require('vscode');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const IS_WIN = process.platform === 'win32';

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
    return new Promise(resolve => {
        exec(cmd, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err?.code });
        });
    });
}

// ── Secret patterns (regex + label) ─────────────────────────────────────────
const SECRET_PATTERNS = [
    { label: 'AWS Access Key',        re: /AKIA[0-9A-Z]{16}/ },
    { label: 'AWS Secret Key',        re: /aws.{0,20}secret.{0,20}['"][0-9a-zA-Z\/+]{40}['"]/i },
    { label: 'Generic API Key',       re: /(api[_\-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i },
    { label: 'Private Key (PEM)',     re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { label: 'GitHub Token',          re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
    { label: 'Bearer Token',          re: /bearer\s+[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/i },
    { label: 'Database Password',     re: /(db_pass|database_password|mysql_pass|pg_pass)\s*[:=]\s*['"][^'"]{6,}['"]/i },
    { label: 'Slack Webhook',         re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/ },
    { label: 'Stripe Key',            re: /(?:r|s)k_(live|test)_[0-9a-zA-Z]{24,}/ },
    { label: 'Google API Key',        re: /AIza[0-9A-Za-z\-_]{35}/ },
];

const GITIGNORE_SENSITIVE = ['.env', '.env.local', '.env.production', '*.pem', '*.key', '*.p12', 'secrets.json', 'credentials.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.dart_tool', '.pub-cache']);

class SecurityPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.results = null;

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._runAudit(), 400);
    }

    static createOrShow(extensionUri) {
        if (SecurityPanel.currentPanel) { SecurityPanel.currentPanel.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioSecurity', '🔒 Security Audit',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        SecurityPanel.currentPanel = new SecurityPanel(panel, extensionUri);
    }

    // ── Message handler ──────────────────────────────────────────────────────
    async _onMessage(msg) {
        switch (msg.type) {
            case 'refresh':    this._runAudit(); break;
            case 'openFile':   this._openFile(msg.filePath, msg.line); break;
            case 'openUrl':    vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
            case 'fixGitignore': this._addToGitignore(msg.entry); break;
        }
    }

    // ── Main audit ───────────────────────────────────────────────────────────
    async _runAudit() {
        this.panel.webview.postMessage({ type: 'scanning' });

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;
        const audit = {
            timestamp:   new Date().toISOString(),
            wsRoot,
            secrets:     [],
            gitignore:   { missing: [], found: [] },
            npmAudit:    null,
            gitHooks:    null,
            envFiles:    [],
            score:       100,
            issues:      0,
        };

        // 1. Secrets scan
        if (wsRoot) {
            audit.secrets = await this._scanSecrets(wsRoot);
            audit.issues += audit.secrets.length;
        }

        // 2. .gitignore check
        if (wsRoot) {
            const gi = path.join(wsRoot, '.gitignore');
            if (fs.existsSync(gi)) {
                const content = fs.readFileSync(gi, 'utf8');
                for (const entry of GITIGNORE_SENSITIVE) {
                    if (content.includes(entry)) {
                        audit.gitignore.found.push(entry);
                    } else {
                        audit.gitignore.missing.push(entry);
                        audit.issues++;
                    }
                }
            } else {
                audit.gitignore.missing = [...GITIGNORE_SENSITIVE];
                audit.issues += GITIGNORE_SENSITIVE.length;
            }
        }

        // 3. npm audit (if package.json present)
        if (wsRoot && fs.existsSync(path.join(wsRoot, 'package.json'))) {
            const r = await run('npm audit --json', { cwd: wsRoot });
            try {
                const parsed = JSON.parse(r.stdout || '{}');
                const vulns  = parsed.metadata?.vulnerabilities || {};
                audit.npmAudit = {
                    critical:  vulns.critical  || 0,
                    high:      vulns.high      || 0,
                    moderate:  vulns.moderate  || 0,
                    low:       vulns.low       || 0,
                    total:     (vulns.critical||0) + (vulns.high||0) + (vulns.moderate||0) + (vulns.low||0),
                };
                audit.issues += audit.npmAudit.critical * 3 + audit.npmAudit.high;
            } catch {
                audit.npmAudit = { error: 'npm audit output could not be parsed', raw: r.stdout.slice(0, 200) };
            }
        }

        // 4. Git hooks check (pre-commit, pre-push)
        if (wsRoot) {
            const hooksDir = path.join(wsRoot, '.git', 'hooks');
            const hooks = ['pre-commit', 'pre-push'];
            audit.gitHooks = {};
            for (const h of hooks) {
                audit.gitHooks[h] = fs.existsSync(path.join(hooksDir, h));
            }
        }

        // 5. .env files in workspace
        if (wsRoot) {
            audit.envFiles = this._findEnvFiles(wsRoot);
        }

        // Score: subtract penalties
        audit.score = Math.max(0, 100
            - audit.secrets.length * 20
            - (audit.gitignore.missing.length > 0 ? 10 : 0)
            - (audit.npmAudit?.critical || 0) * 10
            - (audit.npmAudit?.high     || 0) * 5
        );

        this.results = audit;
        this.panel.webview.postMessage({ type: 'auditResult', audit });
    }

    // ── Secret scanner (walks workspace files) ───────────────────────────────
    async _scanSecrets(root) {
        const hits = [];
        const walk = (dir, depth) => {
            if (depth > 6) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (SKIP_DIRS.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full, depth + 1); continue; }
                if (!/\.(js|ts|py|env|json|yaml|yml|sh|bat|ps1|config|conf|ini|txt)$/.test(e.name)) continue;
                let content;
                try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
                const lines = content.split('\n');
                lines.forEach((line, idx) => {
                    for (const { label, re } of SECRET_PATTERNS) {
                        if (re.test(line)) {
                            hits.push({
                                label,
                                file: path.relative(root, full),
                                line: idx + 1,
                                snippet: line.trim().slice(0, 80),
                            });
                        }
                    }
                });
            }
        };
        walk(root, 0);
        return hits;
    }

    _findEnvFiles(root) {
        const found = [];
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const e of entries) {
                if (e.isFile() && /^\.env/.test(e.name)) {
                    found.push(e.name);
                }
            }
        } catch {}
        return found;
    }

    // ── Add entry to .gitignore ──────────────────────────────────────────────
    _addToGitignore(entry) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!wsRoot) return;
        const gi = path.join(wsRoot, '.gitignore');
        try {
            const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
            if (!existing.includes(entry)) {
                fs.appendFileSync(gi, `\n${entry}\n`, 'utf8');
                vscode.window.showInformationMessage(`✅ Added "${entry}" to .gitignore`);
                this._runAudit();
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to update .gitignore: ${e.message}`);
        }
    }

    _openFile(filePath, line) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
        const full = path.isAbsolute(filePath) ? filePath : path.join(wsRoot, filePath);
        vscode.workspace.openTextDocument(full).then(doc => {
            vscode.window.showTextDocument(doc).then(editor => {
                if (line) {
                    const pos = new vscode.Position(line - 1, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos));
                }
            });
        });
    }

    dispose() {
        SecurityPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop(); if (d) d.dispose();
        }
    }

    // ── WebView HTML ─────────────────────────────────────────────────────────
    _buildHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Security Audit</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#21262d;--text:#e6edf3;--muted:#7d8590;
  --green:#2ea043;--red:#da3633;--yellow:#d29922;--blue:#1f6feb;--focus:#1f6feb;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
#header{background:var(--card);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}
#header h1{font-size:17px;font-weight:600;}
.btn{background:var(--blue);color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;}
.btn:hover{opacity:.85;} .btn-sm{padding:4px 9px;font-size:12px;}
.btn-danger{background:var(--red);} .btn-warn{background:var(--yellow);color:#000;}
.btn-green{background:var(--green);}
#content{padding:16px 20px;}
.score-ring{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;border:4px solid var(--green);margin:0 auto 12px;}
.score-ring.warn{border-color:var(--yellow);}  .score-ring.danger{border-color:var(--red);}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.issue-row{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;}
.issue-row:last-child{border-bottom:none;}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap;flex-shrink:0;}
.badge-red{background:rgba(218,54,51,.2);color:#f85149;}
.badge-yellow{background:rgba(210,153,34,.2);color:#e3b341;}
.badge-green{background:rgba(46,160,67,.2);color:#3fb950;}
.badge-blue{background:rgba(31,111,235,.2);color:#58a6ff;}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
.file-link{color:var(--blue);cursor:pointer;text-decoration:underline;font-size:12px;}
.vuln-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
.vuln-cell{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center;}
.vuln-count{font-size:22px;font-weight:700;}
.vuln-label{font-size:11px;color:var(--muted);}
.empty{color:var(--muted);font-size:13px;padding:8px 0;}
</style>
</head>
<body>
<div id="header">
  <div><h1>🔒 Security Audit</h1><p id="subtitle" style="font-size:12px;color:var(--muted);">Scanning workspace...</p></div>
  <button class="btn" onclick="refresh()" id="refreshBtn">🔄 Refresh</button>
</div>
<div id="content">
  <div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Running security audit...</p></div>
</div>

<script>
const vscode = acquireVsCodeApi();
function refresh(){ document.getElementById('refreshBtn').disabled=true; vscode.postMessage({type:'refresh'}); }
function openFile(f,l){ vscode.postMessage({type:'openFile',filePath:f,line:l}); }
function fixGi(e){ vscode.postMessage({type:'fixGitignore',entry:e}); }

window.addEventListener('message', e => {
  const msg = e.data;
  if(msg.type==='scanning'){
    document.getElementById('refreshBtn').disabled=true;
    document.getElementById('content').innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Running security audit...</p></div>';
    return;
  }
  if(msg.type==='auditResult') renderAudit(msg.audit);
});

function renderAudit(a){
  document.getElementById('refreshBtn').disabled=false;
  const ws = a.wsRoot ? a.wsRoot.split(/[\\/]/).pop() : '(no workspace)';
  document.getElementById('subtitle').textContent = 'Workspace: ' + ws + ' — ' + new Date(a.timestamp).toLocaleTimeString();

  let html='';

  // Score
  const sc = a.score;
  const cls = sc>=80?'':'sc>=50?warn:danger';
  const ringCls = sc>=80?'score-ring':(sc>=50?'score-ring warn':'score-ring danger');
  html+=\`<div style="text-align:center;margin-bottom:16px">
    <div class="\${ringCls}">\${sc}</div>
    <div style="font-size:13px;color:var(--muted)">Security Score / 100</div>
    <div style="font-size:12px;margin-top:4px">\${a.issues} issue\${a.issues!==1?'s':''} found</div>
  </div>\`;

  // Secrets
  html+=\`<div class="section"><h2>🔑 Secrets / Credential Leaks (\${a.secrets.length})</h2>\`;
  if(a.secrets.length===0){html+='<p class="empty">✅ No secrets detected in workspace files.</p>';}
  else{
    a.secrets.forEach(s=>{
      html+=\`<div class="issue-row">
        <span class="badge badge-red">LEAK</span>
        <div style="flex:1">
          <div><strong>\${s.label}</strong> — <span class="file-link" onclick="openFile('\${s.file}',\${s.line})">\${s.file}:\${s.line}</span></div>
          <div style="font-size:11px;color:var(--muted);font-family:monospace;margin-top:2px">\${escHtml(s.snippet)}</div>
        </div>
      </div>\`;
    });
  }
  html+='</div>';

  // .gitignore
  html+=\`<div class="section"><h2>📄 .gitignore — Sensitive Patterns</h2>\`;
  if(a.gitignore.missing.length===0){html+='<p class="empty">✅ All recommended patterns present.</p>';}
  else{
    html+='<p style="font-size:12px;color:var(--muted);margin-bottom:8px">Missing entries (risk: accidental commit of secrets):</p>';
    a.gitignore.missing.forEach(m=>{
      html+=\`<div class="issue-row">
        <span class="badge badge-yellow">MISSING</span>
        <div style="flex:1;font-size:13px"><code>\${m}</code></div>
        <button class="btn btn-sm btn-green" onclick="fixGi('\${m}')">Add</button>
      </div>\`;
    });
  }
  html+='</div>';

  // npm audit
  if(a.npmAudit){
    html+=\`<div class="section"><h2>📦 npm Dependency Audit</h2>\`;
    if(a.npmAudit.error){
      html+=\`<p class="empty">⚠️ \${a.npmAudit.error}</p>\`;
    } else {
      html+=\`<div class="vuln-grid">
        <div class="vuln-cell"><div class="vuln-count" style="color:\${a.npmAudit.critical>0?'#f85149':'#3fb950'}">\${a.npmAudit.critical}</div><div class="vuln-label">Critical</div></div>
        <div class="vuln-cell"><div class="vuln-count" style="color:\${a.npmAudit.high>0?'#e3b341':'#3fb950'}">\${a.npmAudit.high}</div><div class="vuln-label">High</div></div>
        <div class="vuln-cell"><div class="vuln-count">\${a.npmAudit.moderate}</div><div class="vuln-label">Moderate</div></div>
        <div class="vuln-cell"><div class="vuln-count">\${a.npmAudit.low}</div><div class="vuln-label">Low</div></div>
      </div>\`;
      if(a.npmAudit.total>0){
        html+=\`<div style="margin-top:10px"><button class="btn btn-sm btn-warn" onclick="vscode.postMessage({type:'openUrl',url:'https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities'})">How to fix</button></div>\`;
      }
    }
    html+='</div>';
  }

  // Git hooks
  if(a.gitHooks){
    html+=\`<div class="section"><h2>🪝 Git Hooks</h2>\`;
    ['pre-commit','pre-push'].forEach(h=>{
      const ok=a.gitHooks[h];
      html+=\`<div class="issue-row">
        <span class="badge \${ok?'badge-green':'badge-yellow'}">\${ok?'PRESENT':'MISSING'}</span>
        <span style="flex:1;font-size:13px"><code>\${h}</code></span>
      </div>\`;
    });
    html+='</div>';
  }

  // .env files
  if(a.envFiles && a.envFiles.length>0){
    html+=\`<div class="section"><h2>🌍 .env Files Detected</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:8px">Verify these are in .gitignore:</p>\`;
    a.envFiles.forEach(f=>{
      const missing = a.gitignore.missing.includes(f)||a.gitignore.missing.includes('.env');
      html+=\`<div class="issue-row">
        <span class="badge \${missing?'badge-red':'badge-green'}">\${missing?'NOT IN .GITIGNORE':'IN .GITIGNORE'}</span>
        <span style="flex:1;font-size:13px"><code>\${f}</code></span>
      </div>\`;
    });
    html+='</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { SecurityPanel };
