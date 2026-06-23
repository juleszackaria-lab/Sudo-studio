const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * PHASE 0 - AUDIT GLOBAL DU SYSTÈME
 * GET /api/system/audit
 * 
 * Retourne un audit complet du système:
 * - Routes existantes
 * - APIs disponibles
 * - Modules chargés
 * - État de connexion
 * - Fonctionnalités manquantes
 */
router.get('/api/system/audit', async (req, res) => {
  try {
    const audit = {
      timestamp: new Date().toISOString(),
      status: 'ok',
      system: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      },
      backend: {
        routes: [],
        modules: [],
        missing: [],
        errors: []
      },
      features: {
        existing: [],
        missing: [],
        planned: []
      },
      ai: {
        models_manager: false,
        local_inference: false,
        ollama_support: false,
        vllm_support: false
      },
      extension: {
        exists: false,
        path: null
      }
    };

    // 1. Audit des routes existantes
    const routesPath = path.join(__dirname);
    const routeFiles = fs.readdirSync(routesPath).filter(f => f.endsWith('.routes.js'));
    
    audit.backend.routes = routeFiles.map(file => {
      return {
        file: file,
        path: `/routes/${file}`,
        loaded: true
      };
    });

    // 2. Vérifier les modules critiques
    const criticalModules = [
      { name: 'express', path: 'express' },
      { name: 'socket.io', path: 'socket.io' },
      { name: 'helmet', path: 'helmet' },
      { name: 'cors', path: 'cors' },
      { name: 'jsonwebtoken', path: 'jsonwebtoken' },
      { name: 'bcrypt', path: 'bcrypt' },
      { name: 'winston', path: 'winston' },
      { name: 'axios', path: 'axios' }
    ];

    for (const mod of criticalModules) {
      try {
        require.resolve(mod.path);
        audit.backend.modules.push({
          name: mod.name,
          status: 'installed',
          version: require(`${mod.path}/package.json`).version
        });
      } catch (e) {
        audit.backend.modules.push({
          name: mod.name,
          status: 'missing',
          error: e.message
        });
        audit.backend.missing.push(mod.name);
      }
    }

    // 3. Audit des features existantes
    const existingFeatures = [
      'Admin Routes (JWT Auth)',
      'Monitor Routes (Health, Version)',
      'Papito Routes (AI Analysis, DevOps)',
      'AI Models Manager',
      'User Management',
      'Rate Limiting',
      'CORS Protection',
      'Helmet Security',
      'Error Handling',
      'Logging System'
    ];
    audit.features.existing = existingFeatures;

    // 4. Features manquantes (selon le prompt God Mode)
    const missingFeatures = [
      'Environment Replication Engine',
      'Papito++ Advanced Analysis',
      'Auto-Fix System',
      'DevOps Simulator',
      'AI Chat Backend (/api/ai/chat)',
      'Multi-Model AI Routing (Ollama, vLLM)',
      'Streaming AI Responses',
      'Code Context Management',
      'Sudo AI Extension (VSCodium)',
      'AI Autocomplete',
      'AI Cache System'
    ];
    audit.features.missing = missingFeatures;

    // 5. Features planifiées
    audit.features.planned = [
      'PHASE 1: Standardisation API (/api/environment, /api/project, /api/devops, /api/ai)',
      'PHASE 2: Features Entreprise (Environment Engine, Papito++, AutoFix, DevOps Sim)',
      'PHASE 3: Backend IA Local (Multi-models routing, Ollama, vLLM, DeepSeek, etc.)',
      'PHASE 4: Extension Sudo AI (Sidebar, Chat UI, Commands)',
      'PHASE 5: Intégration Totale (E2E tests, Status endpoint)'
    ];

    // 6. Vérifier AI Models Manager
    try {
      const aiManager = require('../ai/aiModelsManager');
      audit.ai.models_manager = typeof aiManager.listModels === 'function';
    } catch (e) {
      audit.backend.errors.push(`AI Models Manager: ${e.message}`);
    }

    // 7. Vérifier existence de l'extension
    const extensionPath = path.join(__dirname, '../../sudo-ai-extension');
    if (fs.existsSync(extensionPath)) {
      audit.extension.exists = true;
      audit.extension.path = extensionPath;
    } else {
      audit.features.missing.push('Sudo AI Extension directory');
    }

    // 8. Déterminer le statut global
    if (audit.backend.missing.length > 0 || audit.backend.errors.length > 0) {
      audit.status = 'incomplete';
    } else if (audit.features.missing.length > 5) {
      audit.status = 'partially_ready';
    }

    // 9. Recommandations
    audit.recommendations = [
      'Créer structure /api/ standardisée',
      'Implémenter /api/ai/chat avec routing multi-modèles',
      'Créer extension Sudo AI dans /sudo-ai-extension',
      'Ajouter support Ollama (port 11434)',
      'Ajouter support vLLM/DeepSeek (port 8000)',
      'Implémenter streaming pour réponses IA',
      'Ajouter cache Redis pour réponses IA (optionnel)',
      'Créer tests E2E pour toutes les phases'
    ];

    // Log l'audit
    logger.info('System audit completed', { 
      status: audit.status, 
      routes: audit.backend.routes.length,
      missing: audit.backend.missing.length 
    });

    res.json(audit);

  } catch (error) {
    logger.error('System audit failed', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

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

    // Vérifier AI
    try {
      const aiManager = require('../ai/aiModelsManager');
      status.ai = typeof aiManager.listModels === 'function';
    } catch (e) {
      status.ai = false;
    }

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
    await axios.get('http://localhost:6000/health', { timeout: 2000 });
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
      await axios.post('http://localhost:6000/download',
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
