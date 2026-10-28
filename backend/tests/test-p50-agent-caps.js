// MISSION P50 - Capacites avancees de l'agent : preuves deterministes.
// Groupe A (item 1, coeur) : MCP HTTP distant (JSON + SSE), jetons via
// trousseau (jamais fichier/journal), allowlist imposee. Serveur MCP
// fictif en boucle locale. Stdlib only, ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'sudo-agent', 'src');

const mcp = require(path.join(AGENT_SRC, 'mcp.js'));
const keyring = require(path.join(AGENT_SRC, 'keyring.js'));
const skills = require(path.join(AGENT_SRC, 'skills.js'));
const execm = require(path.join(AGENT_SRC, 'exec.js'));
const genm = require(path.join(AGENT_SRC, 'gen.js'));
const bizm = require(path.join(AGENT_SRC, 'biz.js'));
const tools = require(path.join(AGENT_SRC, 'tools.js'));
const cproc = require('child_process');
const { runTurn } = require(path.join(AGENT_SRC, 'loop.js'));
const { createLogger } = require(path.join(AGENT_SRC, 'journal.js'));
const { SessionStore } = require(path.join(AGENT_SRC, 'store.js'));

let PASS = 0;
const FAILS = [];
function t(name, fn) { return { name, fn }; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

function writeMcpHome(home, servers, allowed) {
  const dir = path.join(home, '.sudo_studio', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ servers }), 'utf8');
  fs.writeFileSync(path.join(dir, 'mcp_policy.json'), JSON.stringify({ allowed }), 'utf8');
}

// Fixture: serveur MCP HTTP minimal (JSON-RPC). opts: { token?, sseCall? }.
function mockMcpHttp(opts) {
  opts = opts || {};
  const seen = { auth: [] };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (opts.token) {
        const a = String(req.headers.authorization || '');
        seen.auth.push(a);
        if (a !== 'Bearer ' + opts.token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad token' }));
          return;
        }
      }
      let msg = null;
      try { msg = JSON.parse(raw); } catch (_) { msg = {}; }
      const result = (msg.method === 'initialize')
        ? { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } }
        : (msg.method === 'tools/list')
          ? { tools: [{ name: 'echo', description: 'renvoie le texte' }, { name: 'ssecho', description: 'via SSE' }] }
          : { content: [{ type: 'text', text: 'ECHO:' + JSON.stringify((msg.params && msg.params.arguments) || {}) }] };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id === undefined ? 1 : msg.id, result });
      res.setHeader('Mcp-Session-Id', 'sess-mock');
      if (opts.sseCall && msg.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: message\ndata: ' + payload + '\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, url: 'http://127.0.0.1:' + srv.address().port + '/mcp', seen,
        close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

const tests = [
t('A1 HTTP JSON : liste + appel', async () => {
  const mock = await mockMcpHttp({});
  const home = tmp('p50home');
  const jlines = [];
  try {
    writeMcpHome(home, { demo: { url: mock.url } }, { demo: '*' });
    const tools = await mcp.listTools(home, 'demo', (l) => jlines.push(l));
    assert(tools.length === 2 && tools[0].name === 'echo', 'outils: ' + JSON.stringify(tools));
    const r = await mcp.callTool(home, 'demo', 'echo', { a: 1 }, {}, (l) => jlines.push(l));
    assert(r.ok === true && r.text.indexOf('ECHO:') === 0, 'appel: ' + JSON.stringify(r));
    assert(typeof r.ms === 'number', 'duree mesuree');
    assert(jlines.join('\n').indexOf('demo') !== -1, 'journalise');
  } finally { mcp.disconnectAll(null); await mock.close(); }
}),
t('A2 HTTP SSE : appel parse', async () => {
  const mock = await mockMcpHttp({ sseCall: true });
  const home = tmp('p50home');
  try {
    writeMcpHome(home, { sse: { url: mock.url } }, { sse: '*' });
    const r = await mcp.callTool(home, 'sse', 'ssecho', { b: 2 }, {}, null);
    assert(r.ok === true && r.text.indexOf('ECHO:') === 0, 'sse: ' + JSON.stringify(r));
  } finally { mcp.disconnectAll(null); await mock.close(); }
}),
t('A3 jeton trousseau : envoye, jamais journalise', async () => {
  const mock = await mockMcpHttp({ token: 'TOK-SECRET-1' });
  const home = tmp('p50home');
  const jlines = [];
  keyring.setKeyringRunner(async (script) => {
    assert(script.indexOf('TOK-SECRET-1') === -1, 'secret en clair dans le script!');
    return { code: 0, stdout: 'TOK-SECRET-1', stderr: '' };
  });
  try {
    writeMcpHome(home, { gh: { url: mock.url, tokenTarget: 'SudoStudio/mcp/gh' } }, { gh: '*' });
    const r = await mcp.callTool(home, 'gh', 'echo', {}, {}, (l) => jlines.push(l));
    assert(r.ok === true, 'appel auth: ' + JSON.stringify(r));
    assert(mock.seen.auth.length >= 1 && mock.seen.auth[0] === 'Bearer TOK-SECRET-1', 'header envoye');
    assert(jlines.join('\n').indexOf('TOK-SECRET-1') === -1, 'secret dans le journal!');
  } finally { keyring.setKeyringRunner(null); mcp.disconnectAll(null); await mock.close(); }
}),
t('A4 jeton manquant : erreur claire, pas de secret', async () => {
  const mock = await mockMcpHttp({ token: 'X' });
  const home = tmp('p50home');
  keyring.setKeyringRunner(async () => ({ code: 1, stdout: '', stderr: 'NOTFOUND:1168' }));
  try {
    writeMcpHome(home, { gh2: { url: mock.url, tokenTarget: 'SudoStudio/mcp/gh2' } }, { gh2: '*' });
    let err = null;
    try { await mcp.callTool(home, 'gh2', 'echo', {}, {}, null); } catch (e) { err = e; }
    assert(err && err.code === 'mcp_no_token', 'code: ' + (err && (err.code + ' ' + err.message)));
    assert(String(err.message).indexOf('SudoStudio/mcp/gh2') !== -1, 'cible nommee');
  } finally { keyring.setKeyringRunner(null); mcp.disconnectAll(null); await mock.close(); }
}),
t('A5 allowlist imposee sur HTTP', async () => {
  const mock = await mockMcpHttp({});
  const home = tmp('p50home');
  try {
    writeMcpHome(home, { lim: { url: mock.url } }, { lim: ['echo'] });
    let err = null;
    try { await mcp.callTool(home, 'lim', 'ssecho', {}, {}, null); } catch (e) { err = e; }
    assert(err && err.code === 'mcp_not_allowed', 'refus: ' + (err && err.code));
    const r = await mcp.callTool(home, 'lim', 'echo', {}, {}, null);
    assert(r.ok === true, 'autorise passe');
  } finally { mcp.disconnectAll(null); await mock.close(); }
}),
t('A6 injoignable : erreur claire', async () => {
  const home = tmp('p50home');
  try {
    writeMcpHome(home, { down: { url: 'http://127.0.0.1:9/mcp', timeoutMs: 1500 } }, { down: '*' });
    let err = null;
    try { await mcp.listTools(home, 'down', null); } catch (e) { err = e; }
    assert(err && err.code === 'mcp_unreachable', 'code: ' + (err && (err.code + ' ' + err.message)));
  } finally { mcp.disconnectAll(null); }
}),
t('A7 trousseau : validation + couture', async () => {
  assert(keyring.validTarget('SudoStudio/mcp/gh') === true, 'cible ok');
  assert(keyring.validTarget('../x') === false && keyring.validTarget('') === false, 'cibles refusees');
  let r = await keyring.setSecret('bad target!', 's');
  assert(r.ok === false && r.code === 'bad_args', 'set cible');
  r = await keyring.setSecret('SudoStudio/mcp/gh', '');
  assert(r.ok === false && r.code === 'bad_args', 'set vide');
  const seen = [];
  keyring.setKeyringRunner(async (script) => { seen.push(script); return { code: 0, stdout: 'OK', stderr: '' }; });
  try {
    r = await keyring.setSecret('SudoStudio/mcp/gh', 's3cr3t!');
    assert(r.ok === true, 'set ok');
    assert(seen.length === 1 && seen[0].indexOf('SudoStudio/mcp/gh') !== -1, 'cible dans le script');
    assert(seen[0].indexOf('s3cr3t!') === -1 && seen[0].indexOf('FromBase64String') !== -1, 'secret base64, pas en clair');
    assert(seen[0].indexOf('CredWrite') !== -1, 'op CredWrite');
    r = await keyring.getSecret('SudoStudio/mcp/gh');
    assert(r.ok === true, 'get ok (couture)');
    r = await keyring.deleteSecret('SudoStudio/mcp/gh');
    assert(r.ok === true, 'delete ok');
  } finally { keyring.setKeyringRunner(null); }
}),
t('A8 unites pures SSE/URL', async () => {
  const m = mcp.parseSseResponses('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"a":1}}\n\ndata: [DONE]\n', 7);
  assert(m && m.result && m.result.a === 1, 'sse id');
  assert(mcp.parseSseResponses('pas de data\n', 1) === null, 'sse vide');
  assert(mcp.isHttpCfg({ url: 'https://x/mcp' }) === true, 'http oui');
  assert(mcp.isHttpCfg({ command: 'npx' }) === false, 'stdio non');
  assert(mcp.safeUrl('https://x/mcp?token=abc') === 'https://x/mcp', 'requete coupee');
}),
// ---- groupe B : endpoints agent reels (HTTP local, home temporaire) ------
t('B0 validation unitaire des configs', async () => {
  assert(mcp.validateServerConfig('ok-name_1', { transport: 'stdio', command: 'npx' }) === null, 'stdio ok');
  assert(mcp.validateServerConfig('mauvais nom!', { transport: 'stdio', command: 'x' }) !== null, 'nom refuse');
  assert(mcp.validateServerConfig('h', { transport: 'http', url: 'http://example.com/mcp' }) !== null, 'http distant refuse');
  assert(mcp.validateServerConfig('h', { transport: 'http', url: 'http://127.0.0.1:1/mcp' }) === null, 'http local ok');
  assert(mcp.validateServerConfig('h', { transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'x' } }) !== null, 'Authorization refuse');
  assert(mcp.validateServerConfig('h', { transport: 'http', url: 'https://example.com/mcp', tokenTarget: 'SudoStudio/mcp/h' }) === null, 'https + cible ok');
  assert(mcp.validateServerConfig('h', { transport: 'carrier' }) !== null, 'transport refuse');
  const d = mcp.describeServer('h', { url: 'https://example.com/mcp?t=1', tokenTarget: 'SudoStudio/mcp/h' }, {});
  assert(d.url === 'https://example.com/mcp' && d.hasTokenTarget === true && !('tokenTarget' in d || 'headers' in d), 'vue caviardee: ' + JSON.stringify(d));
}),
t('B1 endpoints CRUD stdio (+ validation)', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    let r = await agentReq(port, token, 'GET', '/mcp/servers');
    assert(r.status === 200 && Array.isArray(r.body.servers) && r.body.servers.length === 0, 'liste vide: ' + r.status);
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'loc', transport: 'stdio', command: 'node', args: ['x.js'] });
    assert(r.status === 201 && r.body.server && r.body.server.transport === 'stdio', 'ajout: ' + r.status);
    r = await agentReq(port, token, 'GET', '/mcp/servers');
    assert(r.status === 200 && r.body.servers.length === 1 && r.body.servers[0].command === 'node'
      && !('args' in r.body.servers[0]) && !('env' in r.body.servers[0]), 'liste caviardee: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'mauvais nom!', transport: 'stdio', command: 'x' });
    assert(r.status === 400, 'nom refuse: ' + r.status);
  } finally { await close(); }
}),
t('B2 regles HTTP (https distant, pas Authorization, tokenTarget)', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    let r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'remote', transport: 'http', url: 'http://example.com/mcp' });
    assert(r.status === 400 && /https/.test(r.body.error), 'http distant: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    assert(r.status === 400 && /tokenTarget/.test(r.body.error), 'Authorization: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'remote', transport: 'http', url: 'https://example.com/mcp', tokenTarget: 'bad target!' });
    assert(r.status === 400, 'cible: ' + r.status);
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'remote', transport: 'http', url: 'https://example.com/mcp', tokenTarget: 'SudoStudio/mcp/remote' });
    assert(r.status === 201 && r.body.server.hasTokenTarget === true, 'https + cible: ' + JSON.stringify(r.body));
    assert(!JSON.stringify(r.body).includes('Bearer'), 'zero secret en reponse');
  } finally { await close(); }
}),
t('B3 suppression + 404', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    let r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'tmp', transport: 'stdio', command: 'x' });
    assert(r.status === 201, 'ajout: ' + r.status);
    r = await agentReq(port, token, 'DELETE', '/mcp/servers/tmp');
    assert(r.status === 200 && r.body.removed === true, 'suppression: ' + r.status);
    r = await agentReq(port, token, 'DELETE', '/mcp/servers/tmp');
    assert(r.status === 404, 'inconnu: ' + r.status);
  } finally { await close(); }
}),
t('B4 test reel (faux serveur, 404, injoignable code)', async () => {
  const { port, token, close } = await startAgentServer();
  const mock = await mockMcpHttp({});
  try {
    let r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'faux', transport: 'http', url: mock.url });
    assert(r.status === 201, 'ajout faux: ' + r.status);
    r = await agentReq(port, token, 'POST', '/mcp/servers/faux/test', {});
    assert(r.status === 200 && r.body.ok === true && (r.body.tools || []).join(',') === 'echo,ssecho', 'test ok: ' + JSON.stringify(r.body));
    assert(typeof r.body.ms === 'number', 'duree mesuree');
    r = await agentReq(port, token, 'POST', '/mcp/servers/inconnu/test', {});
    assert(r.status === 404, 'inconnu: ' + r.status);
    r = await agentReq(port, token, 'POST', '/mcp/servers', { name: 'mort', transport: 'http', url: 'http://127.0.0.1:9/mcp' });
    assert(r.status === 201, 'ajout mort: ' + r.status);
    r = await agentReq(port, token, 'POST', '/mcp/servers/mort/test', {});
    assert(r.status === 502 && r.body.ok === false && r.body.code === 'mcp_unreachable', 'injoignable: ' + JSON.stringify(r.body));
  } finally { mcp.disconnectAll(null); await mock.close(); await close(); }
}),
t('B5 trousseau : statut honnete, refus propre, zero fuite', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    let r = await agentReq(port, token, 'GET', '/keyring/status');
    assert(r.status === 200 && r.body.available === false && typeof r.body.detail === 'string', 'statut: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'POST', '/keyring/secret', { target: 'SudoStudio/mcp/x', secret: 'shh-P50' });
    assert(r.status === 400 && /trousseau|keyring|Windows/i.test(r.body.error || ''), 'refus: ' + JSON.stringify(r.body));
    assert(!(r.body.error || '').includes('shh-P50'), 'secret jamais renvoye');
  } finally { await close(); }
}),
t('B6 auth requise (401)', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    let r = await agentReq(port, null, 'GET', '/mcp/servers');
    assert(r.status === 401, 'sans jeton: ' + r.status);
    r = await agentReq(port, 'mauvais', 'GET', '/keyring/status');
    assert(r.status === 401, 'mauvais jeton: ' + r.status);
    r = await agentReq(port, token, 'GET', '/keyring/status');
    assert(r.status === 200, 'bon jeton passe: ' + r.status);
  } finally { await close(); }
}),
t('B7 page : panneau + commande + zero secret', async () => {
  const panelPath = path.join(ROOT, 'sudo-ai-extension/src/panels/MCPServersPanel.js');
  assert(fs.existsSync(panelPath), 'panneau present');
  const src = fs.readFileSync(panelPath, 'utf8');
  assert(src.includes('type="password"'), 'champ password');
  assert(src.includes('tokenCleared'), 'champ vide apres envoi');
  assert(!/console\.log\([^)]*secret/i.test(src), 'aucun log de secret');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'sudo-ai-extension/package.json'), 'utf8'));
  assert((pkg.contributes.commands || []).some((c) => c.command === 'sudoStudio.openMcpPanel'), 'commande package.json');
  const ext = fs.readFileSync(path.join(ROOT, 'sudo-ai-extension/extension.js'), 'utf8');
  assert(ext.includes('sudoStudio.openMcpPanel') && ext.includes('MCPServersPanel'), 'commande extension.js');
  const srvSrc = fs.readFileSync(path.join(AGENT_SRC, 'server.js'), 'utf8');
  assert(!/log\.info\('keyring (set|delete)'[^)]*secret/.test(srvSrc), 'journal trousseau sans secret');
}),
// ---- groupe C : skills (import avec apercu, activation, injection) --------
t('C1 import local : apercu sans installation, puis activation globale', async () => {
  const home = tmp('p50sk');
  const src = tmp('p50src');
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: revue\nversion: 2\ndescription: relit le code\n---\n# Revue\nMARQUEUR-REVUE : toujours relire.\n', 'utf8');
  fs.writeFileSync(path.join(src, 'aide.txt'), 'annexe', 'utf8');
  const pv = await skills.previewImport(home, src);
  assert(pv.ok === true && pv.name === 'revue' && pv.stagingId, 'apercu: ' + JSON.stringify(pv).slice(0, 200));
  assert(pv.files.join(',').indexOf('SKILL.md') !== -1 && pv.excerpt.indexOf('MARQUEUR-REVUE') !== -1, 'contenu previsualise');
  assert(skills.listSkills(home, null).length === 0, 'rien installe avant activation');
  const ac = skills.activateStaged(home, null, pv.stagingId, 'global');
  assert(ac.ok === true && ac.active === true, 'activation: ' + JSON.stringify(ac));
  const listed = skills.listSkills(home, null);
  assert(listed.length === 1 && listed[0].active === true && listed[0].scope === 'global', 'liste: ' + JSON.stringify(listed));
  let inj = skills.activeSkillsText(home, null);
  assert(inj.text.indexOf('MARQUEUR-REVUE') !== -1 && inj.used.join(',') === 'global/revue', 'injection: ' + JSON.stringify(inj.used));
  const off = skills.setActive(home, null, 'global', 'revue', false);
  assert(off.ok === true, 'desactivation');
  inj = skills.activeSkillsText(home, null);
  assert(inj.text === '' && inj.used.length === 0, 'inactif = pas injecte');
}),
t('C2 skill projet : decouverte + activation explicite', async () => {
  const home = tmp('p50sk');
  const root = tmp('p50proj');
  const dir = path.join(root, '.sudo_studio', 'skills', 'normes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Normes\nMARQUEUR-NORMES\n', 'utf8');
  let listed = skills.listSkills(home, root);
  assert(listed.length === 1 && listed[0].scope === 'project' && listed[0].name === 'normes' && listed[0].active === false, 'decouvert inactif: ' + JSON.stringify(listed));
  assert(skills.activeSkillsText(home, root).text === '', 'pas injecte avant activation');
  const on = skills.setActive(home, root, 'project', 'normes', true);
  assert(on.ok === true, 'activation projet');
  assert(skills.activeSkillsText(home, root).text.indexOf('MARQUEUR-NORMES') !== -1, 'injecte apres activation');
  assert(skills.activeSkillsText(home, null).text === '', 'projet isole du global');
}),
t('C3 imports malformes refuses (codes clairs)', async () => {
  const home = tmp('p50sk');
  const vide = tmp('p50vide');
  fs.writeFileSync(path.join(vide, 'note.txt'), 'rien', 'utf8');
  let pv = await skills.previewImport(home, vide);
  assert(pv.ok === false && pv.code === 'no_skill_md', 'sans SKILL.md: ' + JSON.stringify(pv));
  const mauvais = tmp('p50mauvais');
  fs.writeFileSync(path.join(mauvais, 'SKILL.md'), '---\nname: pas bon!\n---\n# X\n', 'utf8');
  pv = await skills.previewImport(home, mauvais);
  assert(pv.ok === false && pv.code === 'bad_skill_name', 'nom invalide: ' + JSON.stringify(pv));
  const gros = tmp('p50gros');
  fs.writeFileSync(path.join(gros, 'SKILL.md'), '# G\n' + 'x'.repeat(70000), 'utf8');
  pv = await skills.previewImport(home, gros);
  assert(pv.ok === false && pv.code === 'skill_md_too_big', 'trop gros: ' + JSON.stringify(pv));
  assert(skills.listStaged(home).length === 0, 'transits en echec nettoyes');
}),
t('C4 import git via file:// (ou echec clair sans git)', async () => {
  const home = tmp('p50sk');
  let gitOk = false;
  try { const v = cproc.spawnSync('git', ['--version'], { timeout: 10000 }); gitOk = v.status === 0; } catch (_) { gitOk = false; }
  if (!gitOk) {
    const pv = await skills.previewImport(home, 'https://example.com/x.git');
    assert(pv.ok === false && pv.code === 'git_failed', 'echec clair: ' + JSON.stringify(pv).slice(0, 160));
    return;
  }
  const repo = tmp('p50repo');
  const g = (a) => cproc.execFileSync('git', a, { cwd: repo, stdio: 'pipe', timeout: 30000 });
  g(['init']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(repo, 'SKILL.md'), '---\nname: gitdemo\ndescription: via git\n---\n# Git\nMARQUEUR-GIT\n', 'utf8');
  g(['add', 'SKILL.md']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'skill']);
  const pv = await skills.previewImport(home, 'file://' + repo);
  assert(pv.ok === true && pv.name === 'gitdemo' && pv.excerpt.indexOf('MARQUEUR-GIT') !== -1, 'clone + apercu: ' + JSON.stringify(pv).slice(0, 200));
  const ac = skills.activateStaged(home, null, pv.stagingId, 'global');
  assert(ac.ok === true, 'activation apres clone');
  assert(skills.activeSkillsText(home, null).text.indexOf('MARQUEUR-GIT') !== -1, 'injecte');
}),
t('C5 endpoints skills (apercu, activation, toggle, suppression)', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    const src = tmp('p50esrc');
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: ep\ndescription: endpoint\n---\n# EP\nMARQUEUR-EP\n', 'utf8');
    let r = await agentReq(port, token, 'GET', '/skills');
    assert(r.status === 200 && r.body.skills.length === 0, 'vide: ' + r.status);
    r = await agentReq(port, token, 'POST', '/skills/preview', { source: src });
    assert(r.status === 200 && r.body.stagingId && r.body.name === 'ep', 'apercu: ' + JSON.stringify(r.body).slice(0, 160));
    const sid = r.body.stagingId;
    r = await agentReq(port, token, 'GET', '/skills');
    assert(r.body.skills.length === 0 && r.body.staged.join(',') === sid, 'transit liste, pas installe');
    r = await agentReq(port, token, 'POST', '/skills/activate', { stagingId: sid, scope: 'global' });
    assert(r.status === 201 && r.body.active === true, 'activation: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'POST', '/skills/active', { scope: 'global', name: 'ep', active: false });
    assert(r.status === 200 && r.body.active === false, 'toggle off: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'DELETE', '/skills/ep', { scope: 'global' });
    assert(r.status === 200 && r.body.ok === true, 'suppression: ' + JSON.stringify(r.body));
    r = await agentReq(port, token, 'GET', '/skills');
    assert(r.body.skills.length === 0, 'liste vide apres suppression');
  } finally { await close(); }
}),
t('C6 injection boucle : forme + cablage statique', async () => {
  const home = tmp('p50sk');
  const src = tmp('p50csrc');
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# S\nTEXTE-SKILL-C6\n', 'utf8');
  const pv = await skills.previewImport(home, src);
  assert(pv.ok === true, 'apercu');
  const ac = skills.activateStaged(home, null, pv.stagingId, 'global', 'c6');
  assert(ac.ok === true && ac.name === 'c6', 'renommage a l activation');
  const inj = skills.activeSkillsText(home, null);
  assert(typeof inj.text === 'string' && Array.isArray(inj.used) && Array.isArray(inj.skipped), 'forme {text,used,skipped}');
  assert(inj.text.indexOf('TEXTE-SKILL-C6') !== -1, 'corps injecte');
  const loopSrc = fs.readFileSync(path.join(AGENT_SRC, 'loop.js'), 'utf8');
  assert(loopSrc.includes('activeSkillsText') && /out\.splice\([^;]*filter\(skillsText\)/.test(loopSrc), 'boucle injecte + filtre');
}),
// ---- groupe D : exec longs (live, stop, delai, boucle fix bornee) ---------
t('D1 sortie live : morceaux sans repetition, code 0', async () => {
  const dir = tmp('p50exec');
  const s = execm.startProc({ command: 'node -e "console.log(\'LIVE-1\');setTimeout(function(){console.log(\'LIVE-2\');},400)"', cwd: dir, label: 'd1' });
  assert(s.ok === true && execm.validId(s.id), 'demarre: ' + JSON.stringify(s));
  let outs = '';
  let last = null;
  const t0 = Date.now();
  for (;;) {
    last = execm.pollProc(s.id);
    assert(last.ok === true || last.running === false, 'poll: ' + JSON.stringify(last).slice(0, 160));
    outs += last.out || '';
    if (!last.running) break;
    if (Date.now() - t0 > 10000) throw new Error('jamais termine');
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(last.exitCode === 0, 'code 0: ' + JSON.stringify(last).slice(0, 200));
  assert(outs.indexOf('LIVE-1') !== -1 && outs.indexOf('LIVE-2') !== -1, 'live complet: ' + JSON.stringify(outs));
  assert(outs.indexOf('LIVE-1') === outs.lastIndexOf('LIVE-1'), 'pas de repetition (offsets)');
  execm.reapProcs();
}),
t('D2 stop : processus long tue', async () => {
  const dir = tmp('p50exec');
  const s = execm.startProc({ command: 'node -e "setTimeout(function(){},30000)"', cwd: dir });
  assert(s.ok === true, 'demarre');
  const st = execm.stopProc(s.id);
  assert(st.ok === true && st.stopped === true, 'stop: ' + JSON.stringify(st));
  let last = null;
  const t0 = Date.now();
  for (;;) {
    last = execm.pollProc(s.id);
    if (!last.running) break;
    if (Date.now() - t0 > 8000) throw new Error('jamais tue');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(last.killed === true, 'marque tue: ' + JSON.stringify(last).slice(0, 200));
  execm.reapProcs();
}),
t('D3 delai de vie : tue + code timeout', async () => {
  const dir = tmp('p50exec');
  const s = execm.startProc({ command: 'node -e "setTimeout(function(){},30000)"', cwd: dir, timeoutMs: 800 });
  assert(s.ok === true, 'demarre');
  let last = null;
  const t0 = Date.now();
  for (;;) {
    last = execm.pollProc(s.id);
    if (!last.running) break;
    if (Date.now() - t0 > 10000) throw new Error('jamais expire');
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(last.ok === false && last.code === 'timeout' && last.timedOut === true, 'timeout: ' + JSON.stringify(last).slice(0, 200));
  execm.reapProcs();
}),
t('D4 boucle fix bornee : 6 echecs => PARTIEL build_fix', async () => {
  const proj = tmp('p50d4');
  fs.writeFileSync(path.join(proj, 'f.txt'), 'x', 'utf8');
  const responses = [];
  const rules = [];
  for (let i = 0; i < 8; i++) {
    const cmd = 'node -e "process.exit(' + (3 + i) + ')"';
    responses.push({ toolCalls: [{ name: 'bash', args: { command: cmd } }] });
    rules.push('bash|command|' + cmd);
  }
  const r = await driveTurn50(proj, 'corrige le build qui echoue', responses, { mode: 'build', rules });
  const end = r.events.filter((e) => e && e.type === 'turn.done').pop() || {};
  assert(end.status === 'PARTIEL', 'PARTIEL, got ' + JSON.stringify(end).slice(0, 200));
  assert(end.stopReason === 'build_fix', 'stop build_fix, got ' + end.stopReason);
  assert(String(end.reason || '').indexOf('boucle de correction bornee') !== -1, 'raison: ' + end.reason);
  assert(r.chats.length === 6, 'borne a 6 tours, got ' + r.chats.length);
  assert(r.journal.indexOf('build-fix borne atteinte') !== -1, 'journalise');
}),
t('D5 diagnostics : lignes d erreur + fin de sortie', async () => {
  const d = execm.extractErrors('ok line\nerror TS123: boom\nmiddle\nFAILED tests\nTraceback (most recent call last)\nlast');
  assert(d.errors.length === 3, '3 lignes: ' + JSON.stringify(d.errors));
  assert(d.text.indexOf('TS123') !== -1 && d.text.indexOf('fin de sortie') !== -1, 'texte: ' + d.text.slice(0, 120));
  const d2 = execm.extractErrors('tout va bien\nfin');
  assert(d2.errors.length === 0 && d2.text.indexOf('fin de sortie') !== -1, 'sans erreur: queue quand meme');
}),
t('D6 cycle HTTP : poll inconnu, start approuve, stop', async () => {
  const { port, token, close } = await startAgentServer();
  try {
    const proj = tmp('p50d6');
    let r = await agentReq(port, token, 'POST', '/sessions', { title: 'd6', projectRoot: proj });
    assert(r.status === 201 && r.body.id, 'session: ' + r.status);
    const sid = r.body.id;
    const call = (tool, args) => agentReq(port, token, 'POST', '/sessions/' + sid + '/tools/call', { tool, args });
    r = await call('exec_poll', { id: '0'.repeat(16) });
    assert(r.status === 200 && r.body.status === 'error' && r.body.code === 'unknown_proc', 'poll inconnu execute: ' + JSON.stringify(r.body).slice(0, 200));
    r = await call('exec_start', { command: 'node -e "console.log(\'D6-OK\')"', cwd: '.' });
    assert(r.status === 200 && r.body.status === 'need-approval' && r.body.request && r.body.request.id, 'start demande approbation: ' + JSON.stringify(r.body).slice(0, 200));
    const reqId = r.body.request.id;
    // L approbation EXECUTE l appel en attente (pas de re-appel : race).
    r = await agentReq(port, token, 'POST', '/sessions/' + sid + '/approvals', { decision: 'session', requestId: reqId });
    assert(r.status === 200 && r.body.status === 'executed' && r.body.call.ok === true && execm.validId(r.body.call.result.id), 'approbation execute: ' + JSON.stringify(r.body).slice(0, 200));
    const pid = r.body.call.result.id;
    let out = '';
    const t0 = Date.now();
    for (;;) {
      r = await call('exec_poll', { id: pid });
      assert(r.status === 200 && r.body.status === 'done', 'poll: ' + r.status);
      out += (r.body.call.result && r.body.call.result.out) || '';
      if (!r.body.call.result.running) break;
      if (Date.now() - t0 > 10000) throw new Error('jamais termine');
      await new Promise((res) => setTimeout(res, 150));
    }
    assert(out.indexOf('D6-OK') !== -1, 'sortie live via HTTP: ' + JSON.stringify(out));
    const r2 = await call('exec_start', { command: 'node -e "setTimeout(function(){},30000)"', cwd: '.' });
    assert(r2.body.status === 'need-approval', '2e commande re-demande (regle par commande)');
    const reqId2 = r2.body.request.id;
    const r3 = await agentReq(port, token, 'POST', '/sessions/' + sid + '/approvals', { decision: 'session', requestId: reqId2 });
    assert(r3.status === 200 && r3.body.status === 'executed' && execm.validId(r3.body.call.result.id), 'sleep execute: ' + JSON.stringify(r3.body).slice(0, 160));
    const pid2 = r3.body.call.result.id;
    const r4 = await call('exec_stop', { id: pid2 });
    assert(r4.status === 200 && r4.body.status === 'need-approval', 'stop demande approbation (mutant)');
    const r5 = await agentReq(port, token, 'POST', '/sessions/' + sid + '/approvals', { decision: 'session', requestId: r4.body.request.id });
    assert(r5.status === 200 && r5.body.status === 'executed' && r5.body.call.result.stopped === true, 'stop execute: ' + JSON.stringify(r5.body).slice(0, 200));
  } finally { try { execm.stopAll(); } catch (_) {} await close(); }
}),
// ---- groupe E : generation projet (phases, checks reels, points retour) ---
t('E1 flot heureux : TERMINE avec preuves', async () => {
  const proj = tmp('p50gen');
  const g = genm.startRun(proj, 'mini projet', 'node');
  assert(g.ok === true && genm.validId(g.id), 'start: ' + JSON.stringify(g));
  const id = g.id;
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'mini' }), 'utf8');
  fs.writeFileSync(path.join(proj, 'index.js'), 'console.log(1);\n', 'utf8');
  let ph = genm.markPhase(proj, id, 'plan', 'ok');
  assert(ph.ok === true, 'plan');
  ph = genm.markPhase(proj, id, 'files', 'ok');
  assert(ph.ok === true, 'files');
  const chk = async (phase, command) => {
    const s = execm.startProc({ command, cwd: proj, timeoutMs: 15000 });
    assert(s.ok === true, 'check start ' + phase);
    let p = null;
    const t0 = Date.now();
    for (;;) {
      p = execm.pollProc(s.id);
      if (!p.running) break;
      if (Date.now() - t0 > 12000) throw new Error('check timeout ' + phase);
      await new Promise((r) => setTimeout(r, 100));
    }
    execm.reapProcs();
    return genm.recordCheck(proj, id, { phase, command, code: p.exitCode, ms: 1, tail: (p.out || '').slice(-500) });
  };
  assert((await chk('deps', 'node --version')).ok === true, 'check deps');
  assert(genm.markPhase(proj, id, 'deps', 'ok').ok === true, 'deps');
  const cb = await chk('build', 'node index.js');
  assert(cb.ok === true && cb.check.code === 0, 'check build');
  assert(genm.markPhase(proj, id, 'build', 'ok').ok === true, 'build');
  fs.writeFileSync(path.join(proj, 'test.js'), 'console.log(2);\n', 'utf8');
  const ct = await chk('tests', 'node test.js');
  assert(ct.ok === true && ct.check.code === 0, 'check tests');
  assert(genm.markPhase(proj, id, 'tests', 'ok').ok === true, 'tests');
  const rep = genm.buildReport(proj, id);
  assert(rep.ok === true && rep.report.verdict.status === 'TERMINE', 'TERMINE: ' + JSON.stringify(rep.report.verdict));
  assert(rep.report.diff.created.join(',').indexOf('index.js') !== -1, 'diff: ' + JSON.stringify(rep.report.diff));
  assert(rep.report.checks.length === 3, '3 checks enregistres');
}),
t('E2 PARTIEL honnete : manquants listes', async () => {
  const proj = tmp('p50gen');
  const id = genm.startRun(proj, 'x', '').id;
  genm.markPhase(proj, id, 'plan', '');
  genm.markPhase(proj, id, 'files', '');
  genm.recordCheck(proj, id, { phase: 'build', command: 'make', code: 2, ms: 3, tail: 'boom' });
  const rep = genm.buildReport(proj, id);
  assert(rep.report.verdict.status === 'PARTIEL', 'PARTIEL');
  const m = rep.report.verdict.missing.join('|');
  assert(m.indexOf('phase deps') !== -1 && m.indexOf('check build reussi') !== -1 && m.indexOf('check tests reussi') !== -1, 'manquants: ' + m);
  const w = genm.markPhase(proj, id, 'deps', '');
  assert(w.ok === true && w.warning === null, 'deps sans warning');
}),
t('E3 ordre impose + erreurs claires', async () => {
  const proj = tmp('p50gen');
  const id = genm.startRun(proj, 'x', '').id;
  let r = genm.markPhase(proj, id, 'build', '');
  assert(r.ok === false && /ordre/.test(r.error), 'ordre: ' + r.error);
  genm.markPhase(proj, id, 'plan', '');
  r = genm.markPhase(proj, id, 'plan', '');
  assert(r.ok === false && /deja/.test(r.error), 'doublon: ' + r.error);
  r = genm.markPhase(proj, '0'.repeat(16), 'plan', '');
  assert(r.ok === false, 'run inconnu refuse');
  r = genm.restorePhase(proj, id, 'tests', {});
  assert(r.ok === false && /non marquee/.test(r.error), 'restaure phase non marquee: ' + r.error);
}),
t('E4 points retour : restauration exacte', async () => {
  const proj = tmp('p50gen');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'v1', 'utf8');
  const id = genm.startRun(proj, 'x', '').id;
  genm.markPhase(proj, id, 'plan', '');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'v2', 'utf8');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b', 'utf8');
  genm.markPhase(proj, id, 'files', '');
  fs.writeFileSync(path.join(proj, 'c.txt'), 'c', 'utf8');
  genm.markPhase(proj, id, 'deps', '');
  let rs = genm.restorePhase(proj, id, 'files', {});
  assert(rs.ok === true && rs.deleted === 1, 'retour files: ' + JSON.stringify(rs));
  assert(!fs.existsSync(path.join(proj, 'c.txt')) && fs.readFileSync(path.join(proj, 'a.txt'), 'utf8') === 'v2', 'etat files');
  rs = genm.restorePhase(proj, id, 'start', {});
  assert(rs.ok === true, 'retour start: ' + JSON.stringify(rs));
  assert(fs.readFileSync(path.join(proj, 'a.txt'), 'utf8') === 'v1' && !fs.existsSync(path.join(proj, 'b.txt')), 'etat start');
}),
t('E5 cablage executeTool : permissions + check reel', async () => {
  const proj = tmp('p50gen');
  const ctx = () => ({ root: proj, sessionId: 'sess-e5', session: { meta: { readFiles: [] } }, store: { update: () => null, get: () => null },
    log: null, corr: 't', run: { killFns: [], calls: [], created: [] }, home: tmp('home'),
    sessionRules: new Set(), projectRules: new Set(), sessionKill: [], checkpoint: async () => null });
  let r = await tools.executeTool(ctx(), 'gen_start', { goal: 'x' }, {});
  assert(r.status === 'need-approval' && r.request.tool === 'gen_start', 'start demande approbation');
  r = await tools.executeTool(ctx(), 'gen_start', { goal: 'x' }, { preApproved: true });
  assert(r.status === 'done' && r.call.ok === true && genm.validId(r.call.result.id), 'start pre-approuve: ' + JSON.stringify(r).slice(0, 200));
  const id = r.call.result.id;
  r = await tools.executeTool(ctx(), 'gen_report', { run: id }, {});
  assert(r.status === 'done' && r.call.ok === true && r.call.result.verdict.status === 'PARTIEL', 'report auto (lecture seule)');
  r = await tools.executeTool(ctx(), 'gen_check', { run: id, phase: 'build', command: 'node -e "console.error(\'BUILD-ERR-X\');process.exit(1)"', timeoutMs: 15000 }, { preApproved: true });
  assert(r.status === 'error' && r.code === 'exit_1' && r.reason.indexOf('BUILD-ERR-X') !== -1, 'check echoue + diagnostics: ' + JSON.stringify(r).slice(0, 300));
  const rep = genm.buildReport(proj, id);
  assert(rep.report.checks.length === 1 && rep.report.checks[0].code === 1, 'echec enregistre');
}),
t('E6 agent pilote : 2 tours => TERMINE prouve', async () => {
  const proj = tmp('p50gen');
  const runOf = (body) => {
    const m = /generation demarree \(([0-9a-f]{16})\)/.exec(JSON.stringify(body));
    return m ? m[1] : 'RIEN';
  };
  const T1 = [
    { toolCalls: [{ name: 'gen_start', args: { goal: 'mini projet node', stack: 'node' } }] },
    { toolCalls: [{ name: 'list', args: { dir: '.' } }] },
    { build: (b) => [{ name: 'gen_phase', args: { run: runOf(b), phase: 'plan', note: 'plan ok' } }] },
    { build: (b) => [{ name: 'write', args: { file: 'package.json', content: '{"name":"mini"}' } }] },
    { build: (b) => [{ name: 'write', args: { file: 'index.js', content: "console.log('GEN-OK');\n" } }] },
    { build: (b) => [{ name: 'write', args: { file: 'test.js', content: "if (1+1!==2) process.exit(1);console.log('TESTS-OK');\n" } }] },
    { build: (b) => [{ name: 'gen_phase', args: { run: runOf(b), phase: 'files', note: '3 fichiers' } }] },
    { build: (b) => [{ name: 'gen_phase', args: { run: runOf(b), phase: 'deps', note: 'zero dependance' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'squelette ecrit' } }] },
  ];
  const rules1 = ['gen_start|scope|gen', 'gen_phase|scope|gen:plan', 'write|file|package.json',
    'write|file|index.js', 'write|file|test.js', 'gen_phase|scope|gen:files', 'gen_phase|scope|gen:deps'];
  const genOpts = { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] };
  const t1 = await driveTurn50(proj, 'genere un mini projet node (squelette)', T1, Object.assign({ rules: rules1 }, genOpts));
  const T2 = [
    { build: (b) => [{ name: 'gen_check', args: { run: runOf(b), phase: 'build', command: 'node index.js', timeoutMs: 30000 } }] },
    { build: (b) => [{ name: 'gen_phase', args: { run: runOf(b), phase: 'build', note: 'build ok' } }] },
    { build: (b) => [{ name: 'gen_check', args: { run: runOf(b), phase: 'tests', command: 'node test.js', timeoutMs: 30000 } }] },
    { build: (b) => [{ name: 'gen_phase', args: { run: runOf(b), phase: 'tests', note: 'tests ok' } }] },
    { build: (b) => [{ name: 'gen_report', args: { run: runOf(b) } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'projet termine et verifie' } }] },
  ];
  const rules2 = ['gen_check|command|node index.js', 'gen_phase|scope|gen:build', 'gen_check|command|node test.js', 'gen_phase|scope|gen:tests'];
  const t2 = await driveTurn50(proj, 'termine la generation : build, tests, rapport', T2, Object.assign({ rules: rules2, carry: t1.carry }, genOpts));
  const msgs = t2.store.get(t2.sessionId).messages;
  const rep = msgs.filter((m) => m.role === 'tool' && m.name === 'gen_report').pop();
  assert(rep, 'rapport emis');
  const parsed = JSON.parse(rep.content);
  assert(parsed.result && parsed.result.verdict && parsed.result.verdict.status === 'TERMINE', 'TERMINE agent: ' + rep.content.slice(0, 300));
  assert(parsed.result.checks.filter((c) => c.code === 0).length === 2, '2 checks a 0');
}),
t('E7 bornes honnetes : gros fichiers et depots ignores', async () => {
  const proj = tmp('p50gen');
  fs.writeFileSync(path.join(proj, 'gros.bin'), Buffer.alloc(600000, 7));
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'y.js'), 'y', 'utf8');
  fs.writeFileSync(path.join(proj, 'ok.js'), 'ok', 'utf8');
  const m = genm.manifestOf(proj);
  assert(!m.files['gros.bin'] && !m.files['node_modules/x/y.js'] && m.files['ok.js'], 'filtre: ' + Object.keys(m.files).join(','));
  assert(m.skipped >= 1, 'compteur passes comptabilise');
}),
// ---- groupe F : outils metier IDE (analyse, secu, ignore, CI, doctor, SDK)
t('F1 analyze : structure reelle', async () => {
  const proj = tmp('p50biz');
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"x"}', 'utf8');
  fs.writeFileSync(path.join(proj, 'index.js'), '// TODO: faire\nconsole.log(1);\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'main.py'), '# FIXME: refaire\nprint(1)\n', 'utf8');
  fs.mkdirSync(path.join(proj, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'tests', 'test_x.py'), 'def test_a(): pass\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'README.md'), '# X\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'n\n', 'utf8');
  const a = bizm.analyze(proj);
  assert(a.files === 6, 'fichiers: ' + a.files);
  assert(a.byLang.javascript && a.byLang.javascript.files === 1, 'js: ' + JSON.stringify(a.byLang));
  assert(a.byLang.python && a.byLang.python.files === 2, 'py: ' + JSON.stringify(a.byLang));
  assert(a.manifests.join(',') === 'package.json', 'manifestes: ' + a.manifests);
  assert(a.tests.join(',') === 'tests/test_x.py', 'tests: ' + a.tests);
  assert(a.readme === 'README.md' && a.todo === 1 && a.fixme === 1, 'readme/todo/fixme');
  assert(a.entries.join(',') === 'index.js,main.py', 'entrees: ' + a.entries);
  assert(typeof a.ms === 'number', 'duree');
}),
t('F2 secaudit : secrets caviarde + avis CVE', async () => {
  const proj = tmp('p50biz');
  // Fausses cles d exemple documentees (jamais reelles).
  fs.writeFileSync(path.join(proj, '.env'), 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\napi_key = "sk-1234567890abcdef1234"\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ dependencies: { lodash: '4.17.20' } }), 'utf8');
  fs.writeFileSync(path.join(proj, 'requirements.txt'), 'pyyaml==5.3.1\n', 'utf8');
  const s = bizm.secaudit(proj);
  const labels = s.secrets.map((x) => x.label).join('|');
  assert(labels.indexOf('AWS Access Key') !== -1 && labels.indexOf('Generic API Key') !== -1, 'labels: ' + labels);
  const blob = JSON.stringify(s);
  assert(blob.indexOf('AKIAIOSFODNN7EXAMPLE') === -1 && blob.indexOf('sk-1234567890abcdef1234') === -1, 'valeurs jamais en clair');
  const cves = s.advisories.map((x) => x.cve).join('|');
  assert(cves.indexOf('CVE-2020-8203') !== -1 && cves.indexOf('CVE-2020-14343') !== -1, 'cves: ' + cves);
  assert(s.db.entries === 8 && /small/.test(s.db.note), 'base annoncee: ' + JSON.stringify(s.db));
  assert(s.deps.npm === 1 && s.deps.pip === 1, 'deps: ' + JSON.stringify(s.deps));
}),
t('F3 mkignore : fusion idempotente', async () => {
  const proj = tmp('p50biz');
  fs.writeFileSync(path.join(proj, 'package.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'custom-xyz\n', 'utf8');
  let r = bizm.mkignore(proj);
  assert(r.ok === true && r.stacks.join(',') === 'node', 'stack: ' + JSON.stringify(r));
  const gi = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8');
  assert(gi.indexOf('node_modules/') !== -1 && gi.indexOf('.env') !== -1 && gi.indexOf('custom-xyz') !== -1, 'fusion: ' + gi.slice(0, 200));
  r = bizm.mkignore(proj);
  assert(r.ok === true && r.added.length === 0, 'idempotent');
  r = bizm.mkignore(proj, 'cobol');
  assert(r.ok === false, 'stack inconnue refusee');
}),
t('F4 ci : workflows valides, refus d ecraser', async () => {
  const proj = tmp('p50biz');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }), 'utf8');
  fs.writeFileSync(path.join(proj, 'test.js'), '1', 'utf8');
  let r = bizm.ci(proj, 'github');
  assert(r.ok === true && r.path === '.github/workflows/ci.yml', 'github: ' + JSON.stringify(r));
  const yml = fs.readFileSync(path.join(proj, r.path), 'utf8');
  assert(yml.indexOf('setup-node') !== -1 && yml.indexOf('test') !== -1, 'contenu: ' + yml.slice(0, 160));
  r = bizm.ci(proj, 'github');
  assert(r.ok === false && /existe/.test(r.error), 'refus ecraser: ' + r.error);
  const proj2 = tmp('p50biz');
  r = bizm.ci(proj2, 'gitlab');
  assert(r.ok === true && r.path === '.gitlab-ci.yml', 'gitlab: ' + JSON.stringify(r));
  assert(fs.readFileSync(path.join(proj2, r.path), 'utf8').indexOf('stages:') !== -1, 'gitlab contenu');
  r = bizm.ci(proj2, 'jenkins');
  assert(r.ok === false, 'fournisseur invalide refuse');
}),
t('F5 doctor live : sondes reelles', async () => {
  const d = await bizm.doctor();
  const byName = {};
  for (const c of d.checks) byName[c.name] = c;
  assert(byName['Node.js'] && byName['Node.js'].status === 'ok' && byName['Node.js'].value[0] === 'v', 'node: ' + JSON.stringify(byName['Node.js']));
  assert(byName['Git'] && byName['Git'].status === 'ok', 'git: ' + JSON.stringify(byName['Git']));
  assert(byName['Docker'] && byName['Docker'].status, 'docker sonde (statut quelconque)');
  assert(byName['Plateforme'] && byName['Plateforme'].status === 'info', 'plateforme');
  assert(byName['RAM'] && /Go/.test(byName['RAM'].value), 'ram: ' + JSON.stringify(byName['RAM']));
  assert(byName['Backend (port 5000)'] && byName['Runtime IA (port 6000)'], 'services sondes');
}),
t('F6 sdk : status, dry, refus honnetes, split ferme', async () => {
  let r = await bizm.sdkStatus('nodejs');
  assert(r.ok === true && r.sdks.length === 1 && r.sdks[0].installed === true && r.sdks[0].version[0] === 'v', 'status node: ' + JSON.stringify(r));
  r = await bizm.sdkStatus('bogus');
  assert(r.ok === false, 'id inconnu refuse');
  r = await bizm.sdkInstall('nodejs', { dry: true });
  assert(r.ok === true && r.dry === true && r.command.indexOf('node') !== -1, 'dry: ' + JSON.stringify(r));
  r = await bizm.sdkInstall('android-sdk', { dry: true });
  assert(r.ok === false && /page SDK/.test(r.error), 'non automatise: ' + r.error);
  if (process.platform !== 'win32') {
    r = await bizm.sdkInstall('nodejs', {});
    assert(r.ok === false && /Windows/.test(r.error), 'live hors Windows refuse: ' + r.error);
  }
  const sp = bizm.sdkSplitWin('winget install OpenJS.NodeJS.LTS');
  assert(sp && sp.bin === 'winget' && sp.args.join(' ') === 'install OpenJS.NodeJS.LTS', 'split');
  assert(bizm.sdkSplitWin('winget install X | sh') === null, 'pipe refuse');
  assert(bizm.sdkSplitWin('curl x | sh') === null, 'non-winget refuse');
}),
t('F7 cablage : lecture auto, ecritures avec approbation', async () => {
  const proj = tmp('p50biz');
  fs.writeFileSync(path.join(proj, 'package.json'), '{}', 'utf8');
  const ctx = () => ({ root: proj, sessionId: 'sess-f7', session: { meta: { readFiles: [] } }, store: { update: () => null, get: () => null },
    log: null, corr: 't', run: { killFns: [], calls: [], created: [] }, home: tmp('home'),
    sessionRules: new Set(), projectRules: new Set(), sessionKill: [], checkpoint: async () => null });
  let r = await tools.executeTool(ctx(), 'analyze', {}, {});
  assert(r.status === 'done' && r.call.ok === true, 'analyze auto');
  r = await tools.executeTool(ctx(), 'doctor', {}, {});
  assert(r.status === 'done' && r.call.ok === true, 'doctor auto');
  r = await tools.executeTool(ctx(), 'mkignore', {}, {});
  assert(r.status === 'need-approval' && r.request.pattern.text === '.gitignore', 'mkignore demande: ' + JSON.stringify(r.request));
  r = await tools.executeTool(ctx(), 'ci', { provider: 'gitlab' }, {});
  assert(r.status === 'need-approval' && r.request.pattern.text === '.gitlab-ci.yml', 'ci demande: ' + JSON.stringify(r.request));
  r = await tools.executeTool(ctx(), 'sdk', { op: 'status' }, {});
  assert(r.status === 'need-approval', 'sdk demande meme en status (defaut sur)');
  r = await tools.executeTool(ctx(), 'mkignore', {}, { preApproved: true });
  assert(r.status === 'done' && r.call.ok === true && fs.existsSync(path.join(proj, '.gitignore')), 'mkignore pre-approuve');
}),
// ---- groupe G : sous-agents (sequentiel, parallele, gardes) ----------------
t('G1 sous-agent sequentiel : resume remonte', async () => {
  const proj = tmp('p50sub');
  fs.writeFileSync(path.join(proj, 'info.txt'), 'donnee-42', 'utf8');
  const Q = [
    { toolCalls: [{ name: 'subagent', args: { task: 'lis info.txt et resume', maxRounds: 3 } }] },
    { toolCalls: [{ name: 'read', args: { file: 'info.txt' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'ENFANT-OK: donnee-42 lue' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'parent ok' } }] },
  ];
  const r = await driveTurn50(proj, 'fais lire info.txt par un sous-agent', Q, { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] });
  const sub = r.store.get(r.sessionId).messages.filter((m) => m.role === 'tool' && m.name === 'subagent').pop();
  assert(sub, 'message outil subagent');
  const parsed = JSON.parse(sub.content);
  assert(parsed.ok === true && parsed.summary.indexOf('ENFANT-OK') !== -1, 'resume remonte: ' + sub.content.slice(0, 300));
  assert(parsed.result && parsed.result.files.join(',').indexOf('info.txt') === -1, 'lecture seule : aucun fichier touche');
  const kids = r.store.list().filter((s) => s.title.indexOf('sub:') === 0 && s.projectRoot === proj);
  assert(kids.length === 1 && kids[0].title.indexOf('sub:') === 0, 'session enfant: ' + JSON.stringify(kids));
  assert(r.store.get(kids[0].id).meta.parent === r.sessionId, 'lien parent');
  assert(r.journal.indexOf('sous-agent demarre') !== -1 && r.journal.indexOf('sous-agents termines') !== -1, 'journalise');
  assert(r.events.some((e) => e && e.type === 'subagent.done'), 'evenement subagent.done');
}),
t('G2 enfant lecture seule : ecriture bloquee', async () => {
  const proj = tmp('p50sub');
  const Q = [
    { toolCalls: [{ name: 'subagent', args: { task: 'essaie ecrire', readonly: true } }] },
    { toolCalls: [{ name: 'write', args: { file: 'hack.txt', content: 'x' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'ECRITURE-REFUSEE vue' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'parent ok' } }] },
  ];
  const r = await driveTurn50(proj, 'enfant lecture seule', Q, { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] });
  const kids = r.store.list().filter((s) => s.title.indexOf('sub:') === 0 && s.projectRoot === proj);
  assert(kids.length === 1, 'un enfant');
  const ck = r.store.get(kids[0].id);
  assert(ck.meta.mode === 'plan', 'enfant en PLAN');
  const w = ck.messages.filter((m) => m.role === 'tool' && m.name === 'write').pop();
  assert(w && w.content.indexOf('plan_mode') !== -1, 'ecriture refusee: ' + (w && w.content.slice(0, 160)));
  assert(!fs.existsSync(path.join(proj, 'hack.txt')), 'rien ecrit (confinement)');
  const sub = r.store.get(r.sessionId).messages.filter((m) => m.role === 'tool' && m.name === 'subagent').pop();
  assert(sub && sub.content.indexOf('ECRITURE-REFUSEE') !== -1, 'rapport remonte');
}),
t('G3 fan-out parallele : 2 enfants, routage par marqueur', async () => {
  const proj = tmp('p50sub');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'B', 'utf8');
  const rounds = {};
  const routed = (body) => {
    const s = JSON.stringify(body);
    if (s.toLowerCase().indexOf('sous-tache agent') === -1) return [{ name: 'done', args: { summary: 'parent ok' } }];
    const k = s.indexOf('MARQUEUR-A') !== -1 ? 'A' : 'B';
    rounds[k] = (rounds[k] || 0) + 1;
    if (rounds[k] === 1) return [{ name: 'read', args: { file: k === 'A' ? 'a.txt' : 'b.txt' } }];
    return [{ name: 'done', args: { summary: k === 'A' ? 'RES-A lue' : 'RES-B lue' } }];
  };
  const Q = [
    { toolCalls: [{ name: 'subagent', args: { tasks: [{ task: 'MARQUEUR-A lis a.txt' }, { task: 'MARQUEUR-B lis b.txt' }] } }] },
    { build: routed }, { build: routed }, { build: routed }, { build: routed }, { build: routed },
  ];
  const r = await driveTurn50(proj, 'parallelise la lecture', Q, { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] });
  const sub = r.store.get(r.sessionId).messages.filter((m) => m.role === 'tool' && m.name === 'subagent').pop();
  assert(sub, 'message subagent');
  const parsed = JSON.parse(sub.content);
  assert(parsed.ok === true && Array.isArray(parsed.result) && parsed.result.length === 2, '2 resultats: ' + sub.content.slice(0, 200));
  assert(parsed.result[0].summary === 'RES-A lue' && parsed.result[1].summary === 'RES-B lue', 'ordre des taches: ' + sub.content.slice(0, 300));
  const kids = r.store.list().filter((s) => s.title.indexOf('sub:') === 0 && s.projectRoot === proj);
  assert(kids.length === 2, '2 sessions enfants');
}),
t('G4 gardes : fan-out, profondeur, plafond', async () => {
  const proj = tmp('p50sub');
  const Q = [
    { toolCalls: [{ name: 'subagent', args: { tasks: [{ task: '1' }, { task: '2' }, { task: '3' }, { task: '4' }] } }] },
    { toolCalls: [{ name: 'subagent', args: { task: 'tente un petit-enfant' } }] },
    { toolCalls: [{ name: 'subagent', args: { task: 'petit-enfant' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'enfant simple' } }] },
    { toolCalls: [{ name: 'subagent', args: { task: 'trivial 2' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'enfant 2' } }] },
    { toolCalls: [{ name: 'subagent', args: { task: 'trivial 3' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'enfant 3' } }] },
    { toolCalls: [{ name: 'subagent', args: { task: 'de trop' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'parent ok' } }] },
  ];
  const r = await driveTurn50(proj, 'teste les gardes', Q, { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] });
  const subs = r.store.get(r.sessionId).messages.filter((m) => m.role === 'tool' && m.name === 'subagent');
  assert(subs.length === 5, '5 appels intercepter: ' + subs.length);
  assert(subs[0].content.indexOf('fan-out max 3') !== -1, 'plafond fan-out: ' + subs[0].content.slice(0, 120));
  assert(subs[1].content.indexOf('enfant simple') !== -1, 'enfant profondeur ok');
  assert(subs[4].content.indexOf('trop de sous-agents') !== -1, 'plafond tour: ' + subs[4].content.slice(0, 120));
  const kids = r.store.list().filter((s) => s.title.indexOf('sub:') === 0 && s.projectRoot === proj);
  assert(kids.length === 3, '3 enfants (refus non comptent): ' + kids.length);
  const depthKid = kids.map((k) => r.store.get(k.id)).find((s) => s.messages.some((m) => m.role === 'tool' && m.name === 'subagent'));
  assert(depthKid, 'enfant ayant tente un spawn');
  const nested = depthKid.messages.filter((m) => m.role === 'tool' && m.name === 'subagent').pop();
  assert(nested.content.indexOf('profondeur max 1') !== -1, 'profondeur refusee: ' + nested.content.slice(0, 120));
}),
t('G5 maxRounds borne + appel direct refuse', async () => {
  const proj = tmp('p50sub');
  fs.writeFileSync(path.join(proj, 'f.txt'), 'x', 'utf8');
  const Q = [
    { toolCalls: [{ name: 'subagent', args: { task: 'lis f.txt', maxRounds: 1 } }] },
    { toolCalls: [{ name: 'read', args: { file: 'f.txt' } }] },
    { toolCalls: [{ name: 'done', args: { summary: 'parent ok' } }] },
  ];
  const r = await driveTurn50(proj, 'enfant borne a 1 tour', Q, { mode: 'build', model: 'llama-8b', models: [{ id: 'llama-8b', n_ctx: 16384 }] });
  const sub = r.store.get(r.sessionId).messages.filter((m) => m.role === 'tool' && m.name === 'subagent').pop();
  const parsed = JSON.parse(sub.content);
  assert(parsed.result && parsed.result.status === 'PARTIEL' && parsed.result.toolCalls === 1, 'borne a 1 tour: ' + sub.content.slice(0, 200));
  const ctx = { root: proj, sessionId: 'sess-g5', session: { meta: { readFiles: [] } }, store: { update: () => null, get: () => null },
    log: null, corr: 't', run: { killFns: [], calls: [], created: [] }, home: tmp('home'),
    sessionRules: new Set(), projectRules: new Set(), sessionKill: [], checkpoint: async () => null };
  const d = await tools.executeTool(ctx, 'subagent', { task: 'x' }, {});
  assert(d.status === 'error' && d.code === 'loop_only', 'direct refuse proprement: ' + JSON.stringify(d).slice(0, 120));
  assert(tools.toolNames().indexOf('subagent') !== -1, 'schema expose');
}),
];

function agentReq(port, token, method, uri, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: uri, method, timeout: 15000, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { let b = null; try { b = raw ? JSON.parse(raw) : null; } catch (_) { b = { _raw: raw }; } resolve({ status: res.statusCode, body: b }); });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startAgentServer() {
  const serverMod = require(path.join(AGENT_SRC, 'server.js'));
  const home = tmp('p50srv');
  process.env.SUDO_STUDIO_HOME = home;
  const token = 'p50-test-token-0123456789';
  const app = serverMod.createApp({
    authToken: token, store: require(path.join(AGENT_SRC, 'store.js')).createStore({}),
    registry: require(path.join(AGENT_SRC, 'registry.js')).createRegistry(), log: null, version: 'test',
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { port: app.server.address().port, token, close: () => new Promise((r) => app.server.close(() => r())) };
}

// Fournisseur fictif scriptable + tour complet (modele driveTurn p49).
function mockProvider50(responses, models) {
  const queue = responses.slice();
  const chats = [];
  const modelList = models || [{ id: 'mock-model' }];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: modelList }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        chats.push(body);
        const next = queue.length ? queue.shift() : { content: 'fin' };
        const msg = { content: next.content === undefined ? '' : next.content };
        if (typeof next.build === 'function') next.toolCalls = next.build(body);
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
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, port: srv.address().port, chats, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

async function driveTurn50(proj, prompt, responses, opts) {
  opts = opts || {};
  let home = null;
  let store = null;
  let s = null;
  let rules = null;
  if (opts.carry) {
    home = opts.carry.home; store = opts.carry.store; s = store.get(opts.carry.sessionId); rules = opts.carry.rules;
  } else {
    home = tmp('p50home');
    store = new SessionStore({ dir: path.join(home, 'store') });
    s = store.create({ title: 't', projectRoot: proj });
    rules = new Map();
  }
  const logsDir = path.join(home, 'logs');
  const log = createLogger({ logsDir, component: 'agent' });
  if (opts.mode) store.update(s.id, (x) => { x.meta.mode = opts.mode; });
  const pending = new Map();
  if (opts.rules) {
    if (!rules.get(s.id)) rules.set(s.id, new Set());
    for (const r of opts.rules) rules.get(s.id).add(r);
  }
  const mock = await mockProvider50(responses, opts.models);
  const events = [];
  try {
    const out = await runTurn({
      store, sessionId: s.id, prompt, corr: 'p50',
      provider: { type: 'local', baseUrl: 'http://127.0.0.1:' + mock.port, model: opts.model || 'mock-model' },
      toolsCtx: { home, sessionRules: rules, pending },
      runs: new Map(), log,
      onEvent: (e) => { try { events.push(e); } catch (_) {} },
    });
    let journal = '';
    try { journal = fs.readFileSync(path.join(logsDir, 'agent.log'), 'utf8'); } catch (_) {}
    return { out, chats: mock.chats, journal, events, store, home, sessionId: s.id, rules,
      carry: { store, home, sessionId: s.id, rules } };
  } finally {
    await mock.close();
  }
}

async function main() {
  for (const tst of tests) {
    try {
      await tst.fn();
      PASS += 1;
      console.log('ok - ' + tst.name);
    } catch (e) {
      FAILS.push(tst.name);
      console.log('FAIL - ' + tst.name + ' :: ' + ((e && e.message) || e));
    }
  }
  console.log(PASS + '/' + tests.length + ' P50 tests passed' + (FAILS.length ? ' FAILS: ' + FAILS.join(' | ') : ''));
  process.exit(FAILS.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
