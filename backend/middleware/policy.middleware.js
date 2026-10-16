/**
 * SUDO STUDIO - P15 3b: policy enforcement middleware (backend side).
 * Usage: router.post('/api/models/download', verifyToken, requireModelAllowed, handler).
 * requireCloudAllowed guards any route that would call a user-supplied cloud
 * base URL (no such backend route exists today; enforced + tested at module level).
 */
'use strict';

const policy = require('../src/policy/policy');

function requireModelAllowed(req, res, next) {
    const body = req.body || {};
    const model = body.model || body.modelId || body.name;
    if (!policy.isModelAllowed(model)) {
        return res.status(403).json({
            error: policy.POLICY_MSG_MODEL, model: model || null, policy: 'allowedModels',
        });
    }
    return next();
}

function requireCloudAllowed(req, res, next) {
    const body = req.body || {};
    const baseUrl = body.baseUrl || body.baseURL
        || (body.provider && (body.provider.baseUrl || body.provider.baseURL));
    const chk = policy.isCloudHostAllowed(baseUrl);
    if (!chk.ok) {
        return res.status(403).json({ error: chk.error, policy: 'cloudPolicy' });
    }
    return next();
}

module.exports = { requireModelAllowed, requireCloudAllowed };
