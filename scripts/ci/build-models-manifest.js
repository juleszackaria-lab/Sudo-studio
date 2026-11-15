#!/usr/bin/env node
/**
 * build-models-manifest.js - P64 (partie F) : un seul code, des profils de
 * livraison choisis au BUILD.
 *
 * Profils :
 *   global (defaut, comportement actuel inchange) : tout le catalogue
 *   us     : editeurs des Etats-Unis uniquement
 *   eu     : editeurs de l Union europeenne uniquement
 *   neutre : licences permissives (Apache-2.0, MIT, BSD) quel que soit le pays,
 *            et usage commercial autorise
 *   client : aucun modele (le client branche le sien via un fournisseur
 *            compatible OpenAI sur son reseau interne)
 *
 * Produit, pour chaque profil :
 *   dist-models/<profil>/catalogue.json  (ce que l interface a le droit d afficher)
 *   dist-models/<profil>/MODEL_NOTICES.md (mentions exigees par les licences)
 * et echoue si un modele exclu par le profil apparait dans la sortie.
 *
 * N a AUCUN effet sur le mode agent : ce script ne fait que lire/lister.
 * Usage : node scripts/ci/build-models-manifest.js --profile us [--out dir]
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'models-manifest.json');
const PROFILES = ['global', 'us', 'eu', 'neutre', 'client'];
const PERMISSIVE = ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];
const EU = ['FR', 'DE', 'NL', 'IE', 'ES', 'IT', 'SE', 'FI', 'BE', 'AT', 'PL', 'PT', 'DK', 'CZ'];

function load() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!raw || !Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error('manifeste vide ou invalide');
  }
  return raw;
}

function validate(models) {
  const errs = [];
  const ids = new Set();
  for (const m of models) {
    if (!m.id) { errs.push('modele sans id'); continue; }
    if (ids.has(m.id)) errs.push('id duplique: ' + m.id);
    ids.add(m.id);
    if (!m.publisher) errs.push(m.id + ' : publisher manquant');
    if (!m.country) errs.push(m.id + ' : country manquant');
    if (!m.license_spdx) errs.push(m.id + ' : license_spdx absent (NON VERIFIE)');
    if (m.license_spdx && !m.license_url) errs.push(m.id + ' : license_url manquant');
    if (m.license_spdx && !m.license_sha256) errs.push(m.id + ' : license_sha256 non mesure');
    if (!Array.isArray(m.markets)) errs.push(m.id + ' : markets manquant');
    if (m.bundle !== 'download' && m.bundle !== 'embedded') errs.push(m.id + ' : bundle doit etre download|embedded');
  }
  return errs;
}

function allows(model, profile) {
  if (profile === 'client') return false;
  // "global" = catalogue ACTUEL : rien ne disparait (comportement par defaut
  // inchange). Les modeles a risque sont livres avec un avertissement explicite
  // (champ warnings) pour que l acheteur les voie avant de vendre.
  if (profile === 'global') return true;
  // Un modele sans usage commercial autorise n entre dans AUCUN profil vendu.
  if (model.commercial_use !== true) return false;
  if (profile === 'us') return model.country === 'US';
  if (profile === 'eu') return EU.indexOf(model.country) !== -1;
  if (profile === 'neutre') return PERMISSIVE.indexOf(model.license_spdx) !== -1;
  return false;
}

function catalogue(models, profile) {
  return models.filter((m) => allows(m, profile)).map((m) => ({
    id: m.id,
    label: m.label,
    publisher: m.publisher,
    country: m.country,
    license: m.license_spdx,
    license_url: m.license_url,
    license_sha256: m.license_sha256,
    commercial_use: m.commercial_use,
    bundle: m.bundle,
    file: m.file,
    file_bytes: m.file_bytes,
    ram_min_mb: m.ram_min_mb,
    capabilities: m.capabilities,
    default: !!m.default,
    warnings: buildWarnings(m),
  }));
}

function buildWarnings(m) {
  const w = [];
  if (m.commercial_use !== true) w.push('usage commercial non autorise par la licence');
  if (!m.license_spdx) w.push('licence NON VERIFIE (depot inaccessible)');
  if (!m.license_sha256) w.push('empreinte de licence non mesuree');
  if (m.gated) w.push('acces restreint sur Hugging Face (' + m.gated + ')');
  return w;
}

function notices(models, selected) {
  const lines = [
    '# MODEL NOTICES - profil de livraison',
    '',
    'Genere par scripts/ci/build-models-manifest.js. Ne pas editer a la main.',
    '',
  ];
  if (selected.length === 0) {
    lines.push('Aucun modele n est livre dans ce profil (le client branche le sien).');
    return lines.join('\n') + '\n';
  }
  for (const m of selected) {
    lines.push('## ' + m.label + ' (' + m.id + ')');
    lines.push('- Editeur : ' + m.publisher + ' (' + m.country + ')');
    lines.push('- Licence : ' + (m.license_spdx || 'NON VERIFIE'));
    lines.push('- Texte : ' + (m.license_url || 'NON VERIFIE'));
    lines.push('- Empreinte SHA256 de la licence : ' + (m.license_sha256 || 'NON MESUREE'));
    lines.push('- Obligations : ' + (m.obligations || 'NON VERIFIE'));
    lines.push('- Fichier : ' + (m.file || 'NON VERIFIE') + ' (' + (m.file_bytes || 'taille non mesuree') + ' octets)');
    lines.push('- Origine : telecharge a l execution depuis ' + m.source_url);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--profile');
  const profile = pi >= 0 ? argv[pi + 1] : 'global';
  const oi = argv.indexOf('--out');
  const outDir = oi >= 0 ? argv[oi + 1] : path.join(ROOT, 'dist-models');
  if (PROFILES.indexOf(profile) === -1) {
    console.error('[FAIL] profil inconnu: ' + profile + ' (attendu: ' + PROFILES.join('|') + ')');
    process.exit(2);
  }
  const raw = load();
  const errs = validate(raw.models);
  const hard = errs.filter((e) => /duplique|sans id|vide|bundle/.test(e));
  if (hard.length) {
    console.error('[FAIL] manifeste invalide:\n  ' + hard.join('\n  '));
    process.exit(1);
  }
  if (errs.length) {
    console.log('[WARN] champs non mesures (comptes comme NON VERIFIE) :');
    for (const e of errs) console.log('   - ' + e);
  }

  const selected = raw.models.filter((m) => allows(m, profile));
  const cat = catalogue(raw.models, profile);
  const dir = path.join(outDir, profile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalogue.json'),
    JSON.stringify({ profile: profile, count: cat.length, models: cat }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'MODEL_NOTICES.md'), notices(raw.models, selected));

  // Controle d exclusion : aucun modele refuse ne doit apparaitre dans la sortie.
  const text = fs.readFileSync(path.join(dir, 'catalogue.json'), 'utf8')
    + fs.readFileSync(path.join(dir, 'MODEL_NOTICES.md'), 'utf8');
  const leaks = raw.models.filter((m) => !allows(m, profile) && text.indexOf(m.id) !== -1);
  if (leaks.length) {
    console.error('[FAIL] modele(s) exclu(s) present(s) dans la sortie ' + profile + ' : '
      + leaks.map((m) => m.id).join(', '));
    process.exit(1);
  }
  console.log('[OK] profil ' + profile + ' : ' + cat.length + '/' + raw.models.length
    + ' modeles retenus, 0 fuite -> ' + path.relative(ROOT, dir));
  for (const m of cat) console.log('   + ' + m.id + '  (' + m.publisher + ', ' + m.country + ', ' + m.license + ')');
  const excluded = raw.models.filter((m) => !allows(m, profile));
  for (const m of excluded) console.log('   - exclu: ' + m.id + '  (raison: ' + (profile === 'client' ? 'profil client' :
    (m.commercial_use !== true ? 'usage commercial non autorise par la licence' : 'hors profil ' + profile)) + ')');
}

if (require.main === module) main();
module.exports = { allows, catalogue, validate, PROFILES };
