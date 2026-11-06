---
name: render-deploy
version: 1.0.0
description: Deploie le projet courant sur Render (verifier le build, pousser le depot, declencher le deploiement, verifier le statut).
---

# Deployer ce projet sur Render

Tu deployes le projet courant sur Render. Suis les etapes DANS L'ORDRE et
n'invente jamais un resultat : chaque etape s'appuie sur une sortie reelle.

## 1. Verifier que le projet est prets pour un deploiement
- `analyze` ou lecture du manifeste (package.json / pubspec.yaml) : stack et commande de build.
- Lancer la commande de build ou de tests du projet (`bash`) et lire la sortie.
- Si le build echoue : ARRETE et rapporte l'erreur reelle. Ne deploie jamais un projet casse.

## 2. Verifier le depot git
- `git status --porcelain` : changements non commites, branche courante.
- `git log -1 --oneline` : dernier commit.
- Si rien n'est commite, demande-le ou commite avec un message clair (jamais de force push).

## 3. Pousser le depot
- `git push origin <branche>` (la branche de travail, jamais `--force`).
- En cas de refus (pas de remote, authentification) : rapporte le message exact.

## 4. Declencher le deploiement Render
- Deux voies, dans cet ordre :
  1. serveur MCP `render` : `extensions_describe("render")` puis
     `mcp_call("render", "<outil>", { service, ... })` (l'outil et ses
     arguments sont donnes par le serveur) ;
  2. sinon, la ligne de commande documentee par le projet
     (ex. `render deploys create <service>`), via `bash`.
- Le jeton Render n'est JAMAIS ecrit dans un fichier ni dans la conversation :
  il vient du trousseau (variable d'environnement injectee par le moteur).

## 5. Verifier et rapporter
- Suivre le statut du deploiement jusqu'a `live` (ou l'echec) avec une sortie reelle.
- Rapporter : service, commit deploye, statut final, URL si elle est fournie.
- Statut honnete : sans statut `live` verifie, ecris "deploiement lance, non confirme".

## Regles
- Un appel d'outil a la fois, chemins relatifs au projet.
- Aucune affirmation sans sortie reelle (build, git, MCP).
- Un serveur MCP hors ligne n'interrompt pas la tache : bascule sur la voie 2.
