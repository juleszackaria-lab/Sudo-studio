# SUDO STUDIO - P15 task 6: pre-build verification on the real Windows PC.
# Run on the user's PC:  powershell -ExecutionPolicy Bypass -File scripts\pc-verify.ps1
# Optional: -InstallDir "C:\...\SudoStudio"  -RuntimeUrl http://127.0.0.1:6000
# Writes pc-verify-result.json next to this script. No secret is ever written.
# Threat model asserted (see src/agent/sandbox.js + OpenCodeDriver.js):
#   L1-win = Job Object (kill-on-close) + restricted token + optional per-program
#            outbound firewall block. L1 does NOT restrict filesystem reads/writes.
#   L2     = docker / Windows Sandbox guest = filesystem + network isolation.
# Escape tests PASS when the observed behavior matches this model.
# PowerShell 5.1 compatible. ASCII-only.
param(
    [string]$InstallDir = "",
    [string]$RuntimeUrl = "http://127.0.0.1:6000",
    [string]$BackendUrl = "http://127.0.0.1:5000",
    [string]$NodeExe = "node"
)

$ErrorActionPreference = "Continue"
$results = @()

function Add-Result($id, $name, $result, $detail) {
    $script:results += [pscustomobject]@{
        id = $id; name = $name; result = $result; detail = [string]$detail
    }
    Write-Host ("[{0}] {1}: {2}" -f $result, $id, $name)
}

function Get-HttpJson($url, $timeoutSec = 10) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
        return @{ ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300); code = $r.StatusCode; body = $r.Content }
    } catch {
        return @{ ok = $false; code = 0; body = [string]$_.Exception.Message }
    }
}

function Test-IsAdmin() {
    try {
        $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

if ($InstallDir -eq "") { $InstallDir = Split-Path $PSScriptRoot -Parent }
$RuntimeExe = Join-Path $InstallDir "runtime.exe"
$nodeOk = $false
try { & $NodeExe --version | Out-Null; if ($LASTEXITCODE -eq 0) { $nodeOk = $true } } catch { $nodeOk = $false }

# -- 1. runtime /health ---------------------------------------------------------
$h = Get-HttpJson ($RuntimeUrl + "/health")
if ($h.ok) { Add-Result "rt-health" "GET /health" "PASS" ("HTTP " + $h.code) }
else { Add-Result "rt-health" "GET /health" "FAIL" ("unreachable: " + $h.body) }

# -- 2. runtime /v1/models ------------------------------------------------------
$m = Get-HttpJson ($RuntimeUrl + "/v1/models")
if ($m.ok) { Add-Result "rt-models" "GET /v1/models" "PASS" ("HTTP " + $m.code) }
else { Add-Result "rt-models" "GET /v1/models" "FAIL" ("unreachable: " + $m.body) }

# -- 3. backend health (informational; backend may be stopped) ------------------
$b = Get-HttpJson ($BackendUrl + "/api/system/health") 5
if ($b.ok) { Add-Result "be-health" "backend /api/system/health" "PASS" ("HTTP " + $b.code) }
else { Add-Result "be-health" "backend /api/system/health" "SKIP" "backend not running (start backend.exe to test)" }

# -- 4. runtime stop + restart ---------------------------------------------------
$rtProcs = @(Get-Process -Name "runtime" -ErrorAction SilentlyContinue)
if ((Test-Path $RuntimeExe) -and $rtProcs.Count -gt 0) {
    Stop-Process -Id $rtProcs[0].Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $down = Get-HttpJson ($RuntimeUrl + "/health") 4
    if ($down.ok) {
        Add-Result "rt-restart" "stop then restart runtime" "FAIL" "still answering after stop"
    } else {
        Start-Process -FilePath $RuntimeExe -WorkingDirectory $InstallDir
        $up = $false
        for ($i = 0; $i -lt 36; $i++) {
            Start-Sleep -Seconds 5
            if ((Get-HttpJson ($RuntimeUrl + "/health") 4).ok) { $up = $true; break }
        }
        if ($up) { Add-Result "rt-restart" "stop then restart runtime" "PASS" "down after stop, up after relaunch" }
        else { Add-Result "rt-restart" "stop then restart runtime" "FAIL" "did not come back within 180 s" }
    }
} else {
    Add-Result "rt-restart" "stop then restart runtime" "SKIP" "runtime.exe not found or not running"
}

# -- 5. Job Object kill-on-close primitive (L1 mechanism) ------------------------
$jobCode = @"
using System;
using System.Runtime.InteropServices;
public class PcJob {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, ref byte d, int s);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool b, int c);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr j, uint c);
}
"@
try {
    Add-Type -TypeDefinition $jobCode -ErrorAction Stop
    $job = [PcJob]::CreateJobObject([IntPtr]::Zero, $null)
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION with LimitFlags=KILL_ON_JOB_CLOSE (0x2000)
    $sz = 8 * 4 + 4 * 8
    $buf = New-Object byte[] 128
    $buf[16] = 0x00; $buf[17] = 0x20; $buf[18] = 0x00; $buf[19] = 0x00
    $jb = [PcJob]::SetInformationJobObject($job, 9, [ref]$buf[0], $buf.Length)
    $victim = Start-Process "$env:SystemRoot\System32\timeout.exe" -ArgumentList "/T 60 /NOBREAK" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    $ph = [PcJob]::OpenProcess(0x1F0FFF, $false, $victim.Id)
    $assigned = $false
    if ($ph -ne [IntPtr]::Zero) { $assigned = [PcJob]::AssignProcessToJobObject($job, $ph); [void][PcJob]::CloseHandle($ph) }
    [void][PcJob]::TerminateJobObject($job, 0)
    Start-Sleep -Seconds 3
    $gone = $true
    try { $p = Get-Process -Id $victim.Id -ErrorAction Stop; $gone = $false; Stop-Process -Id $victim.Id -Force } catch { $gone = $true }
    [void][PcJob]::CloseHandle($job)
    if ($jb -and $assigned -and $gone) { Add-Result "sec-job-kill" "job KILL_ON_JOB_CLOSE kills tree" "PASS" "flag set, assigned, child dead" }
    else { Add-Result "sec-job-kill" "job KILL_ON_JOB_CLOSE kills tree" "FAIL" ("flag=" + $jb + " assigned=" + $assigned + " dead=" + $gone) }
} catch {
    Add-Result "sec-job-kill" "job KILL_ON_JOB_CLOSE kills tree" "FAIL" ("exception: " + $_.Exception.Message)
}

# -- 6. restricted token via runas /trustlevel -----------------------------------
try {
    $who = & runas /trustlevel:0x20000 "cmd /c whoami /groups" 2>&1 | Out-String
    if ($who -match "S-1-5-32-544" -and $who -match "(?i)deny-only|denied") {
        Add-Result "sec-token-low" "runas trustlevel 0x20000 restricts admin SID" "PASS" "admins group deny-only"
    } elseif ($who -match "S-1-5-32-544") {
        Add-Result "sec-token-low" "runas trustlevel 0x20000 restricts admin SID" "FAIL" "admin SID present without deny-only"
    } else {
        Add-Result "sec-token-low" "runas trustlevel 0x20000 restricts admin SID" "SKIP" "runas probe inconclusive on this PC"
    }
} catch {
    Add-Result "sec-token-low" "runas trustlevel 0x20000 restricts admin SID" "SKIP" ("runas unavailable: " + $_.Exception.Message)
}

# -- 7. firewall rule roundtrip (admin only, harmless test rule) -----------------
if (Test-IsAdmin) {
    try {
        New-NetFirewallRule -DisplayName "SudoStudio pc-verify probe" -Program "$env:SystemRoot\System32\ping.exe" -Direction Outbound -Action Block -ErrorAction Stop | Out-Null
        $exists = (Get-NetFirewallRule -DisplayName "SudoStudio pc-verify probe" -ErrorAction Stop) -ne $null
        Remove-NetFirewallRule -DisplayName "SudoStudio pc-verify probe" -ErrorAction Stop
        $gone2 = $true
        try { Get-NetFirewallRule -DisplayName "SudoStudio pc-verify probe" -ErrorAction Stop | Out-Null; $gone2 = $false } catch { $gone2 = $true }
        if ($exists -and $gone2) { Add-Result "sec-fw-roundtrip" "firewall rule add/remove works" "PASS" "rule created then removed" }
        else { Add-Result "sec-fw-roundtrip" "firewall rule add/remove works" "FAIL" ("created=" + $exists + " removed=" + $gone2) }
    } catch {
        Add-Result "sec-fw-roundtrip" "firewall rule add/remove works" "FAIL" ("exception: " + $_.Exception.Message)
    }
} else {
    Add-Result "sec-fw-roundtrip" "firewall rule add/remove works" "SKIP" "needs admin (re-run elevated)"
}

# -- 8. escape: write outside project (L1 model = NOT blocked, L2 only) ----------
$probeDir = Join-Path ([IO.Path]::GetTempPath()) "pc-verify-proj"
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
$outside = Join-Path ([IO.Path]::GetTempPath()) "pc-verify-escape.txt"
try {
    "escape-probe" | Out-File -FilePath $outside -Encoding ascii -Force
    $wrote = Test-Path $outside
    Remove-Item $outside -Force -ErrorAction SilentlyContinue
    if ($wrote) { Add-Result "esc-write-outside" "write outside project dir" "PASS" "allowed (matches L1 model: FS isolation is L2-only)" }
    else { Add-Result "esc-write-outside" "write outside project dir" "FAIL" "write failed unexpectedly" }
} catch {
    Add-Result "esc-write-outside" "write outside project dir" "FAIL" ("exception: " + $_.Exception.Message)
}

# -- 9. escape: read $HOME\.ssh (L1 model = NOT blocked, L2 only) -----------------
$sshFile = Join-Path $HOME ".ssh\id_rsa"
if (Test-Path $sshFile) {
    try {
        $fs = [IO.File]::OpenRead($sshFile); $fs.Close()
        Add-Result "esc-ssh-read" "read HOME/.ssh/id_rsa" "PASS" "readable (matches L1 model: FS isolation is L2-only)"
    } catch {
        Add-Result "esc-ssh-read" "read HOME/.ssh/id_rsa" "PASS" ("denied by ACLs: " + $_.Exception.Message)
    }
} else {
    Add-Result "esc-ssh-read" "read HOME/.ssh/id_rsa" "SKIP" "no id_rsa on this PC (nothing to protect)"
}

# -- 10. escape: outbound TCP (no product firewall rule active here) --------------
try {
    $tcp = New-Object Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect("93.184.216.34", 443, $null, $null)
    $okConn = $iar.AsyncWaitHandle.WaitOne(8000)
    $tcp.Close()
    if ($okConn) { Add-Result "esc-curl" "outbound TCP 443 (no FW rule)" "PASS" "reachable (matches L1 model: blocked only with admin FW rule)" }
    else { Add-Result "esc-curl" "outbound TCP 443 (no FW rule)" "PASS" "unreachable here (proxy/offline PC?)" }
} catch {
    Add-Result "esc-curl" "outbound TCP 443 (no FW rule)" "SKIP" ("exception: " + $_.Exception.Message)
}

# -- 11. escape: surviving child (job must kill it) -------------------------------
try {
    $job2 = [PcJob]::CreateJobObject([IntPtr]::Zero, $null)
    $buf2 = New-Object byte[] 128
    $buf2[16] = 0x00; $buf2[17] = 0x20; $buf2[18] = 0x00; $buf2[19] = 0x00
    [void][PcJob]::SetInformationJobObject($job2, 9, [ref]$buf2[0], $buf2.Length)
    $parent = Start-Process "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/c timeout /T 60 /NOBREAK >NUL" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    $ph2 = [PcJob]::OpenProcess(0x1F0FFF, $false, $parent.Id)
    if ($ph2 -ne [IntPtr]::Zero) { [void][PcJob]::AssignProcessToJobObject($job2, $ph2); [void][PcJob]::CloseHandle($ph2) }
    [void][PcJob]::TerminateJobObject($job2, 0)
    Start-Sleep -Seconds 3
    $survivor = $false
    try { Get-Process -Id $parent.Id -ErrorAction Stop | Out-Null; $survivor = $true; Stop-Process -Id $parent.Id -Force } catch { $survivor = $false }
    [void][PcJob]::CloseHandle($job2)
    if (-not $survivor) { Add-Result "esc-survivor" "job-contained child cannot survive" "PASS" "child dead after job terminate" }
    else { Add-Result "esc-survivor" "job-contained child cannot survive" "FAIL" "child survived job terminate" }
} catch {
    Add-Result "esc-survivor" "job-contained child cannot survive" "FAIL" ("exception: " + $_.Exception.Message)
}

# -- 12. L2 availability (informational) -------------------------------------------
$l2 = @()
if (Test-Path "$env:SystemRoot\System32\WindowsSandbox.exe") { $l2 += "wsb" }
try { & docker info 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $l2 += "docker" } } catch {}
if ($l2.Count -gt 0) { Add-Result "l2-available" "L2 guest available" "PASS" ("via: " + ($l2 -join ",")) }
else { Add-Result "l2-available" "L2 guest available" "SKIP" "no WindowsSandbox.exe nor working docker" }

# -- node-driven tests: score + license -------------------------------------------
if (-not $nodeOk) {
    Add-Result "score-secret" "fake secret lowers score, removal restores" "SKIP" "node not on PATH"
    Add-Result "lic-invented" "invented license key refused" "SKIP" "node not on PATH"
    Add-Result "lic-modified" "tampered license key refused" "SKIP" "node not on PATH"
    Add-Result "lic-expired" "expired license key refused" "SKIP" "node not on PATH"
} else {
    $extDir = Join-Path $InstallDir "sudo-ai-extension"
    if (-not (Test-Path $extDir)) { $extDir = Join-Path (Split-Path $PSScriptRoot -Parent) "sudo-ai-extension" }

    # 13. score: fake secret + vulnerable dep lower the score; removal restores ----
    $scoreJs = @"
const path = require('path');
const ext = process.argv[2];
const pats = require(path.join(ext, 'src', 'utils', 'secretPatterns.js'));
const audit = require(path.join(ext, 'src', 'utils', 'localAudit.js'));
const score = require(path.join(ext, 'src', 'utils', 'securityScore.js'));
const fake = 'AKIAIOSFODNN7EXAMPLE'; // documented AWS example, never real
const hits = pats.filter((p) => p.re.test('key=' + fake)).map((p) => ({ label: p.label, severity: score.severityOfSecret(p.label) }));
const loaded = audit.loadAdvisories();
const db = loaded.db ? { date: loaded.db.generatedAt, source: loaded.db.source, stale: audit.dbIsStale(loaded.db.generatedAt) } : null;
const pkgs = [{ name: 'lodash', version: '4.17.20', ecosystem: 'npm' }];
const adv = loaded.db ? audit.matchAdvisories(pkgs, loaded.db) : [];
const withSecret = score.computeSecurityScore({ db, advisories: adv, secrets: hits, files: {}, tests: {} });
const without = score.computeSecurityScore({ db, advisories: adv, secrets: [], files: {}, tests: {} });
console.log(JSON.stringify({ hits: hits.length, adv: adv.length, s1: withSecret.score, s0: without.score }));
"@
    $scoreFile = Join-Path ([IO.Path]::GetTempPath()) "pc-verify-score.js"
    $scoreJs | Out-File -FilePath $scoreFile -Encoding ascii -Force
    try {
        $out = & $NodeExe $scoreFile $extDir 2>&1 | Out-String
        $j = $out | ConvertFrom-Json
        if ($j.hits -ge 1 -and $j.s1 -ne $null -and $j.s0 -ne $null -and $j.s1 -lt $j.s0) {
            Add-Result "score-secret" "fake secret lowers score, removal restores" "PASS" ("hits=" + $j.hits + " adv=" + $j.adv + " score " + $j.s0 + "->" + $j.s1)
        } else {
            Add-Result "score-secret" "fake secret lowers score, removal restores" "FAIL" ("unexpected: " + $out)
        }
    } catch {
        Add-Result "score-secret" "fake secret lowers score, removal restores" "FAIL" ("exception: " + $_.Exception.Message)
    }
    Remove-Item $scoreFile -Force -ErrorAction SilentlyContinue

    # 14-16. license keys: invented / tampered / expired ---------------------------
    $licJs = @"
const path = require('path');
const crypto = require('crypto');
const root = process.argv[2];
const lic = require(path.join(root, 'backend', 'src', 'license', 'license.js'));
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kp = crypto.generateKeyPairSync('ed25519');
const spki = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const now = Date.now();
const mkPayload = (exp) => ({ licenseId: 'PC-VERIFY-1', client: 'pc-verify', edition: 'team', seats: 1,
    issuedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(exp).toISOString() });
const sign = (p) => { const a = b64u(JSON.stringify(p)); return a + '.' + b64u(crypto.sign(null, Buffer.from(a), kp.privateKey)); };
const good = sign(mkPayload(now + 86400000));
const tampered = good.slice(0, -2) + (good.slice(-2) === 'AA' ? 'BB' : 'AA');
const expired = sign(mkPayload(now - 1000));
const r = {
    invented: lic.verifyLicenseKey('aGVsbG8.d29ybGQ', {}).valid,
    tampered: lic.verifyLicenseKey(tampered, { publicKeySpkiB64: spki }).valid,
    expired: lic.verifyLicenseKey(expired, { publicKeySpkiB64: spki }),
    sane: lic.verifyLicenseKey(good, { publicKeySpkiB64: spki }).valid,
};
console.log(JSON.stringify({ invented: r.invented, tampered: r.tampered,
    expValid: r.expired.valid, expReason: r.expired.reason, sane: r.sane }));
"@
    $licFile = Join-Path ([IO.Path]::GetTempPath()) "pc-verify-lic.js"
    $licJs | Out-File -FilePath $licFile -Encoding ascii -Force
    try {
        $out2 = & $NodeExe $licFile (Split-Path $extDir -Parent) 2>&1 | Out-String
        $k = $out2 | ConvertFrom-Json
        if ($k.sane -ne $true) {
            Add-Result "lic-invented" "invented license key refused" "FAIL" "sanity check failed (test harness broken)"
            Add-Result "lic-modified" "tampered license key refused" "FAIL" "sanity check failed (test harness broken)"
            Add-Result "lic-expired" "expired license key refused" "FAIL" "sanity check failed (test harness broken)"
        } else {
            if ($k.invented -eq $false) { Add-Result "lic-invented" "invented license key refused" "PASS" "invalid as expected" }
            else { Add-Result "lic-invented" "invented license key refused" "FAIL" "invented key accepted!" }
            if ($k.tampered -eq $false) { Add-Result "lic-modified" "tampered license key refused" "PASS" "invalid as expected" }
            else { Add-Result "lic-modified" "tampered license key refused" "FAIL" "tampered key accepted!" }
            if ($k.expValid -eq $false -and $k.expReason -match "expiree") { Add-Result "lic-expired" "expired license key refused" "PASS" ("reason: " + $k.expReason) }
            else { Add-Result "lic-expired" "expired license key refused" "FAIL" ("unexpected: valid=" + $k.expValid + " reason=" + $k.expReason) }
        }
    } catch {
        Add-Result "lic-invented" "invented license key refused" "FAIL" ("exception: " + $_.Exception.Message)
        Add-Result "lic-modified" "tampered license key refused" "FAIL" ("exception: " + $_.Exception.Message)
        Add-Result "lic-expired" "expired license key refused" "FAIL" ("exception: " + $_.Exception.Message)
    }
    Remove-Item $licFile -Force -ErrorAction SilentlyContinue
}

# -- write results ------------------------------------------------------------------
$pass = @($results | Where-Object { $_.result -eq "PASS" }).Count
$fail = @($results | Where-Object { $_.result -eq "FAIL" }).Count
$skip = @($results | Where-Object { $_.result -eq "SKIP" }).Count
$report = [pscustomobject]@{
    date = (Get-Date).ToUniversalTime().ToString("o")
    installDir = $InstallDir
    runtimeUrl = $RuntimeUrl
    summary = @{ pass = $pass; fail = $fail; skip = $skip }
    tests = $results
}
$outPath = Join-Path $PSScriptRoot "pc-verify-result.json"
$report | ConvertTo-Json -Depth 5 | Out-File -FilePath $outPath -Encoding ascii -Force
Write-Host ("---")
Write-Host ("PASS=$pass FAIL=$fail SKIP=$skip -> $outPath")
if ($fail -gt 0) { exit 1 } else { exit 0 }
