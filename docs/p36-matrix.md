# P36 - Matrice des prompts 1-35 sur le paquet installe

Source de verite executable : `scripts/verify/matrix.json` (56 lignes).
Runner : `scripts/verify/run-matrix.js` -> `matrix-result.json` (exit 1 si un FAIL).
Regle (e) : le packaging ECHOUE si une ligne evaluee est FAIL.

## Legende des sources

| source | signification | qui fait echouer le packaging |
|---|---|---|
| p36 | execute par run-matrix.js sur le paquet installe | run-matrix exit 1 |
| smoke | relu par run-matrix.js depuis `summary.txt` du smoke 03 | run-matrix exit 1 (+ le step smoke lui-meme) |
| manifest | re-hash complet + execution du ps1 livre, par run-matrix | run-matrix exit 1 |
| panel-job | job 03 panel-render (P35), externe | le job lui-meme |
| e2e-job | step 03 agent-e2e (P31d), externe | le step lui-meme |
| unit | suites d'origine 01/02 | gate 03 pre-existant (01+02 verts, pins==main) |
| doc | SKIP : prompt papier (rapport/plan) | personne (rien a executer) |

## Lignes P36 (prouvees par le runner)

| id | fonction | test |
|---|---|---|
| P36-AUDIT-4TYPES | 4 types de secrets detectes | test-security auditA-4-secret-types |
| P36-AUDIT-REDACT | aucun contenu brut au rapport | auditA-redaction |
| P36-AUDIT-GITIGNORE | .gitignore recommande | auditA-gitignore-recommended |
| P36-AUDIT-VULN | lodash CVE-2020-8203 signalee | auditA-vuln-flagged |
| P36-AUDIT-SCORE | score 0-100 present | auditA-score |
| P36-AUDIT-NODB | base absente/corrompue = non evaluee + fallback | auditB + auditC + auditC2 |
| P36-DOCTOR-TOOLS | Doctor == shell independant (6 outils) | test-doctor tool-* |
| P36-DOCTOR-BACKEND | Doctor voit backend :5000 (`--require-backend` en CI) | backend-consistent |
| P36-AUTOFIX-DRY | dry-run 0 exec, lignes `dry-run`, journal plan | test-autofix dryrun-* |
| P36-AUTOFIX-JOURNAL | journal cmd+codes+sorties, jamais de navigateur | journal-* + never-opens-browser |
| P36-LICENSE-REFUSE | expiree/altere/inventee/dechet refusees | *-refused (4) |
| P36-LICENSE-EDITIONS | gating Team (agent) / Enterprise (security) | team-enterprise-applied |
| P36-AGENT-E2E | stub : ECHEC->approbation->TERMINE | step e2e 03 (existant) |
| P36-MANIFEST | re-hash complet + composants + brand | run-matrix manifest check |
| P36-VERIFY-PS1 | verify-installed.ps1 livre et executable | run-matrix l'execute |

## Lignes P29-P35 (paquet installe)

| id | fonction | test |
|---|---|---|
| P35-NOBLACK / P35-NOCONSOLE / P32-SCREENSHOT | 15 panneaux non-noirs, lancement hidden, captures | panel-render job |
| P35-PERUSER | per-user, zero ecriture install | smoke extension-live-copy + logs-single-dir |
| P35-BRAND / P20-BRAND | marque paquet installe | smoke brand-* (5) |
| P35-ENTRY | entry pyinstaller + firsts | smoke backend-build-line + backend-health |
| P29-INSTALLER | install silencieuse + fichiers + uninstall propre | smoke installer/silent/expected/clean |
| P29C4-MANIFEST | manifeste embarque | smoke build-manifest |
| P30-CRASHLOG | journal plantage (scope p30only, c3/c4 exclus) | smoke logs-single-dir |
| P31-AGENT-SPAWN / P27-NODEDEV | agent depuis sources (pas de binaire) | smoke agent-handshake |
| P31-EDITOR | editeur demarre/ferme proprement | smoke editor-close-cleanup |
| P33-LOGDIR | dossier logs unique | smoke logs-single-dir + runtime-p21-journal |
| P21-JOURNAL | journal tech | smoke runtime-p21-journal |

## Lignes P1-P28 : re-preuves + gate unit

P7, P10, P11, P16, P23, P28 sont re-prouves sur l'installe PAR les tests P36
(voir colonne test de matrix.json) ; leur gate reste le gate 03 (01+02 verts).
P3-a, P5, P6, P8, P25 : lignes dediees (P25 = conception copy-based du test audit).
P1, P2, P4, P9, P12, P13, P17, P18, P22, P24, P26, P34 : `*-ARCHIVE`
(fonction = archive conversation, preuve = suite 01/02 d'origine via le gate 03).

## (f) Non-verifiable-sur-Windows (liste emise par le runner)

1. **Prompts papier** (doc, SKIP) : P14 (rapport <3500 mots), P15 (preuves
   collees), P19 (plan). Rien a executer sur un paquet.
2. **Unites d'origine** (unit, gate 03) : P1, P2, P3-a, P4, P5, P6, P7, P8, P9,
   P10, P11, P12, P13, P16, P17, P18, P22, P23, P24, P26, P28, P34.
   Leurs suites tournent sur Ubuntu (01/02), pas sur le paquet installe ;
   le gate 03 pre-existant (01+02 verts + pins==main) les impose avant packaging.
3. **Partiels assumés** :
   - P36-DOCTOR-BACKEND hors CI : informatif (pas de backend dans la sandbox).
   - P36-VERIFY-PS1 hors Windows : SKIP (besoin de powershell).
   - `_runAudit` avec package.json : `npm audit` borne 15 s (en ligne : resultat
     reel ; hors ligne : `unreliable` honnete, jamais de crash).
   - P30 overlay UI (`sudoBackendUnavailable`) : comportement visuel, couvert par
     le panel-render job, pas par un assert (le Doctor rend des lignes d'erreur,
     pas d'overlay, par conception).
   - Cles signees avec la VRAIE cle produit : impossibles sans la cle privee
     (absente du CI par conception, prouve : aucun secret au depot) ; l'expiry
     et la crypto sont prouvees par round-trip sur paire fraiche via le module
     installe (`publicKeySpkiB64`).

## Notes d'honnetete

- P36(c) tronque : "base corrompue =" (fin de texte manquante). Inference
  documentee : corrompue = meme issue que absente (candidats sautes, marqueur
  `non evaluees`, sans erreur). Testee (auditC) + fallback teste (auditC2).
- Faux positifs evites : URL postgres SANS mot de passe non detectee (voulu) ;
  le pattern exige `:password@`.
- Fuite memoire test : les fixtures (faux secrets) sont supprimees en fin de run.
- `verify-installed.ps1` n'ecrit JAMAIS dans le dossier d'install (P35c).
