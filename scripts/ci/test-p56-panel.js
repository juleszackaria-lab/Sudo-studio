/**
 * test-p56-panel.js - P56: the plan card, the "etape n/N" indicator and the
 * "Reprendre" button are really wired in the Agent panel.
 *
 * No browser here: the HTML rendered by the PRODUCT (AgentPanel.getWebviewHtml)
 * is executed in a minimal DOM, and the engine's real _onSse is driven with
 * job.plan / job.step / job.done payloads. Nothing is asserted that the
 * product does not actually do.
 *
 * Usage: node scripts/ci/test-p56-panel.js [--out <fichier.html>]
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const Module = require('module');
const origResolve = Module._resolveFilename;
const VSCODE_STUB = path.join(os.tmpdir(), 'p56-vscode-stub.js');
fs.writeFileSync(VSCODE_STUB, 'module.exports = { window:{}, workspace:{ workspaceFolders: [] }, Uri:{ file:(p)=>({fsPath:p}) }, commands:{ executeCommand: async()=>{}, registerCommand:()=>{} }, ViewColumn:{ One:1 }, EventEmitter: class { on(){} fire(){} }, env:{}, version:"1.0.0" };\n', 'utf8');
Module._resolveFilename = function (request, parent, isMain, opts) {
  if (request === 'vscode') return VSCODE_STUB;
  return origResolve.call(this, request, parent, isMain, opts);
};

const EXT = path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'agent');
const panelMod = require(path.join(EXT, 'AgentPanel.js'));
const engineMod = require(path.join(EXT, 'AgentEngine.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 400)); }
}
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--') ? process.argv[i + 1] : true;
}

const html = panelMod.getWebviewHtml({
  nonce: 'p56nonce', cspSource: 'vscode-webview://x', codiconUri: 'codicon.css',
  tokensUri: '', hljsUri: '', variant: 'agent',
});

// ------------------------------------------------------------- 1. balisage
check('carte du plan : styles dedies', /\.jobcard/.test(html) && /\.jobcard pre\.jobplan/.test(html) && /\.jobcard \.jobacts/.test(html));
check('indicateur de progression : style dedie', /\.jobind/.test(html));
check('les evenements "job" du moteur sont recus par le webview', /m\.type === "job"/.test(html) && /onJobMsg/.test(html));
check('boutons Lancer et Modifier presents dans le code du webview',
  /b1\.textContent = "Lancer"/.test(html) && /b2\.textContent = "Modifier"/.test(html));
check('bouton Reprendre present', /rb\.textContent = "Reprendre"/.test(html));
check('l etape courante est affichee "n/N"', /"Etape " \+ m\.n \+ "\/" \+ m\.N/.test(html));
check('progression sticky (visible pendant le defilement)', /position:sticky/.test(html));

// --------------------------------------------------------- 2. DOM minimal
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
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
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
    // 'jobind' nait du code du panneau : absent = pas d indicateur, c est ce
    // qu on veut pouvoir observer. Les autres identifiants sont crees a la
    // demande (le vrai DOM rend toujours un noeud pour un id du balisage).
    getElementById: (id) => {
      if (nodes[id]) return nodes[id];
      // Un noeud cree dynamiquement porte son id sur l element lui-meme.
      const inThread = nodes.thread.children.filter((c) => c.id === id);
      if (inThread.length) return inThread[0];
      if (id === 'jobind') return null; // indicateur absent = pas de projet en cours
      return mk(id);
    },
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
  console, JSON, Math, Date, parseInt, parseFloat, isNaN, String, Number, Object, Array, RegExp, Set, Map,
  setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(extractScript(html), sandbox, { timeout: 5000 });
  check('script du webview execute sans erreur', true);
} catch (e) {
  check('script du webview execute sans erreur', false, String((e && e.message) || e).slice(0, 300));
}

const thread = dom.nodes.thread;
// Les lignes d'etape vivent dans le rail de l'agent, pas a la racine du fil :
// on parcourt tout l'arbre (comme le fait l'oeil de l'utilisateur).
function walk(node, out) {
  out = out || [];
  for (const c of (node.children || [])) { out.push(c); walk(c, out); }
  return out;
}
const stepLines = () => walk(thread).filter((c) => c.className === 'stepline').map((c) => c.textContent);
const findCards = () => thread.children.filter((c) => c.className === 'jobcard');
const buttonsOf = (card) => {
  const row = card.children.find((c) => c.className === 'jobacts');
  return row ? row.children : [];
};

// ------------------------------------------------------- 3. carte du plan
const PLAN = 'PLAN DU CAHIER DES CHARGES : gestionnaire de taches\n60 ligne(s), 4 section(s), 56 exigence(s) numerotee(s), 20 etape(s).\nSECTIONS\n  1. Donnees\nEXIGENCES\n  R1 (S1) creer une tache\nETAPES\n  1/20 [R1,R2,R3] init\nValidez pour lancer (Lancer / Modifier).';
try {
  sandbox.onJobMsg({ phase: 'plan', jobId: 'job-1', specId: 'spec-abc', title: 'gestionnaire de taches',
    requirements: 56, steps: 20, sections: 4, plan: PLAN });
  const cards = findCards();
  check('plan recu : une carte est affichee', cards.length === 1, cards.length);
  const card = cards[0];
  const head = card.children.find((c) => c.className === 'jobhead');
  check('en-tete : titre + 56 exigences + 20 etapes',
    /gestionnaire de taches/.test(head.textContent) && /56 exigences/.test(head.textContent) && /20 etapes/.test(head.textContent),
    head.textContent);
  const pre = card.children.find((c) => c.className === 'jobplan');
  check('le plan complet (sections + exigences + etapes) est visible',
    /PLAN DU CAHIER/.test(pre.textContent) && /R1 \(S1\)/.test(pre.textContent) && /1\/20/.test(pre.textContent), pre.textContent.slice(0, 80));
  const btns = buttonsOf(card);
  check('deux boutons : Lancer et Modifier', btns.length === 2 && btns[0].textContent === 'Lancer' && btns[1].textContent === 'Modifier',
    btns.map((b) => b.textContent));

  // clic Modifier : la saisie propose de modifier (aucun envoi)
  const before = dom.posted.length;
  btns[1]._listeners.click[0]();
  check('Modifier : prepare la saisie sans lancer le projet',
    /modifier/.test(dom.nodes.agentInput.value) && dom.posted.length === before, dom.nodes.agentInput.value);

  // clic Lancer : envoie "lancer" et retire la carte
  btns[0]._listeners.click[0]();
  const last = dom.posted[dom.posted.length - 1] || {};
  check('Lancer : envoie "lancer" a l agent', last.type === 'send' && last.text === 'lancer', last);
  check('Lancer : les boutons disparaissent (impossible de lancer deux fois)',
    buttonsOf(card).length === 0 || card.children.every((c) => c.className !== 'jobacts'));
  check('Lancer : le plan reste lisible pendant la construction',
    !!card.children.find((c) => c.className === 'jobplan'));

  // message utilisateur visible dans le fil
  check('le fil montre la demande envoyee', thread.children.some((c) => c.className === 'msg user' && c.textContent === 'lancer'));
} catch (e) {
  check('carte du plan (comportement)', false, String((e && e.message) || e).slice(0, 300));
}

// ---------------------------------------------------- 4. etape n/N + echecs
try {
  sandbox.onJobMsg({ phase: 'step', status: 'start', n: 3, N: 20, text: 'realiser R7, R8, R9' });
  let ind = dom.document.getElementById('jobind');
  check('progression : "Etape 3/20" affichee', !!ind && /Etape 3\/20/.test(ind.textContent), ind && ind.textContent);
  check('progression : le libelle de l etape est visible', /realiser R7/.test(ind.textContent), ind && ind.textContent);
  sandbox.onJobMsg({ phase: 'step', status: 'done', n: 3, N: 20, done: 3 });
  ind = dom.document.getElementById('jobind');
  check('progression : avancement en etapes faites', /3 faites/.test(ind.textContent), ind.textContent);
  sandbox.onJobMsg({ phase: 'step', status: 'failed', n: 4, N: 20, detail: 'aucune modification verifiee' });
  check('echec d etape : ligne "NON REALISEE" dans le fil',
    stepLines().some((t) => /NON REALISEE/.test(t)), stepLines().slice(-3));
  sandbox.onJobMsg({ phase: 'done', done: 19, failed: 1, skipped: 0, total: 20 });
  check('fin de projet : progression retiree', dom.document.getElementById('jobind') === null);
  check('fin de projet : bilan affiche (19 faites, 1 en echec)',
    stepLines().some((t) => /19 faites, 1 en echec/.test(t)), stepLines().slice(-3));
} catch (e) {
  check('progression et echecs (comportement)', false, String((e && e.message) || e).slice(0, 300));
}

// ------------------------------------------------------- 5. bouton Reprendre
try {
  sandbox.onJobMsg({ phase: 'resumable', resumable: { id: 'job-1', title: 'gestionnaire de taches',
    done: 11, total: 20, status: 'stopped' } });
  const cards = findCards();
  const rc = cards[cards.length - 1];
  check('projet interrompu : une carte "Reprendre" est proposee',
    !!rc && /Projet interrompu/.test((rc.children.find((c) => c.className === 'jobhead') || {}).textContent || ''), cards.length);
  const head = rc.children.find((c) => c.className === 'jobhead');
  check('la carte dit ou en est le projet (11/20)', /11\/20/.test(head.textContent), head.textContent);
  const btns = buttonsOf(rc);
  check('un seul bouton : Reprendre', btns.length === 1 && btns[0].textContent === 'Reprendre', btns.map((b) => b.textContent));
  btns[0]._listeners.click[0]();
  const last = dom.posted[dom.posted.length - 1] || {};
  check('Reprendre : envoie "reprendre le projet"', last.type === 'send' && last.text === 'reprendre le projet', last);
  check('Reprendre : le bouton disparait (une seule reprise possible)', buttonsOf(rc).length === 0, buttonsOf(rc).length);
} catch (e) {
  check('bouton Reprendre (comportement)', false, String((e && e.message) || e).slice(0, 300));
}

// ------------------------- 6. moteur d extension : evenements job.plan/step/done
try {
  const evts = [];
  const fakeThis = {
    _raw(t, o) { evts.push({ t, o }); },
    _leg(t, o) { evts.push({ t, o }); },
  };
  const onSse = engineMod.AgentEngine ? engineMod.AgentEngine.prototype._onSse : null;
  check('moteur : _onSse accessible', typeof onSse === 'function');
  const noop = () => {};
  onSse.call(fakeThis, 'sid1', 'job.plan', { jobId: 'job-1', specId: 'spec-a', title: 'T', steps: 20, requirements: 56, sections: 4, plan: PLAN }, noop);
  onSse.call(fakeThis, 'sid1', 'job.step', { jobId: 'job-1', n: 2, N: 20, status: 'start', text: 'x'.repeat(500), reqs: ['R4'], files: [] }, noop);
  onSse.call(fakeThis, 'sid1', 'job.done', { jobId: 'job-1', done: 20, failed: 0, skipped: 0, total: 20, report: 'rapport' }, noop);
  const plan = evts.find((e) => e.t === 'job' && e.o.phase === 'plan');
  const step = evts.find((e) => e.t === 'job' && e.o.phase === 'step');
  const done = evts.find((e) => e.t === 'job' && e.o.phase === 'done');
  check('moteur : job.plan devient un evenement "job" du panneau', !!plan && plan.o.requirements === 56 && /PLAN DU CAHIER/.test(plan.o.plan));
  check('moteur : job.step porte n/N et un texte borne', !!step && step.o.n === 2 && step.o.N === 20 && step.o.text.length <= 203);
  check('moteur : job.done porte le bilan', !!done && done.o.done === 20 && done.o.total === 20);
  check('moteur : chaque evenement est aussi emis sur l EventEmitter', evts.filter((e) => e.t === 'job').length === 6, evts.length);
} catch (e) {
  check('moteur : evenements job (comportement)', false, String((e && e.message) || e).slice(0, 300));
}

// ------------------------------- 7. apercu statique (PAS une capture d ecran)
const outFile = String(arg('out', path.join(os.tmpdir(), 'p56-panel-preview.html')));
try {
  const preview = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>P56 - panneau Agent (apercu statique)</title>
<style>
body { font-family: system-ui, sans-serif; background:#1e1e1e; color:#ddd; margin:0; }
.note { background:#3a2f00; color:#ffd479; padding:8px 16px; font-size:13px; }
#thread { padding:16px; max-width:760px; }
.jobcard { border:1px solid #444; border-radius:8px; padding:8px 10px; margin:8px 0; background:#252526; }
.jobcard .jobhead { font-size:12px; font-weight:600; margin-bottom:6px; }
.jobcard pre.jobplan { background:#1b1b1b; border-radius:6px; padding:8px 10px; font-size:12px;
  white-space:pre-wrap; max-height:220px; overflow:auto; margin:0 0 8px; }
.jobacts { display:flex; gap:8px; }
.btn { background:#0e639c; color:#fff; border:0; border-radius:6px; padding:4px 12px; font-size:12px; }
.btn.ghost { background:#3a3d41; }
.jobind { position:sticky; bottom:0; font-size:12px; padding:4px 8px; background:#1b1b1b; border-radius:6px; color:#9fd0ff; }
.stepline { font-size:12px; color:#aaa; padding:2px 0; }
.msg.user { background:#2d2d30; border-radius:8px; padding:6px 10px; margin:6px 0; font-size:13px; }
</style></head><body>
<div class="note">Apercu STATIQUE construit a partir du balisage reel du panneau (getWebviewHtml).
Ce n est PAS une capture de l application installee : aucun test dans cet environnement n ouvre l editeur.</div>
<div id="thread">
  <div class="msg user">${PLAN.split('\n')[0]}</div>
  <div class="jobcard">
    <div class="jobhead">Cahier des charges : gestionnaire de taches - 56 exigences, 20 etapes</div>
    <pre class="jobplan">${PLAN.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
    <div class="jobacts"><button class="btn">Lancer</button><button class="btn ghost">Modifier</button></div>
  </div>
  <div class="msg user">lancer</div>
  <div class="stepline">Projet : etape 1/20 - init du projet</div>
  <div class="stepline">Etape 4/20 NON REALISEE : aucune modification verifiee</div>
  <div class="jobind">Etape 12/20 : realiser R32, R33, R34</div>
  <div class="jobcard">
    <div class="jobhead">Projet interrompu : gestionnaire de taches - 11/20 etapes faites</div>
    <div class="jobacts"><button class="btn">Reprendre</button></div>
  </div>
</div>
</body></html>`;
  fs.writeFileSync(outFile, preview, 'utf8');
  check('apercu statique ecrit et etiquete "PAS une capture"',
    fs.existsSync(outFile) && /PAS une capture/.test(fs.readFileSync(outFile, 'utf8')), outFile);
} catch (e) {
  check('apercu statique', false, String((e && e.message) || e).slice(0, 200));
}

console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
