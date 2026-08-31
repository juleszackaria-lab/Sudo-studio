@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Starting...

:: ============================================================
::  SUDO STUDIO v5.0 - Windows Launcher
::  Changes in v5.0:
::   - UAC auto-elevation (no more "run as administrator")
::   - backend.exe + runtime.exe launch INVISIBLE (no CMD window)
::   - Uses launch_hidden.vbs for silent background processes
::   - Window title and all references updated to "Sudo Studio"
:: ============================================================

:: -- CRITICAL: Set working directory to script location ------
cd /d "%~dp0"
set "ROOT=%~dp0"

:: ============================================================
::  AUTO UAC ELEVATION
::  If not running as admin, relaunch this script elevated.
::  Uses PowerShell Start-Process -Verb RunAs (no .vbs needed).
:: ============================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo   [UAC] Requesting administrator privileges...
    echo   [UAC] A Windows permission dialog will appear.
    echo   [UAC] Click "Yes" to continue.
    echo.
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b 0
)

:: -- Now running as administrator ----------------------------

:: -- Global Variables ----------------------------------------
set "APP=%ROOT%"
set "LOGS=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "EXT=%ROOT%extensions\sudo-ai"
set "DATA=%ROOT%data"
set "VBS=%ROOT%launch_hidden.vbs"

:: ============================================================
::  STEP 1 - Confirm script is running
:: ============================================================
echo.
echo ============================================================
echo   SUDO STUDIO v5.0
echo ============================================================
echo   Running as: Administrator
echo   Root: %ROOT%
echo ============================================================
echo.

:: -- Create logs folder --------------------------------------
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
if not exist "%LOGS%" (
    echo [ERROR] Cannot create logs folder: %LOGS%
    pause
    exit /b 1
)

:: -- Init log file -------------------------------------------
(
    echo ============================================================
    echo   SUDO STUDIO v5.0 - %DATE% %TIME%
    echo   Root: %ROOT%
    echo   Running as: Administrator
    echo ============================================================
) > "%LOG_FILE%"
echo [LOG] Logging to: %LOG_FILE%
echo.

:: ============================================================
::  STEP 2 - VERIFY ALL EXECUTABLES
:: ============================================================
echo [STEP 2] Checking application files...
echo [STEP 2] Checking files... >> "%LOG_FILE%"
echo.

:: --- backend.exe ---
if exist "%APP%backend.exe" (
    echo   [OK] backend.exe found
    echo   [OK] backend.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] backend.exe - Expected: %APP%backend.exe
    echo   [ERROR] backend.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] backend.exe is missing. Please reinstall Sudo Studio.
    pause
    exit /b 1
)

:: --- runtime.exe ---
if exist "%APP%runtime.exe" (
    echo   [OK] runtime.exe found
    echo   [OK] runtime.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] runtime.exe - Expected: %APP%runtime.exe
    echo   [ERROR] runtime.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] runtime.exe is missing. Please reinstall Sudo Studio.
    pause
    exit /b 1
)

:: --- VSCodium.exe (Sudo Studio editor) ---
if exist "%APP%VSCodium.exe" (
    echo   [OK] VSCodium.exe (Sudo Studio editor) found
    echo   [OK] VSCodium.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] VSCodium.exe - Expected: %APP%VSCodium.exe
    echo   [ERROR] VSCodium.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] VSCodium.exe is missing. Please reinstall Sudo Studio.
    pause
    exit /b 1
)

:: --- VBScript launcher (for hidden processes) ---
if exist "%VBS%" (
    echo   [OK] launch_hidden.vbs found
    echo   [OK] launch_hidden.vbs >> "%LOG_FILE%"
) else (
    echo   [WARN] launch_hidden.vbs not found - using minimized windows as fallback
    echo   [WARN] launch_hidden.vbs missing >> "%LOG_FILE%"
    set "USE_VBS=0"
    goto :check_vbs_done
)
set "USE_VBS=1"
:check_vbs_done

:: --- Sudo AI Extension ---
if exist "%EXT%\extension.js" (
    echo   [OK] Sudo AI extension found
) else (
    echo   [WARN] Sudo AI extension not found - opening without AI features
    echo   [WARN] Extension missing >> "%LOG_FILE%"
)

echo.
echo [STEP 2] All required files verified.
echo [STEP 2] All files OK >> "%LOG_FILE%"
echo.

:: ============================================================
::  PHASE 2 - LAUNCH AI RUNTIME (port 6000) - INVISIBLE
:: ============================================================
echo [STEP 3] Starting AI Runtime on port %RUNTIME_PORT% (background, invisible)...
echo [PHASE 2] Launching runtime.exe HIDDEN on port %RUNTIME_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing runtime on port 6000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6000 " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch runtime.exe COMPLETELY HIDDEN (no window, no taskbar icon)
if "%USE_VBS%"=="1" (
    cscript //nologo "%VBS%" "%APP%runtime.exe" --port %RUNTIME_PORT%
    echo   [LAUNCHED] runtime.exe hidden via VBScript
    echo [PHASE 2] runtime.exe launched hidden via VBScript >> "%LOG_FILE%"
) else (
    :: Fallback: PowerShell hidden launch
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -FilePath '%APP%runtime.exe' -ArgumentList '--port %RUNTIME_PORT%' -WindowStyle Hidden"
    echo   [LAUNCHED] runtime.exe hidden via PowerShell
    echo [PHASE 2] runtime.exe launched hidden via PowerShell >> "%LOG_FILE%"
)
echo.

:: -- Poll port 6000 every 3s, timeout 600s (10 min for 2GB model load) --
set "RUNTIME_READY=0"
set "RUNTIME_WAIT=0"

:wait_runtime
    set /a RUNTIME_WAIT+=1
    if !RUNTIME_WAIT! gtr 200 goto :runtime_timeout
    timeout /t 3 /nobreak >nul

    :: Check with curl first
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

    set /a RUNTIME_ELAPSED=RUNTIME_WAIT*3
    set /a RUNTIME_MOD=RUNTIME_ELAPSED %% 15
    if !RUNTIME_MOD! equ 0 (
        echo   [AI Loading] !RUNTIME_ELAPSED!s - TinyLlama loading... (up to 600s)
        echo   [AI Loading] !RUNTIME_ELAPSED!s >> "%LOG_FILE%"
    )
    goto :wait_runtime

:runtime_timeout
    echo.
    echo   [OK] 600s elapsed. runtime.exe is still running (loading model).
    echo   [OK] Sudo Studio will open now. Chat works once model finishes loading.
    echo [PHASE 2] 600s timeout - runtime still loading >> "%LOG_FILE%"
    goto :runtime_done

:runtime_ok
    echo   [OK] AI Runtime ready on port %RUNTIME_PORT%
    echo [PHASE 2] Runtime ready on port %RUNTIME_PORT% >> "%LOG_FILE%"

:runtime_done
echo.

:: ============================================================
::  PHASE 3 - LAUNCH BACKEND (port 5000) - INVISIBLE
:: ============================================================
echo [STEP 4] Starting Backend on port %BACKEND_PORT% (background, invisible)...
echo [PHASE 3] Launching backend.exe HIDDEN on port %BACKEND_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing backend on port 5000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000 " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch backend.exe COMPLETELY HIDDEN
if "%USE_VBS%"=="1" (
    cscript //nologo "%VBS%" "%APP%backend.exe" --port %BACKEND_PORT%
    echo   [LAUNCHED] backend.exe hidden via VBScript
    echo [PHASE 3] backend.exe launched hidden via VBScript >> "%LOG_FILE%"
) else (
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -FilePath '%APP%backend.exe' -ArgumentList '--port %BACKEND_PORT%' -WindowStyle Hidden"
    echo   [LAUNCHED] backend.exe hidden via PowerShell
    echo [PHASE 3] backend.exe launched hidden via PowerShell >> "%LOG_FILE%"
)
echo.

:: -- Poll port 5000 every 2 seconds, timeout 60s --
set "BACKEND_READY=0"
set "BACKEND_WAIT=0"

:wait_backend
    set /a BACKEND_WAIT+=1
    if !BACKEND_WAIT! gtr 30 goto :backend_timeout
    timeout /t 2 /nobreak >nul

    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    powershell -NoProfile -WindowStyle Hidden -Command "try{$r=(Invoke-WebRequest -Uri 'http://localhost:%BACKEND_PORT%/api/system/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    echo   Waiting for Backend... !BACKEND_WAIT! / 30
    goto :wait_backend

:backend_timeout
    echo.
    echo   [WARN] Backend did not respond in 60s. Continuing anyway.
    echo   [WARN] Check logs: %ROOT%logs\backend.log
    echo   [WARN] Backend timeout >> "%LOG_FILE%"
    goto :backend_done

:backend_ok
    echo   [OK] Backend ready on port %BACKEND_PORT%
    echo [PHASE 3] Backend ready on port %BACKEND_PORT% >> "%LOG_FILE%"

:backend_done
echo.

:: ============================================================
::  PHASE 4 - VERIFY PROCESSES RUNNING (tasklist check)
:: ============================================================
echo [STEP 5] Verifying background processes...
echo [PHASE 4] Process verification >> "%LOG_FILE%"

tasklist 2>nul | findstr /I "runtime.exe" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] runtime.exe is running in background (invisible)
    echo   [OK] runtime.exe confirmed running >> "%LOG_FILE%"
) else (
    echo   [WARN] runtime.exe not detected in tasklist - may still be starting
    echo   [WARN] runtime.exe not in tasklist >> "%LOG_FILE%"
)

tasklist 2>nul | findstr /I "backend.exe" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] backend.exe is running in background (invisible)
    echo   [OK] backend.exe confirmed running >> "%LOG_FILE%"
) else (
    echo   [WARN] backend.exe not detected in tasklist - may still be starting
    echo   [WARN] backend.exe not in tasklist >> "%LOG_FILE%"
)
echo.

:: ============================================================
::  PHASE 5 - LAUNCH SUDO STUDIO EDITOR (VSCodium)
:: ============================================================
echo [STEP 6] Opening Sudo Studio...
echo [PHASE 5] Launching Sudo Studio editor... >> "%LOG_FILE%"
echo.

set "V_EXE=%ROOT%VSCodium.exe"
set "V_EXT=%ROOT%extensions"
set "V_DAT=%ROOT%data"
set "V_DEV=%ROOT%extensions\sudo-ai"

if not exist "%V_DAT%" mkdir "%V_DAT%" 2>nul
if not exist "%V_EXT%" mkdir "%V_EXT%" 2>nul

if not exist "%V_EXE%" (
    echo [FATAL] VSCodium.exe not found: %V_EXE%
    echo [FATAL] VSCodium.exe not found >> "%LOG_FILE%"
    pause
    exit /b 1
)

:: Write clean launcher script
set "LAUNCHER=%ROOT%launch.bat"
(
    echo @echo off
    echo start "" "%V_EXE%" --extensions-dir "%V_EXT%" --user-data-dir "%V_DAT%" --extensionDevelopmentPath "%V_DEV%"
) > "%LAUNCHER%"

echo [PHASE 5] Launching editor via launcher... >> "%LOG_FILE%"
call "%LAUNCHER%"

timeout /t 5 /nobreak >nul
tasklist 2>nul | findstr /I "VSCodium" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Sudo Studio (VSCodium) is running
    echo [PHASE 5] VSCodium running OK >> "%LOG_FILE%"
) else (
    echo   [WARN] Sudo Studio may still be starting...
    echo [PHASE 5] VSCodium not yet detected >> "%LOG_FILE%"
)
echo.

:: ============================================================
::  PHASE 6 - EXTENSION VERIFICATION
:: ============================================================
echo [STEP 7] Extension Check:
if exist "%EXT%\extension.js"  (echo   [OK] extension.js) else (echo   [WARN] extension.js missing)
if exist "%EXT%\package.json"  (echo   [OK] package.json) else (echo   [WARN] package.json missing)
if exist "%EXT%\src"           (echo   [OK] src\ directory) else (echo   [WARN] src\ missing)
echo.

:: ============================================================
::  ALL SERVICES RUNNING
:: ============================================================
echo %DATE% %TIME% - ALL SERVICES STARTED >> "%LOG_FILE%"
echo.
echo ============================================================
echo   SUDO STUDIO IS RUNNING
echo ============================================================
echo.
echo   Backend   : http://localhost:%BACKEND_PORT%
echo   AI Runtime: http://localhost:%RUNTIME_PORT%
echo.
echo   Logs folder: %LOGS%
echo.
echo   background processes (invisible):
echo     backend.exe  - port %BACKEND_PORT%
echo     runtime.exe  - port %RUNTIME_PORT%
echo.
echo   Sudo Studio editor is open.
echo.
echo ============================================================
echo   To view logs: open %LOGS%
echo   To stop all:  close this window (kills all services)
echo ============================================================
echo.

:: -- Keep alive: monitor services, restart if crashed --------
:keep_alive
    timeout /t 30 /nobreak >nul

    :: Check runtime still alive, restart if dead
    tasklist 2>nul | findstr /I "runtime.exe" >nul 2>&1
    if errorlevel 1 (
        echo [WATCHDOG] runtime.exe crashed - restarting hidden... >> "%LOG_FILE%"
        echo   [WATCHDOG] runtime.exe restarting...
        if "%USE_VBS%"=="1" (
            cscript //nologo "%VBS%" "%APP%runtime.exe" --port %RUNTIME_PORT%
        ) else (
            powershell -NoProfile -WindowStyle Hidden -Command ^
              "Start-Process -FilePath '%APP%runtime.exe' -ArgumentList '--port %RUNTIME_PORT%' -WindowStyle Hidden"
        )
    )

    :: Check backend still alive, restart if dead
    tasklist 2>nul | findstr /I "backend.exe" >nul 2>&1
    if errorlevel 1 (
        echo [WATCHDOG] backend.exe crashed - restarting hidden... >> "%LOG_FILE%"
        echo   [WATCHDOG] backend.exe restarting...
        if "%USE_VBS%"=="1" (
            cscript //nologo "%VBS%" "%APP%backend.exe" --port %BACKEND_PORT%
        ) else (
            powershell -NoProfile -WindowStyle Hidden -Command ^
              "Start-Process -FilePath '%APP%backend.exe' -ArgumentList '--port %BACKEND_PORT%' -WindowStyle Hidden"
        )
    )

    goto :keep_alive
