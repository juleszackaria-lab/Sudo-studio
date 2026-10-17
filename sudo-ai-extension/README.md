# Extension Sudo Studio (VSCode / VSCodium)

Assistant de code IA **local d'abord** : l'extension est l'interface
(13 panneaux + 90 commandes) ; l'intelligence vient du backend
(`:5000`) et du runtime IA local (`:6000`, GGUF). Aucun compte cloud,
aucune télémétrie.

## Ce que fait réellement l'extension

- **Chat IA** (`Open AI Chat`) : conversation avec le modèle local,
  rendue 100 % hors ligne (moteur partagé `getWebviewHtml`).
- **Agent** : exécution supervisée de tâches (outils fichiers/shell
  confinés, approbation des actions mutantes, sandbox L1).
- **Doctor / SDK / Runtime / Environment / DevOps** : diagnostic réel
  du poste, gestion des SDK, modèles et environnements.
- **Security / Duplication / ProjectAnalysis / Central / Logs /
  License / Providers** : audit vulnérabilités hors ligne, doublons,
  analyse projet, gestion centrale, journaux, licences, fournisseurs.
- **Fournisseurs** : `local` (runtime, défaut) ou `cloud` explicitement
  activé par l'administrateur (liste blanche + SecretStorage).

## Prérequis

1. Backend en route : `cd backend && node server.js` (`:5000`).
2. Runtime IA en route : `python backend/runtime/server.enterprise.py`
   (`:6000`, modèle Qwen2.5-Coder-1.5B téléchargé au 1er besoin).
3. Dépendances webview : `cd sudo-ai-extension && npm install`
   (`axios` + `marked` uniquement).

## Installation

```bash
# Mode développement : ouvrir ce dossier dans VSCodium, F5.

# Paquet installable :
npx vsce package   # → sudo-ai-2.1.0.vsix
codium --install-extension sudo-ai-2.1.0.vsix
```

## Réglages (`sudoStudio.*`)

| Clé | Défaut | Rôle |
|---|---|---|
| `backendUrl` | `http://localhost:5000` | backend Sudo Studio |
| `runtimeUrl` | `http://127.0.0.1:6000` | runtime IA local |
| `offlineInstallersDir` | `""` (= `~/.sudo_studio/installers`) | installeurs hors ligne (SDK) |

## Vie privée

Aucune donnée ne quitte la machine en configuration par défaut :
inférence locale, score de sécurité calculé localement, journaux
locaux (`docs/LOGS.md` racine). Seule l'activation explicite d'un
fournisseur `cloud` envoie des prompts à la `baseUrl` configurée.

## Licences tierces

Voir [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) (Codicons,
highlight.js, Plex, base avis OSV) et [`DESIGN_NOTES.md`](DESIGN_NOTES.md)
(notes d'UI P13).
