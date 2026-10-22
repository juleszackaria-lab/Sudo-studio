P42 - PROTOCOLE DE PREUVES (paquet installe, cause racine prouvee)
=================================================================
Regle mission : preuves tirees du PAQUET INSTALLE ; sinon PARTIEL.
Cause prouvee : page extension > Features > Runtime Status affichait
"property icon is mandatory and must be of type string" (erreur) et
"View container 'sudo-studio' does not exist..." (avertissement) :
l'editeur installé rejette l'icone objet -> vues Sudo dans l'Explorateur.

PREREQUIS : build installe CONTENANT le commit P42 (About > Commit),
profil neuf ou "Sudo: Reinitialiser la disposition" (ancien etat).

PREUVE 1 - page de l'extension, 0 message
------------------------------------------
Extensions > "Sudo Studio - Enterprise AI Platform" > Features >
Runtime Status : capture avec 0 erreur et 0 avertissement.
+ bas de la page (README) : ligne "Build: <version> | commit <sha> | <date>".

PREUVE 2 - robot dans la barre d'activite
-----------------------------------------
Capture : icone robot visible, tooltip "Sudo Studio" ; au clic, vue
"Sudo Studio" (Chat, Runtime, System Doctor, SDK Manager, DevOps,
Analyse de projet). Sombre + clair (2 captures).

PREUVE 3 - titre de fenetre "Sudo Studio"
------------------------------------------
Capture : barre de titre "... - Sudo Studio" (template classique,
commandCenter off). + raccourci Bureau et entree menu Start nommes
"Sudo Studio" + dialogue Help > About (nom, version, commit, date).

PREUVE 4 - barre laterale compacte, 3 hauteurs
-----------------------------------------------
Hauteurs 600 / 800 / 1000 px : 1 vue "Sudo Studio" + 5 sections
repliees par defaut (Environment, Security, Duplication, Central,
License), vide sous le contenu < ~8 px. 3 captures (theme au choix).

PREUVE 5 - journaux editeur sans erreur
----------------------------------------
%TEMP%\p46v-*\udata\logs\*\ (run -Full) ou dossier logs du profil :
extraits exthost + renderer Sans "must be of type", "does not exist",
"icon" en contexte erreur. Coller 20 lignes autour de l'activation
(montrant la ligne "Sudo Studio build <v> commit <c> date <d>").

PREUVE 6 - sortie du test 5 (reel, pas du JSON)
------------------------------------------------
Executer sur le PC :
  powershell -NoProfile -ExecutionPolicy Bypass -File "<install>\verify-installed.ps1" -Full
Coller les lignes [VERIFY-*] P46-3 (editor-exthost-logs PASS, 30 s,
user-data-dir temporaire) et le verdict final. FAIL = porte rouge.

PREUVE 7 - numero de build affiche
-----------------------------------
a) page extension (preuve 1, footer README) ; b) About (preuve 3) ;
c) tetes des journaux : backend.log ("build: commit=... date=...
version=..."), runtime.log ("# build: ... commit=... date=...
version=..."), startup.log ("SUDO STUDIO v<version>", "Build commit:").

VERDICT
-------
SUCCESS ssi preuves 1-7 fournies et conformes. Sinon PARTIEL avec
la liste des preuves manquantes. Tout echec avec un build >= P42 =
bug reel (ouvrir mission corrective, ne pas modifier hors scope).
