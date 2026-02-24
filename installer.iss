[Setup]
AppName=Sudo Studio
AppVersion=1.0
DefaultDirName={pf}\SudoStudio
DefaultGroupName=SudoStudio
OutputBaseFilename=SudoStudio-Setup
Compression=lzma
SolidCompression=yes

[Files]
Source: "vscodium\*"; DestDir: "{app}"; Flags: recursesubdirs
Source: "SudoStudio.cmd"; DestDir: "{app}"

[Icons]
Name: "{group}\SudoStudio"; Filename: "{app}\SudoStudio.cmd"
Name: "{commondesktop}\SudoStudio"; Filename: "{app}\SudoStudio.cmd"