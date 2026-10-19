/**
 * webviewGuard.js - P35(b): anti-black-screen guard for every webview panel.
 *
 * One snippet, embedded right after <body> in each panel's HTML:
 *   - an immediate "Chargement..." state (first paint, before panel scripts);
 *   - capture of page errors (window.onerror, unhandled promise rejections,
 *     resource load failures via capture-phase error events);
 *   - instead of a black screen: a readable message with the cause plus
 *     [Reessayer] (page reload) and [Ouvrir les journaux] (handled by
 *     backendFallback.handlePanelMessage, like the backend overlay);
 *   - the error is posted to the extension ({type:'sudoWebviewError'}),
 *     which logs it (backendFallback route, never breaks the panel).
 * A silent blank body (no error event but nothing rendered) is also
 * detected after load and reported as "contenu vide".
 *
 * CSP: panels without a CSP meta use guardSnippet() (plain <script>).
 * Panels with a nonce CSP pass { nonce } so the guard script is allowed.
 * Styling is inline <style> (allowed by 'unsafe-inline' everywhere here).
 * ASCII only (French text via \u escapes, same convention as
 * backendFallback.js). Zero dependency.
 * P37: the guard runs FIRST in every panel (right after <body>), so it
 * installs an idempotent acquireVsCodeApi() shim. Real VS Code throws on
 * the 2nd acquire call, which used to kill every panel script (fatal
 * overlay on all pages). With the shim every caller shares one instance.
 * If the shim cannot be installed, the guard stays lazy (no eager
 * acquire) so the panel script still gets the single instance; only the
 * error telemetry to the extension is lost in that case.
 */
'use strict';

function _safeNonce(n) {
  return String(n || '').replace(/[^A-Za-z0-9+/=]/g, '').slice(0, 64);
}

function guardSnippet(opts) {
  opts = opts || {};
  const nonceAttr = opts.nonce ? ' nonce="' + _safeNonce(opts.nonce) + '"' : '';
  return '<style>\n' +
'#ssLoading{padding:28px 24px;font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:var(--vscode-editor-foreground,#e6edf3);}\n' +
'#ssLoading .spin{display:inline-block;width:12px;height:12px;margin-right:8px;border:2px solid var(--vscode-panel-border,#444);border-top-color:var(--vscode-focusBorder,#1f6feb);border-radius:50%;animation:ssspin 1s linear infinite;vertical-align:-1px;}\n' +
'@keyframes ssspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}\n' +
'#ssFatal{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-background,#1e1e1e);}\n' +
'#ssFatal[hidden]{display:none;}\n' +
'.ssf-card{max-width:460px;padding:28px 32px;border:1px solid var(--vscode-panel-border,#444);border-radius:8px;background:var(--vscode-editorWidget-background,#252526);text-align:center;font-family:var(--vscode-font-family,sans-serif);}\n' +
'.ssf-title{font-size:14px;font-weight:600;margin-bottom:8px;color:var(--vscode-errorForeground,#f48771);}\n' +
'.ssf-cause{font-size:12px;opacity:.9;margin-bottom:6px;word-break:break-word;}\n' +
'.ssf-sub{font-size:12px;opacity:.7;margin-bottom:18px;}\n' +
'.ssf-actions{display:flex;gap:10px;justify-content:center;}\n' +
'.ssf-actions button{padding:6px 16px;cursor:pointer;}\n' +
'</style>\n' +
'<div id="ssLoading"><span class="spin"></span>Chargement en cours...</div>\n' +
'<div id="ssFatal" hidden>\n' +
'<div class="ssf-card">\n' +
'<div class="ssf-title">Le panneau n\u2019a pas pu s\u2019afficher</div>\n' +
'<div class="ssf-cause" id="ssfCause">cause inconnue</div>\n' +
'<div class="ssf-sub">L\u2019erreur a \u00e9t\u00e9 \u00e9crite dans le journal.</div>\n' +
'<div class="ssf-actions"><button id="ssfRetry">R\u00e9essayer</button><button id="ssfLogs">Ouvrir les journaux</button></div>\n' +
'</div>\n' +
'</div>\n' +
'<script' + nonceAttr + '>\n' +
'(function () {\n' +
'  var __ssShimOk = false;\n' +
'  try {\n' +
'    if (typeof acquireVsCodeApi === "function" && !acquireVsCodeApi.__ssShim) {\n' +
'      var __ssOrig = acquireVsCodeApi;\n' +
'      var __ssApi = null;\n' +
'      var __ssShim = function () {\n' +
'        if (!__ssApi) { __ssApi = __ssOrig(); }\n' +
'        return __ssApi;\n' +
'      };\n' +
'      __ssShim.__ssShim = true;\n' +
'      acquireVsCodeApi = __ssShim;\n' +
'      __ssShimOk = (acquireVsCodeApi === __ssShim);\n' +
'    } else if (acquireVsCodeApi && acquireVsCodeApi.__ssShim) {\n' +
'      __ssShimOk = true;\n' +
'    }\n' +
'  } catch (_) { __ssShimOk = false; }\n' +
'  var api = null;\n' +
'  if (__ssShimOk) { try { api = acquireVsCodeApi(); } catch (_) { api = null; } }\n' +
'  function post(m) {\n' +
'    try {\n' +
'      if (!api) { try { api = acquireVsCodeApi(); } catch (_) { api = null; } }\n' +
'      if (api) api.postMessage(m);\n' +
'    } catch (_) {}\n' +
'  }\n' +
'  function hideLoader() { var l = document.getElementById("ssLoading"); if (l) l.style.display = "none"; }\n' +
'  var fatalShown = false;\n' +
'  function showFatal(cause) {\n' +
'    if (fatalShown) return;\n' +
'    fatalShown = true;\n' +
'    hideLoader();\n' +
'    try {\n' +
'      var c = document.getElementById("ssfCause");\n' +
'      if (c) c.textContent = String(cause || "cause inconnue").slice(0, 300);\n' +
'      var box = document.getElementById("ssFatal");\n' +
'      if (box) box.hidden = false;\n' +
'    } catch (_) {}\n' +
'    post({ type: "sudoWebviewError", cause: String(cause || "cause inconnue").slice(0, 300) });\n' +
'  }\n' +
'  function wireButtons() {\n' +
'    try {\n' +
'      document.getElementById("ssfRetry").addEventListener("click", function () { location.reload(); });\n' +
'      document.getElementById("ssfLogs").addEventListener("click", function () { post({ type: "sudoOpenLogs" }); });\n' +
'    } catch (_) {}\n' +
'  }\n' +
'  window.addEventListener("error", function (ev) {\n' +
'    var msg = (ev && ev.message) || "";\n' +
'    var src = (ev && ev.filename) || "";\n' +
'    if (!msg && ev && ev.target && ev.target !== window) {\n' +
'      var t = ev.target;\n' +
'      msg = "ressource introuvable: " + (t.src || t.href || t.tagName || "?");\n' +
'    }\n' +
'    showFatal(msg || ("erreur de script" + (src ? " (" + src + ")" : "")));\n' +
'  }, true);\n' +
'  window.addEventListener("unhandledrejection", function (ev) {\n' +
'    var r = ev && ev.reason;\n' +
'    showFatal("promesse rejet\u00e9e: " + (r && r.message ? r.message : String(r)));\n' +
'  });\n' +
'  function blankCheck() {\n' +
'    if (fatalShown) return;\n' +
'    try {\n' +
'      var txt = (document.body ? document.body.innerText : "") || "";\n' +
'      txt = txt.replace(/Chargement en cours\\.\\.\\./g, "").trim();\n' +
'      if (txt.length < 10) showFatal("contenu vide apr\u00e8s chargement");\n' +
'    } catch (_) {}\n' +
'  }\n' +
'  wireButtons();\n' +
'  if (document.readyState === "complete") { hideLoader(); setTimeout(blankCheck, 1500); }\n' +
'  else {\n' +
'    window.addEventListener("load", function () { hideLoader(); setTimeout(blankCheck, 1500); });\n' +
'    setTimeout(function () { hideLoader(); blankCheck(); }, 8000);\n' +
'  }\n' +
'})();\n' +
'</script>';
}

module.exports = { guardSnippet };
