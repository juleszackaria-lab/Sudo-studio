/**
 * SUDO STUDIO - P62-D5 (F3) : "code une nouvelle version de ce projet dans
 * un dossier different, au meme niveau que le projet".
 *
 * AVANT : le modele essayait write/edit hors du dossier ouvert, le moteur
 * repondait "edit - bloque : constat requis avant ecriture (echec)" puis
 * "AUCUNE MODIFICATION". Prouve par le scenario 1 (qui reproduit l ancien
 * chemin) ; le scenario 2 prouve la nouvelle voie deterministe.
 *
 * ASCII only. Lancer : node backend/tests/test-p62-copy-project.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld, call, calls, text, lastAssistant } = require('./lib/agentHarness');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

const FILES = {
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 1),
    'src/index.js': "console.log('demo');\n",
    'README.md': '# demo\n',
    'node_modules/x/index.js': 'x\n',
    '.git/config': '[core]\n',
    'build/out.js': 'y\n',
    'dist/out.js': 'z\n',
    '.dart_tool/p.dill': 'd\n',
};

async function main() {
    // Noms uniques : /tmp peut contenir les restes d un run precedent.
    const U = Date.now().toString(36);
    // ---------- 1 : ancien chemin (write hors du dossier ouvert) = ECHEC
    {
        const w = createWorld({ files: FILES });
        const voisin = path.join(path.dirname(w.proj), 'demo-v2-ancien-' + U);
        const r = await w.turn('code une nouvelle version de ce projet dans un dossier different', [
            call('write', { file: voisin + '/src/index.js', content: "console.log('v2');" }),
            text('fini'),
        ], { maxIt: 4 });
        const refused = (r.calls || []).some((c) => c.ok === false && ['outside', 'outside_root', 'denied', 'bad_path', 'bad_args'].indexOf(c.code) !== -1);
        check('F3-avant: un write hors du dossier ouvert est refuse par le moteur (ancien chemin)',
            refused && !fs.existsSync(path.join(voisin, 'src', 'index.js')),
            'codes=' + JSON.stringify((r.calls || []).map((c) => c.tool + ':' + c.code)));
    }

    // ---------- 2 : nouvel outil deterministe copy_project = SUCCES
    {
        const w = createWorld({ files: FILES });
        const nom = 'demo-v2-' + U;
        const r = await w.turn('code une nouvelle version de ce projet dans un dossier different, au meme niveau que le projet', [
            call('copy_project', { nom: nom }),
            text('copie faite'),
        ], { maxIt: 4, autoApprove: 'once' });
        const dest = path.join(path.dirname(w.proj), nom);
        check('F3-apres: le dossier voisin existe', fs.existsSync(dest), dest);
        check('F3-apres: les sources sont copiees',
            fs.existsSync(path.join(dest, 'src', 'index.js')) && fs.existsSync(path.join(dest, 'package.json')),
            dest);
        check('F3-apres: .git / node_modules / build / dist / .dart_tool sont EXCLUS',
            !fs.existsSync(path.join(dest, '.git')) && !fs.existsSync(path.join(dest, 'node_modules')) &&
            !fs.existsSync(path.join(dest, 'build')) && !fs.existsSync(path.join(dest, 'dist')) &&
            !fs.existsSync(path.join(dest, '.dart_tool')), 'exclusions');
        const cp = (r.calls || []).filter((c) => c.tool === 'copy_project');
        check('F3-apres: l appel est trace une seule fois et reussi',
            cp.length === 1 && cp[0].ok === true, JSON.stringify(cp));
        check('F3-apres: le projet ouvert n est pas modifie (meme fichier, meme contenu)',
            w.read('src/index.js') === "console.log('demo');\n", String(w.read('src/index.js')));
        check('F3-apres: la reponse finale annonce le dossier cree',
            new RegExp(nom).test(String(lastAssistant(r.msgs) || '')), JSON.stringify(String(lastAssistant(r.msgs) || '').slice(0, 140)));
    }

    // ---------- 3 : sans approbation, rien n est ecrit
    {
        const w = createWorld({ files: FILES });
        const nom = 'demo-v2-refus-' + U;
        const r = await w.turn('copie le projet dans un dossier voisin', [
            call('copy_project', { nom: nom }),
            text('rien fait'),
        ], { maxIt: 3, autoApprove: 'deny' });
        const dest = path.join(path.dirname(w.proj), nom);
        check('F3-securite: refus de l operateur -> aucun dossier cree', !fs.existsSync(dest), dest);
        check('F3-securite: le refus est trace (denied)',
            (r.calls || []).some((c) => c.tool === 'copy_project' && c.code === 'denied'),
            JSON.stringify((r.calls || []).map((c) => c.tool + ':' + c.code)));
    }

    // ---------- 4 : un dossier voisin deja rempli n est pas ecrase
    {
        const w = createWorld({ files: FILES });
        const nom = 'demo-v2-existant-' + U;
        const dest = path.join(path.dirname(w.proj), nom);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'important.txt'), 'ne pas ecraser\n');
        const r = await w.turn('copie le projet dans un dossier voisin', [
            call('copy_project', { nom: nom }),
            text('ok'),
        ], { maxIt: 3, autoApprove: 'once' });
        check('D5-securite: cible non vide -> refus, contenu intact',
            fs.readFileSync(path.join(dest, 'important.txt'), 'utf8') === 'ne pas ecraser\n' &&
            (r.calls || []).some((c) => c.tool === 'copy_project' && c.code === 'exists'),
            JSON.stringify((r.calls || []).map((c) => c.tool + ':' + c.code)));
    }

    // ---------- 5 : l avertissement nomme bien l ecriture hors projet
    {
        const w = createWorld({ files: FILES });
        const p = w.turn('copie le projet a cote', [call('copy_project', { nom: 'demo-v2-warn-' + U }), text('ok')], { maxIt: 3 });
        const t0 = Date.now();
        while (!w.waiters.size && Date.now() - t0 < 4000) await new Promise((r2) => setTimeout(r2, 20));
        let warn = '';
        for (const id of Array.from(w.waiters.keys())) {
            const req = Array.from(w.pending.values()).find((x) => x.request && x.request.id === id);
            warn = req ? String(req.request.warning || '') : '';
            require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'loop')).resolveTurnApproval(w.toolsCtx(), id, 'deny');
        }
        check('D5-approbation: avertissement en francais nommant l ecriture HORS du projet',
            /ATTENTION/.test(warn) && /hors de lui/i.test(warn), JSON.stringify(warn.slice(0, 120)));
        await p;
    }

    console.log('\nP62-D5: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exitCode = 1; });
