// Sudo Agent MCP client, stdio servers (P26-e). Global config (never in
// the project), admin-managed allowlist (fail-closed), hidden-window
// processes, every call under the permission system and journaled.
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (initialize,
// tools/list, tools/call). Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');
const keyring = require('./keyring');

let spawnFn = null; // test seam: setMcpSpawn(fn) overrides childProcess.spawn
function setMcpSpawn(fn) { spawnFn = fn; }
function spawner() { return spawnFn || childProcess.spawn; }

function agentDir(home) {
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent');
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

// Global config: { servers: { name: stdio | http } }.
// stdio: { command, args?, env?, cwd? }; http: { url, headers?, tokenTarget?, timeoutMs? }.
// Secrets NEVER live here: tokenTarget names a keyring entry holding the
// bearer token (P50-1). The file holds names, never values.
function loadConfig(home) {
  const d = readJsonFile(path.join(agentDir(home), 'mcp.json'));
  return d && typeof d.servers === 'object' && d.servers ? d.servers : {};
}

// P50-1: validate + persist server entries (used by the HTTP endpoints and
// the "MCP Servers" page). Returns null when valid, else a French error.
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_RE_SRC = '^[A-Za-z0-9_][A-Za-z0-9_.\\/-]{0,127}$';

function isLocalhostUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch (_) { return false; }
}

function validateServerConfig(name, cfg) {
  if (!NAME_RE.test(String(name || ''))) return 'nom de serveur invalide (lettres, chiffres, - _).';
  if (!cfg || typeof cfg !== 'object') return 'configuration manquante.';
  const transport = cfg.transport || (cfg.url ? 'http' : 'stdio');
  if (transport === 'http') {
    if (typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url)) return 'url http(s) requise.';
    if (cfg.url.length > 500) return 'url trop longue.';
    if (/^http:\/\//.test(cfg.url) && !isLocalhostUrl(cfg.url)) return 'http distant refuse: https requis hors localhost.';
    if (cfg.headers !== undefined) {
      if (!cfg.headers || typeof cfg.headers !== 'object' || Array.isArray(cfg.headers)) return 'headers invalides.';
      for (const k of Object.keys(cfg.headers)) {
        if (String(k).toLowerCase() === 'authorization') return 'en-tete Authorization interdit: utilisez tokenTarget (trousseau).';
        if (typeof cfg.headers[k] !== 'string' || cfg.headers[k].length > 2000) return 'valeur header invalide.';
      }
    }
    if (cfg.tokenTarget !== undefined && cfg.tokenTarget !== null && cfg.tokenTarget !== '') {
      if (typeof cfg.tokenTarget !== 'string' || !(new RegExp(TARGET_RE_SRC)).test(cfg.tokenTarget)) return 'tokenTarget invalide.';
    }
    if (cfg.timeoutMs !== undefined && (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 120000)) return 'timeoutMs invalide (1000..120000).';
    return null;
  }
  if (transport === 'stdio') {
    if (typeof cfg.command !== 'string' || !cfg.command.trim() || cfg.command.length > 500) return 'commande requise.';
    if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== 'string' || a.length > 2000))) return 'args invalides.';
    if (cfg.cwd !== undefined && (typeof cfg.cwd !== 'string' || cfg.cwd.length > 500)) return 'cwd invalide.';
    // NOTE: env may hold secrets in clear; documented. Prefer tokenTarget
    // (keyring) for tokens; env is for non-secret variables.
    if (cfg.env !== undefined && (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env))) return 'env invalide.';
    return null;
  }
  return 'transport invalide (stdio|http).';
}

function saveConfig(home, servers) {
  const dir = agentDir(home);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const p = path.join(dir, 'mcp.json');
  fs.writeFileSync(p, JSON.stringify({ servers }, null, 2) + '\n', 'utf8');
  return p;
}

// Redacted public view of one server entry (names only, never values).
function describeServer(name, cfg, policy) {
  const httpCfg = isHttpCfg(cfg);
  const allow = policy ? policy[name] : undefined;
  return {
    name,
    transport: httpCfg ? 'http' : 'stdio',
    command: httpCfg ? undefined : String(cfg.command || ''),
    url: httpCfg ? safeUrl(cfg.url) : undefined,
    hasTokenTarget: !!(cfg.tokenTarget),
    allowlist: allow === '*' ? '*' : (Array.isArray(allow) ? allow.slice(0, 100) : []),
  };
}

// P50-1: test a server: connect + tools/list, then disconnect. Throws coded
// errors (mcp_unreachable, mcp_auth_failed, ...). Never returns secrets.
async function testServer(home, name, journal, timeoutMs) {
  const t0 = Date.now();
  const tools = await listTools(home, name, journal);
  try { disconnectOne(name, journal); } catch (_) {}
  const cfg = loadConfig(home)[name] || {};
  return { ok: true, transport: isHttpCfg(cfg) ? 'http' : 'stdio', tools: tools.map((t) => String(t.name || '')).filter(Boolean).slice(0, 200), ms: Date.now() - t0 };
}

function isHttpCfg(cfg) {
  return !!cfg && typeof cfg.url === 'string' && /^https?:\/\//.test(cfg.url);
}

function safeUrl(u) {
  return String(u || '').split('?')[0].slice(0, 200);
}

// Admin allowlist: { allowed: { server: ['tool', ...] | '*' } }. Fail-closed.
function policyFile(home) {
  if (process.env.SUDO_AGENT_MCP_POLICY) return String(process.env.SUDO_AGENT_MCP_POLICY);
  return path.join(agentDir(home), 'mcp_policy.json');
}

function loadPolicy(home) {
  const d = readJsonFile(policyFile(home));
  return d && typeof d.allowed === 'object' && d.allowed ? d.allowed : {};
}

function isAllowed(home, server, tool) {
  const allow = loadPolicy(home)[server];
  if (allow === '*') return true;
  return Array.isArray(allow) && allow.indexOf(tool) !== -1;
}

function filteredEnv(extra) {
  const keep = ['PATH', 'SystemRoot', 'windir', 'TMP', 'TEMP', 'HOME', 'USER', 'LANG', 'LC_ALL', 'NODE_PATH', 'PYTHONPATH'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) env[k] = String(extra[k]);
  }
  return env;
}

function nextId(c) { c.seq += 1; return c.seq; }

function sendReq(client, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId(client);
    const timer = setTimeout(() => {
      delete client.pending[id];
      reject(new Error('timeout appel MCP (' + method + ')'));
    }, timeoutMs || 15000);
    client.pending[id] = { resolve, reject, timer, method };
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    try { client.child.stdin.write(line + '\n'); }
    catch (e) { clearTimeout(timer); delete client.pending[id]; reject(e); }
  });
}

function onData(client, chunk, journal) {
  client.buf += String(chunk || '');
  let nl;
  while ((nl = client.buf.indexOf('\n')) !== -1) {
    const line = client.buf.slice(0, nl).trim();
    client.buf = client.buf.slice(nl + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg && msg.id !== undefined && client.pending[msg.id]) {
      const p = client.pending[msg.id];
      delete client.pending[msg.id];
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error('MCP ' + (msg.error.message || 'rpc error')));
      else p.resolve(msg.result);
    } else if (msg && msg.method && journal) {
      journal('mcp notif ' + client.name + ': ' + msg.method);
    }
  }
}

// Live clients, keyed by server name. Idle ones are disconnected lazily.
const clients = new Map();
const IDLE_MS = 10 * 60 * 1000;

// P50-1: Streamable HTTP transport (remote MCP servers). Single-shot
// POST per JSON-RPC request; the Mcp-Session-Id is reused when the
// server provides one. Responses are plain JSON or SSE event streams.

// Pure: last JSON-RPC message carried by an SSE stream (or null).
function parseSseResponses(text, reqId) {
  let fallback = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line.indexOf('data:') !== 0) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let msg = null;
    try { msg = JSON.parse(payload); } catch (_) { continue; }
    if (!msg || typeof msg !== 'object') continue;
    if (reqId !== undefined && msg.id === reqId) return msg;
    fallback = msg;
  }
  return fallback;
}

function httpPost(url, bodyObj, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u = null;
    try { u = new URL(url); } catch (_) { reject(new Error('URL MCP invalide.')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('URL MCP invalide.')); return; }
    const payload = JSON.stringify(bodyObj);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      timeout: timeoutMs || 15000,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
      }, headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += String(c || ''); if (data.length > 1048576) { try { req.destroy(); } catch (_) {} } });
      res.on('end', () => {
        const sessionId = res.headers && res.headers['mcp-session-id'];
        resolve({ status: res.statusCode || 0, ctype: String((res.headers && res.headers['content-type']) || ''), data, sessionId: sessionId ? String(sessionId) : null });
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', (e) => reject(e));
    try { req.write(payload); req.end(); } catch (e) { reject(e); }
  });
}

async function httpRpc(client, method, params, id, timeoutMs) {
  const cfg = client.httpCfg;
  const headers = {};
  if (cfg.headers && typeof cfg.headers === 'object') {
    for (const k of Object.keys(cfg.headers)) headers[String(k)] = String(cfg.headers[k]).slice(0, 500);
  }
  if (client.sessionId) headers['Mcp-Session-Id'] = client.sessionId;
  if (cfg.tokenTarget) {
    const tk = await keyring.getSecret(cfg.tokenTarget);
    if (!tk.ok) {
      throw Object.assign(new Error('jeton MCP manquant pour ' + client.name + ' (' + cfg.tokenTarget + ').'), { code: 'mcp_no_token' });
    }
    headers['Authorization'] = 'Bearer ' + tk.secret;
  }
  let r = null;
  try {
    r = await httpPost(cfg.url, { jsonrpc: '2.0', id, method, params: params || {} }, headers, timeoutMs || cfg.timeoutMs);
  } catch (e) {
    throw Object.assign(new Error('MCP ' + client.name + ' injoignable (' + safeUrl(cfg.url) + ').'), { code: 'mcp_unreachable' });
  }
  if (r.sessionId) client.sessionId = r.sessionId;
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(new Error('MCP ' + client.name + ' refuse (auth).'), { code: 'mcp_auth' });
  }
  if (r.status < 200 || r.status >= 300) {
    throw Object.assign(new Error('MCP ' + client.name + ' HTTP ' + r.status + '.'), { code: 'mcp_http' });
  }
  let msg = null;
  if (r.ctype.indexOf('text/event-stream') !== -1) msg = parseSseResponses(r.data, id);
  else { try { msg = JSON.parse(r.data); } catch (_) { msg = null; } }
  if (!msg || typeof msg !== 'object') throw Object.assign(new Error('MCP ' + client.name + ' reponse illisible.'), { code: 'mcp_bad_response' });
  if (msg.error) throw new Error('MCP ' + (msg.error.message || 'rpc error'));
  return msg.result;
}

function disconnectOne(name, journal, clientsMap) {
  const map = clientsMap || clients;
  const c = map.get(name);
  if (!c) return;
  map.delete(name);
  for (const id of Object.keys(c.pending || {})) {
    try { clearTimeout(c.pending[id].timer); c.pending[id].reject(new Error('client MCP ferme')); } catch (_) {}
  }
  try { if (c.child && !c.child.killed) c.child.kill(); } catch (_) {}
  if (journal) journal('mcp deconnecte: ' + name);
}

function reapIdle(journal) {
  const now = Date.now();
  for (const [name, c] of clients) {
    if (now - (c.lastUsed || 0) > IDLE_MS) disconnectOne(name, journal);
  }
}

async function connectHttp(home, serverName, cfg, journal) {
  const client = { name: serverName, http: true, httpCfg: cfg, sessionId: null, seq: 0, lastUsed: Date.now(), tools: null };
  clients.set(serverName, client);
  if (journal) journal('mcp connecte (http): ' + serverName + ' ' + safeUrl(cfg.url));
  const initId = 1;
  await httpRpc(client, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sudo-agent', version: '0.1.0' },
  }, initId, cfg.timeoutMs);
  client.seq = initId;
  const listed = await httpRpc(client, 'tools/list', {}, 2, cfg.timeoutMs);
  client.seq = 2;
  client.tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
  return client;
}

async function connect(home, serverName, journal) {
  reapIdle(journal);
  const hit = clients.get(serverName);
  if (hit && hit.http) { hit.lastUsed = Date.now(); return hit; }
  if (hit && hit.child && !hit.child.killed) { hit.lastUsed = Date.now(); return hit; }
  if (hit) clients.delete(serverName);
  const cfg = loadConfig(home)[serverName];
  if (!cfg) throw new Error('serveur MCP inconnu: ' + serverName);
  if (isHttpCfg(cfg)) return connectHttp(home, serverName, cfg, journal);
  if (!cfg.command) throw new Error('serveur MCP inconnu: ' + serverName);
  const child = spawner()(String(cfg.command), (cfg.args || []).map(String), {
    cwd: cfg.cwd || process.cwd(),
    env: filteredEnv(cfg.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: false,
  });
  const client = { name: serverName, child, buf: '', seq: 0, pending: {}, lastUsed: Date.now(), tools: null };
  child.stdout.on('data', (d) => onData(client, d, journal));
  child.stderr.on('data', (d) => { if (journal) journal('mcp stderr ' + serverName + ': ' + String(d).slice(0, 300)); });
  child.on('error', (e) => {
    for (const id of Object.keys(client.pending)) {
      try { clearTimeout(client.pending[id].timer); client.pending[id].reject(e); } catch (_) {}
    }
    client.pending = {};
  });
  child.on('exit', () => disconnectOne(serverName, journal));
  clients.set(serverName, client);
  if (journal) journal('mcp connecte: ' + serverName + ' (pid ' + (child.pid || '?') + ')');
  await sendReq(client, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sudo-agent', version: '0.1.0' },
  });
  try { client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch (_) {}
  const listed = await sendReq(client, 'tools/list', {});
  client.tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
  return client;
}

async function listTools(home, serverName, journal) {
  const c = await connect(home, serverName, journal);
  c.lastUsed = Date.now();
  return c.tools || [];
}

function textOf(result) {
  if (!result) return '';
  const c = result.content;
  if (Array.isArray(c)) {
    return c.map((b) => (b && typeof b.text === 'string') ? b.text : JSON.stringify(b)).join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

async function callTool(home, serverName, toolName, args, opts, journal) {
  opts = opts || {};
  if (!isAllowed(home, serverName, toolName)) {
    throw Object.assign(new Error('outil MCP non autorise: ' + serverName + '/' + toolName), { code: 'mcp_not_allowed' });
  }
  const t0 = Date.now();
  const c = await connect(home, serverName, journal);
  c.lastUsed = Date.now();
  let res = null;
  if (c.http) {
    c.seq += 1;
    res = await httpRpc(c, 'tools/call', { name: toolName, arguments: args || {} }, c.seq, opts.timeoutMs);
  } else {
    res = await sendReq(c, 'tools/call', { name: toolName, arguments: args || {} }, opts.timeoutMs);
  }
  const ms = Date.now() - t0;
  if (journal) journal('mcp appel ' + serverName + '/' + toolName + ' ok ' + ms + 'ms');
  return { ok: !(res && res.isError), text: textOf(res), ms };
}

function disconnectAll(journal) {
  for (const name of Array.from(clients.keys())) disconnectOne(name, journal);
}

module.exports = {
  agentDir, loadConfig, saveConfig, policyFile, loadPolicy, isAllowed,
  validateServerConfig, describeServer, testServer,
  connect, listTools, callTool, disconnectAll, textOf,
  setMcpSpawn, _clients: clients,
  isHttpCfg, parseSseResponses, safeUrl,
};
