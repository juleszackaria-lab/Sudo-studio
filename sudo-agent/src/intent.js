// Sudo Agent intent classifier (P49-1). Every turn is classified BEFORE the
// first model call: ACTION (the user wants something DONE: the project is
// explored and/or changed through tools) vs QUESTION (information only) vs
// AMBIGUOUS (neither signal: legacy behavior). Verbs win over explanation
// words ("explique puis corrige" = ACTION); a pasted task list (>= 2 list
// items) is always ACTION. ACTION splits into modify-class (expects verified
// file changes: cree, supprime, ...) and run-class (expects a verified
// execution, files optional: lance, teste, ...). Pure + stdlib + ASCII only.
'use strict';

const { isGeneralQuestion } = require('./projectmap');

function fold(s) {
  // Unicode escapes stay ASCII in source; fold common French accents.
  return String(s || '').toLowerCase()
    .replace(/[\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5]/g, 'a')
    .replace(/[\u00e8\u00ea\u00eb\u00e9]/g, 'e')
    .replace(/[\u00ee\u00ef\u00ec\u00ed]/g, 'i')
    .replace(/[\u00f4\u00f6\u00f2\u00f3\u00f5]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g, 'u')
    .replace(/[\u00e7]/g, 'c')
    .replace(/[\u00f1]/g, 'n');
}

// [canonical, regex] on folded text. modify=true means the turn MUST end
// with verified file changes (P49-2 strict verdict).
const VERBS = [
  ['applique', /\bappliqu(e|er|es|ez|ent|ons)?\b|\bappl(y|ies|ied)\b/, true],
  ['cree', /\bcre(e|er|es|ez|ent|ons|a|ait)?\b|\bcreat(e|es|ed|ing|ion)?\b/, true],
  ['modifie', /\bmodifi(e|er|es|ez|ent|ons)?\b|\bmodif(y|ies|ied|ication)?\b|\bchang(e|er|es|ez|ent|ement)?\b/, true],
  ['supprime', /\bsupprim(e|er|es|ez|ent|ons)?\b|\bdelet(e|es|ed|ing|ion)?\b|\bremov(e|es|ed|ing|al)?\b|\bretir(e|er|es|ez|ent|ons)?\b|\benlev(e|er|es|ez|ent|ons)?\b/, true],
  ['renomme', /\brenomm(e|er|es|ez|ent|ons)?\b|\brenam(e|es|ed|ing)?\b/, true],
  ['ajoute', /\bajout(e|er|es|ez|ent|ons)?\b|\badds?\b/, true],
  ['corrige', /\bcorrig(e|er|es|ez|ent|ons)?\b|\bfix(e|er|es|ez|ent)?\b/, true],
  ['implemente', /\bimplement(e|er|es|ez|ent|ons)?\b/, true],
  ['ecris', /\b(re)?ecri(s|t|re|vez|vent)?\b|\bwrit(e|es|ing|ten)?\b|\bwrote\b/, true],
  ['refactor', /\brefactor\b|\brefacto\b/, true],
  ['deploie', /\bdeploy(s|ed|ing)?\b|\bdeploi(e|er|es|ez|ent|ons)?\b/, true],
  ['installe', /\b(re)?install(e|er|es|ez|ent|ons)?\b/, true],
  ['build', /\b(re)?builds?\b|\b(re)?construi(s|t|re|sez|sent)?\b/, true],
  ['migre', /\bmigr(e|er|es|ez|ent|ons)?\b|\bmigrat(e|es|ed|ing|ion)?\b/, true],
  ['optimise', /\boptimis(e|er|es|ez|ent|ons)?\b|\boptimiz(e|es|ed|ing|ation)?\b/, true],
  ['nettoie', /\bnettoi(e|er|es|ez|ent|ons|age)?\b|\bcleanup\b|\bclean up\b/, true],
  ['ameliore', /\bamelior(e|er|es|ez|ent|ons)?\b|\bimprov(e|es|ed|ing|ement)?\b/, true],
  ['securise', /\bsecuris(e|er|es|ez|ent|ons)?\b|\bsecur(e|es|ed|ing|ity)?\b/, true],
  ['lance', /\b(re)?lanc(e|er|es|ez|ent|ons)?\b|\blaunch(ed|es|ing)?\b/, false],
  ['execute', /\bexecut(e|er|es|ez|ent|ons)?\b|\bexec\b|\brun\b/, false],
  ['teste', /\btest(e|er|es|ez|ent|ons)?\b/, false],
  ['debug', /\bdebug\b|\bdebogu(e|er|es|ez|ent|ons)?\b/, false],
  ['demarre', /\b(re)?demarr(e|er|es|ez|ent|ons)?\b|\b(re)?starts?\b|\bstarted\b|\bstarting\b/, false],
  ['stop', /\bstops?\b|\bstopped\b|\bstopping\b|\barret(e|er|es|ez|ent|ons)?\b/, false],
  ['verifie', /\bverifi(e|er|es|ez|ent|ons)?\b|\bchecks?\b|\bchecked\b|\bchecking\b|\blints?\b/, false],
  ['audit', /\baudits?\b/, false],
];

const IMPROVE_RE = /\b(amelior|optimis|nettoi|securis|refactor|audit|qualite|perfs?|performance)\w*/;
const COLLECTIVE_RE = /\b(applique|construis|construire|reecris|reecrire|migres?|migrer|ces ameliorations|ces taches|tout ceci|tout ca|from scratch)\b/;
// Anchored interrogatives. Tested on separator-flattened text so that
// "qu'est-ce", "c'est quoi" and "est-ce que" match their spaced forms.
const QUESTION_OPENER_RE = /^(pourquoi|comment|quel|quelle|quels|quelles|qui|quoi|qu|quand|combien|lequel|lesquels|ou|pour quoi|a quoi|est ce|qu est ce|c est|sais tu|que|why|how|what|when|where|who|which|is|are|was|were|do|does|did|can|could)\b/;

// One pasted list item: "- foo", "* foo", "1. foo", "1) foo", "- [ ] foo"
// (U+2022 bullet accepted too, as an escape: source stays ASCII).
const ITEM_RE = /^[ \t]*(?:[-*\u2022]|\d{1,3}[.)\]])(\s*\[[ xX]\])?\s+\S/;
const ITEM_STRIP = /^[ \t]*(?:[-*\u2022]|\d{1,3}[.)\]])(\s*\[[ xX]\])?\s+/;

function parseTaskList(prompt) {
  const items = [];
  String(prompt || '').split(/\r?\n/).forEach((line) => {
    if (ITEM_RE.test(line)) {
      const cleaned = line.replace(ITEM_STRIP, '').trim().slice(0, 200);
      if (cleaned) items.push(cleaned);
    }
  });
  return items;
}

// Returns { kind, verbs, expectsChange, improvement, collective, taskItems,
// hasTaskList, reason }. kind is ACTION when a verb or a pasted list is
// present, else QUESTION when isGeneralQuestion matches, else AMBIGUOUS.
function classifyAction(prompt) {
  const text = String(prompt || '');
  const t = fold(text);
  const verbs = [];
  let expectsChange = false;
  for (const [name, re, modify] of VERBS) {
    let hit = false;
    try { hit = re.test(t); } catch (_) { hit = false; }
    if (hit) {
      verbs.push(name);
      if (modify) expectsChange = true;
    }
  }
  const taskItems = parseTaskList(text);
  const hasTaskList = taskItems.length >= 2;
  if (hasTaskList) expectsChange = true;
  let kind = 'AMBIGUOUS';
  let reason = 'no action verb, no task list, no question pattern';
  // Interrogative openers ("pourquoi ce test echoue ?") win over RUN verbs
  // (test/lance/run are nouns as often as orders), but never over MODIFY
  // verbs ("comment corriger X" stays a task: P39 task-verbs-win rule).
  if (!expectsChange && !hasTaskList && QUESTION_OPENER_RE.test(t.replace(/[-']/g, ' '))) {
    kind = 'QUESTION';
    reason = 'interrogative opener, no modification verb';
  } else if (verbs.length || hasTaskList) {
    kind = 'ACTION';
    reason = 'verbs=[' + verbs.join(',') + ']' + (hasTaskList ? ' tasklist=' + taskItems.length : '');
  } else if (!t || t.length > 2000) {
    kind = 'AMBIGUOUS';
    reason = !t ? 'empty prompt' : 'prompt too long to classify as a question';
  } else {
    let q = false;
    try { q = isGeneralQuestion(text); } catch (_) { q = false; }
    if (q) { kind = 'QUESTION'; reason = 'general-question pattern, no action verb'; }
  }
  return {
    kind, verbs, expectsChange, taskItems, hasTaskList,
    improvement: IMPROVE_RE.test(t),
    collective: hasTaskList || COLLECTIVE_RE.test(t),
    reason,
  };
}

module.exports = { classifyAction, parseTaskList, fold };
