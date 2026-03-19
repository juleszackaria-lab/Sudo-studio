# 🚀 GUIDE DE DÉPLOIEMENT ET SÉCURISATION - SUDO STUDIO BACKEND

## 📋 PRÉ-REQUIS

### Logiciels Requis
- Node.js >= 14.x
- npm >= 7.x
- SQLite3
- Python 3.x (pour les modèles AI)
- Docker (optionnel, pour l'émulateur)

---

## 🔐 SÉCURISATION AVANT DÉPLOIEMENT

### 1. Changer le Mot de Passe Admin Par Défaut

**⚠️ CRITIQUE - À FAIRE AVANT LA PRODUCTION**

Le backend crée un utilisateur admin par défaut:
- **Username**: `admin`
- **Password**: `admin123`

**Action requise**:

```bash
# Se connecter au serveur
npm start

# Dans un autre terminal, obtenir un token
curl -X POST http://localhost:5000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Utiliser le token pour créer un nouvel admin avec mot de passe fort
curl -X POST http://localhost:5000/admin/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_TOKEN_ICI" \
  -d '{
    "username": "votre_admin",
    "password": "VotreMo tDePa$$eFort123!",
    "role": "admin"
  }'

# Ensuite, supprimer ou désactiver l'admin par défaut
# Modifier le fichier models/user.model.js pour ne plus créer l'admin par défaut
```

### 2. Configurer le JWT Secret

**⚠️ CRITIQUE**

Par défaut: `'enterprise-secret'` (DANGEREUX en production)

**Générer un secret fort**:

```bash
# Linux/Mac
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Ou utilisez:
openssl rand -base64 64
```

**Configuration**:

```bash
# .env file
ENTERPRISE_JWT_SECRET=votre_secret_genere_ici_64_caracteres_minimum

# Ou en ligne de commande
export ENTERPRISE_JWT_SECRET="votre_secret_genere_ici"
```

### 3. Corriger les Vulnérabilités npm

```bash
cd backend

# Analyser les vulnérabilités
npm audit

# Corriger automatiquement
npm audit fix

# Si nécessaire, forcer les corrections
npm audit fix --force

# Vérifier à nouveau
npm audit
```

### 4. Configuration HTTPS en Production

**Option A: Utiliser un reverse proxy (Nginx)**

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Redirection HTTP vers HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

**Option B: HTTPS directement dans Node.js**

Modifier `server.js`:

```javascript
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('/path/to/key.pem'),
  cert: fs.readFileSync('/path/to/cert.pem')
};

const server = https.createServer(options, app);
```

### 5. Variables d'Environnement

Créer un fichier `.env`:

```bash
# .env
NODE_ENV=production
PORT=5000
ENTERPRISE_JWT_SECRET=votre_secret_jwt_fort_64_caracteres
LOG_LEVEL=info
EMULATOR_TIMEOUT_MS=60000

# CORS Origins (séparer par des virgules)
CORS_ORIGINS=https://votre-domaine.com,https://www.votre-domaine.com

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Database
DATABASE_PATH=./data/enterprise.db
```

Installer dotenv:

```bash
npm install dotenv
```

Ajouter en haut de `server.js`:

```javascript
require('dotenv').config();
```

---

## 📦 INSTALLATION ET DÉMARRAGE

### Installation

```bash
cd backend
npm install
```

### Développement

```bash
npm run dev
```

### Production

```bash
npm start
```

### Tests

```bash
# Tous les tests
npm test

# Tests en mode watch
npm run test:watch

# Tests unitaires seulement
npm run test:unit

# Tests d'intégration seulement
npm run test:integration
```

---

## 🐳 DÉPLOIEMENT AVEC DOCKER

### Dockerfile (déjà présent)

Le backend contient déjà un `Dockerfile`. Construire l'image:

```bash
cd backend
docker build -t sudo-studio-backend .
```

### Docker Compose

Le backend contient déjà `docker-compose.yml`:

```bash
docker-compose up -d
```

### Déploiement sur Serveur

```bash
# Cloner le repo
git clone https://github.com/juleszackaria-lab/Sudo-studio.git
cd Sudo-studio/backend

# Créer .env avec vos configurations
nano .env

# Installer les dépendances
npm install --production

# Créer un service systemd
sudo nano /etc/systemd/system/sudo-studio.service
```

**Contenu du service**:

```ini
[Unit]
Description=Sudo Studio Backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/Sudo-studio/backend
Environment="NODE_ENV=production"
Environment="PORT=5000"
EnvironmentFile=/path/to/Sudo-studio/backend/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

# Logging
StandardOutput=append:/var/log/sudo-studio/out.log
StandardError=append:/var/log/sudo-studio/error.log

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/path/to/Sudo-studio/backend/data
ReadWritePaths=/path/to/Sudo-studio/backend/logs

[Install]
WantedBy=multi-user.target
```

**Activer et démarrer**:

```bash
# Créer les dossiers de logs
sudo mkdir -p /var/log/sudo-studio
sudo chown www-data:www-data /var/log/sudo-studio

# Activer et démarrer le service
sudo systemctl daemon-reload
sudo systemctl enable sudo-studio
sudo systemctl start sudo-studio

# Vérifier le statut
sudo systemctl status sudo-studio

# Voir les logs
sudo journalctl -u sudo-studio -f
```

---

## 🔄 PROCESS MANAGER (PM2)

### Installation

```bash
npm install -g pm2
```

### Configuration

Créer `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'sudo-studio-backend',
    script: 'server.js',
    instances: 2,
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development',
      PORT: 5000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true
  }]
};
```

### Commandes PM2

```bash
# Démarrer
pm2 start ecosystem.config.js --env production

# Redémarrer
pm2 restart sudo-studio-backend

# Arrêter
pm2 stop sudo-studio-backend

# Voir les logs
pm2 logs sudo-studio-backend

# Voir le statut
pm2 status

# Monitoring
pm2 monit

# Sauvegarder la configuration
pm2 save

# Démarrage automatique au boot
pm2 startup
```

---

## 📊 MONITORING ET LOGS

### Rotation des Logs

Installer logrotate:

```bash
sudo nano /etc/logrotate.d/sudo-studio
```

**Configuration**:

```
/path/to/Sudo-studio/backend/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data www-data
    sharedscripts
    postrotate
        systemctl reload sudo-studio > /dev/null 2>&1 || true
    endscript
}
```

### Health Check Automatique

Créer un script de surveillance:

```bash
#!/bin/bash
# health-check.sh

BACKEND_URL="http://localhost:5000/health"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" $BACKEND_URL)

if [ $RESPONSE -eq 200 ]; then
    echo "✅ Backend is healthy"
    exit 0
else
    echo "❌ Backend is unhealthy (HTTP $RESPONSE)"
    # Redémarrer le service
    systemctl restart sudo-studio
    exit 1
fi
```

**Ajouter au crontab**:

```bash
crontab -e

# Vérifier la santé toutes les 5 minutes
*/5 * * * * /path/to/health-check.sh >> /var/log/sudo-studio/health-check.log 2>&1
```

---

## 🔍 TESTS EN PRODUCTION

### Smoke Tests

```bash
# Health check
curl http://your-domain.com/health

# Version
curl http://your-domain.com/version

# Login (devrait fonctionner avec les bons identifiants)
curl -X POST http://your-domain.com/login \
  -H "Content-Type: application/json" \
  -d '{"username":"votre_admin","password":"votre_mot_de_passe"}'
```

---

## 🚨 TROUBLESHOOTING

### Le serveur ne démarre pas

```bash
# Vérifier les logs
journalctl -u sudo-studio -n 50

# Vérifier les ports
netstat -tlnp | grep 5000

# Vérifier les permissions
ls -la /path/to/Sudo-studio/backend/data
```

### Erreurs de base de données

```bash
# Vérifier que le dossier data existe
mkdir -p data

# Vérifier les permissions
chmod 755 data
```

### Problèmes de mémoire

```bash
# Augmenter la limite de mémoire Node.js
node --max-old-space-size=4096 server.js
```

---

## 📚 RESSOURCES ADDITIONNELLES

- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Node.js Production Best Practices](https://nodejs.org/en/docs/guides/nodejs-docker-webapp/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)

---

## ✅ CHECKLIST DE DÉPLOIEMENT

Avant de déployer en production, vérifier:

- [ ] Mot de passe admin par défaut changé
- [ ] JWT_SECRET configuré avec une valeur forte
- [ ] Variables d'environnement configurées
- [ ] HTTPS activé
- [ ] Vulnérabilités npm corrigées
- [ ] Logs configurés avec rotation
- [ ] Backup de la base de données configuré
- [ ] Health checks automatiques configurés
- [ ] Monitoring en place
- [ ] Firewall configuré (ouvrir seulement ports nécessaires)
- [ ] Tests de charge effectués
- [ ] Documentation mise à jour
- [ ] Plan de rollback préparé

---

**Date de création**: 2026-03-19  
**Version du guide**: 1.0  
**Maintenu par**: Sudo Studio Team
