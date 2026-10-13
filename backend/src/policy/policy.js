/**
 * SUDO STUDIO - P15 3b: backend-side admin policy checks.
 * Reads the SAME stores as the extension ($SUDO_STUDIO_HOME/.sudo_studio/central/):
 * - central_policies.json (allowedModels) — mirrors CentralMgmtPanel.isModelAllowed
 * - cloud_policy.json (cloudEnabled + whitelist) — mirrors AIProviderService.checkCloudAllowed
 * Empty/missing lists keep the extension semantics (models: allow all; cloud: disabled).
 * ASCII-only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const POLICY_MSG_MODEL = 'Modele bloque par la politique administrateur';
const POLICY_MSG_CLOUD = 'Fournisseur cloud non autorise par la politique administrateur';

function centralDir() {
    return path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio', 'central');
}

function readStore(file) {
    try {
        const raw = fs.readFileSync(path.join(centralDir(), file), 'utf8');
        const d = JSON.parse(raw);
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
    } catch (_) {
        return null;
    }
}

function getAllowedModels() {
    const d = readStore('central_policies.json');
    if (!d || !Array.isArray(d.allowedModels)) return [];
    return d.allowedModels.filter((x) => typeof x === 'string');
}

function isModelAllowed(modelId) {
    const list = getAllowedModels();
    if (!list.length) return true;
    const m = String(modelId || '').trim().toLowerCase();
    if (!m) return false;
    return list.some((a) => String(a).trim().toLowerCase() === m);
}

function getCloudPolicy() {
    const dflt = { cloudEnabled: false, whitelist: [] };
    const d = readStore('cloud_policy.json');
    if (!d) return dflt;
    return {
        cloudEnabled: d.cloudEnabled === true,
        whitelist: Array.isArray(d.whitelist) ? d.whitelist.filter((x) => typeof x === 'string') : [],
    };
}

function isCloudHostAllowed(baseUrl) {
    const pol = getCloudPolicy();
    if (!pol.cloudEnabled) return { ok: false, error: POLICY_MSG_CLOUD };
    let host = '';
    try {
        host = new URL(String(baseUrl)).hostname.toLowerCase();
    } catch (_) {
        return { ok: false, error: POLICY_MSG_CLOUD };
    }
    const allowed = pol.whitelist
        .map((w) => String(w).toLowerCase())
        .some((w) => w && (host === w || host.endsWith('.' + w)));
    if (!allowed) return { ok: false, error: POLICY_MSG_CLOUD };
    return { ok: true };
}

module.exports = {
    centralDir, getAllowedModels, isModelAllowed,
    getCloudPolicy, isCloudHostAllowed,
    POLICY_MSG_MODEL, POLICY_MSG_CLOUD,
};
