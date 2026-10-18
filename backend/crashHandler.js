/**
 * crashHandler.js - P30(c): readable crashes, never a silent exit 0.
 *
 * Registers uncaughtException + unhandledRejection handlers that write the
 * cause to the journal (unified logs dir + the local backend.log) AND to
 * STDOUT, then exit with code 1. All writes are synchronous so nothing is
 * lost before exit. Builtins only (fs, path, os): loads even when
 * node_modules is broken.
 * Test seam: setup({ exit: false, onFatal }) records instead of exiting.
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveUnifiedDir() {
  if (process.env.SUDO_STUDIO_LOGS) return process.env.SUDO_STUDIO_LOGS;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'SudoStudio', 'logs');
  }
  return path.join(os.homedir(), '.sudo_studio', 'logs');
}

function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (_) { /* journal best-effort, stdout still carries the cause */ }
}

function setup(opts) {
  opts = opts || {};
  const localLog = opts.localLog || null; // install-dir backend.log (may be null)
  const unifiedLog = opts.unifiedLog || path.join(resolveUnifiedDir(), 'backend.log');
  const exitCode = opts.exitCode || 1;
  const doExit = opts.exit !== false;
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null;
  const state = { inHandler: false };

  function fatal(kind, err) {
    if (state.inHandler) {
      if (doExit) { try { process.exit(exitCode); } catch (_) {} }
      return;
    }
    state.inHandler = true;
    const msg = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? err.stack : String(err);
    const ts = new Date().toISOString();
    const line1 = '[' + ts + '] FATAL ' + kind + ': ' + msg + '\n';
    const line2 = '[' + ts + '] STACK: ' + stack + '\n';
    try {
      if (localLog) appendLine(localLog, line1 + line2);
      appendLine(unifiedLog, line1 + line2);
    } catch (_) { /* ignore, stdout next */ }
    try { fs.writeSync(1, line1 + line2); } catch (_) { /* stdout broken, journal kept it */ }
    try { fs.writeSync(2, line1); } catch (_) { /* ignore */ }
    if (onFatal) { try { onFatal(kind, msg, stack); } catch (_) {} }
    if (doExit) { try { process.exit(exitCode); } catch (_) {} }
  }

  process.on('uncaughtException', (err) => {
    // EPIPE / ECONNRESET on pipes/sockets are harmless - suppress the flood,
    // keep the process alive (pre-existing behavior, pipes only).
    if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
      try {
        if (localLog) appendLine(localLog, '[' + new Date().toISOString() + '] ' + err.code + ' (suppressed)\n');
      } catch (_) {}
      return;
    }
    fatal('uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    fatal('unhandledRejection', reason);
  });

  return { unifiedLog };
}

module.exports = { setup, resolveUnifiedDir };
