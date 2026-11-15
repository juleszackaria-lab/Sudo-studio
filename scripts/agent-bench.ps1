# SUDO STUDIO - P65-C : banc d'essai de l'agent (Windows / PowerShell).
#
# Deux passes, dans cet ordre :
#   1. PASSE DETERMINISTE (faux fournisseur) : 38 taches sur trois projets
#      (Next.js, Flutter, Python), verification automatique sur le disque.
#      Aucun modele, aucun reseau, aucun artefact.
#   2. PASSE REELLE (optionnelle) : -Model <fichier.gguf|id> rejoue les MEMES
#      taches contre le modele charge dans le runtime local. Seule passe qui
#      fournit des jetons/seconde et une vraie note de qualite.
#
# Usage :
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-bench.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-bench.ps1 `
#     -Model qwen2.5-coder-1.5b-q4_k_m.gguf
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-bench.ps1 `
#     -Model <id> -Url http://127.0.0.1:6000 -Only M
#
# Code retour : 0 = tout ce qui a ete demande a reussi, 1 = echec,
#               2 = modele demande mais runtime injoignable (NON MESURE).
# ASCII only.

[CmdletBinding()]
param(
  [string]$Model = '',
  [string]$Url = 'http://127.0.0.1:6000',
  [string]$Only = '',
  [string]$OutDir = 'bench-results'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$bench = Join-Path $PSScriptRoot 'ci\agent-bench.js'
if (-not (Test-Path $bench)) { Write-Host "[FAIL] banc introuvable : $bench"; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '[FAIL] node absent du PATH'; exit 1 }

$onlyArg = @()
if ($Only) { $onlyArg = @('--only', $Only) }

Write-Host '=== PASSE 1/2 : deterministe (faux fournisseur, sans modele) ==='
$rep1 = Join-Path $OutDir 'agent-bench-report.json'
$out1 = & node $bench @onlyArg --json $rep1 2>&1 | Out-String
Write-Host $out1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] la passe deterministe est rouge (code $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}
$ligne = ($out1 -split "`n" | Where-Object { $_ -match '^TOTAL :' } | Select-Object -Last 1)
Write-Host ("--- " + $(if ($ligne) { $ligne.Trim() } else { 'aucune ligne TOTAL' })) -ForegroundColor Cyan

if (-not $Model) {
  Write-Host ''
  Write-Host 'Passe 2 NON DEMANDEE : aucun modele fourni (-Model).'
  Write-Host "Jetons/seconde, RAM du runtime et qualite reelle d'un modele restent NON MESURES."
  exit 0
}

Write-Host ''
Write-Host ("=== PASSE 2/2 : modele reel '" + $Model + "' via " + $Url + " ===")
$models = $null
try {
  $models = Invoke-RestMethod -Uri ($Url + '/v1/models') -TimeoutSec 5
} catch {
  Write-Host ("[NON MESURE] runtime injoignable sur " + $Url + "/v1/models : " + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '  Demarrer le runtime du produit avec ce modele charge, puis relancer.'
  exit 2
}
Write-Host ('runtime joignable ; modeles annonces : ' + ($models | ConvertTo-Json -Compress -Depth 4))

$rep2 = Join-Path $OutDir 'agent-bench-reel.json'
& node $bench @onlyArg --real $Url --model $Model --json $rep2
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] la passe reelle est rouge (code $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host ("Rapports : " + $rep1 + ' (deterministe) et ' + $rep2 + ' (reel).')
exit 0
