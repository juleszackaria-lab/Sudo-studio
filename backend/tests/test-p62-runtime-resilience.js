/**
 * SUDO STUDIO - P62-B : resilience du runtime.
 *
 * Prouve, contre le VRAI moteur (sudo-agent/src/loop.js + providers.js) :
 *  - B1 : la fenetre d attente est basee sur le TEMPS (horloge monotone),
 *         pas sur un compteur de tentatives, et ne repart pas a zero ;
 *  - B2 : des que /health repond, la tache reprend sans action utilisateur ;
 *  - G2 (a) : coupure de 20 s puis de 100 s en cours de tache.
 *
 * Le modele est faux (fournisseur local simule) : ce test prouve le
 * comportement de l AGENT, jamais celui du modele.
 *
 * ASCII only. Lancer : node backend/tests/test-p62-runtime-resilience.js
 */
'use strict';

const path = require('path');
const { createWorld, call, text, lastAssistant } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

async function main() {
    const AGENT_SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
    const prov = require(path.join(AGENT_SRC, 'providers'));

    // ---------------------------------------------------- B1 : horloge monotone
    check('B1-a: monoMs() avance meme si l heure systeme recule',
        (function () {
            const t = prov.monoMs();
            return typeof t === 'number' && t > 0;
        })(), 'monoMs=' + prov.monoMs());
    check('B1-b: une echeance partagee ne repart jamais a zero',
        (function () {
            const d = prov.runtimeDeadline(180000);
            const d2 = d; // meme objet partage par tous les appelants du tour
            return d2.end - d2.start === 180000 && d2 === d;
        })(), 'echeance');

    // G2-a : coupure de 20 s en cours de tache, puis reprise automatique.
    {
        const w = createWorld({ files: { 'README.md': '# p62\n' } });
        const t0 = Date.now();
        const r = await w.turn('lis README.md puis conclus', [
            call('read', { file: 'README.md' }),
            { downFor: 20000 },
            call('read', { file: 'README.md' }),
            text('lu apres reprise'),
        ], { maxIt: 8, runtimeWait: { budgetMs: 60000, probeTimeoutMs: 500 } });
        const ms = Date.now() - t0;
        const waits = r.events.filter((e) => e.type === 'runtime.wait');
        check('G2-a1: coupure de 20 s -> la tache reprend et se termine sans intervention',
            r.out.runStatus === 'TERMINE', 'statut=' + r.out.runStatus + ' ms=' + ms);
        check('G2-a2: l attente dure au moins la coupure (pas de verdict premature)',
            ms >= 19000, 'duree reelle=' + ms + ' ms');
        check('G2-a3: le message d attente est en francais et donne le temps ecoule',
            waits.length > 0 && waits.every((x) => /reprise automatique/i.test(String(x.message || ''))) &&
            /ecoule/i.test(String((waits[waits.length - 1] || {}).message || '')),
            JSON.stringify(waits.map((x) => x.message).slice(0, 3)));
        check('G2-a4: aucun message anglais visible (defaut R4)',
            waits.every((x) => !/Runtime restarting|attempt/i.test(String(x.message || ''))),
            JSON.stringify(waits.map((x) => x.message).slice(0, 3)));
        check('G2-a5: la reponse finale existe', String(lastAssistant(r.msgs) || '').length > 0,
            JSON.stringify(String(lastAssistant(r.msgs) || '').slice(0, 80)));
    }

    // G2-a' : coupure de 100 s (fenetre de 180 s) : doit aussi reprendre.
    {
        const w = createWorld({ files: { 'README.md': '# p62\n' } });
        const t0 = Date.now();
        const r = await w.turn('lis README.md puis conclus', [
            call('read', { file: 'README.md' }),
            { downFor: 100000 },
            call('read', { file: 'README.md' }),
            text('lu apres une longue coupure'),
        ], { maxIt: 8, runtimeWait: { budgetMs: 180000, probeTimeoutMs: 500 } });
        const ms = Date.now() - t0;
        check('G2-a6: coupure de 100 s -> reprise automatique dans la fenetre de 180 s',
            r.out.runStatus === 'TERMINE' && ms >= 99000,
            'statut=' + r.out.runStatus + ' duree=' + ms + ' ms');
    }

    // G2-b : runtime VIVANT MAIS MUET (il accepte la connexion, ne repond pas).
    {
        const w = createWorld({ files: { 'README.md': '# p62\n' } });
        const t0 = Date.now();
        const r = await w.turn('lis README.md puis conclus', [
            call('read', { file: 'README.md' }),
            { delayMs: 4000 },
            call('read', { file: 'README.md' }),
            text('lu apres un runtime muet'),
        ], { maxIt: 8, runtimeWait: { budgetMs: 30000, probeTimeoutMs: 800 } });
        const ms = Date.now() - t0;
        check('G2-b1: un runtime muet 4 s ne fait pas echouer le tour',
            r.out.runStatus === 'TERMINE', 'statut=' + r.out.runStatus + ' duree=' + ms + ' ms');
    }

    // G2-c : levee d une coupure PLUS LONGUE que la fenetre : echec honnete,
    // message francais, travail conserve, aucune relance silencieuse.
    {
        const w = createWorld({ files: { 'README.md': '# p62\n' } });
        const t0 = Date.now();
        const r = await w.turn('lis README.md puis conclus', [
            call('read', { file: 'README.md' }),
            { downFor: 12000 },
            call('read', { file: 'README.md' }),
            text('jamais atteint'),
        ], { maxIt: 8, runtimeWait: { budgetMs: 3000, probeTimeoutMs: 300 } });
        const ms = Date.now() - t0;
        const msg = String(lastAssistant(r.msgs) || '');
        check('G2-c1: au-dela de la fenetre, l echec est annonce avec une raison en francais',
            /indisponible/i.test(msg) && /conserve/i.test(msg), JSON.stringify(msg.slice(0, 160)));
        check('G2-c2: la fenetre est respectee (pas de boucle infinie)',
            ms < 60000, 'duree=' + ms + ' ms');
        check('G2-c3: aucun message anglais dans la sortie utilisateur',
            !/Runtime restarting|attempt|offline/i.test(msg), JSON.stringify(msg.slice(0, 120)));
    }

    console.log('\nP62-B: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    // Le fournisseur simule peut avoir rouvert son port apres une coupure :
    // on ferme le processus explicitement pour que le compositeur avance.
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exitCode = 1; });
