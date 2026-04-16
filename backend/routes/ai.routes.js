const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth.middleware');

/**
 * PHASE 3 - BACKEND IA LOCAL
 * Module de chat AI avec support multi-modèles
 * Support: Ollama, vLLM, DeepSeek, et autres modèles locaux
 */

// Configuration des routes de modèles
const MODEL_ROUTES = {
  // Ollama models (port 11434)
  'gemma4': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'mistral': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'mixtral': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'llama3': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'llama3.1': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'llama3.2': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'codellama': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'qwen-coder': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  'qwen2.5-coder': {
    url: 'http://localhost:11434/api/generate',
    type: 'ollama',
    port: 11434
  },
  // DeepSeek / vLLM models (port 8000)
  'deepseek-coder': {
    url: 'http://localhost:8000/v1/completions',
    type: 'vllm',
    port: 8000
  },
  'deepseek-coder-v2': {
    url: 'http://localhost:8000/v1/completions',
    type: 'vllm',
    port: 8000
  }
};

// Modèles par défaut si aucun n'est spécifié
const DEFAULT_MODEL = 'llama3';

// Détecter le mode de conversation
function detectMode(message, context = '') {
  const lowerMessage = message.toLowerCase();
  const codeKeywords = ['code', 'function', 'class', 'variable', 'debug', 'fix', 'error', 'bug'];
  const debugKeywords = ['debug', 'error', 'fix', 'issue', 'problem', 'crash', 'fail'];
  
  if (context && context.includes('```')) {
    return 'code';
  }
  
  if (debugKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return 'debug';
  }
  
  if (codeKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return 'code';
  }
  
  return 'chat';
}

// Vérifier si un modèle est disponible
async function checkModelAvailability(modelName, modelConfig) {
  try {
    const checkUrl = modelConfig.type === 'ollama' 
      ? `http://localhost:${modelConfig.port}/api/tags`
      : `http://localhost:${modelConfig.port}/health`;
    
    await axios.get(checkUrl, { timeout: 2000 });
    return true;
  } catch (error) {
    return false;
  }
}

// Fallback chain pour les modèles
const FALLBACK_CHAIN = ['llama3', 'mistral', 'gemma4', 'codellama'];

/**
 * POST /api/ai/chat
 * Endpoint principal de chat avec IA
 * 
 * Body: {
 *   message: string,
 *   model: string (optionnel),
 *   context: string (optionnel, code context),
 *   stream: boolean (optionnel)
 * }
 */
router.post('/api/ai/chat', verifyToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { message, model, context = '', stream = false } = req.body;

    if (!message) {
      return res.status(400).json({ 
        error: 'message is required',
        example: {
          message: 'Explain async/await in JavaScript',
          model: 'llama3',
          context: 'optional code context'
        }
      });
    }

    // Détecter le mode
    const mode = detectMode(message, context);

    // Sélectionner le modèle
    let selectedModel = model || DEFAULT_MODEL;
    let modelConfig = MODEL_ROUTES[selectedModel];

    if (!modelConfig) {
      logger.warn(`Model ${selectedModel} not found, using default`, { requested: selectedModel });
      selectedModel = DEFAULT_MODEL;
      modelConfig = MODEL_ROUTES[DEFAULT_MODEL];
    }

    logger.info('AI chat request received', {
      user: req.user.username,
      model: selectedModel,
      mode,
      message_length: message.length,
      has_context: context.length > 0
    });

    // Vérifier disponibilité du modèle
    const isAvailable = await checkModelAvailability(selectedModel, modelConfig);
    
    if (!isAvailable) {
      // Essayer les fallback models
      logger.warn(`Model ${selectedModel} unavailable, trying fallbacks`, { model: selectedModel });
      
      let fallbackFound = false;
      for (const fallbackModel of FALLBACK_CHAIN) {
        if (fallbackModel === selectedModel) continue;
        
        const fallbackConfig = MODEL_ROUTES[fallbackModel];
        const fallbackAvailable = await checkModelAvailability(fallbackModel, fallbackConfig);
        
        if (fallbackAvailable) {
          selectedModel = fallbackModel;
          modelConfig = fallbackConfig;
          fallbackFound = true;
          logger.info(`Using fallback model: ${fallbackModel}`);
          break;
        }
      }
      
      if (!fallbackFound) {
        return res.status(503).json({
          error: 'No AI models available',
          message: 'All AI models are currently unavailable. Please ensure Ollama or vLLM is running.',
          tried_models: [model, ...FALLBACK_CHAIN],
          help: {
            ollama: 'Start Ollama with: ollama serve',
            vllm: 'Start vLLM with: python -m vllm.entrypoints.api_server'
          }
        });
      }
    }

    // Construire le prompt selon le mode
    let prompt = message;
    if (context) {
      prompt = mode === 'code' || mode === 'debug'
        ? `Context:\n\`\`\`\n${context}\n\`\`\`\n\nQuestion: ${message}`
        : `${message}\n\nContext: ${context}`;
    }

    // Appeler le modèle IA
    let reply, requestData, response;
    
    if (modelConfig.type === 'ollama') {
      // Ollama API format
      requestData = {
        model: selectedModel,
        prompt: prompt,
        stream: false
      };
      
      try {
        response = await axios.post(modelConfig.url, requestData, {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        });
        
        reply = response.data.response || response.data.text || 'No response from model';
      } catch (error) {
        logger.error('Ollama request failed', { 
          error: error.message,
          model: selectedModel,
          url: modelConfig.url
        });
        throw error;
      }
      
    } else if (modelConfig.type === 'vllm') {
      // vLLM / OpenAI-compatible API format
      requestData = {
        model: selectedModel,
        prompt: prompt,
        max_tokens: 1000,
        temperature: 0.7
      };
      
      try {
        response = await axios.post(modelConfig.url, requestData, {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        });
        
        reply = response.data.choices?.[0]?.text || 'No response from model';
      } catch (error) {
        logger.error('vLLM request failed', { 
          error: error.message,
          model: selectedModel,
          url: modelConfig.url
        });
        throw error;
      }
    }

    const latency = Date.now() - startTime;

    const result = {
      reply,
      model_used: selectedModel,
      mode,
      latency: `${latency}ms`,
      timestamp: new Date().toISOString(),
      metadata: {
        message_length: message.length,
        reply_length: reply.length,
        has_context: context.length > 0,
        context_length: context.length
      }
    };

    logger.info('AI chat completed', {
      user: req.user.username,
      model: selectedModel,
      mode,
      latency,
      reply_length: reply.length
    });

    res.json(result);

  } catch (error) {
    const latency = Date.now() - startTime;
    
    logger.error('AI chat failed', { 
      error: error.message,
      stack: error.stack,
      latency
    });
    
    res.status(500).json({ 
      error: 'AI processing failed',
      message: error.message,
      latency: `${latency}ms`,
      suggestion: 'Check if AI model services (Ollama/vLLM) are running'
    });
  }
});

/**
 * GET /api/ai/models
 * Liste tous les modèles AI disponibles
 */
router.get('/api/ai/models', verifyToken, async (req, res) => {
  try {
    const models = [];

    // Vérifier chaque modèle
    for (const [modelName, modelConfig] of Object.entries(MODEL_ROUTES)) {
      const isAvailable = await checkModelAvailability(modelName, modelConfig);
      
      models.push({
        name: modelName,
        type: modelConfig.type,
        port: modelConfig.port,
        url: modelConfig.url,
        available: isAvailable,
        status: isAvailable ? 'online' : 'offline',
        recommended_for: modelName.includes('coder') ? 'code' : 'general'
      });
    }

    const onlineCount = models.filter(m => m.available).length;

    res.json({
      total: models.length,
      online: onlineCount,
      offline: models.length - onlineCount,
      default_model: DEFAULT_MODEL,
      fallback_chain: FALLBACK_CHAIN,
      models: models.sort((a, b) => {
        if (a.available && !b.available) return -1;
        if (!a.available && b.available) return 1;
        return a.name.localeCompare(b.name);
      })
    });

  } catch (error) {
    logger.error('Failed to list AI models', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai/code/explain
 * Explique du code
 */
router.post('/api/ai/code/explain', verifyToken, async (req, res) => {
  const { code, model = 'qwen2.5-coder' } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  req.body.message = `Explain this code:\n\n${code}`;
  req.body.model = model;
  req.body.context = code;
  
  // Réutiliser l'endpoint chat
  return router.stack.find(r => r.route && r.route.path === '/api/ai/chat').route.stack[1].handle(req, res);
});

/**
 * POST /api/ai/code/fix
 * Corrige du code
 */
router.post('/api/ai/code/fix', verifyToken, async (req, res) => {
  const { code, error, model = 'deepseek-coder-v2' } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  const message = error 
    ? `Fix this code. Error: ${error}\n\nCode:\n${code}`
    : `Fix and improve this code:\n\n${code}`;

  req.body.message = message;
  req.body.model = model;
  req.body.context = code;
  
  return router.stack.find(r => r.route && r.route.path === '/api/ai/chat').route.stack[1].handle(req, res);
});

/**
 * GET /api/ai/health
 * Vérifie la santé des services IA
 */
router.get('/api/ai/health', verifyToken, async (req, res) => {
  const health = {
    timestamp: new Date().toISOString(),
    services: {
      ollama: {
        port: 11434,
        status: 'checking'
      },
      vllm: {
        port: 8000,
        status: 'checking'
      }
    },
    models_available: 0,
    models_total: Object.keys(MODEL_ROUTES).length
  };

  // Check Ollama
  try {
    await axios.get('http://localhost:11434/api/tags', { timeout: 2000 });
    health.services.ollama.status = 'online';
  } catch (error) {
    health.services.ollama.status = 'offline';
    health.services.ollama.error = error.message;
  }

  // Check vLLM
  try {
    await axios.get('http://localhost:8000/health', { timeout: 2000 });
    health.services.vllm.status = 'online';
  } catch (error) {
    health.services.vllm.status = 'offline';
    health.services.vllm.error = error.message;
  }

  // Count available models
  for (const [modelName, modelConfig] of Object.entries(MODEL_ROUTES)) {
    const isAvailable = await checkModelAvailability(modelName, modelConfig);
    if (isAvailable) health.models_available++;
  }

  health.overall_status = health.models_available > 0 ? 'operational' : 'degraded';

  res.json(health);
});

module.exports = router;
