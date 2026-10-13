/**
 * SUDO STUDIO — Enterprise Duplication Panel
 * Feature 2: Enterprise Duplication at Scale
 *
 * Provides:
 * 1. Environment Profile Export / Import (JSON snapshot of full dev env)
 * 2. Project Template Creation (zip current workspace into a reusable template)
 * 3. Template Deploy (unzip a template into a new folder)
 * 4. Multi-Machine Sync diff (compare local env against a shared profile)
 *
 * Completely local — no backend needed.
 * All failures are explicit ([FAIL] log entries, never silent).
 */
'use strict';

const vscode = require('vscode');
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { promisify } = require('util');
const { appendAudit } = require('../utils/auditLog');
const execAsync = promisify(exec);

const IS_WIN = process.platform === 'win32';

// ── Tool list for environment snapshot ──────────────────────────────────────
const TOOL_CHECKS = [
    { name: 'Node.js',  cmd: 'node --version' },
    { name: 'npm',      cmd: 'npm --version' },
    { name: 'Python',   cmd: IS_WIN ? 'python --version' : 'python3 --version' },
    { name: 'pip',      cmd: IS_WIN ? 'pip --version' : 'pip3 --version' },
    { name: 'Git',      cmd: 'git --version' },
    { name: 'Docker',   cmd: 'docker --version' },
    { name: 'Flutter',  cmd: 'flutter --version' },
    { name: 'Java',     cmd: 'java --version 2>&1' },
    { name: 'Rust',     cmd: 'rustc --version' },
    { name: 'Go',       cmd: 'go version' },
];

function detectTool(t) {
    return new Promise(r => {
        exec(t.cmd, { timeout: 5000 }, (err, stdout) => {
            r({ name: t.name, installed: !err && !!stdout.trim(), version: stdout.trim().split('\n')[0] || null });
        });
    });
}

async function buildEnvProfile(label) {
    const tools = await Promise.all(TOOL_CHECKS.map(detectTool));
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const envVars = {};
    ['PATH','JAVA_HOME','ANDROID_HOME','FLUTTER_ROOT','PYTHONPATH','GOPATH','NODE_ENV'].forEach(k => {
        if (process.env[k]) envVars[k] = process.env[k];
    });
    // Detect project type from workspace
    let projectType = 'unknown';
    if (wsRoot) {
        if (fs.existsSync(path.join(wsRoot, 'pubspec.yaml'))) projectType = 'flutter';
        else if (fs.existsSync(path.join(wsRoot, 'package.json'))) projectType = 'nodejs';
        else if (fs.existsSync(path.join(wsRoot, 'requirements.txt'))) projectType = 'python';
        else if (fs.existsSync(path.join(wsRoot, 'pom.xml'))) projectType = 'java-maven';
        else if (fs.existsSync(path.join(wsRoot, 'build.gradle'))) projectType = 'java-gradle';
        else if (fs.existsSync(path.join(wsRoot, 'Cargo.toml'))) projectType = 'rust';
        else if (fs.existsSync(path.join(wsRoot, 'go.mod'))) projectType = 'go';
        else if (fs.existsSync(path.join(wsRoot, 'Dockerfile'))) projectType = 'docker';
    }
    return {
        label:          label || 'env-profile',
        version:        '2.0',
        createdAt:      new Date().toISOString(),
        machine:        os.hostname(),
        platform:       `${os.platform()} ${os.arch()}`,
        nodeVersion:    process.version,
        sudoStudioVer:  '1.0.0',
        workspace:      wsRoot,
        projectType,
        tools,
        envVars,
        totalRam:       Math.round(os.totalmem() / 1024 / 1024 / 1024),
        cpuCores:       os.cpus().length,
    };
}

function diffProfiles(local, imported) {
    const diffs = [];
    const importedToolMap = {};
    (imported.tools || []).forEach(t => { importedToolMap[t.name] = t; });
    (local.tools || []).forEach(lt => {
        const it = importedToolMap[lt.name];
        if (!it) return;
        if (!lt.installed && it.installed) {
            diffs.push({ tool: lt.name, local: 'NOT INSTALLED', required: it.version, severity: 'error' });
        } else if (lt.installed && it.installed && lt.version !== it.version) {
            diffs.push({ tool: lt.name, local: lt.version, required: it.version, severity: 'warn' });
        }
    });
    return diffs;
}

// -- TASK 7 verification helpers ----------------------------------------------
function countZipEntries(zipPath) {
    return new Promise(resolve => {
        if (IS_WIN) {
            const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries.Count"`;
            exec(cmd, { timeout: 15000 }, (err, stdout) => {
                if (err || !stdout) { resolve(-1); return; }
                const n = parseInt(stdout.trim(), 10);
                resolve(Number.isFinite(n) ? n : -1);
            });
        } else {
            exec(`unzip -l "${zipPath}"`, { timeout: 15000 }, (err, stdout) => {
                if (err || !stdout) { resolve(-1); return; }
                const m = stdout.match(/(\d+)\s+files?/);
                resolve(m ? parseInt(m[1], 10) : -1);
            });
        }
    });
}

// P12: project duplication (pure helpers, ASCII-only).
const DUP_DEFAULT_EXCLUDES = ['node_modules', 'build', '.dart_tool'];
const DUP_SAMPLE_MAX = 25;
const DUP_HASH_FULL_MAX = 4 * 1024 * 1024;
const DUP_HASH_PREFIX = 1024 * 1024;

function collectDupFiles(root, excludes) {
    // Sorted relative file list (posix separators); excluded dir names skipped
    // at any depth; symlinks skipped and counted (never followed).
    const skip = new Set(excludes || []);
    const files = [];
    let skippedSymlinks = 0;
    const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (skip.has(e.name)) continue;
            const full = path.join(dir, e.name);
            const relp = rel ? rel + '/' + e.name : e.name;
            let st;
            try { st = fs.lstatSync(full); } catch { continue; }
            if (st.isSymbolicLink()) { skippedSymlinks++; continue; }
            if (st.isDirectory()) walk(full, relp);
            else if (st.isFile()) files.push(relp);
        }
    };
    walk(root, '');
    files.sort();
    return { files, skippedSymlinks };
}

function hashDupFile(absPath) {
    // { sha256, bytes, partial } - full hash up to 4 MB, else 1 MB prefix + size.
    const st = fs.statSync(absPath);
    const fd = fs.openSync(absPath, 'r');
    try {
        const n = Math.min(st.size, st.size > DUP_HASH_FULL_MAX ? DUP_HASH_PREFIX : st.size);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, 0);
        const h = require('crypto').createHash('sha256').update(buf).digest('hex');
        return { sha256: h, bytes: st.size, partial: st.size > DUP_HASH_FULL_MAX };
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
}

function verifyDupCopy(srcRoot, files, destRoot, sampleMax) {
    // Re-hash a deterministic sample of the copied files (every Nth, max 25).
    const max = sampleMax || DUP_SAMPLE_MAX;
    const step = Math.max(1, Math.floor(files.length / max));
    const sampleIdx = [];
    for (let i = 0; i < files.length && sampleIdx.length < max; i += step) sampleIdx.push(i);
    const sample = [];
    const mismatches = [];
    let errors = 0;
    for (const i of sampleIdx) {
        const rel = files[i];
        try {
            const a = hashDupFile(path.join(srcRoot, rel));
            const b = hashDupFile(path.join(destRoot, rel));
            const match = a.sha256 === b.sha256 && a.bytes === b.bytes && a.partial === b.partial;
            sample.push({ file: rel, sha256: b.sha256.slice(0, 16), bytes: b.bytes,
                partial: b.partial, match });
            if (!match) mismatches.push(rel);
        } catch { errors++; mismatches.push(rel); }
    }
    let destCount = 0;
    try { destCount = collectDupFiles(destRoot, []).files.length; } catch { destCount = -1; }
    return { checked: sampleIdx.length, matched: sample.filter(x => x.match).length,
        mismatches, errors, sample, destCount };
}

function countFilesRecursive(dir, cap = 5000) {
    let n = 0;
    const walk = d => {
        if (n >= cap) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (n >= cap) return;
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else n++;
        }
    };
    walk(dir);
    return n;
}

// -- Panel class ---------------------------------------------------------------
class DuplicationPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.localProfile = null;

        this.panel.webview.html = this._buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this._onMessage(m), null, this.disposables);

        setTimeout(() => this._scanLocal(), 400);
    }

    static createOrShow(extensionUri) {
        if (DuplicationPanel.currentPanel) { DuplicationPanel.currentPanel.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioDuplication', '📋 Enterprise Duplication',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DuplicationPanel.currentPanel = new DuplicationPanel(panel, extensionUri);
    }

    async _onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'scanLocal':      await this._scanLocal(); break;
            case 'exportProfile':  await this._exportProfile(); break;
            case 'importProfile':  await this._importProfile(); break;
            case 'createTemplate': await this._createTemplate(); break;
            case 'deployTemplate': await this._deployTemplate(); break;
            case 'duplicateProject': await this._duplicateProject(); break;
            case 'openUrl': {
                if (typeof msg.url !== 'string' || !/^https?:\/\//.test(msg.url)) return;
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                break;
            }
        }
    }

    async _scanLocal() {
        this.panel.webview.postMessage({ type: 'scanning' });
        try {
            this.localProfile = await buildEnvProfile('local');
            this.panel.webview.postMessage({ type: 'localReady', profile: this.localProfile });
            appendAudit('DUP_SCAN', `local scan: ${(this.localProfile.tools || []).filter(t => t.installed).length}/${(this.localProfile.tools || []).length} tools installed`, { result: 'ok', verified: true });
        } catch {
            this.panel.webview.postMessage({ type: 'error', msg: 'Scan de l\'environnement échoué. Réessayez.' });
        }
    }

    async _exportProfile() {
        try {
            const profile = await buildEnvProfile('exported');
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), `sudo-env-${Date.now()}.json`)),
                filters: { 'Environment Profile': ['json'] }
            });
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(profile, null, 2), 'utf8');
            // TASK 7: post-condition - parse the file back.
            const back = JSON.parse(fs.readFileSync(saveUri.fsPath, 'utf8'));
            if (!back || !Array.isArray(back.tools)) throw new Error('verify-mismatch');
            appendAudit('DUP_EXPORT', `profile exported to ${path.basename(saveUri.fsPath)} (${back.tools.length} tools)`, { result: 'ok', verified: true });
            vscode.window.showInformationMessage(
                `✅ Profil exporté : ${path.basename(saveUri.fsPath)}`,
                'Ouvrir'
            ).then(s => { if (s === 'Ouvrir') vscode.workspace.openTextDocument(saveUri.fsPath).then(d => vscode.window.showTextDocument(d)); });
            this.panel.webview.postMessage({ type: 'exportDone', file: saveUri.fsPath });
        } catch {
            vscode.window.showErrorMessage('Export échoué — vérifiez les permissions du dossier de destination.');
            this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] Export échoué — vérifiez les permissions.' });
        }
    }

    async _importProfile() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Environment Profile': ['json'] }
            });
            if (!uris || !uris.length) return;

            // Reject oversized files (DoS protection)
            const stat = fs.statSync(uris[0].fsPath);
            if (stat.size > 512 * 1024) {
                vscode.window.showErrorMessage('Le fichier de profil est trop volumineux (max 512 KB).');
                return;
            }

            const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
            let imported;
            try {
                imported = JSON.parse(raw);
            } catch {
                vscode.window.showErrorMessage('Fichier invalide — le JSON est malformé.');
                this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] JSON malformé dans le fichier de profil.' });
                return;
            }
            if (!imported || typeof imported !== 'object' || !Array.isArray(imported.tools)) {
                vscode.window.showErrorMessage('Fichier invalide — champ "tools" manquant.');
                this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] Profil invalide — champ "tools" manquant.' });
                return;
            }
            // Compute diff against local profile
            const local = this.localProfile || await buildEnvProfile('local');
            const diffs = diffProfiles(local, imported);
            this.panel.webview.postMessage({
                type: 'diffResult', imported, local, diffs,
                file: path.basename(uris[0].fsPath)
            });
            appendAudit('DUP_IMPORT', `profile compared from ${path.basename(uris[0].fsPath)}: ${diffs.length} diff(s)`, { result: 'ok', verified: true });
        } catch {
            vscode.window.showErrorMessage('Import échoué — vérifiez les permissions du fichier.');
            this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] Import échoué — vérifiez les permissions.' });
        }
    }

    async _createTemplate() {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!wsRoot) {
            vscode.window.showWarningMessage('Open a workspace folder first to create a template.');
            return;
        }
        const name = await vscode.window.showInputBox({
            prompt: 'Template name', placeHolder: 'my-project-template',
            validateInput: v => /^[\w\-]+$/.test(v) ? null : 'Use only letters, digits, hyphens'
        });
        if (!name) return;

        try {
            const outDir  = path.join(os.homedir(), '.sudo_studio', 'templates');
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `${name}.zip`);

            // Use PowerShell Compress-Archive on Windows, zip on Unix
            let zipCmd;
            if (IS_WIN) {
                zipCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${wsRoot}\\*' -DestinationPath '${outFile}' -Force"`;
            } else {
                zipCmd = `cd "${wsRoot}" && zip -r "${outFile}" . --exclude '.git/*' --exclude 'node_modules/*' --exclude '.dart_tool/*'`;
            }

            this.panel.webview.postMessage({ type: 'templateProgress', msg: 'Création du ZIP en cours...' });
            await execAsync(zipCmd, { timeout: 60000 });

            const stat    = fs.statSync(outFile);
            // TASK 7: post-condition - the ZIP must list at least one entry.
            const entries = await countZipEntries(outFile);
            if (entries === 0) throw new Error('empty-archive');
            const sizeMb  = (stat.size / 1024 / 1024).toFixed(1);
            vscode.window.showInformationMessage(`✅ Template "${name}" créé (${sizeMb} MB)`, 'Ouvrir le dossier')
                .then(s => { if (s === 'Ouvrir le dossier') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir)); });
            this.panel.webview.postMessage({ type: 'templateCreated', name, file: outFile, sizeMb });
            appendAudit('DUP_TEMPLATE_CREATE', `template "${name}" (${sizeMb} MB, ${entries < 0 ? 'entries unknown' : entries + ' entries'})`, { result: 'ok', verified: entries > 0 });
        } catch {
            vscode.window.showErrorMessage('Création du template échouée — vérifiez les permissions du dossier.');
            this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] Création du template échouée — vérifiez les permissions.' });
        }
    }

    async _deployTemplate() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectMany: false,
                filters: { 'Template ZIP': ['zip'] }
            });
            if (!uris || !uris.length) return;

            const destUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'new-project')),
            });
            if (!destUri) return;

            if (!fs.existsSync(destUri.fsPath)) fs.mkdirSync(destUri.fsPath, { recursive: true });

            let extractCmd;
            if (IS_WIN) {
                extractCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${uris[0].fsPath}' -DestinationPath '${destUri.fsPath}' -Force"`;
            } else {
                extractCmd = `unzip -o "${uris[0].fsPath}" -d "${destUri.fsPath}"`;
            }

            this.panel.webview.postMessage({ type: 'templateProgress', msg: 'Extraction du template...' });
            await execAsync(extractCmd, { timeout: 60000 });
            // TASK 7: post-condition - destination must contain extracted files.
            const extracted = countFilesRecursive(destUri.fsPath);
            if (extracted < 1) throw new Error('empty-dest');

            vscode.window.showInformationMessage(
                `✅ Template déployé dans ${path.basename(destUri.fsPath)}`,
                'Ouvrir le dossier'
            ).then(s => {
                if (s === 'Ouvrir le dossier') {
                    vscode.commands.executeCommand('vscode.openFolder', destUri, true);
                }
            });
            this.panel.webview.postMessage({ type: 'deployDone', dest: destUri.fsPath });
            appendAudit('DUP_TEMPLATE_DEPLOY', `template deployed to ${path.basename(destUri.fsPath)} (${extracted} files)`, { result: 'ok', verified: true });
        } catch {
            vscode.window.showErrorMessage('Déploiement échoué — vérifiez que le fichier ZIP est valide et les permissions du dossier.');
            this.panel.webview.postMessage({ type: 'error', msg: '[FAIL] Déploiement échoué — ZIP invalide ou permissions insuffisantes.' });
        }
    }

    async _duplicateProject() {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!wsRoot) {
            vscode.window.showWarningMessage('Ouvrez d\'abord un dossier de projet a dupliquer.');
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Dupliquer ici'
        });
        if (!picked || !picked.length) return; // cancel = silent no-op
        const dest = path.resolve(picked[0].fsPath);
        const src = path.resolve(wsRoot);
        const fail = (msg) => {
            vscode.window.showErrorMessage(msg);
            this.panel.webview.postMessage({ type: 'duplicateDone', success: false, error: msg });
            appendAudit('DUP_DUPLICATE', 'refused: ' + msg, { result: 'error', verified: false });
        };
        if (dest === src) { fail('Destination identique a la source.'); return; }
        if (dest.startsWith(src + path.sep)) { fail('Le dossier de destination est dans le projet source.'); return; }
        if (src.startsWith(dest + path.sep)) { fail('Le projet source est dans la destination.'); return; }
        try {
            if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
                fail('Le dossier de destination n\'est pas vide.'); return;
            }
        } catch { fail('Destination illisible.'); return; }
        let list;
        try { list = collectDupFiles(src, DUP_DEFAULT_EXCLUDES); }
        catch { fail('Inventaire du projet impossible.'); return; }
        const total = list.files.length;
        const tick = () => new Promise(r => setImmediate(r));
        const post = (copied, current) => {
            try { this.panel.webview.postMessage({ type: 'duplicateProgress', copied, total, current }); } catch {}
        };
        try { fs.mkdirSync(dest, { recursive: true }); }
        catch { fail('Creation du dossier impossible (permissions).'); return; }
        post(0, '');
        const copyErrors = [];
        for (let i = 0; i < total; i++) {
            const rel = list.files[i];
            try {
                const target = path.join(dest, rel);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(src, rel), target);
            } catch { copyErrors.push(rel); }
            if ((i + 1) % 20 === 0 || i + 1 === total) { post(i + 1, rel); await tick(); }
        }
        let rep;
        try { rep = verifyDupCopy(src, list.files, dest); }
        catch { fail('Verification impossible.'); return; }
        const success = copyErrors.length === 0 && rep.errors === 0 &&
            rep.mismatches.length === 0 && rep.destCount === total;
        const report = { total, copied: total - copyErrors.length,
            skippedSymlinks: list.skippedSymlinks, excludes: DUP_DEFAULT_EXCLUDES.slice(),
            copyErrors, checked: rep.checked, matched: rep.matched,
            mismatches: rep.mismatches, sample: rep.sample, destCount: rep.destCount };
        this.panel.webview.postMessage({ type: 'duplicateDone', success, dest, report });
        appendAudit('DUP_DUPLICATE', `${path.basename(src)} -> ${path.basename(dest)}: ` +
            `${report.copied}/${total} files, sample ${rep.matched}/${rep.checked} match` +
            (success ? '' : ' - FAILED'), { result: success ? 'ok' : 'error', verified: success });
        if (success) {
            vscode.window.showInformationMessage(`Projet duplique (${report.copied} fichiers, echantillon verifie).`);
        } else {
            vscode.window.showErrorMessage('Duplication echouee - voir le rapport de verification.');
        }
    }

    dispose() {
        DuplicationPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
    }

    _buildHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enterprise Duplication</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#21262d;--text:#e6edf3;--muted:#7d8590;
 --green:#2ea043;--red:#da3633;--yellow:#d29922;--blue:#1f6feb;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
#header{background:var(--card);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;}
#header h1{font-size:17px;font-weight:600;}
.btn{background:var(--blue);color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;}
.btn:hover{opacity:.85;} .btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-green{background:var(--green);} .btn-warn{background:var(--yellow);color:#000;}
.btn-secondary{background:#21262d;color:var(--text);}
.btn-sm{padding:4px 9px;font-size:12px;}
#content{padding:16px 20px;}
.action-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:16px;}
.action-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;cursor:pointer;transition:border-color .2s;}
.action-card:hover{border-color:var(--blue);}
.action-card h3{font-size:14px;font-weight:600;margin-bottom:6px;}
.action-card p{font-size:12px;color:var(--muted);line-height:1.4;}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.section h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;}
.tool-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;}
.tool-row:last-child{border-bottom:none;}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;}
.badge-ok{background:rgba(46,160,67,.2);color:#3fb950;}
.badge-miss{background:rgba(218,54,51,.2);color:#f85149;}
.badge-warn{background:rgba(210,153,34,.2);color:#e3b341;}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;}
@keyframes spin{to{transform:rotate(360deg);}}
.log-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:monospace;font-size:12px;max-height:160px;overflow-y:auto;color:#58a6ff;margin-top:8px;}
.diff-row{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border);}
.diff-row:last-child{border-bottom:none;}
</style>
</head>
<body>
<div id="header">
  <div><h1>📋 Enterprise Duplication</h1><p id="subtitle" style="font-size:12px;color:var(--muted)">Reproduce environments at scale</p></div>
  <button class="btn btn-secondary" onclick="scanLocal()">🔄 Rescan</button>
</div>
<div id="content">
  <div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Scanning environment...</p></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let localProfile = null;

function scanLocal(){ vscode.postMessage({type:'scanLocal'}); showScanning(); }
function showScanning(){ document.getElementById('content').innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Scanning...</p></div>'; }

window.addEventListener('message', e => {
  const m = e.data;
  if(m.type==='scanning')   { showScanning(); return; }
  if(m.type==='localReady') { localProfile=m.profile; renderMain(m.profile); return; }
  if(m.type==='diffResult') { renderDiff(m); return; }
  if(m.type==='templateCreated') { appendLog('Template created: '+m.file+' ('+m.sizeMb+' MB)'); return; }
  if(m.type==='deployDone')      { appendLog('Template deployed to: '+m.dest); return; }
  if(m.type==='duplicateProgress') { renderDupProgress(m); return; }
  if(m.type==='duplicateDone')     { renderDupDone(m); return; }
  if(m.type==='exportDone')      { appendLog('Profile exported: '+m.file); return; }
  if(m.type==='templateProgress') { appendLog(m.msg); return; }
  if(m.type==='error')           { appendLog('[FAIL] '+m.msg); return; }
});

function appendLog(msg){
  let lb = document.getElementById('logBox');
  if(!lb) return;
  lb.innerHTML += '<div>'+escHtml(msg)+'</div>';
  lb.scrollTop = lb.scrollHeight;
}

function renderMain(p){
  const installed = (p.tools||[]).filter(t=>t.installed).length;
  const total     = (p.tools||[]).length;
  let html = \`
  <div class="action-grid">
    <div class="action-card" onclick="vscode.postMessage({type:'exportProfile'})">
      <h3>📤 Export Profile</h3>
      <p>Save a JSON snapshot of your full dev environment to share with your team.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'importProfile'})">
      <h3>📥 Import & Compare</h3>
      <p>Load a team profile and see which tools are missing or have version mismatches.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'createTemplate'})">
      <h3>📦 Create Template</h3>
      <p>Package the current workspace into a .zip template for instant team duplication.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'duplicateProject'})">
      <h3>&#128193; Dupliquer ce projet vers un nouveau dossier...</h3>
      <p>Copy this project to a new folder (skips node_modules, build, .dart_tool) with progress and a verification report.</p>
    </div>
    <div class="action-card" onclick="vscode.postMessage({type:'deployTemplate'})">
      <h3>🚀 Deploy Template</h3>
      <p>Extract a .zip template into a new folder and open it as a fresh workspace.</p>
    </div>
  </div>

  <div class="section">
    <h2>🖥️ Local Environment — \${p.machine} (\${p.platform})</h2>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      \${installed}/\${total} tools detected &nbsp;·&nbsp; Project type: <strong>\${p.projectType||'unknown'}</strong>
      &nbsp;·&nbsp; \${p.totalRam}GB RAM &nbsp;·&nbsp; \${p.cpuCores} cores
    </div>\`;
  (p.tools||[]).forEach(t=>{
    html+=\`<div class="tool-row">
      <span class="badge \${t.installed?'badge-ok':'badge-miss'}">\${t.installed?'OK':'MISSING'}</span>
      <span style="flex:1">\${t.name}</span>
      <span style="font-size:12px;color:var(--muted)">\${t.installed?(t.version||'detected'):'not found'}</span>
    </div>\`;
  });
  html+=\`</div>
  <div class="section"><h2>📋 Activity Log</h2><div class="log-box" id="logBox"><div>Ready.</div></div></div>\`;
  document.getElementById('content').innerHTML=html;
}

function renderDiff(m){
  let html=\`<div class="section"><h2>🔍 Profile Diff — \${m.file}</h2>
  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
    Imported from: \${m.imported.machine||'?'} on \${m.imported.platform||'?'} · Created: \${m.imported.createdAt||'?'}
  </div>\`;
  if(m.diffs.length===0){
    html+=\`<p style="color:#3fb950;font-size:13px">✅ Local environment matches imported profile.</p>\`;
  } else {
    m.diffs.forEach(d=>{
      html+=\`<div class="diff-row">
        <span class="badge \${d.severity==='error'?'badge-miss':'badge-warn'}">\${d.severity.toUpperCase()}</span>
        <span style="flex:1">\${d.tool}</span>
        <span style="font-size:12px;color:var(--muted)">local: \${d.local} → required: \${d.required}</span>
      </div>\`;
    });
  }
  html+=\`</div><div class="section"><h2>📋 Activity Log</h2><div class="log-box" id="logBox"><div>Diff complete.</div></div></div>\`;
  document.getElementById('content').innerHTML=html;
}

function dupZone(){
  let z = document.getElementById('dupZone');
  if(!z){
    z = document.createElement('div');
    z.id = 'dupZone';
    z.className = 'section';
    const c = document.getElementById('content');
    c.insertBefore(z, c.firstChild);
  }
  return z;
}
function renderDupProgress(m){
  const pct = m.total > 0 ? Math.round(m.copied / m.total * 100) : 0;
  dupZone().innerHTML =
    '<h2>Duplication en cours</h2>' +
    '<div style="background:#222;border-radius:4px;height:14px;overflow:hidden">' +
    '<div style="background:#4caf50;height:14px;width:' + pct + '%"></div></div>' +
    '<div class="muted">' + m.copied + ' / ' + m.total + ' fichiers (' + pct + '%)' +
    (m.current ? ' - ' + escHtml(m.current) : '') + '</div>';
}
function renderDupDone(m){
  if(!m.success){
    dupZone().innerHTML = '<h2>Echec de la duplication</h2>' +
      '<div><span class="badge badge-miss">REJECTED</span> ' + escHtml(m.error || 'Erreur inconnue') + '</div>';
    appendLog('DUPLICATION ECHEC: ' + escHtml(m.error || ''));
    return;
  }
  const r = m.report || {};
  let rows = '';
  (r.sample || []).forEach(x => {
    rows += '<tr><td>' + escHtml(x.file) + '</td><td class="muted">' + x.sha256 +
      (x.partial ? ' (partiel)' : '') + '</td><td>' + (x.match ? 'OK' : 'KO') + '</td></tr>';
  });
  dupZone().innerHTML =
    '<h2>Duplication terminee</h2>' +
    '<div><span class="badge badge-ok">MATCH</span> ' + escHtml(m.dest || '') + '</div>' +
    '<div class="muted">' + r.copied + ' / ' + r.total + ' fichiers copies' +
    (r.skippedSymlinks ? ', ' + r.skippedSymlinks + ' liens symboliques ignores' : '') +
    ' - echantillon verifie: ' + r.matched + ' / ' + r.checked + '</div>' +
    (rows ? '<table><tr><th>Fichier</th><th>sha256 (16)</th><th>Resultat</th></tr>' + rows + '</table>' : '') +
    ((r.copyErrors && r.copyErrors.length) ? '<div>Erreurs de copie: ' + r.copyErrors.length + '</div>' : '') +
    ((r.mismatches && r.mismatches.length) ? '<div>Discordances: ' + r.mismatches.map(escHtml).join(', ') + '</div>' : '');
  appendLog('DUPLICATION REUSSIE: ' + r.copied + ' fichiers -> ' + escHtml(m.dest || ''));
}
function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;
    }
}

module.exports = { DuplicationPanel, DUP_DEFAULT_EXCLUDES, collectDupFiles, verifyDupCopy, hashDupFile };
