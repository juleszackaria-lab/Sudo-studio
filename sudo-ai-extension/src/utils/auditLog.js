/**
 * SUDO STUDIO - Shared audit log (TASK 7g).
 * Single append-only store for ALL enterprise panel actions:
 * ~/.sudo_studio/central/audit.json (keeps last 500 entries).
 * Entry: { ts, actor, action, detail, result, verified }.
 * SUDO_STUDIO_HOME env override exists for hermetic tests only.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function getCentralDir() {
    const d = path.join(process.env.SUDO_STUDIO_HOME || os.homedir(), '.sudo_studio', 'central');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

function appendAudit(action, detail, opts = {}) {
    const file = path.join(getCentralDir(), 'audit.json');
    let log = [];
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) log = parsed;
    } catch { /* missing or corrupt -> start fresh, never crash the caller */ }
    log.unshift({
        ts:       new Date().toISOString(),
        actor:    opts.actor || 'admin',
        action:   String(action || 'UNKNOWN'),
        detail:   String(detail || ''),
        result:   opts.result || 'ok',
        verified: opts.verified === true,
    });
    try {
        fs.writeFileSync(file, JSON.stringify(log.slice(0, 500), null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

function getAuditLog(limit = 500) {
    try {
        const raw = fs.readFileSync(path.join(getCentralDir(), 'audit.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
    } catch {
        return [];
    }
}

module.exports = { appendAudit, getAuditLog, getCentralDir };
