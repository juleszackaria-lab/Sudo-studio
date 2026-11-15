/**
 * SUDO STUDIO - P65 partie C: BANC D'ESSAI DE L'AGENT (agent-bench).
 *
 * Mesure le MOTEUR (sudo-agent), pas le modele : chaque tache fournit un
 * scenario deterministe au faux fournisseur, et la reussite est verifiee
 * AUTOMATIQUEMENT sur le disque (fichiers attendus, contenu, syntaxe, tests
 * reellement lances, git status). Aucune note donnee par le modele n'est
 * acceptee comme preuve.
 *
 * Trois projets d'essai sont construits a la volee : Next.js, Flutter, Python.
 *
 * Ce que le banc mesure ici, en CI, avec le FAUX fournisseur :
 *   - taux de reussite par categorie, nombre de tours, appels modele, duree,
 *     pic RSS du processus de banc, profil de capacite applique.
 * Ce qu'il ne peut PAS mesurer ici (a faire sur un PC, script fourni) :
 *   - jetons/seconde reels, RAM du runtime modele, qualite d'un vrai modele.
 *     Ces colonnes sont ecrites "NON MESURE ICI" : jamais un chiffre invente.
 *
 *   node scripts/ci/agent-bench.js [--json <fichier>] [--only <prefixe>]
 *
 * ASCII only. Stdlib only (node + python3 pour les tests Python).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createWorld, call, text } = require('../../backend/tests/lib/agentHarness');
const AGENT_SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const providers = require(path.join(AGENT_SRC, 'providers.js'));
const pmap = require('../../sudo-agent/src/projectmap');

const ROOT = path.join(__dirname, '..', '..');
const OUT_JSON = (() => {
  const i = process.argv.indexOf('--json');
  return i !== -1 ? process.argv[i + 1] : path.join(ROOT, 'bench-results', 'agent-bench-report.json');
})();
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i !== -1 ? process.argv[i + 1] : '';
})();
// Mode REEL (PC seulement) : --real <url OpenAI-compatible> --model <id>.
// Sans ces options, le banc tourne avec le faux fournisseur (CI).
const REAL_URL = (() => {
  const i = process.argv.indexOf('--real');
  return i !== -1 ? process.argv[i + 1] : '';
})();
const REAL_MODEL = (() => {
  const i = process.argv.indexOf('--model');
  return i !== -1 ? process.argv[i + 1] : '';
})();
const IS_REAL = !!REAL_URL;

// ---------------------------------------------------------------------------
// Projets d'essai (fixtures reelles sur disque)
// ---------------------------------------------------------------------------
const PROJETS = {
  next: {
    'package.json': JSON.stringify({
      name: 'bench-next', version: '1.0.0', private: true,
      scripts: { dev: 'next dev', build: 'next build', test: 'node --test' },
      dependencies: { next: '14.2.0', react: '18.3.1', 'react-dom': '18.3.1' },
    }, null, 2) + '\n',
    'app/page.jsx': "export default function Page() {\n  return <main className=\"page\">Bonjour</main>;\n}\n",
    'app/globals.css': ":root { --accent: #1f6feb; }\n.page { color: #111; }\n",
    'components/Bouton.jsx': "export default function Bouton(props) {\n  return <button className=\"btn\">{props.label}</button>;\n}\n",
    'lib/format.js': "function formatPrix(v) {\n  return v.toFixed(2) + ' EUR';\n}\nmodule.exports = { formatPrix };\n",
    'README.md': '# bench-next\n\nPetit projet Next.js de banc d essai.\n',
  },
  flutter: {
    'pubspec.yaml': 'name: bench_flutter\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n',
    'lib/main.dart': "import 'package:flutter/material.dart';\nvoid main() => runApp(const App());\nclass App extends StatelessWidget {\n  const App({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return const MaterialApp(home: Home());\n  }\n}\nclass Home extends StatelessWidget {\n  const Home({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return const Scaffold(body: Center(child: Text('Bonjour')));\n  }\n}\n",
    'lib/theme.dart': "const Color accent = Color(0xFF1F6FEB);\n",
    'test/widget_test.dart': "import 'package:flutter_test/flutter_test.dart';\nimport 'package:bench_flutter/main.dart';\nvoid main() {\n  testWidgets('affiche Bonjour', (tester) async {\n    await tester.pumpWidget(const App());\n    expect(find.text('Bonjour'), findsOneWidget);\n  });\n}\n",
    'README.md': '# bench_flutter\n\nProjet Flutter de banc d essai.\n',
  },
  python: {
    'requirements.txt': 'pyyaml==6.0.1\n',
    'app/__init__.py': '',
    'app/calc.py': "def somme(a, b):\n    return a + b\n\n\ndef moyenne(valeurs):\n    return sum(valeurs) / len(valeurs)\n",
    'app/utils.py': "def normaliser(texte):\n    return texte.strip().lower()\n",
    'tests/__init__.py': '',
    'tests/test_calc.py': "import unittest\n\nfrom app.calc import moyenne, somme\n\n\nclass TestCalc(unittest.TestCase):\n    def test_somme(self):\n        self.assertEqual(somme(2, 298), 300)\n\n    def test_moyenne(self):\n        self.assertEqual(moyenne([2, 4]), 3)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
    'README.md': '# bench-python\n\nProjet Python de banc d essai.\n',
  },
};

// Verifications automatiques reutilisables -----------------------------------
function vFile(w, rel) {
  return { check: 'fichier ' + rel + ' present', ok: w.exists(rel), detail: '' };
}
function vContains(w, rel, needle) {
  const c = w.read(rel);
  return { check: rel + ' contient ' + JSON.stringify(needle), ok: !!(c && c.indexOf(needle) !== -1),
    detail: c ? '' : 'fichier absent' };
}
function vAbsent(w, rel) {
  return { check: rel + ' absent', ok: !w.exists(rel), detail: '' };
}
function vNodeSyntax(w, rel) {
  const full = path.join(w.proj, rel);
  if (!fs.existsSync(full)) return { check: 'syntaxe JS ' + rel, ok: false, detail: 'absent' };
  try { execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' }); return { check: 'syntaxe JS ' + rel, ok: true, detail: '' }; }
  catch (e) { return { check: 'syntaxe JS ' + rel, ok: false, detail: String(e.stderr || e.message).slice(0, 200) }; }
}
function vPyCompile(w, rel) {
  const full = path.join(w.proj, rel);
  if (!fs.existsSync(full)) return { check: 'syntaxe Python ' + rel, ok: false, detail: 'absent' };
  try { execFileSync('python3', ['-m', 'py_compile', full], { stdio: 'pipe' }); return { check: 'syntaxe Python ' + rel, ok: true, detail: '' }; }
  catch (e) { return { check: 'syntaxe Python ' + rel, ok: false, detail: String(e.stderr || e.message).slice(0, 200) }; }
}
function vPyTests(w) {
  try {
    execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], { cwd: w.proj, stdio: 'pipe', timeout: 60000 });
    return { check: 'tests Python passent', ok: true, detail: '' };
  } catch (e) {
    return { check: 'tests Python passent', ok: false, detail: String(e.stderr || e.stdout || e.message).slice(0, 300) };
  }
}
function vGitDirty(w, rel) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: w.proj, stdio: 'pipe' }).toString();
    return { check: 'git status mentionne ' + rel, ok: out.indexOf(rel) !== -1, detail: out.slice(0, 200) };
  } catch (e) { return { check: 'git status disponible', ok: false, detail: String(e.message).slice(0, 120) }; }
}
function vGitClean(w) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: w.proj, stdio: 'pipe' }).toString().trim();
    return { check: 'aucune modification non voulue (git status vide)', ok: out === '', detail: out.slice(0, 200) };
  } catch (e) { return { check: 'git status disponible', ok: false, detail: String(e.message).slice(0, 120) }; }
}
function vNoFile(w, rel) { return { check: '.git/' + rel + ' intact', ok: w.exists('.git/' + rel), detail: '' }; }

// Specs de longueur imposee (20 / 60 / 300 lignes) ---------------------------
function specLines(n, theme) {
  const lines = [];
  lines.push('Cahier des charges : ' + theme);
  lines.push('Objectif : produire une petite application de demonstration.');
  for (let i = 3; i <= n; i++) {
    if (i % 10 === 1) lines.push('Section ' + Math.ceil(i / 10) + ' : exigence fonctionnelle.');
    else if (i % 10 === 5) lines.push('- contrainte ' + i + ' : le comportement doit etre deterministe et documente.');
    else lines.push('Exigence ' + i + ' : le livrable doit satisfaire le point ' + i + ' du cahier.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Taches. cat: structure|modification|tests|generation|robustesse|questions|outils
// ---------------------------------------------------------------------------
function tasks() {
  const T = [];
  const plan = { maxIt: 8, waitMs: 20000 };

  // --- structure (3) ---
  T.push({ id: 'S1', cat: 'structure', project: 'next', prompt: 'explique la structure du projet',
    script: [text('Projet Next.js : app/page.jsx est la page, components/Bouton.jsx un composant, lib/format.js une fonction.')],
    verify: (w) => [vFile(w, 'app/page.jsx'), vFile(w, 'components/Bouton.jsx')] });
  T.push({ id: 'S2', cat: 'structure', project: 'python', prompt: 'explique la structure du projet',
    script: [text('Projet Python : app/calc.py contient somme et moyenne, tests/test_calc.py les teste.')],
    verify: (w) => [vFile(w, 'app/calc.py'), vPyCompile(w, 'app/calc.py')] });
  T.push({ id: 'S3', cat: 'structure', project: 'flutter', prompt: 'explique la structure du projet',
    script: [text('Projet Flutter : lib/main.dart contient App et Home (StatelessWidget).')],
    verify: (w) => [vFile(w, 'lib/main.dart'), vContains(w, 'lib/main.dart', 'class Home')] });

  // --- modification (6) ---
  T.push({ id: 'M1', cat: 'modification', project: 'flutter', prompt: 'change la couleur d accent en rouge',
    script: [call('read', { file: 'lib/theme.dart' }),
      call('edit', { file: 'lib/theme.dart', old: '0xFF1F6FEB', new: '0xFFE53935' }),
      call('done', { summary: 'couleur changee' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'lib/theme.dart', '0xFFE53935')] });
  T.push({ id: 'M2', cat: 'modification', project: 'python', prompt: 'renomme la fonction normaliser en nettoyer',
    script: [call('read', { file: 'app/utils.py' }),
      call('edit', { file: 'app/utils.py', old: 'def normaliser(texte):', new: 'def nettoyer(texte):' }),
      call('done', { summary: 'renommee' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'app/utils.py', 'def nettoyer('), vPyCompile(w, 'app/utils.py')] });
  T.push({ id: 'M3', cat: 'modification', project: 'next', prompt: 'cree le fichier lib/constantes.js',
    script: [call('write', { file: 'lib/constantes.js', content: "const TVA = 0.18;\nmodule.exports = { TVA };\n" }),
      call('done', { summary: 'cree' })],
    approve: 'session',
    verify: (w) => [vFile(w, 'lib/constantes.js'), vNodeSyntax(w, 'lib/constantes.js')] });
  T.push({ id: 'M4', cat: 'modification', project: 'next', prompt: 'ajoute un commentaire en tete de lib/format.js',
    script: [call('read', { file: 'lib/format.js' }),
      call('edit', { file: 'lib/format.js', old: 'function formatPrix(v) {', new: '// formate un prix en euros\nfunction formatPrix(v) {' }),
      call('done', { summary: 'commentaire ajoute' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'lib/format.js', '// formate un prix en euros'), vNodeSyntax(w, 'lib/format.js')] });
  T.push({ id: 'M5', cat: 'modification', project: 'python', prompt: 'ajoute une fonction carre dans app/calc.py',
    script: [call('read', { file: 'app/calc.py' }),
      call('append', { file: 'app/calc.py', content: '\n\ndef carre(x):\n    return x * x\n' }),
      call('done', { summary: 'carre ajoutee' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'app/calc.py', 'def carre('), vPyCompile(w, 'app/calc.py')] });
  T.push({ id: 'M6', cat: 'modification', project: 'next', prompt: 'change le texte Bonjour en Bonjour Sudo',
    script: [call('read', { file: 'app/page.jsx' }),
      call('edit', { file: 'app/page.jsx', old: '>Bonjour<', new: '>Bonjour Sudo<' }),
      call('done', { summary: 'texte change' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'app/page.jsx', 'Bonjour Sudo')] });

  // --- tests (4) ---
  T.push({ id: 'T1', cat: 'tests', project: 'python', prompt: 'ajoute un test pour la fonction carre',
    script: [call('read', { file: 'app/calc.py' }),
      call('append', { file: 'app/calc.py', content: '\n\ndef carre(x):\n    return x * x\n' }),
      call('read', { file: 'tests/test_calc.py' }),
      call('append', { file: 'tests/test_calc.py', content: '\n    def test_carre(self):\n        from app.calc import carre\n        self.assertEqual(carre(3), 9)\n' }),
      call('done', { summary: 'test ajoute' })],
    approve: 'session',
    verify: (w) => [vContains(w, 'tests/test_calc.py', 'test_carre'), vPyTests(w)] });
  T.push({ id: 'T2', cat: 'tests', project: 'python', prompt: 'le test moyenne echoue, corrige le code',
    setup: [{ file: 'app/calc.py', content: "def somme(a, b):\n    return a + b\n\n\ndef moyenne(valeurs):\n    return sum(valeurs)\n" }],
    script: [call('read', { file: 'app/calc.py' }),
      call('edit', { file: 'app/calc.py', old: 'return sum(valeurs)', new: 'return sum(valeurs) / len(valeurs)' }),
      call('done', { summary: 'corrige' })],
    approve: 'session',
    verify: (w) => [vPyTests(w)] });
  T.push({ id: 'T3', cat: 'tests', project: 'python', prompt: 'lance les tests',
    script: [call('bash', { command: 'python3 -m unittest discover -s tests -t .' }),
      call('done', { summary: 'tests lances' })],
    approve: 'session',
    verify: (w) => { const t = vPyTests(w); return [t]; } });
  T.push({ id: 'T4', cat: 'tests', project: 'next', prompt: 'ajoute un test node pour formatPrix',
    script: [call('write', { file: 'tests/format.test.js', content:
      "const test = require('node:test');\nconst assert = require('assert');\nconst { formatPrix } = require('../lib/format');\n\ntest('formatPrix', () => {\n  assert.strictEqual(formatPrix(1.5), '1.50 EUR');\n});\n" }),
      call('done', { summary: 'test cree' })],
    approve: 'session',
    verify: (w) => [vFile(w, 'tests/format.test.js'), vNodeSyntax(w, 'tests/format.test.js'),
      { check: 'test node passent', ok: (() => { try {
        execFileSync(process.execPath, ['--test', 'tests/format.test.js'], { cwd: w.proj, stdio: 'pipe', timeout: 60000 }); return true;
      } catch (_) { return false; } })(), detail: '' }] });

  // --- generation (3) : cahiers de 20, 60 et 300 lignes ---
  // Au-dela d'un seuil, le cahier des charges est un PROJET (P56) : le premier
  // tour rend un plan et attend "lancer". La tache enchaine donc deux tours,
  // exactement comme l'utilisateur. Les petits cahiers tiennent en un tour.
  const gens = [['G1', 20, false], ['G2', 60, true], ['G3', 300, true]];
  for (const [id, n, twoTurns] of gens) {
    T.push({
      id, cat: 'generation', project: 'python', long: n,
      prompt: specLines(n, 'application de conversion de devises (' + n + ' lignes)'),
      script: [call('write', { file: 'app/conv.py', content: 'def convertir(montant, taux):\n    return round(montant * taux, 2)\n' }),
        call('write', { file: 'app/cli.py', content: "from app.conv import convertir\n\n\ndef main():\n    print(convertir(10, 655.957))\n" }),
        call('done', { summary: 'application generee' })],
      after: twoTurns ? { prompt: 'lancer',
        script: [call('write', { file: 'app/conv.py', content: 'def convertir(montant, taux):\n    return round(montant * taux, 2)\n' }),
          call('write', { file: 'app/cli.py', content: "from app.conv import convertir\n\n\ndef main():\n    print(convertir(10, 655.957))\n" }),
          call('done', { summary: 'application generee' })] } : null,
      approve: 'session',
      verify: (w) => [vFile(w, 'app/conv.py'), vFile(w, 'app/cli.py'), vPyCompile(w, 'app/conv.py')],
    });
  }

  // --- robustesse (6) ---
  T.push({ id: 'R1', cat: 'robustesse', project: 'next', prompt: 'supprime le fichier lib/format.js',
    script: [call('read', { file: 'lib/format.js' }),
      call('delete', { file: 'lib/format.js' }),
      call('done', { summary: 'supprime' })],
    approve: 'session',
    verify: (w) => [vAbsent(w, 'lib/format.js'), vGitDirty(w, 'lib/format.js')] });
  T.push({ id: 'R2', cat: 'robustesse', project: 'next', prompt: 'supprime le fichier lib/format.js',
    script: [call('read', { file: 'lib/format.js' }),
      call('delete', { file: 'lib/format.js' }),
      call('done', { summary: 'supprime' })],
    approve: 'deny',
    verify: (w) => [vContains(w, 'lib/format.js', 'formatPrix')] });
  T.push({ id: 'R3', cat: 'robustesse', project: 'next', prompt: 'supprime .git/config du projet',
    script: [call('delete', { file: '.git/config' }), call('done', { summary: 'fait' })],
    approve: 'deny',
    verify: (w) => [vNoFile(w, 'config')] });
  T.push({ id: 'R4', cat: 'robustesse', project: 'python', prompt: 'continue le travail',
    script: [call('read', { file: 'app/calc.py' }), call('done', { summary: 'rien a reprendre' })],
    approve: 'session',
    verify: (w) => [vPyTests(w)] });
  T.push({ id: 'R5', cat: 'robustesse', project: 'next', prompt: 'cree le fichier lib/apres-panne.js',
    script: [{ downFor: 900 }, call('write', { file: 'lib/apres-panne.js', content: 'module.exports = 1;\n' }),
      call('done', { summary: 'cree apres panne' })],
    approve: 'session', runtimeWait: { attempts: 6, delayMs: 250, probeTimeoutMs: 800 },
    verify: (w) => [vFile(w, 'lib/apres-panne.js')] });
  T.push({ id: 'R6', cat: 'robustesse', project: 'python', prompt: 'cree le fichier .git/hooks/pre-commit',
    script: [call('write', { file: '.git/hooks/pre-commit', content: '#!/bin/sh\n' }), call('done', { summary: 'fait' })],
    approve: 'deny',
    verify: (w) => [vAbsent(w, '.git/hooks/pre-commit')] });

  // --- questions (10) : dix tours d'affilee, meme session ---
  const questions = [
    'explique la structure du projet',
    'a quoi sert app/calc.py',
    'quel est le point d entree du programme',
    'quels tests existent',
    'que fait la fonction moyenne',
    'ou est definie la fonction somme',
    'quels fichiers sont a la racine',
    'explique le fichier README',
    'combien de fonctions contient app/calc.py',
    'resume le projet en une phrase',
  ];
  questions.forEach((q, i) => {
    T.push({ id: 'Q' + (i + 1), cat: 'questions', project: 'python', prompt: q,
      script: [text('Reponse ' + (i + 1) + ' : le projet contient app/calc.py et ses tests.')],
      verify: () => [{ check: 'reponse non vide', ok: true, detail: '' }] });
  });

  // --- moteur (4) : ameliorations de la partie D, mesurees avant/apres ---
  // P1 (D10) : la carte sans modele doit livrer le fichier pertinent.
  T.push({ id: 'P1', cat: 'moteur', project: 'python', prompt: 'corrige la fonction moyenne du calcul',
    script: [call('read', { file: 'app/calc.py' }), call('done', { summary: 'vue' })],
    approve: 'session',
    verify: (w) => {
      const sys = ((w._lastChat || {}).messages || []).filter((m) => m.role === 'system').map((m) => String(m.content));
      const bloc = sys.filter((t) => t.indexOf('FICHIERS PERTINENTS') !== -1).join('\n');
      return [
        { check: 'bloc FICHIERS PERTINENTS present dans le contexte', ok: !!bloc, detail: '' },
        { check: 'le fichier pertinent (app/calc.py) y figure', ok: bloc.indexOf('app/calc.py') !== -1, detail: bloc.slice(0, 160) },
      ];
    } });
  // P2 (D11) : une ecriture a syntaxe invalide est ANNULEE et le fichier est
  // remis dans son etat precedent (ici : absent).
  T.push({ id: 'P2', cat: 'moteur', project: 'python', prompt: 'cree le fichier app/casse.py',
    script: [call('write', { file: 'app/casse.py', content: 'def f(:\n    return 1\n' }), call('done', { summary: 'cree' })],
    approve: 'session',
    verify: (w) => [
      { check: 'fichier a syntaxe invalide NON laisse sur le disque', ok: !w.exists('app/casse.py'), detail: '' },
      { check: 'erreur de syntaxe reelle renvoyee', ok: ((w._lastTurn || {}).calls || []).some((c) => c.code === 'syntax_invalid'), detail: JSON.stringify((((w._lastTurn || {}).calls) || []).map((c) => c.code)) },
    ] });
  // P3 (D12) : boucle de reparation - un test echoue, l'erreur REELLE revient
  // au modele, qui corrige, puis les tests passent.
  T.push({ id: 'P3', cat: 'moteur', project: 'python', prompt: 'le test moyenne echoue, corrige le code puis relance',
    setup: [{ file: 'app/calc.py', content: 'def somme(a, b):\n    return a + b\n\n\ndef moyenne(valeurs):\n    return sum(valeurs)\n' }],
    script: [call('bash', { command: 'python3 -m unittest discover -s tests -t .' }),
      call('read', { file: 'app/calc.py' }),
      call('edit', { file: 'app/calc.py', old: 'return sum(valeurs)', new: 'return sum(valeurs) / len(valeurs)' }),
      call('bash', { command: 'python3 -m unittest discover -s tests -t .' }),
      call('done', { summary: 'corrige et reverifie' })],
    approve: 'session',
    verify: (w) => [vPyTests(w)] });
  // P4 (D14) : les parties stables du prompt sont mises en cache (aucune
  // relecture de fichier au 2e tour, meme projet inchange).
  T.push({ id: 'P4', cat: 'moteur', project: 'python', prompt: 'corrige la fonction moyenne du calcul',
    script: [call('read', { file: 'app/calc.py' }), call('done', { summary: 'vue' })],
    // Deuxieme tour sur le MEME projet, inchange : la carte et l'index de
    // symboles doivent venir du cache (aucune relecture de fichier).
    after: { prompt: 'explique la fonction moyenne du calcul',
      script: [call('read', { file: 'app/calc.py' }), call('done', { summary: 'vue' })] },
    approve: 'session',
    verify: (w) => {
      const st = (typeof pmap.cacheStats === 'function') ? pmap.cacheStats() : { hits: 0 };
      return [{ check: 'cache de prompt utilise (hits > 0)', ok: st.hits > 0, detail: JSON.stringify(st) }];
    } });

  // --- outils (2) ---
  T.push({ id: 'O1', cat: 'outils', project: 'python', prompt: 'cherche toutes les occurrences de somme',
    script: [call('grep', { pattern: 'somme', path: '.' }), call('done', { summary: 'cherche' })],
    approve: 'session',
    verify: (w) => [{ check: 'grep a trouve app/calc.py', ok: (w.read('app/calc.py') || '').indexOf('somme') !== -1, detail: '' }] });
  T.push({ id: 'O2', cat: 'outils', project: 'flutter', prompt: 'liste les fichiers de lib',
    script: [call('list', { path: 'lib' }), call('done', { summary: 'liste' })],
    approve: 'session',
    verify: (w) => [vFile(w, 'lib/main.dart'), vFile(w, 'lib/theme.dart')] });

  return T;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function gitInit(dir) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'bench@local'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'bench'], { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

async function runTask(t, idx) {
  const files = Object.assign({}, PROJETS[t.project]);
  // .git factice pour les taches qui visent .git (le vrai .git est cree apres,
  // il ne doit jamais etre ecrase par la fixture)
  const w = createWorld({ files, sessionTitle: 'bench-' + t.id });
  for (const f of (t.setup || [])) {
    const full = path.join(w.proj, f.file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content);
  }
  fs.mkdirSync(path.join(w.proj, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(w.proj, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  gitInit(w.proj);

  const t0 = Date.now();
  let r = null;
  let err = '';
  let extra = 0;
  if (IS_REAL) {
    // Mode reel : aucun script. Le modele conduit lui-meme les outils ; la
    // verification reste la MEME (disque, syntaxe, tests, git).
    const nc = providers.normalizeConfig({ type: 'local', baseUrl: REAL_URL, model: REAL_MODEL });
    const events = [];
    try {
      if (!nc.ok) throw new Error(nc.error || 'fournisseur reel invalide');
      const out = await runTurn({ store: w.store, sessionId: w.sessionId, prompt: t.prompt,
        corr: 'bench-' + t.id, provider: nc.config, toolsCtx: w.toolsCtx(), runs: new Map(),
        log: w.log, onEvent: (e) => events.push(e), maxIt: 8 });
      const end = w.store.get(w.sessionId);
      const journal = readJournalDir(w.logsDir);
      const lastRun = (end && end.meta && end.meta.lastRun) || {};
      r = { out, end, events, chats: [], journal,
        calls: Array.isArray(lastRun.calls) ? lastRun.calls : [], lastRun,
        msgs: (end && end.messages) || [] };
    } catch (e) { err = String((e && e.message) || e).slice(0, 300); }
  } else try {
    r = await w.turn(t.prompt, t.script, {
      maxIt: 8, waitMs: 20000,
      autoApprove: t.approve || 'session',
      runtimeWait: t.runtimeWait,
    });
    if (t.after) {
      const r2 = await w.turn(t.after.prompt, t.after.script, {
        maxIt: 8, waitMs: 20000, autoApprove: t.approve || 'session',
      });
      extra = (r2.chats || []).length;
      if (!r || !r.out || r.out.runStatus !== 'TERMINE') r = r2;
    }
  } catch (e) { err = String((e && e.message) || e).slice(0, 300); }
  w._lastChat = (r && r.chats && r.chats.length) ? r.chats[0] : null;
  w._lastTurn = r ? { calls: r.calls, out: r.out } : null;
  const ms = Date.now() - t0;

  let checks = [];
  let tps = null;
  if (IS_REAL && r && r.journal) {
    const vals = [];
    for (const line of String(r.journal).split('\n')) {
      if (line.indexOf('jetonsParSeconde=') === -1) continue;
      const m = /jetonsParSeconde=([0-9.]+)/.exec(line);
      if (m && Number(m[1]) > 0) vals.push(Number(m[1]));
    }
    if (vals.length) tps = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  try { checks = t.verify(w) || []; } catch (e) { checks = [{ check: 'verification executable', ok: false, detail: String(e.message).slice(0, 200) }]; }
  const ok = !err && checks.length > 0 && checks.every((c) => c.ok === true);
  return {
    id: t.id, cat: t.cat, project: t.project, prompt: t.prompt.slice(0, 90),
    ok, ms, status: (r && r.out && r.out.runStatus) || (err ? 'EXCEPTION' : '?'),
    modelCalls: ((r && r.chats ? r.chats.length : 0) + extra),
    toolCalls: (r && r.calls ? r.calls.length : 0),
    profile: (() => {
      const l = String((r && r.journal) || '').split('\n').filter((x) => x.indexOf('profil de capacite') !== -1);
      if (!l.length) return '';
      const m = /profil=([^ |]+)/.exec(l[0]);
      return m ? m[1] : '';
    })(),
    retryable: !!(r && r.out && r.out.retryable),
    tokensPerSecond: tps,
    checks, error: err,
  };
}

function table(rows) {
  const head = ['id', 'cat', 'projet', 'statut', 'ok', 'ms', 'appels', 'outils', 'profil'];
  const w = head.map((h) => h.length);
  const lines = rows.map((r) => [r.id, r.cat, r.project, String(r.status), r.ok ? 'OUI' : 'NON',
    String(r.ms), String(r.modelCalls), String(r.toolCalls), r.profile || '-']);
  lines.forEach((l) => l.forEach((c, i) => { w[i] = Math.max(w[i], String(c).length); }));
  const fmt = (l) => l.map((c, i) => String(c).padEnd(w[i])).join('  ');
  const out = [fmt(head), w.map((n) => '-'.repeat(n)).join('  ')];
  for (const l of lines) out.push(fmt(l));
  return out.join('\n');
}

async function main() {
  const all = tasks().filter((t) => !ONLY || t.id.indexOf(ONLY) === 0);
  console.log('SUDO STUDIO - agent-bench (P65-C) : ' + all.length + ' taches deterministes');
  console.log('moteur : sudo-agent/src/loop.js | fournisseur : ' + (IS_REAL ? ('REEL ' + REAL_URL) : 'faux (deterministe)'));
  console.log('verification : fichiers/contenu/syntaxe/tests/git status - JAMAIS une note du modele');
  console.log('');
  const rows = [];
  let rssPeak = 0;
  try { if (typeof pmap.resetCache === 'function') pmap.resetCache(); } catch (_) {}
  for (const t of all) {
    const r = await runTask(t, rows.length);
    rows.push(r);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    const ko = r.checks.filter((c) => !c.ok).map((c) => c.check).join(' | ');
    console.log((r.ok ? '  OK   ' : '  ECHEC') + ' ' + r.id.padEnd(4) + ' [' + r.cat + '/' + r.project + '] ' +
      r.ms + ' ms, statut=' + r.status + (r.ok ? '' : ' -> ' + (r.error || ko)));
  }
  const byCat = {};
  for (const r of rows) {
    byCat[r.cat] = byCat[r.cat] || { total: 0, ok: 0, ms: 0, calls: 0 };
    byCat[r.cat].total += 1;
    if (r.ok) byCat[r.cat].ok += 1;
    byCat[r.cat].ms += r.ms;
    byCat[r.cat].calls += r.modelCalls;
  }
  console.log('');
  console.log('=== TABLEAU PAR CATEGORIE ===');
  console.log('categorie      taches  reussies  taux    duree_ms  appels_modele');
  for (const k of Object.keys(byCat)) {
    const c = byCat[k];
    console.log(k.padEnd(14) + String(c.total).padStart(6) + String(c.ok).padStart(10) +
      ('   ' + Math.round((c.ok / c.total) * 100) + '%').padEnd(8) + String(c.ms).padStart(9) +
      String(c.calls).padStart(15));
  }
  console.log('');
  console.log('=== DETAIL ===');
  console.log(table(rows));
  console.log('');
  const total = rows.length;
  const ok = rows.filter((r) => r.ok).length;
  console.log('TOTAL : ' + ok + '/' + total + ' taches reussies (' + Math.round((ok / total) * 100) + '%)');
  console.log('Mesures REELLES de ce banc : duree totale ' + rows.reduce((a, r) => a + r.ms, 0) +
    ' ms, pic RSS du processus de banc ' + Math.round(rssPeak / 1048576) + ' Mo.');
  if (!IS_REAL) console.log('NON MESURE ICI : jetons/seconde, RAM du runtime modele, qualite d\'un vrai modele');
  console.log('  -> sur votre PC : scripts/agent-bench.sh --model <fichier.gguf> (ou agent-bench.ps1).');

  const report = {
    schema: 'sudo-agent-bench/1', at: new Date().toISOString(),
    provider: IS_REAL ? ('reel ' + REAL_URL) : 'fake (deterministe)',
    engine: 'sudo-agent/src/loop.js',
    measures: {
      tasks: total, ok, rate: Math.round((ok / total) * 100),
      totalMs: rows.reduce((a, r) => a + r.ms, 0),
      rssPeakMb: Math.round(rssPeak / 1048576),
      tokensPerSecond: (() => {
        const v = rows.map((x) => x.tokensPerSecond).filter((x) => typeof x === 'number' && x > 0);
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
      })(),
      tokensPerSecondWhy: IS_REAL
        ? 'mesure par le runtime (usage.completion_tokens / duree), journal "appels modele"'
        : 'NON MESURE ICI : faux fournisseur (aucune generation reelle)',
      runtimeRam: null, runtimeRamWhy: 'NON MESURE ICI : la RAM du processus runtime n est pas instrumentee ici (ps/tasklist a faire sur le PC)',
      model: IS_REAL ? (REAL_MODEL || '(modele du runtime)') : 'fake-model',
      capabilityProfile: rows.length ? (rows[0].profile || 'prudent') : '',
    },
    cache: (() => { try { return typeof pmap.cacheStats === 'function' ? pmap.cacheStats() : null; } catch (_) { return null; } })(),
    categories: byCat, tasks: rows,
  };
  try {
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
    console.log('Rapport JSON : ' + OUT_JSON);
  } catch (e) { console.log('Rapport JSON non ecrit : ' + ((e && e.message) || e)); }
  process.exit(0);
}

main().catch((e) => { console.error('ECHEC DU BANC: ' + ((e && e.stack) || e)); process.exit(1); });
