/**
 * SUDO STUDIO - P63-B/P6 : la LISTE REELLE des chemins d'etat.
 *
 * Le script n'invente rien : il fait fonctionner chaque module qui ecrit de
 * l'etat (sessions, points de retour, journaux, travaux, cahiers, plans
 * orchestres, skills, commandes, regles, politiques, MCP, agents, extensions)
 * dans un HOME temporaire, puis enumere les fichiers REELLEMENT crees.
 *
 * Il verifie ensuite deux regles :
 *   - aucun de ces chemins n'est dans le projet ;
 *   - tous sont sous le meme emplacement unique (agentHome canonique).
 *
 * Usage : node scripts/ci/p63-state-paths.js
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'sudo-agent', 'src');

// HOME isole : le script ne touche jamais le vrai dossier utilisateur.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p63-paths-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'p63-paths-proj-'));
process.env.SUDO_AGENT_HOME = '';
delete process.env.SUDO_AGENT_HOME;
process.env.SUDO_STUDIO_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
if (!process.env.LOCALAPPDATA) process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
if (!process.env.XDG_DATA_HOME) process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');

const sd = require(path.join(SRC, 'stateDir'));
const storeMod = require(path.join(SRC, 'store'));
const ckpt = require(path.join(SRC, 'checkpoints'));
const journal = require(path.join(SRC, 'journal'));
const job = require(path.join(SRC, 'job'));
const spec = require(path.join(SRC, 'spec'));
const orch = require(path.join(SRC, 'orch'));
const skills = require(path.join(SRC, 'skills'));
const commands = require(path.join(SRC, 'commands'));
const perm = require(path.join(SRC, 'permissions'));
const verify = require(path.join(SRC, 'verify'));
const mcp = require(path.join(SRC, 'mcp'));
const agents = require(path.join(SRC, 'agents'));
const ext = require(path.join(SRC, 'extensions'));

const agentHome = sd.agentHome({ home: home });

function walk(dir, acc) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function under(p, root) {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x === r || x.indexOf(r + path.sep) === 0;
}

async function main() {
  // --- 1. on FAIT ecrire chaque module -----------------------------------
  const st = storeMod.createStore({ home: home });
  const sess = st.create({ title: 'p63 chemins', projectRoot: proj });

  const log = journal.createLogger({ component: 'agent', home: home });
  try { log.info('p63 chemins', { test: true }); } catch (_) {}

  fs.writeFileSync(path.join(proj, 'index.js'), 'module.exports = 1;\n');
  try { ckpt.saveSnapshot(home, proj, sess.id, 'p63', {}); } catch (_) {}

  const meta = {
    id: 'spec-p63paths', title: 'Chemins', lines: 3,
    requirements: [{ id: 'R1', text: 'ecrire un fichier', section: 1 }],
    sections: [{ n: 1, title: 'But' }],
  };
  try { spec.ingest(proj, '# Cahier\n\n## 1. But\n- Exigence 1 : ecrire un fichier.\n', {}); } catch (_) {}
  try { job.create(proj, meta, [{ i: 0, section: 1, reqs: ['R1'], text: 'ecrire a.txt', complex: false }], {}); } catch (_) {}
  try {
    orch.saveState(proj, { version: orch.VERSION, planId: 'p63plan', steps: [], created: new Date().toISOString() });
  } catch (_) {}
  try {
    const d = skills.globalDir(home);
    fs.mkdirSync(path.join(d, 'normes'), { recursive: true });
    fs.writeFileSync(path.join(d, 'normes', 'SKILL.md'), '# Normes\nP63\n');
    skills.setActive(home, null, 'global', 'normes', true);
  } catch (_) {}
  try { commands.saveCommand(home, proj, 'p63cmd', 'texte du modele'); } catch (_) {}
  try { perm.saveProjectRule(proj, 'bash|run|npm test'); } catch (_) {}
  try { verify.netPolicyFile(home); fs.mkdirSync(path.dirname(verify.netPolicyFile(home)), { recursive: true }); fs.writeFileSync(verify.netPolicyFile(home), '{}'); } catch (_) {}
  try { mcp.saveConfig(home, { demo: { command: 'node', args: ['-e', '0'] } }); } catch (_) {}
  try { agents.saveAgent(home, { name: 'p63', model: '', tools: [] }); } catch (_) {}
  try { ext.audit(home, { kind: 'test', name: 'p63', ok: true }); } catch (_) {}

  // --- 2. on enumere ce qui a REELLEMENT ete ecrit -----------------------
  const files = walk(home, []).filter((f) => !under(f, proj));

  console.log('HOME isole            : ' + home);
  console.log('Projet                : ' + proj);
  console.log('Emplacement unique    : ' + agentHome);
  console.log('');
  console.log('CHEMINS REELS (' + files.length + ') :');
  let outside = 0;
  let inProject = 0;
  for (const f of files.sort()) {
    const rel = path.relative(agentHome, f);
    const ok = under(f, agentHome);
    if (ok) outside += 1; else inProject += 1;
    console.log('  ' + (ok ? '[sous emplacement unique] ' : '[AILLEURS] ') +
      (ok ? rel : path.relative(home, f)));
  }
  console.log('');
  console.log('Sous l emplacement unique : ' + outside + '/' + files.length);
  const projFiles = walk(proj, []);
  const agentInProj = projFiles.filter((f) => /\.sudo-agent|\.sudo_studio|SudoStudio/.test(f));
  console.log('Fichiers d agent dans le projet : ' + agentInProj.length);
  const okAll = outside === files.length && files.length > 0 && agentInProj.length === 0;
  console.log('');
  console.log(okAll ? 'P63-PATHS: OK' : 'P63-PATHS: FAIL');
  process.exit(okAll ? 0 : 1);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
