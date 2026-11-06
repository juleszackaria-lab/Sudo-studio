/**
 * test-p55-recipes.js - P55(4): recettes integrees et detection de framework.
 *
 * Verifie, sans reseau ni modele :
 *   - la detection de pile sur trois copies de projet (Flutter, Next.js, Node) ;
 *   - la selection de la bonne recette pour des demandes reelles (FR/EN) ;
 *   - le contenu injecte (dossier de tests, commande de test, marches a suivre) ;
 *   - l absence d injection quand aucune recette ne correspond.
 *
 * Usage : node scripts/ci/test-p55-recipes.js
 * Sortie : une ligne PASS/FAIL par controle + un total. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const recipes = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'recipes.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('PASS ' + name); }
    else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 240)); }
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function write(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}

// -- trois copies de projet -------------------------------------------------
const flutter = tmp('p55-flutter');
write(flutter, 'pubspec.yaml', 'name: demo_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n');
write(flutter, 'lib/main.dart', 'void main() {}\n');

const next = tmp('p55-next');
write(next, 'package.json', JSON.stringify({ name: 'site', dependencies: { next: '14.0.0', react: '18.0.0' }, devDependencies: { jest: '29.0.0' }, scripts: { test: 'jest' } }, null, 2));
write(next, 'app/page.tsx', 'export default function Page() { return null; }\n');

const nodeP = tmp('p55-node');
write(nodeP, 'package.json', JSON.stringify({ name: 'lib', dependencies: {}, scripts: {} }, null, 2));
write(nodeP, 'index.js', 'module.exports = { add: (a, b) => a + b };\n');

// 1. detection
const stF = recipes.detectStack(flutter);
check('detection Flutter', stF.type === 'flutter' && stF.testDir === 'test' && stF.testCommand === 'flutter test'
    && stF.srcDir === 'lib', stF);
const stN = recipes.detectStack(next);
check('detection Next.js', stN.type === 'next' && stN.testRunner === 'jest' && stN.testCommand === 'npm test', stN);
const stJ = recipes.detectStack(nodeP);
check('detection Node sans lanceur', stJ.type === 'node' && stJ.testRunner === 'node-test'
    && stJ.testCommand === 'node --test' && /CommonJS/.test(stJ.notes.join(' ')), stJ);

// 2. selection de recette
check('recette tests (FR)', (recipes.match('Ajoute des tests au projet et lance-les') || {}).id === 'add-tests');
check('recette couleur', (recipes.match('change la couleur principale en vert') || {}).id === 'change-color');
check('recette page', (recipes.match('ajoute une page A propos') || {}).id === 'add-page');
check('recette test qui echoue', (recipes.match('le test de login echoue, repare-le') || {}).id === 'fix-test');
check('recette renommage', (recipes.match('renomme getUser en fetchUser partout') || {}).id === 'rename-symbol');
check('recette dependance', (recipes.match('ajoute la dependance dayjs') || {}).id === 'add-dependency');
check('aucune recette pour une demande libre', recipes.match('explique ce que fait ce depot') === null,
    (recipes.match('explique ce que fait ce depot') || {}).id);

// 3. contenu injecte
const tF = recipes.promptText('Ajoute des tests au projet et lance-les', flutter);
check('texte Flutter : dossier + commande', /dossier de tests : test/.test(tF) && /flutter test/.test(tF)
    && /RECETTE add-tests/.test(tF), tF.slice(0, 200));
const tN = recipes.promptText('Ajoute des tests au projet et lance-les', next);
check('texte Next : dossier + commande', /npm test/.test(tN) && /RECETTE add-tests/.test(tN), tN.slice(0, 200));
const tC = recipes.promptText('change la couleur principale en vert', nodeP);
check('texte couleur : occurrences + verification', /grep de la valeur actuelle/.test(tC)
    && /RECETTE change-color/.test(tC), tC.slice(0, 200));
check('injection vide sans recette', recipes.promptText('explique ce depot', nodeP) === '');
check('injection bornee', recipes.promptText('Ajoute des tests', flutter, { maxChars: 120 }).length <= 120);

// 4. inventaire
const inv = recipes.list();
check('six recettes livrees', inv.length === 6 && inv.map((r) => r.id).sort().join(',')
    === 'add-dependency,add-page,add-tests,change-color,fix-test,rename-symbol', inv);

console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
try { fs.rmSync(flutter, { recursive: true, force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(next, { recursive: true, force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(nodeP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(fail ? 1 : 0);
