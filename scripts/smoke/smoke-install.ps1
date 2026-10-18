# P29(a): Sudo Studio installer smoke test (Windows, PowerShell 5.1+).
# Silent install -> health checks (backend 5000 + runtime 6000) -> agent
# handshake (Electron-as-Node) -> file checks -> editor-close 0-process
# check -> clean uninstall. Exit 0 = all PASS (SKIPs allowed); exit 1 = any FAIL.
# Logs + summary are always written to OutDir (CI uploads them as artifact).
# ASCII only. Usage:
#   powershell -ExecutionPolicy Bypass -File smoke-install.ps1 -InstallerPath .\SudoStudio-Setup-5.0.0.exe
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Sudo Studio'),
    [string]$OutDir = (Join-Path (Get-Location) 'smoke-out'),
    [switch]$SkipEditorTest,
    [string]$OldLogoSvgSha256 = '88bb8eb6c643403be96d1d218a564c28a05f3b31368aad10c0db0bc1efbed75f',
    [string]$OldIconPngSha256 = 'b9971d910cb2502df37d7c65b2e36c9061d030fd41699bf9dafee46551c5505c',
    [string]$NewIconPngSha256 = 'f9a9ccc40f3a630132f9485084e33a0504493b3d7adda663950e50600b219d42'
)
$ErrorActionPreference = 'Stop'
$script:checks = New-Object System.Collections.ArrayList
$script:nFail = 0
$script:nSkip = 0

function Add-Check([string]$name, [string]$verdict, [string]$detail) {
    [void]$script:checks.Add(@{ name = $name; verdict = $verdict; detail = $detail })
    if ($verdict -eq 'FAIL') { $script:nFail++ }
    if ($verdict -eq 'SKIP') { $script:nSkip++ }
    Write-Host ("[SMOKE-{0}] {1} {2}" -f $verdict, $name, $detail)
}
function Save-Summary {
    $lines = @('Sudo Studio smoke summary', ('date: ' + (Get-Date -Format 'o')), '')
    foreach ($c in $script:checks) { $lines += ('[{0}] {1} {2}' -f $c.verdict, $c.name, $c.detail) }
    $lines += ''
    $lines += ('FAIL={0} SKIP={1}' -f $script:nFail, $script:nSkip)
    $lines | Set-Content (Join-Path $script:OutDir 'summary.txt') -Encoding UTF8
}
function Wait-Http200([string]$url, [int]$timeoutSec, [hashtable]$headers) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $lastErr = ''
    while ((Get-Date) -lt $deadline) {
        try {
            $p = @{ Uri = $url; TimeoutSec = 5; UseBasicParsing = $true; ErrorAction = 'Stop' }
            if ($headers) { $p['Headers'] = $headers }
            $r = Invoke-WebRequest @p
            if ($r.StatusCode -eq 200) { return $r }
        } catch { $lastErr = $_.Exception.Message }
        Start-Sleep -Seconds 3
    }
    throw ("timeout after {0}s waiting for {1} (last: {2})" -f $timeoutSec, $url, $lastErr)
}
function Test-PortFree([int]$port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        try { $c.Connect('127.0.0.1', $port); return $false } catch { return $true }
        finally { $c.Close() }
    } catch { return $true }
}
function Get-SudoProcesses([string]$root) {
    $names = @('backend.exe', 'runtime.exe', 'SudoStudio.exe', 'VSCodium.exe')
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like ($root + '*') -and ($names -contains $_.Name) })
}
function Copy-IfExists([string]$src, [string]$dstDir) {
    if (Test-Path $src) { Copy-Item $src $dstDir -Force -ErrorAction SilentlyContinue }
}

$script:OutDir = $OutDir
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Start-Transcript -Path (Join-Path $OutDir 'smoke-transcript.txt') -Force | Out-Null
try {
    Write-Host ("installer: {0}" -f $InstallerPath)
    Write-Host ("installdir: {0}" -f $InstallDir)
    if (-not (Test-Path $InstallerPath)) { Add-Check 'installer-present' 'FAIL' $InstallerPath; throw 'installer not found' }

    # -- 1. preconditions: ports free, target absent --
    if (-not (Test-PortFree 5000)) { Add-Check 'pre-port-5000-free' 'FAIL' 'occupied'; throw 'port 5000 occupied' }
    Add-Check 'pre-port-5000-free' 'PASS' ''
    if (-not (Test-PortFree 6000)) { Add-Check 'pre-port-6000-free' 'FAIL' 'occupied'; throw 'port 6000 occupied' }
    Add-Check 'pre-port-6000-free' 'PASS' ''
    if (Test-Path $InstallDir) { Add-Check 'pre-installdir-absent' 'FAIL' $InstallDir; throw 'install dir already exists' }
    Add-Check 'pre-installdir-absent' 'PASS' ''

    # -- 2. silent install --
    $innoLog = Join-Path $OutDir 'innosetup.log'
    $ip = Start-Process -FilePath $InstallerPath -ArgumentList '/SILENT', '/NORESTART', ("/DIR={0}" -f $InstallDir), ("/LOG={0}" -f $innoLog) -Wait -PassThru
    if ($ip.ExitCode -ne 0 -or -not (Test-Path (Join-Path $InstallDir 'SudoStudio.exe'))) {
        Add-Check 'silent-install' 'FAIL' ("exit={0}" -f $ip.ExitCode); throw 'install failed'
    }
    Add-Check 'silent-install' 'PASS' ("exit=0 dir={0}" -f $InstallDir)

    # -- 3. expected files --
    $files = @(
        'SudoStudio.exe', 'backend.exe', 'runtime.exe', 'start.bat', 'unins000.exe',
        'build-manifest.json', 'logo.ico', 'resources\icon.ico',
        'sudo-agent\src\server.js',
        'extensions\sudo-ai\extension.js', 'extensions\sudo-ai\package.json',
        'extensions\sudo-ai\node_modules\axios\package.json',
        'extensions\sudo-ai\resources\sudo-robot.svg',
        'resources\app\product.json', 'resources\app\out\media\code-icon.svg'
    )
    $missing = @()
    foreach ($f in $files) { if (-not (Test-Path (Join-Path $InstallDir $f))) { $missing += $f } }
    if ($missing.Count -gt 0) { Add-Check 'expected-files' 'FAIL' ($missing -join ', '); throw 'files missing' }
    Add-Check 'expected-files' 'PASS' ("{0} files" -f $files.Count)

    # -- 4. build manifest (commit, date, SHA-256) --
    try {
        $mf = Get-Content (Join-Path $InstallDir 'build-manifest.json') -Raw | ConvertFrom-Json
        if (-not $mf.version -or -not $mf.date -or -not $mf.sudo_studio_commit) { throw 'missing version/date/sudo_studio_commit' }
        $hashFails = @()
        foreach ($key in @('backend.exe', 'runtime.exe')) {
            if ($mf.files -and $mf.files.$key) {
                $actual = (Get-FileHash (Join-Path $InstallDir $key) -Algorithm SHA256).Hash.ToLower()
                if ($actual -ne [string]$mf.files.$key.ToLower()) { $hashFails += $key }
            }
        }
        if ($hashFails.Count -gt 0) { throw ('sha256 mismatch: ' + ($hashFails -join ', ')) }
        Add-Check 'build-manifest' 'PASS' ("commit={0}" -f $mf.sudo_studio_commit)
    } catch { Add-Check 'build-manifest' 'FAIL' $_.Exception.Message; throw 'manifest invalid' }

    # -- 5. branding: product.json + title-bar svg bytes --
    try {
        $pj = Get-Content (Join-Path $InstallDir 'resources\app\product.json') -Raw | ConvertFrom-Json
        if ($pj.nameShort -ne 'Sudo Studio') { throw ('nameShort=' + $pj.nameShort) }
        Add-Check 'brand-product.json' 'PASS' 'nameShort=Sudo Studio'
    } catch { Add-Check 'brand-product.json' 'FAIL' $_.Exception.Message }
    try {
        $a = [System.IO.File]::ReadAllBytes((Join-Path $InstallDir 'resources\app\out\media\code-icon.svg'))
        $b = [System.IO.File]::ReadAllBytes((Join-Path $InstallDir 'resources\sudo-icon.svg'))
        $same = ($a.Length -eq $b.Length)
        if ($same) { for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { $same = $false; break } } }
        if (-not $same) { throw 'code-icon.svg differs from sudo-icon.svg (STEP 2c missed)' }
        Add-Check 'brand-titlebar-svg' 'PASS' 'code-icon.svg == sudo-icon.svg'
    } catch { Add-Check 'brand-titlebar-svg' 'FAIL' $_.Exception.Message }

    # -- 5b. branding P32: old logo zero + single extension + exe icon --
    try {
        $oldTextExts = @('.js', '.json', '.css', '.html', '.svg', '.xml', '.ts', '.nls', '.txt', '.md')
        $oldHits = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $oldTextExts -contains $_.Extension.ToLower() } |
            Where-Object { $_.FullName -notmatch 'node_modules' } |
            Where-Object { $_.FullName -notmatch '\\.git\\' } |
            Where-Object { $_.Length -lt 64MB } |
            Where-Object {
                try {
                    $t = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
                    $gA = ($t -match 'path6008') -and ($t -match 'Gradient_1')
                    $gB = ($t -match '#78AEED') -and ($t -match '#1D6BCA') -and ($t -match 'linearGradient')
                    if ($gA -or $gB) { $true }
                    else {
                        $hb = $false
                        if ($_.Extension.ToLower() -eq '.js' -or $_.Extension.ToLower() -eq '.css') {
                            foreach ($m in [regex]::Matches($t, 'data:image/svg\+xml;base64,([A-Za-z0-9+/=]+)')) {
                                try {
                                    $d = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($m.Groups[1].Value))
                                    $dA = ($d -match 'path6008') -and ($d -match 'Gradient_1')
                                    $dB = ($d -match '#78AEED') -and ($d -match '#1D6BCA') -and ($d -match 'linearGradient')
                                    if ($dA -or $dB) { $hb = $true; break }
                                } catch {}
                            }
                        }
                        $hb
                    }
                }
                catch { $false }
            })
        if ($oldHits.Count -gt 0) { throw ('old-logo markers in: ' + (($oldHits | Select-Object -First 5 | ForEach-Object { $_.FullName.Substring($InstallDir.Length) }) -join ', ')) }
        $oldSvg = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension.ToLower() -eq '.svg' } |
            Where-Object {
                try { (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() -eq $OldLogoSvgSha256.ToLower() }
                catch { $false }
            })
        if ($oldSvg.Count -gt 0) { throw ('old-logo fingerprint svg: ' + $oldSvg[0].FullName.Substring($InstallDir.Length)) }
        Add-Check 'brand-oldlogo-zero' 'PASS' 'markers+b64+fingerprint absent'
    } catch { Add-Check 'brand-oldlogo-zero' 'FAIL' $_.Exception.Message }
    try {
        $copies = @()
        if (Test-Path (Join-Path $InstallDir 'extensions\sudo-ai\package.json')) { $copies += 'extensions\sudo-ai' }
        if (Test-Path (Join-Path $InstallDir 'sudo-ai-extension\package.json')) { $copies += 'sudo-ai-extension' }
        foreach ($dd in @('data\extensions', 'resources\app\extensions')) {
            $eroot = Join-Path $InstallDir $dd
            if (Test-Path $eroot) {
                foreach ($sub in @(Get-ChildItem $eroot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*sudo*' })) {
                    $copies += ($dd + '\' + $sub.Name)
                }
            }
        }
        if ($copies.Count -ne 1 -or $copies[0] -ne 'extensions\sudo-ai') { throw ('copies: ' + ($copies -join ', ')) }
        $ep = Get-Content (Join-Path $InstallDir 'extensions\sudo-ai\package.json') -Raw | ConvertFrom-Json
        $bar = @($ep.contributes.viewsContainers.activitybar)
        if ($bar.Count -ne 1 -or $bar[0].id -ne 'sudo-studio') { throw 'activitybar container != [sudo-studio]' }
        foreach ($ip in @($bar[0].icon.light, $bar[0].icon.dark)) {
            if (-not $ip -or -not (Test-Path (Join-Path $InstallDir ('extensions\sudo-ai\' + ($ip -replace '/', '\'))))) { throw ('container icon missing: ' + $ip) }
        }
        $vs = $ep.contributes.views
        if (-not $vs.'sudo-studio' -or @($vs.'sudo-studio').Count -lt 1) { throw 'no views in sudo-studio' }
        if ($vs.explorer) { throw 'views still under explorer' }
        Add-Check 'brand-extension-single' 'PASS' ($copies[0] + ' views=' + @($vs.'sudo-studio').Count)
    } catch { Add-Check 'brand-extension-single' 'FAIL' $_.Exception.Message }
    $exeCheck = Join-Path (Split-Path $PSScriptRoot -Parent) 'ci\check-exe-icon.ps1'
    if (-not (Test-Path $exeCheck)) {
        Add-Check 'brand-exe-icon' 'SKIP' 'checker not in checkout'
    } else {
        try {
            & $exeCheck -ExePath (Join-Path $InstallDir 'SudoStudio.exe') -OldPngSha256 $OldIconPngSha256 -NewPngSha256 $NewIconPngSha256
            if ($LASTEXITCODE -ne 0) { throw 'checker exit 1 (see [EXE-ICON] lines)' }
            Add-Check 'brand-exe-icon' 'PASS' 'old gone + new present'
        } catch { Add-Check 'brand-exe-icon' 'FAIL' $_.Exception.Message }
    }

    # -- 6. backend + runtime health --
    $be = Start-Process -FilePath (Join-Path $InstallDir 'backend.exe') -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    try {
        $r = Wait-Http200 'http://localhost:5000/api/system/health' 90
        Add-Check 'backend-health' 'PASS' 'HTTP 200'
    } catch { Add-Check 'backend-health' 'FAIL' $_.Exception.Message }
    $rt = Start-Process -FilePath (Join-Path $InstallDir 'runtime.exe') -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    try {
        $r = Wait-Http200 'http://localhost:6000/health' 300
        $body = $r.Content | ConvertFrom-Json
        if ($body.status -ne 'healthy') { throw ('status=' + $body.status) }
        Add-Check 'runtime-health' 'PASS' 'status=healthy'
    } catch { Add-Check 'runtime-health' 'FAIL' $_.Exception.Message }

    # -- 7. backend boot line (build commit) + P21 runtime journal --
    try {
        $bl = Get-Content (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\backend.log') -Raw -ErrorAction Stop
        if ($bl -notmatch 'build: commit=') { throw 'no build line in backend.log' }
        Add-Check 'backend-build-line' 'PASS' ''
    } catch { Add-Check 'backend-build-line' 'FAIL' $_.Exception.Message }
    try {
        $jr = Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.log'
        $jt = Get-Content $jr -Raw -ErrorAction Stop
        if ($jt -notmatch '# === session start ===') { throw 'no P21 session header' }
        if ($jt -notmatch '\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[(INFO|DEBUG|WARNING|ERROR)\] \[runtime\]') { throw 'no P21-shaped line' }
        Add-Check 'runtime-p21-journal' 'PASS' $jr
    } catch { Add-Check 'runtime-p21-journal' 'FAIL' $_.Exception.Message }

    # -- 8. agent handshake via the product exe (Electron-as-Node) --
    $agentOk = $false
    try {
        $serverJs = Join-Path $InstallDir 'sudo-agent\src\server.js'
        $token = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:SUDO_AGENT_TOKEN = $token
        $env:SUDO_AGENT_PORT = '0'
        $env:SUDO_AGENT_PROVIDER = '{}'
        $ao = Join-Path $OutDir 'agent-stdout.txt'
        $ae = Join-Path $OutDir 'agent-stderr.txt'
        if (Test-Path $ao) { Remove-Item $ao -Force }
        $ap = Start-Process -FilePath (Join-Path $InstallDir 'SudoStudio.exe') -ArgumentList "`"$serverJs`"" -NoNewWindow -RedirectStandardOutput $ao -RedirectStandardError $ae -PassThru
        try {
            $hs = $null
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline -and -not $hs) {
                Start-Sleep -Seconds 2
                if (Test-Path $ao) { $hs = Select-String -Path $ao -Pattern '^\{"ready":true' | Select-Object -First 1 }
            }
            if (-not $hs) { throw 'no handshake on stdout within 60s' }
            $port = ($hs.Line | ConvertFrom-Json).port
            $hr = Wait-Http200 ("http://127.0.0.1:{0}/health" -f $port) 30 @{ Authorization = ("Bearer {0}" -f $token) }
            if (($hr.Content | ConvertFrom-Json).ok -ne $true) { throw 'health ok != true' }
            $agentOk = $true
            Add-Check 'agent-handshake' 'PASS' ("port={0}" -f $port)
        } finally {
            try { Stop-Process -Id $ap.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch { Add-Check 'agent-handshake' 'FAIL' $_.Exception.Message }
    finally {
        $env:ELECTRON_RUN_AS_NODE = $null
        $env:SUDO_AGENT_TOKEN = $null
        $env:SUDO_AGENT_PORT = $null
        $env:SUDO_AGENT_PROVIDER = $null
    }

    # -- 9. editor close -> 0 processes (start.bat monitor) --
    if ($SkipEditorTest) {
        Add-Check 'editor-close-cleanup' 'SKIP' 'flag'
    } else {
        try { Stop-Process -Id $be.Id -Force -ErrorAction SilentlyContinue } catch {}
        try { Stop-Process -Id $rt.Id -Force -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Seconds 2
        $launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start.bat' -WorkingDirectory $InstallDir -WindowStyle Minimized -PassThru
        try {
            $extDir = Join-Path $InstallDir 'extensions'
            $deadline = (Get-Date).AddSeconds(240)
            $editorMain = $null
            while ((Get-Date) -lt $deadline -and -not $editorMain) {
                Start-Sleep -Seconds 5
                $editorMain = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -like '*--extensions-dir*' -and $_.CommandLine -like ("*{0}*" -f $extDir) } |
                    Select-Object -First 1)
                if ($editorMain.Count -eq 0) { $editorMain = $null }
            }
            if (-not $editorMain) { throw 'editor main process never appeared within 240s' }
            Stop-Process -Id $editorMain.ProcessId -Force
            $deadline = (Get-Date).AddSeconds(120)
            $left = @('x')
            while ((Get-Date) -lt $deadline -and $left.Count -gt 0) {
                Start-Sleep -Seconds 5
                $left = Get-SudoProcesses $InstallDir
            }
            if ($left.Count -gt 0) { throw ("{0} process(es) still alive: {1}" -f $left.Count, (($left | ForEach-Object { $_.Name }) -join ', ')) }
            Add-Check 'editor-close-cleanup' 'PASS' '0 processes remain'
        } catch { Add-Check 'editor-close-cleanup' 'FAIL' $_.Exception.Message }
        finally {
            try { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue } catch {}
            foreach ($p in (Get-SudoProcesses $InstallDir)) {
                try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
    }

    # -- 9b. single logs folder: listing after all components ran (P33-c) --
    if ($SkipEditorTest) {
        Add-Check 'logs-single-dir' 'SKIP' 'flag (no launcher run, no startup.log)'
    } else {
        try {
            $single = Join-Path $env:LOCALAPPDATA 'SudoStudio\logs'
            $files = @(Get-ChildItem $single -File -ErrorAction Stop | ForEach-Object { $_.Name })
            foreach ($need in @('startup.log', 'backend.log', 'runtime.log')) {
                if ($files -notcontains $need) { throw ('missing: ' + $need) }
            }
            $legacy = Join-Path $InstallDir 'logs'
            if ((Test-Path $legacy) -and (@(Get-ChildItem $legacy -File -ErrorAction SilentlyContinue).Count -gt 0)) {
                throw 'journals still written under the install folder'
            }
            Add-Check 'logs-single-dir' 'PASS' ($files -join ', ')
        } catch { Add-Check 'logs-single-dir' 'FAIL' $_.Exception.Message }
    }

    # -- 10. clean uninstall --
    try {
        $unins = Join-Path $InstallDir 'unins000.exe'
        if (-not (Test-Path $unins)) { throw 'unins000.exe missing' }
        $up = Start-Process -FilePath $unins -ArgumentList '/SILENT', '/NORESTART' -Wait -PassThru
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline -and ((Test-Path (Join-Path $InstallDir 'SudoStudio.exe')) -or (Test-Path (Join-Path $InstallDir 'backend.exe')) -or (Test-Path (Join-Path $InstallDir 'runtime.exe')))) {
            Start-Sleep -Seconds 5
        }
        $exeLeft = @('SudoStudio.exe', 'backend.exe', 'runtime.exe') | Where-Object { Test-Path (Join-Path $InstallDir $_) }
        if ($exeLeft.Count -gt 0) { throw ('exes remain: ' + ($exeLeft -join ', ')) }
        $stillRunning = @(Get-Process -Name 'backend', 'runtime', 'SudoStudio', 'VSCodium' -ErrorAction SilentlyContinue)
        if ($stillRunning.Count -gt 0) { throw ("{0} process(es) still running" -f $stillRunning.Count) }
        schtasks /query /tn SudoStudioLauncher /fo list 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { throw 'scheduled task SudoStudioLauncher still exists' }
        if (Test-Path 'HKLM:\SOFTWARE\Sudo Studio') { throw 'HKLM registry key still exists' }
        $leftovers = @(Get-ChildItem $InstallDir -ErrorAction SilentlyContinue)
        Add-Check 'clean-uninstall' 'PASS' ("exit={0} leftover-items={1} (logs/data accepted)" -f $up.ExitCode, $leftovers.Count)
    } catch { Add-Check 'clean-uninstall' 'FAIL' $_.Exception.Message }
}
catch {
    if ($script:nFail -eq 0) { Add-Check 'smoke-aborted' 'FAIL' $_.Exception.Message }
    else { Write-Host ("[SMOKE-ABORT] {0}" -f $_.Exception.Message) }
}
finally {
    try {
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\startup.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\backend.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.jsonl') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\extension.log') $OutDir
        Copy-IfExists (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\agent.log') $OutDir
        Save-Summary
    } catch { Write-Host ("[SMOKE] log copy failed: {0}" -f $_.Exception.Message) }
    try { Stop-Transcript | Out-Null } catch {}
}
if ($script:nFail -gt 0) { Write-Host ("SMOKE RESULT: FAIL ({0} failed, {1} skipped)" -f $script:nFail, $script:nSkip); exit 1 }
Write-Host ("SMOKE RESULT: SUCCESS ({0} checks, {1} skipped)" -f $script:checks.Count, $script:nSkip)
exit 0
