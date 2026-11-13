/**
 * keepAwake.js - P62-B3 : empecher la mise en veille pendant un run.
 *
 * Pourquoi ici et pas dans l'extension : les sondes de sante et ce verrou
 * vivent dans le BACKEND, un processus separe. Une fenetre masquee ou une page
 * ralentie par le navigateur ne peut donc pas suspendre la surveillance.
 *
 * Moyens utilises, par plateforme (aucun privilege demande) :
 *   - Windows : un processus PowerShell qui appelle SetThreadExecutionState
 *     (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) et se rearme ; il tient tant qu'il
 *     vit, et meurt avec le backend.
 *   - Linux : `systemd-inhibit --what=sleep:idle ... sleep` si disponible,
 *     sinon rien (on le dit, on ne fait pas semblant).
 *   - macOS : `caffeinate -i`.
 *
 * Tout est injectable (spawnFn, now, log) pour les tests. Ne jette jamais.
 * ASCII only.
 */
'use strict';

const { spawn } = require('child_process');

const WINDOWS_SCRIPT = [
  '$sig = @"',
  '[DllImport("kernel32.dll")]',
  'public static extern uint SetThreadExecutionState(uint esFlags);',
  '"@',
  '$t = Add-Type -MemberDefinition $sig -Name P62Power -Namespace Sudo -PassThru',
  '# ES_CONTINUOUS=0x80000000 | ES_SYSTEM_REQUIRED=0x00000001',
  'while ($true) { [void]$t::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 30 }',
].join('\n');

function planFor(platform) {
  const p = String(platform || process.platform);
  if (p === 'win32') {
    return {
      supported: true,
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SCRIPT],
      what: 'SetThreadExecutionState (veille systeme empechee)',
    };
  }
  if (p === 'linux') {
    return {
      supported: true,
      command: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--why=Sudo Studio : un tour agent est en cours', '--mode=block', 'sleep', 'infinity'],
      what: 'systemd-inhibit (sleep:idle bloques)',
      fallback: 'systemd-inhibit absent : la veille n est pas empechee, seul le reveil est detecte',
    };
  }
  if (p === 'darwin') {
    return { supported: true, command: 'caffeinate', args: ['-i'], what: 'caffeinate -i' };
  }
  return { supported: false, what: 'plateforme inconnue : veille non empechee' };
}

function createKeepAwake(opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || spawn;
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});
  const platform = o.platform || process.platform;
  let child = null;
  let since = 0;
  let reason = '';
  let unavailable = '';

  function status() {
    return {
      active: !!child,
      since: since ? new Date(since).toISOString() : null,
      seconds: since ? Math.round((now() - since) / 1000) : 0,
      reason,
      mechanism: planFor(platform).what,
      unavailable: unavailable || null,
    };
  }

  function start(why) {
    if (child) { reason = String(why || reason); return status(); }
    const plan = planFor(platform);
    if (!plan.supported) {
      unavailable = plan.what;
      log('warn', 'veille : mecanisme indisponible', { what: plan.what });
      return status();
    }
    try {
      child = spawnFn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true, detached: false });
      child.on('error', (e) => {
        unavailable = plan.fallback || String((e && e.message) || e);
        child = null;
        log('warn', 'veille : verrou non pris', { command: plan.command, why: unavailable });
      });
      child.on('exit', () => { child = null; });
      since = now();
      reason = String(why || 'tour agent en cours').slice(0, 200);
      log('info', 'veille empechee pendant le tour', { mechanism: plan.what, reason });
    } catch (e) {
      child = null;
      unavailable = String((e && e.message) || e);
      log('warn', 'veille : verrou non pris', { why: unavailable });
    }
    return status();
  }

  function stop(why) {
    if (!child) { since = 0; reason = ''; return status(); }
    const c = child;
    child = null;
    try { if (typeof c.kill === 'function') c.kill(); } catch (_) {}
    const held = since ? Math.round((now() - since) / 1000) : 0;
    since = 0;
    reason = '';
    log('info', 'veille de nouveau possible', { heldSeconds: held, why: String(why || 'fin du tour').slice(0, 120) });
    return status();
  }

  return { start, stop, status, platform, _plan: () => planFor(platform) };
}

module.exports = { createKeepAwake, planFor, WINDOWS_SCRIPT };
