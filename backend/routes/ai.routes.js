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

// Configuration des routes de modèles - Python Runtime (port 6000)
// All models use the same Python Flask runtime with transformers
const PYTHON_RUNTIME_URL = 'http://localhost:6000';
const PYTHON_RUNTIME_PORT = 6000;

const MODEL_ROUTES = {
  // All models now use Python Flask runtime with HuggingFace transformers
  'qwen2.5-coder': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'Qwen/Qwen2.5-Coder-1.5B-Instruct'
  },
  'qwen-coder': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'Qwen/Qwen2.5-Coder-1.5B-Instruct'
  },
  'deepseek-coder': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'deepseek-ai/deepseek-coder-1.3b-instruct'
  },
  'phi-2': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'microsoft/phi-2'
  },
  'qwen2-chat': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'Qwen/Qwen2-1.5B-Instruct'
  },
  'default': {
    url: `${PYTHON_RUNTIME_URL}/infer`,
    healthUrl: `${PYTHON_RUNTIME_URL}/health`,
    type: 'python-runtime',
    port: PYTHON_RUNTIME_PORT,
    modelId: 'auto'  // Let runtime use its loaded model
  }
};

// Modèles par défaut si aucun n'est spécifié
const DEFAULT_MODEL = 'default';

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
    const checkUrl = modelConfig.healthUrl || `http://localhost:${modelConfig.port}/health`;
    
    logger.info('Checking model availability', { 
      model: modelName, 
      url: checkUrl 
    });
    
    const response = await axios.get(checkUrl, { 
      timeout: 3000,
      validateStatus: (status) => status === 200
    });
    
    // For Python runtime, check if it's healthy
    if (modelConfig.type === 'python-runtime') {
      const isHealthy = response.data && response.data.status === 'healthy';
      logger.info('Python runtime health check', {
        model: modelName,
        healthy: isHealthy,
        loaded: response.data?.model?.loaded,
        modelName: response.data?.model?.name
      });
      return isHealthy;
    }
    
    return true;
  } catch (error) {
    logger.warn('Model availability check failed', {
      model: modelName,
      error: error.message,
      code: error.code
    });
    return false;
  }
}

// Fallback chain pour les modèles - Python runtime models
const FALLBACK_CHAIN = ['default', 'qwen2.5-coder', 'phi-2', 'qwen2-chat'];

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
          error: 'Python AI Runtime not available',
          message: 'The Python AI runtime is not responding. Please ensure runtime.exe is running.',
          tried_models: [selectedModel, ...FALLBACK_CHAIN],
          runtime_url: PYTHON_RUNTIME_URL,
          runtime_port: PYTHON_RUNTIME_PORT,
          help: {
            windows: 'Start runtime with: runtime.exe',
            manual: `Check if Python runtime is running on port ${PYTHON_RUNTIME_PORT}`,
            health_check: `${PYTHON_RUNTIME_URL}/health`
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

    // Appeler le modèle IA via Python Runtime
    let reply, requestData, response;
    
    if (modelConfig.type === 'python-runtime') {
      // Python Flask Runtime API format
      // The runtime expects: { input/prompt/message, max_tokens, temperature, stream }
      requestData = {
        message: prompt,        // Primary field
        prompt: prompt,         // Fallback field
        input: prompt,          // Fallback field
        max_tokens: 512,
        temperature: 0.7,
        stream: false
      };
      
      logger.info('Calling Python runtime', {
        url: modelConfig.url,
        promptLength: prompt.length,
        model: selectedModel
      });
      
      try {
        response = await axios.post(modelConfig.url, requestData, {
          timeout: 120000,  // 120 seconds for model inference (AI routes require 120s+)
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          validateStatus: (status) => status >= 200 && status < 300
        });
        
        logger.info('Python runtime response received', {
          status: response.status,
          hasReply: !!response.data?.reply,
          dataKeys: Object.keys(response.data || {})
        });
        
        // Python runtime returns: { reply, model, latency, tokens, ... }
        reply = response.data.reply || response.data.text || response.data.response || 'No response from model';
        
        // If mock mode, add warning
        if (response.data.mock) {
          logger.warn('Python runtime in MOCK MODE - no model loaded', {
            model: selectedModel
          });
          reply = `⚠️ AI Runtime in Mock Mode\n\n${reply}\n\nℹ️ To enable real AI responses, ensure a model is loaded in the Python runtime.`;
        }
        
      } catch (error) {
        logger.error('Python runtime request failed', { 
          error: error.message,
          code: error.code,
          response: error.response?.data,
          status: error.response?.status,
          model: selectedModel,
          url: modelConfig.url
        });
        
        // Provide helpful error message
        if (error.code === 'ECONNREFUSED') {
          throw new Error(`Python runtime not running on port ${modelConfig.port}. Please start runtime.exe`);
        } else if (error.code === 'ETIMEDOUT') {
          throw new Error('Python runtime timeout - model inference took too long');
        } else {
          throw error;
        }
      }
      
    } else {
      // Fallback for unknown types
      throw new Error(`Unsupported model type: ${modelConfig.type}`);
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
      suggestion: 'Check if Python AI runtime (runtime.exe) is running',
      runtime_url: PYTHON_RUNTIME_URL,
      help: `Test runtime health at: ${PYTHON_RUNTIME_URL}/health`
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
 * Vérifie la santé des services IA - Python Runtime
 */
router.get('/api/ai/health', verifyToken, async (req, res) => {
  const health = {
    timestamp: new Date().toISOString(),
    services: {
      python_runtime: {
        url: PYTHON_RUNTIME_URL,
        port: PYTHON_RUNTIME_PORT,
        status: 'checking',
        type: 'Flask + HuggingFace Transformers'
      }
    },
    models_available: 0,
    models_total: Object.keys(MODEL_ROUTES).length,
    runtime_info: null
  };

  // Check Python Runtime
  try {
    const response = await axios.get(`${PYTHON_RUNTIME_URL}/health`, { timeout: 3000 });
    health.services.python_runtime.status = 'online';
    health.runtime_info = response.data;
    
    // Check if a model is loaded
    if (response.data?.model?.loaded) {
      health.model_loaded = true;
      health.loaded_model = response.data.model.name;
      health.device = response.data.model.device;
    } else {
      health.model_loaded = false;
      health.warning = 'Runtime is running but no AI model is loaded (mock mode)';
    }
    
  } catch (error) {
    health.services.python_runtime.status = 'offline';
    health.services.python_runtime.error = error.message;
    health.services.python_runtime.code = error.code;
    
    if (error.code === 'ECONNREFUSED') {
      health.services.python_runtime.help = 'Start runtime with: runtime.exe';
    }
  }

  // Count available models (will be 0 if runtime is down)
  for (const [modelName, modelConfig] of Object.entries(MODEL_ROUTES)) {
    const isAvailable = await checkModelAvailability(modelName, modelConfig);
    if (isAvailable) health.models_available++;
  }

  health.overall_status = health.models_available > 0 ? 'operational' : 'degraded';

  res.json(health);
});

module.exports = router;
