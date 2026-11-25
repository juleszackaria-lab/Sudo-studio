'use strict';
/**
 * P70-A1 : chronometrage par tour. Un seul endroit, des noms fixes, et une
 * ligne de journal qui dit tout : modele, outils, checkpoint, git, total.
 * ASCII only.
 */
function start() {
  const t0 = process.hrtime.bigint();
  const phases = {};
  return {
    mark(name) {
      phases[name] = Number(process.hrtime.bigint() - t0) / 1e6;
      return this;
    },
    add(name, ms) {
      phases[name] = (phases[name] || 0) + (Number(ms) || 0);
      return this;
    },
    finish() {
      const total = Number(process.hrtime.bigint() - t0) / 1e6;
      const out = {
        model_ms: Math.round((phases.model || 0) * 10) / 10,
        tools_ms: Math.round((phases.tools || 0) * 10) / 10,
        checkpoint_ms: Math.round((phases.checkpoint || 0) * 10) / 10,
        git_ms: Math.round((phases.git || 0) * 10) / 10,
        resolve_ms: Math.round((phases.resolve || 0) * 10) / 10,
        total_ms: Math.round(total * 10) / 10,
      };
      return out;
    },
  };
}

function line(t) {
  if (!t) return '';
  return 'tour | temps total=' + t.total_ms + 'ms modele=' + t.model_ms + 'ms outils=' +
    t.tools_ms + 'ms checkpoint=' + t.checkpoint_ms + 'ms git=' + t.git_ms + 'ms';
}

module.exports = { start, line };
