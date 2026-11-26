# P71 - PROJECT ANALYSIS (recommandations IA), SYSTEM DOCTOR, AUTOFIX

Date : 2026-11-25, sandbox Linux (aucun PC Windows, aucun modele charge ici).
Branche : `main` uniquement, aucun nouveau fichier de workflow (2 jobs ajoutes a `00`).

---

## 1) Tableau d'etat : ce qui touchait deja ces fonctions

| Point P71 | Etat avant ce prompt | Preuve (fichier) |
|---|---|---|
| Recommandations IA (W1) | un seul chemin : `POST http://127.0.0.1:6000/infer`, `max_tokens: 400`, **delai fixe 60 000 ms**, contexte borne a 1500 caracteres ; aucun message de cause sauf « Delai depasse (60s) » | `sudo-ai-extension/src/panels/ProjectAnalysisPanel.js` l.505-543 |
| Probleme « delai depasse » | `axios` avec `timeout: 60000` en dur : aucune mesure de vitesse, aucun plafond configurable, aucun bouton Annuler pour l'enrichissement | idem l.528 |
| AutoFix d'analyse (W2) | le panneau ne traite que `fixGitignore`, `genDockerfile`, `genCICD` ; **aucun** `addTestScript` ni README ; le reste tombe dans un `switch` sans `default` = silence | idem `runAutoFix()` |
| API backend d'auto-fix | `POST /api/project/auto-fix` est une **simulation** : `issues_fixed` code en dur, aucun acces disque | `backend/routes/project.routes.js` l.88-140 |
| Analyse backend | `POST /api/project/analyze` renvoie aussi des **chiffres inventes** (`files_count: 142`, `score: 72`) ; le panneau, lui, utilise le moteur deterministe `projectAnalyzer.js` | `backend/routes/project.routes.js` l.40-80 |
| Doctor (W3) | detection par `exec('node --version', {timeout: 5000})` avec le PATH herite de l'editeur, aucun `where`, aucune trace, `err` -> « Not found » | `sudo-ai-extension/src/panels/DoctorPanel.js` l.64-89 |
| PATH de l'agent (P70) | corrige cote agent : `p70/env.js` lit le registre a chaque tour | `sudo-agent/src/p70/env.js` |
| AutoFix npm / SDK | `doctor/autoFix.js` installe via winget sans verifier l'etat ni re-tester | `sudo-ai-extension/src/doctor/autoFix.js` |

---

## 2) Partie A - mesures et verdict H1/H2/H3

**NON MESURE ICI** : aucun modele n'est charge dans cette sandbox (pas de GGUF, pas de
runtime). Le banc est ecrit et cable : `scripts/ci/p71-analysis-bench.js` + job
`p71-real-model-analysis` (matrice `n_ctx` = 2048 / 4096 / 8192, meme modele Qwen2.5-Coder-1.5B
Q4_K_M que P67). Il imprime et archive : jetons du prompt (reels si `usage.prompt_tokens`,
sinon estimes), fenetre, plafond 70 %, duree totale, jetons/s, delai calcule, verdict.

### Ce que le code prouve deja (sans modele)

- L'ancien prompt d'analyse etait borne a **1500 caracteres** de contexte (`.slice(0, 1500)`),
  soit environ 420 jetons estimes : il ne pouvait pas depasser 70 % d'une fenetre de 2048
  (1433 jetons). **H1 (fenetre depassee) est donc tres improbable pour ce panneau precis.**
- A la vitesse mesuree sur ton PC (25-30 jetons/s annonces, hypothese de travail), 400 jetons
  de sortie = 13 a 16 s de generation, et un prompt de ~420 jetons = 14 a 17 s de lecture :
  total de l'ordre de 30 s, **sous** les 60 s. Cela affaiblit **H2** tel quel, mais ne
  l'exclut pas (modele qui recharge, `n_ctx` 8192 au lieu de 2048, un autre appel en cours).
- Consequence : l'hypothese la plus coherente est **H3** (cause autre : runtime occupe /
  modele en cours de chargement / appel precedent encore en vol / lecture ×N). C'est une
  **HYPOTHESE**, pas une mesure : seul le run `p71-real-model-analysis` la tranchera.

### Ce que P71 change dans le client (A3)

- contexte **compact** borne a 70 % de la fenetre REELLE (`/models` : `real_window_tokens`,
  sinon `n_ctx`), jamais le depot entier ;
- **delai calcule** : `(jetons_prompt + max_tokens) / vitesse_mesuree + 8 s`, plancher 30 s,
  plafond configurable 180 s (avant : 60 s fixes) ;
- bouton **Annuler** ;
- echec -> cause en francais : `window` / `slow` / `busy` (503) / `offline` / `server`, chacune
  avec l'action proposee, **les recommandations deterministes restant affichees** ;
- journal `analysis` : `analysis_ai prompt_tokens=… window=… ratio=… max_out=… deadline_ms=…
  duration_ms=… tok_per_s=… issue=…` (aucun secret, aucun contenu de prompt).

---

## 3) Causes racines

### W2 - AutoFix de Project Analysis

Deux causes, les deux dans le code :

1. `runAutoFix(issue)` ne connait que `fixGitignore`, `genDockerfile`, `genCICD` ; les issues
   produites par l'analyse (`addTestScript`, README manquant) n'ont **aucun** cas : le `switch`
   n'a pas de `default`, donc rien ne se passe et **aucun message** n'est affiche (echec
   silencieux).
2. L'API `POST /api/project/auto-fix` du backend **simule** la correction (« Simuler l'auto-fix »)
   : elle renvoie `issues_fixed` en dur sans jamais toucher au disque. Un appel a cette route
   ne peut donc rien corriger par construction.

Correction (B5/B6) : `analysis/autoFixAnalysis.js` - plan deterministe + diff + approbation +
ecriture + **verification disque** + re-analyse. Deux corrections reelles :
`readme` (cree a partir des donnees d'analyse : nom, scripts, dependances, tests, structure) et
`testScript` (ajoute `scripts.test` **seulement** si un lanceur est detecte, sinon explique quoi
faire). Tout refus porte un code et une phrase en francais.

### W3 - Doctor qui rate Node/npm au premier diagnostic

Cause visible dans le code : detection par `exec('node --version', { timeout: 5000 })` avec
l'environnement **herite du processus Extension Host**, un `exec` par outil lance en parallele,
et un simple `err` -> « Not found » sans commande ni sortie. Trois fragilites concretes :
PATH potentiellement incomplet au demarrage, 5 s de delai sur un premier lancement a froid
(antivirus inclus), et **aucune trace** pour distinguer « pas installe » de « installe mais pas
dans le PATH ». Le second diagnostic qui reussit s'explique par un demarrage a froid deja paye
ou un PATH rafraichi : **HYPOTHESE** (pas de journal cote PC pour le prouver).

Correction (C8/C9) : `doctor/detectTools.js` - PATH **registre machine + utilisateur** relu a
chaque diagnostic, resolution `where`/`which`, dossiers d'installation connus, delai 15 s par
commande, **details** par ligne (commande, sortie, chemin resolu, PATH utilise, mode de
resolution) et etat « installe mais hors du PATH » -> **Reparer le PATH** (portee utilisateur,
`[Environment]::SetEnvironmentVariable("Path", $new, "User")`, aucun droit admin).

---

## 4) Erreur de l'AutoFix npm : message exact

**NON DISPONIBLE ICI** : le message n'a pas ete releve sur le PC et je ne l'invente pas.
Ce que le code fait maintenant, et qui rend la cause identifiable sans ambiguite :

| Situation | Code rendu | Message |
|---|---|---|
| deja installe et utilisable | `already_ok` | « npm est deja installe et utilisable (chemin) : rien a installer. » |
| installe hors du PATH | `repair_path` | « installe mais son dossier n'est pas dans le PATH : on repare le PATH utilisateur au lieu de reinstaller. » |
| absent + hors ligne sans installateur | `offline_no_installer` | chemin exact du dossier attendu (`%USERPROFILE%\.sudo_studio\installers`) |
| echec d'installation reseau | `install_failed` | « reseau indisponible pendant l'installation » + chemin hors ligne |
| installation OK mais detection muette | `fixed_unverified` | « la detection ne trouve toujours pas l'outil : rien n'est affirme a tort » |
| installation + re-detection OK | `fixed_verified` | « Termine et VERIFIE : chemin utilisable » |

Les familles de causes couvertes par la classification : npm absent du paquet Node, PATH,
identifiant winget, politique d'execution PowerShell, droits, reseau. La collecte du message
exact se fera par `collect-and-verify-p71.ps1` (journal `autofix`).

---

## 5) Resultats (a) a (f) avec controles negatifs

Suites ecrites et **vertes localement** (Linux, sans modele). Aucun run CI n'a pu etre lance
(voir 6 et 7).

| Exigence | Test | Resultat local | Controle negatif |
|---|---|---|---|
| (a) deterministe < 2 s | `test-p71-recommendations.js` R1/R2 | 10/10 vert ; mesure ~2 ms sur le projet de test | R3 : projet complet -> plus d'avertissement ; R4 : aucune reco « obsolete » sans donnee |
| (b) enrichissement IA avec le vrai modele | `scripts/ci/p71-analysis-bench.js` + job dedie | **NON JOUE** (pas de modele ici) | A11 : aucun « delai depasse » nu ; message + action |
| (c) AutoFix README + re-analyse | `test-p71-analysis-ai-autofix.js` B0-B6 | vert : diff, ecriture, verification, README disparait de la re-analyse | B2 : sans approbation rien n'est ecrit ; B6 : pas d'ecrasement |
| (d) Doctor premier diagnostic | `test-p71-doctor.js` C1/C2 | vert sur PC simule (PATH sans nodejs -> trouve par dossier connu) | C3 : PATH vide + dossier absent -> absent |
| (e) installe mais hors PATH | C4/C4b + `npmFix` D2 | vert : plan de reparation utilisateur, aucun droit admin | D2 verifie la re-detection apres reparation |
| (f) AutoFix npm verifie | `test-p71-doctor.js` D1-D6 | vert : 6 cas, dont hors ligne et echec reseau | D5/D6 : jamais de succes sans re-detection |

Totaux locaux : **10 + 25 + 13 = 48 checks**, tous verts. Non-regression dans le meme arbre :
P4 61/61, P26 28/28, P54 23/23.

---

## 6) Paquet : NON FAIT

La sandbox a perdu l'acces authentifie au depot (clone anonyme seul disponible) : **aucun push,
aucun dispatch de run, aucun paquet** n'a pu etre fait depuis cette session. Rien n'est donc
annonce comme construit. URL, taille et SHA256 : **non disponibles**.

Commandes a lancer (depuis ton PC, ou apres avoir reconnecte GitHub) :

```
# 1. pousser le commit P71 (branche main)
git push origin main

# 2. suites deterministes (workflow 00, job p71-analysis-doctor)
gh workflow run 00-test-suite.yml --ref main

# 3. modele reel : 3 fenetres (job p71-real-model-analysis)
gh workflow run 00-test-suite.yml --ref main

# 4. paquet officiel (depot sudo-studio-packager, sur la TETE de main)
gh workflow run package.yml --repo juleszackaria-lab/sudo-studio-packager --ref main
# puis : URL du run, taille des artefacts, SHA256 (64 caracteres), SHA de main en
# premiere ligne du journal de demarrage, fumee du paquet installe
```

---

## 7) Ce qui n'est PAS prouve ici + commande pour ton PC

- **(b) vrai modele** : rien n'a ete mesure. Verdict H1/H2/H3 a obtenir par le job
  `p71-real-model-analysis` (artefact `p71-analysis-<n_ctx>.json`) ou en local :
  `node scripts/ci/p71-analysis-bench.js --window 2048`.
- **(d) Doctor sur ton PC** (Windows reel, Node/npm/git/Python installes) :
  `powershell -ExecutionPolicy Bypass -File scripts\ci\collect-and-verify-p71.ps1`
  -> ZIP des journaux (analysis, analysis.jsonl, autofix, sdk, engine-child, runtime_crash,
  runtime_debug, agent) sur le Bureau + `p71-verify-<date>.txt` avec PASS/FAIL et la ligne
  de journal prouvante (`JOURNAL doctor | trouves=… | absents=… | hors_path=…`).
- **(e) reparation du PATH** : le script modifie le PATH **utilisateur** seulement s'il manque
  reellement le dossier de Node ; sinon il se contente de le dire (aucune modification inutile).
- **W1 reel** (bouton « Obtenir les recommandations IA ») et **W3 reel** (premier diagnostic) :
  NON PROUVES ICI, faute de PC Windows et de modele.

---

## 8) Tableau final

| Element | Statut |
|---|---|
| Recommandations deterministes + preuves (A2) | PROUVE EN LOCAL (moteur seul), 10 checks |
| Budget IA calcule, contexte <= 70 %, causes en francais (A3/A4) | PROUVE EN LOCAL (25 checks) ; mesure avec le vrai modele = NON PROUVÉ ICI |
| AutoFix README + test script, diff/approbation/verification/re-analyse (B5/B6) | PROUVE EN LOCAL (B1-B11) |
| Doctor : registre + `where` + dossiers connus + details (C8) | PROUVE EN LOCAL sur PC simule ; sur ton PC = NON PROUVÉ ICI |
| « installe mais hors PATH » -> reparer le PATH utilisateur (C9) | PROUVE EN LOCAL (plan + script exact) ; execution reelle = NON PROUVÉ ICI |
| AutoFix npm hors ligne / verifie (D10/D11) | PROUVE EN LOCAL (6 cas) ; message d'erreur d'origine = NON DISPONIBLE |
| Tests (a)-(f) avec controles negatifs | PARTIEL : (a)(c)(d-simule)(e-plan)(f) verts ; (b) et (d-reel) NON PROUVES ICI |
| Job CI + script PC | ECRITS, NON EXECUTES |
| Paquet (run, taille, SHA256) | NON FAIT (pas d'acces authentifie depuis cette session) |
| Push | NON FAIT (meme cause) |
