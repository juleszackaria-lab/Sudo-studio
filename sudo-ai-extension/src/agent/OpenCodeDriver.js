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
    const env = Object.assign({}, process.env);
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
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            this.port = await findFreePort();
            this.baseUrl = 'http://127.0.0.1:' + this.port;
            this.proc = spawn(bin, ['serve', '--pure', '--port', String(this.port),
                '--hostname', '127.0.0.1'], { cwd: this.projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
            this.proc.once('error', (e) => { lastErr = e; });
            this.proc.stderr.on('data', () => { /* swallowed; server logs live in contained HOME */ });
            try {
                await this._waitHealth(30000);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                try { this.proc.kill(); } catch (_) {}
                this.proc = null;
            }
        }
        if (!this.proc) throw new Error('opencode server failed to boot: ' + (lastErr && lastErr.message));
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

    async stop() {
        this.stopEvents();
        const p = this.proc;
        this.proc = null;
        this.baseUrl = null;
        if (!p) return;
        try {
            p.kill();
            await new Promise((resolve) => {
                const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(); }, 8000);
                p.once('exit', () => { clearTimeout(t); resolve(); });
            });
        } catch (_) { /* already gone */ }
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
