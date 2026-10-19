/**
 * backendFallback.js - P30(d): no panel ever stays black when the backend
 * is down. Uniform contract for the 6 panels (Doctor, SDK, DevOps,
 * CentralMgmt, Security, Duplication):
 *   - the panel's own load ALWAYS runs (local loads must work with no
 *     backend at all; the fallback never pre-probes, so it can never
 *     hijack a working panel);
 *   - ensureBackend races the load against a 5 s bound: if the load fails
 *     with a backend-down signature, or hangs past the bound, the webview
 *     shows "Backend indisponible : <raison>" with [Reessayer]
 *     [Ouvrir les journaux] (proper French via \u00e9 escapes);
 *   - a late success hides the overlay again (Ok is only ever posted to
 *     dismiss a shown overlay, so success paths post nothing new);
 *   - any other load error is re-thrown untouched (exact old behavior).
 * Panels integrate in 4 touches: require here, embed webviewSnippet() in
 * the HTML just before </body> (never first: test harnesses extract the
 * panel's own first <script> block), call
 * window.__sudoBackendInit(vscode) in their script, route handleMessage
 * through handlePanelMessage + wrap the initial load with ensureBackend.
 * Zero dependency (vscode only when the logs button is pressed) so this
 * module is unit-testable outside the extension host. ASCII only.
 */
'use strict';

const TIMEOUT_MS = 5000;
const TYPES = {
  unavailable: 'sudoBackendUnavailable',
  ok: 'sudoBackendOk',
  retry: 'sudoBackendRetry',
  logs: 'sudoOpenLogs',
  webviewError: 'sudoWebviewError'
};

// Panels currently showing the overlay (so Ok is posted only to dismiss).
const _shown = (typeof WeakMap === 'function') ? new WeakMap() : null;
const _shownList = [];
function _isShown(panel) {
  if (_shown) return _shown.get(panel) === true;
  return _shownList.indexOf(panel) !== -1;
}
function _setShown(panel, v) {
  if (_shown) { if (v) _shown.set(panel, true); else _shown.delete(panel); return; }
  const i = _shownList.indexOf(panel);
  if (v && i === -1) _shownList.push(panel);
  if (!v && i !== -1) _shownList.splice(i, 1);
}

function shortReason(err) {
  if (!err) return 'cause inconnue';
  if (err.code === 'ECONNREFUSED') return 'connexion refus\u00e9e';
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') return 'd\u00e9lai d\u00e9pass\u00e9 (5 s)';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'r\u00e9seau injoignable';
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return 'connexion perdue';
  if (err.response && err.response.status) return 'HTTP ' + err.response.status;
  const m = String((err && err.message) || err);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i.test(m)) return 'd\u00e9lai d\u00e9pass\u00e9 (5 s)';
  return m.slice(0, 80) || 'cause inconnue';
}

const DOWN_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'];
function isBackendDown(err) {
  if (!err) return false;
  if (DOWN_CODES.indexOf(err.code) !== -1) return true;
  if (err.request && !err.response) return true; // axios-style: no response at all
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i.test(String(err.message || err));
}

function postSafe(panel, msg) {
  try {
    if (panel && panel.webview && typeof panel.webview.postMessage === 'function') {
      panel.webview.postMessage(msg);
    }
  } catch (_) { /* webview gone - nothing to show to */ }
}

function boundLabel(ms) {
  return ms >= 1000 ? (Math.round(ms / 1000) + ' s') : (ms + ' ms');
}

async function ensureBackend(panel, loadFn, opts) {
  opts = opts || {};
  const ms = opts.timeoutMs || TIMEOUT_MS;
  let run;
  try {
    run = (typeof loadFn === 'function') ? loadFn() : Promise.resolve();
  } catch (e) {
    run = Promise.reject(e); // sync throw flows through the race like a rejection
  }
  let timer = null;
  const gate = new Promise(function (resolve) {
    timer = setTimeout(function () {
      postSafe(panel, { type: TYPES.unavailable, reason: 'd\u00e9lai d\u00e9pass\u00e9 (' + boundLabel(ms) + ')' });
      _setShown(panel, true);
      resolve(false);
    }, ms);
  });
  let settled = false;
  const winner = await Promise.race([
    Promise.resolve(run).then(
      function () { settled = true; return true; },
      function (e) { settled = true; throw e; }
    ),
    gate
  ]).then(
    function (v) { return { ok: true, value: v }; },
    function (e) { return { ok: false, error: e }; }
  );
  if (settled) {
    clearTimeout(timer);
    if (winner.ok) {
      if (_isShown(panel)) { _setShown(panel, false); postSafe(panel, { type: TYPES.ok }); }
      return true;
    }
    const e = winner.error;
    if (isBackendDown(e)) {
      postSafe(panel, { type: TYPES.unavailable, reason: shortReason(e) });
      _setShown(panel, true);
      return false;
    }
    throw e; // not a backend outage: exact old behavior
  }
  // Bound hit first: the load is still running. A late success hides the
  // overlay; a late foreign error surfaces exactly as before (unhandled,
  // like the pre-P30 floating promises in these panels).
  Promise.resolve(run).then(
    function () {
      if (_isShown(panel)) { _setShown(panel, false); postSafe(panel, { type: TYPES.ok }); }
    },
    function (e) {
      if (isBackendDown(e)) {
        postSafe(panel, { type: TYPES.unavailable, reason: shortReason(e) });
      } else {
        setImmediate(function () { throw e; });
      }
    }
  );
  return false;
}

function handlePanelMessage(panel, msg, reloadFn, cmds) {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === TYPES.retry) {
    try {
      const r = typeof reloadFn === 'function' ? reloadFn() : null;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { /* reload posts its own fallback on failure */ }
    return true;
  }
  if (msg.type === TYPES.logs) {
    try {
      const c = cmds || require('vscode').commands;
      c.executeCommand('sudoStudio.openLogsFolder');
    } catch (_) { /* extension host unavailable (tests) */ }
    return true;
  }
  if (msg.type === TYPES.webviewError) {
    try {
      require('./techLog').sharedLog('extension').warn(
        'webview error: ' + String(msg.cause || 'cause inconnue').slice(0, 200), {});
    } catch (_) { /* logging never breaks panels */ }
    return true;
  }
  return false;
}

function webviewSnippet() {
  return `<style>
#sudoBackendFallback{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-background,#1e1e1e);}
#sudoBackendFallback[hidden]{display:none;}
.sbf-card{max-width:440px;padding:28px 32px;border:1px solid var(--vscode-panel-border,#444);border-radius:8px;background:var(--vscode-editorWidget-background,#252526);text-align:center;font-family:var(--vscode-font-family,sans-serif);}
.sbf-title{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--vscode-errorForeground,#f48771);}
.sbf-sub{font-size:12px;opacity:.85;margin-bottom:18px;}
.sbf-actions{display:flex;gap:10px;justify-content:center;}
.sbf-actions button{padding:6px 16px;cursor:pointer;}
</style>
<div id="sudoBackendFallback" hidden>
<div class="sbf-card">
<div class="sbf-title">Backend indisponible : <span id="sbfReason">connexion impossible</span></div>
<div class="sbf-sub">Le panneau ne peut pas charger ses donn\u00e9es.</div>
<div class="sbf-actions"><button id="sbfRetry">R\u00e9essayer</button><button id="sbfLogs">Ouvrir les journaux</button></div>
</div>
</div>
<script>
(function () {
  var api = null;
  window.__sudoBackendInit = function (vscodeApi) {
    api = vscodeApi;
    document.getElementById('sbfRetry').addEventListener('click', function () {
      if (api) api.postMessage({ type: 'sudoBackendRetry' });
    });
    document.getElementById('sbfLogs').addEventListener('click', function () {
      if (api) api.postMessage({ type: 'sudoOpenLogs' });
    });
  };
  window.addEventListener('message', function (ev) {
    var m = ev && ev.data;
    if (!m) return;
    var box = document.getElementById('sudoBackendFallback');
    if (!box) return;
    if (m.type === 'sudoBackendUnavailable') {
      document.getElementById('sbfReason').textContent = m.reason || 'connexion impossible';
      box.hidden = false;
    } else if (m.type === 'sudoBackendOk') {
      box.hidden = true;
    }
  });
})();
</script>`;
}

module.exports = { TIMEOUT_MS, TYPES, shortReason, isBackendDown, ensureBackend, handlePanelMessage, webviewSnippet };
