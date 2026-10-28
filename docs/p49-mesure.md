# P49 - L'agent EXECUTE : protocole de mesure reelle (20 demandes x 3 projets)

Owner protocol for the P49 live proof. Nothing below can be proven from
CI or mocks: it needs the INSTALLED package + the real local runtime +
Qwen 1.5B. The bench drives REAL turns against the installed product on
disposable COPIES (originals are never touched).

## 0. Pre-requis

- Paquet installe (build avec P49), runtime local En ligne (panneau Runtime).
- Modele : Qwen2.5-Coder-1.5B-Instruct (Q4_K_M). Noter le n_ctx effectif
  (panneau Runtime) dans le rapport.
- 3 projets quelconques (ex : un repo node, un script python, un dossier
  statique). Les 20 demandes apportent leurs propres fixtures : tout
  projet convient.
- node disponible dans le PATH (scoring A10, sinon repli sur le flag).

## 1. Commande

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bench-agent.ps1 `
  -Projects C:\dev\projA, C:\dev\projB, C:\dev\projC `
  -Tasks P49 -TrialsPerCell 1
```

- 20 demandes x 3 projets = 60 essais (taux BRUT, 1 essai par case).
- Duree indicative : 30 a 120 s par essai (petit modele local).
- Reprise : le harnais est resumable (state.json) ; relancer la meme
  commande reprend ou elle s'est arretee.
- Sec : `-Tasks P49 -Fast` = 20 essais sur le 1er projet (degrossissage).

## 2. Les 20 demandes (taux brut, regles de score)

| # | Demande | Type | Reussite si (verifie pilote, pas le modele) |
|---|---------|------|----------------------------------------------|
| A1 | Cree P49_NOTE.md exactement `P49-OK` | ACTION | fichier exact |
| A2 | Corrige add dans p49_calc.js | ACTION | `function add(a, b)` present |
| A3 | Supprime p49_trash.txt | ACTION | fichier parti |
| A4 | Renomme p49_old.txt -> p49_new.txt | ACTION | deplace + contenu garde |
| A5 | Ajoute BETA a p49_list.txt | ACTION | alpha + BETA presents |
| A6 | Retire [BLOC-A-SUPPRIMER] de p49_doc.txt | ACTION | bloc parti, haut/bas gardes |
| A7 | Ameliore p49_readme.md (section Usage) | ACTION | `Usage` present |
| A8 | 2 ameliorations collectives sur p49_app.js | ACTION | `use strict` + `module.exports` |
| A9 | Cree p49_sum.js (add exportee) | ACTION | `function add` + `module.exports` |
| A10 | Fais passer p49_check.js | ACTION | `node p49_check.js` exit 0 (sinon flag `ok`) |
| A11 | Deplace sub/p49_a.txt -> p49_b.txt | ACTION | deplace + contenu garde |
| A12 | (EN) Create P49_HELLO.txt exactly `hello` | ACTION | fichier exact |
| A13 | Lance `node -e "console.log('P49-RUN-OK')"` | ACTION run | bash demande avec P49-RUN-OK |
| A14 | Verifie p49_calc.js avec node --check | ACTION run | bash demande avec --check |
| A15 | Liste les .md du projet | ACTION run | reponse cite P49_SEED |
| A16 | Explique P49_SEED.md | QUESTION | TERMINE + >=50 car. + TOURNESOL |
| A17 | A quoi sert p49_calc.js ? | QUESTION | TERMINE + >=50 car. + `add` |
| A18 | Resume le projet en une phrase | QUESTION | TERMINE + 30-500 car. |
| A19 | Bonjour | AMBIGU | reponse non vide (gracieux) |
| A20 | lis P49_SEED.md | AMBIGU | reponse cite TOURNESOL |

Politique d'approbation : sur les copies, write/edit/delete/rename/patch
sont auto-approuves ; bash seulement si prefixe sur (node, npm, pytest...).
Les demandes A1-A12 scorent sur les FICHIERS (insensible au flux
approbation : l'approbation execute entre le tour 1 et le tour 2).

## 3. Rapport attendu (a coller)

- `summary.json` du dossier bench (pass/total par case + taux brut).
- n_ctx effectif + nom exact du modele.
- Les lignes `AUCUNE MODIFICATION` trouvees dans results.jsonl (honnetete
  negative : un echec avoue vaut mieux qu'un TERMINE menteur).
- En cas de case a 0/3 sur A1-A12 : joindre le results.jsonl de la case
  (diagnostic driver : tool_choice, relances, verrous).

## 4. Cible

- Taux brut global : baseline a etablir (1er passage = reference).
- Zero `TERMINE` sans modification sur A1-A12 (annexe `Modifications
  verifiees` ou `AUCUNE MODIFICATION`, jamais un TERMINE nu).
- A16-A18 : 100 % TERMINE (questions pures).

## 5. Automatise (deja prouve en CI)

- `backend/tests/test-p49-agent-acts.js` : 25 tests (classification,
  regime strict, verdict honnete, verrous, delete/rename, repetition).
- `backend/runtime/test_p1_openai_mock.py` : sampling + tool_choice.
- Voisins : p24 (F1 pre-existant), p25 50/50, p26 28/28, p39 7/7,
  p43 20/20, p48 30/30.
