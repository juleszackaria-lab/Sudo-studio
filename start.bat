@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  SUDO STUDIO v6.0 - Windows Launcher
::  Changes in v6.0 (CRITICAL FIX RELEASE):
::   - FIXED: pause removed from all fatal error handlers
::             (script runs hidden — pause caused invisible freeze)
::   - FIXED: 600s blocking runtime poll replaced with fast
::             non-blocking tasklist check (2s timeout only)
::   - FIXED: USE_VBS uses !delayed! expansion throughout
::   - FIXED: UAC elevation preserves working directory reliably
::   - FIXED: VBScript is primary, start /MIN is fallback
::   - ADDED: Granular [STEP] logging at every critical junction
::   - ADDED: tasklist verification after each process launch
:: ============================================================

:: ============================================================
::  STEP 0 — Set working directory FIRST, before anything else
::  This MUST be the absolute first operation.
:: ============================================================
cd /d "%~dp0"
set "ROOT=%~dp0"
set "LOGS=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"

:: Create logs folder early so UAC path can log immediately
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul

:: ============================================================
::  STEP 1 — UAC AUTO-ELEVATION
::  If not admin, relaunch this script elevated WITH explicit
::  WorkingDirectory so the elevated process keeps the right CWD.
:: ============================================================
echo [STEP 1] Checking administrator privileges...
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [STEP 1] Not admin - requesting elevation via UAC...
    echo [STEP 1] UAC elevation requested >> "%LOG_FILE%"
    :: Use cmd /c to wrap the BAT call so CWD is preserved cleanly
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ""%~f0""' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b 0
)

:: ============================================================
::  Now confirmed running as Administrator
::  Re-apply CWD in case elevation changed it
:: ============================================================
cd /d "%~dp0"
set "ROOT=%~dp0"
set "LOGS=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"

title Sudo Studio - Starting...

:: ============================================================
::  STEP 2 — Global Variables
:: ============================================================
set "APP=%ROOT%"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "EXT=%ROOT%extensions\sudo-ai"
set "DATA=%ROOT%data"
set "VBS=%ROOT%launch_hidden.vbs"
set "USE_VBS=0"

:: ============================================================
::  STEP 3 — Init log file
:: ============================================================
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
(
    echo ============================================================
    echo   SUDO STUDIO v6.0 - %DATE% %TIME%
    echo   Root: %ROOT%
    echo   Running as: Administrator
    echo   Log: %LOG_FILE%
    echo ============================================================
) > "%LOG_FILE%"

echo.
echo ============================================================
echo   SUDO STUDIO v6.0
echo ============================================================
echo   Root    : %ROOT%
echo   Logs    : %LOGS%
echo   Ports   : Backend=%BACKEND_PORT%  Runtime=%RUNTIME_PORT%
echo ============================================================
echo.
echo [STEP 3] Log file initialized: %LOG_FILE%
echo [STEP 3] Startup initiated >> "%LOG_FILE%"

:: ============================================================
::  STEP 4 — Verify executables
::  CRITICAL: no pause in fatal handlers (script may run hidden)
::            use timeout /t 5 instead so user CAN see message
::            if they have a visible window, but script continues
:: ============================================================
echo.
echo [STEP 4] Verifying application files...
echo [STEP 4] Checking files... >> "%LOG_FILE%"

:: --- backend.exe ---
if exist "%APP%backend.exe" (
    echo   [OK] backend.exe found
    echo   [OK] backend.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] backend.exe - Expected at: %APP%backend.exe
    echo   [FATAL] backend.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] backend.exe is missing. Please reinstall Sudo Studio.
    echo [FATAL] Path checked: %APP%backend.exe
    timeout /t 10 /nobreak >nul
    exit /b 1
)

:: --- runtime.exe ---
if exist "%APP%runtime.exe" (
    echo   [OK] runtime.exe found
    echo   [OK] runtime.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] runtime.exe - Expected at: %APP%runtime.exe
    echo   [FATAL] runtime.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] runtime.exe is missing. Please reinstall Sudo Studio.
    echo [FATAL] Path checked: %APP%runtime.exe
    timeout /t 10 /nobreak >nul
    exit /b 1
)

:: --- VSCodium.exe ---
if exist "%APP%VSCodium.exe" (
    echo   [OK] VSCodium.exe (Sudo Studio editor) found
    echo   [OK] VSCodium.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] VSCodium.exe - Expected at: %APP%VSCodium.exe
    echo   [FATAL] VSCodium.exe missing >> "%LOG_FILE%"
    echo.
    echo [FATAL] VSCodium.exe is missing. Please reinstall Sudo Studio.
    timeout /t 10 /nobreak >nul
    exit /b 1
)

:: --- VBScript launcher ---
if exist "%VBS%" (
    echo   [OK] launch_hidden.vbs found - will use VBScript (SW_HIDE)
    echo   [OK] launch_hidden.vbs >> "%LOG_FILE%"
    set "USE_VBS=1"
) else (
    echo   [WARN] launch_hidden.vbs not found - using start /MIN fallback
    echo   [WARN] launch_hidden.vbs missing - using start /MIN >> "%LOG_FILE%"
    set "USE_VBS=0"
)

echo   [INFO] USE_VBS=!USE_VBS!
echo   [INFO] USE_VBS=!USE_VBS! >> "%LOG_FILE%"

:: --- Extension ---
if exist "%EXT%\extension.js" (
    echo   [OK] Sudo AI extension found
    echo   [OK] Extension >> "%LOG_FILE%"
) else (
    echo   [WARN] Sudo AI extension not found - AI features disabled
    echo   [WARN] Extension missing >> "%LOG_FILE%"
)

echo.
echo [STEP 4] File verification complete.
echo [STEP 4] Files OK >> "%LOG_FILE%"
echo.

:: ============================================================
::  STEP 5 — Kill any stale processes on our ports
:: ============================================================
echo [STEP 5] Clearing stale processes on ports %RUNTIME_PORT% and %BACKEND_PORT%...
echo [STEP 5] Clearing stale processes >> "%LOG_FILE%"

for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%RUNTIME_PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Kill stale runtime/backend processes
taskkill /F /IM runtime.exe >nul 2>&1
taskkill /F /IM backend.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo   [OK] Stale process cleanup done.
echo [STEP 5] Stale cleanup done >> "%LOG_FILE%"
echo.

:: ============================================================
::  STEP 6 — Launch runtime.exe HIDDEN
::  Primary:  VBScript SW_HIDE (truly invisible, no taskbar)
::  Fallback: start /MIN (minimized CMD window — still works)
:: ============================================================
echo [STEP 6] Launching AI Runtime (port %RUNTIME_PORT%)...
echo [STEP 6] Launching runtime.exe >> "%LOG_FILE%"

if "!USE_VBS!"=="1" (
    echo   [METHOD] VBScript SW_HIDE
    echo   [METHOD] VBScript >> "%LOG_FILE%"
    cscript //nologo "%VBS%" "%APP%runtime.exe" --port %RUNTIME_PORT%
    echo   [LAUNCHED] runtime.exe via VBScript
    echo [STEP 6] runtime.exe launched via VBScript >> "%LOG_FILE%"
) else (
    echo   [METHOD] start /MIN fallback
    echo   [METHOD] start /MIN >> "%LOG_FILE%"
    start "Sudo Runtime" /MIN "%APP%runtime.exe" --port %RUNTIME_PORT%
    echo   [LAUNCHED] runtime.exe via start /MIN
    echo [STEP 6] runtime.exe launched via start /MIN >> "%LOG_FILE%"
)

:: Wait 2 seconds then verify process is actually running
timeout /t 2 /nobreak >nul

echo [STEP 6] Verifying runtime.exe started...
echo [STEP 6] Verifying runtime.exe... >> "%LOG_FILE%"

tasklist /FI "IMAGENAME eq runtime.exe" 2>nul | find /I "runtime.exe" >nul
if %errorlevel% equ 0 (
    echo   [OK] runtime.exe IS running in background
    echo   [OK] runtime.exe confirmed running >> "%LOG_FILE%"
) else (
    echo   [WARN] runtime.exe not found in tasklist yet - may still be starting
    echo   [WARN] runtime.exe not in tasklist (may still be starting) >> "%LOG_FILE%"
    :: Give it 3 more seconds
    timeout /t 3 /nobreak >nul
    tasklist /FI "IMAGENAME eq runtime.exe" 2>nul | find /I "runtime.exe" >nul
    if %errorlevel% equ 0 (
        echo   [OK] runtime.exe now running (delayed start)
        echo   [OK] runtime.exe running after delay >> "%LOG_FILE%"
    ) else (
        echo   [ERROR] runtime.exe STILL not running - AI chat may not work
        echo   [ERROR] runtime.exe failed to start >> "%LOG_FILE%"
    )
)
echo.

:: ============================================================
::  STEP 7 — Launch backend.exe HIDDEN
::  Same VBScript/fallback logic as runtime
:: ============================================================
echo [STEP 7] Launching Backend (port %BACKEND_PORT%)...
echo [STEP 7] Launching backend.exe >> "%LOG_FILE%"

if "!USE_VBS!"=="1" (
    echo   [METHOD] VBScript SW_HIDE
    cscript //nologo "%VBS%" "%APP%backend.exe" --port %BACKEND_PORT%
    echo   [LAUNCHED] backend.exe via VBScript
    echo [STEP 7] backend.exe launched via VBScript >> "%LOG_FILE%"
) else (
    echo   [METHOD] start /MIN fallback
    start "Sudo Backend" /MIN "%APP%backend.exe" --port %BACKEND_PORT%
    echo   [LAUNCHED] backend.exe via start /MIN
    echo [STEP 7] backend.exe launched via start /MIN >> "%LOG_FILE%"
)

:: Wait 2 seconds then verify
timeout /t 2 /nobreak >nul

echo [STEP 7] Verifying backend.exe started...
echo [STEP 7] Verifying backend.exe... >> "%LOG_FILE%"

tasklist /FI "IMAGENAME eq backend.exe" 2>nul | find /I "backend.exe" >nul
if %errorlevel% equ 0 (
    echo   [OK] backend.exe IS running in background
    echo   [OK] backend.exe confirmed running >> "%LOG_FILE%"
) else (
    echo   [WARN] backend.exe not found in tasklist - may still be starting
    echo   [WARN] backend.exe not in tasklist >> "%LOG_FILE%"
    timeout /t 3 /nobreak >nul
    tasklist /FI "IMAGENAME eq backend.exe" 2>nul | find /I "backend.exe" >nul
    if %errorlevel% equ 0 (
        echo   [OK] backend.exe now running (delayed start)
        echo   [OK] backend.exe running after delay >> "%LOG_FILE%"
    ) else (
        echo   [ERROR] backend.exe STILL not running - backend API may not work
        echo   [ERROR] backend.exe failed to start >> "%LOG_FILE%"
    )
)
echo.

:: ============================================================
::  STEP 8 — Wait for AI Runtime to be READY (non-blocking)
::  Max 30 attempts × 3s = 90s total
::  If not ready, continue anyway (model loads in background)
::  NOTE: This replaces the old 600s blocking poll.
::        We proceed after 90s regardless.
:: ============================================================
echo [STEP 8] Waiting for AI Runtime health check (max 90s)...
echo [STEP 8] Runtime health check >> "%LOG_FILE%"

set "RUNTIME_READY=0"
set "RUNTIME_WAIT=0"

:wait_runtime
    set /a RUNTIME_WAIT+=1
    if !RUNTIME_WAIT! gtr 30 goto :runtime_timeout
    timeout /t 3 /nobreak >nul

    :: Primary check: curl
    curl -s --connect-timeout 2 -o nul -w "%%{http_code}" http://localhost:%RUNTIME_PORT%/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "RUNTIME_READY=1"
        goto :runtime_ok
    )

    :: Print progress every 15s
    set /a RUNTIME_ELAPSED=RUNTIME_WAIT*3
    set /a RUNTIME_MOD=RUNTIME_ELAPSED %% 15
    if !RUNTIME_MOD! equ 0 (
        echo   [AI Loading] !RUNTIME_ELAPSED!s elapsed - TinyLlama still loading...
        echo   [AI Loading] !RUNTIME_ELAPSED!s >> "%LOG_FILE%"
    )
    goto :wait_runtime

:runtime_timeout
    echo.
    echo   [INFO] Runtime not ready after 90s - continuing anyway.
    echo   [INFO] TinyLlama model loads in background (takes 2-5 min first time).
    echo   [INFO] Chat will work once the model finishes loading.
    echo   [INFO] Runtime not ready after 90s - will continue loading in background >> "%LOG_FILE%"
    goto :runtime_done

:runtime_ok
    set /a RUNTIME_ELAPSED_OK=RUNTIME_WAIT*3
    echo.
    echo   [OK] AI Runtime READY on port %RUNTIME_PORT% (!RUNTIME_ELAPSED_OK!s)
    echo   [OK] Runtime ready after !RUNTIME_ELAPSED_OK!s >> "%LOG_FILE%"

:runtime_done
echo.

:: ============================================================
::  STEP 9 — Wait for Backend (max 30s)
:: ============================================================
echo [STEP 9] Waiting for Backend health check (max 30s)...
echo [STEP 9] Backend health check >> "%LOG_FILE%"

set "BACKEND_READY=0"
set "BACKEND_WAIT=0"

:wait_backend
    set /a BACKEND_WAIT+=1
    if !BACKEND_WAIT! gtr 15 goto :backend_timeout
    timeout /t 2 /nobreak >nul

    curl -s --connect-timeout 2 -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    echo   [Backend] Waiting... !BACKEND_WAIT!/15
    goto :wait_backend

:backend_timeout
    echo.
    echo   [WARN] Backend did not respond in 30s. Continuing anyway.
    echo   [WARN] Check logs: %ROOT%logs\backend.log
    echo   [WARN] Backend timeout after 30s >> "%LOG_FILE%"
    goto :backend_done

:backend_ok
    echo.
    echo   [OK] Backend READY on port %BACKEND_PORT%
    echo   [OK] Backend ready >> "%LOG_FILE%"

:backend_done
echo.

:: ============================================================
::  STEP 10 — Launch Sudo Studio (VSCodium)
:: ============================================================
echo [STEP 10] Opening Sudo Studio (VSCodium)...
echo [STEP 10] Launching Sudo Studio >> "%LOG_FILE%"

set "V_EXE=%ROOT%VSCodium.exe"
set "V_EXT=%ROOT%extensions"
set "V_DAT=%ROOT%data"
set "V_DEV=%ROOT%extensions\sudo-ai"

if not exist "%V_DAT%" mkdir "%V_DAT%" 2>nul
if not exist "%V_EXT%" mkdir "%V_EXT%" 2>nul

:: Write clean launcher script (avoids any quoting issues in start command)
set "LAUNCHER=%ROOT%launch.bat"
(
    echo @echo off
    echo start "" "%V_EXE%" --extensions-dir "%V_EXT%" --user-data-dir "%V_DAT%" --extensionDevelopmentPath "%V_DEV%"
) > "%LAUNCHER%"

call "%LAUNCHER%"
echo   [LAUNCHED] Sudo Studio
echo [STEP 10] VSCodium launched >> "%LOG_FILE%"

:: Verify after 5s
timeout /t 5 /nobreak >nul
tasklist 2>nul | findstr /I "VSCodium" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Sudo Studio (VSCodium) is running
    echo [STEP 10] VSCodium confirmed running >> "%LOG_FILE%"
) else (
    echo   [WARN] Sudo Studio may still be starting (first launch can be slow)
    echo [STEP 10] VSCodium not yet detected - may still be starting >> "%LOG_FILE%"
)
echo.

:: ============================================================
::  STEP 11 — Extension check
:: ============================================================
echo [STEP 11] Extension check:
if exist "%EXT%\extension.js"  (echo   [OK] extension.js) else (echo   [WARN] extension.js missing)
if exist "%EXT%\package.json"  (echo   [OK] package.json) else (echo   [WARN] package.json missing)
if exist "%EXT%\src"           (echo   [OK] src\ directory) else (echo   [WARN] src\ missing)
echo.

:: ============================================================
::  STARTUP COMPLETE
:: ============================================================
echo %DATE% %TIME% - ALL SERVICES STARTED >> "%LOG_FILE%"
echo.
echo ============================================================
echo   SUDO STUDIO IS RUNNING
echo ============================================================
echo.
echo   Backend   : http://localhost:%BACKEND_PORT%  [!BACKEND_READY!]
echo   AI Runtime: http://localhost:%RUNTIME_PORT%  [!RUNTIME_READY!]
echo.
echo   Logs folder: %LOGS%
echo.
echo   Background processes (invisible):
echo     backend.exe  - port %BACKEND_PORT%
echo     runtime.exe  - port %RUNTIME_PORT%
echo.
echo   Sudo Studio editor is open.
echo   This window stays open as the watchdog monitor.
echo.
echo ============================================================
echo   To view logs: open %LOGS%
echo   To stop all : close this window
echo ============================================================
echo.
echo [WATCHDOG] Monitoring services every 30s. DO NOT CLOSE THIS WINDOW.
echo [WATCHDOG] Starting watchdog loop >> "%LOG_FILE%"

:: ============================================================
::  WATCHDOG LOOP — Monitor and restart crashed services
::  Uses !delayed expansion! throughout (FIXED from v5.0)
:: ============================================================
:keep_alive
    timeout /t 30 /nobreak >nul

    :: Check runtime still alive
    tasklist 2>nul | findstr /I "runtime.exe" >nul 2>&1
    if errorlevel 1 (
        echo [WATCHDOG] %TIME% - runtime.exe crashed - restarting...
        echo [WATCHDOG] runtime.exe crashed - restarting >> "%LOG_FILE%"
        if "!USE_VBS!"=="1" (
            cscript //nologo "%VBS%" "%APP%runtime.exe" --port %RUNTIME_PORT%
        ) else (
            start "Sudo Runtime" /MIN "%APP%runtime.exe" --port %RUNTIME_PORT%
        )
        echo [WATCHDOG] runtime.exe restarted
    )

    :: Check backend still alive
    tasklist 2>nul | findstr /I "backend.exe" >nul 2>&1
    if errorlevel 1 (
        echo [WATCHDOG] %TIME% - backend.exe crashed - restarting...
        echo [WATCHDOG] backend.exe crashed - restarting >> "%LOG_FILE%"
        if "!USE_VBS!"=="1" (
            cscript //nologo "%VBS%" "%APP%backend.exe" --port %BACKEND_PORT%
        ) else (
            start "Sudo Backend" /MIN "%APP%backend.exe" --port %BACKEND_PORT%
        )
        echo [WATCHDOG] backend.exe restarted
    )

    goto :keep_alive
