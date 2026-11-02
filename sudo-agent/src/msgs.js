// Sudo Agent engine -> model messages (P53-5).
// Every message the DRIVER sends to the model must be: short, factual,
// imperative, in the CONVERSATION language, and must never invite an
// apology or a refusal ("I'm sorry, but I can't..."). French is the
// product default; English is only used when the conversation is English.
// Stdlib only, ASCII only, deterministic (no locale, no network).
'use strict';

// Deliberately small closed-class word lists: they classify the CONVERSATION,
// never a single ambiguous sentence (ties fall back to French = product
// language). Accented forms are avoided so the source stays ASCII.
const FR_WORDS = ['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'pour', 'dans',
  'avec', 'sur', 'pas', 'que', 'qui', 'est', 'sont', 'ce', 'cette', 'il', 'elle', 'je', 'tu',
  'nous', 'vous', 'mon', 'ton', 'son', 'fais', 'corrige', 'ajoute', 'modifie', 'cree',
  'fichier', 'projet', 'erreur', 'verifie', 'reponds', 'peux', 'veux', 'dois', 'aussi',
  'mais', 'plus', 'tout', 'comme', 'bonjour', 'merci', 'stp', 'svp'];
const EN_WORDS = ['the', 'and', 'with', 'for', 'this', 'that', 'you', 'must', 'please',
  'should', 'will', 'not', 'file', 'project', 'error', 'fix', 'check', 'step', 'task',
  'make', 'add', 'can', 'need', 'want', 'your', 'from', 'have', 'would', 'could', 'hello',
  'thanks', 'also', 'but', 'more', 'all', 'like'];

function countWords(list, text) {
  const lower = String(text || '').toLowerCase();
  let n = 0;
  for (const w of list) {
    const re = new RegExp('(^|[^a-z])' + w + '([^a-z]|$)', 'g');
    const m = lower.match(re);
    if (m) n += m.length;
  }
  return n;
}

// Returns 'fr' or 'en'. fallback is returned on a tie (default 'fr').
function detectLang(text, fallback) {
  const fb = fallback === 'en' ? 'en' : 'fr';
  const fr = countWords(FR_WORDS, text);
  const en = countWords(EN_WORDS, text);
  if (fr > en) return 'fr';
  if (en > fr) return 'en';
  return fb;
}

const FR = {
  lang: 'fr',
  invalidCall: (field) => 'Appel invalide : champ ' + String(field || 'name') +
    ' manquant. Reponds par UN appel d\'outil JSON : {"name":"<outil>","arguments":{...}}.',
  badArgs: (why) => 'Arguments illisibles (' + String(why || '').slice(0, 120) +
    '). Reponds avec UN appel JSON strict.',
  strictAction: (why) => 'RAPPEL STRICT : ' + String(why || '') +
    ' Emets exactement UN appel d\'outil maintenant, aucun texte libre. Si la tache est finie, appelle reply ou done.',
  corrective: 'Boucle : tu as repete 3 fois le meme appel (meme outil, memes arguments, meme resultat). ' +
    'Change de strategie : constate autrement (list/grep/read), change d\'outil ou d\'arguments, ou termine via reply/done. ' +
    'Ne re-emets pas cet appel.',
  verifyFail: (round, max, body) => 'VERIFICATION ECHOUEE (essai ' + round + '/' + max + ') :\n' +
    String(body) + '\nCorrige le probleme puis reponds.',
  verifySkipped: (tool) => 'non executee : ' + String(tool) + ' introuvable (installez-le via SDK Manager).',
  verifyTimeout: (check, ms) => 'delai depasse (' + Math.round((Number(ms) || 0) / 1000) + ' s) : ' + String(check),
  answerLang: 'Reponds dans la langue de la conversation.',
  missingTool: (tool, hint) => String(tool) + ' introuvable sur cette machine. Install' +
    'e-le via ' + String(hint || 'le SDK Manager') + ' (avec permission), ou utilise un autre outil.',
  finalPartial: (n, files, reason) => 'PARTIEL : ' + n + ' fichier(s) modifie(s) (' + files + ') ; ' +
    'verification non executee ou echouee : ' + reason + '.',
};

const EN = {
  lang: 'en',
  invalidCall: (field) => 'Invalid call: missing "' + String(field || 'name') +
    '" field. Reply with ONE JSON tool call: {"name":"<tool>","arguments":{...}}.',
  badArgs: (why) => 'Unreadable arguments (' + String(why || '').slice(0, 120) +
    '). Reply with ONE strict JSON tool call.',
  strictAction: (why) => 'STRICT REMINDER: ' + String(why || '') +
    ' Emit exactly ONE tool call now, no free text. If the task is done, call reply or done.',
  corrective: 'Loop: the same call (same tool, same args, same result) ran 3 times. ' +
    'Change strategy: observe differently (list/grep/read), pick another tool or args, or finish via reply/done. ' +
    'Do not re-issue this call.',
  verifyFail: (round, max, body) => 'VERIFICATION FAILED (attempt ' + round + '/' + max + '):\n' +
    String(body) + '\nFix the problem, then reply.',
  verifySkipped: (tool) => 'not run: ' + String(tool) + ' not found (install it from the SDK Manager).',
  verifyTimeout: (check, ms) => 'timed out after ' + Math.round((Number(ms) || 0) / 1000) + ' s: ' + String(check),
  answerLang: 'Answer in the conversation language.',
  missingTool: (tool, hint) => String(tool) + ' is not installed on this machine. Install it via ' +
    String(hint || 'the SDK Manager') + ' (with permission), or use another tool.',
  finalPartial: (n, files, reason) => 'PARTIAL: ' + n + ' file(s) modified (' + files + ') ; ' +
    'verification not run or failed: ' + reason + '.',
};

function t(lang) { return lang === 'en' ? EN : FR; }

module.exports = { detectLang, t, FR, EN };
