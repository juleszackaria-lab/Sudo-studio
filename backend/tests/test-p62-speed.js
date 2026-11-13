/**
 * SUDO STUDIO - P62-E : mesures et bruit du journal.
 *
 * Prouve, sur le VRAI moteur :
 *  - E1 : chaque appel au modele laisse une ligne de mesures (jetons, duree,
 *         jetons/seconde) et le tour une ligne de synthese ; aucun chiffre
 *         n est invente (tout vient de l usage renvoye par le fournisseur) ;
 *  - E5 : une seule ligne de journal par appel d outil, sans le bruit des
 *         interrogations (/approvals, /jobs, /extensions).
 *
 * ASCII only. Lancer : node backend/tests/test-p62-speed.js
 */
'use strict';

const { createWorld, call, text, journalLines } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

async function main() {
    {
        const w = createWorld({ files: { 'README.md': '# p62\n' } });
        const r = await w.turn('lis README.md puis conclus', [
            call('read', { file: 'README.md' }),
            text('lu'),
        ], { maxIt: 4 });
        const calls = journalLines(r.journal, 'appel modele');
        const tour = journalLines(r.journal, 'mesures du tour');
        check('E1-a: une ligne de mesures par appel au modele', calls.length >= 2, 'lignes=' + calls.length);
        check('E1-b: la ligne porte les jetons et la duree',
            calls.length > 0 && /jetonsPrompt=\d+/.test(calls[0]) && /jetonsGeneres=\d+/.test(calls[0]) && /ms=\d+/.test(calls[0]),
            String(calls[0] || '').slice(0, 160));
        check('E1-c: une synthese unique de fin de tour', tour.length === 1, 'lignes=' + tour.length);
        check('E1-d: la synthese porte appels modele, jetons et jetons/seconde',
            tour.length === 1 && /appelsModele=\d+/.test(tour[0]) && /jetonsGeneres=\d+/.test(tour[0]) &&
            /jetonsParSeconde=/.test(tour[0]), String(tour[0] || '').slice(0, 200));
        const out = journalLines(r.journal, 'tool ok').concat(journalLines(r.journal, 'tool fail'));
        check('E5-a: une seule ligne de journal par appel d outil', out.length === 1, 'lignes=' + out.length);
        check('E5-b: aucun bruit d interrogation dans le journal du moteur',
            !/approvals|\/jobs|extensions\/summary/.test(r.journal), 'bruit detecte');
    }

    console.log('\nP62-E: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exitCode = 1; });
