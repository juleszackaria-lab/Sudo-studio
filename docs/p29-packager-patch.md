# P29 - Packager patch (sudo-studio-packager repo, workflow 03)

Status: SPEC READY, NOT APPLIED (packager repo unreachable from this sandbox;
apply with push-time access, then run CI). All anchors below were recovered
from the 03 success log of 2026-10-17 (run 39076854816).

Workflow file: the 03 file under `.github/workflows/` (list the dir; it is the
one that compiles `installer.iss` with ISCC and uploads `SudoStudio-Installer`).

## P0 - Rebuild order (mandatory)

The current 01/02 artifacts (runs 39075731421 / 39075733042) predate P29: their
`backend.exe` still crashes at boot (P29-b). Before running 03+smoke:

1. Merge P29 to `main` (Sudo-studio).
2. Dispatch 01 and 02 on the merged `main` (they build backend.exe / runtime.exe).
3. Run 03 with `BACKEND_RUN_ID` / `RUNTIME_RUN_ID` = the fresh runs.
   (03 fetches Sudo-studio source at `ref: main`, so P29 files - including
   `scripts/smoke/smoke-install.ps1` - are present as `_sudo-studio-source\...`.)

## P1 - Agent copy destination (P29-f)

Root cause: the extension resolves the agent server at
`{install}\extensions\sudo-agent\src\server.js` (up3 from
`extensions\sudo-ai\src\agent` + `sudo-agent\src\server.js` - see
`defaultServerJs()` in `sudo-ai-extension/src/agent/AgentServer.js`),
but 03 copies it to `{install}\sudo-agent\src\server.js`. Two edits:

Edit 1 - agent copy step (anchor: `$src = "_sudo-studio-source\sudo-agent\src"`):

    OLD: $dst = "build\SudoStudio\sudo-agent\src"
    NEW: $dst = "build\SudoStudio\extensions\sudo-agent\src"

Edit 2 - validation step right after (anchor: `manquant a la RACINE`):

    OLD: if not exist "build\SudoStudio\sudo-agent\src\server.js" (
    OLD:   echo ERROR: sudo-agent\src\server.js manquant a la RACINE
    NEW: if not exist "build\SudoStudio\extensions\sudo-agent\src\server.js" (
    NEW:   echo ERROR: extensions\sudo-agent\src\server.js manquant (P29-f)

(Also update the step's success echo, which prints the old ROOT path.)

## P2 - Use the repo installer.iss (P29-d)

Root cause: 03 GENERATES a minimal `installer.iss` inline (`$lines = @(...)`
step just before the ISCC step). That script has no process kill, no lock
check, no scheduled-task cleanup, no registry cleanup - so the P29-d code in
`Sudo-studio/installer.iss` would never run, and the smoke uninstall checks
(task + HKLM removal) would fail. Single-source fix: copy the repo script.

Replace the whole inline-generation step (anchor: the `$lines = @(` step whose
output ends with `[Run] / Filename: "{app}\start.bat"...`) with:

```powershell
Copy-Item "_sudo-studio-source\installer.iss" "installer.iss" -Force
Copy-Item "_sudo-studio-source\launch_hidden.vbs" "launch_hidden.vbs" -Force
$iss = Get-Content "installer.iss" -Raw
# ISCC runs at the workspace root: point the bundle + art at the build dir,
# and match the artifact name the later steps expect (Output\SudoStudio-Setup.exe).
$iss = $iss -replace 'OutputDir\s+= dist', 'OutputDir                     = Output'
$iss = $iss -replace 'OutputBaseFilename\s+= SudoStudio-Setup-\{#MyAppVersion\}', 'OutputBaseFilename            = SudoStudio-Setup'
$iss = $iss -replace 'Source: "\.\\\*";', 'Source: "build\SudoStudio\*";'
$iss = $iss -replace '#define MyAppIcon\s+"resources\\icon\.ico"', '#define MyAppIcon         "build\SudoStudio\resources\icon.ico"'
$iss = $iss -replace 'WizardSmallImageFile\s+= resources', 'WizardSmallImageFile          = build\SudoStudio\resources'
$iss = $iss -replace 'WizardImageFile\s+= resources', 'WizardImageFile               = build\SudoStudio\resources'
$iss = $iss -replace 'Source: "resources\\icon\.ico"; DestDir: "\{app\}\\resources"', 'Source: "build\SudoStudio\resources\icon.ico"; DestDir: "{app}\resources"'
$iss | Set-Content "installer.iss" -Encoding ASCII
Write-Host "[OK] installer.iss: repo script + packager path stamps"
```

Notes:
- `build\SudoStudio\resources\{icon.ico,wizard-small.bmp,installer-banner.bmp}`
  all exist (the old inline script already referenced them and ISCC passed).
- Do NOT touch the ISCC step or the `$setup = Get-ChildItem "Output\*.exe"` step.
- The `[Files] Excludes` line from the repo script is kept as-is (harmless).

## P3 - build-manifest.json (P29-e)

Insert AFTER the last step that writes into `build\SudoStudio` and BEFORE the
installer.iss step (P2), so the manifest ships inside `{app}`:

```powershell
$mfFiles = @('backend.exe', 'runtime.exe', 'SudoStudio.exe', 'start.bat',
  'extensions\sudo-agent\src\server.js', 'resources\app\product.json')
$hashes = @{}
foreach ($f in $mfFiles) {
    $p = Join-Path 'build\SudoStudio' $f
    if (Test-Path $p) { $hashes[$f] = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() }
}
$issVer = '5.0.0'
$m = Select-String -Path '_sudo-studio-source\installer.iss' -Pattern '#define MyAppVersion\s+"([^"]+)"'
if ($m) { $issVer = $m.Matches[0].Groups[1].Value }
$ssCommit = ''
try { $ssCommit = (git -C _sudo-studio-source rev-parse HEAD).Trim() } catch { $ssCommit = 'unknown' }
$mf = [ordered]@{
    version            = $issVer
    date               = (Get-Date).ToUniversalTime().ToString('o')
    sudo_studio_commit = $ssCommit
    packager_commit    = $env:GITHUB_SHA
    files              = $hashes
}
($mf | ConvertTo-Json -Depth 5) | Set-Content 'build\SudoStudio\build-manifest.json' -Encoding UTF8
Write-Host ("[OK] build-manifest.json: version={0} ss={1}" -f $issVer, $ssCommit)
```

## P4 - Smoke job (P29-a)

Append a new job (runs after the package job; replace `<package-job-id>` with
the id of the job that runs ISCC - the one containing the steps above):

```yaml
  smoke-windows:
    name: P29 smoke (Windows install)
    runs-on: windows-latest
    needs: [<package-job-id>]
    timeout-minutes: 45
    steps:
      - name: Download installer
        uses: dawidd6/action-download-artifact@v5
        with:
          run_id: ${{ github.run_id }}
          name: SudoStudio-Installer
          path: smoke-dl
      - name: Check out Sudo-studio source (smoke script)
        uses: actions/checkout@v4
        with:
          repository: juleszackaria-lab/Sudo-studio
          ref: main
          path: _sudo-studio-source
      - name: Run installer smoke test
        shell: powershell
        run: |
          powershell -NoProfile -ExecutionPolicy Bypass -File _sudo-studio-source\scripts\smoke\smoke-install.ps1 -InstallerPath (Join-Path (Get-Location) 'smoke-dl\SudoStudio-Setup.exe')
      - name: Upload smoke logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-logs
          path: smoke-out/
```

Notes:
- The smoke script FAILS (exit 1) if any check fails; the step fails the job.
- `smoke-out/summary.txt` + transcript + service logs are always uploaded.
- Expected duration ~10-15 min (runtime first-extract + editor test).
- The smoke installer path: the upload step publishes `Output\SudoStudio-Setup.exe`
  under artifact name `SudoStudio-Installer` (verified in the 03 log).
