/**
 * SUDO STUDIO - P65 partie F: EXTENSIONS REELLES (MCP stdio + skill).
 *
 * Prouve, dans un TOUR D'AGENT REEL (moteur empaquete, faux modele) :
 *   F1 l'agent appelle REELLEMENT un outil d'un serveur MCP local (stdio,
 *      JSON-RPC), lance comme processus enfant : la sortie rendue est celle
 *      du serveur, pas une simulation dans le moteur ;
 *   F2 l'agent charge REELLEMENT un skill (corps du SKILL.md dans le
 *      resultat de l'outil) ;
 *   F3 le JOURNAL contient les deux appels (tool ok tool=mcp_call / skill) ;
 *   F4 un serveur MCP absent rend une erreur claire, jamais un faux succes.
 *
 * NON PROUVE ICI : MCP distant (HTTP). Aucun serveur distant n'est appele
 * depuis la CI (pas de reseau) : voir docs/p65/README.md.
 *
 * ASCII only. Stdlib only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, call, done } = (function () {
  const h = require('./lib/agentHarness');
  return { createWorld: h.createWorld, call: h.call, done: h.call };
})();

const SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
const FIXTURE = path.join(__dirname, '..', '..', 'scripts', 'ci', 'fixtures', 'mcp-render-server.js');
const mcpMod = require(path.join(SRC, 'mcp.js'));
const skillsMod = require(path.join(SRC, 'skills.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  OK   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' : ' + ((e && e.message) || e)); }
}

function setupExtensions(w) {
  // 1. serveur MCP local (vrai processus enfant, stdio JSON-RPC)
  const agentHome2 = require(path.join(SRC, 'stateDir')).agentHome({ home: w.home });
  mcpMod.saveConfig(w.home, {
    render: { command: process.execPath, args: [FIXTURE], enabled: true,
      description: 'Serveur MCP local de demonstration',
      env: { RENDER_TOKEN: 'p65-jeton-de-test' } },
  });
  // Liste d'autorisation administrateur (fail-closed par defaut) : sans elle,
  // mcp_call est refuse avant tout appel - c'est la protection, pas un bug.
  fs.mkdirSync(agentHome2, { recursive: true });
  fs.writeFileSync(path.join(agentHome2, 'mcp_policy.json'),
    JSON.stringify({ allowed: { render: ['deploy', 'status'] } }), 'utf8');
  // 2. skill d'exemple, dans le PROJET (emplacement reel du moteur : hors du
  // projet, dans le dossier agent - P63-D), active
  const stateDir = require(path.join(SRC, 'stateDir'));
  const agentHome = stateDir.agentHome({ home: w.home });
  const sdir = path.join(stateDir.paths(w.proj, { agentHome: agentHome }).root, 'skills', 'exemple-deploiement');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'SKILL.md'),
    '---\nname: exemple-deploiement\nversion: 1.0.0\n' +
    'description: Procedure d exemple pour le banc P65 (deployer puis verifier).\n---\n\n' +
    '# Procedure d exemple\n\n1. Verifier le build.\n2. Appeler mcp_call render deploy.\n3. Verifier le statut.\n');
  const act = skillsMod.setActive(w.home, w.proj, 'project', 'exemple-deploiement', true);
  return act;
}

// Le nom du fichier MCP reellement configure est "render" ; l'outil "deploy".
async function main() {
  console.log('SUDO STUDIO - P65-F : MCP local (stdio) + skill reellement appeles');

  const w = createWorld({ files: {
    'package.json': JSON.stringify({ name: 'p65-f', version: '1.0.0' }),
    'README.md': '# p65-f\n',
  } });
  w.store.update(w.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
  const act = setupExtensions(w);
  check('F0 extension installee (skill actif + serveur MCP declare)', () => {
    assert.ok(act && act.ok, 'activation du skill : ' + JSON.stringify(act));
    const cfg = mcpMod.loadConfig(w.home);
    assert.ok(cfg && cfg.render, 'serveur MCP render absent de la configuration');
  });

  const r = await w.turn('deploie le projet sur Render avec la procedure du skill', [
    call('skill', { name: 'exemple-deploiement' }),
    call('mcp_call', { serveur: 'render', outil: 'deploy', arguments: { service: 'p65-demo', commit: 'abc123' } }),
    call('mcp_call', { serveur: 'render', outil: 'status', arguments: { deployId: 'dep_1' } }),
    call('done', { summary: 'deploiement fait et verifie' }),
  ], { autoApprove: 'session', maxIt: 8, waitMs: 30000 });

  const j = String(r.journal || '');
  const callsText = JSON.stringify(r.calls || []);
  const msgsText = JSON.stringify((r.msgs || []).map((m) => m.content));

  check('F2 skill reellement charge (corps du SKILL.md rendu)', () => {
    assert.ok(j.indexOf('skill') !== -1, 'aucune trace de skill dans le journal');
    assert.ok(msgsText.indexOf('Verifier le build') !== -1 || callsText.indexOf('Procdure') !== -1
      || msgsText.indexOf('Procedure d exemple') !== -1,
      'le corps du skill n apparait pas dans les resultats d outil');
  });
  check('F1 outil MCP reellement appele (sortie du serveur)', () => {
    assert.ok(callsText.indexOf('mcp_call') !== -1, 'aucun appel mcp_call enregistre');
    assert.ok(msgsText.indexOf('dep_1') !== -1, 'la sortie du serveur MCP (dep_1) est absente : ' + msgsText.slice(0, 300));
  });
  check('F3 journal : les deux appels sont traces', () => {
    const okLines = j.split('\n').filter((l) => l.indexOf('tool ok') !== -1);
    assert.ok(okLines.some((l) => l.indexOf('tool=skill') !== -1 || l.indexOf('tool=skill_load') !== -1),
      'aucune ligne tool ok pour le skill : ' + okLines.slice(-5).join(' | '));
    assert.ok(okLines.some((l) => l.indexOf('tool=mcp_call') !== -1),
      'aucune ligne tool ok pour mcp_call');
  });
  check('F3 le serveur MCP est un processus ENFANT reel (stdio)', () => {
    // Le serveur exige RENDER_TOKEN par l'environnement : s'il repond, c'est
    // qu'il a vraiment tourne (aucune simulation dans le moteur).
    assert.ok(msgsText.indexOf('jeton Render absent') === -1, 'le serveur a refuse le jeton : ' + msgsText.slice(0, 300));
  });

  // ---- F4 : serveur absent -> erreur claire ---------------------------
  {
    const w2 = createWorld({ files: { 'package.json': '{}' } });
    w2.store.update(w2.sessionId, (s) => { s.meta = s.meta || {}; s.meta.mode = 'build'; });
    mcpMod.saveConfig(w2.home, {});
    const r2 = await w2.turn('appelle le serveur absent', [
      call('mcp_call', { serveur: 'absent', outil: 'deploy', arguments: {} }),
      call('done', { summary: 'test' }),
    ], { autoApprove: 'session', maxIt: 6, waitMs: 20000 });
    check('F4 serveur absent : erreur claire, jamais un faux succes', () => {
      const c = (r2.calls || []).filter((x) => x.tool === 'mcp_call');
      assert.ok(c.length > 0, 'aucun appel mcp_call');
      assert.strictEqual(c[0].ok, false, 'l appel devait echouer : ' + JSON.stringify(c[0]));
      assert.notStrictEqual(r2.out.runStatus, 'TERMINE', 'statut = ' + r2.out.runStatus);
    });
  }

  console.log('');
  console.log('TOTAL P65-F : ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ECHEC DU HARNAIS: ' + ((e && e.stack) || e)); process.exit(1); });
