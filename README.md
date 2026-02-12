# Sudo-studio

**Plateforme intégrée de développement et de chat IA**, combinant VSCodium (éditeur open-source) avec un backend Node.js + Python pour exécuter les modèles IA localement.

## 📋 Architecture

```
┌─────────────────────────────────────────┐
│         VSCodium IDE                    │
│  - Extension Sudo-studio UI             │
│  - Terminal split (code + émulateur)    │
│  - IA natives désactivées                 │
└──────────────┬──────────────────────────┘
               │ HTTP + Socket.io
┌──────────────▼──────────────────────────┐
│     Backend Node.js (Express)           │
│  - API REST (/api/models, /api/chat)   │
│  - Web UI intégrée (/ui)                 │
│  - Gestion des modèles                  │
└──────────────┬──────────────────────────┘
               │ HTTP (inférence)
┌──────────────▼──────────────────────────┐
│   Python Runtime Servers (Flask)        │
│  - Chargement modèles (Transformers)    │
│  - Inférence locale                     │
└─────────────────────────────────────────┘
```

## 🚀 Installation rapide

### Prérequis
- **Node.js** 18+ (pour le backend)
- **Python 3.10+** (pour les runtimes de modèles)
- **Git**

### Automatisé (Linux/Mac)
```bash
chmod +x setup.sh
./setup.sh
```

### Automatisé (Windows)
```cmd
setup.bat
```

### Manuel

**1. Backend Node.js :**
```bash
cd backend
npm install
npm run dev       # Lance sur http://localhost:5000
```

**2. Runtime Python (dans un autre terminal) :**
```bash
cd backend/runtime
python -m venv .venv
source .venv/bin/activate    # .venv\Scripts\activate (Windows)
pip install -r requirements.txt
python server.py --model gpt2 --port 6000
```

**3. Accéder l'UI :**
- Web UI : http://localhost:5000/ui/index.html
- VSCodium : Exécutez commande `Sudo Studio: Open UI`

## 📚 Fonctionnalités du backend

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/models` | GET | Liste les modèles + status |
| `/api/models/:name` | GET | Info sur un modèle |
| `/api/models/download` | POST | Télécharge un modèle |
| `/api/models/:name` | DELETE | Supprime un modèle |
| `/api/models/start` | POST | Démarre runtime du modèle |
| `/api/models/stop` | POST | Arrête le runtime |
| `/api/models/infer` | POST | Exécute l'inférence |
| `/api/chat` | POST | Chat via modèle actif |
| `/ui` | GET | Page web UI |

### Exemple : Télécharger & utiliser un modèle

```bash
# Terminal 1 : Backend
cd backend && npm run dev

# Terminal 2 : Runtime Python
cd backend/runtime && source .venv/bin/activate
python server.py --model gpt2 --port 6000

# Terminal 3 : Requêtes
# 1. Démarrer le modèle
curl -X POST http://localhost:5000/api/models/start \
  -H "Content-Type: application/json" \
  -d '{"modelName":"gpt2"}'

# 2. Faire une inférence
curl -X POST http://localhost:5000/api/models/infer \
  -H "Content-Type: application/json" \
  -d '{"modelName":"gpt2","input":"Hello world"}'

# Réponse : { "reply": "Hello world is great..." }
```

## 🔧 Configuration

### Variables d'environnement (backend)
```bash
PORT=5000           # Port du serveur Express (défaut: 5000)
```

### Modèles supportés
Le runtime Python supporte tous les modèles Hugging Face. Exemples :
- `gpt2` - Petit modèle rapide (test)
- `distilbert-base-uncased` - Classification texte
- `gpt2-medium` - Génération texte améliorée

## 📝 Structure du projet

```
Sudo-studio/
├── backend/
│   ├── server.js               # Serveur Express principal
│   ├── ai/
│   │   └── aiModelsManager.js  # Gestion lifecycle modèles
│   ├── runtime/
│   │   ├── server.py           # Serveur Flask inférence
│   │   └── requirements.txt    # Dépendances Python
│   ├── package.json
│   └── services/               # Utilitaires (paiements, fichiers)
├── web-ui/
│   ├── index.html              # UI web intégrée
│   ├── styles.css
│   └── app.js
├── vscodium/
│   ├── extensions/sudo-studio-ui/  # Extension VSCodium
│   │   ├── package.json
│   │   └── extension.js
│   └── ...                     # Code source VSCodium
├── .github/
│   └── workflows/
│       └── build-windows.yml   # CI/CD pour builds Windows
├── setup.sh / setup.bat        # Scripts d'installation
└── README.md
```

## 🔐 Sécurité & Performance

### Lifecycle des modèles
- Les modèles sont lancés sous forme de **processus enfants détachés** (pas bloquants)
- Chaque modèle obtient un **port unique** (6000, 6001, etc.)
- Les métadonnées sont **persistantes** via `backend/ai/models/models.json`

### Limitations connues
- L'inférence attend 3 secondes avant timeout (configurable)
- Modèles limités à 100+ MB (vérifiez `backend/download-models.js`)
- Pas de GPU acceleration (CPU only par défaut)

## 🐛 Troubleshooting

**Port déjà utilisé :**
```bash
# Trouver le processus
lsof -i :5000   # Linux/Mac
netstat -ano | findstr :5000  # Windows

# Tuer le processus
kill -9 <PID>   # Linux/Mac
taskkill /PID <PID> /F  # Windows
```

**Python runtime ne démarre pas :**
```bash
# Vérifier les dépendances
python -c "import flask; import transformers; print('OK')"

# Lancer en debug
python backend/runtime/server.py --model gpt2 --port 6000
```

**VSCodium n'ouvre pas l'UI :**
- Vérifiez que le backend est lancé sur `http://localhost:5000`
- Ouvrez http://localhost:5000/ui/index.html directement dans le navigateur

## 📦 Build & Deployment

### Créer une distribution
```bash
# Automatisé (via GitHub Actions, voir .github/workflows/build-windows.yml)
# ou manuellement
mkdir dist
cp -r backend web-ui dist/
cp -r vscodium/extensions/sudo-studio-ui dist/
tar -czf sudo-studio-release.tar.gz dist/
```

## 📜 Licence
BSD-3-Clause (conforme VSCodium)

## 💬 Support
Pour des issues ou contributions, consultez le repo GitHub.
