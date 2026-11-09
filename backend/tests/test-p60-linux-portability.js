// P60: Linux portability guard + platform paths + package manager + licence.
//
// A: no Windows-only string in a Linux EXECUTION path (C:, %LOCALAPPDATA%,
//    powershell, .exe, .bat, Start-Process, UAC, Inno Setup...). A hit is only
//    allowed on a line that is explicitly guarded for win32.
// B: platformPaths honours XDG and keeps the documented Linux layout.
// C: package manager detection + "never run without approval".
// D: Ed25519 licence verification is identical on Linux (dev key).
// E: the agent runs under ELECTRON_RUN_AS_NODE semantics (execPath + env only).
// ASCII only.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); }
  else { fail += 1; failures.push(name); console.log('FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); }
}

// ---------------------------------------------------------------- A. strings
// Files that RUN on Linux (server boot, logging, agent launch, doctor).
const RUNTIME_FILES = [
  'backend/server.js',
  'backend/crashHandler.js',
  'backend/models/user.model.js',
  'backend/utils/techLog.js',
  'backend/utils/platformPaths.js',
  'backend/routes/system.routes.js',
  'backend/doctor/linuxPackages.enterprise.js',
  'sudo-agent/src/server.js',
  'sudo-agent/src/platform.js',
  'sudo-agent/src/tools.js',
  'sudo-agent/src/loop.js',
  'sudo-ai-extension/src/agent/AgentServer.js',
];

// [pattern, label]. Case-insensitive except where noted.
const FORBIDDEN = [
  [/[A-Za-z]:\\\\?[A-Za-z]/, 'chemin Windows C:\\...'],
  [/%LOCALAPPDATA%/i, '%LOCALAPPDATA%'],
  [/powershell/i, 'powershell'],
  [/\.exe\b/i, '.exe'],
  [/\.bat\b/i, '.bat'],
  [/Start-Process/i, 'Start-Process'],
  [/\bUAC\b/, 'UAC'],
  [/Inno Setup/i, 'Inno Setup'],
  [/\bwinget\b/i, 'winget'],
];

// A line is tolerated when it is explicitly about Windows.
function guarded(line) {
  return /win32|isWindows|Windows|win32Only|platform === 'win32'|process\.platform/.test(line);
}

function scanFile(rel) {
  const abs = path.join(ROOT, rel);
  let txt = '';
  try { txt = fs.readFileSync(abs, 'utf8'); } catch (_) { return { rel, missing: true, hits: [] }; }
  const hits = [];
  txt.split(/\r?\n/).forEach((line, i) => {
    // Comments are documentation: a Windows mention there is not a path used
    // at run time. Code lines are what matter.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    if (isComment) return;
    for (const [re, label] of FORBIDDEN) {
      if (re.test(line) && !guarded(line)) {
        hits.push({ rel, line: i + 1, label, text: line.trim().slice(0, 160) });
      }
    }
  });
  return { rel, missing: false, hits };
}

const allHits = [];
let scanned = 0;
for (const rel of RUNTIME_FILES) {
  const r = scanFile(rel);
  if (r.missing) continue;
  scanned += 1;
  allHits.push(...r.hits);
}
check('A1 tous les fichiers d execution Linux sont presents', scanned === RUNTIME_FILES.length,
  scanned + '/' + RUNTIME_FILES.length);
if (allHits.length) {
  allHits.slice(0, 10).forEach((h) => console.log('  OFFENDER ' + h.rel + ':' + h.line + ' [' + h.label + '] ' + h.text));
}
check('A2 aucun chemin Windows non garde dans le code qui tourne sous Linux', allHits.length === 0,
  allHits.length + ' occurrence(s)');

// The guard must be able to FAIL: a synthetic file with a Windows path is caught.
const fake = path.join(os.tmpdir(), 'p60-fake-' + process.pid + '.js');
fs.writeFileSync(fake, "const p = 'C:\\\\Users\\\\x\\\\logs';\nrun('powershell -c x');\n");
(function () {
  const txt = fs.readFileSync(fake, 'utf8');
  let n = 0;
  txt.split('\n').forEach((line) => { FORBIDDEN.forEach(([re]) => { if (re.test(line)) n += 1; }); });
  check('A3 le garde detecte bien un fichier fautif (auto-test)', n >= 2, 'hits=' + n);
  fs.unlinkSync(fake);
})();

// ------------------------------------------------------------ B. XDG paths
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

delete require.cache[require.resolve('../utils/platformPaths')];
const ppPath = path.join(ROOT, 'backend', 'utils', 'platformPaths.js');
delete require.cache[ppPath];
const pp = require(ppPath);

withEnv({ SUDO_STUDIO_HOME: null, SUDO_STUDIO_LOGS: null, XDG_DATA_HOME: null, XDG_STATE_HOME: null }, () => {
  const logs = pp.logsDir({ platform: 'linux' });
  check('B1 Linux sans XDG : ~/.local/share/sudo-studio/logs',
    logs === path.join(os.homedir(), '.local', 'share', 'sudo-studio', 'logs'), logs);
});

withEnv({ SUDO_STUDIO_HOME: null, SUDO_STUDIO_LOGS: null, XDG_DATA_HOME: '/tmp/xdg-data', XDG_STATE_HOME: null }, () => {
  check('B2 Linux + XDG_DATA_HOME respecte', pp.dataDir({ platform: 'linux' }) === '/tmp/xdg-data/sudo-studio',
    pp.dataDir({ platform: 'linux' }));
});

withEnv({ SUDO_STUDIO_HOME: null, SUDO_STUDIO_LOGS: null, XDG_STATE_HOME: '/tmp/xdg-state', XDG_DATA_HOME: '/tmp/xdg-data' }, () => {
  check('B3 XDG_STATE_HOME prioritaire pour les journaux',
    pp.logsDir({ platform: 'linux' }) === '/tmp/xdg-state/sudo-studio/logs', pp.logsDir({ platform: 'linux' }));
});

withEnv({ SUDO_STUDIO_HOME: null, SUDO_STUDIO_LOGS: null, XDG_DATA_HOME: 'relatif/interdit', XDG_STATE_HOME: null }, () => {
  check('B4 un XDG relatif est ignore (spec)',
    pp.dataDir({ platform: 'linux' }) === path.join(os.homedir(), '.local', 'share', 'sudo-studio'),
    pp.dataDir({ platform: 'linux' }));
});

withEnv({ SUDO_STUDIO_HOME: '/tmp/portable-home', SUDO_STUDIO_LOGS: null, XDG_DATA_HOME: '/tmp/xdg-data' }, () => {
  check('B5 SUDO_STUDIO_HOME gagne sur XDG (lanceur portable)',
    pp.dataDir({ platform: 'linux' }) === '/tmp/portable-home', pp.dataDir({ platform: 'linux' }));
});

withEnv({ SUDO_STUDIO_HOME: null, SUDO_STUDIO_LOGS: '/tmp/explicit-logs' }, () => {
  check('B6 SUDO_STUDIO_LOGS gagne sur tout', pp.logsDir({ platform: 'linux' }) === '/tmp/explicit-logs');
});

check('B7 modeles et installateurs inchanges (~/.sudo_studio)',
  pp.modelsDir({ platform: 'linux' }).indexOf('.sudo_studio/models') !== -1 &&
  pp.installersDir({ platform: 'linux' }).indexOf('.sudo_studio/installers') !== -1);
check('B8 Windows garde %LOCALAPPDATA%\\SudoStudio\\logs',
  pp.logsDir({ platform: 'win32', dir: null }).indexOf(path.join('SudoStudio', 'logs')) !== -1,
  pp.logsDir({ platform: 'win32' }));

// Une ligne de demarrage est bien ecrite dans le dossier Linux attendu.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p60-home-'));
withEnv({ SUDO_STUDIO_HOME: tmpHome, SUDO_STUDIO_LOGS: null }, () => {
  const r = pp.writeStartupLine('test demarrage');
  const f = path.join(tmpHome, 'logs', 'startup.log');
  check('B9 journal de demarrage ecrit dans le dossier attendu', r.ok && fs.existsSync(f), r.dir);
  const line = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check('B10 la ligne contient la date et le texte', /\[launcher\] test demarrage/.test(line), line.slice(0, 80));
});

// ------------------------------------------------- C. packages (no silent sudo)
const lp = require(path.join(ROOT, 'backend', 'doctor', 'linuxPackages.enterprise.js'));
const detApt = { platform: 'linux', supported: true, manager: 'apt', isRoot: false, pkexec: true, sudo: true, elevation: 'pkexec' };
const s = lp.suggest('git', { detected: detApt });
check('C1 suggestion apt exacte', s.ok && s.install === 'pkexec apt install -y git', s.install);
check('C2 l elevation est signalee a l utilisateur', s.approvalRequired === true);
const detRoot = { platform: 'linux', supported: true, manager: 'dnf', isRoot: true, pkexec: false, sudo: false, elevation: 'root' };
const s2 = lp.suggest('python', { detected: detRoot });
check('C3 dnf sans elevation quand root', s2.ok && s2.install === 'dnf install -y python3 python3-pip', s2.install);
const noApprove = lp.runApproved('git', { detected: detApt });
check('C4 SANS approbation rien n est execute', noApprove.executed === false && noApprove.code === 'approval_required');
const elev = lp.runApproved('git', { detected: detApt, approve: true });
check('C5 approbation seule ne suffit pas si elevation non autorisee',
  elev.executed === false && elev.code === 'elevation_required', elev.code);
const noMgr = lp.suggest('git', { detected: { platform: 'linux', supported: false, manager: null, reason: 'aucun' } });
check('C6 sans gestionnaire : message honnete, pas de commande inventee', noMgr.ok === false && noMgr.code === 'no_manager');
const flutter = lp.suggest('flutter', { detected: detApt });
check('C7 SDK hors depots : renvoie la procedure manuelle', flutter.ok === false && /site officiel/.test(String(flutter.error)));
check('C8 Windows n est pas casse : detect() garde le chemin winget',
  /winget/.test(lp.detect({ platform: 'win32' }).reason));

// -------------------------------------------------- D. licence Ed25519 Linux
const lic = require(path.join(ROOT, 'backend', 'src', 'license', 'license.js'));
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
check('D1 la licence expose une cle publique Ed25519 (32 octets)',
  typeof lic.PRODUCT_PUBLIC_KEY_SPKI_B64 === 'string' &&
  Buffer.from(lic.PRODUCT_PUBLIC_KEY_SPKI_B64, 'base64').length === 44,
  Buffer.from(lic.PRODUCT_PUBLIC_KEY_SPKI_B64 || '', 'base64').length);
// Signature Ed25519 verifiee sur Linux avec un couple de test (meme algo).
const msg = Buffer.from('sudo-studio-dev-license|enterprise|2027-01-01');
const sig = crypto.sign(null, msg, privateKey);
check('D2 Ed25519 : une signature valide est acceptee', crypto.verify(null, msg, publicKey, sig));
check('D3 Ed25519 : une signature alteree est refusee',
  crypto.verify(null, Buffer.from(msg.toString() + 'x'), publicKey, sig) === false);
check('D4 base64url de licence disponible (memes fonctions sous Linux)',
  typeof lic.b64uEncode === 'function' && lic.b64uDecode(lic.b64uEncode(Buffer.from('abc'))).toString() === 'abc');
check('D5 verification d une cle de licence invalide : refus, jamais une exception',
  (function () { try { const v = lic.verifyLicenseKey('SDS-0000-0000-0000-0000'); return v && v.valid === false; } catch (e) { return false; } })());

// -------------------------------------- E. agent: ELECTRON_RUN_AS_NODE path
const agentServerSrc = fs.readFileSync(path.join(ROOT, 'sudo-ai-extension', 'src', 'agent', 'AgentServer.js'), 'utf8');
check('E1 l agent est lance avec process.execPath (jamais un node du PATH)',
  /process\.execPath/.test(agentServerSrc) && /SUDO_AGENT_NODE/.test(agentServerSrc));
check('E2 ELECTRON_RUN_AS_NODE est pose pour le mode Node de l editeur',
  /ELECTRON_RUN_AS_NODE/.test(agentServerSrc));
check('E3 le jeton passe par l environnement, pas par la ligne de commande',
  /SUDO_AGENT_TOKEN/.test(agentServerSrc) && !/--token/.test(agentServerSrc));
check('E4 hote loopback uniquement', /127\.0\.0\.1/.test(agentServerSrc));

console.log('\n---');
console.log('P60: ' + pass + '/' + (pass + fail) + ' passed' + (fail ? ' | FAILS: ' + failures.join(', ') : ''));
process.exit(fail ? 1 : 0);
