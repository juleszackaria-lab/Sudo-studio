/**
 * suspendWatch.js - P62-B3 : detecter une VEILLE / un gel de la machine.
 *
 * Principe, sans API systeme : on compare deux horloges.
 *   - l'horloge MURALE (Date.now) s'arrete-t-elle pendant que la machine dort ?
 *     Non : au reveil elle a saute d'un coup.
 *   - l'horloge MONOTONE (process.hrtime) ne bouge pas pendant la veille.
 * Un ecart durable entre les deux (>= thresholdMs) EST une veille (ou un gel).
 *
 * A chaque reveil detecte :
 *   1. on journalise l'evenement avec l'heure et la duree ;
 *   2. on sonde immediatement l'etat du runtime ;
 *   3. s'il ne repond pas, on demande au superviseur de le relancer.
 *
 * Tout est injectable (now, mono, probe, restart, log) : les tests simulent
 * une veille de 30 minutes en une milliseconde. Ne jette jamais. ASCII only.
 */
'use strict';

function monoMs() {
  try { return Number(process.hrtime.bigint() / 1000000n); } catch (_) { return Date.now(); }
}

function createSuspendWatch(opts) {
  const o = opts || {};
  const wall = o.now || (() => Date.now());
  const mono = o.mono || monoMs;
  const probe = typeof o.probe === 'function' ? o.probe : async () => ({ ok: true });
  const restart = typeof o.restart === 'function' ? o.restart : async () => ({ ok: false, skipped: true });
  const log = o.log || (() => {});
  const thresholdMs = Number(o.thresholdMs) > 0 ? Number(o.thresholdMs) : 5000;

  let lastWall = wall();
  let lastMono = mono();
  let timer = null;
  const events = [];

  function record(kind, extra) {
    const ev = Object.assign({ at: new Date(wall()).toISOString(), kind }, extra || {});
    events.push(ev);
    if (events.length > 50) events.shift();
    log(kind === 'veille' ? 'warn' : 'info', kind === 'veille' ? 'veille detectee' : 'etat apres veille', ev);
    return ev;
  }

  // Une passe de detection. Rend { suspended, gapMs, detail }.
  async function tick() {
    const w = wall();
    const m = mono();
    const gapWall = w - lastWall;
    const gapMono = m - lastMono;
    lastWall = w;
    lastMono = m;
    const drift = gapWall - gapMono;
    if (drift < thresholdMs) return { suspended: false, driftMs: Math.round(drift) };

    const ev = record('veille', { dureeMs: Math.round(drift), dureeSec: Math.round(drift / 1000) });
    let p = null;
    try { p = await probe(); } catch (e) { p = { ok: false, code: 'probe_error', error: String((e && e.message) || e) }; }
    record('reveil', { runtimeOk: !!(p && p.ok), code: (p && p.code) || null, dureeMs: ev.dureeMs });
    if (!p || !p.ok) {
      let r = null;
      try { r = await restart(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      record('relance', { demandee: !!(r && r.ok), detail: String((r && (r.detail || r.error)) || '') .slice(0, 160) });
    }
    return { suspended: true, driftMs: Math.round(drift), runtimeOk: !!(p && p.ok) };
  }

  function start(intervalMs) {
    if (timer) return status();
    const iv = Number(intervalMs) > 0 ? Number(intervalMs) : 15000;
    timer = setInterval(() => { tick().catch(() => {}); }, iv);
    if (timer.unref) { try { timer.unref(); } catch (_) {} }
    log('info', 'surveillance veille active', { intervalMs: iv, thresholdMs });
    return status();
  }

  function stop() {
    if (timer) { try { clearInterval(timer); } catch (_) {} }
    timer = null;
    return status();
  }

  function status() {
    return { watching: !!timer, thresholdMs, events: events.slice(-10) };
  }

  return { start, stop, tick, status, _setLast: (w, m) => { lastWall = w; lastMono = m; } };
}

module.exports = { createSuspendWatch, monoMs };
