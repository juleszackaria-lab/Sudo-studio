#!/usr/bin/env node
/**
 * SUDO STUDIO - P71-A2 : recommandations DETERMINISTES, sans modele.
 *   R1  sur un projet Next.js incomplet : README, script test, verrouillage,
 *       .gitignore, CI, Docker sont signales AVEC leur preuve ;
 *   R2  temps de calcul < 2000 ms (exigence 12a) ;
 *   R3  CONTROLE NEGATIF : sur un projet complet, ces avertissements
 *       disparaissent (sinon la regle crie au loup) ;
 *   R4  une donnee absente n'est jamais inventee (pas de "obsolete" sans
 *       donnee de version).
 * Lancer : node backend/tests/test-p71-recommendations.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const analyzer = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', 'projectAnalyzer'));
const rec = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', 'recommendations'));

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-rec-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return dir;
}

const INCOMPLETE = {
  'package.json': JSON.stringify({ name: 'maquis-pos', dependencies: { next: '14.0.0', react: '18.2.0' }, scripts: { dev: 'next dev' } }, null, 2),
  'app/page.js': '// TODO: brancher la caisse\nexport default function Page(){return null}\n',
};
const COMPLETE = {
  'package.json': JSON.stringify({ name: 'maquis-pos', dependencies: { next: '14.0.0' }, devDependencies: { vitest: '1.0.0' },
    scripts: { dev: 'next dev', test: 'vitest run' } }, null, 2),
  'README.md': '# maquis-pos\n',
  'package-lock.json': '{}',
  '.gitignore': 'node_modules\n.env\n',
  '.env.example': 'DATABASE_URL=\n',
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
  'Dockerfile': 'FROM node:20\n',
  'app/page.js': 'export default function Page(){return null}\n',
};

async function main() {
// ---------------------------------------------------------------- R1 + R2
{
  const root = project(INCOMPLETE);
  const analysis = await analyzer.analyzeProject(root);
  const t0 = Date.now();
  const r = rec.build(analysis, { root });
  const ms = Date.now() - t0;
  const ids = r.items.map((i) => i.id);
  console.log('   points : ' + ids.join(', ') + ' (' + ms + ' ms)');
  check('R1a README manquant signale', ids.indexOf('readme') !== -1, ids.join(','));
  check('R1b script test manquant signale', ids.indexOf('test-script') !== -1, ids.join(','));
  check('R1c verrouillage manquant signale', ids.some((i) => i.indexOf('lock-') === 0), ids.join(','));
  check('R1d .gitignore et CI signales', ids.indexOf('gitignore') !== -1 && ids.indexOf('no-ci') !== -1, ids.join(','));
  check('R1e TODO/FIXME signale avec un exemple localise',
    ids.indexOf('todos') !== -1 && /app[\\/]page\.js/.test(String(r.items.find((i) => i.id === 'todos').proof)),
    JSON.stringify(r.items.find((i) => i.id === 'todos')));
  check('R1f chaque point porte une preuve non vide',
    r.items.every((i) => i.proof && String(i.proof).length > 3),
    r.items.map((i) => i.id + ':' + !!i.proof).join(','));
  check('R2 recommandations calculees en moins de 2000 ms', ms < 2000, ms + ' ms');
  check('R2b les points corrigeables portent un fixId deterministe',
    r.items.find((i) => i.id === 'readme').fixId === 'readme', JSON.stringify(r.items.find((i) => i.id === 'readme')));
}

// ---------------------------------------------------------------- R3 controle negatif
{
  const root = project(COMPLETE);
  const analysis = await analyzer.analyzeProject(root);
  const r = rec.build(analysis, { root });
  const ids = r.items.map((i) => i.id);
  check('R3 CONTROLE NEGATIF : projet complet -> ni README ni script test ni verrou signales',
    ids.indexOf('readme') === -1 && ids.indexOf('test-script') === -1 && !ids.some((i) => i.indexOf('lock-') === 0),
    ids.join(','));
}

// ---------------------------------------------------------------- R4 pas d'invention
{
  const root = project(INCOMPLETE);
  const analysis = await analyzer.analyzeProject(root);
  const r = rec.build(analysis, { root });
  const texts = r.items.map((i) => i.title + ' ' + i.detail).join(' ').toLowerCase();
  check('R4 aucune recommandation "obsolete" sans donnee de version',
    texts.indexOf('obsolete') === -1 && texts.indexOf('vulnerable') === -1, texts.slice(0, 160));
}

console.log('');
if (!fails.length) { console.log('P71 recommandations deterministes: ' + pass + ' checks passed (all green)'); process.exit(0); }
console.log('P71 recommandations deterministes: ' + pass + ' checks passed, ' + fails.length + ' FAILED');
fails.forEach((f) => console.log('  - ' + f));
process.exit(1);
}
main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
