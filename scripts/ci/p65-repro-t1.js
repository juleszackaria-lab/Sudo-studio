/**
 * SUDO STUDIO - P65 partie A: REPRODUCTION de T1 (tours vides).
 *
 * Ce script ne corrige rien et n'affirme rien : il MESURE, sur le moteur
 * reellement empaquete (sudo-agent/src/loop.js) et un faux fournisseur
 * deterministe. Il doit pouvoir tourner a l'identique AVANT et APRES la
 * correction : c'est la comparaison des deux sorties qui prouve le defaut.
 *
 *   node scripts/ci/p65-repro-t1.js
 *
 * Pour chaque scenario : statut, texte visible rendu a l'utilisateur, appels
 * reellement executes. Un tour VIDE est un tour dont le statut est TERMINE
 * alors qu'aucun texte de reponse et aucun appel d'outil execute n'existe.
 *
 * ASCII only. Stdlib only.
 */
'use strict';

const { createWorld, call, text, lastAssistant } = require('../../backend/tests/lib/agentHarness');

const out = [];
function line(s) { out.push(s); console.log(s); }

function setMode(w, mode) {
  w.store.update(w.sessionId, (s) => { if (!s.meta) s.meta = {}; s.meta.mode = mode; });
}

// Un tour vide : statut TERMINE sans texte utile et sans execution d'outil.
const NON_EXEC = ['skipped', 'denied', 'need_approval', 'asked', 'already_done', 'corrective'];
function executedOk(r) {
  return (r.calls || []).filter((c) => c.ok && NON_EXEC.indexOf(c.code) === -1
    && c.tool !== 'reply' && c.tool !== 'done').length;
}
function visibleText(r) {
  const t = String(lastAssistant(r.msgs) || '').trim();
  // Les textes fabriques par le moteur (P61-9) ne sont PAS une reponse.
  const synthetic = /^Tache terminee( \(\d+ appel\(s\) abouti\(s\)\))?\.?$/.test(t);
  return { text: t, synthetic, usable: !!t && !synthetic };
}

async function scenario(title, prompt, mode, script, opts) {
  const w = createWorld({ files: { 'package.json': JSON.stringify({ name: 'p65', version: '1.0.0' }) } });
  setMode(w, mode);
  const r = await w.turn(prompt, script, Object.assign({ maxIt: 8, waitMs: 15000 }, opts || {}));
  const v = visibleText(r);
  const ex = executedOk(r);
  const vide = (r.out.runStatus === 'TERMINE') && !v.usable && ex === 0;
  line('');
  line('--- ' + title + ' ---');
  line('  mode                 : ' + mode);
  line('  invite               : ' + JSON.stringify(prompt));
  line('  statut du tour       : ' + r.out.runStatus + ' (stopReason=' + (r.out.stopReason || '-') + ')');
  line('  appels moteur        : ' + (r.chats || []).length);
  line('  outils executes (ok) : ' + ex);
  line('  texte visible        : ' + JSON.stringify(v.text.slice(0, 300)));
  line('  texte fabrique ?     : ' + (v.synthetic ? 'OUI (aucune reponse du modele)' : 'non'));
  line('  TOUR VIDE            : ' + (vide ? 'OUI' : 'non'));
  return { title, mode, status: r.out.runStatus, text: v.text, synthetic: v.synthetic, vide, executed: ex };
}

async function main() {
  line('SUDO STUDIO - P65 / T1 : tours vides (mesure, pas de correction)');
  line('moteur : sudo-agent/src/loop.js   fournisseur : faux (deterministe)');
  const results = [];

  // R0 : T2 -- le calcul part au modele ou non (voir partie A4).
  results.push(await scenario('RO calcul en phrase', '1+1 font combien', 'plan', [text('299')]));
  results.push(await scenario('RO calcul nu', '2+298', 'plan', [text('299')]));

  // Invite AMBIGU = chemin outils (le runtime force un appel d'outil a chaque
  // tour) : c'est le chemin de la photo du 14/11.
  const A = 'salut';

  // R1 (temoin) : le modele repond en texte libre. Doit afficher le texte.
  results.push(await scenario('R1 temoin : texte libre', A, 'plan',
    [text('1+1 font 2.')]));

  // R2 : le modele termine par done() SANS resume. C'est le chemin de la photo
  // du 14/11 : "Mode plan / Tour en cours... / Termine. / TERMINE (plan)".
  results.push(await scenario('R2 done() vide', A, 'plan',
    [call('done', {})]));

  // R3 : sortie d'outil INUTILISABLE apres reparation cote runtime
  // ("tool call unusable after repairs" dans runtime_debug.log) : le runtime
  // repond 200 + erreur structuree, le modele ne rend aucun appel. Le dernier
  // appel (format de secours, sans outil) ne rend rien non plus.
  results.push(await scenario('R3 appel inutilisable (runtime)', A, 'plan',
    [{ runtimeRefusal: { field: 'json',
        message: 'Appel invalide : JSON. Reponds par {"tool": <nom>, "args": {...}}.',
        detail: 'JSON illisible', example: { tool: 'read', args: { file: 'README.md' } } },
      text: 'Appel invalide : JSON. Reponds par {"tool": <nom>, "args": {...}}.' },
     text('')]));

  // R4 : done tronque (max_tokens tombe au milieu des arguments).
  results.push(await scenario('R4 done() tronque', A, 'plan',
    [{ call: { name: 'done', rawArgs: '{"summary": "1+1 font' } }]));

  // R5 : "continu" apres une reponse : termine sans rien faire ni dire.
  results.push(await scenario('R5 continu', 'continu', 'plan', [call('done', {})]));

  // R6 : mode BUILD, question simple, done() vide (meme defaut hors plan).
  results.push(await scenario('R6 build done() vide', A, 'build',
    [call('done', {})]));

  // R7 : le modele ecrit la reponse en texte libre PUIS termine par done()
  // sans resume (comportement tres courant d'un 1.5B). Le texte ne doit pas
  // etre jete : c'est la reponse.
  results.push(await scenario('R7 texte + done() vide', A, 'plan',
    [{ text: '1+1 font 2.', call: { name: 'done', args: {} } }]));

  // R8 : le modele ecrit la reponse, puis produit un appel INUTILISABLE.
  results.push(await scenario('R8 texte + appel inutilisable', A, 'plan',
    [{ text: '1+1 font 2.', call: { name: 'done', rawArgs: '{"summary": ' } },
     text('1+1 font 2.')]));

  const vides = results.filter((r) => r.vide).length;
  line('');
  line('===== SYNTHESE AVANT/APRES =====');
  line('  scenarios mesures    : ' + results.length);
  line('  TOURS VIDES          : ' + vides);
  for (const r of results) {
    line('   - ' + r.title + ' : statut=' + r.status + ' texte=' +
      JSON.stringify(r.text.slice(0, 60)) + (r.vide ? '  <-- TOUR VIDE' : ''));
  }
  line('  verdict              : ' + (vides ? 'DEFAUT REPRODUIT' : 'aucun tour vide'));
}

main().then(() => process.exit(0), (e) => { console.error('ECHEC DU SCRIPT: ' + ((e && e.stack) || e)); process.exit(1); });
