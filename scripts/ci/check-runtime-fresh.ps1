# P33(a): refuse a stale runtime.exe artifact before packaging.
# Compares the 02 workflow run creation date (via the GitHub API) with the
# last commit that touched the runtime sources (git log on backend/runtime).
# Exit 0 = fresh (or printed PASS line); exit 1 = stale or inconclusive.
# PowerShell 5.1 compatible. ASCII only.
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [string]$Repo = 'juleszackaria-lab/Sudo-studio',
    [string]$RuntimeDir = 'backend/runtime',
    [string]$Token = ''
)
$ErrorActionPreference = 'Stop'

# -- 1. last touch of the runtime sources (committer date + short sha) --
$touchOut = & git -C $SourceDir log -1 --format='%cI|%h' -- $RuntimeDir 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error ("[RUNTIME-FRESH] FAIL: git log failed in {0}: {1}" -f $SourceDir, ($touchOut -join ' '))
    exit 1
}
$touchLine = ($touchOut | Select-Object -First 1).ToString().Trim()
$parts = $touchLine -split '\|'
if ($parts.Count -lt 2) {
    Write-Error ("[RUNTIME-FRESH] FAIL: unexpected git log output: {0}" -f $touchLine)
    exit 1
}
$touchDate = [DateTimeOffset]::Parse($parts[0].Trim())
$touchSha = $parts[1].Trim()
Write-Host ("[RUNTIME-FRESH] last runtime touch: {0} ({1})" -f $parts[0].Trim(), $touchSha)

# -- 2. the 02 run that produced the artifact (GitHub API) --
if (-not $Token) { $Token = $env:GH_TOKEN }
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
$headers = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
if ($Token) { $headers['Authorization'] = ('Bearer ' + $Token) }
try {
    $run = Invoke-RestMethod -Uri ("https://api.github.com/repos/{0}/actions/runs/{1}" -f $Repo, $RunId) -Headers $headers
} catch {
    Write-Error ("[RUNTIME-FRESH] FAIL: API lookup of run {0} failed: {1}" -f $RunId, $_.Exception.Message)
    exit 1
}
$headShort = $run.head_sha
if ($headShort -and $headShort.Length -gt 12) { $headShort = $headShort.Substring(0, 12) }
Write-Host ("[RUNTIME-FRESH] run {0}: conclusion={1} head={2} created={3}" -f $RunId, $run.conclusion, $headShort, $run.created_at)
if ($run.conclusion -ne 'success') {
    Write-Error ("[RUNTIME-FRESH] FAIL: run {0} conclusion is '{1}', not success" -f $RunId, $run.conclusion)
    exit 1
}
$created = [DateTimeOffset]::Parse($run.created_at)

# -- 3. verdict: the run must be NEWER than the last source touch --
if ($created -lt $touchDate) {
    Write-Error ("[RUNTIME-FRESH] FAIL: runtime artifact is STALE (run created {0}, before last runtime-source touch {1} {2}). Re-run workflow 02 first." -f $run.created_at, $parts[0].Trim(), $touchSha)
    exit 1
}
Write-Host ("[RUNTIME-FRESH] PASS: artifact is fresh (run {0} >= last touch {1})" -f $run.created_at, $parts[0].Trim())
exit 0
