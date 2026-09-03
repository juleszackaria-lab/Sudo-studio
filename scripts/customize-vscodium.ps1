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
        
        $json | Add-Member -NotePropertyName "nameShort" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "nameLong" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "applicationName" -NotePropertyValue "sudo-studio" -Force
        $json | Add-Member -NotePropertyName "win32DirName" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "win32NameVersion" -NotePropertyValue "Sudo Studio" -Force
        $json | Add-Member -NotePropertyName "win32MutexName" -NotePropertyValue "sudostudio" -Force
        $json | Add-Member -NotePropertyName "win32RegValueName" -NotePropertyValue "SudoStudio" -Force
        $json | Add-Member -NotePropertyName "darwinBundleIdentifier" -NotePropertyValue "com.sudostudio.app" -Force
        
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

# --- Step 2: Replace icons if a custom logo exists ----------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$logoPath = Join-Path $repoRoot "resources\logo.ico"

if (Test-Path $logoPath) {
    Write-Host "Found custom logo at: $logoPath"
    
    $iconTargets = @(
        (Join-Path $resolvedDir "code.ico"),
        (Join-Path $resolvedDir "resources\win32\code.ico")
    )
    
    foreach ($target in $iconTargets) {
        if (Test-Path $target) {
            try {
                Copy-Item $logoPath $target -Force
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
    Write-Host "[INFO] No custom logo.ico found at $logoPath - skipping icon replacement"
}

Write-Host "=== Sudo Studio Branding Customization Complete ==="
exit 0
