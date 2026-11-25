<#
  SUDO STUDIO - P70 partie G : rejoue T1 -> T10 sur la machine Windows de
  l'agent et ecrit un PASS/FAIL avec, pour chaque test, une ligne prouvante.

  Ce que le script rend visible AVANT de tester (bug V5) :
    - le PATH que voit l'agent (registre machine + utilisateur) ;
    - les outils reellement resolus, avec leur chemin complet ;
    - les outils absents, s'il y en a.

  Usage :
      powershell -ExecutionPolicy Bypass -File scripts\ci\agent-p70.ps1
      powershell ... -File scripts\ci\agent-p70.ps1 -Model C:\models\qwen.gguf

  Sortie : code 0 si tous les tests joues passent, 1 sinon. Un test non joue
  (modele absent) est affiche SKIP : jamais compte comme un vert.
#>
param(
    [string]$Model = "",
    [string]$Out = "p70-replay.txt"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# P70 : le produit active le chemin rapide ; on force la meme chose ici.
$env:SUDO_P70_FASTPATH = "1"
if ($Model -ne "") { $env:P70_MODEL = $Model }

function Write-Header($text) {
    Write-Host ""
    Write-Host ("=" * 78)
    Write-Host $text
    Write-Host ("=" * 78)
}

Write-Header "P70 - environnement vu par l agent"

# PATH machine + utilisateur, lu dans le registre (et non herite du processus).
$machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
$user = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @()
foreach ($chunk in @($machine, $user)) {
    if ($chunk) { $entries += ($chunk -split ';' | Where-Object { $_ -ne "" }) }
}
Write-Host ("PATH registre : machine=" + (($machine -split ';') | Where-Object { $_ } ).Count + " entrees, utilisateur=" + (($user -split ';') | Where-Object { $_ }).Count + " entrees")
Write-Host ("PATH effectif de l agent : " + $entries.Count + " entrees")

foreach ($tool in @("node", "npm", "git", "python", "python3", "pip", "where")) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) { Write-Host ("  trouve   : " + $tool + " -> " + $cmd.Source) }
    else { Write-Host ("  ABSENT   : " + $tool) }
}

# Controle negatif du PATH : avec un PATH vide, node DOIT etre absent.
$savedPath = $env:PATH
$env:PATH = "C:\p70-dossier-inexistant"
$neg = Get-Command node -ErrorAction SilentlyContinue
$env:PATH = $savedPath
if ($neg) {
    Write-Host "CONTROLE NEGATIF PATH : ECHEC (node trouve malgre un PATH vide)"
    $negOk = $false
} else {
    Write-Host "CONTROLE NEGATIF PATH : OK (node introuvable avec un PATH vide)"
    $negOk = $true
}

Write-Header "P70 - T1 a T10"

$log = & node "scripts/ci/p70-replay.js" 2>&1 | Tee-Object -FilePath $Out
$log | ForEach-Object { Write-Host $_ }

$pass = ($log | Select-String -Pattern "^T\d+ PASS").Count
$fail = ($log | Select-String -Pattern "^T\d+ FAIL").Count
$skip = ($log | Select-String -Pattern "^T\d+ SKIP").Count

Write-Header "P70 - resultat"
Write-Host ("PASS=" + $pass + " FAIL=" + $fail + " SKIP=" + $skip)
Write-Host ("Journal complet : " + (Resolve-Path $Out))

if (-not $negOk) {
    Write-Host "RESULTAT : FAIL (controle negatif du PATH en echec)"
    exit 1
}
if ($fail -gt 0) {
    Write-Host "RESULTAT : FAIL"
    exit 1
}
Write-Host "RESULTAT : PASS"
exit 0
