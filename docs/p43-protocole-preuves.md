# P43 - Protocole de preuves (PAQUET INSTALLE, PC owner)

But : prouver sur le paquet installe (portable ou setup) que :
(1) le runtime applique le n_ctx demande, sinon le defaut ajuste (<=3B :
8192/4096/2048 selon poids + cout KV + marge, /health + page Runtime
affichent l'effectif) ; (2) les QUESTIONS passent en UN appel (pas
d'exploration libre) et les MODIFICATIONS gardent la boucle ; (3) budgets
par partie, lectures tronquees avec "suite : lignes X-Y", compression a
75 %, JAMAIS d'abandon (reponse de secours garantie) ; (4) les
recommandations IA restent un appel borne avec etats d'erreur ;
(5) le bench `scripts/bench-agent.ps1` tourne en auto et reprend.

Pre-requis : paquet installe depuis la CI (commit note ci-dessous), modele
local charge (Qwen2.5-Coder-1.5B recommande), 3 projets owner dont les noms
de dossiers servent de reperes (ex : ScannerNum/flutter, maquis-pos/next,
projet python). Ne toucher qu'aux copies de test du bench, jamais aux
projets reels.

Commit attendu : (noter le SHA installe) _______________

## A. n_ctx effectif (P43-1)

A1. Runtime & Models : charger le modele 1.5B, champ n_ctx VIDE.
    Attendu : la mention "actif : NNNN" affiche 8192 si la RAM libre le
    permet (poids + 8192*28Ko + 1Go marge <= libre), sinon 4096, sinon
    2048. Noter la valeur : _______
A2. `GET http://127.0.0.1:6000/health` : `model.n_ctx` == valeur A1.
    Coller le bloc "model" du JSON.
A3. Journal runtime : lignes `[GGUF] n_ctx=... (requested=None, ...)`,
    `[GGUF] policy: fit: ...` (ou `default_n_ctx ...`, `requested ...`,
    `tight RAM ...` selon le cas) et `[GGUF] kv_check: ...`.
    Coller les 3 lignes.
A4. Taper 4096 dans le champ, recharger (switch) : "actif : 4096",
    `/health` == 4096, journal `(requested=4096`. Coller la preuve.
A5. Bouton redemarrer : l'actif RESTE 4096 (re-transmis, pas de retour
    silencieux au defaut). Coller `/health` apres redemarrage.

## B. Deux chemins (P43-2)

B1. Agent, projet reel : "Explique ce projet en 5 phrases."
    Attendu : UNE reponse en flux, AUCUN appel d'outil (journal : une seule
    ligne "question envoyee" puis "question repondue", pas de "tool ok").
    Coller les lignes du journal agent.
B2. Agent : "Cree un fichier P43_TEMOIN.md contenant P43-OK" (dossier de
    test, pas un projet reel).
    Attendu : boucle agent (lignes "tool ok", "budget parties"), fichier
    cree apres approbation. Coller "budget parties" + preuve fichier.

## C. Budgets + secours (P43-3)

C1. Ligne "budget parties" de B2 : 6 parties + total = somme.
    Coller la ligne.
C2. Lecture tronquee : demander au agent de lire un gros fichier par
    morceaux (ex : "lis les 200 premieres lignes de X"). Attendu : le
    resultat contient "suite : lignes A-B". Coller l'extrait.
C3. Saturation (optionnel, modele 1.5B) : question longue sur gros projet.
    Attendu : une reponse TOUJOURS (eventuellement "[reponse generee
    sans IA]"), JAMAIS "rien a resumer" ni tour vide. Coller le statut.

## D. Recommandations IA (P43-4)

D1. Panneau Analyse : "Recommandations IA" sur un projet.
    Attendu : texte de recommandations (borne), OU un etat d'erreur net
    (modele absent / delai 60s / runtime injoignable), JAMAIS "en cours"
    fige. Coller le resultat ou l'etat.

## E. Bench (P43-5)

E1. Powershell : `powershell -ExecutionPolicy Bypass -File scripts\bench-agent.ps1 -Projects <p1>,<p2>,<p3> -Fast`
    Attendu : 5 essais, recapitulatif, `results.jsonl` + `summary.json`.
    Coller le recapitulatif console.
E2. Relancer la MEME commande : "resumed" couvre les 5 essais (reprise,
    0 nouvel essai). Coller la ligne.
E3. (long, optionnel) sans `-Fast`, 10 essais/case : joindre summary.json.

## F. Portes locales (rappel, deja vertes ici)

- `python3 backend/runtime/test_p1_openai_mock.py` : 34/34 (dont §12b).
- `node backend/tests/test-p43-context.js` : 20/20.
- `node backend/tests/test-p39-always-answer.js` : 7/7.
- `node backend/tests/test-p24-agent-core.js` : 35/35.
- `node backend/tests/test-p25-agent-tools.js` : 50/50.
- `node backend/tests/test-p26-agent-loop.js` : 28/28.
- `node backend/tests/test-p20-brand.js` + `test-p46-gate.js` : verts.

Verdict : SUCCESS si A1-D1 colles et conformes (+ E1-E2), sinon PARTIEL
avec la liste des points manquants.
