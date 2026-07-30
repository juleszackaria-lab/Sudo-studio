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

// BASE_DIR: root directory for static assets (dist/, web-ui/)
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
earlyLog('logDir (pkg-safe): ' + logDir);
earlyLog('pkg context: ' + (typeof process.pkg !== 'undefined'));
earlyLog('process.execPath: ' + process.execPath);
earlyLog('Node version: ' + process.version);
earlyLog('Platform: ' + process.platform + ' ' + process.arch);

// ================================================================
// STEP 0.5 — GLOBAL CRASH HANDLERS
// Catch anything that slips through so we ALWAYS get a log entry.
// ================================================================
// Track whether we are already inside an error handler to prevent infinite EPIPE loops.
// earlyLog() writes to process.stderr — if stderr itself is broken (EPIPE) the write
// triggers another uncaughtException which calls earlyLog again → infinite loop.
let _inErrorHandler = false;

process.on('uncaughtException', (err) => {
  if (_inErrorHandler) return; // break the EPIPE → uncaughtException loop
  _inErrorHandler = true;
  try {
    // EPIPE / ECONNRESET on stderr/sockets are harmless — suppress the flood
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
      try { fs.appendFileSync(BACKEND_LOG, '[' + new Date().toISOString() + '] ' + err.code + ' (suppressed)\n'); } catch (_) {}
      _inErrorHandler = false;
      return;
    }
    earlyLog('UNCAUGHT EXCEPTION: ' + err.message);
    earlyLog('STACK: ' + (err.stack || 'no stack'));
  } finally {
    _inErrorHandler = false;
  }
});

process.on('unhandledRejection', (reason) => {
  if (_inErrorHandler) return;
  _inErrorHandler = true;
  try {
    earlyLog('UNHANDLED REJECTION: ' + (reason && reason.message ? reason.message : String(reason)));
    if (reason && reason.stack) earlyLog('STACK: ' + reason.stack);
  } finally {
    _inErrorHandler = false;
  }
});

// ================================================================
// STEP 1 — REQUIRE ALL MODULES (each wrapped, logged on failure)
// ================================================================
earlyLog('Loading express...');
const express = require('express');
earlyLog('Loading http...');
const http = require('http');
earlyLog('Loading socket.io...');
const { Server } = require('socket.io');
earlyLog('Loading aiModelsManager...');
const aiModelsManager = require('./ai/aiModelsManager');
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
const papitoRoutes      = safeRequire('./routes/papito.routes',      'papito');
const monitorRoutes     = safeRequire('./routes/monitor.routes',     'monitor');
const systemRoutes      = safeRequire('./routes/system.routes',      'system');
const authRoutes        = safeRequire('./routes/auth.routes',        'auth');
const environmentRoutes = safeRequire('./routes/environment.routes', 'environment');
const projectRoutes     = safeRequire('./routes/project.routes',     'project');
const devopsRoutes      = safeRequire('./routes/devops.routes',      'devops');
const aiRoutes          = safeRequire('./routes/ai.routes',          'ai');
const modelsRoutes      = safeRequire('./routes/models.routes',      'models');
const sdkRoutes         = safeRequire('./routes/sdk.routes',         'sdk');
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
app.use('/papito', papitoRoutes);
app.use('/', monitorRoutes);
app.use('/', systemRoutes);
app.use('/', environmentRoutes);
app.use('/', projectRoutes);
app.use('/', devopsRoutes);
app.use('/', aiRoutes);
app.use('/', modelsRoutes);
app.use('/', sdkRoutes);

// Static UI
app.use('/ui', express.static(path.join(BASE_DIR, 'web-ui')));

app.get('/', (req, res) => {
  const idx = path.join(BASE_DIR, 'dist', 'index.html');
  if (fs.existsSync(idx)) {
    res.sendFile(idx);
  } else {
    res.json({ status: 'ok', service: 'sudo-studio-backend' });
  }
});

// Legacy /api/models endpoints (kept for compatibility)
app.get('/api/models', (req, res) => {
  try { res.json(aiModelsManager.listModels()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/models/:modelName', (req, res) => {
  try {
    const info = aiModelsManager.getModelInfo(req.params.modelName);
    if (!info) return res.status(404).json({ error: 'Model not found' });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/start', (req, res) => {
  const { modelName } = req.body;
  if (!modelName) return res.status(400).json({ error: 'modelName required' });
  try { res.json({ message: 'started', state: aiModelsManager.startModel(modelName) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/stop', (req, res) => {
  const { modelName } = req.body;
  if (!modelName) return res.status(400).json({ error: 'modelName required' });
  try { aiModelsManager.stopModel(modelName); res.json({ message: 'stopped' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/infer', async (req, res) => {
  const { modelName, input } = req.body;
  try { res.json(await aiModelsManager.infer(modelName, input)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/download', async (req, res) => {
  const { modelName, url } = req.body;
  if (!modelName || !url) return res.status(400).json({ error: 'modelName and url required' });
  try { res.json({ message: `Model ${modelName} downloaded`, path: await aiModelsManager.downloadModel(modelName, url) }); }
  catch (e) { res.status(500).json({ error: 'Failed to download model' }); }
});

app.post('/api/chat', async (req, res) => {
  const { modelName, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });
  const reply = `Réponse simulée pour le prompt: "${prompt}"`;
  res.json({ reply });
});

app.delete('/api/models/:modelName', (req, res) => {
  try { aiModelsManager.deleteModel(req.params.modelName); res.json({ message: `Model deleted` }); }
  catch (e) { res.status(500).json({ error: 'Failed to delete model' }); }
});

// Socket.io
io.on('connection', (socket) => {
  earlyLog('Socket connected: ' + socket.id);
  socket.on('chat-message', async (data) => {
    const { prompt } = data || {};
    socket.emit('chat-response', { reply: `Réponse simulée: ${prompt || ''}` });
  });
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
