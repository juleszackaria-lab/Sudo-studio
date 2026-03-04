[Setup]
AppName=Sudo Studio
AppVersion=1.0
DefaultDirName={pf}\SudoStudio
DefaultGroupName=SudoStudio
OutputBaseFilename=SudoStudio-Setup
Compression=lzma
SolidCompression=yes

[Files]
Source: "*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; IMPORTANT : start.bat est directement dans {app}
Name: "{group}\SudoStudio"; Filename: "{app}\start.bat"
Name: "{commondesktop}\SudoStudio"; Filename: "{app}\start.bat"

[Run]
; Lance l'application après installation (optionnel mais recommandé)
Filename: "{app}\start.bat"; Description: "Lancer Sudo Studio"; Flags: nowait postinstall skipifsilent
