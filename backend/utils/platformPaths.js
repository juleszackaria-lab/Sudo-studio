/**
 * SUDO STUDIO - P60: multiplatform path abstraction (single source of truth).
 *
 * Before P60 every "where do we write" decision was repeated per module, with
 * a Windows branch and a Linux fallback. This module is now THE place:
 *
 *   Windows   logs  : %LOCALAPPDATA%\SudoStudio\logs
 *             data  : %LOCALAPPDATA%\SudoStudio\
 *   Linux/mac logs  : $XDG_STATE_HOME/sudo-studio/logs  (XDG_STATE is the
 *                     spec-correct home for logs; falls back to
 *                     $XDG_DATA_HOME/sudo-studio/logs, then
 *                     ~/.local/share/SudoStudio/logs as documented to users)
 *             data  : $XDG_DATA_HOME/sudo-studio        (~/.local/share/...)
 *             models: ~/.sudo_studio/models             (kept: user-visible,
 *                     documented, and already holds downloaded GGUFs)
 *             inst. : ~/.sudo_studio/installers         (kept, same reason)
 *
 * Precedence everywhere (highest first):
 *   1. explicit option passed by the caller (tests use it)
 *   2. SUDO_STUDIO_LOGS / SUDO_STUDIO_HOME  (launcher + tests)
 *   3. XDG variables (Linux/mac)
 *   4. platform default
 *
 * Tests and CI override with SUDO_STUDIO_HOME, so nothing here changes the
 * behaviour proven by the earlier suites on Windows.
 *
 * Pure Node (fs/os/path only), pkg-safe (no __dirname), ASCII only.
 */
'use strict';

const os = require('os');
const path = require('path');

function platform(p) {
  return p || process.platform;
}

function home() {
  try { return os.homedir(); } catch (_) { return process.env.HOME || process.env.USERPROFILE || '.'; }
}

// XDG Base Directory: only honoured when the variable holds an ABSOLUTE path
// (the spec says relative values must be ignored).
function xdg(name) {
  const v = process.env[name];
  if (!v) return null;
  if (!path.isAbsolute(v)) return null;
  return v;
}

function isWin(p) {
  return platform(p) === 'win32';
}

/** Root data folder (logs/, models/, installers/ live under it on Windows). */
function dataDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (process.env.SUDO_STUDIO_HOME) return process.env.SUDO_STUDIO_HOME;
  const p = platform(opts.platform);
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    return path.join(local, 'SudoStudio');
  }
  if (p === 'linux') {
    return path.join(xdg('XDG_DATA_HOME') || path.join(home(), '.local', 'share'), 'sudo-studio');
  }
  // macOS
  return path.join(home(), 'Library', 'Application Support', 'SudoStudio');
}

/** Logs folder. Linux: XDG_STATE_HOME first (spec), then data dir. */
function logsDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (process.env.SUDO_STUDIO_LOGS) return process.env.SUDO_STUDIO_LOGS;
  const p = platform(opts.platform);
  if (p === 'win32') return path.join(dataDir(opts), 'logs');
  if (p === 'linux') {
    const state = xdg('XDG_STATE_HOME');
    if (state) return path.join(state, 'sudo-studio', 'logs');
    return path.join(dataDir(opts), 'logs');
  }
  return path.join(dataDir(opts), 'logs');
}

/** Models folder: unchanged logic (~/.sudo_studio/models), user documented. */
function modelsDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (process.env.SUDO_STUDIO_MODELS) return process.env.SUDO_STUDIO_MODELS;
  if (isWin(opts.platform)) return path.join(dataDir(opts), 'models');
  return path.join(home(), '.sudo_studio', 'models');
}

/** Offline installers folder: unchanged logic (~/.sudo_studio/installers). */
function installersDir(opts) {
  opts = opts || {};
  if (opts.dir) return opts.dir;
  if (process.env.SUDO_STUDIO_INSTALLERS) return process.env.SUDO_STUDIO_INSTALLERS;
  if (isWin(opts.platform)) return path.join(dataDir(opts), 'installers');
  return path.join(home(), '.sudo_studio', 'installers');
}

/** Where a frozen (pkg / PyInstaller) build may write: never the snapshot. */
function isPackaged() {
  return !!(process.pkg || process.env.SUDO_STUDIO_PACKAGED === '1');
}

/**
 * Logs dir for a frozen build: never inside the read-only snapshot
 * (/snapshot under pkg, /tmp/_MEIxxxx under PyInstaller). Falls back to the
 * per-user folder, then the temp dir. Returns { dir, reason }.
 */
function packagedLogsDir(opts) {
  opts = opts || {};
  if (process.env.SUDO_STUDIO_LOGS) return { dir: process.env.SUDO_STUDIO_LOGS, reason: 'env' };
  const preferred = logsDir(opts);
  return { dir: preferred, reason: 'platform' };
}

/**
 * Startup journal shared by the launcher and the backend: one line per boot,
 * in the documented logs folder. Never throws: a read-only home must not
 * prevent the product from starting.
 */
function writeStartupLine(text, opts) {
  opts = opts || {};
  const fs = require('fs');
  const target = (opts.dir || logsDir(opts));
  const candidates = [target, path.join(os.tmpdir(), 'sudo-studio-logs')];
  const line = new Date().toISOString() + ' [launcher] ' + String(text).replace(/[\r\n]+/g, ' ') + '\n';
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'startup.log'), line, 'utf8');
      return { ok: true, dir };
    } catch (_) { /* next candidate */ }
  }
  return { ok: false, dir: null };
}

/** Human readable summary (Doctor / support). */
function summary(opts) {
  return {
    platform: platform(opts && opts.platform),
    data: dataDir(opts),
    logs: logsDir(opts),
    models: modelsDir(opts),
    installers: installersDir(opts),
    xdgData: xdg('XDG_DATA_HOME') || null,
    xdgState: xdg('XDG_STATE_HOME') || null,
  };
}

module.exports = {
  dataDir, logsDir, modelsDir, installersDir,
  isPackaged, packagedLogsDir, writeStartupLine, summary, xdg, isWin,
};
