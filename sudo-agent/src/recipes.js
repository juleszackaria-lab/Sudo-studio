/**
 * SUDO AGENT - P55(4): recettes integrees (competences livrees avec le
 * produit, chargees A LA DEMANDE).
 *
 * Une recette est une marche a suivre courte et deterministe pour une tache
 * frequente. Elle n'est injectee dans le prompt QUE si la demande correspond
 * (mots-cles FR/EN) : aucun cout pour les autres tours. La detection de
 * framework rend la recette CONCRETE (dossier de tests, commande a lancer,
 * ThemeData en Dart, tailwind.config en JS...).
 *
 * Recettes livrees :
 *   add-tests         ajouter des tests et les lancer (Flutter/Next/Node)
 *   change-color      changer une couleur (CSS, Tailwind, theme Dart)
 *   add-page          ajouter une page ou un composant
 *   fix-test          reparer un test qui echoue
 *   rename-symbol     renommer un symbole dans tous les fichiers
 *   add-dependency    ajouter une dependance
 *
 * Stdlib only, ASCII only, aucune ecriture disque.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// -- detection de la pile ---------------------------------------------------
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}
function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }

/**
 * Detecte la pile du projet. Renvoie toujours un objet :
 *   { type: 'flutter'|'next'|'node'|'unknown', root, testDir, testCommand,
 *     testRunner, srcDir, notes: [] }
 * testCommand vaut null quand le projet n'a pas encore de lanceur de tests
 * (la recette doit alors l'installer ou l'annoncer).
 */
function detectStack(root) {
  const base = String(root || '.');
  const out = { type: 'unknown', root: base, testDir: 'test', testCommand: null,
    testRunner: '', srcDir: 'src', notes: [] };

  // Flutter / Dart
  const pubspec = readText(path.join(base, 'pubspec.yaml'));
  if (pubspec) {
    const m = /^name:\s*([A-Za-z0-9_]+)/m.exec(pubspec);
    out.type = 'flutter';
    out.testDir = 'test';
    out.testRunner = 'flutter_test';
    out.srcDir = 'lib';
    out.packageName = m ? m[1] : '';
    out.testCommand = 'flutter test';
    if (/dev_dependencies:[\s\S]*?flutter_test:/.test(pubspec)) {
      out.notes.push('flutter_test deja declare dans dev_dependencies');
    } else {
      out.notes.push('ajouter dev_dependencies: flutter_test: sdk: flutter');
    }
    if (exists(path.join(base, 'test'))) out.notes.push('dossier test/ existant');
    return out;
  }

  // Node / Next.js
  const pkg = readJson(path.join(base, 'package.json'));
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    const scripts = pkg.scripts || {};
    out.type = deps.next ? 'next' : 'node';
    out.packageName = pkg.name || '';
    out.srcDir = deps.next ? 'app' : (exists(path.join(base, 'src')) ? 'src' : '.');
    if (deps.next) {
      out.testDir = exists(path.join(base, '__tests__')) ? '__tests__'
        : (exists(path.join(base, 'tests')) ? 'tests' : '__tests__');
      const runner = deps.vitest ? 'vitest' : (deps.jest ? 'jest' : (deps.mocha ? 'mocha' : ''));
      out.testRunner = runner;
      if (runner) {
        out.testCommand = scripts.test ? 'npm test' : ('npx ' + runner);
      } else {
        out.testRunner = 'node-test';
        out.testDir = 'tests';
        out.testCommand = 'node --test';
        out.notes.push('aucun lanceur de tests : soit node --test (zero dependance), soit installer vitest');
      }
      out.notes.push('composants dans ' + out.srcDir + '/ , pages dans ' + out.srcDir + '/');
      return out;
    }
    // Node simple
    const runner2 = deps.vitest ? 'vitest' : (deps.jest ? 'jest' : (deps.mocha ? 'mocha' : 'node-test'));
    out.testRunner = runner2;
    out.testDir = exists(path.join(base, 'test')) ? 'test' : (exists(path.join(base, 'tests')) ? 'tests' : 'test');
    if (scripts.test && !/^echo|no test specified/i.test(String(scripts.test))) {
      out.testCommand = 'npm test';
      out.notes.push('script npm test existant : ' + String(scripts.test).slice(0, 80));
    } else if (runner2 === 'node-test') {
      out.testCommand = 'node --test';
      out.notes.push('aucun script test : utiliser node --test (aucune dependance)');
    } else {
      out.testCommand = 'npx ' + runner2;
    }
    if (pkg.type !== 'module') out.notes.push('CommonJS : require/module.exports (sauf indication contraire)');
    return out;
  }

  // Divers
  if (exists(path.join(base, 'index.html'))) {
    const html = readText(path.join(base, 'index.html'));
    if (/\btype="module"/.test(html)) out.notes.push('HTML + modules ES');
    out.type = 'static';
    out.srcDir = '.';
    return out;
  }
  return out;
}

// -- recettes ---------------------------------------------------------------
const RECIPES = [
  {
    id: 'add-tests',
    title: 'Ajouter des tests et les lancer',
    triggers: [/\btests?\b/i, /\btester\b/i, /\bcouvre\b/i, /\bspecs?\b/i, /\bunit test/i],
    steps: [
      'Constate : list/glob puis read des fichiers a couvrir (et de la config de test).',
      'Choisis le dossier et la convention du projet (dossier + suffixe ci-dessous).',
      'Ecris UN fichier de test par unite testee, avec des assertions reelles (pas de test vide).',
      'Si le lanceur manque, ajoute la dependance/le script necessaire (recette add-dependency).',
      'Lance la commande de test (bash) et rapporte la sortie reelle : nombre de tests, echecs.',
      'Termine par done avec le resume (fichiers crees + resultat de la commande).',
    ],
    verify: (st) => st.testCommand || 'installe un lanceur (node --test accepte sans dependance)',
  },
  {
    id: 'change-color',
    title: 'Changer une couleur',
    triggers: [/couleur/i, /\bcolor/i, /\btheme\b/i, /\bpalette\b/i, /\bbackground\b/i, /\bprimary\b/i],
    steps: [
      'Trouve TOUTES les occurrences : grep de la valeur actuelle (hex, rgb, nom, token).',
      'Selon la pile : variables CSS (:root), classes Tailwind, ThemeData/ColorScheme (Dart), theme JS/TS.',
      'Modifie chaque occurrence avec edit (une modification ciblee, pas de reecriture globale).',
      'Ne cree pas de doublon : si un token existe, change le token, pas chaque usage.',
      'Verifie avec un grep final que l ancienne valeur ne reste pas (hors tests/commentaires).',
      'Termine par done avec la liste des fichiers modifies et le diff resumme.',
    ],
    verify: () => 'grep de l ancienne valeur + relecture du diff',
  },
  {
    id: 'add-page',
    title: 'Ajouter une page ou un composant',
    triggers: [/\bpage\b/i, /\bcomposant/i, /\bcomponent\b/i, /\becran\b/i, /\bvue\b/i, /\broute\b/i],
    steps: [
      'Constante : la structure existante (list du dossier des pages/composants) et le style local.',
      'Cree le fichier au bon endroit, avec le nom demande, selon la convention du projet.',
      'Branche la navigation/le routeur si le projet en a un (route, lien, menu).',
      'Reutilise les composants et styles existants ; n invente pas un second systeme.',
      'Verifie : build/lint/tests disponibles (bash) et corrige ce qui casse.',
      'Termine par done avec les fichiers crees ou modifies.',
    ],
    verify: () => 'build/lint du projet',
  },
  {
    id: 'fix-test',
    title: 'Reparer un test qui echoue',
    // Priorite plus haute : "le test echoue" est plus precis que "ajoute des
    // tests", et doit gagner quand les deux familles de mots-cles matchent.
    priority: 2,
    triggers: [/test.*(echoue|echec|rouge|failing|fail)/i, /(echoue|echec|rouge).*test/i, /\bfix.*test/i],
    steps: [
      'Lance la commande de test et LIS la sortie (nom du test, message, pile).',
      'Ouvre le test ET le code teste ; identifie qui est faux (le test ou le code).',
      'Corrige la cause reelle, pas l assertion (sauf si le test est reellement obsolete).',
      'Relance la commande de test jusqu a un resultat vert ou une impasse expliquee.',
      'Termine par done avec la cause, le correctif et la sortie finale.',
    ],
    verify: (st) => st.testCommand || 'lanceur de tests a installer',
  },
  {
    id: 'rename-symbol',
    title: 'Renommer un symbole dans tous les fichiers',
    priority: 2,
    triggers: [/renomm/i, /\brename\b/i, /\brenomme\b/i],
    steps: [
      'grep du symbole exact (mot entier) : liste TOUS les fichiers d usage.',
      'Verifie les collisions : le nouveau nom existe-t-il deja ?',
      'Renomme la definition puis chaque usage, fichier par fichier (edit cible).',
      'Verifie : grep de l ancien nom (doit etre absent du code), puis build/tests.',
      'Termine par done avec le nombre d occurrences remplacees par fichier.',
    ],
    verify: () => 'grep ancien nom vide + build/tests',
  },
  {
    id: 'add-dependency',
    title: 'Ajouter une dependance',
    triggers: [/dependance/i, /\bdependency\b/i, /\bpackage\b/i, /\bnpm install\b/i, /\bpub add\b/i],
    steps: [
      'Lis le manifeste (package.json / pubspec.yaml) : gestionnaire, versions, style.',
      'Ajoute la dependance au bon endroit (dependencies vs devDependencies).',
      'Installe (npm install / flutter pub add) et rapporte la sortie reelle.',
      'Verifie que le projet demarre ou que les tests passent encore.',
      'Termine par done avec la version installee et tout avertissement.',
    ],
    verify: () => 'installation + tests/build',
  },
];

function list() {
  return RECIPES.map((r) => ({ id: r.id, title: r.title }));
}

function byId(id) {
  for (const r of RECIPES) if (r.id === id) return r;
  return null;
}

/** Recette correspondant a la demande, ou null. */
function match(prompt) {
  const p = String(prompt || '');
  if (!p.trim()) return null;
  let best = null;
  let bestScore = 0;
  for (const r of RECIPES) {
    let score = 0;
    for (const re of r.triggers) {
      if (re.test(p)) score += 1;
    }
    // Le nombre de familles de mots-cles departage ; a egalite, la recette la
    // plus specifique (priorite) l emporte : "le test echoue" > "ajoute des tests".
    const priority = r.priority || 1;
    if (score > 0 && best && score === bestScore && priority > (best.priority || 1)) { best = r; continue; }
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function stackLines(st) {
  const L = [];
  L.push('pile detectee : ' + st.type + (st.packageName ? ' (' + st.packageName + ')' : ''));
  L.push('dossier de tests : ' + st.testDir);
  L.push('lanceur : ' + (st.testRunner || 'aucun'));
  L.push('commande de test : ' + (st.testCommand || 'AUCUNE (a installer avant de lancer)'));
  L.push('sources : ' + st.srcDir);
  for (const n of (st.notes || [])) L.push('note : ' + n);
  return L;
}

/**
 * Rend la recette prete a injecter. `root` sert a la detection.
 * Renvoie { id, title, text } ou null si aucune recette ne correspond.
 */
function render(idOrPrompt, root) {
  const rec = byId(idOrPrompt) || match(idOrPrompt);
  if (!rec) return null;
  const st = detectStack(root);
  const lines = [];
  lines.push('RECETTE ' + rec.id + ' : ' + rec.title);
  lines.push.apply(lines, stackLines(st));
  lines.push('Marche a suivre (respecte-la, elle vient du produit) :');
  rec.steps.forEach((s, i) => lines.push((i + 1) + '. ' + s));
  lines.push('Verification attendue : ' + String(rec.verify(st)));
  lines.push('Regles : un appel d outil a la fois, chemins relatifs au projet, aucune affirmation sans sortie reelle.');
  return { id: rec.id, title: rec.title, stack: st, text: lines.join('\n') };
}

/** Texte a injecter pour une demande (vide si aucune recette ne correspond). */
function promptText(prompt, root, opts) {
  const o = opts || {};
  if (o.disabled) return '';
  const r = render(prompt, root);
  if (!r) return '';
  const cap = o.maxChars || 1400;
  return r.text.slice(0, cap);
}

module.exports = { RECIPES, list, byId, match, render, promptText, detectStack };
