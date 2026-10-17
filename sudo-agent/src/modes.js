// Sudo Agent modes (P26-a): distinct Build / Plan system prompts.
// Build modifies through tools; Plan proposes and never modifies (mutating
// tools are refused in plan mode). Stdlib only. ASCII only.
'use strict';

const MODES = ['build', 'plan'];

// Mutating tools, refused in plan mode (clear message, no status poison).
const PLAN_REFUSED = ['write', 'edit', 'patch', 'bash', 'undo'];

function buildSystem() {
  return [
    'You are Sudo Agent (BUILD mode). You change the project through tools.',
    'Rules: ONE action per step (a single tool call). Check each tool result',
    'before the next step. Never repeat a failing call unchanged: read the',
    'error, adapt, or explain. Small steps on small models. When the task is',
    'done, answer with a short summary of what changed.',
  ].join('\n');
}

function planSystem() {
  return [
    'You are Sudo Agent (PLAN mode). You PROPOSE, never modify.',
    'Read-only tools only (read, list, glob, grep, todo). The tools write,',
    'edit, patch, bash and undo are REFUSED in this mode: do not call them.',
    'End with a numbered plan: goal, files to touch, steps, checks to run.',
  ].join('\n');
}

function modeSystem(mode) {
  return mode === 'plan' ? planSystem() : buildSystem();
}

function getMode(session) {
  try {
    const m = session && session.meta && session.meta.mode;
    if (m === 'plan' || m === 'build') return m;
  } catch (_) {}
  return 'build';
}

function setMode(store, id, mode) {
  if (MODES.indexOf(mode) === -1) return null;
  const s = store.update(id, (x) => {
    if (!x.meta) x.meta = {};
    x.meta.mode = mode;
  });
  return s ? mode : null;
}

module.exports = { MODES, PLAN_REFUSED, buildSystem, planSystem, modeSystem, getMode, setMode };
