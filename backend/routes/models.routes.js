const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth.middleware');
const axios = require('axios');

const execPromise = promisify(exec);

/**
 * PHASE 2 - GESTION AUTOMATIQUE DES MODÈLES IA
 * Module pour installer/supprimer/lister les modèles IA locaux
 */

// Liste des modèles disponibles avec leurs métadonnées
const AVAILABLE_MODELS = {
  // Ollama models
  'llama3': {
    name: 'llama3',
    displayName: 'Llama 3',
    type: 'ollama',
    size: '4.7 GB',
    description: 'General purpose model, great for chat and questions',
    command: 'ollama pull llama3:latest',
    recommended: true
  },
  'llama3.1': {
    name: 'llama3.1',
    displayName: 'Llama 3.1',
    type: 'ollama',
    size: '4.7 GB',
    description: 'Enhanced version with better reasoning',
    command: 'ollama pull llama3.1:latest',
    recommended: true
  },
  'llama3.2': {
    name: 'llama3.2',
    displayName: 'Llama 3.2',
    type: 'ollama',
    size: '2.0 GB',
    description: 'Latest lightweight version',
    command: 'ollama pull llama3.2:latest',
    recommended: true
  },
  'mistral': {
    name: 'mistral',
    displayName: 'Mistral',
    type: 'ollama',
    size: '4.1 GB',
    description: 'Fast and efficient model for general tasks',
    command: 'ollama pull mistral:latest',
    recommended: true
  },
  'mixtral': {
    name: 'mixtral',
    displayName: 'Mixtral 8x7B',
    type: 'ollama',
    size: '26 GB',
    description: 'Powerful mixture-of-experts model',
    command: 'ollama pull mixtral:latest',
    recommended: false
  },
  'gemma4': {
    name: 'gemma4',
    displayName: 'Gemma 4',
    type: 'ollama',
    size: '5.0 GB',
    description: 'Google\'s open model, balanced performance',
    command: 'ollama pull gemma:latest',
    recommended: true
  },
  'codellama': {
    name: 'codellama',
    displayName: 'Code Llama',
    type: 'ollama',
    size: '3.8 GB',
    description: 'Specialized for code generation',
    command: 'ollama pull codellama:latest',
    recommended: true
  },
  'qwen-coder': {
    name: 'qwen-coder',
    displayName: 'Qwen Coder',
    type: 'ollama',
    size: '4.2 GB',
    description: 'Excellent for code analysis',
    command: 'ollama pull qwen:latest',
    recommended: true
  },
  'qwen2.5-coder': {
    name: 'qwen2.5-coder',
    displayName: 'Qwen 2.5 Coder',
    type: 'ollama',
    size: '4.7 GB',
    description: 'Latest Qwen model optimized for coding',
    command: 'ollama pull qwen2.5-coder:latest',
    recommended: true
  },
  'deepseek-coder': {
    name: 'deepseek-coder',
    displayName: 'DeepSeek Coder',
    type: 'ollama',
    size: '3.8 GB',
    description: 'Advanced code understanding',
    command: 'ollama pull deepseek-coder:latest',
    recommended: true
  },
  'deepseek-coder-v2': {
    name: 'deepseek-coder-v2',
    displayName: 'DeepSeek Coder V2',
    type: 'ollama',
    size: '16 GB',
    description: 'Most advanced DeepSeek model for coding',
    command: 'ollama pull deepseek-coder-v2:latest',
    recommended: false
  }
};

/**
 * GET /api/models/list
 * Liste tous les modèles installés et disponibles
 */
router.get('/api/models/list', verifyToken, async (req, res) => {
  try {
    logger.info('Listing models', { user: req.user.username });

    // Vérifier les modèles installés via Ollama
    let installedModels = [];
    
    try {
      const { stdout } = await execPromise('ollama list');
      
      // Parser la sortie d'ollama list
      const lines = stdout.split('\n').slice(1); // Skip header
      installedModels = lines
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(/\s+/);
          const modelName = parts[0].split(':')[0]; // Remove :latest tag
          return modelName;
        });
      
    } catch (error) {
      logger.warn('Ollama not available or no models installed', { error: error.message });
    }

    // Construire la liste complète
    const availableList = Object.values(AVAILABLE_MODELS).map(model => ({
      ...model,
      installed: installedModels.includes(model.name)
    }));

    const response = {
      installed: installedModels,
      available: availableList,
      total_available: availableList.length,
      total_installed: installedModels.length,
      ollama_running: installedModels.length > 0 || (await checkOllamaRunning())
    };

    res.json(response);

  } catch (error) {
    logger.error('Failed to list models', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      error: 'Failed to list models',
      message: error.message,
      suggestion: 'Make sure Ollama is installed: https://ollama.ai/download'
    });
  }
});

/**
 * POST /api/models/install
 * Installe un modèle IA
 * 
 * Body: {
 *   model: string (ex: "llama3", "codellama")
 * }
 */
router.post('/api/models/install', verifyToken, async (req, res) => {
  try {
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ 
        error: 'model is required',
        example: { model: 'llama3' }
      });
    }

    // Vérifier que le modèle existe dans la liste
    const modelInfo = AVAILABLE_MODELS[model];
    
    if (!modelInfo) {
      return res.status(404).json({ 
        error: `Model '${model}' not found`,
        available_models: Object.keys(AVAILABLE_MODELS),
        suggestion: 'Check the model name and try again'
      });
    }

    logger.info('Installing model', { 
      user: req.user.username, 
      model,
      size: modelInfo.size
    });

    // Vérifier qu'Ollama est disponible
    const ollamaRunning = await checkOllamaRunning();
    
    if (!ollamaRunning) {
      return res.status(503).json({
        error: 'Ollama service is not running',
        message: 'Please start Ollama first',
        help: {
          install: 'Download from https://ollama.ai/download',
          start: 'Run: ollama serve'
        }
      });
    }

    // Retourner immédiatement avec le statut "installing"
    res.json({
      status: 'installing',
      model: model,
      displayName: modelInfo.displayName,
      size: modelInfo.size,
      command: modelInfo.command,
      estimated_time: '2-10 minutes',
      message: `Installing ${modelInfo.displayName}... This may take a few minutes.`,
      progress_endpoint: `/api/models/install/status/${model}`
    });

    // Installer en arrière-plan
    installModelBackground(model, modelInfo, req.user.username);

  } catch (error) {
    logger.error('Model installation failed', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      error: 'Installation failed',
      message: error.message
    });
  }
});

/**
 * Installation en arrière-plan
 */
async function installModelBackground(model, modelInfo, username) {
  try {
    logger.info('Starting background installation', { model, username });
    
    // Exécuter la commande d'installation
    const { stdout, stderr } = await execPromise(modelInfo.command, {
      timeout: 600000 // 10 minutes timeout
    });
    
    logger.info('Model installed successfully', { 
      model,
      output: stdout,
      username
    });
    
    // TODO: Émettre un événement Socket.io pour notifier l'utilisateur
    
  } catch (error) {
    logger.error('Background installation failed', { 
      model,
      error: error.message,
      username
    });
  }
}

/**
 * DELETE /api/models/remove
 * Supprime un modèle installé
 * 
 * Body: {
 *   model: string
 * }
 */
router.delete('/api/models/remove', verifyToken, async (req, res) => {
  try {
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ 
        error: 'model is required',
        example: { model: 'llama3' }
      });
    }

    logger.info('Removing model', { 
      user: req.user.username,
      model
    });

    // Vérifier qu'Ollama est disponible
    const ollamaRunning = await checkOllamaRunning();
    
    if (!ollamaRunning) {
      return res.status(503).json({
        error: 'Ollama service is not running',
        message: 'Cannot remove model without Ollama'
      });
    }

    // Supprimer le modèle
    try {
      const { stdout } = await execPromise(`ollama rm ${model}`);
      
      logger.info('Model removed successfully', { 
        model,
        output: stdout,
        user: req.user.username
      });

      res.json({
        status: 'success',
        message: `Model '${model}' has been removed`,
        model
      });

    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: `Model '${model}' is not installed`,
          suggestion: 'Use GET /api/models/list to see installed models'
        });
      }
      throw error;
    }

  } catch (error) {
    logger.error('Model removal failed', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      error: 'Removal failed',
      message: error.message
    });
  }
});

/**
 * GET /api/models/install/status/:model
 * Vérifie le statut d'installation d'un modèle
 */
router.get('/api/models/install/status/:model', verifyToken, async (req, res) => {
  try {
    const { model } = req.params;

    // Vérifier si le modèle est installé
    const { stdout } = await execPromise('ollama list');
    const installedModels = stdout.split('\n').slice(1).map(line => {
      const parts = line.split(/\s+/);
      return parts[0]?.split(':')[0];
    }).filter(Boolean);

    const isInstalled = installedModels.includes(model);

    res.json({
      model,
      status: isInstalled ? 'installed' : 'installing',
      installed: isInstalled
    });

  } catch (error) {
    logger.error('Failed to check installation status', { error: error.message });
    res.status(500).json({ 
      error: 'Failed to check status',
      message: error.message
    });
  }
});

/**
 * Vérifie si Ollama est en cours d'exécution
 */
async function checkOllamaRunning() {
  try {
    await axios.get('http://localhost:11434/api/tags', { timeout: 2000 });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = router;
