# P50 FULL - Tableau capacite | statut | preuve (item 7)

Vote : FULL, 7 items + trousseau Credential Manager (zero dep).
Branche : `p50-agent-caps`. Suite : `backend/tests/test-p50-agent-caps.js`.
Releve du 28/10/2026 : **47/47, stable sur 4 passages**.
Voisins : p26 28/28, p49 25/25, p25 50/50.

| # | Capacite | Statut | Preuve |
|---|----------|--------|--------|
| 1 | Serveurs MCP + trousseau OS (credman, zero dep) | VERT | Groupes A+B : 16/16 ; doc `docs/p50-mcp.md` |
| 2 | Skills (import avec apercu, activation, injection tour) | VERT | Groupe C : 6/6 (cumul 22/22) |
| 3 | Executions longues (live, stop, delai, boucle fix bornee) | VERT | Groupe D : 6/6 (cumul 28/28) ; D6 stabilise sans re-appels |
| 4 | Generation projet (plan->fichiers->deps->build->tests, points retour) | VERT | Groupe E : 7/7 (cumul 35/35) ; `TERMINE` seulement si build+tests a code 0 |
| 5 | 6 outils metier (analyse, audit secu, ignore, CI, doctor, SDK) | VERT | Groupe F : 7/7 (cumul 42/42) ; FULL=27 ; secaudit expurge les secrets (assert) |
| 6 | Sous-agents (sequentiel + parallele, bornes, lecture seule -> plan) | VERT | Groupe G : 5/5 (cumul 47/47) ; FULL=28 ; profondeur max 1, fan-out max 3, 3 spawns/tour, enfants max 6 tours |
| 7 | Ce tableau | VERT | Fichier present, comptes verifies contre la suite |

Notes :

- Contrainte contexte : profil full `est0 ~= 1700` exige `n_ctx >= 2300`.
- Gardes produit : `callKey` discrimine les taches `subagent` (les
  repetitions vraiment identiques declenchent toujours l'arret boucle).
- `sdk status` demande approbation (defaut sur, winget argv-splite).
- Resumes enfants = argument `done`/`reply`, repli texte assistant.
- Aucun nom concurrent hors `THIRD_PARTY_NOTICES`.
- Preuves paquet installe (PC proprietaire) requises par point pour le
  verdict final, sinon PARTIEL (protocole P50 a suivre).
