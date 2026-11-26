<#
  SUDO STUDIO - P71 partie E13 : collecte des journaux + rejeu (a), (d), (e).

  Ce script :
    1. copie les journaux analysis, analysis.jsonl, autofix, sdk, engine-child,
       runtime_crash, runtime_debug, agent dans un ZIP sur le Bureau ;
    2. rejoue (a) recommandations deterministes < 2 s ;
    3. rejoue (d) Doctor : premier diagnostic (Node, npm, git, Python) ;
    4. rejoue (e) "installe mais hors PATH" -> reparation du PATH utilisateur ;
    5. ecrit un PASS/FAIL avec la ligne de journal prouvante.

  Usage :
      powershell -ExecutionPolicy Bypass -File scripts\ci\collect-and-verify-p71.ps1
      ... -ZipOnly        # collecte seulement

  Sortie : p71-verify.txt (a cote du ZIP), code 0 si tout passe.
#>
param(
    [switch]$ZipOnly,
    [string]$OutDir = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zip = Join-Path $OutDir ("sudo-studio-journaux-p71-" + $stamp + ".zip")
$report = Join-Path $OutDir ("p71-verify-" + $stamp + ".txt")

function Say($line) { Write-Host $line; Add-Content -Path $report -Value $line -Encoding UTF8 }

Say "P71 - collecte et verification ($stamp)"
Say ("racine du depot : " + $root)

# ---------------------------------------------------------------- 1. journaux
$logRoots = @(
    (Join-Path $env:APPDATA "Sudo Studio\logs"),
    (Join-Path $env:LOCALAPPDATA "Sudo Studio\logs"),
    (Join-Path $env:USERPROFILE ".sudo_studio\logs"),
    (Join-Path $root "logs")
)
$names = @("analysis", "analysis.jsonl", "autofix", "sdk", "engine-child", "runtime_crash", "runtime_debug", "agent")
$found = @()
foreach ($dir in $logRoots) {
    if (-not (Test-Path $dir)) { continue }
    foreach ($n in $names) {
        Get-ChildItem -Path $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like ($n + "*") } |
            ForEach-Object { $found += $_.FullName }
    }
}
$found = $found | Sort-Object -Unique
Say ("journaux trouves : " + $found.Count)
foreach ($f in $found) { Say ("  " + $f) }

$tmp = Join-Path $env:TEMP ("p71-logs-" + $stamp)
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
foreach ($f in $found) {
    $sub = Split-Path -Leaf (Split-Path -Parent $f)
    $dest = Join-Path $tmp $sub
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item $f -Destination $dest -Force
}
if (Test-Path $zip) { Remove-Item $zip -Force }
if ((Get-ChildItem $tmp -Recurse -File | Measure-Object).Count -gt 0) {
    Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip -Force
    Say ("ZIP : " + $zip + " (" + [Math]::Round((Get-Item $zip).Length / 1KB, 1) + " Ko)")
} else {
    Say "aucun journal a zipper (le produit n a peut-etre pas encore tourne)"
}

if ($ZipOnly) { Say "RESULTAT : ZIP SEUL (aucun test joue)"; exit 0 }

# ---------------------------------------------------------------- 2. (a) deterministe
Say ""
Say "--- (a) recommandations deterministes < 2 s"
$recOut = & node "backend/tests/test-p71-recommendations.js" 2>&1
$recOut | ForEach-Object { Say $_ }
$recOk = ($recOut | Select-String -Pattern "all green").Count -gt 0
Say ("(a) " + $(if ($recOk) { "PASS" } else { "FAIL" }) + " | preuve : " + (($recOut | Select-String -Pattern "R2 recommandations").Line))

# ---------------------------------------------------------------- 3. (d) doctor premier diagnostic
Say ""
Say "--- (d) Doctor : premier diagnostic (Node, npm, git, Python)"
$doctorJs = @'
const dt = require('./sudo-ai-extension/src/doctor/detectTools');
(async () => {
  const r = await dt.detect(['node','npm','git','python','python3'], { timeoutMs: 15000 });
  console.log('JOURNAL ' + dt.journalLine(r));
  const need = ['node','npm','git'];
  const manquants = need.filter(n => r.missing.indexOf(n) !== -1);
  console.log('MANQUANTS ' + (manquants.join(',') || 'aucun'));
  console.log('SOURCE ' + JSON.stringify(r.sources));
  r.details.forEach(d => console.log('DETAIL ' + d.name + ' -> ' + (d.resolved || 'absent') + ' | ' + d.command + ' | ' + JSON.stringify(d.pathUsed).slice(0,120)));
  process.exit(manquants.length ? 1 : 0);
})();
'@
$doctorFile = Join-Path $env:TEMP "p71-doctor-check.js"
Set-Content -Path $doctorFile -Value $doctorJs -Encoding UTF8
Copy-Item $doctorFile (Join-Path $root "p71-doctor-check.js") -Force
$docOut = & node "p71-doctor-check.js" 2>&1
$docOut | ForEach-Object { Say $_ }
Remove-Item (Join-Path $root "p71-doctor-check.js") -Force -ErrorAction SilentlyContinue
$docOk = ($docOut | Select-String -Pattern "MANQUANTS aucun").Count -gt 0
Say ("(d) " + $(if ($docOk) { "PASS" } else { "FAIL" }) + " | preuve : " + (($docOut | Select-String -Pattern "JOURNAL").Line))

# ---------------------------------------------------------------- 4. (e) hors PATH -> reparation
Say ""
Say "--- (e) installe mais hors PATH -> reparation du PATH utilisateur"
$before = [Environment]::GetEnvironmentVariable("Path", "User")
Say ("PATH utilisateur avant : " + $(if ($before) { $before } else { "(vide)" }))
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Say "(e) NON CONCLUANT : node absent du PATH ; impossible de tester la reparation sans casser quelque chose."
    Say "RESULTAT : PARTIEL (voir plus haut)"
    exit 2
}
$nodeDir = Split-Path -Parent $nodeCmd.Source
$inUserPath = ($before -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ieq $nodeDir.TrimEnd("\")) }).Count -gt 0
if ($inUserPath) {
    Say ("(e) PASS | preuve : deja present dans le PATH utilisateur -> " + $nodeDir)
} else {
    $planJs = "const dt=require('./sudo-ai-extension/src/doctor/detectTools');const p=dt.planPathRepair(process.argv[2]);console.log(p.script);"
    Set-Content -Path (Join-Path $root "p71-pathplan.js") -Value $planJs -Encoding UTF8
    $script = & node "p71-pathplan.js" $nodeDir
    Remove-Item (Join-Path $root "p71-pathplan.js") -Force -ErrorAction SilentlyContinue
    & powershell -NoProfile -NonInteractive -Command $script | Out-Null
    $after = [Environment]::GetEnvironmentVariable("Path", "User")
    $ok = ($after -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ieq $nodeDir.TrimEnd("\")) }).Count -gt 0
    Say ("PATH utilisateur apres : " + $after)
    Say ("(e) " + $(if ($ok) { "PASS" } else { "FAIL" }) + " | preuve : " + $nodeDir + $(if ($ok) { " ajoute au PATH utilisateur (sans admin)" } else { " toujours absent" }))
    if (-not $ok) { $docOk = $false }
}

Say ""
$global:ok = $recOk -and $docOk
Say ("RESULTAT : " + $(if ($global:ok) { "PASS" } else { "FAIL" }))
Say ("rapport : " + $report)
Say ("zip     : " + $zip)
if ($global:ok) { exit 0 } else { exit 1 }
