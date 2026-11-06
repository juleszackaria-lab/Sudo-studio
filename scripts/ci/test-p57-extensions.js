/**
 * test-p57-extensions.js - P57: l'agent utilise VRAIMENT ses extensions.
 *
 * Controles deterministes, sans modele ni reseau :
 *   1. registre unique (inventaire, resume d'en-tete, digest court) ;
 *   2. decouverte : "deploie ce projet sur Render" propose le skill
 *      render-deploy ET le serveur MCP render ;
 *   3. extensions_describe pour chaque nature d'extension ;
 *   4. skill_load : contenu complet a la demande, refus si inactif ;
 *   5. mcp_call : serveur local REELLEMENT appele (JSON-RPC stdio), sortie
 *      rendue au modele, erreur claire si hors ligne SANS casser le tour ;
 *   6. permissions : liste administrateur, politique par outil, approbation ;
 *   7. secrets : jeton lu dans le trousseau et injecte dans l'ENVIRONNEMENT du
 *      serveur MCP ; jamais dans l'audit, jamais dans une sortie d'outil ;
 *   8. audit : une ligne par appel, masquee ;
 *   9. commande "/nom" developpee ; agent personnalise liste ; task -> subagent.
 *
 * Usage : node scripts/ci/test-p57-extensions.js  (code 0 = tout passe)
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
const extMod = require(path.join(SRC, 'extensions.js'));
const mcpMod = require(path.join(SRC, 'mcp.js'));
const skillsMod = require(path.join(SRC, 'skills.js'));
const commandsMod = require(path.join(SRC, 'commands.js'));
const agentsMod = require(path.join(SRC, 'agents.js'));
const keyring = require(path.join(SRC, 'keyring.js'));
const toolsMod = require(path.join(SRC, 'tools.js'));
const profiles = require(path.join(SRC, 'profiles.js'));

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-render-server.js');
const SKILL_SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'skills', 'render-deploy', 'SKILL.md');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('PASS ' + name); }
    else { fail += 1; console.log('FAIL ' + name + ' :: ' + String(detail === undefined ? '' : JSON.stringify(detail)).slice(0, 300)); }
}
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p + '-')); }
function write(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}

// -- environnement de test --------------------------------------------------
const home = tmp('p57home');
const root = tmp('p57proj');
write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { build: 'node -e 0', test: 'node -e 0' } }) + '\n');
write(root, 'README.md', '# demo\n');
write(root, 'AGENTS.md', 'Regle projet : ne jamais deploiyer sans build vert.\n');

const agentHome = path.join(home, '.sudo_studio', 'agent');
// 1. skill render-deploy (livre avec le produit) copie puis active
fs.mkdirSync(path.join(agentHome, 'skills', 'render-deploy'), { recursive: true });
fs.copyFileSync(SKILL_SRC, path.join(agentHome, 'skills', 'render-deploy', 'SKILL.md'));
const activate = skillsMod.setActive(home, root, 'global', 'render-deploy', true);
check('skill render-deploy activable', activate.ok === true, activate);
// 2. skill inactif (controle negatif)
fs.mkdirSync(path.join(agentHome, 'skills', 'autre-skill'), { recursive: true });
fs.writeFileSync(path.join(agentHome, 'skills', 'autre-skill', 'SKILL.md'),
    '---\nname: autre-skill\ndescription: Un skill non active.\n---\nContenu.\n', 'utf8');

// 3. serveur MCP "render" (fixture locale, stdio) avec secret par trousseau
mcpMod.saveConfig(home, {
    render: {
        command: process.execPath,
        args: [FIXTURE],
        description: 'Deploiement Render (API de deploiement)',
        enabled: true,
        secretEnv: { RENDER_TOKEN: 'SudoStudio/mcp/render' },
    },
    fantome: { command: process.execPath, args: [FIXTURE], description: 'Serveur coupe', enabled: true, env: { MCP_RENDER_OFFLINE: '1' } },
    coupe: { command: process.execPath, args: [FIXTURE], description: 'Serveur desactive', enabled: false },
});
fs.mkdirSync(agentHome, { recursive: true });
fs.writeFileSync(path.join(agentHome, 'mcp_policy.json'),
    JSON.stringify({ allowed: { render: ['deploy', 'status'], fantome: ['deploy'] } }), 'utf8');

// 4. commande personnalisee /deploiement
fs.mkdirSync(path.join(agentHome, 'commands'), { recursive: true });
fs.writeFileSync(path.join(agentHome, 'commands', 'deploiement.md'),
    '---\nname: deploiement\ndescription: Deploie le projet sur Render\nargs: service\n---\nDeploie ${service} sur Render en suivant le skill render-deploy.\n', 'utf8');

// 5. agent personnalise "Deployeur"
agentsMod.saveAgent(home, { name: 'Deployeur', description: 'Agent de deploiement Render', instructions: 'Tu deploies sur Render avec preuves.', tools: ['read', 'list', 'bash', 'mcp_call', 'done'] });

// 6. trousseau factice (seam) : le jeton n'existe QUE la
const SECRET = 'rnd_p57_secret_ABC123';
const seenTargets = [];
keyring.setKeyringRunner(async (script) => {
    const m = /\$T='([^']+)'/.exec(String(script));
    const target = m ? m[1] : '';
    seenTargets.push(target);
    if (target === 'SudoStudio/mcp/render') return { code: 0, stdout: SECRET, stderr: '' };
    if (target === 'SudoStudio/mcp/absent') return { code: 0, stdout: 'autre', stderr: '' };
    return { code: 1, stdout: '', stderr: 'NOTFOUND:1168' };
});

const ctx = {
    home, root, sessionId: 'sess-p57', corr: 'req-p57', log: null,
    sessionRules: new Set(), projectRules: new Set(),
    store: { get: () => ({ messages: [] }), update: () => {}, create: () => ({ id: 'x' }) },
};

(async () => {
    // ---------------------------------------------------------------- 1. registre
    const inv = extMod.inventory(home, root);
    check('inventaire : 3 serveurs MCP', inv.mcp.length === 3, inv.mcp.map((m) => m.name));
    check('inventaire : skills non casses listes', inv.skills.length === 2, inv.skills);
    check('inventaire : commande listee', inv.commands.length === 1 && inv.commands[0].name === 'deploiement', inv.commands);
    check('inventaire : agent personnalise liste', inv.agents.some((a) => a.name === 'Deployeur' && !a.builtin), inv.agents.map((a) => a.name));
    check('inventaire : regles projet detectees', inv.rules.project === true, inv.rules);

    const sum = extMod.summary(home, root);
    check('resume en-tete "N MCP, N skills actifs"', sum.mcp === 3 && sum.mcpEnabled === 2
        && sum.skillsActive === 1 && sum.label === '2 MCP, 1 skill actif', sum);
    const sumEmpty = extMod.summary(tmp('p57empty'), null);
    check('resume sans extension = 0', sumEmpty.label === '0 MCP, 0 skill actif', sumEmpty.label);

    const digest = extMod.digest(home, root);
    check('digest court (noms + une ligne)', digest.indexOf('render') !== -1 && digest.indexOf('render-deploy') !== -1
        && digest.length <= extMod.MAX_DISCOVER_LINES && digest.indexOf('## ') === -1, digest.slice(0, 200));
    check('digest ne contient PAS le corps du skill', digest.indexOf('Pousser le depot') === -1, 'corps present');

    // ---------------------------------------------------------------- 2. decouverte
    const sug = extMod.suggest(home, root, 'deploie ce projet sur Render', 4);
    check('decouverte : skill render-deploy propose', sug.some((x) => x.kind === 'skill' && x.name === 'render-deploy'), sug.map((x) => x.kind + ':' + x.name));
    check('decouverte : MCP render propose', sug.some((x) => x.kind === 'mcp' && x.name === 'render'), sug.map((x) => x.kind + ':' + x.name));
    check('decouverte : skill actif prioritaire', sug[0] && sug[0].kind === 'skill' && sug[0].name === 'render-deploy', sug.map((x) => x.kind + ':' + x.name + ':' + x.score));
    const prop = extMod.proposalText(home, root, 'deploie ce projet sur Render');
    check('proposition injectable (skill + MCP)', /skill render-deploy/.test(prop) && /MCP render/.test(prop), prop.slice(0, 200));
    check('proposition vide pour une demande sans extension', extMod.proposalText(home, root, 'explique la structure du projet') === '',
        extMod.proposalText(home, root, 'explique la structure du projet'));
    check('serveur desactive jamais propose', extMod.suggest(home, root, 'serveur desactive coupe', 4).every((x) => x.name !== 'coupe'), true);

    // ---------------------------------------------------------------- 3. describe
    const dMcp = extMod.describe(home, root, 'render');
    // describe() est SYNCHRONE (aucun spawn) : il decrit le serveur ; la liste
    // d'outils est decouverte par l'outil extensions_describe (test plus bas).
    check('describe MCP : serveur decrit', dMcp.ok && dMcp.kind === 'mcp' && dMcp.enabled === true
        && /mcp_call/.test(dMcp.howto), dMcp);
    const dSk = extMod.describe(home, root, 'render-deploy');
    check('describe skill : actif + howto', dSk.ok && dSk.kind === 'skill' && dSk.active === true && /skill_load/.test(dSk.howto), dSk);
    const dSk2 = extMod.describe(home, root, 'autre-skill');
    check('describe skill inactif : signale', dSk2.ok && dSk2.active === false && /inactif/.test(dSk2.howto), dSk2);
    const dCmd = extMod.describe(home, root, 'deploiement');
    check('describe commande', dCmd.ok && dCmd.kind === 'command' && /\/deploiement/.test(dCmd.howto), dCmd);
    const dAg = extMod.describe(home, root, 'Deployeur');
    check('describe agent', dAg.ok && dAg.kind === 'agent' && /task/.test(dAg.howto), dAg);
    check('describe inconnu : erreur claire', extMod.describe(home, root, 'nexistepas').code === 'not_found', extMod.describe(home, root, 'nexistepas'));

    // ---------------------------------------------------------------- 4. skill_load
    const okSkill = await toolsMod.executeTool(ctx, 'skill_load', { name: 'render-deploy' }, {});
    const skText = String((okSkill.call && okSkill.call.result && okSkill.call.result.content) || '');
    check('skill_load : contenu complet servi', okSkill.status === 'done' && okSkill.call.ok !== false
        && /Pousser le depot/.test(skText), skText.slice(0, 120));
    const badSkill = await toolsMod.executeTool(ctx, 'skill_load', { name: 'autre-skill' }, {});
    check('skill_load : inactif refuse', badSkill.status === 'error' && badSkill.code === 'not_active', badSkill);
    const missSkill = await toolsMod.executeTool(ctx, 'skill_load', { name: 'inexistant' }, {});
    check('skill_load : inconnu refuse', missSkill.status === 'error' && missSkill.code === 'not_found', missSkill);

    // ---------------------------------------------------------------- 5. decouverte par outils
    const listOut = await toolsMod.executeTool(ctx, 'extensions_list', {}, {});
    const listLines = ((listOut.call && listOut.call.result && listOut.call.result.entries) || []).join('\n');
    check('extensions_list : une ligne par extension', listOut.status === 'done'
        && /mcp render/.test(listLines) && /skill render-deploy/.test(listLines)
        && /commande \/deploiement/.test(listLines) && /agent Deployeur/.test(listLines), listLines.slice(0, 240));
    const descOut = await toolsMod.executeTool(ctx, 'extensions_describe', { name: 'render' }, {});
    const descData = (descOut.call && descOut.call.result) || {};
    check('extensions_describe : outils MCP decouverts', descOut.status === 'done'
        && Array.isArray(descData.tools) && descData.tools.indexOf('deploy') !== -1, descData);

    // ---------------------------------------------------------------- 6. mcp_call reel
    const call1 = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'render', outil: 'deploy', arguments: { service: 'demo-p57', commit: 'abc123' } }, { preApproved: true });
    const call1Text = String((call1.call && call1.call.result && call1.call.result.text) || call1.call && call1.call.result || '');
    check('mcp_call : serveur local appele, deploiement rendu', call1.status === 'done' && /dep_1/.test(call1Text) && /live/.test(call1Text), [call1.status, call1Text.slice(0, 160)]);
    check('mcp_call : le secret a bien servi (serveur a accepte)', call1Text.indexOf('jeton Render absent') === -1, call1Text.slice(0, 120));

    const call2 = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'render', outil: 'status', arguments: { deployId: 'dep_1' } }, { preApproved: true });
    check('mcp_call : second outil', call2.status === 'done'
        && /dep_1/.test(String((call2.call && call2.call.result && call2.call.result.text) || '')), call2.status);

    // hors ligne : erreur claire, PAS d exception, le tour peut continuer
    const off = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'fantome', outil: 'deploy', arguments: { service: 'x' } }, { preApproved: true });
    check('mcp_call hors ligne : erreur claire', off.status === 'error'
        && /hors ligne|connexion refusee|echec/i.test(String(off.reason || off.error || JSON.stringify(off))) , off);
    check('mcp_call hors ligne : pas de throw', typeof off === 'object' && !!off.status, off);

    // ---------------------------------------------------------------- 7. permissions
    fs.writeFileSync(path.join(agentHome, 'mcp_policy.json'),
        JSON.stringify({ allowed: { render: ['deploy'], fantome: ['deploy'] } }), 'utf8');
    const notAllowed = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'render', outil: 'status', arguments: {} }, { preApproved: true });
    check('liste administrateur : outil non liste refuse', notAllowed.status === 'error'
        && /non autorise/.test(String(notAllowed.reason || '')), notAllowed);
    fs.writeFileSync(path.join(agentHome, 'mcp_policy.json'),
        JSON.stringify({ allowed: { render: ['deploy', 'status'], fantome: ['deploy'] } }), 'utf8');

    mcpMod.setToolDecision(home, 'render', 'deploy', 'deny');
    const denied = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'render', outil: 'deploy', arguments: { service: 'x' } }, { preApproved: true });
    check('politique par outil : refus', denied.status === 'error' && /refuse par la politique/.test(String(denied.reason || '')), denied);
    mcpMod.setToolDecision(home, 'render', 'deploy', 'ask');

    const ask = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'render', outil: 'deploy', arguments: { service: 'x' } }, {});
    check('sans approbation : demande d approbation (pas un echec)', ask.status === 'need-approval'
        && ask.request && ask.request.pattern && ask.request.pattern.text === 'render/deploy', ask);

    const disabled = await toolsMod.executeTool(ctx, 'mcp_call', { serveur: 'coupe', outil: 'deploy', arguments: {} }, { preApproved: true });
    check('serveur desactive : refus clair', disabled.status === 'error' && /desactive/.test(String(disabled.reason || '')), disabled);

    // ---------------------------------------------------------------- 8. audit
    const auditEntries = extMod.readAudit(home, 100);
    const calls = auditEntries.filter((e) => e.kind === 'mcp');
    check('audit : une entree par appel MCP', calls.length >= 5, calls.length);
    check('audit : succes et echecs journalises', calls.some((e) => e.code === 'ok') && calls.some((e) => e.code !== 'ok'),
        calls.map((e) => e.code));
    const auditRaw = fs.readFileSync(extMod.auditFile(home), 'utf8');
    check('audit : jeton ABSENT du fichier', auditRaw.indexOf(SECRET) === -1, 'fuite de jeton dans audit.jsonl');
    check('audit : cibles enregistrees', seenTargets.indexOf('SudoStudio/mcp/render') !== -1, seenTargets);

    // le secret est bien injecte dans l'ENVIRONNEMENT du serveur MCP
    const env = await extMod.resolveSecretEnv(home, 'render', { RENDER_TOKEN: 'SudoStudio/mcp/render' });
    check('secretEnv : jeton resolu depuis le trousseau', env.env.RENDER_TOKEN === SECRET && env.missing.length === 0, env);
    const envMiss = await extMod.resolveSecretEnv(home, 'render', { RENDER_TOKEN: 'SudoStudio/mcp/absent2' });
    check('secretEnv : secret manquant signale (sans casser)', envMiss.missing.indexOf('RENDER_TOKEN') !== -1
        && envMiss.env.RENDER_TOKEN === undefined, envMiss);

    // aucune sortie d'outil ne contient le jeton
    const allOut = [call1Text, String((call2.call && call2.call.result && call2.call.result.text) || '')].join('\n');
    check('sorties d outil : jeton absent', allOut.indexOf(SECRET) === -1, 'fuite dans une sortie MCP');

    // ---------------------------------------------------------------- 9. commande / agent / task
    const exp = commandsMod.expand(home, root, '/deploiement demo-p57');
    check('commande /nom developpee', exp && exp.matched && exp.ok && /demo-p57/.test(exp.prompt), exp && exp.prompt);
    const agList = agentsMod.listAgents(home);
    check('agent personnalise visible', agList.some((a) => a.name === 'Deployeur'));
    const taskOut = await toolsMod.executeTool(ctx, 'task', { agent: 'Deployeur', consigne: 'deploie' }, {});
    check('task : traite par la boucle agent (pas d appel direct)', taskOut.status === 'error' && taskOut.code === 'loop_only', taskOut);
    const taskBad = await toolsMod.executeTool(ctx, 'task', { agent: 'Deployeur' }, {});
    check('task sans consigne : refus clair', taskBad.status === 'error' && taskBad.code === 'bad_args', taskBad);

    // ---------------------------------------------------------------- 10. schemas / profils
    // P57-1: decision mesuree - les 5 outils d'extensions ne sont PAS dans le
    // profil small (ils faisaient deborder un contexte micro 2048 : P25/P26
    // passaient de vert a "contexte sature"). Ils sont dans le profil complet.
    const small = profiles.profileTools('small');
    const full = profiles.profileTools('full');
    const extTools = ['extensions_list', 'extensions_describe', 'skill_load', 'mcp_call', 'task'];
    check('profil small : pas d outils d extensions (budget micro)', extTools.every((n) => small.indexOf(n) === -1), small);
    check('profil full : les 5 outils d extensions presents', extTools.every((n) => full.indexOf(n) !== -1), full);
    const schemas = toolsMod.toOpenAISchema('full', 8192);
    const names = schemas.map((s) => s.function.name);
    check('schemas full/8192 : mcp_call avec parametres requis', schemas.some((s) => s.function.name === 'mcp_call'
        && s.function.parameters.required.join(',') === 'serveur,outil'), schemas.find((s) => s.function.name === 'mcp_call'));
    // P57-1: meme profil complet, contexte court -> les schemas d'extensions
    // sont retires (le jeu revient a celui d'avant P57, 30 outils).
    const tight = toolsMod.toOpenAISchema('full', 4096).map((s) => s.function.name);
    check('schemas full/4096 : extensions retirees (budget)',
        extTools.every((n) => tight.indexOf(n) === -1) && tight.length === 30, tight.length);
    check('schemas full/8192 : tool_choice contraint reste raisonnable', names.length <= 36, names.length);

    console.log('\n== ' + pass + ' PASS, ' + fail + ' FAIL ==');
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.log('ERREUR SUITE :: ' + String((e && e.stack) || e).slice(0, 600));
    process.exit(1);
});
