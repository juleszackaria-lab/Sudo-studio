'use strict';
/**
 * P71-A2 : recommandations DETERMINISTES, sans modele.
 *
 * Chaque recommandation porte sa PREUVE (fichier, ligne, absence constatee).
 * Aucune donnee inventee : si l'information n'est pas dans l'analyse ou sur le
 * disque, la regle ne s'applique pas.
 *
 * Entree : le rapport de analyzeProject() (analysis/projectAnalyzer.js)
 *          + {root} pour relire le disque quand c'est necessaire.
 * Sortie : { items: [...], counts: {error, warn, info} }
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');

const LOCK_NAMES = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'],
  python: ['poetry.lock', 'Pipfile.lock', 'requirements.txt'],
  go: ['go.sum'],
  rust: ['Cargo.lock'],
  php: ['composer.lock'],
  java: ['gradle.lockfile'],
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function exists(root, rel) {
  try { return fs.existsSync(path.join(root, rel)); } catch (_) { return false; }
}

function readIgnore(root) {
  try { return fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch (_) { return null; }
}

function envKeys(root) {
  const f = exists(root, '.env') ? path.join(root, '.env') : null;
  if (!f) return [];
  try {
    return fs.readFileSync(f, 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && l.indexOf('=') > 0 && l[0] !== '#')
      .map((l) => l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim());
  } catch (_) { return []; }
}

function build(analysis, opts) {
  opts = opts || {};
  const root = opts.root || (analysis && analysis.root) || '';
  const items = [];
  const add = (item) => items.push(item);
  const a = analysis || {};

  // ---- package.json : script test, README, .env.example ---------------------
  const pkg = root ? readJson(path.join(root, 'package.json')) : null;
  const scripts = (pkg && pkg.scripts) || {};

  if (pkg && !scripts.test) {
    add({ id: 'test-script', area: 'Tests', level: 'warn',
      title: 'Aucun script "test" defini',
      detail: 'Ajouter "test" dans scripts de package.json (ou expliquer quel lanceur utiliser).',
      proof: 'package.json : scripts.test absent',
      fixId: 'testScript' });
  }
  if (!(a.readme && a.readme.present) && !exists(root, 'README.md') && !exists(root, 'readme.md')) {
    add({ id: 'readme', area: 'Docs', level: 'warn',
      title: 'README manquant',
      detail: 'Un README est la premiere chose que lit un autre developpeur.',
      proof: 'aucun README.md a la racine de ' + (a.name || '(projet)'),
      fixId: 'readme' });
  }
  if (pkg && !exists(root, '.env.example') && !exists(root, '.env.sample')) {
    add({ id: 'env-example', area: 'Config', level: 'warn',
      title: '.env.example manquant',
      detail: 'Lister les variables d environnement attendues, sans leurs valeurs.',
      proof: 'aucun .env.example ni .env.sample a la racine',
      fixId: null });
  }

  // ---- TODO / FIXME ---------------------------------------------------------
  const todos = a.todos || {};
  if (Number(todos.count) > 0) {
    const s = (todos.sample || [])[0];
    const where = s ? String(s.path || s.file || '') + (s.line ? ':' + s.line : '') : '(exemples non fournis)';
    add({ id: 'todos', area: 'Qualite', level: 'info',
      title: Number(todos.count) + ' marqueurs TODO/FIXME',
      detail: 'Les traiter ou les convertir en taches suivies.',
      proof: 'analyse : TODO=' + (todos.todo || 0) + ' FIXME=' + (todos.fixme || 0) + ' ; premier : ' + where,
      fixId: null });
  }

  // ---- verrouillage des dependances ----------------------------------------
  for (const eco of a.deps || []) {
    const ecoName = String(eco.ecosystem || '').toLowerCase();
    if (eco.lockfile) continue;                 // verrou present : rien a dire
    const manifest = eco.manifest || null;
    if (!manifest) continue;
    const unpinned = Array.isArray(eco.unpinned) ? eco.unpinned.length : 0;
    add({ id: 'lock-' + ecoName, area: 'Dependances', level: 'warn',
      title: 'Dependances non verrouillees (' + ecoName + ')',
      detail: 'Sans fichier de verrouillage, deux installations ne donnent pas le meme resultat.',
      proof: manifest + ' sans ' + ((LOCK_NAMES[ecoName] || ['fichier de verrouillage']).join(' / ')) +
        (unpinned ? ' ; ' + unpinned + ' dependance(s) non epinglee(s)' : '') +
        (eco.note ? ' (' + eco.note + ')' : ''),
      fixId: null });
  }

  // ---- tests ----------------------------------------------------------------
  const tests = a.tests || {};
  if (Number(tests.count) === 0) {
    add({ id: 'no-tests', area: 'Tests', level: 'warn',
      title: 'Aucun fichier de test detecte',
      detail: 'Commencer par un test sur le point d entree principal.',
      proof: 'analyse : tests.count=0 sur ' + (a.stats ? a.stats.files : '?') + ' fichiers',
      fixId: null });
  }

  // ---- .gitignore / secrets -------------------------------------------------
  const gi = readIgnore(root);
  if (gi === null) {
    add({ id: 'gitignore', area: 'Securite', level: 'warn',
      title: '.gitignore absent',
      detail: 'Risque de committer node_modules, .env ou des fichiers de build.',
      proof: 'aucun .gitignore a la racine',
      fixId: null });
  } else if (exists(root, '.env') && !/(^|\n)\s*\.env\s*(\n|$)/.test(gi)) {
    add({ id: 'env-not-ignored', area: 'Securite', level: 'error',
      title: '.env present mais non ignore',
      detail: 'RISQUE DE FUITE DE SECRETS : ajouter .env au .gitignore.',
      proof: '.env existe et .gitignore ne contient pas la ligne .env',
      fixId: null });
  }

  // ---- variables d environnement -------------------------------------------
  const keys = envKeys(root);
  if (keys.length && !exists(root, '.env.example')) {
    add({ id: 'env-keys', area: 'Config', level: 'info',
      title: keys.length + ' variable(s) d environnement utilisee(s)',
      detail: 'Les documenter dans .env.example (noms seulement).',
      proof: '.env : ' + keys.slice(0, 6).join(', ') + (keys.length > 6 ? ' ...' : ''),
      fixId: null });
  }

  // ---- CI / Docker ---------------------------------------------------------
  const ci = a.ci || {};
  if (!(ci.present || (Array.isArray(ci.providers) && ci.providers.length))) {
    add({ id: 'no-ci', area: 'CI/CD', level: 'info',
      title: 'Aucun pipeline CI detecte',
      detail: 'Un workflow qui lance les tests a chaque push evite les regressions silencieuses.',
      proof: 'analyse : aucun fichier .github/workflows, .gitlab-ci.yml ou equivalent',
      fixId: null });
  }
  if (!exists(root, 'Dockerfile')) {
    add({ id: 'no-docker', area: 'Deploiement', level: 'info',
      title: 'Pas de Dockerfile',
      detail: 'Utile seulement si le projet doit etre deploye en conteneur.',
      proof: 'aucun Dockerfile a la racine',
      fixId: null });
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const it of items) counts[it.level] = (counts[it.level] || 0) + 1;
  return { items, counts, root, generatedAt: new Date().toISOString() };
}

module.exports = { build, LOCK_NAMES };
