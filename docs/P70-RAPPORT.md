# P70 - MODE AGENT : operations de base sans modele, rapports verifies

Date : 2026-11-25 (sandbox Linux). Branche : `main` seulement, aucun nouveau workflow.

## 0. Tableau court : ce qui touchait deja le sujet (P61 a P69)

| Point P70 | Etat reel avant ce prompt | Preuve / fichier |
|---|---|---|
| Suppression d'un fichier | l'outil `delete` refuse les dossiers (`not_file`) et exige une lecture prealable (`not_read`) ; le modele a donc contourne par `edit` a correspondance approchee | `sudo-agent/src/tools.js` `hDelete` l.1008 ; suite P62-F2 |
| Faux « done » | le moteur croyait le modele sur parole : `verifyClaims` n'existait que pour les blocs FICHIER du format de secours | `backend/tests/test-p68-fallback.js` C11 |
| Statut honnete | `computeRunStatus` + `statusNotice` existaient (P49/P65), mais aucun fait disque n'entrait dans le verdict | `loop.js` l.966 et l.1052 |
| Rebours d'echec | 2 tentatives maximum par cible (`target_given_up`) depuis P62-F4 | vue dans `test-p62-refus-boucle.js` F4 |
| PATH de l'agent (V5) | l'environnement enfant venait de `process.env` filtre (P54/P56) : un PATH herite et perime suffisait a faire apparaitre `absents=node,npm,git,...` | `tools.js` l.709 |
| Checkpoint 500 fichiers (V6) | `checkpoints.js` tronque a 500 entrees (`truncated=true`) | `sudo-agent/src/checkpoints.js` |
| Routage par domaine | `router.js` route par mots-cles de domaine : « supprime le workflow ci-cd puis corrige les failles » partait en `security` (V2) | `router.js` `route()` |

## 1. Partie A - instrumenter

- **Noms d'outils** : chaque tour ecrit desormais une ligne `outils du tour` avec `noms=<outil>/<code>`, et la trace `meta.lastRun.calls` est remplie **aussi** par le chemin rapide (avant, seuls les appels du modele y figuraient).
- **Chronometrage** : `p70/timing.js` mesure `model_ms`, `tools_ms`, `checkpoint_ms`, `git_ms`, `resolve_ms`, `total_ms` ; ligne de journal `temps total=... modele=... checkpoint=...`.
- **PATH vu par l'agent** : une ligne `outils PC | trouves=... absents=... source={...}` par tour.
- **Cout du checkpoint** : mesure `checkpoint_ms` (le plafond 500 est conserve : il protege le disque, et il est desormais chiffre).

## 2. Partie B - chemin rapide sans modele

`sudo-agent/src/p70/{intent,paths,ops,verified,timing,surface,env,fast,edit}.js`

- parseur FR/EN avec tolerance de fautes (« supirme » -> delete), resolution **unique** (ambiguite = on demande, jamais de choix silencieux) ;
- operations : lire, lister, creer (contenu fourni), renommer, deplacer, copier, supprimer ;
- **approbation** : la question passe par `pauseForApproval` du moteur (le meme mecanisme que les outils, pas un second systeme), puis **verification sur le disque** et **point de retour** (`ops.restore`, « annule le run ») ;
- **0 appel modele** et budget de temps : `modelCalls=0` dans le retour, la trace et le journal.

Porte d'activation : `SUDO_P70_FASTPATH=1`, positionnee par `start.bat` et `start.sh` (produit). Un moteur nu garde le comportement historique, ce qui permet aux suites P52/P61/P63 de continuer a tester la boucle modele telle quelle. Le controle negatif I3 verifie que porte fermee = le modele est appele.

## 3. Partie C - ensemble minimal d'outils et consignes composees

- `p70/surface.js` : par intention, la liste minimale est **imposee**, y compris a 2048 et 4096 jetons, et `delete` ne peut plus tomber par reduction de budget quand l'intention est de supprimer.
- `router.js` : une operation qui **modifie** le disque retire la main au routeur par domaine (`domain=null`, `tools=[]`, raison journalisee) et les consignes composees sont coupees en sous-taches `file-op` / `platform`. Une **lecture** ne change rien au routage (aucun effet de bord).

Liste des 20 consignes testees : voir `backend/tests/test-p70-surface.js`, constante `C` (FR et EN, `puis` / `then` / `;`).

## 4. Partie D - rapport verifie

- `p70/verified.js` : `verifyClaims(texte, faits)` ; si le modele annonce une suppression/creation sans fait correspondant, le verdict est force a **ECHEC** avec un message de contradiction (« Le modele a annonce "supprime" mais aucun fichier n'a ete supprime. »).
- `labelFor` : `already_done` -> « deja execute », `await_choice` -> « en attente de votre choix ». Plus jamais « (echec) » pour un dedoublonnage.

## 5. Partie E - edition sure

- `p70/edit.js` : refus si l'intention est une suppression (`intent_delete`) ; correspondance approchee = diff **etiquete** + approbation obligatoire ; apres **2 echecs identiques** sur la meme cible, on s'arrete et on demande.

## 6. Partie F - PATH (V5)

- `p70/env.js` : PATH **registre machine + utilisateur** lu a chaque tour (Windows), `where`/`which`, dossiers connus, et journal `outils PC | trouves=... absents=... ajoutes au PATH enfants=... source=...`.
- `loop.js` : rafraichissement au debut de **chaque** tour, PATH transmis aux commandes enfants (`tools.js`).
- Preuve locale (Linux, sandbox) : `trouves=6 node=/usr/bin/node ; npm=/usr/bin/npm ; git=/usr/bin/git ; python=/usr/local/bin/python ; python3=/usr/local/bin/python3 ; pip=/usr/local/bin/pip | source={"fallback":"environnement du processus","machineEntries":5,"userEntries":0}`.
- Controle negatif (V7c) : PATH force a un dossier inexistant -> `node` et `git` **absents**.
- Windows : `scripts/ci/agent-p70.ps1` imprime le PATH registre et les outils, et joue le controle negatif ; job `p70-windows-path` (windows-2022) dans le workflow `00`.

## 7. Partie G - tests et rejeu

| Suite | Checks | Etat local (Linux, sans modele) |
|---|---|---|
| `backend/tests/test-p70-fastpath.js` | 33 | vert |
| `backend/tests/test-p70-surface.js` | 40 | vert |
| `backend/tests/test-p70-verified-env.js` | 16 | vert |
| `backend/tests/test-p70-integration.js` | 15 | vert (dont controle negatif porte fermee) |
| `scripts/ci/p70-replay.js` (T1 a T10) | 10 PASS, 1 SKIP | vert, `T10 SKIP` = vrai modele non fourni ici |

Non-regression verifiee dans le meme arbre : P59 53/53, P62-F2/F4 13/13, P63 49/49, P52-pause 19/19, P52-orch 9/9, P53 18/18, P68-C 7/7, P26 28/28, P54 23/23.

Chaque suite P70 a ses **controles negatifs** : W1f (phrase sans verbe), W3d (`.git` protege mais `.github` non), W5d (sans point de retour, on refuse de pretendre avoir restaure), W6c (sans contenu, on demande), W8a (faux « c'est supprime » -> ECHEC), I3 (porte fermee -> le modele est appele), V7c (PATH vide), S3 (`delete` non impose a l'intention audit).

### Ce qui n'est PAS encore prouve

- **T10 / vrai modele** : `SKIP` ici (Qwen2.5-Coder-1.5B Q4_K_M non telechargeable dans cette sandbox). Le job `p70-fastpath` prouve le **moteur seul** (faux fournisseur) : a marquer « PROUVE EN CI (moteur seul) ».
- **Aucun run GitHub n'a ete lance** pour ce prompt (consigne explicite). Les jobs `p70-fastpath` et `p70-windows-path` sont ecrits et valides en YAML ; leur premier passage reste a faire.
- **Paquet** : non reconstruit (aucun run packager).

## 8. Hypothese explicite

Le gain de temps du chemin rapide sur la machine de l'utilisateur (Windows, projet maquis pos) reste une **hypothese** tant que `agent-p70.ps1` n'a pas ete execute la-bas : les seules mesures disponibles ici sont celles de la sandbox Linux (T1 : 9 ms, T2 : 3 ms, T3 : 1 ms pour les operations elles-memes, hors demarrage du moteur).
