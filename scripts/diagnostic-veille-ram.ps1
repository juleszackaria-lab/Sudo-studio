<#
  SUDO STUDIO - P62 A3 : trancher H1 (manque de RAM), H2 (veille Windows),
  H3 (ralentissement quand la fenetre est masquee).

  A executer SUR LE PC, en administrateur pour les journaux systeme :

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnostic-veille-ram.ps1

  Le script ne modifie RIEN. Il lit et ecrit un rapport texte dans
  .\p62-diagnostic\<horodatage>.txt que tu peux m'envoyer tel quel.
  Aucun secret n'est affiche : seules des mesures systeme sont collectees.
#>

[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path (Get-Location).Path 'p62-diagnostic'),
  [string]$RuntimeUrl = 'http://127.0.0.1:6000',
  [string]$BackendUrl = 'http://127.0.0.1:5000',
  [int]$VeilleFenetreMinutes = 180
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutDir ($stamp + '.txt')

function Ligne {
  param([string]$Texte)
  Write-Host $Texte
  Add-Content -Path $out -Value $Texte -Encoding UTF8
}

function Titre {
  param([string]$Texte)
  Ligne ''
  Ligne ('== ' + $Texte + ' ==')
}

Ligne ('SUDO STUDIO - diagnostic veille / RAM / runtime')
Ligne ('Date locale     : ' + (Get-Date).ToString('s'))
Ligne ('Machine         : ' + $env:COMPUTERNAME)
Ligne ('Utilisateur     : ' + $env:USERNAME)
Ligne ('Rapport         : ' + $out)

# --------------------------------------------------------------- H1 : memoire
Titre 'H1 - memoire (hypothese : manque de RAM)'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $libreMo = [int]($os.FreePhysicalMemory / 1024)
  $totalMo = [int]($os.TotalVisibleMemorySize / 1024)
  Ligne ('RAM totale      : ' + $totalMo + ' Mo')
  Ligne ('RAM libre       : ' + $libreMo + ' Mo')
  Ligne ('RAM engagee     : ' + [int](($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1024) + ' Mo')
  $seuil = 800
  if ($libreMo -lt $seuil) {
    Ligne ('VERDICT H1      : RAM FAIBLE (' + $libreMo + ' Mo < ' + $seuil + ' Mo) -> H1 plausible')
  } else {
    Ligne ('VERDICT H1      : RAM libre suffisante (' + $libreMo + ' Mo >= ' + $seuil + ' Mo) -> H1 peu probable')
  }
} catch { Ligne ('ERREUR memoire  : ' + $_.Exception.Message) }

Titre 'H1b - processus les plus gourmands (top 8)'
try {
  Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 8 |
    ForEach-Object { Ligne ('  ' + $_.ProcessName.PadRight(28) + [int]($_.WorkingSet64 / 1MB) + ' Mo') }
} catch { Ligne ('ERREUR processus : ' + $_.Exception.Message) }

# --------------------------------------------------- H2 : veille / arret brutal
Titre 'H2 - veille Windows (Kernel-Power 42 = mise en veille, 107 = reprise, 41 = arret brutal)'
try {
  $depuis = (Get-Date).AddMinutes(-1 * $VeilleFenetreMinutes)
  $evts = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = $depuis } -ErrorAction Stop
  $interessants = $evts | Where-Object { @(41, 42, 107, 109) -contains $_.Id } | Sort-Object TimeCreated -Descending | Select-Object -First 20
  if ($interessants) {
    foreach ($e in $interessants) {
      Ligne ('  ' + $e.TimeCreated.ToString('s') + '  Id=' + $e.Id + '  ' + ($e.LevelDisplayName))
    }
    $nbVeille = @($interessants | Where-Object { $_.Id -eq 42 }).Count
    $nbReprise = @($interessants | Where-Object { $_.Id -eq 107 }).Count
    $nbArret = @($interessants | Where-Object { $_.Id -eq 41 }).Count
    Ligne ('COMPTE H2       : veille(42)=' + $nbVeille + ' reprise(107)=' + $nbReprise + ' arret brutal(41)=' + $nbArret)
    if ($nbArret -gt 0) { Ligne 'VERDICT H2      : au moins un ARRET BRUTAL -> H1 (crash par manque de RAM) plausible' }
    elseif ($nbVeille -gt 0) { Ligne 'VERDICT H2      : des mises en veille ont eu lieu pendant la fenetre -> H2 plausible' }
    else { Ligne 'VERDICT H2      : aucune veille sur la fenetre -> H2 peu probable' }
  } else {
    Ligne ('  aucune entree Kernel-Power 41/42/107/109 depuis ' + $depuis.ToString('s'))
    Ligne 'VERDICT H2      : rien a signaler sur la fenetre demandee'
  }
} catch { Ligne ('ERREUR veille   : ' + $_.Exception.Message) }

Titre 'H2b - autres arrets (EventLog 6008 = arret inattendu, 1001 = BugCheck)'
try {
  $depuis = (Get-Date).AddMinutes(-1 * $VeilleFenetreMinutes)
  $evts2 = Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $depuis } -ErrorAction Stop |
    Where-Object { @(6008, 1001) -contains $_.Id } | Select-Object -First 10
  if ($evts2) { foreach ($e in $evts2) { Ligne ('  ' + $e.TimeCreated.ToString('s') + '  Id=' + $e.Id + '  ' + $e.ProviderName) } }
  else { Ligne '  aucun evenement 6008/1001 sur la fenetre' }
} catch { Ligne ('ERREUR evenements : ' + $_.Exception.Message) }

# --------------------------------------------------------- H3 : etat runtime
Titre 'H3 - etat des services locaux maintenant'
function Sonde {
  param([string]$Nom, [string]$Url)
  try {
    $t0 = Get-Date
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    $ms = [int]((Get-Date) - $t0).TotalMilliseconds
    Ligne ('  ' + $Nom.PadRight(10) + ' HTTP ' + $r.StatusCode + ' en ' + $ms + ' ms')
  } catch {
    Ligne ('  ' + $Nom.PadRight(10) + ' INJOIGNABLE : ' + $_.Exception.Message)
  }
}
Sonde -Nom 'runtime' -Url ($RuntimeUrl + '/health')
Sonde -Nom 'backend' -Url ($BackendUrl + '/api/system/health')

Titre 'H3b - processus runtime presents'
try {
  $procs = Get-Process | Where-Object { $_.ProcessName -match 'runtime|llama|sudo' } | Select-Object -First 10
  if ($procs) {
    foreach ($p in $procs) {
      $pinfo = ''
      try { $pinfo = $p.Path } catch { $pinfo = '(chemin non lisible)' }
      Ligne ('  ' + $p.ProcessName.PadRight(24) + ' PID=' + $p.Id + '  RAM=' + [int]($p.WorkingSet64 / 1MB) + ' Mo  ' + $pinfo)
    }
  } else { Ligne '  aucun processus runtime/llama/sudo' }
} catch { Ligne ('ERREUR processus runtime : ' + $_.Exception.Message) }

# ------------------------------------------------------ journaux du produit
Titre 'Journaux Sudo Studio (dernieres lignes utiles)'
$candidats = @(
  (Join-Path $env:LOCALAPPDATA 'sudo-studio\logs\runtime-supervisor.log'),
  (Join-Path $env:LOCALAPPDATA 'sudo-studio\logs\runtime.log'),
  (Join-Path $env:LOCALAPPDATA 'sudo-studio\logs\backend.log'),
  (Join-Path $env:LOCALAPPDATA 'sudo-studio\logs\agent.log')
)
foreach ($f in $candidats) {
  if (Test-Path $f) {
    Ligne ('  --- ' + $f)
    Get-Content -Path $f -Tail 40 | ForEach-Object { Ligne ('    ' + $_) }
  } else {
    Ligne ('  (absent) ' + $f)
  }
}

# ------------------------------------------- minuteurs : ce qui tourne et ou
Titre 'A3b - minuteurs et sondes (source)'
Ligne '  Les sondes de sante du runtime tournent dans le BACKEND (processus separe) :'
Ligne '    backend/supervisor/runtimeSupervisor.js  -> setInterval(pollMs) + httpGet /health'
Ligne '  L extension ne sonde que l agent et le backend ; ses minuteurs sont dans'
Ligne '    sudo-ai-extension/src/services/BackendService.js (retry de demarrage)'
Ligne '    sudo-ai-extension/src/agent/AgentServer.js (surveillance du processus agent)'
Ligne '  Un minuteur Chromium/Node est sensible a la veille (horloge suspendue) et au'
Ligne '  masquage de la fenetre (throttling), sauf s il tourne dans le processus backend.'

Titre 'Resume a m envoyer'
Ligne '  1) la ligne VERDICT H1'
Ligne '  2) la ligne COMPTE H2 et la ligne VERDICT H2'
Ligne '  3) les lignes H3 (HTTP runtime/backend) et H3b (processus)'
Ligne ('  fichier complet : ' + $out)
Ligne ''
Ligne 'FIN DU DIAGNOSTIC'
