'use strict';
/**
 * P70-C10/C11 : la surface d'outils exposee au modele, NOMMEE et JUSTIFIEE.
 *
 * Deux garanties :
 *   1. chaque intention a un ensemble MINIMAL ; `delete` en fait partie pour
 *      toute intention de fichiers, et la reduction de budget ne peut PAS le
 *      retirer (elle le dit si elle a du garder un outil "hors budget") ;
 *   2. le nom des outils exposes et la raison sont journalises a chaque tour
 *      (ce qui manquait : on ne savait jamais ce que le modele voyait).
 *
 * ASCII only.
 */

// Ensemble minimal par intention. Toute intention de fichiers inclut delete :
// une demande de suppression ne doit jamais tomber sur une surface sans delete.
const MINIMAL = {
  delete: ['delete', 'list', 'read', 'reply', 'done'],
  read: ['read', 'list', 'reply', 'done'],
  list: ['list', 'read', 'reply', 'done'],
  create_file: ['write', 'append', 'mkdir', 'reply', 'done'],
  create_dir: ['mkdir', 'list', 'reply', 'done'],
  rename: ['rename', 'read', 'list', 'reply', 'done'],
  move: ['rename', 'read', 'list', 'reply', 'done'],
  copy: ['read', 'write', 'list', 'reply', 'done'],
  modify: ['edit', 'append', 'read', 'reply', 'done'],
  audit: ['secaudit', 'read', 'grep', 'list', 'reply', 'done'],
};

function minimalFor(kind) {
  return (MINIMAL[kind] || MINIMAL.read).slice();
}

/**
 * @param {string[]} baseNames surface du profil (ex. profils SMALL)
 * @param {string} intentKind 'delete' | 'read' | ...
 * @param {object} opts { ctxTokens, budgetDrop:[noms retirs pour le budget] }
 * @returns {{names:string[], reason:string, keptDespiteBudget:string[], dropped:string[]}}
 */
function toolsForIntent(baseNames, intentKind, opts) {
  opts = opts || {};
  const base = Array.isArray(baseNames) ? baseNames.slice() : [];
  const min = minimalFor(intentKind);
  const dropped = Array.isArray(opts.budgetDrop) ? opts.budgetDrop.slice() : [];
  const names = base.filter((n) => dropped.indexOf(n) === -1);
  const keptDespiteBudget = [];
  for (const n of min) {
    if (names.indexOf(n) === -1) {
      names.push(n);
      if (dropped.indexOf(n) !== -1) keptDespiteBudget.push(n);
    }
  }
  const reason = 'intention ' + intentKind + ' -> ensemble minimal ' + min.join(',') +
    (dropped.length ? ' | budget a retire ' + dropped.join(',') : '') +
    (keptDespiteBudget.length ? ' | GARDES malgre le budget : ' + keptDespiteBudget.join(',') : '');
  return { names, reason, minimal: min, keptDespiteBudget, dropped };
}

/** Ligne de journal : les NOMS, pas seulement un compte. */
function journalLine(names, reason, ctxTokens) {
  return 'outils exposes | ctx=' + (ctxTokens === undefined ? '?' : ctxTokens) +
    ' n=' + names.length + ' noms=' + names.join(',') + ' | raison=' + reason;
}

module.exports = { MINIMAL, minimalFor, toolsForIntent, journalLine };
