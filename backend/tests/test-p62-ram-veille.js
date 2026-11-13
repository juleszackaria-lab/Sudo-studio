/**
 * SUDO STUDIO - P62-B3 / C : veille et RAM faible.
 *
 * Prouve, sans dependre du PC de l'utilisateur :
 *   B3  le verrou anti-veille demarre et s'arrete avec le tour, et il est
 *       pris par le BACKEND (processus separe), pas par une page ;
 *   B3  une veille est DETECTEE par l'ecart horloge murale / horloge monotone,
 *       journalisee, suivie d'une sonde du runtime et d'une relance si besoin ;
 *   C1  le profil (n_ctx / n_threads / n_batch) est choisi selon la RAM libre
 *       reelle, avec un message en francais qui dit POURQUOI ;
 *   C2  RAM insuffisante -> avertissement clair + liste de modeles, jamais de
 *       plantage silencieux ;
 *   C3  sous pression pendant un run -> contexte reduit pour l'appel suivant,
 *       avec un message, sans tuer le runtime.
 *
 * ASCII only. Lancer : node backend/tests/test-p62-ram-veille.js
 */
'use strict';

const path = require('path');
const keep = require(path.join(__dirname, '..', 'supervisor', 'keepAwake'));
const susp = require(path.join(__dirname, '..', 'supervisor', 'suspendWatch'));
const ram = require(path.join(__dirname, '..', 'supervisor', 'ramProfile'));

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

// Faux processus enfant : compte les demarrages et les arrets.
function fakeSpawner() {
    const seen = [];
    const fn = (cmd, args) => {
        const rec = { cmd, args, killed: false, handlers: {} };
        seen.push(rec);
        return {
            on: (ev, h) => { rec.handlers[ev] = h; },
            kill: () => { rec.killed = true; if (rec.handlers.exit) rec.handlers.exit(0); },
            pid: 4242,
        };
    };
    return { fn, seen };
}

async function main() {
    // ------------------------------------------------------------- B3 verrou
    {
        const sp = fakeSpawner();
        const logs = [];
        const ka = keep.createKeepAwake({
            platform: 'win32', spawnFn: sp.fn,
            log: (lvl, msg, f) => logs.push(lvl + ' ' + msg + ' ' + JSON.stringify(f || {})),
            now: (() => { let t = 1000; return () => (t += 500); })(),
        });
        check('B3-a: aucun verrou avant le tour', ka.status().active === false);
        const st = ka.start('tour agent req-1');
        check('B3-b: le tour prend le verrou anti-veille', st.active === true && sp.seen.length === 1, JSON.stringify(st));
        check('B3-c: le mecanisme Windows est SetThreadExecutionState (pas une page webview)',
            st.mechanism.indexOf('SetThreadExecutionState') !== -1 && sp.seen[0].cmd === 'powershell',
            sp.seen[0] && sp.seen[0].cmd);
        const st2 = ka.stop('fin du tour');
        check('B3-d: le verrou est rendu a la fin du tour',
            st2.active === false && sp.seen[0].killed === true, JSON.stringify(st2));
        check('B3-e: la prise et la fin sont journalisees',
            logs.some((l) => /verrou|veille empechee/.test(l)) && logs.some((l) => /veille de nouveau possible/.test(l)),
            logs.join(' | ').slice(0, 200));
    }
    {
        const ka = keep.createKeepAwake({ platform: 'linux', spawnFn: () => { throw new Error('absent'); }, log: () => {} });
        const st = ka.start('tour');
        check('B3-f: mecanisme indisponible -> le statut le DIT, pas de silence',
            st.active === false && st.unavailable && /absent/.test(st.unavailable), JSON.stringify(st));
        const plan = keep.planFor('linux');
        check('B3-g: sous Linux le verrou est systemd-inhibit (sleep:idle)',
            plan.command === 'systemd-inhibit' && plan.args.join(' ').indexOf('sleep:idle') !== -1, plan.args.join(' '));
    }

    // -------------------------------------------------- B3 detection veille
    {
        let w = 1000000;
        let m = 500000;
        const logs = [];
        let probes = 0;
        let restarts = 0;
        const sw = susp.createSuspendWatch({
            now: () => w, mono: () => m,
            thresholdMs: 5000,
            probe: async () => { probes += 1; return { ok: false, code: 'runtime_offline', error: 'ECONNREFUSED' }; },
            restart: async () => { restarts += 1; return { ok: true, detail: 'relance demandee' }; },
            log: (lvl, msg, f) => logs.push(lvl + ' ' + msg + ' ' + JSON.stringify(f || {})),
        });
        // 15 s normales : l'horloge murale et la monotone avancent ensemble.
        w += 15000; m += 15000;
        const normal = await sw.tick();
        check('B3-h: 15 s normales ne declenchent rien', normal.suspended === false, JSON.stringify(normal));
        // Veille de 30 minutes : la murale saute, la monotone non.
        w += 1800000; m += 50;
        const slept = await sw.tick();
        check('B3-i: une veille de 30 min est detectee par les deux horloges',
            slept.suspended === true && slept.driftMs > 1700000, JSON.stringify(slept));
        check('B3-j: au reveil le runtime est sonde IMMEDIATEMENT', probes === 1, 'sondes=' + probes);
        check('B3-k: runtime muet au reveil -> une relance superviseur est demandee', restarts === 1, 'relances=' + restarts);
        check('B3-l: veille, reveil et relance sont journalises',
            logs.some((l) => /veille detectee/.test(l)) && logs.some((l) => /etat apres veille/.test(l)) &&
            logs.some((l) => /relance/.test(l)), logs.join(' | ').slice(0, 240));
        check('B3-m: l evenement porte la duree de la veille',
            (sw.status().events || []).some((e) => e.kind === 'veille' && e.dureeSec >= 1700),
            JSON.stringify(sw.status().events.slice(0, 2)));
    }
    {
        // Veille pendant laquelle le runtime va bien : aucune relance inutile.
        let w = 5; let m = 5; let restarts = 0;
        const sw = susp.createSuspendWatch({
            now: () => w, mono: () => m, thresholdMs: 3000,
            probe: async () => ({ ok: true }), restart: async () => { restarts += 1; return { ok: true }; },
            log: () => {},
        });
        w += 600000; m += 10;
        const r = await sw.tick();
        check('B3-n: runtime sain au reveil -> aucune relance inutile',
            r.suspended === true && r.runtimeOk === true && restarts === 0, JSON.stringify(r));
    }

    // ------------------------------------------------------------ C1 profil
    {
        // Machine serree mais utilisable : 1,4 Go libres, petit modele 0,5B.
        const low = ram.decide({ freeMB: 1400, totalMB: 8052, modelMB: 400, cpus: 4 });
        check('C1-a: avec 1,4 Go libres, le contexte est reduit (8192 -> 2048)',
            low.nCtx === 2048 && low.ok === true, JSON.stringify(low).slice(0, 200));
        check('C1-b: le choix est explique en francais avec les chiffres reels',
            /contexte 2048/.test(low.message) && low.message.indexOf('1400') !== -1 && /RAM libre/.test(low.message),
            low.message.slice(0, 200));
        const floor = ram.decide({ freeMB: 1100, totalMB: 8052, modelMB: 400, cpus: 4 });
        check('C1-h: a 1,1 Go libres on descend jusqu au plancher (512)',
            floor.nCtx === 512 && floor.ok === true, JSON.stringify({ nCtx: floor.nCtx, need: floor.neededMB, budget: floor.budgetMB }));
        // Chiffres exacts de la video de test : 427 Mo libres.
        const video = ram.decide({ freeMB: 427, totalMB: 8052, modelMB: 1100, cpus: 4 });
        check('C1-g: chiffres de la video (427 Mo libres) -> refus net et explique, aucun plantage',
            video.ok === false && video.fits === false && /RAM libre insuffisante/.test(video.message),
            video.message.slice(0, 180));
        const mid = ram.decide({ freeMB: 3000, totalMB: 8052, modelMB: 1100, cpus: 4 });
        check('C1-c: avec 3 Go libres, le contexte monte (4096)',
            mid.nCtx === 4096, JSON.stringify({ nCtx: mid.nCtx, free: mid.freeMB }));
        const big = ram.decide({ freeMB: 12000, totalMB: 16384, modelMB: 1100, cpus: 8 });
        check('C1-d: avec 12 Go libres, le contexte complet (8192) et plus de fils',
            big.nCtx === 8192 && big.nThreads > 4 && big.nBatch === 512, JSON.stringify(big).slice(0, 220));
        check('C1-e: n_batch baisse quand la RAM est serree',
            low.nBatch === 128 && big.nBatch === 512, low.nBatch + '/' + big.nBatch);
        check('C1-f: jamais plus de 70 % de la RAM libre engagee',
            ram.estimateMB(400, low.nCtx) <= Math.floor(1400 * ram.SAFE_SHARE),
            ram.estimateMB(400, low.nCtx) + ' Mo pour un budget de ' + Math.floor(1400 * ram.SAFE_SHARE));
    }

    // --------------------------------------------------- C2 RAM insuffisante
    {
        const none = ram.decide({ freeMB: 300, totalMB: 8052, modelMB: 4700, cpus: 4 });
        check('C2-a: RAM insuffisante -> ok=false et AUCUN contexte choisi',
            none.ok === false && none.nCtx === null && none.fits === false, JSON.stringify(none).slice(0, 200));
        check('C2-b: le message dit quoi faire (fermer des applications / modele plus leger)',
            /RAM libre insuffisante/.test(none.message) && /Ferme d autres applications/.test(none.message),
            none.message.slice(0, 200));
        const cat = ram.catalogFor(3000);
        check('C2-c: le catalogue indique quels modeles tiennent reellement',
            Array.isArray(cat) && cat.some((m) => m.fits === false) && cat.some((m) => m.fits === true),
            JSON.stringify(cat.map((m) => m.id + '=' + m.fits)));
        check('C2-d: chaque entree du catalogue porte sa RAM requise en Mo',
            cat.every((m) => typeof m.ramMB === 'number' && m.ramMB > 0), JSON.stringify(cat[0]));
    }

    // ------------------------------------------------------ C3 sous pression
    {
        const p = ram.underPressure(4096, 300);
        check('C3-a: sous 800 Mo libres, le contexte du prochain appel est divise',
            p.changed === true && p.nCtx === 2048, JSON.stringify(p));
        check('C3-b: la decision est annoncee (jamais silencieuse)',
            /RAM libre faible/.test(p.message) && /2048/.test(p.message), p.message.slice(0, 160));
        const calm = ram.underPressure(4096, 2600);
        check('C3-c: RAM correcte -> aucun changement', calm.changed === false && calm.nCtx === 4096);
        const floor = ram.underPressure(1024, 200);
        check('C3-d: le contexte ne descend jamais sous 512 jetons',
            floor.nCtx === 512, JSON.stringify(floor));
    }

    // -------------------------------- B3 cote AGENT (sudo-agent/powerkeep)
    {
        const pk = require(path.join(__dirname, '..', '..', 'sudo-agent', 'src', 'powerkeep'));
        let w = 2000;
        let m = 9000;
        const evts = [];
        const keep = pk.createPowerKeep({
            platform: 'win32',
            spawnFn: () => ({ on: () => {}, kill: () => { } }),
            now: () => w, mono: () => m,
            log: (lvl, msg) => evts.push(lvl + ' ' + msg),
        });
        check('B3-o: le tour agent prend le verrou anti-veille',
            keep.start('tour s1').actif === true, JSON.stringify(keep.status()));
        w += 20000; m += 20000;
        check('B3-p: 20 s normales ne declenchent aucune alerte', keep.tick().suspended === false);
        w += 900000; m += 30;
        const t = keep.tick();
        check('B3-q: une veille de 15 min est detectee cote agent avec sa duree',
            t.suspended === true && t.seconds >= 890, JSON.stringify(t));
        check('B3-r: la veille est journalisee en francais',
            evts.some((e) => /veille detectee pendant le tour/.test(e)), evts.join(' | ').slice(0, 200));
        check('B3-s: le verrou est rendu a la fin du tour et la duree est notee',
            keep.stop('fin').actif === false && evts.some((e) => /veille de nouveau possible/.test(e)),
            evts.slice(-2).join(' | '));
        check('B3-t: le mecanisme Windows est nomme pour l utilisateur',
            pk.planFor('win32').what === 'SetThreadExecutionState' &&
            pk.planFor('linux').cmd === 'systemd-inhibit', JSON.stringify(pk.planFor('linux')));
    }

    console.log('\nP62-B3/C: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
