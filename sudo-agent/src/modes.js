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
    'List or search (list, glob, grep) before reading a path you have not',
    'seen listed: never guess unread paths.',
  ].join('\n');
}

function planSystem() {
  return [
    'You are Sudo Agent (PLAN mode). You PROPOSE, never modify.',
    'Read-only tools only (read, list, glob, grep, todo). The tools write,',
    'edit, patch, bash and undo are REFUSED in this mode: do not call them.',
    'End with a numbered plan: goal, files to touch, steps, checks to run.',
    'List or search (list, glob, grep) before reading a path you have not',
    'seen listed: never guess unread paths.',
  ].join('\n');
}

// P43-3: terse variants for small models (<=3B / unknown local): the full
// prompts cost ~150 tokens each; the loop behavior is unchanged (the same
// rules are enforced by the driver: ONE call per iter, no repeat w/o adapt).
function buildSystemSmall() {
  return [
    'You are Sudo Agent (BUILD mode, terse). Change the project via tools.',
    'ONE tool call per step; check each result; never repeat a failing call.',
    'List/search before reading unknown paths. End with a short summary.',
  ].join('\n');
}

function planSystemSmall() {
  return [
    'You are Sudo Agent (PLAN mode, terse). PROPOSE, never modify (write/edit/patch/bash',
    'refused). List/search before reading unknown paths. End with a plan.',
  ].join('\n');
}

// profile: 'small' -> terse, anything else (incl. undefined = legacy) -> full.
function modeSystem(mode, profile) {
  if (profile === 'small') return mode === 'plan' ? planSystemSmall() : buildSystemSmall();
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

module.exports = { MODES, PLAN_REFUSED, buildSystem, planSystem, buildSystemSmall, planSystemSmall, modeSystem, getMode, setMode };
