# P63 - Reprise reelle, delais coherents, etat hors projet, JSON non rejete

Commit : `285f6fc` (branche `p60-linux`), construit sur `e6c3d48`.
Tests : `backend/tests/test-p63-agent.js` (G1, G2, G3, G5, F-18, C-UI) et
`backend/tests/test-p63-json.js` -> `backend/tests/test_p63_json.py` (G4).

Regle appliquee : chaque test a ete joue AVANT (code de `e6c3d48`, worktree
`/tmp/p63-before`) et APRES. La sortie "avant" est dans
`docs/p63/preuve-avant.txt`, reproductible avec :

    git worktree add /tmp/p63-before e6c3d48
    P63_REPO=/tmp/p63-before node scripts/ci/p63-reproduction-avant.js

---

## 1. Ce que disaient les 5 echecs et ce qui a change

### G1 - "continu" ne reprenait rien (cause racine trouvee)

Cause : `sudo-agent/src/loop.js`, detection de reprise `/reprend/i` seulement
(l. ~931 de `e6c3d48`). "continu" ne correspondait pas : le tour partait dans
la boucle modele normale, qui repondait "Mode build / Termine / TERMINE (build)"
sans jamais lire le registre. Les 60 etapes restaient "pending".

Correction :
- nouveau module pur `sudo-agent/src/resume.js` : `isResumeIntent()` reconnait
  `continu|continue|reprends|poursuis|vas-y|on continue|ok continue|resume`
  (message entier, ponctuation et accents toleres ; une phrase comme
  "continue d ecrire le rapport" ne declenche PAS la reprise) ;
- `loop.js` : chemin de reprise DETERMINISTE place avant la boucle modele -
  il relit `job.unfinished()` sur disque, annonce les 4 nombres
  (`x faites, y echouees, z interrompues, w non tentees`), redemarre a la
  premiere etape non faite et n'appelle JAMAIS le modele pour cela ;
- `job.js` : `resumable()` reprend tout travail inacheve (`running`,
  `proposed`, `stopped`, `partial`, `failed`, `interrupted`), `unfinished()`,
  `firstOpenStep()`, `progressLine()` ;
- `job.reportText()` : entete `INCOMPLET (travail x/N)` tant qu'une etape n'est
  ni faite ni explicitement hors perimetre -> plus de faux "TERMINE" ;
- `AgentPanel.js` : bouton "Reprendre le travail" qui envoie le MOT CLE
  `reprendre` (donc le chemin deterministe), plus la phrase "reprendre le
  projet" qui, elle, repartait dans le modele.

### G2 - 121 s contre 180 s : le temps de panne etait decompte

Cause : `job.js` comparait `s.ms` (temps MURAL) a `b.stepMs = 120000`, alors
que l'attente runtime peut durer 180 s. Une panne de 150 s faisait donc
depasser le budget.

Correction :
- `job.delays()` : un seul endroit, trois delais documentes
  (`runtimeWaitMs` 180 s, `stepActiveMs` 300 s, `jobTotalMs` 3600 s,
  `attempts` 3) avec invariants appliques vers le HAUT : aucun delai interne
  plus court que celui qu'il couvre ;
- `job.run()` : l'etape mesure `ms` (mural), `activeMs` (mural moins
  `runtimeDownMs`) et `runtimeDownMs` ; le budget se juge sur `activeMs` ;
- statut dedie `interrupted_runtime` + texte `INTERROMPUE (runtime) ... Reprise
  automatique.` ; l'etape reprend EN PREMIER (tri explicite) ;
- `loop.js` : `runEntry.runtimeDownMs` cumule les attentes mesurees a l'horloge
  monotone, evenements `runtime.down` / `runtime.up`, et le minuteur d'etape du
  tour enfant est un `setInterval` qui compare le temps ACTIF (suspendu pendant
  la panne), y compris pour le watchdog de secours.

### G3 - `.sudo-agent` cree DANS le projet

Cause : 4 chemins codes en dur (`job.js:31`, `spec.js:37`, `orch.js:23`,
`loop.js:1581`) + `store.js`, `checkpoints.js`, `journal.js`, `skills.js`,
`commands.js`, `gen.js`, `extensions.js`, `agents.js`, `mcp.js`,
`permissions.js`, `verify.js` qui ecrivaient sous `~/.sudo_studio/agent` ou
dans le projet.

Correction : nouveau module `sudo-agent/src/stateDir.js`
(`fingerprint()` sha256 du chemin absolu, 16 caracteres, minuscule sous
Windows) ; tout l'etat vit dans
`%LOCALAPPDATA%\SudoStudio\agent\workspaces\<empreinte>\` (Linux/macOS :
`XDG_DATA_HOME` / `~` equivalents). Sous-dossiers : `jobs`, `specs`,
`sessions`, `checkpoints`, `logs`, `registry = advancement.json`.

Compatibilite : si l'installation possede deja `~/.sudo_studio/agent`
(hors projet, donc deja conforme), il est conserve - aucune session, regle ni
point de retour perdu. Un `.sudo-agent` deja present DANS un projet est
detecte ; `migrateLegacy(root, approved)` ne le deplace qu'avec un accord
explicite et retire le dossier du projet s'il devient vide.

### G4 - "JSON illisible" sur des sorties qui paraissaient valides

Cause (tranchee) : ce n'etait ni le validateur ni un caractere invisible, mais
la TRONCATURE au budget `max_tok=512` : la chaine JSON etait coupee en plein
milieu, `_try_json` echouait, et le message affiche etait "JSON illisible".

Correction (`backend/runtime/openai_compat.py`, `toolcall_repair.py`) :
- `max_tok` par type d'appel (`_attempt(msgs, max_tok=None)`) ;
- si `finish_reason == "length"` et reparation impossible, un 2e essai est
  rejoue avec `max_tokens` double (borne 768..2048) ;
- `close_truncated()` referme la chaine et les accolades ouvertes ;
- `repair_tool_output()` au niveau module (la route et le test utilisent la
  MEME fonction : plus de copie divergente) ;
- un JSON reellement invalide reste rejete (`bonjour, pas de json`, `{}`),
  meme avec `finish_reason=length` ;
- (F-18) `sudo-agent/src/calc.js` : calcul deterministe, `2 + 298` -> `300`
  sans aucun appel modele.

### G5 - 327 exigences / 63 etapes annoncees contre 60 executees

Cause : deux sources de nombres (le plan affiche et le plan execute).

Correction (`spec.js`) : `MAX_STEPS` 200, `planWithMeta()` est la SEULE source
(`{steps, planned, kept, total, truncated, totalRequirements, outOfScope}`),
`planText()` affiche exactement le travail execute :
`N etape(s) a executer + M hors perimetre (K au total)` ; une exigence hors
perimetre (CI distante, installateur Windows, materiel reel, publication) est
marquee "a faire par l utilisateur" et n'est NI executee NI comptee en echec ;
`job.reportText()` affiche `TERMINE (travail x/N)` et le hors perimetre a part.

---

## 2. Preuves a-h

| Preuve | Attendu | Resultat | Statut |
|---|---|---|---|
| a. reproduction avant correction | G1/G2/G3/G5 reproduits sur `e6c3d48` | `docs/p63/preuve-avant.txt` : statut `TERMINE`, "Mode build / Termine / TERMINE (build)", 1 appel modele parent, etapes 5..12 non executees, `.sudo-agent` dans le projet, pas de ligne hors perimetre | PROUVE (local) |
| b. cause racine fichier + ligne | oui | `loop.js` l.931 (`/reprend/i`), `job.js` l.31 (`jobsDir`), `spec.js` l.37 (`specsDir`), `orch.js` l.23, `loop.js` l.1581 ; `job.js` `s.ms > b.stepMs` ; `max_tok=512` | PROUVE |
| c. test G1-G5 echouant avant, vert apres | 5 tests | avant : G1 = `TERMINE` + 0 reprise ; apres : 37 checks verts (`test-p63-agent.js`) + 10 verts (`test_p63_json.py`) | PROUVE (local) |
| d. panne runtime 150 s jamais decomptee | oui | G2-d/e/g/h : `activeMs = 0`, `runtimeDownMs = 150000`, statut `interrupted_runtime`, `failed = 0` ; 121 s murales dont 120 s de panne -> etape FAITE | PROUVE (test) |
| e. `continu` deterministe (0 appel modele) | oui | G1-a : 0 appel parent ; G1-b : "Redemarrage a l etape 5" ; G1-i/j : sans travail inacheve, 0 appel et message clair | PROUVE (test) |
| f. aucun fichier d'agent dans le projet | oui | G3-a/b/c/d/e + `test-p62-spec-cahiers` F-1a2 : repertoire projet inchange, etat sous `<workspace>/<empreinte>` | PROUVE (test) |
| g. JSON : deux sorties brutes passent, JSON invalide rejete | oui | G4-1..G4-6 verts | PROUVE (local) |
| h. plan coherent (memes nombres) | oui | G5-a/b/c/d/e verts | PROUVE (test) |

### Statut global

| Element | Statut |
|---|---|
| Correctifs G1, G2, G3, G4, G5 (code) | PROUVE (tests locaux + CI ci-dessous) |
| Suite complete locale `backend/tests/run-all.js` | PROUVE : 60 suites, 0 failed |
| CI 00 sur `285f6fc` | PROUVE : run `43615131711` -> `TOTAL: 60 suites, 0 failed`, PowerShell syntax OK |
| Binaires Windows du paquet (01 + 02) | PROUVE : `backend-exe` 31,9 Mo + `runtime-exe` 244,2 Mo construits sur `285f6fc` |
| Paquet Windows installe (G1-G5 rejoues sur le binaire) | NON PROUVE ICI -> commande PC section 4 |
| Linux (conteneurs, XDG) | NON FAIT (demande explicite : plus tard) |
| Run 03 precedent `43482333015` | INTROUVABLE (404 API) -> rien a conclure |
| G4 sur un vrai modele local (troncature reelle) | PARTIEL : la troncature est reproduite en test, pas sur un modele 1.5B installe |

---

## 3. CI

- 00 tests : run `43615131711` sur `285f6fc` (p60-linux) ->
  `TOTAL: 60 suites, 0 failed`, plus `P63: 37 checks passed` et
  `P63-F: all green` dans le meme journal ; job "PowerShell syntax" : success.
- 01 backend : run `43615839230` (285f6fc) -> success, artefact
  `backend-exe` 31,9 Mo.
- 02 runtime : run `43615841096` (285f6fc) -> success, artefact
  `runtime-exe` 244,2 Mo.
- Assemblage installateur ("03") : le workflow d assemblage n existe PLUS dans
  le depot (seuls 00, 01 et 02 sont presents) ; le run 03 `43482333015`
  invoque precedemment repond 404. L installateur Windows est donc
  NON PROUVE ICI ; les deux binaires qui le composent sont construits par
  01 et 02.

---

## 4. Commande PC (paquet installe)

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-e2e.ps1 `
      -InstallDir "C:\SudoStudio" -ProjectPath "C:\mon\projet" `
      -OutDir "C:\p63-preuves"

Scenarios P63 ajoutes (15 a 20), chacun avec sa ligne de journal :

- 15 cahier de 300 lignes : plan annonce = etapes executees, aucun
  `.sudo-agent` dans le projet, etat dans
  `%LOCALAPPDATA%\SudoStudio\agent\workspaces\<empreinte>` ;
- 16 panne runtime de 150 s puis `continu` : etape `INTERROMPUE (runtime)`,
  reprise, aucune ligne "budget temps depasse" ;
- 17 `continu` sans travail inacheve : reponse deterministe, 0 appel modele ;
- 18 redemarrage du serveur d'agent puis `continu` : reprise depuis le registre ;
- 19 `git status` propre : aucun fichier de l'agent vu par git ;
- 20 trois echecs sur une etape puis passage a la suivante.

Rapport ecrit dans `<OutDir>\agent-e2e-report.txt` (PASS/FAIL/SKIP + preuve).

---

## 5. Rappels

- Le jeton GitHub utilise pour pousser doit etre REVOQUE apres usage.
- Aucun dossier `.sudo-agent` ne doit reapparaitre dans un projet : si un
  ancien projet en contient un, l'agent propose la migration (accord explicite).
