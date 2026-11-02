// Sudo Agent tool pre-checks (P53-1/2/7).
// Before ANY control command (verify check, build/test), the driver proves
// the binary exists: 5 s cap (`--version`, then where/which), result cached
// per process and reused by the prompt ("Environment" panel data). A missing
// tool is a SKIPPED step with an install action -- never a 30 s wait, never a
// retry, never a reason to refuse the final answer.
// Stdlib only, ASCII only.
'use strict';

const { execFile } = require('child_process');
const msgs = require('./msgs');

const PROBE_TIMEOUT = 5000;      // P53-1: 5 s, then decision
const SNAPSHOT_TIMEOUT = 1800;   // turn-start snapshot: cheap, parallel
const SNAPSHOT_TTL = 60000;      // reuse the same snapshot for a minute

// Known binaries -> SDK Manager id (when one exists) + prose hint.
const TOOLS = {
  flutter: { sdk: 'flutter', hint: 'SDK Manager (flutter)' },
  dart: { sdk: 'flutter', hint: 'SDK Manager (flutter)' },
  python: { sdk: 'python', hint: 'SDK Manager (python)' },
  python3: { sdk: 'python', hint: 'SDK Manager (python)' },
  pip: { sdk: 'pip', hint: 'SDK Manager (pip)' },
  pip3: { sdk: 'pip', hint: 'SDK Manager (pip)' },
  docker: { sdk: 'docker', hint: 'SDK Manager (docker)' },
  node: { sdk: null, hint: 'AutoFix' },
  npm: { sdk: null, hint: 'AutoFix' },
  git: { sdk: null, hint: 'AutoFix' },
  go: { sdk: null, hint: 'AutoFix' },
  cargo: { sdk: null, hint: 'AutoFix' },
  rustc: { sdk: null, hint: 'AutoFix' },
  mvn: { sdk: null, hint: 'AutoFix' },
  dotnet: { sdk: null, hint: 'AutoFix' },
  make: { sdk: null, hint: 'AutoFix' },
  pytest: { sdk: 'python', hint: 'SDK Manager (python)' },
  gcc: { sdk: null, hint: 'AutoFix' },
};

// Binaries worth knowing at turn start (prompt awareness, P53-7).
const SNAPSHOT_BINS = ['node', 'npm', 'git', 'python', 'python3', 'pip', 'pip3',
  'docker', 'flutter', 'dart', 'go', 'cargo'];

const probes = new Map(); // bin -> { ok, version, at }

function nowMs() { return Date.now(); }

// Probe ONE binary. Never throws. Cached for the process lifetime unless
// opts.fresh is set (a tool can be installed mid-session by the user).
function probe(bin, opts) {
  opts = opts || {};
  const name = String(bin || '').trim();
  if (!name) return Promise.resolve({ ok: false, version: '', reason: 'empty' });
  const hit = probes.get(name);
  if (!opts.fresh && hit && (nowMs() - hit.at) < (opts.ttl || SNAPSHOT_TTL)) return Promise.resolve(hit);
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT;
  return new Promise((resolve) => {
    let settled = false;
    const win = (v) => {
      if (settled) return;
      settled = true;
      const rec = { ok: !!v.ok, version: v.version || '', at: nowMs() };
      probes.set(name, rec);
      resolve(rec);
    };
    let child = null;
    try {
      child = execFile(name, ['--version'], { timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          const out = String(stdout || '') + String(stderr || '');
          const first = out.trim().split('\n')[0].slice(0, 120);
          if (!err) { win({ ok: true, version: first }); return; }
          // ENOENT / 127-ish => really absent. Any other failure (non-zero
          // exit with output) still proves the binary exists and ran.
          if (err && (err.code === 'ENOENT' || /not found|introuvable/i.test(String(err.message || '')))) {
            win({ ok: false, version: '', reason: 'not_found' });
            return;
          }
          if (first) { win({ ok: true, version: first }); return; }
          win({ ok: false, version: '', reason: String(err.code || 'error') });
        });
    } catch (_) { win({ ok: false, version: '', reason: 'spawn' }); return; }
    const guard = setTimeout(() => {
      try { if (child) child.kill('SIGKILL'); } catch (_) {}
      win({ ok: false, version: '', reason: 'timeout' });
    }, timeoutMs + 400);
    if (guard && typeof guard.unref === 'function') guard.unref();
  });
}

// Leading binary of a shell command (env assignments skipped, quotes stripped).
function firstToken(command) {
  let s = String(command || '').trim();
  const envPrefix = s.match(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/);
  if (envPrefix) s = s.slice(envPrefix[0].length);
  const tok = (s.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
  if (!tok) return '';
  return tok.replace(/^.*[\\/]/, '').replace(/\.(exe|bat|cmd|ps1)$/i, '');
}

// Does this command need a known tool? Returns the TOOLS key or ''.
function toolOf(command) {
  const tok = firstToken(command);
  if (!tok) return '';
  if (TOOLS[tok]) return tok;
  return '';
}

function actionFor(tool) {
  const def = TOOLS[tool] || {};
  if (def.sdk) return { kind: 'sdk', id: def.sdk, hint: def.hint || 'SDK Manager' };
  return { kind: 'autofix', id: null, hint: def.hint || 'AutoFix' };
}

// P53-1: pre-check ONE control command. Returns
//   { ok:true, checked:false }                     -> unknown tool, run it
//   { ok:true, checked:true, tool, version }       -> present, run it
//   { ok:false, checked:true, tool, message, action } -> SKIP, never run
async function checkCommand(command, opts) {
  opts = opts || {};
  const lang = opts.lang === 'en' ? 'en' : 'fr';
  const tool = toolOf(command);
  if (!tool) return { ok: true, checked: false, tool: '' };
  const r = await probe(tool, { timeoutMs: opts.timeoutMs || PROBE_TIMEOUT, fresh: opts.fresh === true });
  if (r.ok) return { ok: true, checked: true, tool, version: r.version };
  const action = actionFor(tool);
  return {
    ok: false, checked: true, tool, action,
    message: msgs.t(lang).verifySkipped(tool),
    reason: 'tool_missing',
  };
}

// Test/ops hook: SUDO_AGENT_ENV_AVAILABLE="node,git" forces the snapshot
// (used by the deterministic suites; never set in production).
function overrideList() {
  const raw = process.env.SUDO_AGENT_ENV_AVAILABLE;
  if (!raw || typeof raw !== 'string') return null;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

let snapshot = null;
let snapshotAt = 0;

async function envSnapshot(opts) {
  opts = opts || {};
  if (!opts.fresh && snapshot && (nowMs() - snapshotAt) < SNAPSHOT_TTL) return snapshot;
  const forced = overrideList();
  if (forced) {
    const present = forced.slice();
    snapshot = {
      at: nowMs(), present, missing: SNAPSHOT_BINS.filter((b) => present.indexOf(b) === -1),
      source: 'override', versions: {},
    };
    snapshotAt = nowMs();
    return snapshot;
  }
  const results = await Promise.all(SNAPSHOT_BINS.map((b) => probe(b, { timeoutMs: SNAPSHOT_TIMEOUT })));
  const present = [];
  const missing = [];
  const versions = {};
  for (let i = 0; i < SNAPSHOT_BINS.length; i++) {
    const bin = SNAPSHOT_BINS[i];
    const r = results[i];
    if (r.ok) { present.push(bin); if (r.version) versions[bin] = r.version.slice(0, 60); }
    else missing.push(bin);
  }
  snapshot = { at: nowMs(), present, missing, versions, source: 'probe' };
  snapshotAt = nowMs();
  return snapshot;
}

function resetCache() { probes.clear(); snapshot = null; snapshotAt = 0; }

// P53-7: the prompt block that keeps the model from proposing absent tools.
// Deliberately COMPACT (2 short lines): it rides in every system prompt, and
// small local models live on a 2048-token budget.
function envPromptBlock(lang, snap, opts) {
  const s = snap && Array.isArray(snap.present) ? snap : snapshot;
  if (!s || (!s.present.length && !s.missing.length)) return '';
  const fr = lang !== 'en';
  // Terse profiles (small local models, ~2048-token budgets) get the
  // ACTIONABLE half only: what is absent, and what to do about it.
  if (opts && opts.compact) {
    const miss = s.missing.slice(0, 6).join(', ') || (fr ? 'aucun' : 'none');
    return fr
      ? 'ENV: ABSENTS = ' + miss + ' -> ne les utilise pas ; propose sdk (SDK Manager) ou AutoFix, avec permission.'
      : 'ENV: MISSING = ' + miss + ' -> never use them; suggest sdk (SDK Manager) or AutoFix, with permission.';
  }
  const present = s.present.slice(0, 6).join(', ') || (fr ? 'aucun' : 'none');
  const missing = s.missing.slice(0, 6).join(', ') || (fr ? 'aucun' : 'none');
  if (fr) {
    return 'ENV (verifie) : ABSENTS = ' + missing + ' (ne les propose pas : propose l\'installation via ' +
      'SDK Manager / outil sdk ou AutoFix, avec permission). Dispo = ' + present + '.';
  }
  return 'ENV (checked): MISSING = ' + missing + ' (do not use them: suggest installing via ' +
    'SDK Manager / sdk tool or AutoFix, with permission). Available = ' + present + '.';
}

module.exports = { TOOLS, SNAPSHOT_BINS, PROBE_TIMEOUT, probe, firstToken, toolOf, checkCommand,
  envSnapshot, envPromptBlock, resetCache, actionFor };
