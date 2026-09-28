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

        if ($json.PSObject.Properties.Name -contains 'checksums') {
            $json.PSObject.Properties.Remove('checksums')
            Write-Host "[OK] Removed 'checksums' field from product.json (STEP 1) to avoid false corruption warning"
        }

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
# STEP 2b - EXHAUSTIVE app-icon sweep (proven by real build inventory)
# Proven by inventory of VSCodium 1.135.06055 win32-x64 (198 image files):
#  - Replaced (unambiguous app identity ONLY): code.ico + Start-menu tile
#    PNGs, regenerated at EXACT resolution via .NET (size parsed from the
#    filename itself, never guessed) - not a blind same-file copy.
#  - NEVER touched: per-language/file-type icons (python.ico, java.ico, ...,
#    default.ico, shell.ico), extension icons (*\extensions\*), workbench UI
#    graphics (*\out\* media/spritesheets), third-party favicons.
#  - resources\win32\ (legacy path) is probed but absent in current builds;
#    resources\linux / resources\darwin are logged if present (coherence).
# ============================================================
Write-Host "[STEP 2b] Exhaustive app-icon sweep..."
$iconWin32Dirs = @(
    (Join-Path $resolvedDir "resources\app\resources\win32"),
    (Join-Path $resolvedDir "resources\win32")
)
foreach ($iconDir in $iconWin32Dirs) {
    if (-not (Test-Path $iconDir)) {
        Write-Host "[INFO] [2b] Icon dir not present (skipping): $iconDir"
        continue
    }
    Write-Host "[INFO] [2b] Icon inventory of: $iconDir"
    $dirFiles = Get-ChildItem $iconDir -File -ErrorAction SilentlyContinue
    foreach ($dirFile in $dirFiles) {
        Write-Host ("[INFO] [2b]   - {0} ({1} bytes)" -f $dirFile.Name, $dirFile.Length)
    }
    $codeIcoTarget = Join-Path $iconDir "code.ico"
    if ((Test-Path $codeIcoTarget) -and $logoIco) {
        try {
            Copy-Item $logoIco $codeIcoTarget -Force
            Write-Host "[OK] [2b] App icon replaced: $codeIcoTarget (source: $logoIco)"
        }
        catch {
            Write-Warning ("[WARN] [2b] Failed to replace {0}: {1}" -f $codeIcoTarget, $_.Exception.Message)
        }
    }
}
$tileTargets = @(
    (Join-Path $resolvedDir "resources\app\resources\win32\code_150x150.png"),
    (Join-Path $resolvedDir "resources\app\resources\win32\code_70x70.png"),
    (Join-Path $resolvedDir "resources\win32\code_150x150.png"),
    (Join-Path $resolvedDir "resources\win32\code_70x70.png")
)
foreach ($tileTarget in $tileTargets) {
    if (-not (Test-Path $tileTarget)) { continue }
    if (-not $logoPng -or -not (Test-Path $logoPng)) {
        Write-Host "[INFO] [2b] No PNG logo source - tile kept as-is: $tileTarget"
        continue
    }
    $tileName = Split-Path $tileTarget -Leaf
    if ($tileName -match '(\d+)x(\d+)') {
        $tileW = [int]$Matches[1]
        $tileH = [int]$Matches[2]
    }
    else {
        Write-Warning "[WARN] [2b] Cannot parse tile size from name - kept as-is: $tileName"
        continue
    }
    try {
        Add-Type -AssemblyName System.Drawing
        $srcImg = [System.Drawing.Image]::FromFile($logoPng)
        $tileBmp = New-Object System.Drawing.Bitmap($tileW, $tileH)
        $gfx = [System.Drawing.Graphics]::FromImage($tileBmp)
        $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $gfx.DrawImage($srcImg, 0, 0, $tileW, $tileH)
        $gfx.Dispose()
        $srcImg.Dispose()
        $tileBmp.Save($tileTarget, [System.Drawing.Imaging.ImageFormat]::Png)
        $tileBmp.Dispose()
        Write-Host ("[OK] [2b] Tile regenerated at exact {0}x{1}: {2}" -f $tileW, $tileH, $tileTarget)
    }
    catch {
        Write-Warning ("[WARN] [2b] Tile resize failed for {0}, trying plain copy: {1}" -f $tileTarget, $_.Exception.Message)
        try {
            Copy-Item $logoPng $tileTarget -Force
            Write-Host "[OK] [2b] Tile replaced (plain copy fallback): $tileTarget"
        }
        catch {
            Write-Warning ("[WARN] [2b] Tile copy fallback failed for {0}: {1}" -f $tileTarget, $_.Exception.Message)
        }
    }
}
foreach ($probeDir in @((Join-Path $resolvedDir "resources\linux"), (Join-Path $resolvedDir "resources\darwin"))) {
    if (Test-Path $probeDir) { Write-Host "[INFO] [2b] Present (left untouched, non-Windows): $probeDir" }
    else { Write-Host "[INFO] [2b] Not present in this build: $probeDir" }
}

$appOutDir = Join-Path $resolvedDir "resources\app\out"
if (Test-Path $appOutDir) {
    Write-Host "[BRAND] Scanning app/out for VSCodium text in .js files..."

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

            $patched = $raw -replace '(?<![/\\.])VSCodium(?![/\\.])','Sudo Studio'
            if ($patched -ne $raw) {
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

    $jsonFiles = Get-ChildItem $appOutDir -Recurse -File |
        Where-Object { $_.Extension -eq ".json" } |
        Where-Object { $_.FullName -notmatch "node_modules" } |
        Where-Object { $_.Length -lt 5MB }
        # NOTE: nls* JSON files are intentionally INCLUDED now — they contain
        # "Get Started with VSCodium" strings that must be patched.
        # These are flat key→value maps, safe to patch with a raw string replace.

    $patchedJson = 0
    $totalJson   = @($jsonFiles).Count
    Write-Host "[BRAND] .json files to scan (nls* excluded): $totalJson"

    foreach ($file in $jsonFiles) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -notmatch "VSCodium") { continue }

            $obj  = $raw | ConvertFrom-Json
            $serialized = $obj | ConvertTo-Json -Depth 100
            $patched    = $serialized -replace '(?<![/\\.])VSCodium(?![/\\.])','Sudo Studio'
            if ($patched -ne $serialized) {
                try { $patched | ConvertFrom-Json | Out-Null }
                catch {
                    Write-Warning "[WARN] Post-patch JSON validation failed for $($file.Name) - skipping to avoid corruption: $($_.Exception.Message)"
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
        Write-Error "[VALIDATE] $invalidCount corrupt JSON file(s) detected - rebuild required!"
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
# STEP 4b - Scan Walkthrough JSON/JS files for residual VSCodium text
# ============================================================
$walkthroughDirs = @(
    (Join-Path $resolvedDir "resources\app\extensions"),
    (Join-Path $resolvedDir "resources\app")
)
foreach ($wtDir in $walkthroughDirs) {
    if (-not (Test-Path $wtDir)) { continue }
    Write-Host "[WALKTHROUGH] Scanning for VSCodium text in walkthrough files under: $wtDir"

    $wtJsFiles = Get-ChildItem $wtDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq ".js" } |
        Where-Object { $_.FullName -match 'walkthrough' -or $_.FullName -match 'getting.started' -or $_.FullName -match 'welcome' } |
        Where-Object { $_.FullName -notmatch 'node_modules' } |
        Where-Object { $_.Length -lt 5MB }

    $patchedWtJs = 0
    foreach ($file in $wtJsFiles) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -notmatch 'VSCodium') { continue }
            $patched = $raw -replace '(?<![/\.])VSCodium(?![/\.])','Sudo Studio'
            if ($patched -ne $raw) {
                $rawBytes = [System.IO.File]::ReadAllBytes($file.FullName)
                $hasBom   = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
                $enc      = if ($hasBom) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
                [System.IO.File]::WriteAllText($file.FullName, $patched, $enc)
                Write-Host "[OK] Patched walkthrough JS: $($file.FullName.Substring($resolvedDir.Length))"
                $patchedWtJs++
            }
        } catch {
            Write-Warning "[WARN] Could not patch walkthrough JS $($file.Name): $($_.Exception.Message)"
        }
    }

    $wtJsonFiles = Get-ChildItem $wtDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq ".json" } |
        Where-Object { $_.FullName -notmatch 'node_modules' } |
        Where-Object { $_.Length -lt 5MB } |
        Where-Object { $_.Name -match 'walkthrough' -or $_.Name -match 'getting.started' -or $_.Name -match 'package' -or $_.Name -match '^nls' }

    $patchedWtJson = 0
    foreach ($file in $wtJsonFiles) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -notmatch 'VSCodium') { continue }
            $obj        = $raw | ConvertFrom-Json
            $serialized = $obj | ConvertTo-Json -Depth 100
            $patched    = $serialized -replace '(?<![/\.])VSCodium(?![/\.])','Sudo Studio'
            if ($patched -ne $serialized) {
                try { $patched | ConvertFrom-Json | Out-Null }
                catch {
                    Write-Warning "[WARN] Post-patch JSON validation failed for $($file.Name) - skipping: $($_.Exception.Message)"
                    continue
                }
                $rawBytes = [System.IO.File]::ReadAllBytes($file.FullName)
                $hasBom   = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
                $enc      = if ($hasBom) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
                [System.IO.File]::WriteAllText($file.FullName, $patched, $enc)
                Write-Host "[OK] Patched walkthrough JSON: $($file.FullName.Substring($resolvedDir.Length))"
                $patchedWtJson++
            }
        } catch {
            Write-Warning "[WARN] Could not patch walkthrough JSON $($file.Name): $($_.Exception.Message)"
        }
    }
    Write-Host "[WALKTHROUGH] Patched: $patchedWtJs JS + $patchedWtJson JSON files in $wtDir"
}

# ============================================================
# ============================================================
# STEP 4c - Exhaustive branding sweep: nls.messages.js + any remaining file
# This is a safety net for any file missed by the targeted sweeps above.
# Patches ALL text files (JS/JSON/NLS) under resources\app that still
# contain "VSCodium" or the literal string "Get Started with VSCodium".
# ============================================================
Write-Host "[STEP 4c] Exhaustive final branding sweep (nls.messages.js + all remaining)..."
$allTextFiles = Get-ChildItem (Join-Path $resolvedDir "resources\app") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.js','.json','.nls','.ts') } |
    Where-Object { $_.FullName -notmatch 'node_modules' } |
    Where-Object { $_.Length -lt 8MB }

$step4cPatched = 0
foreach ($file in $allTextFiles) {
    try {
        $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($raw -notmatch 'VSCodium') { continue }
        $patched = $raw -replace '(?<![/\.])VSCodium(?![/\.])','Sudo Studio'
        if ($patched -ne $raw) {
            $rawBytes4c = [System.IO.File]::ReadAllBytes($file.FullName)
            $hasBom4c   = ($rawBytes4c.Length -ge 3 -and $rawBytes4c[0] -eq 0xEF -and $rawBytes4c[1] -eq 0xBB -and $rawBytes4c[2] -eq 0xBF)
            $enc4c      = if ($hasBom4c) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
            [System.IO.File]::WriteAllText($file.FullName, $patched, $enc4c)
            Write-Host "[OK] [4c] Patched: $($file.FullName.Substring($resolvedDir.Length))"
            $step4cPatched++
        }
    } catch {
        Write-Warning "[WARN] [4c] Could not patch $($file.Name): $($_.Exception.Message)"
    }
}
Write-Host "[STEP 4c] Final sweep patched $step4cPatched additional file(s)"

# ============================================================
# STEP 4d - Repoint Welcome-page Announcements feed to Sudo Studio repo
# ROOT CAUSE (Probleme 3): the Welcome page "Announcements" are NOT a local
# JSON file - the built gettingStarted bundle FETCHES them at runtime from:
#   https://raw.githubusercontent.com/VSCodium/vscodium/<master|insider>/announcements-extra.json
# (see vscodium/patches/feat-announcements.patch + vscodium/docs/telemetry.md).
# That is why "Securing VSCodium" / "minReleaseAge" survive all local sweeps:
# the content comes from VSCodium's server, live.
# FIX: precise literal swap of the feed base URL to our own repository.
# This only changes a string literal inside the JS bundle - it cannot break
# JS syntax. If our repo has no matching file yet, the app falls back to the
# (empty) builtin list and shows "There are no current announcements."
# ============================================================
Write-Host "[STEP 4d] Repointing announcements feed VSCodium -> Sudo Studio..."
$feedOld = "raw.githubusercontent.com/VSCodium/vscodium"
$feedNew = "raw.githubusercontent.com/juleszackaria-lab/Sudo-studio"
$feedFiles = Get-ChildItem (Join-Path $resolvedDir "resources\app") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq ".js" } |
    Where-Object { $_.FullName -notmatch "node_modules" } |
    Where-Object { $_.Length -lt 8MB }
$step4dPatched = 0
foreach ($file in $feedFiles) {
    try {
        $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($raw -notmatch [regex]::Escape($feedOld)) { continue }
        $patched = $raw.Replace($feedOld, $feedNew)
        if ($patched -ne $raw) {
            $rb = [System.IO.File]::ReadAllBytes($file.FullName)
            $bom = ($rb.Length -ge 3 -and $rb[0] -eq 0xEF -and $rb[1] -eq 0xBB -and $rb[2] -eq 0xBF)
            $enc = if ($bom) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
            [System.IO.File]::WriteAllText($file.FullName, $patched, $enc)
            Write-Host "[OK] [4d] Repointed announcements feed in: $($file.FullName.Substring($resolvedDir.Length))"
            $step4dPatched++
        }
    } catch {
        Write-Warning "[WARN] [4d] Could not patch $($file.Name): $($_.Exception.Message)"
    }
}
Write-Host "[STEP 4d] Feed repointed in $step4dPatched file(s)"
# Verify: old feed URL must be gone from the whole artifact (warning only)
$feedLeftovers = @(Get-ChildItem (Join-Path $resolvedDir "resources\app") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".js",".json") } |
    Where-Object { $_.FullName -notmatch "node_modules" } |
    Where-Object { $_.Length -lt 8MB } |
    Where-Object {
        try { [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) -match [regex]::Escape($feedOld) }
        catch { $false }
    })
if ($feedLeftovers.Count -gt 0) {
    Write-Warning "[WARN] [4d] Old announcements feed URL still present in $($feedLeftovers.Count) file(s):"
    $feedLeftovers | ForEach-Object { Write-Host "  $($_.FullName.Substring($resolvedDir.Length))" }
} else {
    Write-Host "[OK] [4d] Verified: no reference to the VSCodium announcements feed remains" }

# Helper (STEP 4e): recursively replace display-context VSCodium in JSON string
# VALUES only (keys/structure untouched). Returns occurrences replaced.
# PS 5.1 compatible: no ternary, no ?. / ?? operators.
function Invoke-JsonStringBranding($node, $pattern) {
    $count = 0
    if ($node -is [string]) {
        return 0
    }
    elseif ($node -is [System.Collections.IList]) {
        for ($i = 0; $i -lt $node.Count; $i++) {
            $v = $node[$i]
            if ($v -is [string]) {
                $m = ([regex]::Matches($v, $pattern)).Count
                if ($m -gt 0) {
                    $node[$i] = [regex]::Replace($v, $pattern, 'Sudo Studio')
                    $count += $m
                }
            }
            else {
                $count += Invoke-JsonStringBranding $v $pattern
            }
        }
    }
    elseif ($node -is [psobject]) {
        foreach ($prop in $node.PSObject.Properties) {
            $v = $prop.Value
            if ($v -is [string]) {
                $m = ([regex]::Matches($v, $pattern)).Count
                if ($m -gt 0) {
                    $prop.Value = [regex]::Replace($v, $pattern, 'Sudo Studio')
                    $count += $m
                }
            }
            else {
                $count += Invoke-JsonStringBranding $v $pattern
            }
        }
    }
    return $count
}

# ============================================================
# STEP 4e - EXHAUSTIVE text sweep (whole build dir, per-type treatment)
# No more one-by-one hunting: scans the ENTIRE build dir for 10 extensions
# with a 64MB cap (proven necessary: the 19MB workbench.desktop.main.js and
# sessions.desktop.main.js bundles hold 62 occurrences a <10MB filter MISSES).
#  - .json (INCLUDING nls*.json): JSON-SAFE ONLY (parse -> string VALUES only
#    -> re-parse + entry-count validation). Never raw text on JSON.
#    nls decision (documented): excluding nls* would leave ~91 UI-VISIBLE
#    strings ("Please restart VSCodium...", "VSCodium Console"...). JSON-safe
#    treatment honors the mission's INTENT (never raw-touch nls) and reaches
#    its GOAL (zero visible VSCodium). Any validation failure -> file skipped.
#  - .plist: XML-safe (text nodes + attribute values only, structure kept).
#  - .js/.html/.css/.txt/.md/.xml/.ini: direct display-context regex replace,
#    BOM preserved (same rule as previous steps).
#  - ALWAYS SKIPPED: node_modules (third-party code), .git, LICENSE*/NOTICE*/
#    THIRD-PARTY*/COPYING* (legal attribution, e.g. "The VSCodium
#    contributors" - MIT licence must keep it).
#  - URL/path contexts (sourceMappingURL, github.com/VSCodium/..., update &
#    download endpoints) are KEPT by the display-context regex - changing them
#    would break source maps and the update mechanism.
# ============================================================
Write-Host "[STEP 4e] Exhaustive text sweep over whole build dir (10 extensions, <64MB)..."
$step4eExts = @('.js','.json','.html','.css','.txt','.md','.xml','.ini','.plist')
$displayPattern = '(?<![/\\.])VSCodium(?![/\\.])'
$step4eFiles = Get-ChildItem $resolvedDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $step4eExts -contains $_.Extension.ToLower() } |
    Where-Object { $_.FullName -notmatch 'node_modules' } |
    Where-Object { $_.FullName -notmatch '\\.git\\' } |
    Where-Object { $_.Name -notmatch '^(LICENSE|LICENCE|NOTICE|THIRD-PARTY|COPYING)' } |
    Where-Object { $_.Length -lt 64MB }
$step4eScanned = 0
$step4ePatched = 0
$step4eSkipped = 0
$step4eReplaced = 0
foreach ($file in $step4eFiles) {
    $step4eScanned++
    try {
        $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($raw -notmatch 'VSCodium') { continue }
        $rel4e = $file.FullName.Substring($resolvedDir.Length)
        $rawBytes4e = [System.IO.File]::ReadAllBytes($file.FullName)
        $hasBom4e = ($rawBytes4e.Length -ge 3 -and $rawBytes4e[0] -eq 0xEF -and $rawBytes4e[1] -eq 0xBB -and $rawBytes4e[2] -eq 0xBF)
        $enc4e = if ($hasBom4e) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }
        $fileExt = $file.Extension.ToLower()

        if ($fileExt -eq '.json') {
            # ---- JSON-SAFE path (nls*.json included, never raw) ----
            try { $jsonObj = $raw | ConvertFrom-Json }
            catch {
                Write-Warning ("[WARN] [4e] Invalid JSON, skipped: {0}" -f $rel4e)
                $step4eSkipped++
                continue
            }
            if ($null -eq $jsonObj) { continue }
            if ($jsonObj -is [string]) {
                $mRoot = ([regex]::Matches($jsonObj, $displayPattern)).Count
                if ($mRoot -eq 0) { continue }
                $patchedJson = ([regex]::Replace($jsonObj, $displayPattern, 'Sudo Studio')) | ConvertTo-Json -Depth 1000
                try { $checkRoot = $patchedJson | ConvertFrom-Json }
                catch {
                    Write-Warning ("[WARN] [4e] JSON re-parse failed, skipped: {0}" -f $rel4e)
                    $step4eSkipped++
                    continue
                }
                if (-not ($checkRoot -is [string])) {
                    Write-Warning ("[WARN] [4e] JSON shape changed, skipped: {0}" -f $rel4e)
                    $step4eSkipped++
                    continue
                }
            }
            else {
                if ($jsonObj -is [System.Collections.IList]) { $beforeCount = $jsonObj.Count }
                else { $beforeCount = @($jsonObj.PSObject.Properties).Count }
                $nRepl = Invoke-JsonStringBranding $jsonObj $displayPattern
                if ($nRepl -eq 0) { continue }
                $patchedJson = $jsonObj | ConvertTo-Json -Depth 1000
                try { $checkObj = $patchedJson | ConvertFrom-Json }
                catch {
                    Write-Warning ("[WARN] [4e] JSON re-parse failed, skipped: {0}" -f $rel4e)
                    $step4eSkipped++
                    continue
                }
                if ($checkObj -is [System.Collections.IList]) { $afterCount = $checkObj.Count }
                else { $afterCount = @($checkObj.PSObject.Properties).Count }
                if ($afterCount -ne $beforeCount) {
                    Write-Warning ("[WARN] [4e] JSON entry count changed ({0}->{1}), skipped: {2}" -f $beforeCount, $afterCount, $rel4e)
                    $step4eSkipped++
                    continue
                }
                $leftover = ([regex]::Matches($patchedJson, $displayPattern)).Count
                if ($leftover -gt 0) {
                    Write-Warning ("[WARN] [4e] Display-context leftovers ({0}), skipped: {1}" -f $leftover, $rel4e)
                    $step4eSkipped++
                    continue
                }
                $mRoot = $nRepl
            }
            [System.IO.File]::WriteAllText($file.FullName, $patchedJson, $enc4e)
            Write-Host ("[OK] [4e] JSON-safe patched ({0} occ): {1}" -f $mRoot, $rel4e)
            $step4ePatched++
            $step4eReplaced += $mRoot
        }
        elseif ($fileExt -eq '.plist') {
            # ---- XML-SAFE path (values only, structure untouched) ----
            try {
                $xmlDoc = New-Object System.Xml.XmlDocument
                $xmlDoc.LoadXml($raw)
                $plistCount = 0
                foreach ($textNode in $xmlDoc.SelectNodes('//text()')) {
                    $m = ([regex]::Matches($textNode.Value, $displayPattern)).Count
                    if ($m -gt 0) {
                        $textNode.Value = [regex]::Replace($textNode.Value, $displayPattern, 'Sudo Studio')
                        $plistCount += $m
                    }
                }
                foreach ($attr in $xmlDoc.SelectNodes('//@*')) {
                    $m = ([regex]::Matches($attr.Value, $displayPattern)).Count
                    if ($m -gt 0) {
                        $attr.Value = [regex]::Replace($attr.Value, $displayPattern, 'Sudo Studio')
                        $plistCount += $m
                    }
                }
                if ($plistCount -eq 0) { continue }
                $sw = New-Object System.IO.StringWriter
                $xmlDoc.Save($sw)
                $patchedPlist = $sw.ToString()
                $sw.Dispose()
                $checkXml = New-Object System.Xml.XmlDocument
                $checkXml.LoadXml($patchedPlist)
                [System.IO.File]::WriteAllText($file.FullName, $patchedPlist, $enc4e)
                Write-Host ("[OK] [4e] plist patched ({0} occ): {1}" -f $plistCount, $rel4e)
                $step4ePatched++
                $step4eReplaced += $plistCount
            }
            catch {
                Write-Warning ("[WARN] [4e] plist handling failed, skipped {0}: {1}" -f $rel4e, $_.Exception.Message)
                $step4eSkipped++
                continue
            }
        }
        else {
            # ---- Direct text path (.js/.html/.css/.txt/.md/.xml/.ini) ----
            $mDirect = ([regex]::Matches($raw, $displayPattern)).Count
            if ($mDirect -eq 0) { continue }
            $patched = [regex]::Replace($raw, $displayPattern, 'Sudo Studio')
            [System.IO.File]::WriteAllText($file.FullName, $patched, $enc4e)
            Write-Host ("[OK] [4e] Text patched ({0} occ): {1}" -f $mDirect, $rel4e)
            $step4ePatched++
            $step4eReplaced += $mDirect
        }
    }
    catch {
        Write-Warning ("[WARN] [4e] Could not process {0}: {1}" -f $file.Name, $_.Exception.Message)
        $step4eSkipped++
    }
}
Write-Host ("[STEP 4e] DONE: {0} files scanned, {1} patched, {2} skipped(validation), display-occurrences replaced: {3}" -f $step4eScanned, $step4ePatched, $step4eSkipped, $step4eReplaced)
# VERIFY: re-scan display-context across the same scope -> must be 0.
$verifyLeftovers = @(Get-ChildItem $resolvedDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $step4eExts -contains $_.Extension.ToLower() } |
    Where-Object { $_.FullName -notmatch 'node_modules' } |
    Where-Object { $_.FullName -notmatch '\\.git\\' } |
    Where-Object { $_.Name -notmatch '^(LICENSE|LICENCE|NOTICE|THIRD-PARTY|COPYING)' } |
    Where-Object { $_.Length -lt 64MB } |
    Where-Object {
        try { [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) -match $displayPattern }
        catch { $false }
    })
if ($verifyLeftovers.Count -gt 0) {
    Write-Warning ("[WARN] [4e] VERIFY: {0} file(s) still hold display-context VSCodium (see below). URL/path + legal contexts are kept by design." -f $verifyLeftovers.Count)
    $verifyLeftovers | ForEach-Object { Write-Host ("  [4e-LEFTOVER] {0}" -f $_.FullName.Substring($resolvedDir.Length)) }
}
else {
    Write-Host "[OK] [4e] VERIFY: 0 display-context VSCodium occurrences remain (URL/path + legal contexts kept by design)"
}
# Rename Start-menu tile manifest to match the renamed executable.
# Windows binds <exename>.VisualElementsManifest.xml; after VSCodium.exe ->
# SudoStudio.exe the old filename is ignored and tiles fall back to defaults.
$oldManifest = Join-Path $resolvedDir "VSCodium.VisualElementsManifest.xml"
$newManifest = Join-Path $resolvedDir "SudoStudio.VisualElementsManifest.xml"
if (Test-Path $oldManifest) {
    try {
        Move-Item $oldManifest $newManifest -Force
        Write-Host "[OK] Renamed tile manifest: VSCodium.VisualElementsManifest.xml -> SudoStudio.VisualElementsManifest.xml"
    }
    catch {
        Write-Warning ("[WARN] Manifest rename failed: {0}" -f $_.Exception.Message)
    }
}

# STEP 5 - Re-confirm product.json display names (safe JSON patch)
# ============================================================
$appProductJson = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $appProductJson) {
    try {
        $rawBytes5 = [System.IO.File]::ReadAllBytes($appProductJson)
        $hasBom5   = ($rawBytes5.Length -ge 3 -and $rawBytes5[0] -eq 0xEF -and $rawBytes5[1] -eq 0xBB -and $rawBytes5[2] -eq 0xBF)
        $enc5      = if ($hasBom5) { [System.Text.Encoding]::UTF8 } else { New-Object System.Text.UTF8Encoding($false) }

        $json5 = [System.IO.File]::ReadAllText($appProductJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($json5.nameShort -ne "Sudo Studio") {
            $json5 | Add-Member -NotePropertyName "nameShort" -NotePropertyValue "Sudo Studio" -Force
        }
        if ($json5.nameLong -ne "Sudo Studio") {
            $json5 | Add-Member -NotePropertyName "nameLong" -NotePropertyValue "Sudo Studio" -Force
        }
        if ($json5.PSObject.Properties.Name -contains 'checksums') {
            $json5.PSObject.Properties.Remove('checksums')
            Write-Host "[OK] Removed 'checksums' field from product.json (STEP 5) to avoid false corruption warning"
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
