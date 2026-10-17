# ARCHITECTURE — Sudo Studio

Vue acheteur : composants, ports, flux. Tout ce qui suit est lu dans le
code le 17/10/2026 (P28) ; les éléments non câblés sont signalés.

## Vue d'ensemble

```
┌─────────────────────┐   HTTP :5000    ┌──────────────────────┐
│ Éditeur marbré      │◄───────────────►│ Backend Node.js      │
│ (VSCodium +         │   (JWT)         │ backend/server.js    │
│  sudo-ai-extension) │                 │ 12 modules de routes │
└─────────┬───────────┘                 └──────────┬───────────┘
          │ WebSocket / spawn            HTTP :6000│
          ▼                              (boucle locale) ▼
┌─────────────────────┐                 ┌──────────────────────┐
│ sudo-agent          │                 │ Runtime Python (IA)  │
│ serveur agent local │                 │ server.enterprise.py │
│ stdlib uniquement   │                 │ GGUF + llama-cpp     │
└─────────────────────┘                 └──────────────────────┘
```

## Composants et ports

| Composant | Dossier | Port | Protocole | Authentification |
|---|---|---|---|---|
| Backend API | `backend/` | `5000` (`PORT` ou 5000, écoute `0.0.0.0`) | HTTP + Socket.IO | JWT (`/api/auth/*`), bcrypt |
| Runtime IA | `backend/runtime/` | `6000` (`--port`, `--host` défaut `127.0.0.1`) | HTTP REST + OpenAI-compat | aucune (boucle locale uniquement) |
| Agent local | `sudo-agent/` | éphémère (spawn, poignée `ready` sur stdout) | HTTP + jeton | `SUDO_AGENT_TOKEN` 32 octets |
| Extension | `sudo-ai-extension/` | — (dans l'éditeur) | appels backend + agent | JWT + stockage secret VSCode |
| Superviseur runtime | `backend/routes/supervisor.routes.js` | via backend | `GET /api/supervisor/runtime-status` | aucune (comme `/health`) |

## Backend — modules de routes (tous montés à `/`)

| Module | Espace | Rôle |
|---|---|---|
| `auth.routes.js` | `/api/auth/*` | login JWT, dev-token, verify, status |
| `admin.routes.js` | `/login`, `/admin/users` | users (création admin, hash bcrypt) |
| `ai.routes.js` | `/api/ai/*` | chat, modèles, explain/fix de code (proxy vers runtime) |
| `models.routes.js` | `/api/models/*` | list/download/switch/status/install des modèles |
| `devops.routes.js` | `POST /api/devops/generate` | **seule** route devops (générateur de templates) |
| `emulator.routes.js` | `POST /emulator/start\|status\|stop` | contrôle docker (admin ; docker requis) |
| `environment.routes.js` | `/api/environment/*` | statut/export/sync/snapshot/requirements (Team+) |
| `project.routes.js` | `/api/project/*` | analyse, auto-fix, structure, création |
| `sdk.routes.js` | `/api/sdk/*` | list/install/detect des SDK |
| `monitor.routes.js` | `/health`, `/version` | sondes publiques |
| `system.routes.js` | `/api/system/*` | status, routes, health, **doctor** (diagnostic réel), autofix (instructions) |
| `supervisor.routes.js` | `/api/supervisor/runtime-status` | état du runtime vu du backend |

Données backend : `data/enterprise.json` (lowdb, créé au 1er démarrage ;
compte `admin`/`admin123` initial, hash bcrypt) ; licence dans
`~/.sudo_studio/` ; journaux techniques `~/.sudo_studio/logs`
(voir `docs/LOGS.md`).

## Runtime IA — points d'accès (`:6000`)

- `GET /health`, `GET /` — sondes.
- `POST /infer`, `POST /chat`, `POST /infer-stream` — inférence.
- `GET /v1/models`, `POST /v1/chat/completions` — compatibilité OpenAI
  (`openai_compat.py`, avec politique `n_ctx` selon la RAM).
- `GET /models`, `POST /reload`, `POST /download`,
  `GET /models/download-status`, `GET /models/catalogue`, `GET /scan` —
  gestion des modèles (téléchargement HuggingFace au 1er besoin).

Modèle par défaut : `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF` (Q4_K_M).
Catalogue connu : variantes Qwen2.5-Coder 1.5B/3B/7B/14B (+ table
mémoire indicative dans le code, **non mesurée sur PC**).

## Extension — 13 panneaux

`CentralMgmt, Chat, DevOps, Doctor, Duplication, Environment, License,
Logs, ProjectAnalysis, Providers, Runtime, SDK, Security`.
Le chat et l'agent partagent le même moteur de rendu webview
(`getWebviewHtml`, 100 % hors ligne : Plex + highlight.js vendus).

Fournisseurs IA (`Providers`, suite P2) : type `local` (runtime `:6000`,
défaut) ou `cloud` (baseUrl http(s) + inscription sur liste blanche,
**désactivé par défaut**, clé dans le SecretStorage, jamais sur disque).

## Flux principaux

1. **Chat IA** : webview → `POST :5000/api/ai/chat` (JWT) → backend →
   `POST :6000/chat` → GGUF → réponse remontée (stream via Socket.IO).
2. **Agent** : panneau Agent → `sudo-agent` spawné (jeton, sandbox **L1** :
   Job Object + jeton restreint sous Windows) → outils autorisés par
   politique → appels runtime via `baseUrl` configurée.
3. **Doctor** : `POST :5000/api/system/doctor` exécute de vrais contrôles
   (Node, Python, Git, Docker, runtime) et rend un diagnostic ; l'autofix
   rend des instructions (ou déclenche le téléchargement modèle).
4. **Sécurité projet** : `SecurityPanel` + `localAudit.js` croisent le
   projet avec `advisories.json` embarqué (généré à la packaging, P23) ;
   score déterministe (`SECURITY_SCORING.md`), 100 % local.
5. **Licences** : clé `base64url(payload).base64url(signature)` Ed25519
   vérifiée **hors ligne** (`backend/src/license/license.js` + miroir
   extension) ; feature-gates `community/team/enterprise`
   (voir `LICENSING.md`).

## Présent mais non câblé (à savoir avant achat)

- `backend/services/autofix.enterprise.js` (841 l.) et
  `backend/doctor/environmentDoctor.enterprise.js` (473 l.) : modules
  réels mais **non requis** par le serveur (le doctor/autofix exposés
  sont implémentés dans `system.routes.js`). `sdkInstaller.enterprise.js`
  est utilisé par la suite P21.
- Détection L2 (`detectL2`/`pickL2`) : conservée pour afficher un motif
  d'indisponibilité honnête ; l'exécution L2 n'existe plus (P27).

## Supprimé en P28 (ne plus chercher)

Routes papito `/analyze|/debug|/create-project|/devops` (simulées),
5 fausses routes devops (`/simulate`, `/metrics`, `/deploy`,
`/deployments`, `/rollback`), `GET /api/system/audit` (listes en dur),
`backend/index.js` + doctor/installer de base, `moneyfusion.js`,
`filesystem.js`, `aiModelsManager.js`, `papito-core.js`, monture `/ui`
vide, suites jest/mocha, 13 docs obsolètes. Historique git conservé.
