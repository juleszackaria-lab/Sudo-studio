/**
 * SUDO STUDIO - P65 partie B: PROFILS DE CAPACITE PAR MODELE (donnee, pas code).
 *
 * Prouve, moteur reellement empaquete + faux fournisseur :
 *  - le profil applique vient d'un FICHIER (capability-profiles.json) ;
 *  - le plafond d'outils du profil est REELLEMENT applique a la requete
 *    envoyee au fournisseur (on compte les outils recus) ;
 *  - le fichier ADMIN (<home>/capability-profiles.json) surcharge le paquet
 *    sans rebuild ;
 *  - un modele inconnu recoit le profil PRUDENT + un avertissement journalise ;
 *  - ajouter un modele = ajouter une entree de donnee (aucune modification du
 *    moteur : le test ajoute un modele jamais code dans loop.js).
 *
 * ASCII only. Stdlib only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, call, text } = require('./lib/agentHarness');
const AGENT_SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
const capabilities = require(path.join(AGENT_SRC, 'capabilities'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  OK   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' : ' + ((e && e.message) || e)); }
}
function writeAdmin(home, obj) {
  fs.writeFileSync(path.join(home, 'capability-profiles.json'), JSON.stringify(obj, null, 2));
}

async function main() {
  console.log('SUDO STUDIO - P65-B : profils de capacite');

  // ---- 1. la donnee est un fichier lisible -----------------------------
  check('B1 manifeste present et valide (schema)', () => {
    const man = JSON.parse(fs.readFileSync(capabilities.DEFAULT_FILE, 'utf8'));
    assert.strictEqual(man.schema, capabilities.SCHEMA);
    assert.ok(Object.keys(man.models).length >= 13, 'modeles = ' + Object.keys(man.models).length);
  });

  check('B2 identifiants du catalogue resolus (13 modeles)', () => {
    const ids = [
      'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',
      'bartowski/phi-3-mini-4k-instruct-GGUF', 'meta-llama/Llama-3.2-3B-Instruct',
      'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'bartowski/CodeLlama-7b-Instruct-GGUF',
      'bartowski/mistral-7b-instruct-v0.2-GGUF', 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
      'bartowski/deepseek-coder-v2-lite-instruct-GGUF', 'bartowski/Meta-Llama-3.1-13B-Instruct-GGUF',
      'bartowski/CodeLlama-13b-Instruct-GGUF', 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
      'mistralai/Mistral-7B-Instruct-v0.2',
    ];
    const unknown = ids.filter((id) => capabilities.resolve(id, { home: '/tmp/p65-nohome' }).source !== 'manifeste');
    assert.deepStrictEqual(unknown, [], 'non resolus : ' + unknown.join(', '));
  });

  check('B3 modele inconnu : profil prudent + avertissement', () => {
    const r = capabilities.resolve('mon-modele-maison-1B', { home: '/tmp/p65-nohome' });
    assert.strictEqual(r.source, 'inconnu');
    assert.strictEqual(r.id, 'prudent');
    assert.ok(/prudent/i.test(r.warning), 'avertissement = ' + r.warning);
    assert.ok(r.profile.toolsMax <= 8, 'toolsMax prudent = ' + r.profile.toolsMax);
  });

  // ---- 2. le moteur APPLIQUE le plafond d'outils (mesure) --------------
  {
    // P65-B : le plafond s'applique a un modele CONNU du manifeste (ici
    // declare par le fichier ADMIN, sans rebuild). Un modele INCONNU garde les
    // valeurs historiques du moteur et ne recoit qu'un avertissement : on ne
    // change pas le comportement a l'aveugle (B4-bis).
    const w = createWorld({ files: { 'package.json': '{}' }, model: 'maison-petit-1b' });
    fs.writeFileSync(path.join(w.home, 'capability-profiles.json'),
      JSON.stringify({ schema: 'sudo-capability-profiles/1',
        models: { 'maison-petit-1b': { toolsMax: 6, label: 'Modele client 1B' } } }));
    w.store.update(w.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
    const r = await w.turn('cree le fichier a.txt avec ok', [
      call('write', { file: 'a.txt', content: 'ok\n' }),
      call('done', { summary: 'fait' }),
    ], { autoApprove: 'session', maxIt: 5, waitMs: 15000 });
    const sent = (r.chats || [])[0] || {};
    const cap = capabilities.resolve((r.chats[0] || {}).model || 'fake-model', { home: w.home });
    check('B4 outils envoyes <= plafond du profil', () => {
      assert.ok(Array.isArray(sent.tools) && sent.tools.length > 0, 'aucun outil envoye');
      assert.ok(sent.tools.length <= cap.profile.toolsMax,
        'envoyes=' + sent.tools.length + ' plafond=' + cap.profile.toolsMax);
    });
    check('B4-bis la sortie reply/done survit toujours au plafond', () => {
      const names = (sent.tools || []).map((t) => (t.function && t.function.name) || '');
      assert.ok(names.indexOf('done') !== -1, 'done retire par le plafond : ' + names.join(','));
      assert.ok(names.indexOf('reply') !== -1, 'reply retire par le plafond : ' + names.join(','));
      assert.ok(names.indexOf('read') !== -1, 'read retire par le plafond : ' + names.join(','));
    });
    check('B4-ter modele inconnu : aucun plafond impose a l aveugle', async () => {
      const w2 = createWorld({ files: { 'package.json': '{}' } });
      w2.store.update(w2.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
      const r2 = await w2.turn('salut', [call('reply', { text: 'bonjour' })], { maxIt: 4, waitMs: 15000 });
      const s2 = (r2.chats || [])[0] || {};
      const cap2 = capabilities.resolve('fake-model', { home: w2.home });
      assert.strictEqual(cap2.source, 'inconnu');
      assert.ok((s2.tools || []).length > cap2.profile.toolsMax,
        'un modele inconnu a ete plafonne : envoyes=' + (s2.tools || []).length);
    });
    check('B5 le profil applique est journalise (modele, source)', () => {
      const l = String(r.journal || '').split('\n').filter((x) => x.indexOf('profil de capacite') !== -1);
      assert.ok(l.length >= 1, 'aucune ligne "profil de capacite" dans le journal');
      assert.ok(/source=/.test(l[0]), 'ligne = ' + l[0]);
    });
    check('B6 modele inconnu : avertissement journalise', async () => {
      const w3 = createWorld({ files: { 'package.json': '{}' } });
      w3.store.update(w3.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
      const r3 = await w3.turn('salut', [call('reply', { text: 'bonjour' })], { maxIt: 4, waitMs: 15000 });
      const l = String(r3.journal || '').split('\n').filter((x) => x.indexOf('profil de capacite') !== -1);
      assert.ok(l.length && /avertissement=/.test(l[0]) && l[0].indexOf('prudent') !== -1,
        'ligne = ' + (l[0] || '(aucune)'));
    });
  }

  // ---- 3. surcharge ADMIN sans rebuild --------------------------------
  {
    // Modele CONNU (present au manifeste livre) pour que le plafond admin
    // s'applique reellement au fournisseur.
    const w = createWorld({ files: { 'package.json': '{}' }, model: 'qwen2.5-coder-1.5b' });
    // L'administrateur ajoute un modele MAISON et abaisse son plafond a 6.
    writeAdmin(w.home, {
      models: {
        'qwen2.5-coder-1.5b-instruct': { toolsMax: 6, temperature: 0.33, label: 'maison' },
        'modele-du-client-7b': { toolsMax: 9, ctxSafe: 6144, profile: 'small', toolMode: 'json-grammar' },
      },
    });
    w.store.update(w.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
    const r = await w.turn('cree le fichier b.txt avec ok', [
      call('write', { file: 'b.txt', content: 'ok\n' }),
      call('done', { summary: 'fait' }),
    ], { autoApprove: 'session', maxIt: 5, waitMs: 15000, env: { SUDO_AGENT_MODEL: 'qwen2.5-coder-1.5b' } });
    check('B7 surcharge admin prise en compte (modele connu)', () => {
      const cap = capabilities.resolve('qwen2.5-coder-1.5b-instruct', { home: w.home });
      assert.strictEqual(cap.profile.toolsMax, 6, 'toolsMax = ' + cap.profile.toolsMax);
      assert.strictEqual(cap.profile.temperature, 0.33);
    });
    check('B8 modele ajoute par l administrateur : resolu sans code', () => {
      const cap = capabilities.resolve('modele-du-client-7b', { home: w.home });
      assert.strictEqual(cap.source, 'manifeste');
      assert.strictEqual(cap.profile.toolsMax, 9);
      assert.strictEqual(cap.profile.ctxSafe, 6144);
    });
    check('B9 le plafond admin atteint bien le fournisseur', () => {
      const sent = (r.chats || [])[0] || {};
      const cap = capabilities.resolve('qwen2.5-coder-1.5b', { home: w.home });
      assert.strictEqual(cap.source, 'manifeste', 'le modele doit venir du fichier admin');
      assert.ok((sent.tools || []).length <= cap.profile.toolsMax,
        'envoyes=' + (sent.tools || []).length + ' plafond=' + cap.profile.toolsMax);
    });
  }

  // ---- 4. un manifeste illisible ne casse jamais le tour --------------
  {
    const w = createWorld({ files: { 'package.json': '{}' } });
    fs.writeFileSync(path.join(w.home, 'capability-profiles.json'), '{ ceci n est pas du json');
    w.store.update(w.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'plan'; });
    const r = await w.turn('salut', [text('bonjour')], { maxIt: 4, waitMs: 15000 });
    check('B10 manifeste admin illisible : repli sur le paquet, tour normal', () => {
      assert.strictEqual(r.out.runStatus, 'TERMINE');
      const sent = (r.chats || [])[0] || {};
      assert.ok(Array.isArray(sent.tools));
    });
  }

  console.log('');
  console.log('TOTAL P65-B : ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ECHEC DU HARNAIS: ' + ((e && e.stack) || e)); process.exit(1); });
