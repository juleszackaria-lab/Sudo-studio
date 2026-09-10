param(
    [Parameter(Mandatory=$true)]
    [string]$VSCodiumDir
)
Write-Host "=== Sudo Studio Branding Customization ==="
Write-Host "VSCodium directory: $VSCodiumDir"
if (-not (Test-Path $VSCodiumDir)) {
    Write-Error "[ERREUR] VSCodiumDir introuvable: $VSCodiumDir"
    Write-Host "Usage: .\scripts\customize-vscodium.ps1 -VSCodiumDir <chemin>"
    exit 1
}
$resolved = Resolve-Path $VSCodiumDir -ErrorAction SilentlyContinue
if ($resolved) {
    $resolvedDir = $resolved.Path
}
else {
    $resolvedDir = $VSCodiumDir
}
Write-Host "Resolved path: $resolvedDir"
# ============================================================
# STEP 1 - product.json
# ============================================================
$productJsonPath = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $productJsonPath) {
    Write-Host "Found product.json at: $productJsonPath"
    try {
        $json = Get-Content $productJsonPath -Raw | ConvertFrom-Json
        $json | Add-Member -NotePropertyName "nameShort" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "nameLong" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "applicationName" -NotePropertyValue "sudo-studio" -Force
        $json | Add-Member -NotePropertyName "win32DirName" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "win32NameVersion" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "win32MutexName" -NotePropertyValue "sudostudio" -Force
        $json | Add-Member -NotePropertyName "win32RegValueName" -NotePropertyValue "SudoStudio" -Force
        $json | Add-Member -NotePropertyName "darwinBundleIdentifier" -NotePropertyValue "com.sudostudio.app" -Force
        $json | ConvertTo-Json -Depth 20 | Set-Content $productJsonPath -Encoding UTF8
        Write-Host "[OK] product.json updated with Sudo Studio branding"
    }
    catch {
        Write-Warning "[WARN] Failed to update product.json: $($_.Exception.Message)"
    }
}
else {
    Write-Warning "[WARN] product.json not found at: $productJsonPath"
}
# ============================================================
# STEP 2 - ICO icons
# ============================================================
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$logoIco = $null
$candidates = @(
    (Join-Path $resolvedDir "logo.ico"),
    (Join-Path $repoRoot "resources\logo.ico"),
    (Join-Path $repoRoot "resources\icon.ico")
)
foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
        $logoIco = $candidate
        break
    }
}
if ($logoIco) {
    Write-Host "Using icon source: $logoIco"
    $iconTargets = @(
        (Join-Path $resolvedDir "code.ico"),
        (Join-Path $resolvedDir "resources\win32\code.ico"),
        (Join-Path $resolvedDir "resources\app\resources\win32\code.ico"),
        (Join-Path $resolvedDir "resources\win32\regedit.ico"),
        (Join-Path $resolvedDir "resources\win32\shell.ico")
    )
    foreach ($target in $iconTargets) {
        if (Test-Path $target) {
            try {
                Copy-Item $logoIco $target -Force
                Write-Host "[OK] Icon replaced: $target"
            }
            catch {
                Write-Warning "[WARN] Failed to replace icon at $target : $($_.Exception.Message)"
            }
        }
        else {
            Write-Host "[INFO] Icon target not found (skipping): $target"
        }
    }
}
else {
    Write-Host "[INFO] No logo.ico found - skipping ICO replacement"
}
# ============================================================
# STEP 3 - PNG icons
# ============================================================
$logoPng = Join-Path $repoRoot "resources\icon.png"
if (Test-Path $logoPng) {
    Write-Host "Using PNG icon source: $logoPng"
    $pngTargets = @(
        (Join-Path $resolvedDir "resources\win32\code_150x150.png"),
        (Join-Path $resolvedDir "resources\win32\code_70x70.png"),
        (Join-Path $resolvedDir "resources\app\resources\win32\code_150x150.png"),
        (Join-Path $resolvedDir "resources\app\resources\win32\code_70x70.png")
    )
    foreach ($target in $pngTargets) {
        if (Test-Path $target) {
            try {
                Copy-Item $logoPng $target -Force
                Write-Host "[OK] PNG icon replaced: $target"
            }
            catch {
                Write-Warning "[WARN] Failed to replace PNG at $target : $($_.Exception.Message)"
            }
        }
        else {
            Write-Host "[INFO] PNG icon target not found (skipping): $target"
        }
    }
}
else {
    Write-Host "[INFO] resources\icon.png not found - skipping PNG replacement"
}
# ============================================================
# STEP 4 - Replace visible VSCodium text
# ============================================================
$appOutDir = Join-Path $resolvedDir "resources\app\out"
if (Test-Path $appOutDir) {
    Write-Host "[BRAND] Scanning app/out for VSCodium text..."
    $filesToScan = Get-ChildItem $appOutDir -Recurse -File |
        Where-Object {
            $_.Extension -in @(".js", ".json")
        } |
        Where-Object {
            $_.FullName -notmatch "node_modules"
        } |
        Where-Object {
            $_.Length -lt 5MB
        }
    $patchedCount = 0
    $totalFiles = @($filesToScan).Count
    Write-Host "[BRAND] Files to scan: $totalFiles"
    foreach ($file in $filesToScan) {
        try {
            $raw = [System.IO.File]::ReadAllText(
                $file.FullName,
                [System.Text.Encoding]::UTF8
            )
            if ($raw -notmatch "VSCodium") {
                continue
            }
            $patched = $raw.Replace("VSCodium", "Sudo Studio")
            if ($patched -ne $raw) {
                [System.IO.File]::WriteAllText(
                    $file.FullName,
                    $patched,
                    [System.Text.Encoding]::UTF8
                )
                $relPath = $file.FullName.Substring($resolvedDir.Length)
                Write-Host "[OK] Patched: $relPath"
                $patchedCount++
            }
        }
        catch {
            Write-Warning "[WARN] Could not patch $($file.FullName): $($_.Exception.Message)"
        }
    }
    Write-Host "[BRAND] Total files patched: $patchedCount / $totalFiles scanned"
}
else {
    Write-Host "[INFO] app\out directory not found at $appOutDir - skipping JS text patch"
}
# ============================================================
# STEP 5 - Re-confirm product.json display names
# ============================================================
$appProductJson = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $appProductJson) {
    try {
        $raw = Get-Content $appProductJson -Raw -Encoding UTF8
        $raw = $raw.Replace(
            '"nameShort": "VSCodium"',
            '"nameShort": "Sudo Studio"'
        )
        $raw = $raw.Replace(
            '"nameLong": "VSCodium"',
            '"nameLong": "Sudo Studio"'
        )
        Set-Content $appProductJson $raw -Encoding UTF8
        Write-Host "[OK] product.json display names re-confirmed"
    }
    catch {
        Write-Warning "[WARN] product.json text patch failed: $($_.Exception.Message)"
    }
}
Write-Host "=== Sudo Studio Branding Customization Complete ==="
exit 0