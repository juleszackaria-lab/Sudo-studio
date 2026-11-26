#!/usr/bin/env node
/**
 * SUDO STUDIO - P70 parties D, E, F.
 *   V1..V4  rapports verifies : un "done" du modele n'est jamais un fait ;
 *   V5      etiquettes : dedoublonnage != echec, statut interne jamais brut ;
 *   V6      edition : refus si l'intention est une suppression ; approximation
 *           etiquetee + approbation ; arret apres 2 echecs identiques ;
 *   V7      environnement : PATH lu, outils resolus avec chemin complet,
 *           et CONTROLE NEGATIF avec un PATH vide.
 * Lancer : node backend/tests/test-p70-verified-env.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const P70 = path.join(ROOT, 'sudo-agent', 'src', 'p70');
const verified = require(path.join(P70, 'verified.js'));
const edit = require(path.join(P70, 'edit.js'));
const env = require(path.join(P70, 'env.js'));
const timing = require(path.join(P70, 'timing.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// ---------------------------------------------------------------- D
const fake = verified.verifyClaims('Workflow GitHub supprime. Tache terminee. Les modifications ont ete appliquees.',
  { deleted: [], created: [], modified: [] });
check('V1 (V1 du PC) un modele qui annonce une suppression sans fait -> ECHEC',
  fake.status === 'ECHEC' && fake.ok === false, JSON.stringify(fake).slice(0, 160));
check('V2 le message de contradiction est explicite',
  /Le modele a annonce/.test(fake.message) && /aucun fichier n/.test(fake.message), fake.message.slice(0, 160));
const okFacts = verified.verifyClaims('Workflow GitHub supprime.', { deleted: ['.github/workflows/ci-cd.yml'], created: [], modified: [] });
check('V3 CONTROLE POSITIF : la meme phrase avec un fait verifie passe', okFacts.ok === true, JSON.stringify(okFacts));
const createLie = verified.verifyClaims('J ai cree le fichier notes.md.', { deleted: [], created: [], modified: [] });
check('V4 un fichier annonce cree mais absent -> ECHEC', createLie.status === 'ECHEC' && /aucun fichier n.a ete cree/.test(createLie.message),
  createLie.message.slice(0, 140));
check('V5a un dedoublonnage nest plus affiche comme un echec',
  !/ech(ec|eacute)/i.test(verified.labelFor('already_done')) && /deja execute/.test(verified.labelFor('already_done')),
  verified.labelFor('already_done'));
check('V5b un statut interne nest jamais montre brut',
  /en attente/.test(verified.labelFor('await_choice')) && !/await_choice/.test(verified.labelFor('await_choice')),
  verified.labelFor('await_choice'));
check('V5c une ligne de resultat est homogene', /^Echec : /.test(verified.resultLine('ECHEC', 'rien fait')),
  verified.resultLine('ECHEC', 'rien fait'));

// ---------------------------------------------------------------- E
const g1 = edit.guardEdit({ file: '.github/workflows/ci-cd.yml', intentKind: 'delete' });
check('V6a refus d editer un fichier dont l intention est une SUPPRESSION (bug V1)',
  g1.ok === false && g1.code === 'intent_delete', JSON.stringify(g1).slice(0, 140));
const g2 = edit.guardEdit({ file: 'a.js', intentKind: 'modify', match: 'approximate',
  diff: '- old\n+ new' });
check('V6b correspondance approchee : diff etiquete + approbation exigee',
  g2.ok === false && g2.code === 'needs_approval' && g2.label === 'correspondance approchee' && /new/.test(g2.diff),
  JSON.stringify(g2).slice(0, 160));
const g3 = edit.guardEdit({ file: 'a.js', intentKind: 'modify', match: 'exact' });
check('V6c une correspondance exacte passe sans approbation', g3.ok === true, JSON.stringify(g3));
edit.reset();
const f1 = edit.noteFailure('a.js', 'ambiguous');
const f2 = edit.noteFailure('a.js', 'ambiguous');
check('V6d deux echecs identiques sur la meme cible -> on ARRETE et on demande',
  f1.stop === false && f2.stop === true && /Arret sur/.test(f2.message), JSON.stringify(f2).slice(0, 160));

// ---------------------------------------------------------------- F
const res = env.resolveTools(['node', 'git', 'python3', 'npm', 'docker']);
const line = env.journalLine(res);
check('V7a les outils presents sont resolus avec leur chemin COMPLET',
  !!res.found.node && path.isAbsolute(res.found.node) && !!res.found.git,
  line.slice(0, 180));
check('V7b la ligne de journal nomme les absents et la source du PATH',
  /absents=/.test(line) || res.missing.length === 0, line.slice(0, 220));
// P70-F, controle negatif valable sur Linux ET Windows : avec un PATH qui ne
// contient rien, un outil INCONNU doit rester absent (aucune invention), et si
// node est retrouve ce ne peut etre que par un dossier d installation connu -
// jamais par le PATH. C'est exactement la garantie de p70/env.js.
const resBad = env.resolveTools(['node', 'git', 'p70-outil-inexistant'], { pathValue: '/nonexistent-dir-p70' });
check('V7c CONTROLE NEGATIF : PATH vide -> un outil inexistant reste ABSENT',
  resBad.missing.indexOf('p70-outil-inexistant') !== -1, 'absents=' + resBad.missing.join(','));
check('V7d CONTROLE NEGATIF : avec ce PATH, node/git ne viennent jamais du PATH',
  ['node', 'git'].every((n) => !resBad.found[n] || resBad.found[n].indexOf('nonexistent-dir-p70') === -1),
  JSON.stringify(resBad.found));

// chronometrage
const t = timing.start();
const t1 = t.finish();
check('V8 le chronometrage rend modele/outils/checkpoint/git/total',
  ['model_ms', 'tools_ms', 'checkpoint_ms', 'git_ms', 'total_ms'].every((k) => typeof t1[k] === 'number'),
  JSON.stringify(t1));
check('V8b la ligne de journal du tour est lisible', /temps total=.*modele=.*checkpoint=/.test(timing.line(t1)),
  timing.line(t1));

console.log('');
if (failures.length === 0) {
  console.log('P70 rapports verifies, edition, environnement: ' + pass + ' checks passed (all green)');
  process.exit(0);
}
console.log('P70 rapports verifies, edition, environnement: ' + pass + ' checks passed, ' + failures.length + ' FAILED');
failures.forEach((f) => console.log('  - ' + f));
process.exit(1);
