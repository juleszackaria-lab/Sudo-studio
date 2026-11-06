/**
 * test-p57-panel.js - P57(7): le panneau Agent montre reellement les extensions.
 *
 * Pas de navigateur dans cet environnement : on rend le HTML REELLEMENT produit
 * par AgentPanel.getWebviewHtml() (la fonction du produit, pas une maquette),
 * puis on verifie le balisage et on execute les fonctions webview pures dans un
 * DOM minimal pour prouver le comportement (badge, completion "/" et "@",
 * lignes repliees, selecteur d'agent). Un apercu HTML statique est aussi ecrit
 * (p57-panel-preview.html) pour l'oeil humain : ce n'est PAS une capture de
 * l'application installee, c'est dit explicitement dans le fichier.
 *
 * Usage : node scripts/ci/test-p57-panel.js [--out <fichier.html>]
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// Le panneau est un module d'extension : il exige 'vscode'. On installe un
// stub minimal (aucun acces reel a l'editeur) avant de le charger.
const Module = require('module');
const origResolve = Module._resolveFilename;
const VSCODE_STUB = path.join(os.tmpdir(), 'p57-vscode-stub.js');
fs.writeFileSync(VSCODE_STUB, 'module.exports = { window:{}, workspace:{ workspaceFolders: [] }, Uri:{ file:(p)=>({fsPath:p}) }, commands:{ executeCommand: async()=>{}, registerCommand:()=>{} }, ViewColumn:{ One:1 }, EventEmitter: class { on(){} fire(){} }, env:{}, version:"1.0.0" };\n', 'utf8');
Module._resolveFilename = function (request, parent, isMain, opts) {
    if (request === 'vscode') return VSCODE_STUB;
    return origResolve.call(this, request, parent, isMain, opts);
};

const panelMod = require(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'agent', 'AgentPanel.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('PASS ' + name); }
    else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 300)); }
}
function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    return process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--') ? process.argv[i + 1] : true;
}

const html = panelMod.getWebviewHtml({
    nonce: 'p57nonce', cspSource: 'vscode-webview://x', codiconUri: 'codicon.css',
    tokensUri: '', hljsUri: '', variant: 'agent',
});

// -- 1. balisage -------------------------------------------------------------
check('en-tete : badge "N MCP, N skills actifs"', /id="extBadge"/.test(html) && /id="extTxt">0 MCP, 0 skill actif</.test(html));
check('en-tete : selecteur d agent', /<select id="agentSel"/.test(html) && /<option value="Build">Build<\/option>/.test(html));
check('styles : badge + liste de completion', /\.extbadge/.test(html) && /#compl \.it/.test(html));
check('ligne repliee d extension : style dedie', /details\.toolrow\.ext \.tname/.test(html));
check('completion : touche Entree/Tab/Fleches cablee',
    /ArrowDown/.test(html) && /applyCompl/.test(html) && /refreshCompl/.test(html));
check('messages : extensions et agent recus',
    /m\.type === "extensions"/.test(html) && /m\.type === "agent"/.test(html));
check('badge cliquable (rafraichir)', /refreshExtensions/.test(html));

// -- 2. DOM minimal : on execute le script du webview -----------------------
function makeDom() {
    const nodes = {};
    const mk = (id) => {
        const el = {
            id, innerHTML: '', textContent: '', title: '', value: '', className: '', style: {},
            children: [], parentNode: null, _listeners: {},
            classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
            addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
            querySelectorAll() { return this.children; },
            querySelector() { return this.children[0] || null; },
            setAttribute(k, v) { this[k] = v; },
            getAttribute(k) { return this[k]; },
            focus() { /* noop */ },
            scrollHeight: 0, scrollTop: 0, clientHeight: 0,
        };
        nodes[id] = el;
        return el;
    };
    ['thread', 'agentInput', 'btnSend', 'btnStop', 'queueBadge', 'modeSel', 'providerSel', 'modelSel',
        'srvDot', 'srvTxt', 'rtDot', 'rtTxt', 'extBadge', 'extTxt', 'agentSel', 'composer', 'empty'].forEach(mk);
    const document = {
        getElementById: (id) => nodes[id] || mk(id),
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => mk('_' + tag + '_' + Math.random().toString(36).slice(2)),
        addEventListener: () => {},
    };
    const posted = [];
    const vscode = { postMessage: (m) => posted.push(m), setState: () => {}, getState: () => null };
    return { document, posted, vscode, nodes };
}

function extractScript(h) {
    const i = h.lastIndexOf('<script nonce=');
    const j = h.indexOf('>', i) + 1;
    const k = h.lastIndexOf('</script>');
    return h.slice(j, k);
}

const dom = makeDom();
const sandbox = {
    document: dom.document,
    acquireVsCodeApi: () => dom.vscode,
    window: { addEventListener: () => {} },
    console,
    JSON, Math, Date, parseInt, parseFloat, isNaN, String, Number, Object, Array, RegExp, Set, Map,
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
};
sandbox.globalThis = sandbox;
try {
    vm.createContext(sandbox);
    vm.runInContext(extractScript(html), sandbox, { timeout: 5000 });
    check('script du webview execute sans erreur', true);
} catch (e) {
    check('script du webview execute sans erreur', false, String((e && e.message) || e).slice(0, 200));
}

// -- 3. comportement : badge + completion ----------------------------------
try {
    sandbox.setExtensions(
        { mcpEnabled: 1, skillsActive: 2, commands: 3, agents: 1, label: '1 MCP, 2 skills actifs' },
        {
            mcp: [{ name: 'render', description: 'Deploiement Render', enabled: true, tools: ['deploy'] }],
            skills: [{ name: 'render-deploy', description: 'Deploie sur Render', active: true }],
            commands: [{ name: 'deploiement', description: 'Deploie le projet' }],
            agents: [{ name: 'Build', builtin: true }, { name: 'Deployeur', description: 'Agent de deploiement', builtin: false }],
        });
    check('badge affiche le resume recu', dom.nodes.extTxt.textContent === '1 MCP, 2 skills actifs', dom.nodes.extTxt.textContent);
    check('badge actif (classe on)', dom.nodes.extBadge.classList.contains('on'));
    check('selecteur d agent rempli', /Deployeur/.test(dom.nodes.agentSel.innerHTML), dom.nodes.agentSel.innerHTML);

    const src = sandbox.completionSource();
    check('completion : commande /deploiement proposee', src.some((x) => x.k === '/deploiement'), src.map((x) => x.k));
    check('completion : skill @render-deploy propose', src.some((x) => x.k === '@render-deploy'), src.map((x) => x.k));
    check('completion : agent @Deployeur propose', src.some((x) => x.k === '@Deployeur'), src.map((x) => x.k));

    // lignes d'extension : cible "serveur : outil" et message hors ligne clair
    const tgt = sandbox.toolTarget({ tool: 'mcp_call', args: { serveur: 'render', outil: 'deploy' } }, {});
    check('ligne extension : cible "render : deploy"', tgt === 'render : deploy', tgt);
    const tgtSkill = sandbox.toolTarget({ tool: 'skill_load', args: { name: 'render-deploy' } }, {});
    check('ligne extension : skill nomme', tgtSkill === 'render-deploy', tgtSkill);
    const hint = sandbox.extHint('mcp_call', { args: { serveur: 'render' }, state: { error: 'serveur MCP hors ligne' } });
    check('hors ligne : message clair non bloquant',
        /hors ligne/.test(hint) && /repli CLI/.test(hint) && /non verifie/.test(hint), hint);
    const hint2 = sandbox.extHint('mcp_call', { args: { serveur: 'render' }, summary: 'serveur MCP hors ligne (ECONNREFUSED)' });
    check('hors ligne : detecte aussi via le resume tool.result', /render hors ligne/.test(hint2), hint2);
    check('pas de message hors ligne sans erreur reseau', sandbox.extHint('mcp_call', { state: { status: 'completed' } }) === '');
    check('pas de message pour un outil ordinaire', sandbox.extHint('bash', { state: { error: 'hors ligne' } }) === '');

    // frappe de "/dep" -> liste filtree
    dom.nodes.agentInput.value = '/dep';
    sandbox.refreshCompl();
    const compl = dom.nodes.composer.children.find((c) => c.id === 'compl');
    check('completion : liste affichee pour "/dep"', !!compl && compl.children.length === 1, compl && compl.children.length);
    // Tab insere le texte
    sandbox.applyCompl(0);
    check('completion : Tab insere "/deploiement "', dom.nodes.agentInput.value === '/deploiement ', dom.nodes.agentInput.value);
    // "@render" -> skill
    dom.nodes.agentInput.value = 'deploie @rend';
    sandbox.refreshCompl();
    const compl2 = dom.nodes.composer.children.find((c) => c.id === 'compl');
    check('completion : liste affichee pour "@rend"', !!compl2 && compl2.children.length === 1,
        dom.nodes.composer.children.map((c) => c.id + ':' + (c.children || []).length));
} catch (e) {
    check('comportement webview (badge/completion)', false, String((e && e.message) || e).slice(0, 200));
}

// -- 4. apercu HTML statique (pour l'oeil humain, PAS une capture de l'app) --
const outFile = String(arg('out', path.join(os.tmpdir(), 'p57-panel-preview.html')));
try {
    const badge = '1 MCP, 1 skill actif';
    const rows = [
        ['ext', 'extensions_list', 'tout', 'ok'],
        ['ext', 'skill', 'render-deploy', 'ok'],
        ['', 'bash', 'node -e "process.exit(0)"', 'ok'],
        ['ext', 'MCP', 'render : deploy', 'ok'],
        ['ext', 'MCP', 'render : status', 'ok'],
    ].map(([cls, name, tgt, st]) => '      <details class="toolrow' + (cls ? ' ' + cls : '') + '"><summary><span class="dot ok"></span>'
        + '<span class="tname">' + name + '</span><span class="tgt">' + tgt + '</span>'
        + '<span class="tst">' + st + '</span></summary><pre>{"ok": true}</pre></details>').join('\n');
    const preview = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>P57 - panneau Agent (apercu statique)</title>
<style>
body { font-family: system-ui, sans-serif; background:#1e1e1e; color:#ddd; margin:0; }
.note { background:#3a2f00; color:#ffd479; padding:8px 16px; font-size:13px; }
#hdr { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid #333; flex-wrap:wrap; }
#hdr .title { font-weight:600; margin-right:8px; }
.extbadge { display:inline-flex; gap:6px; font-size:12px; color:#9fd0ff; background:#2a2a2a; border:1px solid #3a7bd5; border-radius:6px; padding:3px 8px; }
.sandbox { font-size:12px; color:#888; padding:2px 6px; border:1px solid #444; border-radius:6px; }
select { background:#2a2a2a; color:#ddd; border:1px solid #444; border-radius:6px; padding:4px 8px; font-size:12px; }
#thread { padding:16px; }
.rail { border-left:1px solid #333; margin-left:6px; padding-left:14px; }
details.toolrow summary { cursor:pointer; display:flex; gap:8px; font-size:12px; padding:3px 0; align-items:center; }
details.toolrow.ext .tname { color:#7fb8ff; }
details.toolrow.ext .tname::before { content:">"; opacity:0.6; margin-right:4px; }
.tgt { color:#888; } .tst { margin-left:auto; color:#777; font-size:11px; }
.dot.ok { width:8px; height:8px; border-radius:50%; background:#3fb950; display:inline-block; }
#composer { border-top:1px solid #333; padding:10px 16px; position:relative; }
#compl { position:absolute; left:16px; right:16px; bottom:100%; background:#252526; border:1px solid #3c3c3c; border-radius:6px; }
#compl .it { display:flex; gap:8px; padding:5px 10px; font-size:12px; }
#compl .it.sel { background:#0e639c; color:#fff; }
#compl .k { font-family:ui-monospace,monospace; font-weight:600; }
</style></head>
<body>
<div class="note">Apercu STATIQUE genere par scripts/ci/test-p57-panel.js a partir du balisage du panneau reel.
Ce n'est PAS une capture de l'application installee : voir le tableau final du rapport P57.</div>
<div id="hdr">
  <span class="title">Sudo Agent</span>
  <span class="sandbox">Build | Plan</span>
  <span class="sandbox">Mode restreint</span>
  <span class="extbadge">&#9881; ${badge}</span>
  <select><option>Deployeur</option><option>Build</option><option>Plan</option></select>
</div>
<div id="thread"><div class="rail">
${rows}
</div></div>
<div id="composer">
  <div id="compl"><div class="it sel"><span class="k">/deploiement</span><span>Deploie le projet sur Render</span></div>
  <div class="it"><span class="k">@render-deploy</span><span>Deploie sur Render (skill actif)</span></div></div>
  <div style="font-size:13px;color:#ccc">deploie ce projet sur Render</div>
</div>
</body></html>`;
    fs.writeFileSync(outFile, preview, 'utf8');
    check('apercu HTML ecrit', fs.existsSync(outFile));
    console.log('apercu : ' + outFile);
} catch (e) {
    check('apercu HTML ecrit', false, String((e && e.message) || e).slice(0, 200));
}

console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
