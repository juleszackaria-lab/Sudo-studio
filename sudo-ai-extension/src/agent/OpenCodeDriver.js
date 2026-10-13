/**
 * SUDO STUDIO - OpenCode server driver (MISSION P3 b,c,d).
 *
 * Spawns the pinned OpenCode server (see opencode.manifest.json) as a local
 * child process bound to 127.0.0.1 and drives it over plain HTTP + SSE.
 * No SDK dependency (the official SDK needs bun to run its TS sources).
 *
 * Offline-strict + containment (all verified against the v1.19.0 sources):
 * - config passed via OPENCODE_CONFIG_CONTENT (generated, never a file)
 * - HOME/XDG/APPDATA redirected under the extension global dir
 * - OPENCODE_DISABLE_MODELS_FETCH/AUTOUPDATE/PROJECT_CONFIG + --pure
 * - pre-seeded package.json/lock/node_modules skip the background
 *   @opencode-ai/plugin npm install (npm.ts checkDirty); registry env
 *   blackhole makes any missed install fail fast with zero traffic.
 * - random basic-auth password per spawn.
 * ASCII-only.
 */
'use strict';

const { EventEmitter } = require('events');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const sandbox = require('./sandbox'); // P8: L1 restrictions + L2 guests

const OPENCODE_VERSION = '1.19.0';      // must match opencode.manifest.json
const PLUGIN_PKG = '@opencode-ai/plugin';
const LOCAL_PROVIDER_ID = 'openai';     // bundled SDK, baseURL overridden to runtime
const CLOUD_PROVIDER_ID = 'sudo-cloud'; // bundled @ai-sdk/openai-compatible
const RUNTIME_BASE_URL = 'http://127.0.0.1:6000/v1';

// ---------------------------------------------------------------- pure helpers

function findFreePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

function resolveBinary(extensionDir) {
    if (process.env.SUDO_OPENCODE_BIN) return process.env.SUDO_OPENCODE_BIN;
    const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    if (extensionDir) {
        const local = path.join(extensionDir, 'bin', exe);
        if (fs.existsSync(local)) return local;
    }
    try {
        const cmd = process.platform === 'win32' ? 'where opencode' : 'command -v opencode';
        const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
        if (out) return out;
    } catch (_) { /* not on PATH */ }
    return null;
}

function globalHome() {
    return path.join(os.homedir(), '.sudo_studio', 'opencode');
}

function configDirCandidates(home) {
    const dirs = [path.join(home, '.config', 'opencode')];
    if (process.platform === 'win32') {
        // env-paths style locations, covered best-effort (registry blackhole
        // guarantees zero traffic for any directory we did not pre-seed).
        dirs.push(path.join(home, 'AppData', 'Roaming', 'opencode'));
        dirs.push(path.join(home, 'AppData', 'Local', 'opencode'));
    }
    return dirs;
}

/** Pre-seed package.json + lock + node_modules so Npm.install skips reify. */
function seedPluginInstallSkip(configDir) {
    fs.mkdirSync(path.join(configDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'package.json'),
        JSON.stringify({ name: 'sudo-opencode-global', private: true,
            dependencies: { [PLUGIN_PKG]: OPENCODE_VERSION } }, null, 2));
    fs.writeFileSync(
        path.join(configDir, 'package-lock.json'),
        JSON.stringify({ name: 'sudo-opencode-global', lockfileVersion: 3,
            packages: { '': { dependencies: { [PLUGIN_PKG]: OPENCODE_VERSION } } } }, null, 2));
    fs.writeFileSync(path.join(configDir, 'node_modules', '.sudo-keep'),
        'pre-seed: makes opencode skip its background @opencode-ai/plugin npm install (offline).');
}

function buildSpawnEnv(home, config, password) {
    // P8: the parent environment is filtered FIRST: secret-bearing variables
    // never reach the agent process (names counted, values never logged).
    const filtered = sandbox.filterSpawnEnv(process.env);
    const env = filtered.env;
    env.HOME = home;
    env.XDG_DATA_HOME = path.join(home, '.local', 'share');
    env.XDG_CONFIG_HOME = path.join(home, '.config');
    env.XDG_CACHE_HOME = path.join(home, '.cache');
    env.XDG_STATE_HOME = path.join(home, '.local', 'state');
    if (process.platform === 'win32') {
        env.APPDATA = path.join(home, 'AppData', 'Roaming');
        env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
        env.USERPROFILE = home;
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    env.OPENCODE_SERVER_PASSWORD = password;
    env.OPENCODE_SERVER_USERNAME = 'opencode';
    // P3-c: every network path verified in v1.19.0 sources, then disabled.
    env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true';
    env.OPENCODE_DISABLE_LSP_DOWNLOAD = 'true';
    // Belt & suspenders: any missed arborist reify fails instantly, no traffic.
    env.npm_config_registry = 'http://127.0.0.1:9/';
    env.npm_config_fetch_retries = '0';
    env.SUDO_SANDBOX_STRIPPED = String(filtered.stripped.length);
    return env;
}

/**
 * Generated offline-strict opencode.json.
 * local: bundled openai SDK with baseURL override (no npm fetch).
 * cloud: bundled openai-compatible SDK + P2 key (memory only, never a file).
 */
function buildOpenCodeConfig({ providerType, baseUrl, model, apiKey }) {
    const isLocal = providerType !== 'cloud';
    const pid = isLocal ? LOCAL_PROVIDER_ID : CLOUD_PROVIDER_ID;
    const provider = {
        options: { baseURL: baseUrl, apiKey: apiKey || 'local', timeout: 300000 },
        whitelist: [model],
        models: { [model]: { name: model, tool_call: true } },
    };
    if (!isLocal) provider.npm = '@ai-sdk/openai-compatible'; // bundled, no fetch
    return {
        autoupdate: false,
        share: 'disabled',
        enabled_providers: [pid],
        provider: { [pid]: provider },
        model: pid + '/' + model,
        small_model: pid + '/' + model,
        default_agent: 'build',
        permission: {
            edit: 'ask', bash: 'ask', task: 'ask',
            webfetch: 'deny', websearch: 'deny', external_directory: 'deny',
        },
        agent: {
            plan: { mode: 'primary', permission: {
                edit: 'deny', bash: 'deny', task: 'deny',
                webfetch: 'deny', websearch: 'deny', external_directory: 'deny',
            } },
        },
        snapshot: true,
        mcp: {},
    };
}

// ---------------------------------------------------------------- driver

class OpenCodeDriver extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.projectRoot = opts.projectRoot || null;
        this.extensionDir = opts.extensionDir || null;
        this.home = opts.home || globalHome();
        this.binary = opts.binary || null;
        this.port = opts.port || 0;
        this.password = opts.password || crypto.randomBytes(24).toString('hex');
        this.httpClient = opts.httpClient || null; // injectable {get,post} for tests
        this.proc = null;
        this.baseUrl = null;
        this.sseReq = null;
        // P8 sandbox state (reported to the UI badge, never faked).
        this._sandboxKind = null; // l1-posix | l1-win | l2-docker | l2-wsb
        this._sandbox = { level: 'l1', via: 'process', token: false,
            job: false, network: 'open', note: '' };
        this._sandboxTmp = null;
        this._pgid = null;
        this._l2Name = null;
        this._fwAdded = false;
    }

    _resetSandboxState() {
        this._sandbox = { level: 'l1', via: 'process', token: false,
            job: false, network: 'open', note: '' };
    }

    getSandboxState() {
        return Object.assign({}, this._sandbox);
    }

    _http() {
        if (!this.httpClient) this.httpClient = require('axios');
        return this.httpClient;
    }

    _auth() {
        return { username: 'opencode', password: this.password };
    }

    async _api(method, apiPath, body, timeoutMs = 30000) {
        const ax = this._http();
        const url = this.baseUrl + apiPath;
        try {
            if (method === 'GET' || method === 'DELETE') {
                const r = await ax[method === 'GET' ? 'get' : 'delete'](url,
                    { auth: this._auth(), timeout: timeoutMs });
                return r.data;
            }
            const r = await ax.post(url, body === undefined ? {} : body,
                { auth: this._auth(), timeout: timeoutMs });
            return r.data;
        } catch (e) {
            if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')
                throw new Error('opencode server unreachable (' + e.code + ')');
            if (e.response) throw new Error('opencode HTTP ' + e.response.status + ' ' + apiPath);
            throw e;
        }
    }

    async start(providerSpec) {
        if (this.proc) return;
        if (!this.projectRoot || !fs.existsSync(this.projectRoot))
            throw new Error('no project folder open (opencode needs a working directory)');
        const bin = this.binary || resolveBinary(this.extensionDir);
        if (!bin || !fs.existsSync(bin))
            throw new Error('opencode binary not found (packager must ship it, see opencode.manifest.json)');
        this.binary = bin;
        const config = buildOpenCodeConfig(providerSpec);
        for (const dir of configDirCandidates(this.home)) {
            try { seedPluginInstallSkip(dir); } catch (_) { /* best effort */ }
        }
        const env = buildSpawnEnv(this.home, config, this.password);
        // P8: sandbox decision (spec.sandbox set by the engine; legacy plain
        // spawn when absent keeps older callers working).
        const sbx = (providerSpec && providerSpec.sandbox) || {};
        const mode = sbx.mode === 'l1' || sbx.mode === 'l2' ? sbx.mode : 'auto';
        const localOnly = sbx.localOnly !== undefined ? !!sbx.localOnly
            : providerSpec.providerType !== 'cloud';
        this._resetSandboxState();
        if (mode !== 'l1') {
            const det = sandbox.detectL2({ image: sbx.image,
                noCache: !!sbx.noCache, exec: sbx.exec || undefined });
            const pick = sandbox.pickL2(det);
            if (pick.via) {
                await this._startL2(pick.via,
                    { bin, env, localOnly, image: det.image });
                return;
            }
            if (mode === 'l2') {
                this._sandbox.note = 'Sandbox isolee indisponible sur ce poste (' +
                    pick.reason + ')';
            }
        }
        await this._startL1({ bin, env, localOnly });
    }

    async _startL1({ bin, env, localOnly }) {
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            this.port = await findFreePort();
            this.baseUrl = 'http://127.0.0.1:' + this.port;
            this.proc = await this._spawnL1(bin, env, localOnly);
            this.proc.once('error', (e) => { lastErr = e; });
            if (this.proc.stderr) {
                this.proc.stderr.on('data', () => { /* swallowed; server logs live in contained HOME */ });
            }
            if (localOnly && process.platform === 'win32') this._applyFw(bin);
            try {
                await this._waitHealth(30000);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                try { await this._killL1Fast(); } catch (_) {}
                this.proc = null;
            }
        }
        if (!this.proc) throw new Error('opencode server failed to boot: ' + (lastErr && lastErr.message));
        this._sandbox.level = 'l1';
    }

    // P8: guarded spawn (own process group on POSIX so stop() kills the
    // whole tree; factored for the P8 tree-kill proof).
    _spawnGuarded(bin, args, opts = {}) {
        const o = Object.assign({ cwd: this.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }, opts);
        if (process.platform !== 'win32' && o.detached !== false) o.detached = true;
        const proc = spawn(bin, args, o);
        if (o.detached) this._pgid = proc.pid;
        return proc;
    }

    async _spawnL1(bin, env, localOnly) {
        const args = ['serve', '--pure', '--port', String(this.port),
            '--hostname', '127.0.0.1'];
        if (process.platform !== 'win32') {
            this._sandboxKind = 'l1-posix';
            this._sandbox.via = 'process-group';
            if (localOnly) {
                this._sandbox.network = 'open';
                this._sandbox.note = 'filtrage reseau indisponible sur ce systeme (posix)';
            }
            return this._spawnGuarded(bin, args, { cwd: this.projectRoot, env,
                stdio: ['ignore', 'pipe', 'pipe'] });
        }
        return this._spawnL1Win(bin, env, args);
    }

    async _spawnL1Win(bin, env, args) {
        void args;
        this._sandboxKind = 'l1-win';
        this._sandbox.via = 'job';
        try {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-sbx-'));
            this._sandboxTmp = dir;
            const launcher = path.join(dir, 'launcher.ps1');
            const wrapper = path.join(dir, 'run-oc.cmd');
            const resultFile = path.join(dir, 'result.json');
            fs.writeFileSync(launcher, sandbox.buildJobLauncherPs1(), 'utf8');
            fs.writeFileSync(wrapper, sandbox.buildOcWrapperCmd(
                { exe: bin, port: this.port, workDir: this.projectRoot }), 'utf8');
            const probe = sandbox.runasProbe();
            const childEnv = Object.assign({}, env, { SUDO_SANDBOX_PORT: String(this.port) });
            const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
                '-Exe', bin, '-WorkDir', this.projectRoot, '-Wrapper', wrapper,
                '-ResultFile', resultFile];
            if (probe.supported) psArgs.push('-TokenLow');
            const proc = spawn('powershell.exe', psArgs,
                { cwd: this.projectRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
            const t0 = Date.now();
            let res = null;
            while (Date.now() - t0 < 15000) {
                try { res = JSON.parse(fs.readFileSync(resultFile, 'utf8')); break; }
                catch (_) { /* not written yet */ }
                if (proc.exitCode != null) break;
                await new Promise((r) => setTimeout(r, 200));
            }
            if (res && res.pid) {
                this._sandbox.token = !!res.token;
                this._sandbox.job = !!res.job;
                if (res.note) this._sandbox.note = 'lanceur: ' + res.note;
                return proc;
            }
            try { proc.kill(); } catch (_) {}
        } catch (_) { /* fall through to plain spawn */ }
        // Fallback: plain spawn, honestly reported (no job, no token).
        this._cleanupSandboxTmp();
        this._sandbox.via = 'process';
        this._sandbox.note = 'job indisponible (repli sans isolation processus)';
        return spawn(bin, ['serve', '--pure', '--port', String(this.port),
            '--hostname', '127.0.0.1'],
        { cwd: this.projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    }

    _applyFw(bin) {
        try {
            const { execFileSync } = require('child_process');
            execFileSync('powershell.exe', sandbox.buildFwAddArgs(bin),
                { timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'] });
            this._fwAdded = true;
            this._sandbox.network = 'blocked';
        } catch (_) {
            this._fwAdded = false;
            this._sandbox.network = 'open';
            const note = 'pare-feu refuse (droits admin requis?)';
            this._sandbox.note = this._sandbox.note ? this._sandbox.note + ' ; ' + note : note;
        }
    }

    async _startL2(via, o) {
        this.port = await findFreePort();
        this._sandbox.level = 'l2';
        if (via === 'docker') return this._startL2Docker(o);
        return this._startL2Wsb(o);
    }

    async _startL2Docker({ env, localOnly, image }) {
        const pairs = Object.entries(sandbox.pickContainerEnv(env));
        const name = 'sudo-studio-' + Date.now();
        const spec = sandbox.buildDockerSpawn({ image, projectRoot: this.projectRoot,
            port: this.port, localOnly, name, envPairs: pairs });
        this._sandboxKind = 'l2-docker';
        this._sandbox.via = 'docker';
        this._sandbox.network = localOnly ? 'blocked' : 'open';
        this._l2Name = name;
        this.baseUrl = 'http://127.0.0.1:' + this.port;
        this.proc = spawn(spec.bin, spec.args,
            { cwd: this.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        if (this.proc.stderr) this.proc.stderr.on('data', () => {});
        let lastErr = null;
        this.proc.once('error', (e) => { lastErr = e; });
        try {
            await this._waitHealth(60000);
        } catch (e) {
            try { await this._dockerRm(name); } catch (_) {}
            try { this.proc.kill(); } catch (_) {}
            this.proc = null;
            throw new Error('sandbox docker: ' + (e && e.message) +
                (lastErr ? ' (' + lastErr.message + ')' : ''));
        }
    }

    _dockerRm(name) {
        return new Promise((resolve) => {
            try {
                const { execFile } = require('child_process');
                execFile('docker', ['rm', '-f', name], { timeout: 20000 }, () => resolve());
            } catch (_) { resolve(); }
        });
    }

    async _startL2Wsb({ bin, env, localOnly }) {
        const ocDir = path.dirname(bin);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-sbx-'));
        this._sandboxTmp = dir;
        const bundle = sandbox.buildWsbBundle({ projectRoot: this.projectRoot,
            ocDir, genDir: dir, port: this.port });
        fs.writeFileSync(path.join(dir, 'bootstrap.ps1'), bundle.bootstrapPs1, 'utf8');
        fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({
            env: sandbox.pickContainerEnv(env), port: this.port, localOnly: !!localOnly,
        }), 'utf8');
        const wsbFile = path.join(dir, 'run.wsb');
        fs.writeFileSync(wsbFile, bundle.wsbXml, 'utf8');
        this._sandboxKind = 'l2-wsb';
        this._sandbox.via = 'wsb';
        this._sandbox.network = 'open';
        const sysRoot = process.env.SystemRoot || 'C:\\Windows';
        const wsbBin = path.join(sysRoot, 'System32', 'WindowsSandbox.exe');
        this.proc = spawn(wsbBin, [wsbFile], { cwd: this.projectRoot, stdio: 'ignore' });
        const ipFile = path.join(this.projectRoot, '.sudo-sandbox-ip');
        const netFile = path.join(this.projectRoot, '.sudo-sandbox-net');
        const t0 = Date.now();
        let ips = [];
        while (Date.now() - t0 < 240000) {
            try {
                const raw = fs.readFileSync(ipFile, 'utf8');
                ips = raw.split(/\r?\n/).map((s) => s.trim())
                    .filter((s) => /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(s));
                if (ips.length) break;
            } catch (_) { /* guest booting */ }
            if (this.proc.exitCode != null) break;
            await new Promise((r) => setTimeout(r, 1000));
        }
        try {
            const flag = fs.readFileSync(netFile, 'utf8').trim();
            this._sandbox.network = flag === 'blocked' ? 'blocked' : 'open';
        } catch (_) { this._sandbox.network = 'open'; }
        if (!ips.length) {
            this._cleanupWsbFiles(ipFile, netFile);
            throw new Error('sandbox wsb: guest bootstrap timed out (no IP published)');
        }
        try {
            await this._waitHealthAddrs(ips, 120000);
        } catch (e) {
            this._cleanupWsbFiles(ipFile, netFile);
            throw e;
        }
        this._cleanupWsbFiles(ipFile, netFile);
    }

    _cleanupWsbFiles(...files) {
        for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} }
    }

    async _waitHealthAddrs(ips, ms) {
        const t0 = Date.now();
        let last = null;
        let i = 0;
        while (Date.now() - t0 < ms) {
            this.baseUrl = 'http://' + ips[i % ips.length] + ':' + this.port;
            try {
                const h = await this._api('GET', '/global/health', null, 3000);
                if (h && h.healthy === true) {
                    this._assertVersion(h);
                    return;
                }
            } catch (e) { last = e; }
            i++;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw last || new Error('health timeout');
    }

    async _waitHealth(ms) {
        const t0 = Date.now();
        let last = null;
        while (Date.now() - t0 < ms) {
            try {
                const h = await this._api('GET', '/global/health', null, 3000);
                if (h && h.healthy === true) {
                    if (h.version !== OPENCODE_VERSION)
                        throw new Error('opencode version mismatch: got ' + h.version +
                            ', pinned ' + OPENCODE_VERSION + ' (update opencode.manifest.json)');
                    return;
                }
            } catch (e) { last = e; }
            await new Promise(r => setTimeout(r, 400));
        }
        throw last || new Error('health timeout');
    }

    _assertVersion(h) {
        if (h.version !== OPENCODE_VERSION)
            throw new Error('opencode version mismatch: got ' + h.version +
                ', pinned ' + OPENCODE_VERSION + ' (update opencode.manifest.json)');
    }

    async _killL1Fast() {
        const p = this.proc;
        if (!p) return;
        try {
            if (process.platform === 'win32') {
                const { execFileSync } = require('child_process');
                try {
                    execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'],
                        { timeout: 10000, stdio: ['ignore', 'ignore', 'ignore'] });
                } catch (_) { try { p.kill('SIGKILL'); } catch (_) {} }
            } else if (this._pgid) {
                try { process.kill(-this._pgid, 'SIGKILL'); } catch (_) {}
            } else {
                try { p.kill('SIGKILL'); } catch (_) {}
            }
        } catch (_) { /* already gone */ }
    }

    _cleanupSandboxTmp() {
        if (!this._sandboxTmp) return;
        const dir = this._sandboxTmp;
        this._sandboxTmp = null;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }

    async stop() {
        this.stopEvents();
        const p = this.proc;
        this.proc = null;
        this.baseUrl = null;
        const kind = this._sandboxKind;
        this._sandboxKind = null;
        // P8: every sandbox resource is released (firewall, container, files).
        if (this._fwAdded) {
            this._fwAdded = false;
            try {
                const { execFileSync } = require('child_process');
                execFileSync('powershell.exe', sandbox.buildFwRemoveArgs(),
                    { timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'] });
            } catch (_) { /* best effort */ }
        }
        if (this._l2Name) {
            const name = this._l2Name;
            this._l2Name = null;
            try { await this._dockerRm(name); } catch (_) {}
        }
        if (kind === 'l2-wsb' && this.projectRoot) {
            this._cleanupWsbFiles(path.join(this.projectRoot, '.sudo-sandbox-ip'),
                path.join(this.projectRoot, '.sudo-sandbox-net'));
        }
        if (!p) { this._cleanupSandboxTmp(); return; }
        try {
            if (kind === 'l1-win' || (kind == null && process.platform === 'win32')) {
                await this._killWinTree(p);
            } else if (kind === 'l1-posix' || kind == null) {
                await this._killPosixTree(p);
            } else {
                // L2 guests die via docker rm / client kill; also signal the wrapper.
                try { p.kill(); } catch (_) {}
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, 5000);
                    p.once('exit', () => { clearTimeout(t); resolve(); });
                });
            }
        } catch (_) { /* already gone */ }
        this._cleanupSandboxTmp();
    }

    _killWinTree(p) {
        return new Promise((resolve) => {
            try {
                const { execFile } = require('child_process');
                // The job close already kills the tree; taskkill /T covers
                // fallback spawns that escaped the job.
                execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'],
                    { timeout: 15000 }, () => resolve());
            } catch (_) { resolve(); }
            try { p.kill(); } catch (_) {}
        }).then(() => new Promise((resolve) => {
            if (p.exitCode != null) return resolve();
            const t = setTimeout(resolve, 5000);
            p.once('exit', () => { clearTimeout(t); resolve(); });
        }));
    }

    _killPosixTree(p) {
        return new Promise((resolve) => {
            const pgid = this._pgid;
            this._pgid = null;
            try {
                if (pgid) process.kill(-pgid, 'SIGTERM');
                else p.kill();
            } catch (_) { /* already gone */ }
            const t = setTimeout(() => {
                try {
                    if (pgid) process.kill(-pgid, 'SIGKILL');
                    else p.kill('SIGKILL');
                } catch (_) { /* already gone */ }
                resolve();
            }, 8000);
            p.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }

    get running() { return !!this.proc; }

    // -- sessions / messages -------------------------------------------------
    createSession(title) {
        return this._api('POST', '/session', { title: String(title || '').slice(0, 80) });
    }
    getSession(id) {
        return this._api('GET', '/session/' + id);
    }
    deleteSession(id) {
        return this._api('DELETE', '/session/' + id);
    }
    abortSession(id) {
        return this._api('POST', '/session/' + id + '/abort');
    }
    getDiff(id) {
        return this._api('GET', '/session/' + id + '/diff');
    }
    revertMessage(id, messageID) {
        return this._api('POST', '/session/' + id + '/revert', { messageID });
    }
    getStatus() {
        return this._api('GET', '/session/status');
    }
    getConfig() {
        return this._api('GET', '/config');
    }
    postMessage(id, body, timeoutMs = 1200000) {
        return this._api('POST', '/session/' + id + '/message', body, timeoutMs);
    }
    replyPermission(id, permissionID, response) {
        if (!['once', 'always', 'reject'].includes(response))
            throw new Error('bad permission response: ' + response);
        return this._api('POST', '/session/' + id + '/permissions/' + permissionID, { response });
    }

    // -- events (SSE) ----------------------------------------------------------
    startEvents() {
        if (this.sseReq || !this.baseUrl) return;
        const headers = { Authorization: 'Basic ' +
            Buffer.from('opencode:' + this.password).toString('base64'), Accept: 'text/event-stream' };
        const req = http.get(this.baseUrl + '/event', { headers }, (res) => {
            let buf = '';
            res.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const raw = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const m = raw.match(/^data:\s*(.*)$/m);
                    if (!m) continue;
                    try {
                        const ev = JSON.parse(m[1]);
                        this.emit('bus', ev);
                        if (ev && ev.type === 'permission.updated') this.emit('permission', ev.properties);
                    } catch (_) { /* partial frame */ }
                }
            });
            res.on('close', () => this.emit('event-error', new Error('sse closed')));
            res.on('error', (e) => this.emit('event-error', e));
        });
        req.on('error', (e) => this.emit('event-error', e));
        this.sseReq = req;
    }

    stopEvents() {
        try { if (this.sseReq) this.sseReq.destroy(); } catch (_) {}
        this.sseReq = null;
    }
}

module.exports = {
    OpenCodeDriver, buildOpenCodeConfig, buildSpawnEnv, seedPluginInstallSkip,
    resolveBinary, findFreePort, globalHome, configDirCandidates,
    OPENCODE_VERSION, LOCAL_PROVIDER_ID, CLOUD_PROVIDER_ID, RUNTIME_BASE_URL,
};
