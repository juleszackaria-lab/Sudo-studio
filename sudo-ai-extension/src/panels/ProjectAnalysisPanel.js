/**
 * SUDO STUDIO - Project Analysis Panel
 * Analyzes workspace locally: stack, deps, security, quality, architecture
 * No backend required. AI recommendations via runtime port 6000.
 */
const vscode = require('vscode');
const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const { exec } = require('child_process');

class ProjectAnalysisPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        setTimeout(() => this.analyzeProject(), 300);
    }

    static createOrShow(extensionUri) {
        if (ProjectAnalysisPanel.currentPanel) {
            ProjectAnalysisPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoProjectAnalysis', '🔍 Project Analysis',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ProjectAnalysisPanel.currentPanel = new ProjectAnalysisPanel(panel, extensionUri);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'reanalyze':      await this.analyzeProject(); break;
            case 'autoFix':       await this.runAutoFix(msg.issue); break;
            case 'aiRecommend':   await this.aiRecommendations(); break;
            case 'openFile':      await this.openFile(msg.file); break;
        }
    }

    async analyzeProject() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.panel.webview.postMessage({ type: 'noWorkspace' });
            return;
        }

        this.panel.webview.postMessage({ type: 'analyzing' });

        const root = folder.uri.fsPath;
        const result = {
            name: path.basename(root),
            root,
            stack: [],
            deps: [],
            devDeps: [],
            issues: [],
            metrics: {},
            score: 0
        };

        try {
            // ── File detection ─────────────────────────────────────────────
            const has = f => fs.existsSync(path.join(root, f));
            const read = f => {
                try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; }
            };

            // Count files by extension
            const fileCounts = await this._countFiles(root);
            result.metrics.fileCount = fileCounts.total;
            result.metrics.fileCounts = fileCounts.byExt;

            // ── Stack detection ────────────────────────────────────────────
            if (has('package.json')) {
                const pkg = JSON.parse(read('package.json') || '{}');
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                result.metrics.depCount = Object.keys(pkg.dependencies || {}).length;
                result.metrics.devDepCount = Object.keys(pkg.devDependencies || {}).length;

                const detected = [];
                if (deps['next'])        detected.push({ name: 'Next.js', icon: '▲', category: 'framework' });
                if (deps['react'])       detected.push({ name: 'React',   icon: '⚛', category: 'framework' });
                if (deps['vue'])         detected.push({ name: 'Vue.js',  icon: '💚', category: 'framework' });
                if (deps['angular'])     detected.push({ name: 'Angular', icon: '🅰', category: 'framework' });
                if (deps['svelte'])      detected.push({ name: 'Svelte',  icon: '🔥', category: 'framework' });
                if (deps['express'])     detected.push({ name: 'Express', icon: '🚂', category: 'backend' });
                if (deps['fastify'])     detected.push({ name: 'Fastify', icon: '⚡', category: 'backend' });
                if (deps['nestjs'] || deps['@nestjs/core']) detected.push({ name: 'NestJS', icon: '🐱', category: 'backend' });
                if (deps['prisma'] || deps['@prisma/client']) detected.push({ name: 'Prisma', icon: '🔷', category: 'database' });
                if (deps['mongoose'])    detected.push({ name: 'MongoDB', icon: '🍃', category: 'database' });
                if (deps['pg'])          detected.push({ name: 'PostgreSQL', icon: '🐘', category: 'database' });
                if (deps['redis'])       detected.push({ name: 'Redis',   icon: '🔴', category: 'cache' });
                if (deps['jest'] || deps['vitest']) detected.push({ name: 'Testing', icon: '🧪', category: 'test' });
                if (deps['typescript'] || deps['@types/node']) detected.push({ name: 'TypeScript', icon: '🔷', category: 'language' });
                else detected.push({ name: 'JavaScript', icon: '🟡', category: 'language' });
                detected.push({ name: 'Node.js', icon: '🟢', category: 'runtime' });

                result.stack = detected;
                result.deps = Object.keys(pkg.dependencies || {}).slice(0, 20);
                result.devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 15);
                result.packageName = pkg.name;
                result.packageVersion = pkg.version;

                // Check issues
                if (!pkg.scripts?.test) result.issues.push({ level: 'warn', area: 'Tests', msg: 'Aucun script test défini dans package.json', fix: 'addTestScript' });
                if (!pkg.scripts?.build) result.issues.push({ level: 'info', area: 'Build', msg: 'Aucun script build défini', fix: null });
                if (!has('.env.example') && !has('.env.sample')) result.issues.push({ level: 'warn', area: 'Config', msg: '.env.example manquant — autres dev ne savent pas les vars requises', fix: null });
            }

            if (has('requirements.txt') || has('Pipfile')) {
                result.stack.push({ name: 'Python', icon: '🐍', category: 'language' });
                if (has('manage.py'))  result.stack.push({ name: 'Django', icon: '🎸', category: 'framework' });
                else if (has('app.py')) result.stack.push({ name: 'Flask', icon: '🌶', category: 'framework' });
            }
            if (has('go.mod'))        result.stack.push({ name: 'Go', icon: '🔵', category: 'language' });
            if (has('Cargo.toml'))    result.stack.push({ name: 'Rust', icon: '🦀', category: 'language' });
            if (has('pom.xml') || has('build.gradle')) result.stack.push({ name: 'Java', icon: '☕', category: 'language' });
            if (has('pubspec.yaml'))  result.stack.push({ name: 'Flutter/Dart', icon: '🎨', category: 'language' });

            // ── Architecture checks ────────────────────────────────────────
            result.architecture = {
                hasDocker: has('Dockerfile') || has('docker-compose.yml'),
                hasCI:     has('.github/workflows') || has('.gitlab-ci.yml') || has('Jenkinsfile'),
                hasTests:  has('__tests__') || has('test') || has('tests') || has('spec'),
                hasGit:    has('.git'),
                hasLint:   has('.eslintrc') || has('.eslintrc.js') || has('.eslintrc.json') || has('eslint.config.js'),
                hasFormat: has('.prettierrc') || has('.prettierrc.json') || has('.prettierrc.js'),
                hasEnv:    has('.env') || has('.env.local'),
                hasReadme: has('README.md') || has('README'),
                hasDocs:   has('docs') || has('documentation'),
            };

            if (!result.architecture.hasDocker) result.issues.push({ level: 'info', area: 'Docker', msg: 'Pas de Dockerfile — difficile à déployer en conteneur', fix: 'genDockerfile' });
            if (!result.architecture.hasCI)     result.issues.push({ level: 'info', area: 'CI/CD', msg: 'Pas de pipeline CI/CD configuré', fix: 'genCICD' });
            if (!result.architecture.hasLint)   result.issues.push({ level: 'warn', area: 'Qualité', msg: 'Pas de linter configuré (ESLint recommandé)', fix: null });
            if (!result.architecture.hasReadme) result.issues.push({ level: 'warn', area: 'Docs', msg: 'README manquant', fix: null });

            // ── Security scan ──────────────────────────────────────────────
            if (has('.env')) {
                result.issues.push({ level: 'warn', area: 'Sécurité', msg: '.env présent — vérifiez qu\'il est dans .gitignore', fix: null });
            }
            if (has('.git')) {
                const gitignore = read('.gitignore') || '';
                if (!gitignore.includes('.env') && has('.env')) {
                    result.issues.push({ level: 'error', area: 'Sécurité', msg: '.env n\'est pas dans .gitignore — RISQUE DE FUITE DE SECRETS!', fix: 'fixGitignore' });
                }
            }

            // ── Score calculation ──────────────────────────────────────────
            const checks = [
                result.architecture.hasDocker,
                result.architecture.hasCI,
                result.architecture.hasTests,
                result.architecture.hasGit,
                result.architecture.hasLint,
                result.architecture.hasReadme,
                result.architecture.hasFormat,
                result.stack.length > 0,
                result.issues.filter(i => i.level === 'error').length === 0,
                result.issues.filter(i => i.level === 'warn').length < 3,
            ];
            result.score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

        } catch (e) {
            result.issues.push({ level: 'error', area: 'Analyse', msg: `Erreur: ${e.message}`, fix: null });
        }

        this.panel.webview.postMessage({ type: 'analysisResult', result });
    }

    async _countFiles(dir, depth = 0) {
        if (depth > 3) return { total: 0, byExt: {} };
        const counts = { total: 0, byExt: {} };
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'].includes(e.name)) continue;
                if (e.isDirectory()) {
                    const sub = await this._countFiles(path.join(dir, e.name), depth + 1);
                    counts.total += sub.total;
                    for (const [ext, n] of Object.entries(sub.byExt)) {
                        counts.byExt[ext] = (counts.byExt[ext] || 0) + n;
                    }
                } else {
                    const ext = path.extname(e.name) || 'other';
                    counts.total++;
                    counts.byExt[ext] = (counts.byExt[ext] || 0) + 1;
                }
            }
        } catch (_) {}
        return counts;
    }

    async runAutoFix(issue) {
        switch (issue) {
            case 'fixGitignore': {
                const folder = vscode.workspace.workspaceFolders?.[0];
                if (!folder) return;
                const giPath = path.join(folder.uri.fsPath, '.gitignore');
                let content = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
                if (!content.includes('.env')) {
                    content += '\n# Environment\n.env\n.env.local\n.env.*.local\n';
                    fs.writeFileSync(giPath, content);
                    vscode.window.showInformationMessage('✅ .gitignore mis à jour - .env ajouté');
                }
                break;
            }
            case 'genDockerfile':
                vscode.commands.executeCommand('sudoStudio.openDevOpsPanel');
                break;
            case 'genCICD':
                vscode.commands.executeCommand('sudoStudio.openDevOpsPanel');
                break;
        }
        await this.analyzeProject();
    }

    async aiRecommendations() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;

        this.panel.webview.postMessage({ type: 'aiLoading' });
        try {
            const r = await axios.post('http://localhost:6000/infer', {
                message: `Analyse ce projet et donne 5 recommandations concrètes pour améliorer la qualité, sécurité et maintenabilité. Répertoire: ${path.basename(folder.uri.fsPath)}. Soit concis et actionnable.`,
                max_tokens: 400
            }, { timeout: 60000 });
            this.panel.webview.postMessage({ type: 'aiRecommendations', text: r.data.reply });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'aiError', text: 'Runtime IA non disponible' });
        }
    }

    async openFile(file) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            vscode.window.showTextDocument(doc);
        } catch (_) {}
    }

    dispose() {
        ProjectAnalysisPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Project Analysis</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);min-height:100vh}
#header{background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
#header h1{font-size:17px;font-weight:600}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:7px 13px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sm{padding:4px 9px;font-size:11px}
#content{padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:10px;padding:14px 16px}
.card-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:10px}
.score-circle{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;margin:0 auto 8px}
.score-row{display:flex;align-items:center;gap:16px;margin-bottom:12px}
.score-details{flex:1}
.score-label{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:2px}
.score-bar{height:8px;background:var(--vscode-panel-border);border-radius:4px;overflow:hidden;margin-top:4px}
.score-fill{height:100%;border-radius:4px;transition:width .8s}
.stack-grid{display:flex;flex-wrap:wrap;gap:8px}
.stack-chip{padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;display:flex;align-items:center;gap:4px}
.chip-framework{background:rgba(99,102,241,.15);color:#818cf8}
.chip-backend  {background:rgba(34,197,94,.15); color:#4ade80}
.chip-database {background:rgba(251,191,36,.15);color:#fbbf24}
.chip-language {background:rgba(96,165,250,.15); color:#60a5fa}
.chip-runtime  {background:rgba(52,211,153,.15); color:#34d399}
.chip-test     {background:rgba(248,113,113,.15);color:#f87171}
.chip-cache    {background:rgba(196,181,253,.15);color:#c4b5fd}
.arch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.arch-item{background:var(--vscode-editorWidget-background);border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:6px;font-size:12px}
.arch-ok  {color:#4caf50}
.arch-miss{color:#9e9e9e;opacity:.6}
.issue{padding:9px 12px;border-radius:6px;margin-bottom:6px;font-size:12px;display:flex;align-items:flex-start;gap:8px}
.issue.error{background:rgba(244,67,54,.1);border-left:3px solid #f44336}
.issue.warn {background:rgba(255,152,0,.1);border-left:3px solid #ff9800}
.issue.info {background:rgba(33,150,243,.1);border-left:3px solid #2196f3}
.issue-badge{font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600;white-space:nowrap;flex-shrink:0}
.spinner{width:20px;height:20px;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-button-background);border-radius:50%;animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
#aiBox{background:var(--vscode-editorWidget-background);border-radius:8px;padding:12px;font-size:13px;line-height:1.6;margin-top:10px;white-space:pre-wrap;display:none}
#aiBox.show{display:block}
#loadingOverlay{display:none;padding:30px;text-align:center}
#loadingOverlay.show{display:block}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
</style>
</head>
<body>
<div id="header">
    <div>
        <h1>🔍 Project Analysis</h1>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">Audit complet de votre projet</div>
    </div>
    <div style="display:flex;gap:8px">
        <button class="btn btn-sec btn-sm" onclick="reanalyze()">🔄 Réanalyser</button>
        <button class="btn btn-sm" onclick="aiRec()">🤖 Recommandations IA</button>
    </div>
</div>

<div id="content">
    <div id="loadingOverlay" class="show">
        <div class="spinner" style="width:32px;height:32px;margin:0 auto 12px"></div>
        <div style="font-size:13px;color:var(--vscode-descriptionForeground)">Analyse du projet en cours...</div>
    </div>

    <div id="mainContent" style="display:none">
        <!-- Score Card -->
        <div class="card">
            <div class="card-title">📊 Score Global</div>
            <div class="score-row">
                <div class="score-circle" id="scoreCircle"></div>
                <div class="score-details">
                    <div id="projectNameEl" style="font-size:16px;font-weight:700;margin-bottom:4px"></div>
                    <div class="score-label">Score de qualité</div>
                    <div class="score-bar"><div class="score-fill" id="scoreFill"></div></div>
                    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px" id="scoreLabel"></div>
                </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap" id="metricsRow"></div>
        </div>

        <!-- Stack -->
        <div class="card">
            <div class="card-title">⚙️ Stack Technique</div>
            <div class="stack-grid" id="stackGrid"></div>
        </div>

        <!-- Architecture -->
        <div class="card">
            <div class="card-title">🏗️ Architecture</div>
            <div class="arch-grid" id="archGrid"></div>
        </div>

        <!-- Issues -->
        <div class="card" id="issuesCard">
            <div class="card-title" style="display:flex;justify-content:space-between">
                <span>⚠️ Problèmes Détectés</span>
                <span id="issueCount" style="font-size:11px;font-weight:400">0 problèmes</span>
            </div>
            <div id="issuesList"></div>
        </div>

        <!-- AI Recommendations -->
        <div class="card">
            <div class="card-title">🤖 Recommandations IA</div>
            <div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Analyse IA nécessite le runtime (port 6000)</div>
            <button class="btn btn-sm" onclick="aiRec()">🤖 Obtenir les recommandations IA</button>
            <div id="aiBox"></div>
        </div>
    </div>

    <div id="noWorkspaceMsg" style="display:none;padding:30px;text-align:center;color:var(--vscode-descriptionForeground)">
        <div style="font-size:32px;margin-bottom:10px">📁</div>
        <div style="font-size:14px">Aucun workspace ouvert</div>
        <div style="font-size:12px;margin-top:4px">Ouvrez un dossier de projet dans VSCode</div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function reanalyze() { vscode.postMessage({type:'reanalyze'}); }
function aiRec()     { vscode.postMessage({type:'aiRecommend'}); }

function scoreColor(s) {
    if (s >= 80) return '#4caf50';
    if (s >= 60) return '#ff9800';
    return '#f44336';
}
function scoreLabel(s) {
    if (s >= 80) return 'Excellent — Projet bien structuré';
    if (s >= 60) return 'Bon — Quelques améliorations possibles';
    if (s >= 40) return 'Moyen — Plusieurs points à corriger';
    return 'Nécessite attention — Problèmes importants détectés';
}

window.addEventListener('message', ev => {
    const m = ev.data;
    switch(m.type) {
        case 'analyzing':
            document.getElementById('loadingOverlay').classList.add('show');
            document.getElementById('mainContent').style.display='none';
            break;
        case 'noWorkspace':
            document.getElementById('loadingOverlay').classList.remove('show');
            document.getElementById('noWorkspaceMsg').style.display='block';
            break;
        case 'analysisResult':
            renderResult(m.result);
            break;
        case 'aiLoading':
            document.getElementById('aiBox').className='show';
            document.getElementById('aiBox').textContent='⏳ Analyse IA en cours...';
            break;
        case 'aiRecommendations':
            document.getElementById('aiBox').className='show';
            document.getElementById('aiBox').textContent=m.text;
            break;
        case 'aiError':
            document.getElementById('aiBox').className='show';
            document.getElementById('aiBox').textContent='❌ '+m.text;
            break;
    }
});

function renderResult(r) {
    document.getElementById('loadingOverlay').classList.remove('show');
    document.getElementById('mainContent').style.display='flex';
    document.getElementById('mainContent').style.flexDirection='column';
    document.getElementById('mainContent').style.gap='14px';
    document.getElementById('noWorkspaceMsg').style.display='none';

    // Score
    const sc = document.getElementById('scoreCircle');
    sc.textContent = r.score;
    sc.style.background = scoreColor(r.score) + '20';
    sc.style.color = scoreColor(r.score);
    sc.style.border = '3px solid ' + scoreColor(r.score);
    document.getElementById('scoreFill').style.width = r.score + '%';
    document.getElementById('scoreFill').style.background = scoreColor(r.score);
    document.getElementById('scoreLabel').textContent = scoreLabel(r.score);
    document.getElementById('projectNameEl').textContent = r.packageName || r.name;

    // Metrics chips
    const metrics = [
        { icon:'📄', label: r.metrics.fileCount + ' fichiers' },
        { icon:'📦', label: (r.metrics.depCount || 0) + ' deps' },
        { icon:'🔧', label: (r.metrics.devDepCount || 0) + ' devDeps' },
    ];
    document.getElementById('metricsRow').innerHTML = metrics.map(m =>
        '<span style="background:var(--vscode-editorWidget-background);padding:4px 10px;border-radius:12px;font-size:11px">'+m.icon+' '+m.label+'</span>'
    ).join('');

    // Stack
    const chipClass = { framework:'chip-framework', backend:'chip-backend', database:'chip-database', language:'chip-language', runtime:'chip-runtime', test:'chip-test', cache:'chip-cache' };
    document.getElementById('stackGrid').innerHTML = (r.stack || []).map(s =>
        '<span class="stack-chip '+(chipClass[s.category]||'chip-language')+'">'+s.icon+' '+s.name+'</span>'
    ).join('');
    if (!r.stack?.length) document.getElementById('stackGrid').innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-size:12px">Stack non détectée</span>';

    // Architecture
    const arch = r.architecture || {};
    const archItems = [
        ['Docker', arch.hasDocker, '🐳'],
        ['CI/CD', arch.hasCI, '⚙️'],
        ['Tests', arch.hasTests, '🧪'],
        ['Git', arch.hasGit, '📚'],
        ['Linter', arch.hasLint, '✏️'],
        ['Prettier', arch.hasFormat, '✨'],
        ['README', arch.hasReadme, '📖'],
        ['Docs', arch.hasDocs, '📚'],
        ['.env', arch.hasEnv, '🔑'],
    ];
    document.getElementById('archGrid').innerHTML = archItems.map(([n, ok, icon]) =>
        '<div class="arch-item"><span class="'+(ok?'arch-ok':'arch-miss')+'">'+icon+' '+(ok?'✓':'✗')+' '+n+'</span></div>'
    ).join('');

    // Issues
    const issues = r.issues || [];
    document.getElementById('issueCount').textContent = issues.length + ' problème' + (issues.length!==1?'s':'');
    if (issues.length === 0) {
        document.getElementById('issuesList').innerHTML = '<div style="color:#4caf50;font-size:12px">✅ Aucun problème détecté!</div>';
    } else {
        document.getElementById('issuesList').innerHTML = issues.map(i => {
            const fixBtn = i.fix ? '<button class="btn btn-sm btn-sec" onclick="runFix(\''+i.fix+'\')" style="margin-left:auto;flex-shrink:0">🔧 AutoFix</button>' : '';
            const badge = i.level === 'error' ? '🔴 ERREUR' : i.level === 'warn' ? '🟡 AVERT.' : 'ℹ️ INFO';
            return '<div class="issue '+i.level+'"><span class="issue-badge">'+badge+'</span><span style="flex:1"><strong>['+i.area+']</strong> '+i.msg+'</span>'+fixBtn+'</div>';
        }).join('');
    }
}

function runFix(fix) { vscode.postMessage({type:'autoFix',issue:fix}); }
</script>
</body>
</html>`;
    }
}

module.exports = { ProjectAnalysisPanel };
