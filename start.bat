@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Starting...

:: ============================================================
::  SUDO STUDIO v4.2 - Windows Launcher
::  backend.exe  = Node.js/Express (pkg node18-win-x64)
::  runtime.exe  = Python/Flask + HuggingFace AI
::  No system Node.js or Python required.
::  v4.2: Removed fragile helper bat -> direct VSCodium launch
:: ============================================================

:: -- CRITICAL: Set working directory to script location ------
cd /d "%~dp0"

:: -- Global Variables ----------------------------------------
set "ROOT=%~dp0"
set "APP=%ROOT%"
set "LOGS=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "EXT=%ROOT%extensions\sudo-ai"
set "DATA=%ROOT%data"

:: -- STEP 1: Confirm script is actually running ---------------
echo.
echo ============================================================
echo   SUDO STUDIO v4.1
echo ============================================================
echo   STEP 1 - Script is running
echo   Root directory: %ROOT%
echo ============================================================
echo.

:: -- Create logs folder ---------------------------------------
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
if not exist "%LOGS%" (
    echo [ERROR] Cannot create logs folder at: %LOGS%
    echo         Check write permissions.
    echo.
    pause
    exit /b 1
)

:: -- Init log file --------------------------------------------
(
    echo ============================================================
    echo   SUDO STUDIO v4.1 - %DATE% %TIME%
    echo   Root: %ROOT%
    echo ============================================================
) > "%LOG_FILE%"
echo [LOG] Logging to: %LOG_FILE%
echo.

:: ============================================================
::  PHASE 1 - VERIFY ALL EXECUTABLES (STEP 2)
:: ============================================================
echo [STEP 2] Checking application files...
echo [PHASE 1] Checking files... >> "%LOG_FILE%"
echo.

:: --- backend.exe ---
if exist "%APP%backend.exe" (
    echo   [OK] backend.exe found
    echo   [OK] backend.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] backend.exe
    echo   Expected at: %APP%backend.exe
    echo   [ERROR] backend.exe not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] backend.exe is missing.
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- runtime.exe ---
if exist "%APP%runtime.exe" (
    echo   [OK] runtime.exe found
    echo   [OK] runtime.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] runtime.exe
    echo   Expected at: %APP%runtime.exe
    echo   [ERROR] runtime.exe not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] runtime.exe is missing.
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- VSCodium.exe ---
if exist "%APP%VSCodium.exe" (
    echo   [OK] VSCodium.exe found
    echo   [OK] VSCodium.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] VSCodium.exe
    echo   Expected at: %APP%VSCodium.exe
    echo   [ERROR] VSCodium.exe not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] VSCodium.exe is missing.
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- Sudo AI Extension (warning only - not fatal) ---
if exist "%EXT%\extension.js" (
    echo   [OK] Sudo AI extension found
    echo   [OK] extension.js >> "%LOG_FILE%"
) else (
    echo   [WARNING] Sudo AI extension not found at:
    echo             %EXT%\extension.js
    echo   [WARNING] Extension missing - VSCodium will open without Sudo AI >> "%LOG_FILE%"
)

echo.
echo [STEP 2] All required files verified.
echo [PHASE 1] All files OK >> "%LOG_FILE%"
echo.

:: ============================================================
::  PHASE 2 - LAUNCH AI RUNTIME (port 6000) (STEP 3)
:: ============================================================
echo [STEP 3] Starting AI Runtime on port %RUNTIME_PORT%...
echo          (First run may download AI model ~600MB - up to 5 min)
echo [PHASE 2] Launching runtime.exe on port %RUNTIME_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing runtime on port 6000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch runtime.exe in a minimized window
start "SudoRuntime" /MIN "%APP%runtime.exe"
echo [PHASE 2] runtime.exe launched >> "%LOG_FILE%"
echo   [LAUNCHED] runtime.exe -> port %RUNTIME_PORT%
echo.

:: -- Poll port 6000 every 3 seconds, timeout 300s (5 min for model download) --
set "RUNTIME_READY=0"
set "RUNTIME_WAIT=0"

:wait_runtime
    set /a RUNTIME_WAIT+=1
    if !RUNTIME_WAIT! gtr 100 goto :runtime_timeout
    timeout /t 3 /nobreak >nul

    :: Try curl first (faster)
    curl -s -o nul -w "%%{http_code}" http://localhost:%RUNTIME_PORT%/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "RUNTIME_READY=1"
        goto :runtime_ok
    )

    :: Fallback: PowerShell
    powershell -NoProfile -WindowStyle Hidden -Command "try{$r=(Invoke-WebRequest -Uri 'http://localhost:%RUNTIME_PORT%/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
        set "RUNTIME_READY=1"
        goto :runtime_ok
    )

    :: Print progress every 15 seconds
    set /a RUNTIME_ELAPSED=RUNTIME_WAIT*3
    set /a RUNTIME_MOD=RUNTIME_ELAPSED %% 15
    if !RUNTIME_MOD! equ 0 (
        echo   Still waiting for Runtime... !RUNTIME_ELAPSED!s elapsed
    )
    goto :wait_runtime

:runtime_timeout
    echo   [WARNING] Runtime did not respond after 300s. Continuing...
    echo   Check log: %LOGS%\runtime.log if it exists.
    echo [PHASE 2] WARNING: Runtime timeout >> "%LOG_FILE%"
    goto :runtime_done

:runtime_ok
    echo   [OK] AI Runtime ready on port %RUNTIME_PORT%
    echo [PHASE 2] Runtime ready on port %RUNTIME_PORT% >> "%LOG_FILE%"

:runtime_done
echo.

:: ============================================================
::  PHASE 3 - LAUNCH BACKEND (port 5000) (STEP 4)
:: ============================================================
echo [STEP 4] Starting Backend on port %BACKEND_PORT%...
echo [PHASE 3] Launching backend.exe on port %BACKEND_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing backend on port 5000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch backend.exe in a minimized window
start "SudoBackend" /MIN "%APP%backend.exe"
echo [PHASE 3] backend.exe launched >> "%LOG_FILE%"
echo   [LAUNCHED] backend.exe -> port %BACKEND_PORT%
echo.

:: -- Poll port 5000 every 2 seconds, timeout 60s --
set "BACKEND_READY=0"
set "BACKEND_WAIT=0"

:wait_backend
    set /a BACKEND_WAIT+=1
    if !BACKEND_WAIT! gtr 30 goto :backend_timeout
    timeout /t 2 /nobreak >nul

    :: Try curl first
    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    :: Fallback: PowerShell
    powershell -NoProfile -WindowStyle Hidden -Command "try{$r=(Invoke-WebRequest -Uri 'http://localhost:%BACKEND_PORT%/api/system/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    echo   Waiting for Backend... !BACKEND_WAIT! / 30
    goto :wait_backend

:backend_timeout
    echo.
    echo   [ERROR] Backend did not respond after 60 seconds.
    echo   [ERROR] Backend timeout >> "%LOG_FILE%"
    echo.
    echo   Diagnostics:
    echo     - Port %BACKEND_PORT% may already be in use
    echo     - Check: %ROOT%logs\backend.log
    echo.
    echo   Last backend output (if any):
    if exist "%LOGS%\backend.log" (
        powershell -NoProfile -WindowStyle Hidden -Command "Get-Content '%LOGS%\backend.log' -Tail 5 -EA SilentlyContinue" 2>nul
    ) else (
        echo     No backend.log found yet.
    )
    echo.
    echo ============================================================
    echo   Backend failed. Press any key to close.
    echo ============================================================
    pause
    exit /b 1

:backend_ok
    echo   [OK] Backend ready on port %BACKEND_PORT%
    echo [PHASE 3] Backend ready on port %BACKEND_PORT% >> "%LOG_FILE%"

:backend_done
echo.

:: ============================================================
::  PHASE 4 - HEALTH CHECK SUMMARY (STEP 5)
:: ============================================================
echo [STEP 5] Health Check Summary:
echo [PHASE 4] Health check summary >> "%LOG_FILE%"
echo.

:: Runtime health
if "!RUNTIME_READY!"=="1" (
    echo   Runtime  (port %RUNTIME_PORT%) : OK
    echo [PHASE 4] Runtime OK >> "%LOG_FILE%"
) else (
    echo   Runtime  (port %RUNTIME_PORT%) : WARNING - Not responding
    echo [PHASE 4] Runtime WARNING >> "%LOG_FILE%"
)

:: Backend health
if "!BACKEND_READY!"=="1" (
    echo   Backend  (port %BACKEND_PORT%) : OK
    echo [PHASE 4] Backend OK >> "%LOG_FILE%"
) else (
    echo   Backend  (port %BACKEND_PORT%) : ERROR
    echo [PHASE 4] Backend ERROR >> "%LOG_FILE%"
)

:: Extension check
if exist "%EXT%\extension.js" (
    echo   Extension               : OK
    echo [PHASE 4] Extension OK >> "%LOG_FILE%"
) else (
    echo   Extension               : WARNING - Not found
    echo [PHASE 4] Extension WARNING - not found >> "%LOG_FILE%"
)

echo.

:: ============================================================
::  PHASE 5 - LAUNCH VSCODIUM + SUDO AI EXTENSION (STEP 6)
:: ============================================================
echo [STEP 6] Opening Sudo Studio (VSCodium + Sudo AI)...
echo [PHASE 5] Launching VSCodium... >> "%LOG_FILE%"
echo.

:: Set VSCodium launch variables
set "VSCODIUM=%ROOT%VSCodium.exe"
set "VSCEXT=%ROOT%extensions"
set "VSCDATA=%ROOT%data"
set "VSCDEV=%ROOT%extensions\sudo-ai"

:: Verify VSCodium.exe exists before attempting launch
if not exist "%VSCODIUM%" (
    echo [ERROR] VSCodium not found: %VSCODIUM% >> "%LOG_FILE%"
    echo.
    echo [FATAL] VSCodium.exe introuvable
    echo Chemin: %VSCODIUM%
    pause
    exit /b 1
)

:: Create required directories
if not exist "%VSCDATA%" mkdir "%VSCDATA%" 2>nul
if not exist "%VSCEXT%" mkdir "%VSCEXT%" 2>nul

:: Launch VSCodium directly (no helper bat - avoids quote corruption + silent call failure)
echo [PHASE 5] Starting VSCodium process... >> "%LOG_FILE%"
start "SudoStudio" "%VSCODIUM%" --extensions-dir "%VSCEXT%" --user-data-dir "%VSCDATA%" --extensionDevelopmentPath "%VSCDEV%"

timeout /t 3 /nobreak >nul
echo [PHASE 5] VSCodium launch command sent >> "%LOG_FILE%"

:: Verify VSCodium process is running
tasklist | findstr /I "VSCodium" >nul 2>&1
if !errorlevel! equ 0 (
    echo [PHASE 5] VSCodium process confirmed >> "%LOG_FILE%"
    echo   [OK] VSCodium is running
) else (
    echo [PHASE 5] WARNING: VSCodium not detected >> "%LOG_FILE%"
    echo   [WARNING] VSCodium may have closed
    echo   Check antivirus or permissions
)

echo.

:: ============================================================
::  PHASE 6 - EXTENSION VERIFICATION (STEP 7)
:: ============================================================
echo [STEP 7] Extension Verification:
if exist "%EXT%\extension.js" (
    echo   [OK] extension.js present
) else (
    echo   [WARN] extension.js not found - Sudo AI features unavailable
)
if exist "%EXT%\package.json" (
    echo   [OK] package.json present
) else (
    echo   [WARN] package.json not found
)
if exist "%EXT%\src" (
    echo   [OK] src\ directory present
) else (
    echo   [WARN] src\ directory not found
)
echo.

:: ============================================================
::  ALL SERVICES RUNNING
:: ============================================================
echo [DONE] >> "%LOG_FILE%"
echo %DATE% %TIME% - ALL SERVICES STARTED >> "%LOG_FILE%"
echo.
echo ============================================================
echo   SUDO STUDIO IS RUNNING
echo ============================================================
echo.
echo   Backend   : http://localhost:%BACKEND_PORT%
echo   AI Runtime: http://localhost:%RUNTIME_PORT%
echo.
echo   Logs      : %LOGS%\startup.log
echo.
echo   VSCodium should now be opening with Sudo AI loaded.
echo   If VSCodium is not open yet, wait 5-10 seconds.
echo.
echo ============================================================
echo   Keep this window open to maintain services.
echo   Close this window to stop everything.
echo ============================================================
echo.

:: -- Keep terminal open, services run in their own windows ---
:keep_alive
timeout /t 30 /nobreak >nul
goto :keep_alive
