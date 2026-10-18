/**
 * server.js - Sudo Studio Backend
 *
 * PKG-SAFE: All writable paths use process.execPath-relative resolution.
 * ZERO native C++ modules — lowdb (pure-JS JSON DB) + bcryptjs (pure-JS bcrypt).
 * backend.log is written as the VERY FIRST operation, before any npm require().
 */

// ================================================================
// ABSOLUTE FIRST LINES — write backend.log BEFORE any other require()
// Uses ONLY Node.js built-ins (fs, path). Zero npm dependencies here.
// ================================================================
const fs = require('fs')
const path = require('path')
// P30(b): --selftest audits every require() WITHOUT booting (exit 0/1).
// Placed before EVERYTHING (even log creation): a missing module must fail
// the audit, never crash the boot. selftest.js is builtins-only.
if (process.argv.indexOf('--selftest') !== -1) {
  require('./selftest').runAndExit(__filename);
}
const logDir = process.pkg
  ? path.join(path.dirname(process.execPath), '..', 'logs')
  : path.join(__dirname, '..', 'logs')
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}
fs.writeFileSync(
  path.join(logDir, 'backend.log'),
  new Date().toISOString() + ' Backend starting...\n'
)

// ================================================================
// STEP 0 — early log helper (appends to backend.log + stderr)
// ================================================================
'use strict';

const LOGS_DIR    = logDir;
const BACKEND_LOG = path.join(LOGS_DIR, 'backend.log');

// BASE_DIR: root directory for static assets (dist/) and version.json
// Same pkg-safe logic as logDir but without the /logs suffix
const BASE_DIR = process.pkg
  ? path.join(path.dirname(process.execPath), '..')
  : path.join(__dirname, '..');

function earlyLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  process.stderr.write(line);
  try { fs.appendFileSync(BACKEND_LOG, line); } catch (_) { /* ignore */ }
}

earlyLog('=== Sudo Studio Backend starting ===');
// P29(e): build commit first (build-manifest.json shipped at install root).
try {
  const mf = path.join(path.dirname(process.execPath), 'build-manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  earlyLog('build: commit=' + (m.sudo_studio_commit || m.commit || '?') + ' date=' + (m.date || '?'));
} catch (_) { earlyLog('build: dev (no build-manifest.json)'); }
earlyLog('logDir (pkg-safe): ' + logDir);
earlyLog('pkg context: ' + (typeof process.pkg !== 'undefined'));
earlyLog('process.execPath: ' + process.execPath);
earlyLog('Node version: ' + process.version);
earlyLog('Platform: ' + process.platform + ' ' + process.arch);

// ================================================================
// STEP 0.5 - GLOBAL CRASH HANDLERS (P30-c)
// Cause -> unified journal (%LOCALAPPDATA%\SudoStudio\logs\backend.log)
// + local backend.log + STDOUT, then exit(1). Never a silent exit 0.
// crashHandler.js is builtins-only: safe to require this early.
require('./crashHandler').setup({ localLog: BACKEND_LOG });

// ================================================================
// STEP 1 — REQUIRE ALL MODULES (each wrapped, logged on failure)
// ================================================================
earlyLog('Loading express...');
const express = require('express');
earlyLog('Loading http...');
const http = require('http');
earlyLog('Loading socket.io...');
const { Server } = require('socket.io');
earlyLog('Loading helmet...');
const helmet = require('helmet');
earlyLog('Loading cors...');
const cors = require('cors');
earlyLog('Loading express-rate-limit...');
const rateLimit = require('express-rate-limit');

earlyLog('Loading user.model...');
const { initDB } = require('./models/user.model');

earlyLog('Loading logger (winston)...');
const logger = require('./utils/logger');
earlyLog('Logger loaded. File transport: ' + logger.fileTransportOk);
try { require('./utils/connRetry').installAxiosConnRetry(require('axios')); earlyLog('connRetry installed (P1-e: 1 retry on ECONNRESET/REFUSED)'); } catch (e) { earlyLog('WARNING connRetry install failed: ' + e.message); }

// Routes — each wrapped individually so one bad require does not kill the server
function safeRequire(modPath, name) {
  try {
    const m = require(modPath);
    earlyLog('Loaded route: ' + name);
    return m;
  } catch (e) {
    earlyLog('WARNING: Failed to load route ' + name + ': ' + e.message);
    // Return an empty router as fallback
    const r = express.Router();
    r.use((req, res) => res.status(503).json({ error: name + ' not available', detail: e.message }));
    return r;
  }
}

earlyLog('Loading routes...');
const adminRoutes       = safeRequire('./routes/admin.routes',       'admin');
const emulatorRoutes    = safeRequire('./routes/emulator.routes',    'emulator');
const monitorRoutes     = safeRequire('./routes/monitor.routes',     'monitor');
const systemRoutes      = safeRequire('./routes/system.routes',      'system');
const authRoutes        = safeRequire('./routes/auth.routes',        'auth');
const environmentRoutes = safeRequire('./routes/environment.routes', 'environment');
const projectRoutes     = safeRequire('./routes/project.routes',     'project');
const devopsRoutes      = safeRequire('./routes/devops.routes',      'devops');
const aiRoutes          = safeRequire('./routes/ai.routes',          'ai');
const modelsRoutes      = safeRequire('./routes/models.routes',      'models');
const sdkRoutes         = safeRequire('./routes/sdk.routes',         'sdk');
const supervisorRoutes  = safeRequire('./routes/supervisor.routes',  'supervisor');
earlyLog('All routes loaded');

// ================================================================
// STEP 2 — CREATE EXPRESS APP
// ================================================================
earlyLog('Creating Express app...');
const app = express();
const server = http.createServer(app);

earlyLog('Creating socket.io server...');
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST'],
  },
});

// ================================================================
// STEP 3 — MIDDLEWARE
// ================================================================
earlyLog('Mounting middleware...');

app.use(express.static(path.join(BASE_DIR, 'dist')));
app.use(express.json());
app.use(helmet());

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return callback(null, true);
    if (origin.startsWith('vscode-webview://') || origin.startsWith('vscode-file://')) return callback(null, true);
    if (origin === 'null') return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
};
app.use(cors(corsOptions));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  skip: (req) => req.path === '/health' || req.path === '/version',
});
app.use(limiter);

// P21-a: correlation id per request (echoed back, usable as the journal corr field).
app.use((req, res, next) => {
  try {
    const h = req.headers && (req.headers['x-correlation-id'] || req.headers['x-request-id']);
    req.corrId = (h && /^[A-Za-z0-9_-]{1,64}$/.test(String(h))) ? String(h) : null;
    if (!req.corrId) {
      try { req.corrId = 'req-' + require('crypto').randomBytes(4).toString('hex'); }
      catch (_) { req.corrId = 'req-' + Date.now(); }
    }
    res.setHeader('x-correlation-id', req.corrId);
  } catch (_) { /* never break requests */ }
  next();
});

// ================================================================
// STEP 4 — DB INIT (non-blocking — server starts even if DB fails)
// ================================================================
earlyLog('Initializing database...');
initDB()
  .then(() => earlyLog('Database initialized OK'))
  .catch((e) => earlyLog('WARNING: Database init failed: ' + e.message + ' (server continues)'));

// ================================================================
// STEP 5 — MOUNT ROUTES
// ================================================================
earlyLog('Mounting routes...');
app.use('/', authRoutes);
app.use('/', adminRoutes);
app.use('/', emulatorRoutes);
app.use('/', monitorRoutes);
app.use('/', systemRoutes);
app.use('/', environmentRoutes);
app.use('/', projectRoutes);
app.use('/', devopsRoutes);
app.use('/', aiRoutes);
app.use('/', modelsRoutes);
app.use('/', sdkRoutes);
app.use('/', supervisorRoutes);

// Static UI
// P28: the former /ui mount was removed (backend/web-ui/ never existed).

app.get('/', (req, res) => {
  const idx = path.join(BASE_DIR, 'dist', 'index.html');
  if (fs.existsSync(idx)) {
    res.sendFile(idx);
  } else {
    res.json({ status: 'ok', service: 'sudo-studio-backend' });
  }
});

// P29(b): legacy /api/models block + fake /api/chat removed (2026-10-18).
// The block required ./ai/aiModelsManager (deleted in P28) and crashed
// the backend at boot (MODULE_NOT_FOUND). Real routes live in
// routes/models.routes.js and routes/ai.routes.js (mounted below).
// P30(a) root cause: backend/ai/aiModelsManager.js was deleted in 772ee6f
// (P28, 17/10 - legacy per-model sidecar design, superseded by the single
// enterprise runtime on port 6000) but this require (here since 5841616)
// was never updated. Every backend.exe built after P28 crashed at boot.
// No .gitignore cause (only backend/ai/models* ignored), no case issue
// (backend/ai/ is gone entirely), pkg config was fine (static requires are
// bundled automatically - pkg only WARNED on the missing file and still
// produced a crashing exe). Deletion (not restore) is the correct fix;
// --selftest now gates the build against any repeat.

// Socket.io
io.on('connection', (socket) => {
  earlyLog('Socket connected: ' + socket.id);
  // P29(b): fake 'chat-message' handler removed (hardcoded simulated reply).
  // Real chat: POST /api/ai/chat (routes/ai.routes.js) via the runtime.
  socket.on('disconnect', () => {
    earlyLog('Socket disconnected: ' + socket.id);
  });
});

// Centralized error handler
app.use((err, req, res, next) => {
  earlyLog('Express error: ' + err.message);
  try { logger.error(err); } catch (e) { /* ignore */ }
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ================================================================
// STEP 6 — START LISTENING
// ================================================================
const PORT = process.env.PORT || 5000;

function startServer(port) {
  earlyLog('Starting server on port ' + port + '...');
  server.listen(port, '0.0.0.0', () => {
    earlyLog('=== SERVER LISTENING on port ' + port + ' ===');
    earlyLog('Health: http://localhost:' + port + '/api/system/health');
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      earlyLog('Port ' + port + ' in use, trying ' + (port + 1));
      startServer(port + 1);
    } else {
      earlyLog('FATAL server error: ' + err.message);
    }
  });
}

startServer(PORT);
// P21: uniform technical journal (backend + supervisor) with session header.
try {
  const techLog = require('./utils/techLog');
  techLog.setTechEnabled(true);
  let build = 'unknown';
  try { build = String(JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'version.json'), 'utf8')).version || 'unknown'); } catch (_) {}
  let policies = {};
  try { policies = { edition: process.env.SUDO_EDITION || 'dev' }; } catch (_) {}
  const backendTech = techLog.createLogger({ component: 'backend' });
  backendTech.sessionHeader(techLog.gatherSessionInfo({ build, model: 'n/a (backend)', ports: { backend: PORT, runtime: 6000 }, policies }));
  backendTech.info('backend starting', { port: PORT });
  const supTech = techLog.createLogger({ component: 'supervisor' });
  supTech.sessionHeader(techLog.gatherSessionInfo({ build, model: 'see runtime health', ports: { backend: PORT, runtime: 6000 }, policies }));
  require('./supervisor/runtimeSupervisor').getSupervisor({ tech: supTech }).start();
  earlyLog('Runtime supervisor started (P1-d)');
} catch (e) { earlyLog('WARNING supervisor start failed: ' + e.message); }
