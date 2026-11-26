#!/usr/bin/env node
/**
 * SUDO STUDIO - P71 parties A (budget IA) et B (AutoFix d'analyse).
 *
 *   A  budget : prompt compact <= 70 % de la fenetre, delai CALCULE sur la
 *      vitesse mesuree, causes d'echec en francais, journal sans secret ;
 *   A' CONTROLE NEGATIF : une fenetre plus petite reduit le prompt, et un
 *      runtime lent allonge le delai (un delai FIXE serait forcement faux) ;
 *   B  AutoFix : diff -> approbation -> ecriture -> verification -> re-analyse ;
 *   B' CONTROLES NEGATIFS : sans approbation rien n'est ecrit ; sans lanceur
 *      de tests on refuse (aucun script fantome) ; fix inconnu refuse.
 * Lancer : node backend/tests/test-p71-analysis-ai-autofix.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = (m) => require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', m));
const ai = P('aiBudget');
const fix = P('autoFixAnalysis');
const rec = P('recommendations');
const analyzer = P('projectAnalyzer');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-fix-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return dir;
}
const BIG = { name: 'maquis-pos', stats: { files: 900, lines: 90000, byLang: { JavaScript: { files: 800 }, CSS: { files: 100 } } },
  deps: [{ manifestDeps: Array.from({ length: 40 }, (_, i) => ({ name: 'pkg' + i })) }],
  todos: { count: 12 }, tests: { count: 0 }, readme: { present: false }, ci: { present: false } };

async function main() {
  // ------------------------------------------------------------- A budget
  {
    const c2 = ai.compactContext(BIG, { windowTokens: 2048 });
    const c8 = ai.compactContext(BIG, { windowTokens: 8192 });
    console.log('   estimation : fenetre 2048 -> ' + c2.estimatedTokens + ' jetons (max ' + c2.maxTokens + ') ; 8192 -> ' + c8.estimatedTokens + ' (max ' + c8.maxTokens + ')');
    check('A1 le prompt tient dans 70 % de la fenetre (2048)', c2.estimatedTokens <= Math.floor(2048 * 0.7), String(c2.estimatedTokens));
    check('A2 fenetre 8192 -> meme garantie', c8.estimatedTokens <= Math.floor(8192 * 0.7), String(c8.estimatedTokens));
    check('A3 CONTROLE NEGATIF : la borne du prompt suit la fenetre (2048 < 8192)',
      c2.maxChars < c8.maxChars, c2.maxChars + ' vs ' + c8.maxChars);
    const huge = Object.assign({}, BIG, { name: 'p'.repeat(20000) });
    const cHuge = ai.compactContext(huge, { windowTokens: 2048 });
    check('A3b un contexte trop long est COUPE a la borne (jamais tronque en silence : marqueur ajoute)',
      cHuge.context.length <= cHuge.maxChars + 40 && /tronque/.test(cHuge.context),
      cHuge.context.length + ' / ' + cHuge.maxChars);
    check('A4 le contexte ne contient jamais le depot entier (pas de liste de chemins)',
      c2.context.indexOf('/') === -1 || c2.context.length < 4000, c2.context.slice(0, 120));

    const dSlow = ai.deadlineMs({ promptTokens: 1200, maxOutTokens: 320, tokPerSec: 10 });
    const dFast = ai.deadlineMs({ promptTokens: 1200, maxOutTokens: 320, tokPerSec: 40 });
    check('A5 le delai suit la vitesse mesuree (lent > rapide)', dSlow.ms > dFast.ms, dSlow.ms + ' vs ' + dFast.ms);
    check('A6 le delai est borne par un plafond configurable',
      ai.deadlineMs({ promptTokens: 999999, maxOutTokens: 4000, tokPerSec: 1, ceilingMs: 120000 }).ms === 120000,
      String(ai.deadlineMs({ promptTokens: 999999, maxOutTokens: 4000, tokPerSec: 1, ceilingMs: 120000 }).ms));
    check('A7 le plafond et le plancher sont annonces dans le resultat',
      dSlow.ceilingMs > 0 && dSlow.floorMs > 0 && typeof dSlow.clamped === 'string', JSON.stringify(dSlow));

    const cWin = ai.classify({ message: 'x' }, { windowTokens: 2048, promptTokens: 5000 });
    const cSlow = ai.classify({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' },
      { windowTokens: 2048, promptTokens: 600, deadlineMs: 75000, tokPerSec: 11 });
    const cBusy = ai.classify({ response: { status: 503 } }, {});
    const cOff = ai.classify({ code: 'ECONNREFUSED' }, {});
    check('A8 fenetre depassee : cause + action', cWin.code === 'window' && cWin.action.length > 10, cWin.message);
    check('A9 lenteur : le message donne le delai calcule ET la vitesse mesuree',
      cSlow.code === 'slow' && /75 s/.test(cSlow.message) && /11 jetons\/s/.test(cSlow.message), cSlow.message);
    check('A10 runtime sans modele et runtime injoignable sont distingues',
      cBusy.code === 'busy' && cOff.code === 'offline', cBusy.code + '/' + cOff.code);
    const cNone = ai.classify({ message: 'boom' }, {});
    check("A11 CONTROLE NEGATIF : aucun 'delai depasse' nu sans cause identifiee",
      cNone.code !== 'slow' && /boom/.test(cNone.message) && cNone.action.length > 10, cNone.message);

    const line = ai.journalLine({ promptTokens: 512, windowTokens: 2048, ratioUsed: 0.7, maxOutTokens: 320,
      deadlineMs: 60000, durationMs: 41000, tokPerSec: 12, issue: 'ok' });
    check('A12 journal "analysis" : une ligne, chiffres, aucun secret',
      /prompt_tokens=512/.test(line) && /window=2048/.test(line) && /issue=ok/.test(line) &&
      c2.context.slice(0, 20).indexOf(line) === -1 && line.indexOf('\n') === -1, line);
  }

  // ------------------------------------------------------------- B AutoFix
  const PKG = JSON.stringify({ name: 'maquis-pos', version: '1.0.0',
    dependencies: { next: '14.0.0', react: '18.2.0' },
    devDependencies: { vitest: '1.0.0' },
    scripts: { dev: 'next dev' } }, null, 2);
  const FILES = { 'package.json': PKG, 'app/page.js': 'export default function Page(){return null}\n' };
  {
    const root = project(FILES);
    const a1 = await analyzer.analyzeProject(root);
    const r1 = rec.build(a1, { root });
    check('B0 la recommandation README est bien proposee avant correction',
      r1.items.some((i) => i.id === 'readme'), r1.items.map((i) => i.id).join(','));

    const plan = fix.plan('readme', a1, { root });
    check('B1 le plan contient un diff et le nom du fichier',
      plan.ok && plan.file === 'README.md' && plan.diff.split('\n').length > 5, plan.ok + ' ' + plan.file);
    const noApprove = fix.apply(plan, {});
    check("B2 CONTROLE NEGATIF : sans approbation, rien n'est ecrit",
      noApprove.code === 'needs_approval' && !fs.existsSync(path.join(root, 'README.md')), noApprove.code);
    const applied = fix.apply(plan, { approve: true });
    check('B3 applique et VERIFIE sur le disque',
      applied.ok && applied.code === 'applied' && fs.existsSync(path.join(root, 'README.md')), applied.code);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    check('B4 le README reprend les donnees de l analyse (nom, script, dependance)',
      /maquis-pos/.test(readme) && /npm run dev/.test(readme) && /next/.test(readme), readme.slice(0, 120));

    const a2 = await analyzer.analyzeProject(root);
    const r2 = rec.build(a2, { root });
    check("B5 apres re-analyse, l avertissement README a disparu",
      !r2.items.some((i) => i.id === 'readme'), r2.items.map((i) => i.id).join(','));

    const again = fix.plan('readme', a2, { root });
    check('B6 relancer la correction ne reecrit pas un README existant',
      again.code === 'exists' && again.ok === false, again.code);
  }
  {
    // script test : lanceur detecte -> corrige ; lanceur absent -> refuse
    const root = project(FILES);
    const a = await analyzer.analyzeProject(root);
    const plan = fix.plan('testScript', a, { root });
    check('B7 avec vitest detecte, le script test est propose avec la commande',
      plan.ok && plan.runner === 'vitest' && /vitest run/.test(plan.after), JSON.stringify({ ok: plan.ok, r: plan.runner }));
    const out = fix.apply(plan, { approve: true });
    const pkg2 = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check('B8 package.json contient scripts.test et reste un JSON valide',
      out.ok && pkg2.scripts.test === 'vitest run' && pkg2.dependencies.next === '14.0.0', JSON.stringify(pkg2.scripts));

    const root2 = project({ 'package.json': JSON.stringify({ name: 'x', scripts: { dev: 'next dev' } }, null, 2) });
    const a2 = await analyzer.analyzeProject(root2);
    const p2 = fix.plan('testScript', a2, { root: root2 });
    check("B9 CONTROLE NEGATIF : sans lanceur de tests, on REFUSE et on explique",
      p2.ok === false && p2.code === 'no_runner' && /Installez un lanceur/.test(p2.message), p2.message.slice(0, 100));
    check('B10 aucune ecriture dans ce cas',
      JSON.parse(fs.readFileSync(path.join(root2, 'package.json'), 'utf8')).scripts.test === undefined, 'test ecrit ?');
  }
  {
    const root = project(FILES);
    const a = await analyzer.analyzeProject(root);
    const p = fix.plan('corrigerTout', a, { root });
    check('B11 un fix inconnu est refuse avec un message (jamais un silence)',
      p.ok === false && p.code === 'unknown_fix' && p.message.length > 5, p.code);
  }

  console.log('');
  if (!fails.length) { console.log('P71 budget IA + AutoFix: ' + pass + ' checks passed (all green)'); process.exit(0); }
  console.log('P71 budget IA + AutoFix: ' + pass + ' checks passed, ' + fails.length + ' FAILED');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
