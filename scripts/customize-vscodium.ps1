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
} else {
    $resolvedDir = $VSCodiumDir
}

Write-Host "Resolved path: $resolvedDir"

# --- Step 1: Modify product.json ---------------------------------------
$productJsonPath = Join-Path $resolvedDir "resources\app\product.json"

if (Test-Path $productJsonPath) {
    Write-Host "Found product.json at: $productJsonPath"

    try {
        $json = Get-Content $productJsonPath -Raw | ConvertFrom-Json

        $json | Add-Member -NotePropertyName "nameShort"               -NotePropertyValue "Sudo Studio"           -Force
        $json | Add-Member -NotePropertyName "nameLong"                -NotePropertyValue "Sudo Studio"           -Force
        $json | Add-Member -NotePropertyName "applicationName"         -NotePropertyValue "sudo-studio"           -Force
        $json | Add-Member -NotePropertyName "win32DirName"            -NotePropertyValue "Sudo Studio"           -Force
        $json | Add-Member -NotePropertyName "win32NameVersion"        -NotePropertyValue "Sudo Studio"           -Force
        $json | Add-Member -NotePropertyName "win32MutexName"          -NotePropertyValue "sudostudio"            -Force
        $json | Add-Member -NotePropertyName "win32RegValueName"       -NotePropertyValue "SudoStudio"            -Force
        $json | Add-Member -NotePropertyName "darwinBundleIdentifier"  -NotePropertyValue "com.sudostudio.app"    -Force

        $json | ConvertTo-Json -Depth 10 | Set-Content $productJsonPath -Encoding UTF8
        Write-Host "[OK] product.json updated with Sudo Studio branding"
    }
    catch {
        Write-Warning "[WARN] Failed to update product.json: $_"
    }
}
else {
    Write-Warning "[WARN] product.json not found at: $productJsonPath"
}

# --- Step 2: Replace ICO icon files ------------------------------------
# Replaces all known VSCodium icon locations with our custom logo.ico.
# logo.ico must already exist in the build dir (created by ImageMagick step
# in 03-package.yml BEFORE this script runs).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir

# logo.ico is either in build dir (passed as VSCodiumDir) or resources/
$logoIco = $null
foreach ($candidate in @(
    (Join-Path $resolvedDir   "logo.ico"),
    (Join-Path $repoRoot      "resources\logo.ico"),
    (Join-Path $repoRoot      "resources\icon.ico")
)) {
    if (Test-Path $candidate) {
        $logoIco = $candidate
        break
    }
}

if ($logoIco) {
    Write-Host "Using icon source: $logoIco"

    # All known ICO locations inside a VSCodium/Electron install
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
                Write-Warning "[WARN] Failed to replace icon at $target : $_"
            }
        }
        else {
            Write-Host "[INFO] Icon target not found (skipping): $target"
        }
    }
}
else {
    Write-Host "[INFO] No logo.ico found — skipping ICO replacement"
}

# --- Step 3: Replace PNG icon files inside resources/app ---------------
# VSCodium embeds code_150x150.png and code_70x70.png for the Start Menu /
# taskbar overlays (used by Windows Shell). Replace them with our icon.png.
$logoPng = $null
foreach ($candidate in @(
    (Join-Path $repoRoot "resources\icon.png")
)) {
    if (Test-Path $candidate) {
        $logoPng = $candidate
        break
    }
}

if ($logoPng) {
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
                Write-Warning "[WARN] Failed to replace PNG at $target : $_"
            }
        }
        else {
            Write-Host "[INFO] PNG icon target not found (skipping): $target"
        }
    }
}
else {
    Write-Host "[INFO] resources\icon.png not found — skipping PNG replacement"
}

# --- Step 4: Patch all visible "VSCodium" text in JS bundles -----------
# VSCodium's compiled JS bundles (resources/app/out/*.js) contain hard-coded
# display strings like "Welcome to VSCodium", "VSCodium" in the Get Started
# page, menus, etc. We do a text replacement on all .js and .json files.
#
# SAFE replacements (display strings only):
#   "VSCodium"  → "Sudo Studio"   (displayed name)
#   "vscodium"  → "sudo-studio"   (lower-case slug — only in display contexts)
#
# SKIPPED (would break runtime):
#   - URL paths  (we preserve URLs like open-vsx.org/vscodium/...)
#   - Executable names in config/binary paths (VSCodium.exe / code.exe)
#   - Internal telemetry / update server keys
#   - node_modules (too large, not displayed to user)
#
# Strategy: replace only in known safe files, log every file touched.
$appOutDir = Join-Path $resolvedDir "resources\app\out"

if (Test-Path $appOutDir) {
    Write-Host "[BRAND] Scanning app/out for VSCodium text..."

    # Files to patch (include .js and .json display files; exclude node_modules)
    $filesToScan = Get-ChildItem $appOutDir -Recurse -Include "*.js","*.json" `
                   | Where-Object { $_.FullName -notmatch "node_modules" } `
                   | Where-Object { $_.Length -lt 5MB }   # skip huge minified bundles

    $patchedCount = 0
    $totalFiles   = ($filesToScan | Measure-Object).Count
    Write-Host "[BRAND] Files to scan: $totalFiles"

    foreach ($file in $filesToScan) {
        try {
            $raw = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)

            # Check if file contains VSCodium (case-sensitive — JS is case-sensitive)
            if ($raw -cnotmatch "VSCodium") { continue }

            # Count occurrences for logging
            $occurrences = ([regex]::Matches($raw, "VSCodium")).Count

            # Replace display-safe patterns:
            # 1. "VSCodium" (capital V, display name) → "Sudo Studio"
            #    Exclude URLs (preceded by // or .)
            $patched = $raw

            # Safe replacement: VSCodium as a word boundary (not preceded by / or .)
            # Use negative lookbehind to protect URLs
            $patched = [regex]::Replace($patched,
                '(?<![/\\.])VSCodium(?![/\\.])',
                'Sudo Studio')

            if ($patched -ne $raw) {
                [System.IO.File]::WriteAllText($file.FullName, $patched, [System.Text.Encoding]::UTF8)
                $relPath = $file.FullName.Replace($resolvedDir, "")
                Write-Host "[OK] Patched ($occurrences occurrences): $relPath"
                $patchedCount++
            }
        }
        catch {
            Write-Warning "[WARN] Could not patch $($file.FullName): $_"
        }
    }

    Write-Host "[BRAND] Total files patched: $patchedCount / $totalFiles scanned"
}
else {
    Write-Host "[INFO] app\out directory not found at $appOutDir — skipping JS text patch"
}

# Also patch resources/app/product.json's nameShort/nameLong if they got
# reverted by a partial extraction (belt-and-suspenders, already done in Step 1
# but doing it again at string level too in case JSON parsing quirks exist).
$appProductJson = Join-Path $resolvedDir "resources\app\product.json"
if (Test-Path $appProductJson) {
    try {
        $raw = Get-Content $appProductJson -Raw -Encoding UTF8
        # Only touch the display-facing name fields, not URLs/IDs
        $patched = $raw `
            -replace '"nameShort"\s*:\s*"VSCodium"',    '"nameShort": "Sudo Studio"' `
            -replace '"nameLong"\s*:\s*"VSCodium"',     '"nameLong": "Sudo Studio"' `
            -replace '"nameLong"\s*:\s*"VSCodium[^"]*"', '"nameLong": "Sudo Studio"'
        if ($patched -ne $raw) {
            Set-Content $appProductJson $patched -Encoding UTF8
            Write-Host "[OK] product.json display names re-confirmed via text patch"
        }
    }
    catch {
        Write-Warning "[WARN] product.json text patch failed: $_"
    }
}

Write-Host "=== Sudo Studio Branding Customization Complete ==="
exit 0
