# P63-B - Correction du rapport P63 : installateur perdu, non-regression, preuves

Branche `p60-linux`, tete de code **`a56713f`** (tete de branche, apres ce
rapport : `5dcc624`). `main` reste **`e6c3d48`** : **aucune
fusion n a ete faite** (interdiction explicite du prompt 63-B).
Depot de packaging : `juleszackaria-lab/sudo-studio-packager`, `main`
**`ddba778`** (les runs cites utilisent `ead23c9` pour 04 et `ddba778` pour 05).

Regles d etiquette appliquees dans tout ce document :

| Etiquette | Sens |
|---|---|
| PROUVE | log CI reel (URL de run + sortie collee) ou paquet INSTALLE |
| PROUVE EN CI (moteur seul) | test unitaire execute par la CI, sans paquet installe |
| PARTIEL | une partie seulement est demontree |
| NON FAIT | non execute |
| NON PROUVE ICI | necessite un PC Windows, un modele reel ou un service absent de la sandbox |

Aucune ligne de ce rapport ne porte la mention "demande explicite" sans une
citation litterale.

---

## 1. Preuve a) - les workflows disparus : quand, par quel commit, pourquoi

Commandes utilisees (toutes branches des deux depots) :

    git log --all --diff-filter=D --name-only -- .github/workflows/
    git log --all --oneline -- .github/workflows/
    gh api /repos/juleszackaria-lab/Sudo-studio/actions/workflows

Resultat pour `Sudo-studio` : **un seul** workflow a disparu.

| Fichier | Commit | Auteur | Date (UTC) | Message | Effet |
|---|---|---|---|---|---|
| `.github/workflows/03-package.yml` | `1c3b8a9` | `arena-agent` | 2026-10-29 14:23:29 | `allgreen: drop legacy 03-package (packaging vit dans sudo-studio-packager)` | -573 lignes |

Aucun workflow Linux n a **jamais** existe dans `Sudo-studio` (`--diff-filter=D`
sur toutes les branches ne renvoie rien d autre). Les workflows Linux vivent
dans l autre depot :

| Workflow | Depot | id GitHub | Etat |
|---|---|---|---|
| `03-package.yml` (Windows, Inno Setup) | `sudo-studio-packager` | 238260318 | actif |
| `04-package-linux.yml` | `sudo-studio-packager` | 410562824 | actif, **rejoue dans ce prompt** |
| `05-linux-smoke.yml` | `sudo-studio-packager` | 414102697 | actif |

### Restauration et remise en etat

| Commit | Contenu |
|---|---|
| `bed7d65` | restauration de `03-package.yml` depuis `1c3b8a9^` + `branch=${{ github.ref_name }}` |
| `b2ce046` | copie de `launch_hidden.vbs` (voir ci-dessous) |
| `4487a8d` | nouveau `06-smoke-installed.yml` (smoke du paquet installe) |

Note : `06-smoke-installed.yml` n a pas pu etre declenche dans ce prompt
(`POST .../workflows/06-smoke-installed.yml/dispatches` -> HTTP 404). GitHub n
accepte un `workflow_dispatch` que pour un fichier present sur la branche par
defaut ; le mettre sur `main` exigerait la fusion interdite. La fumee du
paquet installe est donc prouvee par le job `P29+P31 smoke` du packager
(section 3), qui installe reellement l installateur et interroge `/health`.

Le workflow restaure **n etait pas fonctionnel tel quel** : le premier run
`43625538795` (commit `4487a8d`) a echoue en 5 min avec

    Error on line 95 in ...\build\SudoStudio\installer.iss: Source file
    "...\build\SudoStudio\launch_hidden.vbs" does not exist.
    Compile aborted.
    [FAIL] Inno Setup (ISCC) failed with exit code 2 - no installer produced

Cause : `installer.iss` exige `launch_hidden.vbs` a la racine du paquet, et le
workflow supprime en `1c3b8a9` ne le copiait pas (le fichier a evolue apres la
suppression du workflow). Correction `b2ce046` : copie + verification d
existence avant ISCC. C est **la** raison pour laquelle l installateur etait
"perdu" : ce n etait pas seulement le fichier YAML, c etait aussi un
assemblage desynchronise.

---

## 2. Preuve b) - runs sur la tete de branche, artefacts et SHA256

### 2.1 Tests et binaires (depot `Sudo-studio`)

| Run | Workflow | Commit | Statut | Duree | Sortie verifiee |
|---|---|---|---|---|---|
| `43639628419` | 00 tests | `a56713f` (tete) | success | 3 min | `TOTAL: 60 suites, 0 failed`, `P63: 49 checks passed`, `P63-F: all green` |
| `43630708739` | 00 tests | `84e4a88` | success | 3 min | `TOTAL: 60 suites, 0 failed`, `P63: 49 checks passed`, `P63-F: all green` |
| `43639603148` | 01 backend | `a56713f` (tete) | success | 1 min | artefact `backend-exe` |
| `43639606603` | 02 runtime | `a56713f` (tete) | success | 11 min | artefact `runtime-exe` |
| `43634398830` | 01 backend | `46f0759` | success | 1 min | artefact `backend-exe` |
| `43634400791` | 02 runtime | `46f0759` | success | 12 min | artefact `runtime-exe` |
| `43628890594` | 01 backend | `84e4a88` | success | 1 min | artefact `backend-exe` 31,9 Mo |
| `43628892143` | 02 runtime | `84e4a88` | success | 13 min | artefact `runtime-exe` 244,2 Mo |
| `43624495103` | 00 tests | `bed7d65` | success | 3 min | `TOTAL: 60 suites, 0 failed` |
| `43624496713` | 01 backend | `bed7d65` | success | 1 min | artefact `backend-exe` |
| `43624498463` | 02 runtime | `bed7d65` | success | 10 min | artefact `runtime-exe` |
| `43615839230` | 01 backend | `285f6fc` | success | 1 min | binaires de `285f6fc` (paquet precedent) |
| `43615841096` | 02 runtime | `285f6fc` | success | 12 min | binaires de `285f6fc` (paquet precedent) |

Les deux jeux de binaires demandes existent donc en CI : celui de `285f6fc`
(`43615839230` / `43615841096`) et celui de la tete (`43634398830` /
`43634400791`).

### 2.2 Installateur Windows construit par le workflow **restaure** (03 de `Sudo-studio`)

| Element | Valeur |
|---|---|
| Run | `43627384576` (03 - Package Sudo Studio), commit `b2ce046`, **success**, 10 min |
| Binaires utilises | 01 `43628890594` + 02 `43628892143` (`84e4a88`) |
| Artefact | `sudo-studio-installer` (424,0 Mo) |
| Fichier | `SudoStudio-Setup-5.0.0.exe`, **445 022 372 octets** |
| **SHA256** | `78c8601c34eb8a82587def17ca0216027f46c5f30430fd82842f18fe99bcaea9` |
| Autre artefact | `sudo-studio-build` 955,06 Mo |

### 2.3 Paquet livre (03 du depot `sudo-studio-packager`)

| Element | Valeur |
|---|---|
| Run | `43630677463` (`SudoStudio Stable Build`), `main` `dcf3e2d`, **success**, 28 min |
| Pins utilises | 01 `43628890594` + 02 `43628892143`, `SUDO_STUDIO_REF=84e4a88` |
| Jobs | `build` success, `P29+P31 smoke (Windows install + agent e2e)` **success**, `P32 screenshots` success, `P35 panel render` success |
| Artefact installateur | `SudoStudio-Installer` 359,05 Mo |
| Fichier | `SudoStudio-Setup.exe`, **376 882 235 octets** |
| **SHA256** | `4188cec51af75e352df606b2dae5cba5e5eedad539e419baedcce3d9fcfa2007` |
| Autres artefacts | `SudoStudio-Portable` 415,89 Mo, `smoke-logs` 0,15 Mo, `panel-render` 2,7 Mo, `p32-screenshots` 0,11 Mo |

Le manifeste embarque dans le paquet installe confirme les pins :
`build-manifest commit=84e4a88489efa84044109a69d9ca5ddd70d3977a components=5`.

### 2.4 Linux (04 du depot `sudo-studio-packager`)

| Run | Packager | Statut | Constat |
|---|---|---|---|
| `43625587488` | `51b276a` | failure | garde-fou : pins `bed7d65` contre `p60-linux` = `4487a8d` -> refus correct |
| `43627388506` | `c7e4eb3` | failure | `linux-total-test` : **H3** (assertion fausse, voir 2.5) |
| `43630679621` | `dcf3e2d` | failure | `Assemble SudoStudio-Linux` : **2 assertions perimees** du panneau (voir 2.6) |
| `43636691500` | `6da9226` | failure | `scripts/ci/test-p57-extensions.js` : **20 echecs** -> vraie regression P63 (voir 2.7) |
| `43641720911` | `ead23c9` | **failure** | tout passe jusqu au paquet installe, puis **smoke conteneurs : 23 PASS, 1 FAIL** par image (voir 2.8) |
| `43648790493` (05) | `ddba778` | **failure** | meme image, meme rouge : 6 conteneurs en echec sur le meme controle |

Detail du run `43641720911` (65 min), jobs :

    Guard - pins are green and agree                         success
    Build backend (linux-x64)                                success
    Build runtime (linux-x64)                                success
    Assemble SudoStudio-Linux                                success
    P29+P31 Linux delivery gate                              success
    Linux total functionality (installed bundle)             success
    Smoke rockylinux-9 / fedora-40 / debian-12 /
          ubuntu-24.04 / ubuntu-22.04 / debian-12-slim       failure (23 PASS, 1 FAIL)
    P60 Linux delivery decision                              skipped

### 2.7 Regression trouvee par la CI Linux : suites P57 (`scripts/ci/test-p57-extensions.js`)

    a la tete :  == 32 PASS, 20 FAIL ==
    sur e6c3d48: == 52 PASS, 0 FAIL ==   (worktree du commit de base)

Cause : le test creait toutes ses fixtures (skills, `mcp_policy.json`, commandes)
dans l ANCIEN dossier `~/.sudo_studio/agent`, que le produit ne lit plus
(point 6). Le produit est conforme ; c est le test qui decrivait l ancien
emplacement. Correction : fixtures placees via le seam documente
`SUDO_AGENT_HOME` (+ garde-fou interdisant `agentHome == legacyHome`), et le cas
"aucune extension" bascule temporairement ce seam sur un dossier vide.
Resultat : `== 52 PASS, 0 FAIL ==`, exactement le total d avant.

### 2.8 ROUGE OUVERT : le smoke conteneurs (05) - agent sans appel d outil sur modele reel

Etat : **6 images sur 6 en echec**, 23 PASS / 1 FAIL par image, sur le meme
controle :

    PASS session agent creee
    ...
    FAIL l agent cree le fichier demande :: fichier absent ou vide (approbations=0)
    == RESULTAT : 23 PASS, 1 FAIL ==

Le paquet installe repond, il ne fait pas semblant :

    event: turn.start   {"model":"Qwen2.5-Coder-1.5B-Q4_K_M (GGUF)"}
    event: turn.done    {"status":"PARTIEL","stopReason":"no_tool",
                         "toolCalls":0,"reason":"AUCUNE MODIFICATION : le modele
                         n'emet aucun appel d'outil (reparations contraintes
                         espacees)"}

Non-regression (meme controle, pins P62) : run `43468866095`
(`4ff41c94`) ->

    PASS l agent a cree hello-linux.txt avec le bon contenu (approbation accordee)

en 47 s. Ce n est donc **pas** un probleme de lenteur : une seconde execution
avec une fenetre portee de 300 a 900 s (run `43648790493`, `ddba778`) donne
exactement le meme resultat apres 10 min.

Conclusion honnete : **regression du chemin "appel d outil" du runtime avec un
vrai modele 1.5B sur le paquet Linux installe**, apparue dans le train P63/P63-B.
**Cause NON PROUVEE** : le journal du runtime (`[OPENAI] tool attemptN raw ...`)
n est pas collecte par le harnais ; il faut l ajouter au prochain passage.
Consequence : conformement a la regle "un seul rouge = aucun artefact
livrable", **aucun artefact Linux n est declare livrable dans ce prompt**.

### 2.5 Defaut trouve par la CI Linux : H3 (`scripts/ci/test-p56-spec.js`)

    FAIL H3: chaque etape a recu un resume des precedentes (sauf la 1re)
    :: [{"n":1,...,"prev":false},{"n":1,...,"prev":false},
        {"n":1,...,"prev":false},{"n":2,...,"prev":true}, ...]

Cette assertion echouait **deja sur `e6c3d48`** (verifie sur un worktree du
commit de base : `== 47 PASS, 1 FAIL ==`, meme message). Ce n est donc **pas**
une regression P63. L assertion etait fausse : la 1re etape est retentee (jusqu
a `attempts`), et une tentative de la 1re etape n a par definition aucune
precedente a resumer. Correction (assertion, pas produit) :

- `H3` : toute etape `n>1` recoit un resume ; il existe au moins une telle etape.
- `H3b` (nouveau) : aucune tentative de la 1re etape ne porte de resume.

Resultat local apres correction : `== 49 PASS, 0 FAIL ==`.

### 2.6 Defaut trouve par la CI Linux : panneau (`scripts/ci/test-p56-panel.js`)

    FAIL un seul bouton : Reprendre :: ["Reprendre le travail"]
    FAIL Reprendre : envoie "reprendre le projet" :: {"type":"send","text":"reprendre"}
    == 32 PASS, 2 FAIL ==

Ce sont **deux assertions perimees** : le P63 (G1) a volontairement change le
libelle (`Reprendre le travail`) et le contenu envoye (le MOT CLE deterministe
`reprendre`, chemin de reprise a 0 appel modele). L assertion decrivait l
ancien comportement. Correction des deux assertions (avec commentaire
explicite) : `== 34 PASS, 0 FAIL ==`.

Ces deux defauts sont des **assertions de test**, pas des comportements de l
agent : aucun point de code produit n a ete modifie pour les faire passer.

---

## 3. Preuve c) - fumee sur le PAQUET INSTALLE

Source : artefact `smoke-logs` du run `43630677463` (`smoke-out/summary.txt`),
ecrit par `scripts/smoke/smoke-install.ps1` apres installation **silencieuse**
reelle.

    [PASS] pre-port-5000-free
    [PASS] pre-port-6000-free
    [PASS] pre-installdir-absent
    [PASS] silent-install exit=0 dir=C:\Program Files\Sudo Studio
    [PASS] expected-files 17 files
    [PASS] build-manifest commit=84e4a88489efa84044109a69d9ca5ddd70d3977a components=5 brand=P20-OK
    [PASS] brand-product.json nameShort=Sudo Studio
    [PASS] backend-health HTTP 200
    [PASS] runtime-health status=healthy
    [PASS] runtime-p21-journal C:\Users\runneradmin\AppData\Local\SudoStudio\logs\runtime.log
    [PASS] agent-handshake port=63594
    [PASS] editor-close-cleanup 0 processes remain
    [PASS] logs-single-dir agent.jsonl, agent.log, backend.jsonl, backend.log,
           enterprise.log, extension.jsonl, extension.log, runtime-supervisor.log,
           runtime.jsonl, runtime.log, runtime_debug.log, startup.log,
           supervisor.jsonl, supervisor.log
    [PASS] clean-uninstall exit=0 leftover-items=1 (logs/data accepted)

    FAIL=0 SKIP=0

Le job `P29+P31 smoke (Windows install + agent e2e)` enchaine ensuite un agent
e2e sur le produit **installe** (`e2e-out/e2e-summary.txt`) :

    [PASS] install exit=0 dir=C:\Users\RUNNER~1\AppData\Local\Temp\SudoE2E
    [PASS] e2e-handshake port=63672
    [PASS] e2e-health ok
    [PASS] e2e-session 8427cb8b033fac85
    [PASS] e2e-turn1 paused, nothing written
    [PASS] e2e-approve resumed, scripted content
    [PASS] e2e-turn2 TERMINE
    [PASS] e2e-only-file hello.txt only
    [PASS] uninstall exit=0
    FAIL=0

Ce que cela prouve exactement : installation silencieuse, `backend /health`
HTTP 200, `runtime /health` `healthy`, **journal ecrit au bon endroit**
(`%LOCALAPPDATA%\SudoStudio\logs`, un seul dossier), arret propre, desinstallation
propre. Le reste des scenarios P63 sur le paquet installe releve du PC (section
8).

---

## 4. Preuve d) - ecart avec `main`, aucune fusion

    git rev-list --left-right --count main...p60-linux   ->   0   24 (25 avec ce rapport)
    git diff --stat main..HEAD                           ->   91 files changed, 8953 insertions(+), 418 deletions(-)

`main` = `e6c3d48` (inchange), `p60-linux` = `a56713f` (code) / `5dcc624` (rapport). `main` n a **aucun**
commit en avance : la fusion serait un simple `--ff`, elle n a **pas** ete
faite. Les 18 commits P63/P63-B :

    285f6fc c443365 95d96ff 834f086 856d064 4d77fce bed7d65 4487a8d
    b2ce046 84e4a88 46f0759 a56713f (+ commits de rapport)

Depot `sudo-studio-packager` : `main` `cc0d344` -> `6da9226` (3 commits, tous
des pins et garde-fous, aucun code produit).

---

## 5. Preuve e) - une ligne de journal par appel d outil rejete

Code : `backend/runtime/openai_compat.py`, fonction `reject_line()` (l.367).
Sortie reelle (executee, secrets masques avant ecriture) :

    [OPENAI] tool rejete essai1: finish_reason=length jetons_generes=512
    longueur=87 debut='{"name":"read_file","arguments":{"path":"a.txt","token":"[MASQUE]'
    fin=':"read_file","arguments":{"path":"a.txt","token":"[MASQUE]"}' 
    raison=invalid_tool_call / json / troncature

Elle contient les quatre mesures exigees : `finish_reason`, jetons generes,
longueur de la sortie brute, 80 premiers et 80 derniers caracteres (masques),
plus la raison exacte du rejet. Tests : `P3-a..d` dans `test_p63_json.py`
-> `P63-F: all green` (execute dans le run `43630708739`).

---

## 6. Preuve f) - delai total : INCOMPLET, jamais un echec, configurable

`sudo-agent/src/job.js` : `SUDO_AGENT_JOB_TOTAL_MS` (defaut `21600000` = 6 h,
`0` = illimite), budget relu a **chaque** execution de `run()` (les valeurs
figees dans l etat par `create()` ne sont plus utilisees), statut `incomplete`,
evenement `job.budget`, rapport `INCOMPLET (x/N)`, `unfinished()` reprend
`incomplete` et `interrupted`.

Test a **horloge simulee** (`backend/tests/test-p63-agent.js`, option `opts.now`,
1 h simulee par etape, budget total 2 h) :

    ok - P4-a: budget total atteint -> arret PROPRE, aucune etape comptee en echec
    ok - P4-b: le bilan dit INCOMPLET (x/N), jamais un echec
    ok - P4-c: le statut du travail est resumable (incomplete)
    ok - P4-d: les etapes non tentees restent EN PLACE et la reprise est possible
    ok - P4-e: le delai total est configurable (defaut 6 h, 0 = illimite)
    ok - P4-f: 0 = aucune limite totale (reglage explicite)
    ok - P4-g: "continu" apres un arret budget reprend a la 1re etape non faite

`P63: 49 checks passed (all green)`, et ces memes checks sont rejoues par la CI
(run `43630708739`). Ce qui n est **pas** prouve ici : un arret budget reel sur
un modele local (latence reelle), voir section 8.

---

## 7. Preuve g) - chemins d etat reels et migration

`node scripts/ci/p63-state-paths.js` (HOME isole) -> `P63-PATHS: OK`.

Emplacement unique : `%LOCALAPPDATA%\SudoStudio\agent\workspaces\<empreinte>`
(Linux/macOS : `XDG_DATA_HOME` soit `~/.local/share/SudoStudio/agent`).

14 fichiers reels, **14/14** sous l emplacement unique, **0** dans le projet :

    agents.json, audit.jsonl, mcp.json, net_policy.json, skills.json,
    skills/normes/SKILL.md, logs/agent.jsonl, logs/agent.log,
    checkpoints/..., sessions/*.json,
    workspaces/<id>/jobs/*.json, workspaces/<id>/orch-*.json,
    workspaces/<id>/specs/*.{json,md}

Migration (`sudo-agent/src/stateDir.js`, `detectLegacyHome()` l.69,
`migrateHome()` l.81, branchee dans `server.js` apres `log.sessionHeader`) :

| Situation | Resultat observe |
|---|---|
| ancien dossier present (`sessions/`) | `detecte: true`, `entries: ['sessions']` |
| sans accord | `ok: false, needsApproval: true`, ancien dossier **intact** |
| avec accord (`SUDO_AGENT_MIGRATE_HOME=approve`) | `ok: true, moved: 1, removed: true` |

Aucune donnee n est deplacee sans accord explicite.

---

## 8. Preuve h) - tableau final

| Point | Etat | Preuve |
|---|---|---|
| 1. historique des workflows disparus (commit, auteur, date, message) | PROUVE | section 1 (`git log --diff-filter=D`) |
| 1. restauration du 03 Windows | PROUVE | `bed7d65` + run `43627384576` success |
| 1. workflows Linux | PROUVE (existants, dans le packager) | ids 410562824 / 414102697, run `43641720911` (04) et `43648790493` (05) |
| 2. installateur Windows (workflow restaure) | PROUVE | run `43627384576`, 445 022 372 o, SHA256 `78c8601c...` |
| 2. installateur Windows (packager, paquet livre) | PROUVE | run `43630677463`, 376 882 235 o, SHA256 `4188cec5...` |
| 2. fumee du paquet INSTALLE (/health backend + runtime, journal) | PROUVE | section 3 (`summary.txt`, `FAIL=0`) |
| 2. binaires `285f6fc` et tete | PROUVE | `43615839230`/`43615841096` et `43634398830`/`43634400791` |
| 2. Linux : workflow 04, assemblage, paquet installe | PROUVE | run `43641720911` : assemble + gate + total fonctionnel installe = success |
| 2. Linux : smoke conteneurs (agent cree un fichier) | **ROUGE / NON PROUVE** | 6/6 images, 23 PASS 1 FAIL, `stopReason=no_tool`, cause NON PROUVEE (section 2.8) |
| 3. ecart `p60-linux` vs `main`, aucune fusion | PROUVE | section 4 (0/18, 91 fichiers) |
| 3. pins a jour | PROUVE | `ead23c9` puis `ddba778` (packager), sections 2.2/2.3/2.4 |
| 4. G4 : cause NON PROUVEE sur modele reel | NON PROUVE ICI | troncature reproduite en test, pas sur un modele 1.5B installe |
| 4. ligne de journal par appel rejete | PROUVE EN CI (moteur seul) | section 5, `P3-a..d` verts |
| 5. delai total INCOMPLET/resumable/configurable | PROUVE EN CI (moteur seul) | section 6, `P4-a..g` |
| 6. chemins d etat uniques + migration sur accord | PROUVE EN CI (moteur seul) | section 7, `P63-PATHS: OK` |
| 7. etiquetage du tableau de preuves | PROUVE | ce document |
| G1..G5 sur le paquet installe (scenarios 15 a 20) | NON PROUVE ICI | commande PC section 9 |
| Defauts de test trouves et corriges (H3, panneau, P57 extensions) | PROUVE | sections 2.5, 2.6 et 2.7 : rouge avant / vert apres, totaux identiques |

---

## 9. Ce qui reste a faire

1. **Rouge ouvert (priorite 1)** : le smoke conteneurs Linux (section 2.8). Le
   modele 1.5B ne produit aucun appel d outil sur le paquet installe. Prochain
   pas : collecter `[OPENAI] tool attemptN raw...` du runtime dans le harnais
   `linux/container-test.sh`, puis corriger la brique fautive (reparation
   d appel d outil ou invite d outil), **sans** assouplir le controle.
2. G4 sur un vrai modele : la ligne `tool rejete` existe, mais aucune
   troncature n a encore ete constatee sur un modele reel.

Sur un PC Windows :

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-e2e.ps1 `
      -InstallDir "C:\Program Files\Sudo Studio" -ProjectPath "C:\mon\projet" `
      -OutDir "C:\p63-preuves"

Avec `SudoStudio-Setup.exe` (SHA256 `4188cec5...`) : scenarios 15 a 20 de la
section 4 du rapport P63 (cahier de 300 lignes, panne runtime 150 s puis
`continu`, `continu` sans travail inacheve, redemarrage du serveur puis
`continu`, `git status` propre, trois echecs d etape), plus un arret budget
reel et une vraie troncature de modele pour G4.

## 10. Rappels

- Le jeton GitHub personnel utilise pour pousser **doit etre revoque** apres
  usage ; il n a jamais ete ecrit sur disque ni dans ce rapport.
- Aucune fusion dans `main` n a ete faite : elle reste interdite sans ordre
  explicite.
