'use strict';
/**
 * P70-D12/D14 : aucun "done" du modele affiche comme un fait.
 *
 * Le texte du modele est une PAROLE ; les faits viennent du disque. Si le
 * modele annonce une suppression que la verification ne voit pas, on affiche
 * la contradiction et le statut passe ECHEC/PARTIEL. Jamais l'inverse.
 *
 * ASCII only.
 */

const CLAIMS = [
  { re: /\b(supprim\w*|supprime|deleted|removed|effac\w*)\b/i, fact: 'deleted',
    phrase: 'aucun fichier n\'a ete supprime',
    quote: /(supprim\w*|deleted|removed)[^.!?\n]{0,60}/i },
  { re: /\b(cr[ee]\w*|created|ajout\w*|added)\b/i, fact: 'created',
    phrase: 'aucun fichier n\'a ete cree',
    quote: /(cr[ee]\w*|created|added)[^.!?\n]{0,60}/i },
  { re: /\b(modifi\w*|modifi[ee]s?|modified|updated|corrig\w*)\b/i, fact: 'modified',
    phrase: 'aucun fichier n\'a ete modifie',
    quote: /(modifi\w*|modified|updated)[^.!?\n]{0,60}/i },
];

/**
 * @param {string} claimText texte produit par le modele (sa parole)
 * @param {object} facts     faits VERIFIES ({deleted:[],created:[],modified:[]})
 * @returns {{ok:boolean,status:string,message:string,contradictions:[]}}
 */
function verifyClaims(claimText, facts) {
  const text = String(claimText || '');
  const f = facts || {};
  const contradictions = [];
  for (const c of CLAIMS) {
    if (!c.re.test(text)) continue;
    const n = Array.isArray(f[c.fact]) ? f[c.fact].length : 0;
    if (n > 0) continue;
    const m = text.match(c.quote);
    const quoted = (m ? m[0] : text.slice(0, 80)).trim();
    contradictions.push({ fact: c.fact,
      message: 'Le modele a annonce "' + quoted + '" mais ' + c.phrase + '.' });
  }
  if (!contradictions.length) {
    return { ok: true, status: null, message: '', contradictions: [] };
  }
  return { ok: false, status: 'ECHEC', contradictions,
    message: contradictions.map((c) => c.message).join(' ') };
}

/** Libelles lisibles : un dedoublonnage n'est pas un echec, un statut interne n'est jamais brut. */
const STATUS_LABELS = {
  EN_ATTENTE: 'en attente de votre choix',
  ATTENTE: 'en attente de votre choix',
  await_choice: 'en attente de votre choix',
  PARTIEL: 'partiel',
  TERMINE: 'termine',
  ECHEC: 'echec',
  already_done: 'deja execute (rien a refaire)',
};

function labelFor(status, opts) {
  opts = opts || {};
  const s = String(status || '');
  if (opts.alreadyDone) return STATUS_LABELS.already_done;
  if (STATUS_LABELS[s]) return STATUS_LABELS[s];
  if (/^[a-z_]+$/.test(s)) return 'etat interne (' + s + ')';
  return s;
}

/** Une ligne de resultat homogene : "Termine : ..." / "Echec : ..." / "Deja execute : ...". */
function resultLine(status, text, opts) {
  const label = labelFor(status, opts);
  const head = label.charAt(0).toUpperCase() + label.slice(1);
  let body = String(text || '').trim();
  // Pas de "Termine : Termine :" si l'appelant a deja mis l'etiquette.
  const lowHead = head.toLowerCase();
  if (body.toLowerCase().indexOf(lowHead + ' :') === 0) {
    body = body.slice(head.length + 2).trim();
  }
  return head + ' : ' + body;
}

module.exports = { verifyClaims, labelFor, resultLine, STATUS_LABELS };
