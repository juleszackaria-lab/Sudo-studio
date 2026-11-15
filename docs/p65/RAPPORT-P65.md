# RAPPORT P65 - MODE AGENT : TOURS VIDES, ADAPTATION AU MODELE, BANC D'ESSAI, PUISSANCE DU MOTEUR

Date : 2026-11-15. Branche : `p60-linux`. Tete de branche : `e8f521b` (P65), precedee de `c5d1e55`.
`main` : `e6c3d48` (aucune fusion, conformement a la consigne).

Regle de preuve appliquee partout dans ce rapport :

- **PROUVE** = log CI reel colle ci-dessous, ou mesure dont la commande exacte est donnee.
- **PARTIEL** = une partie de la chaine seulement est prouvee.
- **NON FAIT** = pas implemente.
- **NON PROUVE ICI** = exige le PC Windows + le vrai modele (script exact fourni).

Les tests unitaires du depot **ne sont pas** une preuve de paquet installe : quand un point
n'a comme appui que le harnais, il est ecrit « PROUVE EN CI (moteur seul) » et non « SUCCESS ».

---

## a. Etat reel des prompts 61, 62, 63 (point -> etat -> preuve)

| Point | Etat reel (ce depot, ce jour) | Preuve |
|---|---|---|
| P61 - suite complete verte en CI | OUI, 65 suites, 0 echec | run `43706064149` job « 49 suites (backend composer) » : `TOTAL: 65 suites, 0 failed`, `suites executees : 65 (minimum exige : 54)` |
| P61 - script de preuve utilisateur `scripts/agent-e2e.ps1` | EXISTE, etendu en P65 (etapes 21 a 23) | job « PowerShell syntax » vert (meme run), 23 etapes dans l'en-tete du script |
| P61 - budget 70 % applique aussi aux schemas d'outils | OUI (inchange par P65) | suite `p26-agent-loop` E2 verte, y compris en CI (meme run) |
| P61 - reponse finale toujours dans le transcript (P61-9) | OUI (inchange) | suite `p26-agent-loop` verte |
| P62 - copie de projet (`copy_project`), reprise runtime, 3 essais par etape | OUI (inchange) | suites `p49`, `p59`, `p62` vertes en CI |
| P62 - un test rouge = aucun artefact livrable | REGLE APPLIQUEE : voir la section « Defauts trouves et corriges » (7 suites etaient rouges apres mes changements, elles sont vertes) | run `43706064149` |
| P63 - workflows 01 / 02 / 03 | voir section h | runs `43706070310` (01), `43706072012` (02), `43706433996` (03) |
| P63 - aucun fichier d'agent dans le projet (P63-D) | OUI (inchange), verifie par `p63`/`p59` verts | run `43706064149` |
| P63-B - smoke paquet installe : **ROUGE OUVERT** (`no_tool`, run `43648790493`, 23 PASS / 1 FAIL) | **NON CORRIGE ICI**, cause non prouvee | a reprendre avec `06-smoke-installed.yml` |

Conclusion : je ne refais pas 61/62/63. Ce prompt traite uniquement ce qui manquait : A, B, C, D, E, F, G.

---

## b. T1 - tour vide : cause racine et avant/apres

**Cause racine (fichier + ligne + journal)** : `sudo-agent/src/tools.js`, gestionnaire `hDone`
(ligne ~1060 de la version `c5d1e55`). `done({})` etait accepte avec un resume **vide** :
`ok=true`, `declared=true`, `finalText=''`. La fin de tour `loop.js` voyait alors
« un tour declare termine sans texte », et l'ancien repli fabriquait une phrase de succes
(`Tache terminee (N appel(s) abouti(s)).`) avec le statut **TERMINE**. D'ou la photo du 14/11 :
« Termine. / TERMINE (plan) » sans aucune reponse.

Ce n'etait donc pas le runtime qui « perdait » la reponse : le moteur acceptait un `done` vide
et **fabbriquait** un texte de reussite. Le journal correspondant ne contenait aucun
`appel d'outil execute` ni texte visible.

**Correction (A1 + A2)** :

1. Invariant de fin de tour (`loop.js`, fonctions `usableAnswer` / `executedEvidence`) : un tour
   n'est TERMINE que s'il a produit un texte visible non vide **ou** au moins un appel d'outil
   execute avec resultat.
2. Relance **unique** en texte simple, sans outil, puis ECHEC explicite :
   « Le modele n'a pas produit de reponse utilisable (aucun texte, aucun resultat d'outil).
   Cliquez sur Reessayer. » (statut ECHEC, `retryable=true`, bouton Reessayer cote panneau).
3. En mode plan / question simple, le texte du modele est affiche tel quel ; si `done` est
   invalide mais contient un resume lisible, il est **extrait** et affiche (PARTIEL, jamais TERMINE).
4. Une **panne fournisseur** (runtime coupe, HTTP) garde le repli deterministe etiquete
   `[reponse generee sans IA]` et le statut PARTIEL : le modele n'a pas eu la parole, on ne
   l'accuse pas d'un tour vide (suite `p43` Q5, verte).
5. Une **reponse vide** du fournisseur n'est plus maquillee : ECHEC reessayable (suite `p43` Q6,
   assertion mise a jour avec justification, voir plus bas).

**Avant / apres (faux fournisseur, commande `node scripts/ci/p65-repro-t1.js`)** :

| Scenario | Avant | Apres |
|---|---|---|
| reponse vide (mode plan) | TERMINE, texte fabrique | ECHEC + message exact + Reessayer |
| JSON invalide | TERMINE sans texte | texte extrait ou ECHEC (jamais TERMINE muet) |
| `done` tronque | TERMINE, `finalText=''` | resume extrait affiche, statut PARTIEL |
| total tours vides sur 5 scenarios | **5** | **0** |

Preuve collee : `/home/user/p65/repro-A.txt` (avant/apres) et `TOTAL P65-A : 18 PASS, 0 FAIL`
(run `43706064149`). **T1 n'est donc pas « NON REPRODUIT » : il est reproduit et corrige.**

**T2 (calcul deterministe)** : `sudo-agent/src/calc.js` intercepte l'arithmetique avant tout
appel modele. Mesure : 5 calculs justes dont `2+298 = 300`, **0 appel modele**.
`TOTAL P65-A` inclut ces 5 cas.

---

## c. Profils de capacite charges depuis les DONNEES (liste reelle)

Fichier livre : `sudo-agent/src/capability-profiles.json` (schema `sudo-capability-profiles/1`).
Surcharge administrateur : `<home>/capability-profiles.json` (meme schema, aucun rebuild).
Variable : `SUDO_AGENT_CAPABILITY` (chemin d'un manifeste). Aucune valeur de modele n'est figee
dans le code : le moteur lit, applique, et journalise.

Liste reelle (sortie de `capabilities.resolve()` sur le manifeste livre) :

| Modele | modeAppelOutils | temp | maxTok (chat/plan/tool) | gabarit | ctxSafe | outilsMax | exemples | etapes plan | profil |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder-1.5b-instruct | json-grammar | 0.15 | 700/1000/400 | chatml | 4096 | 13 | 2 | 3 | small |
| qwen2.5-coder-3b-instruct | json-grammar | 0.15 | 800/1200/500 | chatml | 8192 | 13 | 1 | 4 | small |
| qwen2.5-coder-7b-instruct | json-grammar | 0.2 | 1000/1600/700 | chatml | 16384 | 34 | 1 | 6 | full |
| qwen2.5-coder-14b-instruct | json-grammar | 0.2 | 1200/2000/800 | chatml | 16384 | 34 | 1 | 8 | full |
| phi-3-mini-4k-instruct | json-grammar | 0.1 | 600/900/350 | phi3 | 4096 | 12 | 2 | 3 | small |
| llama-3.2-3b-instruct | json-grammar | 0.15 | 800/1200/500 | llama3 | 8192 | 13 | 1 | 4 | small |
| llama-3.1-8b-instruct | json-grammar | 0.2 | 1000/1600/700 | llama3 | 16384 | 34 | 1 | 6 | full |
| llama-3.1-13b-instruct | json-grammar | 0.2 | 1200/2000/800 | llama3 | 16384 | 34 | 1 | 8 | full |
| codellama-7b-instruct | json-grammar | 0.15 | 800/1200/500 | llama2 | 8192 | 20 | 2 | 4 | small |
| codellama-13b-instruct | json-grammar | 0.15 | 1000/1600/700 | llama2 | 16384 | 34 | 1 | 6 | full |
| mistral-7b-instruct-v0.2 | json-grammar | 0.2 | 900/1400/600 | mistral | 8192 | 20 | 1 | 5 | small |
| deepseek-coder-v2-lite-instruct | json-grammar | 0.15 | 1000/1600/700 | deepseek | 16384 | 34 | 1 | 6 | full |
| granite-4.0-h-micro | json-grammar | 0.1 | 700/1000/400 | granite | 4096 | 13 | 2 | 3 | small |
| gpt-oss-20b | json-grammar | 0.2 | 1200/2000/800 | harmony | 16384 | 34 | 1 | 8 | full |
| phi-4-mini-instruct | json-grammar | 0.1 | 700/1000/400 | phi4 | 4096 | 13 | 2 | 3 | small |

**Modele inconnu** : profil « prudent » = **les reglages par defaut du moteur sont CONSERVES**
(aucune temperature, aucun plafond de jetons et aucun nombre d'outils imposes a l'aveugle) +
un avertissement journalise (`capability.warning`). Justification : ecraser les valeurs d'un
modele qu'on ne connait pas est un pari, pas une optimisation.

Garde-fou ajoute pendant la non-regression : un plafond d'outils **ne retire jamais**
`reply`, `done`, `read`, `edit`. Sans `done`, un modele ne peut plus terminer son tour ; ce
defaut a ete vu et corrige (suite `p26` E2 le prouve, voir section « defauts trouves »).

---

## d. Banc d'essai (faux fournisseur) - tableau complet et log CI

Commande CI : `node scripts/ci/agent-bench.js --json /tmp/agent-bench-report.json`
Job bloquant : **« Agent bench (faux fournisseur) »**, run `43706064149` -> `success`.

Extrait de log reel du job (cope-colle) :

```
TOTAL : 38/38 taches reussies (100%)
taches : 38/38 (100%)
```

Tableau par categorie (rapport JSON du run CI, 38 taches, 3 projets : Next.js, Flutter, Python) :

| Categorie | Taches | Reussies | Taux | Duree ms | Appels modele |
|---|---|---|---|---|---|
| structure | 3 | 3 | 100 % | 99 | 3 |
| modification | 6 | 6 | 100 % | 1213 | 17 |
| tests | 4 | 4 | 100 % | 642 | 12 |
| generation (cahiers 20/60/300 lignes) | 3 | 3 | 100 % | 1080 | 231 |
| robustesse (coupure runtime, reprise, refus .git) | 6 | 6 | 100 % | 1653 | 12 |
| questions (10 d'affilee) | 10 | 10 | 100 % | 213 | 10 |
| moteur (D : carte, correctif, reparation, cache) | 4 | 4 | 100 % | 311 | 15 |
| outils (MCP + skill reels) | 2 | 2 | 100 % | 40 | 4 |
| **total** | **38** | **38** | **100 %** | **~5,3 s** | **304** |

Mesures et non-mesures, telles quelles :

- duree totale : **~5,3 s** ; pic RSS du processus de banc : **79 Mo** (mesure locale identique en CI).
- **jetons/seconde : NON MESURE ICI** (faux fournisseur : aucune generation reelle).
- **RAM du runtime modele : NON MESURE ICI** (le runtime ne tourne pas dans ce banc).
- **sous-ensemble 1-8 avec un vrai petit modele : NON MESURE ICI** (pas de modele ni de PC Windows
  dans cet environnement). Script exact a lancer sur le PC :
  `scripts/agent-bench.sh --model <fichier.gguf>` ou
  `powershell -File scripts\agent-bench.ps1 -Model <fichier.gguf>`
  (les deux scripts font d'abord la passe deterministe, puis la passe reelle via
  `/v1/models` du runtime local ; si le runtime est injoignable, ils sortent en code 2 en
  ecrivant « NON MESURE », sans inventer de chiffre).

Note d'honnetete : certaines taches reussissent avec un statut `PARTIEL` ou `ECHEC` du tour
(par exemple `G2`, `G3` : le cahier de 60/300 lignes depasse la fenetre du faux fournisseur).
La reussite est jugee sur le **disque** (fichiers attendus, syntaxe, tests, git status), jamais
sur une note du modele — c'est la regle du banc.

---

## e. Avant / apres du banc pour chaque amelioration de la partie D

Mesure sur le sous-ensemble `P1..P4` (categorie `moteur`), meme banc, meme machine, code
d'avant (stash) puis code d'apres.

| Amelioration D | Avant | Apres | Preuve |
|---|---|---|---|
| D10 carte du depot + fichiers pertinents (sans modele) | `relevantFiles` inexistant ; P1/P3 en echec | P1/P3 reussis ; journal `fichiers pertinents (carte sans modele) | fichiers=app/calc.py` | `/home/user/p65/bench-avant-apres-D.txt` |
| D11 correctifs cibles + controle de syntaxe + retour arriere | P2/P4 en echec (reecriture complete, pas de garde) | P2/P4 reussis ; journal `syntaxe ok` / `retour arriere` | meme fichier |
| D14 cache d'index (jamais de recalcul complet) | 16 ms par appel, 43 lectures | 3-4 ms, `stats {"hits":2,"misses":1,"reads":43}` | mesure collee dans le rapport de session |
| Total sous-ensemble `--only P` | **1/4 (25 %)**, 833 ms, 13 appels | **4/4 (100 %)**, 960 ms, 15 appels | `/home/user/p65/bench-avant-apres-D.txt` |

Les ameliorations D12 (boucle de reparation 2 cycles), D13 (outils deterministes : squelettes,
renommage, copie, deduplication, calcul) et D15 (verification par etape sans modele :
`stepcheck.verifyFile`) sont couvertes par les taches `T1..T4`, `M1..M6`, `R1..R6` du banc
(vertes avant/apres dans le tableau ci-dessus, mais **pas** mesurees par une experience
« avant » separee : je ne presente donc pas de chiffre avant/apres pour ces trois-la, seulement
le fait qu'elles sont necessaires aux taches concernees).

---

## f. Constat « Agents » et delegation reelle

**Audit factuel (etat `c5d1e55`, avant P65)** : l'onglet « Agents » ne fait que **definir** des
agents personnalises (nom, description, instructions, liste d'outils) dans
`sudo-agent/src/agents.js`. `agents.js` **ne journalise rien**. Le seul mecanisme proche etait
l'outil `subagent` et l'outil `task`, qui executent un tour avec une autre consigne, **sans**
contexte isole garanti, **sans** outils restreints par role, **sans** verificateur et **sans**
journal de delegation. Reponse a la question posee : **non, un agent ne pouvait pas deleguer
avec verification avant ecriture**.

**Implementation P65-E** : `sudo-agent/src/delegation.js` + outil `delegate` (interception dans
`loop.js`, un seul modele charge, execution sequentielle) :

1. instantane du projet (fichiers + signatures) ;
2. sous-agent **executant** : contexte isole (session enfant), `listeOutils` restreinte
   (`read,list,glob,grep,write,edit,append,mkdir,skill,todo,done,reply` — **sans** bash, delete,
   rename) ;
3. diff deterministe (`checkDiff` : existence + syntaxe par fichier) ;
4. sous-agent **verificateur** : contexte isole, outils **lecture seule**
   (`read,list,glob,grep,done,reply`), regime non strict (aucune obligation de modifier) ;
5. verdict : `oui` -> application ; `non` -> `restoreSnapshot` + ligne `delegation retour arriere` ;
6. journal lisible + fichier `delegation-<turnId>.json` (`schema: sudo-delegation/1`), bornage
   `MAX_STEPS = 8`.

**Preuve : delegation reelle dans le journal** (extrait verbatim, harnais, run CI `43706064149`) :

```
delegation etape | n=1 total=1 step=cree app/conv.py avec une fonction convertir phase=executant
delegation sous-agent | role=executor child=947316623292229d outils=12 listeOutils=read,list,glob,grep,write,edit,append,mkdir,skill,todo,done,reply
delegation executant rendu | n=1 child=947316623292229d ok=true fichiers=app/conv.py supprimes=0
delegation sous-agent | role=verifier child=2ce86a749d14523a outils=6 listeOutils=read,list,glob,grep,done,reply
delegation verification | n=1 verdict=oui deterministe=ok fichiers=app/conv.py applique=oui
delegation bilan | n=1 statut=appliquee applique=oui verificateur=oui fichiers=app/conv.py
```

Le fichier `app/conv.py` est **reellement ecrit sur le disque** par le sous-agent
(`tool ok | tool=write target=app/conv.py rule=none+approved`), et le cas negatif supprime le
fichier (`delegation retour arriere` + bilan `refusee`). `TOTAL P65-E : 11 PASS, 0 FAIL`.

Statut : **PROUVE EN CI (moteur seul)**. Non prouve : une delegation sur le paquet installe avec
le vrai modele (a faire via `agent-e2e.ps1` sur le PC).

---

## g. MCP local (stdio) et skill : appels reels dans le journal

Fixture : `scripts/ci/fixtures/mcp-render-server.js` (serveur `render`, outils `deploy`/`status`,
exige un jeton d'environnement, modes `MCP_RENDER_OFFLINE=1` / `MCP_RENDER_SLOW_MS`).
Skill d'exemple : `exemple-deploiement/SKILL.md`, active par `skills.setActive(...)`.
Liste d'autorisation MCP ecrite dans `mcp_policy.json` (sans elle, `mcp_call` est refuse avant
tout appel — c'est la protection, pas un bug).

Extrait verbatim du journal (harnais, run CI `43706064149`) :

```
tool ok | tool=skill target=? code=ok ms=3 rule=none
tool ok | tool=mcp_call target=render/deploy code=ok ms=33 rule=none+approved
tool ok | tool=mcp_call target=render/status code=ok ms=1 rule=none+approved
```

Le serveur MCP est un **processus enfant reel** (stdio) ; le cas « serveur absent » echoue
proprement (`mcp_unknown`, jamais un faux succes). `TOTAL P65-F : 6 PASS, 0 FAIL`.
**MCP distant (HTTP/SSE) : NON PROUVE ICI.**

---

## h. Non-regression (01, 02, 03, Linux) et suite complete

| Workflow | Run | Resultat |
|---|---|---|
| 00 - Test suite (backend + extension) - **Linux** | `43706064149` | **success** : `TOTAL: 65 suites, 0 failed`, job « Agent bench (faux fournisseur) » vert, job « PowerShell syntax » vert |
| 01 - Build Backend EXE | `43706070310` | **success** |
| 02 - Build Runtime | `43706072012` | **success** : `[OK] server.exe built: 246 MB` |
| 03 - Package Sudo Studio | `43706433996` | **success** : `[OK] Inno Setup installer built successfully`, `SudoStudio-Setup-5.0.0.exe`, artefacts `sudo-studio-installer` (444 604 342 o) et `sudo-studio-build` (1 001 482 896 o) |
| 06 - Smoke paquet installe | non relance | **ROUGE OUVERT P63-B** (`no_tool`, cause non prouvee) |

Le paquet est lance **une seule fois** dans ce prompt (regle P62 : un paquet = 01 + 02 + 03, en
fin de session).

---

## Defauts trouves pendant la non-regression et corriges (transparence)

Apres l'implementation, `node backend/tests/run-all.js` est passe de 0 a **10 suites rouges**.
Aucune n'a ete « verte » en changeant un message ou en retirant une protection. Detail :

| Suite | Cause reelle | Decision |
|---|---|---|
| `p26` E1/E2/I2 | mon profil « prudent » reduisait la surface a 8 outils et **retirait `reply`/`done`** : un modele ne pouvait plus terminer son tour. **Vrai defaut de securite fonctionnelle.** | `limitTools` preserve `reply/done/read/edit` ; profil inconnu = valeurs historiques conservees. Assertions inchangees. |
| `p43` Q5 | panne fournisseur transformee en ECHEC | corrige : panne = repli deterministe etiquete + PARTIEL (comportement P43). |
| `p43` Q6 | reponse vide maquillee en repli | **contrat change par P65-A1** : assertion mise a jour pour exiger ECHEC + message exact + relance reelle (2 appels), et interdiction d'un repli en tete de reponse. Justifie en commentaire dans le test. |
| `p62` F4-c | message generique A1 ecrasait la cause concrete | corrige : ligne `Cause : la cible "X" est introuvable (outil read, code not_found)` sous l'echec. Assertion inchangee. |
| `p49` B1/D1 | reglages de sampling deplaces dans une constante nommee | constante `SAMPLING_DEFAUT = { temperature: 0.15, ... maxTokens: 1200 }` : valeurs identiques, marqueurs du test preserves. |
| `p54` D4, `p24` G1, `p59` B12 | inventaire d'outils : `delegate` est un nouvel outil (50 au registre, 37 en surface complete) | assertions d'inventaire mises a jour, avec commentaire expliquant l'ajout. |
| `p29`, `p30`, `p33` | **pas des regressions** : `backend/node_modules` absent dans mon environnement (`npm ci` non lance) | prouve par `git stash` (meme echec sans mes changements) puis resolu par `npm ci`. |

`run-all.js` : **65 suites, 0 failed**. `backend && npm test` : **`TOTAL: 65 suites, 0 failed`**.

---

## i. Tableau final PROUVE / PARTIEL / NON FAIT / NON PROUVE ICI

| # | Element | Statut | Preuve / raison |
|---|---|---|---|
| A1 | invariant de fin de tour, relance unique, ECHEC + Reessayer | **PROUVE EN CI (moteur seul)** | `TOTAL P65-A : 18 PASS, 0 FAIL` (run `43706064149`) ; logique dans `loop.js` (`usableAnswer`, `executedEvidence`) |
| A2 | mode plan/question : texte affiche tel quel, resume de `done` invalide extrait | **PROUVE EN CI (moteur seul)** | `TOTAL P65-A` (cas JSON invalide / `done` tronque) |
| A3 | cause racine T1 + avant/apres | **PROUVE** | cause : `tools.js` `hDone` accepte un resume vide ; avant 5 tours vides -> apres 0 (`/home/user/p65/repro-A.txt`) |
| A4 | calcul deterministe (T2) | **PROUVE EN CI (moteur seul)** | 5 calculs justes, 0 appel modele (`TOTAL P65-A`) |
| B | profils de capacite en donnees + surcharge admin + avertissement modele inconnu | **PROUVE EN CI (moteur seul)** | `TOTAL P65-B : 12 PASS, 0 FAIL` ; liste reelle section c |
| B (mesure) | valeurs optimales par modele (temp, max_tok) etablies par mesure | **NON PROUVE ICI** | aucune mesure de tool-calling par modele disponible ; les valeurs sont `policy`, pas `measured` (le manifeste le dit) |
| C | banc >= 30 taches, 3 projets, verification automatique | **PROUVE** | 38/38 en CI, log colle section d |
| C | sortie JSON + tableau (taux, tours, temps, profil) | **PROUVE** | `agent-bench-report.json` (artefact CI `P65-agent-bench`) |
| C | jetons/s, pic RAM du runtime, modele + profil reels | **NON PROUVE ICI** | exige le PC : `scripts/agent-bench.sh --model <gguf>` |
| C | sous-ensemble 1-8 avec petit modele reel | **NON PROUVE ICI** | idem (script fourni, code retour 2 si runtime injoignable) |
| C | `agent-bench.ps1` + `agent-bench.sh` (parametre modele) | **PROUVE (syntaxe)** | `bash -n` ok, `agent-bench.sh --help` et passe deterministe executes ; `.ps1` parse par le job « PowerShell syntax » |
| D | carte du depot + fichiers pertinents sans modele | **PROUVE** (banc P1/P3 + journal) | `/home/user/p65/bench-avant-apres-D.txt` |
| D | correctifs cibles + controle de syntaxe + retour arriere | **PROUVE** (banc P2/P4) | idem |
| D | boucle de reparation 2 cycles, outils deterministes, verification par etape | **PARTIEL** | couverts par les taches du banc (vertes) mais sans experience « avant » separee ; pas de chiffre avance |
| D | cache de prompt + budget de contexte strict | **PARTIEL** | cache d'index mesure (16 ms -> 3-4 ms) ; cache de PROMPT non mesure isolement |
| E | audit factuel de l'onglet Agents | **PROUVE** (lecture du code, section f) | `agents.js` ne journalise rien, aucune delegation avant P65 |
| E | delegation reelle (executant + verificateur + rollback + journal + JSON) | **PROUVE EN CI (moteur seul)** | `TOTAL P65-E : 11 PASS, 0 FAIL` + journal colle section f |
| E | meme delegation sur le paquet installe avec le vrai modele | **NON PROUVE ICI** | `scripts/agent-e2e.ps1` etape 21-23 sur le PC |
| F | MCP local stdio reellement appele + skill reellement charge | **PROUVE EN CI (moteur seul)** | `TOTAL P65-F : 6 PASS, 0 FAIL` + journal section g |
| F | MCP distant (HTTP/SSE) | **NON PROUVE ICI** | non teste ; ecrit tel quel |
| G | un test par echec (T1, T2) qui echouait avant | **PROUVE** | `test-p65-tours-vides.js` : 5 tours vides en avant, 0 apres ; les tests sont dans la suite CI |
| G | `agent-e2e.ps1` mis a jour | **PROUVE (syntaxe)** | etapes 21 (tour vide), 22 (calcul, 0 appel), 23 (banc 38 taches) ; parser PowerShell vert |
| G | job CI bloquant « Agent bench (faux fournisseur) » | **PROUVE** | job `132787287586`, `success`, log `TOTAL : 38/38` |
| G | non-regression complete | **PROUVE (Linux + Windows)** | 00 : 65 suites, 0 echec (Linux) ; 01 (`43706070310`), 02 (`43706072012`), 03 (`43706433996`) tous `success` |
| G | paquet installe (06) | **ROUGE OUVERT P63-B** | `no_tool`, run `43648790493`, cause non prouvee |
| - | fusion dans `main` | **NON FAIT (volontaire)** | consigne explicite : ne pas fusionner |

---

## Ce qui reste a faire (et qui le fera)

1. **PC Windows** : `agent-bench.ps1 -Model <gguf>` -> jetons/s, RAM du runtime, sous-ensemble reel
   1-8 ; `agent-e2e.ps1` -> preuve de la delegation et des tours vides sur le paquet installe.
2. **Smoke paquet installe (06)** : le rouge P63-B `no_tool` reste ouvert ; cause non prouvee a ce jour.
3. **Revocation du jeton d'acces GitHub** utilise pour pousser cette branche : a faire maintenant,
   il n'a pas ete ecrit sur disque mais il est encore valide.

Aucune fusion dans `main`. `main` reste a `e6c3d48`.
