#!/usr/bin/env node
/**
 * SUDO STUDIO - P70 partie C : "supprimer" toujours disponible, routage correct.
 *   S1  chaque intention expose son ensemble MINIMAL, pour ctx 2048 ET 4096 ;
 *   S2  delete ne peut pas etre retire par la reduction de budget ;
 *   S3  CONTROLE NEGATIF : pour une intention d'audit, delete n'est PAS force ;
 *   S4  le routeur ne bascule pas en "security" sur une operation de fichier ;
 *   S5  20 consignes composees : chaque sous-tache a sa route ;
 *   S6  la ligne de journal contient les NOMS.
 * Lancer : node backend/tests/test-p70-surface.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const surface = require(path.join(ROOT, 'sudo-agent', 'src', 'p70', 'surface.js'));
const router = require(path.join(ROOT, 'sudo-agent', 'src', 'router.js'));
const profiles = require(path.join(ROOT, 'sudo-agent', 'src', 'profiles.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const SMALL = profiles.profileTools('small');
const FULL = profiles.profileTools('full');
const INTENTS = ['delete', 'read', 'list', 'create_file', 'create_dir', 'rename', 'modify', 'audit'];

for (const ctx of [2048, 4096]) {
  for (const kind of INTENTS) {
    for (const [label, base] of [['small', SMALL], ['full', FULL]]) {
      const r = surface.toolsForIntent(base, kind, { ctxTokens: ctx });
      const need = surface.minimalFor(kind);
      const missing = need.filter((n) => r.names.indexOf(n) === -1);
      check('S1 ctx=' + ctx + ' ' + label + ' intention=' + kind + ' -> ' + need.join(',') ,
        missing.length === 0, 'manquants=' + missing.join(',') + ' | surface=' + r.names.join(','));
    }
  }
}

// delete ne peut pas tomber par reduction de budget quand on supprime
const drop = surface.toolsForIntent(SMALL, 'delete', { ctxTokens: 2048, budgetDrop: ['delete', 'list'] });
check('S2 delete GARDE malgre la reduction de budget (intention supprimer)',
  drop.names.indexOf('delete') !== -1 && drop.keptDespiteBudget.indexOf('delete') !== -1,
  'noms=' + drop.names.join(',') + ' | gardes=' + drop.keptDespiteBudget.join(','));
// controle negatif : l'audit ne force pas delete
const aud = surface.toolsForIntent(['secaudit', 'read', 'grep', 'list', 'reply', 'done'], 'audit',
  { ctxTokens: 2048, budgetDrop: ['delete'] });
check('S3 CONTROLE NEGATIF : intention audit -> delete nest PAS impose',
  aud.names.indexOf('delete') === -1, 'noms=' + aud.names.join(','));

// routage : fichier d'abord, audit ensuite
const r1 = router.route('supprime le fichier .github/workflows/ci-cd.yml');
check('S4a demande de suppression -> aucun domaine plateforme', r1.domain === null && r1.tools.length === 0,
  JSON.stringify({ d: r1.domain, r: r1.reason }));
const r2 = router.route('Utilise la fonctionnalite run securite audit, trouve les failles puis corrige-les');
check('S4b (V2) une demande d audit reste "security"', r2.domain === 'security', String(r2.domain));
const r3 = router.route('supprime docs/note.md puis lance l audit de securite');
check('S4c consigne composee : 1re sous-tache fichier, 2e security',
  r3.domain === null && r3.subtasks && r3.subtasks[0].kind === 'file-op' &&
  r3.subtasks[1] && r3.subtasks[1].domain === 'security',
  JSON.stringify((r3.subtasks || []).map((s) => s.kind + ':' + (s.domain || '-'))));

// 20 consignes composees FR/EN
const C = [
  'supprime docs/note.md puis lance l audit de securite',
  'supprime le fichier a.txt et ensuite corrige les failles trouvees',
  'efface b.txt puis fais un audit',
  'renomme c.txt en d.txt puis analyse le projet',
  'deplace e/ vers f/ then run the security audit',
  'copie g.txt vers h.txt puis corrige les bugs',
  'supprime le dossier build puis lance le doctor',
  'mkdir assets then analyse the project',
  'delete src/old.js then fix the vulnerabilities',
  'supprime .github/workflows/ci-cd.yml puis corrige les failles',
  'supprime x.txt ; corrige les failles',
  'cree un fichier notes.txt avec: coucou puis audit de securite',
  'supprime docs/ puis analyse le projet',
  'remove tmp.js and then fix the bugs',
  'supprime y.md puis regarde les journaux en erreur',
  'renomme z.md en w.md puis verifie le devops',
  'supprime le fichier ci-cd.yml puis corrige les failles',
  'copie a.txt vers b.txt then run the security audit',
  'supprime note.md puis corrige les vulnerabilites',
  'supprime le fichier cache.tmp puis lance l audit',
];
let okComposed = 0;
const detailC = [];
for (const prompt of C) {
  const r = router.route(prompt);
  const first = (r.subtasks || [])[0];
  const good = first && first.kind === 'file-op' && r.domain === null;
  if (good) okComposed += 1;
  else detailC.push(prompt + ' -> ' + JSON.stringify({ d: r.domain, sub: (r.subtasks || []).map((s) => s.kind) }));
}
// Une LECTURE ne retire pas la main au routeur : elle n'a aucun effet de bord,
// et l'audit qui suit doit rester route vers security.
const rRead = router.route('lis package.json puis lance l audit');
check('S5z une lecture + audit reste routee vers security (aucun effet de bord)',
  rRead.domain === 'security' && rRead.tools.length > 0, JSON.stringify({ d: rRead.domain, n: rRead.tools.length }));
check('S5 les 20 consignes composees sont coupees et la partie fichier nest pas routee vers security',
  okComposed === 20, okComposed + '/20 | ' + detailC.slice(0, 4).join(' || '));

const line = surface.journalLine(surface.toolsForIntent(SMALL, 'delete', { ctxTokens: 2048 }).names,
  'intention delete', 2048);
check('S6 la ligne de journal donne les NOMS et la raison',
  /noms=/.test(line) && /delete/.test(line) && /raison=/.test(line), line.slice(0, 160));

console.log('');
if (failures.length === 0) {
  console.log('P70 surface et routage: ' + pass + ' checks passed (all green)');
  process.exit(0);
}
console.log('P70 surface et routage: ' + pass + ' checks passed, ' + failures.length + ' FAILED');
failures.forEach((f) => console.log('  - ' + f));
process.exit(1);
