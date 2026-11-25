#!/usr/bin/env node
/**
 * SUDO STUDIO - P70 : chemin rapide SANS MODELE pour les operations de base.
 *
 * Ce que cette suite prouve, sans modele et sans runtime :
 *   W1..W2  le parseur FR/EN (fautes de frappe comprises) et le refus de deviner ;
 *   W3      le resolveur : casse, separateurs, UNIQUE, ".github" != ".git" ;
 *   W4      T1 supprimer : approbation, 0 appel modele, verification disque, < 5 s ;
 *   W5      T2 dossier + "annule le run" restaure ;
 *   W6      T3 lire / T4 creer / T5 renommer ;
 *   W7      T6 consigne composee : la partie fichier est faite, l'audit n'est
 *           PAS traite par le chemin rapide ;
 *   W8      controles negatifs : sans execution, un "c'est supprime" est REFUSE.
 *
 * Lancer : node backend/tests/test-p70-fastpath.js
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const P70 = path.join(ROOT, 'sudo-agent', 'src', 'p70');
const intent = require(path.join(P70, 'intent.js'));
const paths = require(path.join(P70, 'paths.js'));
const ops = require(path.join(P70, 'ops.js'));
const fast = require(path.join(P70, 'fast.js'));
const verified = require(path.join(P70, 'verified.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// --- projet de test, comme un vrai projet Next.js
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p70-fastpad-'));
function mk(rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content === undefined ? 'x\n' : content);
}
mk('.github/workflows/ci-cd.yml', 'name: ci\non: push\n');
mk('docs/note.md', '# note\n');
mk('docs/deep/guide.md', '# guide\n');
mk('app/page.js', 'export default function Page(){return null}\n');
mk('package.json', '{"name":"maquis-pos"}\n');
mk('.git/config', '[core]\n');   // P70-B6 : ".git" est protege, ".github" non
mk('dossier/sous/a.txt', 'a\n');
mk('dossier/sous/b.txt', 'b\n');
mk('dossier/sous/c.txt', 'c\n');
const SID = 'sess-p70';

// ============================================================== W1 parseur
const p1 = intent.parse('supprime le fichier .github/workflows/ci-cd.yml');
check('W1a consigne FR de suppression -> op delete + cible',
  p1.kind === 'file-op' && p1.op === 'delete' && /ci-cd\.yml$/.test(p1.target || ''),
  JSON.stringify(p1));
const p2 = intent.parse('efface docs/note.md');
check('W1b synonyme "efface" -> delete', p2.kind === 'file-op' && p2.op === 'delete', JSON.stringify(p2));
const p3 = intent.parse('delete the file app/page.js');
check('W1c consigne EN "delete" -> delete', p3.kind === 'file-op' && p3.op === 'delete', JSON.stringify(p3));
const p4 = intent.parse('supirme docs/note.md');
check('W1d faute de frappe "supirme" -> delete (1 faute toleree)', p4.kind === 'file-op' && p4.op === 'delete', JSON.stringify(p4));
const p5 = intent.parse('supprime le fichier ou dossier github');
check('W1e "le fichier ou dossier github" -> cible "github"', p5.kind === 'file-op' && p5.target === 'github', JSON.stringify(p5));
const p6 = intent.parse('Va voir le resultat du Security Audit et corrige les failles trouvees.');
check('W1f CONTROLE NEGATIF : une demande d audit n est PAS une operation de fichier',
  p6.kind === 'complex', JSON.stringify(p6));
const p7 = intent.parse('supprime docs/note.md puis lance l audit de securite');
check('W1g consigne composee -> 2 sous-taches ordonnees', p7.kind === 'composed' && p7.parts.length === 2, JSON.stringify(p7.kind));
check('W1h la 1re sous-tache est la suppression, dans l ordre',
  p7.parts[0].kind === 'file-op' && p7.parts[0].op === 'delete' && /note\.md/.test(p7.parts[0].target), JSON.stringify(p7.parts[0]));

// ============================================================== W3 chemins
const r1 = paths.resolve(root, 'DOCS/NOTE.MD');
check('W3a insensible a la casse + chemin relatif', r1.ok && r1.rel === 'docs/note.md', JSON.stringify(r1));
const r2 = paths.resolve(root, '.github\\workflows\\ci-cd.yml');
check('W3b separateurs Windows acceptes', r2.ok && r2.rel === '.github/workflows/ci-cd.yml', JSON.stringify(r2));
check('W3c ".github" est une cible NORMALE (pas protegee)',
  r2.ok && paths.classify(r2.rel, root) === 'project', JSON.stringify(r2.cls));
check('W3d ".git" EST protege (segment entier, pas prefixe)',
  paths.classify('.git/config', root) === 'protected');
// un SECOND guide.md : la cible devient ambigue, et on doit le DIRE
fs.mkdirSync(path.join(root, 'autre'), { recursive: true });
fs.writeFileSync(path.join(root, 'autre/guide.md'), 'y\n');
const amb2 = paths.resolve(root, 'guide.md');
check('W3e plusieurs candidats -> on DEMANDE (aucune approximation)',
  !amb2.ok && amb2.reason === 'ambiguous' && amb2.candidates.length >= 2, JSON.stringify(amb2).slice(0, 200));
const absent = paths.resolve(root, 'docs/noteee.md');
check('W3f cible absente -> suggestions, jamais choisie a la place',
  !absent.ok && absent.reason === 'absent' && (absent.suggestions || []).length >= 1,
  JSON.stringify(absent).slice(0, 200));

// ============================================================== W4 T1 supprimer
let t0 = Date.now();
const d0 = fast.tryHandle({ prompt: 'supprime le fichier .github/workflows/ci-cd.yml', root, home: root, sessionId: SID });
check('W4a sans accord : approbation affichee, RIEN nest supprime',
  d0.handled && d0.status === 'EN_ATTENTE' && fs.existsSync(path.join(root, '.github/workflows/ci-cd.yml')),
  d0.text.slice(0, 120));
const d1 = fast.tryHandle({ prompt: 'oui', root, home: root, sessionId: SID });
const ms1 = Date.now() - t0;
check('W4b apres accord : le fichier nest PLUS sur le disque (verifie)',
  d1.status === 'TERMINE' && !fs.existsSync(path.join(root, '.github/workflows/ci-cd.yml')), d1.text.slice(0, 120));
check('W4c 0 appel modele', d1.modelCalls === 0, String(d1.modelCalls));
check('W4d 5 s ou moins hors approbation', ms1 <= 5000, ms1 + ' ms');
check('W4e le rapport nomme le fichier et la verification',
  /Supprime|supprime/.test(d1.text) && /disque/.test(d1.text), d1.text.slice(0, 120));

// ============================================================== W5 T2 dossier + annulation
const d2 = fast.tryHandle({ prompt: 'supprime le dossier dossier/sous', root, home: root, sessionId: SID });
check('W5a un dossier annonce le NOMBRE de fichiers avant de supprimer',
  d2.status === 'EN_ATTENTE' && /3 fichier/.test(d2.text), d2.text.slice(0, 140));
const d3 = fast.tryHandle({ prompt: 'oui', root, home: root, sessionId: SID });
check('W5b le dossier est bien absent apres execution',
  d3.status === 'TERMINE' && !fs.existsSync(path.join(root, 'dossier/sous')), d3.text.slice(0, 120));
const d4 = fast.tryHandle({ prompt: 'annule le run', root, home: root, sessionId: SID });
check('W5c "annule le run" restaure la cible (point de retour)',
  d4.status === 'TERMINE' && fs.existsSync(path.join(root, 'dossier/sous/a.txt')), d4.text.slice(0, 120));
const d5 = fast.tryHandle({ prompt: 'annule le run', root, home: root, sessionId: 'autre-session' });
check('W5d CONTROLE NEGATIF : sans point de retour, on refuse de pretendre avoir restaure',
  d5.status === 'ECHEC' && /Aucun point de retour/.test(d5.text), d5.text.slice(0, 100));

// ============================================================== W6 lire / creer / renommer
const rd = fast.tryHandle({ prompt: 'lis docs/note.md', root, home: root, sessionId: SID });
check('W6a T3 lire un fichier affiche son contenu reel',
  rd.status === 'TERMINE' && /# note/.test(rd.text), rd.text.slice(0, 80));
const cr = fast.tryHandle({ prompt: 'cree un fichier docs/nouveau.md avec: bonjour maquis', root, home: root, sessionId: SID });
check('W6b T4 creer un fichier ecrit le contenu fourni (pas invente)',
  cr.status === 'TERMINE' && fs.readFileSync(path.join(root, 'docs/nouveau.md'), 'utf8').indexOf('bonjour maquis') >= 0,
  cr.text.slice(0, 100));
const cr2 = fast.tryHandle({ prompt: 'cree un fichier docs/vide.md', root, home: root, sessionId: SID });
check('W6c CONTROLE NEGATIF : sans contenu, on DEMANDE (on n invente pas)',
  cr2.status === 'EN_ATTENTE' && !fs.existsSync(path.join(root, 'docs/vide.md')), cr2.text.slice(0, 100));
const rn = fast.tryHandle({ prompt: 'renomme docs/note.md en docs/note-2.md', root, home: root, sessionId: SID });
check('W6d T5 renommer : ancien absent, nouveau present',
  rn.status === 'TERMINE' && !fs.existsSync(path.join(root, 'docs/note.md')) &&
  fs.existsSync(path.join(root, 'docs/note-2.md')), rn.text.slice(0, 100));

// ============================================================== W7 T6 composee
fs.writeFileSync(path.join(root, 'docs/note-2.md'), '# note\n');
const comp = fast.tryHandle({
  prompt: 'supprime docs/note-2.md puis lance l audit de securite', root, home: root, sessionId: SID,
});
const compAfterOk = (comp.status === 'EN_ATTENTE')
  ? fast.tryHandle({ prompt: 'oui', root, home: root, sessionId: SID })
  : comp;
check('W7a la partie fichier de la consigne composee est traitee',
  !fs.existsSync(path.join(root, 'docs/note-2.md')) && /audit/i.test(compAfterOk.text + comp.text), (compAfterOk.text || '').slice(0, 140));
check('W7b l audit nest PAS traite par le chemin rapide (0 appel modele pour la partie fichier)',
  (comp.modelCalls === 0) && (compAfterOk.status === 'PARTIEL' || compAfterOk.status === 'EN_ATTENTE' || compAfterOk.handled === false),
  'status=' + compAfterOk.status + ' calls=' + compAfterOk.modelCalls);

// ============================================================== W8 controles negatifs
const fake = verified.verifyClaims('Workflow GitHub supprime. Tache terminee.', { deleted: [], created: [], modified: [] });
check('W8a un faux "c est supprime" sans fait disque -> ECHEC + contradiction',
  fake.ok === false && fake.status === 'ECHEC' && /Le modele a annonce/.test(fake.message) && /aucun fichier n/.test(fake.message),
  fake.message.slice(0, 160));
const truth = verified.verifyClaims('Fichier supprime.', { deleted: ['x'], created: [], modified: [] });
check('W8b CONTROLE POSITIF : la meme phrase avec un fait disque passe', truth.ok === true, JSON.stringify(truth));
const noExec = ops.remove(path.join(root, 'docs/nouveau.md'), 'docs/nouveau.md', { approve: false, cls: 'project' });
check('W8c sans approbation explicite, ops.remove ne supprime rien',
  noExec.code === 'needs_approval' && fs.existsSync(path.join(root, 'docs/nouveau.md')), JSON.stringify(noExec.code));
const prot = fast.tryHandle({ prompt: 'supprime .git/config', root, home: root, sessionId: SID });
check('W8d ".git" exige une confirmation distincte (cible protegee)',
  prot.status === 'EN_ATTENTE' && /protegee/.test(prot.text), prot.text.slice(0, 120));

console.log('');
if (failures.length === 0) {
  console.log('P70 chemin rapide sans modele: ' + pass + ' checks passed (all green)');
  process.exit(0);
}
console.log('P70 chemin rapide sans modele: ' + pass + ' checks passed, ' + failures.length + ' FAILED');
failures.forEach((f) => console.log('  - ' + f));
process.exit(1);
