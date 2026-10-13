# P13 Agent UI - notes de design

Refonte visuelle de la page Agent et du chat (P4/P5). Moteur, permissions
et providers intouches : seuls la webview (`getWebviewHtml`), son hote
(payloads `done`/`update`), les jetons CSS et les assets statiques changent.

## 1. Jetons (`media/agent-ui-tokens.css`)

Cinq couleurs + surfaces heritees du theme VSCode :

| Jeton        | Sombre    | Clair     | Role unique                    |
|--------------|-----------|-----------|--------------------------------|
| `--sudo-ok`  | `#3FB950` | `#1A7F37` | succes, noeud termine          |
| `--sudo-err` | `#F85149` | `#D1242F` | erreur, noeud echoue           |
| `--sudo-warn`| `#D29922` | `#8F6318` | approbation, annulation        |
| `--sudo-run` | `#39C5CF` | `#0E6E75` | action en cours, accent sombre |
| `--sudo-acc` | `#58A6FF` | `#0969DA` | liens, focus, accent clair     |

Surfaces : `editor.background`, `editorWidget.background` (panneaux),
`editorWidget.border` (filets). Contraste texte >= 4.5 verifie par calcul
dans la suite P13. Le clair force `#FFFFFF` (fond natif VSCode Light+).

## 2. Typographie (100 % hors ligne)

IBM Plex Sans (400/500/600) + Plex Mono (400/500), subset latin woff2
vendore dans `media/fonts/` (~90 Ko), licence OFL jointe (`OFL.txt`).
`font-display: swap`. Repli `sans-serif`/`monospace` si police absente.

## 3. Code : highlight.js vendore

`media/vendor/highlight.min.js` 11.10.0 (build navigateur UMD, 37 langages
dont Dart) + `LICENSE` (BSD-3). Re-coloration legere via CSS pour rester
dans la palette (mots-cles -> accent, chaines -> vert, commentaires ->
gris >= 4.5). Pas de CDN, pas de `style-src` distant.

## 4. Structure

- Colonne unique 820 px centree, une seule colonne quel que soit l'etat.
- Rail d'activite : trait vertical + un noeud par etape/outil.
  Forme ET couleur portent le statut (pastille verte = termine, anneau
  cyan = en cours, carre ambre = annule, croix rouge = echoue).
- Banniere sandbox persistante (P8) + pastille "Mode restreint".
- Approbation : carte ambree, titre exact impose par le protocole P4,
  4 choix, "Autoriser pour toute la session" en primaire.
- Modifications : `<details>` replie par defaut avec `+n/-n` par fichier
  (comptes fournis par l'hote depuis le DiffStore, panneau seul).
- Etats : vide illustre (SVG inline), chargement (squelette pulse lent),
  erreur (cause + Recommencer, lapin P4 conserve quand fourni).
- Mouvement : 120-180 ms, une seule surface animee a la fois ; le pulse
  du curseur respecte `prefers-reduced-motion`.
- Rayons : 6 px (boutons, puces) et 10 px (cartes, panneau).

## 5. ETAPE 3 - autocritique appliquee

1. Rail 6 px decale a gauche des noeuds (oubli du padding) -> corrige
   a 30 px, verifie par capture zoomee x3.
2. Icones fichier repetees sur chaque ligne de Modifications (decoratif
   pur, toutes identiques) -> supprimees, lignes texte seul.
3. Prefixes `[phase]` sur les lignes d'etape (residu moteur, bruit de
   lecture) -> supprimes, message seul (repli sur phase si vide).
   La distinction annulation est preservee par le noeud ambre.

## 6. Preuves (hors depot, `/home/user/preuves-p13/`)

- 24 captures : sombre+clair x 320/600/1100 x vide/en cours/approbation/
  erreur, + 2 Modifications (sombre+clair 1100).
- `perf.json` : 500 messages rendus en ~31-45 ms, reflow ~0 ms,
  defilement ~0 ms (content-visibility), 6 executions.
- `netproof.txt` : 9 requetes au chargement, 0 externe (tout `file://`).
- `regressions.log` : suites P1-P11 vertes apres changement.

## 7. Maintenance

- Ne jamais reintroduire de CDN : la CSP webview bloque tout tiers
  (`default-src 'none'`, source locale seule + `data:` images) et la
  suite P13 echoue sur tout `http(` dans le code.
- Les chaines du protocole P4 (titres, boutons, libelles) sont figees :
  tout renommage casse `test-p4-agent-ui.js` et `test-p13-agent-ui.js`.
- Seule assertion visuelle ajustee : colonne 880 -> 820 px.
