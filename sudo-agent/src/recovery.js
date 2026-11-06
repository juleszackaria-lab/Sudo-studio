/**
 * SUDO AGENT - P55(3): recuperation des pannes d'appel d'outils.
 *
 * Une erreur du fournisseur (500, delai, appel d'outil invalide) n'est pas une
 * fin de tour : c'est un incident RECUPERABLE. Ce module fournit les briques
 * pures, sans dependance vscode ni reseau :
 *
 *   - classify(err)              incident recuperable ou non (et pourquoi) ;
 *   - reducedTools(schemas)      jeu d'outils minimal pour un petit modele ;
 *   - parseFileBlocks(text)      format de secours "FICHIER: chemin" + contenu ;
 *   - fallbackPrompt(task)       consigne du format de secours ;
 *   - stripPreamble(text)        nettoyage des bavardages autour des blocs.
 *
 * Le cablage (essais successifs, ecriture par les outils normaux, verdict
 * honnete) vit dans loop.js : rien ici n'ecrit sur le disque.
 *
 * ASCII only.
 */
'use strict';

// Outils gardes pour un essai "schema reduit" : de quoi constater, ecrire et
// terminer, sans le bruit des outils specialises.
const REDUCED_KEEP = ['read', 'list', 'grep', 'write', 'edit', 'append', 'mkdir', 'reply', 'done'];

// Codes consideres comme recuperables : le fournisseur ou le transport a
// echoue, pas la demande de l'utilisateur.
const RECOVERABLE_CODES = [
  'provider_error', 'provider_unreachable', 'runtime_offline', 'invalid_tool_call',
  'timeout', 'provider_timeout', 'bad_response', 'empty_reply',
];

function classify(err) {
  const code = String((err && err.code) || '');
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const msg = String((err && err.message) || err || '');
  if (code === 'aborted' || (err && err.abortedByAgent)) {
    return { recoverable: false, why: 'arret demande par l utilisateur' };
  }
  // Authentification / quota / modele absent : reessayer ne sert a rien.
  if (status === 401 || status === 403) return { recoverable: false, why: 'authentification refusee (HTTP ' + status + ')' };
  if (status === 404) return { recoverable: false, why: 'modele ou route introuvable (HTTP 404)' };
  if (/no_model|aucun modele/i.test(msg) || code === 'no_model') {
    return { recoverable: false, why: 'aucun modele charge' };
  }
  if (code === 'bad_config' || code === 'bad_request' || status === 400) {
    // 400 = outils non supportes : les appelants savent deja basculer.
    return { recoverable: false, why: 'requete refusee par le fournisseur (HTTP 400)' };
  }
  if (RECOVERABLE_CODES.indexOf(code) !== -1) return { recoverable: true, why: code + (status ? ' (HTTP ' + status + ')' : '') };
  if (status >= 500) return { recoverable: true, why: 'erreur serveur HTTP ' + status };
  if (/tool call JSON invalid|must be an object/i.test(msg)) {
    return { recoverable: true, why: 'appel d outil illisible produit par le modele' };
  }
  if (/ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(msg)) {
    return { recoverable: true, why: 'incident transport' };
  }
  return { recoverable: false, why: code || 'erreur inconnue' };
}

/**
 * Jeu d'outils reduit (schemas OpenAI). Garde l'ordre d'origine, borne le
 * nombre : un petit modele choisit mieux parmi 9 outils que parmi 30.
 */
function reducedTools(schemas) {
  const keep = [];
  for (const s of (schemas || [])) {
    const n = (s && s.function && s.function.name) || '';
    if (REDUCED_KEEP.indexOf(n) !== -1) keep.push(s);
  }
  if (!keep.length) return (schemas || []).slice(0, REDUCED_KEEP.length);
  // Doublons retires, ordre d'origine conserve : un tour doit pouvoir se
  // terminer, donc reply/done restent toujours presents.
  const seen = new Set();
  const out = [];
  for (const s of keep) {
    const n = s.function.name;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(s);
  }
  return out.slice(0, 12);
}

/** Consigne du format de secours (aucun outil, texte simple). */
function fallbackPrompt(task) {
  return [
    'Les appels d\'outils ne passent pas avec ce modele. Utilise le format de secours.',
    'Reponds UNIQUEMENT avec un ou plusieurs blocs, dans cet ordre, sans autre texte :',
    'FICHIER: chemin/relatif/du/fichier',
    '<contenu COMPLET du fichier>',
    'FIN FICHIER',
    '',
    'Tu peux enchainer plusieurs blocs. Les chemins sont relatifs au projet.',
    'Si aucun fichier ne doit etre cree, reponds par une seule ligne : AUCUN FICHIER',
    task ? ('Tache : ' + String(task).slice(0, 600)) : '',
  ].filter(Boolean).join('\n');
}

function stripPreamble(text) {
  let s = String(text === undefined || text === null ? '' : text);
  // clotures markdown autour des blocs
  s = s.replace(/```[A-Za-z0-9_+-]*\s*\n/g, '').replace(/```/g, '');
  return s;
}

/**
 * Analyse le format de secours. Renvoie :
 *   { ok, files: [{ path, content }], reason }
 * Un bloc accepte : "FICHIER: x" ... "FIN FICHIER" (marqueur de fin optionnel :
 * le bloc suivant ou la fin du texte ferment aussi).
 */
function parseFileBlocks(text) {
  const raw = stripPreamble(text);
  if (!raw.trim()) return { ok: false, files: [], reason: 'reponse vide' };
  if (/^\s*AUCUN FICHIER\s*$/im.test(raw) && !/FICHIER\s*:/i.test(raw)) {
    return { ok: true, files: [], reason: 'aucun fichier annonce' };
  }
  const lines = raw.split(/\r?\n/);
  const files = [];
  let cur = null;
  const startRe = /^\s*(?:#{0,3}\s*)?(?:FICHIER|FILE)\s*:\s*(.+?)\s*$/i;
  const endRe = /^\s*(?:FIN FICHIER|END FILE)\s*$/i;
  for (const line of lines) {
    const m = startRe.exec(line);
    if (m) {
      if (cur) files.push(cur);
      let p = m[1].replace(/^[`'"]+|[`'"]+$/g, '').trim();
      p = p.replace(/\\/g, '/');
      cur = { path: p, lines: [] };
      continue;
    }
    if (endRe.test(line)) {
      if (cur) { files.push(cur); cur = null; }
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) files.push(cur);
  const clean = [];
  const refused = [];
  for (const f of files) {
    const p = String(f.path || '').trim();
    // Refus des chemins dangereux : pas d'absolu, pas de remontee de dossier.
    if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').indexOf('..') !== -1) {
      if (p) refused.push(p);
      continue;
    }
    let content = f.lines.join('\n');
    content = content.replace(/\s+$/, '');
    if (content.length > 512 * 1024) { refused.push(p + ' (trop gros)'); continue; }
    clean.push({ path: p, content: content + '\n' });
  }
  return { ok: clean.length > 0, files: clean, refused,
    reason: clean.length ? '' : 'aucun bloc FICHIER exploitable' };
}

module.exports = { REDUCED_KEEP, RECOVERABLE_CODES, classify, reducedTools, fallbackPrompt,
  parseFileBlocks, stripPreamble };
