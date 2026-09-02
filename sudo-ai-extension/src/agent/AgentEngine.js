/**
 * SUDO STUDIO — AgentEngine v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous programming agent built ON TOP of the existing Sudo AI architecture.
 * Does NOT replace Chat mode, terminal, filesystem, or runtime.
 *
 * Architecture:
 *   AgentEngine
 *     ├── AgentState          (task lifecycle, iteration counter, history)
 *     ├── FileTool            (read / write / list / search — wraps Node.js fs)
 *     ├── TerminalTool        (exec commands — wraps child_process.exec)
 *     ├── GitTool             (status / diff / log — wraps TerminalTool)
 *     ├── AIProvider          (abstraction over runtime:6000 and backend:5000)
 *     └── AgentLoop           (plan → inspect → edit → run → observe → repeat)
 *
 * Permissions:
 *   READ_FILE, WRITE_FILE, RUN_COMMAND, GIT_READ are auto-approved.
 *   GIT_WRITE (commit/push), DANGEROUS_COMMAND require user confirm.
 *
 * Emits events (EventEmitter) to the WebView via AgentPanel:
 *   'step'        { phase, message, data }
 *   'tool_call'   { tool, args, result }
 *   'progress'    { step, total, pct }
 *   'approval_needed' { action, description, resolve }
 *   'done'        { status, summary, filesModified, commandsRun, testResults }
 *   'error'       { message, phase }
 */

'use strict';

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const { exec }     = require('child_process');
const axios        = require('axios');

// ─── AGENT SYSTEM PROMPT ──────────────────────────────────────────────────────
// Injected by AIProvider.query() / plan() / diagnose() to constrain the model
// to produce structured, actionable responses suitable for autonomous execution.
const AGENT_SYSTEM_PROMPT = `Tu es Sudo Agent, un agent de programmation autonome et précis.

Pour toute tâche reçue :
1. Analyse la demande précisément — comprends ce qui est demandé avant d'agir.
2. Produis un plan numéroté clair (maximum 10 étapes).
3. Pour chaque étape, produis une action concrète :
   - LIRE un fichier : "Read <chemin/fichier>"
   - ÉCRIRE un fichier : "Write <chemin/fichier>" suivi du code complet
   - EXÉCUTER une commande : "Run <commande>"
   - TESTER : "Test <framework>" 
4. Le code produit doit être COMPLET et FONCTIONNEL dans le bon langage demandé.
5. Ne jamais donner de réponse vague — toujours du code ou des actions concrètes.
6. Si le langage cible est Dart, réponds en Dart. Si Python, en Python. Jamais un autre langage.
7. Les blocs de code commencent par un commentaire // file: nom.ext ou # file: nom.ext.

FORMAT DE RÉPONSE POUR LES PLANS :
1. <action concrète>
2. <action concrète>
...

Réponds directement sans introduction. Sois technique et précis.`;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_ITERATIONS  = 10;
const CMD_TIMEOUT_MS  = 60000;  // 60s per command
const AI_TIMEOUT_MS   = 120000; // 120s for AI calls
const AGENT_STATE_DIR = '.sudo/agent';

// Dangerous command patterns — require user approval
const DANGEROUS_PATTERNS = [
    /git\s+reset\s+--hard/i,
    /git\s+clean\s+-f/i,
    /git\s+push\s+--force/i,
    /rm\s+-rf/i,
    /del\s+\/f\s+\/s/i,
    /format\s+[a-z]:/i,
    /DROP\s+TABLE/i,
    /kubectl\s+delete\s+namespace/i,
];

// Safe read-only git commands (auto-approved)
const GIT_READ_CMDS = [
    /^git\s+status/,
    /^git\s+diff/,
    /^git\s+log/,
    /^git\s+show/,
    /^git\s+branch/,
];

// ─── AGENT STATE ──────────────────────────────────────────────────────────────
class AgentState {
    constructor(task, projectRoot) {
        this.task              = task;
        this.projectRoot       = projectRoot;
        this.currentPlan       = [];
        this.currentStep       = 0;
        this.filesRead         = [];
        this.filesModified     = [];
        this.commandsExecuted  = [];
        this.testResults       = [];
        this.errors            = [];
        this.iteration         = 0;
        this.finalStatus       = 'running';  // 'running'|'success'|'failed'|'stopped'|'awaiting_approval'
        this.startedAt         = Date.now();
        this.stoppedByUser     = false;
        this.logs              = [];
    }

    log(msg) {
        const ts = new Date().toISOString().slice(11, 23);
        const entry = `[${ts}] ${msg}`;
        this.logs.push(entry);
        console.log('[AGENT]', entry);
    }

    toSummary() {
        return {
            task:            this.task,
            status:          this.finalStatus,
            iteration:       this.iteration,
            filesModified:   this.filesModified,
            commandsRun:     this.commandsExecuted.map(c => c.cmd),
            testResults:     this.testResults,
            errors:          this.errors,
            durationMs:      Date.now() - this.startedAt,
            logs:            this.logs.slice(-30),
        };
    }

    persist(projectRoot) {
        try {
            const dir = path.join(projectRoot, AGENT_STATE_DIR, 'sessions');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `session_${this.startedAt}.json`);
            fs.writeFileSync(file, JSON.stringify(this.toSummary(), null, 2), 'utf8');
        } catch (_) { /* non-fatal */ }
    }
}

// ─── FILE TOOL ────────────────────────────────────────────────────────────────
class FileTool {
    constructor(projectRoot) {
        this.root = projectRoot;
    }

    _resolve(filePath) {
        if (path.isAbsolute(filePath)) return filePath;
        return path.join(this.root, filePath);
    }

    readFile(filePath) {
        const abs = this._resolve(filePath);
        if (!fs.existsSync(abs)) return { ok: false, error: `File not found: ${filePath}` };
        try {
            const content = fs.readFileSync(abs, 'utf8');
            return { ok: true, content, lines: content.split('\n').length, bytes: content.length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    writeFile(filePath, content) {
        const abs = this._resolve(filePath);
        try {
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            // Backup original
            if (fs.existsSync(abs)) {
                fs.writeFileSync(abs + '.sudo_bak', fs.readFileSync(abs), 'utf8');
            }
            fs.writeFileSync(abs, content, 'utf8');
            return { ok: true, path: filePath };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    listDir(dirPath, options = {}) {
        const abs = this._resolve(dirPath || '.');
        const { maxDepth = 2, excludes = ['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'coverage'] } = options;

        const walk = (dir, depth) => {
            if (depth > maxDepth) return [];
            let entries = [];
            try {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    if (excludes.includes(item.name)) continue;
                    entries.push({ name: item.name, type: item.isDirectory() ? 'dir' : 'file', depth });
                    if (item.isDirectory()) {
                        entries = entries.concat(walk(path.join(dir, item.name), depth + 1));
                    }
                }
            } catch (_) {}
            return entries;
        };
        return { ok: true, entries: walk(abs, 0) };
    }

    searchText(pattern, dirPath, extensions = ['.js', '.ts', '.py', '.json', '.md']) {
        const abs = this._resolve(dirPath || '.');
        const results = [];
        const re = typeof pattern === 'string' ? new RegExp(pattern, 'gi') : pattern;

        const walk = (dir) => {
            try {
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (['node_modules', '.git', '__pycache__', 'dist', 'build'].includes(item.name)) continue;
                    const full = path.join(dir, item.name);
                    if (item.isDirectory()) { walk(full); }
                    else if (extensions.some(ext => item.name.endsWith(ext))) {
                        try {
                            const lines = fs.readFileSync(full, 'utf8').split('\n');
                            lines.forEach((line, i) => {
                                if (re.test(line)) {
                                    results.push({ file: path.relative(this.root, full), line: i + 1, text: line.trim().slice(0, 200) });
                                }
                            });
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        };
        walk(abs);
        return { ok: true, matches: results.slice(0, 50) };
    }

    applyPatch(filePath, patches) {
        // patches: [{oldText, newText}]
        const result = this.readFile(filePath);
        if (!result.ok) return result;
        let content = result.content;
        const applied = [];
        for (const p of patches) {
            if (content.includes(p.oldText)) {
                content = content.replace(p.oldText, p.newText);
                applied.push(p.oldText.slice(0, 40));
            } else {
                return { ok: false, error: `Patch not found: "${p.oldText.slice(0, 60)}"` };
            }
        }
        return { ...this.writeFile(filePath, content), patchesApplied: applied.length };
    }
}

// ─── TERMINAL TOOL ────────────────────────────────────────────────────────────
class TerminalTool {
    constructor(projectRoot) {
        this.root = projectRoot;
    }

    run(cmd, options = {}) {
        return new Promise((resolve) => {
            const cwd     = options.cwd || this.root;
            const timeout = options.timeout || CMD_TIMEOUT_MS;
            const started = Date.now();

            exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
                const duration = Date.now() - started;
                const exitCode = err ? (err.code || 1) : 0;

                // Truncate large outputs intelligently
                const truncate = (s, max = 8000) => {
                    if (!s || s.length <= max) return s || '';
                    return s.slice(0, max / 2) + '\n...[truncated]...\n' + s.slice(-max / 2);
                };

                resolve({
                    ok:       exitCode === 0,
                    cmd,
                    exitCode,
                    stdout:   truncate(stdout),
                    stderr:   truncate(stderr),
                    duration,
                    timedOut: err && err.killed,
                });
            });
        });
    }
}

// ─── GIT TOOL ─────────────────────────────────────────────────────────────────
class GitTool {
    constructor(terminal) {
        this.term = terminal;
    }

    async status()        { return this.term.run('git status --porcelain'); }
    async diff(file)      { return this.term.run(file ? `git diff -- "${file}"` : 'git diff'); }
    async log(n = 10)     { return this.term.run(`git log --oneline -${n}`); }
    async addAll()        { return this.term.run('git add -A'); }
    async commit(msg)     { return this.term.run(`git commit -m "${msg.replace(/"/g, '\\"')}"`); }

    async changedFiles() {
        const r = await this.status();
        if (!r.ok && !r.stdout) return [];
        return r.stdout.trim().split('\n')
            .filter(l => l.trim())
            .map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3).trim() }));
    }
}

// ─── AI PROVIDER ──────────────────────────────────────────────────────────────
class AIProvider {
    constructor(options = {}) {
        this.runtimeUrl = options.runtimeUrl || 'http://localhost:6000';
        this.backendUrl = options.backendUrl  || 'http://localhost:5000';
        this.authToken  = options.authToken   || null;
    }

    async query(prompt, systemContext = '', options = {}) {
        const max_tokens  = options.max_tokens  || 1024;
        const temperature = options.temperature || 0.3;
        // Prepend agent system prompt + optional context
        const fullPrompt = AGENT_SYSTEM_PROMPT +
            (systemContext ? '\n\nCONTEXT:\n' + systemContext : '') +
            '\n\nUser: ' + prompt.trim() + '\nAssistant:';
        const payload = { message: fullPrompt, prompt: fullPrompt, input: fullPrompt, max_tokens, temperature };

        // Try runtime first (local, no auth)
        try {
            const r = await axios.post(`${this.runtimeUrl}/infer`, payload, { timeout: AI_TIMEOUT_MS });
            return { ok: true, reply: r.data.reply || r.data.response || '', model: r.data.model, mock: r.data.mock };
        } catch (e1) {
            if (e1.code === 'ECONNREFUSED') {
                // Runtime offline — return a structured fallback
                return { ok: false, error: 'Runtime offline', reply: null };
            }
            return { ok: false, error: e1.message, reply: null };
        }
    }

    async plan(task, context) {
        const prompt = `You are an autonomous programming agent.

TASK: ${task}

PROJECT CONTEXT:
${context}

Produce a numbered step-by-step plan (max 10 steps) to complete this task.
Each step must be a concrete action: read file, run command, edit file, run tests, etc.
Be specific. Output only the plan, one step per line, numbered.
Example:
1. Read backend/server.js to understand startup code
2. Run npm test to see current test failures
3. Edit backend/server.js to fix the port conflict
4. Run npm test again to verify fix`;

        return this.query(prompt, '', { max_tokens: 512, temperature: 0.2 });
    }

    async diagnose(error, context) {
        const prompt = `You are a debugging expert.

ERROR:
${error}

CONTEXT:
${context}

Diagnose the root cause in 2-3 sentences. Then give the exact fix as a code patch.
Format:
ROOT CAUSE: <brief explanation>
FIX: <exact change to make>
FILE: <which file to edit>`;

        return this.query(prompt, '', { max_tokens: 512, temperature: 0.1 });
    }
}

// ─── AGENT ENGINE ─────────────────────────────────────────────────────────────
class AgentEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || (
            require('vscode').workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()
        );
        this.fileTool    = new FileTool(this.projectRoot);
        this.termTool    = new TerminalTool(this.projectRoot);
        this.gitTool     = new GitTool(this.termTool);
        this.aiProvider  = new AIProvider(options.ai || {});
        this.state       = null;
        this._stopped    = false;
        this._approvalQueue = [];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Run a full agent task from start to finish */
    async run(task) {
        this._stopped = false;
        this.state = new AgentState(task, this.projectRoot);
        console.log('[AGENT] Task received:', task);
        console.log('[AGENT] projectRoot:', this.projectRoot);
        this.state.log(`Agent started — task: ${task}`);
        this._emit('step', { phase: 'start', message: `🚀 Agent démarré — tâche: ${task}` });

        try {
            // PHASE 1: Gather project context
            await this._phase_analyze();
            if (this._stopped) return this._finish('stopped');

            // PHASE 2: Build plan
            await this._phase_plan();
            if (this._stopped) return this._finish('stopped');

            // PHASE 3: Execute plan (with retry loop)
            await this._phase_execute();

        } catch (e) {
            this.state.log(`FATAL: ${e.message}`);
            this._emit('error', { message: e.message, phase: 'execute' });
            return this._finish('failed');
        }

        return this._finish(this.state.finalStatus === 'running' ? 'success' : this.state.finalStatus);
    }

    /** Stop the agent gracefully */
    stop() {
        this._stopped = true;
        if (this.state) {
            this.state.log('Stopped by user');
            this.state.stoppedByUser = true;
        }
        this._emit('step', { phase: 'stop', message: '⏹ Agent arrêté par l\'utilisateur.' });
    }

    /** Approve or reject a pending action */
    resolveApproval(approved) {
        if (this._approvalQueue.length) {
            const resolver = this._approvalQueue.shift();
            resolver(approved);
        }
    }

    // ── Phases ────────────────────────────────────────────────────────────────

    async _phase_analyze() {
        console.log('[AGENT] Starting ANALYZE phase');
        this._emit('step', { phase: 'analyze', message: '🔍 Analyse du projet...' });
        this.state.log('Phase: analyze');

        const structure = this.fileTool.listDir('.', { maxDepth: 2 });
        const dirs = structure.entries
            .filter(e => e.type === 'dir' && e.depth === 0)
            .map(e => e.name).join(', ');
        const files = structure.entries
            .filter(e => e.type === 'file' && e.depth === 0)
            .map(e => e.name).join(', ');

        // Read key files for context
        const contextFiles = ['package.json', 'README.md', 'requirements.txt', 'pyproject.toml'];
        const contextSnippets = [];
        for (const f of contextFiles) {
            const r = this.fileTool.readFile(f);
            if (r.ok) contextSnippets.push(`--- ${f} (${r.lines} lines) ---\n${r.content.slice(0, 800)}`);
        }

        // Check git status
        const gitSt = await this.gitTool.status();

        this.state._projectContext = [
            `ROOT: ${this.projectRoot}`,
            `DIRS: ${dirs}`,
            `ROOT FILES: ${files}`,
            gitSt.stdout ? `GIT STATUS:\n${gitSt.stdout.slice(0, 400)}` : '',
            ...contextSnippets,
        ].filter(Boolean).join('\n\n');

        this._emit('step', {
            phase: 'analyze',
            message: `📁 Projet analysé — ${structure.entries.length} entrées, git: ${gitSt.ok ? 'OK' : 'N/A'}`,
            data: { dirs, rootFiles: files }
        });
    }

    async _phase_plan() {
        console.log('[AGENT] Starting PLAN phase');
        this._emit('step', { phase: 'plan', message: '📋 Construction du plan...' });
        this.state.log('Phase: plan');

        const aiResult = await this.aiProvider.plan(this.state.task, this.state._projectContext);

        let plan = [];
        if (aiResult.ok && aiResult.reply) {
            // Parse numbered list
            plan = aiResult.reply.split('\n')
                .filter(l => /^\d+\./.test(l.trim()))
                .map((l, i) => ({ step: i + 1, description: l.replace(/^\d+\.\s*/, '').trim(), status: 'pending' }));
        }

        // Fallback plan if AI unavailable
        if (!plan.length) {
            plan = [
                { step: 1, description: 'Analyser les fichiers principaux du projet', status: 'pending' },
                { step: 2, description: 'Identifier la cause du problème', status: 'pending' },
                { step: 3, description: 'Appliquer les corrections', status: 'pending' },
                { step: 4, description: 'Lancer les tests de vérification', status: 'pending' },
            ];
        }

        this.state.currentPlan = plan;
        this.state.log(`Plan: ${plan.length} steps`);

        this._emit('step', {
            phase: 'plan',
            message: `📋 Plan: ${plan.length} étapes`,
            data: { plan }
        });
    }

    async _phase_execute() {
        console.log('[AGENT] Starting EXECUTE phase');
        this.state.log('Phase: execute');
        let iteration = 0;

        while (iteration < MAX_ITERATIONS && !this._stopped) {
            iteration++;
            this.state.iteration = iteration;
            this.state.log(`Iteration ${iteration}/${MAX_ITERATIONS}`);

            this._emit('step', {
                phase: 'iterate',
                message: `🔄 Itération ${iteration}/${MAX_ITERATIONS}`,
                data: { iteration, max: MAX_ITERATIONS }
            });

            // Execute remaining plan steps
            for (const step of this.state.currentPlan) {
                if (this._stopped) return;
                if (step.status === 'done') continue;

                step.status = 'running';
                this.state.currentStep = step.step;
                this._emit('step', {
                    phase: 'step',
                    message: `▶ Étape ${step.step}: ${step.description}`,
                    data: { step }
                });
                this.state.log(`Step ${step.step}: ${step.description}`);

                await this._executeStep(step);
                step.status = 'done';

                this._emit('progress', {
                    step: this.state.currentPlan.filter(s => s.status === 'done').length,
                    total: this.state.currentPlan.length,
                    pct: Math.round(100 * this.state.currentPlan.filter(s => s.status === 'done').length / this.state.currentPlan.length)
                });
            }

            // Verify result after executing plan
            const verified = await this._verify();
            if (verified) {
                this.state.finalStatus = 'success';
                return;
            }

            // Not verified — diagnose and repair
            if (iteration < MAX_ITERATIONS) {
                await this._diagnoseAndRepair();
            }
        }

        if (iteration >= MAX_ITERATIONS) {
            this.state.log(`Max iterations (${MAX_ITERATIONS}) reached`);
            this.state.errors.push(`Max iterations reached without success`);
            this.state.finalStatus = 'failed';
        }
    }

    async _executeStep(step) {
        const desc = step.description.toLowerCase();

        // Detect step type and execute appropriate tool
        if (/^(read|lire|inspect|check|regarde|look at)\s/i.test(desc)) {
            // FILE READ
            const fileMatch = desc.match(/[a-z0-9_./-]+\.[a-z]{1,5}/i);
            if (fileMatch) {
                await this._toolReadFile(fileMatch[0]);
            }
        } else if (/^(run|lancer|execute|exécute|npm|pip|python|node|flutter|yarn|cargo|make)\s/i.test(desc)) {
            // COMMAND
            const cmd = step.description.replace(/^(run|lancer|execute|exécute)\s+/i, '').trim();
            await this._toolRunCommand(cmd);
        } else if (/^(edit|modifier|fix|corriger|write|create|créer|update)\s/i.test(desc)) {
            // FILE EDIT — ask AI what to write
            await this._toolAIEdit(step.description);
        } else if (/^(git|commit)\s/i.test(desc)) {
            // GIT
            await this._toolGit(step.description);
        } else if (/^(test|vérif|verify|check)\s/i.test(desc)) {
            // TEST
            await this._toolRunTest(step.description);
        } else {
            // Generic — try as command if it looks executable, else AI
            if (/\b(npm|pip|python|node|git|yarn|cargo)\b/i.test(desc)) {
                await this._toolRunCommand(step.description);
            } else {
                this.state.log(`Step type unclear, skipping: ${step.description}`);
            }
        }
    }

    // ── Tools ─────────────────────────────────────────────────────────────────

    async _toolReadFile(filePath) {
        this.state.log(`READ: ${filePath}`);
        const result = this.fileTool.readFile(filePath);
        this.state.filesRead.push(filePath);
        this._emit('tool_call', {
            tool: 'read_file',
            args: { file: filePath },
            result: result.ok ? `${result.lines} lines read` : result.error
        });
        if (result.ok) {
            // Store snippet in context for AI
            this.state._projectContext += `\n\n--- ${filePath} (${result.lines} lines) ---\n${result.content.slice(0, 2000)}`;
        }
        return result;
    }

    async _toolWriteFile(filePath, content, reason = '') {
        this.state.log(`WRITE: ${filePath} — ${reason}`);
        const result = this.fileTool.writeFile(filePath, content);
        if (result.ok) {
            if (!this.state.filesModified.includes(filePath)) {
                this.state.filesModified.push(filePath);
            }
        }
        this._emit('tool_call', {
            tool: 'write_file',
            args: { file: filePath, reason },
            result: result.ok ? 'Written successfully' : result.error
        });
        return result;
    }

    async _toolRunCommand(cmd, options = {}) {
        // Safety check — dangerous commands require approval
        const isDangerous = DANGEROUS_PATTERNS.some(re => re.test(cmd));
        if (isDangerous) {
            const approved = await this._requestApproval('DANGEROUS_COMMAND', `Run: ${cmd}`);
            if (!approved) {
                this.state.log(`REJECTED dangerous command: ${cmd}`);
                return { ok: false, error: 'Rejected by user' };
            }
        }

        this.state.log(`CMD: ${cmd}`);
        this._emit('tool_call', { tool: 'run_command', args: { cmd }, result: '...' });

        const result = await this.termTool.run(cmd, options);
        this.state.commandsExecuted.push({ cmd, exitCode: result.exitCode, ok: result.ok });

        this._emit('tool_call', {
            tool: 'run_command',
            args: { cmd },
            result: result.ok ? `Exit 0\n${result.stdout.slice(0, 400)}` : `Exit ${result.exitCode}\n${(result.stderr || result.stdout).slice(0, 400)}`
        });

        if (!result.ok) {
            this.state.errors.push({ cmd, stderr: (result.stderr || '').slice(0, 500), exitCode: result.exitCode });
        }

        return result;
    }

    async _toolRunTest(description) {
        // Detect test framework and run
        const hasPackageJson = this.fileTool.readFile('package.json');
        let cmd = 'npm test';

        if (hasPackageJson.ok) {
            const pkg = JSON.parse(hasPackageJson.content);
            if (pkg.scripts?.test) cmd = 'npm test';
            if (pkg.scripts?.['test:unit']) cmd = 'npm run test:unit';
        } else if (this.fileTool.readFile('requirements.txt').ok) {
            cmd = 'python -m pytest --tb=short 2>&1 || python -m unittest discover 2>&1';
        }

        const result = await this._toolRunCommand(cmd);
        this.state.testResults.push({ cmd, ok: result.ok, output: (result.stdout + result.stderr).slice(0, 1000) });
        return result;
    }

    async _toolAIEdit(instruction) {
        this.state.log(`AI EDIT: ${instruction}`);
        // Ask AI to identify file and generate fix
        const prompt = `INSTRUCTION: ${instruction}

PROJECT CONTEXT:
${this.state._projectContext.slice(0, 3000)}

Respond in this exact format:
FILE: <relative path>
PATCH_OLD: <exact string to find in file>
PATCH_NEW: <replacement string>
EXPLANATION: <one sentence>

If no specific edit is needed, respond with: NO_EDIT_NEEDED`;

        const ai = await this.aiProvider.query(prompt, '', { max_tokens: 800, temperature: 0.1 });

        if (!ai.ok || !ai.reply || ai.reply.includes('NO_EDIT_NEEDED')) {
            this.state.log('AI edit: no change needed');
            return;
        }

        // Parse AI response
        const fileMatch   = ai.reply.match(/^FILE:\s*(.+)$/m);
        const oldMatch    = ai.reply.match(/^PATCH_OLD:\s*([\s\S]+?)^PATCH_NEW:/m);
        const newMatch    = ai.reply.match(/^PATCH_NEW:\s*([\s\S]+?)^EXPLANATION:/m);

        if (fileMatch && oldMatch && newMatch) {
            const file   = fileMatch[1].trim();
            const oldTxt = oldMatch[1].trim();
            const newTxt = newMatch[1].trim();
            const patch  = this.fileTool.applyPatch(file, [{ oldText: oldTxt, newText: newTxt }]);
            if (patch.ok) {
                if (!this.state.filesModified.includes(file)) this.state.filesModified.push(file);
                this._emit('tool_call', { tool: 'ai_edit', args: { file, instruction }, result: `Patch applied to ${file}` });
            } else {
                this.state.log(`AI edit patch failed: ${patch.error}`);
            }
        }
    }

    async _toolGit(instruction) {
        const isWrite = /commit|push|merge|rebase/i.test(instruction);
        if (isWrite) {
            const approved = await this._requestApproval('GIT_WRITE', instruction);
            if (!approved) return;
        }

        if (/status/i.test(instruction))      { return this._toolRunCommand('git status'); }
        if (/diff/i.test(instruction))         { return this._toolRunCommand('git diff'); }
        if (/log/i.test(instruction))          { return this._toolRunCommand('git log --oneline -10'); }
        if (/commit/i.test(instruction)) {
            const msg = instruction.replace(/.*commit\s*/i, '').trim() || 'fix: agent auto-fix';
            await this._toolRunCommand('git add -A');
            return this._toolRunCommand(`git commit -m "${msg}"`);
        }
    }

    // ── Verify ────────────────────────────────────────────────────────────────

    async _verify() {
        console.log('[AGENT] Starting VERIFY phase');
        this._emit('step', { phase: 'verify', message: '✅ Vérification du résultat...' });
        this.state.log('Phase: verify');

        // Run tests if available
        const pkg = this.fileTool.readFile('package.json');
        if (pkg.ok) {
            try {
                const p = JSON.parse(pkg.content);
                if (p.scripts?.test) {
                    const r = await this._toolRunCommand('npm test -- --passWithNoTests 2>&1 || npm test 2>&1', { timeout: 30000 });
                    if (r.ok) {
                        this._emit('step', { phase: 'verify', message: '✅ Tests passent' });
                        return true;
                    }
                    this.state.log('Tests failed in verify');
                    return false;
                }
            } catch (_) {}
        }

        // No tests — check runtime health if applicable
        try {
            const h = await axios.get('http://localhost:6000/health', { timeout: 3000 });
            if (h.data?.status === 'healthy') {
                this._emit('step', { phase: 'verify', message: '✅ Runtime healthy' });
                return true;
            }
        } catch (_) {}

        // No test framework found — assume success if no errors
        if (this.state.errors.length === 0) {
            this._emit('step', { phase: 'verify', message: '✅ Aucune erreur détectée' });
            return true;
        }

        return false;
    }

    // ── Diagnose & Repair ─────────────────────────────────────────────────────

    async _diagnoseAndRepair() {
        this._emit('step', { phase: 'diagnose', message: '🔬 Diagnostic des erreurs...' });
        this.state.log('Phase: diagnose');

        const lastErrors = this.state.errors.slice(-3);
        if (!lastErrors.length) return;

        const errorContext = lastErrors.map(e =>
            `CMD: ${e.cmd}\nEXIT: ${e.exitCode}\nSTDERR: ${e.stderr}`
        ).join('\n\n---\n\n');

        const diagnosis = await this.aiProvider.diagnose(errorContext, this.state._projectContext.slice(0, 2000));

        if (diagnosis.ok && diagnosis.reply) {
            this.state.log(`Diagnosis: ${diagnosis.reply.slice(0, 200)}`);
            this._emit('step', {
                phase: 'diagnose',
                message: '🩺 ' + diagnosis.reply.slice(0, 150),
                data: { diagnosis: diagnosis.reply }
            });

            // Generate repair step and prepend to plan
            this.state.currentPlan.unshift({
                step: 0,
                description: 'Fix identified issue: ' + diagnosis.reply.slice(0, 100),
                status: 'pending'
            });
        }
    }

    // ── Approval system ───────────────────────────────────────────────────────

    _requestApproval(type, description) {
        return new Promise((resolve) => {
            this._approvalQueue.push(resolve);
            this.state.finalStatus = 'awaiting_approval';
            this._emit('approval_needed', { action: type, description, resolve });
        });
    }

    // ── Finish ────────────────────────────────────────────────────────────────

    _finish(status) {
        this.state.finalStatus = status;
        this.state.persist(this.projectRoot);
        const summary = this.state.toSummary();

        const statusEmoji = { success: '✅', failed: '❌', stopped: '⏹', awaiting_approval: '⏸' };
        this._emit('done', {
            status,
            emoji: statusEmoji[status] || '❓',
            summary,
            filesModified:  this.state.filesModified,
            commandsRun:    this.state.commandsExecuted.map(c => c.cmd),
            testResults:    this.state.testResults,
        });

        this.state.log(`Agent finished — status: ${status}`);
        return summary;
    }

    _emit(event, data) {
        this.emit(event, data);
    }
}

module.exports = { AgentEngine, AgentState, FileTool, TerminalTool, GitTool, AIProvider };
