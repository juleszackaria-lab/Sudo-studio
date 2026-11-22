# P69 — LE RUNTIME MEURT EN PLEINE GÉNÉRATION

**Rapport.** Dépôt `juleszackaria-lab/Sudo-studio`, branche `main`.
Tête de travail : `2c4458a` (voir section 8 pour les runs).

Règle suivie partout : **PROUVÉ** = une sortie collée, un test qui passe, ou un
run CI identifiable. Le reste est marqué **HYPOTHÈSE**, **PARTIEL**, **NON
REPRODUIT** ou **NON FAIT**. Aucun chiffre n'est inventé ; les cases que je
n'ai pas pu mesurer sont vides et dites vides.

---

## 1. Tableau d'état — ce qui touche déjà le runtime avant ce prompt

| brique | où | ce qu'elle fait | état au début de P69 |
|---|---|---|---|
| profil RAM « RAM62 » | `openai_compat.low_ram_profile` | choisit `n_threads`, `n_batch`, et **plafonne** `n_ctx` selon la RAM libre ; message en français | en service |
| garde-fou RAM au chargement | `server.enterprise._RamWatchdog` | surveille la RAM pendant `Llama(...)` (non interruptible) ; si la RAM passe sous le seuil, le chargement est déclaré **échoué** (pas de faux succès) | en service ; message sans marche à suivre (**corrigé**, C9) |
| verrou de chargement | `_load_lock` + `start_model_load` | un seul chargement à la fois ; le second était **REFUSÉ** (`REFUSED (busy)`) | **corrigé** (C8 : fusionné, plus refusé) |
| superviseur | `backend/supervisor/runtimeSupervisor.js` (P1-d) | sonde `/health` (3×5 s), relance avec temporisation, plafond 5/10 min, recharge le dernier modèle, écrit `runtime-supervisor.log` | **en service mais muet** (cause prouvée §3) |
| garde anti-veille + diagnostic | `backend/supervisor/powerGuard.js` (P62-B3/C) | empêche la veille, journalise RAM libre et silence client lors d'une relance | en service |
| serveur HTTP | `server.enterprise.py` (Flask, `threaded=True`) | `/health`, `/models`, `/reload`, `/v1/chat/completions` | en service |
| fenêtre de contexte | P1-c / P43-1 / **P68-B** | `n_ctx` demandé, sinon politique automatique, sinon profil RAM ; budget d'appel = 70 % de la fenêtre **mesurée** | en service |
| côté agent | `providers.waitForRuntime` | attend le runtime 180 s, puis relance supervisée | **corrigé** (§4 : « occupé » n'est plus traité comme « mort ») |
| dossier de logs unique | P33 (`backend/utils/techLog.js`, `server.js`) | `%LOCALAPPDATA%\SudoStudio\logs` | en service — sauf pour le superviseur (**corrigé**) |

---

## 2. Partie A — médecine légale des plantages

### A1. Ce qui est en place (PROUVÉ localement)

Trois ajouts, tous vérifiés par `backend/tests/test-p69-runtime-survival.js` :

1. **`faulthandler`** activé au démarrage du runtime, écrit dans
   `<logs>/runtime_crash.log` (append, en-tête pid + date). Si le fichier ne
   peut pas être ouvert, le runtime le **dit** dans son journal — un garde-fou
   muet n'est pas un garde-fou. (`forensics.enable_faulthandler`)
2. **Trace d'appel AVANT l'entrée dans le moteur natif** :
   `[CALL] begin id=… kind=chat|tools|tools+grammaire prompt_tokens=… grammar=… n_ctx=… max_tokens=…`,
   plus `last_call.json` réécrit à chaque appel et **supprimé à la fin normale**.
   S'il existe encore après la mort du processus, c'est l'appel en cours.
3. **Côté parent**, le superviseur sait maintenant :
   * le **code de sortie** de l'enfant qu'il a lancé (et son nom symbolique :
     `0xC0000005 ACCESS_VIOLATION`, `0xC0000409 STACK_BUFFER_OVERRUN`,
     `0xC000001D ILLEGAL_INSTRUCTION`) ;
   * l'heure, la RAM libre, la durée de vie du processus ;
   * le **dernier appel tracé** (`last_call.json`) et la **fin du fichier de
     crash** ; tout cela est écrit dans `runtime-supervisor.log` et dans le
     journal technique **avant** toute relance.

Sortie du test (extrait, exécuté ici) :

```
ok - K1 faulthandler actif avec un fichier de crash
ok - K1b la trace d appel est ecrite AVANT le moteur natif
ok - K1c la phase passe a generation puis revient a libre
ok - K1d la trace est effacee apres un appel normal (sinon: plantage)
ok - K5 le code 0xC0000005 est nomme ACCESS_VIOLATION
ok - K5b le code 0xC0000409 est nomme STACK_BUFFER_OVERRUN
ok - K5c sans enfant lance : dit clairement que le code est inconnu
ok - K5d le contexte de crash porte l appel en cours et la fin du fichier de crash
```

**Limite honnête** : dans le paquet installé, `runtime.exe` est lancé par
`start.bat`/`startup.ps1`, **pas** par le superviseur. Le code de sortie
Windows n'est donc disponible que lorsqu'une relance a eu lieu (c'est le
superviseur qui relance). Pour le démarrage initial, la preuve reste le
fichier `runtime_crash.log` (faulthandler) — c'est précisément pour cela qu'il
est activé.

### A2. Reproduction en CI (vrai modèle, ubuntu CPU)

Banc : `scripts/ci/p69-crash-bench.py`, job CI **`P69 - survie du runtime
(300 appels + plantage injecte)`**.
Série : 300 appels alternant chat / outils+grammaire / prompt à ~55 % de la
fenêtre ; `n_ctx` 2048 puis 4096 ; à chaque appel, l'état du processus est lu
immédiatement après la réponse.

**RÉSULTAT CI — deux runs indépendants, vrai modèle, 240 appels au total.**

Run `44966308802`, job `137036008632` :

```
=== P69: serie de 120 appels sur le VRAI runtime (ports 43929/38477) ===
chargement : {"ok": true, "load_s": 2.0, "n_ctx": 8192, "rss_mb": 2020.1}
battement de coeur : status=200 busy=False phase=demarrage
[FENETRE] n_ctx reel au depart : 2048
[BASCULE] n_ctx 2048 -> 4096 : {"status": 200, ... "n_ctx": 4096, "ram_available_gb": 14.8}
[BASCULE] rechargement : {"ok": true, "load_s": 1.0, "n_ctx": 4096, "rss_mb": 2021.7} | fenetre reelle = 4096

=== RESULTAT DE LA SERIE ===
appels            : 120
reussis (HTTP 200): 120
morts du processus: 0
latence mediane   : 13140 ms (max 40727 ms)
  aucune mort : sur cette machine et ce modele, la serie n'a pas reproduit le plantage.
  chat     n=30   codes={"200": 30}   mediane=   298 ms
  tools    n=30   codes={"200": 30}   mediane=  2635 ms
  pres     n=30   codes={"200": 30}   mediane= 27972 ms
  depasse  n=30   codes={"200": 30}   mediane= 40195 ms
```

Run `44966352600`, job `137036147812` (même code, autre machine, en parallèle du
précédent) : `reussis 120/120`, `morts 0`, `mediane 9033 ms (max 29193 ms)`,
`chat 215 ms / tools 1890 ms / pres 19557 ms / depasse 28969 ms`.

**Conclusion honnête : le plantage n'est PAS reproduit en CI.** 240 appels
réels, quatre familles, deux fenêtres (2048 puis 4096), jusqu'à 120 % de la
fenêtre : zéro mort. Ce n'est pas « le bug n'existe pas » — c'est « il ne se
déclenche ni sur ce CPU (AVX2, Ubuntu) ni avec 1,5B Q4_K_M ». La machine du
21/11 est un Windows, sur un autre CPU. C'est pour cela que le script de la
partie A3 existe.

Deux observations de méthode, dites franchement :

* **Un « au-delà de la fenêtre » ne casse rien ici** : les 30 appels à 120 %
  reviennent tous `200` en ~29–40 s parce que `trim_messages_to_budget`
  ramène le message au budget d'appel (70 % de la fenêtre). Le cas « on
  dépasse et le moteur tombe » n'est donc **pas** exercé par cette voie.
* Les deux runs tournaient en parallèle sur deux machines : les latences
  diffèrent d'un facteur ~1,45. Aucun chiffre de latence n'est à comparer
  entre les deux.

### A3. Script pour ton PC

`scripts/ci/p69-stress-pc.ps1` (livré, **non exécuté ici** — je n'ai pas de
Windows). Il fait exactement la même série, avec bridage de RAM optionnel :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\p69-stress-pc.ps1 -MaxFreeRamMb 2048
```

Il écrit `p69-pc-report.txt` (machine, RAM, série, chaque mort avec code de
sortie / RAM / `last_call.json` / fin de `runtime_crash.log`, puis le plantage
injecté et le temps de redémarrage complet) et indique les fichiers à me
renvoyer.

---

## 3. Pourquoi `runtime-supervisor.log` était muet depuis le 17/11 (PROUVÉ)

**Cause : le superviseur écrivait dans un dossier qui n'existe pas / n'est pas
inscriptible, et toutes les erreurs d'écriture étaient avalées.**

Preuve dans le paquet **installé** (journal du backend, 18/11, extrait de
`smoke-out/backend.log`) :

```
logDir (P33 single): C:\Users\runneradmin\AppData\Local\SudoStudio\logs
pkg context: true
process.execPath: C:\Program Files\Sudo Studio\backend.exe
```

et le calcul de l'ancien chemin d'audit (`path.dirname(execPath) + '..\logs'`) :

```
execPath        : C:\Program Files\Sudo Studio\backend.exe
AVANT (ancien)  : C:\Program Files\logs
APRES (P33/P69) : C:\Users\jules\AppData\Local\SudoStudio\logs
```

`C:\Program Files\logs` n'est pas inscriptible sans élévation ; `fs.mkdirSync`
échouait (erreur ignorée), puis chaque `appendFileSync` échouait aussi —
**silencieusement** (`catch (_) { /* ignore */ }`). D'où zéro ligne depuis le
17/11 alors que le runtime a redémarré trois fois le 21/11.

**Corrigé** : le journal suit le dossier de logs unique (P33), et une écriture
impossible est **signalée** (console + journal technique), une fois par
processus. Tests : `K3`, `K3b`, `K3c`.

> Ce que ce paragraphe ne prouve pas : que le superviseur *tournait*. Il
> tournait (sinon aucun redémarrage n'aurait eu lieu) ; il ne pouvait pas
> écrire. La preuve définitive sera la première ligne « START watching=… » dans
> `%LOCALAPPDATA%\SudoStudio\logs\runtime-supervisor.log` sur ton PC après
> installation du nouveau paquet.

---

## 4. Avant / après : santé et relance

| | avant | après |
|---|---|---|
| savoir si le runtime est **mort** ou **occupé** | impossible : `/health` est le seul point, il ne répond pas pendant une génération ; le superviseur conclut « refusé x58 » et relance un processus vivant | **battement de cœur** sur un port séparé (`127.0.0.1:6001/hb`), dans un thread qui ne touche jamais au moteur : `{alive, busy, phase, call{prompt_tokens, grammar, n_ctx, elapsed_ms}}` |
| relancer un runtime vivant | possible (compteur d'échecs) | **interdit** : battement vivant ⇒ aucun redémarrage, quel que soit l'état de `/health` |
| message côté agent | « runtime indisponible après 105228 ms, probes=21 » | si le battement répond : « Runtime vivant mais indisponible pour l'instant : génération en cours (N jetons) — attente, aucune relance » |
| relance | « relance impossible (timeout) » | cause journalisée (code de sortie, RAM, dernier appel), temporisation, **durée totale** écrite |
| journal du superviseur | muet (mauvais dossier, erreurs avalées) | dossier P33 + échec d'écriture signalé |

Mesure du battement (extraite du test local, processus réel) :

```
ok - K2 le battement de coeur demarre (port choisi par l OS)
ok - K2b pendant une generation le battement repond quand meme
ok - K2c il distingue OCCUPE (busy=true, phase=generation)
ok - K2d controle negatif : mort -> aucune reponse (ECONNREFUSED)
ok - K4 un runtime OCCUPE (generation) n est jamais relance
ok - K4c un runtime MORT est relance (controle positif)
```

Sur « relance impossible (timeout) » : la relance échouait parce que le
superviseur **sondait `/health` d'un processus qui charge un modèle** (ou qui
génère) et concluait à l'échec au bout de `waitHealthy` ; il tuait ensuite un
runtime occupé puis en relançait un autre qui rechargeait le modèle (3 à 15 s).
Avec le battement de cœur, ce cas disparaît : on ne relance plus un processus
dont le cœur bat.

---

## 5. Endurance et plantage injecté (point 10)

**Prouvé localement** (banc lui-même, avec un faux runtime qui meurt à l'appel
4 — c'est le contrôle négatif du banc) :

```
appels            : 8
reussis (HTTP 200): 6
morts du processus: 2
  mort apres l'appel 4 (kind=tools) exit=139 last_call={"call_id":"stub-4","kind":"tools+grammaire","grammar":true,"n_ctx":2048}
=== PLANTAGE INJECTE (SIGKILL en pleine generation) ===
sans relance : /health -> None (URLError: [Errno 111] Connection refused)
reprise : ok=True en 1.0s (modele recharge, n_ctx=2048)
```

**Sur le vrai modèle** (run `44966308802`, job `137036008632`, extrait) :

```
=== PLANTAGE INJECTE (SIGKILL en pleine generation) ===
client : None en 1626ms (connexion coupee)
battement avant le kill : {"status": 200, "busy": true, "phase": "generation"}
sans relance : /health -> None (URLError: [Errno 111] Connection refused)
reprise : ok=True en 2.0s (modele recharge, n_ctx=8192)
preuve   : last_call={"call_id": "1795308650029-552", "kind": "chat",
           "pid": 2810, "prompt_tokens": 1424, "n_ctx": 4096, "max_tokens": 200, ...}
```

Trois choses à retenir de ce bloc, et aucune n'est décorative :

1. **Le battement de cœur dit la vérité juste avant la mort** :
   `busy=true, phase=generation`. C'est exactement l'information qui manquait
   le 21/11.
2. **Le contrôle négatif passe** : sans relance, `/health` refuse la connexion.
   La reprise mesurée n'est donc pas un artefact.
3. **Le client ne reçoit pas de 503** : il voit la connexion se couper
   (`RemoteDisconnected`). C'est la limite de la section 7.

**Ce qui reste vrai (et qui est maintenant dit en 503)** : aucune reprise en
vol. Un appel interrompu par la mort du moteur est perdu — mais le client
reçoit un `503` JSON qui nomme la panne, jamais une connexion coupée. La suite
`I7`/`I7b` le vérifie.

---

## 5 bis. C7 — L'API SURVIT AU PLANTAGE DU MOTEUR (fait, prouvé)

Le 21/11, l'API **était** le moteur : un plantage natif emportait tout. C'est
corrigé — le moteur vit désormais dans un processus enfant.

```
client --> api_front (parent : ne touche JAMAIS au moteur)
                |
                +-- proxy HTTP --> server.enterprise.py (enfant : llama.cpp)
```

Ce que ça change, concrètement :

| situation | avant | après |
|---|---|---|
| le moteur meurt | l'API meurt : connexion coupée, plus de `/health` | l'API répond **200** sur `/health` avec `engine.alive=false` + le code de sortie nommé |
| un appel pendant la panne | rien, silence | `503` JSON `engine_unavailable` : « le moteur a planté (…), l'API est vivante, relance en cours, réessayez » |
| réparation | l'utilisateur relance le produit | relance automatique (+ temporisation croissante), l'appel suivant passe |
| second lancement sur un port occupé | deux moteurs se disputaient le port | le second front **s'arrête** et le dit (« runtime déjà en service ») |
| moteur qui meurt en boucle (binaire cassé) | relances sans fin | relances **suspendues** après 5 morts en < 5 s, raison exposée dans `/engine` |

Preuves, toutes exécutées :

```
backend/tests/test-p69-engine-isolation.js  ->  17 checks, tous verts
  ok - I5 l API repond ENCORE apres la mort du moteur (200, jamais coupee)
  ok - I6 /health nomme la mort du moteur
  ok - I7b le 503 dit que le moteur a plante et qu il est relance
  ok - I8 apres relance, l appel suivant passe
  ok - I12 CONTROLE NEGATIF : sans front, la mort du moteur coupe la connexion
  ok - I14 un second front sur un port deja servi refuse de demarrer
  ok - I15 un moteur qui meurt immediatement suspend les relances, avec la raison
```

et avec le **vrai modèle** en CI (job `p69-isolation`) :

```
ok   - 1 le front repond et le moteur a charge le modele
ok   - 2 un vrai appel passe par le front       :: status=200 texte='Bonjour'
ok   - 4 le moteur est tue (SIGKILL)            :: pid=2581
ok   - 5 l API repond ENCORE (code 200) apres la mort du moteur
ok   - 6 /health nomme la mort du moteur        :: last_exit=-9 "signal 9"
ok   - 10 le front n'a jamais quitte
ok   - 11 CONTROLE NEGATIF : sans front, la meme mort coupe la connexion
```

Le produit s'en sert : `start.bat` lance `runtime.exe --front`
(`SUDO_API_FRONT=0` restaure l'ancien mode). Vérifié dans le paquet construit :
l'étape « Copy start.bat from Sudo-studio repo » passe, et le garde-fou
d'installation (`P46 delivery gate`) donne `GATE RESULT: SUCCESS (22 checks)`
avec `P46-6 PASS runtime-journal-nctx`.

---

## 6. Temps de redémarrage mesuré (point 6)

| mesure | valeur | où |
|---|---|---|
| relance avec faux runtime (banc) | **1,0 s** | sortie ci-dessus |
| relance complète (processus + modèle), vrai modèle | **2,0 s** (deux runs, même valeur) | job `p69-runtime`, bloc « reprise : ok=True en 2.0s (modele recharge, n_ctx=8192) » |
| relance sur ton PC | **à mesurer** | `p69-pc-report.txt`, section « relance complete » |

---

## 7. Ce qui n'est PAS prouvé, et la commande à lancer chez toi

**NON PROUVÉ ici** : la cause du plantage du 21/11. Candidats, par ordre de
plausibilité, et ce qui les départagerait :

1. **instruction illégale** (`0xC000001D`) : la variante `avx2` de llama.cpp
   sur un CPU qui ne la supporte pas. Départage : le code de sortie.
2. **violation d'accès** (`0xC0000005`) dans llama.cpp pendant le décodage
   contraint (grammaire) : c'est le point commun des 28 redémarrages (19
   normaux + 9 avec grammaire) — la grammaire n'est donc pas la seule cause.
3. **RAM critique** pendant le chargement ou l'inférence (2,6 Go libres).

Commande à lancer sur ton PC (aucun droit admin requis) :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\p69-stress-pc.ps1 -MaxFreeRamMb 2048
```

puis renvoie `p69-pc-report.txt`, `%LOCALAPPDATA%\SudoStudio\logs\runtime_crash.log`
et `%LOCALAPPDATA%\SudoStudio\logs\last_call.json`. Ce sont eux qui donneront
le code de sortie et l'appel exact.

---

## 8. Tableau final

| # | item | état | preuve |
|---|---|---|---|
| A1 | faulthandler + trace d'appel + code de sortie côté parent | **PROUVÉ (local)** | `test-p69-runtime-survival.js` K1, K5 |
| A2 | reproduction CI, vrai modèle | **NON REPRODUIT** : 2 runs, 240 appels, 0 mort (§2) | jobs `137036008632`, `137036147812` |
| A3 | script PowerShell PC | **LIVRÉ, NON EXÉCUTÉ ICI** | `scripts/ci/p69-stress-pc.ps1` |
| B4 | cause du silence du superviseur | **PROUVÉ** | §3 (journaux du paquet installé + calcul du chemin) |
| B5 | point de santé inblocable, occuper ≠ mort, ne jamais relancer un vivant | **PROUVÉ (local + CI)** | K2, K2b–d, K4, K4b ; bandeau « battement de coeur : status=200 busy=False phase=demarrage » en CI |
| B5b | correction de « relance impossible (timeout) » | **PROUVÉ (local, par construction)** ; à confirmer sur PC | §4 |
| B6 | relance temporisée et journalisée + durée | **PROUVÉ (local, journal)** ; durée réelle : CI/PC | `RESTART done … duration_ms=` |
| C7 | isolation de l'inférence : l'API survit au plantage du moteur | **PROUVÉ (local + CI, vrai modèle)** | §5 bis : 17 checks, job `p69-isolation`, contrôle négatif |
| C8 | un seul chargement, fenêtre figée par session + raison affichée | **PROUVÉ (local)** | K6, K6b–d ; panneau Runtime |
| C9 | message RAM clair avec la marche à suivre | **PROUVÉ (local)** | K7, K7b–d |
| B12 | le job `p68-context` n'est plus rouge (critère mal posé) | **PROUVÉ (CI)** | run `44966352600` : témoin `/tokenize` 8 prompts, écart max **0** jeton, chemin agent **0** |
| D10 | endurance 100+ requêtes + plantage injecté + contrôle négatif | **PROUVÉ (CI, vrai modèle)** : 240 appels, 0 mort, contrôle négatif OK, reprise 2,0 s | §5 |
| D11 | paquet installé : /health, redémarrage forcé, journal superviseur | **PROUVÉ (CI Windows)** | paquet `45010255766` : `GATE RESULT: SUCCESS (22 checks)`, `P46-6 PASS runtime-journal-nctx`, smoke installation vert |
| B6 | un battement étranger ne rend pas un mort vivant | **PROUVÉ** | `K2e` ; bug réellement rencontré (deux suites sont devenues rouges) |

---

## 9. Commits, runs et paquet

**Sudo-studio** (tout sur `main`, aucune branche) :

```
c83683d  P69-C7 : deux gardes appris du paquet P69 (pas de second moteur sur
         un port deja servi ; temporisation croissante + suspension des
         relances quand le moteur meurt immediatement)
683ea5a  P69-C7 : api_front.py (moteur en processus enfant), --front,
         start.bat, suite d'isolation ; P69-B6 (battement etranger)
bd18945  banc d'isolation : les deux formes de 503 ; Flask installe pour que
         la suite tourne vraiment (un SKIP ne doit pas passer pour un vert)
0797b17  serie dimensionnee sur la fenetre REELLE
2c4458a  medecine legale, battement de coeur, superviseur, fusion, RAM
23a225f  P68 : critere de comptage MESURE (temoin /tokenize)
```

| run Sudo-studio | tête | quoi |
|---|---|---|
| `45001468412` | `683ea5a` | P69-runtime, P68-*, P67 verts ; `p69-isolation` et `49 suites` rouges → corrigés |
| `45003103510` | `bd18945` | suite complète (relancée pour la tête du paquet) |
| `45003351321` | `bd18945` | **01 backend** → vert |
| `45003353210` | `bd18945` | **02 runtime** → vert |
| `45008243441` | `c83683d` | **01 backend** → vert (paquet final) |
| `45008223309` | `c83683d` | **02 runtime** → vert (paquet final) |

**Paquet** (`sudo-studio-packager`, pins `45008243441` / `45008223309`,
`SUDO_STUDIO_REF = c83683da…`) :

| run | résultat | ce qui est dedans |
|---|---|---|
| `45003172376` | **échec, à juste titre** | garde-fou : « pins construits depuis 683ea5a, or ref = bd18945 » |
| `45005217786` | **succès** | installer + portable (preuve de bout en bout) |
| `45010255766` | **succès** | installer **359,6 Mo**, portable **416,5 Mo**, `GATE RESULT: SUCCESS (22 checks, 3 skipped)` |

Étapes vertes du job `build` : garde-fou d'artefact périmé, `Download
backend.exe`/`runtime.exe` par run ID, `Verify artifacts are built from current
main`, `Copy start.bat`, Inno Setup, **`P46 delivery gate (install + test
installed product)`**, `Upload installer`. Job `P29+P31 smoke (Windows install
+ agent e2e)` : **succès** — c'est l'installation réelle testée sur Windows.

**Un point rouge, dit tel quel** : le job *best-effort* `P35 panel render`
échoue sur son étape « start.bat PHASE 5 + hidden launch », avec
`no editor window titled Sudo Studio after hidden launch`. Deux runs ont
échoué à des endroits différents de cette même étape (l'un après « Editor
detected », l'autre avant), et `startup-phase5.log` montre `[PHASE 2] Runtime
ready on port 6000` puis `DEBUG PHASE 5 START` : le lanceur va bien. C'est une
assertion sur le **titre de fenêtre** d'un éditeur lancé en `SW_HIDE` sur un
runner CI ; elle n'est pas dans le chemin du produit. Je ne l'ai pas maquillée
(`continue-on-error`, elle n'empêche pas le paquet) et je ne la déclare pas
résolue.

**Reste ouvert** : (a) cette étape P35 ; (b) valider `--front` sur ton PC
(`%LOCALAPPDATA%\SudoStudio\logs\runtime-front.log` doit contenir
`moteur lance pid=…`, puis `curl http://127.0.0.1:6000/engine`).
