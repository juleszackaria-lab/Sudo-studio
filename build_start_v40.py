#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_start_v40.py
==================
Generates start.bat v4.3 with CRLF line endings and pure ASCII content.

ROOT CAUSES FIXED in v4.1:
  BUG #1: APPDIR=%ROOT%app\\  WRONG  -> fixed: APP=%ROOT% (exe files are in ROOT directly)
  BUG #2: EXT=%ROOT%app\\extensions\\sudo-ai  WRONG  -> fixed: EXT=%ROOT%extensions\\sudo-ai
  BUG #3: DATA=%ROOT%app\\data  WRONG  -> fixed: DATA=%ROOT%data
  BUG #4: start "..." exe ^ / next-line   FRAGILE  -> fixed: build full cmd in a variable, single line
  BUG #5: startup.log stops at [PHASE 3]  -> fixed: PHASE 5 now writes to log + checks process

ROOT CAUSES FIXED in v4.2:
  BUG #6: launch_vscodium.bat helper approach CRASHES silently:
          - echo with embedded quotes corrupts the bat content
          - call to corrupted bat terminates parent script
          FIXED: Replace helper bat with direct 'start' command
  BUG #7: Variable names mismatch -> unified as VSCODIUM/VSCEXT/VSCDATA/VSCDEV

ROOT CAUSES FIXED in v4.3:
  BUG #8: PHASE 4 uses !RUNTIME_READY! and !BACKEND_READY! with delayed expansion
          inside if/else () blocks. On some Windows CMD configs, after curl/powershell
          leaves a non-zero ERRORLEVEL, the delayed expansion evaluation of !var! inside
          a parenthesized block crashes CMD silently.
          FIXED: Replace !RUNTIME_READY! -> %RUNTIME_READY% and !BACKEND_READY! -> %BACKEND_READY%
          in PHASE 4 summary (variables are set before goto, so %var% expansion is correct here)
  BUG #9: PHASE 5 direct 'start' command with long args crashes CMD silently on some systems
          when path variables expand to contain spaces.
          FIXED: Use (echo ...) > launcher.bat parenthesized block method - the ONLY safe way
          to write quoted content to a file in batch. Then call the launcher.
          The launcher is written to %ROOT%launch.bat (NOT %LOGS%) to avoid any %LOGS% path issues.
  BUG #10: tasklist | findstr uses !errorlevel! (delayed expansion) which can fail if
           the pipe resets ERRORLEVEL. FIXED: Use explicit if errorlevel 1 / if not errorlevel 1
"""

import os

CRLF = "\r\n"

# Pure ASCII batch script - NO UTF-8, NO special chars
LINES = [
    # ============================================================
    # HEADER
    # ============================================================
    "@echo off",
    "setlocal enabledelayedexpansion",
    "title Sudo Studio - Starting...",
    "",
    ":: ============================================================",
    "::  SUDO STUDIO v4.3 - Windows Launcher",
    "::  backend.exe  = Node.js/Express (pkg node18-win-x64)",
    "::  runtime.exe  = Python/Flask + HuggingFace AI",
    "::  No system Node.js or Python required.",
    "::  v4.3: Fixed PHASE 4 !var! crash + PHASE 5 launcher script",
    ":: ============================================================",
    "",
    ":: -- CRITICAL: Set working directory to script location ------",
    'cd /d "%~dp0"',
    "",
    ":: -- Global Variables ----------------------------------------",
    'set "ROOT=%~dp0"',
    # FIX #1: APP = ROOT (exe files installed directly in ROOT, no app\ subdir)
    'set "APP=%ROOT%"',
    'set "LOGS=%ROOT%logs"',
    'set "LOG_FILE=%ROOT%logs\\startup.log"',
    'set "BACKEND_PORT=5000"',
    'set "RUNTIME_PORT=6000"',
    # FIX #2: EXT = ROOT\extensions\sudo-ai  (not ROOT\app\extensions\sudo-ai)
    'set "EXT=%ROOT%extensions\\sudo-ai"',
    # FIX #3: DATA = ROOT\data  (not ROOT\app\data)
    'set "DATA=%ROOT%data"',
    "",
    ":: -- STEP 1: Confirm script is actually running ---------------",
    "echo.",
    "echo ============================================================",
    "echo   SUDO STUDIO v4.3",
    "echo ============================================================",
    "echo   STEP 1 - Script is running",
    "echo   Root directory: %ROOT%",
    "echo ============================================================",
    "echo.",
    "",
    ":: -- Create logs folder ---------------------------------------",
    'if not exist "%LOGS%" mkdir "%LOGS%" 2>nul',
    'if not exist "%LOGS%" (',
    '    echo [ERROR] Cannot create logs folder at: %LOGS%',
    '    echo         Check write permissions.',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    "",
    ":: -- Init log file --------------------------------------------",
    '(',
    '    echo ============================================================',
    '    echo   SUDO STUDIO v4.3 - %DATE% %TIME%',
    '    echo   Root: %ROOT%',
    '    echo ============================================================',
    ') > "%LOG_FILE%"',
    'echo [LOG] Logging to: %LOG_FILE%',
    "echo.",
    "",
    ":: ============================================================",
    "::  PHASE 1 - VERIFY ALL EXECUTABLES (STEP 2)",
    ":: ============================================================",
    "echo [STEP 2] Checking application files...",
    'echo [PHASE 1] Checking files... >> "%LOG_FILE%"',
    "echo.",
    "",
    ":: --- backend.exe ---",
    'if exist "%APP%backend.exe" (',
    '    echo   [OK] backend.exe found',
    '    echo   [OK] backend.exe >> "%LOG_FILE%"',
    ') else (',
    '    echo   [NOT FOUND] backend.exe',
    '    echo   Expected at: %APP%backend.exe',
    '    echo   [ERROR] backend.exe not found >> "%LOG_FILE%"',
    '    echo.',
    '    echo [FATAL] backend.exe is missing.',
    '    echo         Please reinstall Sudo Studio.',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    "",
    ":: --- runtime.exe ---",
    'if exist "%APP%runtime.exe" (',
    '    echo   [OK] runtime.exe found',
    '    echo   [OK] runtime.exe >> "%LOG_FILE%"',
    ') else (',
    '    echo   [NOT FOUND] runtime.exe',
    '    echo   Expected at: %APP%runtime.exe',
    '    echo   [ERROR] runtime.exe not found >> "%LOG_FILE%"',
    '    echo.',
    '    echo [FATAL] runtime.exe is missing.',
    '    echo         Please reinstall Sudo Studio.',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    "",
    ":: --- VSCodium.exe ---",
    'if exist "%APP%VSCodium.exe" (',
    '    echo   [OK] VSCodium.exe found',
    '    echo   [OK] VSCodium.exe >> "%LOG_FILE%"',
    ') else (',
    '    echo   [NOT FOUND] VSCodium.exe',
    '    echo   Expected at: %APP%VSCodium.exe',
    '    echo   [ERROR] VSCodium.exe not found >> "%LOG_FILE%"',
    '    echo.',
    '    echo [FATAL] VSCodium.exe is missing.',
    '    echo         Please reinstall Sudo Studio.',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    "",
    ":: --- Sudo AI Extension (warning only - not fatal) ---",
    'if exist "%EXT%\\extension.js" (',
    '    echo   [OK] Sudo AI extension found',
    '    echo   [OK] extension.js >> "%LOG_FILE%"',
    ') else (',
    '    echo   [WARNING] Sudo AI extension not found at:',
    '    echo             %EXT%\\extension.js',
    '    echo   [WARNING] Extension missing - VSCodium will open without Sudo AI >> "%LOG_FILE%"',
    ')',
    "",
    "echo.",
    "echo [STEP 2] All required files verified.",
    'echo [PHASE 1] All files OK >> "%LOG_FILE%"',
    "echo.",
    "",
    ":: ============================================================",
    "::  PHASE 2 - LAUNCH AI RUNTIME (port 6000) (STEP 3)",
    ":: ============================================================",
    "echo [STEP 3] Starting AI Runtime on port %RUNTIME_PORT%...",
    "echo          (First run may download AI model ~600MB - up to 5 min)",
    'echo [PHASE 2] Launching runtime.exe on port %RUNTIME_PORT% >> "%LOG_FILE%"',
    "echo.",
    "",
    ":: Kill any existing runtime on port 6000",
    'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr ":6000 " ^| findstr "LISTENING"\') do (',
    '    taskkill /F /PID %%a >nul 2>&1',
    ')',
    "",
    ":: Launch runtime.exe in a minimized window",
    'start "SudoRuntime" /MIN "%APP%runtime.exe"',
    'echo [PHASE 2] runtime.exe launched >> "%LOG_FILE%"',
    "echo   [LAUNCHED] runtime.exe -> port %RUNTIME_PORT%",
    "echo.",
    "",
    ":: -- Poll port 6000 every 3 seconds, timeout 300s (5 min for model download) --",
    'set "RUNTIME_READY=0"',
    'set "RUNTIME_WAIT=0"',
    "",
    ":wait_runtime",
    '    set /a RUNTIME_WAIT+=1',
    '    if !RUNTIME_WAIT! gtr 100 goto :runtime_timeout',
    '    timeout /t 3 /nobreak >nul',
    "",
    "    :: Try curl first (faster)",
    '    curl -s -o nul -w "%%{http_code}" http://localhost:%RUNTIME_PORT%/health 2>nul | findstr /B "200" >nul 2>&1',
    '    if !errorlevel! equ 0 (',
    '        set "RUNTIME_READY=1"',
    '        goto :runtime_ok',
    '    )',
    "",
    "    :: Fallback: PowerShell",
    "    powershell -NoProfile -WindowStyle Hidden -Command \"try{$r=(Invoke-WebRequest -Uri 'http://localhost:%RUNTIME_PORT%/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}\" >nul 2>&1",
    '    if !errorlevel! equ 0 (',
    '        set "RUNTIME_READY=1"',
    '        goto :runtime_ok',
    '    )',
    "",
    "    :: Print progress every 15 seconds",
    '    set /a RUNTIME_ELAPSED=RUNTIME_WAIT*3',
    '    set /a RUNTIME_MOD=RUNTIME_ELAPSED %% 15',
    '    if !RUNTIME_MOD! equ 0 (',
    '        echo   Still waiting for Runtime... !RUNTIME_ELAPSED!s elapsed',
    '    )',
    '    goto :wait_runtime',
    "",
    ":runtime_timeout",
    '    echo   [WARNING] Runtime did not respond after 300s. Continuing...',
    '    echo   Check log: %LOGS%\\runtime.log if it exists.',
    '    echo [PHASE 2] WARNING: Runtime timeout >> "%LOG_FILE%"',
    '    goto :runtime_done',
    "",
    ":runtime_ok",
    '    echo   [OK] AI Runtime ready on port %RUNTIME_PORT%',
    '    echo [PHASE 2] Runtime ready on port %RUNTIME_PORT% >> "%LOG_FILE%"',
    "",
    ":runtime_done",
    "echo.",
    "",
    ":: ============================================================",
    "::  PHASE 3 - LAUNCH BACKEND (port 5000) (STEP 4)",
    ":: ============================================================",
    "echo [STEP 4] Starting Backend on port %BACKEND_PORT%...",
    'echo [PHASE 3] Launching backend.exe on port %BACKEND_PORT% >> "%LOG_FILE%"',
    "echo.",
    "",
    ":: Kill any existing backend on port 5000",
    'for /f "tokens=5" %%a in (\'netstat -aon ^| findstr ":5000 " ^| findstr "LISTENING"\') do (',
    '    taskkill /F /PID %%a >nul 2>&1',
    ')',
    "",
    ":: Launch backend.exe in a minimized window",
    'start "SudoBackend" /MIN "%APP%backend.exe"',
    'echo [PHASE 3] backend.exe launched >> "%LOG_FILE%"',
    "echo   [LAUNCHED] backend.exe -> port %BACKEND_PORT%",
    "echo.",
    "",
    ":: -- Poll port 5000 every 2 seconds, timeout 60s --",
    'set "BACKEND_READY=0"',
    'set "BACKEND_WAIT=0"',
    "",
    ":wait_backend",
    '    set /a BACKEND_WAIT+=1',
    '    if !BACKEND_WAIT! gtr 30 goto :backend_timeout',
    '    timeout /t 2 /nobreak >nul',
    "",
    "    :: Try curl first",
    '    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1',
    '    if !errorlevel! equ 0 (',
    '        set "BACKEND_READY=1"',
    '        goto :backend_ok',
    '    )',
    "",
    "    :: Fallback: PowerShell",
    "    powershell -NoProfile -WindowStyle Hidden -Command \"try{$r=(Invoke-WebRequest -Uri 'http://localhost:%BACKEND_PORT%/api/system/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}\" >nul 2>&1",
    '    if !errorlevel! equ 0 (',
    '        set "BACKEND_READY=1"',
    '        goto :backend_ok',
    '    )',
    "",
    '    echo   Waiting for Backend... !BACKEND_WAIT! / 30',
    '    goto :wait_backend',
    "",
    ":backend_timeout",
    '    echo.',
    '    echo   [ERROR] Backend did not respond after 60 seconds.',
    '    echo   [ERROR] Backend timeout >> "%LOG_FILE%"',
    '    echo.',
    '    echo   Diagnostics:',
    '    echo     - Port %BACKEND_PORT% may already be in use',
    '    echo     - Check: %ROOT%logs\\backend.log',
    '    echo.',
    '    echo   Last backend output (if any):',
    '    if exist "%LOGS%\\backend.log" (',
    '        powershell -NoProfile -WindowStyle Hidden -Command "Get-Content \'%LOGS%\\backend.log\' -Tail 5 -EA SilentlyContinue" 2>nul',
    '    ) else (',
    '        echo     No backend.log found yet.',
    '    )',
    '    echo.',
    '    echo ============================================================',
    '    echo   Backend failed. Press any key to close.',
    '    echo ============================================================',
    '    pause',
    '    exit /b 1',
    "",
    ":backend_ok",
    '    echo   [OK] Backend ready on port %BACKEND_PORT%',
    '    echo [PHASE 3] Backend ready on port %BACKEND_PORT% >> "%LOG_FILE%"',
    "",
    ":backend_done",
    "echo.",
    "",
    ":: ============================================================",
    "::  PHASE 4 - HEALTH CHECK SUMMARY (STEP 5)",
    ":: ============================================================",
    "echo [STEP 5] Health Check Summary:",
    'echo [PHASE 4] Health check summary >> "%LOG_FILE%"',
    "echo.",
    "",
    # FIX #8: Use %RUNTIME_READY% instead of !RUNTIME_READY! here.
    # These variables are SET before the goto labels, so normal %var% expansion works.
    # Delayed expansion !var! inside () blocks after curl/powershell can crash CMD silently.
    ":: Runtime health -- FIX #8: use %var% not !var! to avoid delayed-expansion crash",
    'if "%RUNTIME_READY%"=="1" (',
    '    echo   Runtime  (port %RUNTIME_PORT%) : OK',
    '    echo [PHASE 4] Runtime OK >> "%LOG_FILE%"',
    ') else (',
    '    echo   Runtime  (port %RUNTIME_PORT%) : WARNING - Not responding',
    '    echo [PHASE 4] Runtime WARNING >> "%LOG_FILE%"',
    ')',
    "",
    ":: Backend health -- FIX #8: use %var% not !var!",
    'if "%BACKEND_READY%"=="1" (',
    '    echo   Backend  (port %BACKEND_PORT%) : OK',
    '    echo [PHASE 4] Backend OK >> "%LOG_FILE%"',
    ') else (',
    '    echo   Backend  (port %BACKEND_PORT%) : ERROR',
    '    echo [PHASE 4] Backend ERROR >> "%LOG_FILE%"',
    ')',
    "",
    ":: Extension check",
    'if exist "%EXT%\\extension.js" (',
    '    echo   Extension               : OK',
    '    echo [PHASE 4] Extension OK >> "%LOG_FILE%"',
    ') else (',
    '    echo   Extension               : WARNING - Not found',
    '    echo [PHASE 4] Extension WARNING - not found >> "%LOG_FILE%"',
    ')',
    "",
    "echo.",
    "",
    # ============================================================
    # PHASE 5 - LAUNCH VSCODIUM  v4.3: LAUNCHER SCRIPT (parenthesized block)
    # ============================================================
    ":: ============================================================",
    "::  PHASE 5 - LAUNCH VSCODIUM + SUDO AI EXTENSION (STEP 6)",
    ":: ============================================================",
    "echo [STEP 6] Opening Sudo Studio (VSCodium + Sudo AI)...",
    'echo [PHASE 5] Preparing VSCodium... >> "%LOG_FILE%"',
    "echo.",
    "",
    # FIX #9: Use short clean variable names V_EXE/V_EXT/V_DAT/V_DEV
    ":: Chemins sans espaces dans les variables",
    'set "V_EXE=%ROOT%VSCodium.exe"',
    'set "V_EXT=%ROOT%extensions"',
    'set "V_DAT=%ROOT%data"',
    'set "V_DEV=%ROOT%extensions\\sudo-ai"',
    "",
    ":: Creer dossiers necessaires",
    'if not exist "%V_DAT%" mkdir "%V_DAT%" 2>nul',
    'if not exist "%V_EXT%" mkdir "%V_EXT%" 2>nul',
    "",
    ":: Verifier VSCodium.exe",
    'if not exist "%V_EXE%" (',
    '    echo [FATAL] VSCodium.exe not found >> "%LOG_FILE%"',
    '    echo [FATAL] VSCodium.exe introuvable : %V_EXE%',
    '    pause',
    '    exit /b 1',
    ')',
    'echo [PHASE 5] VSCodium.exe found >> "%LOG_FILE%"',
    "",
    # FIX #9: Write launcher with parenthesized block - the ONLY safe way
    # to write quoted content to a file without quote corruption.
    # Written to %ROOT%launch.bat (ROOT dir, not LOGS) - avoids %LOGS% path issues.
    ":: Ecrire un script de lancement propre (bloc parenthese - seule methode sans corruption de guillemets)",
    'set "LAUNCHER=%ROOT%launch.bat"',
    '(',
    '    echo @echo off',
    '    echo start "" "%V_EXE%" --extensions-dir "%V_EXT%" --user-data-dir "%V_DAT%" --extensionDevelopmentPath "%V_DEV%"',
    ') > "%LAUNCHER%"',
    "",
    ":: Lancer via le script propre",
    'echo [PHASE 5] Launching via launcher... >> "%LOG_FILE%"',
    'call "%LAUNCHER%"',
    "",
    ":: Attendre et verifier",
    "timeout /t 5 /nobreak >nul",
    # FIX #10: Use explicit errorlevel check instead of !errorlevel! after pipe
    'tasklist 2>nul | findstr /I "VSCodium" >nul 2>&1',
    'if not errorlevel 1 (',
    '    echo [PHASE 5] VSCodium running OK >> "%LOG_FILE%"',
    '    echo   [OK] VSCodium is running',
    ') else (',
    '    echo [PHASE 5] VSCodium not detected >> "%LOG_FILE%"',
    '    echo   [WARNING] VSCodium may have closed',
    ')',
    "",
    "echo.",
    "",
    ":: ============================================================",
    "::  PHASE 6 - EXTENSION VERIFICATION (STEP 7)",
    ":: ============================================================",
    "echo [STEP 7] Extension Verification:",
    'if exist "%EXT%\\extension.js" (',
    '    echo   [OK] extension.js present',
    ') else (',
    '    echo   [WARN] extension.js not found - Sudo AI features unavailable',
    ')',
    'if exist "%EXT%\\package.json" (',
    '    echo   [OK] package.json present',
    ') else (',
    '    echo   [WARN] package.json not found',
    ')',
    'if exist "%EXT%\\src" (',
    '    echo   [OK] src\\ directory present',
    ') else (',
    '    echo   [WARN] src\\ directory not found',
    ')',
    "echo.",
    "",
    ":: ============================================================",
    "::  ALL SERVICES RUNNING",
    ":: ============================================================",
    'echo [DONE] >> "%LOG_FILE%"',
    'echo %DATE% %TIME% - ALL SERVICES STARTED >> "%LOG_FILE%"',
    "echo.",
    "echo ============================================================",
    "echo   SUDO STUDIO IS RUNNING",
    "echo ============================================================",
    "echo.",
    "echo   Backend   : http://localhost:%BACKEND_PORT%",
    "echo   AI Runtime: http://localhost:%RUNTIME_PORT%",
    "echo.",
    "echo   Logs      : %LOGS%\\startup.log",
    "echo.",
    "echo   VSCodium should now be opening with Sudo AI loaded.",
    "echo   If VSCodium is not open yet, wait 5-10 seconds.",
    "echo.",
    "echo ============================================================",
    "echo   Keep this window open to maintain services.",
    "echo   Close this window to stop everything.",
    "echo ============================================================",
    "echo.",
    "",
    ":: -- Keep terminal open, services run in their own windows ---",
    ":keep_alive",
    "timeout /t 30 /nobreak >nul",
    "goto :keep_alive",
]

# ============================================================
# Write file with CRLF
# ============================================================
output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "start.bat")

content = CRLF.join(LINES) + CRLF

# Verify pure ASCII (no UTF-8 sneaking in)
try:
    content.encode("ascii")
    print("OK Content is pure ASCII")
except UnicodeEncodeError as e:
    print(f"FAIL Non-ASCII character found: {e}")
    for i, line in enumerate(LINES, 1):
        try:
            line.encode("ascii")
        except UnicodeEncodeError:
            print(f"  Line {i}: {repr(line)}")
    exit(1)

with open(output_path, "wb") as f:
    f.write(content.encode("ascii"))

print(f"OK Written: {output_path}")
print(f"   Lines: {len(LINES)}")
print(f"   Size : {len(content)} bytes")
print(f"   CRLF : YES")

# ============================================================
# Validation checks
# ============================================================
print()
print("=== VALIDATION CHECKS ===")

checks = [
    # Core structure
    ('cd /d "%~dp0"',                       True,  "cd /d present"),
    ('set "APP=%ROOT%"',                    True,  "FIX #1: APP=%ROOT%"),
    ('set "EXT=%ROOT%extensions\\',         True,  "FIX #2: EXT=%ROOT%extensions"),
    ('set "DATA=%ROOT%data"',               True,  "FIX #3: DATA=%ROOT%data"),
    # v4.3 FIX #8: %var% instead of !var! in PHASE 4
    ('if "%RUNTIME_READY%"=="1"',           True,  "FIX #8: RUNTIME uses %var% not !var!"),
    ('if "%BACKEND_READY%"=="1"',           True,  "FIX #8: BACKEND uses %var% not !var!"),
    ('if "!RUNTIME_READY!"=="1"',           False, "FIX #8: NO !RUNTIME_READY! in PHASE 4"),
    ('if "!BACKEND_READY!"=="1"',           False, "FIX #8: NO !BACKEND_READY! in PHASE 4"),
    # v4.3 FIX #9: launcher script via parenthesized block
    ('set "LAUNCHER=%ROOT%launch.bat"',     True,  "FIX #9: LAUNCHER=%ROOT%launch.bat"),
    ('set "V_EXE=%ROOT%VSCodium.exe"',      True,  "FIX #9: V_EXE variable"),
    ('set "V_EXT=%ROOT%extensions"',        True,  "FIX #9: V_EXT variable"),
    ('set "V_DAT=%ROOT%data"',              True,  "FIX #9: V_DAT variable"),
    ('set "V_DEV=%ROOT%extensions\\sudo-ai"', True, "FIX #9: V_DEV variable"),
    ('call "%LAUNCHER%"',                   True,  "FIX #9: call LAUNCHER"),
    # v4.3 FIX #10: explicit errorlevel check
    ('if not errorlevel 1',                 True,  "FIX #10: explicit errorlevel check (no !errorlevel!)"),
    # Log entries
    ("[PHASE 5] VSCodium.exe found",        True,  "PHASE 5 log: VSCodium.exe found"),
    ("[PHASE 5] Launching via launcher",    True,  "PHASE 5 log: Launching via launcher"),
    ("[PHASE 5] VSCodium running OK",       True,  "PHASE 5 log: VSCodium running OK"),
    # Absent items
    ("launch_vscodium.bat",                 False, "NO old launch_vscodium.bat"),
    ("APPDIR",                              False, "NO APPDIR (wrong old var)"),
    ("%ROOT%app\\",                         False, "NO %ROOT%app\\ paths"),
    ("M-b",                                 False, "NO UTF-8 garbage"),
    # Structure
    ("extensionDevelopmentPath",            True,  "VSCodium --extensionDevelopmentPath flag"),
    (":keep_alive",                         True,  "keep_alive label present"),
    ("goto :keep_alive",                    True,  "goto :keep_alive present"),
    ("LOG_FILE",                            True,  "logging enabled"),
    ("pause",                               True,  "pause before exit on error"),
]

all_ok = True
for text, must_exist, desc in checks:
    present = text in content
    if must_exist:
        if present:
            print(f"  PASS - {desc}")
        else:
            print(f"  FAIL - {desc} -- '{text}' not found!")
            all_ok = False
    else:
        if not present:
            print(f"  PASS - {desc}")
        else:
            print(f"  FAIL - {desc} -- '{text}' IS present (should be absent!)")
            all_ok = False

print()
if all_ok:
    print("=== ALL CHECKS PASSED === start.bat v4.3 ready")
else:
    print("=== SOME CHECKS FAILED === Review output above")
