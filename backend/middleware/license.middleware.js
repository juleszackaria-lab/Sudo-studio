/**
 * SUDO STUDIO - PROMPT 11: license enforcement middleware (backend side).
 * Usage: router.post('/api/x', verifyToken, requireFeature('central'), handler).
 * No license (or invalid/expired) degrades to Community: base features stay
 * open, team/enterprise features answer 403 with the required edition.
 */
'use strict';

const lic = require('../src/license/license');

function requireFeature(feature) {
    return (req, res, next) => {
        let g;
        try {
            g = lic.guardFeature(feature);
        } catch {
            return res.status(500).json({ error: 'License check failed' });
        }
        if (g.allowed) return next();
        return res.status(403).json({ error: g.message, feature, edition: g.edition, need: g.need });
    };
}

module.exports = { requireFeature };
