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
# STEP 1 - product.json (safe JSON load/modify/save)
# ============================================================
$productJsonPath = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $productJsonPath) {
    Write-Host "Found product.json at: $productJsonPath"
    try {
        # Detect BOM so we preserve it on write
        $rawBytes = [System.IO.File]::ReadAllBytes($productJsonPath)
        $hasBom = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
        $enc = if ($hasBom) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }

        $raw  = [System.IO.File]::ReadAllText($productJsonPath, [System.Text.Encoding]::UTF8)
        $json = $raw | ConvertFrom-Json

        $json | Add-Member -NotePropertyName "nameShort"            -NotePropertyValue "Sudo Studio"       -Force
        $json | Add-Member -NotePropertyName "nameLong"             -NotePropertyValue "Sudo Studio"       -Force
        $json | Add-Member -NotePropertyName "applicationName"      -NotePropertyValue "sudo-studio"       -Force
        $json | Add-Member -NotePropertyName "win32DirName"         -NotePropertyValue "Sudo Studio"       -Force
        $json | Add-Member -NotePropertyName "win32NameVersion"     -NotePropertyValue "Sudo Studio"       -Force
        $json | Add-Member -NotePropertyName "win32MutexName"       -NotePropertyValue "sudostudio"        -Force
        $json | Add-Member -NotePropertyName "win32RegValueName"    -NotePropertyValue "SudoStudio"        -Force
        $json | Add-Member -NotePropertyName "darwinBundleIdentifier" -NotePropertyValue "com.sudostudio.app" -Force

        $patched = $json | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($productJsonPath, $patched, $enc)
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
# STEP 4 - Replace visible VSCodium text in .js bundles ONLY
#
# CRITICAL RULES:
#  1. NEVER patch any file whose name starts with "nls" (nls.messages.json,
#     nls.metadata.json, etc.) — these are Electron/Chromium i18n resources;
#     a text-replacement will corrupt them and prevent the window from opening.
#  2. NEVER patch .json files with raw string replacement — always use
#     ConvertFrom-Json / ConvertTo-Json to preserve valid JSON structure.
#  3. Only .js files are patched with raw string replacement.
#  4. After patching, validate every .json in app/out is still valid JSON.
# ============================================================
$appOutDir = Join-Path $resolvedDir "resources\app\out"
if (Test-Path $appOutDir) {
    Write-Host "[BRAND] Scanning app/out for VSCodium text in .js files..."

    # ── JS files only (never JSON) ──────────────────────────────────────────
    $jsFiles = Get-ChildItem $appOutDir -Recurse -File |
        Where-Object { $_.Extension -eq ".js" } |
        Where-Object { $_.FullName -notmatch "node_modules" } |
        Where-Object { $_.Length -lt 5MB }

    $patchedJs = 0
    $totalJs   = @($jsFiles).Count
    Write-Host "[BRAND] .js files to scan: $totalJs"

    foreach ($file in $jsFiles) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -notmatch "VSCodium") { continue }

            # URL-safe replace: skip occurrences inside URL paths or file extensions
            $patched = $raw -replace '(?<![/\\.])VSCodium(?![/\\.])','Sudo Studio'
            if ($patched -ne $raw) {
                # Preserve original encoding (BOM or not)
                $rawBytes2 = [System.IO.File]::ReadAllBytes($file.FullName)
                $hasBom2   = ($rawBytes2.Length -ge 3 -and $rawBytes2[0] -eq 0xEF -and $rawBytes2[1] -eq 0xBB -and $rawBytes2[2] -eq 0xBF)
                $enc2      = if ($hasBom2) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
                [System.IO.File]::WriteAllText($file.FullName, $patched, $enc2)
                $relPath = $file.FullName.Substring($resolvedDir.Length)
                Write-Host "[OK] Patched JS: $relPath"
                $patchedJs++
            }
        }
        catch {
            Write-Warning "[WARN] Could not patch $($file.FullName): $($_.Exception.Message)"
        }
    }
    Write-Host "[BRAND] JS files patched: $patchedJs / $totalJs scanned"

    # ── JSON files: safe ConvertFrom-Json approach, SKIP nls*.json ──────────
    $jsonFiles = Get-ChildItem $appOutDir -Recurse -File |
        Where-Object { $_.Extension -eq ".json" } |
        Where-Object { $_.FullName -notmatch "node_modules" } |
        Where-Object { $_.Length -lt 5MB } |
        Where-Object { $_.Name -notmatch "^nls" }   # <-- CRITICAL: skip nls.messages.json, nls.metadata.json, etc.

    $patchedJson = 0
    $totalJson   = @($jsonFiles).Count
    Write-Host "[BRAND] .json files to scan (nls* excluded): $totalJson"

    foreach ($file in $jsonFiles) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -notmatch "VSCodium") { continue }

            # Safe JSON round-trip: parse, modify string values, re-serialize
            $obj  = $raw | ConvertFrom-Json
            # Convert to JSON string, do the replacement only on string values by
            # working through the serialized form — but use ConvertTo-Json depth 100
            # so nested objects survive intact, then do targeted string replacement
            # on the re-serialized output (the only VSCodium refs in JSON values will
            # be quoted strings, not keys or URLs).
            $serialized = $obj | ConvertTo-Json -Depth 100
            $patched    = $serialized -replace '(?<![/\\.])VSCodium(?![/\\.])','Sudo Studio'
            if ($patched -ne $serialized) {
                # Validate the patched result is still valid JSON before writing
                try { $patched | ConvertFrom-Json | Out-Null }
                catch {
                    Write-Warning "[WARN] Post-patch JSON validation failed for $($file.Name) — skipping to avoid corruption: $($_.Exception.Message)"
                    continue
                }
                $rawBytes3 = [System.IO.File]::ReadAllBytes($file.FullName)
                $hasBom3   = ($rawBytes3.Length -ge 3 -and $rawBytes3[0] -eq 0xEF -and $rawBytes3[1] -eq 0xBB -and $rawBytes3[2] -eq 0xBF)
                $enc3      = if ($hasBom3) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
                [System.IO.File]::WriteAllText($file.FullName, $patched, $enc3)
                $relPath = $file.FullName.Substring($resolvedDir.Length)
                Write-Host "[OK] Patched JSON: $relPath"
                $patchedJson++
            }
        }
        catch {
            Write-Warning "[WARN] Could not patch JSON $($file.FullName): $($_.Exception.Message)"
        }
    }
    Write-Host "[BRAND] JSON files patched: $patchedJson / $totalJson scanned"

    # ── POST-PATCH VALIDATION: verify ALL .json files in app/out are valid ──
    Write-Host "[VALIDATE] Validating all .json files in app/out..."
    $validCount   = 0
    $invalidCount = 0
    Get-ChildItem $appOutDir -Recurse -Include "*.json" | ForEach-Object {
        try {
            Get-Content $_.FullName -Raw | ConvertFrom-Json | Out-Null
            Write-Host "[VALID] $($_.Name)"
            $validCount++
        }
        catch {
            Write-Host "[CORRUPT] $($_.Name): $($_.Exception.Message)"
            $invalidCount++
        }
    }
    Write-Host "[VALIDATE] Results: $validCount valid, $invalidCount corrupt"
    if ($invalidCount -gt 0) {
        Write-Error "[VALIDATE] $invalidCount corrupt JSON file(s) detected — rebuild required!"
        exit 2
    }
    else {
        Write-Host "[VALIDATE] All JSON files valid."
    }
}
else {
    Write-Host "[INFO] app\out directory not found at $appOutDir - skipping JS text patch"
}

# ============================================================
# STEP 5 - Re-confirm product.json display names (safe JSON patch)
# ============================================================
$appProductJson = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $appProductJson) {
    try {
        $rawBytes5 = [System.IO.File]::ReadAllBytes($appProductJson)
        $hasBom5   = ($rawBytes5.Length -ge 3 -and $rawBytes5[0] -eq 0xEF -and $rawBytes5[1] -eq 0xBB -and $rawBytes5[2] -eq 0xBF)
        $enc5      = if ($hasBom5) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }

        $json5 = [System.IO.File]::ReadAllText($appProductJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        # Ensure nameShort/nameLong are correct (idempotent)
        if ($json5.nameShort -ne "Sudo Studio") {
            $json5 | Add-Member -NotePropertyName "nameShort" -NotePropertyValue "Sudo Studio" -Force
        }
        if ($json5.nameLong -ne "Sudo Studio") {
            $json5 | Add-Member -NotePropertyName "nameLong" -NotePropertyValue "Sudo Studio" -Force
        }
        $patched5 = $json5 | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($appProductJson, $patched5, $enc5)
        Write-Host "[OK] product.json display names re-confirmed"
    }
    catch {
        Write-Warning "[WARN] product.json re-confirm failed: $($_.Exception.Message)"
    }
}
Write-Host "=== Sudo Studio Branding Customization Complete ==="
exit 0
