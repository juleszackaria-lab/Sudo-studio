#Requires -Version 5.1
<#
.SYNOPSIS
    Sudo Studio P46 - verify an INSTALLED package, per-line PASS/FAIL/SKIP.
.DESCRIPTION
    P36(d) base (manifest hashes, structure, branding, probes) extended with
    the P46 delivery-gate lines: backend --selftest (L1), agent handshake
    from the installed path (L2), editor exthost/renderer log scan (L3, -Full),
    15 panels render + console (L4, -Full), branding incl. old-logo zero (L5),
    runtime journal header + real-vs-requested n_ctx (L6), manifest vs files +
    runtime freshness (L7), uninstall line (L8, always SKIP here: destructive,
    CI gate only), result integrity incl. no-secret scan (L9).
    Writes verify-result.json holding versions, hashes and verdicts ONLY -
    never any secret, key, token or project content (L9 refuses to write the
    file if a secret pattern is detected in it).
    Never writes inside the install dir (P35c): output goes to the current
    directory unless -OutFile is given; temp work under -WorkDir or %TEMP%.
    Default run is fast (< 120 s, P36 matrix compatible) and network-free.
    -Full launches the editor, renders panels and may download ~1 GB
    (model load for the n_ctx check).
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\me\AppData\Local\Programs\SudoStudio\verify-installed.ps1"
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File verify-installed.ps1 -Full -OutFile .\verify-result.json
#>
param(
    [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    [string]$OutFile = '',
    [switch]$Full,
    [string]$PanelScript = '',
    [string]$ExeChecker = '',
    [int]$ModelTimeoutSec = 900,
    [string]$WorkDir = ''
)

$ErrorActionPreference = 'Stop'
$files = @()
$probes = @()
$checks = @()
$nFail = 0
$nSkip = 0
$autoWork = $false

function Add-File([string]$rel, [bool]$ok, [string]$detail) {
    $script:files += @{ path = $rel; ok = $ok; detail = $detail }
}
function Add-Probe([string]$name, [bool]$ok, [string]$detail) {
    # Probes are informational: they never fail the verdict.
    $script:probes += @{ name = $name; ok = $ok; detail = $detail }
}
function Add-Check([string]$line, [string]$name, [string]$verdict, [string]$detail) {
    $script:checks += @{ line = $line; name = $name; verdict = $verdict; detail = $detail }
    if ($verdict -eq 'FAIL') { $script:nFail++ }
    if ($verdict -eq 'SKIP') { $script:nSkip++ }
    Write-Host ("[VERIFY-{0}] {1} {2} {3}" -f $verdict, $line, $name, $detail)
}
function Short([string]$s, [int]$n) {
    if (-not $s) { return '' }
    $t = $s -replace '\s+', ' '
    if ($t.Length -gt $n) { return $t.Substring(0, $n) + '...' }
    return $t
}

if (-not $WorkDir) {
    $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ('p46v-' + $PID)
    $autoWork = $true
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$logsDir = Join-Path $env:LOCALAPPDATA 'SudoStudio\logs'

try {
    # -- 0. manifest ------------------------------------------------------------
    $mf = $null
    $mfPath = Join-Path $InstallDir 'build-manifest.json'
    try {
        if (-not (Test-Path $mfPath)) { throw 'missing' }
        $mf = Get-Content $mfPath -Raw | ConvertFrom-Json
        if (-not $mf.version -or -not $mf.date -or -not $mf.sudo_studio_commit) { throw 'incomplete' }
        Add-File 'build-manifest.json' $true ("commit=" + $mf.sudo_studio_commit)
    } catch {
        Add-File 'build-manifest.json' $false $_.Exception.Message
    }

    # -- 0b. hashed files (P36b: manifest vs installed files) -------------------
    if ($mf -and $mf.files) {
        foreach ($prop in $mf.files.PSObject.Properties) {
            $rel = $prop.Name
            $want = [string]$prop.Value
            $p = Join-Path $InstallDir $rel
            try {
                if (-not (Test-Path $p)) { throw 'missing file' }
                $actual = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
                if ($actual -ne $want.ToLower()) { throw 'sha256 mismatch' }
                Add-File $rel $true ('sha256 ok ' + $actual.Substring(0, 12) + '...')
            } catch {
                Add-File $rel $false $_.Exception.Message
            }
        }
    } else {
        Add-File '(manifest files block)' $false 'no files block to verify'
    }

    # -- 0c. structure + branding (compat) --------------------------------------
    foreach ($rel in @('SudoStudio.exe', 'backend.exe', 'runtime.exe', 'start.bat',
            'launch_hidden.vbs', 'verify-installed.ps1',
            'extensions\sudo-ai\package.json', 'extensions\sudo-ai\extension.js',
            'sudo-agent\src\server.js', 'resources\app\product.json')) {
        Add-File $rel (Test-Path (Join-Path $InstallDir $rel)) 'presence'
    }
    try {
        $pj0 = Get-Content (Join-Path $InstallDir 'resources\app\product.json') -Raw | ConvertFrom-Json
        Add-File 'brand:product.json nameShort' ($pj0.nameShort -eq 'Sudo Studio') ([string]$pj0.nameShort)
    } catch {
        Add-File 'brand:product.json nameShort' $false $_.Exception.Message
    }
    try {
        $lp0 = Get-Content (Join-Path $InstallDir 'extensions\sudo-ai\package.json') -Raw | ConvertFrom-Json
        $cid0 = @($lp0.contributes.viewsContainers.activitybar)[0].id
        Add-File 'brand:extension container' ($cid0 -eq 'sudo-studio') ([string]$cid0)
    } catch {
        Add-File 'brand:extension container' $false $_.Exception.Message
    }

    # -- 0d. probes (informational: up/down only) -------------------------------
    try {
        $b = Invoke-RestMethod 'http://127.0.0.1:5000/api/system/health' -TimeoutSec 3
        $bs = 'up'
        if ($b.status) { $bs = [string]$b.status } elseif ($b.ok) { $bs = [string]$b.ok }
        Add-Probe 'backend-5000' $true $bs
    } catch {
        Add-Probe 'backend-5000' $false 'not running (start the app first)'
    }
    try {
        $r = Invoke-RestMethod 'http://127.0.0.1:6000/health' -TimeoutSec 3
        $rs = 'up'
        if ($r.status) { $rs = [string]$r.status }
        Add-Probe 'runtime-6000' $true $rs
    } catch {
        Add-Probe 'runtime-6000' $false 'not running (start the app first)'
    }
    $perUser = Join-Path $env:LOCALAPPDATA 'SudoStudio'
    Add-Probe 'per-user-dir' (Test-Path $perUser) $perUser

    # == P46-L1: backend.exe --selftest (every require() resolves) =============
    try {
        $beExe = Join-Path $InstallDir 'backend.exe'
        if (-not (Test-Path $beExe)) { throw 'backend.exe missing' }
        $stOut = Join-Path $WorkDir 'selftest.txt'
        $stErr = Join-Path $WorkDir 'selftest-err.txt'
        $sp = Start-Process -FilePath $beExe -ArgumentList '--selftest' -WorkingDirectory $InstallDir -NoNewWindow -RedirectStandardOutput $stOut -RedirectStandardError $stErr -Wait -PassThru
        $st = ''
        if (Test-Path $stOut) { $st = Get-Content $stOut -Raw }
        if ($sp.ExitCode -ne 0) { throw ('exit=' + $sp.ExitCode + ' ' + (Short $st 160)) }
        if ($st -notmatch 'SELFTEST PASS') { throw 'no SELFTEST PASS line' }
        $first = ''
        if ($st -match 'SELFTEST: [^\r\n]*') { $first = $Matches[0] }
        Add-Check 'P46-1' 'selftest' 'PASS' $first
    } catch { Add-Check 'P46-1' 'selftest' 'FAIL' (Short $_.Exception.Message 200) }

    # == P46-L2: agent server from the installed path + handshake ==============
    try {
        $serverJs = Join-Path $InstallDir 'sudo-agent\src\server.js'
        $prodExe = Join-Path $InstallDir 'SudoStudio.exe'
        if (-not (Test-Path $serverJs)) { throw 'server.js missing' }
        if (-not (Test-Path $prodExe)) { throw 'SudoStudio.exe missing' }
        $token = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:SUDO_AGENT_TOKEN = $token
        $env:SUDO_AGENT_PORT = '0'
        $env:SUDO_AGENT_PROVIDER = '{}'
        $ao = Join-Path $WorkDir 'agent-stdout.txt'
        $ae = Join-Path $WorkDir 'agent-stderr.txt'
        if (Test-Path $ao) { Remove-Item $ao -Force }
        $ap = Start-Process -FilePath $prodExe -ArgumentList "`"$serverJs`"" -NoNewWindow -RedirectStandardOutput $ao -RedirectStandardError $ae -PassThru
        try {
            $hs = $null
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline -and -not $hs) {
                Start-Sleep -Seconds 2
                if (Test-Path $ao) { $hs = Select-String -Path $ao -Pattern '^\{"ready":true' | Select-Object -First 1 }
            }
            if (-not $hs) { throw 'no handshake on stdout within 60s (MODULE_NOT_FOUND?)' }
            $port = ($hs.Line | ConvertFrom-Json).port
            $hr = Invoke-WebRequest ("http://127.0.0.1:{0}/health" -f $port) -TimeoutSec 10 -UseBasicParsing -Headers @{ Authorization = ("Bearer {0}" -f $token) }
            if (($hr.Content | ConvertFrom-Json).ok -ne $true) { throw 'health ok != true' }
            Add-Check 'P46-2' 'agent-handshake' 'PASS' ("port={0}" -f $port)
        } finally {
            try { Stop-Process -Id $ap.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch { Add-Check 'P46-2' 'agent-handshake' 'FAIL' (Short $_.Exception.Message 200) }
    finally {
        $env:ELECTRON_RUN_AS_NODE = $null
        $env:SUDO_AGENT_TOKEN = $null
        $env:SUDO_AGENT_PORT = $null
        $env:SUDO_AGENT_PROVIDER = $null
    }

    # == P46-L3: editor 30 s on temp user-data-dir + exthost/renderer logs ======
    if (-not $Full) {
        Add-Check 'P46-3' 'editor-exthost-logs' 'SKIP' 'needs -Full (launches the editor)'
    } else {
        try {
            $prodExe = Join-Path $InstallDir 'SudoStudio.exe'
            $masterExt = Join-Path $InstallDir 'extensions\sudo-ai'
            if (-not (Test-Path $prodExe)) { throw 'SudoStudio.exe missing' }
            if (-not (Test-Path (Join-Path $masterExt 'package.json'))) { throw 'shipped extension missing' }
            $liveParent = Join-Path $WorkDir 'live-ext'
            $udata = Join-Path $WorkDir 'udata'
            foreach ($d in @($liveParent, $udata)) {
                if (Test-Path $d) { Remove-Item $d -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $d | Out-Null
            }
            Copy-Item $masterExt (Join-Path $liveParent 'sudo-ai') -Recurse -Force
            $ep = Start-Process -FilePath $prodExe -ArgumentList "--extensions-dir=`"$liveParent`"", "--user-data-dir=`"$udata`"", '--new-window', '--disable-gpu' -PassThru
            try {
                Start-Sleep -Seconds 30
            } finally {
                $killEnd = (Get-Date).AddSeconds(30)
                do {
                    $eds = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                        Where-Object { $_.ExecutablePath -like ($InstallDir + '*') -and $_.Name -eq 'SudoStudio.exe' })
                    foreach ($e in $eds) {
                        try { Stop-Process -Id $e.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
                    }
                    if ($eds.Count -eq 0) { break }
                    Start-Sleep -Seconds 2
                } while ((Get-Date) -lt $killEnd)
            }
            $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ExecutablePath -like ($InstallDir + '*') -and $_.Name -eq 'SudoStudio.exe' })
            if ($left.Count -gt 0) { throw ($left.Count.ToString() + ' editor process(es) refuse to die') }
            $logFiles = @(Get-ChildItem (Join-Path $udata 'logs') -Recurse -Filter '*.log' -File -ErrorAction SilentlyContinue)
            if ($logFiles.Count -eq 0) { throw 'editor produced no logs under the temp user-data-dir' }
            $hits = @()
            $nLines = 0
            foreach ($lf in $logFiles) {
                try { $lines = Get-Content $lf.FullName -ErrorAction Stop } catch { continue }
                foreach ($ln in $lines) {
                    $nLines++
                    if ($ln -match 'must be of type') { $hits += ('must-be-of-type: ' + (Short $ln 180)); continue }
                    # P42(5): the proven container rejection is logged as a
                    # WARNING ("View container ... does not exist"), so warn
                    # context counts for that pattern; icon stays error-only.
                    if ($ln -match '(?i)\berror\b|\bexception\b|\bfailed\b|\bwarning\b|\bwarn\b|\bERR\b') {
                        if ($ln -match 'does not exist') { $hits += ('does-not-exist: ' + (Short $ln 180)) }
                    }
                    if (($ln -match '(?i)\berror\b|\bexception\b|\bfailed\b|\bERR\b') -and ($ln -match '(?i)\bicon\b')) { $hits += ('icon: ' + (Short $ln 180)) }
                    if ($hits.Count -ge 5) { break }
                }
                if ($hits.Count -ge 5) { break }
            }
            if ($hits.Count -gt 0) { throw ('registration errors: ' + ($hits -join ' / ')) }
            Add-Check 'P46-3' 'editor-exthost-logs' 'PASS' ("{0} logs, {1} lines, 0 registration errors" -f $logFiles.Count, $nLines)
        } catch { Add-Check 'P46-3' 'editor-exthost-logs' 'FAIL' (Short $_.Exception.Message 300) }
    }

    # == P46-L4: every panel renders (no blank, no console error) ===============
    if (-not $Full) {
        Add-Check 'P46-4' 'panels' 'SKIP' 'needs -Full (renders 15 panels)'
    } else {
        try {
            $ps = $PanelScript
            if (-not $ps) { $ps = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts\ci\panel-render-test.js' }
            if (-not (Test-Path $ps)) { $ps = Join-Path $PSScriptRoot 'panel-render-test.js' }
            if (-not (Test-Path $ps)) { throw 'SKIP:panel-render-test.js not available (CI checkout only)' }
            $node = Get-Command node -ErrorAction SilentlyContinue
            if (-not $node) { throw 'SKIP:node not found on PATH' }
            $liveParent = Join-Path $WorkDir 'live-ext'
            if (-not (Test-Path (Join-Path $liveParent 'sudo-ai\package.json'))) {
                if (Test-Path $liveParent) { Remove-Item $liveParent -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $liveParent | Out-Null
                Copy-Item (Join-Path $InstallDir 'extensions\sudo-ai') (Join-Path $liveParent 'sudo-ai') -Recurse -Force
            }
            $pudata = Join-Path $WorkDir 'pudata'
            $pout = Join-Path $WorkDir 'panels'
            foreach ($d in @($pudata, $pout)) {
                if (Test-Path $d) { Remove-Item $d -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $d | Out-Null
            }
            $np = Start-Process -FilePath 'node' -ArgumentList "`"$ps`"", '--install-dir', "`"$InstallDir`"", '--live-dir', "`"$liveParent`"", '--user-data-dir', "`"$pudata`"", '--out-dir', "`"$pout`"", '--label', 'p46' -NoNewWindow -Wait -PassThru
            $rep = Join-Path $pout 'report-p46.json'
            $detail = 'exit=' + $np.ExitCode
            if (Test-Path $rep) {
                $rj = Get-Content $rep -Raw | ConvertFrom-Json
                $np2 = @($rj.panels).Count
                $ok2 = @(@($rj.panels) | Where-Object { $_.pass }).Count
                $detail = ("{0}/{1} panels, exthostErrs={2}, pristineDiffs={3}" -f $ok2, $np2, @($rj.exthostErrs).Count, $rj.pristine.count)
            }
            if ($np.ExitCode -ne 0) { throw $detail }
            Add-Check 'P46-4' 'panels' 'PASS' $detail
        } catch {
            $m = $_.Exception.Message
            if ($m -like 'SKIP:*') { Add-Check 'P46-4' 'panels' 'SKIP' $m.Substring(5) }
            else { Add-Check 'P46-4' 'panels' 'FAIL' (Short $m 250) }
        }
    }

    # == P46-L5: branding (name + robot container + old logo absent) ============
    try {
        $parts = @()
        $pj = Get-Content (Join-Path $InstallDir 'resources\app\product.json') -Raw | ConvertFrom-Json
        if ($pj.nameShort -ne 'Sudo Studio') { throw ('nameShort=' + $pj.nameShort) }
        if (-not $pj.commit -or -not $pj.date) { throw 'product.json lacks commit/date (About dialog)' }
        $cfgV = $pj.configurationDefaults
        if (-not $cfgV -or $cfgV.'window.commandCenter' -ne $false) { throw 'configurationDefaults window.commandCenter != false' }
        if ($cfgV.'window.title' -ne '${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}') { throw 'configurationDefaults window.title != classic template' }
        $parts += 'product.json'
        $ep5 = Get-Content (Join-Path $InstallDir 'extensions\sudo-ai\package.json') -Raw | ConvertFrom-Json
        $bar = @($ep5.contributes.viewsContainers.activitybar)
        if ($bar.Count -ne 1 -or $bar[0].id -ne 'sudo-studio') { throw 'activitybar container != [sudo-studio]' }
        $sIcon = $bar[0].icon
        if ($sIcon -isnot [string]) { throw 'container icon must be a string path (P42: object form rejected by the editor)' }
        if (-not (Test-Path (Join-Path $InstallDir ('extensions\sudo-ai\' + ($sIcon -replace '/', '\'))))) { throw ('container icon missing: ' + $sIcon) }
        $vs = $ep5.contributes.views
        if (-not $vs.'sudo-studio' -or @($vs.'sudo-studio').Count -lt 1) { throw 'no views in sudo-studio' }
        if ($vs.explorer) { throw 'views still under explorer' }
        $parts += ("container views=" + @($vs.'sudo-studio').Count)
        $a = [System.IO.File]::ReadAllBytes((Join-Path $InstallDir 'resources\app\out\media\code-icon.svg'))
        $b = [System.IO.File]::ReadAllBytes((Join-Path $InstallDir 'resources\sudo-icon.svg'))
        $same = ($a.Length -eq $b.Length)
        if ($same) { for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { $same = $false; break } } }
        if (-not $same) { throw 'code-icon.svg differs from sudo-icon.svg' }
        $parts += 'titlebar-svg'
        $oldSvgHash = '88bb8eb6c643403be96d1d218a564c28a05f3b31368aad10c0db0bc1efbed75f'
        $oldSvg = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension.ToLower() -eq '.svg' } |
            Where-Object {
                try { (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() -eq $oldSvgHash }
                catch { $false }
            })
        if ($oldSvg.Count -gt 0) { throw ('old-logo fingerprint svg: ' + $oldSvg[0].FullName.Substring($InstallDir.Length)) }
        if ($Full) {
            $oldTextExts = @('.js', '.json', '.css', '.html', '.svg', '.xml', '.ts', '.nls', '.txt', '.md')
            $oldHits = @(Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $oldTextExts -contains $_.Extension.ToLower() } |
                Where-Object { $_.FullName -notmatch 'node_modules' } |
                Where-Object { $_.Length -lt 64MB } |
                Where-Object {
                    try {
                        $t = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
                        (($t -match 'path6008') -and ($t -match 'Gradient_1')) -or
                        (($t -match '#78AEED') -and ($t -match '#1D6BCA') -and ($t -match 'linearGradient'))
                    } catch { $false }
                })
            if ($oldHits.Count -gt 0) { throw ('old-logo markers in: ' + (($oldHits | Select-Object -First 3 | ForEach-Object { $_.FullName.Substring($InstallDir.Length) }) -join ', ')) }
            $parts += 'oldlogo-deep'
        } else {
            $parts += 'oldlogo-fingerprint-only'
        }
        if ($ExeChecker -and (Test-Path $ExeChecker)) {
            & $ExeChecker -ExePath (Join-Path $InstallDir 'SudoStudio.exe')
            if ($LASTEXITCODE -ne 0) { throw 'exe icon checker exit 1' }
            $parts += 'exe-icon'
        } else {
            $parts += 'exe-icon-skipped'
        }
        Add-Check 'P46-5' 'branding' 'PASS' ($parts -join ', ')
    } catch { Add-Check 'P46-5' 'branding' 'FAIL' (Short $_.Exception.Message 250) }

    # == P46-L6: runtime journal header + real n_ctx == requested ===============
    try {
        $jr = Join-Path $logsDir 'runtime.log'
        if (-not (Test-Path $jr)) { throw 'SKIP:runtime.log absent (runtime never ran)' }
        $jt = Get-Content $jr -Raw
        if ($jt -notmatch '# === session start ===') { throw 'no structured session header' }
        if ($jt -notmatch '\d{4}-\d{2}-\d{2}T\S+ \[(INFO|DEBUG|WARNING|ERROR)\] \[runtime\]') { throw 'no P21-shaped line' }
        if (-not $Full) { throw 'SKIP:header OK, n_ctx needs -Full (model load)' }
        try {
            $h = Invoke-RestMethod 'http://127.0.0.1:6000/health' -TimeoutSec 5
            if ($h.status -ne 'healthy') { throw ('status=' + $h.status) }
        } catch {
            throw 'SKIP:runtime not running (start the app or the gate first)'
        }
        $wantCtx = 4096
        try {
            $rl = Invoke-RestMethod 'http://127.0.0.1:6000/reload' -Method Post -Body (@{ n_ctx = $wantCtx } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 30
        } catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode.value__ } catch {}
            if ($code -eq 409) { throw 'SKIP:another model load already in progress (409)' }
            throw ('reload refused: ' + (Short $_.Exception.Message 150))
        }
        $got = $null
        $deadline = (Get-Date).AddSeconds($ModelTimeoutSec)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 15
            try { $m = Invoke-RestMethod 'http://127.0.0.1:6000/models' -TimeoutSec 10 } catch { continue }
            if ($m.loaded -and $m.n_ctx) { $got = $m; break }
        }
        if (-not $got) {
            $ds = ''
            try { $ds = Short ((Invoke-RestMethod 'http://127.0.0.1:6000/models/download-status' -TimeoutSec 10) | ConvertTo-Json -Compress) 120 } catch {}
            throw ('SKIP:model not loaded within ' + $ModelTimeoutSec + 's (network? ' + $ds + ')')
        }
        if ([int]$got.n_ctx -ne $wantCtx) { throw ("real n_ctx={0} != requested {1}" -f $got.n_ctx, $wantCtx) }
        $jt2 = Get-Content $jr -Raw
        if ($jt2 -notmatch '\[GGUF\] n_ctx=4096 \(requested=4096') { throw 'journal lacks [GGUF] n_ctx=4096 (requested=4096 line' }
        Add-Check 'P46-6' 'runtime-journal-nctx' 'PASS' 'header OK, n_ctx=4096 requested=4096 (API + journal)'
    } catch {
        $m6 = $_.Exception.Message
        if ($m6 -like 'SKIP:*') { Add-Check 'P46-6' 'runtime-journal-nctx' 'SKIP' $m6.Substring(5) }
        else { Add-Check 'P46-6' 'runtime-journal-nctx' 'FAIL' (Short $m6 250) }
    }

    # == P46-L7: manifest vs installed files + runtime freshness ================
    try {
        if (-not $mf) { throw 'build-manifest.json unreadable (see files section)' }
        $bad = @()
        foreach ($prop in $mf.files.PSObject.Properties) {
            $p = Join-Path $InstallDir $prop.Name
            try {
                if (-not (Test-Path $p)) { throw 'missing' }
                $ah = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
                if ($ah -ne ([string]$prop.Value).ToLower()) { throw 'sha256 mismatch' }
            } catch { $bad += ($prop.Name + ':' + $_.Exception.Message) }
        }
        if ($bad.Count -gt 0) { throw ('file mismatches: ' + ($bad -join ', ')) }
        $comps = $mf.components
        if (-not $comps -or -not $comps.backend -or -not $comps.runtime -or -not $comps.extension -or -not $comps.agent) { throw 'components block incomplete' }
        foreach ($k in @('backend', 'runtime', 'extension', 'agent')) {
            if ($comps.$k.commit -ne $mf.sudo_studio_commit) { throw ('component commit mismatch: ' + $k) }
        }
        if ($comps.editor.product -ne 'Sudo Studio') { throw 'editor product invalid' }
        $fresh = 'freshness: manifest predates P46 (no touch field)'
        if ($comps.runtime.touch -and $comps.runtime.touch -ne 'unknown' -and $comps.runtime.date) {
            $runDate = [DateTimeOffset]::Parse([string]$comps.runtime.date)
            $touchDate = [DateTimeOffset]::Parse([string]$comps.runtime.touch)
            if ($runDate -lt $touchDate) { throw ("stale runtime: run {0} older than last touch {1}" -f $comps.runtime.date, $comps.runtime.touch) }
            $fresh = ("freshness OK (run {0} >= touch {1})" -f $comps.runtime.date, $comps.runtime.touch)
        }
        Add-Check 'P46-7' 'manifest' 'PASS' ("commit={0} files={1} {2}" -f $mf.sudo_studio_commit, @($mf.files.PSObject.Properties).Count, $fresh)
    } catch { Add-Check 'P46-7' 'manifest' 'FAIL' (Short $_.Exception.Message 250) }

    # == P46-L8: uninstall (never on the owner PC) ==============================
    Add-Check 'P46-8' 'uninstall-clean' 'SKIP' 'destructive, CI gate only (see p46-gate.ps1)'
}
catch {
    Add-Check 'P46-0' 'verify-aborted' 'FAIL' (Short $_.Exception.Message 200)
}

# == P46-L9: result integrity (written file holds no secret) ===================
$verdict = 'PASS'
if ($nFail -gt 0) { $verdict = 'FAIL' }
$ver = 'unknown'
if ($mf) { $ver = [string]$mf.version }
$com = 'unknown'
if ($mf) { $com = [string]$mf.sudo_studio_commit }
$draft = [ordered]@{
    app     = 'Sudo Studio'
    version = $ver
    commit  = $com
    date    = (Get-Date -Format 'o')
    install = $InstallDir
    full    = [bool]$Full
    files   = $files
    probes  = $probes
    checks  = $checks
    fail    = $nFail
    skip    = $nSkip
    verdict = $verdict
}
$draftJson = ($draft | ConvertTo-Json -Depth 6)
$secretHit = $false
foreach ($pat in @('ghp_', 'gho_', 'github_pat_', 'xox[baprs]-', 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY', '(?i)bearer\s+[A-Za-z0-9\-._~+/=]{8,}')) {
    if ($draftJson -match $pat) { $secretHit = $true; break }
}
if ($secretHit) {
    Add-Check 'P46-9' 'result-integrity' 'FAIL' 'secret pattern detected - result NOT written'
    Write-Error 'verify-installed: REFUSING to write verify-result.json (secret pattern detected)'
} else {
    Add-Check 'P46-9' 'result-integrity' 'PASS' 'no secret pattern in result'
    $final = [ordered]@{
        app     = 'Sudo Studio'
        version = $ver
        commit  = $com
        date    = (Get-Date -Format 'o')
        install = $InstallDir
        full    = [bool]$Full
        files   = $files
        probes  = $probes
        checks  = $checks
        fail    = $nFail
        skip    = $nSkip
        verdict = $verdict
    }
    if (-not $OutFile) { $OutFile = Join-Path (Get-Location).Path 'verify-result.json' }
    [System.IO.File]::WriteAllText($OutFile, ($final | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}
if ($autoWork) {
    try { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}
if ($nFail -gt 0) { $verdict = 'FAIL' }
Write-Host ("verify-installed: {0} (checks={1} fail={2} skip={3}) -> {4}" -f $verdict, $checks.Count, $nFail, $nSkip, $OutFile)
if ($verdict -eq 'FAIL') { exit 1 }
