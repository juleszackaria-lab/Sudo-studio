/**
 * SUDO STUDIO - P65 parties A et G19: TOURS VIDES (T1) et CALCUL (T2).
 *
 * Un test par echec prouve. Ces assertions ECHOUAIENT sur le code d'avant la
 * correction (verifie par git stash, sortie collee dans le rapport) :
 *
 *   T1  "1+1 font combien" rendait "TERMINE" avec "Tache terminee (1 appel(s)
 *       abouti(s))" et AUCUNE reponse ; "continu" et un done() tronque
 *       finissaient sans texte.
 *   T2  "2+298" ecrit dans une phrase partait au modele (reponse 299) au lieu
 *       du calcul deterministe.
 *
 * Regle P65-A1 : un tour n'est TERMINE que s'il a produit un texte de
 * reponse visible non vide, ou au moins un appel d'outil REELLEMENT execute.
 * Sinon : une relance en texte simple (une seule fois), puis ECHEC explicite
 * avec "Le modele n'a pas produit de reponse utilisable" + bouton Reessayer.
 *
 * Le moteur teste est celui du paquet (sudo-agent/src/loop.js), pas une copie.
 * ASCII only. Stdlib only.
 */
'use strict';

const assert = require('assert');
const { createWorld, call, text, lastAssistant } = require('./lib/agentHarness');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log('  OK   ' + name); }
  catch (e) { fail += 1; failures.push(name + ' : ' + ((e && e.message) || e)); console.log('  FAIL ' + name + ' : ' + ((e && e.message) || e)); }
}

// Invites NON arithmetiques (les cas de calcul sont testes en T2).
// AMBIGU = chemin "outils" (le runtime force un appel : c'est le chemin de la
// photo du 14/11, ou le modele termine par done() vide).
const AMBIGU = 'salut';
// QUESTION = chemin question (une reponse texte, aucun outil propose).
const QUESTION = 'explique la structure du projet';
const RETRY_MSG = "Le modele n'a pas produit de reponse utilisable";
const SYNTHETIC = /^Tache terminee( \(\d+ appel\(s\) abouti\(s\)\))?\.?$/;

function setMode(w, mode) {
  w.store.update(w.sessionId, (s) => { if (!s.meta) s.meta = {}; s.meta.mode = mode; });
}
function lastDone(events) {
  const list = (events || []).filter((e) => e && e.type === 'turn.done');
  return list.length ? list[list.length - 1] : null;
}
function answer(r) {
  return String(lastAssistant(r.msgs) || '').trim();
}
// Un tour vide : TERMINE sans texte utile ni execution reelle.
function isEmptyTurn(r) {
  const d = lastDone(r.events || r.events);
  const t = answer(r);
  const ok = (r.calls || []).filter((c) => c.ok && ['skipped', 'denied', 'already_done', 'corrective'].indexOf(c.code) === -1
    && c.tool !== 'reply' && c.tool !== 'done').length;
  return !!(r.out && r.out.runStatus === 'TERMINE' && d && d.status === 'TERMINE'
    && (!t || SYNTHETIC.test(t)) && ok === 0);
}

async function proj(files) {
  const w = createWorld({ files: files || { 'package.json': JSON.stringify({ name: 'p65', version: '1.0.0' }) } });
  setMode(w, 'plan');
  return w;
}

async function main() {
  console.log('SUDO STUDIO - P65 : tours vides (T1) et calcul deterministe (T2)');

  // ---- T1 : done() sans resume ----------------------------------------
  {
    const w = await proj();
    const r = await w.turn(AMBIGU, [call('done', {})], { maxIt: 6, waitMs: 15000 });
    const d = lastDone(r.events);
    const t = answer(r);
    check('T1a done() vide : statut ECHEC, pas TERMINE', () => {
      assert.notStrictEqual(r.out.runStatus, 'TERMINE', 'le tour ne doit jamais etre TERMINE sans preuve');
      assert.strictEqual(d.status, 'ECHEC', 'turn.done.status = ' + d.status);
    });
    check('T1a done() vide : message exact demande', () => {
      assert.ok(t.indexOf(RETRY_MSG) !== -1, 'texte = ' + JSON.stringify(t.slice(0, 160)));
    });
    check('T1a done() vide : aucun texte fabrique', () => {
      assert.ok(!SYNTHETIC.test(t), 'texte fabrique par le moteur : ' + JSON.stringify(t));
    });
    check('T1a done() vide : bouton Reessayer (retryable)', () => {
      assert.strictEqual(d.retryable, true, 'turn.done.retryable = ' + d.retryable);
    });
    check('T1a done() vide : pas un tour vide', () => { assert.ok(!isEmptyTurn(r)); });
  }

  // ---- T1 : "continu" --------------------------------------------------
  {
    const w = await proj();
    const r = await w.turn('continu', [call('done', {})], { maxIt: 6, waitMs: 15000 });
    check('T1b continu : ECHEC explicite, jamais TERMINE muet', () => {
      assert.notStrictEqual(r.out.runStatus, 'TERMINE');
      assert.ok(answer(r).indexOf(RETRY_MSG) !== -1);
      assert.ok(!isEmptyTurn(r));
    });
  }

  // ---- T1 : appel inutilisable apres reparation (runtime) --------------
  {
    const w = await proj();
    const r = await w.turn(AMBIGU, [
      { runtimeRefusal: { field: 'json', detail: 'JSON illisible',
        message: 'Appel invalide : JSON. Reponds par {"tool": <nom>, "args": {...}}.',
        example: { tool: 'read', args: { file: 'README.md' } } },
        text: 'Appel invalide : JSON.' },
      text(''),
    ], { maxIt: 6, waitMs: 15000 });
    check('T1c appel inutilisable : ECHEC explicite (pas de tour vide)', () => {
      assert.notStrictEqual(r.out.runStatus, 'TERMINE');
      assert.ok(answer(r).indexOf(RETRY_MSG) !== -1);
    });
  }

  // ---- T1 : la relance en texte simple rend la main au modele ----------
  {
    const w = await proj();
    // 1er appel : done vide. 2e appel (relance sans outil) : texte.
    const r = await w.turn(QUESTION, [call('done', {}), text('Deux.')], { maxIt: 6, waitMs: 15000 });
    check('T1d relance texte simple : reponse affichee, statut TERMINE', () => {
      assert.strictEqual(r.out.runStatus, 'TERMINE', 'statut = ' + r.out.runStatus);
      assert.strictEqual(answer(r), 'Deux.');
    });
    check('T1d relance : le 2e appel modele ne contient AUCUN outil', () => {
      const second = (r.chats || [])[1];
      assert.ok(second, 'un 2e appel modele doit exister');
      assert.ok(!second.tools || second.tools.length === 0,
        'la relance doit etre en texte simple (tools=' + JSON.stringify((second.tools || []).length) + ')');
    });
    check('T1d relance : une seule relance (pas de boucle)', () => {
      assert.ok((r.chats || []).length <= 2, 'appels modele = ' + (r.chats || []).length);
    });
  }

  // ---- T1 : le texte libre du modele n'est plus jete -------------------
  {
    const w = await proj();
    const r = await w.turn(AMBIGU, [{ text: '1+1 font 2.', call: { name: 'done', args: {} } }],
      { maxIt: 6, waitMs: 15000 });
    check('T1e texte + done() vide : le texte est la reponse', () => {
      assert.strictEqual(r.out.runStatus, 'TERMINE');
      assert.strictEqual(answer(r), '1+1 font 2.');
    });
  }

  // ---- T1 : resume lisible extrait d'un appel tronque ------------------
  {
    const w = await proj();
    const r = await w.turn(AMBIGU, [{ call: { name: 'done', rawArgs: '{"summary": "La somme vaut 2' } }],
      { maxIt: 6, waitMs: 15000 });
    check('T1f done() tronque : le resume lisible est extrait', () => {
      assert.ok(answer(r).indexOf('La somme vaut 2') !== -1, 'texte = ' + JSON.stringify(answer(r)));
      assert.notStrictEqual(r.out.runStatus, 'TERMINE', 'fragment tronque : statut honnete');
    });
  }

  // ---- NON-REGRESSION : un vrai travail reste TERMINE ------------------
  {
    const w = await proj({ 'package.json': JSON.stringify({ name: 'p65', version: '1.0.0' }) });
    setMode(w, 'build');
    const r = await w.turn('cree le fichier notes.txt avec le contenu bonjour', [
      call('write', { file: 'notes.txt', content: 'bonjour\n' }),
      call('done', { summary: 'Fichier cree.' }),
    ], { autoApprove: 'session', maxIt: 6, waitMs: 15000 });
    check('T1g non-regression : travail reel = TERMINE', () => {
      assert.strictEqual(r.out.runStatus, 'TERMINE', 'statut = ' + r.out.runStatus + ' / ' + answer(r).slice(0, 120));
      assert.ok(w.exists('notes.txt'), 'le fichier doit exister');
    });
  }

  // ---- T2 : calcul deterministe ---------------------------------------
  const calcCases = [
    ['1+1 font combien', '2'],
    ['2+298', '300'],
    ['combien font 2+298 ?', '300'],
    ['calcule (3+4)*5', '35'],
  ];
  for (const [prompt, expected] of calcCases) {
    const w = await proj();
    const r = await w.turn(prompt, [text('299')], { maxIt: 6, waitMs: 15000 });
    check('T2 "' + prompt + '" = ' + expected + ' sans modele', () => {
      assert.ok(answer(r).indexOf('= ' + expected) !== -1, 'texte = ' + JSON.stringify(answer(r)));
      assert.strictEqual((r.chats || []).length, 0, 'le modele ne doit pas etre appele (appels=' + (r.chats || []).length + ')');
      assert.strictEqual(r.out.runStatus, 'TERMINE');
    });
  }
  // Le calcul ne detourne aucune autre demande.
  {
    const w = await proj();
    const r = await w.turn('explique la structure du projet', [text('Voici la structure.')], { maxIt: 6, waitMs: 15000 });
    check('T2 aucune demande non arithmetique detournee', () => {
      assert.strictEqual((r.chats || []).length, 1, 'le modele doit etre appele');
      assert.strictEqual(answer(r), 'Voici la structure.');
    });
  }

  console.log('');
  console.log('TOTAL P65-A : ' + pass + ' PASS, ' + fail + ' FAIL');
  if (fail) { console.log('Echecs :'); for (const f of failures) console.log(' - ' + f); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ECHEC DU HARNAIS: ' + ((e && e.stack) || e)); process.exit(1); });
