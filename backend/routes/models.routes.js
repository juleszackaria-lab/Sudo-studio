const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth.middleware');
const axios = require('axios');

const execPromise = promisify(exec);

/**
 * PHASE 2 - GESTION AUTOMATIQUE DES MODÈLES IA
 * Module pour lister/gérer les modèles IA locaux HuggingFace.
 * NOTE: Le runtime Python (port 6000) utilise HuggingFace transformers,
 * PAS Ollama. Ce module reflète la réalité du runtime.
 */

// Modèles HuggingFace supportés par le runtime
const AVAILABLE_MODELS = {
  'TinyLlama/TinyLlama-1.1B-Chat-v1.0': {
    id: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0',
    name: 'TinyLlama',
    displayName: 'TinyLlama 1.1B Chat',
    type: 'huggingface',
    size: '~600 MB',
    description: 'Rapide, léger, CPU compatible. Recommandé pour démarrer.',
    recommended: true,
    minRam: '4GB'
  },
  'Qwen/Qwen2.5-Coder-1.5B-Instruct': {
    id: 'Qwen/Qwen2.5-Coder-1.5B-Instruct',
    name: 'qwen2.5-coder',
    displayName: 'Qwen 2.5 Coder 1.5B',
    type: 'huggingface',
    size: '~1.5 GB',
    description: 'Optimisé pour le code. Excellent rapport qualité/taille.',
    recommended: true,
    minRam: '6GB'
  },
  'microsoft/phi-2': {
    id: 'microsoft/phi-2',
    name: 'phi-2',
    displayName: 'Phi-2 2.7B',
    type: 'huggingface',
    size: '~2.7 GB',
    description: 'Modèle Microsoft très performant pour sa taille.',
    recommended: true,
    minRam: '8GB'
  },
  'deepseek-ai/deepseek-coder-1.3b-instruct': {
    id: 'deepseek-ai/deepseek-coder-1.3b-instruct',
    name: 'deepseek-coder',
    displayName: 'DeepSeek Coder 1.3B',
    type: 'huggingface',
    size: '~1.3 GB',
    description: 'Spécialisé code, DeepSeek AI. Rapide et précis.',
    recommended: true,
    minRam: '6GB'
  },
  'Qwen/Qwen2-1.5B-Instruct': {
    id: 'Qwen/Qwen2-1.5B-Instruct',
    name: 'qwen2-chat',
    displayName: 'Qwen2 Chat 1.5B',
    type: 'huggingface',
    size: '~1.5 GB',
    description: 'Modèle de conversation Qwen2, compact et efficace.',
    recommended: false,
    minRam: '6GB'
  },
  'meta-llama/Llama-3.2-1B-Instruct': {
    id: 'meta-llama/Llama-3.2-1B-Instruct',
    name: 'Llama-3.2-1B',
    displayName: 'Llama 3.2 1B',
    type: 'huggingface',
    size: '~1.2 GB',
    description: 'Meta Llama 3.2, compact et efficace.',
    recommended: false,
    minRam: '6GB'
  }
};

/**
 * Scan HuggingFace cache to find installed models.
 * HF cache is at ~/.cache/huggingface/hub/
 */
function scanHFCache() {
  const installed = [];
  try {
    const hfHome = process.env.HF_HOME
      || process.env.HUGGINGFACE_HUB_CACHE
      || path.join(require('os').homedir(), '.cache', 'huggingface', 'hub');

    if (!fs.existsSync(hfHome)) return installed;

    const entries = fs.readdirSync(hfHome);
    for (const entry of entries) {
      // HF cache entries look like "models--TinyLlama--TinyLlama-1.1B-Chat-v1.0"
      if (!entry.startsWith('models--')) continue;
      const modelId = entry.replace('models--', '').replace(/--/g, '/');
      const modelPath = path.join(hfHome, entry);
      // Check if snapshots directory exists (model is downloaded)
      const snapshotsPath = path.join(modelPath, 'snapshots');
      if (fs.existsSync(snapshotsPath)) {
        const snapshots = fs.readdirSync(snapshotsPath);
        if (snapshots.length > 0) {
          installed.push(modelId);
        }
      }
    }
  } catch (err) {
    logger.warn('HF cache scan failed', { error: err.message });
  }
  return installed;
}

/**
 * Check AI runtime status
 */
async function checkRuntimeStatus() {
  try {
    const r = await axios.get('http://localhost:6000/health', { timeout: 2000 });
    return { running: true, model: r.data.model || {} };
  } catch (_) {
    return { running: false, model: {} };
  }
}

/**
 * GET /api/models/list
 * Liste les modèles HuggingFace installés et disponibles
 */
router.get('/api/models/list', verifyToken, async (req, res) => {
  try {
    logger.info('Listing HuggingFace models', { user: req.user.username });

    const installedIds = scanHFCache();
    const runtimeStatus = await checkRuntimeStatus();

    const availableList = Object.values(AVAILABLE_MODELS).map(model => ({
      ...model,
      installed: installedIds.some(id =>
        id.toLowerCase() === model.id.toLowerCase() ||
        id.toLowerCase().replace(/\//g, '--') === model.id.toLowerCase().replace(/\//g, '--')
      ),
      active: runtimeStatus.model?.name === model.name || runtimeStatus.model?.name === model.id
    }));

    const response = {
      installed: installedIds,
      available: availableList,
      total_available: availableList.length,
      total_installed: installedIds.length,
      runtime_running: runtimeStatus.running,
      current_model: runtimeStatus.model?.name || null,
      hf_cache_path: path.join(require('os').homedir(), '.cache', 'huggingface', 'hub')
    };

    res.json(response);

  } catch (error) {
    logger.error('Failed to list models', { error: error.message });
    res.status(500).json({
      error: 'Failed to list models',
      message: error.message
    });
  }
});

/**
 * POST /api/models/download
 * Lance le téléchargement d'un modèle via le runtime Python
 *
 * Body: { model: string }  -- HuggingFace model ID
 */
router.post('/api/models/download', verifyToken, async (req, res) => {
  try {
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({
        error: 'model is required',
        example: { model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' }
      });
    }

    const modelInfo = Object.values(AVAILABLE_MODELS).find(
      m => m.id === model || m.name === model
    );

    logger.info('Starting model download via runtime', {
      user: req.user.username,
      model
    });

    // Delegate to Python runtime
    try {
      const r = await axios.post('http://localhost:6000/download',
        { model },
        { timeout: 10000 }
      );

      res.json({
        status: 'downloading',
        model,
        displayName: modelInfo?.displayName || model,
        size: modelInfo?.size || 'unknown',
        message: `Downloading ${modelInfo?.displayName || model}...`,
        runtime_response: r.data
      });
    } catch (runtimeErr) {
      if (runtimeErr.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'AI Runtime not running',
          message: 'Start runtime.exe first (port 6000)',
          fix: 'Launch runtime.exe from start.bat'
        });
      }
      throw runtimeErr;
    }

  } catch (error) {
    logger.error('Model download failed', { error: error.message });
    res.status(500).json({
      error: 'Download failed',
      message: error.message
    });
  }
});

/**
 * POST /api/models/switch
 * Change le modèle actif via le runtime Python
 *
 * Body: { model: string }
 */
router.post('/api/models/switch', verifyToken, async (req, res) => {
  try {
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ error: 'model is required' });
    }

    logger.info('Switching model via runtime', {
      user: req.user.username,
      model
    });

    try {
      const r = await axios.post('http://localhost:6000/reload',
        { model },
        { timeout: 10000 }
      );
      res.json({
        status: 'switching',
        model,
        message: `Switching to ${model}...`,
        runtime_response: r.data
      });
    } catch (runtimeErr) {
      if (runtimeErr.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'AI Runtime not running',
          message: 'Start runtime.exe first (port 6000)'
        });
      }
      throw runtimeErr;
    }

  } catch (error) {
    logger.error('Model switch failed', { error: error.message });
    res.status(500).json({ error: 'Switch failed', message: error.message });
  }
});

/**
 * GET /api/models/status
 * Retourne l'état actuel du modèle chargé dans le runtime
 */
router.get('/api/models/status', verifyToken, async (req, res) => {
  try {
    const runtimeStatus = await checkRuntimeStatus();
    res.json({
      runtime_running: runtimeStatus.running,
      model: runtimeStatus.model,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/models/install  (kept for backward compat — delegates to /download)
 */
router.post('/api/models/install', verifyToken, async (req, res) => {
  req.url = '/api/models/download';
  return router.handle(req, res, () => {});
});

module.exports = router;
