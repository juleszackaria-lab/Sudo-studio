/**
 * logger.js - PKG-SAFE Winston logger
 *
 * ROOT CAUSE FIX:
 *   Under pkg, __dirname resolves to a VIRTUAL read-only path inside the snapshot
 *   (e.g. /snapshot/backend/utils). Writing logs there throws EROFS/ENOENT and
 *   crashes the process before server.listen() is ever reached.
 *
 *   Fix: use process.execPath-relative paths when running inside a pkg bundle.
 *     pkg context  -> path.dirname(process.execPath) = C:\SudoStudio\app\
 *     dev context  -> path.join(__dirname, '..') = ./backend/
 *
 *   This is the ONLY correct pattern for writable runtime paths under pkg.
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

// ----------------------------------------------------------------
// PKG-SAFE base directory
// process.pkg is defined when running inside a pkg bundle.
// In that case __dirname is a virtual read-only snapshot path.
// ----------------------------------------------------------------
const BASE_DIR = (typeof process.pkg !== 'undefined')
  ? path.dirname(process.execPath)   // e.g. C:\SudoStudio\app\
  : path.join(__dirname, '..');      // e.g. ./backend/ (dev)

const logsDir = path.join(BASE_DIR, 'logs');

// Create logs dir - if this fails we fall back to console-only (never crash)
let fileTransportOk = false;
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  fileTransportOk = true;
} catch (e) {
  // Cannot write to logsDir - fall back to console only, do NOT crash
  process.stderr.write('[logger] WARNING: Cannot create logs dir: ' + logsDir + ' -> ' + e.message + '\n');
}

// Build transports list
const logTransports = [
  new transports.Console({
    format: format.combine(
      format.colorize(),
      format.timestamp(),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const m = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level}] ${message}${m}`;
      })
    )
  })
];

if (fileTransportOk) {
  logTransports.push(
    new transports.File({
      filename: path.join(logsDir, 'enterprise.log'),
      format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const m = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message}${m}`;
        })
      )
    })
  );
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: logTransports,
});

// Expose logsDir so server.js can reference it for backend.log path
logger.logsDir = logsDir;
logger.fileTransportOk = fileTransportOk;

module.exports = logger;
