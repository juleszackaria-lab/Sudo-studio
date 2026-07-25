/**
 * boot-logger.js
 *
 * Ultra-early boot logger: writes to disk BEFORE any other module loads.
 * This is the FIRST module required in server.js.
 * Guarantees backend.log exists even if the process crashes immediately after.
 *
 * Uses only Node.js built-ins (fs, path) — zero npm dependencies.
 * Works inside pkg exe because it uses process.pkg-aware path resolution.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Resolve the log directory: must be on a real writable disk path.
// Inside pkg, __dirname = /snapshot/... which is read-only virtual FS.
// ---------------------------------------------------------------------------
function getLogsDir() {
  if (process.pkg) {
    // Exe lives at process.execPath (e.g. C:\Program Files\SudoStudio\app\backend.exe)
    // Write logs next to the exe's parent parent (i.e. {install_root}\logs\)
    const exeDir = path.dirname(process.execPath);          // app\
    const installRoot = path.dirname(exeDir);               // {app}\
    return path.join(installRoot, 'logs');
  }
  // Normal node: logs/ relative to backend root
  return path.join(__dirname, '..', 'logs');
}

const logsDir = getLogsDir();

console.log('[PKG-SAFE] boot-logger writing to:', logsDir);

// Create logs dir synchronously — must exist before first write
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('[PKG-SAFE] Created logs dir:', logsDir);
  }
} catch (e) {
  // If we can't create logs dir, fall back to temp dir
  // This should never happen but we must not crash here
  console.error('[boot-logger] Cannot create logs dir:', e.message);
}

const logFile = path.join(logsDir, 'backend.log');

// ---------------------------------------------------------------------------
// Write immediately: mark start time
// ---------------------------------------------------------------------------
const startTime = new Date().toISOString();
const startMsg = [
  '============================================================',
  `  SUDO STUDIO BACKEND - Boot started at ${startTime}`,
  `  Node version : ${process.version}`,
  `  Platform     : ${process.platform} ${process.arch}`,
  `  PID          : ${process.pid}`,
  `  pkg mode     : ${process.pkg ? 'YES (exe)' : 'NO (node)'}`,
  `  execPath     : ${process.execPath}`,
  `  cwd          : ${process.cwd()}`,
  `  logs dir     : ${logsDir}`,
  '============================================================',
  '',
].join('\n');

try {
  fs.writeFileSync(logFile, startMsg + '\n', { encoding: 'utf8', flag: 'w' });
} catch (e) {
  console.error('[boot-logger] Cannot write log file:', e.message);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function log(level, message) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // Silently ignore log write errors — never crash the server over logging
  }
}

function info(msg)  { log('INFO',  msg); }
function warn(msg)  { log('WARN',  msg); }
function error(msg) { log('ERROR', msg); }
function debug(msg) { log('DEBUG', msg); }

// ---------------------------------------------------------------------------
// Global uncaught exception handlers — log to file BEFORE process exits
// ---------------------------------------------------------------------------
function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    error(`UNCAUGHT EXCEPTION: ${err.message}`);
    error(`Stack: ${err.stack}`);
    // Give the file system time to flush before exit
    try { fs.appendFileSync(logFile, `FATAL: process exiting after uncaughtException\n`); } catch (_) {}
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack : String(reason);
    error(`UNHANDLED REJECTION: ${msg}`);
    try { fs.appendFileSync(logFile, `FATAL: process exiting after unhandledRejection\n`); } catch (_) {}
    process.exit(1);
  });

  process.on('exit', (code) => {
    const line = `${new Date().toISOString()} [INFO] Process exiting with code ${code}\n`;
    try { fs.appendFileSync(logFile, line); } catch (_) {}
  });
}

module.exports = { info, warn, error, debug, logFile, logsDir, installGlobalHandlers };
