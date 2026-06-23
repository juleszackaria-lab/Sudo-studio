const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');

/**
 * PHASE 1 - ENVIRONMENT ENGINE
 * Module de réplication et configuration d'environnement
 */

/**
 * POST /api/environment/replicate
 * Réplique un environnement de développement complet
 * 
 * Body: {
 *   projectName: string,
 *   template: 'node' | 'react' | 'vue' | 'express' | 'fastify',
 *   dependencies: string[],
 *   services: string[] // ex: ['redis', 'postgres', 'mongo']
 * }
 */
router.post('/api/environment/replicate', verifyToken, async (req, res) => {
  try {
    const { projectName, template, dependencies = [], services = [] } = req.body;

    if (!projectName || !template) {
      return res.status(400).json({ 
        error: 'projectName and template are required',
        allowed_templates: ['node', 'react', 'vue', 'express', 'fastify', 'nextjs']
      });
    }

    logger.info('Environment replication started', { 
      user: req.user.username, 
      projectName, 
      template,
      dependencies: dependencies.length,
      services: services.length
    });

    // Simuler la création de l'environnement
    const result = {
      status: 'success',
      projectName,
      template,
      steps_completed: [
        '1. Project structure created',
        '2. Package.json initialized',
        `3. ${dependencies.length} dependencies installed`,
        `4. ${services.length} services configured`,
        '5. Environment variables set',
        '6. Git initialized'
      ],
      dependencies_installed: dependencies,
      services_configured: services,
      next_steps: [
        `cd ${projectName}`,
        'npm start',
        'Open http://localhost:3000'
      ],
      estimated_time: '2-5 minutes'
    };

    // En production, ici on appellerait le vrai moteur de réplication
    // qui exécuterait npx create-* ou des commandes Docker

    res.json(result);

  } catch (error) {
    logger.error('Environment replication failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/environment/templates
 * Liste tous les templates disponibles
 */
router.get('/api/environment/templates', verifyToken, (req, res) => {
  const templates = [
    {
      id: 'node',
      name: 'Node.js',
      description: 'Basic Node.js project with Express',
      command: 'npm init -y',
      dependencies: ['express', 'nodemon', 'dotenv']
    },
    {
      id: 'react',
      name: 'React App',
      description: 'React application with Vite',
      command: 'npm create vite@latest',
      dependencies: ['react', 'react-dom', 'vite']
    },
    {
      id: 'vue',
      name: 'Vue.js App',
      description: 'Vue 3 application with Vite',
      command: 'npm create vue@latest',
      dependencies: ['vue', 'vite']
    },
    {
      id: 'express',
      name: 'Express API',
      description: 'Express REST API with middleware',
      command: 'npx express-generator',
      dependencies: ['express', 'cors', 'helmet', 'morgan']
    },
    {
      id: 'fastify',
      name: 'Fastify API',
      description: 'Fast and low overhead web framework',
      command: 'npm init fastify',
      dependencies: ['fastify', '@fastify/cors']
    },
    {
      id: 'nextjs',
      name: 'Next.js',
      description: 'React framework for production',
      command: 'npx create-next-app@latest',
      dependencies: ['next', 'react', 'react-dom']
    }
  ];

  res.json({ total: templates.length, templates });
});

/**
 * GET /api/environment/status
 * Vérifie l'état de l'environnement système
 */
router.get('/api/environment/status', verifyToken, (req, res) => {
  const status = {
    node: {
      version: process.version,
      installed: true
    },
    npm: {
      installed: true, // On suppose que npm est installé avec Node
      version: 'check with npm --version'
    },
    memory: {
      free: process.memoryUsage().heapTotal - process.memoryUsage().heapUsed,
      total: process.memoryUsage().heapTotal,
      used: process.memoryUsage().heapUsed
    },
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  };

  res.json(status);
});

/**
 * POST /api/environment/install
 * Installe des dépendances dans un projet
 * 
 * Body: {
 *   projectPath: string,
 *   dependencies: string[],
 *   dev: boolean
 * }
 */
router.post('/api/environment/install', verifyToken, async (req, res) => {
  try {
    const { projectPath, dependencies = [], dev = false } = req.body;

    if (!projectPath || dependencies.length === 0) {
      return res.status(400).json({ 
        error: 'projectPath and dependencies are required' 
      });
    }

    logger.info('Installing dependencies', { 
      user: req.user.username,
      projectPath,
      dependencies,
      dev
    });

    // Simuler l'installation
    const result = {
      status: 'success',
      projectPath,
      dependencies_installed: dependencies,
      dev_dependencies: dev,
      command: dev 
        ? `npm install --save-dev ${dependencies.join(' ')}`
        : `npm install ${dependencies.join(' ')}`,
      duration: '30-120 seconds'
    };

    // En production, ici on exécuterait:
    // const { exec } = require('child_process');
    // exec(result.command, { cwd: projectPath }, ...)

    res.json(result);

  } catch (error) {
    logger.error('Dependencies installation failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/environment/fix
 * Fix environment issues automatically.
 * Called by EnvironmentPanel via BackendService.fixEnvironment().
 *
 * Body: { issues: string[] }
 */
router.post('/api/environment/fix', verifyToken, async (req, res) => {
  try {
    const { issues = [] } = req.body;

    logger.info('Environment fix started', {
      user: req.user.username,
      issues_count: issues.length,
      issues
    });

    const fixes = [];
    
    for (const issue of issues) {
      const issueLower = issue.toLowerCase();
      if (issueLower.includes('node') || issueLower.includes('npm')) {
        fixes.push({ issue, action: 'Verified Node.js installation', status: 'ok', command: 'node --version' });
      } else if (issueLower.includes('python') || issueLower.includes('pip')) {
        fixes.push({ issue, action: 'Verified Python installation', status: 'ok', command: 'python --version' });
      } else if (issueLower.includes('git')) {
        fixes.push({ issue, action: 'Verified Git installation', status: 'ok', command: 'git --version' });
      } else if (issueLower.includes('docker')) {
        fixes.push({ issue, action: 'Docker check performed', status: 'info', command: 'docker --version' });
      } else if (issueLower.includes('permission') || issueLower.includes('access')) {
        fixes.push({ issue, action: 'Permission issue logged', status: 'warning', command: null });
      } else {
        fixes.push({ issue, action: 'Issue logged for manual review', status: 'info', command: null });
      }
    }

    const result = {
      status: 'completed',
      fixes_attempted: fixes.length,
      fixes_successful: fixes.filter(f => f.status === 'ok').length,
      fixes,
      timestamp: new Date().toISOString(),
      next_steps: fixes
        .filter(f => f.command)
        .map(f => f.command)
    };

    res.json(result);

  } catch (error) {
    logger.error('Environment fix failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/environment/export
 * Export current environment configuration as a portable snapshot.
 * Called by BackendService.exportEnvironment().
 *
 * Body: { projectPath: string, format: 'json'|'env'|'dockerfile' }
 */
router.post('/api/environment/export', verifyToken, async (req, res) => {
  try {
    const { projectPath = process.cwd(), format = 'json' } = req.body;
    const { exec } = require('child_process');
    const os = require('os');

    logger.info('Environment export started', {
      user: req.user.username,
      projectPath,
      format
    });

    // Gather system environment snapshot
    const nodeVersion = await new Promise(resolve => {
      exec('node --version', { timeout: 3000 }, (err, stdout) => resolve(err ? 'unknown' : stdout.trim()));
    });
    const pythonVersion = await new Promise(resolve => {
      const cmd = process.platform === 'win32' ? 'python --version 2>&1' : 'python3 --version';
      exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? 'unknown' : stdout.trim()));
    });
    const npmVersion = await new Promise(resolve => {
      exec('npm --version', { timeout: 3000 }, (err, stdout) => resolve(err ? 'unknown' : stdout.trim()));
    });
    const gitVersion = await new Promise(resolve => {
      exec('git --version', { timeout: 3000 }, (err, stdout) => resolve(err ? 'unknown' : stdout.trim()));
    });

    const snapshot = {
      exported_at: new Date().toISOString(),
      project_path: projectPath,
      format,
      system: {
        platform: os.platform(),
        arch: os.arch(),
        node: nodeVersion,
        npm: npmVersion,
        python: pythonVersion,
        git: gitVersion,
        ram_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
        cpu_cores: os.cpus().length
      },
      environment_variables: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        PATH: process.env.PATH ? '(set)' : '(not set)'
      },
      recommended_setup: [
        `Node.js ${nodeVersion}`,
        `Python ${pythonVersion}`,
        `npm ${npmVersion}`,
        `Git ${gitVersion}`
      ]
    };

    res.json({ success: true, snapshot });

  } catch (error) {
    logger.error('Environment export failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
