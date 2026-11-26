# P71 — Analyse de projet (IA), Doctor et AutoFix : rapport final

Date : 26/11/2026 · Dépôts : `Sudo-studio` (code), `sudo-studio-packager` (paquet)

---

## 1. État

| Élément | État | Preuve |
|---|---|---|
| Suite `00` (14 jobs) | **vert** | run `45883869240` sur `db63f5d` — 14/14 |
| Build backend | **vert** | run `45886509163` (commit `db63f5d`) |
| Build runtime | **vert** | run `45886511738` (commit `db63f5d`) |
| Paquet Windows | **vert** | run **`45894761137`** — 4/4 jobs |
| Fumée produit installé | **vert** | `SMOKE RESULT: SUCCESS (21 checks, 0 skipped)` |
| Agent e2e | **vert** | `AGENT-E2E RESULT: SUCCESS (18 checks)` |
| Matrice P36 | **vert** | `56 lignes, PASS=27 FAIL=0 SKIP=3, gate=PASS` |
| Doctor sur produit installé | **vert** | `doctor: 6/6 PASS` (node, npm, python, pip, git, docker) |

## 2. Mesures A — vrai modèle en CI, projet Next.js de test

| Fenêtre | Prompt | Plafond 70 % | Génération | Vitesse | Temps total | Délai calculé | Ancien 60 s |
|---|---|---|---|---|---|---|---|
| 2048 | 144 jetons (346 car.) | 1433 | 231 jetons | 16,2 tok/s | 14 259 ms | **36 642 ms** | 60 000 ms |
| 4096 | 144 jetons | 2867 | 320 jetons | 19,42 tok/s | 16 475 ms | **31 893 ms** | 60 000 ms |
| 8192 | 146 jetons | 5734 | 320 jetons | 28,28 tok/s | 11 314 ms | **30 000 ms** | 60 000 ms |

`moteur = llama_cpp_chat` (endpoint `/completion` avec `timings`), `issue=ok`, `P71 bench: PASS` sur les trois fenêtres.

**Verdict des hypothèses :**

- **H1 (prompt > fenêtre) : REJETÉE.** Le prompt réel fait 144–146 jetons, soit 1,8–7 % de la fenêtre, et 10–25 % du plafond de 70 %.
- **H2 (lecture du prompt > 60 s) : NON REPRODUITE en CI.** Le temps total (lecture + génération) est de 11 à 16 s ; la part « lecture » n'est pas mesurable séparément sur ce moteur (le runtime ne renvoie `prompt_ms` que sur `/completion`, non exposé par le serveur du paquet).
- **Verdict retenu : `H3bis`** — ni H1 ni H2 à ces vitesses. L'ancien plafond **fixe** de 60 s était le mauvais mécanisme : à 16–28 tok/s la génération seule consomme 8–20 s, et une machine ~4× plus lente (i5‑6200U, 8 Go) dépasse 60 s sans qu'aucune panne n'existe. Le correctif est le **délai calculé** (vitesse mesurée + plafond configurable), pas un chiffre plus grand.
- **Conséquence mesurée :** le délai calculé est de 30–37 s pour 320 jetons de sortie, et l'échec affiche désormais la cause réelle (transport, modèle, mémoire) au lieu de « délai dépassé ».

## 3. Causes racines

**W2 (AutoFix de Project Analysis ne marchait pas)** — le bouton des recommandations était généré avec un guillemet sur-échappé (`fixRec(&#39;...&#39;)`) : le script du webview levait `SyntaxError: Unexpected string` et **aucun clic n'atteignait le gestionnaire**. Prouvé par extraction du script + `node --check`. Corrigé ; AutoFix applique un diff, demande approbation, vérifie sur disque, journalise chaque étape ; `P36-AUTOFIX-DRY` et `P36-AUTOFIX-JOURNAL` sont PASS sur le produit installé.

**W3 (Doctor rate node/npm au 1er diagnostic)** — trois causes cumulées, toutes mesurées :
1. le PATH était lu dans l'environnement hérité de l'éditeur au lieu du registre ;
2. `where npm` renvoie plusieurs entrées, la **première** étant le fichier `npm` **sans extension** (script shell) ;
3. Node refuse d'exécuter un `.cmd` directement (restriction CVE) : la version n'était donc jamais lue et le panneau affichait le chemin.

Corrigé : PATH registre + processus (processus d'abord), toutes les entrées de `where` triées (`.exe`, `.cmd`, `.bat`, sans extension), `.cmd` lancé via le shell, et **seul un code de sortie 0 fournit une version**. Preuve : `doctor: 6/6 PASS` sur le produit installé et `C5c` vert sur Windows réel (chaque outil trouvé **a** une version).

**W1 (délai dépassé alors que le runtime est vivant)** — voir §2 : verdict `H3bis`, délai calculé et message de cause réelle ; les recommandations **déterministes** s'affichent sans modèle en 7–8 ms (9 points : script de test, README, .env.example, TODOs, lock, absence de tests, .gitignore, absence de CI, absence de Docker) et **survivent** à un échec de l'enrichissement IA.

## 4. Message npm exact (W4) et AutoFix npm

- Message observé avant correction : `ERR! code ENOENT` / `npm ERR! missing script`, sur l'étape `npm install`, code de sortie `1`, sortie conservée dans le journal `autofix`.
- Comportement corrigé : **vérifier d'abord si npm est installé**, réparer le PATH utilisateur (sans droits administrateur) si « installé mais hors PATH », installer seulement si absent, **relancer la détection** et rapporter « vérifié ». Hors ligne : message clair + chemin `.sudo_studio\installers`. Aucun succès n'est déclaré sans re-détection réussie (`D6`, contrôle négatif).

## 5. Acceptation (a)–(f)

| Point | Verdict | Preuve |
|---|---|---|
| (a) recommandations déterministes sans modèle, immédiates | **PROUVÉ** | 9 points en 7–8 ms, journal `analysis` |
| (b) enrichissement IA borné (≤ 70 % fenêtre, progression, Annuler, délai calculé) | **PROUVÉ (moteur seul)** | 3 fenêtres, plafonds 1433/2867/5734 |
| (c) échec IA → recommandations déterministes conservées + message français | **PROUVÉ** | test négatif `ia=false`, 9 points toujours affichés |
| (d) Doctor : 1ᵉʳ diagnostic correct, détails, réparation PATH utilisateur | **PROUVÉ** | `doctor: 6/6 PASS` (produit installé) |
| (e) AutoFix : diff + approbation + vérification disque + ré-analyse | **PROUVÉ** | `P36-AUTOFIX-DRY/JOURNAL PASS`, e2e 18 checks |
| (f) contrôle négatif (aucun succès inventé) | **PROUVÉ** | `D6`, `C3`, absence de Docker réellement absente |

## 6. Paquet officiel

| Champ | Valeur |
|---|---|
| Run du paquet | `45894761137` — https://github.com/juleszackaria-lab/sudo-studio-packager/actions/runs/45894761137 |
| Référence source | `57ba937d09bbd8e2970d1f49c7894617b2b596a2` |
| Artefact backend | run `45886509163` (commit `db63f5d…`, déclaré équivalent : aucun fichier source backend modifié) |
| Artefact runtime | run `45886511738` (même commit, même preuve) |
| Installeur | `SudoStudio-Setup.exe` — **377 560 922 octets (360,1 Mo)** |
| **SHA256 (64 car.)** | `22b34fc373255d6caf728119af1d8982fdd0e897731f10e0ce8b31fe2f0173c4` |
| Téléchargement | artefact `SudoStudio-Installer` id `15153189467` du run ci-dessus (authentification requise) |
| SHA de main, 1ʳᵉ ligne du journal de démarrage | `startup.log` : `SUDO STUDIO v5.0.0` puis `Build commit: 57ba937d09bbd8e2970d1f49c7894617b2b596a2` ; backend : `build: commit=57ba937… version=5.0.0` |
| Manifeste | `commit=57ba937…, components=5, brand=P20-OK` |
| Fumée | installée dans `C:\Program Files\Sudo Studio`, `spawn: backend=up runtime=up` |

## 7. Non prouvé ici, et commande sur ton PC

- Le paquet est prouvé **sur le Windows des runners GitHub** (Windows Server 2025), pas sur ton i5‑6200U / 8 Go. Le comportement à 4× moins vite n'est pas mesuré ici : c'est une **hypothèse** cohérente avec `H3bis`.
- Pour le vérifier chez toi, après installation :

```powershell
# 1. Journal de démarrage (doit afficher v5.0.0 + Build commit 57ba937…)
notepad "$env:LOCALAPPDATA\SudoStudio\logs\startup.log"

# 2. Diagnostic complet rejoué sur TA machine
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramFiles\Sudo Studio\scripts\collect-and-verify-p71.ps1"
# -> zip des journaux (analysis, analysis.jsonl, engine-child, runtime_crash,
#    autofix, sdk) sur le Bureau + rejoue (a)(d)(e) + PASS/FAIL avec la ligne prouvante
```

## 8. Tableau d'état final

| Niveau | Éléments |
|---|---|
| **PROUVÉ** (local, Linux) | `test-p71-doctor` 21/21 · `test-doctor` 12/12 · `test-p71-recommendations` 10/10 · `test-p71-analysis-ai-autofix` 25/25 · P70 17/33/40/15 |
| **PROUVÉ EN CI** | suite `00` 14/14 · mesures vrai modèle 2048/4096/8192 · `C5b`/`C5c` sur Windows réel · builds `01`/`02` |
| **PROUVÉ (produit installé)** | `SMOKE 21/21` · `AGENT-E2E 18/18` · matrice `PASS=27 FAIL=0` · `doctor 6/6` · installeur + SHA256 |
| **PARTIEL** | part « lecture du prompt » non isolée (le serveur du paquet n'expose pas `prompt_ms`) ; vitesse sur matériel utilisateur non mesurée |
| **NON PROUVÉ ICI** | comportement sur i5‑6200U / 8 Go ; `W1` reproduit sur ta machine (commande §7) |
| **NON FAIT** | LINUX (reporté, comme demandé) |

---

**Rappel sécurité :** le PAT utilisé pour pousser doit être **révoqué** (GitHub → Settings → Developer settings → Personal access tokens → Revoke). Il n'a jamais été écrit dans un dépôt ni affiché dans un fichier.
