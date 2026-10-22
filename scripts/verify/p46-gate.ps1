#Requires -Version 5.1
# P46: delivery gate - install the BUILT package, test the INSTALLED product,
# refuse publication on ANY failure. Runs inside the packager 03 build job
# BEFORE the installer upload: exit 1 here blocks SudoStudio-Installer and
# SudoStudio-Portable (only the 'diagnostic' artifact is uploaded).
# Silent install -> snapshots -> backend/runtime up -> shipped
# verify-installed.ps1 -Full (P46-1..7,9) -> pristine check (8a) ->
# uninstall -> no files / no processes / task+registry (8b).
# Exit 0 = all PASS (SKIPs allowed); exit 1 = any FAIL.
# Logs + verify-result.json + gate-result.json always in OutDir (diagnostic).
# ASCII only. Usage:
#   powershell -ExecutionPolicy Bypass -File p46-gate.ps1 -InstallerPath .\SudoStudio-Setup.exe -SourceDir _sudo-studio-source -OutDir gate-out
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$InstallDir = (Join-Path ([System.IO.Path]::GetTempPath()) 'P46Gate'),
    [string]$OutDir = (Join-Path (Get-Location) 'gate-out'),
    [string]$SourceDir = '_sudo-studio-source',
    [int]$ModelTimeoutSec = 900
)
$ErrorActionPreference = 'Stop'
$script:checks = @()
$script:nFail = 0
$script:nSkip = 0

function Add-Check([string]$line, [string]$name, [string]$verdict, [string]$detail) {
    $script:checks += @{ line = $line; name = $name; verdict = $verdict; detail = $detail }
    if ($verdict -eq 'FAIL') { $script:nFail++ }
    if ($verdict -eq 'SKIP') { $script:nSkip++ }
    Write-Host ("[GATE-{0}] {1} {2} {3}" -f $verdict, $line, $name, $detail)
}
function Short([string]$s, [int]$n) {
    if (-not $s) { return '' }
    $t = $s -replace '\s+', ' '
    if ($t.Length -gt $n) { return $t.Substring(0, $n) + '...' }
    return $t
}
function Test-PortFree([int]$port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        try { $c.Connect('127.0.0.1', $port); return $false } catch { return $true }
        finally { $c.Close() }
    } catch { return $true }
}
function Wait-Http200([string]$url, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $lastErr = ''
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) { return $r }
        } catch { $lastErr = $_.Exception.Message }
        Start-Sleep -Seconds 5
    }
    throw ("timeout after {0}s waiting for {1} (last: {2})" -f $timeoutSec, $url, $lastErr)
}
function Get-SudoProcesses([string]$root) {
    $names = @('backend.exe', 'runtime.exe', 'SudoStudio.exe', 'VSCodium.exe')
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like ($root + '*') -and ($names -contains $_.Name) })
}
function Snapshot-Dir([string]$root) {
    $h = @{}
    if (-not (Test-Path $root)) { return $h }
    $files = @(Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length)
        try { $h[$rel] = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower() }
        catch { $h[$rel] = ('UNREADABLE:' + $_.Exception.Message) }
    }
    return $h
}
function Copy-IfExists([string]$src, [string]$dstDir) {
    if (Test-Path $src) { Copy-Item $src $dstDir -Force -ErrorAction SilentlyContinue }
}

$script:OutDir = $OutDir
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Start-Transcript -Path (Join-Path $OutDir 'gate-transcript.txt') -Force | Out-Null
try {
    Write-Host ("installer: {0}" -f $InstallerPath)
    Write-Host ("installdir: {0}" -f $InstallDir)
    if (-not (Test-Path $InstallerPath)) { Add-Check 'G0' 'installer-present' 'FAIL' $InstallerPath; throw 'installer not found' }
    Add-Check 'G0' 'installer-present' 'PASS' $InstallerPath

    # -- preconditions --
    if (-not (Test-PortFree 5000)) { Add-Check 'G0' 'pre-port-5000-free' 'FAIL' 'occupied'; throw 'port 5000 occupied' }
    Add-Check 'G0' 'pre-port-5000-free' 'PASS' ''
    if (-not (Test-PortFree 6000)) { Add-Check 'G0' 'pre-port-6000-free' 'FAIL' 'occupied'; throw 'port 6000 occupied' }
    Add-Check 'G0' 'pre-port-6000-free' 'PASS' ''
    if (Test-Path $InstallDir) { Add-Check 'G0' 'pre-installdir-absent' 'FAIL' $InstallDir; throw 'install dir already exists' }
    Add-Check 'G0' 'pre-installdir-absent' 'PASS' ''

    # -- silent install --
    $innoLog = Join-Path $OutDir 'innosetup.log'
    $ip = Start-Process -FilePath $InstallerPath -ArgumentList '/SILENT', '/NORESTART', ("/DIR=`"{0}`"" -f $InstallDir), ("/LOG=`"{0}`"" -f $innoLog) -Wait -PassThru
    if ($ip.ExitCode -ne 0 -or -not (Test-Path (Join-Path $InstallDir 'SudoStudio.exe'))) {
        Add-Check 'G1' 'silent-install' 'FAIL' ("exit={0}" -f $ip.ExitCode); throw 'install failed'
    }
    Add-Check 'G1' 'silent-install' 'PASS' ("exit=0 dir={0}" -f $InstallDir)
    $snapA = Snapshot-Dir $InstallDir
    Add-Check 'G1' 'snapshot-before-run' 'PASS' ("{0} files" -f $snapA.Count)
    $taskAt0 = $false
    try { $null = & schtasks /query /tn SudoStudioLauncher /fo list 2>&1; $taskAt0 = ($LASTEXITCODE -eq 0) } catch {}
    $regAt0 = Test-Path 'HKLM:\SOFTWARE\Sudo Studio'

    # -- backend + runtime up (their health is smoke-covered; here: run them) --
    $be = Start-Process -FilePath (Join-Path $InstallDir 'backend.exe') -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    try {
        $null = Wait-Http200 'http://localhost:5000/api/system/health' 90
        Add-Check 'G2' 'backend-up' 'PASS' 'HTTP 200'
    } catch { Add-Check 'G2' 'backend-up' 'FAIL' (Short $_.Exception.Message 200) }
    $rt = Start-Process -FilePath (Join-Path $InstallDir 'runtime.exe') -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    try {
        $r = Wait-Http200 'http://localhost:6000/health' 300
        if (($r.Content | ConvertFrom-Json).status -ne 'healthy') { throw ('status=' + ($r.Content | ConvertFrom-Json).status) }
        Add-Check 'G2' 'runtime-up' 'PASS' 'status=healthy'
    } catch { Add-Check 'G2' 'runtime-up' 'FAIL' (Short $_.Exception.Message 200) }

    # -- shipped verifier, full mode (P46-1..7,9) --
    $verifyPs1 = Join-Path $InstallDir 'verify-installed.ps1'
    if (-not (Test-Path $verifyPs1)) {
        Add-Check 'P46-9' 'verify-shipped' 'FAIL' 'verify-installed.ps1 not shipped'
    } else {
        $vOut = Join-Path $OutDir 'verify-result.json'
        $vWork = Join-Path $OutDir 'work'
        & $verifyPs1 -InstallDir $InstallDir -Full -OutFile $vOut -PanelScript (Join-Path $SourceDir 'scripts\ci\panel-render-test.js') -ExeChecker (Join-Path $SourceDir 'scripts\ci\check-exe-icon.ps1') -WorkDir $vWork -ModelTimeoutSec $ModelTimeoutSec
        if (-not (Test-Path $vOut)) {
            Add-Check 'P46-9' 'verify-result' 'FAIL' 'shipped verifier produced no verify-result.json'
        } else {
            try {
                $vj = Get-Content $vOut -Raw | ConvertFrom-Json
                foreach ($c in @($vj.checks)) {
                    Add-Check ([string]$c.line) ([string]$c.name) ([string]$c.verdict) ([string]$c.detail)
                }
            } catch { Add-Check 'P46-9' 'verify-result' 'FAIL' ('unparseable: ' + (Short $_.Exception.Message 150)) }
        }
    }

    # -- P46-8a: no writes inside the install dir at runtime --
    try {
        $snapB = Snapshot-Dir $InstallDir
        $diffs = @()
        foreach ($k in $snapB.Keys) {
            if (-not $snapA.ContainsKey($k)) { $diffs += ('added: ' + $k) }
            elseif ($snapB[$k] -ne $snapA[$k]) { $diffs += ('modified: ' + $k) }
        }
        foreach ($k in $snapA.Keys) {
            if (-not $snapB.ContainsKey($k)) { $diffs += ('deleted: ' + $k) }
        }
        if ($diffs.Count -gt 0) { throw (($diffs | Select-Object -First 5) -join '; ') }
        Add-Check 'P46-8a' 'install-pristine' 'PASS' ("{0} files unchanged" -f $snapB.Count)
    } catch { Add-Check 'P46-8a' 'install-pristine' 'FAIL' (Short $_.Exception.Message 300) }

    # -- stop everything before uninstall --
    foreach ($p in (Get-SudoProcesses $InstallDir)) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    $deadline0 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline0 -and @(Get-SudoProcesses $InstallDir).Count -gt 0) { Start-Sleep -Seconds 2 }

    # -- P46-8b: uninstall leaves no files and no processes --
    try {
        $unins = Join-Path $InstallDir 'unins000.exe'
        if (-not (Test-Path $unins)) { throw 'unins000.exe missing' }
        $up = Start-Process -FilePath $unins -ArgumentList '/SILENT', '/NORESTART' -Wait -PassThru
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline -and ((Test-Path (Join-Path $InstallDir 'SudoStudio.exe')) -or (Test-Path (Join-Path $InstallDir 'backend.exe')) -or (Test-Path (Join-Path $InstallDir 'runtime.exe')))) {
            Start-Sleep -Seconds 5
        }
        $rest = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue)
        if ($rest.Count -gt 0) {
            throw ('files remain: ' + (($rest | Select-Object -First 5 | ForEach-Object { $_.FullName.Substring($InstallDir.Length) }) -join ', '))
        }
        if (Test-Path $InstallDir) { Add-Check 'P46-8b' 'uninstall-no-files' 'PASS' ("exit={0} dir remains, empty" -f $up.ExitCode) }
        else { Add-Check 'P46-8b' 'uninstall-no-files' 'PASS' ("exit={0} dir removed" -f $up.ExitCode) }
    } catch { Add-Check 'P46-8b' 'uninstall-no-files' 'FAIL' (Short $_.Exception.Message 300) }
    try {
        $still = @(Get-Process -Name 'backend', 'runtime', 'SudoStudio', 'VSCodium' -ErrorAction SilentlyContinue)
        if ($still.Count -gt 0) { throw ("{0} process(es) still running" -f $still.Count) }
        Add-Check 'P46-8b' 'uninstall-no-processes' 'PASS' '0 processes'
    } catch { Add-Check 'P46-8b' 'uninstall-no-processes' 'FAIL' (Short $_.Exception.Message 150) }
    if ($taskAt0) {
        $stask = 1
        try { $null = & schtasks /query /tn SudoStudioLauncher /fo list 2>&1; $stask = $LASTEXITCODE } catch { $stask = 1 }
        if ($stask -eq 0) { Add-Check 'P46-8b' 'uninstall-task' 'FAIL' 'scheduled task still exists' }
        else { Add-Check 'P46-8b' 'uninstall-task' 'PASS' 'task removed' }
    } else {
        Add-Check 'P46-8b' 'uninstall-task' 'SKIP' 'no task at baseline'
    }
    if ($regAt0) {
        if (Test-Path 'HKLM:\SOFTWARE\Sudo Studio') { Add-Check 'P46-8b' 'uninstall-registry' 'FAIL' 'HKLM key still exists' }
        else { Add-Check 'P46-8b' 'uninstall-registry' 'PASS' 'key removed' }
    } else {
        Add-Check 'P46-8b' 'uninstall-registry' 'SKIP' 'no key at baseline'
    }
}
catch {
    if ($script:nFail -eq 0) { Add-Check 'G9' 'gate-aborted' 'FAIL' (Short $_.Exception.Message 200) }
    else { Write-Host ("[GATE-ABORT] {0}" -f $_.Exception.Message) }
}
finally {
    try {
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\startup.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\backend.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.jsonl') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\extension.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\agent.log') $OutDir
        $result = [ordered]@{
            app       = 'Sudo Studio P46 delivery gate'
            date      = (Get-Date -Format 'o')
            installer = $InstallerPath
            install   = $InstallDir
            checks    = $script:checks
            fail      = $script:nFail
            skip      = $script:nSkip
            result    = 'PASS'
        }
        if ($script:nFail -gt 0) { $result.result = 'FAIL' }
        ($result | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $script:OutDir 'gate-result.json') -Encoding UTF8
        Write-Host '[GATE-EVIDENCE] gate-result.json:'
        Write-Host (Get-Content (Join-Path $script:OutDir 'gate-result.json') -Raw)
        $vrf = Join-Path $script:OutDir 'verify-result.json'
        if (Test-Path $vrf) {
            Write-Host '[GATE-EVIDENCE] verify-result.json checks:'
            foreach ($c in @((Get-Content $vrf -Raw | ConvertFrom-Json).checks)) {
                Write-Host ("[GATE-EVIDENCE] {0} {1} {2}" -f $c.line, $c.verdict, $c.name)
            }
        }
    } catch { Write-Host ("[GATE] evidence copy failed: {0}" -f $_.Exception.Message) }
    try { Stop-Transcript | Out-Null } catch {}
}
if ($script:nFail -gt 0) { Write-Host ("GATE RESULT: FAIL ({0} failed, {1} skipped) - PUBLISH BLOCKED" -f $script:nFail, $script:nSkip); exit 1 }
Write-Host ("GATE RESULT: SUCCESS ({0} checks, {1} skipped)" -f $script:checks.Count, $script:nSkip)
exit 0
