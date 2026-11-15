# P66 - VERIFICATION INDEPENDANTE (LECTURE SEULE)

Role tenu : verificateur externe. Aucune correction produit, aucun test desactive, aucune
fusion dans main. Tete verifiee : `p60-linux` = **`add0e408e61a0d442e8907dad99c345043941de6`**
(`main` reste a `e6c3d48`, non touche).

Note de perimetre : **tous les runs CI et le paquet ont ete mesures sur `add0e40`**. Le seul
commit posterieur (`0dae9ce`) ajoute ce rapport en Markdown : il ne contient aucun fichier
produit, aucune suite, aucun script executable. Les faits mesures restent donc valables pour la
tete actuelle, a ce fichier de documentation pres.

Nature des preuves, sans exception :

- **PROUVE** : log CI reel (run + sortie collee) ou mesure dont la commande est donnee.
- **PROUVE EN CI (moteur seul)** : suite du depot verte dans un run CI reel (le moteur est
  teste, pas le paquet installe).
- **PARTIEL / NON FAIT / NON PROUVE ICI** : ecrit tel quel quand la chaine s'arrete.

---

## 0. Ce que j'ai fait exactement (tracabilite)

| Etape | Action | Resultat |
|---|---|---|
| 1 | `git rev-parse HEAD` | `add0e40...` ; `git push` de 2 commits de verification (voir « incident » ci-dessous) |
| 2 | Dispatch 00/01/02/03 sur `add0e40` | tous verts (tableau B) |
| 3 | Telechargement de l'artefact installateur du run 03 | `SudoStudio-Setup-5.0.0.exe`, 445 042 538 octets |
| 4 | `sha256sum` sur l'installateur telecharge | `c4067656b8a52593d7a2e6e927de9a3664931e00a4dda40aaea8f66c09326c9d` |
| 5 | Extraction du payload de l'installateur (innoextract 1.9) | **ECHEC** (installateur produit par un Inno Setup plus recent : « setup loader revision 2 ») |
| 6 | Telechargement de l'artefact `sudo-studio-build` (arbre exact compresse par l'installateur, `installer.iss: Source: ".\*"`) | 1 001 492 623 octets, 1,5 Go extraits |
| 7 | Recherches (a) a (f) de la partie C sur cet arbre | resultats en C.5 |
| 8 | Dispatch 06 (fumee paquet installe) | **404 : workflow absent de la branche par defaut** -> non executer (defaut n°2) |
| 9 | Re-verifications locales des 10+ points | sorties en A.2 |

**Incident de ma part, ecrit sans detour** : mon premier commit de P66
(`9a9b66b`) a **ecrase** `scripts/verify/verify-installed.ps1`, qui est un fichier du
**produit** (verificateur P46, 504 lignes). Consequence mesuree : le run `43708348217` a rendu
`test-p46-gate.js` et `test-p48-titlebar-runtime.js` **rouges** (`TOTAL: 65 suites, 2 failed`).
J'ai restaure le fichier depuis `HEAD~1` et deplace mon script en
`scripts/p66-verify-installed.ps1` (commit `add0e40`). Le run `43709182585` est repasse a
`TOTAL: 65 suites, 0 failed`. C'est un defaut de MA methode, pas du produit : il est liste en
E n°8 parce qu'il revele aussi une fragilite du gate.

---

## A1. Etat des promesses (59, 61, 62, 63, 63-B, 64, 65)

Ce que j'ai pu re-mesurer aujourd'hui sur `add0e40` est indique ; le reste est marque.

| Prompt | Point promis | Etat aujourd'hui sur la tete | Nature de la preuve |
|---|---|---|---|
| P59 | Mode agent de bout en bout, 20 etapes scenario | Suites vertes, script present | **PROUVE EN CI (moteur seul)** - run `43709182585` (`TOTAL: 65 suites, 0 failed`) ; `scripts/agent-e2e.ps1` present (23 etapes) |
| P59 | Pont plateforme + routeur deterministe | Fichiers livres | **PROUVE (code)** : `sudo-agent/src/platform.js`, `router.js` presents dans le paquet |
| P61 | Suite complete verte (51 suites alors) | 65 suites vertes | **PROUVE EN CI** : run `43709182585`, job « 49 suites (backend composer) » : `TOTAL: 65 suites, 0 failed`, `suites executees : 65 (minimum exige : 54)` |
| P61 | Budget 70 % applique aux schemas d'outils | Test E2 vert | **PROUVE EN CI (moteur seul)** : `backend/tests/test-p26-agent-loop.js` dans le run |
| P61 | Reponse finale toujours dans le transcript | Test vert | **PROUVE EN CI (moteur seul)** |
| P62 | Copie de projet, reprise runtime, 3 essais/etape | Suites vertes | **PROUVE EN CI (moteur seul)** : `test-p62-*.js` (6 suites) |
| P62 | Verification de paquet installe | Workflow 06 injoignable | **NON PROUVE ICI** (defaut n°2) |
| P63 | Aucun fichier d'agent dans le projet (P63-D) | Code livre + suites vertes | **PROUVE EN CI (moteur seul)** ; chemins d'etat hors projet confirmes en C.5(f) |
| P63 | Cahier des charges -> plan annonce = etapes executees | Suites vertes | **PROUVE EN CI (moteur seul)** (`test-p63-agent.js`, `test-p63-json.js`) |
| P63-B | Smoke paquet installe vert | Le run cite (`43648790493`) **n'existe plus** (404) et 06 n'est pas declenchable | **NON PROUVE ICI / preuve d'origine non re-verifiable** (defaut n°2) |
| P64 | Manifeste modeles + SBOM CycloneDX + inventaires | Fichiers presents | **PROUVE (depot)** : `models-manifest.json`, `docs/sbom/sbom-sudo-studio.cdx.json` (`bomFormat: CycloneDX`, `specVersion 1.7`, **445 composants**), `docs/p64/{gitleaks-worktree,inventaire-reseau,provenance-opencode}.json` |
| P64 | Aucune trace de marque Microsoft dans le paquet | **NON TENU** | **PROUVE (paquet)** : 25 chaines `microsoft` dans `resources/app/product.json` (defaut n°3) |
| P65 | Tours vides (A), profils (B), banc (C), delegation (E), MCP/skill (F) | Suites vertes, banc 38/38 | **PROUVE EN CI (moteur seul)** ; banc : **PROUVE** (job bloquant, `TOTAL : 38/38`, run `43709182585`) |
| P65 | Paquet installe / vrai modele | non executable ici | **NON PROUVE ICI** |

---

## A2. Re-verification de 10 points notes « SUCCESS / PROUVE » (rejoues maintenant)

Commandes : `node backend/tests/test-<nom>.js` apres `npm ci` dans `backend` et
`sudo-ai-extension`. Sorties collees telles quelles.

| # | Point ancien | Sortie du jour | Tient ? |
|---|---|---|---|
| 1 | P24 registre d'outils (49 -> 50) | `P24: 35/35 passed` | OUI |
| 2 | P26 profils/surface (28) | `P26: 28/28 passed` | OUI |
| 3 | P43 budget/contexte (20) | `20/20 P43 tests passed` | OUI |
| 4 | P49 regime strict (25) | `25/25 P49 tests passed` | OUI |
| 5 | P54 extensions (23) | `23/23 P54 tests passed` | OUI |
| 6 | P59 plateforme (53) | `P59: 53/53 passed` | OUI |
| 7 | P62 refus/boucle (13) | `P62-F2/F4: 13 checks passed (all green)` | OUI |
| 8 | P65-A tours vides (18) | `TOTAL P65-A : 18 PASS, 0 FAIL` | OUI |
| 9 | P65-E delegation (11) | `TOTAL P65-E : 11 PASS, 0 FAIL` | OUI |
| 10 | P65-F MCP + skill (6) | `TOTAL P65-F : 6 PASS, 0 FAIL` | OUI |
| 11 | P65-B profils (12) | `TOTAL P65-B : 12 PASS, 0 FAIL` | OUI |
| 12 | P30 backend + selftest (30) | `P30-backend: 30 checks passed (all green)` ; `node server.js --selftest` -> `SELFTEST PASS` | OUI (apres `npm ci` : sans node_modules, 29 modules manquants et 3 suites rouges — c'etait mon environnement, pas le produit) |
| 13 | Banc 38 taches (2 entrees) | `TOTAL : 38/38 taches reussies (100%)` (`agent-bench.js` et `agent-bench.sh --out /tmp/bench-out`) | OUI |

**Ce qui ne tient plus : rien sur ces 13 points.** En revanche deux points de P63-B/P64 ne
tiennent pas : le run de fumee cite n'est plus consultable (404) et la promesse « aucune marque
Microsoft » est fausse dans le paquet (C.5.d).

---

## B. CI complete sur la tete (run par run)

Runs dispatchés sur `add0e408e61a0d442e8907dad99c345043941de6` :

| Workflow | Run | Jobs | Resultat |
|---|---|---|---|
| 00 - Test suite | `43709182585` | « 49 suites (backend composer) » `success` ; « PowerShell syntax (scripts/*.ps1) » `success` ; « Agent bench (faux fournisseur) » `success` | **VERT** |
| 01 - Build Backend EXE | `43709184207` | `build-backend` | **VERT** |
| 02 - Build Runtime | `43709185677` | `build` | **VERT** (`[OK] server.exe built: 246 MB`) |
| 03 - Package Sudo Studio | `43709187255` | `package` | **VERT** (`[OK] Inno Setup installer built successfully`, `SudoStudio-Setup-5.0.0.exe`) |
| 06 - Smoke paquet installe | - | - | **NON LANCE : dispatch 404** (workflow absent de la branche par defaut) |

Sorties collees (run 00) :

```
TOTAL: 65 suites, 0 failed
suites executees : 65 (minimum exige : 54)
[PASS] p66-verify-installed.ps1
Tous les scripts .ps1 sont syntaxiquement valides.
TOTAL : 38/38 taches reussies (100%)
```

**Rouges / jaunes / ignores / desactives :**

- Rouges : **aucun** dans les 4 workflows executables (sur `add0e40`).
- Jaunes (avertissements non bloquants) : `test-ai-flow.js` -> `SKIP test-ai-flow.js (live E2E
  needs runtime+backend; rerun with SUDO_LIVE=1)` ; l'etape CI « No SKIP hidden as a pass »
  l'accepte explicitement. Avertissement GitHub « Node.js 20 is deprecated » sur 03 (actions).
- Workflow injoignable : **06** (voir defaut n°2).
- Aucun test ni workflow supprime, desactive ou ignore par moi.

**Ecart de compte de suites depuis le P63 (60 annonce, 65 mesure)** : entierement explique.
En retirant les 5 suites ajoutees apres le P63 - `test-p64-profiles.js` (P64) et les 4
`test-p65-*.js` (P65) - on retombe exactement sur 60. Compte verifie :
`ls backend/tests/test-p*.js | wc -l` = **64**, plus `test-extension-complete.js` = **65**.

---

## C4. Paquet construit depuis la tete

| Element | Valeur mesuree |
|---|---|
| Run du paquet | `43709187255` (workflow 03, tete `add0e40`) |
| Artefact | `sudo-studio-installer`, zip 444 612 121 octets |
| Installateur | `SudoStudio-Setup-5.0.0.exe` |
| Taille exacte | **445 042 538 octets** |
| SHA256 complet | **`c4067656b8a52593d7a2e6e927de9a3664931e00a4dda40aaea8f66c09326c9d`** |
| Commits des trois composants (API) | sudo-studio `add0e408e61a0d442e8907dad99c345043941de6` ; backend (run `43709184207`) `add0e408...` ; runtime (run `43709185677`) `add0e408...` |
| Ligne « build : <sha> » dans le journal de demarrage | **IMPOSSIBLE A OBTENIR, et c'est un defaut** : le paquet ne contient **aucun** `build-manifest.json`, donc `start.bat` ecrit `Build commit: dev (no build-manifest.json)` |

Preuves du defaut (paquet, pas hypothese) :

```
$ ls build-manifest.json            -> No such file or directory
$ find . -name build-manifest.json  -> 0
$ grep -n "BUILD_COMMIT=dev" start.bat
99:set "BUILD_COMMIT=dev (no build-manifest.json)"
116:    echo   Build commit: !BUILD_COMMIT!
$ grep -c "MANIFEST" <log du run 03>  -> 0 (le script scripts/ci/build-manifest.ps1 n'est appele par aucune etape de 03)
```

`scripts/ci/build-manifest.ps1` existe et exige 15 fichiers dont `verify-installed.ps1` ; il
n'est **jamais invoque** : les etapes de `03-package.yml` sont checkout, resolve, runtime,
backend, VSCodium, personnalisation, icone/rcedit, advisory DB, copie des exe, start.bat, Inno,
upload. Aucune etape manifeste.

---

## C5. Recherches dans le contenu livre

Support : l'arbre `build/SudoStudio` de l'artefact `sudo-studio-build` du run `43709187255`,
c'est-a-dire **exactement ce que l'installateur compresse** (`installer.iss`, ligne 90 :
`Source: ".\*"; DestDir: "{app}"`). Ce n'est pas une installation silencieuse (voir C6).

### (a) Trace de dossier `.sudo-agent`

```
$ find . -name ".sudo-agent*"                       -> (aucun)
$ grep -ril "\.sudo-agent" <fichiers livres>        -> sudo-agent/src/stateDir.js, sudo-agent/src/orch.js
$ occurrences hors node_modules                     -> 8
```

Extraits : `stateDir.js` ne contient `.sudo-agent` que comme **chemin d'anciennes versions a
migrer** (`const LEGACY_DIR = '.sudo-agent'`, `detectLegacy`, `migrateLegacy`, message
« Le projet contient un dossier d agent (.sudo-agent) de ... ») ; `orch.js` l'a dans un
commentaire d'en-tete. **Aucun dossier `.sudo-agent` n'est cree ni livre.**

### (b) Chaines anglaises visibles par l'utilisateur

Scan cible (litteraux en contexte `message:/error:/reason:/label:/title:` dans
`sudo-agent/src` + `sudo-ai-extension/src`, prompts modeles `modes.js`/`msgs.js`/`compress.js`
et base OSV `advisories.json` exclus) : **149 chaines anglaises**. Echantillon (fichier:ligne) :

```
sudo-agent/src/agents.js:58        'unknown agent'
sudo-agent/src/server.js:64        'invalid JSON body'
sudo-agent/src/loop.js:1522        'mcp list failed'
sudo-agent/src/loop.js:1694        'compression failed'
sudo-agent/src/loop.js:1827        'verify failed'
sudo-agent/src/registry.js:17      'tool handler required'
sudo-agent/src/prereq.js:187       'ENV: MISSING = '
sudo-agent/src/journal.js:174      '[agent-journal] WARNING: cannot use '
```

Les variantes anglaises de `loop.js:3428-3445` (`Cause: the target ...`, `FAILED: the model
produced ...`) ne s'affichent que si la conversation est en anglais : normal.
Conclusion : la promesse « aucune chaine anglaise » n'est pas tenue **a 100 %** ; elle l'est
pour l'interface principale, pas pour les erreurs internes/journal.

### (c) Secret ou jeton dans les journaux

Les journaux ne sont pas dans le paquet (ils sont crees a l'execution). Sur ce qui est livre :

```
$ grep -rIoh -E "ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}" <fichiers livres hors node_modules>
-> 0 occurrence
```

**NON PROUVE ICI** pour les journaux d'execution : ils exigent une installation reelle (C6).

### (d) Marque Microsoft

```
$ grep -o -i "microsoft" resources/app/product.json | wc -l   -> 25
$ grep -ro -i "microsoft" sudo-agent/src sudo-ai-extension/src | wc -l -> 7330
```

Les 25 de `product.json` incluent, en clair :

```
voiceWsUrl = wss://falcon-caas.mai.microsoft.com/voice-code/api/v1/realtime/voice
builtInExtensions.[0..2].metadata.publisherDisplayName = Microsoft
  (vscode-js-debug-companion, vscode-js-debug, vscode-js-profile-visualizer)
serverLicenseUrl = https://github.com/microsoft/vscode/blob/main/LICENSE.txt
documentationUrl / releaseNotesUrl / keyboardShortcutsUrl* / tipsAndTricksUrl = https://go.microsoft.com/...
```

Les 7330 occurrences de `sudo-agent/src` et de l'extension sont des **identifiants de paquets
winget** (`winget install Microsoft.OpenJDK.21`) : usage legitime, a ne pas confondre. Reste que
l'endpoint cloud Microsoft et les trois extensions « publisher Microsoft » **contredisent la
promesse P64**.

### (e) Nom du moteur d'origine, hors THIRD_PARTY_NOTICES

Recherche sensible a la casse, hors `ThirdPartyNotices.txt`, `LICENSES.chromium.html`,
`node_modules` et la base OSV `advisories.json` :

```
Cline 0 | Aider 0 | OpenHands 0 | CrewAI 0 | Open Interpreter 0 | SWE-agent 0
Continue 47 | Cursor 43 | Copilot 18 | autogen 8   -> mots courants de l'editeur
  (bouton "Continue", curseur, integrations Copilot du socle code-oss, "autogenerated")
"llama.cpp" -> 1 fichier : sudo-ai-extension/src/data/advisories.json (donnee OSV)
"opencode"  -> ressources de l'editeur (nls.keys.json: "openCodexAgentCustomizations"),
               README (adresse opencode@microsoft.com) et advisories.json (paquet "opencode-ai")
```

**Paquet : aucune fuite du nom du moteur d'origine hors fichiers de notices** (les seules
occurrences sont des donnees de vulnerabilites OSV ou des identifiants internes de l'editeur).
**Depot : le nom figure dans des documents internes** (`docs/p64/provenance-opencode.json`,
`docs/P64-CONFORMITE-MODELES.md`) ; ces documents ne sont pas dans le paquet.

### (f) Chemins d'etat de l'agent reellement utilises

```
sudo-agent/src/stateDir.js (livre) :
  Windows : %LOCALAPPDATA%\SudoStudio\agent\workspaces\<empreinte>\
  Linux   : $XDG_DATA_HOME/SudoStudio/agent/workspaces/<empreinte>/  (~/.local/share/...)
  macOS   : ~/Library/Application Support/SudoStudio/agent/workspaces/<empreinte>/
  <empreinte> = sha256 du chemin absolu et resolu du projet, 16 caracteres
  journal agent : <agentHome>/logs (ou SUDO_STUDIO_LOGS)
backend.exe : chaines "SudoStudio" et ".sudo_studio" (modele/cache runtime) presentes
```

`strings -a runtime.exe | grep sudo_studio` -> 0 : le runtime ne contient pas ce chemin en
clair (binaire PyInstaller compresse), donc **NON PROUVE ICI** pour les chemins du runtime.

---

## C6. Fumee sur le paquet INSTALLE

**NON PROUVE ICI.** Raison factuelle, verifiee a l'instant :

```
$ POST /repos/.../actions/workflows/06-smoke-installed.yml/dispatches  ->  HTTP 404
$ GET  /repos/.../actions/workflows                                   ->  00, 01, 02, 03 seulement
$ git cat-file -e origin/main:.github/workflows/06-smoke-installed.yml  -> absent de main
```

`workflow_dispatch` n'accepte que les workflows presents sur la **branche par defaut**. `06`
n'existe que sur `p60-linux` : il est donc **indestructiblement non declenchable** sans fusion
(interdite) ou sans modification du workflow (que je ne fais pas). Consequences mesurees :

- installation silencieuse, `/health` backend et runtime, dossier de journaux unique,
  desinstallation propre : **NON PROUVE ICI** ;
- le rouge P63-B (`no_tool`, run `43648790493` annonce par le rapport precedent) : ce run
  renvoie **404** a l'API aujourd'hui, donc **non re-verifiable**.

---

## D. Script unique pour votre PC

Fichier ajoute : **`scripts/p66-verify-installed.ps1`** (ASCII, 469 lignes). Il ne remplace pas
le verificateur produit (`scripts/verify/verify-installed.ps1`, porte P46), il le complete.

Ce qu'il fait, en un seul fichier de sortie `verification-report.txt` (PASS / FAIL / SKIP, avec
la ligne de preuve) + `journaux-sudo-studio.zip`, tous deux sur le Bureau :

1. SHA256 complet de l'installateur fourni (`-Installer`, comparaison si `-ExpectedSha256`) ;
2. dossier d'installation + fichiers critiques ;
3. `/health` backend (5000) et runtime (6000) ;
4. `n_ctx` + modele charge (`/health` du runtime : `model.loaded`, `model.n_ctx`, `device`,
   `load_ms`) ;
5. RAM libre (CIM) avec seuil 300 Mo ;
6. avec le **VRAI modele** : creation de `test.txt` contenant `bonjour` (preuve =
   `tool ok.*tool=write.*test\.txt`), relecture (`tool ok.*tool=read`), question simple sans
   outil (reponse non vide, statut TERMINE) ;
7. `continu` sans travail inacheve (preuve = ligne de reprise deterministe) ;
8. aucun `.sudo-agent` dans le projet (`git status --porcelain` + balayage) ;
9. nombre de rejets d'appels d'outils dans le journal ;
10. chaines anglaises (9 motifs connus) dans `agent.log`, `backend.log`, `runtime.log` ;
11. secrets (4 motifs) dans tous les `.log` ;
12. evenements Kernel-Power recents (veille) ;
13. dernieres lignes de `runtime-supervisor.log`.

Analyse syntaxique en CI (PowerShell du runner Linux), sortie collee du run `43709182585` :

```
[PASS] p66-verify-installed.ps1
[PASS] p46-gate.ps1
[PASS] verify-installed.ps1
[PASS] smoke-install.ps1
[PASS] build-manifest.ps1
[PASS] check-exe-icon.ps1
[PASS] check-runtime-fresh.ps1
Tous les scripts .ps1 sont syntaxiquement valides.
```

Le script n'a **pas** ete execute sur Windows : **NON PROUVE ICI** (il exige le PC).

---

## E. Defauts trouves, par gravite

| # | Gravite | Defaut | Preuve |
|---|---|---|---|
| 1 | **BLOQUANT** | `build-manifest.json` n'est **jamais produit ni livre** : aucune etape de `03-package.yml` n'appelle `scripts/ci/build-manifest.ps1`. Le journal de demarrage annonce donc `Build commit: dev (no build-manifest.json)` au lieu des identifiants git. Toute la tracabilite « quel build tourne chez le client » est vide. | `grep -c MANIFEST` sur le log du run 03 = 0 ; `ls build-manifest.json` = absent ; `start.bat:99` ; `build-manifest.ps1` attendu par le packager |
| 2 | **BLOQUANT** | Le workflow de fumee du paquet installe (`06`) n'est pas declenchable : absent de `main`, donc `workflow_dispatch` -> 404. **Aucune preuve de paquet installe ne peut etre produite depuis une branche.** Le run invoque comme preuve par P63-B (`43648790493`) renvoie 404 : il n'est plus verifiable. | sortie 404 collee en C6 ; liste des workflows = 00/01/02/03 |
| 3 | **ELEVE** | Marque Microsoft encore presente dans le produit livre : `voiceWsUrl = wss://falcon-caas.mai.microsoft.com/...` (endpoint cloud), 3 extensions integrees `publisherDisplayName = Microsoft`, URLs `go.microsoft.com`, lien de licence `github.com/microsoft/vscode`. | 25 occurrences dans `resources/app/product.json`, extrait colle en C5(d) |
| 4 | **ELEVE** | `verify-installed.ps1` (verificateur produit P46, exige par `build-manifest.ps1`) **n'est pas dans le paquet** : le client ne peut pas verifier lui-meme ce qui est installe. | `ls verify-installed.ps1` dans l'arbre livre = absent |
| 5 | **MOYEN** | 149 chaines anglaises dans le code livre hors prompts/advisories, dont des messages d'erreur/journal lisibles (`unknown agent`, `invalid JSON body`, `mcp list failed`, `compression failed`, `verify failed`, `ENV: MISSING = `). | scan colle en C5(b) |
| 6 | **MOYEN** | `scripts/verify/` est un dossier « piege » : y ajouter un fichier casse 2 suites du produit (`p46-gate`, `p48-titlebar-runtime`) parce que la porte lit des chemins fixes et compare des listes. Un dossier de verification partage ne devrait pas avoir cet effet. | run `43708348217` : `TOTAL: 65 suites, 2 failed` ; `test-p46-gate.js:100-101` |
| 7 | **FAIBLE** | Nom de job CI perime : « 49 suites (backend composer) » alors que le job en execute **65**. | log du run `43709182585` |
| 8 | **FAIBLE** | Le nom du moteur d'origine figure dans des documents internes du depot (`docs/p64/provenance-opencode.json`, `docs/P64-CONFORMITE-MODELES.md`). Absent du paquet, mais present dans l'historique git. | `ls docs/p64/` |
| 9 | **FAIBLE** | Le controle « aucune chaine anglaise » de mon `p66-verify-installed.ps1` ne couvre que 9 motifs : insuffisant pour prouver l'absence (il ne prouve que l'absence de ces 9-la). | script, section 10 |
| 10 | **INFO** | `.sudo_studio` (cache modeles du runtime) et `.sudo-agent` (ancien dossier d'agent, uniquement migre) coexistent dans le code ; aucun `.sudo-agent` n'est cree. | C5(a) et C5(f) |

Rien n'a ete corrige : ces defauts sont decrits, pas modifies.

---

## F. Ce que je n'ai pas pu verifier, et pourquoi

| Point | Raison |
|---|---|
| Installation silencieuse, `/health` sur le paquet, desinstallation propre | workflow 06 non declenchable (defaut n°2) ; pas de Windows ici |
| Contenu exact du paquet **installe** (vs arbre compresse) | l'installateur est produit par un Inno Setup trop recent pour `innoextract 1.9` (« setup loader revision 2 ») et je n'ai pas les droits root pour installer un outil plus recent |
| Journaux d'execution (secrets, anglais, chemins d'etat reels) | exigent une execution reelle (C6) |
| `strings` du runtime (chemins `.sudo_studio`) | binaire PyInstaller compresse : 0 chaine lisible |
| Le vrai modele (Qwen 1.5B), jetons/s, RAM, `n_ctx` reel | exige le PC : `scripts/p66-verify-installed.ps1` |
| Le rouge P63-B `no_tool` | run `43648790493` = 404 |
| Linux (port/support produit) | **NON TRAITE (decision de l'utilisateur)** |

---

## G. Tableau final

| Element | Statut |
|---|---|
| CI 00/01/02/03 sur la tete `add0e40` | **PROUVE** (4 runs verts, logs colles) |
| Suite complete 65/65, 0 echec | **PROUVE** (run `43709182585`) |
| Banc d'essai 38/38 (faux fournisseur) | **PROUVE** (job bloquant vert) |
| T1/T2, profils B, delegation E, MCP/skill F | **PROUVE EN CI (moteur seul)** |
| Re-verification de 13 points anciens | **PROUVE** (sorties collees, tous tiennent) |
| Installateur de la tete : run, taille, SHA256 | **PROUVE** (`43709187255`, 445 042 538 o, `c4067656...926c9d`) |
| Ligne « build : <sha> » au demarrage | **NON FAIT par le produit** (defaut n°1) |
| Recherches (a)(c)(d)(e) dans le contenu livre | **PROUVE** (sorties collees) |
| Recherche (f) chemins d'etat de l'agent | **PROUVE** (code livre) |
| Recherche (f) chemins du runtime | **NON PROUVE ICI** (binaire compresse) |
| Recherche (c) secrets dans les journaux d'execution | **NON PROUVE ICI** |
| Fumee du paquet installe | **NON PROUVE ICI** (workflow 06 -> 404) |
| `scripts/p66-verify-installed.ps1` ecrit + parse en CI | **PROUVE** (`[PASS] p66-verify-installed.ps1`) |
| `scripts/p66-verify-installed.ps1` execute sur Windows | **NON PROUVE ICI** |
| Defauts trouves | 10 (2 BLOQUANT, 2 ELEVE, 2 MOYEN, 3 FAIBLE, 1 INFO) |
| Fusion dans main | **NON FAIT (interdit)** - `main` = `e6c3d48` |
| Linux | **NON TRAITE (decision de l'utilisateur)** |


---

## H. CORRECTIONS APPORTEES APRES REMARQUE DE L'UTILISATEUR (paquet)

L'utilisateur a indique la chaine reelle : **backend et runtime sont construits dans
`Sudo-studio`, le PAQUET est construit dans `sudo-studio-packager`** (workflow
« SudoStudio Stable Build »). Le workflow `.github/workflows/03-package.yml` de ce depot etait
donc un **doublon degrade**, et il a ete supprime (commit `af42630`, ordre explicite de
l'utilisateur : `git rm .github/workflows/03-package.yml`).

Trois conclusions de ce rapport doivent etre corrigees, sans effacer l'erreur :

| Point du rapport | Ce que j'avais ecrit | Correction |
|---|---|---|
| Defaut n°1 (BLOQUANT) « aucun build-manifest.json » | presente comme un defaut produit | **VRAI pour le doublon**, **FAUX pour la chaine reelle** : le workflow du packager appelle `scripts/ci/build-manifest.ps1 -BuildDir build/SudoStudio -SudoStudioCommit $ssCommit -BackendRunId ... -RuntimeRunId ...` (ligne 571 du fichier du packager). Le manifeste n'etait absent que parce que le doublon supprime ne l'appelait pas. |
| Defaut n°4 (ELEVE) « verify-installed.ps1 absent du paquet » | presente comme un defaut produit | **VRAI pour le doublon**, **FAUX pour la chaine reelle** : le packager copie `scripts/verify/verify-installed.ps1` a la RACINE du build (lignes 467-469) et refuse le paquet s'il manque (lignes 549-553). |
| Defaut n°2 (BLOQUANT) « run 43648790493 = 404 » | j'ai conclu que la preuve de P63-B n'existait plus | **ERREUR DE MA PART** : ce run existe, mais dans le depot **`sudo-studio-packager`** — c'est « 05 - Linux smoke test (clean containers) », `conclusion: failure`, sur `main` du packager. Je l'avais cherche dans `Sudo-studio`. Il reste rouge, et comme il concerne Linux il releve de **NON TRAITE (decision de l'utilisateur)**. Le workflow `06-smoke-installed.yml` de ce depot, lui, reste non declenchable (absent de `main` de Sudo-studio) : c'est cette partie-la qui est un vrai blocage, et elle depend maintenant du packager puisque le workflow 03 local n'existe plus. |

Ce qui reste vrai apres correction : defauts n°3 (marque Microsoft, 25 chaines), n°5 (149 chaines
anglaises), n°6 (dossier `scripts/verify/` piege), n°7 (nom de job CI perime), n°8 (nom du moteur
d'origine dans des docs internes), n°9 (controle anglais partiel de mon script), n°10 (INFO).

Le paquet de reference est desormais celui du packager : run **`43746055054`** (branche
`p66-pins`, commit de pins `531caf2`, tete Sudo-studio `af42630`).
