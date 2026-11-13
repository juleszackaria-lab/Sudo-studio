/**
 * powerGuard.js - P62-B3/C : un seul point d'entree pour le backend.
 *
 * Assemble :
 *   - le verrou anti-veille (keepAwake) ;
 *   - la surveillance de veille (suspendWatch, horloge murale vs monotone) ;
 *   - le profil RAM (ramProfile) qui choisit n_ctx / n_threads / n_batch ;
 *   - le suivi de la derniere requete recue (pour la CAUSE des relances).
 *
 * Le backend appelle :
 *   const guard = createPowerGuard({ supervisor, log, tech, platform });
 *   guard.noteRequest()                                   // a chaque requete
 *   await guard.beginRun('tour agent')                    // debut de tour
 *   guard.endRun('fin de tour')                           // fin de tour
 *   guard.diag()                                          // -> { ramFreeMB, ... }
 *   guard.status()                                        // -> etat complet
 *
 * Aucune exception ne remonte : un PC sans systemd-inhibit ne doit pas casser
 * le backend. ASCII only.
 */
'use strict';

const keep = require('./keepAwake');
const susp = require('./suspendWatch');
const ram = require('./ramProfile');

function httpGet(url, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch (e) { resolve({ ok: false, error: 'url invalide' }); return; }
        const lib = u.protocol === 'https:' ? require('https') : require('http');
        const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: timeoutMs || 2500 },
            (res) => {
                res.resume();
                resolve({ ok: res.statusCode === 200, code: res.statusCode });
            });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => resolve({ ok: false, code: (e && e.code) || 'error', error: String((e && e.message) || e) }));
        req.end();
    });
}

function createPowerGuard(opts) {
    const o = opts || {};
    const log = typeof o.log === 'function' ? o.log : () => {};
    const tech = o.tech || null;
    const supervisor = o.supervisor || null;
    const now = o.now || (() => Date.now());
    const probeFn = typeof o.probe === 'function'
        ? o.probe
        : () => httpGet((o.runtimeUrl || 'http://127.0.0.1:6000') + '/health', 2500);

    let lastRequestAt = 0;
    let lastSuspend = null;
    let runningTurns = 0;
    let lastModelLoadMs = null;

    const power = keep.createKeepAwake({
        platform: o.platform,
        spawnFn: o.spawnFn,
        now,
        log: (lvl, msg, f) => {
            log(lvl, msg, f);
            if (tech) { try { (tech[lvl] || tech.info).call(tech, msg, f || {}); } catch (_) {} }
        },
    });

    const watch = susp.createSuspendWatch({
        now,
        mono: o.mono,
        thresholdMs: o.suspendThresholdMs || 5000,
        probe: probeFn,
        restart: async () => {
            if (!supervisor || typeof supervisor.maybeRestart !== 'function') {
                return { ok: false, skipped: true, detail: 'superviseur absent : relance manuelle necessaire' };
            }
            const r = await supervisor.maybeRestart('reveil apres veille (runtime muet)', { manual: true });
            const ok = !!(r && (r.action === 'restarted' || r.ok));
            return { ok, detail: JSON.stringify(r || {}).slice(0, 160) };
        },
        log: (lvl, msg, f) => {
            lastSuspend = Object.assign({ at: new Date(now()).toISOString() }, f || {});
            log(lvl, msg, f);
            if (tech) { try { (tech[lvl] || tech.info).call(tech, msg, f || {}); } catch (_) {} }
        },
    });

    function noteRequest(atMs) {
        lastRequestAt = Number(atMs) || now();
        if (supervisor && typeof supervisor.noteRequest === 'function') {
            try { supervisor.noteRequest(lastRequestAt); } catch (_) {}
        }
        return lastRequestAt;
    }

    // Profil RAM a appliquer au prochain chargement de modele.
    function profile(extra) {
        const e = extra || {};
        return ram.decide({
            freeMB: e.freeMB,
            totalMB: e.totalMB,
            modelMB: e.modelMB,
            cpus: e.cpus,
            platform: o.platform,
        });
    }

    function diag() {
        return {
            ramFreeMB: ram.freeRamMB(),
            ramTotalMB: ram.totalRamMB(),
            sinceLastRequestS: lastRequestAt ? Math.round((now() - lastRequestAt) / 1000) : null,
            veille: lastSuspend,
            modelLoadMs: lastModelLoadMs,
            toursEnCours: runningTurns,
        };
    }

    async function beginRun(reason) {
        runningTurns += 1;
        const st = power.start(reason || 'tour agent en cours');
        try { watch.start(o.suspendPollMs || 15000); } catch (_) {}
        log('info', 'tour demarre, veille empechee', { reason: String(reason || '').slice(0, 120) });
        return st;
    }

    function endRun(reason) {
        runningTurns = Math.max(0, runningTurns - 1);
        if (runningTurns === 0) {
            try { watch.stop(); } catch (_) {}
            return power.stop(reason || 'fin du tour');
        }
        return power.status();
    }

    // mmap=1, mlock=0 : le modele est mappe, jamais verrouille en RAM
    // (mlock sur 400 Mo libres = plantage). Le temps de chargement est mesure.
    function modelLoadOptions(extra) {
        const p = profile(extra);
        return {
            nCtx: p.nCtx,
            nThreads: p.nThreads,
            nBatch: p.nBatch,
            useMmap: true,
            useMlock: false,
            message: p.message,
            ok: p.ok,
        };
    }

    function noteModelLoaded(ms, extra) {
        lastModelLoadMs = Number(ms) > 0 ? Math.round(Number(ms)) : null;
        const f = Object.assign({ modelLoadMs: lastModelLoadMs, mmap: true, mlock: false }, extra || {});
        log('info', 'modele charge', f);
        if (tech) { try { tech.info('modele charge', f); } catch (_) {} }
        return lastModelLoadMs;
    }

    function status() {
        return Object.assign({
            veille: power.status(),
            surveillanceVeille: watch.status(),
            dernierChangementVeille: lastSuspend,
            ram: { libreMo: ram.freeRamMB(), totalMo: ram.totalRamMB() },
            profil: profile(),
            dernierChargementModeleMs: lastModelLoadMs,
            secondesDepuisDerniereRequete: lastRequestAt ? Math.round((now() - lastRequestAt) / 1000) : null,
            toursEnCours: runningTurns,
        }, {});
    }

    return {
        noteRequest, beginRun, endRun, diag, status, profile,
        modelLoadOptions, noteModelLoaded,
        tickSuspend: () => watch.tick(),
        _internals: { power, watch },
    };
}

module.exports = { createPowerGuard };
