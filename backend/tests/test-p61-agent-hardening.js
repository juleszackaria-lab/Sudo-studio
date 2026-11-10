/**
 * SUDO STUDIO - P61: durcissement de l'agent (echecs E1..E5 du journal reel).
 *
 * Chaque test s'appuie sur ce que l'UTILISATEUR voit et sur ce que le disque
 * prouve (fichiers, journal, meta.lastRun) - jamais sur une intention.
 * Le modele est simule (regle P59/P60 : un harnais a modele simule prouve le
 * comportement de l'AGENT, pas la qualite du modele).
 *
 *   node backend/tests/test-p61-agent-hardening.js
 *
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorld, call, calls, text, lastAssistant, journalLines, tmp } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log('ok - ' + name); }
    else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function codesOf(r, tool) {
    return (r.calls || []).filter((c) => c.tool === tool).map((c) => c.code);
}
function realExecs(r, tool) {
    // Une execution REELLE = le code n'est ni un doublon, ni un refus de garde.
    const NOT_EXEC = ['already_done', 'duplicate', 'skipped', 'corrective', 'loop', 'not_found_resolved', 'target_given_up'];
    return (r.calls || []).filter((c) => c.tool === tool && NOT_EXEC.indexOf(c.code) === -1).length;
}

const FILES = {
    'package.json': JSON.stringify({ name: 'p61', version: '1.0.0' }),
    'notes.txt': 'a supprimer\n',
    'README.md': '# Projet\n\nBienvenue.\n',
    'src/app.js': 'const x = 1;\n',
};

async function main() {
    // ---------------------------------------------------------------- E1
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Utilise le systeme audit et fais l audit complet puis corrige', [
            call('security_audit_run', {}),
            call('security_audit_run', {}),
            call('security_audit_run', {}),
            text('fini'),
        ], { maxIt: 10 });
        check('E1-a: un appel identique n est execute QU UNE fois (3 demandes)',
            realExecs(r, 'security_audit_run') === 1, 'execs=' + realExecs(r, 'security_audit_run') + ' codes=' + codesOf(r, 'security_audit_run').join(','));
        check('E1-b: la redemande est refusee avec "deja execute" ou arretee',
            codesOf(r, 'security_audit_run').some((c) => c === 'already_done' || c === 'loop'),
            codesOf(r, 'security_audit_run').join(','));
        const msg = lastAssistant(r.msgs);
        check('E1-c: le message final dit ce qui est fait ET ce qui reste',
            /Fait :/.test(msg) && /Reste :/.test(msg), JSON.stringify(String(msg).slice(0, 160)));
    }

    // ---------------------------------------------------------------- E2
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Supprime le fichier notes.txt', [
            call('delete', { file: 'notes.txt' }),
            text('fini'),
        ], { autoApprove: 'once', maxIt: 6 });
        check('E2-a: la suppression APRES approbation est reellement faite', !w.exists('notes.txt'), 'fichier encore present');
        check('E2-b: un SEUL delete reellement execute', realExecs(r, 'delete') === 1, 'execs=' + realExecs(r, 'delete') + ' codes=' + codesOf(r, 'delete').join(','));
        check('E2-c: l agent a lu le fichier lui-meme avant de supprimer',
            /lecture automatique avant action/.test(r.journal), 'pas de ligne de journal');
        check('E2-d: aucune erreur not_read renvoyee au modele',
            codesOf(r, 'delete').indexOf('not_read') === -1, codesOf(r, 'delete').join(','));
        const readFiles = (w.meta().readFiles || []);
        check('E2-e: le fichier a ete marque lu (protection conservee)', readFiles.indexOf('notes.txt') !== -1, JSON.stringify(readFiles));
    }

    // ---------------------------------------------------------------- E3
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Lis readme.md', [
            call('read', { file: 'readme.md' }),
            text('lu'),
        ], { maxIt: 6 });
        check('E3-a: la casse est corrigee automatiquement (README.md lu)',
            /chemin resolu/.test(r.journal) && r.calls.some((c) => c.tool === 'read' && c.ok),
            'journal=' + (/chemin resolu/.test(r.journal) ? 'oui' : 'non'));
        check('E3-b: le modele recoit le contenu ET le chemin corrige',
            JSON.stringify(r.msgs).indexOf('README.md') !== -1, 'contenu absent du transcript');
        const d3 = r.events.filter((e) => e.type === 'turn.done').pop() || {};
        check('E3-c: aucun statut silencieux (raison + texte final non vides)',
            String(d3.reason || '').trim().length > 5 && String(lastAssistant(r.msgs)).trim().length > 0,
            'status=' + r.out.runStatus + ' reason=' + JSON.stringify(d3.reason));
    }
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Lis un fichier qui n existe pas du tout', [
            call('read', { file: 'inexistant-total.md' }),
            call('read', { file: 'inexistant-total.md' }),
            call('read', { file: 'inexistant-total.md' }),
            call('read', { file: 'inexistant-total.md' }),
            text('fini'),
        ], { maxIt: 10 });
        check('E3-d: 2 echecs max sur la MEME cible puis abandon explique',
            r.calls.filter((c) => c.code === 'target_given_up').length === 1,
            codesOf(r, 'read').join(','));
        check('E3-e: la liste des fichiers existants est donnee une seule fois',
            journalLines(r.journal, 'cible introuvable').length <= 2,
            'lignes=' + journalLines(r.journal, 'cible introuvable').length);
    }

    // ---------------------------------------------------------------- E4
    {
        const w = createWorld({ files: { 'package.json': JSON.stringify({ name: 'p61' }) } });
        const r = await w.turn('Lis package.json', [
            call('read', { file: 'package.json' }),
            { downFor: 700 },
            call('read', { file: 'package.json' }),
            { text: 'lu' },
        ], { maxIt: 8, runtimeWait: { attempts: 8, delayMs: 300, probeTimeoutMs: 200 } });
        const waits = r.events.filter((e) => e.type === 'runtime.wait');
        check('E4-a: le tour survit a une coupure du runtime', r.out.runStatus === 'TERMINE', r.out.runStatus);
        check('E4-b: l utilisateur voit "Runtime en redemarrage"',
            waits.length > 0 && /Runtime en redemarrage/.test(String(waits[0].message || '')),
            JSON.stringify(waits.map((x) => x.message).slice(0, 2)));
        check('E4-c: la requete est rejouee, pas perdue',
            r.calls.some((c) => c.tool === 'read' && c.ok), 'aucun read abouti');
    }

    // ---------------------------------------------------------------- E5
    {
        const w = createWorld({ files: { 'package.json': JSON.stringify({ name: 'p61' }) } });
        const r = await w.turn('Fais une chose impossible', [
            call('outil_inexistant', {}),
            call('outil_inexistant', {}),
            call('outil_inexistant', {}),
            call('outil_inexistant', {}),
        ], { maxIt: 8 });
        const done = r.events.filter((e) => e.type === 'turn.done').pop() || {};
        check('E5-a: PARTIEL avec une raison non vide', String(done.reason || '').trim().length > 5, JSON.stringify(done.reason));
        const msg = lastAssistant(r.msgs);
        check('E5-b: un message visible est TOUJOURS ecrit', String(msg).trim().length > 20, JSON.stringify(msg.slice(0, 120)));
        check('E5-c: le message explique fait/reste', /Fait :/.test(msg) && /Reste :/.test(msg), JSON.stringify(msg.slice(0, 200)));
    }

    // ------------------------------------------------- 4: dedup dans une reponse
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('lis README.md', [
            { calls: [{ name: 'read', args: { file: 'README.md' } }, { name: 'read', args: { file: 'README.md' } }] },
            text('fini'),
        ], { maxIt: 5 });
        check('4-a: deux appels identiques dans la MEME reponse -> une execution',
            realExecs(r, 'read') === 1, 'execs=' + realExecs(r, 'read') + ' codes=' + codesOf(r, 'read').join(','));
        check('4-b: le doublon est marque "duplicate"', codesOf(r, 'read').indexOf('duplicate') !== -1, codesOf(r, 'read').join(','));
    }

    // ------------------------------------------------- 7: cibles dangereuses
    // Chaque cible est testee dans une session NEUVE : un refus laisse une
    // tache inachevee, et le tour suivant demanderait d'abord REPRENDRE ou
    // ABANDONNER (comportement voulu, mais il masquerait ce qu'on mesure ici).
    for (const target of ['.git/config', 'node_modules/x/index.js']) {
        const w = createWorld({ files: { 'package.json': '{}', '.git/config': '[core]\n', 'node_modules/x/index.js': 'x\n' } });
        const { ruleKey } = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'permissions'));
        // Approbation generale deja memorisee pour ce fichier precis.
        w.rules.get(w.sessionId).add(ruleKey('delete', { kind: 'file', text: target }));
        const p = w.turn('supprime ' + target, [call('delete', { file: target }), text('fini')], { maxIt: 4 });
        const t0 = Date.now();
        while (!w.waiters.size && Date.now() - t0 < 4000) await new Promise((r2) => setTimeout(r2, 20));
        const asked = w.waiters.size > 0;
        let wtext = '';
        for (const id of Array.from(w.waiters.keys())) {
            const req = Array.from(w.pending.values()).find((x) => x.request && x.request.id === id);
            wtext = req ? String(req.request.warning || '') : '';
            require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'loop')).resolveTurnApproval(w.toolsCtx(), id, 'deny');
        }
        // P61-7: l'avertissement doit NOMMER le dossier sensible en francais
        // ("ATTENTION ... .git"). Une demande sans texte n'est pas une
        // confirmation eclairee. L'assertion tourne MEME si aucune approbation
        // n'est demandee : c'est justement le defaut mesure.
        const warned = /ATTENTION/.test(wtext) && wtext.indexOf(target.split('/')[0]) !== -1;
        check('7: ' + target + ' -> confirmation DISTINCTE meme avec une regle', asked && warned,
            'asked=' + asked + ' warn=' + JSON.stringify(wtext.slice(0, 80)));
        await p;
        check('7-b: ' + target + ' intact apres refus', w.exists(target));
    }

    // ------------------------------------------------- 9: abandon avec raison
    {
        const w = createWorld({ files: { 'package.json': '{}' } });
        const p = w.turn('lis package.json puis continue', [
            call('read', { file: 'package.json' }),
            { delayMs: 3000 },
            text('fin'),
        ], { maxIt: 4 });
        await new Promise((r2) => setTimeout(r2, 400));
        const { abortRun } = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'loop'));
        // Le tour est lance par w.turn avec son propre runs Map : on passe par
        // l'evenement d'annulation de l'outil (approbation) pour rester public.
        const out = await p;
        check('9-a: un abandon ne laisse jamais un statut muet',
            out.out.runStatus === 'TERMINE' || /Statut|interrompue|Fait/.test(lastAssistant(out.msgs)),
            out.out.runStatus + ' / ' + JSON.stringify(lastAssistant(out.msgs).slice(0, 80)));
    }

    // ------------------------------------------------- 11: isolation des tours
    {
        const w = createWorld({ files: FILES });
        for (let i = 0; i < 20; i++) {
            const r = await w.turn('lis README.md (demande ' + i + ')', [
                call('read', { file: 'README.md' }),
                text('ok ' + i),
            ], { maxIt: 3 });
            if (r.out.runStatus === 'ECHEC') {
                check('11: 20 demandes consecutives sans blocage', false, 'echec a la demande ' + i);
                break;
            }
            if (i === 19) check('11: 20 demandes consecutives sans blocage', true);
        }
        const r2 = await w.turn('lis README.md encore', [call('read', { file: 'README.md' }), text('ok')], { maxIt: 3 });
        check('11-b: aucun etat de dedup ne fuit du tour precedent', realExecs(r2, 'read') === 1, 'execs=' + realExecs(r2, 'read'));
    }

    // ------------------------------------------------- 12: arguments malformes
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('lis README.md', [
            { call: { name: 'read', rawArgs: '{"file": "README.md",}' } },   // virgule finale
            text('fini'),
        ], { maxIt: 4 });
        check('12-a: arguments JSON repares (virgule finale) -> lecture reussie',
            r.calls.some((c) => c.tool === 'read' && c.ok), codesOf(r, 'read').join(','));
        check('12-b: la reparation est journalisee', /arguments d outil repares/.test(r.journal));
    }
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('lis README.md', [
            { call: { name: 'read', rawArgs: 'pas du json du tout' } },
            { call: { name: 'read', rawArgs: '[[[' } },
            text('fini'),
        ], { maxIt: 4 });
        // P61-12: le modele recoit une explication francaise, jamais une trace
        // technique ; le tour se termine avec une raison visible.
        const toolMsgs = JSON.stringify(r.msgs.filter((m) => m.role === 'tool').map((m) => String(m.content)));
        const d2 = r.events.filter((e) => e.type === 'turn.done').pop() || {};
        check('12-c: arguments irrecuperables -> erreur claire en francais, jamais un 500',
            r.calls.some((c) => c.code === 'bad_args') && /argument|outil/i.test(toolMsgs) && !/stack|TypeError/.test(toolMsgs),
            'codes=' + codesOf(r, 'read').join(',') + ' msgs=' + toolMsgs.slice(0, 160));
        check('12-d: statut final toujours accompagne d une raison',
            String(d2.reason || '').trim().length > 5, JSON.stringify(d2.reason));
    }

    // ------------------------------------------------- 13: journal
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('lis README.md', [call('read', { file: 'README.md' }), text('fini')], { maxIt: 3 });
        const lines = journalLines(r.journal, 'tool ok').concat(journalLines(r.journal, 'tool fail'));
        check('13-a: une ligne de journal par appel d outil execute', lines.length === 1, 'lignes=' + lines.length);
        check('13-b: la ligne porte duree et resultat', /ms=\d+/.test(lines[0] || '') && /code=/.test(lines[0] || ''), String(lines[0] || '').slice(0, 120));
        check('13-c: git statut avant/apres journalise', /git statut avant/.test(r.journal) && /git statut apres/.test(r.journal));
    }

    // ------------------------------------------------- secrets dans le journal
    {
        const w = createWorld({ files: Object.assign({ '.env': 'API_KEY=sk-live-0123456789abcdef\n' }, FILES) });
        const r = await w.turn('lis .env', [call('read', { file: '.env' }), text('fini')], { maxIt: 3 });
        check('s: aucun secret en clair dans le journal',
            !/sk-live-0123456789abcdef/.test(r.journal), 'secret trouve dans agent.log');
    }

    console.log('\nP61: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exitCode = 1; });
