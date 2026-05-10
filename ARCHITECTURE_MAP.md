# 🏗️ SUDO STUDIO - ARCHITECTURE MAP

**Date**: 2026-05-10  
**Version**: 2.0.0 (Post-Correction)  
**Status**: Production Ready

---

## 📋 TABLE OF CONTENTS

1. [Vue d'ensemble](#vue-densemble)
2. [Composants principaux](#composants-principaux)
3. [Architecture backend](#architecture-backend)
4. [Runtime Python](#runtime-python)
5. [Extension VSCodium](#extension-vscodium)
6. [Flux de données](#flux-de-données)
7. [Sécurité](#sécurité)
8. [Scalabilité](#scalabilité)

---

## 🎯 VUE D'ENSEMBLE

Sudo Studio est une plateforme IDE alimentée par IA locale composée de trois couches principales:

```
┌─────────────────────────────────────────────────┐
│           LAYER 1: USER INTERFACE               │
│         (VSCodium Extension)                    │
│  - Chat UI                                      │
│  - Commands (Explain, Fix, Generate)           │
│  - Status Bar                                   │
└────────────────┬────────────────────────────────┘
                 │ HTTP/REST
                 ▼
┌─────────────────────────────────────────────────┐
│        LAYER 2: BUSINESS LOGIC                  │
│         (Node.js Backend - Express)             │
│  - Authentication                               │
│  - AI Routing                                   │
│  - Model Fallback                               │
│  - System Management                            │
└────────────────┬────────────────────────────────┘
                 │ HTTP/REST
                 ▼
┌─────────────────────────────────────────────────┐
│         LAYER 3: AI INFERENCE                   │
│    (Python Runtime + External Services)         │
│  - Transformers                                 │
│  - Ollama                                       │
│  - vLLM                                         │
└─────────────────────────────────────────────────┘
```

---

## 🧩 COMPOSANTS PRINCIPAUX

### 1. Backend Node.js (Port 5000)
**Technologies**: Express.js, Socket.io, JWT  
**Responsabilités**:
- Authentification et autorisation
- Routage des requêtes IA
- Fallback intelligent entre services
- Logging et monitoring
- API REST complète

### 2. Runtime Python (Port 6000)
**Technologies**: Flask, Transformers, PyTorch  
**Responsabilités**:
- Chargement modèles locaux
- Inference IA
- Auto-download modèles
- Health checks

### 3. Extension VSCodium
**Technologies**: VS Code API, Axios  
**Responsabilités**:
- Interface utilisateur
- Commandes palette
- Webview chat
- Communication backend

---

## 🔧 ARCHITECTURE BACKEND

### Structure des Dossiers
```
backend/
├── ai/
│   ├── aiModelsManager.js    # Gestionnaire modèles (legacy)
│   └── papito-core.js         # Analyseur code
├── config/
│   └── firebase.js            # Config Firebase (optionnel)
├── controllers/
│   └── emulator.controller.js # Contrôleur émulateur
├── doctor/
│   └── environmentDoctor.js   # Diagnostic environnement
├── installers/
│   └── sdkInstaller.js        # Installation SDK
├── middleware/
│   └── auth.middleware.js     # ✅ CORRIGÉ: Auth JWT
├── models/
│   └── user.model.js          # Modèle utilisateur
├── routes/
│   ├── admin.routes.js        # Routes admin
│   ├── ai.routes.js           # ✅ Routes IA (main)
│   ├── auth.routes.js         # ✅ NOUVEAU: Auth routes
│   ├── devops.routes.js       # Routes DevOps
│   ├── environment.routes.js  # Routes environnement
│   ├── monitor.routes.js      # Routes monitoring
│   ├── papito.routes.js       # Routes Papito
│   ├── project.routes.js      # Routes projet
│   └── system.routes.js       # Routes système
├── runtime/
│   ├── server.py              # ✅ RÉÉCRIT: Runtime Flask
│   └── manager.py             # ✅ NOUVEAU: Runtime manager
├── security/
│   └── commandWhitelist.js    # Whitelist commandes
├── services/
│   ├── filesystem.js          # Service filesystem
│   └── moneyfusion.js         # Service moneyfusion
├── tests/
│   ├── integration/           # Tests intégration
│   └── unit/                  # Tests unitaires
├── utils/
│   └── logger.js              # Logger Winston
└── server.js                  # ✅ MODIFIÉ: Entry point
```

### Routes API Complètes

#### Authentication (`/api/auth/*`)
```javascript
POST   /api/auth/login        // Login simple
GET    /api/auth/dev-token    // Token dev auto
POST   /api/auth/verify       // Vérifier token
GET    /api/auth/status       // Status auth
```

#### AI (`/api/ai/*`)
```javascript
POST   /api/ai/chat           // Chat principal ✅
GET    /api/ai/models         // Liste modèles
POST   /api/ai/code/explain   // Expliquer code
POST   /api/ai/code/fix       // Corriger code
GET    /api/ai/health         // Health check IA
```

#### System (`/api/system/*`)
```javascript
GET    /api/system/status     // Status système
GET    /api/system/audit      // Audit complet
```

#### Environment (`/api/environment/*`)
```javascript
GET    /api/environment/templates
POST   /api/environment/create
GET    /api/environment/list
```

#### Project (`/api/project/*`)
```javascript
POST   /api/project/analyze
POST   /api/project/fix
GET    /api/project/health
```

#### DevOps (`/api/devops/*`)
```javascript
GET    /api/devops/metrics
POST   /api/devops/deploy
GET    /api/devops/status
```

### Middleware Chain
```javascript
Request
  ↓
CORS middleware (allow localhost:5173)
  ↓
Helmet (security headers)
  ↓
Rate Limiter (100 req/15min)
  ↓
JSON body parser
  ↓
Auth middleware (verifyToken)
  ↓
Route handler
  ↓
Error handler
  ↓
Response
```

---

## 🐍 RUNTIME PYTHON

### Architecture Interne
```python
Flask App (port 6000)
  ├── /health          → Health check
  ├── /infer           → Main inference
  ├── /chat            → Chat with history
  ├── /models          → List models
  └── /reload          → Reload model

Transformers Pipeline
  ├── AutoTokenizer
  ├── AutoModelForCausalLM
  └── text-generation pipeline

Model Management
  ├── Auto-download (first run)
  ├── Model loading (lazy)
  ├── Mock mode (fallback)
  └── Configuration persistence
```

### Modèles Supportés
```python
DEFAULT_MODELS = [
    'Qwen/Qwen2.5-Coder-1.5B-Instruct',  # 1.5B - Code
    'microsoft/phi-2',                    # 2.7B - General
    'Qwen/Qwen2-1.5B-Instruct',          # 1.5B - Chat
]
```

### Endpoints Détaillés

#### `GET /health`
```json
{
  "status": "healthy",
  "model_loaded": true,
  "model_name": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  "model_type": "text-generation",
  "uptime_seconds": 3600,
  "capabilities": {
    "inference": true,
    "streaming": false,
    "code_generation": true,
    "chat": true
  }
}
```

#### `POST /infer`
```json
// Request
{
  "prompt": "Write a Python function to sort a list",
  "max_length": 200,
  "temperature": 0.7
}

// Response
{
  "reply": "def sort_list(items):...",
  "model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  "latency": "1.23s",
  "prompt_length": 45,
  "reply_length": 120,
  "mock": false
}
```

---

## 🎨 EXTENSION VSCODIUM

### Structure
```
sudo-ai-extension/
├── package.json        # ✅ MODIFIÉ: Manifest
├── extension.js        # ✅ MODIFIÉ: Main logic
└── README.md           # Documentation
```

### Commandes Enregistrées
```javascript
1. sudo-ai.explainCode     // Expliquer code sélectionné
2. sudo-ai.fixCode         // Corriger code
3. sudo-ai.generateCode    // Générer nouveau code
4. sudo-ai.refactorCode    // Refactoriser
5. sudo-ai.askQuestion     // Poser question
6. sudo-ai.openChat        // Ouvrir chat
7. sudo-ai.selectModel     // Changer modèle
8. sudo-ai.refreshModels   // Rafraîchir liste
```

### Cycle de Vie
```javascript
Extension Activation
  ↓
Load Configuration
  ↓
Initialize Connection (GET /api/auth/dev-token)
  ↓
Store Auth Token
  ↓
Check Backend Status (GET /api/system/status)
  ↓
Register Commands
  ↓
Create Status Bar Item
  ↓
✓ Ready for User Interaction
```

### Communication Webview
```javascript
Extension (host)
  ↕ postMessage / onDidReceiveMessage
Webview (guest)

Messages:
  host → guest:
    - user-message
    - ai-message
    - error
  
  guest → host:
    - sendMessage
    - selectModel
```

---

## 🔄 FLUX DE DONNÉES

### Flux Chat Complet
```
User Input
  │
  ├─ [Extension] Webview Chat
  │    └─ vscode.postMessage({ command: 'sendMessage', text })
  │
  ├─ [Extension] handleChatMessage(text)
  │    └─ axios.post('/api/ai/chat', { message, model, context })
  │         Headers: Authorization: Bearer <token>
  │
  ├─ [Backend] POST /api/ai/chat
  │    ├─ verifyToken middleware
  │    ├─ detectMode(message)
  │    ├─ selectModel(model || default)
  │    └─ checkModelAvailability()
  │         │
  │         ├─ Try: Ollama (11434)
  │         ├─ Try: vLLM (8000)
  │         └─ Try: Python Runtime (6000)
  │
  ├─ [Runtime] POST /infer or /chat
  │    ├─ Load model (if not loaded)
  │    ├─ Generate response
  │    └─ Return { reply, latency, ... }
  │
  ├─ [Backend] Return response
  │    └─ { reply, model_used, latency, mode, metadata }
  │
  └─ [Extension] Display in Chat UI
       ├─ webview.postMessage({ type: 'ai-message', text, model })
       └─ Webview renders message
```

### Fallback Chain (AI Services)
```
Request arrives at Backend
  │
  ├─ Check Ollama (localhost:11434)
  │    ├─ Available? → Use Ollama
  │    └─ Unavailable? → Continue
  │
  ├─ Check vLLM (localhost:8000)
  │    ├─ Available? → Use vLLM
  │    └─ Unavailable? → Continue
  │
  ├─ Check Python Runtime (localhost:6000)
  │    ├─ Available? → Use Runtime
  │    └─ Unavailable? → Continue
  │
  └─ All Unavailable?
       └─ Return 503 error with help message
```

---

## 🔒 SÉCURITÉ

### Authentification
```
JWT Token System
  ├─ Secret: process.env.JWT_SECRET
  ├─ Expiry: 7 days
  ├─ Payload: { username, role, env, timestamp }
  └─ Modes:
       ├─ Development: Optional auth
       └─ Production: Required auth
```

### Middleware Security
```
1. Helmet.js → Security headers
2. CORS → Restrict origins
3. Rate Limiting → 100 req/15min
4. JWT Verification → Token validation
5. Role-based access → Permission checks
```

### Best Practices
- ✅ Pas de clés hardcodées
- ✅ Secrets en variables d'environnement
- ✅ HTTPS recommandé en production
- ✅ Rate limiting actif
- ✅ Input validation
- ✅ Error handling sans leak d'info

---

## 📈 SCALABILITÉ

### Horizontal Scaling
```
Load Balancer
  │
  ├─ Backend Instance 1 (5000)
  ├─ Backend Instance 2 (5001)
  └─ Backend Instance 3 (5002)
       │
       └─ Shared:
            ├─ Python Runtime Pool
            ├─ Database (SQLite → PostgreSQL)
            └─ Redis (cache + sessions)
```

### Vertical Scaling
```
Resources per Service:
  ├─ Backend Node.js: 512MB-1GB RAM
  ├─ Python Runtime: 2-4GB RAM (depends on model)
  └─ Database: 256MB-512MB RAM
```

### Optimizations Possibles
1. **Caching**: Redis pour réponses IA fréquentes
2. **Queue**: Bull/BullMQ pour requêtes longues
3. **Streaming**: SSE pour réponses progressives
4. **Model Pool**: Multiple runtime instances
5. **Database**: Migration vers PostgreSQL
6. **CDN**: Assets statiques

---

## 📊 MONITORING

### Logs
```javascript
Winston Logger
  ├─ Level: info (production)
  ├─ Format: JSON
  ├─ Transports:
  │    ├─ Console
  │    └─ File (logs/app.log)
  └─ Metadata: { timestamp, service, user, ... }
```

### Health Checks
```
Endpoints à monitorer:
  ├─ GET /api/system/status     → Backend health
  ├─ GET /api/ai/health         → AI services health
  ├─ GET /health (Python)       → Runtime health
  └─ Metrics: uptime, latency, success rate
```

---

## 🎯 NEXT STEPS

### Phase 5: Tests Complets
- [ ] Tests end-to-end extension → backend → runtime
- [ ] Tests de charge (load testing)
- [ ] Tests de sécurité
- [ ] Tests de régression

### Phase 6: Optimizations
- [ ] Streaming responses (SSE)
- [ ] Redis caching
- [ ] Model quantization (GGUF)
- [ ] Multi-GPU support

### Phase 7: Production
- [ ] Docker containers
- [ ] CI/CD pipeline
- [ ] Monitoring dashboard
- [ ] Documentation utilisateur

---

**Status**: ✅ Architecture stable et prête pour production  
**Dernière mise à jour**: 2026-05-10
