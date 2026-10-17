# Sudo Studio

Assistant de code IA fonctionnant **100 % en local** : éditeur marbré
(VSCodium), backend Node.js, runtime Python (modèle GGUF) et extension
d'assistant. Aucun appel réseau vers un fournisseur IA par défaut ;
l'inférence tourne sur la machine via le runtime local.

> État du dépôt (P28, 17/10/2026) : nettoyage honnêteté terminé —
> 25 suites de tests statiques vertes (`cd backend && npm test`),
> modules simulés supprimés, documentation réécrite sur le code réel.
> Les affirmations ci-dessous sont limitées à ce qui est vérifié.

## Contenu réel et vérifié

| Composant | Rôle réel | Port / accès | Preuve |
|---|---|---|---|
| `backend/server.js` | API REST + Socket.IO (auth, chat, licences, doctor, devops) | `:5000` | suites P1–P27 vertes |
| `backend/runtime/server.enterprise.py` | Inférence locale (GGUF via llama-cpp), API OpenAI-compatible | `:6000` | `/health`, `/v1/models` (testé avec mocks ; essai modèle réel sur PC = en attente) |
| `sudo-ai-extension/` | Extension : 13 panneaux (chat, agent, doctor, sécurité…) | F5 / VSIX | `test-extension-complete.js` 102/102 |
| `sudo-agent/` | Serveur agent local (stdlib uniquement, sandbox L1) | spawn local | `sudo-agent/README.md` |
| `vscodium/` | Sources de l'éditeur marbré à la packaging | — | workflow `03-package.yml` |
| `scripts/pc-verify.ps1` | Vérification pré-build sur PC Windows réel | PC | 12 sections, modèle L1 |

Modèle par défaut : **Qwen2.5-Coder-1.5B-Instruct-GGUF** (Q4_K_M),
téléchargé automatiquement au premier démarrage du runtime
(`--no-auto-download` pour désactiver).

## Limites connues (lues avant démo/vente)

- **Sandbox L2 supprimée (P27)** : seule la sandbox **L1** est active
  (Job Object + jeton restreint sous Windows). L'isolation système de
  fichiers/réseau de type L2 n'existe plus ; l'UI l'indique honnêtement.
- **Aucun essai modèle réel sur PC à ce jour** : les suites passent en
  CI/sandbox avec mocks ; le chargement du GGUF 1.5B sur un PC Windows
  réel reste à prouver (`SUDO_LIVE=1` + `scripts/pc-verify.ps1`).
- **Cible packaging = Windows x64** (workflows 01/02/03). Linux/macOS :
  développement et tests uniquement, installeur non fourni.
- **Base avis embarquée réduite** : `advisories.json` commité est un
  extrait (2026-10-11) ; la base complète est reconstruite à chaque
  packaging (étape 7c du workflow 03).
- **Émulateur = docker requis** : les routes `/emulator/*` exigent un
  compte admin + docker fonctionnel, sinon erreur explicite.
- **Compte admin initial** : `admin` / `admin123` créé au premier
  démarrage (stocké hashé bcrypt). À changer immédiatement.

## Matériel recommandé

| Usage | RAM totale conseillée | Pourquoi |
|---|---|---|
| Backend + extension seuls | 4 Go | Node + éditeur |
| + runtime Qwen 1.5B (Q4_K_M) | **8 Go** | ~1,5 Go pour le modèle (estimation du code, **non mesurée sur PC**) |
| + variante 7B | 16 Go | ~5,5 Go modèle (même réserve) |

CPU : x86-64 récent (le build llama-cpp embarque une variante de
compatibilité pour vieux CPU, voir `backend/runtime/requirements.txt`).
Disque : ~2 Go + ~1 Go par modèle GGUF. GPU non requise (inférence CPU).

## Installation (développement)

Prérequis : Node.js 18+ (20 testé), Python 3.11+, Git.
Docker optionnel (émulateur uniquement).

```bash
# 1. Backend (port 5000)
cd backend && npm install && node server.js

# 2. Runtime IA (port 6000) — autre terminal
cd backend/runtime && pip install -r requirements.txt
python server.enterprise.py --port 6000

# 3. Extension — ouvrir sudo-ai-extension/ dans VSCodium, F5.
#    Dépendances webview : cd sudo-ai-extension && npm install
```

Vérification : `cd backend && npm test` (25 suites statiques),
puis `SUDO_LIVE=1 npm test` quand runtime + backend tournent.

## Mise à jour hors ligne

1. Télécharger le nouvel installeur (ou archive) depuis un poste en ligne.
2. L'apporter sur la machine cible (USB) et réinstaller par-dessus :
   la base `data/enterprise.json` et `~/.sudo_studio` (licence, journaux)
   sont conservés.
3. Base vulnérabilités : reconstruite à chaque packaging officiel
   (`node backend/tools/build-advisory-db.js`, étape 7c du workflow 03) ;
   le fichier embarqué porte sa date `generatedAt`, et l'UI signale
   une base périmée (> 90 jours).

## Licences

- **Produit propriétaire** : éditions Community / Team / Enterprise,
  clés hors ligne signées Ed25519. Détail et cérémonie de génération :
  [`LICENSING.md`](LICENSING.md).
- Code tiers et données (Codicons, highlight.js, Plex, avis OSV…) :
  `sudo-ai-extension/THIRD_PARTY_NOTICES.md` et
  `sudo-agent/THIRD_PARTY_NOTICES.md`.
- Sources VSCodium (`vscodium/`) : licence MIT d'origine conservée
  (`vscodium/LICENSE`).

## Documentation

| Document | Contenu |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Composants, ports, flux de données |
| [`BUILD.md`](BUILD.md) | Reconstruction depuis zéro (dev + packaging CI) |
| [`LICENSING.md`](LICENSING.md) | Clés, éditions, cérémonie PROD |
| [`SECURITY.md`](SECURITY.md) | Modèle de menace : couvert / non couvert |
| [`SECURITY_SCORING.md`](SECURITY_SCORING.md) | Formule du score de sécurité (P10) |
| [`docs/LOGS.md`](docs/LOGS.md) | Journaux techniques unifiés (P21) |
| [`backend/tests/README.md`](backend/tests/README.md) | Suites de tests et compositeur |
| [`sudo-agent/README.md`](sudo-agent/README.md) | Serveur agent local |
