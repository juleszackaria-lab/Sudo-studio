// Sudo Agent custom agents + global rules (P54-4/5).
// Built-in agents stay Build and Plan (modes.js). This module stores the
// USER-defined agents (name, instructions, allowed tools, model/provider) and
// the GLOBAL rules file that complements the per-project AGENTS.md.
// Stdlib only, ASCII only. Nothing is logged here.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;
const MAX_INSTRUCTIONS = 16 * 1024;
const MAX_AGENTS = 32;

function agentDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent');
}

function agentsFile(home) { return path.join(agentDir(home), 'agents.json'); }
function globalRulesFile(home) { return path.join(agentDir(home), 'rules.md'); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); return true; } catch (_) { return false; }
}

function slug(name) { return String(name || '').trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40); }

function loadAgents(home) {
  const d = readJson(agentsFile(home));
  const list = d && Array.isArray(d.agents) ? d.agents : [];
  return list.filter((a) => a && typeof a.name === 'string' && NAME_RE.test(a.name)).map((a) => ({
    name: a.name,
    description: String(a.description || '').slice(0, 200),
    instructions: String(a.instructions || '').slice(0, MAX_INSTRUCTIONS),
    tools: Array.isArray(a.tools) ? a.tools.filter((t) => typeof t === 'string').slice(0, 40) : [],
    model: String(a.model || '').slice(0, 120),
    provider: String(a.provider || '').slice(0, 40),
  }));
}

// Built-ins are NOT stored: they are the product agents, always available.
function listAgents(home) {
  const custom = loadAgents(home);
  return [
    { name: 'Build', builtin: true, description: 'Agent par defaut : modifie le projet.', tools: [], model: '', provider: '' },
    { name: 'Plan', builtin: true, description: 'Agent par defaut : propose, ne modifie jamais.', tools: [], model: '', provider: '' },
  ].concat(custom.map((a) => Object.assign({}, a, { builtin: false })));
}

// Built-in agents are resolvable too: naming "Build" or "Plan" in a sub-agent
// call returns the default agent definition instead of "unknown agent".
const BUILTIN = [
  { name: 'Build', builtin: true, description: 'Agent par defaut : modifie le projet.', instructions: '', tools: [], model: '', provider: '' },
  { name: 'Plan', builtin: true, description: 'Agent par defaut : propose, ne modifie jamais.', instructions: '', tools: [], model: '', provider: '' },
];

function findAgent(home, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  const b = BUILTIN.filter((a) => a.name.toLowerCase() === lower)[0];
  if (b) return Object.assign({}, b);
  return loadAgents(home).filter((a) => a.name.toLowerCase() === lower)[0] || null;
}

function saveAgent(home, spec) {
  spec = spec || {};
  const name = slug(spec.name);
  if (!name || !NAME_RE.test(name)) return { ok: false, error: 'nom d\'agent invalide (lettres, chiffres, espaces, - _).' };
  if (name.toLowerCase() === 'build' || name.toLowerCase() === 'plan') {
    return { ok: false, error: 'Build et Plan sont les agents par defaut : choisissez un autre nom.' };
  }
  const instructions = String(spec.instructions || '');
  if (instructions.length > MAX_INSTRUCTIONS) return { ok: false, error: 'instructions trop longues (>16 Ko).' };
  const tools = Array.isArray(spec.tools) ? spec.tools.filter((t) => typeof t === 'string').slice(0, 40) : [];
  const list = loadAgents(home);
  const entry = { name, description: String(spec.description || '').slice(0, 200), instructions,
    tools, model: String(spec.model || '').slice(0, 120), provider: String(spec.provider || '').slice(0, 40) };
  const i = list.findIndex((a) => a.name.toLowerCase() === name.toLowerCase());
  if (i === -1) {
    if (list.length >= MAX_AGENTS) return { ok: false, error: 'trop d\'agents (32 max).' };
    list.push(entry);
  } else {
    list[i] = entry;
  }
  if (!writeJson(agentsFile(home), { agents: list })) return { ok: false, error: 'ecriture impossible (agents.json).' };
  return { ok: true, agent: entry };
}

function deleteAgent(home, name) {
  const list = loadAgents(home);
  const next = list.filter((a) => a.name.toLowerCase() !== String(name || '').toLowerCase());
  if (next.length === list.length) return { ok: false, error: 'agent introuvable : ' + String(name || '').slice(0, 40) };
  if (!writeJson(agentsFile(home), { agents: next })) return { ok: false, error: 'ecriture impossible (agents.json).' };
  return { ok: true };
}

// ---- global rules -----------------------------------------------------------
function readGlobalRules(home) {
  try { return fs.readFileSync(globalRulesFile(home), 'utf8'); } catch (_) { return ''; }
}

function saveGlobalRules(home, text) {
  const t = String(text === undefined || text === null ? '' : text);
  if (t.length > 64 * 1024) return { ok: false, error: 'regles trop longues (>64 Ko).' };
  const p = globalRulesFile(home);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(p, t, 'utf8'); } catch (e) { return { ok: false, error: 'ecriture impossible : ' + String((e && e.message) || e).slice(0, 120) }; }
  return { ok: true, bytes: t.length };
}

module.exports = { NAME_RE, agentDir, agentsFile, globalRulesFile, loadAgents, listAgents, findAgent,
  saveAgent, deleteAgent, readGlobalRules, saveGlobalRules };
