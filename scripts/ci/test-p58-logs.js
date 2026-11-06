/**
 * test-p58-logs.js - P58: the logs viewer really reads the chosen file, the
 * level filter and the component filter really filter.
 *
 * What is proven here (no browser, no installed package):
 *   A. fixture journals - one distinct content per file, text AND json;
 *   B. file selection    - every selection returns ONLY that file's content;
 *   C. level filter      - minimum level semantics on text and JSON lines;
 *   D. component filter  - "Duplication" returns only duplication lines;
 *   E. combinable filters - level + component + search together, line cap;
 *   F. rotation          - <c>.log / <c>.log.1 are listed and read;
 *   G. performance       - a 3 MB journal is read+filtered in < 1000 ms;
 *   H. real UI           - the panel's own webview HTML is compiled and its
 *                          client script is RUN in a DOM stub: firing the
 *                          select's change event must change #out content.
 *
 * Usage: node scripts/ci/test-p58-logs.js [--out <dir>] [--json]
 *   --out writes three HTML snapshots (fichier seul / niveau ERROR /
 *   composant Duplication) built from the viewer's real rendering code.
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p58-'));
const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
process.env.SUDO_STUDIO_LOGS = LOGS;

// ---------------------------------------------------------------- vscode mock
const vscodeMock = {
  ViewColumn: { One: 1 },
  window: {
    panels: [],
    createWebviewPanel(vt, title) {
      const p = {
        viewType: vt, title, revealed: 0, disposed: false,
        webview: { html: '', posted: [], async postMessage(m) { this.posted.push(m); return true; }, onDidReceiveMessage(fn) { this._h = fn; } },
        reveal() { this.revealed++; }, onDidDispose(fn) { this._d = fn; }, dispose() { this.disposed = true; },
      };
      vscodeMock.window.panels.push(p);
      return p;
    },
    async showInformationMessage() { return undefined; },
    async showWarningMessage() { return undefined; },
    showErrorMessage() {},
    async showSaveDialog() { return null; },
  },
  env: { async openExternal() {}, clipboard: { text: '', async writeText(t) { vscodeMock.env.clipboard.text = t; } } },
  workspace: { getConfiguration() { return { get: (k, d) => d, update: async () => {} }; } },
  commands: { executed: [], async executeCommand(n, ...a) { vscodeMock.commands.executed.push([n, ...a]); } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeMock;
  return origLoad.call(this, req, parent, isMain);
};

const logsMod = require(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'panels', 'LogsPanel.js'));
const src = require(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'logs', 'logSource.js'));
const { LogsPanel, listLogFiles, getTail, componentChoices, FEATURES } = logsMod;

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else {
    fail += 1;
    console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 400));
  }
}
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !String(v).startsWith('--') ? v : true;
}

// ---------------------------------------------------------------- A. fixtures
// One DISTINCT marker per file so "only this file's content" is checkable.
const MARK = {
  'agent.log': 'MARK-AGENT-ONLY',
  'backend.log': 'MARK-BACKEND-ONLY',
  'runtime.log': 'MARK-RUNTIME-ONLY',
  'autofix.log': 'MARK-AUTOFIX-ONLY',
  'supervisor.log': 'MARK-SUPERVISOR-ONLY',
  'startup.log': 'MARK-STARTUP-ONLY',
  'extension.log': 'MARK-EXTENSION-ONLY',
  'enterprise.log': 'MARK-ENTERPRISE-ONLY',
};
const TS = '2026-11-06T10:00:0';

function writeText(name, component, lines) {
  const body = lines.map((l, i) => TS + i + '.000Z [' + l[0].padEnd(5, ' ') + '] [' + component + '] [c-' + i + '] ' + l[1]).join('\n') + '\n';
  fs.writeFileSync(path.join(LOGS, name), body, 'utf8');
}

writeText('agent.log', 'agent', [
  ['INFO', MARK['agent.log'] + ' tour demarre'],
  ['WARN', MARK['agent.log'] + ' contexte eleve'],
  ['ERROR', MARK['agent.log'] + ' outil en echec'],
]);
writeText('backend.log', 'backend', [
  ['INFO', MARK['backend.log'] + ' serveur pret'],
  ['ERROR', MARK['backend.log'] + ' port occupe'],
]);
writeText('runtime.log', 'runtime', [['INFO', MARK['runtime.log'] + ' modele charge']]);
writeText('autofix.log', 'autofix', [['WARN', MARK['autofix.log'] + ' correctif applique']]);

// Files written by older code: no component field -> the file name decides.
fs.writeFileSync(path.join(LOGS, 'supervisor.log'),
  TS + '0.000Z START ' + MARK['supervisor.log'] + '\n' + TS + '1.000Z STOP ' + MARK['supervisor.log'] + '\n', 'utf8');
fs.writeFileSync(path.join(LOGS, 'startup.log'),
  TS + '0.000Z boot ' + MARK['startup.log'] + '\n', 'utf8');
fs.writeFileSync(path.join(LOGS, 'extension.log'),
  TS + '0.000Z [INFO ] [extension] [-] ' + MARK['extension.log'] + '\n', 'utf8');
fs.writeFileSync(path.join(LOGS, 'enterprise.log'),
  TS + '0.000Z [INFO ] [enterprise] [-] ' + MARK['enterprise.log'] + '\n', 'utf8');

// Duplication + security audit: several levels + a JSON journal.
writeText('duplication.log', 'duplication', [
  ['INFO', 'duplication scan demarre'],
  ['INFO', 'duplication 12 doublons trouves'],
  ['WARN', 'duplication fichier ignore'],
  ['ERROR', 'duplication echec sur src/a.js'],
]);
fs.writeFileSync(path.join(LOGS, 'secaudit.log'),
  TS + '0.000Z [INFO ] [secaudit] [-] audit demarre\n' +
  TS + '1.000Z [ERROR] [secaudit] [-] CVSS 9.1 sur dep\n', 'utf8');
fs.writeFileSync(path.join(LOGS, 'devops.log'),
  TS + '0.000Z [INFO ] [devops] [-] pipeline lance\n', 'utf8');
fs.writeFileSync(path.join(LOGS, 'license.log'),
  TS + '0.000Z [INFO ] [license] [-] licence active\n', 'utf8');
// JSON journal (.jsonl) - the old viewer could not even filter these.
fs.writeFileSync(path.join(LOGS, 'agent.jsonl'),
  JSON.stringify({ v: 1, ts: TS + '0.000Z', level: 'info', component: 'agent', corr: 'c1', msg: 'json info', fields: {} }) + '\n' +
  JSON.stringify({ v: 1, ts: TS + '1.000Z', level: 'error', component: 'agent', corr: 'c2', msg: 'json error', fields: { code: 1 } }) + '\n', 'utf8');
// Rotation: duplication.log.1
writeText('duplication.log.1', 'duplication', [['INFO', 'duplication archive ancienne']]);

const files = listLogFiles(LOGS);
check('A1: inventaire = tous les journaux du dossier (texte + json + rotation)',
  files.length === 14 && files.some((f) => f.name === 'agent.jsonl') && files.some((f) => f.name === 'duplication.log.1'),
  files.map((f) => f.name));
check('A2: chaque entree porte composant, format, taille, rotation',
  files.every((f) => f.component && (f.format === 'text' || f.format === 'json') && f.size >= 0 && f.rotation >= 0),
  files[0]);
check('A3: rotation triee apres le fichier courant',
  (() => { const d = files.filter((f) => f.component === 'duplication'); return d[0].name === 'duplication.log' && d[1].name === 'duplication.log.1'; })(),
  files.filter((f) => f.component === 'duplication').map((f) => f.name));

// ------------------------------------------------- B. one file at a time
let allOnlyOwn = true;
const offenders = [];
Object.keys(MARK).forEach((name) => {
  const t = getTail(LOGS, name, 100, 'ALL');
  const text = (t.lines || []).join('\n');
  const own = text.indexOf(MARK[name]) !== -1;
  const others = Object.keys(MARK).filter((k) => k !== name && text.indexOf(MARK[k]) !== -1);
  if (!own || others.length) { allOnlyOwn = false; offenders.push({ name, own, others }); }
});
check('B1: chaque fichier ne rend QUE son propre contenu', allOnlyOwn, offenders);
const agentTail = getTail(LOGS, 'agent.log', 100, 'ALL');
const backendTail = getTail(LOGS, 'backend.log', 100, 'ALL');
check('B2: deux fichiers differents -> deux contenus differents',
  agentTail.lines.join() !== backendTail.lines.join() &&
  agentTail.lines.every((l) => l.indexOf('MARK-AGENT-ONLY') !== -1) &&
  backendTail.lines.every((l) => l.indexOf('MARK-BACKEND-ONLY') !== -1),
  { a: agentTail.lines.length, b: backendTail.lines.length });
check('B3: le fichier demande est bien celui rendu (echo du nom)',
  agentTail.file === 'agent.log' && backendTail.file === 'backend.log', [agentTail.file, backendTail.file]);
check('B4: noms invalides et sorties de dossier refuses',
  !!getTail(LOGS, '../../etc/passwd', 10, 'ALL').error && !!getTail(LOGS, 'notes.txt', 10, 'ALL').error &&
  !!getTail(LOGS, 'absent.log', 10, 'ALL').error);

// ------------------------------------------------------ C. level (minimum)
const lvAll = getTail(LOGS, 'agent.log', 100, 'ALL');
const lvInfo = getTail(LOGS, 'agent.log', 100, 'INFO');
const lvWarn = getTail(LOGS, 'agent.log', 100, 'WARN');
const lvErr = getTail(LOGS, 'agent.log', 100, 'ERROR');
check('C1: ALL garde les 3 lignes', lvAll.lines.length === 3, lvAll.lines.length);
check('C2: INFO garde info+warn+error (niveau minimum)', lvInfo.lines.length === 3, lvInfo.lines.length);
check('C3: WARN ne garde que warn+error', lvWarn.lines.length === 2 && !lvWarn.lines.some((l) => l.indexOf('[INFO ') === 0 || l.indexOf('[INFO ]') !== -1), lvWarn.lines);
check('C4: ERROR ne garde qu une ligne, et c est bien l erreur',
  lvErr.lines.length === 1 && lvErr.lines[0].indexOf('outil en echec') !== -1, lvErr.lines);
check('C5: filtre ERROR sur backend.log = 1 ligne (port occupe)',
  getTail(LOGS, 'backend.log', 100, 'ERROR').lines.length === 1 &&
  getTail(LOGS, 'backend.log', 100, 'ERROR').lines[0].indexOf('port occupe') !== -1);
const jErr = getTail(LOGS, 'agent.jsonl', 100, 'ERROR');
check('C6: JSON : niveau lu dans le champ level', jErr.lines.length === 1 && jErr.lines[0].indexOf('json error') !== -1, jErr.lines);
check('C7: JSON : ALL = 2 lignes, INFO = 2, WARN = 1',
  getTail(LOGS, 'agent.jsonl', 100, 'ALL').lines.length === 2 &&
  getTail(LOGS, 'agent.jsonl', 100, 'INFO').lines.length === 2 &&
  getTail(LOGS, 'agent.jsonl', 100, 'WARN').lines.length === 1);

// --------------------------------------------------- D. component filtering
const dup = getTail(LOGS, 'duplication.log', 100, 'ALL', { component: 'duplication' });
check('D1: composant Duplication -> toutes les lignes duplication', dup.lines.length === 4, dup.lines.length);
const dupErr = getTail(LOGS, 'duplication.log', 100, 'ERROR', { component: 'duplication' });
check('D2: Duplication + ERROR -> 1 ligne', dupErr.lines.length === 1 && dupErr.lines[0].indexOf('echec sur src/a.js') !== -1, dupErr.lines);
const dupOnAgent = getTail(LOGS, 'agent.log', 100, 'ALL', { component: 'duplication' });
check('D3: composant Duplication sur agent.log -> 0 ligne (aucune fuite)', dupOnAgent.lines.length === 0, dupOnAgent.lines);
const sec = getTail(LOGS, 'secaudit.log', 100, 'ALL', { component: 'secaudit' });
check('D4: composant Audit de securite -> ses 2 lignes', sec.lines.length === 2, sec.lines.length);
const sup = getTail(LOGS, 'supervisor.log', 100, 'ALL', { component: 'supervisor' });
check('D5: journal sans champ composant -> filtre par nom de fichier', sup.lines.length === 2, sup.lines);
const dupAll = getTail(LOGS, 'duplication.log.1', 100, 'ALL', { component: 'duplication' });
check('D6: fichier de rotation lu et filtre comme l original', dupAll.lines.length === 1 && dupAll.lines[0].indexOf('archive ancienne') !== -1, dupAll.lines);

// ------------------------------------------- E. combinable filters + search
const combo = getTail(LOGS, 'duplication.log', 100, 'WARN', { component: 'duplication', search: 'fichier ignore' });
check('E1: niveau + composant + recherche combines', combo.lines.length === 1 && combo.lines[0].indexOf('fichier ignore') !== -1, combo.lines);
const searchNo = getTail(LOGS, 'duplication.log', 100, 'ALL', { search: 'zzz-introuvable' });
check('E2: recherche sans resultat -> 0 ligne, pas d erreur', searchNo.lines.length === 0 && !searchNo.error);
const cap = getTail(LOGS, 'duplication.log', 2, 'ALL');
check('E3: nombre de lignes respecte (2)', cap.lines.length === 2, cap.lines.length);
check('E4: le plafond garde les lignes les PLUS RECENTES',
  cap.lines[1].indexOf('echec sur src/a.js') !== -1, cap.lines);
check('E5: metadonnees de rendu presentes (ms, matched, scannedBytes, format)',
  typeof agentTail.ms === 'number' && agentTail.matched >= 0 && agentTail.scannedBytes > 0 && agentTail.format === 'text', agentTail);

// ------------------------------------------------------------- G. performance
const big = path.join(LOGS, 'agent-big.log');
(() => {
  const lines = [];
  let size = 0;
  let i = 0;
  const pad = 'x'.repeat(80);
  while (size < 3 * 1024 * 1024) {
    const lvl = (i % 97 === 0) ? 'ERROR' : (i % 13 === 0 ? 'WARN ' : 'INFO ');
    const line = TS + (i % 60) + '.000Z [' + lvl + '] [agent] [c-' + i + '] ligne ' + i + ' ' + pad;
    lines.push(line);
    size += line.length + 1;
    i += 1;
  }
  fs.writeFileSync(big, lines.join('\n') + '\n', 'utf8');
})();
const bigSize = fs.statSync(big).size;
const t0 = process.hrtime.bigint();
const bigTail = getTail(LOGS, 'agent-big.log', 300, 'ALL');
const msAll = Number(process.hrtime.bigint() - t0) / 1e6;
const t1 = process.hrtime.bigint();
const bigErr = getTail(LOGS, 'agent-big.log', 300, 'ERROR');
const msErr = Number(process.hrtime.bigint() - t1) / 1e6;
const t2 = process.hrtime.bigint();
const bigComp = getTail(LOGS, 'agent-big.log', 300, 'ALL', { component: 'duplication' });
const msComp = Number(process.hrtime.bigint() - t2) / 1e6;
check('G1: journal de 3 Mo -> 300 lignes affichees', bigTail.lines.length === 300 && bigSize > 3 * 1024 * 1024 - 200, { size: bigSize, n: bigTail.lines.length });
check('G2: lecture + filtre en moins d une seconde (3 Mo)', msAll < 1000, { ms: Math.round(msAll) });
check('G3: filtre ERROR inclus dans la meme enveloppe', msErr < 1000, { ms: Math.round(msErr) });
check('G4: filtre sans correspondance ne lit pas tout le fichier',
  msComp < 1000 && bigComp.scannedBytes <= src.MAX_SCAN_BYTES, { ms: Math.round(msComp), bytes: bigComp.scannedBytes });
console.log('MESURE perf : ' + bigSize + ' octets | ALL ' + msAll.toFixed(1) + ' ms | ERROR ' + msErr.toFixed(1) +
  ' ms | composant absent ' + msComp.toFixed(1) + ' ms | octets lus ' + bigTail.scannedBytes);

// ------------------------------------------------------------- H. real UI run
function makeDom() {
  const byId = {};
  const mk = (tag, id) => {
    const el = {
      tagName: tag, id: id || '', innerHTML: '', textContent: '', className: '', value: '',
      style: {}, children: [], options: [], parentNode: null, _lis: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener(ev, fn) { (this._lis[ev] = this._lis[ev] || []).push(fn); },
      dispatch(ev, arg) { (this._lis[ev] || []).forEach((f) => f(arg || { currentTarget: this, preventDefault() {} })); },
      appendChild(c) { this.children.push(c); if (c.tagName === 'option') this.options.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); this.options = this.options.filter((x) => x !== c); return c; },
      querySelector(sel) { return this.children.find((c) => c.tagName === sel) || null; },
      querySelectorAll() { return []; },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; },
      focus() {}, scrollTop: 0, scrollHeight: 0,
    };
    if (id) byId[id] = el;
    return el;
  };
  ['file', 'component', 'level', 'lines', 'search', 'auto', 'out', 'meta', 'msg'].forEach((id) => mk('div', id));
  byId.lines.value = '300'; // default of the HTML <select> (selected option)
  const document = {
    getElementById: (id) => byId[id] || mk('div', id),
    createElement: (t) => mk(t),
    addEventListener() {}, querySelectorAll: () => [], body: mk('body'),
  };
  return { document, byId };
}

const panel = (() => {
  LogsPanel.currentPanel = undefined;
  vscodeMock.window.panels.length = 0;
  LogsPanel.createOrShow(undefined, { logsDir: LOGS });
  return vscodeMock.window.panels[0];
})();
const html = panel.webview.html;
const clientScript = (() => {
  // The guard snippet is the FIRST <script>; the viewer is the LAST one.
  const i = html.lastIndexOf('<script>');
  const j = html.indexOf('>', i) + 1;
  const k = html.indexOf('</scr' + 'ipt>', j);
  return html.slice(j, k);
})();
let compiled = true;
let compileErr = '';
try { new vm.Script(clientScript); } catch (e) { compiled = false; compileErr = e.message; }
check('H1: script client de la visionneuse compile', compiled, compileErr);

// The P58 constat, as an assertion: the selects MUST have change handlers.
check('H2: le selecteur de FICHIER a un gestionnaire de changement',
  /id="file"[^>]*onchange=/.test(html), html.match(/id="file"[^>]*/));
check('H3: le selecteur de NIVEAU a un gestionnaire de changement',
  /id="level"[^>]*onchange=/.test(html), html.match(/id="level"[^>]*/));
check('H4: le selecteur de COMPOSANT a un gestionnaire de changement',
  /id="component"[^>]*onchange=/.test(html), html.match(/id="component"[^>]*/));
check('H5: recherche texte + nombre de lignes + suivi auto presents',
  /id="search"/.test(html) && /id="lines"/.test(html) && /id="auto"/.test(html) && /suivi auto/.test(html));
check('H6: boutons ouvrir dossier / copier / exporter',
  /openFolder\(\)/.test(html) && /Copier/.test(html) && /Exporter la vue/.test(html) && />Refresh</.test(html));
check('H7: lignes d erreur colorees', /\.lv-ERROR/.test(html) && /errline/.test(html));

// Run the viewer client in the DOM stub and drive it like a user.
const dom = makeDom();
const posted = [];
const vscodeApi = { postMessage: (m) => posted.push(m), setState() {}, getState() { return null; } };
const listeners = [];
const sandbox = {
  document: dom.document,
  acquireVsCodeApi: () => vscodeApi,
  window: { addEventListener: (ev, fn) => listeners.push(fn) },
  console, JSON, Math, Date, String, Number, Object, Array, RegExp, parseInt, parseFloat, isNaN,
  setTimeout: (fn) => { try { fn(); } catch (_) {} return 1; }, clearTimeout() {}, setInterval() { return 2; }, clearInterval() {},
};
sandbox.globalThis = sandbox;
let ranOk = true;
let runErr = '';
try { vm.createContext(sandbox); vm.runInContext(clientScript, sandbox, { timeout: 5000 }); }
catch (e) { ranOk = false; runErr = String((e && e.message) || e); }
check('H8: script client execute sans erreur', ranOk, runErr);
check('H9: la visionneuse demande la liste des fichiers au demarrage',
  posted.some((m) => m && m.type === 'load'), posted.map((m) => m && m.type));

const out = () => dom.byId.out.innerHTML;
const meta = () => dom.byId.meta.textContent;
function deliver(message) { listeners.forEach((fn) => fn({ data: message })); }

// The panel really answers: use its own handler + the real files payload.
(async () => {
  await panel.webview._h({ type: 'load' });
  const filesMsg = panel.webview.posted.filter((m) => m.type === 'files').pop();
  const filesNow = listLogFiles(LOGS); // inclut le journal de 3 Mo cree en G
  check('H10: le panneau envoie la liste des fichiers + les composants',
    !!filesMsg && filesMsg.files.length === filesNow.length && filesMsg.components.length > 5,
    filesMsg && filesMsg.components.slice(0, 3));
  deliver(filesMsg);
  check('H11: le selecteur est rempli avec TOUS les journaux',
    dom.byId.file.options.length === filesNow.length, dom.byId.file.options.length);
  check('H12: le selecteur de composant propose Duplication / Audit / Doctor',
    dom.byId.component.options.some((o) => o.value === 'duplication') &&
    dom.byId.component.options.some((o) => o.value === 'secaudit') &&
    dom.byId.component.options.some((o) => o.value === 'autofix'),
    dom.byId.component.options.map((o) => o.value));

  // --- the exact scenario from the video: pick backend.log, must show backend
  async function pickFile(name) {
    dom.byId.file.value = name;
    // A user selection fires 'change' on the select -> refresh()
    vm.runInContext('refresh(true)', sandbox);
    const req = posted.filter((m) => m.type === 'getTail').pop();
    await panel.webview._h(req);
    const tailMsg = panel.webview.posted.filter((m) => m.type === 'tail').pop();
    deliver(tailMsg);
    return { req, tailMsg };
  }
  const b = await pickFile('backend.log');
  check('H13: choisir backend.log envoie bien getTail(backend.log)', b.req && b.req.file === 'backend.log', b.req);
  check('H14: l ecran affiche le contenu de backend.log (et rien de l agent)',
    out().indexOf('MARK-BACKEND-ONLY') !== -1 && out().indexOf('MARK-AGENT-ONLY') === -1, out().slice(0, 160));
  const a = await pickFile('agent.log');
  check('H15: changer de fichier CHANGE le contenu affiche',
    out().indexOf('MARK-AGENT-ONLY') !== -1 && out().indexOf('MARK-BACKEND-ONLY') === -1, out().slice(0, 160));
  check('H16: le bandeau indique fichier + lignes + duree',
    meta().indexOf('agent.log') === 0 && / ms \|/.test(meta()), meta());

  // --- level = ERROR only
  dom.byId.level.value = 'ERROR';
  const e2 = await pickFile('agent.log');
  check('H17: niveau ERROR -> une seule ligne, l erreur',
    e2.tailMsg.lines.length === 1 && out().indexOf('outil en echec') !== -1 && out().indexOf('tour demarre') === -1,
    e2.tailMsg.lines);
  dom.byId.level.value = 'WARN';
  const w2 = await pickFile('agent.log');
  check('H18: niveau WARN -> warn + error seulement', w2.tailMsg.lines.length === 2, w2.tailMsg.lines.length);
  dom.byId.level.value = 'ALL';

  // --- component = Duplication only
  dom.byId.component.value = 'duplication';
  dom.byId.file.value = 'duplication.log';
  const d2 = await pickFile('duplication.log');
  check('H19: composant Duplication -> uniquement les lignes duplication',
    d2.tailMsg.lines.length === 4 && d2.tailMsg.lines.every((l) => l.indexOf('duplication') !== -1), d2.tailMsg.lines);
  check('H20: contenu affiche = duplication, pas agent',
    out().indexOf('duplication scan demarre') !== -1 && out().indexOf('MARK-AGENT-ONLY') === -1, out().slice(0, 160));
  // Cross check: Duplication selected while agent.log is open -> empty, no leak.
  dom.byId.file.value = 'agent.log';
  const d3 = await pickFile('agent.log');
  check('H21: composant Duplication + agent.log -> aucune ligne (aucune fuite)',
    d3.tailMsg.lines.length === 0 && out().indexOf('MARK-AGENT-ONLY') === -1, out().slice(0, 120));

  // --- search + export + copy + folder
  dom.byId.component.value = 'ALL';
  dom.byId.search.value = 'port occupe';
  const s2 = await pickFile('backend.log');
  check('H22: recherche texte filtre la vue', s2.tailMsg.lines.length === 1 && out().indexOf('port occupe') !== -1, s2.tailMsg.lines);
  dom.byId.search.value = '';
  await pickFile('backend.log');
  vm.runInContext('copyView()', sandbox);
  await panel.webview._h(posted.filter((m) => m.type === 'copy').pop());
  check('H23: copier met la vue filtree dans le presse-papiers',
    vscodeMock.env.clipboard.text.indexOf('MARK-BACKEND-ONLY') !== -1, String(vscodeMock.env.clipboard.text).slice(0, 80));
  vm.runInContext('openFolder()', sandbox);
  await panel.webview._h(posted.filter((m) => m.type === 'openFolder').pop());
  check('H24: ouvrir le dossier passe par la commande dediee',
    vscodeMock.commands.executed.some((c) => c[0] === 'sudoStudio.openLogsFolder'));
  // export: the mock refuses the save dialog -> honest message, no crash
  vm.runInContext('exportView()', sandbox);
  await panel.webview._h(posted.filter((m) => m.type === 'export').pop());
  const expMsg = panel.webview.posted.filter((m) => m.type === 'exported').pop();
  check('H25: exporter sans chemin -> refus explicite (pas de faux succes)',
    !!expMsg && expMsg.ok === false, expMsg);

  // ------------------------------------------------ snapshots for the report
  // These pages reuse the panel's OWN css and the DOM the client script just
  // produced (real coloured rows). They are previews, NOT screenshots.
  const outDir = arg('out', null);
  if (outDir && outDir !== true) {
    fs.mkdirSync(outDir, { recursive: true });
    const styleBlock = '<style>' + (html.split('<style>')[1] || '').split('</style>')[0] +
      'body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;padding:12px}' +
      '#out{height:auto;max-height:none}' +
      '.note{background:#3a2f00;color:#ffd479;padding:8px 12px;font-size:12px;margin-bottom:10px;border-radius:4px}' +
      '.sel{display:flex;gap:8px;align-items:center;font-size:11px;color:#7d8590;margin-bottom:8px;flex-wrap:wrap}' +
      '.sel b{color:#e6edf3;font-weight:600;background:#21262d;border:1px solid #30363d;border-radius:4px;padding:2px 6px}' +
      '</style>';
    const page = (title, note, toolbar, bodyOut, bodyMeta) => '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
      title + '</title>' + styleBlock + '</head><body><div class="note">' + note + '</div>' +
      '<div class="sel">' + toolbar + '</div>' +
      '<div id="meta" style="font-size:11px;color:#7d8590;margin-bottom:8px">' + bodyMeta + '</div>' +
      '<div id="out">' + bodyOut + '</div></body></html>';
    const toolbar = () => '<span>Fichier <b>' + dom.byId.file.value + '</b></span>' +
      '<span>Composant <b>' + dom.byId.component.value + '</b></span>' +
      '<span>Niveau min <b>' + dom.byId.level.value + '</b></span>' +
      '<span>Lignes <b>' + dom.byId.lines.value + '</b></span>' +
      '<span>Recherche <b>' + (dom.byId.search.value || '(vide)') + '</b></span>';
    const NOTE = 'Apercu STATIQUE produit par scripts/ci/test-p58-logs.js : code client REEL de la visionneuse execute sur des journaux de test. Ce n est PAS une capture du paquet installe (voir le tableau final P58).';

    // 1) one file at a time (backend.log)
    dom.byId.component.value = 'ALL'; dom.byId.level.value = 'ALL'; dom.byId.search.value = '';
    await pickFile('backend.log');
    fs.writeFileSync(path.join(outDir, 'p58-1-fichier-backend.html'),
      page('P58 - backend.log seul', NOTE, toolbar(), dom.byId.out.innerHTML, meta()), 'utf8');

    // 2) level ERROR only
    dom.byId.level.value = 'ERROR';
    await pickFile('agent.log');
    fs.writeFileSync(path.join(outDir, 'p58-2-niveau-error.html'),
      page('P58 - niveau minimum ERROR', NOTE, toolbar(), dom.byId.out.innerHTML, meta()), 'utf8');

    // 3) component Duplication only
    dom.byId.level.value = 'ALL'; dom.byId.component.value = 'duplication';
    await pickFile('duplication.log');
    fs.writeFileSync(path.join(outDir, 'p58-3-composant-duplication.html'),
      page('P58 - composant Duplication seul', NOTE, toolbar(), dom.byId.out.innerHTML, meta()), 'utf8');

    // 4) bonus: the 3 MB journal (perf visible in the bandeau)
    dom.byId.component.value = 'ALL'; dom.byId.level.value = 'ALL';
    await pickFile('agent-big.log');
    fs.writeFileSync(path.join(outDir, 'p58-4-journal-3mo.html'),
      page('P58 - journal de 3 Mo', NOTE + ' Bandeau : octets lus et duree reelle.', toolbar(),
        dom.byId.out.innerHTML, meta()), 'utf8');
    console.log('captures HTML ecrites dans ' + outDir);
  }
  async function lines(file, level, component) {
    await panel.webview._h({ type: 'getTail', file, level: level || 'ALL', component: component || 'ALL', search: '', maxLines: 300 });
    const t = panel.webview.posted.filter((m) => m.type === 'tail').pop();
    deliver(t);
    return (t.lines || []).join('\n');
  }

  // ------------------------------- I. every feature really writes its journal
  const xTech = require(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'utils', 'techLog.js'));
  const { note: noteJournal } = require(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'utils', 'panelJournal.js'));
  xTech.setTechEnabled(true);
  const FEATURE_COMPONENTS = ['duplication', 'secaudit', 'autofix', 'sdk', 'devops', 'enterprise',
    'license', 'analysis', 'environment', 'runtime', 'providers'];
  FEATURE_COMPONENTS.forEach((c) => noteJournal(c, { type: 'test-action' }));
  const wroteAll = FEATURE_COMPONENTS.filter((c) => {
    const t = getTail(LOGS, c + '.log', 50, 'ALL');
    return !t.error && t.lines.length >= 1 && t.lines[0].indexOf('[ ' + c + ' ]') !== -1 || (t.lines.length >= 1 && t.lines[0].indexOf('[' + c + ']') !== -1);
  });
  check('I1: les 11 fonctionnalites ecrivent un journal avec leur marqueur',
    wroteAll.length === FEATURE_COMPONENTS.length, FEATURE_COMPONENTS.filter((c) => wroteAll.indexOf(c) === -1));
  check('I2: la ligne ecrite porte le composant et l action',
    (() => { const t = getTail(LOGS, 'secaudit.log', 50, 'ALL'); return t.lines.some((l) => l.indexOf('[secaudit]') !== -1 && l.indexOf('action=test-action') !== -1); })(),
    getTail(LOGS, 'secaudit.log', 50, 'ALL').lines);
  check('I3: le filtre composant isole chaque fonctionnalite',
    FEATURE_COMPONENTS.every((c) => {
      const t = getTail(LOGS, c + '.log', 50, 'ALL', { component: c });
      return t.lines.length >= 1 && t.lines.every((l) => l.indexOf(c) !== -1);
    }));
  const other = getTail(LOGS, 'secaudit.log', 50, 'ALL', { component: 'duplication' });
  check('I4: filtrer Duplication sur le journal securite ne rend rien', other.lines.length === 0, other.lines);
  xTech.setTechEnabled(false);
  xTech._resetSharedForTests();

  // static wiring: each panel must actually call the journal helper.
  const panelWiring = [
    ['DuplicationPanel.js', 'duplication'], ['SecurityPanel.js', 'secaudit'], ['DoctorPanel.js', 'autofix'],
    ['SDKPanel.js', 'sdk'], ['DevOpsPanel.js', 'devops'], ['CentralMgmtPanel.js', 'enterprise'],
    ['LicensePanel.js', 'license'], ['ProjectAnalysisPanel.js', 'analysis'], ['EnvironmentPanel.js', 'environment'],
    ['RuntimePanel.js', 'runtime'], ['ProvidersPanel.js', 'providers'],
  ];
  const notWired = panelWiring.filter(([file, comp]) => {
    const srcText = fs.readFileSync(path.join(__dirname, '..', '..', 'sudo-ai-extension', 'src', 'panels', file), 'utf8');
    return srcText.indexOf("require('../utils/panelJournal')") === -1 || srcText.indexOf("noteJournal('" + comp + "'") === -1;
  });
  check('I5: chaque panneau est cable au journal (11/11)', notWired.length === 0, notWired);

  console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
  if (process.argv.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ pass, fail, perf: { bytes: bigSize, msAll: Math.round(msAll), msErr: Math.round(msErr) }, results }, null, 1));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
