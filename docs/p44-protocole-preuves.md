# P44 - Protocole de preuves (PAQUET INSTALLE, PC owner)

Corrige : AUTOFIX_STEP "code=aucun / script non execute" malgre UAC
accordee. Cause : le -ArgumentList RunAs etait UNE seule chaine (un seul
argv, rejete par powershell.exe : enfant mort-ne, journal vide). P44
envoie un TABLEAU de 5 arguments, attend le journal jusqu'a 5 s, nomme
la commande jamais demarree, et rend le 9009 explicite.

Pre-requis : paquet installe depuis la CI (commit note ci-dessous),
Windows 10/11. Les commandes node ci-dessous se lancent depuis un
checkout du meme commit (ou tout dossier avec scripts\).

Commit attendu : (noter le SHA installe) _______________

Moteur teste : en priorite le fichier INSTALLE :
  --engine "C:\Program Files\Sudo Studio\extensions\sudo-ai\src\doctor\autoFix.js"
(adapter le chemin d'installation). Sans --engine, le moteur du checkout
est utilise (meme commit => meme fichier).

## A. Chaine directe, commande inoffensive (sans UAC)

A1. `node scripts\verify\test-elevated-chain.js --direct`
    Attendu : CHAIN: PASS, DONE S0 code=0, sortie whoami dans le journal.
    Coller : le bloc Get-ExecutionPolicy -List, le bloc winget --version,
    le journal COMPLET, la ligne CHAIN: PASS.

## B. Chaine elevee, commande inoffensive (UNE invite UAC)

B1. `node scripts\verify\test-elevated-chain.js --elevated`
    Cliquer Oui a l'invite UAC.
    Attendu : CHAIN: PASS (c'est LA preuve que l'etape elevee demarre
    vraiment). Coller le journal COMPLET + CHAIN: PASS.
B2. (contre-preuve, optionnel) Relancer --elevated en cliquant Non :
    Attendu : echec HONNETE (journal vide signale, code lancement != 0),
    pas de "script non execute" mensonger. Coller le verdict.

## C. Cas reel (panneau Doctor)

C1. Doctor -> diagnostiquer, puis AutoFix sur un outil manquant
    (ex : Docker si absent, sinon Python).
    Attendu : AUTOFIX_STEP avec un code NUMERIQUE (0, 3010, ...), plus
    jamais "code=aucun (script non execute)" apres UAC accordee.
    Coller les lignes AUTOFIX_PLAN / AUTOFIX_ELEVATION / AUTOFIX_STEP /
    AUTOFIX_DONE du journal d'audit.
C2. Si Docker : la ligne AUTOFIX_PREREQ annonce virtualisation + WSL2 +
    "redemarrage requis". Coller la ligne.

## D. winget absent (PC concerne uniquement)

D1. Sur Windows 10 sans App Installer : AutoFix en ligne.
    Attendu : message precis "winget absent : importez '<nom exact>' ...
    dans : <dossier>" (jamais de tentative winget vouee a l'echec).
    Coller la ligne.

## E. Portes locales (rappel, deja vertes ici)

- `node backend/tests/test-p44-autofix.js` : 28/28 (dont B4 : defaut 5 s).
- `node backend/tests/test-p40-elevated.js` : 28/28.
- `node backend/tests/test-p19-autofix.js` : 22/22.
- `node backend/tests/test-p7-autofix.js` : 43 checks, 1 FAIL pre-existant
  (E3 : selecteurs UI du panneau, deja en echec sur HEAD sans P44).
- `node scripts/verify/test-autofix.js` : PASS (stub + dry-run + statique).
- `node scripts/verify/test-elevated-chain.js` : SKIP (non-Windows).

Verdict : SUCCESS si A1 + B1 colles et PASS (+ C1 si outil testable),
sinon PARTIEL avec la liste des points manquants.
