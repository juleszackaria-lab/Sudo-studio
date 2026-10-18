# P32 - Packager patch (sudo-studio-packager repo, workflow 03)

Status: SPEC READY, NOT APPLIED (packager repo unreachable from this
sandbox; apply with push-time access, then run CI). Anchors follow the
P29 patch doc conventions (`_sudo-studio-source\...` = Sudo-studio @ main,
artifact `SudoStudio-Installer` = `Output\SudoStudio-Setup.exe`).

Workflow file: the 03 file under `.github/workflows/` (the one that
compiles `installer.iss` with ISCC and uploads `SudoStudio-Installer`).

## Why P20 does not show in the installed product (P32-b)

Three independent mechanisms, all fixed below:

1. 03 does NOT run the repo branding script. The 03 log prints
   `[VERIFY] ProductName: Sudo Studio`, a line that exists nowhere in
   `Sudo-studio/scripts/customize-vscodium.ps1`: 03 carries its own
   inline (older) branding steps, so the P20 SVG sweep and the P29 gen-B
   fix never execute at pack time.
2. NOTHING ever stamps the exe icon. The window corner + taskbar icon on
   Windows come from the icon embedded in the exe. Neither the repo
   script nor (to our knowledge) 03 runs rcedit, so the renamed
   `SudoStudio.exe` keeps showing the old VSCodium mark.
3. The loaded extension is stale and never refreshed. The editor loads
   `{install}\extensions\sudo-ai` (start.bat launches the exe with
   `--extensions-dir` pointing there; `data\extensions` is ignored once
   that flag is set, while `resources\app\extensions` always loads as
   builtins). `start.bat` syncs the extension ONLY when the target is
   missing ("already installed" otherwise), old installers never shipped
   a fresh copy, and the installer has no `[InstallDelete]`: a pre-P20
   copy (no activity container, views under Explorer) loads forever.

## P0 - Rebuild order (mandatory)

1. Merge P32 to `main` (Sudo-studio).
2. 01/02: reuse of recent green runs is acceptable - P32 changes no
   backend/runtime/extension code (only the branding script, the
   installer script, the smoke script, docs and tests).
3. Run 03 with `BACKEND_RUN_ID` / `RUNTIME_RUN_ID` = those runs.

## P1 - Ship a FRESH extension copy (verify-or-add)

The editor loads `build\SudoStudio\extensions\sudo-ai`. Ensure the 03
step that fills it copies the CURRENT `_sudo-studio-source` tree (not a
cached copy), then validates the activity container. Insert AFTER the
last step that writes the extension, BEFORE the ISCC step:

```powershell
$extSrc = '_sudo-studio-source\sudo-ai-extension'
$extDst = 'build\SudoStudio\extensions\sudo-ai'
if (Test-Path $extDst) { Remove-Item $extDst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extDst | Out-Null
Copy-Item "$extSrc\extension.js" "$extDst\" -Force
Copy-Item "$extSrc\package.json" "$extDst\" -Force
Copy-Item "$extSrc\src" "$extDst\src" -Recurse -Force
if (Test-Path "$extSrc\resources") { Copy-Item "$extSrc\resources" "$extDst\resources" -Recurse -Force }
if (Test-Path "$extSrc\node_modules") { Copy-Item "$extSrc\node_modules" "$extDst\node_modules" -Recurse -Force }
$pkg = Get-Content "$extDst\package.json" -Raw | ConvertFrom-Json
$bar = @($pkg.contributes.viewsContainers.activitybar)
if ($bar.Count -ne 1 -or $bar[0].id -ne 'sudo-studio') { Write-Error '[EXT-SHIP] FAIL: no single sudo-studio activity container'; exit 1 }
Write-Host ("[EXT-SHIP] container: {0}" -f ($bar | ConvertTo-Json -Compress -Depth 5))
Write-Host ("[EXT-SHIP] views in sudo-studio: {0}, explorer views: {1}" -f @($pkg.contributes.views.'sudo-studio').Count, ($null -ne $pkg.contributes.views.explorer))
```

Keep this `[EXT-SHIP]` output: it is proof #3 (the loaded package.json).

## P2 - Installer cleanup of stale copies ([InstallDelete])

The repo `installer.iss` now carries a P32(c) `[InstallDelete]` section
(stale `extensions\sudo-ai`, root `sudo-ai-extension`,
`data\extensions\*sudo*`, `resources\app\extensions\*sudo*`, legacy
`VSCodium.exe`, legacy manifest, legacy root/win32 code icons). User
data (`data\User`), models (outside `{app}`) and the live agent
(`{app}\sudo-agent`, P31 root layout) are never touched.

- If P29-P2 was applied (03 copies the repo `installer.iss`): nothing
  to do - the section ships automatically. Verify the copied file
  contains `[InstallDelete]` (fail the step if absent).
- If 03 still GENERATES the iss inline (anchor: the `$lines = @(`
  step): append the section to the generated lines, e.g. right after
  the `[Files]` entries are pushed:

```powershell
$lines += '[InstallDelete]'
$lines += 'Type: filesandordirs; Name: "{app}\extensions\sudo-ai"'
$lines += 'Type: filesandordirs; Name: "{app}\sudo-ai-extension"'
$lines += 'Type: filesandordirs; Name: "{app}\data\extensions\*sudo*"'
$lines += 'Type: filesandordirs; Name: "{app}\resources\app\extensions\*sudo*"'
$lines += 'Type: files; Name: "{app}\VSCodium.exe"'
$lines += 'Type: files; Name: "{app}\VSCodium.VisualElementsManifest.xml"'
$lines += 'Type: files; Name: "{app}\code.ico"'
$lines += 'Type: files; Name: "{app}\resources\win32\code.ico"'
$lines += 'Type: files; Name: "{app}\resources\win32\code_150x150.png"'
$lines += 'Type: files; Name: "{app}\resources\win32\code_70x70.png"'
```

## P3 - Branding: call the REPO script (single source)

Replace any inline branding steps (anchor: the step printing
`[VERIFY] ProductName`) with ONE call to the repo script, AFTER the exe
rename step (`VSCodium.exe` -> `SudoStudio.exe`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File _sudo-studio-source\scripts\customize-vscodium.ps1 -VSCodiumDir build\SudoStudio
if ($LASTEXITCODE -ne 0) { Write-Error 'branding script failed'; exit 1 }
```

The script now stamps the exe icon itself (STEP 2r: pinned rcedit
v2.0.0, sha256-verified, byte-exact old-gone/new-present verify) and
fails LOUD (exit 2) on any rcedit/verify failure, so the step above
fails the job instead of shipping an unbranded build. Keeping the old
inline steps alongside is tolerated (re-runs are no-ops: replaced art
no longer matches the old markers), but replacing them keeps one log.

## P4 - Pack-time exe-icon gate (explicit proof line)

After P3 (the script already verifies internally; this step gives the
standalone `[EXE-ICON]` proof line in the 03 log):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File _sudo-studio-source\scripts\ci\check-exe-icon.ps1 -ExePath build\SudoStudio\SudoStudio.exe
if ($LASTEXITCODE -ne 0) { Write-Error 'exe icon gate failed'; exit 1 }
```

## P5 - Fingerprint refresh (when the base or icon changes)

Defaults match VSCodium 1.97.2 + the current `resources\icon.ico`:

- `OldLogoSvgSha256` (`88bb8eb6...bed75f`): sha256 of the ORIGINAL
  `resources\app\out\media\code-icon.svg` from the downloaded base zip:
  `(Get-FileHash <extracted code-icon.svg> -Algorithm SHA256).Hash`.
- `OldIconPngSha256` (`b9971d91...c5505c`): run the checker against the
  ORIGINAL base exe with dummy shas - it fails but PRINTS every
  embedded PNG blob; copy the 256x256 line:
  `check-exe-icon.ps1 -ExePath <base>\VSCodium.exe -OldPngSha256 00 -NewPngSha256 00`.
- `NewIconPngSha256` (`f9a9ccc4...19d42`): same trick on a branded exe,
  or parse `resources\icon.ico` (the 256x256 PNG entry).

Pass refreshed values to BOTH the customize call (P3) and the smoke
call (P6) as `-OldLogoSvgSha256 ... -OldIconPngSha256 ...`
`-NewIconPngSha256 ...`.

## P6 - Smoke job (already exists, runs the 3 new checks)

The P31-P2 `smoke-windows` job needs no change: section 5b runs
automatically (`brand-oldlogo-zero`, `brand-extension-single`,
`brand-exe-icon`, each FAIL = job FAIL). To override fingerprints,
append the P5 params to the existing smoke call.

## P7 - Screenshot job (OPTIONAL, best-effort)

Screenshots prove the window art (dark + light) but depend on the
runner GUI session: every step after install is `continue-on-error`,
and the job NEVER fails the workflow (`if: always()` upload only).
Append as a NEW job (own install/uninstall under `%TEMP%`, no clash
with smoke):

```yaml
  screenshot-windows:
    name: P32 screenshots (dark + light, best-effort)
    runs-on: windows-latest
    needs: [<package-job-id>]
    timeout-minutes: 30
    steps:
      - name: Download installer
        uses: dawidd6/action-download-artifact@v5
        with:
          run_id: ${{ github.run_id }}
          name: SudoStudio-Installer
          path: shot-dl
      - name: Install + capture dark and light
        shell: powershell
        continue-on-error: true
        run: |
          $dir = Join-Path $env:TEMP 'SudoShot'
          if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
          $ip = Start-Process -FilePath (Join-Path (Get-Location) 'shot-dl\SudoStudio-Setup.exe') -ArgumentList '/SILENT','/NORESTART',("/DIR=$dir") -Wait -PassThru
          if ($ip.ExitCode -ne 0) { throw 'install failed' }
          Add-Type -AssemblyName System.Windows.Forms, System.Drawing
          $udata = Join-Path $env:TEMP 'SudoShotUser'
          foreach ($theme in @('Default Dark Modern', 'Default Light Modern')) {
            if (Test-Path $udata) { Remove-Item $udata -Recurse -Force }
            $usr = Join-Path $udata 'User'; New-Item -ItemType Directory -Force -Path $usr | Out-Null
            "{`"window.title`":`"Sudo Studio - P32`",`"workbench.colorTheme`":`"$theme`",`"workbench.startupEditor`":`"none`"}" | Set-Content (Join-Path $usr 'settings.json') -Encoding UTF8
            $exe = Join-Path $dir 'SudoStudio.exe'
            $p = Start-Process -FilePath $exe -ArgumentList "--extensions-dir=`"$dir\extensions`"","--user-data-dir=`"$udata`"",'--new-window','--disable-gpu' -PassThru
            try {
              Start-Sleep -Seconds 45
              $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
              $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
              $g = [System.Drawing.Graphics]::FromImage($bmp)
              $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
              $g.Dispose()
              $shot = 'shot-out\screenshot-' + ($theme -replace '[^A-Za-z]+', '-').ToLower() + '.png'
              New-Item -ItemType Directory -Force -Path 'shot-out' | Out-Null
              $bmp.Save((Join-Path (Get-Location) $shot), [System.Drawing.Imaging.ImageFormat]::Png)
              $bmp.Dispose()
              Write-Host ("[SHOT] saved {0}" -f $shot)
            } finally {
              try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
            }
          }
      - name: Uninstall
        shell: powershell
        continue-on-error: true
        run: |
          $un = Join-Path $env:TEMP 'SudoShot\unins000.exe'
          if (Test-Path $un) { Start-Process -FilePath $un -ArgumentList '/SILENT','/NORESTART' -Wait }
      - name: Upload screenshots
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: p32-screenshots
          path: shot-out/
          if-no-files-found: warn
```

Caveats (honest): the runner session may render without
compositing/focus, so a reviewer judges the PNGs; the robot icon
needs the extension host (~45 s wait). If both PNGs are unusable,
capture dark+light manually on the test PC instead (same launch
flags, `Win+Shift+S`) - the mission accepts PC captures.

## P8 - Proofs to paste back (P32 verdict)

1. Extension copies before/after: on the TEST PC,
   `dir {install}\extensions`, `dir {install}\data\extensions`,
   `dir {install}\resources\app\extensions` before updating and after
   (after = exactly `extensions\sudo-ai`); plus the CI `[EXT-SHIP]`
   lines and `brand-extension-single PASS`.
2. Old logo = 0: the `[2c] VERIFY: 0 ...` lines (markers, base64,
   fingerprint), `[EXE-ICON] PASS`, and `brand-oldlogo-zero PASS`.
3. Loaded package.json extract: the `[EXT-SHIP] container: {...}`
   line (id `sudo-studio`, robot svg both themes).
4. CI test output: `smoke-out/summary.txt` with the 3 new checks PASS
   (or the FAIL lines, verbatim - no rounding).
5. Window captures: `p32-screenshots` artifact (dark + light), or the
   manual PC captures if the runner session renders poorly.

SUCCESS requires all of the above; otherwise PARTIEL.
