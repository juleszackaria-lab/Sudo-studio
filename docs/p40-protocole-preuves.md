# P40 - Protocole de preuves PC (Windows reel)

But : fournir les 5 preuves exigees par la mission P40 pour passer le
verdict de PARTIEL a SUCCESS. Tout est inoffensif et read-only, sauf la
preuve 4 qui declenche UNE elevation UAC avec une commande inoffensive
(ecriture d'une ligne dans un fichier journal temporaire).

Duree estimee : 10 minutes. Coller chaque resultat dans le chat.

---

## Preuve 1 - ExecutionPolicy (P40-b)

Commande (PowerShell NON admin) :

```
powershell -NoProfile -Command "Get-ExecutionPolicy -List | ForEach-Object { $_.Scope + '=' + $_.ExecutionPolicy }"
```

A coller : la sortie complete (toutes les lignes Scope=Politique).

## Preuve 2 - winget --version (P40-b)

Commande (PowerShell NON admin) :

```
winget --version
```

A coller : la sortie complete, ou le message d'erreur exact si absent.

## Preuve 3 - Journal complet d'execution (P40-a/f)

1. Ouvrir le panneau Doctor de Sudo Studio.
2. Lancer "Tout corriger" (ou la correction d'un outil manque, ex Python).
3. Accepter l'elevation UAC si demandee.
4. Ouvrir le dossier `%LOCALAPPDATA%\SudoStudio\logs` et prendre le fichier
   `.log` le plus recent.
5. Verifier qu'il contient une ligne `AUTOFIX_LOGDIR` (dossier du journal
   cree AVANT l'elevation).

A coller : le contenu COMPLET du fichier .log le plus recent.

## Preuve 4 - Chaine d'elevation, commande inoffensive (P40-a)

Ces 3 commandes reproduisent EXACTEMENT le lanceur P40 (meme encodage
utf16le + base64, meme Start-Process RunAs) avec une charge inoffensive
qui ecrit une seule ligne dans un journal temporaire. Lancer dans un
PowerShell NON admin :

```
$log = "$env:TEMP\p40-inoffensif.log"
"ATTENTE" | Out-File $log
$batch = "`"INOFFENSIF OK`" | Out-File '$log'"
$b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($batch))
```

Puis (UNE invites UAC apparait, cliquer Oui) :

```
Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $b64"
```

Puis verifier :

```
Get-Content $log
```

A coller : le resultat de `Get-Content` (attendu : `INOFFENSIF OK`) +
preciser si l'invite UAC est apparue (oui/non).

## Preuve 5 - Extrait audit AUTOFIX_* (P40-f)

Dans le meme fichier .log que la preuve 3, extraire les lignes commencant
par `AUTOFIX_` (notamment AUTOFIX_PRECHECK avec `politique=[...]`, et
AUTOFIX_STEP ou AUTOFIX_NOSTART le cas echeant).

Commande (dans le dossier des logs) :

```
Select-String "AUTOFIX_" <nom-du-fichier.log>
```

A coller : la sortie complete.

---

## Cas particulier - UAC acceptee mais journal vide

Si la preuve 3 donne un journal SANS ligne START (le symptome P40), ne
pas relancer : coller quand meme le journal + les preuves 1, 2 et 5. Le
moteur P40 aura ajoute un bloc `[diagnostic : ...]` (politique, winget,
Defender) dans la raison de l'echec : coller aussi ce message d'echec
tel qu'affiche dans le panneau.
