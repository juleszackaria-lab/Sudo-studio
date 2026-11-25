'use strict';
/**
 * P70-B5 : parseur d'intention DETERMINISTE pour les operations de base.
 *
 * Objectif : "supprime le fichier X", "liste docs", "cree un fichier notes.txt
 * avec <contenu>", "renomme A en B" ne doivent JAMAIS couter un appel modele.
 * Aucune heuristique cachee : des listes de verbes FR/EN, tolerantes a UNE
 * faute de frappe, et un extracteur de cible qui refuse de deviner.
 *
 * Sortie :
 *   { kind: 'file-op', op, target, content?, to?, lang, reason }
 *   { kind: 'complex', why, lang }              -> le modele peut intervenir
 *   { kind: 'composed', ops: [ <file-op> ... ] }  -> "supprime X puis audit"
 *
 * ASCII only.
 */

// Verbes, avec leurs synonymes. Une faute de frappe (distance 1) est toleree
// sur les verbes de 5 lettres et plus : "supprimr", "supirme" passent.
const VERBS = {
  delete: ['supprime', 'supprimer', 'supprimez', 'efface', 'effacer', 'enleve', 'enlever',
    'retire', 'retirer', 'delete', 'remove', 'rm', 'erase', 'drops'],
  read: ['lis', 'lire', 'lisez', 'affiche', 'afficher', 'montre', 'montrer', 'read', 'show',
    'cat', 'display'],
  list: ['liste', 'lister', 'listez', 'list', 'ls', 'dir', 'inventaire'],
  create_file: ['cree', 'creer', 'creez', 'create', 'touch', 'nouveau'],
  create_dir: ['mkdir'],
  rename: ['renomme', 'renommer', 'renommez', 'rename'],
  move: ['deplace', 'deplacer', 'deplacez', 'move'],
  copy: ['copie', 'copier', 'copiez', 'copy', 'cp'],
};

// Mots qui ne sont jamais des cibles.
const STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'ce', 'cette',
  'mon', 'ma', 'mes', 'the', 'a', 'an', 'fichier', 'fichiers', 'file', 'files', 'dossier',
  'dossiers', 'folder', 'folders', 'repertoire', 'directory', 'ou', 'or', 'et', 'and', 'puis',
  'then', 'deja', 'existing', 'svp', 'stp', 'please', 'merci', 'pour', 'moi', 'for', 'me',
  'maintenant', 'now', 'tout', 'tous', 'all']);

// Mots-cles qui signalent une demande COMPLEXE (le modele doit reflechir) :
// audit, correction de failles, explication, generation de code.
const COMPLEX = /\b(audit\w*|securit\w*|security|faill\w*|vulnerab\w*|corrige|corriger|fix|refactor\w*|explique|expliquer|explain|resume|resumer|summary|analyse|analyser|analyze|genere|generer|generate|ecris|ecrire|write a|implemente|implement)\b/;

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

// Un verbe tolere : exact, ou distance <= 1 pour les verbes >= 5 lettres.
function matchesVerb(token, verb) {
  if (token === verb) return true;
  if (verb.length >= 5 && Math.abs(token.length - verb.length) <= 1) {
    if (levenshtein(token, verb) <= 1) return true;
  }
  // "supirme" -> "supprime" (2 fautes, meme radical) : tolere sur les verbes
  // longs uniquement, et seulement si les 3 premieres lettres concordent.
  if (verb.length >= 7 && token.length >= 4 && token.slice(0, 3) === verb.slice(0, 3)) {
    return levenshtein(token, verb) <= 2;
  }
  return false;
}

function splitWords(text) {
  return fold(text).split(/[^a-z0-9._\-\/\\]+/).filter(Boolean);
}

// "supprime le fichier ou dossier github" -> "github"
// "delete .github/workflows/ci-cd.yml" -> ".github/workflows/ci-cd.yml"
function extractTarget(text, verbToken) {
  const raw = String(text || '');
  // 1. entre guillemets / backticks : la cible est explicite
  const quoted = raw.match(/["'`\u00ab\u00bb]([^"'`\u00ab\u00bb]+)["'`\u00ab\u00bb]/);
  if (quoted && quoted[1].trim()) return { target: quoted[1].trim(), how: 'guillemets' };
  // 2. un jeton qui contient un separateur de chemin (Windows ou POSIX)
  const pathy = raw.match(/(?:^|[\s"'`(])([A-Za-z0-9._\-]+[\/\\][^\s"'`)]+)/);
  if (pathy && pathy[1] && pathy[1].trim() !== '/') {
    return { target: pathy[1].replace(/[.,;:]+$/, ''), how: 'chemin' };
  }
  // 3. sinon : le dernier mot porteur de sens apres le verbe
  const words = splitWords(raw);
  const at = words.findIndex((w) => matchesVerb(w, verbToken));
  const after = at >= 0 ? words.slice(at + 1) : words;
  const candidates = after.filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
  if (candidates.length) return { target: candidates[candidates.length - 1], how: 'mot' };
  return { target: null, how: 'aucune' };
}

function detectLang(text) {
  const t = fold(text);
  if (/\b(supprime|efface|enleve|liste|affiche|cree|renomme|deplace|copie|lis|lire|dossier|fichier)\b/.test(t)) return 'fr';
  if (/\b(delete|remove|list|show|create|rename|move|copy|read|folder|file)\b/.test(t)) return 'en';
  return '?';
}

// Contenu fourni litteralement : apres "avec", "contenant", "content:", un
// bloc ```...``` ou tout ce qui suit ":" en fin de consigne.
function extractContent(text) {
  const raw = String(text || '');
  const fence = raw.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
  if (fence) return { content: fence[1], how: 'bloc' };
  const colon = raw.match(/(?:contenu|content|avec|containing|texte|text)\s*[:=]\s*([\s\S]+)$/i);
  if (colon) return { content: colon[1].trim(), how: 'apres mot-cle' };
  return { content: null, how: 'aucun' };
}

const SIMPLE_OPS = new Set(['delete', 'read', 'list', 'create_file', 'create_dir', 'rename', 'move', 'copy']);

/** Analyse une consigne simple. */
function parseOne(text) {
  const rawText = String(text || '').trim();
  const t = fold(text);
  const words = splitWords(text);
  const lang = detectLang(text);

  // "renomme A en B" / "rename A to B" : deux cibles
  const ren = String(text || '').match(/\b(?:renomme[rz]?|rename)\s+([^\s]+)\s+(?:en|vers|to)\s+([^\s]+)/i);
  if (ren) {
    return { kind: 'file-op', text: rawText, op: 'rename', target: ren[1], to: ren[2], lang, reason: 'verbe+en/to' };
  }
  const mv = String(text || '').match(/\b(?:deplace[rz]?|move)\s+([^\s]+)\s+(?:vers|dans|en|to|into)\s+([^\s]+)/i);
  if (mv) {
    return { kind: 'file-op', text: rawText, op: 'move', target: mv[1], to: mv[2], lang, reason: 'verbe+vers/into' };
  }
  const cp = String(text || '').match(/\b(?:copie[rz]?|copy)\s+([^\s]+)\s+(?:vers|dans|en|to|into)\s+([^\s]+)/i);
  if (cp) {
    return { kind: 'file-op', text: rawText, op: 'copy', target: cp[1], to: cp[2], lang, reason: 'verbe+vers/into' };
  }

  // Quel verbe ? On garde le premier trouve, avec sa longueur comme priorite
  // (supprime > efface > retire : peu importe, ce sont des synonymes du meme op).
  let op = null;
  let verbToken = null;
  for (const w of words) {
    if (STOP.has(w)) continue;
    for (const [name, list] of Object.entries(VERBS)) {
      for (const v of list) {
        if (matchesVerb(w, v)) { op = name; verbToken = v; break; }
      }
      if (op) break;
    }
    if (op) break;
  }
  if (!op) {
    if (COMPLEX.test(t)) return { kind: 'complex', text: rawText, why: 'demande complexe sans verbe d operation', lang };
    return { kind: 'complex', text: rawText, why: 'aucun verbe d operation reconnu', lang };
  }
  // "cree un dossier" -> create_dir ; "cree un fichier" -> create_file
  if (op === 'create_file') {
    if (/\b(dossier|repertoire|folder|directory)\b/.test(t)) op = 'create_dir';
  }
  let { target, how } = extractTarget(text, verbToken || '');
  // "liste le projet" / "liste ici" / "liste" : c'est une liste de la racine,
  // pas une cible inventee. (La LECTURE, elle, exige une cible explicite.)
  const GENERIC_LIST = /^(le |la |l )?(projet|dossier|repertoire|arborescence|racine|workspace|ici|tout)$/;
  if (op === 'list' && (!target || GENERIC_LIST.test(String(target).trim()))) {
    target = '';
    how = 'racine';
  }
  const explicit = how === 'chemin' || how === 'guillemets' || how === 'racine' || (target && /\./.test(target));
  if (op === 'read' && !explicit) {
    return { kind: 'complex', text: rawText, why: 'lecture sans cible explicite (chemin ou nom de fichier)', lang };
  }
  const out = { kind: 'file-op', text: rawText, op, target, lang, reason: 'verbe ' + verbToken + ' + cible ' + how };
  if (op === 'create_file') {
    const c = extractContent(text);
    out.content = c.content;
    out.contentHow = c.how;
  }
  return out;
}

const SPLIT = /\s*(?:;|,\s*puis|\s+puis\s+|\s+ensuite\s+|\s+apres\s+ca\s+|,\s*then\s+|\s+then\s+|\s+and\s+then\s+)\s*/i;

/** Analyse une consigne, simple ou composee (jusqu'a 4 sous-taches). */
function parse(text) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'complex', why: 'consigne vide', lang: '?' };
  const parts = raw.split(SPLIT).map((s) => s.trim()).filter((s) => s.length > 1).slice(0, 4);
  if (parts.length > 1) {
    const ops = parts.map(parseOne);
    // Une sous-tache complexe reste complexe : on ne la supprime pas.
    return { kind: 'composed', parts: ops, lang: detectLang(raw) };
  }
  return parseOne(raw);
}

module.exports = { parse, parseOne, fold, levenshtein, extractTarget, detectLang, extractContent,
  SIMPLE_OPS, VERBS };
