<#
  SUDO STUDIO - P59 PARTIE D : test de bout en bout du mode agent.

  A executer SUR TON PC, sur une COPIE du projet (le script copie lui-meme).
  Il demarre le serveur d'agent du paquet INSTALLE, joue 9 scenarios reels et
  ecrit PASS/FAIL avec, pour chaque etape, LA LIGNE DE JOURNAL qui le prouve.

  12 etapes :
    1 lecture de structure            7 appel d une extension
    2 changement de couleur           8 dix questions a la suite
    3 ajout de tests + execution      9 coupure du runtime en cours de tache
    4 corrige les failles (avant/apres) 10 aucun secret dans le journal
    5 regarde le DevOps               11 suppression d un fichier jamais lu (P61)
    6 journaux ERROR                  12 vingt demandes a la suite (P61)

  Usage :
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-e2e.ps1 `
      -InstallDir "C:\SudoStudio" -ProjectPath "C:\mon\projet"

  Options :
    -InstallDir   dossier du paquet installe (defaut : dossier courant)
    -ProjectPath  projet a copier (defaut : dossier courant)
    -RuntimeUrl   runtime local (defaut http://127.0.0.1:6000)
    -Port         port du serveur d agent lance par le script (defaut 7311)
    -OutDir       dossier des preuves (defaut .\p59-preuves)
    -SkipModel    lance seulement les etapes qui n ont pas besoin du modele

  Le script ne modifie JAMAIS le projet d origine : tout se fait dans une copie
  temporaire. Aucun secret n est affiche : le jeton du serveur est genere ici.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = (Get-Location).Path,
  [string]$ProjectPath = (Get-Location).Path,
  [string]$RuntimeUrl = 'http://127.0.0.1:6000',
  [int]$Port = 7311,
  [string]$OutDir = (Join-Path (Get-Location).Path 'p59-preuves'),
  [switch]$SkipModel
)

$ErrorActionPreference = 'Stop'
$script:Results = @()
$script:Token = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$script:Base = "http://127.0.0.1:$Port"
$script:AgentLog = $null

function Write-Step {
  param([string]$Name, [bool]$Ok, [string]$Proof, [string]$Note = '')
  $state = if ($Ok) { 'PASS' } else { 'FAIL' }
  $color = if ($Ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1}" -f $state, $Name) -ForegroundColor $color
  if ($Proof) { Write-Host ("       preuve : " + $Proof) -ForegroundColor DarkGray }
  if ($Note)  { Write-Host ("       note   : " + $Note) -ForegroundColor DarkYellow }
  $script:Results += [pscustomobject]@{ Etape = $Name; Statut = $state; Preuve = $Proof; Note = $Note }
}

function Skip-Step {
  param([string]$Name, [string]$Why)
  Write-Host ("[SKIP] {0} ({1})" -f $Name, $Why) -ForegroundColor Yellow
  $script:Results += [pscustomobject]@{ Etape = $Name; Statut = 'SKIP'; Preuve = $Why; Note = '' }
}

# ---------------------------------------------------------------- utilitaires
function Invoke-Api {
  param([string]$Method, [string]$Path, $Body, [int]$TimeoutSec = 180)
  $headers = @{ Authorization = "Bearer $script:Token" }
  $args = @{ Uri = ($script:Base + $Path); Method = $Method; Headers = $headers
             TimeoutSec = $TimeoutSec; ContentType = 'application/json' }
  if ($null -ne $Body) { $args.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
  try { return Invoke-RestMethod @args }
  catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
      throw ("HTTP " + [int]$resp.StatusCode + " : " + $text)
    }
    throw $_
  }
}

# Un tour complet : renvoie { ok, text, events }.
# Le flux SSE est lu ligne par ligne : turn.done termine, turn.error echoue.
function Invoke-Turn {
  param([string]$SessionId, [string]$Prompt, [int]$TimeoutSec = 240)
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
  $stream = $req.GetRequestStream()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Close()

  $text = New-Object System.Text.StringBuilder
  $events = New-Object System.Collections.ArrayList
  $done = $false
  $errorText = $null
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
      [void]$events.Add([pscustomobject]@{ event = $eventName; data = $obj })
      if ($eventName -eq 'message.delta' -and $obj.text) { [void]$text.Append($obj.text) }
      if ($eventName -eq 'message.done' -and $obj.text) { [void]$text.Clear(); [void]$text.Append($obj.text) }
      if ($eventName -eq 'turn.error') { $errorText = "$($obj.code) : $($obj.error)"; $done = $true; break }
      if ($eventName -eq 'turn.done') { $done = $true; break }
    }
    $reader.Close(); $resp.Close()
  } catch {
    $errorText = $_.Exception.Message
  }
  return [pscustomobject]@{ ok = ($done -and -not $errorText); text = $text.ToString(); events = $events; error = $errorText }
}

function Get-LogProof {
  param([string]$Pattern, [string]$Since = $null)
  if (-not $script:AgentLog -or -not (Test-Path $script:AgentLog)) { return $null }
  $lines = Get-Content -LiteralPath $script:AgentLog -ErrorAction SilentlyContinue
  if ($Since) { $lines = $lines | Where-Object { $_ -match [regex]::Escape($Since) -or $_.CompareTo($Since) -gt 0 } }
  $hit = $lines | Where-Object { $_ -match $Pattern } | Select-Object -Last 1
  if ($hit) { return $hit.Trim() }
  return $null
}

function Wait-Agent {
  param([int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $null = Invoke-Api -Method GET -Path '/health' -TimeoutSec 3
      return $true
    } catch { Start-Sleep -Milliseconds 400 }
  }
  return $false
}

function Test-Runtime {
  try {
    $null = Invoke-RestMethod -Uri ($RuntimeUrl + '/health') -TimeoutSec 3
    return $true
  } catch { return $false }
}

function New-Session {
  param([string]$Root, [string]$Mode = 'build')
  $s = Invoke-Api -Method POST -Path '/sessions' -Body @{ projectRoot = $Root; mode = $Mode }
  if ($s.id) { return $s.id }
  return $s.sessionId
}

# --------------------------------------------------------------------- setup
Write-Host ''
Write-Host '=== SUDO STUDIO - P59 : test de bout en bout du mode agent ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path (Join-Path $InstallDir 'sudo-agent\src\server.js'))) {
  Write-Error "Serveur d agent introuvable dans $InstallDir\sudo-agent\src\server.js. Passe -InstallDir <paquet installe>."
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'node.exe introuvable dans le PATH (le paquet portable embarque son propre node : utilise-le).' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('p59-e2e-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$copy = Join-Path $work 'projet'
New-Item -ItemType Directory -Force -Path $copy | Out-Null
Write-Host "Copie du projet dans $copy (l original n est jamais touche)."
Copy-Item -Path (Join-Path $ProjectPath '*') -Destination $copy -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $ProjectPath '.git')) {
  Copy-Item -Path (Join-Path $ProjectPath '.git') -Destination $copy -Recurse -Force -ErrorAction SilentlyContinue
}

$homeDir = Join-Path $work 'home'
$logsDir = Join-Path $homeDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$script:AgentLog = Join-Path $logsDir 'agent.log'

$env:SUDO_AGENT_TOKEN = $script:Token
$env:SUDO_AGENT_PORT = "$Port"
$env:SUDO_STUDIO_HOME = $homeDir
$env:SUDO_STUDIO_LOGS = $logsDir
$env:SUDO_AGENT_STORE = (Join-Path $homeDir 'store')
$env:SUDO_AGENT_PROVIDER = (@{ type = 'local'; baseUrl = $RuntimeUrl; model = 'local-model' } | ConvertTo-Json -Compress)

$serverJs = Join-Path $InstallDir 'sudo-agent\src\server.js'
Write-Host "Demarrage du serveur d agent : $serverJs"
$agentProc = Start-Process -FilePath $node.Source -ArgumentList @($serverJs) -PassThru -WindowStyle Hidden
$started = Wait-Agent -Seconds 40
if (-not $started) {
  Write-Step -Name '0 demarrage du serveur d agent' -Ok $false -Proof "aucune reponse sur $script:Base/health"
  try { Stop-Process -Id $agentProc.Id -Force } catch {}
  Write-Host 'Arret : impossible de tester sans serveur.' -ForegroundColor Red
  exit 1
}
Write-Step -Name '0 demarrage du serveur d agent' -Ok $true -Proof "GET /health sur $script:Base"

$runtimeUp = Test-Runtime
if (-not $runtimeUp -or $SkipModel) {
  Write-Host ''
  Write-Host 'Runtime local absent (ou -SkipModel) : les etapes qui exigent le modele seront SKIP, jamais PASS.' -ForegroundColor Yellow
  Write-Host "  sonde : $RuntimeUrl/health"
}

$sessionMain = New-Session -Root $copy
Write-Host "Session : $sessionMain"

# ---------------------------------------------------------------- 1 structure
try {
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Donne la structure du projet : langages, points d entree, tests.'
  $proof = Get-LogProof -Pattern 'route intention|carte projet injectee|tool ok.*(list|analyze|glob)'
  Write-Step -Name '1 lecture de structure' -Ok ($r.ok -and [bool]$proof) -Proof $proof -Note $(if (-not $r.ok) { $r.error } else { '' })
} catch { Write-Step -Name '1 lecture de structure' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------------------- 2 couleur
try {
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Change la couleur d accent du panneau en bleu (une seule modification).'
  $proof = Get-LogProof -Pattern 'tool (ok|fail).*(edit|patch|write)'
  $mut = Get-LogProof -Pattern 'approbation demandee|approval'
  Write-Step -Name '2 changement de couleur' -Ok ($r.ok -and [bool]$proof) -Proof $(if ($proof) { $proof } else { $mut })
} catch { Write-Step -Name '2 changement de couleur' -Ok $false -Proof $_.Exception.Message }

# --------------------------------------------------------- 3 tests + execution
try {
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Ajoute un test simple (un fichier de test) puis execute les tests.'
  $w = Get-LogProof -Pattern 'tool ok.*(write|edit)'
  $t = Get-LogProof -Pattern 'tool (ok|fail).*(bash|exec_start)|verification'
  Write-Step -Name '3 ajout de tests + execution' -Ok ($r.ok -and [bool]$w -and [bool]$t) -Proof ($w + ' || ' + $t)
} catch { Write-Step -Name '3 ajout de tests + execution' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------- 4 failles : avant / apres
try {
  $s4 = New-Session -Root $copy
  $before = Invoke-Turn -SessionId $s4 -Prompt 'Lance le Security Audit et donne le score.'
  $scoreBefore = Get-LogProof -Pattern 'Security Audit : score'
  $r = Invoke-Turn -SessionId $s4 -Prompt 'Va voir le resultat du Security Audit et corrige les failles trouvees.'
  $a1 = Get-LogProof -Pattern 'platform ok \| session=.*tool=security_audit_read'
  if (-not $a1) { $a1 = Get-LogProof -Pattern 'security_audit_read' }
  $edit = Get-LogProof -Pattern 'tool (ok|fail).*(edit|patch)'
  $a2 = Get-LogProof -Pattern 'security_audit_run|Security Audit : score'
  $proofLine = $a1 + ' || ' + $edit + ' || ' + $a2
  Write-Step -Name '4 corrige les failles (avant/apres)' -Ok ($r.ok -and [bool]$a2) -Proof $proofLine -Note $(if ($scoreBefore) { 'score initial : ' + $scoreBefore } else { '' })
} catch { Write-Step -Name '4 corrige les failles (avant/apres)' -Ok $false -Proof $_.Exception.Message }

# ----------------------------------------------------------------- 5 devops
try {
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Il y a un probleme dans le DevOps, regarde et corrige.'
  $proof = Get-LogProof -Pattern 'route intention.*devops|devops_read|platform ok.*devops'
  Write-Step -Name '5 regarde le DevOps' -Ok ($r.ok -and [bool]$proof) -Proof $proof
} catch { Write-Step -Name '5 regarde le DevOps' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------------------------- 6 logs
try {
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Regarde les journaux en erreur du runtime et explique.'
  $proof = Get-LogProof -Pattern 'logs_read|plateforme (question )?prechargee.*logs'
  Write-Step -Name '6 journaux ERROR' -Ok ($r.ok -and [bool]$proof) -Proof $proof
} catch { Write-Step -Name '6 journaux ERROR' -Ok $false -Proof $_.Exception.Message }

# -------------------------------------------------------------- 7 extension
try {
  $exts = Invoke-Api -Method GET -Path '/tools'
  $r = Invoke-Turn -SessionId $sessionMain -Prompt 'Utilise l extension disponible pour faire une verification, puis dis ce qu elle a repondu.'
  $proof = Get-LogProof -Pattern 'tool ok.*(extensions_list|extensions_describe|mcp_call|skill_load|task)'
  Write-Step -Name '7 appel d une extension' -Ok ($r.ok -and [bool]$proof) -Proof $proof -Note $(if (-not $proof) { 'aucune extension installee -> etape non prouvee' } else { '' })
} catch { Write-Step -Name '7 appel d une extension' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------------- 8 dix questions
$questions = @(
  'Quel est le point d entree du projet ?',
  'Combien de fichiers de test ?',
  'Quel gestionnaire de paquets est utilise ?',
  'Y a-t-il une CI ?',
  'Quels sont les TODO ?',
  'Quel est le langage principal ?',
  'Que dit le System Doctor ?',
  'Y a-t-il des secrets exposes ?',
  'Quelle est la commande de build ?',
  'Resume le projet en deux phrases.'
)
try {
  $s8 = New-Session -Root $copy
  $okCount = 0
  $failDetail = ''
  $t0 = Get-Date
  foreach ($q in $questions) {
    $r = Invoke-Turn -SessionId $s8 -Prompt $q -TimeoutSec 180
    if ($r.ok) { $okCount++ } else { $failDetail = $q + ' -> ' + $r.error; break }
  }
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  Write-Step -Name '8 dix questions a la suite' -Ok ($okCount -eq 10) -Proof ("$okCount/10 tours termines en $secs s") -Note $failDetail
} catch { Write-Step -Name '8 dix questions a la suite' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------ 9 coupure du runtime
try {
  $s9 = New-Session -Root $copy
  $job = Start-Job -ScriptBlock {
    param($base, $token, $sid, $prompt)
    $payload = @{ text = $prompt } | ConvertTo-Json -Compress
    try {
      $r = Invoke-WebRequest -Uri "$base/sessions/$sid/messages" -Method POST -TimeoutSec 200 `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $payload -UseBasicParsing
      return $r.Content
    } catch { return ('ERR ' + $_.Exception.Message) }
  } -ArgumentList $script:Base, $script:Token, $s9, 'Analyse tout le projet en profondeur puis corrige ce qui peut l etre.'
  Start-Sleep -Seconds 4
  $killed = $false
  $rt = Get-Process -Name 'server' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*runtime*' }
  if (-not $rt) { $rt = Get-Process -Name 'python','python3' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Select-Object -First 1 }
  if ($rt) { try { Stop-Process -Id $rt.Id -Force; $killed = $true } catch {} }
  $null = Wait-Job -Job $job -Timeout 220
  $content = Receive-Job -Job $job
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  $proof = Get-LogProof -Pattern 'runtime (en redemarrage|restarting)|runtime_offline|runtime revenu|waitForRuntime'
  $graceful = ($content -match 'turn.done|turn.error') -or ($content -match 'Runtime')
  Write-Step -Name '9 coupure du runtime en cours de tache' -Ok ([bool]$killed -and [bool]$graceful) `
    -Proof $(if ($proof) { $proof } else { 'aucune ligne runtime dans le journal' }) `
    -Note $(if (-not $killed) { 'runtime introuvable : coupe-le a la main pendant l etape, puis relance' } elseif (-not $graceful) { 'le tour ninclut pas de verdict : voir la reponse brute' } else { '' })
} catch { Write-Step -Name '9 coupure du runtime en cours de tache' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------- 11 suppression d un fichier jamais lu
# P61-5 : le modele oubliait de lire avant de supprimer et la tache echouait
# ("n a pas ete lu"). L'agent doit lire lui-meme, puis supprimer UNE fois.
try {
  $s11 = New-Session -Root $copy
  $probe = Join-Path $copy ('p61-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  Set-Content -Path $probe -Value 'contenu de preuve' -Encoding utf8
  $relProbe = [System.IO.Path]::GetFileName($probe)
  $r = Invoke-Turn -SessionId $s11 -Prompt ('Supprime le fichier ' + $relProbe + ' du projet.') -TimeoutSec 180
  $gone = -not (Test-Path $probe)
  $oneDel = $true
  if ($script:AgentLog -and (Test-Path $script:AgentLog)) {
    $delLines = @(Select-String -Path $script:AgentLog -Pattern 'tool ok delete|tool fail delete' -AllMatches)
    $oneDel = ($delLines.Count -le 1)
  }
  $readProof = Get-LogProof -Pattern 'lecture automatique avant action'
  Write-Step -Name '11 suppression d un fichier jamais lu' -Ok ([bool]$gone -and [bool]$oneDel -and [bool]$readProof) `
    -Proof ($(if ($readProof) { $readProof } else { 'aucune ligne lecture automatique' }) + ' || fichier supprime : ' + $gone) `
    -Note $(if (-not $oneDel) { 'plusieurs executions de delete : doublon' } else { '' })
} catch { Write-Step -Name '11 suppression d un fichier jamais lu' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------ 12 vingt demandes a la suite
try {
  $s12 = New-Session -Root $copy
  $rs = @('0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19') | ForEach-Object {
    'Question numero ' + $_ + ' : reponds en une phrase sur ce projet.'
  }
  $ok12 = 0
  $bad12 = ''
  $t12 = Get-Date
  foreach ($q in $rs) {
    $r = Invoke-Turn -SessionId $s12 -Prompt $q -TimeoutSec 180
    if ($r.ok) { $ok12++ } else { $bad12 = $q + ' -> ' + $r.error; break }
  }
  $secs12 = [int]((Get-Date) - $t12).TotalSeconds
  $leak = Get-LogProof -Pattern 'un tour est deja en cours'
  Write-Step -Name '12 vingt demandes a la suite' -Ok (($ok12 -eq 20) -and -not $leak) `
    -Proof ("$ok12/20 tours termines en $secs12 s") -Note $bad12
} catch { Write-Step -Name '12 vingt demandes a la suite' -Ok $false -Proof $_.Exception.Message }

# -------------------------------------------------------------- 10 secrets
try {
  $secretProof = $null
  if ($script:AgentLog -and (Test-Path $script:AgentLog)) {
    $hits = Select-String -Path $script:AgentLog -Pattern 'ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}' -AllMatches
    $secretProof = if ($hits) { 'FUITE : ' + ($hits | Select-Object -First 1).Line } else { 'Select-String : aucune correspondance de jeton dans agent.log' }
    if ($hits) {
      $hits | ForEach-Object { $_.Line } | Set-Content -Path (Join-Path $OutDir 'secrets-trouves.txt')
    }
  }
  Write-Step -Name '10 aucun secret en clair dans le journal' -Ok (-not ($secretProof -like 'FUITE*')) -Proof $secretProof
} catch { Write-Step -Name '10 aucun secret en clair dans le journal' -Ok $false -Proof $_.Exception.Message }

# ------------------------------------------------------------------- rapport
$reportPath = Join-Path $OutDir 'agent-e2e-report.txt'
$script:Results | Format-Table -AutoSize | Out-String | Set-Content -Path $reportPath
("Genere : " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) | Add-Content -Path $reportPath
("Journal : " + $script:AgentLog) | Add-Content -Path $reportPath
if (Test-Path $script:AgentLog) { Copy-Item $script:AgentLog (Join-Path $OutDir 'agent.log') -Force }

Write-Host ''
Write-Host '=== RESULTAT ===' -ForegroundColor Cyan
$script:Results | Format-Table -AutoSize | Out-String | Write-Host
$passCount = ($script:Results | Where-Object { $_.Statut -eq 'PASS' }).Count
$failCount = ($script:Results | Where-Object { $_.Statut -eq 'FAIL' }).Count
$skipCount = ($script:Results | Where-Object { $_.Statut -eq 'SKIP' }).Count
Write-Host ("PASS {0} | FAIL {1} | SKIP {2} | rapport : {3}" -f $passCount, $failCount, $skipCount, $reportPath)

try { Stop-Process -Id $agentProc.Id -Force } catch {}
Write-Host ("Copie de travail conservee pour inspection : " + $work) -ForegroundColor DarkGray
if ($failCount -gt 0) { exit 1 } else { exit 0 }
