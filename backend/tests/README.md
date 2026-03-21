# 🧪 GUIDE DES TESTS - SUDO STUDIO BACKEND

## 📊 Résumé des Tests

**Total**: 89 tests  
**Réussis**: 77 (86.5%) ✅  
**Échoués**: 12 (13.5%) ❌  
**Couverture**: 32.56%

---

## 🚀 Exécution des Tests

### Commandes Disponibles

```bash
# Exécuter tous les tests avec rapport de couverture
npm test

# Exécuter les tests en mode watch (développement)
npm run test:watch

# Exécuter seulement les tests unitaires
npm run test:unit

# Exécuter seulement les tests d'intégration
npm run test:integration
```

---

## 📁 Structure des Tests

```
tests/
├── unit/                      # Tests unitaires
│   ├── aiModelsManager.test.js   # Tests du gestionnaire de modèles AI
│   └── user.model.test.js        # Tests du modèle utilisateur
└── integration/               # Tests d'intégration
    ├── admin.routes.test.js      # Tests des routes admin
    ├── monitor.routes.test.js    # Tests des routes monitoring
    ├── papito.routes.test.js     # Tests des routes papito
    └── server.test.js            # Tests d'intégration serveur
```

---

## ✅ Tests qui Passent (77)

### 🔐 Admin Routes (18/18) - 100% ✅

#### POST /login
- ✅ Connexion avec identifiants valides
- ✅ Échec avec nom d'utilisateur invalide
- ✅ Échec avec mot de passe invalide
- ✅ Validation du nom d'utilisateur requis
- ✅ Validation du mot de passe requis
- ✅ Gestion des erreurs serveur

#### POST /admin/users
- ✅ Création d'utilisateur par admin
- ✅ Refus sans token
- ✅ Refus avec token invalide
- ✅ Refus pour non-admin
- ✅ Validation du nom d'utilisateur
- ✅ Validation de la longueur du mot de passe (min 6 caractères)
- ✅ Validation du rôle (admin/developer uniquement)
- ✅ Gestion des erreurs de création

#### JWT & RBAC
- ✅ Format Bearer token accepté
- ✅ Format invalide rejeté
- ✅ Admin autorisé à créer utilisateurs
- ✅ Developer non autorisé à créer utilisateurs

### 📊 Monitor Routes (15/16) - 94% ✅

#### GET /health
- ✅ Retourne OK avec version
- ✅ Retourne OK sans version.json
- ✅ Gère erreurs de parsing JSON
- ✅ Gère erreurs système de fichiers
- ✅ Format timestamp ISO 8601

#### GET /version
- ✅ Retourne informations de version
- ✅ Retourne 404 si fichier absent
- ✅ Gère erreurs de parsing
- ✅ Gère erreurs de lecture
- ✅ Structure d'objet complète

#### Fiabilité
- ✅ Répond même en cas d'échec
- ✅ Temps de réponse < 1 seconde
- ❌ Vérification du chemin (test trop strict)
- ✅ Gère requêtes concurrentes

#### Headers HTTP
- ✅ Content-Type JSON pour /health
- ✅ Content-Type JSON pour /version

### 🤖 Papito Routes (17/20) - 85% ⚠️

#### POST /papito/analyze
- ✅ Appel analyzeData quand authentifié (4/4)
- ✅ Retour 401 sans authentification
- ✅ Retour 501 si fonction indisponible
- ✅ Gestion des erreurs

#### POST /papito/debug
- ✅ Appel debugAI (4/4)
- ✅ Réponse simulée en fallback
- ✅ Vérification authentification
- ✅ Gestion des erreurs

#### POST /papito/create-project
- ✅ Création de projet (3/3)
- ✅ Réponse simulée en fallback
- ✅ Vérification authentification

#### POST /papito/devops
- ✅ Configuration DevOps (3/3)
- ✅ Réponse simulée en fallback
- ✅ Vérification authentification

#### Emulator Routes (Admin Only)
- ❌ POST /papito/emulator/start (timeout)
- ✅ Refus pour non-admin (2/2)
- ✅ Refus sans authentification (2/2)
- ❌ POST /papito/emulator/status (timeout)
- ✅ Refus pour non-admin (1/1)
- ❌ POST /papito/emulator/stop (timeout)
- ✅ Refus pour non-admin (1/1)

### 🧠 AI Models Manager (7/16) - 44% ⚠️

#### Tests Réussis
- ✅ listModels retourne un tableau
- ✅ getModelInfo retourne null si inexistant
- ✅ getModelInfo inclut size et path
- ✅ downloadModel télécharge avec succès (2/2)
- ✅ deleteModel supprime avec succès (2/2)
- ✅ throw error pour modèle inexistant

#### Tests Échoués (problèmes de mocks)
- ❌ listModels status stopped
- ❌ getModelInfo pour modèle existant
- ❌ startModel (5 tests)
- ❌ infer (3 tests)
- ❌ Port management (1 test)

---

## ❌ Tests qui Échouent (12)

### 1. Papito Emulator Routes (3 échecs)

**Problème**: Timeout après 5000ms

```
POST /papito/emulator/start - Timeout
POST /papito/emulator/status - Timeout
POST /papito/emulator/stop - Timeout
```

**Cause**: Le contrôleur emulator mock ne répond pas correctement dans les tests

**Solution**:
```javascript
// Dans tests/integration/papito.routes.test.js
emulatorController.start = jest.fn(async (req, res) => {
  res.json({ message: 'emulator started' });
});
```

### 2. AI Models Manager (9 échecs)

**Problème**: Mocks ne configurent pas correctement les métadonnées

**Tests échoués**:
- listModels - status stopped non trouvé
- getModelInfo - retourne null au lieu de l'objet
- startModel - toutes les variantes
- infer - toutes les variantes
- Port management

**Solution**: Améliorer la configuration des mocks dans `beforeEach`:

```javascript
beforeEach(() => {
  // Recréer le module pour chaque test
  jest.resetModules();
  
  // Configurer les mocks AVANT de require le module
  fs.readFileSync.mockReturnValue(JSON.stringify({
    'test-model': { /* metadata */ }
  }));
});
```

### 3. Server Integration Tests

**Problème**: "Server is not running"

**Cause**: Socket.IO et serveur HTTP ne démarrent pas correctement dans l'environnement de test

**Solution**: Refactoriser server.js pour exporter l'app Express séparément:

```javascript
// server.js
const app = createApp(); // Exporter cette fonction
const server = http.createServer(app);

module.exports = { app, server };
```

### 4. User Model Tests

**Problème**: Module bcrypt ne peut pas être chargé

**Erreur**: `bcrypt/package.json does not exist`

**Cause**: Binding natif bcrypt non compatible avec l'environnement de test

**Solution**:

```javascript
// Dans le test
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true)
}));
```

---

## 📈 Couverture de Code

### Par Module

| Module | Statements | Branches | Functions | Lines |
|--------|-----------|----------|-----------|-------|
| Routes | 96.55% ✅ | 89.28% ✅ | 100% ✅ | 96.46% ✅ |
| Middleware | 73.91% ✅ | 56.25% ⚠️ | 66.66% ⚠️ | 83.33% ✅ |
| Utils (logger) | 88.88% ✅ | 66.66% ⚠️ | 0% ❌ | 87.5% ✅ |
| Security | 100% ✅ | 100% ✅ | 100% ✅ | 100% ✅ |
| AI | 38.37% ❌ | 24.13% ❌ | 29.41% ❌ | 38.5% ❌ |
| Controllers | 9.43% ❌ | 13.33% ❌ | 0% ❌ | 9.8% ❌ |
| Models | 16.39% ❌ | 9.52% ❌ | 0% ❌ | 17.85% ❌ |
| Services | 0% ❌ | 100% | 0% ❌ | 0% ❌ |

### Objectifs de Couverture

- **Actuel**: 32.56%
- **Objectif court terme**: 60%
- **Objectif long terme**: 80%

---

## 🔧 Configuration Jest

Fichier `package.json`:

```json
{
  "jest": {
    "testEnvironment": "node",
    "coverageDirectory": "coverage",
    "collectCoverageFrom": [
      "**/*.js",
      "!node_modules/**",
      "!coverage/**",
      "!tests/**",
      "!jest.config.js"
    ],
    "testMatch": [
      "**/tests/**/*.test.js"
    ]
  }
}
```

---

## 🎯 Ajouter de Nouveaux Tests

### Template de Test Unitaire

```javascript
// tests/unit/votre-module.test.js
const yourModule = require('../../path/to/your-module');

describe('Your Module', () => {
  beforeEach(() => {
    // Setup avant chaque test
  });

  afterEach(() => {
    // Cleanup après chaque test
    jest.clearAllMocks();
  });

  describe('functionName', () => {
    it('should do something specific', () => {
      const result = yourModule.functionName(input);
      expect(result).toBe(expectedOutput);
    });

    it('should handle errors', () => {
      expect(() => {
        yourModule.functionName(invalidInput);
      }).toThrow('Expected error message');
    });
  });
});
```

### Template de Test d'Intégration

```javascript
// tests/integration/your-routes.test.js
const request = require('supertest');
const express = require('express');
const yourRoutes = require('../../routes/your-routes');

describe('Your Routes Integration Tests', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/', yourRoutes);
  });

  describe('GET /your-endpoint', () => {
    it('should return 200 with data', async () => {
      const response = await request(app).get('/your-endpoint');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });
  });
});
```

---

## 🐛 Debugging Tests

### Exécuter un seul test

```bash
# Par nom de fichier
npm test -- tests/integration/admin.routes.test.js

# Par pattern
npm test -- --testNamePattern="should login"

# Mode debug
node --inspect-brk node_modules/.bin/jest --runInBand
```

### Voir plus de détails

```bash
# Mode verbose
npm test -- --verbose

# Voir les handles ouverts
npm test -- --detectOpenHandles

# Désactiver le cache
npm test -- --no-cache
```

---

## 📚 Ressources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)

---

## ✅ Checklist Avant Commit

- [ ] Tous les tests passent (`npm test`)
- [ ] Couverture >= 70% pour les nouveaux fichiers
- [ ] Pas de console.log dans le code de production
- [ ] Mocks correctement nettoyés après chaque test
- [ ] Tests documentés avec des descriptions claires
- [ ] Edge cases couverts

---

**Dernière mise à jour**: 2026-03-19  
**Mainteneur**: Sudo Studio Team
