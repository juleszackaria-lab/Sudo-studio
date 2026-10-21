P38 - PROTOCOLE DE PREUVES (PC, paquet installe)
================================================
Objectif : prouver sur le PRODUIT INSTALLE (jamais sur le repo seul) :
(a) conteneur activity-bar "robot", (b) nom "Sudo Studio" partout,
(c) barre laterale compacte (1 vue nav + 5 sections repliees).

PREREQUIS
---------
1. Build installe CONTENANT le commit P38 (verifier Help > About >
   Commit, ou la date du build > date du merge P38).
2. Si le PC a deja lance une version anterieure : soit profil neuf
   (--user-data-dir vierge), soit commande "Sudo: Reinitialiser la
   disposition", soit 1er lancement post-MAJ (reveal-once).

PREUVE 1 - package.json EFFECTIF (cause racine)
------------------------------------------------
Fichier : <install>/resources/app/extensions/sudo-ai-extension/package.json
(<install> = dossier d'installation Sudo Studio).
Coller l'extrait : contributes.viewsContainers.activitybar (id, title,
icon "resources/sudo-robot.svg"), contributes.views["sudo-studio"]
(liste des 8 ids), contributes.commands[] entree sudoStudio.resetLayout.
ATTENDU : 8 vues, 0 vue Sudo sous "explorer", resetLayout present.
Si le conteneur manque ici => le build est anterieur a 749cbb6
=> reinstaller un build recent (rien a corriger dans le code).

PREUVE 2 - robot activity-bar (sombre + clair)
----------------------------------------------
Captures : icone robot visible en activity-bar, tooltip "Sudo Studio",
panneau au clic = vue "Sudo Studio" (6 entrees : Chat, Runtime,
System Doctor, SDK Manager, DevOps, Analyse de projet).
1 capture theme sombre + 1 capture theme clair.

PREUVE 3 - barre de titre + fenetre
-----------------------------------
Captures : barre de titre "Sudo Studio", icone taskbar, entree
"About" (Help > About : nom + version + commit).
+ nom du raccourci bureau / entree menu Start "Sudo Studio".

PREUVE 4 - sidebar compacte 3 hauteurs x 2 themes (6 captures)
--------------------------------------------------------------
Hauteurs fenetre : 600, 800, 1000 px (redimensionner, pas de zoom).
Pour chaque hauteur x sombre/clair : sections Environment, Security,
Duplication, Central, License REPLIEES par defaut (1 ligne chacune),
vide sous le contenu <= ~8 px (pas de grande zone vide).

PREUVE 5 - reset disposition (palette)
--------------------------------------
Ctrl+Shift+P > taper "Reinitialiser la disposition" : capture de
l'entree "Sudo: Reinitialiser la disposition", puis execution :
le panneau Sudo reapparait (capture avant/apres si masque avant).

PREUVE 6 - gate branding (local, pas de step CI)
-----------------------------------------------
Step CI refuse par vote le 21/10/2026 : executer en local
"node backend/tests/test-p20-branding.js" et coller la ligne
"P20: 43 checks passed (all green)".

VERDICT
-------
SUCCESS ssi preuves 1-6 fournies et conformes. Sinon PARTIEL avec
la liste des preuves manquantes. Tout echec de preuve 1-5 avec un
build >= P38 = bug reel a corriger (ouvrir P43).
