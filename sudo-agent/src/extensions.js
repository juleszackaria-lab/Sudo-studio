/**
 * SUDO AGENT - P57(1..6): registre UNIQUE d'extensions.
 *
 * Le moteur voit, en un seul endroit, ce que l'utilisateur a configure dans la
 * page "Agent Extensions" : serveurs MCP, skills, commandes, agents, regles.
 *
 * Principe pour ne pas saturer un petit modele : les outils de decouverte sont
 * TOUJOURS presents et COURTS (nom + description d'une ligne) :
 *   extensions_list   -> inventaire compact
 *   extensions_describe(nom) -> detail d'une extension
 *   skill_load(nom)   -> contenu complet d'un skill, a la demande
 *   mcp_call(serveur, outil, arguments) -> appel MCP avec permissions + audit
 *   task(agent, consigne) -> sous-agent
 * Le moteur PROPOSE d'office les extensions pertinentes d'apres la demande
 * (suggest() : "render" -> skill render-deploy et/ou MCP render).
 *
 * Secrets (P57-5) : un jeton ne vit JAMAIS dans le contexte du modele ni dans
 * un journal. Le serveur MCP recoit ses variables par `secretEnv`
 * ({ ENV: "SudoStudio/mcp/<serveur>" ou nom de secret }), resolues depuis le
 * trousseau AU MOMENT de l'appel. Les sorties d'outils sont masquees.
 *
 * Stdlib only, ASCII only. Aucune ecriture hors du journal d'audit.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mcpMod = require('./mcp');
const skillsMod = require('./skills');
const commandsMod = require('./commands');
const agentsMod = require('./agents');
const rulesMod = require('./rules');
const keyring = require('./keyring');
const journalMod = require('./journal');

const MAX_LINE = 160;          // une description tient sur une ligne
const MAX_INVENTORY = 24;      // extensions listees au modele
const MAX_DISCOVER_LINES = 1200; // caracteres du digest injecte

function agentDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () {
    try { return os.homedir(); } catch (_) { return process.cwd(); }
  })();
  return path.join(String(h), '.sudo_studio', 'agent');
}

function auditFile(home) { return path.join(agentDir(home), 'audit.jsonl'); }

function oneLine(s, n) {
  let t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  const cap = n || MAX_LINE;
  if (t.length > cap) t = t.slice(0, cap - 1) + '.';
  return t;
}

/** Nettoie une valeur avant journalisation (masque les secrets connus). */
function mask(s) {
  try { return journalMod.maskSecrets(String(s)); } catch (_) { return oneLine(s); }
}

// ---------------------------------------------------------------------------
// Inventaire (P57-1)
// ---------------------------------------------------------------------------
function mcpServers(home) {
  const out = [];
  let cfgAll = {};
  try { cfgAll = mcpMod.loadConfig(home); } catch (_) { cfgAll = {}; }
  for (const name of Object.keys(cfgAll)) {
    const cfg = cfgAll[name] || {};
    let tools = [];
    try { tools = mcpMod.exposedTools(home, name) || []; } catch (_) { tools = []; }
    out.push({
      kind: 'mcp',
      name,
      description: oneLine(cfg.description || cfg.command || (cfg.url || '') || 'serveur MCP'),
      enabled: mcpMod.isEnabled(cfg),
      tools: tools.map(String).slice(0, MAX_INVENTORY),
      toolCount: tools.length,
      transport: cfg.command ? 'stdio' : 'http',
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

function skills(home, root) {
  let list = [];
  try { list = skillsMod.listSkills(home, root) || []; } catch (_) { list = []; }
  return list.filter((s) => !s.broken).map((s) => ({
    kind: 'skill',
    name: s.name,
    scope: s.scope,
    description: oneLine(s.description || 'skill'),
    active: s.active === true,
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function commands(home, root) {
  let list = [];
  try { list = commandsMod.listCommands(home, root) || []; } catch (_) { list = []; }
  return list.map((c) => ({
    kind: 'command',
    name: c.name,
    scope: c.scope || 'global',
    description: oneLine(c.description || 'commande'),
    args: c.args || [],
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function agents(home) {
  let list = [];
  try { list = agentsMod.listAgents(home) || []; } catch (_) { list = []; }
  return list.map((a) => ({
    kind: 'agent',
    name: a.name,
    builtin: a.builtin === true,
    description: oneLine(a.description || 'agent'),
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function rulesSummary(home, root) {
  const out = { global: false, project: false, globalChars: 0, projectChars: 0 };
  try {
    const g = agentsMod.readGlobalRules(home);
    out.global = !!g;
    out.globalChars = String(g || '').length;
  } catch (_) { /* ignore */ }
  try {
    const p = rulesMod.readProjectRules(root);
    out.project = !!(p && p.exists);
    out.projectChars = String((p && p.text) || '').length;
  } catch (_) { /* ignore */ }
  return out;
}

/** Inventaire complet (jamais de secret : descriptions seulement). */
function inventory(home, root) {
  return {
    mcp: mcpServers(home),
    skills: skills(home, root),
    commands: commands(home, root),
    agents: agents(home),
    rules: rulesSummary(home, root),
  };
}

/** Resume pour l'en-tete du panneau : "N MCP, N skills actifs". */
function summary(home, root) {
  const inv = inventory(home, root);
  const mcpOn = inv.mcp.filter((m) => m.enabled).length;
  const skOn = inv.skills.filter((s) => s.active).length;
  return {
    mcp: inv.mcp.length,
    mcpEnabled: mcpOn,
    skills: inv.skills.length,
    skillsActive: skOn,
    commands: inv.commands.length,
    agents: inv.agents.filter((a) => !a.builtin).length,
    label: mcpOn + ' MCP, ' + skOn + ' skill' + (skOn > 1 ? 's' : '') + ' actif' + (skOn > 1 ? 's' : ''),
    rules: inv.rules,
  };
}

// ---------------------------------------------------------------------------
// Decouverte : les extensions pertinentes pour une demande (P57-1)
// ---------------------------------------------------------------------------
const STOP = ['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'ce', 'cette', 'sur', 'pour',
  'dans', 'avec', 'et', 'ou', 'en', 'au', 'aux', 'mon', 'ma', 'mes', 'the', 'this', 'that',
  'project', 'projet', 'fais', 'fait', 'ajoute', 'utilise', 'please', 'veux'];

function terms(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9_.#-]+/)
    .filter((t) => t && t.length > 2 && STOP.indexOf(t) === -1);
}

function scoreOf(text, ts) {
  const hay = String(text || '').toLowerCase();
  let score = 0;
  for (const t of ts) {
    if (!t) continue;
    if (hay.indexOf(t) !== -1) score += (t.length >= 5 ? 3 : 2);
  }
  return score;
}

/**
 * Extensions pertinentes pour `prompt`, triees. Renvoie au plus `max` entrees.
 * Un skill ACTIF passe devant ; un MCP desactive est signale mais pas propose
 * en premier.
 */
function suggest(home, root, prompt, max) {
  const ts = terms(prompt);
  if (!ts.length) return [];
  const inv = inventory(home, root);
  const scored = [];
  for (const m of inv.mcp) {
    const text = m.name + ' ' + m.description + ' ' + m.tools.join(' ');
    let s = scoreOf(text, ts);
    if (!m.enabled) s = 0;               // desactive : jamais propose
    if (s > 0) scored.push(Object.assign({ score: s }, m, { why: 'MCP ' + m.name }));
  }
  for (const sk of inv.skills) {
    const s = scoreOf(sk.name + ' ' + sk.description, ts);
    if (s > 0) scored.push(Object.assign({ score: s + (sk.active ? 3 : 0), active: sk.active }, sk, { why: 'skill ' + sk.name }));
  }
  for (const c of inv.commands) {
    const s = scoreOf(c.name + ' ' + c.description, ts);
    if (s > 0) scored.push(Object.assign({ score: s - 1 }, c, { why: 'commande /' + c.name }));
  }
  for (const a of inv.agents) {
    if (a.builtin) continue;
    const s = scoreOf(a.name + ' ' + a.description, ts);
    if (s > 0) scored.push(Object.assign({ score: s - 2 }, a, { why: 'agent ' + a.name }));
  }
  scored.sort((x, y) => (y.score - x.score) || (x.name < y.name ? -1 : 1));
  return scored.slice(0, max || 4);
}

/** Digest court a injecter dans le prompt (noms + une ligne). */
function digest(home, root) {
  const inv = inventory(home, root);
  const lines = [];
  const mcpOn = inv.mcp.filter((m) => m.enabled);
  if (mcpOn.length) {
    lines.push('MCP actifs : ' + mcpOn.slice(0, MAX_INVENTORY)
      .map((m) => m.name + ' (' + (m.toolCount ? m.toolCount + ' outils' : 'outils a decouvrir') + ')').join(', '));
  }
  const sk = inv.skills.filter((s) => s.active).slice(0, MAX_INVENTORY);
  if (sk.length) {
    lines.push('Skills actifs : ' + sk.map((s) => s.name + ' = ' + s.description).join(' | '));
  }
  const cm = inv.commands.slice(0, MAX_INVENTORY);
  if (cm.length) lines.push('Commandes : ' + cm.map((c) => '/' + c.name + ' = ' + c.description).join(' | '));
  const ag = inv.agents.filter((a) => !a.builtin).slice(0, MAX_INVENTORY);
  if (ag.length) lines.push('Agents : ' + ag.map((a) => a.name + ' = ' + a.description).join(' | '));
  if (!lines.length) return '';
  lines.push('Outils : extensions_list(), extensions_describe(nom), skill_load(nom), mcp_call(serveur, outil, arguments), task(agent, consigne).');
  return lines.join('\n').slice(0, MAX_DISCOVER_LINES);
}

/** Bloc "propositions" pour la demande courante (vide si rien de pertinent). */
function proposalText(home, root, prompt) {
  const s = suggest(home, root, prompt, 3);
  const useful = s.filter((x) => x.kind !== 'command' || x.score > 1);
  if (!useful.length) return '';
  const lines = ['EXTENSIONS PERTINENTES pour cette demande :'];
  for (const x of useful) {
    if (x.kind === 'skill') lines.push('- skill ' + x.name + (x.active ? '' : ' (INACTIF : a activer)') + ' : ' + x.description + ' -> skill_load("' + x.name + '")');
    else if (x.kind === 'mcp') lines.push('- MCP ' + x.name + ' : ' + x.description + ' -> extensions_describe("' + x.name + '") puis mcp_call(serveur, outil, args)');
    else if (x.kind === 'agent') lines.push('- agent ' + x.name + ' : ' + x.description + ' -> task("' + x.name + '", consigne)');
    else lines.push('- commande /' + x.name + ' : ' + x.description);
  }
  lines.push('Utilise-les si la tache l exige ; sinon ignore-les.');
  return lines.join('\n').slice(0, 900);
}

// ---------------------------------------------------------------------------
// Description d'une extension (P57-1: extensions_describe)
// ---------------------------------------------------------------------------
function describe(home, root, name) {
  const want = String(name || '').trim();
  if (!want) return { ok: false, code: 'bad_args', error: 'extensions_describe: nom requis.' };
  const inv = inventory(home, root);
  const bare = want.replace(/^mcp:/, '').replace(/^skill:/, '').replace(/^agent:/, '');
  for (const m of inv.mcp) {
    if (m.name === bare) {
      let tools = [];
      try { tools = mcpMod.exposedTools(home, m.name) || []; } catch (_) { tools = []; }
      return { ok: true, kind: 'mcp', name: m.name, enabled: m.enabled, transport: m.transport,
        description: m.description, tools,
        howto: 'mcp_call({ "serveur": "' + m.name + '", "outil": "<outil>", "arguments": {...} })' };
    }
  }
  for (const s of inv.skills) {
    if (s.name === bare) {
      return { ok: true, kind: 'skill', name: s.name, scope: s.scope, active: s.active,
        description: s.description,
        howto: s.active ? 'skill_load({ "name": "' + s.name + '" })' : 'skill inactif : activez-le dans Agent Extensions > Skills' };
    }
  }
  for (const c of inv.commands) {
    if (c.name === bare) {
      return { ok: true, kind: 'command', name: c.name, scope: c.scope, description: c.description,
        args: c.args, howto: 'l utilisateur tape /' + c.name + ' <arguments>' };
    }
  }
  for (const a of inv.agents) {
    if (a.name.toLowerCase() === bare.toLowerCase()) {
      return { ok: true, kind: 'agent', name: a.name, builtin: a.builtin, description: a.description,
        howto: a.builtin ? 'agent par defaut (mode du panneau)' : 'task({ "agent": "' + a.name + '", "consigne": "..." })' };
    }
  }
  return { ok: false, code: 'not_found', error: 'extension introuvable : ' + oneLine(want, 60) };
}

// ---------------------------------------------------------------------------
// Journal d'audit (P57-6) : chaque appel d'extension y est ecrit, masque.
// ---------------------------------------------------------------------------
function audit(home, entry) {
  const e = Object.assign({ at: new Date().toISOString() }, entry || {});
  const safe = {};
  for (const k of Object.keys(e)) {
    if (/token|secret|password|key/i.test(k)) { safe[k] = '[REDACTED]'; continue; }
    safe[k] = (typeof e[k] === 'string') ? mask(e[k]).slice(0, 400) : e[k];
  }
  try {
    const f = auditFile(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(safe) + '\n', 'utf8');
  } catch (_) { /* un audit illisible ne casse jamais un appel */ }
  return safe;
}

function readAudit(home, limit) {
  const out = [];
  try {
    const raw = fs.readFileSync(auditFile(home), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* fichier absent */ }
  return out.slice(-(limit || 50));
}

// ---------------------------------------------------------------------------
// Secrets (P57-5) : resolution depuis le trousseau, jamais dans le modele
// ---------------------------------------------------------------------------
/**
 * Construit l'environnement a passer a un serveur MCP ou a une commande.
 * `secretEnv` = { NOM_VARIABLE: "SudoStudio/mcp/render" | "mon-secret" }.
 * Le serveur MCP lit le trousseau ; la valeur n'est JAMAIS journalisee ni
 * renvoyee au modele. Renvoie { env, missing: [noms manquants] }.
 */
async function resolveSecretEnv(home, serverName, secretEnv) {
  const env = {};
  const missing = [];
  const map = secretEnv && typeof secretEnv === 'object' ? secretEnv : {};
  for (const varName of Object.keys(map)) {
    let target = String(map[varName] || '').trim();
    if (!target) { missing.push(varName); continue; }
    if (target.indexOf('/') === -1) target = 'SudoStudio/mcp/' + (serverName || 'default') + '/' + target;
    let got = null;
    try { got = await keyring.getSecret(target); } catch (e) { got = { ok: false, error: String((e && e.message) || e) }; }
    if (!got || !got.ok || !got.secret) { missing.push(varName); continue; }
    env[varName] = String(got.secret);
  }
  return { env, missing };
}

// ---------------------------------------------------------------------------
// Appels (P57-2/6) : permissions + politique + audit pour chaque extension
// ---------------------------------------------------------------------------
/**
 * Appel MCP via le registre. `perm` = { check(desc) -> {decision} } fourni par
 * l'appelant (moteur) ; sans `perm`, l'appel exige `preApproved`.
 * Renvoie { ok, text, code, audit } : jamais d'exception, jamais de secret.
 */
async function callMcp(ctx, server, tool, args, opts) {
  const o = opts || {};
  const home = ctx.home;
  const srv = String(server || '').trim();
  const tname = String(tool || '').trim();
  const callArgs = args && typeof args === 'object' ? args : {};
  const base = { kind: 'mcp', server: srv, tool: tname, session: ctx.sessionId || '' };

  if (!srv || !tname) {
    audit(home, Object.assign({ ok: false, code: 'bad_args', why: 'serveur ou outil manquant' }, base));
    return { ok: false, code: 'bad_args', error: 'mcp_call : serveur et outil sont requis.' };
  }
  let cfgAll = {};
  try { cfgAll = mcpMod.loadConfig(home) || {}; } catch (_) { cfgAll = {}; }
  const cfg = cfgAll[srv];
  if (!cfg) {
    audit(home, Object.assign({ ok: false, code: 'mcp_unknown' }, base));
    return { ok: false, code: 'mcp_unknown', error: 'serveur MCP inconnu : ' + oneLine(srv, 40) + ' (Agent Extensions > MCP).' };
  }
  if (!mcpMod.isEnabled(cfg)) {
    audit(home, Object.assign({ ok: false, code: 'mcp_disabled' }, base));
    return { ok: false, code: 'mcp_disabled', error: 'serveur MCP desactive : ' + oneLine(srv, 40) + '.' };
  }
  if (!mcpMod.isAllowed(home, srv, tname)) {
    audit(home, Object.assign({ ok: false, code: 'mcp_not_allowed' }, base));
    return { ok: false, code: 'mcp_not_allowed', error: 'outil non autorise (liste administrateur) : ' + srv + '/' + tname };
  }
  const decision = mcpMod.toolDecision(home, srv, tname);
  if (decision === 'deny') {
    audit(home, Object.assign({ ok: false, code: 'mcp_denied_rule' }, base));
    return { ok: false, code: 'mcp_denied_rule', error: 'outil refuse par la politique : ' + srv + '/' + tname };
  }
  if (decision !== 'allow' && o.perm && typeof o.perm.check === 'function') {
    const verdict = o.perm.check({ tool: 'mcp', server: srv, name: tname, args: callArgs });
    if (verdict && verdict.decision === 'deny') {
      audit(home, Object.assign({ ok: false, code: 'denied', why: mask(verdict.reason || '') }, base));
      return { ok: false, code: 'denied', error: verdict.reason || 'appel refuse par la politique.' };
    }
    if (verdict && verdict.decision === 'ask' && !o.preApproved) {
      audit(home, Object.assign({ ok: true, code: 'need-approval' }, base));
      return { ok: false, code: 'need-approval', error: 'approbation requise pour ' + srv + '/' + tname,
        request: { server: srv, tool: tname, args: callArgs } };
    }
  } else if (decision !== 'allow' && !o.preApproved && o.requireApproval !== false) {
    audit(home, Object.assign({ ok: true, code: 'need-approval' }, base));
    return { ok: false, code: 'need-approval', error: 'approbation requise pour ' + srv + '/' + tname,
      request: { server: srv, tool: tname, args: callArgs } };
  }

  const journal = (m) => { if (o.log) { try { o.log.info('mcp', { session: ctx.sessionId || '', msg: mask(m).slice(0, 300) }, ctx.corr); } catch (_) {} } };
  let res = null;
  try {
    res = await mcpMod.callTool(home, srv, tname, callArgs, {}, journal);
  } catch (e) {
    const code = (e && e.code) || 'mcp_error';
    const err = 'MCP ' + srv + '/' + tname + ' : ' + mask(String((e && e.message) || e)).slice(0, 200);
    audit(home, Object.assign({ ok: false, code }, base));
    return { ok: false, code, error: err };
  }
  const text = mask(res && res.text ? String(res.text) : '');
  audit(home, Object.assign({ ok: !!(res && res.ok), code: res && res.ok ? 'ok' : 'mcp_error',
    ms: (res && res.ms) || 0, chars: text.length }, base));
  if (!res || !res.ok) {
    return { ok: false, code: 'mcp_error', error: text.slice(0, 400) || 'echec MCP.' };
  }
  return { ok: true, code: 'ok', text: text.slice(0, 8000), ms: (res && res.ms) || 0 };
}

/** Charge un skill (contenu complet) apres verification qu il est actif. */
function loadSkill(home, root, name) {
  const r = skillsMod.loadSkillText(home, root, name);
  audit(home, { kind: 'skill', name: String(name || '').slice(0, 60), ok: !!r.ok,
    code: r.ok ? 'ok' : (r.code || 'error'), chars: r.ok ? r.text.length : 0 });
  if (!r.ok) return { ok: false, code: r.code || 'error', error: r.error || 'skill illisible.' };
  return { ok: true, name: r.name, scope: r.scope, text: r.text };
}

module.exports = {
  agentDir, auditFile, audit, readAudit, mask, oneLine,
  inventory, summary, suggest, digest, proposalText, describe,
  resolveSecretEnv, callMcp, loadSkill,
  mcpServers, skills, commands, agents, rulesSummary,
  MAX_LINE, MAX_INVENTORY, MAX_DISCOVER_LINES,
};
