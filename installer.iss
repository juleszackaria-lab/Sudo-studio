[Setup]
AppName=Sudo Studio
AppVersion=1.0
DefaultDirName={pf}\SudoStudio
DefaultGroupName=SudoStudio
OutputBaseFilename=SudoStudio-Setup
Compression=lzma
SolidCompression=yes

[Files]
; Copie tout le contenu du dossier build vers le dossier d'installation
Source: "build\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
; IMPORTANT : start.bat est directement dans {app}
Name: "{group}\SudoStudio"; Filename: "{app}\start.bat"
Name: "{commondesktop}\SudoStudio"; Filename: "{app}\start.bat"

[Run]
; Lance l'application après installation (optionnel mais recommandé)
Filename: "{app}\start.bat"; Description: "Lancer Sudo Studio"; Flags: nowait postinstall skipifsilent