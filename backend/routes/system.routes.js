const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// P28: the former GET /api/system/audit endpoint was DELETED (no caller;
// it mixed live data with a hardcoded missing-features list).
/**
 * GET /api/system/status
 * Status endpoint simple pour vérifier que le backend est opérationnel
 */
router.get('/api/system/status', (req, res) => {
  try {
    const status = {
      backend: true,
      ai: false,
      routes: true,
      extension: false,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };

    // P28: the former aiModelsManager probe was removed with that dead module.
    // Live AI-runtime state is reported by POST /api/system/doctor.
    // This synchronous route does not claim an AI state it cannot verify.
    status.ai = false;

    // Vérifier extension
    const extensionPath = path.join(__dirname, '../../sudo-ai-extension');
    status.extension = fs.existsSync(extensionPath);

    res.json(status);
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      backend: false,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/system/routes
 * Liste toutes les routes disponibles dans le système
 */
router.get('/api/system/routes', (req, res) => {
  try {
    const routes = [];
    
    // Parcourir toutes les routes enregistrées dans Express
    const app = req.app;
    
    function extractRoutes(stack, prefix = '') {
      stack.forEach(middleware => {
        if (middleware.route) {
          // Route directe
          const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
          routes.push({
            path: prefix + middleware.route.path,
            methods: methods,
            middleware: middleware.route.stack.length
          });
        } else if (middleware.name === 'router' && middleware.handle.stack) {
          // Router imbriqué
          const routerPath = middleware.regexp.source
            .replace('\\/?', '')
            .replace('(?=\\/|$)', '')
            .replace(/\\\//g, '/');
          extractRoutes(middleware.handle.stack, prefix + routerPath);
        }
      });
    }

    extractRoutes(app._router.stack);

    res.json({
      total: routes.length,
      routes: routes.sort((a, b) => a.path.localeCompare(b.path))
    });
  } catch (error) {
    logger.error('Failed to list routes', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/system/health
 * Main health check endpoint - used by extension and start.bat polling
 */
router.get('/api/system/health', (req, res) => {
  try {
    res.json({
      status: 'healthy',
      service: 'sudo-studio-backend',
      version: '2.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      platform: process.platform,
      node: process.version,
      memory: {
        used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

/**
 * POST /api/system/doctor
 * Runs system diagnostics: checks Node, Python, Git, Docker, AI runtime.
 * Called by DoctorPanel via BackendService.runDoctor().
 */
router.post('/api/system/doctor', async (req, res) => {
  const { exec } = require('child_process');
  const os = require('os');
  const axios = require('axios');

  const check = (name, cmd) => new Promise(resolve => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      resolve({ name, status: err ? 'error' : 'ok', value: err ? 'Not found' : stdout.trim().split('\n')[0] });
    });
  });

  const isWin = process.platform === 'win32';
  const results = await Promise.all([
    check('Node.js', 'node --version'),
    check('npm', 'npm --version'),
    check('Python', isWin ? 'python --version 2>&1' : 'python3 --version'),
    check('Git', 'git --version'),
    check('Docker', 'docker --version'),
  ]);

  // Check runtime
  try {
    await axios.get('http://127.0.0.1:6000/health', { timeout: 2000 });
    results.push({ name: 'AI Runtime (port 6000)', status: 'ok', value: 'Running' });
  } catch (_) {
    results.push({ name: 'AI Runtime (port 6000)', status: 'error', value: 'Not running', fix: 'startRuntime' });
  }

  results.push(
    { name: 'Platform', status: 'info', value: `${os.platform()} ${os.arch()}` },
    { name: 'RAM', status: 'info', value: `${Math.round(os.totalmem()/1024/1024/1024)}GB total` }
  );

  const ok = results.filter(r => r.status === 'ok').length;
  const total = results.filter(r => r.status !== 'info').length;
  res.json({ success: true, results, score: Math.round((ok / total) * 100) });
});

/**
 * POST /api/system/autofix
 * Auto-fixes a specific issue by type.
 * Called by DoctorPanel via BackendService.autoFix().
 */
router.post('/api/system/autofix', async (req, res) => {
  const { issueType } = req.body;
  const axios = require('axios');

  if (issueType === 'downloadModel') {
    try {
      await axios.post('http://127.0.0.1:6000/download',
        { model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }, { timeout: 5000 });
      return res.json({ success: true, message: 'Model download started on runtime' });
    } catch (e) {
      return res.status(503).json({ success: false, message: `Runtime offline: ${e.message}` });
    }
  }

  // For other issues return instructions
  const fixes = {
    'Node.js': 'Visit https://nodejs.org to install Node.js',
    'Python': 'Visit https://python.org to install Python 3.11+',
    'Git': 'Visit https://git-scm.com to install Git',
    'Docker': 'Visit https://docker.com to install Docker',
    'startRuntime': 'Run: cd backend/runtime && python3 server.enterprise.py',
    'startBackend': 'Run: cd backend && node server.js',
  };

  res.json({
    success: true,
    message: fixes[issueType] || `No automated fix available for: ${issueType}`,
    issueType
  });
});

module.exports = router;
