#Requires -Version 5.1
<#
.SYNOPSIS
    Sudo Studio P36(d) - verify an INSTALLED package. User-runnable on any PC.
.DESCRIPTION
    Hashes every file listed in build-manifest.json, checks the install
    structure and branding, then probes the backend/runtime HTTP endpoints
    IF they are running (informational only, never a failure).
    Writes verify-result.json holding versions and hashes ONLY - never any
    secret, key, or project content.
    Never writes inside the install dir (P35c): the result goes to the
    current directory unless -OutFile is given.
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\me\AppData\Local\Programs\SudoStudio\verify-installed.ps1"
#>
param(
    [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$files = @()
$probes = @()
$nFail = 0

function Add-File([string]$rel, [bool]$ok, [string]$detail) {
    $script:files += @{ path = $rel; ok = $ok; detail = $detail }
    if (-not $ok) { $script:nFail++ }
}
function Add-Probe([string]$name, [bool]$ok, [string]$detail) {
    # Probes are informational: they never fail the verdict.
    $script:probes += @{ name = $name; ok = $ok; detail = $detail }
}

# -- 1. manifest ------------------------------------------------------------
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

# -- 2. hashed files (P36b: manifest vs installed files) ---------------------
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

# -- 3. structure + branding --------------------------------------------------
foreach ($rel in @('SudoStudio.exe', 'backend.exe', 'runtime.exe', 'start.bat',
        'launch_hidden.vbs', 'verify-installed.ps1',
        'extensions\sudo-ai\package.json', 'extensions\sudo-ai\extension.js',
        'sudo-agent\src\server.js', 'resources\app\product.json')) {
    Add-File $rel (Test-Path (Join-Path $InstallDir $rel)) 'presence'
}
try {
    $pj = Get-Content (Join-Path $InstallDir 'resources\app\product.json') -Raw | ConvertFrom-Json
    $okBrand = ($pj.name -eq 'Sudo Studio')
    Add-File 'brand:product.json name' $okBrand ([string]$pj.name)
} catch {
    Add-File 'brand:product.json name' $false $_.Exception.Message
}
try {
    $lp = Get-Content (Join-Path $InstallDir 'extensions\sudo-ai\package.json') -Raw | ConvertFrom-Json
    $cid = @($lp.contributes.viewsContainers.activitybar)[0].id
    Add-File 'brand:extension container' ($cid -eq 'sudo-studio') ([string]$cid)
} catch {
    Add-File 'brand:extension container' $false $_.Exception.Message
}

# -- 4. probes (informational: up/down only) ----------------------------------
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

# -- 5. result -----------------------------------------------------------------
$verdict = 'PASS'
if ($nFail -gt 0) { $verdict = 'FAIL' }
$ver = 'unknown'
if ($mf) { $ver = [string]$mf.version }
$com = 'unknown'
if ($mf) { $com = [string]$mf.sudo_studio_commit }
$result = [ordered]@{
    app      = 'Sudo Studio'
    version  = $ver
    commit   = $com
    date     = (Get-Date -Format 'o')
    install  = $InstallDir
    files    = $files
    probes   = $probes
    verdict  = $verdict
}
if (-not $OutFile) { $OutFile = Join-Path (Get-Location).Path 'verify-result.json' }
$result | ConvertTo-Json -Depth 6 | Set-Content $OutFile -Encoding UTF8
Write-Host ("verify-installed: {0} (files={1} probes={2}) -> {3}" -f $verdict, $files.Count, $probes.Count, $OutFile)
if ($verdict -eq 'FAIL') { exit 1 }
