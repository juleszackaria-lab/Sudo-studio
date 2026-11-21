/**
 * SUDO AGENT - P67(B4/B5/B6): le modele ne doit plus etre le point de
 * defaillance pour les ACTIONS.
 *
 * Deux voies, aucune ne demande au petit modele de produire du JSON:
 *
 *  1. INTENTIONS DETERMINISTES (directIntents): quand la demande est sans
 *     ambiguite ("cree un fichier test.txt contenant bonjour", "change la
 *     couleur principale en vert"), l'AGENT construit lui-meme l'appel d'outil
 *     et le fait passer par le chemin normal (approbation, journal, verdict).
 *     Le modele n'est appele que pour reformuler, jamais pour decider.
 *
 *  2. PROTOCOLE TEXTE (parseActionText): quand le modele doit agir, on lui
 *     demande des lignes simples (ACTION:/CHEMIN:/CONTENU:) et non un objet
 *     JSON. L'analyseur est TOLERANT (guillemets simples, espaces, lignes
 *     vides, majuscules) mais refuse ce qui n'a pas de sens.
 *
 * Regle: ce module est PUR (aucune ecriture disque, aucun acces reseau).
 * ASCII only.
 */
'use strict';

// ---------------------------------------------------------------------------
// Couleurs nommees -> valeur hexadecimale (les plus courantes du web).
// ---------------------------------------------------------------------------
const COLORS = {
  vert: '#22c55e', green: '#22c55e', emeraude: '#10b981', 'emerald': '#10b981',
  rouge: '#ef4444', red: '#ef4444',
  bleu: '#3b82f6', blue: '#3b82f6',
  jaune: '#eab308', yellow: '#eab308',
  orange: '#f97316',
  violet: '#8b5cf6', purple: '#8b5cf6',
  rose: '#ec4899', pink: '#ec4899',
  noir: '#111827', black: '#111827',
  blanc: '#ffffff', white: '#ffffff',
  gris: '#6b7280', gray: '#6b7280', grey: '#6b7280',
};

function fold(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5]/g, 'a')
    .replace(/[\u00e8\u00ea\u00eb\u00e9]/g, 'e')
    .replace(/[\u00ee\u00ef\u00ec\u00ed]/g, 'i')
    .replace(/[\u00f4\u00f6\u00f2\u00f3\u00f5]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g, 'u')
    .replace(/[\u00e7]/g, 'c');
}

function cleanValue(v) {
  let s = String(v === undefined || v === null ? '' : v).trim();
  s = s.replace(/^[«"'`\u201c\u201d]+/, '').replace(/[»"'`\u201c\u201d]+$/, '');
  return s.trim();
}

// ---------------------------------------------------------------------------
// 1. Creer un fichier avec un contenu explicite.
//    "Cree un fichier test.txt contenant bonjour"
//    "ecris dans notes.md : bonjour"
//    "write test.txt with hello"
// ---------------------------------------------------------------------------
const FILE_PATH_RE = /["'\u00ab\u00bb`]?([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,8})["'\u00ab\u00bb`]?/;

function createFileIntent(prompt) {
  const t = fold(prompt);
  if (!/\b(cree|creer|creez|ecris|ecrire|ecrivez|write|touch|enregistre|sauvegarde)\b/.test(t)) return null;
  if (!/\b(fichier|file|fichier nomme)\b/.test(t) && !/\b(dans|with|contenant|content:)\b/.test(t)) return null;
  const m = FILE_PATH_RE.exec(String(prompt));
  if (!m) return null;
  const file = m[1];
  // Contenu : ce qui suit "contenant/avec/qui contient/comportant/:".
  const after = String(prompt).slice(m.index + m[0].length);
  const cm = /(?:^\s*:|contenant|contenu\s*:?\s*|avec|qui contient|comportant|with|content\s*:?)\s*([\s\S]+)$/i.exec(after);
  if (!cm) return null;
  const content = cleanValue(cm[1]).replace(/\s+$/, '');
  if (!content) return null;
  return { name: 'write', args: { file, content }, why: 'demande explicite de creation de fichier' };
}

// ---------------------------------------------------------------------------
// 2. Changer la couleur principale. L'agent trouve LUI-MEME le fichier et la
//    valeur courante (aucune supposition du modele).
// ---------------------------------------------------------------------------
function requestedColor(prompt) {
  const t = fold(prompt);
  if (!/couleur|color|theme|--primary|primaire/.test(t)) return null;
  for (const name of Object.keys(COLORS)) {
    const re = new RegExp('\\b' + name + '\\b');
    if (re.test(t)) return { name, hex: COLORS[name] };
  }
  const hex = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(String(prompt));
  if (hex) return { name: hex[0], hex: hex[0] };
  return null;
}

function isColorIntent(prompt) {
  const t = fold(prompt);
  return /couleur|color|--primary|primaire|theme/.test(t)
    && /\b(change|modifie|remplace|passe|mets|met|change|set|switch|mettre)\b/.test(t);
}

// root: dossier du projet ; findRoot renvoie les fichiers CSS candidats.
// Renvoie { name:'edit', args:{ file, old, new } } pour chaque fichier ou la
// variable --primary existe (max 3).
function primaryColorIntents(prompt, listFiles, readFile) {
  if (!isColorIntent(prompt)) return [];
  const col = requestedColor(prompt);
  if (!col) return [];
  let files = [];
  try { files = (listFiles() || []).filter((f) => /\.(css|scss|less)$/i.test(f)); } catch (_) { files = []; }
  const out = [];
  for (const f of files.slice(0, 40)) {
    let body = null;
    try { body = readFile(f); } catch (_) { body = null; }
    if (!body || body.indexOf('--primary') === -1) continue;
    const m = /--primary\s*:\s*([^;}\n]+)/i.exec(body);
    if (!m) continue;
    const oldVal = m[1].trim();
    if (oldVal.toLowerCase() === String(col.hex).toLowerCase()) continue;
    out.push({ name: 'edit', args: { file: f, old: m[0].trim(), new: '--primary: ' + col.hex },
      why: 'correctif deterministe de la couleur principale (' + oldVal + ' -> ' + col.hex + ')' });
    if (out.length >= 3) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Protocole texte tolerant (voie de secours de premier rang).
//    ACTION: ecrire        CHEMIN: test.txt      CONTENU: bonjour
//    ACTION: lire          CHEMIN: app.py
//    ACTION: terminer
//    (accepte aussi "ACTION: write", "CHEMIN=", "FICHIER:", guillemets)
// ---------------------------------------------------------------------------
const ACTION_ALIASES = {
  ecrire: 'write', ecris: 'write', write: 'write', creer: 'write', cree: 'write',
  lire: 'read', read: 'read', ouvrir: 'read',
  lister: 'list', list: 'list', ls: 'list',
  chercher: 'grep', grep: 'grep', search: 'grep',
  editer: 'edit', edit: 'edit', remplacer: 'edit', replace: 'edit',
  terminer: 'done', done: 'done', fin: 'done', fini: 'done', termine: 'done',
};

function parseActionText(text) {
  const raw = String(text || '').replace(/```[A-Za-z0-9_+-]*/g, '').replace(/```/g, '');
  const lines = raw.split(/\r?\n/);
  const calls = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const name = ACTION_ALIASES[cur.action];
    if (name && name !== 'done') {
      const args = {};
      if (cur.path) args.file = cur.path;
      if (cur.content !== null && cur.content !== undefined) args.content = String(cur.content).replace(/\n+$/, '');
      if (cur.old) args.old = cur.old;
      if (cur.new) args.new = cur.new;
      calls.push({ name, args, raw: cur.action });
    }
    if (name === 'done') calls.push({ name: 'done', args: {}, raw: cur.action });
    cur = null;
  };
  for (const line of lines) {
    const m = /^\s*(?:ACTION|TOOL)\s*[:=]\s*([A-Za-z_]+)\s*$/i.exec(line);
    if (m) { flush(); cur = { action: fold(m[1]).trim(), path: null, content: null }; continue; }
    if (!cur) continue;
    const p = /^\s*(?:CHEMIN|FICHIER|PATH|FILE)\s*[:=]\s*(.+)$/i.exec(line);
    if (p) { cur.path = cleanValue(p[1]); continue; }
    const c = /^\s*(?:CONTENU|CONTENT|TEXTE|TEXT)\s*[:=]\s*([\s\S]*)$/i.exec(line);
    if (c) { cur.content = cleanValue(c[1]); continue; }
    // ligne de contenu libre sous un ACTION: ecrire
    if (cur.action && ACTION_ALIASES[cur.action] === 'write' && cur.path) {
      cur.content = cur.content === null ? line : cur.content + '\n' + line;
    }
  }
  flush();
  return calls.filter((c) => c.name === 'done' || (c.args && c.args.file));
}

// Consigne du protocole texte : courte, stable, sans JSON.
function textProtocolPrompt() {
  return [
    'Tu ne dois PAS repondre en JSON.',
    'Reponds uniquement par des lignes, une information par ligne, dans cet ordre :',
    'ACTION: ecrire',
    'CHEMIN: chemin/relatif/du/fichier',
    'CONTENU: le texte complet a ecrire',
    '',
    'ou, pour lire un fichier :',
    'ACTION: lire',
    'CHEMIN: chemin/relatif/du/fichier',
    '',
    'ou, si tu as termine :',
    'ACTION: terminer',
    '',
    'Aucune autre ligne, aucun commentaire, aucune explication.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 4. Audit de securite : intention de DIAGNOSTIC (lecture seule).
// ---------------------------------------------------------------------------
function isAuditIntent(prompt) {
  const t = fold(prompt);
  if (!/\baudit\b/.test(t)) return false;
  return /securit|securite|faille|secret|vulnerab|security/.test(t);
}

module.exports = {
  isAuditIntent,
  COLORS, createFileIntent, primaryColorIntents, isColorIntent, requestedColor,
  parseActionText, textProtocolPrompt, fold, cleanValue,
};
