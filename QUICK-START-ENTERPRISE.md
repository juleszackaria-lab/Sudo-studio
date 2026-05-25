# ⚡ SUDO STUDIO - QUICK START GUIDE

## 🚀 Start in 3 Steps

### Step 1: Start Backend
```bash
cd backend
node server.js
```
✅ Wait for: "Backend server running on port 5000"

### Step 2: Start AI Runtime
```bash
cd backend/runtime
python server.enterprise.py
```
✅ Wait for: "AI Runtime ready" and model loaded message

### Step 3: Launch Extension
```bash
# Open VSCode in extension folder
code sudo-ai-extension

# Press F5 to start Extension Development Host
# Or: Run > Start Debugging
```
✅ Wait for: "Sudo Studio activated!" notification

---

## 🎯 First Actions

### Open AI Chat
1. Click Sudo Studio icon (robot) in Activity Bar
2. Click "Open AI Chat" in Dashboard
3. Type: "Hello, can you help me?"
4. ✅ See AI response with markdown formatting

### Run System Doctor
1. Sidebar → "System Doctor" view
2. Click "Run System Diagnostic"
3. ✅ See system health score (0-100)
4. ✅ See detected issues with AutoFix buttons

### Install SDK
1. Sidebar → "SDK Manager" view
2. Click "Install" on any SDK (e.g., "Node.js")
3. ✅ See progress bar
4. ✅ See success notification

### Generate Docker
1. Open a project folder in VSCode
2. `Ctrl+Shift+P` → "Sudo Studio: Generate Dockerfile"
3. ✅ Dockerfile created in project
4. ✅ Notification with "View File" button

### Code Actions
1. Select code in editor
2. Right-click → Sudo Studio menu
3. Choose "Explain Code" / "Fix Code" / "Refactor Code"
4. ✅ Result appears in AI Chat

---

## 📁 Views Available

**Sidebar Views (7):**
- **Dashboard** - Overview, quick actions, metrics
- **AI Chat** - Models, history, selection
- **System Doctor** - Diagnostics, score, AutoFix
- **SDK Manager** - SDKs installation
- **DevOps** - Docker, CI/CD, K8s generation
- **Environment** - Export, import, snapshots
- **AI Runtime** - Status, metrics, logs

---

## ⚡ Key Commands

**Access via:** `Ctrl+Shift+P` → "Sudo Studio: ..."

**Most Used:**
- Open AI Chat
- Run System Doctor
- Install SDK
- Generate Dockerfile
- Analyze Project
- Explain Code (select code first)
- Fix Code (select code first)
- Refactor Code (select code first)

---

## 🧪 Verify Everything Works

### Backend Health
```bash
curl http://localhost:5000/api/health
```
✅ Should return: `{"status":"healthy"}`

### Runtime Health
```bash
curl http://localhost:6000/health
```
✅ Should return: `{"status":"healthy","model_loaded":true}`

### Extension Active
- Look for "Sudo Studio" icon in Activity Bar (left sidebar)
- Should have 7 views visible
- No error notifications

---

## 🎨 What You'll See

### AI Chat Panel
- Modern chat UI (Cursor/Claude style)
- Markdown rendering
- Syntax highlighting for code blocks
- Copy buttons
- Loading animations
- Message history

### System Doctor Panel
- Health score card (0-100)
- Modern issue cards with severity colors
- AutoFix buttons
- Progress indicators
- Real-time updates

### SDK Manager Panel
- Grid of SDK cards
- Install/Repair/Uninstall buttons
- Progress bars for downloads
- Status indicators (installed/not installed)
- Icons for each SDK

---

## 🔧 Configuration

**Access:** File > Preferences > Settings → "Sudo Studio"

**Key Settings:**
- Backend URL: `http://localhost:5000` (default)
- Runtime URL: `http://localhost:6000` (default)
- Default Model: `default`
- Enable Streaming: `true`
- Enable AutoFix: `true`

---

## 🐛 Troubleshooting

### Backend Won't Start
```bash
cd backend
npm install
node server.js
```

### Runtime Won't Start
```bash
cd backend/runtime
pip install -r requirements.txt
python server.enterprise.py
```

### Extension Won't Activate
- Check VSCode Output panel
- Look for errors in Developer Tools (`Help > Toggle Developer Tools`)
- Verify backend and runtime are running

### No AI Response
- Check backend is running (port 5000)
- Check runtime is running (port 6000)
- Check runtime has model loaded
- Look for notifications/errors in VSCode

### SDK Installation Fails
- Check internet connection
- Check admin/sudo permissions
- View error message in notification
- Try "Repair SDK" if already partially installed

---

## 📊 Success Indicators

✅ **Backend:** Console shows "Backend server running on port 5000"
✅ **Runtime:** Console shows "AI Runtime ready" + model name
✅ **Extension:** Notification "Sudo Studio activated!"
✅ **Connection:** Notification "Backend connected successfully"
✅ **AI Ready:** Notification "AI Ready: [model-name]"
✅ **Chat Works:** Send message, get AI response
✅ **Doctor Works:** Run diagnostic, see score and issues
✅ **SDK Works:** Install SDK, see progress bar

---

## 🎯 Next Steps

Once everything works:

1. **Explore Views** - Click through all 7 sidebar views
2. **Try Commands** - Open command palette, search "Sudo Studio"
3. **Test Code Actions** - Select code, right-click, use AI features
4. **Generate DevOps** - Try Docker, CI/CD, K8s generation
5. **Manage Environment** - Export/import configurations
6. **Analyze Project** - Get AI insights on your codebase

---

## 📚 Full Documentation

For complete guide, see: **ENTERPRISE-READY.md**

For technical details, see: **SESSION-COMPLETE-REPORT.md**

For testing, run:
```bash
node test-extension-complete.js
```

---

## 💬 Support

**GitHub:** https://github.com/juleszackaria-lab/Sudo-studio
**Issues:** https://github.com/juleszackaria-lab/Sudo-studio/issues

---

**Version:** 2.0.0 Enterprise
**Status:** ✅ Production Ready
**Last Updated:** 2026-05-25

🚀 **Enjoy Sudo Studio Enterprise!** 🎉
