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
; CRITICAL: WorkingDir must be {app} so %~dp0 resolves correctly in start.bat
; Without WorkingDir, Windows may launch from C:\Windows\System32 or user folder
Name: "{group}\SudoStudio"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; Comment: "Launch Sudo Studio"
Name: "{commondesktop}\SudoStudio"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; Comment: "Launch Sudo Studio"

[Run]
; WorkingDir ensures start.bat runs from correct directory after installation
Filename: "{app}\start.bat"; WorkingDir: "{app}"; Description: "Lancer Sudo Studio"; Flags: nowait postinstall skipifsilent
