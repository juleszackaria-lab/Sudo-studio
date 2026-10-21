# P39 - Protocole de preuves (Agent et Chat repondent toujours)

Verdict : **PARTIEL** tant que les preuves ci-dessous, mesurees sur le
**paquet installe**, ne sont pas collees. Aucun arrondi, resultats bruts.

## 1. Prerequis

- Paquet installe construit depuis un commit contenant P39 (verifier :
  le journal agent contient `carte projet injectee` apres un tour).
- Modele local charge (relever son nom + `n_ctx` : panneau Runtime & Models,
  ou `GET /v1/models` du runtime).
- Les 3 projets sur le PC : ScannerNum (Flutter), "maquis pos" (Next.js),
  un projet Node.
- Journaux :
  - agent : `%LOCALAPPDATA%\SudoStudio\logs\agent.log`
    (repli Linux/macOS : `~/.sudo_studio/logs/agent.log`)
  - runtime : `%LOCALAPPDATA%\SudoStudio\logs\runtime_debug.log`
    (chercher `[RAM] Before`, `[GGUF] n_ctx=`, `[RAM] After`).

## 2. Lignes journal attendues (copier les extraits)

Apres un tour avec dossier ouvert, `agent.log` doit montrer :

- `carte projet injectee | ... entries=N type=<type> tokens=T`
- pour une question generale : `contexte general precharge | ... tokens=T`
- pour un fichier manquant : `tool fail | ... tool=read target=<chemin>
  code=not_found ... error=introuvable : <chemin> ; fichiers proches : [...]
  ; contenu du dossier parent : [...]`
- `est0` (colonne du `turn start`) contre `ctx` (= n_ctx du modele).

## 3. Cas boucle volontaire (photo + extrait)

1. Ouvrir "maquis pos", chat : `lis readme.md` (minuscules).
   Resultat attendu : reponse QUAND MEME (secours IA ou, a defaut,
   `[reponse generee sans IA]` + explication de la boucle), statut PARTIEL.
2. Forcer 3 appels identiques si besoin en repetant la demande.
3. Copier : la reponse affichee + les lignes `repeat loop`,
   `reponse secours IA` (ou `reponse secours deterministe`).

## 4. Recommandations IA (panneau Analyse)

1. Ouvrir un projet, attendre l'analyse deterministe.
2. Cliquer "Recommandations IA" : soit 5 recommandations, soit une erreur
   CLAIRE (`Aucun modele charge`, `Delai depasse (60s)`, ...). Jamais
   `Analyse IA en cours...` sans fin (capturer avant/apres 65 s si echec).
3. Copier la capture + le texte obtenu.

## 5. Memoire avant/apres (e)

Dans `runtime_debug.log`, relever pour UN chargement de modele :

- `[RAM] Before model load: <X>GB free / <T>GB total`
- `[GGUF] n_ctx=<N> (requested=..., freeRAM=<X>GB)`
- `[RAM] After model load: <Y>GB free | used: <U>GB`

Regle P39-e : 4096 des 4 Go libres (8192 des 12 Go, sinon 2048).
Si le PC a moins de 4 Go libres, noter `n_ctx=2048` + profils `small`
(descriptions d'outils reduites, deja en place).

## 6. Tableau de mesure (g) : 3 projets x 5 taches x 10 essais

Un essai = UNE question, session fraiche (nouveau chat / nouvelle session
agent), reponse jugee en binaire :

| # | Tache (libelle exact) | Chat (Plan) ou Agent (Build) | Succes = 1 si ... |
|---|------------------------|------------------------------|-------------------|
| T1 | `explique ce projet` | Chat | reponse non vide, cite au moins 2 vrais fichiers/dossiers |
| T2 | `trouve ou est defini X` (X = symbole reel du projet, noter lequel) | Chat | chemin + ligne/fonction corrects |
| T3 | `lis <fichier precis existant>` (noter le chemin) | Chat | contenu ou resume fidele du fichier |
| T4 | `ajoute une fonction <nom> qui <spec>` (noter la spec) | Agent | fonction ajoutee, fichiers modifies listes, pas d'erreur outil non resolue |
| T5 | `corrige le test <nom>` (casser le test avant, de facon notee) | Agent | test re-vert (commande de verification OK) |

Protocole par case : 10 essais, noter `1`/`0` par essai, sans arrondir.
X (T2), le fichier (T3), la spec (T4), la cassure (T5) doivent etre notes
AVANT la serie et gardes identiques sur les 10 essais.

Modele : le modele local actuel UNIQUEMENT (pas de second modele ni cle
API disponibles - note honnetement comme limite).

### Gabarit brut a remplir (150 valeurs)

```text
Projet P1 = ScannerNum : T1 [.,.,.,.,.,.,.,.,.,.] somme=../10
Projet P1 = ScannerNum : T2 (X=...) [.,.,.,.,.,.,.,.,.,.] somme=../10
Projet P1 = ScannerNum : T3 (fichier=...) [.,.,.,.,.,.,.,.,.,.] somme=../10
Projet P1 = ScannerNum : T4 (spec=...) [.,.,.,.,.,.,.,.,.,.] somme=../10
Projet P1 = ScannerNum : T5 (cassure=...) [.,.,.,.,.,.,.,.,.,.] somme=../10
Projet P2 = maquis pos : T1 ... (idem)
Projet P2 = maquis pos : T2 (X=...) ...
Projet P2 = maquis pos : T3 (fichier=...) ...
Projet P2 = maquis pos : T4 (spec=...) ...
Projet P2 = maquis pos : T5 (cassure=...) ...
Projet P3 = <nom projet Node> : T1 ... (idem)
... T2/T3/T4/T5 ...
TOTAL = .../150 (brut, sans arrondir)
```

## 7. Captures exigees (liste de controle)

- [ ] chat `explique ce projet` sur "maquis pos" (reponse visible)
- [ ] chat `explique ce projet` sur ScannerNum (reponse visible)
- [ ] agent (Build) repondant sur "maquis pos"
- [ ] agent (Build) repondant sur ScannerNum
- [ ] cas boucle : reponse de secours affichee
- [ ] Recommandations IA : resultat ou erreur claire
- [ ] extraits `agent.log` (S2 + S3)
- [ ] extraits `runtime_debug.log` (S5)
- [ ] tableau S6 complet (150 valeurs brutes)

## 8. Ce qui est deja prouve en local (pas sur paquet)

- `backend/tests/test-p39-always-answer.js` : 7/7 (carte, tolerance,
  enrichissement, preload, rescue, secours deterministe, injection).
- Non-regression : P25 50/50, P26 28/28 (F3/D1 mis a jour : evolution P39
  documentee), `test_p1_openai_mock.py` 25/25 (politique n_ctx P39-e).
- Fichiers : `sudo-agent/src/projectmap.js` (nouveau), `loop.js` (a/c/d),
  `modes.js` + `tools.js` + `boundary.js` (b), `openai_compat.py` +
  `server.enterprise.py` + `test_p1_openai_mock.py` (e),
  `ProjectAnalysisPanel.js` (f).
