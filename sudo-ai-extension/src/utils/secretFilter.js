/**
 * SUDO STUDIO - Pre-send secret filter (MISSION P2-f).
 * Masks secrets in text sent to CLOUD providers. Reuses the shared
 * SECRET_PATTERNS (same list as the workspace security scanner).
 * Pure, no vscode dependency, unit-testable. ASCII-only.
 */
'use strict';

const SECRET_PATTERNS = require('./secretPatterns');

function _global(re) {
    const f = re.flags || '';
    return new RegExp(re.source, f.includes('g') ? f : f + 'g');
}

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(p => ({ label: p.label, re: _global(p.re) }));

/**
 * Replace every detected secret with [SECRET MASQUE:<label>].
 * @returns {{text: string, masked: string[]}} masked labels (deduped).
 */
function maskSecrets(text) {
    if (typeof text !== 'string' || !text) return { text: text || '', masked: [] };
    let out = text;
    const masked = [];
    for (const { label, re } of GLOBAL_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(out)) {
            masked.push(label);
            re.lastIndex = 0;
            out = out.replace(re, '[SECRET MASQUE:' + label + ']');
        }
    }
    return { text: out, masked };
}

module.exports = { maskSecrets };
