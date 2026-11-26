'use strict';
/**
 * P71-D10/D11 : AutoFix npm, honnete et verifie.
 *
 * Ordre impose :
 *   1. le composant est-il DEJA installe (mais hors du PATH) ?  -> reparer le PATH ;
 *   2. sinon on installe (winget, puis installateur local si hors ligne) ;
 *   3. on RELANCE la detection et on rapporte le resultat VERIFIE.
 * Jamais de "succes" sans verification, jamais d echec silencieux.
 *
 * Hors ligne : message clair + chemin du dossier d installateurs locaux
 * (.sudo_studio\installers). Aucune commande reseau n est lancee.
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');

const OFFLINE_DIR = path.join('.sudo_studio', 'installers');

function classify(det, name) {
  const found = (det && det.found) || {};
  const outside = (det && det.outsidePath) || [];
  if (found[name]) {
    return outside.indexOf(name) !== -1
      ? { state: 'installed_outside_path', path: found[name] }
      : { state: 'ok', path: found[name] };
  }
  return { state: 'missing', path: null };
}

function localInstallers(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /(node|npm)/i.test(f) && /\.(msi|exe|zip)$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch (_) { return []; }
}

function planFix(opts) {
  opts = opts || {};
  const name = opts.name || 'npm';
  const det = opts.detect || {};
  const cls = classify(det, name);
  const offline = !!opts.offline;
  const installersDir = opts.installersDir || path.join(opts.home || process.cwd(), OFFLINE_DIR);

  if (cls.state === 'ok') {
    return { ok: true, code: 'already_ok', steps: [],
      message: name + ' est deja installe et utilisable (' + cls.path + ') : rien a installer.',
      verifiedBy: cls.path };
  }
  if (cls.state === 'installed_outside_path') {
    return { ok: true, code: 'repair_path',
      steps: [{ kind: 'path', directory: path.dirname(cls.path) }],
      message: name + ' est installe (' + cls.path + ') mais son dossier n est pas dans le PATH : ' +
        'on repare le PATH utilisateur au lieu de reinstaller.',
      verifiedBy: cls.path };
  }
  if (offline) {
    const local = localInstallers(installersDir);
    if (!local.length) {
      return { ok: false, code: 'offline_no_installer',
        installersDir,
        message: name + ' n est pas installe et il n y a pas d Internet. ' +
          'Placez l installateur Node.js (msi/exe) dans "' + installersDir + '" puis relancez l AutoFix : ' +
          'il sera utilise hors ligne. Aucune commande reseau n a ete lancee.' };
    }
    return { ok: true, code: 'install_offline',
      steps: [{ kind: 'install', method: 'local', file: local[0] }],
      message: 'Installation hors ligne depuis "' + local[0] + '".', installersDir };
  }
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') {
    return { ok: false, code: 'not_supported',
      message: 'L installation automatique de Node.js est implementee pour Windows ; ' +
        'sur ce systeme, installez-le avec le gestionnaire de paquets puis relancez le diagnostic.' };
  }
  return { ok: true, code: 'install_online',
    steps: [{ kind: 'install', method: 'winget', id: 'OpenJS.NodeJS.LTS' }],
    message: 'Installation de Node.js LTS (winget OpenJS.NodeJS.LTS), puis relance de la detection.' };
}

/**
 * Execute le plan avec des fonctions injectees, puis VERIFIE en re-detectant.
 * exec(cmd, args) -> { code, stdout, stderr }
 */
async function runFix(plan, deps) {
  deps = deps || {};
  const exec = deps.exec;
  const redetect = deps.redetect;
  const log = deps.log || (() => {});
  if (!plan || !plan.ok) {
    return { ok: false, code: (plan && plan.code) || 'no_plan',
      message: (plan && plan.message) || 'Aucune correction possible.' };
  }
  if (plan.code === 'already_ok') {
    return { ok: true, code: 'already_ok', message: plan.message, verified: true };
  }
  const done = [];
  for (const step of plan.steps) {
    if (step.kind === 'path') {
      const r = deps.repairPath ? await deps.repairPath(step.directory) : { ok: false, message: 'reparation PATH indisponible' };
      done.push({ step: 'path', ok: !!r.ok, message: r.message || '' });
      log('npmFix path ' + (r.ok ? 'ok' : 'echec') + ' ' + (r.message || ''));
      if (!r.ok) return { ok: false, code: 'path_repair_failed', message: r.message || 'Reparation du PATH impossible.', done };
    } else if (step.kind === 'install') {
      if (!exec) return { ok: false, code: 'no_exec', message: 'Execution indisponible.', done };
      let r;
      if (step.method === 'winget') {
        r = await exec('winget', ['install', '--id', step.id, '--silent', '--accept-package-agreements', '--accept-source-agreements']);
      } else {
        r = await exec(step.file, []);
      }
      done.push({ step: 'install', method: step.method, code: r.code,
        stdout: String(r.stdout || '').slice(0, 300), stderr: String(r.stderr || '').slice(0, 300) });
      log('npmFix install ' + step.method + ' code=' + r.code);
      if (r.code !== 0) {
        const why = /(network|internet|resolve|connect|0x8a15|offline)/i.test(String(r.stdout || '') + String(r.stderr || ''))
          ? 'reseau indisponible pendant l installation'
          : ('code de sortie ' + r.code);
        return { ok: false, code: 'install_failed',
          message: 'L installation a echoue (' + why + '). ' +
            'Verifiez Internet, ou placez l installateur dans "' + OFFLINE_DIR + '" et relancez.',
          done };
      }
    }
  }
  if (!redetect) return { ok: false, code: 'no_verify', message: 'Verification impossible : detection indisponible.', done };
  const after = await redetect();
  const cls2 = classify(after, plan.steps.some((s) => s.kind === 'install') ? 'node' : 'npm');
  const ok = cls2.state === 'ok';
  return { ok, code: ok ? 'fixed_verified' : 'fixed_unverified',
    verified: ok,
    message: ok
      ? 'Termine et VERIFIE : ' + (cls2.path || 'outil retrouve') + ' est utilisable apres relance de la detection.'
      : 'La detection ne trouve toujours pas l outil apres correction : rien n est affirme a tort. ' +
        'Ouvrez "Details" pour voir la commande et sa sortie.',
    done, after: { state: cls2.state, path: cls2.path } };
}

module.exports = { OFFLINE_DIR, classify, planFix, runFix, localInstallers };
