'use strict';
/**
 * P70-E15/E16 : edition SURE.
 *
 *  - une modification par correspondance APPROCHEE ne s'applique jamais en
 *    silence : on rend un diff ETIQUETE et on exige l'approbation ;
 *  - on refuse d'editer quand l'intention est une SUPPRESSION (c'est le bug
 *    V1 : un fichier a supprimer a ete modifie) ;
 *  - apres deux echecs identiques sur la meme cible, on ARRETE cette cible et
 *    on demande, au lieu de boucler jusqu'a max_iters.
 *
 * ASCII only.
 */

const MAX_SAME_FAILURE = 2;
const _ATTEMPTS = new Map();   // target -> { code, n }

function guardEdit(input) {
  input = input || {};
  const file = String(input.file || '');
  const intentKind = String(input.intentKind || '');
  if (intentKind === 'delete') {
    return { ok: false, code: 'intent_delete',
      message: 'Refus d\'editer "' + file + '" : la demande est une SUPPRESSION. ' +
        'Un fichier a supprimer ne se modifie pas.' };
  }
  if (input.match === 'approximate' || input.approximate === true) {
    const diff = String(input.diff || '').trim();
    return { ok: false, code: 'needs_approval', approximate: true,
      label: 'correspondance approchee',
      diff,
      message: 'Correspondance APPROCHEE sur "' + file + '" (le texte exact n\'a pas ete trouve). ' +
        'Diff marque "correspondance approchee" ci-dessous : approbation requise avant application.' };
  }
  return { ok: true, code: 'exact' };
}

/** Enregistre un echec ; renvoie {stop:true} au 2e echec identique. */
function noteFailure(target, code) {
  const key = String(target || '?');
  const cur = _ATTEMPTS.get(key) || { code: null, n: 0 };
  if (cur.code === code) cur.n += 1;
  else { cur.code = code; cur.n = 1; }
  _ATTEMPTS.set(key, cur);
  if (cur.n >= MAX_SAME_FAILURE) {
    return { stop: true, target: key, code,
      message: 'Arret sur "' + key + '" : ' + cur.n + ' echecs identiques (' + code + '). ' +
        'Je ne boucle pas : dites-moi le chemin exact ou ce qu\'il faut faire.' };
  }
  return { stop: false, target: key, code, n: cur.n };
}

function reset() { _ATTEMPTS.clear(); }

module.exports = { guardEdit, noteFailure, reset, MAX_SAME_FAILURE };
