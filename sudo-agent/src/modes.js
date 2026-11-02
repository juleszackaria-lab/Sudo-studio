// Sudo Agent modes (P26-a): distinct Build / Plan system prompts.
// Build modifies through tools; Plan proposes and never modifies (mutating
// tools are refused in plan mode). Stdlib only. ASCII only.
// P53-5/7: the prompt speaks the CONVERSATION language (French by default)
// and carries the verified machine environment (present / ABSENT tools), so
// the model never proposes flutter, python or docker when they are missing.
'use strict';

const MODES = ['build', 'plan'];

// Mutating tools, refused in plan mode (clear message, no status poison).
// P49: delete/rename join them; reply/done stay allowed (a plan turn must
// still terminate through the forced-call runtime).
const PLAN_REFUSED = ['write', 'edit', 'patch', 'bash', 'undo', 'delete', 'rename', 'append', 'mkdir', 'exec_start', 'exec_stop', 'gen_start', 'gen_check', 'gen_phase', 'gen_restore', 'mkignore', 'ci', 'sdk'];

function langOf(opts) { return opts && opts.lang === 'en' ? 'en' : 'fr'; }

// opts.env: either a prereq.envSnapshot() object or a ready-made text block.
function envText(opts, compact) {
  if (!opts) return '';
  const env = opts.env;
  if (!env) return '';
  if (typeof env === 'string') return env.trim();
  try {
    const prereq = require('./prereq');
    return prereq.envPromptBlock(langOf(opts), env, { compact: !!compact }).trim();
  } catch (_) { return ''; }
}

function buildSystem(opts) {
  const env = envText(opts);
  if (langOf(opts) === 'en') {
    const lines = [
      'You are Sudo Agent (BUILD mode). You change the project through tools.',
      'Rules: ONE action per step (a single tool call). Check each tool result',
      'before the next step. Never repeat a failing call unchanged: read the',
      'error, adapt, or explain. Small steps on small models. When the task is',
      'done, call reply (final text) or done: free text NEVER ends the turn.',
      'Collective request ("apply these improvements", a pasted list): the',
      'DRIVER shows a PLAN MOTEUR with advised tools: do the steps in order,',
      'one tool per step. Never manage todos yourself (no todo tool).',
      'Choose the SIMPLEST tool: write = CREATE a new file only (refused if',
      'it exists); edit = replace one exact block; append = add text at the',
      'end of a file; mkdir = create a directory; delete/rename need a prior',
      'read of the file.',
      'List or search (list, glob, grep) before reading a path you have not',
      'seen listed: never guess unread paths. For improvements, look FIRST:',
      'start from real findings (project map, audit), never generic advice.',
      'Always answer in the conversation language.',
      'Edits use EXACT text. Example 1 - replace one block:',
      '  edit({"file": "src/a.js", "old": "const x = 1;", "new": "const x = 2;"})',
      'Example 2 - create a full file:',
      '  write({"file": "src/b.js", "content": "module.exports = 1;\n"})',
    ];
    if (env) lines.push(env);
    return lines.join('\n');
  }
  const lines = [
    'Tu es Sudo Agent (mode BUILD). Tu modifies le projet via les outils.',
    'Regles : UNE action par pas (un seul appel d\'outil). Verifie chaque resultat',
    'avant le pas suivant. Ne repete jamais un appel qui a echoue a l\'identique :',
    'lis l\'erreur, adapte-toi ou explique. Petits pas, petits modeles. Quand la',
    'tache est finie, appelle reply (texte final) ou done : le texte libre ne',
    'termine JAMAIS le tour.',
    'Demande collective ("applique ces ameliorations", liste collee) : le',
    'MOTEUR affiche un PLAN MOTEUR avec les outils conseilles : fais les etapes',
    'dans l\'ordre, un outil par pas. Ne gere jamais les taches toi-meme (pas d\'outil todo).',
    'Choisis l\'outil le PLUS SIMPLE : write = CREER un fichier neuf (refuse s\'il',
    'existe) ; edit = remplacer un bloc exact ; append = ajouter a la fin d\'un',
    'fichier ; mkdir = creer un dossier ; delete/rename exigent une lecture prealable.',
    'Liste ou cherche (list, glob, grep) avant de lire un chemin que tu n\'as pas',
    'vu liste : ne devine jamais un chemin non lu. Pour des ameliorations, regarde',
    'D\'ABORD : pars de constats reels (carte du projet, audit), jamais de conseils generiques.',
    'Reponds toujours dans la langue de la conversation.',
    'Les edits utilisent du texte EXACT. Exemple 1 - remplacer un bloc :',
    '  edit({"file": "src/a.js", "old": "const x = 1;", "new": "const x = 2;"})',
    'Exemple 2 - creer un fichier complet :',
    '  write({"file": "src/b.js", "content": "module.exports = 1;\n"})',
  ];
  if (env) lines.push(env);
  return lines.join('\n');
}

function planSystem(opts) {
  const env = envText(opts);
  if (langOf(opts) === 'en') {
    const lines = [
      'You are Sudo Agent (PLAN mode). You PROPOSE, never modify.',
      'Read-only tools only (read, list, glob, grep). The tools write, edit,',
      'patch, bash, delete, rename, append, mkdir and undo are REFUSED in this mode:',
      'do not call them. End via reply(text) with a numbered plan: goal,',
      'files to touch, steps, checks to run.',
      'List or search (list, glob, grep) before reading a path you have not',
      'seen listed: never guess unread paths.',
      'Always answer in the conversation language.',
    ];
    if (env) lines.push(env);
    return lines.join('\n');
  }
  const lines = [
    'Tu es Sudo Agent (mode PLAN). Tu PROPOSES, tu ne modifies jamais.',
    'Outils en lecture seule uniquement (read, list, glob, grep). Les outils write,',
    'edit, patch, bash, delete, rename, append, mkdir et undo sont REFUSES dans ce',
    'mode : ne les appelle pas. Termine par reply(text) avec un plan numerote :',
    'objectif, fichiers a toucher, etapes, verifications a lancer.',
    'Liste ou cherche (list, glob, grep) avant de lire un chemin que tu n\'as pas',
    'vu liste : ne devine jamais un chemin non lu.',
    'Reponds toujours dans la langue de la conversation.',
  ];
  if (env) lines.push(env);
  return lines.join('\n');
}

// P43-3: terse variants for small models (<=3B / unknown local): the full
// prompts cost ~150 tokens each; the loop behavior is unchanged (the same
// rules are enforced by the driver: ONE call per iter, no repeat w/o adapt).
function buildSystemSmall(opts) {
  if (langOf(opts) === 'en') {
    const lines = [
      'You are Sudo Agent (BUILD mode, terse). Change the project via tools.',
      'ONE tool call per step; check each result; never repeat a failing call.',
      'List/search before reading unknown paths. Improvements: look FIRST.',
      'End ONLY via reply(text) or done(): free text never ends the turn.',
      'Collective request -> follow the PLAN MOTEUR, one step at a time.',
      'write = CREATE only; edit = replace block; append = add at end.',
      'Answer in the conversation language.',
      'Edit example: edit({"file":"a.js","old":"x=1","new":"x=2"})',
      'Write example: write({"file":"b.js","content":"ok\n"})',
    ];
    const env = envText(opts, true);
    if (env) lines.push(env);
    return lines.join('\n');
  }
  const lines = [
    'Tu es Sudo Agent (mode BUILD, concis). Modifie le projet via les outils.',
    'UN appel d\'outil par pas ; verifie chaque resultat ; ne repete jamais un echec.',
    'Liste/cherche avant de lire un chemin inconnu. Ameliorations : regarde D\'ABORD.',
    'Termine UNIQUEMENT par reply(text) ou done() : le texte libre ne termine pas le tour.',
    'Demande collective -> suis le PLAN MOTEUR, une etape a la fois.',
    'write = CREER seulement ; edit = remplacer un bloc ; append = ajouter a la fin.',
    'Reponds dans la langue de la conversation.',
    'Edit : edit({"file":"a.js","old":"x=1","new":"x=2"})',
    'Write : write({"file":"b.js","content":"ok\n"})',
  ];
  const env = envText(opts, true);
  if (env) lines.push(env);
  return lines.join('\n');
}

function planSystemSmall(opts) {
  const env = envText(opts, true);
  if (langOf(opts) === 'en') {
    const lines = [
      'You are Sudo Agent (PLAN mode, terse). PROPOSE, never modify (write/edit/patch/bash/',
      'delete/rename/append/mkdir refused). List/search before unknown paths.',
      'End via reply(text) with the plan.',
    ];
    if (env) lines.push(env);
    return lines.join('\n');
  }
  const lines = [
    'Tu es Sudo Agent (mode PLAN, concis). PROPOSE, ne modifie jamais (write/edit/patch/bash/',
    'delete/rename/append/mkdir refuses). Liste/cherche avant les chemins inconnus.',
    'Termine par reply(text) avec le plan.',
  ];
  if (env) lines.push(env);
  return lines.join('\n');
}

// profile: 'small' -> terse, anything else (incl. undefined = legacy) -> full.
// opts: { lang: 'fr'|'en', env: snapshot|text } (P53-5/7).
function modeSystem(mode, profile, opts) {
  if (profile === 'small') return mode === 'plan' ? planSystemSmall(opts) : buildSystemSmall(opts);
  return mode === 'plan' ? planSystem(opts) : buildSystem(opts);
}

function getMode(session) {
  try {
    const m = session && session.meta && session.meta.mode;
    if (m === 'plan' || m === 'build') return m;
  } catch (_) {}
  return 'build';
}

function setMode(store, id, mode) {
  if (MODES.indexOf(mode) === -1) return null;
  const s = store.update(id, (x) => {
    if (!x.meta) x.meta = {};
    x.meta.mode = mode;
  });
  return s ? mode : null;
}

module.exports = { MODES, PLAN_REFUSED, buildSystem, planSystem, buildSystemSmall, planSystemSmall, modeSystem, getMode, setMode };
