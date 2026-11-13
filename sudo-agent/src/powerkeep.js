/**
 * powerkeep.js - P62-B3 cote AGENT : le tour empeche la veille et DETECTE les
 * veilles qui arrivent quand meme (ecran verrouille, capot ferme, machine gelee).
 *
 * Deux horloges suffisent, sans API systeme :
 *   Date.now()  avance pendant que la machine dort ;
 *   hrtime      n avance pas (ou beaucoup moins) pendant la veille.
 * Un ecart >= seuil EST une veille : on le journalise, avec sa duree.
 *
 * Le verrou est un processus separe qui vit TANT QUE le tour vit et meurt avec
 * lui : Windows = SetThreadExecutionState, Linux = systemd-inhibit, macOS =
 * caffeinate. Si le mecanisme manque, on le DIT (jamais de faux succes).
 *
 * Ne jette jamais. ASCII only.
 */
'use strict';

const { spawn } = require('child_process');

const WINDOWS_SCRIPT = [
  '$sig = @"',
  '[DllImport("kernel32.dll")]',
  'public static extern uint SetThreadExecutionState(uint esFlags);',
  '"@',
  '$t = Add-Type -MemberDefinition $sig -Name P62Keep -Namespace Sudo -PassThru',
  'while ($true) { [void]$t::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 30 }',
].join('\n');

function planFor(platform) {
  const p = String(platform || process.platform);
  if (p === 'win32') return { supported: true, cmd: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SCRIPT],
    what: 'SetThreadExecutionState' };
  if (p === 'linux') return { supported: true, cmd: 'systemd-inhibit',
    args: ['--what=sleep:idle', '--why=Sudo Studio : tour agent en cours', '--mode=block', 'sleep', 'infinity'],
    what: 'systemd-inhibit' };
  if (p === 'darwin') return { supported: true, cmd: 'caffeinate', args: ['-i'], what: 'caffeinate' };
  return { supported: false, what: 'plateforme inconnue' };
}

function monoMs() {
  try { return Number(process.hrtime.bigint() / 1000000n); } catch (_) { return Date.now(); }
}

function createPowerKeep(opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || spawn;
  const now = o.now || (() => Date.now());
  const mono = o.mono || monoMs;
  const log = o.log || (() => {});
  const platform = o.platform || process.platform;
  const thresholdMs = Number(o.thresholdMs) > 0 ? Number(o.thresholdMs) : 5000;

  let child = null;
  let since = 0;
  let wall = now();
  let monoPrev = mono();
  const veilles = [];

  function start(reason) {
    if (child) return status();
    const plan = planFor(platform);
    if (plan.supported) {
      try {
        child = spawnFn(plan.cmd, plan.args, { stdio: 'ignore', windowsHide: true });
        child.on('error', () => { child = null; log('warn', 'veille : verrou non pris (mecanisme absent)', { what: plan.what }); });
        child.on('exit', () => { child = null; });
      } catch (e) {
        child = null;
        log('warn', 'veille : verrou non pris', { why: String((e && e.message) || e) });
      }
    } else {
      log('warn', 'veille : aucun mecanisme sur cette plateforme', { platform });
    }
    since = now();
    log('info', 'tour protege contre la veille', { raison: String(reason || '').slice(0, 120), mecanisme: plan.what });
    return status();
  }

  function stop(reason) {
    const held = since ? Math.round((now() - since) / 1000) : 0;
    if (child) { try { child.kill(); } catch (_) {} }
    child = null;
    since = 0;
    log('info', 'veille de nouveau possible', { tenuSecondes: held, raison: String(reason || 'fin du tour').slice(0, 120) });
    return status();
  }

  // A appeler regulierement (ou juste avant/apres un appel modele) : rend
  // { suspended, driftMs } et journalise toute veille avec sa duree.
  function tick() {
    const w = now();
    const m = mono();
    const drift = (w - wall) - (m - monoPrev);
    wall = w;
    monoPrev = m;
    if (drift < thresholdMs) return { suspended: false, driftMs: Math.round(drift) };
    const ev = { at: new Date(w).toISOString(), dureeMs: Math.round(drift), dureeSec: Math.round(drift / 1000) };
    veilles.push(ev);
    if (veilles.length > 20) veilles.shift();
    log('warn', 'veille detectee pendant le tour', ev);
    return { suspended: true, driftMs: ev.dureeMs, seconds: ev.dureeSec };
  }

  function status() {
    return {
      actif: !!child,
      mecanisme: planFor(platform).what,
      tenuSecondes: since ? Math.round((now() - since) / 1000) : 0,
      veilles: veilles.slice(-5),
    };
  }

  return { start, stop, tick, status, _setLast: (w, m) => { wall = w; monoPrev = m; } };
}

module.exports = { createPowerKeep, planFor, monoMs, WINDOWS_SCRIPT };
