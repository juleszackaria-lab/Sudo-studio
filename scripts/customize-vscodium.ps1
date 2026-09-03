<#
.SYNOPSIS
    Sudo Studio — VSCodium post-extraction branding script.
    Run AFTER VSCodium is extracted to $VSCodiumDir.

.DESCRIPTION
    1. Patches product.json with Sudo Studio identity fields.
    2. Replaces Windows icon files (.ico + taskbar PNGs) with the
       Sudo Studio logo from resources/logo.ico (or resources/icon.ico).
    3. Replaces the Linux/macOS PNG icon if present.

.PARAMETER VSCodiumDir
    Root directory of the extracted VSCodium distribution.
    Default: ".\vscodium-dist"

.PARAMETER LogoIco
    Path to the Sudo Studio multi-size ICO file.
    Default: ".\resources\icon.ico"

.PARAMETER LogoPng512
    Path to the 512×512 PNG logo (Linux / macOS).
    Default: ".\resources\icon.png"

.EXAMPLE
    # After extracting VSCodium to C:\Build\vscodium-dist:
    .\scripts\customize-vscodium.ps1 -VSCodiumDir "C:\Build\vscodium-dist"

.EXAMPLE
    # From the repo root (default paths):
    .\scripts\customize-vscodium.ps1
#>

param(
    [string]$VSCodiumDir = ".\vscodium-dist",
    [string]$LogoIco     = ".\resources\icon.ico",
    [string]$LogoPng512  = ".\resources\icon.png"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Log {
    param([string]$msg, [string]$color = "Cyan")
    Write-Host "[Sudo Studio Branding] $msg" -ForegroundColor $color
}

function Fail {
    param([string]$msg)
    Write-Host "[ERREUR] $msg" -ForegroundColor Red
    exit 1
}

function Replace-Icon {
    param([string]$src, [string]$dst)
    if (-not (Test-Path $src)) {
        Log "  ⚠  Source introuvable, passage: $src" "Yellow"
        return
    }
    $dir = Split-Path $dst -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -Path $src -Destination $dst -Force
    Log "  ✅ $dst" "Green"
}

# ─── Validate inputs ──────────────────────────────────────────────────────────

# PowerShell 5.1 compatible path resolution (no ?. null-conditional operator)
$_resolved = Resolve-Path $VSCodiumDir -ErrorAction SilentlyContinue
if ($_resolved) {
    $VSCodiumDir = $_resolved.Path
} else {
    $VSCodiumDir = $null
}
if (-not $VSCodiumDir -or -not (Test-Path $VSCodiumDir)) {
    Fail "VSCodiumDir introuvable: $VSCodiumDir`nUsage: .\scripts\customize-vscodium.ps1 -VSCodiumDir <chemin>"
}

Log "=== Personnalisation VSCodium → Sudo Studio ===" "White"
Log "  Répertoire VSCodium : $VSCodiumDir"
Log "  Logo ICO            : $LogoIco"
Log "  Logo PNG 512        : $LogoPng512"
Log ""

# ─── STEP 1 — Patch product.json ──────────────────────────────────────────────

Log "ÉTAPE 1 — Mise à jour de product.json..." "White"

# Locate product.json inside the VSCodium distribution
$productJsonCandidates = @(
    (Join-Path $VSCodiumDir "resources\app\product.json"),
    (Join-Path $VSCodiumDir "resources/app/product.json"),
    (Join-Path $VSCodiumDir "product.json")
)

$productJsonPath = $null
foreach ($c in $productJsonCandidates) {
    if (Test-Path $c) { $productJsonPath = $c; break }
}

if (-not $productJsonPath) {
    Fail "product.json introuvable dans $VSCodiumDir`nCandidats vérifiés:`n  " + ($productJsonCandidates -join "`n  ")
}

Log "  Fichier : $productJsonPath"

# Read existing JSON (handle concatenated-JSON corruption: take first object only)
$rawContent = Get-Content -Path $productJsonPath -Raw -Encoding UTF8

# Parse — if multiple JSON objects are concatenated, use only the first
try {
    $product = $rawContent | ConvertFrom-Json
} catch {
    # Try to extract just the first {...} block
    $firstBrace  = $rawContent.IndexOf('{')
    $depth = 0; $end = -1
    for ($i = $firstBrace; $i -lt $rawContent.Length; $i++) {
        if ($rawContent[$i] -eq '{') { $depth++ }
        elseif ($rawContent[$i] -eq '}') {
            $depth--
            if ($depth -eq 0) { $end = $i; break }
        }
    }
    if ($end -lt 0) { Fail "product.json est corrompu et ne peut pas être parsé." }
    $product = $rawContent.Substring($firstBrace, $end - $firstBrace + 1) | ConvertFrom-Json
    Log "  ⚠  product.json corrompu (JSON concaténé) — seul le premier objet sera utilisé." "Yellow"
}

# Apply Sudo Studio branding fields
$brandingFields = @{
    nameShort               = "Sudo Studio"
    nameLong                = "Sudo Studio"
    applicationName         = "sudo-studio"
    dataFolderName          = ".sudo-studio"
    win32MutexName          = "sudostudio"
    win32DirName            = "Sudo Studio"
    win32NameVersion        = "Sudo Studio"
    win32RegValueName       = "SudoStudio"
    win32AppId              = "{{A9B4E3C2-D5F6-4A7B-8C9D-E0F1A2B3C4D5}}"
    win32x64AppId           = "{{B8C5F4D3-E6A7-5B8C-9D0E-F1A2B3C4D5E6}}"
    darwinBundleIdentifier  = "com.sudostudio.app"
    linuxIconName           = "sudo-studio"
    urlProtocol             = "sudo-studio"
}

foreach ($key in $brandingFields.Keys) {
    # Add-Member with -Force overwrites existing, or adds if missing
    $product | Add-Member -MemberType NoteProperty -Name $key -Value $brandingFields[$key] -Force
}

# Write back as single valid JSON (depth 10 is enough for product.json)
$newJson = $product | ConvertTo-Json -Depth 10
Set-Content -Path $productJsonPath -Value $newJson -Encoding UTF8
Log "  ✅ product.json mis à jour (nameShort='Sudo Studio')" "Green"

# ─── STEP 2 — Replace Windows icon files ──────────────────────────────────────

Log ""
Log "ÉTAPE 2 — Remplacement des icônes Windows..." "White"

# Common locations for VSCodium icon files inside the distribution
$iconTargets = @(
    # Main app icon
    (Join-Path $VSCodiumDir "resources\app\resources\win32\code.ico"),
    (Join-Path $VSCodiumDir "resources\win32\code.ico"),
    # Taskbar / installer PNGs (Windows 8/10 tiles)
    (Join-Path $VSCodiumDir "resources\app\resources\win32\code_150x150.png"),
    (Join-Path $VSCodiumDir "resources\win32\code_150x150.png"),
    (Join-Path $VSCodiumDir "resources\app\resources\win32\code_70x70.png"),
    (Join-Path $VSCodiumDir "resources\win32\code_70x70.png")
)

foreach ($target in $iconTargets) {
    if (Test-Path $target) {
        # Choose ICO or PNG source based on file extension
        $ext = [System.IO.Path]::GetExtension($target).ToLower()
        if ($ext -eq ".ico") {
            Replace-Icon -src $LogoIco -dst $target
        } elseif ($ext -eq ".png") {
            # For PNGs, prefer the 512px PNG (it will be scaled down by Windows)
            Replace-Icon -src $LogoPng512 -dst $target
        }
    }
}

# ─── STEP 3 — Replace Linux/macOS icon ───────────────────────────────────────

Log ""
Log "ÉTAPE 3 — Remplacement de l'icône Linux/macOS..." "White"

$linuxTargets = @(
    (Join-Path $VSCodiumDir "resources\app\resources\linux\code.png"),
    (Join-Path $VSCodiumDir "resources\linux\code.png"),
    (Join-Path $VSCodiumDir "resources\app\resources\darwin\code.icns")
)

foreach ($target in $linuxTargets) {
    if (Test-Path $target) {
        $ext = [System.IO.Path]::GetExtension($target).ToLower()
        if ($ext -in @(".png", ".icns")) {
            Replace-Icon -src $LogoPng512 -dst $target
        }
    }
}

# ─── STEP 4 — Verify ──────────────────────────────────────────────────────────

Log ""
Log "ÉTAPE 4 — Vérification..." "White"

$verifyJson = Get-Content -Path $productJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ok = $true

foreach ($key in @("nameShort", "nameLong", "applicationName")) {
    $val = $verifyJson.$key
    if ($val -notlike "*Sudo*" -and $val -notlike "*sudo*") {
        Log "  ❌ Champ $key n'est pas rebrandé: $val" "Red"
        $ok = $false
    } else {
        Log "  ✅ $key = $val" "Green"
    }
}

Log ""
if ($ok) {
    Log "🎉 Personnalisation Sudo Studio terminée avec succès !" "Green"
    Log "   Titre fenêtre affiché : Sudo Studio" "Green"
    Log "   Icônes : logo Sudo Studio" "Green"
} else {
    Log "⚠  Personnalisation partielle — vérifiez les erreurs ci-dessus." "Yellow"
    exit 1
}
