#!/usr/bin/env node
/**
 * SUDO STUDIO - P70 : integration du chemin rapide DANS le moteur.
 *
 * Ces tests passent par runTurn (le vrai point d'entree), avec un faux
 * fournisseur qui ne repond RIEN : si le modele est appele, le compteur
 * chats du faux fournisseur le montre. C'est la preuve "0 appel modele".
 *
 *   I1 suppression refusee par l'operateur : 0 appel modele, fichier INTACT,
 *      refus trace (code denied), message REFUS ;
 *   I2 suppression approuvee : 0 appel modele, fichier reellement supprime,
 *      verification disque dans le rapport ;
 *   I3 CONTROLE NEGATIF : porte fermee (SUDO_P70_FASTPATH!=1) -> le modele est
 *      appele (le test rouge si la porte ne fait rien) ;
 *   I4 lecture sans modele : contenu reel affiche ;
 *   I5 le journal porte la ligne prouvante "p70 tour sans modele ... modelCalls:0" ;
 *   I6 V1 du PC : ".github/workflows/ci-cd.yml" est bien supprime, et le disque
 *      le confirme (plus de faux "done").
 * Lancer : node backend/tests/test-p70-integration.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { createWorld, call, text, lastAssistant } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const ON = { SUDO_P70_FASTPATH: '1' };
const FILES = {
  'package.json': JSON.stringify({ name: 'maquis-pos' }),
  'notes.txt': 'a supprimer\n',
  '.github/workflows/ci-cd.yml': 'name: ci\n',
};

async function main() {
  // ---- I1 refus
  {
    const w = createWorld({ files: FILES });
    const r = await w.turn('Supprime le fichier notes.txt', [text('je refuse')], { env: ON, autoApprove: 'deny' });
    const calls = (r.calls || []).map((c) => c.tool + '/' + c.code);
    check('I1a refus : le modele n est PAS appele (0 appel modele)', r.chats.length === 0, 'chats=' + r.chats.length);
    check('I1b refus : le fichier est intact', w.exists('notes.txt'), 'exists=' + w.exists('notes.txt'));
    check('I1c refus : tracee comme refus (code denied)', calls.some((c) => c === 'delete/denied'), calls.join(','));
    check('I1d refus : le message dit REFUS et qu aucune modification n a ete faite',
      /REFUS/i.test(lastAssistant(r.msgs)) && /Aucune modification/i.test(lastAssistant(r.msgs)),
      String(lastAssistant(r.msgs)).slice(0, 160));
  }

  // ---- I2 approbation
  {
    const w = createWorld({ files: FILES });
    const r = await w.turn('Supprime le fichier notes.txt', [text('ok')], { env: ON, autoApprove: 'once' });
    check('I2a approbation : 0 appel modele', r.chats.length === 0, 'chats=' + r.chats.length);
    check('I2b approbation : le fichier est vraiment supprime', !w.exists('notes.txt'), 'exists=' + w.exists('notes.txt'));
    const last = lastAssistant(r.msgs);
    check('I2c approbation : le rapport dit la verification disque', /n.est plus sur le disque/i.test(last),
      String(last).slice(0, 160));
    check('I2d approbation : statut TERMINE', (r.lastRun || {}).status === 'TERMINE',
      JSON.stringify({ s: (r.lastRun || {}).status, r: (r.lastRun || {}).reason }));
  }

  // ---- I3 controle negatif : porte fermee
  {
    const w = createWorld({ files: FILES });
    const r = await w.turn('Supprime le fichier notes.txt', [call('delete', { file: 'notes.txt' }), text('fait')],
      { env: { SUDO_P70_FASTPATH: '0' }, maxIt: 4, autoApprove: 'once' });
    check('I3 CONTROLE NEGATIF : porte fermee -> le modele est appele', r.chats.length > 0, 'chats=' + r.chats.length);
  }

  // ---- I4 lecture
  {
    const w = createWorld({ files: FILES });
    const r = await w.turn('Lis le fichier package.json', [text('je lis')], { env: ON });
    const last = lastAssistant(r.msgs);
    check('I4a lecture : 0 appel modele', r.chats.length === 0, 'chats=' + r.chats.length);
    check('I4b lecture : le contenu reel est affiche', /maquis-pos/.test(last), String(last).slice(0, 120));
  }

  // ---- I5 journal prouvant
  {
    const w = createWorld({ files: FILES });
    await w.turn('Lis le fichier package.json', [text('je lis')], { env: ON });
    const j = fs.readFileSync(path.join(w.logsDir, 'agent.log'), 'utf8');
    const l = j.split('\n').filter((x) => /p70 tour sans modele/.test(x));
    check('I5 le journal porte "p70 tour sans modele" avec modelCalls:0',
      l.length >= 1 && /modelCalls[=:]\s*0/.test(l[l.length - 1]), (l[l.length - 1] || '').slice(0, 200));
  }

  // ---- I6 V1 : le fichier du PC est vraiment supprime
  {
    const w = createWorld({ files: FILES });
    const r = await w.turn('supprime le fichier .github/workflows/ci-cd.yml', [text('done')],
      { env: ON, autoApprove: 'once' });
    check('I6a V1 : 0 appel modele', r.chats.length === 0, 'chats=' + r.chats.length);
    check('I6b V1 : le workflow est reellement absent du disque', !w.exists('.github/workflows/ci-cd.yml'),
      'exists=' + w.exists('.github/workflows/ci-cd.yml'));
    check('I6c V1 : statut TERMINE avec verification disque',
      (r.lastRun || {}).status === 'TERMINE' && /plus sur le disque/i.test(lastAssistant(r.msgs)),
      JSON.stringify({ s: (r.lastRun || {}).status }));
  }

  console.log('');
  if (!fails.length) { console.log('P70 integration moteur: ' + pass + ' checks passed (all green)'); process.exit(0); }
  console.log('P70 integration moteur: ' + pass + ' checks passed, ' + fails.length + ' FAILED');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
