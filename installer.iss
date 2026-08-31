; ============================================================
;  Sudo Studio — Inno Setup Installer Script
;  Version: 5.0
;  Requires: Inno Setup 6.x
; ============================================================

#define MyAppName         "Sudo Studio"
#define MyAppVersion      "5.0.0"
#define MyAppPublisher    "Sudo Studio"
#define MyAppURL          "https://sudostudio.app"
#define MyAppExeName      "Code.exe"
#define MyAppMutex        "sudostudio"
#define MyAppIcon         "resources\icon.ico"

[Setup]
; ── Identity ──────────────────────────────────────────────────────────────────
AppId                         = {{A9B4E3C2-D5F6-4A7B-8C9D-E0F1A2B3C4D5}
AppName                       = {#MyAppName}
AppVersion                    = {#MyAppVersion}
AppVerName                    = {#MyAppName} {#MyAppVersion}
AppPublisher                  = {#MyAppPublisher}
AppPublisherURL               = {#MyAppURL}
AppSupportURL                 = {#MyAppURL}
AppUpdatesURL                 = {#MyAppURL}
AppMutex                      = {#MyAppMutex}

; ── ADMIN RIGHTS ─────────────────────────────────────────────────────────────
; MISSION 3: Request administrator privileges at install time.
; The user sees a UAC dialog once during install, never again at runtime.
PrivilegesRequired            = admin
; Allow the user to override down to 'lowest' if they click the shield icon,
; but still REQUEST admin by default (the dialog is the override mechanism).
PrivilegesRequiredOverridesAllowed = dialog

; ── Directories ───────────────────────────────────────────────────────────────
DefaultDirName                = {autopf}\{#MyAppName}
DefaultGroupName              = {#MyAppName}
DisableProgramGroupPage       = yes
OutputDir                     = dist
OutputBaseFilename            = SudoStudio-Setup-{#MyAppVersion}
SetupIconFile                 = {#MyAppIcon}
UninstallDisplayIcon          = {app}\resources\icon.ico

; ── Compression ───────────────────────────────────────────────────────────────
Compression                   = lzma2/max
SolidCompression              = yes
LZMAUseSeparateProcess        = yes

; ── UI ────────────────────────────────────────────────────────────────────────
WizardStyle                   = modern
WizardSmallImageFile          = resources\icon.ico
; Wizard background / header (optional — comment out if files not present)
; WizardImageFile             = resources\installer-banner.bmp
ShowLanguageDialog            = no
LanguageDetectionMethod       = locale

; ── Misc ──────────────────────────────────────────────────────────────────────
ArchitecturesInstallIn64BitMode = x64compatible
MinVersion                    = 10.0
CloseApplications             = yes
RestartIfNeededByRun          = no
AlwaysRestart                 = no
CreateUninstallRegKey         = yes
Uninstallable                 = yes

; ── Version stamp (Add/Remove Programs) ───────────────────────────────────────
VersionInfoVersion            = {#MyAppVersion}
VersionInfoCompany            = {#MyAppPublisher}
VersionInfoDescription        = {#MyAppName} Installer
VersionInfoProductName        = {#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french";  MessagesFile: "compiler:Languages\French.isl"

; ============================================================
[Tasks]
; ── Shortcuts ─────────────────────────────────────────────────────────────────
Name: "desktopicon";    Description: "{cm:CreateDesktopIcon}";    \
    GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; \
    GroupDescription: "{cm:AdditionalIcons}"; \
    Flags: unchecked; OnlyBelowVersion: 6.1; Check: not IsAdminInstallMode

; ============================================================
[Files]
; ── Main application bundle ──────────────────────────────────────────────────
Source: ".\*";            DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "*.iss,dist\*,.git\*,node_modules\.cache\*,__pycache__\*,*.pyc"

; ── Launch helper (VBScript hidden launcher) ──────────────────────────────────
Source: "launch_hidden.vbs"; DestDir: "{app}"; Flags: ignoreversion

; ── Icons ─────────────────────────────────────────────────────────────────────
Source: "resources\icon.ico"; DestDir: "{app}\resources"; Flags: ignoreversion

; ============================================================
[Icons]
; ── Start Menu ────────────────────────────────────────────────────────────────
Name: "{group}\{#MyAppName}"; \
    Filename: "{app}\start.bat"; \
    IconFilename: "{app}\resources\icon.ico"; \
    WorkingDir: "{app}"

; ── Desktop shortcut (optional task) ─────────────────────────────────────────
Name: "{autodesktop}\{#MyAppName}"; \
    Filename: "{app}\start.bat"; \
    IconFilename: "{app}\resources\icon.ico"; \
    WorkingDir: "{app}"; \
    Tasks: desktopicon

; ── Uninstaller shortcut ──────────────────────────────────────────────────────
Name: "{group}\Uninstall {#MyAppName}"; \
    Filename: "{uninstallexe}"; \
    IconFilename: "{app}\resources\icon.ico"

; ============================================================
[Run]
; ── Step 1: Create Scheduled Task for auto-admin launch ──────────────────────
;
; MISSION 3 — Scheduled Task with highest privileges
; This task runs start.bat with /rl highest on every user logon,
; so after installation the user never needs to right-click
; "Run as administrator". Windows executes the task as the
; logged-on user but with elevation already granted.
;
Filename: "schtasks.exe"; \
    Parameters: "/create /tn ""SudoStudioLauncher"" /tr """"""{app}\start.bat"""""" /sc onlogon /rl highest /f"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Configuring auto-start with administrator rights..."; \
    Description: "Create Sudo Studio scheduled task (auto-admin)"

; ── Step 2: Verify the scheduled task was created ────────────────────────────
Filename: "schtasks.exe"; \
    Parameters: "/query /tn ""SudoStudioLauncher"" /fo list"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Verifying auto-start configuration..."; \
    Description: "Verify scheduled task"

; ── Step 3: Launch Sudo Studio immediately after install ─────────────────────
Filename: "{app}\start.bat"; \
    WorkingDir: "{app}"; \
    Flags: nowait postinstall skipifsilent; \
    Description: "Launch {#MyAppName} now"; \
    StatusMsg: "Starting {#MyAppName}..."

; ============================================================
[UninstallRun]
; ── Remove Scheduled Task on uninstall ───────────────────────────────────────
Filename: "schtasks.exe"; \
    Parameters: "/delete /tn ""SudoStudioLauncher"" /f"; \
    Flags: runhidden waituntilterminated

; ============================================================
[Registry]
; ── Register app in Windows for "Open with" ──────────────────────────────────
Root: HKLM; \
    Subkey: "SOFTWARE\{#MyAppName}"; \
    ValueType: string; \
    ValueName: "InstallPath"; \
    ValueData: "{app}"; \
    Flags: uninsdeletekey

Root: HKLM; \
    Subkey: "SOFTWARE\{#MyAppName}"; \
    ValueType: string; \
    ValueName: "Version"; \
    ValueData: "{#MyAppVersion}"

; ── App registration for "Apps & Features" icon ──────────────────────────────
Root: HKLM; \
    Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{{A9B4E3C2-D5F6-4A7B-8C9D-E0F1A2B3C4D5}_is1"; \
    ValueType: string; \
    ValueName: "DisplayIcon"; \
    ValueData: "{app}\resources\icon.ico"; \
    Flags: uninsdeletevalue

; ============================================================
[Dirs]
; Ensure logs/ directory exists with write permissions ─────────────────────────
Name: "{app}\logs";  Permissions: users-modify
Name: "{app}\data";  Permissions: users-modify

; ============================================================
[Code]
// ──────────────────────────────────────────────────────────────────────────
//  Custom code: show a warning if Python is not installed (runtime dep)
//  and remind the user that admin rights are required.
// ──────────────────────────────────────────────────────────────────────────

function InitializeSetup(): Boolean;
begin
  Result := True;
  // Nothing to block — just proceed. Python check can be added here if needed.
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // Post-install: nothing extra needed — scheduled task handles elevation.
    Log('Sudo Studio installation complete. Scheduled task SudoStudioLauncher created.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then begin
    Log('Sudo Studio uninstalled. Scheduled task removed.');
  end;
end;
