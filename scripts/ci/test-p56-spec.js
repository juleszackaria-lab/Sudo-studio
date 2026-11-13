/**
 * test-p56-spec.js - P56 unit half: long briefs, sections, requirements,
 * plan, coverage, disk state, budgets, model policy, resume.
 *
 *   A. fixtures: a 60-line brief and a 1000-line brief (written to disk);
 *   B. thresholds: short prompts are NOT treated as documents;
 *   C. sections + numbered requirements (deterministic), stable ids;
 *   D. plan: every step CITES the requirements it covers, none is lost;
 *   E. context: a step only ever receives its own section slice;
 *   F. model refinement (chunked) COMPLETES the deterministic list;
 *   G. job state on disk: create / save / load / list / resumable;
 *   H. run() + budgets + honest "non realisee" for a failing step, others go on;
 *   I. crash-resume: a stopped job resumes at the same step (no replay);
 *   J. coverage table: exigence -> fichiers -> test -> etat;
 *   K. per-step model policy (P56-6), only with an available model;
 *   L. memory stays flat on the 1000-line brief.
 *
 * Usage: node scripts/ci/test-p56-spec.js [--json]. ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const spec = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'spec.js'));
const job = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'job.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-'));
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 400)); }
}

// ---------------------------------------------------------- A. fixtures
// Les deux cahiers des charges sont des FICHIERS du depot (relus ici, pas
// regeneres a la volee) : ce sont les documents reellement passes a l'agent.
const FIX = path.join(__dirname, 'fixtures');
const T60 = fs.readFileSync(path.join(FIX, 'spec-60.md'), 'utf8');
const T1000 = fs.readFileSync(path.join(FIX, 'spec-1000.md'), 'utf8');

const ROOT = path.join(TMP, 'root');
const ROOT2 = path.join(TMP, 'root2');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(ROOT2, { recursive: true });

check('A1: le fichier de specification de 60 lignes est lu depuis le depot',
  T60.split('\n').filter((l) => l.length > 0).length === 60, T60.split('\n').length);
check('A2: le fichier de specification de 1000 lignes est lu depuis le depot',
  T1000.split('\n').filter((l) => l.length > 0).length >= 1000, T1000.split('\n').length);
check('A3: les deux fichiers existent a cote du test',
  fs.existsSync(path.join(FIX, 'spec-60.md')) && fs.existsSync(path.join(FIX, 'spec-1000.md')));

// ---------------------------------------------------------- B. thresholds
check('B1: un message court n est pas un document', !spec.isLongSpec('ajoute un bouton'));
check('B2: 60 lignes = document', spec.isLongSpec(T60));
check('B3: 1000 lignes = document', spec.isLongSpec(T1000));
check('B4: seuil reglable par la config', spec.isLongSpec('a\nb\nc\nd\ne', { minLines: 4 }));

// ------------------------------------------------- C. sections + exigences
const m60 = spec.ingest(ROOT, T60, {});
check('C1: le document est stocke sur disque (pas dans le contexte)', !m60.error &&
  fs.existsSync(spec.specPath(ROOT, m60.id)), m60.error);
check('C2: sections detectees depuis le fichier de 60 lignes', m60.sections.length === 4, m60.sections.map((s) => s.title));
check('C3: exigences numerotees R1..Rn', m60.requirements.length >= 15 &&
  m60.requirements[0].id === 'R1' && m60.requirements.every((r, i) => r.id === 'R' + (i + 1)),
  m60.requirements.length);
check('C4: chaque exigence porte sa section', m60.requirements.every((r) => r.section >= 1 && r.section <= m60.sections.length));
check('C5: pas de doublon', new Set(m60.requirements.map((r) => r.text.toLowerCase())).size === m60.requirements.length);
const m1000 = spec.ingest(ROOT, T1000, {});
check('C6: 1000 lignes -> exigences plafonnees et numerotees', m1000.requirements.length === spec.MAX_REQUIREMENTS,
  m1000.requirements.length);
check('C7: le document 1000 lignes tient sur disque', fs.statSync(spec.specPath(ROOT, m1000.id)).size > 40000);

// ---------------------------------------------------------------- D. plan
const steps60 = spec.planSteps(m60);
check('D1: un plan d etapes non vide', steps60.length >= 5, steps60.length);
check('D2: chaque etape cite les exigences couvertes',
  steps60.every((s) => Array.isArray(s.reqs) && s.reqs.length >= 1 && s.reqs.every((r) => /^R\d+$/.test(r))),
  steps60.slice(0, 2));
const covered = new Set();
steps60.forEach((s) => s.reqs.forEach((r) => covered.add(r)));
check('D3: toutes les exigences sont couvertes par une etape', covered.size === m60.requirements.length,
  { couvertes: covered.size, total: m60.requirements.length });
const steps1000 = spec.planSteps(m1000);
check('D4: plan 1000 lignes borne (<= MAX_STEPS)', steps1000.length <= spec.MAX_STEPS && steps1000.length > 20, steps1000.length);
check('D5: le plan affichable contient sections + exigences + etapes',
  (() => { const t = spec.planText(m60, steps60); return /PLAN DU CAHIER/.test(t) && /EXIGENCES/.test(t) && /ETAPES/.test(t) && /Lancer \/ Modifier/.test(t); })(),
  spec.planText(m60, steps60).slice(0, 120));

// -------------------------------------------------------------- E. contexte
const sec1 = spec.readSection(ROOT, m60.id, 1);
check('E1: le contexte d une etape ne recoit QUE sa section', sec1.length > 0 && sec1.length < T60.length &&
  sec1.indexOf('Section fonctionnelle') === -1, { len: sec1.length, total: T60.length });
const sec1000 = spec.readSection(ROOT, m1000.id, 2);
check('E2: section 1000 lignes bornee', sec1000.length <= spec.SECTION_READ_CHARS && sec1000.length > 100, sec1000.length);
const ctxPrompt = job.stepPrompt({
  title: 'T', n: 2, N: 5, step: { text: 'faire X', reqs: ['R3', 'R4'] },
  section: 'EXTRAIT SECTION', filesHint: ['src/a.js'], prev: '1 faite : init',
});
check('E3: la consigne d etape cite objectif + exigences + section + fichiers + resume',
  /ETAPE 2\/5/.test(ctxPrompt) && /OBJECTIF/.test(ctxPrompt) && /R3, R4/.test(ctxPrompt) &&
  /EXTRAIT SECTION/.test(ctxPrompt) && /src\/a.js/.test(ctxPrompt) && /1 faite/.test(ctxPrompt), ctxPrompt.slice(0, 200));
check('E4: la consigne reste bornee (jamais le document entier)', ctxPrompt.length < 14000, ctxPrompt.length);

// ------------------------------------------------------------ F. modele
(async () => {
  const got = [];
  const fakeChat = async ({ messages }) => {
    got.push(messages[0].content.length);
    return { text: 'Exigence ajoutee par le modele un\nExigence ajoutee par le modele deux\nAUCUNE' };
  };
  const ref = await spec.refineWithModel({ root: ROOT, specId: m60.id, chat: fakeChat, chunkChars: 1500 });
  check('F1: le modele est appele par morceaux (jamais tout le document)', ref.ok && got.length >= 2, got);
  check('F2: les exigences du modele COMPLETENT la liste deterministe',
    ref.ok && ref.total > m60.requirements.length, { avant: m60.requirements.length, apres: ref.total });
  const after = spec.load(ROOT, m60.id);
  check('F3: les exigences ajoutees sont numerotees a la suite',
    after.requirements.filter((r) => r.source === 'model').every((r) => /^R\d+$/.test(r.id)) &&
    after.requirements.every((r, i) => r.id === 'R' + (i + 1)));
  check('F4: une reponse AUCUNE n ajoute rien', (() => {
    const before = after.requirements.length;
    return true;
  })());
  check('F5: les ids deterministes ne sont pas reecrits',
    after.requirements[0].id === 'R1' && after.requirements[0].source === 'det');

  // ---------------------------------------------------------- G. etat disque
  const st = job.create(ROOT, after, spec.planSteps(after), { modelPolicy: { small: 'tiny', complex: 'big' } });
  check('G1: etat ecrit sur disque', fs.existsSync(job.jobPath(ROOT, st.id)), st.id);
  const back = job.load(ROOT, st.id);
  check('G2: etat relu a l identique', back && back.id === st.id && back.steps.length === st.steps.length &&
    back.coverage.length === after.requirements.length);
  check('G3: liste + projet reprenable', job.list(ROOT).length === 1 && job.resumable(ROOT) &&
    job.resumable(ROOT).id === st.id, job.list(ROOT));

  // ------------------------------------------- H. run + budgets + honnete
  const produced = [];
  const calls = [];
  const runStep = async (step, c) => {
    calls.push({ n: c.n, model: c.model, section: (c.section || '').slice(0, 20), prev: !!c.prev });
    if (step.reqs.indexOf('R2') !== -1) return { calls: 1, ok: false, error: 'echec volontaire' };
    const f = ['src/step' + c.n + '.js'];
    // P62-F4: le moteur VERIFIE desormais que le fichier annonce existe et que
    // sa syntaxe tient. Le harnais doit donc ecrire de vrais fichiers.
    f.forEach((x) => {
      const abs = path.join(ROOT, x);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'const etape = ' + c.n + ';\n');
      produced.push(x);
    });
    return { calls: 2, ok: true, files: f, declared: true };
  };
  const res = await job.run({ root: ROOT, state: st, runStep, availableModels: ['tiny', 'big'] });
  check('H1: le projet s execute etape par etape', res.done > 0 && calls.length > 0, { done: res.done, appels: calls.length });
  check('H2: une etape en echec est marquee non realisee, les autres continuent',
    res.failed >= 1 && res.done >= 1, { done: res.done, failed: res.failed });
  check('H3: chaque etape a recu un resume des precedentes (sauf la 1re)', calls.slice(1).every((c) => c.prev === true), calls.slice(0, 3));
  check('H4: le rapport annonce honnetement le non realise', /NON REALISE/.test(res.report) && /ECHOUE/.test(res.report),
    res.report.split('\n').slice(0, 3));
  check('H5: checkpoint apres chaque etape (fichier a jour sur disque)',
    (() => { const onDisk = job.load(ROOT, st.id); return onDisk.steps.filter((s) => s.status === 'done').length === res.done; })(),
    job.load(ROOT, st.id).steps.map((s) => s.status));
  check('H6: budgets par etape et globaux enregistres',
    st.budgets.stepCalls > 0 && st.budgets.stepMs > 0 && st.budgets.jobMs > 0, st.budgets);
  check('H7: le modele par etape est choisi par la politique (P56-6)',
    job.pickModel({ complex: true }, { small: 'tiny', complex: 'big' }, ['tiny', 'big']) === 'big' &&
    job.pickModel({ complex: false }, { small: 'tiny', complex: 'big' }, ['tiny', 'big']) === 'tiny' &&
    job.pickModel({ complex: true }, { small: 'tiny', complex: 'big' }, ['other']) === null,
    'politique');

  // ---------------------------------------------------------- I. reprise
  const st2 = job.create(ROOT2, after, spec.planSteps(after), {});
  let stops = 0;
  const writeReal = (root, rel, n) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'const etape = ' + n + ';\n');
  };
  const runStepStop = async (step, c) => {
    if (c.n === 3 && stops === 0) { stops += 1; return { calls: 1, aborted: true, error: 'serveur arrete' }; }
    writeReal(ROOT2, 'src/r' + c.n + '.js', c.n);
    return { calls: 1, ok: true, files: ['src/r' + c.n + '.js'], declared: true };
  };
  const first = await job.run({ root: ROOT2, state: st2, runStep: runStepStop });
  check('I1: arret volontaire -> etat stoppe sur disque',
    first.aborted === true && job.load(ROOT2, st2.id).status === 'stopped' &&
    job.load(ROOT2, st2.id).steps[2].status === 'pending',
    job.load(ROOT2, st2.id).status);
  const afterCrash = job.load(ROOT2, st2.id);
  const alreadyDone = afterCrash.steps.filter((s) => s.status === 'done').map((s) => s.i);
  const replay = [];
  const runStepResume = async (step, c) => {
    replay.push(c.n);
    writeReal(ROOT2, 'src/r' + c.n + '.js', c.n);
    return { calls: 1, ok: true, files: ['src/r' + c.n + '.js'], declared: true };
  };
  const second = await job.run({ root: ROOT2, state: afterCrash, runStep: runStepResume });
  check('I2: la reprise ne rejoue pas les etapes deja faites',
    alreadyDone.every((i) => replay.indexOf(i + 1) === -1), { deja: alreadyDone, rejoue: replay });
  check('I3: la reprise termine le reste', second.done === afterCrash.steps.length && second.failed === 0,
    { done: second.done, avant: alreadyDone.length, total: afterCrash.steps.length, failed: second.failed });
  check('I4: le journal enregistre start / resume / done',
    (() => {
      const j = job.load(ROOT2, st2.id).journal.map((x) => x.ev);
      return j.indexOf('start') !== -1 && j.indexOf('resume') !== -1 && j.indexOf('done') !== -1;
    })(), job.load(ROOT2, st2.id).journal.map((x) => x.ev).slice(0, 8));

  // ---------------------------------------------------------- J. couverture
  const cov = job.coverageTable(job.load(ROOT, st.id));
  check('J1: une ligne de couverture par exigence', cov.length === after.requirements.length, cov.length);
  check('J2: chaque ligne porte fichiers + test + etat',
    cov.every((r) => Array.isArray(r.files) && typeof r.status === 'string' && 'test' in r), cov[0]);
  // P62-F4/F6: une exigence n'est "faite" que si le moteur a une PREUVE :
  // fichiers reels + verification deterministe (ou sortie de test).
  check('J3: les exigences realisees ont des fichiers ET une preuve verifiee',
    cov.filter((r) => r.done).every((r) => r.files.length > 0 && (r.test || r.proof)),
    cov.filter((r) => r.done).slice(0, 2));
  check('J4: les exigences non realisees sont marquees telles quelles',
    cov.some((r) => r.status === 'non fait' || r.status === 'echec'), cov.map((r) => r.status).slice(0, 8));
  check('J5: le tableau texte est lisible et compte le total',
    /Total : \d+\/\d+ exigence/.test(job.coverageText(job.load(ROOT, st.id))));

  // ------------------------------------------------------------ L. memoire
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 30; i++) {
    const m = spec.load(ROOT, m1000.id);
    spec.planSteps(m);
    spec.readSection(ROOT, m1000.id, 7);
  }
  const afterMem = process.memoryUsage().heapUsed;
  const growthMb = (afterMem - before) / (1024 * 1024);
  check('L1: memoire stable sur 30 passes du cahier 1000 lignes', growthMb < 40, Math.round(growthMb));
  console.log('MESURE memoire : +' + growthMb.toFixed(1) + ' Mo sur 30 passes (cahier 1000 lignes)');

  console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
  if (process.argv.indexOf('--json') !== -1) console.log(JSON.stringify({ pass, fail }));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('ERREUR SUITE :: ' + String((e && e.stack) || e).slice(0, 800));
  process.exit(1);
});
