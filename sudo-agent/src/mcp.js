// Sudo Agent MCP client, stdio servers (P26-e). Global config (never in
// the project), admin-managed allowlist (fail-closed), hidden-window
// processes, every call under the permission system and journaled.
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (initialize,
// tools/list, tools/call). Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

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

// Global config: { servers: { name: { command, args?, env?, cwd? } } }
function loadConfig(home) {
  const d = readJsonFile(path.join(agentDir(home), 'mcp.json'));
  return d && typeof d.servers === 'object' && d.servers ? d.servers : {};
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

async function connect(home, serverName, journal) {
  reapIdle(journal);
  const hit = clients.get(serverName);
  if (hit && hit.child && !hit.child.killed) { hit.lastUsed = Date.now(); return hit; }
  if (hit) clients.delete(serverName);
  const cfg = loadConfig(home)[serverName];
  if (!cfg || !cfg.command) throw new Error('serveur MCP inconnu: ' + serverName);
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
  const res = await sendReq(c, 'tools/call', { name: toolName, arguments: args || {} }, opts.timeoutMs);
  const ms = Date.now() - t0;
  if (journal) journal('mcp appel ' + serverName + '/' + toolName + ' ok ' + ms + 'ms');
  return { ok: !(res && res.isError), text: textOf(res), ms };
}

function disconnectAll(journal) {
  for (const name of Array.from(clients.keys())) disconnectOne(name, journal);
}

module.exports = {
  agentDir, loadConfig, policyFile, loadPolicy, isAllowed,
  connect, listTools, callTool, disconnectAll, textOf,
  setMcpSpawn, _clients: clients,
};
