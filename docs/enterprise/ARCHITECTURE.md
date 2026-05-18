# SUDO STUDIO - ARCHITECTURE ENTERPRISE

## Vue d'ensemble

Sudo Studio est une plateforme de développement IA intégrée qui transforme VSCode/VSCodium en un IDE intelligent avec capacités d'IA locale, diagnostic automatique et gestion d'environnement.

## Architecture Globale

```
┌─────────────────────────────────────────────────────────────┐
│                    SUDO STUDIO PLATFORM                      │
├──────────────────┬───────────────────┬──────────────────────┤
│   Extension      │    Backend        │   Python Runtime    │
│   VSCodium       │    Node.js        │   Flask + AI        │
└──────────────────┴───────────────────┴──────────────────────┘
```

## Composants Principaux

### 1. Extension VSCode (`sudo-ai-extension/`)
- **Langage**: JavaScript (Node.js)
- **Framework**: VSCode Extension API
- **Port**: Communication HTTP vers backend
- **Fonctionnalités**:
  - Interface utilisateur pour l'IA
  - Commandes de code (explain, fix, generate, refactor)
  - Chat interactif avec l'IA
  - Sélection et téléchargement de modèles
  - Analyse de projet
  - System Doctor intégré

### 2. Backend Node.js (`backend/`)
- **Langage**: JavaScript (Node.js + Express)
- **Port**: 5000 (configurable)
- **Architecture**: REST API + Microservices

#### Modules Backend:

**a) Doctor System** (`backend/doctor/`)
- Diagnostic d'environnement complet
- Détection de 15+ SDKs
- Analyse PATH et variables d'environnement
- Tests de connectivité réseau
- Health scoring (0-100)
- Recommandations intelligentes

**b) SDK Installer** (`backend/installers/`)
- Installation cross-platform de 15+ SDKs
- Gestion du PATH persistante (Registry Windows, shell profiles Unix)
- Retry logic avec exponential backoff
- Vérification d'intégrité (checksums)
- Package manager integration (Homebrew, apt, yum)
- Rollback automatique sur échec

**c) Auto-Fix** (`backend/services/`)
- Détection d'erreurs par patterns (10+ types)
- Réparation npm/pip automatique
- Système de backup/rollback
- Gestion des conflits de dépendances
- Réparation des permissions
- Nettoyage de cache

**d) Routes API** (`backend/routes/`)
- `/api/auth/*` - Authentication JWT
- `/api/ai/*` - Intelligence artificielle
- `/api/system/*` - System status et health
- `/api/models/*` - Gestion des modèles IA
- `/api/project/*` - Analyse de projets

### 3. Python AI Runtime (`backend/runtime/`)
- **Langage**: Python 3.8+
- **Framework**: Flask + Transformers
- **Port**: 6000 (configurable)

#### Components Runtime:

**a) Server Enterprise** (`server.enterprise.py`)
- Inférence IA avec GPU/CPU
- Streaming de réponses
- Gestion mémoire optimisée
- Hot model swapping
- Health monitoring
- Token counting
- Performance metrics

**b) Manager Enterprise** (`manager.enterprise.py`)
- Installation automatique des dépendances
- Gestion du cache HuggingFace
- Validation de modèles
- Configuration persistante
- CLI complet
- Diagnostics système

## Flux de Communication

### 1. Chat IA
```
Extension → Backend → Python Runtime → HuggingFace Model → Response
```

### 2. Diagnostic Système
```
Extension → Backend Doctor → System Analysis → Recommendations
```

### 3. Installation SDK
```
Extension → Backend → SDK Installer → Download → Extract → PATH Update
```

### 4. Auto-Repair
```
Error Detection → Pattern Analysis → Backup → Fix → Verify → Restore if Fail
```

## Technologies

### Frontend (Extension)
- VSCode Extension API
- Webview API pour UI
- Axios pour HTTP
- JavaScript ES6+

### Backend
- Node.js 16+
- Express.js
- JWT Authentication
- Axios pour requêtes externes
- Child Process pour commandes système

### AI Runtime
- Python 3.8+
- Flask + Flask-CORS
- PyTorch
- Transformers (HuggingFace)
- Accelerate (GPU optimization)

## Sécurité

- **Authentication**: JWT tokens avec expiration
- **Dev Mode**: Auto-génération de tokens pour développement
- **Isolation**: Python runtime isolé du backend
- **Validation**: Input validation sur toutes les routes
- **Permissions**: Détection et gestion des privilèges admin

## Performance

- **Caching**: Résultats de diagnostic cachés
- **Lazy Loading**: Modèles IA chargés à la demande
- **Streaming**: Réponses IA en temps réel
- **Parallel**: Installation SDK parallèle
- **Memory Management**: Garbage collection automatique

## Scalabilité

- **Modular**: Composants indépendants
- **Extensible**: Facile d'ajouter nouveaux SDKs/modèles
- **Configurable**: Configuration centralisée
- **Microservices Ready**: Séparation claire des responsabilités

## Deployment

- **Development**: `npm run dev` (backend) + `python manager.enterprise.py start`
- **Production**: PM2 pour Node.js, Supervisor pour Python
- **Docker**: Dockerfile inclus (à venir)
- **CI/CD**: GitHub Actions ready

## Monitoring

- Health checks sur tous les services
- Metrics de performance (tokens/sec, latency)
- Logging structuré
- Error tracking
- Uptime monitoring

## Documentation Technique

Voir aussi:
- [SDK_INSTALLER.md](./SDK_INSTALLER.md) - Documentation SDK Installer
- [DOCTOR_SYSTEM.md](./DOCTOR_SYSTEM.md) - Documentation Doctor
- [AI_RUNTIME.md](./AI_RUNTIME.md) - Documentation Runtime IA
- [AUTO_FIX.md](./AUTO_FIX.md) - Documentation Auto-fix
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Guide de déploiement
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Dépannage
- [TESTING.md](./TESTING.md) - Tests
