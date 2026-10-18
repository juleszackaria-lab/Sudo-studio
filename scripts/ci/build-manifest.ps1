# P29c4: per-component integrity manifest + pack-time refusal + P20 brand gate.
# Verifies every component of build\SudoStudio, REFUSES (exit 1) on any
# mismatch, and writes build-manifest.json. Supersedes the inline P29-P3.
#
#   components: backend + runtime commits come from the 01/02 run API records
#     (head_sha + created_at) and MUST equal -SudoStudioCommit (the source
#     checkout 03 builds from); extension + agent ship from that same checkout
#     (commit by construction, content verified); editor records its version.
#   brand (P20 in the final package): product.json name, title-bar svg bytes,
#     robot activity icon, exe icon (via check-exe-icon.ps1). Any failure
#     refuses the package: a wrong brand must never reach the installer.
#
# Exit 0 = manifest written ([MANIFEST] PASS line); exit 1 = refused.
# PowerShell 5.1 compatible. ASCII only.
param(
    [Parameter(Mandatory = $true)][string]$BuildDir,
    [Parameter(Mandatory = $true)][string]$SudoStudioCommit,
    [Parameter(Mandatory = $true)][string]$BackendRunId,
    [Parameter(Mandatory = $true)][string]$RuntimeRunId,
    [string]$SourceDir = '_sudo-studio-source',
    [string]$PackagerCommit = '',
    [string]$EditorVersion = '1.97.2',
    [string]$Repo = 'juleszackaria-lab/Sudo-studio',
    [string]$Token = ''
)
$ErrorActionPreference = 'Stop'
function Deny([string]$why) { Write-Error ("[MANIFEST] FAIL: {0}" -f $why); exit 1 }

if (-not (Test-Path $BuildDir)) { Deny ("build dir not found: {0}" -f $BuildDir) }
if (-not $PackagerCommit) { $PackagerCommit = $env:GITHUB_SHA }
if (-not $PackagerCommit) { $PackagerCommit = 'unknown' }
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -- 1. required component files -------------------------------------------------
$need = @('backend.exe', 'runtime.exe', 'SudoStudio.exe', 'start.bat',
    'extensions\sudo-ai\package.json', 'extensions\sudo-ai\extension.js',
    'sudo-agent\src\server.js', 'resources\app\product.json',
    'resources\app\out\media\code-icon.svg', 'resources\sudo-icon.svg',
    'resources\icon.ico', 'extensions\sudo-ai\resources\sudo-robot.svg')
foreach ($f in $need) {
    if (-not (Test-Path (Join-Path $BuildDir $f))) { Deny ("component file missing: {0}" -f $f) }
}
Write-Host '[MANIFEST] 12/12 component files present'

# -- 2. backend + runtime commits must match the source checkout -----------------
if (-not $Token) { $Token = $env:GH_TOKEN }
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
$headers = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
if ($Token) { $headers['Authorization'] = ('Bearer ' + $Token) }
function Run-Info([string]$runId, [string]$what) {
    try {
        $r = Invoke-RestMethod -Uri ("https://api.github.com/repos/{0}/actions/runs/{1}" -f $Repo, $runId) -Headers $headers
    } catch { Deny ("API lookup of {0} run {1} failed: {2}" -f $what, $runId, $_.Exception.Message) }
    if ($r.conclusion -ne 'success') { Deny ("{0} run {1} conclusion is '{2}', not success" -f $what, $runId, $r.conclusion) }
    if ($r.head_sha -ne $SudoStudioCommit) {
        Deny ("{0} run {1} built commit {2}, expected {3} (re-dispatch 01/02 after the last merge)" -f $what, $runId, $r.head_sha, $SudoStudioCommit)
    }
    Write-Host ("[MANIFEST] {0}: run {1} commit {2} date {3}" -f $what, $runId, $r.head_sha, $r.created_at)
    return $r
}
$beRun = Run-Info $BackendRunId 'backend'
$rtRun = Run-Info $RuntimeRunId 'runtime'

# -- 3. P20 brand in the FINAL package --------------------------------------------
$pj = Get-Content (Join-Path $BuildDir 'resources\app\product.json') -Raw | ConvertFrom-Json
if ($pj.nameShort -ne 'Sudo Studio') { Deny ('product.json nameShort=' + $pj.nameShort) }
$a = [System.IO.File]::ReadAllBytes((Join-Path $BuildDir 'resources\app\out\media\code-icon.svg'))
$b = [System.IO.File]::ReadAllBytes((Join-Path $BuildDir 'resources\sudo-icon.svg'))
$same = ($a.Length -eq $b.Length)
if ($same) { for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { $same = $false; break } } }
if (-not $same) { Deny 'code-icon.svg differs from sudo-icon.svg in the final package' }
$ep = Get-Content (Join-Path $BuildDir 'extensions\sudo-ai\package.json') -Raw | ConvertFrom-Json
$bar = @($ep.contributes.viewsContainers.activitybar)
if ($bar.Count -ne 1 -or $bar[0].id -ne 'sudo-studio') { Deny 'extension has no single sudo-studio activity container' }
if (-not $bar[0].icon.light -or -not $bar[0].icon.dark) { Deny 'activity container icon missing (light/dark)' }
$extViews = @($ep.contributes.views.'sudo-studio').Count
$extVer = $ep.version
if ($ep.contributes.views.explorer) { Deny 'extension views still under explorer' }
Write-Host ("[MANIFEST] brand: product.json OK, logo svg bytes match, robot container views={0}" -f $extViews)
$exeCheck = Join-Path $scriptDir 'check-exe-icon.ps1'
if (-not (Test-Path $exeCheck)) { Deny 'exe icon checker missing next to this script' }
& $exeCheck -ExePath (Join-Path $BuildDir 'SudoStudio.exe')
if ($LASTEXITCODE -ne 0) { Deny 'exe icon gate failed (see [EXE-ICON] lines above)' }

# -- 4. hashes + version + write ----------------------------------------------------
function Sha-Of([string]$rel) {
    return (Get-FileHash (Join-Path $BuildDir $rel) -Algorithm SHA256).Hash.ToLower()
}
$issVer = '5.0.0'
try {
    $m = Select-String -Path (Join-Path $SourceDir 'installer.iss') -Pattern '#define MyAppVersion\s+"([^"]+)"'
    if ($m) { $issVer = $m.Matches[0].Groups[1].Value }
} catch {}
$mf = [ordered]@{
    version            = $issVer
    date               = (Get-Date).ToUniversalTime().ToString('o')
    sudo_studio_commit = $SudoStudioCommit
    packager_commit    = $PackagerCommit
    files              = [ordered]@{
        'backend.exe'                       = Sha-Of 'backend.exe'
        'runtime.exe'                       = Sha-Of 'runtime.exe'
        'SudoStudio.exe'                    = Sha-Of 'SudoStudio.exe'
        'start.bat'                         = Sha-Of 'start.bat'
        'sudo-agent\src\server.js'          = Sha-Of 'sudo-agent\src\server.js'
        'resources\app\product.json'        = Sha-Of 'resources\app\product.json'
    }
    components         = [ordered]@{
        backend   = [ordered]@{ commit = $beRun.head_sha; date = $beRun.created_at; run_id = $BackendRunId; sha256 = Sha-Of 'backend.exe' }
        runtime   = [ordered]@{ commit = $rtRun.head_sha; date = $rtRun.created_at; run_id = $RuntimeRunId; sha256 = Sha-Of 'runtime.exe' }
        editor    = [ordered]@{ version = $EditorVersion; product = $pj.nameShort; sha256 = Sha-Of 'SudoStudio.exe' }
        extension = [ordered]@{ commit = $SudoStudioCommit; version = $extVer; container = 'sudo-studio'; views = $extViews }
        agent     = [ordered]@{ commit = $SudoStudioCommit; path = 'sudo-agent\src\server.js'; sha256 = Sha-Of 'sudo-agent\src\server.js' }
    }
    brand              = [ordered]@{
        productName  = 'Sudo Studio'
        logoSvgMatch = $true
        robotIcon    = 'extensions\sudo-ai\resources\sudo-robot.svg'
        exeIcon      = 'PASS'
    }
}
($mf | ConvertTo-Json -Depth 8) | Set-Content (Join-Path $BuildDir 'build-manifest.json') -Encoding UTF8
Write-Host ("[MANIFEST] PASS: {0} ss={1} backend=run{2} runtime=run{3} brand=P20-OK" -f $issVer, $SudoStudioCommit, $BackendRunId, $RuntimeRunId)
exit 0
