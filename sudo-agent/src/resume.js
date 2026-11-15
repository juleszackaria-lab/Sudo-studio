// P63-C - reprise DETERMINISTE du travail interrompu.
//
// Regle produit : "continu" (et ses synonymes) n'est PAS une demande au modele,
// c'est un CHEMIN DE REPRISE. Des que le message de l'utilisateur n'est fait
// que d'un de ces mots (ponctuation et accents toleres), l'agent relit le
// registre d'avancement sur disque et reprend a la premiere etape non faite,
// SANS passer par la conversation ni par une planification du modele.
//
// Ce module est volontairement pur (aucune E/S) pour etre testable seul.
'use strict';

// Mots acceptes, compares sans accents ni casse, message entier seulement.
const WORDS = [
  'continu', 'continue', 'continuez', 'continuer', 'continues',
  'reprends', 'reprend', 'reprendre', 'reprenez', 'reprise', 'resume', 'resumes', 'resumer',
  'poursuis', 'poursuit', 'poursuivre', 'poursuivez',
  'vas y', 'vasy', 'va y',
  'on continue', 'ok continue', 'ok continu', 'alors continue',
];

// Ponctuation/espaces toleres autour du mot, y compris "continu !", "Continu.",
function normalize(text) {
  let t = String(text == null ? '' : text).trim().toLowerCase();
  // retirer les accents sans dependance externe (echappements unicode : la
  // source reste ASCII).
  t = t.replace(/[\u00e9\u00e8\u00ea\u00eb]/g, 'e').replace(/[\u00e0\u00e2\u00e4]/g, 'a')
    .replace(/[\u00ee\u00ef]/g, 'i').replace(/[\u00f4\u00f6]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc]/g, 'u').replace(/\u00e7/g, 'c');
  t = t.replace(/[.,;:!?\u2026"'\u00ab\u00bb()\[\]\-\u2013\u2014]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function isResumeIntent(text) {
  const t = normalize(text);
  if (!t) return false;
  // Message entier = le mot de reprise (jamais "continue d'ecrire le rapport").
  if (WORDS.indexOf(t) !== -1) return true;
  // "vas-y", "vas y" et "ok, continu" deja normalises ci-dessus.
  return false;
}

// Libelle du bouton de l'interface (meme chemin que le mot cle).
function buttonLabel() { return 'Reprendre le travail'; }

// Reponse quand la reprise est demandee mais qu'il n'y a rien a reprendre.
function nothingText() {
  return 'Aucun travail inacheve a reprendre : toutes les etapes connues sont ' +
    'faites ou hors perimetre. Envoyez une nouvelle demande pour demarrer un travail.';
}

// Bandeau de reprise : les 4 nombres exiges, dans l'ordre exige.
function bannerText(job) {
  const c = (job && job.counts) || { done: 0, failed: 0, interrupted: 0, skipped: 0, total: 0 };
  const next = job && typeof job.next === 'number' && job.next >= 0 ? (job.next + 1) : null;
  return 'REPRISE du travail ' + String((job && job.id) || '').slice(0, 24) + ' : ' +
    c.done + ' faite(s), ' + c.failed + ' echouee(s), ' + c.interrupted + ' interrompue(s), ' +
    c.skipped + ' non tentee(s) sur ' + c.total + '.' +
    (next ? ' Redemarrage a l etape ' + next + '.' : '');
}

module.exports = { isResumeIntent, normalize, buttonLabel, nothingText, bannerText, WORDS };
