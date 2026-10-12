/**
 * SUDO STUDIO - AI provider registry (MISSION P2 a,b,c,d,f,g).
 *
 * Providers: "Local (runtime)" (type local, offline) + custom OpenAI-compatible
 * endpoints {name, baseUrl, model} whose API key lives ONLY in VS Code
 * SecretStorage (never in files, logs, or audit). Shared by the agent and
 * the chat through complete(). Admin cloud policy (enabled + domain
 * whitelist) is enforced on every cloud use. Cloud payloads pass the secret
 * filter first (maskSecrets). Every outgoing call is audited (metadata only,
 * never message content) in the shared audit store.
 *
 * No vscode import: secrets/storage/http are injectable for plain-node tests.
 * ASCII-only source (project rule).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { maskSecrets } = require('../utils/secretFilter');
const { appendAudit, getCentralDir } = require('../utils/auditLog');
const { getSecretsStore } = require('./extensionContext');

const POLICY_MSG = "Interdit par la politique de l'administrateur";
const LOCAL_ID = 'local';
const RUNTIME_URL = 'http://127.0.0.1:6000';

function defaultActor() {
    try { return (os.userInfo() && os.userInfo().username) || 'local-user'; }
    catch (_) { return 'local-user'; }
}

function cleanStr(s, maxLen) {
    if (typeof s !== 'string') return '';
    return s.trim().slice(0, maxLen);
}

function normalizeBaseUrl(raw) {
    const s = cleanStr(raw, 500);
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
}

class AIProviderService {
    constructor(opts) {
        opts = opts || {};
        const central = opts.centralDir || getCentralDir();
        this.storePath = opts.storePath || path.join(central, 'ai_providers.json');
        this.policyPath = opts.policyPath || path.join(central, 'cloud_policy.json');
        this.secretsStore = opts.secretsStore || null; // lazy: extensionContext
        this.httpClient = opts.httpClient || null;     // lazy: axios
        this.runtimeUrl = opts.runtimeUrl || RUNTIME_URL;
        this.actor = opts.actor || defaultActor();
    }

    _secrets() {
        if (!this.secretsStore) this.secretsStore = getSecretsStore();
        return this.secretsStore;
    }

    _http() {
        if (!this.httpClient) this.httpClient = require('axios');
        return this.httpClient;
    }

    _audit(action, detail, result) {
        try { appendAudit(action, detail, { actor: this.actor, result, verified: true }); }
        catch (_) { /* audit must never break the caller */ }
    }

    // -- store ---------------------------------------------------------------
    _readStore() {
        const dflt = { providers: [], activeId: LOCAL_ID, filterEnabled: true };
        try {
            const raw = fs.readFileSync(this.storePath, 'utf8');
            const d = JSON.parse(raw);
            if (!d || !Array.isArray(d.providers)) return dflt;
            return {
                providers: d.providers,
                activeId: typeof d.activeId === 'string' ? d.activeId : LOCAL_ID,
                filterEnabled: d.filterEnabled !== false,
            };
        } catch (_) { return dflt; }
    }

    _writeStore(data) {
        try {
            fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
            fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (_) { return false; }
    }

    getCloudPolicy() {
        const dflt = { cloudEnabled: false, whitelist: [], updatedAt: null, updatedBy: null };
        try {
            const d = JSON.parse(fs.readFileSync(this.policyPath, 'utf8'));
            if (!d || typeof d !== 'object') return dflt;
            return {
                cloudEnabled: d.cloudEnabled === true,
                whitelist: Array.isArray(d.whitelist) ? d.whitelist.filter(x => typeof x === 'string') : [],
                updatedAt: d.updatedAt || null,
                updatedBy: d.updatedBy || null,
            };
        } catch (_) { return dflt; }
    }

    saveCloudPolicy({ cloudEnabled, whitelist, updatedBy }) {
        const clean = (Array.isArray(whitelist) ? whitelist : [])
            .map(w => String(w).trim().toLowerCase().replace(/\/.*$/, ''))
            .filter(w => w && w.indexOf(' ') === -1);
        const data = {
            cloudEnabled: cloudEnabled === true,
            whitelist: [...new Set(clean)],
            updatedAt: new Date().toISOString(),
            updatedBy: String(updatedBy || 'admin'),
        };
        try {
            fs.mkdirSync(path.dirname(this.policyPath), { recursive: true });
            fs.writeFileSync(this.policyPath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            return { ok: false, error: 'write failed: ' + e.message };
        }
        // Verify after write.
        const back = this.getCloudPolicy();
        if (back.cloudEnabled !== data.cloudEnabled) {
            return { ok: false, error: 'verify after write failed' };
        }
        this._audit('ai.cloud_policy',
            'cloudEnabled=' + data.cloudEnabled + ' whitelist=[' + data.whitelist.join(',') + '] by=' + data.updatedBy,
            'ok');
        return { ok: true, policy: back };
    }

    // -- providers CRUD (metadata only; keys stay in SecretStorage) ---------
    listProviders() {
        const s = this._readStore();
        const local = { id: LOCAL_ID, type: 'local', name: 'Local (runtime)', baseUrl: this.runtimeUrl, model: '(modele charge)' };
        const customs = s.providers.map(p => ({
            id: p.id, type: 'cloud', name: p.name, baseUrl: p.baseUrl,
            model: p.model, createdAt: p.createdAt || null, hasKey: true,
        }));
        return { providers: [local, ...customs], activeId: s.activeId, filterEnabled: s.filterEnabled };
    }

    getActive() {
        const { providers, activeId } = this.listProviders();
        return providers.find(p => p.id === activeId) || providers[0];
    }

    async addProvider({ name, baseUrl, model }, apiKey) {
        name = cleanStr(name, 60);
        model = cleanStr(model, 120);
        const url = normalizeBaseUrl(baseUrl);
        if (!name) return { ok: false, error: 'name required (1-60 chars)' };
        if (!url) return { ok: false, error: 'baseUrl must be an http(s) URL' };
        if (!model) return { ok: false, error: 'model required' };
        if (typeof apiKey !== 'string' || !apiKey) return { ok: false, error: 'apiKey required' };
        const s = this._readStore();
        if (s.providers.some(p => p.name.toLowerCase() === name.toLowerCase())) {
            return { ok: false, error: 'a provider with this name already exists' };
        }
        const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        await this._secrets().store('sudoAi.provider.' + id, apiKey);
        s.providers.push({ id, name, baseUrl: url, model, createdAt: new Date().toISOString() });
        if (!this._writeStore(s)) {
            try { await this._secrets().delete('sudoAi.provider.' + id); } catch (_) { /* ignore */ }
            return { ok: false, error: 'store write failed, key rolled back' };
        }
        this._audit('ai.provider_add', 'provider=' + name + ' baseUrl=' + url + ' model=' + model, 'ok');
        return { ok: true, id };
    }

    async updateProvider(id, { name, baseUrl, model }, newKey) {
        const s = this._readStore();
        const p = s.providers.find(x => x.id === id);
        if (!p) return { ok: false, error: 'provider not found' };
        if (name !== undefined) {
            name = cleanStr(name, 60);
            if (!name) return { ok: false, error: 'name required' };
            if (s.providers.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
                return { ok: false, error: 'a provider with this name already exists' };
            }
            p.name = name;
        }
        if (baseUrl !== undefined) {
            const url = normalizeBaseUrl(baseUrl);
            if (!url) return { ok: false, error: 'baseUrl must be an http(s) URL' };
            p.baseUrl = url;
        }
        if (model !== undefined) {
            model = cleanStr(model, 120);
            if (!model) return { ok: false, error: 'model required' };
            p.model = model;
        }
        if (typeof newKey === 'string' && newKey) {
            await this._secrets().store('sudoAi.provider.' + id, newKey);
        }
        if (!this._writeStore(s)) return { ok: false, error: 'store write failed' };
        this._audit('ai.provider_update', 'provider=' + p.name + ' id=' + id, 'ok');
        return { ok: true };
    }

    async deleteProvider(id) {
        if (id === LOCAL_ID) return { ok: false, error: 'cannot delete Local (runtime)' };
        const s = this._readStore();
        const idx = s.providers.findIndex(x => x.id === id);
        if (idx === -1) return { ok: false, error: 'provider not found' };
        const [gone] = s.providers.splice(idx, 1);
        if (s.activeId === id) s.activeId = LOCAL_ID;
        if (!this._writeStore(s)) return { ok: false, error: 'store write failed' };
        try { await this._secrets().delete('sudoAi.provider.' + id); } catch (_) { /* ignore */ }
        this._audit('ai.provider_delete', 'provider=' + (gone && gone.name) + ' id=' + id, 'ok');
        return { ok: true };
    }

    setActive(id) {
        const { providers } = this.listProviders();
        const p = providers.find(x => x.id === id);
        if (!p) return { ok: false, error: 'provider not found' };
        if (p.type !== 'local') {
            const chk = this.checkCloudAllowed(p);
            if (!chk.ok) {
                this._audit('ai.provider_select', 'provider=' + p.name + ' refused', 'refused_policy');
                return { ok: false, error: chk.error };
            }
        }
        const s = this._readStore();
        s.activeId = id;
        if (!this._writeStore(s)) return { ok: false, error: 'store write failed' };
        this._audit('ai.provider_select', 'provider=' + p.name + ' id=' + id, 'ok');
        return { ok: true };
    }

    setFilterEnabled(on) {
        const s = this._readStore();
        s.filterEnabled = on !== false;
        if (!this._writeStore(s)) return { ok: false, error: 'store write failed' };
        this._audit('ai.filter_toggle', 'filterEnabled=' + s.filterEnabled, 'ok');
        return { ok: true, filterEnabled: s.filterEnabled };
    }

    // -- policy ---------------------------------------------------------------
    checkCloudAllowed(provider) {
        const pol = this.getCloudPolicy();
        if (!pol.cloudEnabled) return { ok: false, error: POLICY_MSG };
        let host = '';
        try { host = new URL(provider.baseUrl).hostname.toLowerCase(); } catch (_) { return { ok: false, error: POLICY_MSG }; }
        const list = pol.whitelist.map(w => String(w).toLowerCase());
        const allowed = list.some(w => w && (host === w || host.endsWith('.' + w)));
        if (!allowed) return { ok: false, error: POLICY_MSG };
        return { ok: true };
    }

    // -- live calls ------------------------------------------------------------
    async testConnection(id) {
        const { providers } = this.listProviders();
        const p = providers.find(x => x.id === id);
        if (!p) return { ok: false, error: 'provider not found' };
        const ax = this._http();
        if (p.type === 'local') {
            try {
                const r = await ax.get(this.runtimeUrl + '/v1/models', { timeout: 10000 });
                const ids = ((r.data && r.data.data) || []).map(m => m.id);
                this._audit('ai.provider_test', 'provider=Local (runtime) models=' + ids.length, 'ok');
                return { ok: true, models: ids };
            } catch (e) {
                const msg = (e.response && ('HTTP ' + e.response.status)) || e.code || e.message;
                this._audit('ai.provider_test', 'provider=Local (runtime) error=' + msg, 'error');
                return { ok: false, error: String(msg) };
            }
        }
        const chk = this.checkCloudAllowed(p);
        if (!chk.ok) {
            this._audit('ai.provider_test', 'provider=' + p.name + ' refused', 'refused_policy');
            return { ok: false, error: chk.error };
        }
        let key;
        try { key = await this._secrets().get('sudoAi.provider.' + id); } catch (e) { key = null; }
        if (!key) {
            this._audit('ai.provider_test', 'provider=' + p.name + ' error=no key in SecretStorage', 'error');
            return { ok: false, error: 'no API key in SecretStorage for this provider' };
        }
        try {
            const r = await ax.get(p.baseUrl + '/v1/models', {
                headers: { Authorization: 'Bearer ' + key }, timeout: 10000,
            });
            const data = r.data && (r.data.data || r.data.models);
            const ids = Array.isArray(data) ? data.map(m => (m && (m.id || m.name)) || '?') : [];
            this._audit('ai.provider_test', 'provider=' + p.name + ' models=' + ids.length, 'ok');
            return { ok: true, models: ids.slice(0, 20) };
        } catch (e) {
            const msg = (e.response && ('HTTP ' + e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 120)))
                || e.code || e.message;
            this._audit('ai.provider_test', 'provider=' + p.name + ' error=' + String(msg).slice(0, 160), 'error');
            return { ok: false, error: String(msg).slice(0, 300) };
        }
    }

    /**
     * Shared completion for agent + chat.
     * - cloud active: policy -> secret filter -> direct OpenAI call -> audit.
     * - local active: delegate to caller localFn (existing path untouched) -> audit.
     */
    async complete({ messages, prompt, systemContext, max_tokens, temperature, purpose, localFn }) {
        const active = this.getActive();
        const purposeTag = cleanStr(purpose, 24) || 'chat';
        let msgs = Array.isArray(messages) ? messages : null;
        if (!msgs) {
            msgs = [];
            if (systemContext) msgs.push({ role: 'system', content: String(systemContext) });
            msgs.push({ role: 'user', content: String(prompt !== undefined ? prompt : '') });
        }
        const mt = Math.max(1, Math.min(4096, parseInt(max_tokens, 10) || 512));
        const tp = (typeof temperature === 'number' && isFinite(temperature)) ? temperature : 0.1;

        if (!active || active.type === 'local') {
            if (typeof localFn !== 'function') throw new Error('no local path provided');
            const r = await localFn();
            const tokens = (r && r.usage && (r.usage.total_tokens !== undefined))
                ? String(r.usage.total_tokens) : 'unknown';
            this._audit('ai.outgoing_call',
                'provider=Local (runtime) model=' + ((r && r.model) || '?') + ' tokens=' + tokens + ' purpose=' + purposeTag,
                (r && r.ok === false) ? 'error' : 'ok');
            return { ok: !(r && r.ok === false), reply: (r && (r.reply || r.response)) || '', raw: r, provider: 'local', masked: [] };
        }

        const chk = this.checkCloudAllowed(active);
        if (!chk.ok) {
            this._audit('ai.outgoing_call', 'provider=' + active.name + ' refused', 'refused_policy');
            throw new Error(chk.error);
        }
        // P2-f: filter BEFORE sending (cloud only).
        const { filterEnabled } = this.listProviders();
        let masked = [];
        const outMsgs = msgs.map(m => {
            const c = (m && typeof m.content === 'string') ? m.content : String((m && m.content) || '');
            if (!filterEnabled) return { role: (m && m.role) || 'user', content: c };
            const f = maskSecrets(c);
            masked = masked.concat(f.masked.filter(x => !masked.includes(x)));
            return { role: (m && m.role) || 'user', content: f.text };
        });
        let key;
        try { key = await this._secrets().get('sudoAi.provider.' + active.id); } catch (e) { key = null; }
        if (!key) {
            this._audit('ai.outgoing_call', 'provider=' + active.name + ' error=no key', 'error');
            throw new Error('no API key in SecretStorage for provider ' + active.name);
        }
        const ax = this._http();
        let reply = '', usage = null;
        try {
            const r = await ax.post(active.baseUrl + '/v1/chat/completions', {
                model: active.model, messages: outMsgs, temperature: tp, max_tokens: mt,
            }, { headers: { Authorization: 'Bearer ' + key }, timeout: 120000 });
            const ch = r.data && r.data.choices && r.data.choices[0];
            reply = (ch && ch.message && ch.message.content) || (ch && ch.text) || '';
            usage = (r.data && r.data.usage) || null;
        } catch (e) {
            const msg = (e.response && ('HTTP ' + e.response.status)) || e.code || e.message;
            this._audit('ai.outgoing_call',
                'provider=' + active.name + ' model=' + active.model + ' tokens=unknown purpose=' + purposeTag, 'error');
            throw new Error('cloud provider error (' + active.name + '): ' + msg);
        }
        const tokens = usage && usage.total_tokens !== undefined ? String(usage.total_tokens) : 'unknown';
        this._audit('ai.outgoing_call',
            'provider=' + active.name + ' model=' + active.model + ' tokens=' + tokens + ' purpose=' + purposeTag, 'ok');
        return { ok: true, reply, model: active.model, usage, provider: active.id, masked };
    }

    previewFilter(text) {
        return maskSecrets(String(text !== undefined ? text : ''));
    }
}

// -- singleton (shares config across agent + chat) ------------------------------
let _instance = null;
function getAIProviderService(opts) {
    if (!_instance) _instance = new AIProviderService(opts);
    return _instance;
}
function _resetAIProviderServiceForTests() { _instance = null; }

module.exports = {
    AIProviderService, getAIProviderService, _resetAIProviderServiceForTests,
    POLICY_MSG, LOCAL_ID,
};
