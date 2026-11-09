/**
 * SUDO STUDIO - P60: Linux package-manager awareness for Doctor / AutoFix.
 *
 * Windows Doctor used winget + PowerShell + UAC. None of that exists on
 * Linux, so this module answers the same questions the honest way:
 *
 *   detect()          which manager is really installed (apt, dnf, yum, zypper,
 *                     pacman, apk) and whether root is available;
 *   suggest(id)       the EXACT command line for a known SDK on THIS machine,
 *                     plus the offline alternative when one exists;
 *   buildCommand()    what would be run, with pkexec when elevation is needed;
 *   runApproved()     executes ONLY when the operator passed approve:true.
 *                     Without it, nothing runs - the command is returned for
 *                     the user to copy. There is no silent sudo, ever.
 *
 * Pure Node (child_process/fs), no shell interpolation of user data: the
 * command is built from a fixed table keyed by an id.
 * ASCII only.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

// id -> { name, apt, dnf, zypper, pacman, apk, check }
const PACKAGES = {
  git: { name: 'Git', apt: 'git', dnf: 'git', zypper: 'git', pacman: 'git', apk: 'git', check: 'git --version' },
  node: { name: 'Node.js', apt: 'nodejs npm', dnf: 'nodejs npm', zypper: 'nodejs npm', pacman: 'nodejs npm', apk: 'nodejs npm', check: 'node --version' },
  python: {
    name: 'Python 3', apt: 'python3 python3-pip python3-venv', dnf: 'python3 python3-pip',
    zypper: 'python3 python3-pip', pacman: 'python python-pip', apk: 'python3 py3-pip', check: 'python3 --version',
  },
  docker: { name: 'Docker', apt: 'docker.io', dnf: 'docker', zypper: 'docker', pacman: 'docker', apk: 'docker', check: 'docker --version' },
  java: { name: 'Java JDK', apt: 'default-jdk', dnf: 'java-17-openjdk-devel', zypper: 'java-17-openjdk-devel', pacman: 'jdk-openjdk', apk: 'openjdk17', check: 'java -version' },
  go: { name: 'Go', apt: 'golang', dnf: 'golang', zypper: 'go', pacman: 'go', apk: 'go', check: 'go version' },
  rust: { name: 'Rust', apt: 'rustc cargo', dnf: 'rust cargo', zypper: 'rust cargo', pacman: 'rust', apk: 'rust cargo', check: 'rustc --version' },
  flutter: {
    name: 'Flutter', apt: null, dnf: null, zypper: null, pacman: null, apk: null, check: 'flutter --version',
    manual: 'Flutter ne vient pas des depots systeme : telechargez le SDK sur le site officiel, puis ajoutez flutter/bin au PATH.',
  },
  dotnet: { name: '.NET SDK', apt: 'dotnet-sdk-8.0', dnf: 'dotnet-sdk-8.0', zypper: 'dotnet-sdk-8.0', pacman: 'dotnet-sdk', apk: 'dotnet8-sdk', check: 'dotnet --version' },
};

// Manager -> { install: [...], remove: [...], query: [...] }
function managerSpec(pm, pkgs) {
  switch (pm) {
    case 'apt': return { install: ['install', '-y', ...pkgs], remove: ['remove', '-y', ...pkgs] };
    case 'dnf': return { install: ['install', '-y', ...pkgs], remove: ['remove', '-y', ...pkgs] };
    case 'yum': return { install: ['install', '-y', ...pkgs], remove: ['remove', '-y', ...pkgs] };
    case 'zypper': return { install: ['install', '-y', ...pkgs], remove: ['remove', '-y', ...pkgs] };
    case 'pacman': return { install: ['-S', '--noconfirm', ...pkgs], remove: ['-R', '--noconfirm', ...pkgs] };
    case 'apk': return { install: ['add', ...pkgs], remove: ['del', ...pkgs] };
    default: return null;
  }
}

const MANAGERS = ['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk'];

function which(bin) {
  try {
    const out = execFileSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8', timeout: 3000 });
    return String(out).trim() || null;
  } catch (_) { return null; }
}

/** Real detection: which manager exists, am I root, is pkexec/sudo usable. */
function detect(opts) {
  opts = opts || {};
  const whichFn = typeof opts.which === 'function' ? opts.which : which;
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    return { platform, supported: false, manager: null,
      reason: 'Windows: winget/PowerShell gerent les installations (chemin inchange).' };
  }
  if (platform === 'darwin') {
    return { platform, supported: false, manager: null, reason: 'macOS: utilisez Homebrew, non gere automatiquement.' };
  }
  let manager = null;
  for (const m of MANAGERS) {
    if (whichFn(m)) { manager = m; break; }
  }
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  const pkexec = !!whichFn('pkexec');
  const sudo = !!whichFn('sudo');
  return {
    platform, supported: !!manager, manager, isRoot, pkexec, sudo,
    elevation: isRoot ? 'root' : (pkexec ? 'pkexec' : (sudo ? 'sudo' : 'none')),
    reason: manager ? ('gestionnaire detecte : ' + manager) : 'aucun gestionnaire connu (apt/dnf/yum/zypper/pacman/apk)',
  };
}

/** Exact commands for one id. Returns { ok, id, name, install, remove, check, notes }. */
function suggest(id, opts) {
  opts = opts || {};
  const d = opts.detected || detect(opts);
  const p = PACKAGES[id];
  if (!p) return { ok: false, code: 'unknown_id', error: 'SDK inconnu : ' + String(id).slice(0, 40) };
  if (!d.supported) {
    return { ok: false, code: 'no_manager', id, name: p.name, error: d.reason, check: p.check, manual: p.manual || null };
  }
  const pkgs = p[d.manager];
  if (!pkgs) {
    return { ok: false, code: 'not_in_repos', id, name: p.name, manager: d.manager,
      error: p.manual || (p.name + ' n est pas disponible via ' + d.manager), check: p.check };
  }
  const list = pkgs.split(' ');
  const spec = managerSpec(d.manager, list);
  const elev = d.isRoot ? [] : (d.pkexec ? ['pkexec'] : (d.sudo ? ['sudo'] : []));
  const installArgv = elev.concat([d.manager], spec.install);
  const removeArgv = elev.concat([d.manager], spec.remove);
  return {
    ok: true, id, name: p.name, manager: d.manager, elevation: d.elevation,
    packages: list,
    install: installArgv.join(' '),
    remove: removeArgv.join(' '),
    check: p.check,
    // The GUI shows this: no silent elevation, the user sees the exact command.
    approvalRequired: elev.length > 0 || !d.isRoot,
    offline: d.manager === 'apt' ? ('apt-get install --no-download ' + list.join(' ') + ' (depot local)') : null,
  };
}

/**
 * Execute ONLY with an explicit approval from the operator.
 * opts: { approve:boolean, timeoutMs }. Without approve=true: no execution.
 */
function runApproved(id, opts) {
  opts = opts || {};
  const s = suggest(id, opts);
  if (!s.ok) return Object.assign({ executed: false }, s);
  if (opts.approve !== true) {
    return Object.assign({ executed: false, code: 'approval_required',
      error: 'approbation explicite requise : aucune commande n a ete lancee.' }, s);
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !opts.allowElevation) {
    return Object.assign({ executed: false, code: 'elevation_required',
      error: 'elevation necessaire : lancez la commande affichee (ou approuvez l elevation).' }, s);
  }
  try {
    const out = execFileSync('sh', ['-c', s.install], { encoding: 'utf8', timeout: opts.timeoutMs || 300000 });
    return Object.assign({ executed: true, ok: true, output: String(out).slice(-2000) }, s);
  } catch (e) {
    return Object.assign({ executed: true, ok: false, error: String((e && e.message) || e).slice(0, 400) }, s);
  }
}

function list() {
  return Object.keys(PACKAGES).map((k) => ({ id: k, name: PACKAGES[k].name, check: PACKAGES[k].check }));
}

module.exports = { detect, suggest, runApproved, list, PACKAGES, MANAGERS, managerSpec };
