# SECURITY_SCORING — Formule du score de sécurité (PROMPT 10)

Implémentation : `sudo-ai-extension/src/utils/securityScore.js` (pur, déterministe,
hors-ligne : aucune donnée ne quitte la machine). Affichage : `SecurityPanel`
(anneau + tableau « Pourquoi ce score »). Historique : l'ancienne formule
retirait un montant fixe dès qu'une entrée `.gitignore` manquait, ce qui figeait
tout projet propre sur une seule valeur ; elle est supprimée.

## Principe

```
score = max(0, 100 − appliqué_secrets − appliqué_dépendances − appliqué_fichiers − appliqué_tests)
```

Chaque catégorie a un **plafond** : les pénalités sont triées (plus graves
d'abord) puis appliquées une par une jusqu'au plafond. Les pénalités dépassant
le plafond restent **listées** avec la mention « plafond » (transparence :
rien n'est caché, le total débité est borné).

## Barème

| Catégorie | Constat | Points | Plafond |
|---|---|---|---|
| Secrets | critique (ex. clé privée PEM) | 15 | 40 |
| Secrets | haute (ex. clé API, token) | 8 | 40 |
| Secrets | moyenne (ex. mot de passe BDD) | 4 | 40 |
| Secrets | basse | 1 | 40 |
| Dépendances | avis critique (base locale) | 10 | 30 |
| Dépendances | avis haute | 5 | 30 |
| Dépendances | avis moyenne **ou gravité inconnue** | 2 | 30 |
| Dépendances | avis basse | 1 | 30 |
| Fichiers | env de prod présent et non ignoré | 10 | 15 |
| Fichiers | dépendances non verrouillées | 5 | 15 |
| Fichiers | pas de `.gitignore` du tout | 5 | 15 |
| Tests | aucun test détecté | 5 | 5 |

Plancher effectif : 10 (100 − 40 − 30 − 15 − 5) ; le `max(0, …)` reste en
garde-fou. Le score est **recalculé à chaque exécution** (ouverture + Refresh).

## Règles de détection (déterministes)

- **Secrets** : 13 motifs partagés + 1 motif local « assignation non quotée »
  (`API_KEY=sk-…`, `auth_token=…`, …). Anti-faux-positifs : valeur ≥ 8
  caractères, valeurs quotées réservées au motif quoté (pas de doublon),
  liste de placeholders exacts (`your_key_here`, `changeme`, `example`, …).
  Fichiers scannés : `.env*`, `.js/.ts/.py/.dart/.go/.java/.cs/.rb/.php`,
  `.json/.yaml/.toml`, scripts, `.pem/.key`, plafond 1 Mo, profondeur 6.
- **Dépendances** : versions verrouillées (`package-lock.json`,
  `requirements.txt` épinglé, `poetry.lock`, `pubspec.lock`) croisées avec la
  base d'avis locale — **jamais** `npm audit` (réseau, non déterministe).
  Citation : fichier + ligne du passage nom/version dans le lockfile.
- **Fichiers** : `.env.production` / `.env.prod` / `.env` présent mais absent
  du `.gitignore` (ligne exacte ou `.env*`) ; verrouillage par écosystème
  (`package.json`→lock npm, `requirements.txt` non 100 % épinglé sans
  `poetry.lock`/`Pipfile.lock`, `pubspec.yaml`→`pubspec.lock`,
  `go.mod`→`go.sum`, `*.csproj`→`packages.lock.json` ; Maven/Gradle : non
  vérifiés, faute de standard de verrouillage).
- **Tests** : dossier `test|tests|__tests__|spec|specs`, ou script `test`
  dans `package.json`, ou fichier `*test*/*spec*` à la racine.

## Sources indisponibles : jamais de chiffre rassurant

- Base d'avis **absente ou inutilisable** → statut `unavailable`,
  `score: null`, affichage « Score non calculable : \<raison\> ».
- Base d'avis **trop ancienne** (> 180 jours, `STALE_DAYS`) → statut
  `partial` : le chiffre est affiché **avec** le bandeau
  « Score partiel : \<raison + date\> ».
- Sans dossier ouvert → `unavailable` (« aucun dossier de projet ouvert »).

## Exports

`Exporter JSON` (rapport complet : `scoreResult`, secrets expurgés, avis,
dates) et `Exporter HTML` (tableau autonome, CSS inline), chacun vérifié
après écriture + entrée `SECURITY_EXPORT_REPORT` dans l'audit log.
