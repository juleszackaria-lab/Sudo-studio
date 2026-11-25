#!/usr/bin/env node
/**
 * SUDO STUDIO - P70 partie G : rejoue T1 -> T10 sur un projet TEMPORAIRE et
 * imprime une ligne PASS/FAIL par test, avec la preuve (temps mesure, nombre
 * d'appels modele, etat du disque).
 *
 *   node scripts/ci/p70-replay.js [--json]
 *
 * T10 (vrai modele Qwen2.5-Coder-1.5B) n'est joue QUE si P70_MODEL est defini :
 *   P70_MODEL=~/model.gguf node scripts/ci/p70-replay.js --model
 * Sans modele, T10 sort en SKIP explicite : jamais un faux vert.
 *
 * ASCII only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P70 = path.join(ROOT, 'sudo-agent', 'src', 'p70');
const fast = require(path.join(P70, 'fast.js'));
const verified = require(path.join(P70, 'verified.js'));
const edit = require(path.join(P70, 'edit.js'));
const env = require(path.join(P70, 'env.js'));

const rows = [];
function rec(id, ok, proof, extra) {
  rows.push({ id, ok, proof, extra: extra || null });
  console.log(id + ' ' + (ok ? 'PASS' : 'FAIL') + ' | ' + proof);
}
function ws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p70-replay-'));
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci-cd.yml'), 'name: ci\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'a supprimer\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"maquis-pos"}\n');
  fs.writeFileSync(path.join(dir, 'guide.md'), 'guide\n');
  return dir;
}
function turn(root, prompt, opts) {
  const t0 = Date.now();
  const r = fast.tryHandle(Object.assign({ prompt, root, sessionId: 'replay', home: root }, opts || {}));
  return { r, ms: Date.now() - t0 };
}

const root = ws();
// T1 : suppression reelle, <= 5 s, 0 appel modele
{
  const { r, ms } = turn(root, 'supprime le fichier notes.txt', { approve: true, confirmProtected: true });
  const gone = !fs.existsSync(path.join(root, 'notes.txt'));
  rec('T1', gone && ms <= 5000 && r.modelCalls === 0,
    'fichier absent=' + gone + ' temps=' + ms + 'ms modelCalls=' + r.modelCalls + ' statut=' + r.status);
}
// T2 : lecture d'un fichier reel
{
  const { r, ms } = turn(root, 'lis package.json');
  rec('T2', /maquis-pos/.test(r.text) && r.modelCalls === 0,
    'contenu reel=' + /maquis-pos/.test(r.text) + ' temps=' + ms + 'ms modelCalls=' + r.modelCalls);
}
// T3 : creation avec contenu fourni
{
  const { r, ms } = turn(root, 'cree le fichier docs/rapport.md avec: ligne un\nligne deux');
  const ok = fs.existsSync(path.join(root, 'docs', 'rapport.md'));
  rec('T3', ok && r.modelCalls === 0, 'fichier cree=' + ok + ' temps=' + ms + 'ms modelCalls=' + r.modelCalls);
}
// T4 : renommage
{
  const { r } = turn(root, 'renomme guide.md en guide-v2.md');
  const ok = fs.existsSync(path.join(root, 'guide-v2.md')) && !fs.existsSync(path.join(root, 'guide.md'));
  rec('T4', ok, 'ancien absent/nouveau present=' + ok + ' statut=' + r.status);
}
// T5 : liste
{
  const { r } = turn(root, 'liste le projet');
  rec('T5', /package\.json/.test(r.text) && r.modelCalls === 0, 'entrees listees=' + /package\.json/.test(r.text));
}
// T6 : refus -> le fichier reste
{
  const { r } = turn(root, 'supprime le fichier package.json');   // sans approve : EN_ATTENTE
  rec('T6', r.status === 'EN_ATTENTE' && fs.existsSync(path.join(root, 'package.json')),
    'sans accord statut=' + r.status + ' fichier intact=' + fs.existsSync(path.join(root, 'package.json')));
}
// T7 : "annule le run" restaure la derniere suppression
{
  turn(root, 'supprime le fichier package.json', { approve: true, confirmProtected: true });
  const absent = !fs.existsSync(path.join(root, 'package.json'));
  const { r } = turn(root, 'annule le run');
  const back = fs.existsSync(path.join(root, 'package.json'));
  rec('T7', absent && back, 'supprime=' + absent + ' restaure=' + back + ' statut=' + r.status);
}
// T8 : consigne composee -> la partie fichier d'abord, la suite ANNONCEE
{
  fs.writeFileSync(path.join(root, 'tmp.txt'), 'x\n');
  const a = turn(root, 'supprime tmp.txt puis lance l audit de securite');
  const asked = a.r.status === 'EN_ATTENTE';
  const b = turn(root, 'oui');
  const gone = !fs.existsSync(path.join(root, 'tmp.txt'));
  const rest = /audit/i.test(b.r.text);
  rec('T8', asked && gone && rest, 'approbation demandee=' + asked + ' supprime apres accord=' + gone +
    ' reste annonce=' + rest + ' statut final=' + b.r.status);
}
// T9 : un faux "done" du modele -> ECHEC + contradiction
{
  const v = verified.verifyClaims('Workflow GitHub supprime. Tache terminee.',
    { deleted: [], created: [], modified: [] });
  rec('T9', v.status === 'ECHEC' && /Le modele a annonce/.test(v.message),
    'statut=' + v.status + ' message=' + String(v.message).slice(0, 80));
}
// T9b : edition refusee quand l'intention est une suppression
{
  const g = edit.guardEdit({ file: '.github/workflows/ci-cd.yml', intentKind: 'delete' });
  rec('T9b', g.ok === false && g.code === 'intent_delete', 'refus=' + g.code);
}
// T10 : vrai modele (optionnel)
{
  if (process.env.P70_MODEL && fs.existsSync(process.env.P70_MODEL)) {
    const r = turn(root, 'supprime le fichier .github/workflows/ci-cd.yml', { approve: true, confirmProtected: true });
    const gone = !fs.existsSync(path.join(root, '.github', 'workflows', 'ci-cd.yml'));
    rec('T10', gone && r.modelCalls === 0,
      'VRAI MODELE present ; chemin rapide utilise, disque verifie=' + gone + ' modelCalls=' + r.modelCalls);
  } else {
    rows.push({ id: 'T10', ok: null, proof: 'SKIP : P70_MODEL non defini (vrai modele non disponible ici)' });
    console.log('T10 SKIP | vrai modele non fourni (P70_MODEL absent) - jamais compte comme un vert');
  }
}
// Rappel de l'environnement vu par l'agent (partie F)
const tools = env.resolveTools(['node', 'npm', 'git', 'python', 'python3', 'pip']);
console.log('');
console.log(env.journalLine(tools));
console.log('PATH de l agent (' + tools.basePath.split(process.platform === 'win32' ? ';' : ':').length + ' entrees)');

const hard = rows.filter((r) => r.ok === false);
const skipped = rows.filter((r) => r.ok === null);
console.log('');
console.log('P70 replay: ' + rows.filter((r) => r.ok === true).length + ' PASS, ' +
  hard.length + ' FAIL, ' + skipped.length + ' SKIP');
if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(process.cwd(), 'p70-replay.json'), JSON.stringify({ rows, path: tools.basePath, tools: tools.found, missing: tools.missing }, null, 2));
}
process.exit(hard.length ? 1 : 0);
