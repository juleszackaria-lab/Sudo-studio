# Sudo Studio — Installation et dossiers (PROMPT 35-c)

## Choix documenté : installation par utilisateur

| | |
|---|---|
| Emplacement | `%LOCALAPPDATA%\Programs\SudoStudio` |
| Droits | **aucun** (ni admin, ni UAC) |
| Mises à jour | sans élévation |

Pourquoi pas Program Files : un dossier inscriptible sans élévation
autorise les mises à jour silencieuses ; les chemins avec parenthèses
(`Program Files (x86)`) ont cassé le lanceur historique (octobre 2026,
désormais corrigé et prouvé par test). Program Files reste SUPPORTÉ :
depuis P21/P34, backend, runtime et extension fonctionnent même sous un
dossier d'installation en lecture seule.

## Règle : le dossier d'installation ne reçoit AUCUNE écriture

Tout état modifiable vit hors installation :

| Contenu | Dossier |
|---|---|
| Données VS Code (`User/`, stockages) | `%LOCALAPPDATA%\SudoStudio\userdata` |
| Extensions actives (`sudo-ai`) | `%LOCALAPPDATA%\SudoStudio\extensions` |
| Journaux (tous composants) | `%LOCALAPPDATA%\SudoStudio\logs` (voir `LOGS.md`) |
| Base locale backend | `%LOCALAPPDATA%\SudoStudio\data\enterprise.json` |
| Lanceur généré | `%LOCALAPPDATA%\SudoStudio\launch.bat` |

L'installeur ne crée plus `data/` ni `logs/` dans `{app}` (sinon
VSCodium basculerait en mode portable). `start.bat` crée les dossiers,
synchronise l'extension livrée (`{install}\extensions\sudo-ai`,
maître en lecture seule) vers la copie active, et exporte
`SUDO_STUDIO_ROOT` (racine réelle pour l'agent) ainsi que
`SUDO_STUDIO_LOGS`.

Exceptions antérieures, hors installation, inchangées :
`~\.sudo_studio\central\audit.json` (journal d'audit, voir `LOGS.md`)
et `~\.sudo_studio` (cache modèles HF + `models/`). Les déplacer
forcerait un re-téléchargement des modèles (Go) : risque/bénéfice
rejeté.

## Migration (premier lancement P35)

Copie seule, jamais de suppression : `{install}\data` → `userdata`
(si réglages présents et cible vide), `{install}\extensions` →
`extensions` (si copie active absente ; le maître livré écrase
ensuite `sudo-ai` au besoin). Ancienne base backend : voir P34
(`LOCALAPPDATA\SudoStudio\data`).

## Lancement sans console (P35-d)

Les raccourcis (Bureau, menu Démarrer, fin d'installation) appellent
`wscript.exe launch_hidden.vbs start.bat` : aucune fenêtre.
`start.bat` reste lançable à la main (mode visible, diagnostic).
Les échecs de démarrage sont écrits dans `startup-errors.txt`
(`logs/`) et affichés dans l'éditeur à l'activation de l'extension.

## Désinstallation

Supprime le dossier d'installation. `%LOCALAPPDATA%\SudoStudio`
(données utilisateur) et `~\.sudo_studio` (modèles, audit) sont
conservés, comme standard.
