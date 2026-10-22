# P43-5: agent benchmark harness (automatic + resumable).
# Drives REAL turns against the INSTALLED product (agent server spawned from
# the install dir, real local runtime) on disposable COPIES of owner
# projects (originals are never touched). Default matrix: N projects x
# 5 tasks x 10 trials per cell. Fast mode: 5 trials total.
#
#   powershell -ExecutionPolicy Bypass -File scripts\bench-agent.ps1 `
#     -Projects C:\dev\projA, C:\dev\projB, C:\dev\projC `
#     -InstallDir 'C:\Program Files\Sudo Studio'
#
# ASCII only.
param(
    [Parameter(Mandatory = $true)][string[]]$Projects,
    [string]$InstallDir = "$env:ProgramFiles\Sudo Studio",
    [string[]]$Tasks = @('T1-explain', 'T2-deps', 'T3-create', 'T4-fix', 'T5-summarize'),
    [int]$TrialsPerCell = 10,
    [switch]$Fast,
    [string]$Model = '',
    [string]$RuntimeUrl = 'http://127.0.0.1:6000',
    [string]$OutDir = '',
    [string]$StateFile = '',
    [int]$TurnTimeoutSec = 300
)

$ErrorActionPreference = 'Stop'

# -- tasks -------------------------------------------------------------------
$TASKS = @{
    'T1-explain'   = 'Explique ce projet en 5 phrases.'
    'T2-deps'      = 'Liste les 5 dependances principales de ce projet.'
    'T3-create'    = 'Cree un fichier NOTE_P43.md a la racine du projet contenant exactement une ligne : P43-OK'
    'T4-fix'       = "Corrige l'erreur de syntaxe dans calc_p43.js (le fichier ne compile pas)."
    'T5-summarize' = 'Resume ce projet en une phrase.'
}
$BROKEN_JS = "function add(a b) { return a + b; }`nmodule.exports = { add };`n"
$SAFE_BASH = @('npm', 'npx', 'node', 'yarn', 'pnpm', 'pytest', 'python -m pytest', 'python -m unittest',
    'go test', 'dotnet test', 'flutter test', 'dart test', 'cargo test')

if ($Fast) { $TrialsPerCell = 1 }
foreach ($t in $Tasks) { if (-not $TASKS.ContainsKey($t)) { throw "tache inconnue : $t" } }
if ($Fast -and $Projects.Count -gt 1) { $Projects = @($Projects[0]) } # fast = 5 trials total

if (-not $OutDir) { $OutDir = Join-Path (Get-Location) ("bench-p43-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $StateFile) { $StateFile = Join-Path $OutDir 'state.json' }
$ResultsFile = Join-Path $OutDir 'results.jsonl'
$SummaryFile = Join-Path $OutDir 'summary.json'
$WorkDir = Join-Path $OutDir 'work'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Log($msg) { Write-Host ("[bench] " + $msg) }

# -- resume state --------------------------------------------------------------
$state = @{ done = @{} }
if (Test-Path $StateFile) {
    try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } catch { Log "WARN: etat illisible, reprise a zero" }
    if (-not $state.done) { $state.done = @{} }
}
function Save-State() {
    $tmp = $StateFile + '.tmp'
    ($state | ConvertTo-Json -Depth 6 -Compress) | Set-Content $tmp -Encoding UTF8
    Move-Item $tmp $StateFile -Force
}

# -- preflight -----------------------------------------------------------------
$exe = Join-Path $InstallDir 'SudoStudio.exe'
$serverJs = Join-Path $InstallDir 'sudo-agent\src\server.js'
if (-not (Test-Path $exe)) { throw "introuvable : $exe" }
if (-not (Test-Path $serverJs)) { throw "introuvable : $serverJs" }
foreach ($p in $Projects) { if (-not (Test-Path $p -PathType Container)) { throw "projet introuvable : $p" } }

function Rt-Health() {
    try { return (Invoke-RestMethod -Uri ($RuntimeUrl + '/health') -TimeoutSec 10) }
    catch { return $null }
}
if ($Model) {
    Log "chargement modele : $Model"
    Invoke-RestMethod -Uri ($RuntimeUrl + '/reload') -Method POST `
        -Body (@{ model = $Model } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 30 | Out-Null
    $deadline = (Get-Date).AddSeconds(600)
    $h = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $h = Rt-Health
        if ($h -and $h.model.loaded) { break }
    }
    if (-not ($h -and $h.model.loaded)) { throw 'modele non charge apres 600s' }
}
$health = Rt-Health
if (-not ($health -and $health.model.loaded)) { throw 'runtime sans modele : chargez un modele puis relancez.' }
$benchModel = $health.model.name
$benchNctx = $health.model.n_ctx
Log ("runtime OK : model={0} n_ctx={1}" -f $benchModel, $benchNctx)

# -- agent server (product exe, Electron-as-Node, real local provider) ---------
$token = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$env:ELECTRON_RUN_AS_NODE = '1'
$env:SUDO_AGENT_TOKEN = $token
$env:SUDO_AGENT_PORT = '0'
$env:SUDO_AGENT_PROVIDER = (@{ type = 'local'; baseUrl = $RuntimeUrl } | ConvertTo-Json -Compress)
$ao = Join-Path $OutDir 'agent-stdout.txt'
$ae = Join-Path $OutDir 'agent-stderr.txt'
$ap = Start-Process -FilePath $exe -ArgumentList "`"$serverJs`"" -NoNewWindow `
    -RedirectStandardOutput $ao -RedirectStandardError $ae -PassThru
$AgentPort = 0
try {
    $deadline = (Get-Date).AddSeconds(60)
    $hs = $null
    while ((Get-Date) -lt $deadline -and -not $hs) {
        Start-Sleep -Seconds 2
        if (Test-Path $ao) { $hs = Select-String -Path $ao -Pattern '^\{"ready":true' | Select-Object -First 1 }
    }
    if (-not $hs) { throw 'agent: pas de handshake en 60s (voir agent-stdout.txt)' }
    $AgentPort = ($hs.Line | ConvertFrom-Json).port
    Log "agent OK : port=$AgentPort"
} catch { try { Stop-Process -Id $ap.Id -Force } catch {}; throw }

$Headers = @{ Authorization = ("Bearer {0}" -f $token) }
function Api($method, $path, $body) {
    $kw = @{ Uri = ("http://127.0.0.1:{0}{1}" -f $AgentPort, $path); Method = $method;
        Headers = $Headers; TimeoutSec = 60; ContentType = 'application/json' }
    if ($null -ne $body) { $kw.Body = ($body | ConvertTo-Json -Depth 8 -Compress) }
    return Invoke-RestMethod @kw
}

# POST messages, read SSE until turn.done / turn.error / timeout.
function Do-Turn($sessionId, $prompt) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TurnTimeoutSec)
    try {
        $url = "http://127.0.0.1:$AgentPort/sessions/$sessionId/messages"
        $req = New-Object System.Net.Http.HttpRequestMessage(
            [System.Net.Http.HttpMethod]::Post, $url)
        $req.Headers.Add('Authorization', "Bearer $token")
        $json = (@{ prompt = $prompt } | ConvertTo-Json -Compress)
        $req.Content = New-Object System.Net.Http.StringContent(
            $json, [System.Text.Encoding]::UTF8, 'application/json')
        $resp = $client.SendAsync($req,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        if (-not $resp.IsSuccessStatusCode) {
            return @{ ok = $false; http = [int]$resp.StatusCode; text = ''; turn = $null }
        }
        $reader = New-Object System.IO.StreamReader($resp.Content.ReadAsStreamAsync().Result)
        $cur = 'message'
        $text = ''
        $turn = $null
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            $line = $line.Trim()
            if (-not $line) { continue }
            if ($line.StartsWith('event:')) { $cur = $line.Substring(6).Trim(); continue }
            if (-not $line.StartsWith('data:')) { continue }
            $obj = $null
            try { $obj = $line.Substring(5).Trim() | ConvertFrom-Json } catch { continue }
            if ($cur -eq 'message.done') { $text = [string]$obj.text }
            elseif ($cur -eq 'turn.done') { $turn = $obj; break }
            elseif ($cur -eq 'turn.error') {
                return @{ ok = $false; http = 0; text = $text; turn = $null; error = [string]$obj.error }
            }
            $cur = 'message'
        }
        if ($null -eq $turn) { return @{ ok = $false; http = 0; text = $text; turn = $null; error = 'flux sans turn.done' } }
        return @{ ok = $true; http = 200; text = $text; turn = $turn }
    } catch {
        try { Api 'POST' "/sessions/$sessionId/abort" @{} | Out-Null } catch {}
        return @{ ok = $false; http = 0; text = ''; turn = $null; error = 'timeout/abandon : ' + $_.Exception.Message }
    } finally { $client.Dispose() }
}

# Approve pending requests on disposable copies (documented auto-policy).
function Approve-All($sessionId) {
    $n = 0
    try { $pend = Api 'GET' "/sessions/$sessionId/approvals" $null } catch { return 0 }
    foreach ($r in $pend.pending) {
        $tool = [string]$r.tool
        $decision = 'deny'
        if (@('read', 'list', 'glob', 'grep', 'todo', 'write', 'edit') -contains $tool) { $decision = 'session' }
        elseif ($tool -eq 'bash') {
            $cmd = [string]$r.summary
            foreach ($s in $SAFE_BASH) { if ($cmd.StartsWith($s)) { $decision = 'session'; break } }
        }
        try { Api 'POST' "/sessions/$sessionId/approvals" @{ requestId = $r.id; decision = $decision } | Out-Null; $n++ } catch {}
    }
    return $n
}

# -- project fingerprints (expected answers, computed by the bench) ------------
function Get-Stack($copy) {
    if (Test-Path (Join-Path $copy 'pubspec.yaml')) { return @('flutter', 'dart') }
    if (Test-Path (Join-Path $copy 'next.config.mjs')) { return @('next') }
    if (Test-Path (Join-Path $copy 'next.config.js')) { return @('next') }
    if (Test-Path (Join-Path $copy 'package.json')) {
        try {
            $pj = Get-Content (Join-Path $copy 'package.json') -Raw | ConvertFrom-Json
            $deps = @()
            if ($pj.dependencies) { $deps += @($pj.dependencies.PSObject.Properties.Name) }
            if ($deps -contains 'react') { return @('react', 'node') }
            if ($deps -contains 'vue') { return @('vue', 'node') }
        } catch {}
        return @('node', 'npm', 'javascript')
    }
    if ((Test-Path (Join-Path $copy 'requirements.txt')) -or (Test-Path (Join-Path $copy 'pyproject.toml'))) { return @('python') }
    if (Test-Path (Join-Path $copy 'go.mod')) { return @('go') }
    if (@(Get-ChildItem $copy -Filter '*.csproj').Count -gt 0) { return @('c#', 'dotnet', 'net') }
    return @((Split-Path $copy -Leaf).ToLower())
}
function Get-Deps($copy) {
    $out = @()
    $pj = Join-Path $copy 'package.json'
    if (Test-Path $pj) {
        try {
            $j = Get-Content $pj -Raw | ConvertFrom-Json
            if ($j.dependencies) { $out += @($j.dependencies.PSObject.Properties.Name) }
            if ($j.devDependencies) { $out += @($j.devDependencies.PSObject.Properties.Name) }
        } catch {}
    }
    $pub = Join-Path $copy 'pubspec.yaml'
    if (($out.Count -eq 0) -and (Test-Path $pub)) {
        $inDeps = $false
        foreach ($ln in (Get-Content $pub)) {
            if ($ln -match '^dependencies:\s*$') { $inDeps = $true; continue }
            if ($inDeps -and $ln -match '^\S') { break }
            if ($inDeps -and $ln -match '^\s{2}([\w-]+):') { $out += $Matches[1] }
        }
    }
    $req = Join-Path $copy 'requirements.txt'
    if (($out.Count -eq 0) -and (Test-Path $req)) {
        foreach ($ln in (Get-Content $req)) {
            $t = ($ln -replace '[#;].*$', '').Trim()
            if ($t -match '^([A-Za-z0-9_-]+)') { $out += $Matches[1].ToLower() }
        }
    }
    return @($out | Select-Object -First 5)
}

# -- trial ---------------------------------------------------------------------
function Run-Trial($projPath, $projIdx, $task, $trial) {
    $key = "$projIdx|$task|$trial"
    $t0 = Get-Date
    $copy = Join-Path $WorkDir ("p{0}-{1}-t{2:00}" -f $projIdx, $task, $trial)
    if (Test-Path $copy) { Remove-Item $copy -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $copy | Out-Null
    robocopy $projPath $copy /MIR /XD node_modules .next dist build out .git .dart_tool `
        /XF '*.log' /NFL /NDL /NJH /NJS | Out-Null
    if ($task -eq 'T4-fix') {
        Set-Content (Join-Path $copy 'calc_p43.js') $BROKEN_JS -Encoding UTF8
    }
    $stack = Get-Stack $copy
    $deps = Get-Deps $copy
    $checks = @{}
    $pass = $false
    $turn = $null
    $text = ''
    $turnOk = $false
    try {
        $s = Api 'POST' '/sessions' @{ title = "bench-$key"; projectRoot = $copy }
        $sid = $s.id
        $r = Do-Turn $sid $TASKS[$task]
        $nAppr = Approve-All $sid
        if ($nAppr -gt 0) {
            Start-Sleep -Seconds 1
            $r2 = Do-Turn $sid 'confirme.'
            if ($r2.ok) { $r = $r2 }
        }
        $turn = $r.turn
        $text = [string]$r.text
        $turnOk = [bool]$r.ok
        $status = if ($turn) { [string]$turn.status } else { '' }
        $low = $text.ToLower()
        $clean = ($text -notmatch 'generee sans IA') -and ($text -notmatch 'rien a resumer') `
            -and ($text -notmatch 'Contexte sature')
        $hasStack = $false
        foreach ($k in $stack) { if ($low.Contains($k.ToLower())) { $hasStack = $true; break } }
        switch ($task) {
            'T1-explain' {
                $checks = @{ turnOk = $turnOk; termine = ($status -eq 'TERMINE');
                    longEnough = ($text.Length -ge 200); stack = $hasStack; clean = $clean }
                $pass = $turnOk -and ($status -eq 'TERMINE') -and ($text.Length -ge 200) -and $hasStack -and $clean
            }
            'T2-deps' {
                $hits = 0
                foreach ($d in $deps) { if ($low.Contains([string]$d).ToLower()) { $hits++ } }
                $checks = @{ turnOk = $turnOk; depHits = $hits; depNeed = 2; clean = $clean }
                $pass = $turnOk -and ($hits -ge 2) -and $clean
            }
            'T3-create' {
                $f = Join-Path $copy 'NOTE_P43.md'
                $exact = (Test-Path $f) -and ((Get-Content $f -Raw).Trim() -eq 'P43-OK')
                $checks = @{ fileExact = $exact }
                $pass = $exact
            }
            'T4-fix' {
                $f = Join-Path $copy 'calc_p43.js'
                $fixed = (Test-Path $f) -and ((Get-Content $f -Raw) -match 'function add\(a, b\)')
                $checks = @{ fixed = $fixed }
                $pass = $fixed
            }
            'T5-summarize' {
                $checks = @{ turnOk = $turnOk; termine = ($status -eq 'TERMINE');
                    lenOk = ($text.Length -ge 30 -and $text.Length -le 500);
                    stack = $hasStack; clean = $clean }
                $pass = $turnOk -and ($status -eq 'TERMINE') -and ($text.Length -ge 30) `
                    -and ($text.Length -le 500) -and $hasStack -and $clean
            }
        }
    } catch {
        $checks = @{ exception = $_.Exception.Message }
    }
    $ms = [int]((Get-Date) - $t0).TotalMilliseconds
    $rec = [ordered]@{ key = $key; project = $projPath; task = $task; trial = $trial;
        ts = (Get-Date).ToString('o'); ms = $ms; model = $benchModel; n_ctx = $benchNctx;
        turnOk = $turnOk; runStatus = if ($turn) { [string]$turn.status } else { '' };
        stopReason = if ($turn) { [string]$turn.stopReason } else { '' };
        textLen = $text.Length; pass = $pass; checks = $checks;
        text = $text.Substring(0, [Math]::Min(4000, $text.Length)) }
    ($rec | ConvertTo-Json -Depth 6 -Compress) | Add-Content $ResultsFile -Encoding UTF8
    $state.done[$key] = @{ pass = $pass; ms = $ms }
    Save-State
    return $rec
}

# -- matrix --------------------------------------------------------------------
try {
    $total = 0
    $done0 = 0
    $cells = @{}
    for ($pi = 0; $pi -lt $Projects.Count; $pi++) {
        foreach ($task in $Tasks) {
            $cellKey = "$pi|$task"
            $cells[$cellKey] = @{ pass = 0; total = 0 }
            for ($tr = 1; $tr -le $TrialsPerCell; $tr++) {
                $total++
                $key = "$pi|$task|$tr"
                if ($state.done.ContainsKey($key)) {
                    $done0++
                    $cells[$cellKey].total++
                    if ($state.done[$key].pass) { $cells[$cellKey].pass++ }
                    continue
                }
                Log ("essai {0}/{1} : projet#{2} {3} #{4}" -f $total, ($Projects.Count * $Tasks.Count * $TrialsPerCell), $pi, $task, $tr)
                $rec = Run-Trial $Projects[$pi] $pi $task $tr
                $cells[$cellKey].total++
                if ($rec.pass) { $cells[$cellKey].pass++ }
                Log ("  -> {0} ({1} ms, {2})" -f ($(if ($rec.pass) { 'PASS' } else { 'FAIL' }), $rec.ms, $rec.runStatus))
            }
        }
    }
    $summary = [ordered]@{ startedAt = ''; finishedAt = (Get-Date).ToString('o');
        model = $benchModel; n_ctx = $benchNctx;
        params = @{ projects = $Projects; tasks = $Tasks; trialsPerCell = $TrialsPerCell; fast = [bool]$Fast };
        resumed = $done0; cells = $cells }
    ($summary | ConvertTo-Json -Depth 6) | Set-Content $SummaryFile -Encoding UTF8
    Log '=== recapitulatif (pass/total par case) ==='
    foreach ($ck in ($cells.Keys | Sort-Object)) {
        Log ("  {0} : {1}/{2}" -f $ck, $cells[$ck].pass, $cells[$ck].total)
    }
    Log ("resultats bruts : {0}" -f $ResultsFile)
} finally {
    try { Stop-Process -Id $ap.Id -Force -ErrorAction SilentlyContinue } catch {}
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:SUDO_AGENT_TOKEN = $null
    $env:SUDO_AGENT_PORT = $null
    $env:SUDO_AGENT_PROVIDER = $null
}
