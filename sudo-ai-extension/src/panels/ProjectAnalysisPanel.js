/**
 * SUDO STUDIO - Project Analysis Panel
 * Analyzes workspace locally: stack, deps, security, quality, architecture
 * No backend required. AI recommendations via runtime port 6000.
 */
const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const { exec, spawnSync } = require('child_process');
// P9: deterministic analysis engine + shared audit (ASCII additions only).
const analyzer = require('../analysis/projectAnalyzer');
const { appendAudit } = require('../utils/auditLog');

class ProjectAnalysisPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        // P9: run state (cancel/timeout) + last deterministic report.
        this._abort = null;
        this._analyzing = false;
        this._lastAnalysis = null;
        this._aiComplete = null; // injectable (tests) else AIProviderService

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Pre-check workspace BEFORE showing the loading overlay.
        // If no folder is open, send noWorkspace immediately so the user
        // never sees "Analyse du projet en cours..." indefinitely.
        if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
            setTimeout(() => {
                this.panel.webview.postMessage({ type: 'noWorkspace' });
            }, 150); // short delay to let the WebView script initialise
        } else {
            // Start analysis, but cap with a 10s safety timeout
            this._analysisTimeout = setTimeout(() => this.analyzeProject(), 300);
        }
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
        if (wvFallback.handlePanelMessage(null, msg)) return;
        switch (msg.type) {
            case 'reanalyze':      await this.analyzeProject(); break;
            case 'autoFix':       await this.runAutoFix(msg.issue); break;
            case 'aiRecommend':   await this.aiRecommendations(); break;
            case 'openFile':      await this.openFile(msg.file); break;
            case 'cancelAnalysis': this.cancelAnalysis(); break;
            case 'exportJson':     await this.exportJson(); break;
            case 'aiSummary':      await this.aiSummary(); break;
            case 'genAgents':      await this.genAgents(); break;
            case 'confirmAgents':  await this.confirmAgents(); break;
        }
    }

    async analyzeProject() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.panel.webview.postMessage({ type: 'noWorkspace' });
            return;
        }
        // P9: one run at a time; cancel/timeout handled by the analyzer.
        if (this._analyzing) return;
        this._analyzing = true;
        if (this._abort) { try { this._abort.abort(); } catch (_) {} }
        this._abort = new AbortController();

        this.panel.webview.postMessage({ type: 'analyzing' });

        const root = folder.uri.fsPath;
        let analysis = null;
        try {
            analysis = await analyzer.analyzeProject(root, {
                signal: this._abort.signal,
                timeoutMs: 120000,
                onProgress: (p) => {
                    try { this.panel.webview.postMessage({ type: 'progress', progress: p }); }
                    catch (_) {}
                },
            });
        } catch (e) {
            this._analyzing = false;
            if (e && e.code === 'ANALYSIS_ABORTED') {
                const n = e.partial && e.partial.stats ? e.partial.stats.files : 0;
                this.panel.webview.postMessage({ type: 'analysisCancelled',
                    text: 'Analyse annulee (' + n + ' fichiers parcourus)' });
                return;
            }
            const msg = e && e.code === 'ANALYSIS_TIMEOUT' ? e.message
                : 'Erreur d analyse: ' + ((e && e.message) || e);
            this.panel.webview.postMessage({ type: 'analysisError', text: String(msg).slice(0, 300) });
            return;
        }
        this._analyzing = false;
        this._lastAnalysis = analysis;

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

            // P9: exact file metrics from the deterministic walk (verifiable).
            result.metrics.fileCount = analysis.stats.files;
            result.metrics.fileCounts = {};
            for (const [lang, v] of Object.entries(analysis.stats.byLang)) {
                result.metrics.fileCounts[lang] = v.files;
            }
            result.metrics.lineCount = analysis.stats.lines;

            // ── Stack detection ────────────────────────────────────────────
            // P22: dep counts from the deterministic engine (all ecosystems, exact).
            let depCount = 0;
            let devDepCount = 0;
            const depNames = [];
            const devDepNames = [];
            for (const eco of analysis.deps || []) {
                for (const m of eco.manifestDeps || []) {
                    if (m.dev) { devDepCount++; devDepNames.push(m.name); }
                    else { depCount++; depNames.push(m.name); }
                }
            }
            result.metrics.depCount = depCount;
            result.metrics.devDepCount = devDepCount;
            result.deps = depNames.slice(0, 20);
            result.devDeps = devDepNames.slice(0, 15);
            if (has('package.json')) {
                const pkg = JSON.parse(read('package.json') || '{}');
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };

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
            // P22: verifiable detections - each badge carries its evidence
            // (file or command). 'missing' only when the check really ran.
            const isOk = (v) => !!v && (v === true || v.state === 'ok');
            const detOk = (evidence) => ({ state: 'ok', evidence: evidence });
            const detMiss = (evidence) => ({ state: 'missing', evidence: evidence });
            const detUnver = (evidence) => ({ state: 'unverified', evidence: evidence });
            const NL = String.fromCharCode(10);
            const shortErr = (e) => String((e && e.message) || e).split(NL)[0].slice(0, 100);
            const gitInfo = (() => {
                try {
                    const r = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'],
                        { encoding: 'utf8', timeout: 8000 });
                    if (r.error) {
                        if (has('.git')) return detOk('.git present (git inutilisable: ' + shortErr(r.error) + ')');
                        return detUnver('git inutilisable (' + shortErr(r.error) + '), aucun .git');
                    }
                    if (String(r.stdout || '').trim() !== 'true') {
                        return detMiss('ni .git ni depot (git rev-parse: pas un depot)');
                    }
                    let extra = 'details illisibles';
                    try {
                        const b = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'],
                            { encoding: 'utf8', timeout: 8000 });
                        const br = String(b.stdout || '').trim() || '?';
                        const s = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=no'],
                            { encoding: 'utf8', timeout: 8000 });
                        const n = String(s.stdout || '').split(NL).filter((x) => x.trim()).length;
                        extra = 'branche ' + br + ', ' + n + ' modifie(s) non commite(s)';
                    } catch (_) { /* keep default */ }
                    const via = has('.git') ? '.git present' : 'depot sans .git visible';
                    return detOk(via + ' [git rev-parse] (' + extra + ')');
                } catch (e) {
                    return detUnver('verification git impossible (' + shortErr(e) + ')');
                }
            })();
            const dockerNames = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
            const dockerFound = dockerNames.filter(has);
            const archDocker = dockerFound.length ? detOk('fichier(s): ' + dockerFound.join(', '))
                : detMiss('aucun de ' + dockerNames.join(', ') + ' a la racine');
            const ciList = analysis.ci || [];
            const archCI = ciList.length ? detOk(ciList.map((c) => c.system + ' ' + c.path).join(', '))
                : detMiss('aucun CI detecte (.github/workflows, .gitlab-ci.yml, Jenkinsfile, ...)');
            const tInfo = analysis.tests || {};
            const archTests = (tInfo.count || 0) > 0
                ? detOk(tInfo.count + ' fichier(s)' +
                    ((tInfo.frameworks || []).length ? ' [' + tInfo.frameworks.join(', ') + ']' : '') +
                    ((tInfo.sample || []).length ? ' ex: ' + tInfo.sample.slice(0, 3).join(', ') : ''))
                : detMiss('aucun fichier de test (test/, *.test.*, *_test.go, ... )');
            const lintNames = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
                'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
                'analysis_options.yaml', 'ruff.toml', '.ruff.toml', 'biome.json'];
            const lintFound = lintNames.filter(has);
            const archLint = lintFound.length ? detOk('fichier: ' + lintFound.join(', '))
                : detMiss('aucune config lint (eslint.*, analysis_options.yaml, ruff, biome)');
            const fmtNames = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.yml',
                'prettier.config.js', '.editorconfig'];
            const fmtFound = fmtNames.filter(has);
            let pkgHasPrettier = false;
            try {
                const pj = JSON.parse(read('package.json') || '{}');
                pkgHasPrettier = !!(pj.prettier || (pj.devDependencies && pj.devDependencies.prettier) ||
                    (pj.dependencies && pj.dependencies.prettier));
            } catch (_) { /* no package.json: ignore */ }
            const archFormat = (fmtFound.length || pkgHasPrettier)
                ? detOk(fmtFound.length ? 'fichier: ' + fmtFound.join(', ') : 'cle prettier dans package.json')
                : detMiss('aucun formateur (prettier.*, .editorconfig, cle prettier)');
            let envFiles = [];
            try {
                envFiles = fs.readdirSync(root).filter((f) => f === '.env' || f.indexOf('.env.') === 0);
            } catch (_) { envFiles = []; }
            const archEnv = envFiles.length ? detOk('fichier(s): ' + envFiles.join(', '))
                : detMiss('aucun fichier .env* a la racine');
            const rdInfo = analysis.readme || {};
            const archReadme = rdInfo.present ? detOk('fichier: ' + rdInfo.path)
                : detMiss('aucun README (README.md, README, ... )');
            const archDocs = (has('docs') || has('documentation'))
                ? detOk('dossier: ' + (has('docs') ? 'docs' : 'documentation'))
                : detMiss('aucun dossier docs/ ni documentation/');
            result.architecture = {
                hasDocker: archDocker,
                hasCI: archCI,
                hasTests: archTests,
                hasGit: gitInfo,
                hasLint: archLint,
                hasFormat: archFormat,
                hasEnv: archEnv,
                hasReadme: archReadme,
                hasDocs: archDocs,
            };

            if (!isOk(result.architecture.hasDocker)) result.issues.push({ level: 'info', area: 'Docker', msg: 'Pas de Dockerfile — difficile à déployer en conteneur', fix: 'genDockerfile' });
            if (!isOk(result.architecture.hasCI))     result.issues.push({ level: 'info', area: 'CI/CD', msg: 'Pas de pipeline CI/CD configuré', fix: 'genCICD' });
            if (!isOk(result.architecture.hasLint))   result.issues.push({ level: 'warn', area: 'Qualité', msg: 'Pas de linter configuré (ESLint recommandé)', fix: null });
            if (!isOk(result.architecture.hasReadme)) result.issues.push({ level: 'warn', area: 'Docs', msg: 'README manquant', fix: null });

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
                isOk(result.architecture.hasDocker),
                isOk(result.architecture.hasCI),
                isOk(result.architecture.hasTests),
                isOk(result.architecture.hasGit),
                isOk(result.architecture.hasLint),
                isOk(result.architecture.hasReadme),
                isOk(result.architecture.hasFormat),
                result.stack.length > 0,
                result.issues.filter(i => i.level === 'error').length === 0,
                result.issues.filter(i => i.level === 'warn').length < 3,
            ];
            result.score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

        } catch (e) {
            result.issues.push({ level: 'error', area: 'Analyse', msg: `Erreur: ${e.message}`, fix: null });
        }

        this.panel.webview.postMessage({ type: 'analysisResult', result, analysis });
    }

    // P9: _countFiles removed (superseded by the deterministic analyzer).

    cancelAnalysis() {
        try { if (this._abort) this._abort.abort(); } catch (_) {}
    }

    async ensureAnalysis() {
        if (this._lastAnalysis) return this._lastAnalysis;
        await this.analyzeProject();
        return this._lastAnalysis;
    }

    async exportJson() {
        const analysis = await this.ensureAnalysis();
        if (!analysis) return;
        let uri = null;
        try {
            uri = await vscode.window.showSaveDialog({
                filters: { 'JSON': ['json'] },
                saveLabel: 'Exporter',
                title: 'Exporter le rapport d analyse (JSON)',
            });
        } catch (_) { uri = null; }
        if (!uri) return;
        try {
            fs.writeFileSync(uri.fsPath, JSON.stringify(analysis, null, 2), 'utf8');
            try { appendAudit('ANALYSIS_EXPORT', 'rapport JSON: ' + uri.fsPath, { actor: 'user', result: 'ok' }); }
            catch (_) {}
            vscode.window.showInformationMessage('Rapport exporte: ' + uri.fsPath);
            this.panel.webview.postMessage({ type: 'exportDone', path: uri.fsPath });
        } catch (e) {
            vscode.window.showErrorMessage('Export impossible: ' + e.message);
        }
    }

    async aiSummary() {
        const analysis = await this.ensureAnalysis();
        if (!analysis) return;
        this.panel.webview.postMessage({ type: 'aiSummary', text: '', loading: true });
        const prompt = analyzer.aiSummaryPrompt(analysis);
        try {
            let complete = this._aiComplete;
            if (!complete) {
                const { getAIProviderService } = require('../services/AIProviderService');
                const svc = getAIProviderService();
                complete = (p) => svc.complete({ prompt: p, max_tokens: 600,
                    temperature: 0.2, purpose: 'analysis' });
            }
            const r = await complete(prompt);
            const text = r && (r.reply || r.text) ? (r.reply || r.text) : '';
            this.panel.webview.postMessage({ type: 'aiSummary', text: String(text).slice(0, 4000) });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'aiSummary', text: '',
                error: 'Resume IA indisponible: ' + String((e && e.message) || e).slice(0, 200) });
        }
    }

    async genAgents() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.panel.webview.postMessage({ type: 'noWorkspace' });
            return;
        }
        const analysis = await this.ensureAnalysis();
        if (!analysis) return;
        const target = path.join(folder.uri.fsPath, 'AGENTS.md');
        const content = analyzer.buildAgentsMd(analysis);
        let old = null;
        try { old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null; }
        catch (_) { old = null; }
        if (old == null) {
            try {
                fs.writeFileSync(target, content, 'utf8');
                try { appendAudit('ANALYSIS_AGENTS_MD', 'AGENTS.md cree: ' + target, { actor: 'user', result: 'ok' }); }
                catch (_) {}
                this.panel.webview.postMessage({ type: 'agentsWritten', created: true });
            } catch (e) {
                this.panel.webview.postMessage({ type: 'analysisError',
                    text: 'Ecriture AGENTS.md impossible: ' + String(e.message).slice(0, 200) });
            }
            return;
        }
        const d = analyzer.diffLines(old, content);
        if (d.same) {
            this.panel.webview.postMessage({ type: 'agentsWritten', created: false, unchanged: true });
            return;
        }
        const cap = (arr) => arr.slice(0, 200);
        this.panel.webview.postMessage({ type: 'agentsDiff',
            diff: { oldLines: d.oldLines, newLines: d.newLines,
                commonPrefix: d.commonPrefix, commonSuffix: d.commonSuffix,
                oldMiddle: cap(d.oldMiddle), newMiddle: cap(d.newMiddle),
                truncated: d.oldMiddle.length > 200 || d.newMiddle.length > 200 } });
    }

    async confirmAgents() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const analysis = await this.ensureAnalysis();
        if (!analysis) return;
        // Regenerated server-side (deterministic): the webview never sends content back.
        const content = analyzer.buildAgentsMd(analysis);
        const target = path.join(folder.uri.fsPath, 'AGENTS.md');
        try {
            fs.writeFileSync(target, content, 'utf8');
            try { appendAudit('ANALYSIS_AGENTS_MD', 'AGENTS.md ecrase (confirme): ' + target, { actor: 'user', result: 'ok' }); }
            catch (_) {}
            this.panel.webview.postMessage({ type: 'agentsWritten', created: false });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'analysisError',
                text: 'Ecriture AGENTS.md impossible: ' + String(e.message).slice(0, 200) });
        }
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
            const r = await axios.post('http://127.0.0.1:6000/infer', {
                message: `Analyse ce projet et donne 5 recommandations concrètes pour améliorer la qualité, sécurité et maintenabilité. Répertoire: ${path.basename(folder.uri.fsPath)}. Soit concis et actionnable.`,
                max_tokens: 400
            }, { timeout: 60000 });
            this.panel.webview.postMessage({ type: 'aiRecommendations', text: r.data.reply });
        } catch (e) {
            // TASK 4a: runtime up but no model loaded (503 no_model_loaded).
            const isNoModel = e.response && e.response.status === 503;
            this.panel.webview.postMessage({ type: 'aiError', text: isNoModel ? 'Aucun modele charge - ouvrez Runtime & Models pour charger un modele' : 'Runtime IA non disponible' });
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
/* ─── SUDO STUDIO DARK THEME ─────────────────────────────────── */
:root {
    --ss-bg: #0d1117; --ss-card-bg: #161b22; --ss-border: #21262d;
    --ss-btn-green: #2ea043; --ss-btn-blue: #1f6feb;
    --ss-text: #e6edf3; --ss-text-muted: #7d8590;
    --vscode-editor-background: #0d1117;
    --vscode-editor-foreground: #e6edf3;
    --vscode-sideBar-background: #161b22;
    --vscode-panel-border: #21262d;
    --vscode-editorWidget-background: #161b22;
    --vscode-button-background: #2ea043;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #21262d;
    --vscode-button-secondaryForeground: #e6edf3;
    --vscode-input-background: #0d1117;
    --vscode-input-foreground: #e6edf3;
    --vscode-input-border: #21262d;
    --vscode-focusBorder: #1f6feb;
    --vscode-descriptionForeground: #7d8590;
}
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
.arch-unver{color:#ff9800}
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
${guardSnippet()}
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
        <div id="progressWrap" style="display:none;max-width:420px;margin:12px auto 0">
            <div style="height:8px;background:var(--vscode-panel-border);border-radius:4px;overflow:hidden">
                <div id="progressFill" style="height:100%;width:0%;background:var(--vscode-button-background)"></div>
            </div>
            <div id="progressText" style="font-size:11px;margin-top:6px"></div>
            <button class="btn btn-sec btn-sm" style="margin-top:8px" onclick="cancelAnalysis()">Annuler</button>
        </div>
    </div>

    <div id="errorBox" style="display:none;margin:0 0 14px;padding:12px 14px;border-radius:6px;background:rgba(244,67,54,.1);border:1px solid rgba(244,67,54,.3);font-size:12px"></div>

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

        <!-- Stats (P9 deterministic, no AI) -->
        <div class="card">
            <div class="card-title">Statistiques (deterministe, sans IA)</div>
            <div id="statsGrid" style="font-size:12px"></div>
            <div class="card-title" style="margin-top:10px">Arborescence resumee</div>
            <div id="treeList" style="font-size:12px"></div>
            <div class="card-title" style="margin-top:10px">Plus gros fichiers</div>
            <div id="bigList" style="font-size:12px"></div>
            <div class="card-title" style="margin-top:10px">Points d entree</div>
            <div id="entryList" style="font-size:12px"></div>
            <div class="card-title" style="margin-top:10px">Tests</div>
            <div id="testInfo" style="font-size:12px"></div>
            <div class="card-title" style="margin-top:10px">CI / README / TODO</div>
            <div id="miscInfo" style="font-size:12px"></div>
        </div>

        <!-- Deps (P9 lockfiles) -->
        <div class="card">
            <div class="card-title">Dependances (verrouillage)</div>
            <div id="depsList" style="font-size:12px"></div>
        </div>

        <!-- Actions (P9) -->
        <div class="card">
            <div class="card-title">Actions</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-sm" onclick="exportJson()">Exporter JSON</button>
                <button class="btn btn-sm" onclick="aiSummary()">Resume IA</button>
                <button class="btn btn-sm" onclick="genAgents()">Generer AGENTS.md</button>
            </div>
            <div id="actionStatus" style="font-size:12px;margin-top:8px;color:var(--vscode-descriptionForeground)"></div>
            <div id="aiSummaryBox" style="display:none;background:var(--vscode-editorWidget-background);border-radius:8px;padding:12px;font-size:13px;line-height:1.6;margin-top:10px;white-space:pre-wrap"></div>
            <div id="agentsBox" style="display:none;margin-top:10px;font-size:12px"></div>
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

    <div id="noWorkspaceMsg" style="display:none;padding:40px 30px;text-align:center;color:var(--vscode-descriptionForeground)">
        <div style="font-size:48px;margin-bottom:14px">📁</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px">Aucun projet ouvert</div>
        <div style="font-size:13px;margin-top:4px;line-height:1.6">
            Ouvrez un dossier via <strong>File &gt; Open Folder</strong><br>
            pour analyser un projet.
        </div>
        <div id="timeoutNote" style="display:none;margin-top:14px;padding:10px 14px;border-radius:6px;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);font-size:12px;color:#f85149">
            ⏱ Timeout : l'analyse a pris trop de temps. Ouvrez un dossier et réessayez.
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function reanalyze() { vscode.postMessage({type:'reanalyze'}); }
function aiRec()     { vscode.postMessage({type:'aiRecommend'}); }
function exportJson() { vscode.postMessage({type:'exportJson'}); }
function aiSummary() { vscode.postMessage({type:'aiSummary'}); }
function genAgents() { vscode.postMessage({type:'genAgents'}); }
function confirmAgents() { vscode.postMessage({type:'confirmAgents'}); }
function cancelAgents() { document.getElementById('agentsBox').style.display='none'; }
function cancelAnalysis() { vscode.postMessage({type:'cancelAnalysis'}); }
function esc(s) {
    return String(s == null ? '' : s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
}
function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' Ko';
    return (n / 1048576).toFixed(1) + ' Mo';
}

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
        case 'analysisTimeout':
            document.getElementById('loadingOverlay').classList.remove('show');
            document.getElementById('noWorkspaceMsg').style.display='block';
            document.getElementById('timeoutNote').style.display='block';
            break;
        case 'analysisResult':
            renderResult(m.result);
            renderAnalysis(m.analysis);
            break;
        case 'progress': {
            const p = m.progress || {};
            document.getElementById('progressWrap').style.display='block';
            document.getElementById('progressFill').style.width = (10 + ((p.files || 0) % 80)) + '%';
            document.getElementById('progressText').textContent =
                (p.files || 0) + ' fichiers, ' + (p.dirs || 0) + ' dossiers' + (p.current ? ' — ' + p.current : '');
            break;
        }
        case 'analysisError':
            document.getElementById('loadingOverlay').classList.remove('show');
            document.getElementById('progressWrap').style.display='none';
            showError(m.text || 'Erreur inconnue');
            break;
        case 'analysisCancelled':
            document.getElementById('loadingOverlay').classList.remove('show');
            document.getElementById('progressWrap').style.display='none';
            showError(m.text || 'Analyse annulee', true);
            break;
        case 'exportDone':
            document.getElementById('actionStatus').textContent = 'Rapport exporte : ' + (m.path || '');
            break;
        case 'aiSummary':
            renderAiSummary(m);
            break;
        case 'agentsDiff':
            renderAgentsDiff(m.diff);
            break;
        case 'agentsWritten':
            document.getElementById('agentsBox').style.display='none';
            document.getElementById('actionStatus').textContent = m.unchanged
                ? 'AGENTS.md deja a jour (aucun changement).'
                : (m.created ? 'AGENTS.md cree.' : 'AGENTS.md mis a jour (ecrasement confirme).');
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
        document.getElementById('archGrid').innerHTML = archItems.map(function(it) {
        const n = it[0]; const v = it[1]; const icon = it[2];
        const st = (v && typeof v === 'object') ? v.state : (v ? 'ok' : 'missing');
        const ev = (v && typeof v === 'object' && v.evidence) ? v.evidence : '';
        const cls = st === 'ok' ? 'arch-ok' : (st === 'unverified' ? 'arch-unver' : 'arch-miss');
        const mark = st === 'ok' ? '&#10003;' : (st === 'unverified' ? '?' : '&#10007;');
        const sub = st === 'unverified' ? 'non verifie' + (ev ? ' (' + esc(ev) + ')' : '') : (ev ? esc(ev) : '');
        return '<div class="arch-item" style="flex-direction:column;align-items:flex-start"><span class="' + cls + '">' + icon + ' ' + mark + ' ' + n + '</span>' +
            (sub ? '<span style="font-size:10px;color:var(--vscode-descriptionForeground)">' + sub + '</span>' : '') + '</div>';
    }).join('');

    // Issues
    const issues = r.issues || [];
    document.getElementById('issueCount').textContent = issues.length + ' problème' + (issues.length!==1?'s':'');
    if (issues.length === 0) {
        document.getElementById('issuesList').innerHTML = '<div style="color:#4caf50;font-size:12px">✅ Aucun problème détecté!</div>';
    } else {
        document.getElementById('issuesList').innerHTML = issues.map(i => {
            const fixBtn = i.fix ? '<button class="btn btn-sm btn-sec" onclick="runFix(\\''+i.fix+'\\')" style="margin-left:auto;flex-shrink:0">🔧 AutoFix</button>' : '';
            const badge = i.level === 'error' ? '🔴 ERREUR' : i.level === 'warn' ? '🟡 AVERT.' : 'ℹ️ INFO';
            return '<div class="issue '+i.level+'"><span class="issue-badge">'+badge+'</span><span style="flex:1"><strong>['+i.area+']</strong> '+i.msg+'</span>'+fixBtn+'</div>';
        }).join('');
    }
}

function showError(t, info) {
    const box = document.getElementById('errorBox');
    box.style.display='block';
    box.style.background = info ? 'rgba(33,150,243,.1)' : 'rgba(244,67,54,.1)';
    box.style.border = '1px solid ' + (info ? 'rgba(33,150,243,.3)' : 'rgba(244,67,54,.3)');
    box.textContent = t;
}

function renderAnalysis(a) {
    document.getElementById('progressWrap').style.display='none';
    document.getElementById('errorBox').style.display='none';
    if (!a) return;
    const st = a.stats || {};
    const langs = Object.keys(st.byLang || {}).map(function(k) {
        return { lang: k, files: st.byLang[k].files, lines: st.byLang[k].lines };
    }).sort(function(x, y) { return y.lines - x.lines; });
    let h = '<div style="margin-bottom:6px"><strong>' + (st.files || 0) + ' fichiers</strong>, ' +
        '<strong>' + (st.lines || 0) + ' lignes</strong>, ' + (st.dirs || 0) + ' dossiers, ' +
        'duree ' + (a.durationMs || 0) + ' ms</div>';
    if (a.truncated) h += '<div>Analyse tronquee (plafond maxFiles atteint) — chiffres partiels.</div>';
    if (st.skippedLarge) h += '<div>' + st.skippedLarge + ' gros fichiers non lus (lignes non comptees).</div>';
    if (st.binary) h += '<div>' + st.binary + ' fichiers binaires (lignes non comptees).</div>';
    h += langs.map(function(l) {
        return '<div>' + esc(l.lang) + ' : ' + l.files + ' fichiers, ' + l.lines + ' lignes</div>';
    }).join('');
    document.getElementById('statsGrid').innerHTML = h;
    document.getElementById('treeList').innerHTML = (a.tree || []).map(function(t) {
        return '<div>' + esc(t.path) + ' : ' + t.files + ' fichiers</div>';
    }).join('') + (a.treeOverflow ? '<div>+' + a.treeOverflow + ' dossiers mineurs.</div>' : '');
    document.getElementById('bigList').innerHTML = (a.biggest || []).map(function(b) {
        return '<div>' + esc(b.path) + ' — ' + fmtBytes(b.bytes) +
            (b.lines == null ? ' (lignes non comptees)' : ', ' + b.lines + ' lignes') + '</div>';
    }).join('') || '<div>Aucun</div>';
    document.getElementById('entryList').innerHTML = ((a.entryPoints || []).map(function(e) {
        return '<div>[' + esc(e.type) + '] ' + esc(e.path) + '</div>';
    }).join('') || '<div>Non detecte</div>');
    const t = a.tests || {};
    document.getElementById('testInfo').innerHTML =
        '<div><strong>' + (t.count || 0) + '</strong> fichiers de test' +
        ((t.frameworks || []).length ? ' (' + t.frameworks.map(esc).join(', ') + ')' : '') + '</div>' +
        (t.dirs || []).map(function(d) {
            return '<div>' + esc(d.path) + ' : ' + d.count + '</div>';
        }).join('');
    const ci = (a.ci || []).map(function(c) {
        return '[' + esc(c.system) + '] ' + esc(c.path);
    }).join(', ') || 'aucune';
    const rd = a.readme || {};
    const td = a.todos || {};
    document.getElementById('miscInfo').innerHTML =
        '<div>CI : ' + ci + '</div>' +
        '<div>README : ' + (rd.present ? esc(rd.path) + ' (' + fmtBytes(rd.bytes) + ')' : 'absent') + '</div>' +
        '<div>TODO : ' + (td.todo || 0) + ' / FIXME : ' + (td.fixme || 0) + '</div>' +
        (td.sample || []).slice(0, 8).map(function(s) {
            return '<div>' + esc(s.kind) + ' ' + esc(s.path) + ':' + s.line + ' — ' + esc(s.text) + '</div>';
        }).join('');
    document.getElementById('depsList').innerHTML = ((a.deps || []).map(function(d) {
        let x = '<div style="margin-bottom:8px"><strong>' + esc(d.ecosystem) + '</strong> (' +
            esc(d.manifest) + ') : ' + (d.manifestDeps || []).length + ' declarees, ' +
            (d.locked || []).length + ' verrouillees';
        x += d.lockfile ? ' [' + esc(d.lockfile) + ']' : ' <strong>[SANS VERROUILLAGE]</strong>';
        x += '</div>';
        if ((d.locked || []).length) {
            x += '<div>' + d.locked.slice(0, 12).map(function(l) {
                return esc(l.name) + '@' + esc(l.version);
            }).join(', ') + (d.locked.length > 12 ? '…' : '') + '</div>';
        }
        if ((d.unlocked || []).length) {
            x += '<div>Non verrouillees : ' + d.unlocked.slice(0, 12).map(esc).join(', ') +
                (d.unlocked.length > 12 ? '…' : '') + '</div>';
        }
        if ((d.manifestDeps || []).length) {
            x += '<div style="margin:4px 0 8px;overflow-x:auto"><table style="border-collapse:collapse;font-size:11px">' +
                '<tr style="color:var(--vscode-descriptionForeground)"><td style="padding:2px 8px 2px 0"><u>nom</u></td><td style="padding:2px 8px"><u>declaree</u></td><td style="padding:2px 8px"><u>verrouillee</u></td><td style="padding:2px 8px"><u>type</u></td><td style="padding:2px 8px"><u>source</u></td></tr>' +
                d.manifestDeps.slice(0, 40).map(function(m) {
                    return '<tr><td style="padding:2px 8px 2px 0">' + esc(m.name) + '</td>' +
                        '<td style="padding:2px 8px">' + esc(m.range || m.detail || '-') + '</td>' +
                        '<td style="padding:2px 8px">' + esc(m.locked || '-') + '</td>' +
                        '<td style="padding:2px 8px">' + (m.dev ? 'dev' : 'prod') + '</td>' +
                        '<td style="padding:2px 8px">' + esc(m.source || d.manifest) + '</td></tr>';
                }).join('') + '</table>' +
                (d.manifestDeps.length > 40 ? '<div>+' + (d.manifestDeps.length - 40) + ' autres (voir export JSON).</div>' : '') + '</div>';
        }
        if (d.note) x += '<div>' + esc(d.note) + '</div>';
        return x;
    }).join('') || '<div>Aucun manifeste trouve (package.json, pubspec.yaml, requirements.txt, pyproject.toml, pom.xml, build.gradle, go.mod, *.csproj) : aucune dependance declaree.</div>');
}

function renderAiSummary(m) {
    const box = document.getElementById('aiSummaryBox');
    box.style.display='block';
    if (m.loading) { box.textContent = 'Resume IA en cours...'; return; }
    if (m.error) { box.textContent = m.error; return; }
    box.innerHTML = '';
    const lab = document.createElement('div');
    lab.style.fontSize = '11px';
    lab.style.color = 'var(--vscode-descriptionForeground)';
    lab.style.marginBottom = '6px';
    lab.textContent = 'Resume IA — genere par IA (faits ci-dessus uniquement, ne remplace pas les faits)';
    const txt = document.createElement('div');
    txt.textContent = m.text || '(vide)';
    box.appendChild(lab);
    box.appendChild(txt);
}

function renderAgentsDiff(d) {
    const box = document.getElementById('agentsBox');
    box.style.display='block';
    if (!d) { box.textContent = 'Aucun diff.'; return; }
    let h = '<div style="margin-bottom:6px"><strong>AGENTS.md existe deja</strong> (' +
        d.oldLines + ' lignes → ' + d.newLines + ' lignes). Confirmer l ecrasement ?</div>';
    h += '<div style="margin-bottom:4px">Ancien (supprime) :</div>';
    h += '<pre style="background:rgba(244,67,54,.1);padding:8px;border-radius:6px;white-space:pre-wrap">' +
        esc(d.oldMiddle.join('\\n')) + '</pre>';
    h += '<div style="margin:4px 0">Nouveau (ajoute) :</div>';
    h += '<pre style="background:rgba(46,160,67,.12);padding:8px;border-radius:6px;white-space:pre-wrap">' +
        esc(d.newMiddle.join('\\n')) + '</pre>';
    if (d.truncated) h += '<div>Diff tronque (200 lignes max par cote).</div>';
    h += '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button class="btn btn-sm" onclick="confirmAgents()">Confirmer l ecrasement</button>' +
        '<button class="btn btn-sec btn-sm" onclick="cancelAgents()">Annuler</button></div>';
    box.innerHTML = h;
}

function runFix(fix) { vscode.postMessage({type:'autoFix',issue:fix}); }
</script>
</body>
</html>`;
    }
}

module.exports = { ProjectAnalysisPanel };
