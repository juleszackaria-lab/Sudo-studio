/**
 * SUDO STUDIO - P62-F2 / F4 : refus respecte, cible absente non bouclee.
 *
 * Deux echecs PROUVES par la video du paquet installe :
 *   F2 : apres un refus d'approbation, l'agent continuait (not_read x4) puis
 *        affichait « AUCUNE MODIFICATION : lecture seule » - un statut qui ne
 *        dit rien de ce qui s'est passe.
 *   F4 : un fichier inexistant (readme.md) etait redemande 4 fois jusqu'a
 *        max_iters, au lieu de s'arreter avec la raison.
 *
 * Le modele est simule (regle P59/P60) : ce test prouve le comportement du
 * MOTEUR, pas la qualite du modele.
 *
 * HTML/ASCII only. Lancer : node backend/tests/test-p62-refus-boucle.js
 */
'use strict';

const { createWorld, call, text, lastAssistant, tmp } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

const FILES = {
    'package.json': JSON.stringify({ name: 'p62', version: '1.0.0' }),
    'notes.txt': 'a supprimer\n',
    'src/app.js': 'const x = 1;\n',
};

async function main() {
    // ---------------------------------------------------------------- F2
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Supprime le fichier notes.txt', [
            call('delete', { file: 'notes.txt' }),
            // Si le moteur laissait continuer, ces lectures apparaitraient.
            call('read', { file: 'package.json' }),
            call('read', { file: 'src/app.js' }),
            text('fini'),
        ], { autoApprove: 'deny', maxIt: 8 });

        const after = (r.calls || []).map((c) => c.tool + '/' + (c.code || 'ok'));
        check('F2-a: le refus est enregistre comme refus (code denied)',
            (r.calls || []).some((c) => c.tool === 'delete' && c.code === 'denied'), after.join(','));
        check('F2-b: le fichier est INTACT apres refus', w.exists('notes.txt'));
        const idxDenied = (r.calls || []).findIndex((c) => c.code === 'denied');
        check('F2-c: le tour s arrete au refus (aucun appel APRES le refus)',
            idxDenied !== -1 && idxDenied === (r.calls || []).length - 1, after.join(','));
        const msg = lastAssistant(r.msgs);
        check('F2-d: le message final dit REFUSE et nomme l outil',
            /REFUS/i.test(msg) && /delete/.test(msg), JSON.stringify(String(msg).slice(0, 200)));
        check('F2-e: le message dit qu aucune modification n a ete faite',
            /Aucune modification/i.test(msg), JSON.stringify(String(msg).slice(0, 200)));
        check('F2-f: le message n est plus le vague « AUCUNE MODIFICATION : lecture seule »',
            !/^AUCUNE MODIFICATION\s*:/i.test(msg), JSON.stringify(String(msg).slice(0, 120)));
        const reason = String((r.lastRun && r.lastRun.reason) || (r.events.find((e) => e.type === 'turn.done') || {}).reason || '');
        check('F2-g: le statut est motive (raison explicite, jamais un PARTIEL muet)',
            /refus/i.test(reason), reason.slice(0, 160));
    }

    // ---------------------------------------------------------------- F4
    {
        const w = createWorld({ files: FILES });
        const r = await w.turn('Lis le fichier readme.md', [
            call('read', { file: 'readme.md' }),
            call('read', { file: 'readme.md' }),
            call('read', { file: 'readme.md' }),
            call('read', { file: 'readme.md' }),
            text('lu'),
        ], { maxIt: 8 });

        const reads = (r.calls || []).filter((c) => c.tool === 'read');
        // Les entrees 'not_found_resolved' sont la REPONSE de l'agent au 1er
        // echec (liste/resolution), pas une tentative de plus.
        const attempts = reads.filter((c) => c.code !== 'not_found_resolved');
        check('F4-a: le fichier absent n est PAS redemande 4 fois (2 tentatives maximum)',
            attempts.length <= 3 && attempts[attempts.length - 1].code === 'target_given_up',
            'tentatives=' + attempts.length + ' ' + attempts.map((c) => c.code).join(','));
        check('F4-b: le moteur s arrete avec la raison « cible abandonnee »',
            reads.some((c) => c.code === 'target_given_up') || /introuvable/i.test(r.journal),
            reads.map((c) => c.code).join(',') + ' | journal=' + String(r.journal).slice(-200));
        const msg = lastAssistant(r.msgs);
        check('F4-c: le message final dit que la cible est introuvable (en francais)',
            /introuvable/i.test(msg), JSON.stringify(String(msg).slice(0, 200)));
        check('F4-d: aucun fichier n a ete cree par erreur',
            !w.exists('readme.md') && w.read('package.json') !== null);
        const done = r.events.find((e) => e.type === 'turn.done') || {};
        check('F4-e: le statut n est jamais un TERMINE flatteur',
            done.status !== 'TERMINE', JSON.stringify({ status: done.status, reason: done.reason }));
    }

    // ------------------------------------- F4 bis : resolution de casse OK
    {
        const w = createWorld({ files: { 'README.md': '# Projet\n', 'notes.txt': 'x\n' } });
        const r = await w.turn('Lis le fichier readme.md', [
            call('read', { file: 'readme.md' }),
            text('lu'),
        ], { maxIt: 4 });
        check('F4-f: quand un fichier proche existe, il est trouve (pas abandonne)',
            (r.calls || []).some((c) => c.tool === 'read' && c.ok === true),
            (r.calls || []).map((c) => c.tool + '/' + (c.code || 'ok')).join(','));
    }

    console.log('\nP62-F2/F4: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
