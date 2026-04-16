# 🚀 SUDO STUDIO - QUICK START GUIDE

**Version:** 1.0 (God Mode)  
**Last Updated:** 2026-04-16

---

## ⚡ 5-MINUTE SETUP

### Step 1: Start the Backend (30 seconds)

```bash
cd /home/user/webapp/backend
npm install  # If first time
npm start
```

**Expected Output:**
```
Serveur en cours d'exécution sur http://localhost:5000
```

**Verify:**
```bash
curl http://localhost:5000/api/system/status
```

---

### Step 2: Start AI Services (2 minutes)

**Choose ONE option:**

#### Option A: Ollama (Recommended for most users)

```bash
# Start Ollama server
ollama serve

# In another terminal, pull models
ollama pull llama3
ollama pull codellama
ollama pull qwen2.5-coder
```

**Verify Ollama:**
```bash
curl http://localhost:11434/api/tags
```

#### Option B: vLLM (For advanced users with GPU)

```bash
pip install vllm

# Start vLLM with DeepSeek Coder
python -m vllm.entrypoints.api_server \
  --model deepseek-ai/deepseek-coder-v2 \
  --port 8000
```

**Verify vLLM:**
```bash
curl http://localhost:8000/health
```

---

### Step 3: Install Extension (2 minutes)

```bash
cd /home/user/webapp/sudo-ai-extension

# Install dependencies
npm install

# Package extension (install vsce if needed)
npm install -g vsce
vsce package

# Install in VSCodium
code --install-extension sudo-ai-1.0.0.vsix
```

**Alternative (Development Mode):**
1. Open VSCodium
2. File → Open Folder → `/home/user/webapp/sudo-ai-extension`
3. Press `F5` to launch in debug mode

---

### Step 4: Configure & Test (30 seconds)

1. Open VSCodium Settings (`Ctrl+,`)
2. Search for "Sudo AI"
3. Verify:
   - `sudoAi.backendUrl`: `http://localhost:5000`
   - `sudoAi.defaultModel`: `llama3`

4. Test commands:
   - Press `Ctrl+Shift+P`
   - Type "Sudo AI"
   - Try "Sudo AI: Ask Question"

---

## 🎯 USAGE EXAMPLES

### Example 1: Explain Code

1. Open a JavaScript file
2. Select a function:
   ```javascript
   async function fetchData() {
     const response = await fetch('/api/data');
     return response.json();
   }
   ```
3. Right-click → "Sudo AI: Explain Code"
4. Get explanation in side panel

---

### Example 2: Fix Code

1. Select buggy code:
   ```javascript
   function add(a, b) {
     return a + b
   }
   console.log(add(1, "2")); // Bug: type coercion
   ```
2. Run "Sudo AI: Fix Code"
3. Get corrected version with explanation

---

### Example 3: Generate Code

1. Run "Sudo AI: Generate Code"
2. Enter: "Create a React component for a user profile card"
3. Get generated component code

---

### Example 4: Chat with AI

1. Run "Sudo AI: Open Chat"
2. Ask questions:
   - "How do I use Redux?"
   - "What's the difference between let and const?"
   - "Explain promises vs async/await"

---

## 📚 API QUICK REFERENCE

### Check System Status
```bash
GET http://localhost:5000/api/system/status
```

### List AI Models
```bash
GET http://localhost:5000/api/ai/models
```

### Chat with AI
```bash
POST http://localhost:5000/api/ai/chat
Content-Type: application/json

{
  "message": "Explain async/await",
  "model": "llama3",
  "context": "optional code context"
}
```

### Analyze Project
```bash
POST http://localhost:5000/api/project/analyze
Content-Type: application/json

{
  "projectPath": "/path/to/project",
  "deep": true
}
```

### Auto-Fix Project
```bash
POST http://localhost:5000/api/project/auto-fix
Content-Type: application/json

{
  "projectPath": "/path/to/project",
  "issues": ["all"]
}
```

### Simulate Load Test
```bash
POST http://localhost:5000/api/devops/simulate
Content-Type: application/json

{
  "scenario": "load",
  "duration": 60,
  "intensity": "medium"
}
```

---

## 🔧 TROUBLESHOOTING

### Problem: "Cannot connect to backend"

**Solution:**
```bash
# Check if backend is running
curl http://localhost:5000/api/system/status

# If not, start it
cd /home/user/webapp/backend
npm start
```

---

### Problem: "No AI models available"

**Solution:**
```bash
# Check Ollama
curl http://localhost:11434/api/tags

# If error, start Ollama
ollama serve

# Pull models
ollama pull llama3
```

---

### Problem: "Extension not found"

**Solution:**
1. Check extension installed:
   ```bash
   code --list-extensions | grep sudo-ai
   ```

2. Reinstall:
   ```bash
   cd /home/user/webapp/sudo-ai-extension
   vsce package
   code --install-extension sudo-ai-1.0.0.vsix
   ```

---

### Problem: "401 Unauthorized" on API calls

**Solution:**

The new API routes require JWT authentication. Get a token first:

```bash
# Login to get JWT token
curl -X POST http://localhost:5000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response: {"token":"eyJhbGc..."}

# Use token in subsequent requests
curl http://localhost:5000/api/ai/models \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

**For Extension:**
The extension will handle authentication automatically once configured.

---

## 🎓 LEARNING PATH

### Beginner
1. Start with simple commands (Explain Code, Ask Question)
2. Try different AI models
3. Experiment with code generation

### Intermediate
4. Use Auto-Fix for project maintenance
5. Try DevOps simulation
6. Explore Project Analysis

### Advanced
7. Integrate into CI/CD pipeline
8. Customize AI model selection per task
9. Build custom workflows with API

---

## 🌟 BEST PRACTICES

### 1. Choose the Right Model
- **General questions:** llama3, mistral
- **Code generation:** codellama, qwen2.5-coder
- **Code understanding:** deepseek-coder-v2
- **Fast responses:** mistral, gemma4

### 2. Provide Context
Always select relevant code before using "Explain" or "Fix" commands.

### 3. Start Small
Test with simple prompts before complex tasks.

### 4. Monitor Resources
AI models are resource-intensive. Check CPU/memory usage.

---

## 📊 SYSTEM REQUIREMENTS

### Minimum
- **CPU:** 4 cores
- **RAM:** 8 GB
- **Disk:** 20 GB free
- **OS:** Linux, macOS, Windows (WSL)

### Recommended
- **CPU:** 8+ cores
- **RAM:** 16 GB+
- **GPU:** NVIDIA (for vLLM)
- **Disk:** 50 GB+ SSD

---

## 🔗 USEFUL COMMANDS

### Backend
```bash
# Start backend
npm start

# Development mode (nodemon)
npm run dev

# Run tests
npm test

# Check health
curl http://localhost:5000/api/health
```

### Ollama
```bash
# Start server
ollama serve

# List models
ollama list

# Pull model
ollama pull <model-name>

# Run model
ollama run <model-name>
```

### Extension
```bash
# Install dependencies
npm install

# Package
vsce package

# Install in VSCodium
code --install-extension sudo-ai-1.0.0.vsix

# Uninstall
code --uninstall-extension sudo-ai
```

---

## 📖 DOCUMENTATION

- **Full Report:** `/GOD_MODE_IMPLEMENTATION_REPORT.md`
- **Extension README:** `/sudo-ai-extension/README.md`
- **Backend Tests:** `/backend/FINAL_BACKEND_HEALTH_REPORT.md`
- **Deployment Guide:** `/backend/DEPLOYMENT_GUIDE.md`

---

## 🎉 YOU'RE READY!

Start coding with AI assistance:

1. ✅ Backend running
2. ✅ AI models loaded
3. ✅ Extension installed
4. ✅ Configuration set

**Press `Ctrl+Shift+P` → "Sudo AI: Ask Question" to begin!**

---

**Need Help?** Check the full documentation or open an issue on GitHub.

**Enjoy Sudo Studio God Mode! 🚀⚡**
