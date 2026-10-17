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
const { getAgentHost } = require('./agentHost');
const { getAIProviderService } = require('../services/AIProviderService');

const RUNTIME_URL = 'http://127.0.0.1:6000';
const RUNTIME_POLL_MS = 20000;

// ------------------------------------------------- P13: +n/-n display stats
// Bounded LCS line counts (before snapshot vs current file). Display data
// only; engine behavior untouched. Returns null when not computable.

function lineStats(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') return null;
    const a = before.split('\n'), b = after.split('\n');
    if (a.length > 4000 || b.length > 4000) return null;
    if (a.length * b.length > 4000000) return null;
    const n = b.length;
    let prev = new Array(n + 1).fill(0);
    let cur = new Array(n + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= n; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        const t = prev; prev = cur; cur = t;
    }
    return { added: n - prev[n], removed: a.length - prev[n] };
}

function fileStat(before, after) {
    if (before === undefined && after === undefined) return null;
    if (before === undefined) {
        if (typeof after !== 'string' || after.indexOf('\0') !== -1) return null;
        return { added: after.split('\n').length, removed: 0 };
    }
    if (after === undefined) return { added: 0, removed: before.split('\n').length };
    return lineStats(before, after);
}

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
    const tokensUri = opts.tokensUri || '';
    const hljsUri = opts.hljsUri || '';
    const isChat = opts.variant === 'chat';
    const extraLinks = tokensUri ? '<link rel="stylesheet" href="' + tokensUri + '">\n' : '';
    const hljsTag = hljsUri ? '<script src="' + hljsUri + '"></script>\n' : '';
    const titleText = isChat ? 'Sudo Chat' : 'Sudo Agent';
    const modeBlock = isChat
        ? '<span class="planbadge"><span class="codicon codicon-eye"></span>Plan, lecture seule</span>\n'
        : '<div id="modeSel" class="seg" role="radiogroup" aria-label="Mode">\n' +
          '<button type="button" role="radio" aria-checked="true" data-mode="build">Build</button>\n' +
          '<button type="button" role="radio" aria-checked="false" data-mode="plan">Plan</button>\n</div>\n';
    const toAgentBlock = isChat
        ? '<button class="btn" id="toAgentBtn"><span class="codicon codicon-robot"></span>Passer en mode Agent</button>\n'
        : '';
    const modelBlock = isChat ? '' :
        '<label for="modelSel">Modele</label>\n  <select id="modelSel"></select>\n';
    const agentCtrls = isChat ? '' :
        '<button class="btn sm" id="btnSessions"><span class="codicon codicon-history"></span>Sessions</button>\n' +
        '  <button id="srvBtn" class="rtbtn" title="Serveur agent"><span class="dot bad" id="srvDot"></span><span id="srvTxt">Agent : ?</span></button>\n';
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${titleText}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; font-src ${csp}; script-src 'nonce-${nonce}' ${csp}; img-src ${csp} data:;">
<link rel="stylesheet" href="${codicons}">
${extraLinks}<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:var(--sudo-font-ui); font-size:var(--fs-1); background:var(--vscode-editor-background,var(--sudo-surface)); color:var(--vscode-editor-foreground,var(--sudo-text)); height:100vh; display:flex; flex-direction:column; line-height:1.55; }
::selection { background:var(--vscode-editor-selectionBackground,var(--sudo-border)); }
:focus-visible { outline:2px solid var(--vscode-focusBorder,var(--sudo-accent)); outline-offset:2px; }
#hdr { display:flex; align-items:center; gap:8px; padding:8px 16px; flex-shrink:0; flex-wrap:wrap; border-bottom:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); background:var(--vscode-editor-background,var(--sudo-surface)); }
#hdr .title { font-weight:600; font-size:var(--fs-1); display:flex; align-items:center; gap:8px; white-space:nowrap; margin-right:8px; }
#hdr .title .codicon { font-size:16px; }
#hdr label { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); white-space:nowrap; }
#hdr select { background:var(--vscode-input-background,var(--sudo-input)); color:var(--vscode-input-foreground,var(--sudo-text)); border:1px solid var(--vscode-input-border,var(--sudo-border)); border-radius:6px; padding:4px 8px; font-size:12px; font-family:inherit; max-width:240px; }
.seg { display:inline-flex; border:1px solid var(--vscode-input-border,var(--sudo-border)); border-radius:6px; padding:2px; gap:2px; background:var(--vscode-input-background,var(--sudo-input)); }
.seg button { border:0; background:transparent; color:var(--vscode-descriptionForeground,var(--sudo-dim)); padding:4px 12px; font-size:12px; border-radius:6px; cursor:pointer; font-family:inherit; }
.seg button[aria-checked="true"] { background:var(--sudo-accent); color:var(--sudo-accent-ink); font-weight:500; }
.rtbtn { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); cursor:pointer; white-space:nowrap; background:none; border:0; border-radius:6px; padding:4px 8px; font-family:inherit; }
.rtbtn:hover { color:var(--vscode-editor-foreground,var(--sudo-text)); }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex-shrink:0; }
.dot.ok { background:var(--vscode-testing-iconPassed,var(--sudo-ok)); }
.dot.bad { background:var(--vscode-testing-iconFailed,var(--sudo-err)); }
.dot.cloud { background:var(--vscode-textLink-foreground,var(--sudo-accent)); }
#thread { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:16px; }
.msg { content-visibility:auto; contain-intrinsic-size:64px; }
.msg.agent { width:100%; max-width:820px; margin:0 auto; }
.msg.user { align-self:flex-end; max-width:min(700px,88%); margin:0 max(0px,calc((100% - 820px)/2)) 0 auto; background:var(--vscode-input-background,var(--sudo-input)); border:1px solid var(--vscode-input-border,var(--sudo-border)); border-radius:var(--r-surf); padding:8px 12px; white-space:pre-wrap; word-break:break-word; }
.bubble .txt { font-size:var(--fs-2); }
.bubble .txt:empty { display:none; }
.txp { white-space:pre-wrap; word-break:break-word; max-width:72ch; margin:0 0 8px; }
.txp:last-child { margin-bottom:0; }
.rail { position:relative; margin-top:8px; padding-left:24px; }
.rail::before { content:""; position:absolute; left:30px; top:8px; bottom:8px; width:1px; background:var(--vscode-editorWidget-border,var(--sudo-border)); }
.rn { position:relative; margin-top:8px; }
.rn:first-child { margin-top:0; }
.node { position:absolute; left:0; top:2px; width:12px; height:12px; border-radius:50%; box-sizing:border-box; }
.node.run { border:2px solid var(--sudo-accent); background:transparent; }
.node.ok { border:2px solid var(--vscode-testing-iconPassed,var(--sudo-ok)); background:var(--vscode-testing-iconPassed,var(--sudo-ok)); }
.node.err { border:2px solid var(--vscode-testing-iconFailed,var(--sudo-err)); background:var(--vscode-testing-iconFailed,var(--sudo-err)); }
.node.warn { border:2px solid var(--vscode-editorWarning-foreground,var(--sudo-warn)); background:transparent; }
.rnc { padding-left:20px; }
.stepline { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); padding:2px 0; }
details.toolrow summary { cursor:pointer; padding:4px 0; list-style:none; display:flex; gap:8px; align-items:center; font-size:12px; }
details.toolrow summary::-webkit-details-marker { display:none; }
details.toolrow .tname { font-weight:500; }
details.toolrow .tgt { color:var(--vscode-descriptionForeground,var(--sudo-dim)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
details.toolrow .tst { margin-left:auto; color:var(--vscode-descriptionForeground,var(--sudo-dim)); font-size:11px; flex-shrink:0; }
details.toolrow pre { margin:4px 0 8px; padding:8px 12px; white-space:pre-wrap; word-break:break-word; font-family:var(--sudo-font-code); font-size:12px; line-height:1.55; max-height:224px; overflow:auto; background:var(--sudo-code-bg); border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-radius:var(--r-surf); }
details.toolrow[open] pre { animation:fadein 150ms ease-out; }
@keyframes fadein { from { opacity:0; } }
.codeblock { margin:8px 0; max-width:72ch; background:var(--sudo-code-bg); border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-radius:var(--r-surf); overflow:hidden; }
.code-h { display:flex; align-items:center; gap:8px; padding:4px 12px; border-bottom:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); font-size:11px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); }
.code-h button { margin-left:auto; }
.codeblock pre { margin:0; padding:12px; overflow:auto; max-height:224px; font-family:var(--sudo-font-code); font-size:12px; line-height:1.55; }
.codeblock pre code { font-family:inherit; background:transparent; }
.approval { border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-left:3px solid var(--vscode-editorWarning-foreground,var(--sudo-warn)); border-radius:var(--r-surf); padding:12px; margin-top:8px; background:var(--vscode-editorWidget-background,var(--sudo-raised)); max-width:72ch; }
.approval h4 { font-size:var(--fs-1); font-weight:600; display:flex; gap:8px; align-items:center; margin-bottom:4px; }
.approval p { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); word-break:break-word; }
.approval .row { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
.approval.collapsed { padding:8px 12px; border-left-color:var(--vscode-testing-iconPassed,var(--sudo-ok)); }
.approval.collapsed p { display:none; }
.approval.collapsed h4 { display:inline; font-size:12px; font-weight:500; margin:0; }
.approval.collapsed .row { display:inline; margin:0 0 0 8px; }
.approval.collapsed .done-line { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); }
.donebox { margin-top:8px; max-width:72ch; }
.done-h { display:flex; gap:8px; align-items:center; }
.done-h h4 { font-size:var(--fs-1); font-weight:600; }
.done-h .node { position:static; flex-shrink:0; }
.donebox .reason { font-size:12px; margin-top:4px; word-break:break-word; color:var(--vscode-descriptionForeground,var(--sudo-dim)); }
.changes { margin-top:8px; border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-radius:var(--r-surf); background:var(--vscode-editor-background,var(--sudo-surface)); }
.changes summary { padding:8px 12px; cursor:pointer; list-style:none; display:flex; gap:8px; align-items:center; font-size:var(--fs-1); font-weight:500; }
.changes summary::-webkit-details-marker { display:none; }
.changes .frow { display:flex; gap:8px; align-items:center; padding:4px 12px; font-size:12px; }
.changes .frow:last-child { padding-bottom:8px; }
.changes .frow .nm { word-break:break-all; }
.changes .stats { font-family:var(--sudo-font-code); font-size:11px; white-space:nowrap; }
.changes .add { color:var(--vscode-testing-iconPassed,var(--sudo-ok)); }
.changes .del { color:var(--vscode-testing-iconFailed,var(--sudo-err)); }
.acts { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
button.linklike { color:var(--vscode-textLink-foreground,var(--sudo-accent)); background:none; border:0; cursor:pointer; font-size:inherit; font-family:inherit; padding:0; white-space:nowrap; margin-left:auto; }
button.linklike:hover { text-decoration:underline; }
.btn { background:var(--vscode-button-secondaryBackground,var(--sudo-raised)); color:var(--vscode-button-secondaryForeground,var(--sudo-text)); border:1px solid var(--vscode-button-border,var(--sudo-border)); border-radius:6px; padding:4px 12px; min-height:28px; font-size:var(--fs-1); cursor:pointer; font-family:inherit; display:inline-flex; gap:8px; align-items:center; justify-content:center; transition:filter 120ms ease-out; }
.btn:hover { filter:brightness(1.12); }
.btn:disabled { opacity:.45; cursor:default; filter:none; }
.btn.primary { background:var(--sudo-accent); color:var(--sudo-accent-ink); border-color:transparent; }
.btn.primary:hover { filter:brightness(1.08); }
.btn.sm { min-height:24px; padding:2px 8px; font-size:12px; }
#composer { flex-shrink:0; width:calc(100% - 32px); max-width:820px; margin:0 auto 16px; border:1px solid var(--vscode-input-border,var(--sudo-border)); border-radius:var(--r-surf); background:var(--vscode-input-background,var(--sudo-input)); padding:8px 8px 4px; }
#composer:focus-within { border-color:var(--vscode-focusBorder,var(--sudo-accent)); }
#agentInput { width:100%; background:transparent; color:var(--vscode-input-foreground,var(--sudo-text)); border:0; padding:4px; font-size:var(--fs-2); font-family:inherit; resize:none; min-height:40px; max-height:144px; line-height:1.55; }
#agentInput:focus { outline:none; }
#agentInput::placeholder { color:var(--vscode-input-placeholderForeground,var(--sudo-dim)); }
#composer .crow { display:flex; align-items:center; gap:8px; padding:4px; }
#hint { font-size:11px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#queueBadge { display:none; font-size:11px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); white-space:nowrap; }
#queueBadge.show { display:inline; }
#composer .cbtns { margin-left:auto; display:flex; gap:8px; flex-shrink:0; }
#empty { width:100%; max-width:820px; margin:0 auto; display:flex; flex-direction:column; align-items:center; gap:8px; padding:48px 16px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); text-align:center; }
#empty .t { font-size:var(--fs-4); font-weight:600; color:var(--vscode-editor-foreground,var(--sudo-text)); }
#empty .s { font-size:var(--fs-1); max-width:560px; }
.sugg { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; justify-content:center; }
.errline { color:var(--vscode-errorForeground,var(--sudo-err)); font-size:12px; padding:4px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; max-width:72ch; }
.errline span { flex:1; }
.skel { margin-top:8px; display:flex; flex-direction:column; gap:8px; max-width:72ch; }
.skel i { display:block; height:12px; border-radius:6px; background:var(--vscode-editorWidget-background,var(--sudo-raised)); border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); }
.skel .w90 { width:90%; } .skel .w70 { width:70%; } .skel .w80 { width:80%; }
.txt.live::after { content:""; display:inline-block; width:8px; height:1em; margin-left:2px; vertical-align:-2px; background:var(--sudo-accent); animation:blink 1s steps(2,start) infinite; }
@keyframes blink { to { visibility:hidden; } }
.sandbox { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-radius:6px; padding:2px 8px; display:inline-flex; gap:4px; align-items:center; white-space:nowrap; }
.planbadge { font-size:12px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); display:inline-flex; gap:8px; align-items:center; white-space:nowrap; }
#ctxbar { width:100%; display:flex; gap:4px; flex-wrap:wrap; }
#ctxbar:empty { display:none; }
#ctxbar:not(:empty) { margin-bottom:8px; }
.chip { font-size:11px; color:var(--vscode-descriptionForeground,var(--sudo-dim)); border:1px solid var(--vscode-editorWidget-border,var(--sudo-border)); border-radius:6px; padding:2px 8px; display:inline-flex; gap:4px; align-items:center; }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); border:3px solid transparent; border-radius:6px; background-clip:content-box; }
@media (max-width: 640px) {
#thread { padding:12px; gap:12px; }
#composer { width:calc(100% - 24px); margin-bottom:12px; }
.approval .row .btn { flex:1 1 100%; }
#hint { display:none; }
}
@media (max-width: 420px) {
.sugg .btn { flex:1 1 100%; }
#hdr label { display:none; }
}
@media (prefers-reduced-motion: reduce) {
.codicon-modifier-spin { animation:none; }
.txt.live::after { animation:none; }
details.toolrow[open] pre { animation:none; }
.btn { transition:none; }
}
</style>
</head>
<body>
<div id="hdr">
  <span class="title"><span class="codicon codicon-comment-discussion"></span>${titleText}</span>
${modeBlock}  <label for="providerSel">Fournisseur</label>
  <select id="providerSel"></select>
  ${modelBlock}<span id="sandboxBadge" class="sandbox" title="Isolation : Mode restreint (L1). Pas de sandbox isol&eacute;e sur ce poste.">Mode restreint</span>
  ${agentCtrls}${toAgentBlock}  <button id="rt" class="rtbtn" title="Cliquer pour actualiser"><span class="dot bad" id="rtDot"></span><span id="rtTxt">Runtime : ?</span></button>
</div>
<div id="thread" role="log" aria-label="Conversation"><div id="empty"><div class="t">${titleText}</div><div class="s">D&eacute;crivez une t&acirc;che ci-dessous. Entr&eacute;e envoie, Maj+Entr&eacute;e = nouvelle ligne.</div><div class="sugg"><button class="btn" data-sugg="Explique ce projet : structure, langage et point d&rsquo;entr&eacute;e">Expliquer ce projet</button><button class="btn" data-sugg="Ajoute des tests au projet et lance-les">Ajouter des tests</button><button class="btn" data-sugg="Corrige l&rsquo;erreur affich&eacute;e dans le panneau Probl&egrave;mes">Corriger l&rsquo;erreur du panneau Probl&egrave;mes</button><button class="btn" data-sugg="Analyse ce projet et r&eacute;sume son &eacute;tat">Analyser le projet</button></div></div></div>
<div id="composer"><div id="ctxbar"></div><textarea id="agentInput" rows="1" placeholder="D&eacute;crivez la t&acirc;che de l&rsquo;agent..." aria-label="Message pour l&rsquo;agent"></textarea><div class="crow"><span id="hint">Entr&eacute;e pour envoyer, Maj+Entr&eacute;e pour une nouvelle ligne</span><span id="queueBadge"></span><span class="cbtns"><button class="btn" id="btnStop" disabled><span class="codicon codicon-debug-stop"></span>Arr&ecirc;ter</button><button class="btn primary" id="btnSend"><span class="codicon codicon-send"></span>Envoyer</button></span></div></div>
${hljsTag}<script nonce="${nonce}">
"use strict";
var vscode = acquireVsCodeApi();
var thread = document.getElementById("thread");
var input = document.getElementById("agentInput");
var btnSend = document.getElementById("btnSend");
var btnStop = document.getElementById("btnStop");
var queueBadge = document.getElementById("queueBadge");
var modeSel = document.getElementById("modeSel");
var providerSel = document.getElementById("providerSel");
var modelSel = document.getElementById("modelSel");
var srvDot = document.getElementById("srvDot");
var srvTxt = document.getElementById("srvTxt");
var rtModels = [];
var provList = [];
var decided = false;
var rtDot = document.getElementById("rtDot");
var rtTxt = document.getElementById("rtTxt");
var running = false;
var currentAgent = null;
var parts = {};
var approvals = {};
var lastUserText = "";
var skelEl = null;
function post(m) { vscode.postMessage(m); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function clearEmpty() { var e = document.getElementById("empty"); if (e) e.remove(); }
function nearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120; }
function stick() { if (nearBottom()) thread.scrollTop = thread.scrollHeight; }
function setModeUI(mode) {
  if (!modeSel) return;
  var btns = modeSel.querySelectorAll("button");
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute("aria-checked", btns[i].getAttribute("data-mode") === mode ? "true" : "false");
  }
}
function send() {
  var t = input.value.trim();
  if (!t) return;
  input.value = "";
  input.style.height = "auto";
  lastUserText = t;
  clearEmpty();
  var d = document.createElement("div");
  d.className = "msg user";
  d.textContent = t;
  thread.appendChild(d);
  thread.scrollTop = thread.scrollHeight;
  post({ type: "send", text: t });
}
btnSend.addEventListener("click", send);
btnStop.addEventListener("click", function() { post({ type: "stop" }); });
input.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener("input", function() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});
if (modeSel) {
  var mbtns = modeSel.querySelectorAll("button");
  for (var mi = 0; mi < mbtns.length; mi++) {
    (function(b) {
      b.addEventListener("click", function() {
        setModeUI(b.getAttribute("data-mode"));
        post({ type: "setMode", mode: b.getAttribute("data-mode") });
      });
    })(mbtns[mi]);
  }
}
providerSel.addEventListener("change", function() { post({ type: "setProvider", id: providerSel.value }); });
if (modelSel) modelSel.addEventListener("change", function() { post({ type: "setModel", model: modelSel.value }); });
var btnSessions = document.getElementById("btnSessions");
if (btnSessions) btnSessions.addEventListener("click", function() { post({ type: "listSessions" }); });
var srvBtn = document.getElementById("srvBtn");
if (srvBtn) srvBtn.addEventListener("click", function() { post({ type: "relaunchServer" }); });
var toAgentBtn = document.getElementById("toAgentBtn");
if (toAgentBtn) toAgentBtn.addEventListener("click", function() { post({ type: "toAgent" }); });
document.getElementById("rt").addEventListener("click", function() { post({ type: "refreshRuntime" }); });
Array.prototype.forEach.call(document.querySelectorAll("[data-sugg]"), function(b) {
  b.addEventListener("click", function() { input.value = b.getAttribute("data-sugg"); input.focus(); });
});
function ensureAgent() {
  clearEmpty();
  if (currentAgent) return currentAgent;
  var wrap = document.createElement("div");
  wrap.className = "msg agent";
  var b = document.createElement("div");
  b.className = "bubble";
  var t = document.createElement("div");
  t.className = "txt";
  b.appendChild(t);
  wrap.appendChild(b);
  thread.appendChild(wrap);
  currentAgent = { wrap: wrap, bubble: b, txt: t, rail: null };
  return currentAgent;
}
function ensureRail(a) {
  if (a.rail) return a.rail;
  var r = document.createElement("div");
  r.className = "rail";
  r.setAttribute("aria-label", "Fil d'activit\\u00e9");
  a.bubble.appendChild(r);
  a.rail = r;
  return r;
}
function railNode(rail, cls) {
  var rn = document.createElement("div");
  rn.className = "rn";
  var n = document.createElement("span");
  n.className = "node " + cls;
  n.setAttribute("aria-hidden", "true");
  var c = document.createElement("div");
  c.className = "rnc";
  rn.appendChild(n);
  rn.appendChild(c);
  rail.appendChild(rn);
  return { rn: rn, node: n, box: c };
}
function showSkel() {
  var a = ensureAgent();
  if (skelEl) return;
  skelEl = document.createElement("div");
  skelEl.className = "skel";
  skelEl.setAttribute("aria-hidden", "true");
  ["w90", "w70", "w80"].forEach(function(w) {
    var i = document.createElement("i");
    i.className = w;
    skelEl.appendChild(i);
  });
  a.bubble.appendChild(skelEl);
  stick();
}
function hideSkel() {
  if (skelEl) { skelEl.remove(); skelEl = null; }
}
function highlightCode(el, lang, src) {
  var H = null;
  try { H = window.hljs || null; } catch (e) { H = null; }
  if (H && lang) {
    var ok = false;
    try { ok = !!H.getLanguage(lang); } catch (e2) { ok = false; }
    if (ok) {
      try { el.innerHTML = H.highlight(src, { language: lang }).value; return; }
      catch (e3) { /* plain below */ }
    }
  }
  el.textContent = src;
}
function addTxp(box, s) {
  var t = String(s || "").replace(/^\\n+|\\n+$/g, "");
  if (!t) return;
  var d = document.createElement("div");
  d.className = "txp";
  d.textContent = t;
  box.appendChild(d);
}
function addCode(box, lang, src) {
  var wrap = document.createElement("div");
  wrap.className = "codeblock";
  var h = document.createElement("div");
  h.className = "code-h";
  var lab = document.createElement("span");
  lab.textContent = lang || "code";
  var cp = document.createElement("button");
  cp.className = "btn sm";
  cp.textContent = "Copier";
  cp.setAttribute("aria-label", "Copier le bloc de code");
  cp.addEventListener("click", function() { copyText(src, cp); });
  h.appendChild(lab);
  h.appendChild(cp);
  var pre = document.createElement("pre");
  var code = document.createElement("code");
  highlightCode(code, lang, src);
  pre.appendChild(code);
  wrap.appendChild(h);
  wrap.appendChild(pre);
  box.appendChild(wrap);
}
function copyText(src, btn) {
  function done(ok) {
    btn.textContent = ok ? "Copi\\u00e9" : "Copie impossible";
    setTimeout(function() { btn.textContent = "Copier"; }, 1200);
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(src).then(function() { done(true); }, function() { done(false); });
      return;
    }
  } catch (e) { /* fallback below */ }
  try {
    var ta = document.createElement("textarea");
    ta.value = src;
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    ta.remove();
    done(!!ok);
  } catch (e2) { done(false); }
}
function renderAgentText(box, raw) {
  box.innerHTML = "";
  var re = /\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g;
  var last = 0, m;
  var s = String(raw || "");
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) addTxp(box, s.slice(last, m.index));
    addCode(box, m[1] || "", m[2] || "");
    last = m.index + m[0].length;
  }
  addTxp(box, s.slice(last));
}
function addStep(phase, message) {
  var a = ensureAgent();
  hideSkel();
  var r = railNode(ensureRail(a), phase === "undo" ? "warn" : "ok");
  var d = document.createElement("div");
  d.className = "stepline";
  d.textContent = message || phase || "";
  r.box.appendChild(d);
  stick();
}
function partKey(p) {
  var m = p.messageID || p.messageId || "";
  var inner = p.part || {};
  var id = inner.id || p.partID || p.partId || p.id || "";
  return m + "::" + id;
}
function partText(p) {
  var t = p.part || p;
  if (t && t.type === "text" && typeof t.text === "string") return t.text;
  if (typeof p.delta === "string") return p.delta;
  if (typeof p.text === "string" && !p.part) return p.text;
  return null;
}
function onPart(props) {
  var inner = props.part || {};
  if (inner.type === "tool" || props.tool) { onTool(props); return; }
  var txt = partText(props);
  if (txt == null) return;
  var a = ensureAgent();
  hideSkel();
  var k = partKey(props) || "main";
  var prev = parts[k] || "";
  var next;
  if (prev && txt.indexOf(prev) === 0) next = txt;
  else next = prev + txt;
  parts[k] = next.slice(-100000);
  var keys = Object.keys(parts);
  renderAgentText(a.txt, keys.map(function(x) { return parts[x]; }).join("\\n"));
  if (running) a.txt.classList.add("live");
  stick();
}
function toolTarget(inner, props) {
  var inp = inner.input || inner.args || props.input || {};
  if (typeof inp === "string") return inp.slice(0, 120);
  var cands = ["filePath", "path", "file", "command", "cmd", "pattern", "query", "url"];
  for (var i = 0; i < cands.length; i++) {
    if (inp && typeof inp[cands[i]] === "string" && inp[cands[i]]) return String(inp[cands[i]]).slice(0, 120);
  }
  return "";
}
function toolStatus(st) {
  if (st === "completed" || st === "ok" || st === "success") return { cls: "ok", icon: "check", label: "R\\u00e9ussi" };
  if (st === "error" || st === "failed") return { cls: "err", icon: "x", label: "\\u00c9chec" };
  return { cls: "run", icon: "sync", label: "En cours" };
}
function onTool(props) {
  var a = ensureAgent();
  hideSkel();
  var inner = props.part || props;
  var k = "tool:" + (partKey(props) || (inner.tool || "tool"));
  var name = inner.tool || props.tool || "outil";
  var st = (inner.state && inner.state.status) || props.status || "running";
  var meta = toolStatus(st);
  var tgt = toolTarget(inner, props);
  var el = document.getElementById(k);
  if (!el) {
    var r = railNode(ensureRail(a), meta.cls);
    el = document.createElement("details");
    el.className = "toolrow";
    el.id = k;
    el._node = r.node;
    r.box.appendChild(el);
  }
  if (el._node) el._node.className = "node " + meta.cls;
  var spin = (meta.icon === "sync") ? " codicon-modifier-spin" : "";
  var detail = "";
  try { detail = JSON.stringify(inner.state || inner, null, 1).slice(0, 4000); } catch (e) { detail = ""; }
  el.innerHTML = "<summary><span class=\\"codicon codicon-" + meta.icon + spin + "\\"></span>" +
    "<span class=\\"tname\\">" + esc(name) + "</span>" +
    "<span class=\\"tgt\\">" + esc(tgt) + "</span>" +
    "<span class=\\"tst\\">" + esc(meta.label) + "</span></summary><pre><code></code></pre>";
  var code = el.querySelector("code");
  if (code) highlightCode(code, "json", detail);
  stick();
}
var CHOICES = [
  ["once", "Autoriser une fois"],
  ["session", "Autoriser pour toute la session"],
  ["project", "Toujours autoriser dans ce projet"],
  ["reject", "Refuser"]
];
function renderApproval(a) {
  var box = ensureAgent().bubble;
  hideSkel();
  var d = document.createElement("div");
  d.className = "approval";
  var h = document.createElement("h4");
  var hi = document.createElement("span");
  hi.className = "codicon codicon-shield";
  var ht = document.createElement("span");
  ht.textContent = a.title || a.action || "Autorisation requise";
  h.appendChild(hi);
  h.appendChild(ht);
  d.appendChild(h);
  var p = document.createElement("p");
  p.textContent = (a.action ? "[" + a.action + "] " : "") + (a.description || "");
  d.appendChild(p);
  var row = document.createElement("div");
  row.className = "row";
  CHOICES.forEach(function(c) {
    var b = document.createElement("button");
    b.className = "btn" + (c[0] === "session" ? " primary" : "");
    b.textContent = c[1];
    b.disabled = !a.actionable;
    (function(choice) {
      b.addEventListener("click", function() {
        row.querySelectorAll("button").forEach(function(x) { x.disabled = true; });
        post({ type: "approve", id: a.id, choice: choice });
      });
    })(c[0]);
    row.appendChild(b);
  });
  d.appendChild(row);
  approvals[a.id] = { el: d, row: row };
  box.appendChild(d);
  stick();
}
function setActionable(id) {
  Object.keys(approvals).forEach(function(k) {
    var en = (k === id);
    approvals[k].row.querySelectorAll("button").forEach(function(x) { x.disabled = !en; });
  });
}
function resolveApproval(id, choice) {
  var r = approvals[id];
  if (!r) return;
  var label = "Refus\\u00e9";
  if (choice === "once") label = "Autoris\\u00e9 (une fois)";
  else if (choice === "session") label = "Autoris\\u00e9 (session)";
  else if (choice === "project") label = "Autoris\\u00e9 (projet)";
  r.el.classList.add("collapsed");
  r.row.innerHTML = "";
  var s = document.createElement("span");
  s.className = "done-line";
  s.textContent = label;
  r.row.appendChild(s);
}
function renderDone(d) {
  var a = ensureAgent();
  hideSkel();
  if (d.reply && !a.txt.textContent) renderAgentText(a.txt, d.reply);
  a.txt.classList.remove("live");
  var box = document.createElement("div");
  box.className = "donebox";
  var cls = d.status === "TERMINE" ? "ok" : (d.status === "PARTIEL" ? "warn" : "err");
  var hd = document.createElement("div");
  hd.className = "done-h";
  var n = document.createElement("span");
  n.className = "node " + cls;
  n.setAttribute("aria-hidden", "true");
  var h = document.createElement("h4");
  h.textContent = d.status + (d.mode ? " (" + d.mode + ")" : "");
  hd.appendChild(n);
  hd.appendChild(h);
  box.appendChild(hd);
  if (d.reason) {
    var r = document.createElement("div");
    r.className = "reason";
    r.textContent = d.reason;
    box.appendChild(r);
  }
  if (d.filesModified && d.filesModified.length) {
    var det = document.createElement("details");
    det.className = "changes";
    det.open = true;
    var sum = document.createElement("summary");
    var sic = document.createElement("span");
    sic.className = "codicon codicon-diff";
    var st = document.createElement("span");
    st.textContent = "Modifications (" + d.filesModified.length + ")";
    sum.appendChild(sic);
    sum.appendChild(st);
    det.appendChild(sum);
    var stats = {};
    (d.fileStats || []).forEach(function(fs) { stats[fs.file] = fs; });
    d.filesModified.forEach(function(nm) {
      var row = document.createElement("div");
      row.className = "frow";
      var s = document.createElement("span");
      s.className = "nm";
      s.textContent = nm;
      row.appendChild(s);
      var fs = stats[nm];
      if (fs && (fs.added != null || fs.removed != null)) {
        var sg = document.createElement("span");
        sg.className = "stats";
        var ah = document.createElement("span");
        ah.className = "add";
        ah.textContent = "+" + (fs.added != null ? fs.added : "?");
        var dh = document.createElement("span");
        dh.className = "del";
        dh.textContent = " \\u2212" + (fs.removed != null ? fs.removed : "?");
        sg.appendChild(ah);
        sg.appendChild(dh);
        row.appendChild(sg);
      }
      var b = document.createElement("button");
      b.className = "linklike";
      b.textContent = "Voir le diff";
      (function(file) {
        b.addEventListener("click", function() { post({ type: "openDiff", file: file }); });
      })(nm);
      row.appendChild(b);
      det.appendChild(row);
    });
    box.appendChild(det);
  }
  var acts = document.createElement("div");
  acts.className = "acts";
  if (d.sessionId) {
    var u = document.createElement("button");
    u.className = "btn";
    var ui = document.createElement("span");
    ui.className = "codicon codicon-discard";
    var ut = document.createElement("span");
    ut.textContent = "Annuler le run";
    u.appendChild(ui);
    u.appendChild(ut);
    u.addEventListener("click", function() { post({ type: "undo" }); });
    acts.appendChild(u);
  }
  if (d.noModel) {
    var m = document.createElement("button");
    m.className = "btn primary";
    m.textContent = "Ouvrir Runtime & Models";
    m.addEventListener("click", function() { post({ type: "openRuntime" }); });
    acts.appendChild(m);
  }
  if (d.kind === "server") {
    var rl = document.createElement("button");
    rl.className = "btn primary";
    rl.textContent = "Relancer le serveur";
    rl.addEventListener("click", function() { post({ type: "relaunchServer" }); });
    acts.appendChild(rl);
  }
  if (decided) {
    var ct = document.createElement("button");
    ct.className = "btn";
    ct.textContent = "Poursuivre";
    ct.addEventListener("click", function() { post({ type: "continue" }); });
    acts.appendChild(ct);
  }
  decided = false;
  box.appendChild(acts);
  a.bubble.appendChild(box);
  currentAgent = null;
  parts = {};
  stick();
}
function renderError(msg) {
  var a = ensureAgent();
  hideSkel();
  a.txt.classList.remove("live");
  var d = document.createElement("div");
  d.className = "errline";
  var ic = document.createElement("span");
  ic.className = "codicon codicon-error";
  var s = document.createElement("span");
  s.textContent = msg;
  d.appendChild(ic);
  d.appendChild(s);
  if (lastUserText) {
    var rb = document.createElement("button");
    rb.className = "btn sm";
    rb.textContent = "Recommencer";
    rb.addEventListener("click", function() { post({ type: "send", text: lastUserText }); });
    d.appendChild(rb);
  }
  a.bubble.appendChild(d);
  stick();
}
function setRunning(v, queued) {
  running = v;
  btnStop.disabled = !v;
  if (document.body) {
    if (v) document.body.classList.add("running");
    else document.body.classList.remove("running");
  }
  if (!v) {
    Array.prototype.forEach.call(document.querySelectorAll(".txt.live"), function(x) {
      x.classList.remove("live");
    });
  }
  if (queued > 0) {
    queueBadge.textContent = queued + " message(s) en file - ils partiront automatiquement.";
    queueBadge.classList.add("show");
  } else {
    queueBadge.textContent = "";
    queueBadge.classList.remove("show");
  }
}
function setRuntime(rt) {
  if (rt.kind === "cloud") {
    rtDot.className = "dot cloud";
    rtTxt.textContent = "Cloud : " + (rt.provider || "?") + " / " + (rt.model || "?");
  } else if (rt.online) {
    rtDot.className = "dot ok";
    rtTxt.textContent = rt.models && rt.models.length ?
      "Runtime : " + rt.models.length + " mod\\u00e8le(s)" : "Runtime : aucun mod\\u00e8le";
    rtModels = (rt.models || []).slice();
    fillModelSel();
  } else {
    rtDot.className = "dot bad";
    rtTxt.textContent = "Runtime : hors ligne";
    rtModels = [];
    fillModelSel();
  }
}
function setProviders(list, activeId) {
  provList = list || [];
  providerSel.innerHTML = "";
  provList.forEach(function(p) {
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + " / " + p.model + (p.type === "cloud" ? "" : " (local)");
    providerSel.appendChild(o);
  });
  providerSel.value = activeId;
  fillModelSel();
}
function fillModelSel() {
  if (!modelSel) return;
  var active = null;
  provList.forEach(function(p) { if (p.id === providerSel.value) active = p; });
  var opts = [];
  if (active && active.type === "cloud") {
    if (active.model) opts.push(active.model);
  } else {
    opts = rtModels.slice();
    if (active && active.model && opts.indexOf(active.model) === -1) opts.unshift(active.model);
  }
  var prev = modelSel.value;
  modelSel.innerHTML = "";
  opts.forEach(function(m) {
    var o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modelSel.appendChild(o);
  });
  if (opts.indexOf(prev) !== -1) modelSel.value = prev;
  else if (active && active.model && opts.indexOf(active.model) !== -1) modelSel.value = active.model;
}
function setServer(s) {
  if (!srvDot || !srvTxt) return;
  var st = (s && s.status) || "?";
  if (st === "ready") {
    srvDot.className = "dot ok";
    srvTxt.textContent = "Agent : pret";
  } else if (st === "starting") {
    srvDot.className = "dot cloud";
    srvTxt.textContent = "Agent : demarrage...";
  } else if (st === "stopped") {
    srvDot.className = "dot bad";
    srvTxt.textContent = "Agent : arrete";
  } else {
    srvDot.className = "dot bad";
    srvTxt.textContent = "Agent : erreur";
  }
  var b = document.getElementById("srvBtn");
  if (b) b.title = "Serveur agent : " + st + (s && s.detail ? " (" + s.detail + ")" : "") + ". Cliquer pour relancer.";
}
function setContext(c) {
  var bar = document.getElementById("ctxbar");
  if (!bar) return;
  bar.innerHTML = "";
  var chips = [];
  if (c.activeFile) chips.push(["file", c.activeFile]);
  if (c.hasSelection) chips.push(["quote", "s\\u00e9lection"]);
  if (c.problems) chips.push(["warning", c.problems + " probl\\u00e8me(s)"]);
  chips.forEach(function(ch) {
    var s = document.createElement("span");
    s.className = "chip";
    var ic = document.createElement("span");
    ic.className = "codicon codicon-" + ch[0];
    var t = document.createElement("span");
    t.textContent = ch[1];
    s.appendChild(ic);
    s.appendChild(t);
    bar.appendChild(s);
  });
}
function renderHistory(turns) {
  clearEmpty();
  turns.forEach(function(t) {
    if (t.role === "user") {
      var d = document.createElement("div");
      d.className = "msg user";
      d.textContent = t.content || "";
      thread.appendChild(d);
    } else {
      var wrap = document.createElement("div");
      wrap.className = "msg agent";
      var b = document.createElement("div");
      b.className = "bubble";
      var x = document.createElement("div");
      x.className = "txt";
      renderAgentText(x, t.content || "");
      b.appendChild(x);
      wrap.appendChild(b);
      thread.appendChild(wrap);
    }
  });
  thread.scrollTop = thread.scrollHeight;
}
function onDelta(text) {
  if (!text) return;
  var a = ensureAgent();
  hideSkel();
  a.txt.textContent += text;
  stick();
}
function onToolMsg(t) {
  var label = (t.phase === "start" ? "Outil : " : "Termine : ") + (t.tool || "?");
  if (t.phase === "end" && t.summary) label += " - " + t.summary;
  if (t.phase === "end" && t.status === "error") label += " (echec)";
  addStep(t.phase, label);
}
function renderSessions(list, current) {
  clearEmpty();
  var wrap = document.createElement("div");
  wrap.className = "msg agent";
  var det = document.createElement("details");
  det.className = "changes";
  det.open = true;
  var sum = document.createElement("summary");
  var sic = document.createElement("span");
  sic.className = "codicon codicon-history";
  var st = document.createElement("span");
  st.textContent = "Sessions (" + (list || []).length + ")";
  sum.appendChild(sic);
  sum.appendChild(st);
  det.appendChild(sum);
  (list || []).forEach(function(s) {
    var row = document.createElement("div");
    row.className = "frow";
    var nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = (s.id === current ? "> " : "") + (s.title || s.id) +
      " (" + (s.messageCount || 0) + " msg)";
    row.appendChild(nm);
    var rb = document.createElement("button");
    rb.className = "linklike";
    rb.textContent = "Reprendre";
    (function(id) {
      rb.addEventListener("click", function() { post({ type: "resumeSession", id: id }); });
    })(s.id);
    row.appendChild(rb);
    var db = document.createElement("button");
    db.className = "linklike";
    db.textContent = "Supprimer";
    (function(id) {
      db.addEventListener("click", function() { post({ type: "deleteSession", id: id }); });
    })(s.id);
    row.appendChild(db);
    det.appendChild(row);
  });
  var acts = document.createElement("div");
  acts.className = "acts";
  var nb = document.createElement("button");
  nb.className = "btn sm";
  nb.textContent = "Nouvelle session";
  nb.addEventListener("click", function() { post({ type: "newSession" }); });
  acts.appendChild(nb);
  det.appendChild(acts);
  wrap.appendChild(det);
  thread.appendChild(wrap);
  stick();
}
window.addEventListener("message", function(ev) {
  var m = ev.data || {};
  if (m.type === "runState") setRunning(!!m.running, m.queued || 0);
  else if (m.type === "started") { parts = {}; ensureAgent(); addStep("run", "Mode " + (m.mode || "")); showSkel(); }
  else if (m.type === "step") addStep(m.phase, m.message);
  else if (m.type === "delta") onDelta(m.text || "");
  else if (m.type === "tool") onToolMsg(m);
  else if (m.type === "part") onPart(m.properties || {});
  else if (m.type === "approval") renderApproval(m);
  else if (m.type === "actionable") setActionable(m.id);
  else if (m.type === "approvalResolved") resolveApproval(m.id, m.choice);
  else if (m.type === "approvalDone") { decided = true; addStep("approval",
    "Approbation : " + (m.status || "?") + (m.detail ? " - " + m.detail : "")); }
  else if (m.type === "sessions") renderSessions(m.sessions || [], m.current || null);
  else if (m.type === "sessionResumed") addStep("session",
    m.id ? ("Session reprise : " + m.id) : "Nouvelle session au prochain envoi.");
  else if (m.type === "server") setServer(m);
  else if (m.type === "done") renderDone(m);
  else if (m.type === "error") renderError(m.message);
  else if (m.type === "undoResult") addStep("undo",
    m.ok ? ("Annul\\u00e9 : " + (m.restored || []).join(", ")) : ("Echec : " + m.error));
  else if (m.type === "runtime") setRuntime(m);
  else if (m.type === "providers") setProviders(m.providers, m.activeId);
  else if (m.type === "mode") setModeUI(m.mode);
  else if (m.type === "cleared") { thread.innerHTML = ""; currentAgent = null; parts = {}; approvals = {}; }
  else if (m.type === "context") setContext(m);
  else if (m.type === "history") renderHistory(m.turns || []);
});
</script>
</body>
</html>`;
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
        this._resumeSessionId = null; // P27: sticky resume (cleared on folder change)
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
            tokensUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-ui-tokens.css')).toString(),
            hljsUri: webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'highlight.min.js')).toString(),
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
                case 'setModel': await this._handleModel(msg.model); break;
                case 'relaunchServer': await this._relaunchServer('manual'); break;
                case 'listSessions': await this._handleListSessions(); break;
                case 'resumeSession': await this._handleResumeSession(msg.id); break;
                case 'deleteSession': await this._handleDeleteSession(msg.id); break;
                case 'newSession': await this._handleNewSession(); break;
                case 'continue': await this._handleContinue(); break;
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
        if (this.projectRoot !== root) this._resumeSessionId = null;
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
            await this.engine.run({ prompt: text, mode: this.mode, resumeSessionId: this._resumeSessionId || undefined });
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
        const host = getAgentHost();
        this.engine = this._engineFactory({
            server: host.getServer ? host.getServer() : null,
            provider: host.gateAgent || null,
            projectRoot: this.projectRoot,
            mode: this.mode,
        });
        this.engine.on('delta', (d) => this._post({ type: 'delta', text: d.text || '' }));
        this.engine.on('step', (d) => this._post({ type: 'step', phase: d.phase, message: d.message }));
        this.engine.on('tool', (d) => this._post({ type: 'tool', phase: d.phase, tool: d.tool,
            status: d.status || null, code: d.code || '', summary: d.summary || '' }));
        this.engine.on('error', (d) => this._post({ type: 'error', message: d.message, kind: d.kind || null }));
        this.engine.on('approval_needed', (d) => this._onApproval(d));
        this.engine.on('approval_resolved', (d) => this._post({ type: 'approvalDone',
            id: d.reqId, decision: d.decision, status: d.status, detail: d.detail || '' }));
        this.engine.on('done', (d) => this._onDone(d));
    }

    _onDone(d) {
        this._running = false;
        const reason = d.reason || '';
        const noModel = d.status === 'ECHEC' && /NO_MODEL_LOADED|Runtime offline/.test(reason);
        const fileStats = [];
        try {
            for (const rel of (d.filesModified || [])) {
                let before;
                try { before = this._diffStore ? this._diffStore.getBefore(rel) : undefined; }
                catch (_) { before = undefined; }
                let after;
                try { after = fs.readFileSync(path.join(this.projectRoot, rel), 'utf8'); }
                catch (_) { after = undefined; }
                const st = fileStat(before, after);
                fileStats.push({ file: rel, added: st ? st.added : null,
                    removed: st ? st.removed : null });
            }
        } catch (_) { /* display-only, never fail the run */ }
        this._post({ type: 'done', status: d.status, reason, reply: d.reply || '',
            filesModified: d.filesModified || [], fileStats, sessionId: d.sessionId || null,
            mode: d.mode || this.mode, noModel, kind: d.kind || null,
            filesRead: d.filesRead || [] });
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

    // P5-d: external send (used by Sudo Chat "Passer en mode Agent").
    async sendExternal(text) {
        await this._handleSend(text);
    }

    _onApproval(d) {
        const a = { id: (d && (d.id || d.reqId)) || '', action: (d && d.action) || (d && d.tool) || '?',
            title: (d && d.title) || ('Approbation requise : ' + ((d && d.tool) || '?')),
            description: (d && d.description) ||
                [d && d.summary, d && d.detail].filter(Boolean).join(' | ') };
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
        const r = await this.engine.resolveApproval(choice === 'reject' ? 'deny' : choice);
        if (!r || !r.ok) {
            this._post({ type: 'error', message: 'Approbation impossible: ' + ((r && r.error) || '?') });
            return;
        }
        this._resolved.add(id);
        this._post({ type: 'approvalResolved', id, choice, status: r.status || null,
            detail: r.detail || '' });
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
        this._relaunchServer('provider');
    }

    async _relaunchServer(reason) {
        const host = getAgentHost();
        if (!host.relaunch) return; // tests / unactivated host: nothing to relaunch
        if (this._running) {
            this._post({ type: 'error',
                message: 'Arretez la tache en cours avant de relancer le serveur agent.' });
            return;
        }
        try {
            await host.relaunch(reason || 'manual');
            if (host.serverState) this._post(Object.assign({ type: 'server' }, host.serverState()));
        } catch (e) {
            this._post({ type: 'error', message: 'Relance serveur agent: ' + e.message });
        }
    }

    async _handleModel(model) {
        model = (model || '').trim();
        if (!model) return;
        let active = null;
        try { active = getAIProviderService().getActive(); } catch (_) { active = null; }
        if (!active) { this._post({ type: 'error', message: 'Aucun fournisseur actif.' }); return; }
        try {
            const r = await getAIProviderService().updateProvider(active.id, { model });
            if (!r || !r.ok) {
                this._post({ type: 'error', message: 'Modele: ' + ((r && r.error) || '?') });
                return;
            }
        } catch (e) {
            this._post({ type: 'error', message: 'Modele: ' + e.message });
            return;
        }
        this._postProviders();
        this._relaunchServer('model');
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

    _rootOrNull() {
        const folders = vscode.workspace.workspaceFolders;
        const ws = folders && folders[0];
        return ws ? ws.uri.fsPath : null;
    }

    _sessionsEngine() {
        // list/resume/delete work before any run: ensure an engine + root.
        const root = this._rootOrNull();
        if (!root) { this._post({ type: 'error', message: 'Ouvrez un dossier projet d\'abord.' }); return null; }
        if (!this.projectRoot) this.projectRoot = root;
        try { this._ensureEngine(); } catch (e) {
            this._post({ type: 'error', message: 'Moteur agent: ' + e.message });
            return null;
        }
        return this.engine;
    }

    async _handleListSessions() {
        const eng = this._sessionsEngine();
        if (!eng) return;
        try {
            const sessions = await eng.listSessions();
            this._post({ type: 'sessions', sessions,
                current: this._resumeSessionId || (eng.lastSessionId ? eng.lastSessionId() : null) });
        } catch (e) {
            this._post({ type: 'error', message: 'Sessions: ' + e.message });
        }
    }

    async _handleResumeSession(id) {
        if (!id) return;
        if (this._running) {
            this._post({ type: 'error', message: 'Arretez la tache en cours avant de changer de session.' });
            return;
        }
        this._resumeSessionId = id;
        this._post({ type: 'sessionResumed', id });
    }

    async _handleDeleteSession(id) {
        if (!id) return;
        const eng = this._sessionsEngine();
        if (!eng) return;
        try {
            await eng.deleteSession(id);
            if (this._resumeSessionId === id) this._resumeSessionId = null;
            const sessions = await eng.listSessions();
            this._post({ type: 'sessions', sessions, current: null });
        } catch (e) {
            this._post({ type: 'error', message: 'Suppression session: ' + e.message });
        }
    }

    async _handleNewSession() {
        if (this._running) {
            this._post({ type: 'error', message: 'Arretez la tache en cours avant d\'ouvrir une session.' });
            return;
        }
        if (this.engine) { try { await this.engine.stop(); } catch (_) {} }
        this.engine = null; // fresh engine = empty session cache
        this._resumeSessionId = null;
        this._approvals = [];
        this._resolved = new Set();
        this._post({ type: 'sessionResumed', id: null });
    }

    async _handleContinue() {
        if (!this.engine) { this._post({ type: 'error', message: 'Aucun moteur actif.' }); return; }
        if (this._running) {
            this._post({ type: 'error', message: 'Une tache est deja en cours.' });
            return;
        }
        this._running = true;
        this._postRunState();
        try {
            await this.engine.continueAfterApproval();
        } catch (e) {
            this._running = false;
            this._post({ type: 'error', message: e.message });
            this._postRunState();
        }
        // normal path: the engine 'done' event finishes the run.
    }

    _postRunState() {
        this._post({ type: 'runState', running: this._running, queued: this._queue.length });
        try {
            const host = getAgentHost();
            if (host.serverState) this._post(Object.assign({ type: 'server' }, host.serverState()));
        } catch (_) {}
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

module.exports = { AgentPanel, getWebviewHtml, DiffStore, lineStats, fileStat };
