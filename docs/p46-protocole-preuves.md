P46 - PROTOCOLE DE PREUVES (porte de livraison, produit installe)
===============================================================
Regle mission : preuves collees (sorties CI Windows) ou PARTIEL.

RAPPEL : ce qui est livre ici (repo Sudo-studio) :
- scripts/verify/verify-installed.ps1 (v2 : lignes P46-1..9, -Full,
  P36-matrix compatible en run par defaut < 120 s, sans reseau).
- scripts/verify/p46-gate.ps1 (orchestrateur CI : install -> -Full ->
  pristine -> uninstall, exit 1 = publication bloquee).
- scripts/ci/build-manifest.ps1 (+ runtime.touch pour fraicheur offline).
- backend/tests/test-p46-gate.js (27 checks statiques, verts en local).
Le cablage packager 03 (porte AVANT upload) est au paragraphe 4 :
il exige vote diff+OK + ordre push + token (fichier sensible, autre repo).

PREUVE A - sortie verte complete (CI Windows)
---------------------------------------------
1. Merger le cablage paragraphe 4 sur main du packager.
2. Declencher 03-package (push ou workflow_dispatch sur main), attendre vert.
3. Coller : job build, step "P46 delivery gate" :
   - "GATE RESULT: SUCCESS (N checks, M skipped)"
   - les lignes [GATE-EVIDENCE] (gate-result.json + lignes verify).
4. Coller : liste des artefacts du run (SudoStudio-Installer +
   SudoStudio-Portable presents, PAS d'artefact "diagnostic").

PREUVE B - un echec volontaire bloque la publication (CI Windows)
------------------------------------------------------------------
But : run rouge A LA PORTE, installateur ABSENT, diagnostic present.
Main n'est jamais touchee (branches temporaires puis supprimees).
1. Branche sab-p46 dans Sudo-studio : une seule ligne changee dans
   sudo-ai-extension/package.json : "id": "sudo-studio" ->
   "id": "sudo-studio-SABOTAGE" (conteneur robot). Push.
2. Branche sab-p46 dans sudo-studio-packager : dans 03-package.yml,
   step "Checkout sudo-ai-extension from Sudo-studio", ajouter
   "ref: sab-p46" (le gate reste inchange). Push.
3. Dispatch API du workflow 03 sur ref sab-p46 :
   POST /repos/Juleszackaria-lab/sudo-studio-packager/actions/workflows/03-package.yml/dispatches
   {"ref":"sab-p46"}.
4. Attendre rouge. Coller : step gate avec "GATE RESULT: FAIL" et
   "PUBLISH BLOCKED", ligne P46-5 branding FAIL (container !=
   [sudo-studio]) ; liste des artefacts : PAS de SudoStudio-Installer,
   artefact "diagnostic" present ; contenu gate-out/gate-result.json
   (result FAIL). Jobs smoke/screenshot/panel : skipped (needs build).
5. Supprimer les 2 branches (API delete ref). Ordre requis pour chaque push.

PREUVE C - contenu de verify-result.json
----------------------------------------
Coller le bloc [GATE-EVIDENCE] du run vert (preuve A) : 9-10 lignes
P46-1..9 avec verdicts (FAIL=0), files[]/probes[] (compat P36),
champ verdict=PASS, full=true. Verifier visuellement : aucun secret
(L9 scanne ghp_/gho_/bearer/cles privees et REFUSE d'ecrire sinon).

PARAGRAPHE 4 - cablage packager 03 (patch exact, vote requis)
--------------------------------------------------------------
Inserer dans sudo-studio-packager/.github/workflows/03-package.yml,
job build, APRES le step "Verify installer binary", AVANT le step
"Upload installer artifact" :

      # -- 19b. P46 delivery gate (BLOCKS publish on any failure) ------
      - name: P46 delivery gate (install + test installed product)
        shell: powershell
        run: |
          powershell -NoProfile -ExecutionPolicy Bypass -File "_sudo-studio-source\\scripts\\verify\\p46-gate.ps1" -InstallerPath "Output\\SudoStudio-Setup.exe" -SourceDir "_sudo-studio-source" -OutDir "gate-out"
          if ($LASTEXITCODE -ne 0) { Write-Error 'P46 gate FAILED - publish blocked'; exit 1 }
      - name: Upload gate diagnostics (publish blocked)
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: diagnostic
          path: gate-out/
          retention-days: 30
          if-no-files-found: warn

Semantique : les uploads installateur/portable (sans "if:", donc
success() uniquement) sont sautes si la porte echoue ; seul
"diagnostic" est publie. Note : "if: failure()" couvre aussi un
build casse, mais gate-out n'existe pas alors (warn, rien d'uploade).

USAGE PC PROPRIETAIRE (P46-9)
------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\...\SudoStudio\verify-installed.ps1"
-> verify-result.json dans le dossier courant (run par defaut : rapide,
sans reseau, ne desinstalle JAMAIS, ne lance pas l'editeur).
Ajouter -Full pour les lignes lourdes (editeur 30 s, 15 panneaux si
node + script CI presents, telechargement modele ~1 Go pour n_ctx).

VERDICT
-------
SUCCESS ssi preuves A + B + C collees et conformes. Sinon PARTIEL.

NOTE CYCLE2 (28/10/2026, execute) - preuve B par injection 17b
---------------------------------------------------------------
Le vecteur conteneur du protocole ci-dessus est inexcutable tel quel :
le sabotage par ref checkout meurt AVANT la porte (P32-P1 refuse le
conteneur casse ; le manifeste §2 refuse pins != checkout). Constate
sur runs 40798754513 (P32-P1) et 40799881778 (manifeste §2).
Variante executee (gate 19b inchange, main intouche) : branche
packager temporaire sab-p46c avec une seule etape ajoutee AVANT la
construction Inno (apres toutes les validations), qui vide le HTML
de DoctorPanel (node --check OK). Run 40800973710 : GATE RESULT
FAIL (1 failed) isole sur P46-4 (doctor : wrapper-only, no guard
markup), autres lignes PASS, artefact "diagnostic" seul, Installer
et Portable absents, jobs aval skipped. Intentions de la preuve B
satisfaites (echec volontaire -> rouge A LA PORTE -> publication
bloquee). Branches temporaires supprimees apres.
Preuve A : run 40794788139, GATE RESULT SUCCESS (22 checks,
3 skipped), 16/16 panneaux, Installer + Portable presents, pas de
diagnostic. Preuve C : les 9 lignes P46-1..9 du run vert (8 PASS +
P46-8 SKIP by-design, resultat ecrit sans secret).
