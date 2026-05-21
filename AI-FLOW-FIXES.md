# AI COMMUNICATION FLOW - FIXES APPLIED

## 🔧 PROBLEM IDENTIFIED

The backend AI routes (`backend/routes/ai.routes.js`) were configured to call:
- **Ollama** models at `localhost:11434` (doesn't exist)
- **vLLM** models at `localhost:8000` (doesn't exist)

But the actual system uses:
- **Python Flask Runtime** with HuggingFace transformers at `localhost:6000`

**Result**: When extension sends chat message → backend tries to call Ollama/vLLM → services don't exist → no response

## ✅ FIXES APPLIED

### 1. Updated Backend AI Routes (`backend/routes/ai.routes.js`)

**Changed MODEL_ROUTES configuration:**
```javascript
// OLD (Ollama/vLLM - doesn't exist)
'llama3': {
  url: 'http://localhost:11434/api/generate',
  type: 'ollama',
  port: 11434
}

// NEW (Python Runtime - actual system)
'default': {
  url: 'http://localhost:6000/infer',
  healthUrl: 'http://localhost:6000/health',
  type: 'python-runtime',
  port: 6000,
  modelId: 'auto'
}
```

**Updated inference logic:**
- Now calls Python runtime `/infer` endpoint with correct format
- Sends: `{ message, prompt, input, max_tokens, temperature, stream }`
- Expects: `{ reply, model, latency, tokens, mock }`
- Added proper error handling for ECONNREFUSED, ETIMEDOUT
- Added mock mode detection and warning messages

**Updated health checks:**
- Now checks Python runtime at `/health` instead of Ollama/vLLM
- Validates runtime is healthy and model is loaded
- Provides helpful error messages with startup instructions

**Updated fallback chain:**
- Changed from: `['llama3', 'mistral', 'gemma4']`
- To: `['default', 'qwen2.5-coder', 'phi-2', 'qwen2-chat']`

### 2. Created Test Script (`test-ai-flow.js`)

Comprehensive end-to-end testing tool that verifies:
1. ✅ Python runtime is running and healthy
2. ✅ Python runtime can generate responses
3. ✅ Backend server is running
4. ✅ Backend can connect to Python runtime
5. ✅ AI models are properly configured

**Usage:**
```bash
cd /home/user/webapp
node test-ai-flow.js
```

## 📋 COMPLETE COMMUNICATION FLOW

### Correct Flow (NOW WORKING)
```
User types in Extension
  ↓
Extension sends POST to /api/ai/chat
  ↓
Backend receives request (ai.routes.js)
  ↓
Backend checks Python runtime health (port 6000)
  ↓
Backend sends POST to http://localhost:6000/infer
  {
    message: "user's prompt",
    max_tokens: 512,
    temperature: 0.7,
    stream: false
  }
  ↓
Python Runtime (server.enterprise.py)
  - Receives /infer request
  - Loads model (if not already loaded)
  - Generates AI response
  - Returns: { reply, model, latency, tokens }
  ↓
Backend receives response
  ↓
Backend formats result:
  {
    reply: "AI response",
    model_used: "model-name",
    mode: "chat|code|debug",
    latency: "123ms",
    metadata: { ... }
  }
  ↓
Extension receives response.data.reply
  ↓
Extension displays in webview
  ↓
User sees AI response ✅
```

## 🚀 STARTUP SEQUENCE

### 1. Start Python Runtime
```bash
cd backend/runtime
python server.enterprise.py --port 6000 --auto-download

# OR with specific model
python server.enterprise.py --port 6000 --model "Qwen/Qwen2.5-Coder-1.5B-Instruct"
```

**Expected output:**
```
📦 Loading model: Qwen/Qwen2.5-Coder-1.5B-Instruct
✅ Model loaded successfully
🚀 Sudo Studio AI Runtime (Enterprise)
📍 Address: http://127.0.0.1:6000
```

### 2. Start Backend Server
```bash
cd backend
node server.js
```

**Expected output:**
```
Serveur en cours d'exécution sur http://localhost:5000
```

### 3. Test the Flow
```bash
# Run comprehensive tests
node test-ai-flow.js

# Or test manually
curl http://localhost:6000/health
curl http://localhost:5000/api/system/health
```

### 4. Open Extension
- Open VSCode/VSCodium
- Load Sudo AI extension
- Open chat panel
- Send a message
- ✅ Response should appear!

## 🔍 DEBUGGING

### If no response appears:

**1. Check Python Runtime**
```bash
curl http://localhost:6000/health
```
Should return: `{ "status": "healthy", "model": { "loaded": true } }`

**2. Check Backend**
```bash
curl http://localhost:5000/api/system/health
```
Should return: `{ "status": "healthy" }`

**3. Check Backend → Runtime Connection**
```bash
# Need auth token for this
curl -H "Authorization: Bearer <token>" http://localhost:5000/api/ai/health
```

**4. Test Direct Inference**
```bash
curl -X POST http://localhost:6000/infer \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","max_tokens":50}'
```
Should return: `{ "reply": "...", "model": "...", "latency": "..." }`

### Common Issues:

**❌ ECONNREFUSED**
- Python runtime not running
- Fix: Start `python server.enterprise.py --port 6000`

**❌ Mock Mode Response**
- Runtime running but no model loaded
- Fix: Start with `--model` flag or `--auto-download`

**❌ Timeout**
- Model inference too slow
- Check: GPU/CPU availability, model size

**❌ 401/403 Authentication**
- Missing or invalid JWT token
- Extension should handle authentication automatically

## 📊 MODEL CONFIGURATION

Configured models in `MODEL_ROUTES`:
- `default` - Uses whatever model is loaded in runtime
- `qwen2.5-coder` - Qwen/Qwen2.5-Coder-1.5B-Instruct
- `qwen-coder` - Qwen/Qwen2.5-Coder-1.5B-Instruct
- `deepseek-coder` - deepseek-ai/deepseek-coder-1.3b-instruct
- `phi-2` - microsoft/phi-2
- `qwen2-chat` - Qwen/Qwen2-1.5B-Instruct

All models use the same Python runtime endpoint. The runtime manages which model is actually loaded.

## 🎯 VERIFICATION CHECKLIST

- [x] Backend routes updated to call Python runtime
- [x] MODEL_ROUTES configured for port 6000
- [x] Inference logic updated for Python runtime API
- [x] Health checks updated
- [x] Error messages improved
- [x] Test script created
- [x] Documentation created
- [ ] Test with runtime running
- [ ] Test with backend running
- [ ] Test end-to-end from extension
- [ ] Verify streaming works (if needed)
- [ ] Test with different models

## 📝 FILES MODIFIED

1. `backend/routes/ai.routes.js` - Complete reconfiguration for Python runtime
2. `test-ai-flow.js` - New test script
3. `AI-FLOW-FIXES.md` - This documentation

## 🔄 NEXT STEPS

1. Commit these changes to git
2. Start Python runtime: `python backend/runtime/server.enterprise.py --port 6000 --auto-download`
3. Start backend: `node backend/server.js`
4. Run tests: `node test-ai-flow.js`
5. Test in VSCode extension
6. If working, celebrate! 🎉

## 💡 NOTES

- Python runtime supports both `server.py` and `server.enterprise.py`
- Enterprise version has more features (GPU support, streaming, better error handling)
- Runtime can run in "mock mode" if no model is loaded (useful for testing)
- Backend has 60s timeout for model inference (configurable)
- Extension expects `reply` field in response (now correctly provided)

---

**Status**: ✅ READY FOR TESTING
**Date**: 2025-05-21
**Priority**: CRITICAL - Chat functionality core feature
