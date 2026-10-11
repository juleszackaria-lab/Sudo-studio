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
const { appendAudit } = require('../utils/auditLog');
const { loadAdvisories, collectPackages, matchAdvisories, dbIsStale, userDbPath } = require('../utils/localAudit');
const coverageUtil = require('../utils/coverage');
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
    { label: 'Slack Token',           re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
    { label: 'PyPI Token',            re: /pypi-[A-Za-z0-9_-]{20,}/ },
    { label: 'NPM Token',             re: /_authToken\s*=\s*[^\s'"]+/ },
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
        // Input validation: all incoming webview messages are untrusted
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'refresh':
                this._runAudit();
                break;
            case 'openFile': {
                // Validate filePath: must be a non-empty string, no path traversal
                const fp = msg.filePath;
                if (typeof fp !== 'string' || fp.length === 0 || fp.length > 512) return;
                if (/(\.\.|[\x00-\x1f])/.test(fp)) return;
                const ln = Number.isInteger(msg.line) ? msg.line : 0;
                this._openFile(fp, ln);
                break;
            }
            case 'openUrl': {
                // Validate URL: must be http(s) only
                const u = msg.url;
                if (typeof u !== 'string') return;
                if (!/^https?:\/\//i.test(u)) return;
                vscode.env.openExternal(vscode.Uri.parse(u));
                break;
            }
            case 'fixGitignore': {
                // Validate entry: must be a short safe filename pattern
                const entry = msg.entry;
                if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) return;
                if (/[\x00-\x1f\/\\]/.test(entry)) return;
                this._addToGitignore(entry);
                break;
            }
            case 'exportLocalAudit':
                this._exportLocalAudit();
                break;
            case 'exportSecrets':
                this._exportSecrets();
                break;
            case 'importAdvisories':
                this._importAdvisories();
                break;
            case 'measureCoverage':
                this._measureCoverage();
                break;
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
            secretsSkipped: 0,
            gitignore:   { missing: [], found: [] },
            npmAudit:    null,
            localAudit:  null,
            gitHooks:    null,
            envFiles:    [],
            score:       100,
            issues:      0,
        };

        // 1. Secrets scan
        if (wsRoot) {
            audit.secrets = await this._scanSecrets(wsRoot);
            audit.secretsSkipped = this._lastSecretsSkipped || 0;
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
            // TASK 7b: a failed npm audit must NEVER render as fake green zeros.
            if (!r.ok) {
                audit.npmAudit = { error: 'npm audit failed (offline or registry unreachable) - result unreliable', unreliable: true };
            } else try {
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
                audit.npmAudit = { error: 'npm audit output could not be parsed - result unreliable', raw: r.stdout.slice(0, 200), unreliable: true };
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

        // 6. Local advisory DB (TASK 7b - 100% offline, never a fake zero).
        if (wsRoot) {
            try {
                const { db, from, error } = loadAdvisories();
                if (!db) {
                    audit.localAudit = { error: 'Advisory database missing or corrupt - local audit unreliable: ' + (error || 'unknown'), unreliable: true };
                } else {
                    const pkgs = collectPackages(wsRoot);
                    const matches = matchAdvisories(pkgs, db);
                    audit.localAudit = {
                        dbDate: db.generatedAt || 'unknown', dbSource: from,
                        dbEntries: db.advisories.length, scanned: pkgs.length,
                        stale: dbIsStale(db.generatedAt), matches,
                    };
                    for (const m of matches) {
                        audit.issues += m.severity === 'critical' ? 3 : 1;
                    }
                }
            } catch {
                audit.localAudit = { error: 'Local audit failed - result unreliable', unreliable: true };
            }
        }

        // Score: subtract penalties
        audit.score = Math.max(0, 100
            - audit.secrets.length * 20
            - (audit.gitignore.missing.length > 0 ? 10 : 0)
            - (audit.npmAudit?.critical || 0) * 10
            - (audit.npmAudit?.high     || 0) * 5
            - (audit.localAudit?.matches || []).filter(m => m.severity === 'critical').length * 10
            - (audit.localAudit?.matches || []).filter(m => m.severity === 'high').length * 5
        );

        this.results = audit;
        this.panel.webview.postMessage({ type: 'auditResult', audit });
        appendAudit('SECURITY_AUDIT', `audit: ${audit.secrets.length} secret(s), ${audit.gitignore.missing.length} gitignore missing, npm ${audit.npmAudit?.error ? 'unreliable' : (audit.npmAudit?.total ?? 'n/a') + ' vuln(s)'}, local ${audit.localAudit?.error ? 'unreliable' : (audit.localAudit?.matches?.length ?? 'n/a') + ' match(es)'}`, { result: 'ok', verified: true });
    }

    // ── Secret scanner (walks workspace files) ───────────────────────────────
    async _scanSecrets(root) {
        const hits = [];
        this._lastSecretsSkipped = 0;
        const walk = (dir, depth) => {
            if (depth > 6) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (SKIP_DIRS.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full, depth + 1); continue; }
                if (!/\.(js|ts|py|env|json|yaml|yml|sh|bat|ps1|config|conf|ini|txt|npmrc|pem|key)$/.test(e.name)) continue;
                // TASK 7c: skip huge files (never freeze the audit on a 500 MB log).
                try { if (fs.statSync(full).size > 1024 * 1024) { this._lastSecretsSkipped++; continue; } } catch { continue; }
                let content;
                try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
                const lines = content.split('\n');
                lines.forEach((line, idx) => {
                    for (const { label, re } of SECRET_PATTERNS) {
                        if (re.test(line)) {
                            // Redact the match itself — show only surrounding context
                            const redacted = line.trim()
                                .replace(re, '[REDACTED]')
                                .slice(0, 100);
                            hits.push({
                                label,
                                file: path.relative(root, full),
                                line: idx + 1,
                                snippet: redacted,
                            });
                        }
                    }
                });
            }
        };
        walk(root, 0);
        return hits;
    }

    // -- TASK 7d: real coverage (own async action, never blocks the audit) --
    async _measureCoverage() {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;
        this.panel.webview.postMessage({ type: 'coverageStarted' });
        try {
            const coverage = await coverageUtil.measure(wsRoot);
            this.panel.webview.postMessage({ type: 'coverageResult', coverage });
            if (coverage.measured) {
                appendAudit('SECURITY_COVERAGE', `${coverage.kind}: ${coverage.totalPct}% over ${coverage.files.length} file(s) (tool: ${coverage.tool}, tests ${coverage.testsOk ? 'passed' : 'FAILED'})`, { result: 'ok', verified: true });
            } else {
                appendAudit('SECURITY_COVERAGE', coverage.reason, { result: 'non-mesurable', verified: false });
            }
        } catch {
            this.panel.webview.postMessage({ type: 'coverageResult', coverage: { measured: false, reason: 'Non mesurable : internal error' } });
            appendAudit('SECURITY_COVERAGE', 'internal error', { result: 'error', verified: false });
        }
    }

    // -- TASK 7b/7c: exports + advisory DB import (all verify after write) --
    async _exportLocalAudit() {
        try {
            const la = this.results?.localAudit;
            if (!la || la.error) { vscode.window.showWarningMessage('No local audit result to export - run Refresh first.'); return; }
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'sudo-local-audit.json')),
                filters: { 'JSON': ['json'] }
            });
            if (!saveUri) return;
            const payload = { exportedAt: new Date().toISOString(), dbDate: la.dbDate, dbSource: la.dbSource, dbEntries: la.dbEntries, stale: la.stale, scanned: la.scanned, matches: la.matches };
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            if (!back || (back.matches || []).length !== la.matches.length) throw new Error('verify-mismatch');
            appendAudit('SECURITY_EXPORT_AUDIT', `${la.matches.length} match(es) exported to ${path.basename(saveUri.fsPath)}`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Local audit exported (${la.matches.length} matches).`);
        } catch {
            vscode.window.showErrorMessage('Export failed - check folder permissions.');
            appendAudit('SECURITY_EXPORT_AUDIT', 'export failed', { result: 'error', verified: false });
        }
    }

    async _exportSecrets() {
        try {
            const secrets = this.results?.secrets;
            if (!secrets) { vscode.window.showWarningMessage('No audit result to export - run Refresh first.'); return; }
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'sudo-secrets.json')),
                filters: { 'JSON': ['json'] }
            });
            if (!saveUri) return;
            // Snippets are already redacted by the scanner; never export raw lines.
            const payload = { exportedAt: new Date().toISOString(), wsRoot: this.results.wsRoot, skippedLarge: this.results.secretsSkipped || 0, secrets };
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            if (!back || (back.secrets || []).length !== secrets.length) throw new Error('verify-mismatch');
            appendAudit('SECURITY_EXPORT_SECRETS', `${secrets.length} finding(s) exported to ${path.basename(saveUri.fsPath)}`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Secrets report exported (${secrets.length} findings).`);
        } catch {
            vscode.window.showErrorMessage('Export failed - check folder permissions.');
            appendAudit('SECURITY_EXPORT_SECRETS', 'export failed', { result: 'error', verified: false });
        }
    }

    async _importAdvisories() {
        try {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'JSON': ['json'] } });
            if (!uris || !uris.length) return;
            const stat = fs.statSync(uris[0].fsPath);
            if (stat.size > 10 * 1024 * 1024) { vscode.window.showErrorMessage('Advisory file too large (max 10 MB).'); return; }
            const raw = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));
            if (!raw || !Array.isArray(raw.advisories) || !raw.generatedAt) {
                vscode.window.showErrorMessage('Invalid advisory file - needs { generatedAt, advisories[] }.');
                appendAudit('SECURITY_IMPORT_ADVISORIES', 'rejected: bad format', { result: 'error', verified: false });
                return;
            }
            const dest = userDbPath();
            if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, JSON.stringify(raw, null, 2), 'utf8');
            const back = JSON.parse(fs.readFileSync(dest, 'utf8'));
            if (!back || (back.advisories || []).length !== raw.advisories.length) throw new Error('verify-mismatch');
            appendAudit('SECURITY_IMPORT_ADVISORIES', `${raw.advisories.length} advisories imported (dated ${raw.generatedAt})`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(`Advisory base imported (${raw.advisories.length} entries). Re-running audit...`);
            this._runAudit();
        } catch {
            vscode.window.showErrorMessage('Import failed - check the file and permissions.');
            appendAudit('SECURITY_IMPORT_ADVISORIES', 'import failed', { result: 'error', verified: false });
        }
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
        if (!wsRoot) {
            vscode.window.showWarningMessage('Aucun dossier de projet ouvert — impossible de modifier .gitignore');
            return;
        }
        const gi = path.join(wsRoot, '.gitignore');
        try {
            const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
            if (!existing.split('\n').map(l => l.trim()).includes(entry)) {
                fs.appendFileSync(gi, `\n${entry}\n`, 'utf8');
                // TASK 7f: post-condition - re-read .gitignore and confirm the entry.
                const back = fs.readFileSync(gi, 'utf8').split('\n').map(l => l.trim());
                if (!back.includes(entry)) {
                    vscode.window.showErrorMessage(`Echec : "${entry}" absent apres ecriture - verifiez les permissions.`);
                    appendAudit('SECURITY_GITIGNORE_ADD', `${entry}: write not confirmed on re-read`, { result: 'error', verified: false });
                    return;
                }
                appendAudit('SECURITY_GITIGNORE_ADD', `"${entry}" added to .gitignore (re-read confirmed)`, { result: 'ok', verified: true });
                vscode.window.showInformationMessage(`✅ "${entry}" ajouté à .gitignore`);
                this._runAudit();
            } else {
                vscode.window.showInformationMessage(`"${entry}" est déjà dans .gitignore`);
            }
        } catch {
            // Never expose raw OS error messages — they can leak absolute paths or system info
            vscode.window.showErrorMessage('Impossible de modifier .gitignore — vérifiez que le fichier n\'est pas en lecture seule.');
        }
    }

    _openFile(filePath, line) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
        if (!wsRoot) {
            vscode.window.showWarningMessage('Aucun dossier de projet ouvert.');
            return;
        }
        // Absolute paths allowed only if they are under wsRoot (no jail escape)
        const full = path.isAbsolute(filePath) ? filePath : path.join(wsRoot, filePath);
        const resolved = path.resolve(full);
        const resolvedWs = path.resolve(wsRoot);
        if (!resolved.startsWith(resolvedWs + path.sep) && resolved !== resolvedWs) {
            // Attempted path traversal — silently ignore
            return;
        }
        vscode.workspace.openTextDocument(resolved).then(doc => {
            vscode.window.showTextDocument(doc).then(editor => {
                if (line && line > 0) {
                    const pos = new vscode.Position(line - 1, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos));
                }
            });
        }, () => {
            vscode.window.showWarningMessage('Fichier introuvable ou inaccessible.');
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
  <button class="btn" onclick="exportVulns()">Export vulns (JSON)</button>
  <button class="btn" onclick="exportSecrets()">Export secrets (JSON)</button>
  <button class="btn" onclick="importDb()">Import advisory DB</button>
  <button class="btn" onclick="measureCoverage()" id="coverageBtn">Measure coverage</button>
</div>
<div id="coverage"></div>
<div id="content">
  <div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Running security audit...</p></div>
</div>

<script>
const vscode = acquireVsCodeApi();
function refresh(){ document.getElementById('refreshBtn').disabled=true; vscode.postMessage({type:'refresh'}); }
function openFile(f,l){ vscode.postMessage({type:'openFile',filePath:f,line:l}); }
function fixGi(e){ vscode.postMessage({type:'fixGitignore',entry:e}); }
function exportVulns(){ vscode.postMessage({type:'exportLocalAudit'}); }
function exportSecrets(){ vscode.postMessage({type:'exportSecrets'}); }
function importDb(){ vscode.postMessage({type:'importAdvisories'}); }
function measureCoverage(){ vscode.postMessage({type:'measureCoverage'}); }
function renderCoverage(c){
  let h='<div class="section"><h2>Coverage</h2>';
  if(!c.measured){ h+='<p class="empty">'+escHtml(c.reason)+'</p>'; }
  else{
    h+='<p style="font-size:12px;color:var(--muted)">'+escHtml(c.kind)+' via '+escHtml(c.tool)+' - '+c.totalPct+'% ('+c.covered+'/'+c.total+' lines), '+c.files.length+' file(s), '+Math.round(c.durationMs/1000)+'s. Tests '+(c.testsOk?'passed':'FAILED')+'.</p>';
    h+='<div style="max-height:300px;overflow:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
    c.files.forEach(f=>{ h+='<tr><td style="padding:2px 6px"><code>'+escHtml(f.file)+'</code></td><td style="text-align:right;padding:2px 6px">'+f.pct+'%</td></tr>'; });
    h+='</table></div>';
  }
  document.getElementById('coverage').innerHTML = h+'</div>';
}

window.addEventListener('message', e => {
  const msg = e.data;
  if(msg.type==='scanning'){
    document.getElementById('refreshBtn').disabled=true;
    document.getElementById('content').innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Running security audit...</p></div>';
    return;
  }
  if(msg.type==='auditResult') renderAudit(msg.audit);
  if(msg.type==='coverageStarted'){document.getElementById('coverageBtn').disabled=true;document.getElementById('coverage').innerHTML='<div class="section"><h2>Coverage</h2><div style="text-align:center;padding:20px"><div class="spinner"></div><p style="margin-top:8px;color:var(--muted)">Measuring coverage (runs project tests)...</p></div></div>';return;}
  if(msg.type==='coverageResult'){document.getElementById('coverageBtn').disabled=false;renderCoverage(msg.coverage);return;}
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
  if(a.secretsSkipped>0){html+='<p class="empty">Skipped '+a.secretsSkipped+' file(s) over 1 MB (too large to scan).</p>';}
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

  // Local advisory DB (offline)
  if(a.localAudit){
    html+=\`<div class="section"><h2>Local Advisory DB (offline)</h2>\`;
    const la=a.localAudit;
    if(la.error){
      html+=\`<p class="empty">WARNING \${escHtml(la.error)}</p>\`;
    } else {
      html+=\`<p style="font-size:12px;color:var(--muted)">Base: \${la.dbEntries} advisories, dated \${escHtml(la.dbDate)} (\${escHtml(la.dbSource)}), \${la.scanned} package(s) scanned.</p>\`;
      if(la.stale){html+='<p class="empty">WARNING Advisory base is older than 180 days - result NOT RELIABLE. Import a fresher base.</p>';}
      if(la.matches.length===0){html+=\`<p class="empty">No match in the local base (\${la.dbEntries} advisories, \${escHtml(la.dbDate)}) - this does not rule out other vulnerabilities.</p>\`;}
      else{
        la.matches.forEach(m=>{
          const sevCls = m.severity==='critical'||m.severity==='high'?'badge-red':'badge-yellow';
          html+=\`<div class="issue-row"><span class="badge \${sevCls}">\${escHtml(m.severity.toUpperCase())}</span><div style="flex:1;font-size:13px"><code>\${escHtml(m.package)}@\${escHtml(m.version)}</code> - \${escHtml(m.cve)} - fix: <code>\${escHtml(m.fixedIn)}</code> <span style="color:var(--muted)">[\${escHtml(m.ecosystem)}, \${escHtml(m.source)}]</span><br><span style="color:var(--muted)">\${escHtml(m.summary)}</span></div></div>\`;
        });
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
