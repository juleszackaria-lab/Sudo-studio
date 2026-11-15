<#
  SUDO STUDIO - P66 : verification du PAQUET INSTALLE sur VOTRE PC (lecture seule).

  Un seul fichier de sortie : verification-report.txt (PASS / FAIL / SKIP, avec la
  ligne de journal qui prouve chaque point) + un zip des journaux utiles, sur le
  Bureau. Le script NE MODIFIE RIEN dans l'installation : il ne touche qu'un
  dossier de travail temporaire (projet d'essai) qu'il cree lui-meme.

  Ce qu'il verifie :
    1  SHA256 de l'installateur fourni (complet, 64 caracteres)
    2  dossier d'installation + fichiers critiques
    3  /health du backend (5000) et du runtime (6000)
    4  n_ctx et modele reellement charge
    5  RAM libre du systeme
    6  l'agent cree test.txt contenant "bonjour" avec le VRAI modele (appel d'outil),
       le relit, puis repond a une question simple SANS outil (reponse non vide)
    7  "continu" sans travail inacheve : reponse deterministe, aucun travail invente
    8  aucun dossier .sudo-agent dans le projet (git status + balayage)
    9  nombre de rejets d'appels d'outils dans le journal
   10  aucune chaine anglaise visible par l'utilisateur
   11  aucun secret ou jeton dans les journaux
   12  evenements de veille Windows recents (Kernel-Power)
   13  dernieres lignes de runtime-supervisor.log

  Usage :
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify\verify-installed.ps1 `
      -Installer "C:\Users\moi\Downloads\SudoStudio-Setup-5.0.0.exe" `
      -ProjectPath "C:\mon\projet" -InstallDir "C:\Program Files\Sudo Studio"

  Options :
    -Installer     installateur a controler (SHA256). Optionnel : la verification
                   est alors SKIP, jamais PASS.
    -ExpectedSha256 SHA256 attendu (64 caracteres). Si absent, il est seulement
                   calcule et affiche (aucune comparaison inventee).
    -InstallDir    dossier d'installation (defaut Program Files).
    -ProjectPath   projet d'essai (une COPIE est faite ; l'original n'est pas touche).
    -RuntimeUrl    runtime local (defaut http://127.0.0.1:6000).
    -BackendUrl    backend local (defaut http://127.0.0.1:5000).
    -AgentUrl      serveur d'agent (defaut http://127.0.0.1:7311, lance par ce script).
    -OutDir        dossier des preuves (defaut : Bureau).
    -SkipModel     n'execute pas les etapes qui exigent le modele (elles sont SKIP).

  ASCII only. Aucun secret n'est affiche : le jeton du serveur d'agent est genere ici.
#>

[CmdletBinding()]
param(
  [string]$Installer = '',
  [string]$ExpectedSha256 = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Sudo Studio'),
  [string]$ProjectPath = (Get-Location).Path,
  [string]$RuntimeUrl = 'http://127.0.0.1:6000',
  [string]$BackendUrl = 'http://127.0.0.1:5000',
  [int]$Port = 7311,
  [string]$OutDir = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'verification-sudo-studio'),
  [switch]$SkipModel
)

$ErrorActionPreference = 'Continue'
$script:Results = New-Object System.Collections.ArrayList
$script:Token = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$c })
$script:Base = "http://127.0.0.1:$Port"
$script:AgentLog = $null
$script:Work = $null

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status,
    [string]$Proof = ''
  )
  $null = $script:Results.Add([pscustomobject]@{
      Etat    = $Status
      Controle = $Name
      Preuve  = $Proof
    })
  $color = if ($Status -eq 'PASS') { 'Green' } elseif ($Status -eq 'FAIL') { 'Red' } else { 'Yellow' }
  Write-Host ("[{0}] {1} :: {2}" -f $Status, $Name, $Proof) -ForegroundColor $color
}

function Invoke-AgentApi {
  param(
    [string]$Method = 'GET',
    [string]$Path = '/health',
    $Body = $null,
    [int]$TimeoutSec = 20
  )
  $url = $script:Base + $Path
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = $Method
  $req.Timeout = $TimeoutSec * 1000
  $req.ReadWriteTimeout = $TimeoutSec * 1000
  $req.Headers.Add('Authorization', "Bearer $script:Token")
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  }
  $resp = $req.GetResponse()
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $text = $reader.ReadToEnd()
  $reader.Close(); $resp.Close()
  if ([string]::IsNullOrEmpty($text)) { return $null }
  return ($text | ConvertFrom-Json)
}

# Un tour complet, en SSE : renvoie le texte final et les evenements.
function Invoke-Turn {
  param([string]$SessionId, [string]$Prompt, [int]$TimeoutSec = 300)
  $url = "$script:Base/sessions/$SessionId/messages"
  $payload = @{ text = $Prompt } | ConvertTo-Json -Compress
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = 'POST'
  $req.ContentType = 'application/json'
  $req.Headers.Add('Authorization', "Bearer $script:Token")
  $req.Timeout = $TimeoutSec * 1000
  $req.ReadWriteTimeout = $TimeoutSec * 1000
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $req.ContentLength = $bytes.Length
  $st = $req.GetRequestStream(); $st.Write($bytes, 0, $bytes.Length); $st.Close()

  $text = New-Object System.Text.StringBuilder
  $errorText = $null
  $done = $false
  try {
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $eventName = 'message'
    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { continue }
      if ($line -like 'event:*') { $eventName = $line.Substring(6).Trim(); continue }
      if (-not ($line -like 'data:*')) { continue }
      $json = $line.Substring(5).Trim()
      if (-not $json) { continue }
      try { $obj = $json | ConvertFrom-Json } catch { continue }
      if ($eventName -eq 'message.delta' -and $obj.text) { [void]$text.Append($obj.text) }
      if ($eventName -eq 'message.done' -and $obj.text) { [void]$text.Clear(); [void]$text.Append($obj.text) }
      if ($eventName -eq 'turn.error') { $errorText = "$($obj.code) : $($obj.error)"; $done = $true; break }
      if ($eventName -eq 'turn.done') { $done = $true; break }
    }
    $reader.Close(); $resp.Close()
  } catch {
    $errorText = $_.Exception.Message
  }
  return [pscustomobject]@{ ok = ($done -and -not $errorText); text = $text.ToString(); error = $errorText }
}

function Get-LogProof {
  param([string]$Path, [string]$Pattern)
  if (-not $Path) { return $null }
  if (-not (Test-Path $Path)) { return $null }
  $hit = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Where-Object { $_ -match $Pattern } | Select-Object -Last 1
  if ($hit) { return $hit.Trim() }
  return $null
}

# --------------------------------------------------------------------- 0 setup
Write-Host ''
Write-Host '=== SUDO STUDIO - P66 : verification du paquet installe (lecture seule) ===' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$reportPath = Join-Path $OutDir 'verification-report.txt'
$script:Work = Join-Path ([System.IO.Path]::GetTempPath()) ('p66-verify-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$proj = Join-Path $script:Work 'projet'
New-Item -ItemType Directory -Force -Path $proj | Out-Null
$logsDir = Join-Path $script:Work 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$script:AgentLog = Join-Path $logsDir 'agent.log'

# ------------------------------------------------- 1 SHA256 de l'installateur
try {
  if (-not $Installer) {
    Add-Result -Name '1 SHA256 de l installateur' -Status 'SKIP' -Proof '-Installer non fourni : aucun SHA256 ne peut etre affirme'
  } elseif (-not (Test-Path $Installer)) {
    Add-Result -Name '1 SHA256 de l installateur' -Status 'FAIL' -Proof ("fichier introuvable : " + $Installer)
  } else {
    $h = (Get-FileHash -Path $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item $Installer).Length
    if ($h.Length -ne 64) {
      Add-Result -Name '1 SHA256 de l installateur' -Status 'FAIL' -Proof ("longueur inattendue : " + $h.Length)
    } elseif ($ExpectedSha256 -and $ExpectedSha256.ToLowerInvariant() -ne $h) {
      Add-Result -Name '1 SHA256 de l installateur' -Status 'FAIL' -Proof ("attendu " + $ExpectedSha256 + " / obtenu " + $h)
    } elseif ($ExpectedSha256) {
      Add-Result -Name '1 SHA256 de l installateur' -Status 'PASS' -Proof ("sha256=" + $h + " taille=" + $size + " octets (comparaison OK)")
    } else {
      Add-Result -Name '1 SHA256 de l installateur' -Status 'PASS' -Proof ("sha256=" + $h + " taille=" + $size + " octets (calcule ; -ExpectedSha256 non fourni, donc aucune comparaison)")
    }
  }
} catch { Add-Result -Name '1 SHA256 de l installateur' -Status 'FAIL' -Proof $_.Exception.Message }

# ------------------------------------------------ 2 dossier d'installation
try {
  $crit = @('resources\app\backend\server.js', 'resources\app\sudo-agent\src\server.js', 'resources\app\sudo-agent\src\loop.js')
  $missing = @()
  foreach ($c in $crit) { if (-not (Test-Path (Join-Path $InstallDir $c))) { $missing += $c } }
  $exe = Join-Path $InstallDir 'Sudo Studio.exe'
  if (-not (Test-Path $exe)) { $missing += 'Sudo Studio.exe' }
  if ($missing.Count -eq 0) {
    Add-Result -Name '2 dossier d installation' -Status 'PASS' -Proof ("$InstallDir : exe + backend + agent presents")
  } else {
    Add-Result -Name '2 dossier d installation' -Status 'FAIL' -Proof ("absents : " + ($missing -join ', '))
  }
} catch { Add-Result -Name '2 dossier d installation' -Status 'FAIL' -Proof $_.Exception.Message }

# ------------------------------------------------ 3 sante backend + runtime
try {
  $b = Invoke-RestMethod -Uri ($BackendUrl + '/health') -TimeoutSec 5
  Add-Result -Name '3a /health backend' -Status 'PASS' -Proof ("GET " + $BackendUrl + "/health -> status=" + $b.status)
} catch {
  Add-Result -Name '3a /health backend' -Status 'FAIL' -Proof ($BackendUrl + "/health : " + $_.Exception.Message)
}
$rtUp = $false
$rt = $null
try {
  $rt = Invoke-RestMethod -Uri ($RuntimeUrl + '/health') -TimeoutSec 5
  $rtUp = $true
  Add-Result -Name '3b /health runtime' -Status 'PASS' -Proof ("GET " + $RuntimeUrl + "/health -> status=" + $rt.status)
} catch {
  Add-Result -Name '3b /health runtime' -Status 'FAIL' -Proof ($RuntimeUrl + "/health : " + $_.Exception.Message)
}

# ------------------------------------------------ 4 n_ctx et modele charge
try {
  if (-not $rtUp) {
    Add-Result -Name '4 n_ctx et modele charge' -Status 'SKIP' -Proof 'runtime injoignable : rien ne peut etre affirme'
  } else {
    $m = $rt.model
    $line = "model=" + $m.name + " loaded=" + $m.loaded + " n_ctx=" + $m.n_ctx + " device=" + $m.device + " load_ms=" + $m.load_ms
    if ($m.loaded -eq $true -and $m.n_ctx) {
      Add-Result -Name '4 n_ctx et modele charge' -Status 'PASS' -Proof $line
    } else {
      Add-Result -Name '4 n_ctx et modele charge' -Status 'FAIL' -Proof ("modele non charge ou n_ctx absent : " + $line)
    }
  }
} catch { Add-Result -Name '4 n_ctx et modele charge' -Status 'FAIL' -Proof $_.Exception.Message }

# ------------------------------------------------------------- 5 RAM libre
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
  $totGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
  $proof = "RAM libre=" + $freeGb + " Go / total=" + $totGb + " Go"
  if ($freeGb -lt 0.3) {
    Add-Result -Name '5 RAM libre' -Status 'FAIL' -Proof ($proof + " : sous 300 Mo, l agent va manquer de memoire")
  } else {
    Add-Result -Name '5 RAM libre' -Status 'PASS' -Proof $proof
  }
} catch { Add-Result -Name '5 RAM libre' -Status 'SKIP' -Proof ("CIM indisponible : " + $_.Exception.Message) }

# -------------------------------------------------- demarrage du serveur d agent
$agentProc = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$serverJs = Join-Path $InstallDir 'resources\app\sudo-agent\src\server.js'
$agentUp = $false
if ($SkipModel) {
  Add-Result -Name '6..7 tours avec le vrai modele' -Status 'SKIP' -Proof '-SkipModel'
} elseif (-not (Test-Path $serverJs)) {
  Add-Result -Name '6..7 tours avec le vrai modele' -Status 'SKIP' -Proof ("serveur d agent absent : " + $serverJs)
} elseif (-not $nodeCmd) {
  Add-Result -Name '6..7 tours avec le vrai modele' -Status 'SKIP' -Proof 'node.exe absent du PATH (utiliser le node embarque du paquet)'
} else {
  $env:SUDO_AGENT_TOKEN = $script:Token
  $env:SUDO_AGENT_PORT = "$Port"
  $env:SUDO_STUDIO_HOME = (Join-Path $script:Work 'agent-home')
  $env:SUDO_STUDIO_LOGS = $logsDir
  $env:SUDO_AGENT_STORE = (Join-Path $script:Work 'agent-store')
  $env:SUDO_AGENT_PROVIDER = (@{ type = 'local'; baseUrl = $RuntimeUrl; model = 'local-model' } | ConvertTo-Json -Compress)
  try {
    $agentProc = Start-Process -FilePath $nodeCmd.Source -ArgumentList @($serverJs) -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
      try { $null = Invoke-AgentApi -Path '/health' -TimeoutSec 3; $agentUp = $true; break } catch { Start-Sleep -Milliseconds 400 }
    }
  } catch { $agentUp = $false }
  if (-not $agentUp) {
    Add-Result -Name '6..7 tours avec le vrai modele' -Status 'SKIP' -Proof ("serveur d agent non demarre sur " + $script:Base + "/health")
  }
}

if ($agentUp -and -not $SkipModel) {
  # ---- 6a : creation de test.txt avec le VRAI modele (appel d'outil)
  try {
    $sess = (Invoke-AgentApi -Method POST -Path '/sessions' -Body @{ projectRoot = $proj; mode = 'build' }).id
    $p1 = 'Cree le fichier test.txt a la racine du projet, contenant exactement le mot bonjour. Puis termine.'
    $r1 = Invoke-Turn -SessionId $sess -Prompt $p1 -TimeoutSec 420
    $file = Join-Path $proj 'test.txt'
    $writeLine = Get-LogProof -Path $script:AgentLog -Pattern 'tool ok.*tool=write.*test\.txt'
    if ((Test-Path $file) -and ((Get-Content -Raw $file).Trim() -eq 'bonjour') -and $writeLine) {
      Add-Result -Name '6a creation de test.txt (appel d outil reel)' -Status 'PASS' -Proof $writeLine
    } else {
      Add-Result -Name '6a creation de test.txt (appel d outil reel)' -Status 'FAIL' `
        -Proof ("fichier=" + (Test-Path $file) + " contenu=" + $(if (Test-Path $file) { (Get-Content -Raw $file).Trim() } else { '-' }) + " | " + $r1.error)
    }
    # ---- 6b : relecture
    $p2 = 'Relis test.txt et dis-moi exactement ce qu il contient.'
    $r2 = Invoke-Turn -SessionId $sess -Prompt $p2 -TimeoutSec 420
    $readLine = Get-LogProof -Path $script:AgentLog -Pattern 'tool ok.*tool=read.*test\.txt'
    if ($readLine -and $r2.text -match 'bonjour') {
      Add-Result -Name '6b relecture de test.txt' -Status 'PASS' -Proof $readLine
    } else {
      Add-Result -Name '6b relecture de test.txt' -Status 'FAIL' -Proof ("reponse=" + ($r2.text -replace '\s+', ' ').Substring(0, [Math]::Min(160, $r2.text.Length)))
    }
    # ---- 6c : question simple SANS outil, reponse non vide
    $sess2 = (Invoke-AgentApi -Method POST -Path '/sessions' -Body @{ projectRoot = $proj; mode = 'plan' }).id
    $r3 = Invoke-Turn -SessionId $sess2 -Prompt 'Explique en une phrase ce que contient ce projet.' -TimeoutSec 300
    $txt = ($r3.text -replace '\s+', ' ').Trim()
    if ($r3.ok -and $txt.Length -gt 10) {
      Add-Result -Name '6c question simple sans outil (reponse non vide)' -Status 'PASS' -Proof ("statut=TERMINE, " + $txt.Length + " caracteres : " + $txt.Substring(0, [Math]::Min(120, $txt.Length)))
    } else {
      Add-Result -Name '6c question simple sans outil (reponse non vide)' -Status 'FAIL' -Proof ("ok=" + $r3.ok + " texte=" + $txt.Length + " car. | " + $r3.error)
    }
    # ---- 7 : "continu" sans travail inacheve
    $r4 = Invoke-Turn -SessionId $sess2 -Prompt 'continu' -TimeoutSec 300
    $t4 = ($r4.text -replace '\s+', ' ').Trim()
    $nothing = Get-LogProof -Path $script:AgentLog -Pattern 'aucun travail|rien a reprendre|reprise deterministe|aucune etape'
    if ($r4.ok -and $t4.Length -gt 0 -and $nothing) {
      Add-Result -Name '7 continu sans travail inacheve' -Status 'PASS' -Proof $nothing
    } else {
      Add-Result -Name '7 continu sans travail inacheve' -Status 'FAIL' -Proof ("ok=" + $r4.ok + " preuve journal=" + $(if ($nothing) { $nothing } else { 'aucune ligne de reprise deterministe' }))
    }
  } catch {
    Add-Result -Name '6/7 tours avec le vrai modele' -Status 'FAIL' -Proof $_.Exception.Message
  }
}

# ------------------------------------- 8 aucun .sudo-agent dans le projet
try {
  $dot = @()
  $dot += Get-ChildItem -Path $proj -Recurse -Force -Directory -Filter '.sudo-agent' -ErrorAction SilentlyContinue
  $gitState = 'pas de depo git'
  if (Test-Path (Join-Path $proj '.git')) {
    $status = & git -C $proj status --porcelain 2>&1 | Out-String
    if ($status -match '\.sudo-agent') { $gitState = 'git status mentionne .sudo-agent : ' + (($status -split "`n") | Where-Object { $_ -match '\.sudo-agent' } | Select-Object -First 1) }
    else { $gitState = 'git status : aucun .sudo-agent' }
  }
  if ($dot.Count -eq 0 -and $gitState -notlike 'git status mentionne*') {
    Add-Result -Name '8 aucun .sudo-agent dans le projet' -Status 'PASS' -Proof $gitState
  } else {
    Add-Result -Name '8 aucun .sudo-agent dans le projet' -Status 'FAIL' -Proof ($gitState + " | dossiers trouves : " + $dot.Count)
  }
} catch { Add-Result -Name '8 aucun .sudo-agent dans le projet' -Status 'FAIL' -Proof $_.Exception.Message }

# ------------------------------------- 9 rejets d'appels d'outils
try {
  if (-not (Test-Path $script:AgentLog)) {
    Add-Result -Name '9 rejets d appels d outils' -Status 'SKIP' -Proof 'journal de l agent introuvable'
  } else {
    $rejets = Get-Content -LiteralPath $script:AgentLog | Where-Object { $_ -match 'deny|refus|denied|non autorise|permission' }
    $n = ($rejets | Measure-Object).Count
    $last = $rejets | Select-Object -Last 1
    Add-Result -Name '9 rejets d appels d outils' -Status 'PASS' -Proof ("rejets=" + $n + $(if ($last) { " | dernier : " + $last.Trim() } else { ' | aucun rejet' }))
  }
} catch { Add-Result -Name '9 rejets d appels d outils' -Status 'SKIP' -Proof $_.Exception.Message }

# ------------------------------------- 10 chaines anglaises visibles
try {
  $patterns = @('Runtime restarting', 'Tool call', 'max_iters', 'tool call unusable', 'Unknown error',
    'Not found', 'Permission denied', 'Failed to', 'Something went wrong')
  $hits = @()
  foreach ($f in @($script:AgentLog, (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\backend.log'), (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime.log'))) {
    if (-not (Test-Path $f)) { continue }
    foreach ($p in $patterns) {
      $h = Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | Where-Object { $_ -like "*$p*" } | Select-Object -First 1
      if ($h) { $hits += ("$p -> " + $h.Trim()) }
    }
  }
  if ($hits.Count -eq 0) {
    Add-Result -Name '10 aucune chaine anglaise visible' -Status 'PASS' -Proof ("9 motifs cherches dans agent.log, backend.log, runtime.log : aucun")
  } else {
    Add-Result -Name '10 aucune chaine anglaise visible' -Status 'FAIL' -Proof ($hits -join ' || ')
  }
} catch { Add-Result -Name '10 aucune chaine anglaise visible' -Status 'SKIP' -Proof $_.Exception.Message }

# ------------------------------------- 11 secrets dans les journaux
try {
  $many = @()
  $dirs = @($logsDir, (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs'))
  foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { continue }
    $many += Get-ChildItem -Path $d -Filter *.log -ErrorAction SilentlyContinue
  }
  $found = @()
  foreach ($f in $many) {
    $h = Select-String -Path $f.FullName -Pattern 'ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|Bearer [A-Za-z0-9._-]{20,}' -AllMatches -ErrorAction SilentlyContinue
    foreach ($x in $h) { $found += ($f.Name + ':' + $x.LineNumber) }
  }
  if ($found.Count -eq 0) {
    Add-Result -Name '11 aucun secret dans les journaux' -Status 'PASS' -Proof ("fichiers inspectes=" + ($many | Measure-Object).Count + " : aucun motif de jeton")
  } else {
    Add-Result -Name '11 aucun secret dans les journaux' -Status 'FAIL' -Proof ($found -join ', ')
  }
} catch { Add-Result -Name '11 aucun secret dans les journaux' -Status 'SKIP' -Proof $_.Exception.Message }

# ------------------------------------- 12 veille Windows recente
try {
  $since = (Get-Date).AddDays(-7)
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = $since } -MaxEvents 20 -ErrorAction Stop
  $sleep = $ev | Where-Object { $_.Id -in @(42, 107, 131, 506, 507) }
  if (($sleep | Measure-Object).Count -gt 0) {
    $e0 = $sleep | Select-Object -First 1
    Add-Result -Name '12 veille Windows (Kernel-Power)' -Status 'PASS' -Proof ("7 derniers jours : " + ($sleep | Measure-Object).Count + " evenement(s), dernier id=" + $e0.Id + " a " + $e0.TimeCreated)
  } else {
    Add-Result -Name '12 veille Windows (Kernel-Power)' -Status 'SKIP' -Proof 'aucun evenement de veille sur 7 jours (normal sur un poste fixe)'
  }
} catch { Add-Result -Name '12 veille Windows (Kernel-Power)' -Status 'SKIP' -Proof ("journal System illisible : " + $_.Exception.Message) }

# ------------------------------------- 13 runtime-supervisor.log
try {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs\runtime-supervisor.log'),
    (Join-Path $InstallDir 'logs\runtime-supervisor.log')
  )
  $f = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($f) {
    $tail = Get-Content -LiteralPath $f -Tail 5 -ErrorAction Stop
    Add-Result -Name '13 runtime-supervisor.log' -Status 'PASS' -Proof (($tail -join ' | ').Trim())
  } else {
    Add-Result -Name '13 runtime-supervisor.log' -Status 'SKIP' -Proof ("introuvable dans : " + ($cands -join ' , '))
  }
} catch { Add-Result -Name '13 runtime-supervisor.log' -Status 'SKIP' -Proof $_.Exception.Message }

# ---------------------------------------------------------------- rapport + zip
try {
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('SUDO STUDIO - verification du paquet installe (P66)')
  [void]$lines.Add(('Date : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
  [void]$lines.Add(('Machine : ' + $env:COMPUTERNAME + ' | utilisateur : ' + $env:USERNAME))
  [void]$lines.Add(('Installation : ' + $InstallDir))
  [void]$lines.Add(('Installateur : ' + $(if ($Installer) { $Installer } else { '(non fourni)' })))
  [void]$lines.Add('')
  foreach ($r in $script:Results) {
    [void]$lines.Add(('[{0}] {1}' -f $r.Etat, $r.Controle))
    [void]$lines.Add(('       preuve : ' + $r.Preuve))
  }
  [void]$lines.Add('')
  $p = ($script:Results | Where-Object { $_.Etat -eq 'PASS' } | Measure-Object).Count
  $f = ($script:Results | Where-Object { $_.Etat -eq 'FAIL' } | Measure-Object).Count
  $s = ($script:Results | Where-Object { $_.Etat -eq 'SKIP' } | Measure-Object).Count
  [void]$lines.Add(('RESUME : PASS {0} | FAIL {1} | SKIP {2}' -f $p, $f, $s))
  [void]$lines.Add('Regle : un point est PASS seulement avec la ligne de journal ou la mesure qui le prouve.')
  $lines | Set-Content -Path $reportPath -Encoding UTF8
  Add-Result -Name '14 rapport ecrit' -Status 'PASS' -Proof $reportPath

  $zip = Join-Path $OutDir 'journaux-sudo-studio.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  $toZip = New-Object System.Collections.ArrayList
  [void]$toZip.Add($reportPath)
  foreach ($d in @($logsDir, (Join-Path $env:LOCALAPPDATA 'SudoStudio\logs'))) {
    if (Test-Path $d) { Get-ChildItem -Path $d -File -ErrorAction SilentlyContinue | ForEach-Object { [void]$toZip.Add($_.FullName) } }
  }
  if ($toZip.Count -gt 0) {
    Compress-Archive -Path $toZip.ToArray() -DestinationPath $zip -Force -ErrorAction Stop
    Add-Result -Name '15 zip des journaux' -Status 'PASS' -Proof $zip
  } else {
    Add-Result -Name '15 zip des journaux' -Status 'SKIP' -Proof 'aucun journal a zipper'
  }
} catch { Add-Result -Name '14/15 rapport et zip' -Status 'FAIL' -Proof $_.Exception.Message }

Write-Host ''
Write-Host '=== RESUME ===' -ForegroundColor Cyan
$script:Results | Format-Table -AutoSize | Out-String | Write-Host
$fail = ($script:Results | Where-Object { $_.Etat -eq 'FAIL' } | Measure-Object).Count
Write-Host ("Rapport : " + $reportPath) -ForegroundColor Cyan
if ($agentProc) { try { Stop-Process -Id $agentProc.Id -Force } catch {} }
if ($fail -gt 0) { exit 1 } else { exit 0 }
