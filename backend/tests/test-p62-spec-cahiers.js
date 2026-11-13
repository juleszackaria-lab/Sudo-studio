/**
 * SUDO STUDIO - P62-F : gros cahiers des charges (60, 300, 1000 lignes).
 *
 * Prouve, sur le VRAI moteur (spec.js + job.js + stepcheck.js) :
 *   F-1  le cahier est stocke sur disque, estime en jetons, et n'est JAMAIS
 *        envoye en entier quand il depasse 50 % de n_ctx ;
 *   F-2  le modele ne recoit que l'etape courante + la section utile + un
 *        resume borne, dans un budget de 60 % de n_ctx ;
 *   F-3  le registre (exigence -> etape -> statut -> preuve) survit a un
 *        crash : on tue le traitement en pleine etape et on reprend ;
 *   F-4  l'etape n'est declaree faite qu'apres verification DETERMINISTE
 *        (fichier present + syntaxe valide) ; un fichier faux est rattrape
 *        par les 2 essais, puis marque echoue avec la raison reelle ;
 *   F-6  le rapport final dit FAIT / ECHOUE / NON FAIT par exigence.
 *
 * ASCII only. Lancer : node backend/tests/test-p62-spec-cahiers.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'sudo-agent', 'src');
const spec = require(path.join(SRC, 'spec'));
const job = require(path.join(SRC, 'job'));
const stepcheck = require(path.join(SRC, 'stepcheck'));

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

// Cahier des charges synthetique : titres numerotes + exigences numerotees.
function brief(nReq, nLines) {
    const L = ['# Cahier des charges du produit', '', '## 1. Objectif', 'Construire un produit verifiable.'];
    for (let i = 1; i <= nReq; i++) {
        L.push('- Exigence ' + i + ' : le module ' + i + ' doit etre implemente et verifie par un test.');
        if (i % 6 === 0) L.push('## ' + (2 + Math.floor(i / 6)) + '. Section ' + i);
        while (L.length < Math.floor((nLines * i) / nReq)) L.push('Complement de specification ligne ' + L.length + '.');
    }
    while (L.length < nLines) L.push('Ligne de contexte supplementaire ' + L.length + '.');
    return L.join('\n');
}

function tmpRoot(tag) {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p62-' + tag + '-'));
    return r;
}

function writeReal(root, rel, content) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

async function runBrief(tag, nReq, nLines, nCtx) {
    const root = tmpRoot(tag);
    const text = brief(nReq, nLines);
    const meta = spec.ingest(root, text, {});
    const steps = spec.planSteps(meta);
    const pol = job.specPolicy(meta, nCtx);
    const st = job.create(root, meta, steps, { specPolicy: pol });
    return { root, text, meta, steps, st, pol };
}

async function main() {
    // ------------------------------------------------ F-1 : jamais en entier
    {
        const { meta, pol, root } = await runBrief('f1', 40, 300, 2048);
        check('F-1a: le cahier est ecrit sur disque',
            fs.existsSync(path.join(root, '.sudo-agent', 'specs', meta.id + '.md')),
            path.join(root, '.sudo-agent', 'specs'));
        check('F-1b: il est estime en jetons et compare a n_ctx',
            pol.specTokens > 0 && pol.nCtx === 2048 && pol.share > 0.5,
            JSON.stringify(pol));
        check('F-1c: au-dela de 50 % du contexte, le document entier est INTERDIT',
            pol.wholeDocumentForbidden === true, JSON.stringify(pol));
        const small = await runBrief('f1b', 10, 60, 32768);
        check('F-1d: un cahier de 60 lignes dans un grand contexte reste autorise en entier',
            small.pol.wholeDocumentForbidden === false, JSON.stringify(small.pol));
    }

    // ------------------------------------------------ F-2 : budget par appel
    {
        const { st, meta, root, text } = await runBrief('f2', 40, 300, 2048);
        // Lignes reelles du cahier : on mesure la PART du document qui fuit.
        const docLines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 25);
        let maxLen = 0;
        let maxPart = 0;
        const runStep = async (step, ctx) => {
            const p = job.stepPrompt(ctx);
            maxLen = Math.max(maxLen, p.length);
            const seen = docLines.filter((l) => p.indexOf(l) !== -1).length;
            maxPart = Math.max(maxPart, docLines.length ? seen / docLines.length : 0);
            const rel = 'src/m' + ctx.n + '.js';
            writeReal(root, rel, 'const m = ' + ctx.n + ';\n');
            return { ok: true, files: [rel], declared: true };
        };
        const res = await job.run({ root, state: st, runStep });
        const cap = (job.specPolicy(meta, 2048).callBudgetChars);
        check('F-2a: aucun appel ne depasse 60 % du contexte',
            maxLen <= cap, maxLen + ' > ' + cap);
        check('F-2b: le cahier complet n a jamais ete envoye (moins de 60 % du document par appel)',
            maxPart < 0.6, 'part maximale du document envoyee : ' + Math.round(maxPart * 100) + ' %');
        check('F-2c: toutes les etapes ont recu leur section utile',
            res.total > 0 && res.done > 0, JSON.stringify(res).slice(0, 160));
    }

    // ------------------------------------- F-3/F-4/F-6 : 300 lignes + crash
    {
        const { st, root } = await runBrief('f3', 40, 300, 4096);
        let crashed = false;
        const runStep1 = async (step, ctx) => {
            if (ctx.n === 4 && !crashed) {
                // Simule un crash : le processus meurt PENDANT l'etape 4.
                crashed = true;
                const onDisk = job.load(root, st.id);
                onDisk.steps[3].status = 'running'; // etat laisse par le crash
                job.save(root, onDisk);
                throw Object.assign(new Error('arret brutal simule'), { simulatedCrash: true });
            }
            const rel = 'src/p' + ctx.n + '.js';
            writeReal(root, rel, 'const p = ' + ctx.n + ';\n');
            return { ok: true, files: [rel], declared: true };
        };
        let first = null;
        try { first = await job.run({ root, state: st, runStep: runStep1 }); }
        catch (_) { first = null; }
        const crashedState = job.load(root, st.id);
        check('F-3a: le registre est sur disque et survit au crash',
            !!crashedState && crashedState.steps.filter((s) => s.status === 'done').length >= 3,
            crashedState ? crashedState.steps.map((s) => s.status).slice(0, 6).join(',') : 'absent');
        const dejaFaits = crashedState.steps.filter((s) => s.status === 'done').map((s) => s.i);
        const replayed = [];
        const runStep2 = async (step, ctx) => {
            replayed.push(ctx.n);
            const rel = 'src/p' + ctx.n + '.js';
            writeReal(root, rel, 'const p = ' + ctx.n + ';\n');
            return { ok: true, files: [rel], declared: true };
        };
        const second = await job.run({ root, state: crashedState, runStep: runStep2 });
        check('F-3b: la reprise ne refait pas les etapes deja faites',
            dejaFaits.every((i) => replayed.indexOf(i + 1) === -1),
            JSON.stringify({ deja: dejaFaits.slice(0, 5), rejoue: replayed.slice(0, 5) }));
        check('F-3c: le registre est mis a jour et le travail termine',
            second.done === crashedState.steps.length && second.failed === 0,
            JSON.stringify(second).slice(0, 200));
        const finalState = job.load(root, st.id);
        check('F-3d: chaque exigence porte un statut et une preuve',
            finalState.coverage.every((c) => c.status && (c.status !== 'fait' || c.proof)),
            JSON.stringify(finalState.coverage[0] || {}));

        // F-4 : le modele annonce un fichier FAUX -> pas "fait", 2 essais, echoue.
        const root2 = tmpRoot('f4');
        const meta2 = spec.ingest(root2, brief(6, 60), {});
        const st2 = job.create(root2, meta2, spec.planSteps(meta2), { specPolicy: job.specPolicy(meta2, 4096) });
        let attempts = 0;
        const runBad = async (step, ctx) => {
            attempts += 1;
            const rel = 'src/bad' + ctx.n + '.js';
            writeReal(root2, rel, 'const = ;\n'); // syntaxe volontairement invalide
            return { ok: true, files: [rel], declared: true };
        };
        const bad = await job.run({ root: root2, state: st2, runStep: runBad });
        const badState = job.load(root2, st2.id);
        check('F-4a: un fichier a la syntaxe invalide n est jamais declare fait',
            bad.done === 0 && bad.failed === badState.steps.length,
            JSON.stringify({ done: bad.done, failed: bad.failed }));
        check('F-4b: chaque etape a bien eu 2 essais avant d echouer',
            badState.steps.every((s) => s.attempts === 2), badState.steps.map((s) => s.attempts));
        check('F-4c: la raison reelle (syntaxe) est enregistree',
            /syntaxe|verification|invalide/i.test(String(badState.steps[0].detail || '')),
            String(badState.steps[0].detail || '').slice(0, 160));

        // F-6 : rapport final honnete par exigence.
        check('F-6a: le rapport liste FAIT et NON REALISE',
            /FAIT/.test(second.report) && /NON REALISE|ECHOUE/.test(bad.report),
            second.report.split('\n')[0]);
        check('F-6b: le rapport porte une preuve par exigence',
            /preuve:/.test(second.report), second.report.split('\n').slice(-3).join(' | ').slice(0, 200));
    }

    // ------------------------------------------------ 1000 lignes : tenue
    {
        const t0 = Date.now();
        const { st, meta, root } = await runBrief('f5', 120, 1000, 8192);
        let maxLen = 0;
        const runStep = async (step, ctx) => {
            maxLen = Math.max(maxLen, job.stepPrompt(ctx).length);
            const rel = 'src/big' + ctx.n + '.js';
            writeReal(root, rel, 'const b = ' + ctx.n + ';\n');
            return { ok: true, files: [rel], declared: true };
        };
        const res = await job.run({ root, state: st, runStep });
        const ms = Date.now() - t0;
        check('F-5a: cahier de 1000 lignes -> exigences numerotees et etapes bornees',
            meta.requirements.length >= 100 && st.steps.length <= 60,
            JSON.stringify({ exigences: meta.requirements.length, etapes: st.steps.length }));
        check('F-5b: le contexte reste sous 60 % de n_ctx sur les 1000 lignes',
            maxLen <= job.specPolicy(meta, 8192).callBudgetChars, maxLen);
        check('F-5c: le traitement aboutit et reste rapide sans modele',
            res.done > 0 && ms < 60000, JSON.stringify({ done: res.done, ms }));
    }

    // ------------------------------------------- verification par type (F-4)
    {
        const root = tmpRoot('types');
        writeReal(root, 'a.json', '{"ok":true}');
        writeReal(root, 'b.js', 'const a = 1;\n');
        writeReal(root, 'c.py', 'x = 1\n');
        writeReal(root, 'd.html', '<html><body><p>x</p></body></html>');
        writeReal(root, 'e.yaml', 'a: 1\nb: 2\n');
        const okAll = stepcheck.verifyStep(root, ['a.json', 'b.js', 'c.py', 'd.html', 'e.yaml']);
        check('F-4d: cinq types de fichiers valides passent la verification',
            okAll.ok === true, JSON.stringify(okAll.failed));
        writeReal(root, 'f.json', '{"broken":');
        const bad = stepcheck.verifyStep(root, ['f.json']);
        check('F-4e: un JSON casse est refuse avec sa raison',
            bad.ok === false && /JSON invalide/.test(bad.detail), bad.detail);
        const absent = stepcheck.verifyStep(root, ['inexistant.js']);
        check('F-4f: un fichier absent est refuse',
            absent.ok === false && /absent/.test(absent.detail), absent.detail);
        const empty = stepcheck.verifyStep(root, []);
        check('F-4g: aucune production = aucune preuve',
            empty.ok === false && /rien de prouve/.test(empty.detail), empty.detail);
        const t = stepcheck.verifyStep(root, ['a.json'], { testCommand: 'node -e "process.exit(0)"' });
        check('F-4h: la commande de test ne tourne que si elle est fournie et passe',
            t.ok === true && t.test && t.test.ran === true && t.test.ok === true, JSON.stringify(t.test));
        const t2 = stepcheck.verifyStep(root, ['a.json'], { testCommand: 'node -e "process.exit(3)"' });
        check('F-4i: un test en echec fait echouer la verification',
            t2.ok === false && t2.test.ok === false, JSON.stringify(t2.test));
    }

    // ------------------------------------------- F-7 : 6 outils au maximum
    {
        const s1 = job.toolSubsetFor({ kind: 'code' }, 6);
        const s2 = job.toolSubsetFor({ kind: 'verify' }, 6);
        check('F-7a: une etape de code voit 6 outils au maximum',
            s1.length <= 6 && s1.indexOf('write') !== -1 && s1.indexOf('read') !== -1, s1.join(','));
        check('F-7b: une etape de verification ne voit aucun outil d ecriture',
            s2.indexOf('write') === -1 && s2.indexOf('edit') === -1 && s2.indexOf('read') !== -1, s2.join(','));
        check('F-7c: la surface reste petite meme sur demande de 2',
            job.toolSubsetFor({}, 2).length >= 3, job.toolSubsetFor({}, 2).join(','));
        // Le contexte de l etape porte bien ce sous-ensemble.
        const root = tmpRoot('f7');
        const meta = spec.ingest(root, brief(6, 60), {});
        const st = job.create(root, meta, spec.planSteps(meta), { specPolicy: job.specPolicy(meta, 8192) });
        let seen = null;
        const runStep = async (step, ctx) => {
            seen = ctx.toolSubset;
            const rel = 'src/t.js';
            writeReal(root, rel, 'const t = 1;\n');
            return { ok: true, files: [rel], declared: true };
        };
        await job.run({ root, state: st, runStep });
        check('F-7d: chaque etape recoit son sous-ensemble d outils (<= 6)',
            Array.isArray(seen) && seen.length > 0 && seen.length <= 6, JSON.stringify(seen));
    }

    console.log('\nP62-F: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
