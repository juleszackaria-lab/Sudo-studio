/**
 * SUDO STUDIO - Sudo Agent conversation panel (MISSION P4).
 * Editor-tab WebviewPanel on top of the P3 AgentEngine (engine behavior
 * unchanged; P4 only added a `reply` field to its done payload).
 * - theme variables (--vscode-*) + codicons only: no gradient, neon or emoji
 * - Enter sends / Shift+Enter newline, input cleared immediately, queue
 * - streaming text parts + compact collapsible tool rows (defensive: works
 *   with full-part or delta updates, degrades to steps + final reply)
 * - "Voir le diff" (native vscode.diff from a before-run snapshot),
 *   modified-files list, undo button (P3 undoLastRun)
 * - inline 4-choice approvals; engine answers FIFO so only the oldest
 *   unresolved card is actionable
 * - header: mode (Build/Plan), provider+model (P2), runtime status
 * ASCII-only (accents via HTML entities / \uXXXX escapes).
 */
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AgentEngine } = require('./AgentEngine');
const { getAIProviderService } = require('../services/AIProviderService');

const RUNTIME_URL = 'http://127.0.0.1:6000';
const RUNTIME_POLL_MS = 20000;

// ---------------------------------------------------------------- DiffStore
// Text snapshot taken before each run so "Voir le diff" can open the native
// vscode.diff (before-content vs current file). Bounded and best-effort.

class DiffStore {
    constructor(root) {
        this.root = root;
        this.before = new Map();
    }
    snapshot() {
        this.before.clear();
        const MAX_FILES = 2000, MAX_FILE = 512 * 1024, MAX_TOTAL = 16 * 1024 * 1024;
        let total = 0, stopped = false;
        const walk = (dir) => {
            if (stopped) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const e of entries) {
                if (stopped) return;
                if (e.name === '.git' || e.name === 'node_modules') continue;
                const full = path.join(dir, e.name);
                try {
                    if (e.isDirectory()) { walk(full); continue; }
                    if (!e.isFile()) continue;
                    const st = fs.statSync(full);
                    if (st.size > MAX_FILE) continue;
                    if (this.before.size >= MAX_FILES || total + st.size > MAX_TOTAL) { stopped = true; return; }
                    const content = fs.readFileSync(full, 'utf8');
                    if (content.indexOf('\0') !== -1) continue; // binary
                    this.before.set(path.relative(this.root, full), content);
                    total += st.size;
                } catch (_) { /* transient */ }
            }
        };
        try { walk(this.root); } catch (_) { /* best effort */ }
    }
    getBefore(rel) {
        return this.before.has(rel) ? this.before.get(rel) : undefined;
    }
}

// ---------------------------------------------------------------- HTML

function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let n = '';
    for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
    return n;
}

function getWebviewHtml(opts) {
    const nonce = opts.nonce;
    const csp = opts.cspSource;
    const codicons = opts.codiconUri;
    return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">\n' +
    '<title>Sudo Agent</title>\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'style-src ' + csp + ' \'unsafe-inline\'; font-src ' + csp + '; ' +
    'script-src \'nonce-' + nonce + '\'; img-src ' + csp + ' data:;">\n' +
    '<link rel="stylesheet" href="' + codicons + '">\n' +
    '<style>\n' +
    '* { margin:0; padding:0; box-sizing:border-box; }\n' +
    'body { font-family:var(--vscode-font-family); font-size:13px; background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); height:100vh; display:flex; flex-direction:column; line-height:1.5; }\n' +
    ':focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }\n' +
    '#hdr { display:flex; align-items:center; gap:8px; padding:8px 16px; flex-shrink:0; flex-wrap:wrap; border-bottom:1px solid var(--vscode-editorWidget-border); background:var(--vscode-editor-background); }\n' +
    '#hdr .title { font-weight:600; font-size:13px; display:flex; align-items:center; gap:8px; white-space:nowrap; margin-right:8px; }\n' +
    '#hdr .title .codicon { font-size:16px; }\n' +
    '#hdr select { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:2px; padding:2px 4px; font-size:12px; font-family:inherit; max-width:240px; }\n' +
    '#hdr label { font-size:12px; color:var(--vscode-descriptionForeground); white-space:nowrap; }\n' +
    '.rtbtn { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--vscode-descriptionForeground); cursor:pointer; white-space:nowrap; background:none; border:none; border-radius:2px; padding:4px 8px; font-family:inherit; }\n' +
    '.rtbtn:hover { color:var(--vscode-editor-foreground); }\n' +
    '.dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex-shrink:0; }\n' +
    '.dot.ok { background:var(--vscode-testing-iconPassed); }\n' +
    '.dot.bad { background:var(--vscode-testing-iconFailed); }\n' +
    '.dot.cloud { background:var(--vscode-textLink-foreground); }\n' +
    '#thread { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:16px; }\n' +
    '.msg.agent { width:100%; max-width:880px; margin:0 auto; }\n' +
    '.msg.user { align-self:flex-end; max-width:min(700px,88%); margin:0 max(0px,calc((100% - 880px)/2)) 0 auto; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:6px; padding:8px 12px; white-space:pre-wrap; word-break:break-word; }\n' +
    '.bubble .txt { white-space:pre-wrap; word-break:break-word; line-height:1.55; }\n' +
    '.bubble .txt:empty { display:none; }\n' +
    '.stepline { font-size:12px; color:var(--vscode-descriptionForeground); padding:2px 0; display:flex; gap:8px; align-items:baseline; }\n' +
    '.stepline .codicon { font-size:12px; }\n' +
    'details.tool { border:1px solid var(--vscode-editorWidget-border); border-radius:6px; margin-top:8px; font-size:12px; background:var(--vscode-editorWidget-background); }\n' +
    'details.tool summary { cursor:pointer; padding:8px 12px; list-style:none; display:flex; gap:8px; align-items:center; border-radius:6px; }\n' +
    'details.tool summary::-webkit-details-marker { display:none; }\n' +
    'details.tool summary .tgt { color:var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n' +
    'details.tool summary .st { margin-left:auto; color:var(--vscode-descriptionForeground); font-size:11px; flex-shrink:0; }\n' +
    'details.tool pre { border-top:1px solid var(--vscode-editorWidget-border); padding:8px 12px; white-space:pre-wrap; word-break:break-word; font-family:var(--vscode-editor-font-family); font-size:12px; max-height:224px; overflow:auto; margin:0; }\n' +
    '.approval { border:1px solid var(--vscode-editorWidget-border); border-left:3px solid var(--vscode-editorWarning-foreground); border-radius:6px; padding:12px; margin-top:8px; background:var(--vscode-editorWidget-background); }\n' +
    '.approval h4 { font-size:13px; font-weight:600; display:flex; gap:8px; align-items:center; margin-bottom:4px; }\n' +
    '.approval p { font-size:12px; color:var(--vscode-descriptionForeground); word-break:break-word; }\n' +
    '.approval .row { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }\n' +
    '.done { border:1px solid var(--vscode-editorWidget-border); border-radius:6px; padding:12px; margin-top:8px; background:var(--vscode-editorWidget-background); }\n' +
    '.done.ok { border-left:3px solid var(--vscode-testing-iconPassed); }\n' +
    '.done.fail { border-left:3px solid var(--vscode-testing-iconFailed); }\n' +
    '.done.part { border-left:3px solid var(--vscode-editorWarning-foreground); }\n' +
    '.done h4 { font-size:13px; font-weight:600; display:flex; gap:8px; align-items:center; }\n' +
    '.done .reason { font-size:12px; margin-top:4px; word-break:break-word; }\n' +
    '.files { margin-top:12px; font-size:12px; }\n' +
    '.files h5 { font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:4px; font-weight:600; }\n' +
    '.files .frow { display:flex; gap:8px; align-items:center; padding:4px 8px; margin:0 -8px; border-radius:4px; }\n' +
    '.files .frow:hover { background:var(--vscode-list-hoverBackground); }\n' +
    '.files .frow .nm { word-break:break-all; }\n' +
    'button.linklike { color:var(--vscode-textLink-foreground); background:none; border:none; cursor:pointer; font-size:inherit; font-family:inherit; padding:0; white-space:nowrap; margin-left:auto; }\n' +
    'button.linklike:hover { color:var(--vscode-textLink-activeForeground); text-decoration:underline; }\n' +
    '.btn { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:1px solid transparent; border-radius:2px; padding:4px 12px; min-height:28px; font-size:13px; cursor:pointer; font-family:inherit; display:inline-flex; gap:8px; align-items:center; justify-content:center; }\n' +
    '.btn:hover { background:var(--vscode-button-secondaryHoverBackground); }\n' +
    '.btn:disabled { opacity:.45; cursor:default; }\n' +
    '.btn.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }\n' +
    '.btn.primary:hover { background:var(--vscode-button-hoverBackground); }\n' +
    '#composer { flex-shrink:0; width:calc(100% - 32px); max-width:880px; margin:0 auto 16px; border:1px solid var(--vscode-input-border); border-radius:6px; background:var(--vscode-input-background); padding:8px 8px 4px; }\n' +
    '#composer:focus-within { border-color:var(--vscode-focusBorder); }\n' +
    '#agentInput { width:100%; background:transparent; color:var(--vscode-input-foreground); border:none; padding:4px; font-size:13px; font-family:inherit; resize:none; min-height:40px; max-height:144px; line-height:1.5; }\n' +
    '#agentInput:focus { outline:none; }\n' +
    '#agentInput::placeholder { color:var(--vscode-input-placeholderForeground); }\n' +
    '#composer .crow { display:flex; align-items:center; gap:8px; padding:4px; }\n' +
    '#hint { font-size:11px; color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n' +
    '#queueBadge { display:none; font-size:11px; color:var(--vscode-descriptionForeground); white-space:nowrap; }\n' +
    '#queueBadge.show { display:inline; }\n' +
    '#composer .cbtns { margin-left:auto; display:flex; gap:8px; flex-shrink:0; }\n' +
    '#empty { width:100%; max-width:880px; margin:0 auto; display:flex; flex-direction:column; align-items:center; gap:8px; padding:48px 16px; color:var(--vscode-descriptionForeground); text-align:center; }\n' +
    '#empty .codicon { font-size:44px; }\n' +
    '#empty .t { font-size:16px; font-weight:600; color:var(--vscode-editor-foreground); }\n' +
    '#empty .s { font-size:12px; max-width:560px; }\n' +
    '.sugg { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; justify-content:center; }\n' +
    '.errline { color:var(--vscode-errorForeground); font-size:12px; padding:4px 0; display:flex; gap:8px; align-items:baseline; }\n' +
    '::-webkit-scrollbar { width:12px; height:12px; }\n' +
    '::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); border:3px solid transparent; border-radius:6px; background-clip:content-box; }\n' +
    '@media (max-width: 640px) {\n' +
    '#thread { padding:12px; gap:12px; }\n' +
    '#composer { width:calc(100% - 24px); margin-bottom:12px; }\n' +
    '.approval .row .btn { flex:1 1 100%; }\n' +
    '#hint { display:none; }\n' +
    '}\n' +
    '@media (prefers-reduced-motion: reduce) {\n' +
    '.codicon-modifier-spin { animation:none; }\n' +
    '}\n' +
    '</style>\n</head>\n<body>\n' +
    '<div id="hdr">\n' +
    '  <span class="title"><span class="codicon codicon-comment-discussion"></span>Sudo Agent</span>\n' +
    '  <label for="modeSel">Mode</label>\n' +
    '  <select id="modeSel"><option value="build">Build</option><option value="plan">Plan</option></select>\n' +
    '  <label for="providerSel">Fournisseur</label>\n' +
    '  <select id="providerSel"></select>\n' +
    '  <button id="rt" class="rtbtn" title="Cliquer pour actualiser"><span class="dot bad" id="rtDot"></span><span id="rtTxt">Runtime : ?</span></button>\n' +
    '</div>\n' +
    '<div id="thread" role="log" aria-label="Conversation"><div id="empty">' +
    '<span class="codicon codicon-comment-discussion"></span>' +
    '<div class="t">Sudo Agent</div>' +
    '<div class="s">D&eacute;crivez une t&acirc;che ci-dessous. Entr&eacute;e envoie, Maj+Entr&eacute;e = nouvelle ligne.</div>' +
    '<div class="sugg">' +
    '<button class="btn" data-sugg="Analyse ce projet et r&eacute;sume son &eacute;tat">Analyser le projet</button>' +
    '<button class="btn" data-sugg="Explique le fichier ouvert dans l&rsquo;&eacute;diteur">Expliquer le fichier actif</button>' +
    '<button class="btn" data-sugg="Lance les tests et r&eacute;sume le r&eacute;sultat">Lancer les tests</button>' +
    '</div></div></div>\n' +
    '<div id="composer">' +
    '<textarea id="agentInput" rows="1" placeholder="D&eacute;crivez la t&acirc;che de l&rsquo;agent..." aria-label="Message pour l&rsquo;agent"></textarea>' +
    '<div class="crow"><span id="hint">Entr&eacute;e pour envoyer, Maj+Entr&eacute;e pour une nouvelle ligne</span>' +
    '<span id="queueBadge"></span>' +
    '<span class="cbtns"><button class="btn" id="btnStop" disabled><span class="codicon codicon-debug-stop"></span>Arr&ecirc;ter</button>' +
    '<button class="btn primary" id="btnSend"><span class="codicon codicon-send"></span>Envoyer</button></span></div></div>\n' +
    '<script nonce="' + nonce + '">\n' +
    '"use strict";\n' +
    'var vscode = acquireVsCodeApi();\n' +
    'var thread = document.getElementById("thread");\n' +
    'var input = document.getElementById("agentInput");\n' +
    'var btnSend = document.getElementById("btnSend");\n' +
    'var btnStop = document.getElementById("btnStop");\n' +
    'var queueBadge = document.getElementById("queueBadge");\n' +
    'var modeSel = document.getElementById("modeSel");\n' +
    'var providerSel = document.getElementById("providerSel");\n' +
    'var rtDot = document.getElementById("rtDot");\n' +
    'var rtTxt = document.getElementById("rtTxt");\n' +
    'var running = false;\n' +
    'var currentAgent = null;\n' +
    'var parts = {};\n' +
    'var approvals = {};\n' +
    'function post(m) { vscode.postMessage(m); }\n' +
    'function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;")' +
    '.replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }\n' +
    'function clearEmpty() { var e = document.getElementById("empty"); if (e) e.remove(); }\n' +
    'function nearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120; }\n' +
    'function stick() { if (nearBottom()) thread.scrollTop = thread.scrollHeight; }\n' +
    'function send() {\n' +
    '  var t = input.value.trim();\n' +
    '  if (!t) return;\n' +
    '  input.value = "";\n' +
    '  input.style.height = "auto";\n' +
    '  clearEmpty();\n' +
    '  var d = document.createElement("div");\n' +
    '  d.className = "msg user";\n' +
    '  d.textContent = t;\n' +
    '  thread.appendChild(d);\n' +
    '  thread.scrollTop = thread.scrollHeight;\n' +
    '  post({ type: "send", text: t });\n' +
    '}\n' +
    'btnSend.addEventListener("click", send);\n' +
    'btnStop.addEventListener("click", function() { post({ type: "stop" }); });\n' +
    'input.addEventListener("keydown", function(e) {\n' +
    '  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }\n' +
    '});\n' +
    'input.addEventListener("input", function() {\n' +
    '  input.style.height = "auto";\n' +
    '  input.style.height = Math.min(input.scrollHeight, 140) + "px";\n' +
    '});\n' +
    'modeSel.addEventListener("change", function() { post({ type: "setMode", mode: modeSel.value }); });\n' +
    'providerSel.addEventListener("change", function() { post({ type: "setProvider", id: providerSel.value }); });\n' +
    'document.getElementById("rt").addEventListener("click", function() { post({ type: "refreshRuntime" }); });\n' +
    'Array.prototype.forEach.call(document.querySelectorAll("[data-sugg]"), function(b) {\n' +
    '  b.addEventListener("click", function() { input.value = b.getAttribute("data-sugg"); input.focus(); });\n' +
    '});\n' +
    'function ensureAgent() {\n' +
    '  clearEmpty();\n' +
    '  if (currentAgent) return currentAgent;\n' +
    '  var wrap = document.createElement("div");\n' +
    '  wrap.className = "msg agent";\n' +
    '  var b = document.createElement("div");\n' +
    '  b.className = "bubble";\n' +
    '  var t = document.createElement("div");\n' +
    '  t.className = "txt";\n' +
    '  b.appendChild(t);\n' +
    '  wrap.appendChild(b);\n' +
    '  thread.appendChild(wrap);\n' +
    '  currentAgent = { wrap: wrap, bubble: b, txt: t };\n' +
    '  return currentAgent;\n' +
    '}\n' +
    'function addStep(phase, message) {\n' +
    '  var a = ensureAgent();\n' +
    '  var d = document.createElement("div");\n' +
    '  d.className = "stepline";\n' +
    '  d.innerHTML = "<span class=\\"codicon codicon-chevron-right\\"></span><span></span>";\n' +
    '  d.lastChild.textContent = (phase ? "[" + phase + "] " : "") + (message || "");\n' +
    '  a.bubble.appendChild(d);\n' +
    '  stick();\n' +
    '}\n' +
    'function partKey(p) {\n' +
    '  var m = p.messageID || p.messageId || "";\n' +
    '  var inner = p.part || {};\n' +
    '  var id = inner.id || p.partID || p.partId || p.id || "";\n' +
    '  return m + "::" + id;\n' +
    '}\n' +
    'function partText(p) {\n' +
    '  var t = p.part || p;\n' +
    '  if (t && t.type === "text" && typeof t.text === "string") return t.text;\n' +
    '  if (typeof p.delta === "string") return p.delta;\n' +
    '  if (typeof p.text === "string" && !p.part) return p.text;\n' +
    '  return null;\n' +
    '}\n' +
    'function onPart(props) {\n' +
    '  var inner = props.part || {};\n' +
    '  if (inner.type === "tool" || props.tool) { onTool(props); return; }\n' +
    '  var txt = partText(props);\n' +
    '  if (txt == null) return;\n' +
    '  var a = ensureAgent();\n' +
    '  var k = partKey(props) || "main";\n' +
    '  var prev = parts[k] || "";\n' +
    '  var next;\n' +
    '  if (prev && txt.indexOf(prev) === 0) next = txt;\n' +
    '  else next = prev + txt;\n' +
    '  parts[k] = next.slice(-100000);\n' +
    '  var keys = Object.keys(parts);\n' +
    '  a.txt.textContent = keys.map(function(x) { return parts[x]; }).join("\\n");\n' +
    '  stick();\n' +
    '}\n' +
    'function toolTarget(inner, props) {\n' +
    '  var inp = inner.input || inner.args || props.input || {};\n' +
    '  if (typeof inp === "string") return inp.slice(0, 120);\n' +
    '  var cands = ["filePath", "path", "file", "command", "cmd", "pattern", "query", "url"];\n' +
    '  for (var i = 0; i < cands.length; i++) {\n' +
    '    if (inp && typeof inp[cands[i]] === "string" && inp[cands[i]]) return String(inp[cands[i]]).slice(0, 120);\n' +
    '  }\n' +
    '  return "";\n' +
    '}\n' +
    'function onTool(props) {\n' +
    '  var a = ensureAgent();\n' +
    '  var inner = props.part || props;\n' +
    '  var k = "tool:" + (partKey(props) || (inner.tool || "tool"));\n' +
    '  var name = inner.tool || props.tool || "outil";\n' +
    '  var st = (inner.state && inner.state.status) || props.status || "running";\n' +
    '  var tgt = toolTarget(inner, props);\n' +
    '  var el = document.getElementById(k);\n' +
    '  if (!el) {\n' +
    '    el = document.createElement("details");\n' +
    '    el.className = "tool";\n' +
    '    el.id = k;\n' +
    '    a.bubble.appendChild(el);\n' +
    '  }\n' +
    '  var icon = st === "completed" || st === "ok" || st === "success" ? "check" : (st === "error" || st === "failed" ? "x" : "sync");\n' +
    '  var spin = (icon === "sync") ? " codicon-modifier-spin" : "";\n' +
    '  var detail = "";\n' +
    '  try { detail = JSON.stringify(inner.state || inner, null, 1).slice(0, 4000); } catch (e) { detail = ""; }\n' +
    '  el.innerHTML = "<summary><span class=\\"codicon codicon-" + icon + spin + "\\"></span>" +\n' +
    '    "<span><b>" + esc(name) + "</b></span> " +\n' +
    '    "<span class=\\"tgt\\">" + esc(tgt) + "</span>" +\n' +
    '    "<span class=\\"st\\">" + esc(st) + "</span></summary><pre>" + esc(detail) + "</pre>";\n' +
    '  stick();\n' +
    '}\n' +
    'var CHOICES = [\n' +
    '  ["once", "Autoriser une fois"],\n' +
    '  ["session", "Autoriser pour toute la session"],\n' +
    '  ["project", "Toujours autoriser dans ce projet"],\n' +
    '  ["reject", "Refuser"]\n' +
    '];\n' +
    'function renderApproval(a) {\n' +
    '  var box = ensureAgent().bubble;\n' +
    '  var d = document.createElement("div");\n' +
    '  d.className = "approval";\n' +
    '  var h = document.createElement("h4");\n' +
    '  h.innerHTML = "<span class=\\"codicon codicon-shield\\"></span>";\n' +
    '  var ht = document.createElement("span");\n' +
    '  ht.textContent = a.title || a.action || "Autorisation requise";\n' +
    '  h.appendChild(ht);\n' +
    '  d.appendChild(h);\n' +
    '  var p = document.createElement("p");\n' +
    '  p.textContent = (a.action ? "[" + a.action + "] " : "") + (a.description || "");\n' +
    '  d.appendChild(p);\n' +
    '  var row = document.createElement("div");\n' +
    '  row.className = "row";\n' +
    '  CHOICES.forEach(function(c) {\n' +
    '    var b = document.createElement("button");\n' +
    '    b.className = "btn";\n' +
    '    b.textContent = c[1];\n' +
    '    b.disabled = !a.actionable;\n' +
    '    (function(choice) {\n' +
    '      b.addEventListener("click", function() {\n' +
    '        row.querySelectorAll("button").forEach(function(x) { x.disabled = true; });\n' +
    '        post({ type: "approve", id: a.id, choice: choice });\n' +
    '      });\n' +
    '    })(c[0]);\n' +
    '    row.appendChild(b);\n' +
    '  });\n' +
    '  d.appendChild(row);\n' +
    '  approvals[a.id] = { el: d, row: row };\n' +
    '  box.appendChild(d);\n' +
    '  stick();\n' +
    '}\n' +
    'function setActionable(id) {\n' +
    '  Object.keys(approvals).forEach(function(k) {\n' +
    '    var en = (k === id);\n' +
    '    approvals[k].row.querySelectorAll("button").forEach(function(x) { x.disabled = !en; });\n' +
    '  });\n' +
    '}\n' +
    'function resolveApproval(id, choice) {\n' +
    '  var r = approvals[id];\n' +
    '  if (!r) return;\n' +
    '  var label = "Refus\\u00e9";\n' +
    '  if (choice === "once") label = "Autoris\\u00e9 (une fois)";\n' +
    '  else if (choice === "session") label = "Autoris\\u00e9 (session)";\n' +
    '  else if (choice === "project") label = "Autoris\\u00e9 (projet)";\n' +
    '  r.row.innerHTML = "";\n' +
    '  var s = document.createElement("span");\n' +
    '  s.textContent = label;\n' +
    '  r.row.appendChild(s);\n' +
    '}\n' +
    'function renderDone(d) {\n' +
    '  var a = ensureAgent();\n' +
    '  if (d.reply && !a.txt.textContent) a.txt.textContent = d.reply;\n' +
    '  var box = document.createElement("div");\n' +
    '  var cls = d.status === "TERMINE" ? "ok" : (d.status === "PARTIEL" ? "part" : "fail");\n' +
    '  box.className = "done " + cls;\n' +
    '  var icon = cls === "ok" ? "check" : (cls === "part" ? "warning" : "x");\n' +
    '  var h = document.createElement("h4");\n' +
    '  h.innerHTML = "<span class=\\"codicon codicon-" + icon + "\\"></span>";\n' +
    '  var t = document.createElement("span");\n' +
    '  t.textContent = d.status + (d.mode ? " (" + d.mode + ")" : "");\n' +
    '  h.appendChild(t);\n' +
    '  box.appendChild(h);\n' +
    '  if (d.reason) {\n' +
    '    var r = document.createElement("div");\n' +
    '    r.className = "reason";\n' +
    '    r.textContent = d.reason;\n' +
    '    box.appendChild(r);\n' +
    '  }\n' +
    '  if (d.filesModified && d.filesModified.length) {\n' +
    '    var f = document.createElement("div");\n' +
    '    f.className = "files";\n' +
    '    var h5 = document.createElement("h5");\n' +
    '    h5.textContent = "Fichiers modifi\\u00e9s (" + d.filesModified.length + ")";\n' +
    '    f.appendChild(h5);\n' +
    '    d.filesModified.forEach(function(nm) {\n' +
    '      var row = document.createElement("div");\n' +
    '      row.className = "frow";\n' +
    '      var ic = document.createElement("span");\n' +
    '      ic.className = "codicon codicon-file";\n' +
    '      var s = document.createElement("span");\n' +
    '      s.className = "nm";\n' +
    '      s.textContent = nm;\n' +
    '      var b = document.createElement("button");\n' +
    '      b.className = "linklike";\n' +
    '      b.textContent = "Voir le diff";\n' +
    '      (function(file) {\n' +
    '        b.addEventListener("click", function() { post({ type: "openDiff", file: file }); });\n' +
    '      })(nm);\n' +
    '      row.appendChild(ic);\n' +
    '      row.appendChild(s);\n' +
    '      row.appendChild(b);\n' +
    '      f.appendChild(row);\n' +
    '    });\n' +
    '    box.appendChild(f);\n' +
    '  }\n' +
    '  var acts = document.createElement("div");\n' +
    '  acts.style.marginTop = "8px";\n' +
    '  acts.style.display = "flex";\n' +
    '  acts.style.gap = "6px";\n' +
    '  if (d.sessionId) {\n' +
    '    var u = document.createElement("button");\n' +
    '    u.className = "btn";\n' +
    '    u.innerHTML = "<span class=\\"codicon codicon-discard\\"></span>";\n' +
    '    var ut = document.createElement("span");\n' +
    '    ut.textContent = "Annuler le run";\n' +
    '    u.appendChild(ut);\n' +
    '    u.addEventListener("click", function() { post({ type: "undo" }); });\n' +
    '    acts.appendChild(u);\n' +
    '  }\n' +
    '  if (d.noModel) {\n' +
    '    var m = document.createElement("button");\n' +
    '    m.className = "btn primary";\n' +
    '    m.textContent = "Ouvrir Runtime & Models";\n' +
    '    m.addEventListener("click", function() { post({ type: "openRuntime" }); });\n' +
    '    acts.appendChild(m);\n' +
    '  }\n' +
    '  box.appendChild(acts);\n' +
    '  a.bubble.appendChild(box);\n' +
    '  currentAgent = null;\n' +
    '  parts = {};\n' +
    '  stick();\n' +
    '}\n' +
    'function renderError(msg) {\n' +
    '  var a = ensureAgent();\n' +
    '  var d = document.createElement("div");\n' +
    '  d.className = "errline";\n' +
    '  d.innerHTML = "<span class=\\"codicon codicon-error\\"></span>";\n' +
    '  var s = document.createElement("span");\n' +
    '  s.textContent = msg;\n' +
    '  d.appendChild(s);\n' +
    '  a.bubble.appendChild(d);\n' +
    '  stick();\n' +
    '}\n' +
    'function setRunning(v, queued) {\n' +
    '  running = v;\n' +
    '  btnStop.disabled = !v;\n' +
    '  if (queued > 0) {\n' +
    '    queueBadge.textContent = queued + " message(s) en file - ils partiront automatiquement.";\n' +
    '    queueBadge.classList.add("show");\n' +
    '  } else {\n' +
    '    queueBadge.textContent = "";\n' +
    '    queueBadge.classList.remove("show");\n' +
    '  }\n' +
    '}\n' +
    'function setRuntime(rt) {\n' +
    '  if (rt.kind === "cloud") {\n' +
    '    rtDot.className = "dot cloud";\n' +
    '    rtTxt.textContent = "Cloud : " + (rt.provider || "?") + " / " + (rt.model || "?");\n' +
    '  } else if (rt.online) {\n' +
    '    rtDot.className = "dot ok";\n' +
    '    rtTxt.textContent = rt.models && rt.models.length ?\n' +
    '      "Runtime : " + rt.models.length + " mod\\u00e8le(s)" : "Runtime : aucun mod\\u00e8le";\n' +
    '  } else {\n' +
    '    rtDot.className = "dot bad";\n' +
    '    rtTxt.textContent = "Runtime : hors ligne";\n' +
    '  }\n' +
    '}\n' +
    'function setProviders(list, activeId) {\n' +
    '  providerSel.innerHTML = "";\n' +
    '  (list || []).forEach(function(p) {\n' +
    '    var o = document.createElement("option");\n' +
    '    o.value = p.id;\n' +
    '    o.textContent = p.name + " / " + p.model + (p.type === "cloud" ? "" : " (local)");\n' +
    '    providerSel.appendChild(o);\n' +
    '  });\n' +
    '  providerSel.value = activeId;\n' +
    '}\n' +
    'window.addEventListener("message", function(ev) {\n' +
    '  var m = ev.data || {};\n' +
    '  if (m.type === "runState") setRunning(!!m.running, m.queued || 0);\n' +
    '  else if (m.type === "started") { parts = {}; ensureAgent(); addStep("run", "Mode " + (m.mode || "")); }\n' +
    '  else if (m.type === "step") addStep(m.phase, m.message);\n' +
    '  else if (m.type === "part") onPart(m.properties || {});\n' +
    '  else if (m.type === "approval") renderApproval(m);\n' +
    '  else if (m.type === "actionable") setActionable(m.id);\n' +
    '  else if (m.type === "approvalResolved") resolveApproval(m.id, m.choice);\n' +
    '  else if (m.type === "done") renderDone(m);\n' +
    '  else if (m.type === "error") renderError(m.message);\n' +
    '  else if (m.type === "undoResult") addStep("undo",\n' +
    '    m.ok ? ("Annul\\u00e9 : " + (m.restored || []).join(", ")) : ("Echec : " + m.error));\n' +
    '  else if (m.type === "runtime") setRuntime(m);\n' +
    '  else if (m.type === "providers") setProviders(m.providers, m.activeId);\n' +
    '  else if (m.type === "mode") { modeSel.value = m.mode; }\n' +
    '  else if (m.type === "cleared") { thread.innerHTML = ""; currentAgent = null; parts = {}; approvals = {}; }\n' +
    '});\n' +
    '</script>\n</body>\n</html>';
}

// ---------------------------------------------------------------- panel

class AgentPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri, opts = {}) {
        this.panel = panel;
        this.extensionUri = extensionUri || null;
        this.disposables = [];
        this._http = opts.http || null;
        this._engineFactory = opts.engineFactory || ((o) => new AgentEngine(o));
        this.engine = null;
        this.projectRoot = null;
        this.mode = 'build';
        this._running = false;
        this._queue = [];
        this._approvals = [];
        this._resolved = new Set();
        this._diffStore = null;
        this._runtimeTimer = null;

        const webview = panel.webview;
        webview.html = getWebviewHtml({
            nonce: getNonce(),
            cspSource: webview.cspSource,
            codiconUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css')).toString(),
        });
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        webview.onDidReceiveMessage((m) => this.handleMessage(m), null, this.disposables);
        this._postProviders();
        this._post({ type: 'mode', mode: this.mode });
        this._checkRuntime();
        this._runtimeTimer = setInterval(() => this._checkRuntime(), RUNTIME_POLL_MS);
    }

    static createOrShow(extensionUri, opts) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;
        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel.panel.reveal(column);
            AgentPanel.currentPanel._checkRuntime();
            return AgentPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoStudioAgent',
            'Sudo Agent',
            column,
            { enableScripts: true, retainContextWhenHidden: true,
              localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
        );
        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri, opts);
        return AgentPanel.currentPanel;
    }

    async handleMessage(msg) {
        try {
            switch (msg && msg.type) {
                case 'send': await this._handleSend(msg.text); break;
                case 'stop': this.stopAgent(); break;
                case 'approve': await this._handleApprove(msg.id, msg.choice); break;
                case 'setMode': this._handleMode(msg.mode); break;
                case 'setProvider': this._handleProvider(msg.id); break;
                case 'openDiff': await this._handleDiff(msg.file); break;
                case 'undo': await this._handleUndo(); break;
                case 'openRuntime':
                    vscode.commands.executeCommand('sudoStudio.openRuntimePanel');
                    break;
                case 'clear':
                    this._queue = [];
                    this._post({ type: 'cleared' });
                    this._postRunState();
                    break;
                case 'refreshRuntime': this._checkRuntime(); break;
                default: break;
            }
        } catch (e) {
            this._post({ type: 'error', message: 'Panel: ' + e.message });
        }
    }

    async _handleSend(text) {
        text = (text || '').trim();
        if (!text) return;
        const folders = vscode.workspace.workspaceFolders;
        const ws = folders && folders[0];
        if (!ws) {
            this._post({ type: 'error',
                message: 'Ouvrez un dossier via Fichier > Ouvrir un dossier, puis relancez.' });
            return;
        }
        const root = ws.uri.fsPath;
        if (this.engine && this.projectRoot !== root) {
            try { await this.engine.stop(); } catch (_) {}
            this.engine = null;
        }
        this.projectRoot = root;
        if (this._running) {
            this._queue.push(text);
            this._postRunState();
            return;
        }
        this._runOne(text);
    }

    async _runOne(text) {
        this._running = true;
        this._postRunState();
        try {
            this._ensureEngine();
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: 'Moteur agent: ' + e.message });
            this._postRunState();
            return;
        }
        this._diffStore = new DiffStore(this.projectRoot);
        try { this._diffStore.snapshot(); } catch (_) {}
        this._approvals = [];
        this._resolved = new Set();
        this._post({ type: 'started', mode: this.mode });
        try {
            await this.engine.run({ prompt: text, mode: this.mode });
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: e.message });
            this._postRunState();
            this._drain();
        }
        // normal path: the engine 'done' event finishes the run.
    }

    _ensureEngine() {
        if (this.engine) return;
        this.engine = this._engineFactory({
            projectRoot: this.projectRoot,
            extensionDir: this.extensionUri ? this.extensionUri.fsPath : null,
            mode: this.mode,
        });
        this.engine.on('step', (d) => this._post({ type: 'step', phase: d.phase, message: d.message }));
        this.engine.on('error', (d) => this._post({ type: 'error', message: d.message }));
        this.engine.on('approval_needed', (d) => this._onApproval(d));
        this.engine.on('done', (d) => this._onDone(d));
        const drv = this.engine.driver;
        if (drv && typeof drv.on === 'function') drv.on('bus', (ev) => this._onBus(ev));
    }

    _onBus(ev) {
        if (!ev || typeof ev.type !== 'string') return;
        // Streamable part updates only (message.updated is already covered
        // by the engine 'step' events; permissions by 'approval_needed').
        if (ev.type.indexOf('message') !== 0 || ev.type.indexOf('part') === -1) return;
        const props = ev.properties || {};
        try { if (JSON.stringify(props).length > 200000) return; } catch (_) { return; }
        this._post({ type: 'part', properties: props });
    }

    _onDone(d) {
        this._running = false;
        const reason = d.reason || '';
        const noModel = d.status === 'ECHEC' && /NO_MODEL_LOADED|Runtime offline/.test(reason);
        this._post({ type: 'done', status: d.status, reason, reply: d.reply || '',
            filesModified: d.filesModified || [], sessionId: d.sessionId || null,
            mode: d.mode || this.mode, noModel });
        this._postRunState();
        this._drain();
    }

    _drain() {
        if (this._running || !this._queue.length) return;
        this._runOne(this._queue.shift());
    }

    stopAgent() {
        this._queue = [];
        if (this.engine) { try { this.engine.stop(); } catch (_) {} }
        this._running = false;
        this._postRunState();
        // the engine 'done' event renders the final (stopped) state.
    }

    _onApproval(d) {
        const a = { id: d.id, action: d.action, title: d.title, description: d.description };
        this._approvals.push(a);
        const first = this._approvals.find((x) => !this._resolved.has(x.id));
        this._post({ type: 'approval', id: a.id, action: a.action, title: a.title,
            description: a.description, actionable: !!first && first.id === a.id });
    }

    async _handleApprove(id, choice) {
        const open = this._approvals.filter((x) => !this._resolved.has(x.id));
        if (!open.length) return;
        if (open[0].id !== id) {
            this._post({ type: 'error',
                message: "Traitez les demandes dans l'ordre (la plus ancienne d'abord)." });
            return;
        }
        if (['once', 'session', 'project', 'reject'].indexOf(choice) === -1) {
            this._post({ type: 'error', message: 'Choix inconnu: ' + choice });
            return;
        }
        if (!this.engine) { this._post({ type: 'error', message: 'Aucun moteur actif.' }); return; }
        const r = await this.engine.resolveApproval(choice);
        if (!r || !r.ok) {
            this._post({ type: 'error', message: 'Approbation impossible: ' + ((r && r.error) || '?') });
            return;
        }
        this._resolved.add(id);
        this._post({ type: 'approvalResolved', id, choice });
        const next = this._approvals.find((x) => !this._resolved.has(x.id));
        this._post({ type: 'actionable', id: next ? next.id : null });
    }

    _handleMode(mode) {
        if (mode !== 'plan' && mode !== 'build') return;
        this.mode = mode;
        if (this.engine) { try { this.engine.setMode(mode); } catch (_) {} }
        this._post({ type: 'mode', mode });
    }

    _handleProvider(id) {
        try {
            getAIProviderService().setActive(id);
        } catch (e) {
            this._post({ type: 'error', message: 'Fournisseur: ' + e.message });
            return;
        }
        this._postProviders();
    }

    _postProviders() {
        try {
            const { providers, activeId } = getAIProviderService().listProviders();
            this._post({ type: 'providers',
                providers: providers.map((p) => ({ id: p.id, type: p.type, name: p.name, model: p.model })),
                activeId });
        } catch (e) {
            this._post({ type: 'error', message: 'Fournisseurs: ' + e.message });
        }
    }

    async _checkRuntime() {
        let active = null;
        try { active = getAIProviderService().getActive(); } catch (_) { active = null; }
        if (active && active.type !== 'local') {
            this._post({ type: 'runtime', kind: 'cloud', provider: active.name, model: active.model });
            return;
        }
        try {
            const ax = this._http || require('axios');
            await ax.get(RUNTIME_URL + '/health', { timeout: 3000 });
            const m = await ax.get(RUNTIME_URL + '/v1/models', { timeout: 3000 });
            const ids = ((m.data && m.data.data) || []).map((x) => x.id).filter(Boolean);
            this._post({ type: 'runtime', kind: 'local', online: true, models: ids });
        } catch (_) {
            this._post({ type: 'runtime', kind: 'local', online: false, models: [] });
        }
    }

    async _handleDiff(rel) {
        if (!rel || !this.projectRoot) return;
        const abs = path.resolve(this.projectRoot, rel);
        const root = path.resolve(this.projectRoot);
        if (abs !== root && abs.indexOf(root + path.sep) !== 0) {
            this._post({ type: 'error', message: 'Chemin hors projet.' });
            return;
        }
        const before = this._diffStore ? this._diffStore.getBefore(rel) : undefined;
        try {
            const dir = path.join(os.tmpdir(), 'sudo-agent-diff');
            fs.mkdirSync(dir, { recursive: true });
            const safe = String(rel).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
            const beforePath = path.join(dir, safe + '.before');
            const emptyPath = path.join(dir, 'empty');
            fs.writeFileSync(beforePath, before === undefined ? '' : before);
            if (!fs.existsSync(emptyPath)) fs.writeFileSync(emptyPath, '');
            const beforeUri = vscode.Uri.file(beforePath);
            const afterUri = fs.existsSync(abs) ? vscode.Uri.file(abs) : vscode.Uri.file(emptyPath);
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, rel + ' (avant -> apres)');
        } catch (e) {
            this._post({ type: 'error', message: 'Diff impossible: ' + e.message });
        }
    }

    async _handleUndo() {
        if (!this.engine) { this._post({ type: 'error', message: 'Aucun moteur actif.' }); return; }
        try {
            const r = await this.engine.undoLastRun();
            this._post({ type: 'undoResult', ok: !!r.ok, restored: r.restored || [], error: r.error || null });
        } catch (e) {
            this._post({ type: 'undoResult', ok: false, restored: [], error: e.message });
        }
    }

    _postRunState() {
        this._post({ type: 'runState', running: this._running, queued: this._queue.length });
    }

    _post(msg) {
        try { this.panel.webview.postMessage(msg); } catch (_) {}
    }

    post(msg) { this._post(msg); }

    dispose() {
        AgentPanel.currentPanel = undefined;
        try { if (this._runtimeTimer) clearInterval(this._runtimeTimer); } catch (_) {}
        this._runtimeTimer = null;
        if (this.engine) { try { this.engine.stop(); } catch (_) {} }
        this.engine = null;
        try { this.panel.dispose(); } catch (_) {}
        this.disposables.forEach((d) => { try { d && d.dispose(); } catch (_) {} });
    }
}

module.exports = { AgentPanel, getWebviewHtml, DiffStore };
