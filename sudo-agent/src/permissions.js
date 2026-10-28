// Sudo Agent permission engine (P25-e). Per tool + pattern: ask / allow /
// deny, with 4 operator answers: once | session | project | deny. A default
// deny list (recursive delete, disk format, registry writes, encoded
// commands, download-and-execute) can never be overridden. Session rules
// cover ONLY the exact chosen action (tool + exact pattern). Stdlib only,
// ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Read-only tools run without asking (boundary still enforced by the tools).
const READONLY_AUTO = ['read', 'list', 'glob', 'grep', 'todo', 'reply', 'done'];
// Mutating tools ask unless a session/project rule matches.
const MUTATING_ASK = ['write', 'edit', 'patch', 'bash', 'undo', 'mcp', 'delete', 'rename'];
const KNOWN_TOOLS = READONLY_AUTO.concat(MUTATING_ASK);

// ---------------------------------------------------------------------------
// Default deny list for shell commands. Scanned against the raw command AND
// a quote-stripped variant (fail closed both ways).
// ---------------------------------------------------------------------------
const DENY_LIST = [
  { id: 'recdel', why: 'suppression recursive interdite',
    res: [/\brm\s+[^\n;&|]*-[a-zA-Z]*r/i, /\bdel(\.exe)?\s+[^\n;&|]*\/s/i, /\b(rmdir|rd)(\.exe)?\s+[^\n;&|]*\/s/i,
      /\berase(\.exe)?\s+[^\n;&|]*\/s/i, /\bremove-item\b[^\n;&|]*-(recurse|rf|recurse:\$true)/i, /\bshred\b/i] },
  { id: 'format', why: 'formatage / ecriture disque interdite',
    res: [/\bmkfs(\.[a-z0-9]+)?\b/i, /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\b(fdisk|parted|sfdisk)\b/i,
      /\bcipher\s+\/w/i, /\bdd\s+[^\n;&|]*\bof=\/dev\//i, />\s*\/dev\/(sd|hd|nvme|vd|xvd)/i, /\bmkswap\b/i, /\b:(\(\)\s*\{[^}]*:\s*\|\s*:&\s*\}\s*;\s*:)/] },
  { id: 'registry', why: 'modification du registre interdite',
    res: [/(^|[\s;&|($`])reg(\.exe)?\s+(add|delete|import|save|restore)\b/i, /\bregedit\b/i,
      /\bset-itemproperty\b[^\n;&|]*\bHK(CC|CR|CU|LM|U):/i, /\bnew-item\b[^\n;&|]*\bHK(CC|CR|CU|LM|U):/i] },
  { id: 'encoded', why: 'commande encodee / obscurcie interdite',
    res: [/\b(powershell|pwsh)(\.exe)?\b[^\n;&|]*-(encodedcommand|\be(nc|c)\b)/i, /\bfrombase64string\b/i,
      /\|\s*base64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash|dash|zsh|powershell|pwsh|cmd)\b/i,
      /\bbase64\s+(-d|--decode)\b[^\n]*>\s*\/tmp\/[^\s;&|]+[^\n]*[;&|]/i, /\bcertutil(\.exe)?\b[^\n]*\s-decode\b/i,
      /\biex\s*\(/i, /\beval\s*\(\s*\$\(/i] },
  { id: 'dlnexec', why: 'telechargement puis execution interdit',
    res: [/\b(curl|wget)(\.exe)?\b[^|\n]*\|\s*(sh|bash|dash|zsh|fish|powershell|pwsh|cmd)\b/i,
      /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|\n]*\|\s*(iex|invoke-expression|powershell|pwsh)\b/i,
      /\b(curl|wget)(\.exe)?\b[^\n;&|]*-o\s+\S+[^\n]*[;&|][^\n]*\b(chmod\s+\+x|sh|bash)\b/i,
      /\bbitsadmin(\.exe)?\b[^\n]*\/transfer\b/i] },
];

function stripQuotes(s) {
  return String(s || '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
}

// Returns { id, why } or null.
function matchDenyList(cmd) {
  const variants = [String(cmd || ''), stripQuotes(cmd)];
  for (const entry of DENY_LIST) {
    for (const re of entry.res) {
      re.lastIndex = 0;
      for (const v of variants) {
        re.lastIndex = 0;
        if (re.test(v)) return { id: entry.id, why: entry.why };
      }
    }
  }
  return null;
}

function denyIds() {
  return DENY_LIST.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Patterns: what a session/project rule covers. Exact match only.
// ---------------------------------------------------------------------------
function normCommand(cmd) {
  return String(cmd || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// target: { kind:'file', rel } | { kind:'command', text } | { kind:'pattern', text } | { kind:'scope', text }.
function patternOf(tool, args, resolved) {
  args = args || {};
  if (tool === 'read' || tool === 'list' || tool === 'write' || tool === 'edit' || tool === 'patch' ||
      tool === 'delete' || tool === 'rename') {
    const rel = resolved && typeof resolved.rel === 'string' ? resolved.rel : String(args.file || args.from || args.dir || args.path || '');
    return { kind: 'file', text: rel.slice(0, 500) };
  }
  if (tool === 'glob') return { kind: 'pattern', text: String(args.pattern || '').slice(0, 300) };
  if (tool === 'grep') {
    return { kind: 'pattern', text: (String(args.pattern || '') + ' @ ' + String(args.path || args.dir || '.')).slice(0, 500) };
  }
  if (tool === 'bash') return { kind: 'command', text: normCommand(args.command) };
  if (tool === 'todo') return { kind: 'scope', text: 'session-todos' };
  if (tool === 'reply' || tool === 'done') return { kind: 'scope', text: 'final-answer' };
  if (tool === 'undo') return { kind: 'scope', text: String(args.scope || 'last') };
  return { kind: 'scope', text: '?' };
}

function ruleKey(tool, pattern) {
  return tool + '|' + (pattern && pattern.kind ? pattern.kind : '?') + '|' + (pattern && pattern.text ? pattern.text : '');
}

// opts: { tool, pattern, p8verdict, sessionRules:Set, projectRules:Set }
// Returns { decision:'allow'|'deny'|'ask', reason, rule?:'session'|'project' }.
function check(opts) {
  opts = opts || {};
  const tool = opts.tool;
  if (KNOWN_TOOLS.indexOf(tool) === -1) return { decision: 'deny', reason: 'outil inconnu.' };
  if (opts.p8verdict && opts.p8verdict.verdict === 'deny') {
    return { decision: 'deny', reason: 'P8 sandbox: ' + (opts.p8verdict.reason || 'refuse') };
  }
  if (opts.denyList) return { decision: 'deny', reason: 'liste de refus (' + opts.denyList.id + '): ' + opts.denyList.why + '.' };
  const key = ruleKey(tool, opts.pattern);
  if (opts.sessionRules && opts.sessionRules.has(key)) return { decision: 'allow', reason: 'regle de session.', rule: 'session' };
  if (opts.projectRules && opts.projectRules.has(key)) return { decision: 'allow', reason: 'regle de projet.', rule: 'project' };
  if (READONLY_AUTO.indexOf(tool) !== -1) return { decision: 'allow', reason: 'lecture seule (autorise).' };
  return { decision: 'ask', reason: 'validation operateur requise.' };
}

// ---------------------------------------------------------------------------
// Project-scoped rules, stored OUTSIDE the project, keyed by root hash.
// ---------------------------------------------------------------------------
function rulesFile(home, root) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  const digest = crypto.createHash('sha1').update(String(root)).digest('hex');
  return path.join(String(h), '.sudo_studio', 'agent', 'rules', digest + '.json');
}

function loadProjectRules(home, root) {
  const file = rulesFile(home, root);
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !Array.isArray(d.rules)) return { file, rules: new Set() };
    const set = new Set();
    for (const r of d.rules) {
      if (r && typeof r.tool === 'string' && r.pattern && typeof r.pattern.text === 'string') {
        set.add(ruleKey(r.tool, r.pattern));
      }
    }
    return { file, rules: set };
  } catch (_) { return { file, rules: new Set() }; }
}

function saveProjectRule(home, root, tool, pattern) {
  const file = rulesFile(home, root);
  let current = { root: String(root), rules: [] };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && Array.isArray(d.rules)) current = d;
  } catch (_) {}
  const key = ruleKey(tool, pattern);
  const exists = current.rules.some((r) => r && ruleKey(r.tool, r.pattern) === key);
  if (!exists) {
    current.rules.push({ tool, pattern: { kind: pattern.kind, text: pattern.text }, at: new Date().toISOString() });
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }
  return file;
}

module.exports = {
  READONLY_AUTO,
  MUTATING_ASK,
  KNOWN_TOOLS,
  DENY_LIST,
  matchDenyList,
  denyIds,
  normCommand,
  patternOf,
  ruleKey,
  check,
  rulesFile,
  loadProjectRules,
  saveProjectRule,
};
