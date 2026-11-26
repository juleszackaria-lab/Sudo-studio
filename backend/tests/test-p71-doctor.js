#!/usr/bin/env node
/**
 * SUDO STUDIO - P71 parties C (Doctor) et D (AutoFix npm), sans toucher au PC :
 * toutes les commandes passent par un `run` simule.
 *
 *   C1  le PREMIER diagnostic trouve node/npm meme si le PATH du processus ne
 *       les contient pas (registre + dossiers connus) ;
 *   C2  chaque ligne porte ses DETAILS (commande, sortie, chemin, PATH) ;
 *   C3  CONTROLE NEGATIF : PATH vide et aucun dossier connu -> absents ;
 *   C4  "installe mais hors PATH" est detecte et propose la reparation du PATH
 *       utilisateur (pas une reinstallation) ;
 *   D1  npm deja installe -> aucun install ;
 *   D2  npm hors PATH -> reparation, puis verification ;
 *   D3  hors ligne sans installateur -> message clair + chemin du dossier ;
 *   D4  installation en echec (reseau) -> cause, pas de faux succes ;
 *   D5  installation OK mais detection toujours muette -> "non verifie" dit ;
 *   D6  CONTROLE NEGATIF : jamais de "succes" sans re-detection.
 * Lancer : node backend/tests/test-p71-doctor.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const D = (m) => require(path.join(ROOT, 'sudo-ai-extension', 'src', 'doctor', m));
const dt = D('detectTools');
const npmFix = D('npmFix');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('ok - ' + name); }
  else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// Un faux PC Windows : le PATH ne contient PAS nodejs, mais le dossier existe.
function fakeRun(map) {
  return async (cmd, args) => {
    const key = (cmd + ' ' + (args || []).join(' ')).trim();
    for (const k of Object.keys(map)) {
      if (key.startsWith(k)) return map[k];
    }
    return { code: 1, stdout: '', stderr: 'not found' };
  };
}

async function main() {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-node-'));
  const nodeExe = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(nodeExe, '');
  fs.chmodSync(nodeExe, 0o755);

  // ---- C1 + C2 : PATH sans nodejs, dossier connu
  {
    const run = fakeRun({
      'where node': { code: 1, stdout: '', stderr: 'INFO: Could not find files' },
      'where npm': { code: 1, stdout: '', stderr: 'INFO: Could not find files' },
    });
    // On force les dossiers connus vers notre faux dossier d installation.
    const saved = dt.KNOWN_DIRS.node;
    dt.KNOWN_DIRS.node = [nodeDir];
    const res = await dt.detect(['node'], { run, pathValue: 'C:\\Windows\\System32', timeoutMs: 15000 });
    dt.KNOWN_DIRS.node = saved;
    const d0 = res.details[0];
    check('C1 le premier diagnostic trouve node hors du PATH (dossier connu)',
      res.found.node === nodeExe && res.outsidePath.indexOf('node') !== -1, JSON.stringify({ f: res.found, o: res.outsidePath }));
    const panel = fs.readFileSync(path.join(ROOT, 'sudo-ai-extension', 'src', 'panels', 'DoctorPanel.js'), 'utf8');
    check('C2 les details sont complets (commande, sortie, chemin, PATH, resolution)',
      ['command', 'stdout', 'resolved', 'pathUsed', 'how'].every((k) => Object.prototype.hasOwnProperty.call(d0, k)) &&
      d0.resolved === nodeExe && d0.how === 'dossier connu' &&
      /commande:/.test(panel) && /sortie:/.test(panel) && /chemin:/.test(panel) && /pathUtilise:/.test(panel),
      JSON.stringify(d0).slice(0, 220));
    check('C2b la ligne de journal nomme ce qui est trouve, absent et hors PATH',
      /trouves=1/.test(dt.journalLine(res)) && /hors_path=node/.test(dt.journalLine(res)), dt.journalLine(res));
  }

  // ---- C3 controle negatif : plus rien ne doit etre trouve
  {
    const run = fakeRun({});
    const saved = dt.KNOWN_DIRS.node;
    dt.KNOWN_DIRS.node = [path.join(os.tmpdir(), 'p71-inexistant')];
    const res = await dt.detect(['node'], { run, pathValue: 'C:\\vide', timeoutMs: 15000 });
    dt.KNOWN_DIRS.node = saved;
    check("C3 CONTROLE NEGATIF : PATH vide + dossier absent -> node ABSENT",
      res.missing.indexOf('node') !== -1 && !res.found.node, JSON.stringify(res.missing));
  }

  // ---- C3b : le PATH du processus complete le registre (faux positif P36)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-proc-'));
    const exe = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.writeFileSync(exe, '');
    if (process.platform !== 'win32') {
      // Comme sur un runner de CI : l outil est dans le PATH du PROCESSUS,
      // pas dans le registre. Il doit etre trouve SANS etre dit hors PATH.
      const savedPath = process.env.PATH;
      process.env.PATH = dir + (process.platform === 'win32' ? ';' : ':') + savedPath;
      const run = fakeRun({ 'which node': { code: 0, stdout: exe + '\n', stderr: '' } });
      const res = await dt.detect(['node'], { run, timeoutMs: 15000 });
      process.env.PATH = savedPath;
      check('C3b un outil present dans le PATH du processus est trouve et N EST PAS dit hors PATH',
        res.found.node === exe && res.outsidePath.length === 0, JSON.stringify({ f: res.found, o: res.outsidePath }));
    } else {
      check('C3b (Windows uniquement) verifie par le job p70-windows-path', true);
    }
  }

  // ---- C4 : reparation du PATH utilisateur, sans admin
  {
    const det = { found: { npm: 'C:\\Program Files\\nodejs\\npm.cmd' }, outsidePath: ['npm'], missing: [] };
    const plan = npmFix.planFix({ name: 'npm', detect: det });
    check('C4 installe mais hors PATH -> reparation, pas reinstallation',
      plan.code === 'repair_path' && plan.steps[0].kind === 'path', plan.code + ' ' + JSON.stringify(plan.steps));
    const rp = dt.planPathRepair('C:\\Program Files\\nodejs');
    check('C4b la reparation porte sur le PATH UTILISATEUR (aucun droit admin)',
      rp.ok && rp.scope === 'utilisateur' && /SetEnvironmentVariable\("Path", \$new, "User"\)/.test(rp.script),
      rp.scope);
  }

  // ---- D1 : deja installe
  {
    const r = await npmFix.runFix(npmFix.planFix({ name: 'npm', detect: { found: { npm: '/usr/bin/npm' }, outsidePath: [] } }),
      { redetect: async () => ({ found: { npm: '/usr/bin/npm' }, outsidePath: [] }) });
    check('D1 deja installe : aucun install, verification immediate',
      r.ok && r.code === 'already_ok', JSON.stringify(r).slice(0, 140));
  }

  // ---- D2 : hors PATH -> reparation puis verification
  {
    let repaired = null;
    const plan = npmFix.planFix({ name: 'npm', detect: { found: { npm: '/opt/node/npm' }, outsidePath: ['npm'] } });
    const r = await npmFix.runFix(plan, {
      repairPath: async (dir) => { repaired = dir; return { ok: true, message: 'PATH utilisateur mis a jour : ' + dir }; },
      redetect: async () => ({ found: { npm: '/opt/node/npm' }, outsidePath: [] }),
    });
    check('D2 reparation du PATH puis detection verifiee',
      repaired === '/opt/node' && r.ok && r.code === 'fixed_verified', JSON.stringify({ repaired, code: r.code }));
  }

  // ---- D3 : hors ligne sans installateur
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-inst-'));
    const plan = npmFix.planFix({ name: 'npm', detect: { found: {}, missing: ['npm'] }, offline: true, installersDir: dir, platform: 'win32' });
    check('D3 hors ligne sans installateur : message clair + dossier attendu',
      plan.ok === false && plan.code === 'offline_no_installer' && plan.message.indexOf(dir) !== -1,
      plan.message.slice(0, 160));
    fs.writeFileSync(path.join(dir, 'node-v20-x64.msi'), 'x');
    const plan2 = npmFix.planFix({ name: 'npm', detect: { found: {}, missing: ['npm'] }, offline: true, installersDir: dir, platform: 'win32' });
    check('D3b hors ligne AVEC installateur local : on l utilise',
      plan2.ok && plan2.code === 'install_offline' && plan2.steps[0].file.indexOf('node-v20-x64.msi') !== -1,
      JSON.stringify(plan2.steps));
  }

  // ---- D4/D5/D6 : issues d installation
  {
    const mk = () => npmFix.planFix({ name: 'node', detect: { found: {}, missing: ['node'] }, offline: false, platform: 'win32' });
    const failed = await npmFix.runFix(mk(), {
      exec: async () => ({ code: 1, stdout: 'network error: unable to resolve host', stderr: '' }),
    });
    check('D4 echec reseau : cause nommee, pas de faux succes',
      failed.ok === false && failed.code === 'install_failed' && /reseau/.test(failed.message), failed.message.slice(0, 120));

    const unverified = await npmFix.runFix(mk(), {
      exec: async () => ({ code: 0, stdout: 'installed', stderr: '' }),
      redetect: async () => ({ found: {}, missing: ['node'] }),
    });
    check("D5 installe mais detection muette : on dit NON VERIFIE (aucun 'termine' menteur)",
      unverified.ok === false && unverified.code === 'fixed_unverified' && /ne trouve toujours pas/.test(unverified.message),
      unverified.code);

    let asked = 0;
    const okRun = await npmFix.runFix(mk(), {
      exec: async () => { asked += 1; return { code: 0, stdout: 'installed', stderr: '' }; },
      redetect: async () => ({ found: { node: 'C:\\Program Files\\nodejs\\node.exe' }, outsidePath: [] }),
    });
    check('D6 CONTROLE NEGATIF : un succes exige une re-detection reussie',
      asked === 1 && okRun.ok && okRun.code === 'fixed_verified' && okRun.verified === true,
      JSON.stringify({ asked, code: okRun.code }));
  }

  // ---- C3c : le cas EXACT du runner Windows (where npm renvoie 2 entrees,
  // la premiere SANS extension et non executable sous Windows). Regression
  // vue dans la fumee du paquet : tool-npm=panel=ok:C:\...\node\20.20.2\ au
  // lieu de la version.
  {
    const dir = 'C:\\hostedtoolcache\\windows\\node\\20.20.2';
    const run = fakeRun({
      'where npm': { code: 0, stdout: dir + '\\npm\r\n' + dir + '\\npm.cmd\r\n', stderr: '' },
      [dir + '\\npm.cmd --version']: { code: 0, stdout: '10.8.2\r\n', stderr: '' },
      [dir + '\\npm --version']: { code: 1, stdout: '', stderr: 'not executable' },
    });
    const res = await dt.detect(['npm'], { run, timeoutMs: 5000, pathValue: dir, platform: 'win32' });
    const d = res.details[0];
    check('C3c npm : le candidat .cmd est prefere au fichier sans extension',
      res.found.npm === dir + '\\npm.cmd', 'resolu=' + res.found.npm);
    check('C3c npm : la VERSION est lue (plus de chemin affiche a la place)',
      d.version === '10.8.2', 'version=' + d.version);
  }

  // ---- C5 : sur un vrai Windows (job p70-windows-path), node/npm/git
  // installes et utilisables ne doivent JAMAIS etre dits "hors du PATH".
  if (process.platform === 'win32') {
    const real = await dt.detect(['node', 'npm', 'git'], { timeoutMs: 20000 });
    check('C5 Windows reel : node, npm et git sont trouves',
      !!real.found.node && !!real.found.npm && !!real.found.git, JSON.stringify(real.found));
    check('C5b Windows reel : aucun faux positif "hors du PATH"',
      real.outsidePath.length === 0, 'hors_path=' + real.outsidePath.join(',') + ' | source=' + JSON.stringify(real.sources));
  } else {
    check('C5 (Windows uniquement) joue par le job p70-windows-path', true);
  }

  console.log('');
  if (!fails.length) { console.log('P71 doctor + autofix npm: ' + pass + ' checks passed (all green)'); process.exit(0); }
  console.log('P71 doctor + autofix npm: ' + pass + ' checks passed, ' + fails.length + ' FAILED');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
