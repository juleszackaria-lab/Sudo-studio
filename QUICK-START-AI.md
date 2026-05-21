# 🚀 QUICK START - AI CHAT FUNCTIONALITY

## ✅ FIXES COMMITTED

All fixes have been committed and pushed to the `main` branch.

**Commit**: `e310b24` - 🔧 FIX: AI Chat Communication Flow - Backend ⇄ Python Runtime

## 🎯 WHAT WAS FIXED

**Problem**: Backend was calling Ollama/vLLM (ports 11434/8000) which don't exist
**Solution**: Reconfigured backend to call Python Flask runtime (port 6000)

The AI chat communication pipeline is now correctly configured:
```
Extension → Backend (port 5000) → Python Runtime (port 6000) → AI Model → Response
```

## 🏃 START THE SYSTEM (3 STEPS)

### Step 1: Start Python AI Runtime
```bash
cd backend/runtime
python server.enterprise.py --port 6000 --auto-download
```

**What it does**:
- Starts Flask server on port 6000
- Auto-downloads a lightweight AI model (~1.5GB)
- Loads model into memory (CPU or GPU)
- Provides /infer and /health endpoints

**Expected output**:
```
📦 Loading model: Qwen/Qwen2.5-Coder-1.5B-Instruct
✅ Model loaded successfully
🚀 Sudo Studio AI Runtime (Enterprise)
📍 Address: http://127.0.0.1:6000
```

**Leave this terminal running!**

### Step 2: Start Backend Server
Open a new terminal:
```bash
cd backend
node server.js
```

**Expected output**:
```
Serveur en cours d'exécution sur http://localhost:5000
```

**Leave this terminal running!**

### Step 3: Test the System
Open a third terminal:
```bash
node test-ai-flow.js
```

**Expected output**:
```
✅ PASS - Runtime Health
✅ PASS - Model Loaded
✅ PASS - Direct Inference
✅ PASS - Backend Health
✅ PASS - Backend AI Health Endpoint

🎉 ALL TESTS PASSED! AI pipeline is ready!
```

## 💬 TEST IN EXTENSION

1. Open VSCode or VSCodium
2. Load the Sudo AI extension (F5 to debug or install from VSIX)
3. Open the AI chat panel (Ctrl+Shift+P → "Sudo AI: Open Chat")
4. Type a message: "Hello, can you help me with Python?"
5. ✅ **You should receive an AI response!**

## 🔍 TROUBLESHOOTING

### No response in chat?

**1. Check Python Runtime**
```bash
curl http://localhost:6000/health
```
Should return: `{ "status": "healthy", "model": { "loaded": true } }`

If not running: Go back to Step 1

**2. Check Backend**
```bash
curl http://localhost:5000/api/system/health
```
Should return: `{ "status": "healthy" }`

If not running: Go back to Step 2

**3. Test Direct Inference**
```bash
curl -X POST http://localhost:6000/infer \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello world","max_tokens":50}'
```

Should return an AI response.

**4. Check Extension Logs**
- Open VSCode Developer Tools: Help → Toggle Developer Tools
- Look for errors in Console
- Check Network tab for failed requests

### Common Issues

**"ECONNREFUSED" error**
- Python runtime not started
- Solution: Start with `python server.enterprise.py --port 6000`

**"Mock mode" response**
- Runtime running but no model loaded
- Solution: Restart runtime with `--auto-download` flag

**Slow first response**
- Model loading for first time (normal)
- Subsequent responses will be faster

**Out of memory**
- Model too large for your system
- Try smaller model or increase swap space

## 📊 SYSTEM REQUIREMENTS

**Minimum**:
- 4GB RAM
- 5GB disk space (for model)
- Python 3.8+
- Node.js 16+

**Recommended**:
- 8GB RAM
- GPU (CUDA/MPS) for faster inference
- SSD for faster model loading

## 📚 DOCUMENTATION

- **Complete fixes**: See `AI-FLOW-FIXES.md`
- **Test script**: Run `node test-ai-flow.js`
- **Backend routes**: `backend/routes/ai.routes.js`
- **Python runtime**: `backend/runtime/server.enterprise.py`

## 🎉 SUCCESS CRITERIA

✅ Python runtime running on port 6000
✅ Backend server running on port 5000
✅ test-ai-flow.js passes all tests
✅ Extension chat receives AI responses
✅ No errors in console logs

---

**Status**: ✅ READY TO USE
**Next**: Start the system and test the chat!
