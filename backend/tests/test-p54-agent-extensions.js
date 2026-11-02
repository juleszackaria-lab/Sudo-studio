// MISSION P54 - Agent Extensions : page unique (MCP / Skills / Commands /
// Agents / Rules), export-import de la configuration complete, tolerance au
// hors-ligne et compatibilite avec la boucle de taches pilotee par le moteur.
//
// Preuves deterministes locales (fournisseur factice, home temporaire, projet
// temporaire, serveur MCP echo local). Tout ce qui exige le paquet INSTALLE
// (Windows, Internet, jeton distant) n'est PAS prouve ici : voir le rapport.
//
// Groups:
//   A commandes personnalisees (/nom)          B agents personnalises + regles
//   C AGENTS.md (diff + confirmation)          D MCP (etat, exposition, outils)
//   E competences (descriptions seules)        F page (statique + rendu HTML)
//   G hors ligne / boucle moteur               H export-import global + routes
// Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const Module = require('module');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');
const EXT = path.join(ROOT, 'sudo-ai-extension');
const HOST = '127.0.0.1';

process.env.SUDO_AGENT_CTX_TOKENS = '32768';

const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));
const commands = require(path.join(AGENT_SRC, 'commands.js'));
const agents = require(path.join(AGENT_SRC, 'agents.js'));
const rules = require(path.join(AGENT_SRC, 'rules.js'));
const mcp = require(path.join(AGENT_SRC, 'mcp.js'));
const skills = require(path.join(AGENT_SRC, 'skills.js'));
const toolsMod = require(path.join(AGENT_SRC, 'tools.js'));
const serverMod = require(path.join(AGENT_SRC, 'server.js'));

// Competitor assistant products must never appear in the sources (the plain
// technical word for a text caret is not a product name).
const BRANDS = ['op' + 'encode', 'cur' + 'sor.sh', 'cur' + 'sor.com', 'cur' + 'sor ai',
  'cline', 'windsurf', 'augmentcode', 'tabnine', 'sourcegraph'];
const PRODUCT_FILES = [
  'commands.js', 'agents.js', 'rules.js', 'mcp.js', 'skills.js', 'tools.js', 'loop.js', 'server.js',
];
const PANEL = path.join(EXT, 'src', 'panels', 'AgentExtensionsPanel.js');

let PASS = 0;
const FAILS = [];
const REGISTRY = [];
function t(name, fn) { REGISTRY.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

const call = (name, args) => ({ toolCalls: [{ id: 'c-' + name + '-' + Math.random().toString(36).slice(2, 8), name, args: args || {} }] });

// -- fake provider ----------------------------------------------------------
function mockProvider(responses) {
  const chats = [];
  const queue = (responses || []).slice();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', n_ctx: 8192 }] }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        chats.push(body);
        const next = queue.length ? queue.shift() : { content: 'ok' };
        if (body && body.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: String(next.content || '') } }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        const msg = { content: next.content === undefined ? '' : next.content };
        if (next.toolCalls) {
          msg.tool_calls = next.toolCalls.map((tc, i) => ({ id: tc.id || ('call-' + chats.length + '-' + i),
            type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: msg }] }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, HOST, () => resolve({
      server: srv, port: srv.address().port, chats,
      close: () => new Promise((r) => srv.close(() => r())),
    }));
  });
}

// -- world (home + project + session) ---------------------------------------
function project(kind) {
  const dir = tmp('p54proj');
  if (kind === 'node') {
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-p54', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo P54\nligne un\nligne deux\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'module.exports = 1;\n', 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Vide\n', 'utf8');
  }
  return dir;
}

function world(proj) {
  const home = tmp('p54home');
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const s = store.create({ title: 't', projectRoot: proj });
  const sessionRules = new Map();
  sessionRules.set(s.id, new Set());
  const w = { proj, home, logsDir, log, store, sessionId: s.id, sessionRules };
  w.toolsCtx = () => ({ home, sessionRules, pending: new Map(), log, corr: 'p54' });
  w.turn = async (prompt, responses, opts) => {
    opts = opts || {};
    const mock = await mockProvider(responses);
    const events = [];
    try {
      const out = await runTurn({
        store, sessionId: s.id, prompt, corr: opts.corr || 'p54',
        provider: { type: 'local', baseUrl: 'http://' + HOST + ':' + mock.port, model: opts.model || 'mock-model' },
        toolsCtx: w.toolsCtx(), runs: new Map(), log,
        onEvent: (e) => { try { events.push(e); } catch (_) {} },
        maxIt: opts.maxIt || 3,
      });
      const end = store.get(s.id);
      let journal = '';
      try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
      return { out, events, chats: mock.chats, journal, end,
        text: String(((end.messages || [])[end.messages.length - 1] || {}).content || '') };
    } finally { await mock.close(); }
  };
  return w;
}

// -- local MCP echo server --------------------------------------------------
function echoServer() {
  const f = path.join(tmp('p54mcp'), 'echo.js');
  fs.writeFileSync(f, [
    "'use strict';",
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c;',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) !== -1) {',
    '    const line = buf.slice(0, nl).trim();',
    '    buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    let m = null;',
    '    try { m = JSON.parse(line); } catch (_) { continue; }',
    '    if (m.id === undefined) continue;',
    '    let result = {};',
    '    if (m.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "echo", version: "1" } };',
    '    else if (m.method === "tools/list") result = { tools: [{ name: "echo", description: "repeat", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };',
    '    else if (m.method === "tools/call") result = { content: [{ type: "text", text: "echo:" + ((m.params && m.params.arguments && m.params.arguments.text) || "") }] };',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");',
    '  }',
    '});',
    '',
  ].join('\n'), 'utf8');
  return f;
}

function agentFile(home, name, obj) {
  const d = path.join(home, '.sudo_studio', 'agent');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), JSON.stringify(obj), 'utf8');
}

// ===========================================================================
// A - commandes personnalisees
// ===========================================================================
t('A1 commande /nom : arguments ($1, ${nom}, {{nom}}), portees, echecs honnetes', () => {
  const home = tmp('p54cmd');
  const proj = project('node');
  const sv = commands.saveCommand(home, proj, 'global', 'revue', 'Relit un fichier',
    'Relis ${file} et concentre-toi sur ${focus}. Note : $1 puis $ARGS.', ['file', 'focus']);
  assert(sv.ok === true && sv.scope === 'global', 'enregistrement: ' + JSON.stringify(sv));
  // project scope SHADOWS the global one
  const sp = commands.saveCommand(home, proj, 'project', 'revue', 'Version projet', 'PROJET ${file}', ['file']);
  assert(sp.ok === true && sp.scope === 'project', 'portee projet');
  const list = commands.listCommands(home, proj);
  assert(list.length === 1 && list[0].scope === 'project', 'projet masque global: ' + JSON.stringify(list.map((c) => c.scope)));
  const ex = commands.expand(home, proj, '/revue notes.txt');
  assert(ex.ok === true && ex.prompt === 'PROJET notes.txt', 'rendu projet: ' + JSON.stringify(ex));
  // without a project root the global definition applies
  const exg = commands.expand(home, null, '/revue notes.txt securite');
  assert(exg.ok === true && exg.scope === 'global', 'portee globale: ' + JSON.stringify(exg));
  assert(exg.prompt.indexOf('Relis notes.txt') === 0, 'argument 1 rendu: ' + exg.prompt);
  assert(exg.prompt.indexOf('securite') !== -1, 'argument 2 rendu: ' + exg.prompt);
  assert(exg.prompt.indexOf('{{') === -1 && exg.prompt.indexOf('$ARGS') === -1, 'aucun gabarit residuel: ' + exg.prompt);
  // missing argument: reported, never silent
  const miss = commands.expand(home, null, '/revue');
  assert(miss.ok === true && miss.missing.length > 0, 'arguments manquants signales: ' + JSON.stringify(miss));
  // unknown command: honest failure, not a chat fallback
  const unk = commands.expand(home, null, '/inconnue test');
  assert(unk.matched === true && unk.ok === false, 'commande inconnue detectee: ' + JSON.stringify(unk));
  assert(/inconnue/.test(unk.error), 'message: ' + unk.error);
  // a plain prompt is not a command
  assert(commands.expand(home, null, 'explique le projet').matched === false, 'prompt normal intact');
  // invalid definitions are refused
  assert(commands.saveCommand(home, null, 'global', 'a b', '', 'x').ok === false, 'nom invalide refuse');
  assert(commands.saveCommand(home, null, 'global', 'vide', '', '   ').ok === false, 'modele vide refuse');
  assert(commands.deleteCommand(home, proj, 'project', 'revue').ok === true, 'suppression projet');
  assert(commands.listCommands(home, proj)[0].scope === 'global', 'global reapparait apres suppression');
});

t('A2 boucle : /nom est developpee AVANT la classification, journalisee', async () => {
  const proj = project('node');
  const w = world(proj);
  commands.saveCommand(w.home, proj, 'global', 'resume', 'Resume', 'Resume le fichier ${file} sans le modifier.', ['file']);
  const r = await w.turn('/resume README.md', [{ content: 'Fait.' }], { maxIt: 1 });
  const sys = String(r.chats[0].messages.map((m) => m.content).join('\n'));
  assert(/Resume le fichier README\.md sans le modifier\./.test(sys), 'modele voit la consigne developpee');
  assert(r.journal.indexOf('commande developpee') !== -1, 'journalisation de la commande');
  assert(r.out.runStatus !== 'ECHEC', 'tour non en echec: ' + r.out.runStatus);
});

t('A3 boucle : commande inconnue -> tour honnete (PARTIEL, aucun appel modele)', async () => {
  const proj = project('node');
  const w = world(proj);
  const r = await w.turn('/nexistepas faire un truc', [{ content: 'jamais appele' }], { maxIt: 1 });
  assert(r.chats.length === 0, 'aucun appel au modele, got ' + r.chats.length);
  assert(r.out.runStatus === 'PARTIEL', 'PARTIEL, got ' + r.out.runStatus);
  assert(/nexistepas/.test(r.text), 'message explicite: ' + r.text.slice(0, 160));
  assert(r.journal.indexOf('commande inconnue') !== -1, 'journal: commande inconnue');
  const td = r.events.filter((e) => e.type === 'turn.done').pop();
  assert(td && td.reason === 'unknown_command', 'raison inconnue dans turn.done');
});

// ===========================================================================
// B - agents personnalises + regles globales
// ===========================================================================
t('B1 agents : Build/Plan par defaut, creation/refus/suppression', () => {
  const home = tmp('p54ag');
  const base = agents.listAgents(home);
  assert(base.length === 2 && base[0].name === 'Build' && base[1].name === 'Plan', 'Build/Plan par defaut: ' + JSON.stringify(base.map((a) => a.name)));
  assert(base.every((a) => a.builtin === true), 'marques builtin');
  const bad = agents.saveAgent(home, { name: 'Plan', instructions: 'x' });
  assert(bad.ok === false && /par defaut/.test(bad.error), 'nom reserve refuse: ' + JSON.stringify(bad));
  const ok = agents.saveAgent(home, { name: 'Revue', description: 'relit', instructions: 'Relis seulement, ne modifie rien.', tools: ['read', 'grep'] });
  assert(ok.ok === true && ok.agent.tools.length === 2, 'creation: ' + JSON.stringify(ok).slice(0, 200));
  const list = agents.listAgents(home);
  assert(list.length === 3 && list[0].builtin === true && list[2].name === 'Revue', 'ordre: ' + JSON.stringify(list.map((a) => a.name)));
  // update in place
  const up = agents.saveAgent(home, { name: 'revue', instructions: 'Mis a jour.', tools: ['read'] });
  assert(up.ok === true && agents.listAgents(home).length === 3, 'mise a jour sans doublon');
  assert(agents.findAgent(home, 'REVUE').name.toLowerCase() === 'revue', 'recherche insensible a la casse');
  assert(agents.findAgent(home, 'Build').builtin === true, 'Build resolvable');
  assert(agents.deleteAgent(home, 'Revue').ok === true, 'suppression');
  assert(agents.deleteAgent(home, 'Revue').ok === false, 'suppression impossible deux fois');
  assert(agents.saveAgent(home, { name: 'X', instructions: 'x'.repeat(17000) }).ok === false, 'instructions bornees');
});

t('B2 regles globales : injectees dans le contexte de chaque tour', async () => {
  const proj = project('node');
  const w = world(proj);
  const sv = agents.saveGlobalRules(w.home, 'MARQUEUR-GLOBAL-P54 : reponds toujours en francais.');
  assert(sv.ok === true && sv.bytes > 0, 'ecriture regles globales');
  const r = await w.turn('modifie le README.md en ajoutant une ligne', [
    call('reply', { text: 'Je propose la modification.' }),
  ], { maxIt: 2 });
  const sys = String(r.chats[0].messages.map((m) => m.content).join('\n'));
  assert(sys.indexOf('MARQUEUR-GLOBAL-P54') !== -1, 'regles globales dans le contexte');
  assert(agents.saveGlobalRules(w.home, 'x'.repeat(70000)).ok === false, 'plafond 64 Ko');
});

t('B3 sous-agent : instructions de l\'agent + outils autorises, agent inconnu refuse', async () => {
  const proj = project('node');
  const w = world(proj);
  agents.saveAgent(w.home, { name: 'Revue', instructions: 'MARQUEUR-INSTR-P54 : analyse uniquement.', tools: ['read'] });
  const r = await w.turn('fais une revue du projet', [
    call('subagent', { task: 'relis README.md', agent: 'Revue' }),
    call('reply', { text: 'Revue faite.' }),
  ], { maxIt: 3 });
  const all = r.chats.map((c) => String((c.messages || []).map((m) => m.content).join('\n'))).join('\n---\n');
  assert(all.indexOf('MARQUEUR-INSTR-P54') !== -1, 'instructions transmises au sous-agent');
  assert(/sous-agent demarre/.test(r.journal) && /Revue/.test(r.journal), 'journal: sous-agent nomme');
  // unknown agent: refused honestly, no crash
  const w2 = world(project('node'));
  const r2 = await w2.turn('fais une revue', [
    call('subagent', { task: 'relis', agent: 'Fantome' }),
    call('reply', { text: 'ok' }),
  ], { maxIt: 3 });
  const tr = r2.events.filter((e) => e.type === 'tool.result' && e.tool === 'subagent').pop();
  assert(tr && /agent inconnu/.test(String(tr.result || tr.reason || '') + JSON.stringify(tr)), 'refus explicite: ' + JSON.stringify(tr).slice(0, 240));
  assert(r2.out.runStatus !== 'ECHEC' || /agent inconnu/.test(r2.text), 'pas de faux succes: ' + r2.out.runStatus);
});

// ===========================================================================
// C - AGENTS.md : brouillon, diff, confirmation
// ===========================================================================
t('C1 AGENTS.md : brouillon genere depuis le projet reel', () => {
  const proj = project('node');
  const draft = rules.generateDraft(require(path.join(AGENT_SRC, 'projectmap.js')), proj);
  assert(draft.ok === true && typeof draft.text === 'string' && draft.text.length > 20, 'brouillon genere');
  assert(/npm test|demo-p54/.test(draft.text), 'brouillon ancre dans le projet: ' + draft.text.slice(0, 200).replace(/\n/g, ' | '));
  assert(!fs.existsSync(path.join(proj, 'AGENTS.md')), 'generer n ecrit pas');
});

t('C2 AGENTS.md : jamais d\'ecrasement sans diff + confirmation', () => {
  const proj = project('node');
  const first = rules.saveProjectRules(proj, '# AGENTS\n- REGLE-A\n');
  assert(first.ok === true, 'creation sans confirmation (fichier absent)');
  assert(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8').indexOf('REGLE-A') !== -1, 'contenu ecrit');
  const second = rules.saveProjectRules(proj, '# AGENTS\n- REGLE-B\n');
  assert(second.ok === false && second.code === 'confirm_required', 'confirmation exigee: ' + JSON.stringify(second).slice(0, 160));
  assert(second.diff && second.diff.added >= 1 && second.diff.removed >= 1, 'diff fourni: ' + JSON.stringify(second.diff));
  assert(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8').indexOf('REGLE-A') !== -1, 'fichier intact sans confirmation');
  const third = rules.saveProjectRules(proj, '# AGENTS\n- REGLE-B\n', { confirm: true });
  assert(third.ok === true, 'ecriture apres confirmation');
  assert(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8').indexOf('REGLE-B') !== -1, 'contenu remplace');
  // identical content: nothing to confirm
  const same = rules.saveProjectRules(proj, '# AGENTS\n- REGLE-B\n');
  assert(same.ok === true, 'reecriture identique acceptee');
});

t('C3 AGENTS.md lu comme contexte du tour (projet + regles globales)', async () => {
  const proj = project('node');
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# AGENTS\nMARQUEUR-AGENTS-P54 : ne touche pas a src/.\n', 'utf8');
  const w = world(proj);
  const r = await w.turn('mets a jour le README.md du projet', [
    call('reply', { text: 'Je propose la mise a jour.' }),
  ], { maxIt: 2 });
  const sys = String(r.chats[0].messages.map((m) => m.content).join('\n'));
  assert(sys.indexOf('MARQUEUR-AGENTS-P54') !== -1, 'AGENTS.md injecte');
});

// ===========================================================================
// D - MCP : etat, exposition, decisions par outil
// ===========================================================================
t('D1 MCP : desactive par defaut cote exposition, presets fournis', () => {
  const home = tmp('p54mcp1');
  const echo = echoServer();
  agentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  agentFile(home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
  assert(mcp.exposedTools(home, 'echo').length === 0, 'aucun outil expose par defaut (contexte court)');
  const ps = mcp.presets();
  assert(ps.length >= 3 && ps.filter((p) => p.id === 'github')[0].needsToken === true, 'presets: ' + JSON.stringify(ps.map((p) => p.id)));
  // exposure is filtered by the ADMIN allowlist first
  const bad = mcp.setExposed(home, 'echo', ['autre']);
  assert(bad.ok === false && /autorisation/.test(bad.error), 'outil hors liste refuse: ' + JSON.stringify(bad));
  const good = mcp.setExposed(home, 'echo', ['echo']);
  assert(good.ok === true && mcp.exposedTools(home, 'echo').join(',') === 'echo', 'exposition acceptee');
  // disable: exposure collapses, nothing is offered
  assert(mcp.setEnabled(home, 'echo', false).ok === true, 'desactivation');
  assert(mcp.exposedTools(home, 'echo').length === 0, 'desactive => aucun outil expose');
  assert(mcp.setEnabled(home, 'echo', true).ok === true, 'reactivation');
  assert(mcp.setEnabled(home, 'fantome', true).ok === false, 'serveur inconnu refuse');
  // deny removes it from the exposure, allow keeps it
  assert(mcp.setToolDecision(home, 'echo', 'echo', 'deny').ok === true, 'decision deny');
  assert(mcp.exposedTools(home, 'echo').length === 0, 'deny retire de l exposition');
  mcp.setToolDecision(home, 'echo', 'echo', 'allow');
  assert(mcp.toolDecision(home, 'echo', 'echo') === 'allow', 'decision allow enregistree');
  assert(mcp.setToolDecision(home, 'echo', 'echo', 'nimportequoi').ok === false, 'decision invalide refusee');
});

t('D2 MCP : appel refuse avant execution (desactive / inconnu / deny)', async () => {
  const home = tmp('p54mcp2');
  const echo = echoServer();
  agentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  agentFile(home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
  const ctx = { home, root: project('node'), sessionId: 's', sessionRules: new Map([['s', new Set()]]), pending: new Map() };
  mcp.setExposed(home, 'echo', ['echo']);
  mcp.setToolDecision(home, 'echo', 'echo', 'deny');
  const denied = await toolsMod.executeTool(ctx, 'mcp__echo__echo', { text: 'x' });
  assert(denied.status === 'denied' && denied.code === 'mcp_denied_rule', 'deny: ' + JSON.stringify(denied).slice(0, 160));
  const unknown = await toolsMod.executeTool(ctx, 'mcp__nope__x', {});
  assert(unknown.code === 'mcp_unknown', 'serveur inconnu: ' + JSON.stringify(unknown).slice(0, 160));
  mcp.setToolDecision(home, 'echo', 'echo', 'ask');
  mcp.setEnabled(home, 'echo', false);
  const disabled = await toolsMod.executeTool(ctx, 'mcp__echo__echo', { text: 'x' });
  assert(disabled.status === 'denied' && disabled.code === 'mcp_disabled', 'desactive: ' + JSON.stringify(disabled).slice(0, 160));
});

t('D3 MCP : decision "allow" execute sans demander, "ask" demande', async () => {
  const home = tmp('p54mcp3');
  const echo = echoServer();
  agentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  agentFile(home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
  const ctx = { home, root: project('node'), sessionId: 's', sessionRules: new Map([['s', new Set()]]), pending: new Map() };
  mcp.setExposed(home, 'echo', ['echo']);
  mcp.setToolDecision(home, 'echo', 'echo', 'ask');
  const ask = await toolsMod.executeTool(ctx, 'mcp__echo__echo', { text: 'a' });
  assert(ask.status === 'need-approval', 'ask => approbation: ' + JSON.stringify(ask).slice(0, 160));
  mcp.setToolDecision(home, 'echo', 'echo', 'allow');
  const auto = await toolsMod.executeTool(ctx, 'mcp__echo__echo', { text: 'b' });
  assert(auto.status === 'done', 'allow => execution directe: ' + JSON.stringify(auto).slice(0, 200));
  assert(String(JSON.stringify(auto)).indexOf('echo:b') !== -1, 'resultat echo');
});

t('D4 boucle : aucun outil MCP dans les schemas tant que rien n\'est expose', async () => {
  const echo = echoServer();
  // One fresh session per case (the engine-managed task loop owns the history
  // of a session; each new demand is proven on its own turn).
  const setup = (expose, enabled) => {
    const w = world(project('node'));
    agentFile(w.home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
    agentFile(w.home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
    if (expose) assert(mcp.setExposed(w.home, 'echo', ['echo']).ok === true, 'exposition');
    if (enabled === false) assert(mcp.setEnabled(w.home, 'echo', false).ok === true, 'desactivation');
    return w;
  };
  const ask = (w) => w.turn('verifie le fichier README.md du projet',
    [call('reply', { text: 'Rien a modifier.' })], { model: 'mock-8b', maxIt: 2 });
  const r1 = await ask(setup(false, true));
  const names1 = (r1.chats[0].tools || []).map((x) => x.function.name);
  assert(names1.filter((n) => n.indexOf('mcp__') === 0).length === 0, 'aucun mcp__ par defaut');
  assert(names1.indexOf('skill') !== -1, 'outil skill toujours propose');
  const r2 = await ask(setup(true, true));
  const names2 = (r2.chats[0].tools || []).map((x) => x.function.name);
  assert(names2.indexOf('mcp__echo__echo') !== -1, 'outil expose present: ' + names2.join(','));
  // disabled server: never offered, even if the exposure list still names it
  const r3 = await ask(setup(true, false));
  const names3 = (r3.chats[0].tools || []).map((x) => x.function.name);
  assert(names3.filter((n) => n.indexOf('mcp__') === 0).length === 0, 'desactive => jamais propose');
});

t('D5 MCP : noms prefixes serveur, import/export "mcpServers" fidele', () => {
  const home = tmp('p54mcp5');
  const echo = echoServer();
  agentFile(home, 'mcp.json', { servers: { echo: { command: process.execPath, args: [echo] } } });
  agentFile(home, 'mcp_policy.json', { allowed: { echo: ['echo'] } });
  mcp.setExposed(home, 'echo', ['echo']);
  const exp = mcp.toMcpServersJson(home);
  assert(exp.mcpServers && exp.mcpServers.echo && exp.mcpServers.echo.command === process.execPath, 'export: ' + JSON.stringify(exp).slice(0, 200));
  assert((exp.mcpServers.echo.args || []).length === 1 && exp.mcpServers.echo.expose[0] === 'echo', 'export args + expose');
  const home2 = tmp('p54mcp5b');
  const r = mcp.importMcpServersJson(home2, exp);
  assert(r.ok === true && r.added.join(',') === 'echo', 'import: ' + JSON.stringify(r).slice(0, 200));
  const cfg2 = mcp.loadConfig(home2).echo;
  assert(cfg2.command === process.execPath && cfg2.expose[0] === 'echo', 'aller-retour fidele: ' + JSON.stringify(cfg2));
  const bad = mcp.importMcpServersJson(home2, { mcpServers: { mauvais: { ni_commande: true } } });
  assert(bad.ok === false && bad.refused && bad.refused.length === 1, 'import invalide refuse en entier: ' + JSON.stringify(bad).slice(0, 200));
});

// ===========================================================================
// E - competences : descriptions seules, corps a la demande
// ===========================================================================
t('E1 contexte court : descriptions seulement, corps via l\'outil skill', async () => {
  const proj = project('node');
  const w = world(proj);
  const src = tmp('p54sk');
  fs.writeFileSync(path.join(src, 'SKILL.md'),
    '---\nname: revue54\ndescription: Relit le code et signale les risques\n---\n# Revue\nMARQUEUR-CORPS-P54 : toujours relire deux fois.\n', 'utf8');
  const pv = await skills.previewImport(w.home, src);
  assert(pv.ok === true && pv.staged !== false, 'apercu import: ' + JSON.stringify(pv).slice(0, 160));
  assert(pv.excerpt.indexOf('MARQUEUR-CORPS-P54') !== -1, 'contenu montre avant activation');
  const ac = skills.activateStaged(w.home, proj, pv.stagingId, 'project');
  assert(ac.ok === true, 'activation projet: ' + JSON.stringify(ac).slice(0, 160));
  const r = await w.turn('applique la competence revue54', [
    call('skill', { name: 'revue54' }),
    call('reply', { text: 'Fait.' }),
  ], { maxIt: 3 });
  const sys = String(r.chats[0].messages.map((m) => m.content).join('\n'));
  assert(sys.indexOf('revue54') !== -1, 'description de la competence dans le contexte');
  assert(sys.indexOf('MARQUEUR-CORPS-P54') === -1, 'corps absent du contexte systeme');
  const tr = r.events.filter((e) => e.type === 'tool.result' && e.tool === 'skill').pop();
  assert(tr && tr.ok === true, 'outil skill appele: ' + JSON.stringify(tr).slice(0, 160));
  assert(r.chats.length >= 2, 'deuxieme appel modele apres chargement: ' + r.chats.length);
  const second = JSON.stringify(r.chats[1] || {});
  const msgs2 = (r.chats[1] && r.chats[1].messages) || [];
  const toolMsg = msgs2.filter((m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls));
  assert(second.indexOf('MARQUEUR-CORPS-P54') !== -1,
    'le modele recoit le corps charge (2e appel): ' + JSON.stringify(toolMsg).slice(0, 700));
  assert(second.indexOf('Relit le code et signale les risques') !== -1, 'descriptions conservees');
  assert(skills.loadSkillText(w.home, proj, 'inconnue').ok === false, 'competence inconnue refusee');
  assert(skills.loadSkillText(w.home, proj, 'revue54').ok === true, 'chargement direct');
});

t('E2 competences : import hors ligne depuis un dossier, refus si rien de valide', async () => {
  const home = tmp('p54sk2');
  const empty = tmp('p54sk2e');
  fs.writeFileSync(path.join(empty, 'lisezmoi.txt'), 'rien ici', 'utf8');
  const bad = await skills.previewImport(home, empty);
  assert(bad.ok === false, 'aucun SKILL.md => refus: ' + JSON.stringify(bad).slice(0, 160));
  const ok76 = await skills.previewImport(home, path.join(ROOT, 'sudo-agent', 'src'));
  assert(ok76.ok === false, 'dossier sans SKILL.md refuse');
  // an unreachable Git source must fail cleanly (offline tolerance), not crash
  const net = await skills.previewImport(home, 'https://example.invalid/p54/skills.git');
  assert(net.ok === false && typeof net.error === 'string' && net.error.length > 5, 'source distante injoignable: ' + JSON.stringify(net).slice(0, 160));
  assert(skills.listSkills(home, null).length === 0, 'aucune installation apres echec');
});

// ===========================================================================
// F - page Agent Extensions (statique + rendu du HTML)
// ===========================================================================
t('F1 page : 5 onglets, guides integres, ASCII, zero nom concurrent', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  for (let i = 0; i < src.length; i++) {
    assert(src.charCodeAt(i) < 128, 'panel: non-ASCII byte a ' + i);
  }
  const lowSrc = src.toLowerCase();
  for (const b of BRANDS) assert(lowSrc.indexOf(b) === -1, 'nom concurrent dans la page: ' + b);
  for (const tab of ['MCP Servers', 'Skills', 'Commands', 'Agents', 'Rules']) {
    assert(src.indexOf('>' + tab + '<') !== -1, 'onglet present: ' + tab);
  }
  const m = src.match(/const GUIDES = \{[\s\S]*?\n\};/);
  assert(m, 'GUIDES definis');
  const keys = (m[0].match(/^\s{4}(mcp|skills|commands|agents|rules):/gm) || []).length;
  assert(keys === 5, 'guides pour les 5 onglets, got ' + keys);
  assert(/Aucun &eacute;crasement sans diff et confirmation/.test(src), 'guide des regles');
  assert(src.indexOf('exportAll') !== -1 && src.indexOf('importAll') !== -1, 'export/import complets');
  assert(src.indexOf('/extensions/') !== -1, 'routes P54 utilisees');
});

t('F2 page : HTML rendu (5 onglets actifs, script valide, aucune fuite)', () => {
  // vscode + helpers stubbed so the class can be instantiated on plain node.
  const origLoad = Module._load;
  const stubs = {
    vscode: {
      ViewColumn: { One: 1 },
      Uri: { file: (p) => ({ fsPath: p }) },
      window: { createWebviewPanel: () => { throw new Error('no panel in test'); }, showOpenDialog: async () => null },
      workspace: { workspaceFolders: [] },
      env: { clipboard: { writeText: async () => {} } },
    },
    [path.join(EXT, 'src', 'utils', 'backendFallback.js')]: { handlePanelMessage: () => false },
    [path.join(EXT, 'src', 'utils', 'webviewGuard.js')]: { guardSnippet: () => '<div id="guard-fallback"></div>' },
    [path.join(EXT, 'src', 'agent', 'agentHost.js')]: { getAgentHost: () => ({ getServer: () => null }) },
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stubs.vscode;
    if (request === '../utils/backendFallback') return stubs[path.join(EXT, 'src', 'utils', 'backendFallback.js')];
    if (request === '../utils/webviewGuard') return stubs[path.join(EXT, 'src', 'utils', 'webviewGuard.js')];
    if (request === '../agent/agentHost') return stubs[path.join(EXT, 'src', 'agent', 'agentHost.js')];
    return origLoad.apply(this, arguments);
  };
  let html = '';
  try {
    delete require.cache[require.resolve(PANEL)];
    const mod = require(PANEL);
    assert(typeof mod.AgentExtensionsPanel === 'function', 'classe exportee');
    const fake = { postMessage: () => {}, onDidReceiveMessage: () => ({ dispose: () => {} }) };
    const inst = new mod.AgentExtensionsPanel({ webview: fake, onDidDispose: () => ({ dispose: () => {} }), reveal: () => {} }, { fsPath: '/' });
    html = inst.panel.webview.html || '';
    assert(html.length > 2000, 'HTML non vide (' + html.length + ' octets)');
  } finally { Module._load = origLoad; }
  const tabs = (html.match(/class="tab[ "]/g) || []).length;
  assert(tabs >= 5, 'au moins 5 onglets rendus, got ' + tabs);
  for (const id of ['pane-mcp', 'pane-skills', 'pane-commands', 'pane-agents', 'pane-rules']) {
    assert(html.indexOf('id="' + id + '"') !== -1, 'panneau present: ' + id);
  }
  assert(html.indexOf('guard-fallback') !== -1, 'garde-fou webview present');
  assert(!/>\s*(undefined|null)\s*</.test(html), 'aucun gabarit non resolu');
  assert(!/\$\{guardSnippet|\$\{guides\}/.test(html), 'aucune interpolation non resolue');
  assert(html.indexOf('Relis ${file}') !== -1, 'exemple de gabarit affiche tel quel');
  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  assert(scripts.length === 1, 'un seul script inline, got ' + scripts.length);
  const body = scripts[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  new vm.Script(body); // throws if the page script does not parse
  assert(body.indexOf("post({ type: 'load' })") !== -1, 'chargement initial declenche');
  assert(body.indexOf('function renderMcp') !== -1 && body.indexOf('function renderRules') !== -1, 'rendus definis');
});

t('F3 cablage : commande, page deplacee, entree de barre laterale', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const cmds = (pkg.contributes.commands || []).map((c) => c.command);
  assert(cmds.indexOf('sudoStudio.openAgentExtensions') !== -1, 'commande declaree');
  assert(cmds.indexOf('sudoStudio.openMcpPanel') === -1, 'ancienne commande retiree');
  const ext = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  assert(/require\('\.\/src\/panels\/AgentExtensionsPanel'\)/.test(ext), 'panneau importe');
  assert(/openAgentExtensions/.test(ext), 'commande enregistree');
  assert(!/MCPServersPanel/.test(ext), 'ancien panneau retire du code');
  assert(!fs.existsSync(path.join(EXT, 'src', 'panels', 'MCPServersPanel.js')), 'ancien fichier supprime');
  const sidebar = require(path.join(EXT, 'src', 'views', 'sidebarModel.js'));
  const all = sidebar.GROUPS.reduce((n, g) => n + g.entries.length, 0);
  assert(all >= 25, 'entrees de barre laterale, got ' + all);
  const entry = sidebar.GROUPS.reduce((acc, g) => acc.concat(g.entries), [])
    .filter((e) => e.command === 'sudoStudio.openAgentExtensions');
  assert(entry.length === 1 && entry[0].label === 'Agent Extensions', 'une entree anglaise: ' + JSON.stringify(entry));
  assert(!Object.prototype.hasOwnProperty.call(sidebar.INTERNAL_COMMANDS, 'sudoStudio.openMcpPanel'), 'ancienne commande interne retiree');
  assert(!/[\u{1F300}-\u{1FAFF}]/u.test(entry[0].label), 'aucun emoji');
});

t('F4 sources produit : ASCII seul, aucun nom concurrent, notices tierces intactes', () => {
  for (const f of PRODUCT_FILES) {
    const buf = fs.readFileSync(path.join(AGENT_SRC, f));
    for (let i = 0; i < buf.length; i++) assert(buf[i] < 128, f + ': non-ASCII byte');
    const low = buf.toString('utf8').toLowerCase();
    for (const b of BRANDS) assert(low.indexOf(b) === -1, f + ': nom concurrent interdit: ' + b);
  }
  const notice = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
  if (fs.existsSync(notice)) {
    const n = fs.readFileSync(notice, 'utf8');
    assert(n.length > 100, 'notices tierces presentes');
  }
});

// ===========================================================================
// G - hors ligne / compatibilite boucle moteur
// ===========================================================================
t('G1 serveur MCP distant injoignable : test honnete, tour non bloque', async () => {
  const home = tmp('p54off');
  agentFile(home, 'mcp.json', { servers: { distant: { transport: 'http', url: 'http://' + HOST + ':1/mcp' } } });
  agentFile(home, 'mcp_policy.json', { allowed: { distant: ['ping'] } });
  const t0 = Date.now();
  let r = null;
  let err = null;
  try { r = await mcp.testServer(home, 'distant', () => {}); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  assert((r && r.ok === false) || err, 'test distant echoue proprement: ' + JSON.stringify(r || String(err)).slice(0, 200));
  assert(ms < 20000, 'echec rapide (' + ms + ' ms), pas de blocage');
  const proj = project('node');
  const w = world(proj);
  agentFile(w.home, 'mcp.json', { servers: { distant: { transport: 'http', url: 'http://' + HOST + ':1/mcp' } } });
  agentFile(w.home, 'mcp_policy.json', { allowed: { distant: ['ping'] } });
  const exp0 = mcp.setExposed(w.home, 'distant', ['ping']);
  assert(exp0.ok === true, 'exposition distante: ' + JSON.stringify(exp0));
  assert(mcp.exposedTools(w.home, 'distant').length === 1, 'outil distant expose');
  const t1 = Date.now();
  const turn = await w.turn('verifie le README.md du projet', [call('reply', { text: 'Rien a faire.' })],
    { model: 'mock-8b', maxIt: 2 });
  const turnMs = Date.now() - t1;
  assert(turn.out.runStatus !== 'ECHEC', 'tour non en echec: ' + turn.out.runStatus);
  assert(turnMs < 60000, 'tour non bloque par le serveur hors ligne (' + turnMs + ' ms)');
  assert(/mcp list failed|mcp/i.test(turn.journal), 'journal: etat MCP trace :: ' + String(turn.journal).slice(-300));
});

t('G2 boucle moteur (P49/P52) : outils agent complets, tasks moteur intactes', () => {
  const names = toolsMod.toolNames();
  assert(names.indexOf('skill') !== -1, 'outil skill present');
  const profiles = require(path.join(AGENT_SRC, 'profiles.js'));
  assert(names.indexOf('subagent') !== -1, 'outil subagent present');
  assert(profiles.profileTools('small').indexOf('todo') === -1
    && profiles.profileTools('full').indexOf('todo') === -1, 'P52: todo gere par le moteur (hors profils)');
  assert(names.length >= 31, 'au moins 31 outils, got ' + names.length);
  assert(profiles.profileTools('small').indexOf('skill') !== -1, 'skill accessible aux petits modeles');
  const loopSrc = fs.readFileSync(path.join(AGENT_SRC, 'loop.js'), 'utf8');
  assert(/allowedTools/.test(loopSrc), 'restriction par agent cablee');
  assert(/readGlobalRulesSafe/.test(loopSrc), 'regles globales cablees');
  assert(/commandsMod\.expand/.test(loopSrc), 'commandes cablees');
  assert(/mcpMod\.exposedTools/.test(loopSrc), 'exposition MCP cablee');
});

// ===========================================================================
// H - export/import global + routes HTTP P54
// ===========================================================================
function httpCall(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port, method, path: p,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

t('H1 routes P54 : commandes, agents, regles, MCP, export/import complet', async () => {
  const home = tmp('p54api');
  const proj = project('node');
  const store = new SessionStore({ storeDir: path.join(home, 'store') });
  const log = createLogger({ logsDir: path.join(home, 'logs'), component: 'agent' });
  const app = serverMod.createApp({ authToken: 'tok-p54-0123456789', store, log, home });
  const srv = app.server;
  await new Promise((r) => srv.listen(0, HOST, r));
  const port = srv.address().port;
  const token = 'tok-p54-0123456789';
  const q = '?projectRoot=' + encodeURIComponent(proj);
  try {
    assert((await httpCall(port, null, 'GET', '/extensions/mcp/presets')).status === 401, 'jeton exige');
    const pres = await httpCall(port, token, 'GET', '/extensions/mcp/presets');
    assert(pres.status === 200 && pres.body.presets.length >= 3, 'presets via HTTP');
    const cs = await httpCall(port, token, 'POST', '/extensions/commands' + q,
      { scope: 'global', name: 'revue', description: 'Relit', template: 'Relis ${file}', args: ['file'] });
    assert(cs.status === 201, 'creation commande: ' + JSON.stringify(cs.body));
    const cl = await httpCall(port, token, 'GET', '/extensions/commands' + q);
    assert(cl.body.commands.length === 1 && cl.body.commands[0].name === 'revue', 'liste commandes');
    const cp = await httpCall(port, token, 'GET', '/extensions/commands/revue' + q + '&args=a.txt');
    assert(cp.status === 200 && /Relis a\.txt/.test(String(cp.body.preview || '')), 'apercu: ' + JSON.stringify(cp.body));
    const as = await httpCall(port, token, 'POST', '/extensions/agents', { name: 'Revue', instructions: 'ok', tools: ['read'] });
    assert(as.status === 201, 'creation agent');
    const al = await httpCall(port, token, 'GET', '/extensions/agents');
    assert(al.body.agents.length === 3 && al.body.agents[0].builtin === true, 'Build/Plan en tete');
    const gen = await httpCall(port, token, 'POST', '/extensions/rules/generate' + q, {});
    assert(gen.status === 200 && gen.body.text.length > 20, 'generation AGENTS.md');
    const r1 = await httpCall(port, token, 'POST', '/extensions/rules' + q, { text: '# A\n- x\n' });
    assert(r1.status === 200, 'premiere ecriture');
    const r2 = await httpCall(port, token, 'POST', '/extensions/rules' + q, { text: '# B\n- y\n' });
    assert(r2.status === 409 && r2.body.code === 'confirm_required', '409 sans confirmation: ' + JSON.stringify(r2.body).slice(0, 160));
    const r3 = await httpCall(port, token, 'POST', '/extensions/rules' + q, { text: '# B\n- y\n', confirm: true });
    assert(r3.status === 200, 'ecriture confirmee');
    const g = await httpCall(port, token, 'POST', '/extensions/rules', { scope: 'global', text: 'Toujours en francais' });
    assert(g.status === 200, 'regles globales');
    const mi = await httpCall(port, token, 'POST', '/extensions/mcp/import',
      { mcpServers: { echo: { command: process.execPath, args: [echoServer()] } } });
    assert(mi.status === 200 && mi.body.added.length === 1, 'import MCP');
    const mt = await httpCall(port, token, 'GET', '/extensions/mcp/tools');
    assert(mt.status === 200 && mt.body.servers.echo && mt.body.servers.echo.expose.length === 0, 'expose vide par defaut');
    const me = await httpCall(port, token, 'POST', '/extensions/mcp/tools', { server: 'echo', expose: ['echo'] });
    assert(me.status === 400, 'exposition hors liste admin refusee: ' + JSON.stringify(me.body).slice(0, 120));
    const en = await httpCall(port, token, 'POST', '/mcp/servers/echo', { enabled: false });
    assert(en.status === 200, 'desactivation via HTTP');
    const ex = await httpCall(port, token, 'GET', '/extensions/export' + q);
    assert(ex.status === 200, 'export complet');
    assert(ex.body.version === 1 && Array.isArray(ex.body.commands) && ex.body.commands.length === 1, 'export contient les commandes');
    assert(ex.body.agents.length === 1 && ex.body.agents[0].name === 'Revue', 'export exclut Build/Plan: ' + JSON.stringify(ex.body.agents.map((a) => a.name)));
    assert(/Toujours en francais/.test(ex.body.rules.global), 'export contient les regles globales');
    assert(Object.keys(ex.body.mcp.mcpServers).length === 1, 'export contient les serveurs MCP');
    // import the bundle into a fresh home through the API
    const home2 = tmp('p54api2');
    const app2 = serverMod.createApp({ authToken: 'tok-p54-abcdefghij', store: new SessionStore({ storeDir: path.join(home2, 'store') }), log: createLogger({ logsDir: path.join(home2, 'logs'), component: 'agent' }), home: home2 });
    await new Promise((r) => app2.server.listen(0, HOST, r));
    const port2 = app2.server.address().port;
    try {
      const im = await httpCall(port2, 'tok-p54-abcdefghij', 'POST', '/extensions/import' + q, ex.body);
      assert(im.status === 200, 'import bundle: ' + JSON.stringify(im.body).slice(0, 200));
      assert(im.body.report.commands.filter((c) => c.ok).length === 1, 'commande importee');
      assert(im.body.report.agents.filter((a) => a.ok).length === 1, 'agent importe');
      const cl2 = await httpCall(port2, 'tok-p54-abcdefghij', 'GET', '/extensions/commands' + q);
      assert(cl2.body.commands.length === 1, 'commande relue apres import');
    } finally { await new Promise((r) => app2.server.close(r)); }
  } finally { await new Promise((r) => srv.close(r)); }
});

// ===========================================================================
// runner
// ===========================================================================
(async () => {
  const ONLY = process.argv[2] || '';
  for (const item of REGISTRY) {
    if (ONLY && item.name.indexOf(ONLY) !== 0) continue;
    try {
      await item.fn();
      PASS += 1;
      console.log('ok - ' + item.name);
    } catch (e) {
      FAILS.push(item.name + ' :: ' + String((e && e.message) || e));
      console.log('FAIL - ' + item.name + ' :: ' + String((e && e.message) || e));
    }
  }
  console.log(PASS + '/' + (PASS + FAILS.length) + ' P54 tests passed');
  if (FAILS.length) console.log('FAILS: ' + FAILS.join(' | '));
  process.exit(FAILS.length ? 1 : 0);
})();
