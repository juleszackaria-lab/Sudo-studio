/**
 * test-p64-profiles.js - P64 partie F : profils de livraison par marche.
 *
 * Verifie, sans reseau ni modele :
 *   - le manifeste est complet et ses ids sont uniques ;
 *   - le profil "global" est le catalogue ACTUEL (13 modeles, rien ne change) ;
 *   - "us" ne contient que des editeurs americains ;
 *   - "eu" ne contient que des editeurs de l Union europeenne ;
 *   - "neutre" ne contient que des licences permissives a usage commercial ;
 *   - "client" ne contient aucun modele ;
 *   - un modele non commercial (licence de recherche) n entre dans AUCUN profil vendu ;
 *   - aucun modele exclu n apparait dans la sortie generee (catalogue + notices).
 *
 * Usage : node backend/tests/test-p64-profiles.js   (code 0 = tout passe)
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(ROOT, 'scripts', 'ci', 'build-models-manifest.js');
const MANIFEST = path.join(ROOT, 'models-manifest.json');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 300)); }
}

const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const models = raw.models;

check('manifeste : 13 modeles du catalogue', models.length === 13, models.length);
check('manifeste : ids uniques', new Set(models.map((m) => m.id)).size === models.length, models.map((m) => m.id));
check('manifeste : chaque modele a editeur et pays', models.every((m) => m.publisher && m.country),
  models.filter((m) => !m.publisher || !m.country).map((m) => m.id));
check('manifeste : aucun modele livre en EMBARQUE (poids non redistribues)',
  models.every((m) => m.bundle === 'download'), models.filter((m) => m.bundle !== 'download').map((m) => m.id));
check('manifeste : licence non verifiee signalee (3 depots 401)',
  models.filter((m) => !m.license_spdx).length === 3, models.filter((m) => !m.license_spdx).map((m) => m.id));

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p64-profiles-'));
function build(profile) {
  execFileSync(process.execPath, [BUILD, '--profile', profile, '--out', outDir], { stdio: 'pipe' });
  const dir = path.join(outDir, profile);
  return {
    cat: JSON.parse(fs.readFileSync(path.join(dir, 'catalogue.json'), 'utf8')),
    notices: fs.readFileSync(path.join(dir, 'MODEL_NOTICES.md'), 'utf8'),
    text: fs.readFileSync(path.join(dir, 'catalogue.json'), 'utf8') + fs.readFileSync(path.join(dir, 'MODEL_NOTICES.md'), 'utf8'),
  };
}

const g = build('global');
check('profil global = catalogue actuel (13)', g.cat.count === 13, g.cat.count);
check('profil global : le modele par defaut est conserve',
  g.cat.models.some((m) => m.default === true && m.id === 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF'),
  g.cat.models.filter((m) => m.default).map((m) => m.id));
check('profil global : les risques sont signales, pas caches',
  g.cat.models.filter((m) => (m.warnings || []).length > 0).length >= 4,
  g.cat.models.filter((m) => (m.warnings || []).length > 0).length);

const us = build('us');
check('profil us : uniquement des editeurs US', us.cat.models.length > 0 && us.cat.models.every((m) => m.country === 'US'),
  us.cat.models.map((m) => m.country));
check('profil us : aucun editeur chinois ou europeen',
  !us.text.includes('Qwen') && !us.text.includes('DeepSeek') && !us.text.includes('Mistral'),
  us.cat.models.map((m) => m.id));
check('profil us : Qwen2.5-Coder-1.5B (defaut) absent', !us.text.includes('Qwen2.5-Coder-1.5B'), 'present');

const eu = build('eu');
check('profil eu : uniquement des editeurs de l UE', eu.cat.models.length > 0 && eu.cat.models.every((m) => ['FR', 'DE', 'NL', 'IE', 'ES', 'IT', 'SE', 'FI', 'BE', 'AT', 'PL', 'PT', 'DK', 'CZ'].includes(m.country)),
  eu.cat.models.map((m) => m.country));
check('profil eu : aucun editeur americain ou chinois',
  !eu.text.includes('Meta') && !eu.text.includes('Microsoft') && !eu.text.includes('Qwen'), eu.cat.models.map((m) => m.id));

const nt = build('neutre');
check('profil neutre : licences permissives seulement',
  nt.cat.models.every((m) => ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'].includes(m.license)),
  nt.cat.models.map((m) => m.license));
check('profil neutre : aucune licence sur mesure (Llama / DeepSeek / Qwen Research)',
  nt.cat.models.every((m) => !/LicenseRef/.test(String(m.license))), nt.cat.models.map((m) => m.license));

const cl = build('client');
check('profil client : aucun modele livre', cl.cat.count === 0, cl.cat.count);
check('profil client : la notice explique le branchement du client',
  /Aucun modele n est livre/.test(cl.notices), cl.notices.slice(0, 80));

// Le modele a licence de recherche ne doit entrer dans AUCUN profil vendu.
const NC = 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF';
for (const p of ['us', 'eu', 'neutre', 'client']) {
  const r = p === 'us' ? us : p === 'eu' ? eu : p === 'neutre' ? nt : cl;
  check('licence de recherche (Qwen 3B) exclue du profil ' + p, !r.text.includes(NC), p);
}

// Aucun modele exclu ne doit apparaitre dans la sortie : controle externe.
for (const [p, r] of [['us', us], ['eu', eu], ['neutre', nt], ['client', cl]]) {
  const allowed = new Set(r.cat.models.map((m) => m.id));
  const leaked = models.filter((m) => !allowed.has(m.id) && r.text.includes(m.id)).map((m) => m.id);
  check('aucune fuite de modele exclu dans ' + p, leaked.length === 0, leaked);
}

console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
process.exit(fail === 0 ? 0 : 1);
