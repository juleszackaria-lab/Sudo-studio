# P68 — Grammaire d'appels d'outils, fenêtre de contexte, interface

Ce document fixe ce qui a été **mesuré**, avec le numéro de run, et ce que le
produit en fait. Rien ici n'est une estimation : chaque chiffre renvoie à un
artefact de CI ou à un fichier de test exécutable.

---

## 1. La grammaire des appels d'outils (partie A)

`backend/runtime/grammar.py` construit la grammaire GBNF passée à llama.cpp
pour contraindre la sortie du modèle à un objet `{"name": ..., "arguments": ...}`.

### Le défaut

```gbnf
name ::= "read" | "write" | "edit" | "list" | "done"
```

En GBNF, un littéral `"read"` désigne la **suite de caractères** `read`, **sans
guillemets**. La grammaire autorisait donc un nom d'outil non quoté — donc du
JSON invalide — *par construction*. Deux défauts voisins :

* `ws ::= [ \t\n]*` laissait passer tabulations et espaces multiples ;
* `chars ::= [^"\\]*` interdisait `\n`, `\"`, `\\` : un chemin Windows
  (`C:\Users\...`) était **impossible** dans un argument.

### Le correctif

```gbnf
name  ::= "\"read\"" | "\"write\"" | "\"edit\"" | "\"list\"" | "\"done\""
ws    ::= " "?
chars ::= ( [^"\\] | escape )*
escape::= "\\" ( "\"" | "\\" | "/" | "b" | "f" | "n" | "r" | "t" | "u" hex hex hex hex )
hex   ::= [0-9a-fA-F]
```

12 règles, 614 caractères, `lint_gbnf` propre.

### La preuve (vrai modèle, aucun faux fournisseur)

`scripts/ci/p68-grammar-witness.py` pose **50 consignes françaises** (10 par
outil) au modèle du produit, avec la note système et la grammaire du runtime,
puis analyse la sortie en **JSON strict** (`json.loads` + schéma, aucune
réparation).

Run **44937261358**, job `P68 - grammaire` :

| grammaire | sorties JSON strictement valides |
|---|---|
| corrigée (dépôt) | **50 / 50 (100 %)** |
| d'avant (reconstruite à l'identique) | **0 / 50 (0 %)** |

Le contrôle négatif n'est pas un commentaire : c'est la même mesure, au même
moment, sur la version cassée. Le job échoue si l'ancienne grammaire redevient
verte (un témoin qui ne peut pas échouer ne prouve rien).

### Le filet de sécurité côté moteur

`backend/runtime/toolcall_repair.py` répare un nom d'outil **non quoté** produit
par un modèle qui n'aurait pas suivi la grammaire (`nom-outil-non-quote:<nom>`
dans le journal). Un outil inconnu reste refusé : la réparation ne crée jamais
d'outil.

---

## 2. La fenêtre de contexte réelle (partie B)

Question posée : **la fenêtre annoncée est-elle la fenêtre tenue ?**

`scripts/ci/p68-context-bench.py` remplit le prompt de texte neutre, cache le
mot témoin `ZORBULAX` **au tout début**, demande de le recopier et recherche
par dichotomie le plus grand prompt encore lu. Un prompt n'est compté
« lisible » que si le mot témoin revient **et** que `prompt + réponse` tient
dans `n_ctx`.

Mesure du **2026-11-21**, run **44957368559**, job `P68 - fenêtre de contexte`,
modèle Qwen2.5-Coder-1.5B-Instruct Q4_K_M, llama-cpp-python 0.3.9 CPU,
ubuntu-22.04 (4 vCPU) :

| `n_ctx` nominal | fenêtre réellement lisible | ratio | RSS après chargement |
|---|---|---|---|
| 2048 | 1949 jetons | **95,2 %** | 1835 Mo |
| 4096 | 3995 jetons | **97,5 %** | 1898 Mo |
| 8192 | 8090 jetons | **98,8 %** | 2054 Mo |

**Conclusion, contre l'idée reçue** : sur ce modèle la fenêtre annoncée est
tenue à plus de 95 %. Le « 70 % de contexte réel » ne se vérifie pas ici. Le
produit garde donc le chiffre **mesuré**, palier par palier
(`REAL_WINDOW_RATIOS` dans `backend/runtime/openai_compat.py`), et le plus petit
(95 %) comme défaut prudent pour un `n_ctx` non mesuré.

Conséquence sur le budget d'un appel — `context_budget_tokens` ne prend plus
60 % du **nominal** mais **70 % de la fenêtre réelle mesurée** :

| `n_ctx` | fenêtre réelle | budget par appel |
|---|---|---|
| 2048 | 1945 | 1361 |
| 4096 | 3973 | 2781 |
| 8192 | 8028 | 5619 |

### Ce que l'interface en dit

* le runtime expose `n_ctx`, `n_ctx_nominal`, `n_ctx_reduction`,
  `real_window_ratio`, `real_window_tokens`, `call_budget_tokens` dans
  `/health` et `/models` ;
* le panneau **Runtime** affiche un bandeau « Contexte réduit : 4096 → 2048
  jetons (profil RAM faible) » dès que la politique RAM a rogné le contexte, et
  le masque quand il n'y a rien à dire ;
* le panneau **Doctor** ajoute deux lignes : « Contexte (jetons) » (effectifs
  vs demandés) et « Fenêtre réelle mesurée » (jetons lisibles, ratio, budget).

---

## 3. L'estimateur de jetons

Le produit estimait `ceil((chars + 32) / 4) + 64` par message. Sur 20 prompts
réels (prose, code JS/Python/TS, JSON, arborescences, journaux, chemins
Windows/Unix, diffs, accents), le vrai tokeniseur donne **2,7 à 3,9 caractères
par jeton** selon la famille : une division par 4 se trompe de 40 % en moyenne
et de plus de 100 % sur certaines entrées.

Le banc compare, sur les **mêmes** mesures réelles :

1. douze formules à diviseur unique (dont celle du produit) ;
2. un modèle linéaire `jetons = a*chars + b*mots + c*lignes + d*ratio_na + e`,
   évalué en **validation croisée « laisser-un-dehors »** (la note
   d'apprentissage ne prouve rien).

Les coefficients retenus et l'erreur mesurée sont écrits dans
`sudo-agent/src/profiles.js` (`estimateTokens`) et repris dans le rapport P68.

---

## 4. Format de secours et réessais (partie C)

* **`FICHIER: chemin`** — quand le fournisseur ne produit plus d'appel d'outil,
  l'agent demande le travail en texte libre, analyse les blocs et les écrit
  **par le chemin normal** (outil `write` : approbation, journal, vérification).
  Les chemins absolus, `..` et les contenus de plus de 512 Ko sont **refusés**
  et journalisés. `AUCUN FICHIER` n'écrit rien et ne prétend rien.
* **2 réessais** — un appel d'outil invalide est retenté au maximum **deux
  fois** (trois tentatives), avec entre deux essais une consigne explicite et
  un exemple valide ; ensuite le moteur passe au format de secours au lieu de
  tourner à vide.

Preuves : `backend/tests/test-p68-fallback.js` (7 vérifications, fournisseur
factice scripté, projet temporaire).

---

## 5. Où sont les tests

| fichier | ce qu'il prouve |
|---|---|
| `scripts/ci/p68-grammar-witness.py` | 50 consignes, JSON strict, grammaire corrigée vs ancienne |
| `scripts/ci/p68-context-bench.py` | fenêtre réelle, RSS, erreur de l'estimateur, formules candidates |
| `backend/tests/test-p68-context.js` | reduction exposée (`/health`, `/models`) et affichée (bandeau, Doctor) |
| `backend/tests/test-p68-fallback.js` | `FICHIER:` écrit de vrais fichiers ; réessais bornés |
| `backend/tests/test-p62-ram-runtime.js` | politique RAM + budget = 70 % de la fenêtre réelle |

Les jobs CI correspondants vivent dans `.github/workflows/00-test-suite.yml`
(`p68-grammar`, `p68-context`).
