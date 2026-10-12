/**
 * SUDO STUDIO - Extension context holder (MISSION P2-c).
 * Panels only receive extensionUri, so SecretStorage is exposed through this
 * holder, set once at activation. Services default to it; tests inject fakes.
 * ASCII-only.
 */
'use strict';

let _ctx = null;

function setExtensionContext(ctx) { _ctx = ctx || null; }

function getExtensionContext() { return _ctx; }

function getSecretsStore() {
    if (!_ctx || !_ctx.secrets) {
        throw new Error('Extension context not initialized (SecretStorage unavailable)');
    }
    return _ctx.secrets;
}

module.exports = { setExtensionContext, getExtensionContext, getSecretsStore };
