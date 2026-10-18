# P32(a): byte-exact exe icon check (old VSCodium icon gone, new Sudo icon in).
# Scans the exe for embedded PNG blobs (Vista+ icons are stored as PNG) and
# compares their SHA-256 against the known fingerprints:
#   OldPngSha256 = 256x256 icon PNG of the VSCodium base exe (MUST be absent)
#   NewPngSha256 = 256x256 icon PNG from resources\icon.ico (MUST be present)
# Defaults match VSCodium 1.97.2 + the current icon.ico; refresh both when the
# base version or the brand icon changes (see docs/p32-packager-patch.md P5).
# Exit 0 = PASS (printed line); exit 1 = FAIL or inconclusive.
# PowerShell 5.1 compatible. ASCII only.
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$OldPngSha256 = 'b9971d910cb2502df37d7c65b2e36c9061d030fd41699bf9dafee46551c5505c',
    [string]$NewPngSha256 = 'f9a9ccc40f3a630132f9485084e33a0504493b3d7adda663950e50600b219d42'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $ExePath)) {
    Write-Error ("[EXE-ICON] FAIL: exe not found: {0}" -f $ExePath)
    exit 1
}
# Compiled blob scanner (a per-byte PowerShell loop over ~190 MB would take
# far too long; C# does it in about a second). Loaded once per session.
if (-not ([System.Management.Automation.PSTypeName]'P32PngBlobs').Type) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
public static class P32PngBlobs {
    public static string[] Scan(string path) {
        byte[] b = File.ReadAllBytes(path);
        var found = new List<string>();
        using (SHA256 sha = SHA256.Create()) {
            for (int i = 0; i + 24 < b.Length; i++) {
                if (b[i] != 0x89 || b[i+1] != 0x50 || b[i+2] != 0x4E || b[i+3] != 0x47
                    || b[i+4] != 0x0D || b[i+5] != 0x0A || b[i+6] != 0x1A || b[i+7] != 0x0A) continue;
                if (b[i+12] != (byte)'I' || b[i+13] != (byte)'H' || b[i+14] != (byte)'D' || b[i+15] != (byte)'R') continue;
                int w = (b[i+16] << 24) | (b[i+17] << 16) | (b[i+18] << 8) | b[i+19];
                int h = (b[i+20] << 24) | (b[i+21] << 16) | (b[i+22] << 8) | b[i+23];
                int end = -1;
                for (int j = i + 8; j + 8 < b.Length; j++) {
                    if (b[j] == (byte)'I' && b[j+1] == (byte)'E' && b[j+2] == (byte)'N' && b[j+3] == (byte)'D') { end = j + 8; break; }
                }
                if (end < 0) continue;
                int len = end - i;
                byte[] blob = new byte[len];
                Buffer.BlockCopy(b, i, blob, 0, len);
                string hex = BitConverter.ToString(sha.ComputeHash(blob)).Replace("-", "").ToLowerInvariant();
                found.Add(w + "x" + h + " len=" + len + " sha256=" + hex);
                i = end - 1;
            }
        }
        return found.ToArray();
    }
}
'@
    } catch {
        Write-Error ("[EXE-ICON] FAIL: blob scanner compile failed: {0}" -f $_.Exception.Message)
        exit 1
    }
}
$blobs = [P32PngBlobs]::Scan($ExePath)
Write-Host ("[EXE-ICON] {0}: {1} embedded PNG blob(s)" -f (Split-Path $ExePath -Leaf), $blobs.Count)
foreach ($line in $blobs) { Write-Host ("[EXE-ICON]   png {0}" -f $line) }
$old = @($blobs | Where-Object { $_ -like ('*sha256=' + $OldPngSha256.ToLower() + '*') })
$new = @($blobs | Where-Object { $_ -like ('*sha256=' + $NewPngSha256.ToLower() + '*') })
if ($old.Count -gt 0) {
    Write-Error ("[EXE-ICON] FAIL: old base-exe icon PNG still embedded in {0} (rcedit step missed?)" -f $ExePath)
    exit 1
}
if ($new.Count -eq 0) {
    Write-Error ("[EXE-ICON] FAIL: new brand icon PNG (256x256 from icon.ico) not found in {0}" -f $ExePath)
    exit 1
}
Write-Host "[EXE-ICON] PASS: old icon gone, new icon present"
exit 0
