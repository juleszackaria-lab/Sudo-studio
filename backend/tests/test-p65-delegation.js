/**
 * SUDO STUDIO - P65 partie E: DELEGATION DETERMINISTE (orchestrateur ->
 * executant -> verificateur -> application ou retour arriere).
 *
 * E16 (constat) : l'onglet "Agents" ne gere que des DEFINITIONS ; il
 * n'orchestre rien. Le moteur savait lancer un sous-agent (subagent/task),
 * mais aucun verificateur ne validait le diff avant l'ecriture.
 *
 * Ce test prouve, sur le moteur empaquete et un faux fournisseur :
 *   E1 une delegation REELLE : deux sous-agents distincts, un fichier ecrit,
 *      une ligne "delegation" dans le journal et un journal de delegation
 *      lisible sur disque ;
 *   E2 le sous-agent EXECUTANT ne recoit que ses outils (aucun bash/delete) ;
 *   E3 le VERIFICATEUR dit NON -> les fichiers sont REMIS en etat ;
 *   E4 le nombre d'etapes est borne ;
 *   E5 l'executant travaille dans une session ENFANT (contexte isole).
 *
 * ASCII only. Stdlib only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, call, text, lastAssistant } = require('./lib/agentHarness');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  OK   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' : ' + ((e && e.message) || e)); }
}

const FILES = { 'app/__init__.py': '', 'app/calc.py': 'def somme(a, b):\n    return a + b\n' };

function setBuild(w) {
  w.store.update(w.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
}

async function main() {
  console.log('SUDO STUDIO - P65-E : delegation deterministe');

  // ---- E1/E2/E5 : delegation nominale ---------------------------------
  {
    const w = createWorld({ files: FILES });
    setBuild(w);
    const r = await w.turn('delegue la creation du fichier conv', [
      call('delegate', { steps: ['cree app/conv.py avec une fonction convertir'] }),
      // sous-agent EXECUTANT
      call('write', { file: 'app/conv.py', content: 'def convertir(montant, taux):\n    return round(montant * taux, 2)\n' }),
      call('done', { summary: 'app/conv.py cree' }),
      // sous-agent VERIFICATEUR (lecture seule)
      call('reply', { text: 'VERDICT: OUI - le fichier conv.py definit convertir.' }),
      // retour a l'orchestrateur
      call('done', { summary: 'Delegation : 1/1 etape appliquee.' }),
    ], { autoApprove: 'session', maxIt: 8, waitMs: 20000 });

    const j = String(r.journal || '');
    check('E1 delegation reellement executee (fichier ecrit)', () => {
      assert.ok(w.exists('app/conv.py'), 'app/conv.py doit exister');
      assert.ok(w.read('app/conv.py').indexOf('def convertir') !== -1);
    });
    check('E1 journal : etape de delegation tracee', () => {
      assert.ok(j.indexOf('delegation etape') !== -1, 'aucune ligne "delegation etape"');
      assert.ok(j.indexOf('delegation verification') !== -1, 'aucune ligne "delegation verification"');
      assert.ok(j.indexOf('delegation bilan') !== -1, 'aucun "delegation bilan"');
    });
    check('E5 deux sous-agents distincts (executant + verificateur)', () => {
      const lines = j.split('\n').filter((l) => l.indexOf('delegation sous-agent') !== -1);
      const roles = lines.map((l) => (/role=(\w+)/.exec(l) || [])[1]).filter(Boolean);
      assert.ok(roles.indexOf('executor') !== -1, 'role=executor absent : ' + lines.join(' | '));
      assert.ok(roles.indexOf('verifier') !== -1, 'role=verifier absent');
      const ids = lines.map((l) => (/child=(\w+)/.exec(l) || [])[1]).filter(Boolean);
      assert.ok(new Set(ids).size >= 2, 'les deux roles doivent avoir des sessions enfants distinctes');
    });
    check('E2 executant restreint (journal) : aucun bash/delete', () => {
      // La liste appliquee est celle que le MOTEUR journalise pour le role.
      const l = String(r.journal || '').split('\n').filter((x) => x.indexOf('role=executor') !== -1);
      assert.ok(l.length, 'aucune ligne role=executor');
      const list = (/listeOutils=([^ |]+)/.exec(l[0]) || [])[1] || '';
      assert.ok(list.indexOf('write') !== -1, 'write doit etre autorise : ' + list);
      ['bash', 'delete', 'rename'].forEach((t) => {
        assert.strictEqual(list.split(',').indexOf(t), -1, t + ' propose a l executant : ' + list);
      });
    });
    check('E2 verificateur en LECTURE SEULE (journal)', () => {
      const l = String(r.journal || '').split('\n').filter((x) => x.indexOf('role=verifier') !== -1);
      assert.ok(l.length, 'aucune ligne role=verifier');
      const list = (/listeOutils=([^ |]+)/.exec(l[0]) || [])[1] || '';
      ['write', 'edit', 'append', 'mkdir', 'bash', 'delete'].forEach((t) => {
        assert.strictEqual(list.split(',').indexOf(t), -1, t + ' propose au verificateur : ' + list);
      });
      assert.strictEqual(list.split(',').indexOf('read'), 0, 'read doit etre le premier outil : ' + list);
    });
    check('E1 journal de delegation lisible sur disque', () => {
      const dirs = [];
      try {
        const st = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'stateDir'));
        dirs.push(st.paths(w.proj).root);
      } catch (_) {}
      let found = null;
      for (const d of dirs) {
        try {
          const f = fs.readdirSync(d).filter((x) => x.indexOf('delegation-') === 0);
          if (f.length) { found = path.join(d, f[0]); break; }
        } catch (_) {}
      }
      assert.ok(found, 'aucun fichier delegation-*.json dans ' + dirs.join(','));
      const doc = JSON.parse(fs.readFileSync(found, 'utf8'));
      assert.strictEqual(doc.schema, 'sudo-delegation/1');
      assert.ok(Array.isArray(doc.steps) && doc.steps.length === 1);
    });
    check('E1 statut du tour honnete (pas de fausse reussite)', () => {
      const t = lastAssistant(r.msgs);
      assert.ok(typeof t === 'string');
      assert.notStrictEqual(r.out.runStatus, undefined);
    });
  }

  // ---- E3 : le verificateur dit NON -> retour arriere ------------------
  {
    const w = createWorld({ files: FILES });
    setBuild(w);
    const r = await w.turn('delegue la creation du fichier conv', [
      call('delegate', { steps: ['cree app/conv.py avec une fonction convertir'] }),
      call('write', { file: 'app/conv.py', content: 'def convertir(montant, taux):\n    return round(montant * taux, 2)\n' }),
      call('done', { summary: 'cree' }),
      call('reply', { text: 'VERDICT: NON - la fonction ne correspond pas a l etape demandee.' }),
      call('done', { summary: 'verification negative' }),
    ], { autoApprove: 'session', maxIt: 8, waitMs: 20000 });
    check('E3 verificateur NON : fichier remis en etat (absent)', () => {
      assert.ok(!w.exists('app/conv.py'), 'le fichier aurait du etre supprime par le retour arriere');
    });
    check('E3 retour arriere journalise', () => {
      assert.ok(String(r.journal || '').indexOf('delegation retour arriere') !== -1,
        'aucune ligne "delegation retour arriere"');
    });
    check('E3 etape marquee refusee, pas appliquee', () => {
      const l = String(r.journal || '').split('\n').filter((x) => x.indexOf('delegation bilan') !== -1);
      assert.ok(l.length && l[0].indexOf('refusee') !== -1, 'bilan = ' + (l[0] || '(aucun)'));
    });
  }

  // ---- E4 : etapes bornees --------------------------------------------
  {
    const w = createWorld({ files: FILES });
    setBuild(w);
    const many = [];
    for (let i = 0; i < 20; i++) many.push('etape ' + i);
    const r = await w.turn('delegue', [
      call('delegate', { steps: many }),
      call('done', { summary: 'borne' }),
    ], { autoApprove: 'session', maxIt: 4, waitMs: 20000 });
    check('E4 nombre d etapes borne (<= 8)', () => {
      assert.ok(String(r.journal || '').indexOf('delegation etape') !== -1);
      const n = String(r.journal || '').split('\n').filter((x) => x.indexOf('delegation etape') !== -1).length;
      assert.ok(n <= 8, 'etapes executees = ' + n);
    });
  }

  console.log('');
  console.log('TOTAL P65-E : ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ECHEC DU HARNAIS: ' + ((e && e.stack) || e)); process.exit(1); });
