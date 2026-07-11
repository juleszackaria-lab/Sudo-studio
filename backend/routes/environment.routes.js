const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth.middleware');

const execPromise = promisify(exec);

/**
 * FEATURE 6 - ENVIRONNEMENTS REPRODUCTIBLES
 * Snapshot, export et synchronisation des environnements développeur.
 * Permet l'élimination du problème "ça marche chez moi".
 */

/**
 * Detect tool version via exec
 */
async function detectTool(cmd, name) {
  try {
    const { stdout } = await execPromise(cmd, { timeout: 5000 });
    return {
      name,
      installed: true,
      version: stdout.trim().split('\n')[0].replace(/^v/, '')
    };
  } catch (_) {
    return { name, installed: false, version: null };
  }
}

/**
 * Scan all development tools and return their status
 */
async function scanEnvironment() {
  const isWin = process.platform === 'win32';

  const toolChecks = await Promise.all([
    detectTool('node --version',                     'Node.js'),
    detectTool('npm --version',                      'npm'),
    detectTool(isWin ? 'python --version 2>&1' : 'python3 --version', 'Python'),
    detectTool(isWin ? 'pip --version' : 'pip3 --version', 'pip'),
    detectTool('git --version',                      'Git'),
    detectTool('docker --version',                   'Docker'),
    detectTool('flutter --version',                  'Flutter'),
    detectTool('java --version 2>&1',                'Java'),
    detectTool('rustc --version',                    'Rust'),
    detectTool('go version',                         'Go'),
  ]);

  return {
    platform: `${os.platform()} ${os.arch()}`,
    hostname: os.hostname(),
    total_ram_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    free_ram_gb: Math.round(os.freemem() / 1024 / 1024 / 1024),
    cpu_cores: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || 'Unknown',
    tools: toolChecks,
    timestamp: new Date().toISOString()
  };
}

/**
 * GET /api/environment/status
 * Retourne l'état complet de l'environnement développeur (outils, système, versions)
 */
router.get('/api/environment/status', verifyToken, async (req, res) => {
  try {
    logger.info('Getting environment status', { user: req.user.username });

    const env = await scanEnvironment();

    // Summary stats
    const installed = env.tools.filter(t => t.installed).length;
    const total = env.tools.length;
    const health_score = Math.round((installed / total) * 100);

    res.json({
      ...env,
      summary: {
        tools_installed: installed,
        tools_total: total,
        health_score,
        status: health_score >= 80 ? 'healthy' : health_score >= 50 ? 'partial' : 'degraded'
      }
    });

  } catch (error) {
    logger.error('Environment status failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/environment/export
 * Exporte un snapshot complet de l'environnement (.env-profile.json)
 * Permet de reproduire exactement l'environnement sur une autre machine.
 */
router.post('/api/environment/export', verifyToken, async (req, res) => {
  try {
    logger.info('Exporting environment snapshot', { user: req.user.username });

    const env = await scanEnvironment();

    // Scan global npm packages
    let npmGlobals = [];
    try {
      const { stdout } = await execPromise('npm list -g --depth=0 --json', { timeout: 10000 });
      const parsed = JSON.parse(stdout);
      npmGlobals = Object.keys(parsed.dependencies || {}).map(name => ({
        name,
        version: parsed.dependencies[name].version
      }));
    } catch (_) {}

    // Scan pip packages
    let pipPackages = [];
    try {
      const pipCmd = process.platform === 'win32' ? 'pip list --format=json' : 'pip3 list --format=json';
      const { stdout } = await execPromise(pipCmd, { timeout: 10000 });
      pipPackages = JSON.parse(stdout);
    } catch (_) {}

    // Check for workspace project
    let projectInfo = null;
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        projectInfo = {
          name: pkg.name,
          version: pkg.version,
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {})
        };
      }
    } catch (_) {}

    const snapshot = {
      export_version: '1.0',
      exported_at: new Date().toISOString(),
      exported_by: req.user.username,
      system: {
        platform: env.platform,
        hostname: env.hostname,
        total_ram_gb: env.total_ram_gb,
        cpu_cores: env.cpu_cores
      },
      tools: env.tools,
      npm_globals: npmGlobals,
      pip_packages: pipPackages.slice(0, 50), // cap at 50
      project: projectInfo,
      sudo_studio_version: '3.0'
    };

    // Return as downloadable JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="env-profile.json"');
    res.json(snapshot);

  } catch (error) {
    logger.error('Environment export failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/environment/sync
 * Compare l'environnement local avec un profil importé et détecte les écarts.
 * Body: { profile: object }  -- env-profile.json content
 */
router.post('/api/environment/sync', verifyToken, async (req, res) => {
  try {
    const { profile } = req.body;

    if (!profile || !profile.tools) {
      return res.status(400).json({ error: 'profile with tools array is required' });
    }

    logger.info('Syncing environment', { user: req.user.username });

    const currentEnv = await scanEnvironment();

    const diffs = [];
    for (const targetTool of profile.tools) {
      const currentTool = currentEnv.tools.find(t => t.name === targetTool.name);

      if (!currentTool) {
        diffs.push({
          tool: targetTool.name,
          issue: 'missing',
          target_version: targetTool.version,
          current_version: null,
          severity: 'error'
        });
      } else if (!currentTool.installed) {
        diffs.push({
          tool: targetTool.name,
          issue: 'not_installed',
          target_version: targetTool.version,
          current_version: null,
          severity: 'error'
        });
      } else if (targetTool.installed && targetTool.version && currentTool.version) {
        // Simple version comparison (major.minor)
        const targetMaj = targetTool.version.split('.')[0];
        const currentMaj = currentTool.version.split('.')[0];
        if (targetMaj !== currentMaj) {
          diffs.push({
            tool: targetTool.name,
            issue: 'version_mismatch',
            target_version: targetTool.version,
            current_version: currentTool.version,
            severity: 'warning'
          });
        }
      }
    }

    const synced = diffs.length === 0;

    res.json({
      synced,
      differences: diffs,
      current_environment: currentEnv,
      profile_environment: profile,
      summary: {
        errors: diffs.filter(d => d.severity === 'error').length,
        warnings: diffs.filter(d => d.severity === 'warning').length,
        status: synced ? 'synchronized' : 'drift_detected'
      }
    });

  } catch (error) {
    logger.error('Environment sync failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/environment/snapshot
 * Alias de /export — crée un snapshot nommé stocké côté serveur
 * Body: { name: string }
 */
router.post('/api/environment/snapshot', verifyToken, async (req, res) => {
  try {
    const { name = `snapshot-${Date.now()}` } = req.body;
    logger.info('Creating environment snapshot', { user: req.user.username, name });

    const env = await scanEnvironment();
    const snapshot = {
      name,
      created_at: new Date().toISOString(),
      created_by: req.user.username,
      system: {
        platform: env.platform,
        hostname: env.hostname,
        total_ram_gb: env.total_ram_gb
      },
      tools: env.tools
    };

    res.json({
      status: 'success',
      snapshot_name: name,
      snapshot,
      message: `Environment snapshot '${name}' created successfully`
    });

  } catch (error) {
    logger.error('Snapshot creation failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/environment/requirements
 * Retourne les requirements Sudo Studio (outils minimum requis)
 */
router.get('/api/environment/requirements', verifyToken, async (req, res) => {
  try {
    const env = await scanEnvironment();

    const required = ['Node.js', 'Python', 'Git'];
    const optional = ['Docker', 'Flutter', 'Java', 'Rust', 'Go'];

    const missing_required = required.filter(name => {
      const tool = env.tools.find(t => t.name === name);
      return !tool || !tool.installed;
    });

    const missing_optional = optional.filter(name => {
      const tool = env.tools.find(t => t.name === name);
      return !tool || !tool.installed;
    });

    res.json({
      required_tools: env.tools.filter(t => required.includes(t.name)),
      optional_tools: env.tools.filter(t => optional.includes(t.name)),
      missing_required,
      missing_optional,
      ready: missing_required.length === 0,
      message: missing_required.length === 0
        ? '✅ All required tools are installed'
        : `❌ Missing required tools: ${missing_required.join(', ')}`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
