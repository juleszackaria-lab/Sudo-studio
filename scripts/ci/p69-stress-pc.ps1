<#
  P69-A3 : serie de stress sur MON PC (Windows), avec la RAM limitee.

  Ce script ne remplace pas la CI : il refait la meme serie la ou le plantage
  a ete observe (Windows, RAM serree, threads limites), et ecrit un rapport
  lisible. Il ne suppose aucun droit administrateur.

  Ce qu'il fait, dans l'ordre :
    1. releve machine (CPU, RAM totale/libre, version de Windows) ;
    2. lance le runtime installe (runtime.exe) avec des journaux dedies ;
    3. attend le chargement du modele ;
    4. envoie 300 appels melanges (chat, outils+grammaire, prompts longs) ;
    5. a chaque appel : identifiant, duree, etat du processus ;
    6. si le processus meurt : code de sortie (hex), RAM libre, dernier appel
       trace (last_call.json) et fin de runtime_crash.log ;
    7. relance le runtime et continue ;
    8. a la fin : tue le processus en pleine generation (plantage injecte),
       mesure ce que le client voit et le temps de redemarrage complet ;
    9. ecrit p69-pc-report.txt a cote du script.

  Exemple (RAM serree) :
    powershell -NoProfile -ExecutionPolicy Bypass -File p69-stress-pc.ps1 -MaxFreeRamMb 2048

  ASCII only. Aucune information secrete n'est ecrite.
#>
param(
  [int]    $Calls        = 300,
  [int]    $Port         = 6000,
  [int]    $HbPort       = 6001,
  [int]    $MaxFreeRamMb = 0,      # 0 = pas de bridage
  [string] $RuntimeExe   = "C:\Program Files\Sudo Studio\runtime.exe",
  [string] $LogsDir      = "$env:LOCALAPPDATA\SudoStudio\logs",
  [string] $Report       = ""
)

$ErrorActionPreference = 'Continue'
if (-not $Report) { $Report = Join-Path (Get-Location) 'p69-pc-report.txt' }
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
'' | Out-File -FilePath $Report -Encoding utf8

function Say($line) {
  $line | Tee-Object -FilePath $Report -Append | Write-Host
}

function FreeRamMb {
  $os = Get-CimInstance Win32_OperatingSystem
  return [int]($os.FreePhysicalMemory / 1024)
}

function RuntimeAlive {
  return [bool](Get-Process -Name 'runtime' -ErrorAction SilentlyContinue)
}

function Hb {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$HbPort/hb" -TimeoutSec 2
  } catch { return $null }
}

function Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 }
  catch { return $null }
}

function Start-Runtime {
  $env:SUDO_STUDIO_LOGS = $LogsDir
  $env:SUDO_HB_PORT = "$HbPort"
  if (-not (Test-Path $RuntimeExe)) {
    Say "[ERREUR] runtime.exe introuvable : $RuntimeExe"
    return $false
  }
  Start-Process -FilePath $RuntimeExe -WindowStyle Hidden | Out-Null
  Say "[INFO] runtime lance : $RuntimeExe (logs : $LogsDir)"
  return $true
}

function Wait-Model([int]$timeoutSec = 420) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $timeoutSec) {
    if (-not (RuntimeAlive)) { return @{ ok = $false; why = 'processus mort pendant le chargement' } }
    $h = Health
    if ($h -and $h.model -and $h.model.loaded) {
      return @{ ok = $true; s = [int]((Get-Date) - $t0).TotalSeconds; n_ctx = $h.model.n_ctx }
    }
    Start-Sleep -Seconds 2
  }
  return @{ ok = $false; why = "modele non charge apres $timeoutSec s" }
}

function Crash-Evidence([int]$callNo) {
  Say "--- MORT du runtime apres l'appel $callNo ---"
  $p = Get-Process -Name 'runtime' -ErrorAction SilentlyContinue
  Say ("  RAM libre      : " + (FreeRamMb) + " Mo")
  try {
    $lc = Join-Path $LogsDir 'last_call.json'
    if (Test-Path $lc) { Say ("  dernier appel  : " + (Get-Content $lc -Raw)) }
    else { Say "  dernier appel  : aucun (fichier last_call.json absent)" }
  } catch { Say "  dernier appel  : illisible" }
  try {
    $cr = Join-Path $LogsDir 'runtime_crash.log'
    if (Test-Path $cr) {
      Say "  fin de runtime_crash.log :"
      Get-Content $cr -Tail 12 | ForEach-Object { Say ("    " + $_) }
    } else { Say "  runtime_crash.log absent (faulthandler non declenche)" }
  } catch { Say "  runtime_crash.log illisible" }
  # Windows ne donne le code de sortie qu'au parent : le journal du
  # superviseur le porte quand c'est lui qui a lance le processus.
  $sup = Join-Path $LogsDir 'runtime-supervisor.log'
  if (Test-Path $sup) {
    Say "  dernieres lignes du superviseur :"
    Get-Content $sup -Tail 8 | ForEach-Object { Say ("    " + $_) }
  }
}

# ---------------------------------------------------------------- 1. machine
Say "=== P69 - serie de stress (PC reel) - $(Get-Date -Format o) ==="
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os  = Get-CimInstance Win32_OperatingSystem
Say ("Machine : " + $os.Caption + " " + $os.Version)
Say ("CPU     : " + $cpu.Name + " (" + $cpu.NumberOfCores + " coeurs / " + $cpu.NumberOfLogicalProcessors + " threads)")
Say ("RAM     : " + [int]($os.TotalVisibleMemorySize / 1024) + " Mo totale, " + (FreeRamMb) + " Mo libre")
Say ("Bridage : " + $(if ($MaxFreeRamMb -gt 0) { "on attend moins de $MaxFreeRamMb Mo libres" } else { 'aucun' }))

# ---------------------------------------------------------------- 2. bridage
if ($MaxFreeRamMb -gt 0) {
  $hog = @()
  while ((FreeRamMb) -gt $MaxFreeRamMb) {
    try {
      # On consomme de la RAM par blocs de 64 Mo jusqu'au seuil : c'est le
      # meme etat que "navigateur ouvert" sur la machine de l'utilisateur.
      $hog += , (New-Object byte[] (64MB))
    } catch { break }
    if ($hog.Count -gt 60) { break }
  }
  Say ("[INFO] RAM occupee par le banc : " + ($hog.Count * 64) + " Mo, libre = " + (FreeRamMb) + " Mo")
}

# ---------------------------------------------------------------- 3. demarrage
if (-not (RuntimeAlive)) { Start-Runtime | Out-Null }
$w = Wait-Model
Say ("Chargement : " + ($w | ConvertTo-Json -Compress))
if (-not $w.ok) {
  Say "[ECHEC] modele non charge : rien d'autre ne peut etre mesure."
  exit 2
}
$hb0 = Hb
Say ("Battement de coeur : alive=" + $hb0.alive + " busy=" + $hb0.busy + " phase=" + $hb0.phase)

# ---------------------------------------------------------------- 4..7 serie
$deaths = 0
$ok = 0
$lat = @()
for ($i = 1; $i -le $Calls; $i++) {
  $kind = @('chat', 'tools', 'long')[$i % 3]
  $body = @{ messages = @(@{ role = 'user'; content = 'Dis bonjour en un mot.' }); max_tokens = 24; temperature = 0 }
  if ($kind -eq 'tools') {
    $body.tools = @(@{ type = 'function'; function = @{ name = 'read'; description = 'Lire un fichier'; parameters = @{ type = 'object'; properties = @{ file = @{ type = 'string' } }; required = @('file') } } })
    $body.messages = @(@{ role = 'user'; content = 'Lis le fichier app.py' })
  } elseif ($kind -eq 'long') {
    $filler = ('Le service de facturation traite les commandes du lundi au vendredi. ' * 90)
    $body.messages = @(@{ role = 'user'; content = $filler + "`nReponds OK." })
  }
  $json = $body | ConvertTo-Json -Depth 8
  $t0 = Get-Date
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -Body $json -ContentType 'application/json' -TimeoutSec 300
    $ms = [int]((Get-Date) - $t0).TotalMilliseconds
    $lat += $ms
    $ok++
    if ($i % 25 -eq 0) { Say ("  appel $i/$Calls ($kind) ok ${ms}ms") }
  } catch {
    Say ("  appel $i/$Calls ($kind) ECHEC : " + $_.Exception.Message)
  }
  if (-not (RuntimeAlive)) {
    $deaths++
    Crash-Evidence $i
    $t1 = Get-Date
    Start-Runtime | Out-Null
    $w2 = Wait-Model
    Say ("[RELANCE] ok=" + $w2.ok + " en " + [int]((Get-Date) - $t1).TotalSeconds + " s")
    if (-not $w2.ok) { Say '[ECHEC] le runtime ne revient pas : on arrete la serie.'; break }
  }
}

$median = 0
if ($lat.Count -gt 0) { $median = ($lat | Sort-Object)[[int]($lat.Count / 2)] }
Say ""
Say "=== RESULTAT DE LA SERIE ==="
Say ("appels        : $Calls")
Say ("reussis       : $ok")
Say ("morts         : $deaths")
Say ("latence mediane : $median ms")

# ---------------------------------------------------------------- 8. injecte
Say ""
Say "=== PLANTAGE INJECTE (kill en pleine generation) ==="
$job = Start-Job -ScriptBlock {
  param($p, $filler)
  $body = @{ messages = @(@{ role = 'user'; content = $filler + "`nCompte jusqu'a 50." }); max_tokens = 200; temperature = 0 } | ConvertTo-Json -Depth 6
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/v1/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 120
    return @{ ok = $true; ms = $sw.ElapsedMilliseconds }
  } catch { return @{ ok = $false; error = $_.Exception.Message } }
} -ArgumentList $Port, ('Le service de facturation traite les commandes. ' * 40)
Start-Sleep -Seconds 2
$hbBefore = Hb
Say ("  battement avant le kill : alive=" + $hbBefore.alive + " busy=" + $hbBefore.busy + " phase=" + $hbBefore.phase)
$proc = Get-Process -Name 'runtime' -ErrorAction SilentlyContinue
if ($proc) { Stop-Process -Id $proc.Id -Force; Say ("  processus tue : " + $proc.Id) }
$jobOut = Receive-Job -Job $job -Wait
Say ("  cote client : " + ($jobOut | ConvertTo-Json -Compress))
Remove-Job -Job $job -Force
Start-Sleep -Seconds 3
$hDown = Health
Say ("  sans relance : /health -> " + $(if ($hDown) { 'repond' } else { 'aucune reponse' }))
$t2 = Get-Date
Start-Runtime | Out-Null
$w3 = Wait-Model
Say ("  relance complete : ok=" + $w3.ok + " en " + [int]((Get-Date) - $t2).TotalSeconds + " s (n_ctx=" + $w3.n_ctx + ")")

# ---------------------------------------------------------------- 9. fin
$supPath = Join-Path $LogsDir 'runtime-supervisor.log'
Say ""
Say ("Journal du superviseur : " + $supPath + " -> " + $(if (Test-Path $supPath) { ((Get-Content $supPath | Measure-Object -Line).Lines.ToString() + ' lignes') } else { 'ABSENT' }))
if ($hog) { $hog = $null }
Say ""
Say "Rapport ecrit : $Report"
Say "A renvoyer : ce fichier + $LogsDir\runtime_crash.log + $LogsDir\last_call.json"
