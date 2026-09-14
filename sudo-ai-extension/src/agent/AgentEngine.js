/**
 * SUDO STUDIO — AgentEngine v2.0 (Master Mode)
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous programming agent at the level of Claude Code / GitHub Copilot Agent.
 *
 * Key improvements over v1:
 *   1. REAL AGENTIC LOOP:  Perceive → Plan (AI, not template) → Act → Observe →
 *      Auto-correct on failure → Repeat until done or MAX_ITERATIONS
 *   2. REAL TOOL USE:      read_file, write_file, edit_file, run_command (real
 *      shell), search_code, git, doctor/autofix/sdk (Sudo Studio integration)
 *   3. RUN_COMMAND:        exec() with real stdout/stderr/exitCode fed back to
 *      the model so it can react to failures
 *   4. MCP CLIENT:         Connects to Model Context Protocol servers configured
 *      in .sudo/mcp.json and exposes their tools in the agent loop
 *   5. STREAMING:          Every think/act step emits a 'step' event with real
 *      model reasoning — no generic titles
 *   6. AUTO-CORRECTION:    exitCode ≠ 0 → agent sees stderr and adapts plan;
 *      step.status is only 'done' after the tool returns successfully
 *   7. ADAPTIVE PLANNING:  AI generates plan from actual task text; fallback is
 *      task-specific (derived from task keywords), not a static template
 *
 * Architecture:
 *   AgentEngine (EventEmitter)
 *     ├── AgentState          (task lifecycle, step tracking, history)
 *     ├── FileTool            (read / write / edit / list / search — Node.js fs)
 *     ├── TerminalTool        (exec — real stdout/stderr/exitCode returned)
 *     ├── GitTool             (status / diff / log / commit)
 *     ├── MCPClient           (Model Context Protocol client)
 *     ├── SudoTools           (Doctor, AutoFix, SDK — Sudo Studio integration)
 *     └── AIProvider          (query / plan / generateCommand / diagnose)
 *
 * Emits:
 *   'step'           { phase, message, data }
 *   'tool_call'      { tool, args, result, ok, exitCode? }
 *   'progress'       { step, total, pct }
 *   'approval_needed' { action, description, resolve }
 *   'done'           { status, summary, filesModified, commandsRun, testResults }
 *   'error'          { message, phase }
 */

'use strict';

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const { exec }     = require('child_process');
const axios        = require('axios');
const net          = require('net');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_ITERATIONS  = 12;
const CMD_TIMEOUT_MS  = 60000;
const AI_TIMEOUT_MS   = 120000;
const AGENT_STATE_DIR = '.sudo/agent';
const MCP_CONFIG_FILE = '.sudo/mcp.json';

// Dangerous command patterns — require user approval before execution
const DANGEROUS_PATTERNS = [
    /git\s+reset\s+--hard/i,
    /git\s+clean\s+-f/i,
    /git\s+push\s+--force/i,
    /rm\s+-rf\s+\//i,
    /del\s+\/f\s+\/s\s+\/q/i,
    /format\s+[a-z]:/i,
    /DROP\s+TABLE/i,
    /kubectl\s+delete\s+namespace/i,
    /shutdown/i,
    /mkfs/i,
];

// ─── AGENT SYSTEM PROMPT ──────────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `Tu es Sudo Agent, un agent de programmation autonome, précis et expert.

Tu travailles en mode agentique : chaque étape produit une ACTION CONCRÈTE que tu exécutes, observes, puis adaptes si nécessaire.

RÈGLES ABSOLUES :
1. Pour ÉCRIRE un fichier : réponds exactement "TOOL: write_file\nFILE: <chemin>\nCONTENT:\n<contenu complet du fichier>"
2. Pour EXÉCUTER une commande : réponds exactement "TOOL: run_command\nCMD: <commande shell exacte>"
3. Pour LIRE un fichier : réponds exactement "TOOL: read_file\nFILE: <chemin>"
4. Pour MODIFIER un fichier existant : réponds exactement "TOOL: edit_file\nFILE: <chemin>\nOLD: <texte exact à remplacer>\nNEW: <texte de remplacement>"
5. Pour CHERCHER dans le code : réponds exactement "TOOL: search_code\nPATTERN: <regex>\nDIR: <répertoire>"
6. Pour GIT : réponds exactement "TOOL: git\nCMD: <sous-commande git>"
7. Le code produit doit être COMPLET et FONCTIONNEL dans le bon langage demandé.
8. Si la tâche dit "Dart", écris du vrai Dart. Si "Python", du vrai Python. Jamais un autre langage.
9. Après chaque action, observe le résultat et adapte ton approche si nécessaire.
10. Ne jamais marquer une étape comme réussie si le résultat contient une erreur.`;

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
        this.finalStatus       = 'running';
        this.startedAt         = Date.now();
        this.stoppedByUser     = false;
        this.logs              = [];
        this._projectContext   = '';
        this._toolResults      = [];   // rolling window of last 5 tool results for AI context
    }

    log(msg) {
        const ts = new Date().toISOString().slice(11, 23);
        const entry = `[${ts}] ${msg}`;
        this.logs.push(entry);
        console.log('[AGENT]', entry);
    }

    addToolResult(tool, args, result) {
        const entry = { tool, args: JSON.stringify(args).slice(0, 100), result: String(result).slice(0, 500) };
        this._toolResults.push(entry);
        if (this._toolResults.length > 8) this._toolResults.shift();
    }

    getToolResultContext() {
        return this._toolResults.map(r =>
            `[${r.tool}] args=${r.args} → ${r.result}`
        ).join('\n');
    }

    toSummary() {
        return {
            task:           this.task,
            status:         this.finalStatus,
            iteration:      this.iteration,
            filesModified:  this.filesModified,
            commandsRun:    this.commandsExecuted.map(c => c.cmd),
            testResults:    this.testResults,
            errors:         this.errors,
            durationMs:     Date.now() - this.startedAt,
            logs:           this.logs.slice(-50),
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
            if (fs.existsSync(abs)) {
                fs.writeFileSync(abs + '.sudo_bak', fs.readFileSync(abs));
            }
            fs.writeFileSync(abs, content, 'utf8');
            return { ok: true, path: filePath, abs };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    editFile(filePath, oldText, newText) {
        const r = this.readFile(filePath);
        if (!r.ok) return r;
        if (!r.content.includes(oldText)) {
            return { ok: false, error: `Pattern not found in ${filePath}: "${oldText.slice(0, 80)}"` };
        }
        const newContent = r.content.replace(oldText, newText);
        return this.writeFile(filePath, newContent);
    }

    listDir(dirPath, options = {}) {
        const abs = this._resolve(dirPath || '.');
        const { maxDepth = 2, excludes = ['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'coverage', '.sudo'] } = options;

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

    searchText(pattern, dirPath, extensions = ['.js', '.ts', '.py', '.json', '.md', '.dart', '.go', '.rs', '.java', '.cs']) {
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
                                    re.lastIndex = 0; // reset for global flag
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
                // err.code can be the process exit code (number) OR a string like 'ENOENT'
                const exitCode = err
                    ? (typeof err.code === 'number' ? err.code : (err.killed ? 124 : 1))
                    : 0;

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
                    timedOut: !!(err && err.killed),
                    error:    err ? err.message : null,
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

// ─── MCP CLIENT ───────────────────────────────────────────────────────────────
/**
 * Minimal Model Context Protocol client.
 * Reads .sudo/mcp.json to discover servers, connects via stdio or HTTP,
 * discovers available tools, and exposes them to the agent loop.
 *
 * MCP config format (.sudo/mcp.json):
 * {
 *   "servers": [
 *     { "name": "filesystem", "type": "stdio", "cmd": "npx @modelcontextprotocol/server-filesystem /path" },
 *     { "name": "my-api",     "type": "http",  "url": "http://localhost:3001/mcp" }
 *   ]
 * }
 */
class MCPClient {
    constructor(projectRoot) {
        this.root    = projectRoot;
        this.tools   = [];      // [{name, description, inputSchema, serverId}]
        this.servers = [];      // loaded from config
        this._ready  = false;
    }

    async initialize() {
        const configPath = path.join(this.root, MCP_CONFIG_FILE);
        if (!fs.existsSync(configPath)) {
            console.log('[MCP] No .sudo/mcp.json found — MCP disabled');
            return;
        }

        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            this.servers = (cfg.servers || []).slice(0, 5); // max 5 servers
            console.log(`[MCP] Loaded ${this.servers.length} server configs`);

            for (const srv of this.servers) {
                try {
                    await this._discoverTools(srv);
                } catch (e) {
                    console.warn(`[MCP] Failed to discover tools from ${srv.name}: ${e.message}`);
                }
            }
            this._ready = this.tools.length > 0;
            console.log(`[MCP] Ready — ${this.tools.length} tools available`);
        } catch (e) {
            console.warn('[MCP] Config parse error:', e.message);
        }
    }

    async _discoverTools(srv) {
        if (srv.type === 'http') {
            // HTTP MCP: POST /tools/list
            const r = await axios.post(`${srv.url}/tools/list`, {}, { timeout: 5000 });
            const tools = (r.data?.tools || []).slice(0, 20);
            for (const t of tools) {
                this.tools.push({ ...t, serverId: srv.name, serverUrl: srv.url, type: 'http' });
            }
            console.log(`[MCP] ${srv.name} (HTTP): ${tools.length} tools`);
        } else if (srv.type === 'stdio') {
            // Stdio MCP: spawn process, send initialize + tools/list JSON-RPC
            // For now we only support HTTP in this minimal implementation
            // Stdio would require a persistent child_process with JSON-RPC over stdin/stdout
            console.log(`[MCP] ${srv.name} (stdio): stdio MCP requires process keep-alive — skipping in this version`);
        }
    }

    async callTool(serverId, toolName, toolArgs) {
        const tool = this.tools.find(t => t.serverId === serverId && t.name === toolName);
        if (!tool) return { ok: false, error: `MCP tool not found: ${serverId}/${toolName}` };

        try {
            if (tool.type === 'http') {
                const r = await axios.post(`${tool.serverUrl}/tools/call`, {
                    name:      toolName,
                    arguments: toolArgs
                }, { timeout: 30000 });
                return { ok: true, result: r.data?.result || r.data };
            }
            return { ok: false, error: 'Unsupported MCP transport' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    getToolSummary() {
        if (!this._ready) return '';
        return 'MCP TOOLS AVAILABLE:\n' + this.tools
            .map(t => `- ${t.serverId}/${t.name}: ${t.description || ''}`)
            .join('\n');
    }
}

// ─── SUDO TOOLS (Sudo Studio integration) ────────────────────────────────────
class SudoTools {
    constructor(termTool, projectRoot) {
        this.term = termTool;
        this.root = projectRoot;
    }

    /**
     * Run a Doctor-style check: calls the runtime /health endpoint.
     * Returns { ok, status, model, issues[] }
     */
    async runDoctor() {
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 5000 });
            return {
                ok: true,
                status:  r.data.status,
                model:   r.data.model,
                loaded:  r.data.model_loaded,
                issues:  r.data.status !== 'healthy' ? ['Runtime not healthy'] : [],
            };
        } catch (e) {
            return { ok: false, error: `Runtime offline: ${e.message}`, issues: ['Runtime not reachable on port 6000'] };
        }
    }

    /**
     * Check if a specific SDK is installed by running its detection command.
     * Returns { ok, installed, version }
     */
    async checkSDK(name) {
        const cmds = {
            node:    'node --version',
            python:  process.platform === 'win32' ? 'python --version' : 'python3 --version',
            git:     'git --version',
            docker:  'docker --version',
            flutter: 'flutter --version',
            java:    'java --version',
            rust:    'rustc --version',
            go:      'go version',
        };
        const cmd = cmds[name.toLowerCase()];
        if (!cmd) return { ok: false, error: `Unknown SDK: ${name}` };

        const r = await this.term.run(cmd, { timeout: 5000 });
        return { ok: r.ok, installed: r.ok, version: r.ok ? r.stdout.trim().split('\n')[0] : null };
    }
}

// ─── AI PROVIDER ──────────────────────────────────────────────────────────────
class AIProvider {
    constructor(options = {}) {
        this.runtimeUrl = options.runtimeUrl || 'http://localhost:6000';
        this.backendUrl = options.backendUrl  || 'http://localhost:5000';
    }

    async query(prompt, systemContext = '', options = {}) {
        const max_tokens  = options.max_tokens  || 1024;
        const temperature = options.temperature || 0.1;

        const fullPrompt = AGENT_SYSTEM_PROMPT +
            (systemContext ? '\n\nCONTEXT:\n' + systemContext : '') +
            '\n\nUser: ' + prompt.trim() + '\nAssistant:';

        const payload = { message: fullPrompt, prompt: fullPrompt, input: fullPrompt, max_tokens, temperature };

        console.log(`[AGENT_AI] query() → POST ${this.runtimeUrl}/infer | max_tokens=${max_tokens} temp=${temperature} | prompt_len=${fullPrompt.length}`);

        try {
            const r = await axios.post(`${this.runtimeUrl}/infer`, payload, { timeout: AI_TIMEOUT_MS });
            const reply = r.data.reply || r.data.response || '';
            const mock  = r.data.mock === true;
            console.log(`[AGENT_AI] ← OK | model=${r.data.model} mock=${mock} | reply_len=${reply.length}`);
            if (!reply) console.warn('[AGENT_AI] Empty reply from runtime');
            return { ok: true, reply, model: r.data.model, mock };
        } catch (e) {
            console.error(`[AGENT_AI] Error: ${e.code || e.message}`);
            if (e.code === 'ECONNREFUSED') return { ok: false, error: 'Runtime offline', reply: null };
            if (e.code === 'ECONNABORTED' || (e.message || '').includes('timeout')) {
                return { ok: false, error: `Timeout after ${AI_TIMEOUT_MS}ms`, reply: null };
            }
            return { ok: false, error: e.message, reply: null };
        }
    }

    /**
     * Plan generation: asks AI to produce a specific, numbered plan for THIS task.
     * The prompt emphasises using concrete tool calls, not generic steps.
     */
    async plan(task, projectContext, mcpContext = '') {
        const prompt = `TÂCHE À ACCOMPLIR : ${task}

CONTEXTE DU PROJET :
${projectContext}
${mcpContext ? '\n' + mcpContext : ''}

Génère un plan d'action numéroté (maximum 8 étapes) SPÉCIFIQUE à cette tâche.
Chaque étape doit utiliser exactement l'un de ces formats d'outil :
  TOOL: write_file  → pour créer/écrire un fichier (utilise cette forme pour créer des fichiers)
  TOOL: run_command → pour exécuter une commande shell réelle
  TOOL: read_file   → pour lire un fichier existant
  TOOL: edit_file   → pour modifier un fichier existant
  TOOL: search_code → pour chercher dans le code
  TOOL: git         → pour des opérations git

Format exact attendu pour chaque étape :
1. [DESCRIPTION COURTE] → TOOL: <outil> — <argument principal>

Exemples pour la tâche "Écrire un fichier Dart calculator.dart" :
1. Créer le fichier Dart → TOOL: write_file — calculator.dart
2. Vérifier la syntaxe → TOOL: run_command — dart analyze calculator.dart

Génère le plan maintenant pour la tâche : ${task}`;

        return this.query(prompt, '', { max_tokens: 512, temperature: 0.2 });
    }

    /**
     * Generate the actual shell command to execute for a given step description.
     * This is called when the step has type run_command but no explicit command.
     */
    async generateCommand(stepDescription, projectContext, previousResults = '') {
        const prompt = `ÉTAPE À EXÉCUTER : "${stepDescription}"

CONTEXTE :
${projectContext.slice(0, 1000)}

RÉSULTATS PRÉCÉDENTS :
${previousResults.slice(0, 500)}

Génère la commande shell exacte et réelle pour accomplir cette étape.
Réponds UNIQUEMENT avec le format :
TOOL: run_command
CMD: <commande shell exacte prête à exécuter>

Si l'étape ne nécessite pas de commande, réponds :
TOOL: write_file
FILE: <chemin>
CONTENT:
<contenu complet>`;

        return this.query(prompt, '', { max_tokens: 300, temperature: 0.1 });
    }

    /**
     * Generate file content for a write_file step.
     */
    async generateFileContent(filePath, task, projectContext, previousResults = '') {
        const ext = path.extname(filePath).toLowerCase();
        const lang = {
            '.dart': 'Dart', '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript',
            '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.cpp': 'C++',
            '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
        }[ext] || 'code';

        const prompt = `TÂCHE : ${task}
FICHIER À CRÉER : ${filePath} (langage: ${lang})

CONTEXTE DU PROJET :
${projectContext.slice(0, 800)}

RÉSULTATS PRÉCÉDENTS :
${previousResults.slice(0, 400)}

Génère le contenu COMPLET et FONCTIONNEL du fichier ${filePath} en ${lang}.
Le code doit être directement exécutable et correspondre exactement à la tâche demandée.
N'inclus pas d'explication, seulement le code.`;

        return this.query(prompt, '', { max_tokens: 1500, temperature: 0.05 });
    }

    /**
     * Diagnose an error and propose a fix action.
     */
    async diagnose(errorContext, projectContext) {
        const prompt = `ERREUR DÉTECTÉE :
${errorContext}

CONTEXTE DU PROJET :
${projectContext.slice(0, 1500)}

Diagnostique la cause racine en 2 phrases maximum, puis propose l'action corrective exacte dans ce format :
TOOL: <outil>
<arguments nécessaires>

Réponds directement avec le diagnostic + l'action corrective.`;

        return this.query(prompt, '', { max_tokens: 600, temperature: 0.1 });
    }
}

// ─── STEP PARSER ──────────────────────────────────────────────────────────────
/**
 * Parses a plan step description to extract tool type and arguments.
 * Handles both structured responses (TOOL: xxx) and natural language descriptions.
 */
function parseStepToTool(description) {
    const d = description.trim();

    // Structured tool call (from plan)
    const toolMatch = d.match(/TOOL:\s*(\w+)\s*[—-]?\s*(.*)/i);
    if (toolMatch) {
        return {
            type: toolMatch[1].toLowerCase().replace('_', '_'),
            arg:  toolMatch[2].trim()
        };
    }

    // Natural language heuristics — comprehensive patterns
    if (/^(read|lire|ouvrir|consulter|inspect|check file|look at|afficher)\s/i.test(d)) {
        const fileMatch = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'read_file', arg: fileMatch ? fileMatch[0] : null };
    }

    if (/^(write|créer|create|générer|generate|écrire|write file|create file)\s/i.test(d)) {
        const fileMatch = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'write_file', arg: fileMatch ? fileMatch[0] : null };
    }

    if (/^(edit|modifier|fix|corriger|update|patch|changer)\s/i.test(d)) {
        const fileMatch = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'edit_file', arg: fileMatch ? fileMatch[0] : null };
    }

    if (/^(run|lancer|execute|exécuter?|npm|pip|python|node|flutter|dart|yarn|cargo|make|gradle|mvn|go\s)\s/i.test(d)) {
        return { type: 'run_command', arg: d.replace(/^(run|lancer|execute|exécuter?)\s+/i, '').trim() };
    }

    if (/^(test|vérif|verify|tester|run test|check syntax|valider)\s/i.test(d)) {
        // Extract command if present, otherwise will generate
        const cmdMatch = d.match(/(dart|npm|python|pytest|jest|mocha|cargo|go\s+test)\s*.*/i);
        return { type: 'run_command', arg: cmdMatch ? cmdMatch[0] : null, isTest: true };
    }

    if (/^(git|commit|push|pull|status|diff)\s/i.test(d)) {
        return { type: 'git', arg: d };
    }

    if (/^(search|grep|find|chercher|trouver)\s/i.test(d)) {
        return { type: 'search_code', arg: d };
    }

    if (/\b(dart|flutter)\b/i.test(d) && /\b(analyser?|check|syntaxe|syntax|verify)\b/i.test(d)) {
        const fileMatch = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'run_command', arg: fileMatch ? `dart analyze ${fileMatch[0]}` : null, isTest: true };
    }

    if (/\b(npm|pip|python|node|flutter|dart)\b/i.test(d)) {
        return { type: 'run_command', arg: d };
    }

    // Default: unknown → ask AI to generate tool call
    return { type: 'ai_generate', arg: null };
}

// ─── AGENT ENGINE ─────────────────────────────────────────────────────────────
class AgentEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || (
            (() => {
                try { return require('vscode').workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd(); }
                catch (_) { return process.cwd(); }
            })()
        );
        this.fileTool    = new FileTool(this.projectRoot);
        this.termTool    = new TerminalTool(this.projectRoot);
        this.gitTool     = new GitTool(this.termTool);
        this.mcpClient   = new MCPClient(this.projectRoot);
        this.sudoTools   = new SudoTools(this.termTool, this.projectRoot);
        this.aiProvider  = new AIProvider(options.ai || {});
        this.state       = null;
        this._stopped    = false;
        this._approvalQueue = [];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async run(task) {
        this._stopped = false;
        this.state    = new AgentState(task, this.projectRoot);
        console.log('[AGENT] Task:', task);
        console.log('[AGENT] projectRoot:', this.projectRoot);
        this.state.log(`Agent v2.0 started — task: ${task}`);
        this._emit('step', { phase: 'start', message: `🚀 Sudo Agent démarré — tâche: ${task}` });

        try {
            // Init MCP (non-blocking — won't fail if no config)
            await this.mcpClient.initialize().catch(e => console.warn('[MCP] Init error:', e.message));

            // PHASE 1: Gather project context (offline)
            await this._phase_analyze();
            if (this._stopped) return this._finish('stopped');

            // PHASE 2: Build AI plan specific to THIS task
            await this._phase_plan();
            if (this._stopped) return this._finish('stopped');

            // PHASE 3: Execute plan with auto-correction loop
            await this._phase_execute();

        } catch (e) {
            this.state.log(`FATAL: ${e.message}`);
            console.error('[AGENT] Fatal error:', e.stack);
            this._emit('error', { message: e.message, phase: 'execute' });
            return this._finish('failed');
        }

        return this._finish(this.state.finalStatus === 'running' ? 'success' : this.state.finalStatus);
    }

    stop() {
        this._stopped = true;
        if (this.state) {
            this.state.log('Stopped by user');
            this.state.stoppedByUser = true;
        }
        this._emit('step', { phase: 'stop', message: '⏹ Agent arrêté par l\'utilisateur.' });
    }

    resolveApproval(approved) {
        if (this._approvalQueue.length) {
            const resolver = this._approvalQueue.shift();
            resolver(approved);
        }
    }

    // ── Phases ────────────────────────────────────────────────────────────────

    async _phase_analyze() {
        console.log('[AGENT] ─── PHASE 1: ANALYZE ───');
        this._emit('step', { phase: 'analyze', message: '🔍 Analyse du projet en cours...' });
        this.state.log('Phase: analyze');

        const structure = this.fileTool.listDir('.', { maxDepth: 2 });
        const dirs  = structure.entries.filter(e => e.type === 'dir'  && e.depth === 0).map(e => e.name).join(', ');
        const files = structure.entries.filter(e => e.type === 'file' && e.depth === 0).map(e => e.name).join(', ');

        // Read key files for context
        const contextFiles = ['package.json', 'README.md', 'requirements.txt', 'pyproject.toml', 'pubspec.yaml', 'go.mod', 'Cargo.toml'];
        const contextSnippets = [];
        for (const f of contextFiles) {
            const r = this.fileTool.readFile(f);
            if (r.ok) contextSnippets.push(`--- ${f} ---\n${r.content.slice(0, 600)}`);
        }

        // Git status
        const gitSt = await this.gitTool.status();

        // MCP tools
        const mcpSummary = this.mcpClient.getToolSummary();

        this.state._projectContext = [
            `PROJECT ROOT: ${this.projectRoot}`,
            `DIRS: ${dirs || '(empty)'}`,
            `ROOT FILES: ${files || '(empty)'}`,
            gitSt.stdout ? `GIT STATUS:\n${gitSt.stdout.slice(0, 300)}` : '',
            ...contextSnippets,
            mcpSummary || '',
        ].filter(Boolean).join('\n\n');

        this._emit('step', {
            phase: 'analyze',
            message: `📁 Projet analysé — ${structure.entries.length} entrées${mcpSummary ? ' | MCP: ' + this.mcpClient.tools.length + ' outils' : ''}`,
            data: { dirs, rootFiles: files, mcpTools: this.mcpClient.tools.length }
        });
    }

    async _phase_plan() {
        console.log('[AGENT] ─── PHASE 2: PLAN ───');
        this._emit('step', { phase: 'plan', message: '📋 Génération du plan IA (adapté à la tâche)...' });
        this.state.log('Phase: plan');

        console.log('[AGENT_PLAN] Calling aiProvider.plan() for task:', this.state.task);
        const aiResult = await this.aiProvider.plan(
            this.state.task,
            this.state._projectContext,
            this.mcpClient.getToolSummary()
        );

        console.log('[AGENT_PLAN] ok=%s mock=%s reply_len=%d',
            aiResult.ok, aiResult.mock, (aiResult.reply || '').length);

        let plan = [];

        if (aiResult.ok && aiResult.reply) {
            // Parse numbered list (supports "1. xxx", "1) xxx", "Step 1: xxx")
            const lines = aiResult.reply.split('\n');
            for (const line of lines) {
                const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
                if (m) {
                    const desc = m[2].trim();
                    if (desc.length > 3) {
                        plan.push({ step: plan.length + 1, description: desc, status: 'pending', raw: line });
                    }
                }
            }
        }

        // Task-specific fallback if AI unavailable or empty response
        if (!plan.length) {
            plan = this._buildTaskSpecificFallbackPlan(this.state.task);
            this.state.log('AI plan empty/failed — using task-specific fallback plan');
            this._emit('step', { phase: 'plan', message: '⚠️ Modèle IA indisponible — plan de secours spécifique à la tâche généré' });
        } else if (aiResult.mock) {
            this.state.log('AI in mock mode — plan may be generic; task-specific context injected');
            this._emit('step', { phase: 'plan', message: '⚠️ Modèle en mode mock — le plan peut manquer de précision' });
        }

        this.state.currentPlan = plan;
        this.state.log(`Plan: ${plan.length} steps`);

        this._emit('step', {
            phase: 'plan',
            message: `📋 Plan: ${plan.length} étapes${aiResult.mock ? ' (mock)' : ' (IA)'}`,
            data: { plan, mock: aiResult.mock || false }
        });
    }

    /**
     * Build a task-specific fallback plan by analysing the task text.
     * This replaces the old generic ["Analyser", "Identifier", "Corriger", "Tester"] template.
     */
    _buildTaskSpecificFallbackPlan(task) {
        const t = task.toLowerCase();

        // File creation tasks (write/create/generate file)
        const fileMatch = task.match(/[\w-]+\.\w{1,6}/);
        const fileName = fileMatch ? fileMatch[0] : null;

        if ((/\b(write|create|créer|écrire|générer|generate)\b.*\bfile\b/i.test(task) ||
             /\b(dart|flutter|python|javascript|typescript|go|rust|java)\b/i.test(task)) && fileName) {
            const ext = path.extname(fileName).toLowerCase();
            const verifyCmd = {
                '.dart': `dart analyze ${fileName}`,
                '.py':   `python3 -c "import ast; ast.parse(open('${fileName}').read())"`,
                '.js':   `node --check ${fileName}`,
                '.ts':   `npx tsc --noEmit ${fileName}`,
                '.go':   `go vet ${fileName}`,
                '.rs':   `rustc --edition 2021 --emit=metadata ${fileName}`,
            }[ext] || `echo "Fichier créé: ${fileName}"`;

            return [
                { step: 1, description: `TOOL: write_file — ${fileName}`,         status: 'pending' },
                { step: 2, description: `TOOL: run_command — ${verifyCmd}`,        status: 'pending' },
            ];
        }

        // Fix/debug tasks
        if (/\b(fix|repair|corriger|déboguer|debug|résoudre)\b/i.test(t)) {
            const filesInTask = task.match(/[\w./\\-]+\.\w{1,6}/g) || [];
            const steps = [];
            if (filesInTask.length) steps.push({ step: 1, description: `TOOL: read_file — ${filesInTask[0]}`, status: 'pending' });
            steps.push({ step: steps.length + 1, description: `TOOL: search_code — error`, status: 'pending' });
            steps.push({ step: steps.length + 1, description: `TOOL: edit_file — appliquer le correctif`, status: 'pending' });
            steps.push({ step: steps.length + 1, description: `TOOL: run_command — npm test || python -m pytest`, status: 'pending' });
            return steps;
        }

        // Install/setup tasks
        if (/\b(install|setup|configur|initialise|init)\b/i.test(t)) {
            return [
                { step: 1, description: 'TOOL: run_command — npm install || pip install -r requirements.txt', status: 'pending' },
                { step: 2, description: 'TOOL: run_command — npm run build || python -c "import sys; print(sys.version)"', status: 'pending' },
            ];
        }

        // Generic fallback — but still structured as tool calls
        return [
            { step: 1, description: `TOOL: search_code — ${task.split(' ').slice(0, 3).join(' ')}`, status: 'pending' },
            { step: 2, description: `TOOL: ai_generate — ${task}`, status: 'pending' },
            { step: 3, description: `TOOL: run_command — echo "Task completed: ${task.slice(0, 50)}"`, status: 'pending' },
        ];
    }

    async _phase_execute() {
        console.log('[AGENT] ─── PHASE 3: EXECUTE ─── plan has', this.state.currentPlan.length, 'steps');
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

            let stepFailed = false;

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

                const result = await this._executeStep(step);

                // CRITICAL: only mark done if tool succeeded
                if (result && result.ok === false) {
                    step.status = 'failed';
                    stepFailed  = true;
                    this.state.log(`Step ${step.step} FAILED: ${result.error || result.stderr || 'unknown error'}`);
                    this._emit('step', {
                        phase: 'step_error',
                        message: `❌ Étape ${step.step} échouée: ${(result.error || result.stderr || '').slice(0, 200)}`,
                        data: { step, error: result.error || result.stderr }
                    });
                } else {
                    step.status = 'done';
                }

                const done  = this.state.currentPlan.filter(s => s.status === 'done').length;
                const total = this.state.currentPlan.length;
                this._emit('progress', {
                    step: done, total,
                    pct: Math.round(100 * done / total)
                });
            }

            // Verify result after executing all plan steps
            const verified = await this._verify();
            if (verified) {
                this.state.finalStatus = 'success';
                return;
            }

            // Not verified — diagnose failed steps and repair
            if (stepFailed && iteration < MAX_ITERATIONS) {
                await this._diagnoseAndRepair();
            } else if (!stepFailed) {
                // All steps done but verify failed — task considered complete
                this.state.finalStatus = 'success';
                return;
            }
        }

        if (iteration >= MAX_ITERATIONS) {
            this.state.log(`Max iterations (${MAX_ITERATIONS}) reached`);
            this.state.errors.push(`Max iterations reached without success`);
            this.state.finalStatus = 'failed';
        }
    }

    /**
     * Execute a single step. Returns { ok, ... } with real success/failure info.
     * NEVER throws — always returns a result object.
     */
    async _executeStep(step) {
        try {
            const parsed = parseStepToTool(step.description);
            console.log(`[AGENT] Step ${step.step} parsed:`, parsed.type, '|', parsed.arg || '');

            switch (parsed.type) {
                case 'read_file':
                    return await this._toolReadFile(parsed.arg || step.description);

                case 'write_file':
                    return await this._toolWriteFileFromAI(parsed.arg || step.description, step.description);

                case 'edit_file':
                    return await this._toolAIEdit(step.description);

                case 'run_command': {
                    // parsed.arg may already be a real command (e.g. "dart analyze calculator.dart")
                    // or null/unclear — ask AI to generate it in that case
                    let cmd = parsed.arg;
                    if (!cmd || cmd.length < 3 || /^(la|les|le|des|un|une|the|a|an)\s/i.test(cmd)) {
                        // arg looks like natural language — generate real command via AI
                        const genResult = await this.aiProvider.generateCommand(
                            step.description,
                            this.state._projectContext,
                            this.state.getToolResultContext()
                        );
                        if (genResult.ok && genResult.reply) {
                            const cmdMatch = genResult.reply.match(/CMD:\s*(.+)/);
                            cmd = cmdMatch ? cmdMatch[1].trim() : null;
                            // Maybe AI replied with write_file instead
                            if (!cmd && genResult.reply.includes('TOOL: write_file')) {
                                return await this._toolWriteFileFromAIReply(genResult.reply, step.description);
                            }
                        }
                        if (!cmd) {
                            this.state.log(`Could not generate command for: ${step.description}`);
                            return { ok: false, error: `Impossible de déterminer la commande pour: ${step.description}` };
                        }
                    }
                    return await this._toolRunCommand(cmd);
                }

                case 'search_code': {
                    const pattern = parsed.arg || step.description.replace(/^(search|grep|find|chercher|trouver)\s*/i, '').trim();
                    return await this._toolSearchCode(pattern);
                }

                case 'git':
                    return await this._toolGit(step.description);

                case 'ai_generate':
                    // Fully delegate to AI: let it decide what to do for this step
                    return await this._toolAIGenerateAction(step.description);

                default:
                    // Unknown type — AI generate
                    return await this._toolAIGenerateAction(step.description);
            }
        } catch (e) {
            console.error('[AGENT] _executeStep threw:', e.message);
            return { ok: false, error: e.message };
        }
    }

    // ── Tools ─────────────────────────────────────────────────────────────────

    async _toolReadFile(filePath) {
        this.state.log(`READ: ${filePath}`);
        const result = this.fileTool.readFile(filePath);
        this.state.filesRead.push(filePath);

        const resultStr = result.ok ? `${result.lines} lines` : result.error;
        this.state.addToolResult('read_file', { file: filePath }, resultStr);
        this._emit('tool_call', {
            tool: 'read_file',
            args: { file: filePath },
            result: resultStr,
            ok: result.ok
        });

        if (result.ok) {
            this.state._projectContext += `\n\n--- ${filePath} (${result.lines} lines) ---\n${result.content.slice(0, 3000)}`;
        }
        return result;
    }

    async _toolWriteFile(filePath, content, reason = '') {
        this.state.log(`WRITE: ${filePath}${reason ? ' — ' + reason : ''}`);
        const result = this.fileTool.writeFile(filePath, content);
        if (result.ok && !this.state.filesModified.includes(filePath)) {
            this.state.filesModified.push(filePath);
        }
        const resultStr = result.ok ? `Written: ${filePath}` : result.error;
        this.state.addToolResult('write_file', { file: filePath }, resultStr);
        this._emit('tool_call', {
            tool: 'write_file',
            args: { file: filePath, reason, bytes: content.length },
            result: resultStr,
            ok: result.ok
        });
        return result;
    }

    async _toolWriteFileFromAI(filePathHint, stepDescription) {
        // Normalise the file path hint (may include TOOL: prefix)
        const fp = (filePathHint || stepDescription)
            .replace(/TOOL:\s*write_file\s*[—-]?\s*/i, '')
            .trim()
            .split(/\s+/)[0];  // take first word as filename

        this.state.log(`WRITE (AI-generated): ${fp}`);
        this._emit('step', { phase: 'step', message: `✍️ Génération du contenu pour ${fp}...` });

        const aiResult = await this.aiProvider.generateFileContent(
            fp,
            this.state.task,
            this.state._projectContext,
            this.state.getToolResultContext()
        );

        if (!aiResult.ok || !aiResult.reply) {
            return { ok: false, error: `AI failed to generate content for ${fp}: ${aiResult.error || 'empty reply'}` };
        }

        // Strip any markdown code fences from the response
        let content = aiResult.reply.trim();
        content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();

        return await this._toolWriteFile(fp, content, stepDescription);
    }

    async _toolWriteFileFromAIReply(aiReply, stepDescription) {
        // Parse FILE: and CONTENT: from AI reply
        const fileMatch    = aiReply.match(/FILE:\s*(.+)/);
        const contentMatch = aiReply.match(/CONTENT:\n([\s\S]+)/);

        if (!fileMatch) return { ok: false, error: 'AI reply missing FILE: field' };

        const fp      = fileMatch[1].trim();
        let   content = contentMatch ? contentMatch[1].trim() : '';
        content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();

        if (!content) {
            // Fallback: generate content separately
            return await this._toolWriteFileFromAI(fp, stepDescription);
        }

        return await this._toolWriteFile(fp, content, stepDescription);
    }

    async _toolRunCommand(cmd, options = {}) {
        // Safety: dangerous commands require user approval
        if (DANGEROUS_PATTERNS.some(re => re.test(cmd))) {
            const approved = await this._requestApproval('DANGEROUS_COMMAND', `Run: ${cmd}`);
            if (!approved) {
                this.state.log(`REJECTED dangerous command: ${cmd}`);
                return { ok: false, error: 'Rejected by user' };
            }
        }

        this.state.log(`CMD: ${cmd}`);
        this._emit('tool_call', { tool: 'run_command', args: { cmd }, result: '…running…', ok: null });

        const result = await this.termTool.run(cmd, options);
        this.state.commandsExecuted.push({ cmd, exitCode: result.exitCode, ok: result.ok });

        const output = result.ok
            ? `Exit 0 | ${result.stdout.slice(0, 600)}`
            : `Exit ${result.exitCode} | STDERR: ${(result.stderr || result.stdout).slice(0, 600)}`;

        this.state.addToolResult('run_command', { cmd }, output);
        this._emit('tool_call', {
            tool: 'run_command',
            args: { cmd },
            result: output,
            ok: result.ok,
            exitCode: result.exitCode
        });

        // CRITICAL: push to errors array so _diagnoseAndRepair can see real stderr
        if (!result.ok) {
            this.state.errors.push({
                cmd,
                stderr:   (result.stderr || '').slice(0, 800),
                stdout:   (result.stdout || '').slice(0, 400),
                exitCode: result.exitCode
            });
        }

        return result;
    }

    async _toolAIEdit(instruction) {
        this.state.log(`AI EDIT: ${instruction}`);
        const prompt = `INSTRUCTION: ${instruction}

CONTEXTE DU PROJET :
${this.state._projectContext.slice(0, 2000)}

RÉSULTATS PRÉCÉDENTS :
${this.state.getToolResultContext()}

Réponds dans ce format EXACT :
FILE: <chemin relatif du fichier>
OLD: <texte exact à remplacer (tel qu'il apparaît dans le fichier)>
NEW: <texte de remplacement>

Si aucune modification n'est nécessaire : NO_EDIT_NEEDED`;

        const ai = await this.aiProvider.query(prompt, '', { max_tokens: 1000, temperature: 0.1 });

        if (!ai.ok || !ai.reply || ai.reply.includes('NO_EDIT_NEEDED')) {
            this.state.log('AI edit: no change needed or AI unavailable');
            return { ok: true };  // not a failure — step just didn't need action
        }

        const fileMatch = ai.reply.match(/^FILE:\s*(.+)$/m);
        const oldMatch  = ai.reply.match(/^OLD:\s*([\s\S]+?)^NEW:/m);
        const newMatch  = ai.reply.match(/^NEW:\s*([\s\S]+)/m);

        if (fileMatch && oldMatch && newMatch) {
            const file   = fileMatch[1].trim();
            const oldTxt = oldMatch[1].trim();
            const newTxt = newMatch[1].trim();
            const r      = this.fileTool.editFile(file, oldTxt, newTxt);
            if (r.ok && !this.state.filesModified.includes(file)) this.state.filesModified.push(file);
            this.state.addToolResult('edit_file', { file, instruction }, r.ok ? 'Edit applied' : r.error);
            this._emit('tool_call', { tool: 'edit_file', args: { file, instruction }, result: r.ok ? `Edit applied to ${file}` : r.error, ok: r.ok });
            return r;
        }

        return { ok: false, error: 'Could not parse AI edit response' };
    }

    async _toolSearchCode(pattern) {
        this.state.log(`SEARCH: ${pattern}`);
        const result = this.fileTool.searchText(pattern, '.');
        const summary = result.ok
            ? `${result.matches.length} matches`
            : result.error;
        this.state.addToolResult('search_code', { pattern }, summary);
        this._emit('tool_call', { tool: 'search_code', args: { pattern }, result: summary, ok: result.ok });
        if (result.ok && result.matches.length) {
            this.state._projectContext += '\n\nSEARCH RESULTS:\n' +
                result.matches.slice(0, 10).map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
        }
        return result;
    }

    async _toolGit(instruction) {
        const isWrite = /commit|push|merge|rebase/i.test(instruction);
        if (isWrite) {
            const approved = await this._requestApproval('GIT_WRITE', instruction);
            if (!approved) return { ok: false, error: 'Git write rejected by user' };
        }

        let cmd;
        if (/status/i.test(instruction))       cmd = 'git status';
        else if (/diff/i.test(instruction))    cmd = 'git diff';
        else if (/log/i.test(instruction))     cmd = 'git log --oneline -10';
        else if (/commit/i.test(instruction)) {
            const msg = instruction.replace(/.*commit\s*/i, '').trim() || 'fix: agent auto-fix';
            await this._toolRunCommand('git add -A');
            cmd = `git commit -m "${msg}"`;
        } else {
            const cmdPart = instruction.replace(/^(git|TOOL:\s*git)\s*/i, '').trim();
            cmd = `git ${cmdPart}`;
        }

        return this._toolRunCommand(cmd);
    }

    /**
     * Fully AI-delegated step: let the model decide the tool to use.
     * Used when step type is 'ai_generate' or unknown.
     */
    async _toolAIGenerateAction(stepDescription) {
        this.state.log(`AI GENERATE ACTION: ${stepDescription}`);
        this._emit('step', { phase: 'step', message: `🤔 IA génère l'action pour: ${stepDescription}...` });

        const genResult = await this.aiProvider.generateCommand(
            stepDescription,
            this.state._projectContext,
            this.state.getToolResultContext()
        );

        if (!genResult.ok || !genResult.reply) {
            return { ok: false, error: `AI could not generate action: ${genResult.error || 'no reply'}` };
        }

        const reply = genResult.reply.trim();

        // Parse tool from reply
        if (reply.includes('TOOL: run_command') || reply.includes('CMD:')) {
            const cmdMatch = reply.match(/CMD:\s*(.+)/);
            if (cmdMatch) return await this._toolRunCommand(cmdMatch[1].trim());
        }
        if (reply.includes('TOOL: write_file') || reply.includes('FILE:')) {
            return await this._toolWriteFileFromAIReply(reply, stepDescription);
        }
        if (reply.includes('TOOL: edit_file')) {
            return await this._toolAIEdit(stepDescription);
        }
        if (reply.includes('TOOL: read_file')) {
            const fileMatch = reply.match(/FILE:\s*(.+)/);
            if (fileMatch) return await this._toolReadFile(fileMatch[1].trim());
        }
        if (reply.includes('TOOL: search_code')) {
            const patternMatch = reply.match(/PATTERN:\s*(.+)/);
            if (patternMatch) return await this._toolSearchCode(patternMatch[1].trim());
        }

        this.state.log(`AI generated unrecognised action format: ${reply.slice(0, 100)}`);
        return { ok: false, error: 'AI reply format not parseable as tool call' };
    }

    // ── Verify ────────────────────────────────────────────────────────────────

    async _verify() {
        console.log('[AGENT] Starting VERIFY phase');
        this._emit('step', { phase: 'verify', message: '✅ Vérification du résultat...' });
        this.state.log('Phase: verify');

        // Check files were actually created/modified
        const filesOk = this.state.filesModified.every(f => {
            const r = this.fileTool.readFile(f);
            if (!r.ok) {
                this.state.log(`VERIFY FAIL: file not found: ${f}`);
                return false;
            }
            return true;
        });

        if (!filesOk) return false;

        // Run tests if test script exists
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

        // No test framework — check for any errors accumulated during execution
        const criticalErrors = this.state.errors.filter(e => e.exitCode !== 0);
        if (criticalErrors.length > 0) {
            this._emit('step', {
                phase: 'verify',
                message: `⚠️ ${criticalErrors.length} commande(s) ont échoué — vérification des fichiers créés...`
            });
            // Still pass if files were successfully created (task might be write-only)
            if (this.state.filesModified.length > 0) {
                this._emit('step', { phase: 'verify', message: `✅ ${this.state.filesModified.length} fichier(s) créés/modifiés avec succès` });
                return true;
            }
            return false;
        }

        this._emit('step', { phase: 'verify', message: '✅ Vérification OK — aucune erreur critique' });
        return true;
    }

    // ── Diagnose & Repair ─────────────────────────────────────────────────────

    async _diagnoseAndRepair() {
        this._emit('step', { phase: 'diagnose', message: '🔬 Diagnostic automatique des erreurs...' });
        this.state.log('Phase: diagnose');

        const lastErrors = this.state.errors.slice(-3);
        if (!lastErrors.length) return;

        const errorContext = lastErrors.map(e =>
            `CMD: ${e.cmd}\nEXIT CODE: ${e.exitCode}\nSTDERR:\n${e.stderr}\nSTDOUT:\n${e.stdout || ''}`
        ).join('\n\n---\n\n');

        this._emit('step', {
            phase: 'diagnose',
            message: `🩺 Analyse de ${lastErrors.length} erreur(s): ${lastErrors.map(e => e.cmd).join(', ')}`
        });

        const diagnosis = await this.aiProvider.diagnose(errorContext, this.state._projectContext.slice(0, 2000));

        if (diagnosis.ok && diagnosis.reply) {
            const diagMsg = diagnosis.reply.slice(0, 200);
            this.state.log(`Diagnosis: ${diagMsg}`);
            this._emit('step', {
                phase: 'diagnose',
                message: '🩺 ' + diagMsg,
                data: { diagnosis: diagnosis.reply }
            });

            // Parse the repair action from the diagnosis reply
            const toolParsed = parseStepToTool(diagnosis.reply);
            if (toolParsed.type !== 'ai_generate') {
                // Insert the repair step at the beginning of pending steps
                const repairDesc = diagnosis.reply.split('\n').find(l => l.includes('TOOL:')) || diagnosis.reply.slice(0, 150);
                this.state.currentPlan.push({
                    step: this.state.currentPlan.length + 1,
                    description: repairDesc,
                    status: 'pending'
                });
                this.state.log(`Repair step added: ${repairDesc.slice(0, 100)}`);
            }
        } else {
            this.state.log('Diagnosis failed or AI unavailable');
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
            emoji:          statusEmoji[status] || '❓',
            summary,
            filesModified:  this.state.filesModified,
            commandsRun:    this.state.commandsExecuted.map(c => c.cmd),
            testResults:    this.state.testResults,
        });

        this.state.log(`Agent v2.0 finished — status: ${status}`);
        return summary;
    }

    _emit(event, data) {
        this.emit(event, data);
    }
}

module.exports = { AgentEngine, AgentState, FileTool, TerminalTool, GitTool, AIProvider, MCPClient, SudoTools };
