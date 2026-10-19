# P35 - packager patch (workflow 03): hidden launch, brand names, panel render gate

Date: 2026-10-19. Companion scripts ship in the Sudo-studio checkout
that 03 already makes: scripts/ci/panel-render-test.js (new),
scripts/customize-vscodium.ps1 (STEP 1 commit + STEP 4e2, extended),
scripts/smoke/smoke-install.ps1 (check 9c, extended).

## 1. Step 8 "Prepare build folders": stop shipping data/ + logs/

Delete the two lines creating `build\SudoStudio\data` and
`build\SudoStudio\logs`. Rationale (P35-c): empty dirs next to the exe
push VSCodium into portable mode and contradict the pristine-install
rule. start.bat creates what it needs under %LOCALAPPDATA%\SudoStudio.

## 2. Step 10b branding call: pass the Sudo-studio commit

```powershell
$ssCommit10 = (git -C _sudo-studio-source rev-parse HEAD).Trim()
& $scriptPath -VSCodiumDir "build\SudoStudio" -SudoStudioCommit $ssCommit10
```

STEP 1 then stamps product.json `commit` (+ `date`) so Help > About
shows OUR commit instead of the upstream VSCodium sha (P35-e).

## 3. Step 13: also ship launch_hidden.vbs

```cmd
if exist _sudo-studio-source\launch_hidden.vbs (
  copy _sudo-studio-source\launch_hidden.vbs build\SudoStudio\launch_hidden.vbs /Y
) else (
  echo ERROR: launch_hidden.vbs not found in Sudo-studio repo
)
```

## 4. Generator (step 17): display names + hidden launch

Keep `AppName=SudoStudio` (upgrade path: same AppId/registry).
Change display strings only:

- `DefaultGroupName=Sudo Studio`
- `[Icons]` Start Menu: `Name: "{group}\Sudo Studio"; Filename: "wscript.exe"; Parameters: """{app}\launch_hidden.vbs"" ""{app}\start.bat"""; WorkingDir: "{app}"; IconFilename: "{app}\resources\icon.ico"`
- `[Icons]` desktop: same target/params with `Name: "{userdesktop}\Sudo Studio"`, keep `Tasks: desktopicon`.
- `[Run]`: `Filename: "wscript.exe"; Parameters: (same); WorkingDir: "{app}"; Description: "Launch Sudo Studio"; Flags: postinstall nowait skipifsilent`

## 5. P32 screenshot job: live extensions dir (P35-c consistency)

Before launching the exe, copy the shipped master to a temp live dir
and point --extensions-dir there (was: install\extensions, writable
by the editor):

```powershell
$live = Join-Path $env:TEMP 'SudoShotLive'
if (Test-Path $live) { Remove-Item $live -Recurse -Force }
New-Item -ItemType Directory -Force -Path $live | Out-Null
Copy-Item (Join-Path $dir 'extensions\sudo-ai') (Join-Path $live 'sudo-ai') -Recurse -Force
```

then `"--extensions-dir=`"$live`""` in the Start-Process arguments.

## 6. New job: panel-render-windows (P35-f, REQUIRED gate)

Needs [build]. Downloads the Installer artifact, installs silent to a
temp dir, launches backend.exe hidden (waits :5000, 60 s), copies the
master to %LOCALAPPDATA%\SudoStudio\extensions, checks out
Sudo-studio@main for scripts/ci, runs node
scripts/ci/panel-render-test.js, then repeats on a paren-path copy
(`C:\ptest (x86)\SudoStudio`, --skip-shortcuts, other debug port),
then a 90 s start.bat run from the paren copy asserting PHASE 5 with
no "unexpected" error, then a hidden-launch step (wscript, assert no
"Starting" console + editor window titled "Sudo Studio" + desktop
screenshot), then uninstall. Uploads the out dir (report + 15 panel
screenshots + desktop shot) always. The job FAILS on any panel blank,
console error, old-logo hit, shortcut/name mismatch, or install-dir
write. Pins: the 01/02 run ids of the Sudo-studio commit under test
(same bump procedure as before).
