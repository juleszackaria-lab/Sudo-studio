# Suites de tests — Sudo Studio

Zéro framework : chaque suite est un script Node exécutable
directement, et `run-all.js` les enchaîne (exit 1 si une suite échoue).

## Commandes

```bash
cd backend
npm test              # = node tests/run-all.js (25 suites statiques)
SUDO_LIVE=1 npm test  # + test-ai-flow.js (E2E live, voir ci-dessous)
node tests/test-p16-editions.js   # une seule suite
```

## Inventaire (P28)

| Suite | Vérifie |
|---|---|
| `test-p1`…`test-p11` (sauf P3) | runtime, providers, agent-UI, chat, central, autofix, sandbox, analyse, score, licence |
| `test-p12-ux.js` | panneaux Duplication/Runtime (12 ch.) |
| `test-p13-agent-ui.js` | UI agent : jetons, protocole, contraste (27 ch.) |
| `test-p15`…`test-p27` (pairs présents) | policy, éditions, secrets, autofix, branding, logs, analyse, avis, agent-core/tools/loop, extension |
| `test-extension-complete.js` (racine) | structure extension + panneaux (102 ch.) |
| `test-ai-flow.js` (live, `SUDO_LIVE=1`) | E2E runtime `:6000` + backend `:5000` en route |

État P28 : **25/25 vertes** en sandbox Linux le 17/10/2026.
`test-ai-flow.js` sans serveurs échoue honnêtement (ECONNREFUSED),
jamais en silence.

## Règles d'évolution (missions)

- Un test qui épingle un comportement **volontairement supprimé** par
  une mission est *évolué* (commentaire `// Pnn:`), jamais le produit.
- Un test qui échoue sur un comportement réel est un **bug produit**.
- Nouvelle suite : `test-p<nn>-<sujet>.js`, auto-découverte par
  `run-all.js` (motif `test-p*.js`), exit 0/1 strict.
- Historique : jest/mocha/chai supprimés en P28 (suites non
  maintenables) ; le compositeur actuel les remplace.
