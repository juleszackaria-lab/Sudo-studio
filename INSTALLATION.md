# 📦 Sudo Studio Enterprise - Installation Guide

## Complete Step-by-Step Installation

---

## 📋 System Requirements

### Minimum Requirements
- **OS**: Windows 10, macOS 10.14, or Linux (Ubuntu 18.04+)
- **RAM**: 8 GB
- **Storage**: 10 GB free space
- **CPU**: Dual-core processor
- **VSCode**: 1.80.0 or higher

### Recommended Requirements
- **OS**: Windows 11, macOS 12+, or Linux (Ubuntu 22.04+)
- **RAM**: 16 GB or more
- **Storage**: 20 GB SSD
- **CPU**: Quad-core processor or better
- **GPU**: NVIDIA CUDA-compatible (optional, for acceleration)
- **VSCode**: Latest version

---

## 🚀 Quick Installation (5 Minutes)

### Step 1: Clone Repository

```bash
git clone https://github.com/juleszackaria-lab/Sudo-studio.git
cd Sudo-studio
```

### Step 2: Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Python Runtime:**
```bash
cd backend/runtime
pip install -r requirements.txt
```

**Extension:**
```bash
cd sudo-ai-extension
npm install
```

### Step 3: Start Services

**Terminal 1 - Backend:**
```bash
cd backend
node server.js
```

**Terminal 2 - Python Runtime:**
```bash
cd backend/runtime
python server.enterprise.py
```

### Step 4: Install Extension

**Option A - Development Mode:**
```bash
cd sudo-ai-extension
code .
# Press F5 to launch Extension Development Host
```

**Option B - Package and Install:**
```bash
cd sudo-ai-extension
npm run package
# Install the generated .vsix file in VSCode
```

### Step 5: Verify Installation

1. Open VSCode
2. Look for Sudo Studio icon (robot) in Activity Bar
3. Open AI Chat
4. Send test message: "Hello!"
5. ✅ You should receive AI response

---

## 📖 Detailed Installation Guide

### Prerequisites Installation

#### Windows

**1. Install Node.js:**
- Download from [nodejs.org](https://nodejs.org/)
- Choose LTS version (18.x or higher)
- Run installer, accept defaults
- Verify: `node --version`

**2. Install Python:**
- Download from [python.org](https://www.python.org/)
- Choose 3.10 or higher
- ✅ Check "Add Python to PATH"
- Run installer
- Verify: `python --version`

**3. Install Git:**
- Download from [git-scm.com](https://git-scm.com/)
- Run installer, accept defaults
- Verify: `git --version`

**4. Install VSCode:**
- Download from [code.visualstudio.com](https://code.visualstudio.com/)
- Run installer
- Launch VSCode

#### macOS

**1. Install Homebrew (if not installed):**
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**2. Install Dependencies:**
```bash
brew install node
brew install python@3.10
brew install git
brew install --cask visual-studio-code
```

**3. Verify Installations:**
```bash
node --version
python3 --version
git --version
code --version
```

#### Linux (Ubuntu/Debian)

**1. Update Package List:**
```bash
sudo apt update
```

**2. Install Dependencies:**
```bash
# Node.js (18.x)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Python 3.10
sudo apt install -y python3.10 python3-pip

# Git
sudo apt install -y git

# VSCode
wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg
sudo install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg
sudo sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list'
sudo apt update
sudo apt install -y code
```

**3. Verify Installations:**
```bash
node --version
python3 --version
git --version
code --version
```

---

## 🔧 Detailed Setup

### 1. Clone and Setup Project

```bash
# Clone repository
git clone https://github.com/juleszackaria-lab/Sudo-studio.git

# Navigate to project
cd Sudo-studio

# Check structure
ls -la
```

**You should see:**
```
backend/
sudo-ai-extension/
docs/
README.md
LICENSE
...
```

### 2. Backend Setup

```bash
# Navigate to backend
cd backend

# Install dependencies
npm install

# Verify installation
npm list

# Test backend
npm test

# Start backend (keep running)
node server.js
```

**Expected output:**
```
🚀 Sudo Studio Backend starting...
✅ Backend server running on port 5000
✅ All routes registered
✅ Ready to accept connections
```

### 3. Python Runtime Setup

**Open new terminal:**

```bash
cd Sudo-studio/backend/runtime

# Create virtual environment (recommended)
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Download AI models (first time only)
python download_models.py

# Start runtime (keep running)
python server.enterprise.py
```

**Expected output:**
```
🤖 Sudo Studio AI Runtime starting...
📦 Loading model: Qwen2.5-Coder-1.5B-Instruct
⚙️  Model loaded successfully
✅ AI Runtime ready on port 6000
✅ Ready to process inference requests
```

**Note:** First model download may take 5-15 minutes depending on internet speed.

### 4. Extension Setup

**Open new terminal:**

```bash
cd Sudo-studio/sudo-ai-extension

# Install dependencies
npm install

# Run tests
npm test

# Package extension (optional)
npm run package
```

### 5. Install Extension in VSCode

**Option A - Development Mode (Recommended for Testing):**

1. Open VSCode
2. File → Open Folder → Select `sudo-ai-extension` folder
3. Press `F5` (or Run → Start Debugging)
4. New VSCode window opens with extension loaded
5. Extension is active in this window

**Option B - Install from VSIX:**

1. Package extension:
   ```bash
   cd sudo-ai-extension
   npm run package
   ```

2. Install in VSCode:
   - Open VSCode
   - View → Extensions (Ctrl+Shift+X)
   - Click `...` → Install from VSIX
   - Select `sudo-studio-2.0.0.vsix`
   - Reload VSCode

**Option C - Link for Development:**

```bash
cd sudo-ai-extension

# Create symlink in VSCode extensions folder
# Windows:
mklink /D "%USERPROFILE%\.vscode\extensions\sudo-studio" .

# macOS/Linux:
ln -s $(pwd) ~/.vscode/extensions/sudo-studio
```

---

## ✅ Verification Checklist

### Backend Verification

**1. Check Health Endpoint:**
```bash
curl http://localhost:5000/api/health
```

**Expected response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-05-25T12:00:00Z",
  "version": "2.0.0"
}
```

**2. Check AI Endpoint:**
```bash
curl -X POST http://localhost:5000/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

**Expected response:**
```json
{
  "reply": "Hello! How can I assist you today?",
  "model": "default",
  "latency": 0.5
}
```

### Python Runtime Verification

**Check Health:**
```bash
curl http://localhost:6000/health
```

**Expected response:**
```json
{
  "status": "healthy",
  "model_loaded": true,
  "loaded_model": "Qwen2.5-Coder-1.5B-Instruct"
}
```

**Test Inference:**
```bash
curl -X POST http://localhost:6000/infer \
  -H "Content-Type: application/json" \
  -d '{"input":"Write a hello world function"}'
```

**Expected response:**
```json
{
  "reply": "Here's a hello world function: ...",
  "model": "Qwen2.5-Coder-1.5B-Instruct",
  "latency": 1.2
}
```

### Extension Verification

**1. Check Extension is Active:**
- Open VSCode
- Look for Sudo Studio icon (robot) in Activity Bar
- Click icon
- Should see 7 views: Dashboard, Chat, Doctor, SDK, DevOps, Environment, Runtime

**2. Test AI Chat:**
- Click "Open AI Chat" in Dashboard
- Chat panel opens
- Type: "Hello!"
- AI response appears within seconds

**3. Test Commands:**
- Press `Ctrl+Shift+P`
- Type "Sudo Studio"
- Should see 35+ commands

**4. Test Code Actions:**
- Open any code file
- Select some code
- Right-click
- See "Sudo Studio" submenu with Explain, Fix, Refactor options

---

## 🐛 Troubleshooting

### Backend Won't Start

**Error: "Port 5000 already in use"**
```bash
# Find process using port
# Windows:
netstat -ano | findstr :5000

# macOS/Linux:
lsof -i :5000

# Kill process or change port in backend/server.js
```

**Error: "Cannot find module"**
```bash
cd backend
rm -rf node_modules package-lock.json
npm install
```

### Python Runtime Won't Start

**Error: "Port 6000 already in use"**
```bash
# Kill process using port 6000
# Then restart runtime
```

**Error: "Model not found"**
```bash
cd backend/runtime
python download_models.py
```

**Error: "CUDA not available"**
- Normal if you don't have NVIDIA GPU
- Runtime will use CPU (slower but works)
- To use GPU: Install CUDA toolkit and PyTorch with CUDA

**Error: "Out of memory"**
```python
# Edit backend/runtime/server.enterprise.py
# Reduce max_tokens or use smaller model
```

### Extension Won't Load

**Extension Not Appearing:**
1. Reload VSCode: `Ctrl+R` or `Cmd+R`
2. Check Extensions panel: View → Extensions
3. Look for "Sudo Studio"
4. If not found, reinstall

**Extension Crashes:**
1. Check Developer Tools: Help → Toggle Developer Tools
2. Look for errors in Console
3. Check Output panel: View → Output → "Sudo Studio"

**Commands Not Working:**
1. Verify backend is running
2. Verify runtime is running
3. Check connection: Look for "Backend connected" notification

### Connection Issues

**Extension Can't Connect to Backend:**
```javascript
// Check backend URL in VSCode settings
// File → Preferences → Settings → Sudo Studio
{
  "sudoStudio.backendUrl": "http://localhost:5000",
  "sudoStudio.runtimeUrl": "http://localhost:6000"
}
```

**Timeout Errors:**
- Increase timeout in settings
- Check firewall rules
- Ensure services are running

---

## 🔄 Updating

### Update to Latest Version

```bash
cd Sudo-studio

# Pull latest changes
git pull origin main

# Update backend
cd backend
npm install

# Update runtime
cd ../backend/runtime
pip install -r requirements.txt --upgrade

# Update extension
cd ../../sudo-ai-extension
npm install

# Restart all services
```

---

## 🗑️ Uninstallation

### Remove Extension

**From VSCode:**
1. View → Extensions
2. Find "Sudo Studio"
3. Click Uninstall
4. Reload VSCode

### Remove Files

```bash
# Remove project folder
rm -rf Sudo-studio

# Remove VSCode extension (if linked)
rm -rf ~/.vscode/extensions/sudo-studio
```

### Remove Dependencies (Optional)

**If you don't need Node.js, Python, etc. for other projects:**

**Windows:**
- Uninstall via Control Panel → Programs

**macOS:**
```bash
brew uninstall node python@3.10 git
```

**Linux:**
```bash
sudo apt remove nodejs python3.10 git code
```

---

## 📧 Support

**Installation Issues:**
- GitHub: [Open issue](https://github.com/juleszackaria-lab/Sudo-studio/issues)
- Email: support@sudostudio.dev
- Docs: [Installation FAQ](https://docs.sudostudio.dev/installation)

---

## 🎉 Next Steps

After successful installation:

1. **Read Quick Start**: [QUICK-START-ENTERPRISE.md](QUICK-START-ENTERPRISE.md)
2. **Explore Features**: [ENTERPRISE-READY.md](ENTERPRISE-READY.md)
3. **Configure Settings**: VSCode → Settings → Sudo Studio
4. **Join Community**: [GitHub Discussions](https://github.com/juleszackaria-lab/Sudo-studio/discussions)

---

**Version:** 2.0.0 Enterprise  
**Last Updated:** May 2026  
**Platform:** Windows | macOS | Linux
