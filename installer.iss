[Setup]
AppName=Sudo Studio
AppVersion=1.0
DefaultDirName={pf}\SudoStudio
DefaultGroupName=SudoStudio
OutputBaseFilename=SudoStudio-Setup
Compression=lzma
SolidCompression=yes

[Files]
Source: "build\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\SudoStudio"; Filename: "{app}\SudoStudio\start.bat"
Name: "{commondesktop}\SudoStudio"; Filename: "{app}\SudoStudio\start.bat"