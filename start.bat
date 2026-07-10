@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Starting

:: ============================================================
::   SUDO STUDIO v3.0 -- Windows Launcher
::   backend.exe and runtime.exe include Node.js/Python.
::   No system dependencies required.
:: ============================================================

:: -- Global variables ----------------------------------------
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "LOGS=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "EXT=%APP%\extensions\sudo-ai"
set "DATA=%APP%\data"
set "START_TIME=%TIME%"
set "START_DATE=%DATE%"

:: -- Create logs folder if missing ---------------------------
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
if not exist "%LOGS%" (
    echo [ERROR] Cannot create logs folder.
    echo         Check permissions: %ROOT%
    pause
    exit /b 1
)

:: -- Init log file -------------------------------------------
(
echo ============================================================
echo   SUDO STUDIO v3.0 - Started: %START_DATE% %START_TIME%
echo   Root: %ROOT%
echo   App : %APP%
echo ============================================================
) > "%LOG_FILE%"

echo.
echo ============================================================
echo   SUDO STUDIO v3.0 - Starting...
echo ============================================================
echo.

:: ============================================================
::  SUBROUTINES -- defined here so :LOG and :check_port are callable from :main
:: ============================================================
goto :main

:: -- Subroutine: write to log --------------------------------
:LOG
    echo %~1 >> "%LOG_FILE%" 2>nul
    exit /b 0

:: -- Subroutine: HTTP health check --------------------------
:: Usage: call :check_port <port> <path> <result_var>
:: Sets result_var=1 if HTTP 200, else 0
:check_port
    set "%~3=0"
    curl --version >nul 2>&1
    if !errorlevel! equ 0 (
        curl -s -o nul -w "%%{http_code}" http://localhost:%~1%~2 2>nul | findstr /B "200" >nul 2>&1
        if !errorlevel! equ 0 set "%~3=1"
    ) else (
        powershell -NoProfile -Command "try{$r=(Invoke-WebRequest -Uri 'http://localhost:%~1%~2' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop);if($r.StatusCode -eq 200){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
        if !errorlevel! equ 0 set "%~3=1"
    )
    exit /b 0

:: ============================================================
:main
:: ============================================================
::  PHASE 1 -- FILE VERIFICATION (< 5 seconds)
:: ============================================================
call :LOG "[PHASE 1] Verifying required files..."
echo [1/4] Verifying application files...

:: Check backend.exe
if not exist "%APP%\backend.exe" (
    call :LOG "[PHASE 1] ERROR: backend.exe not found"
    echo.
    echo   [ERROR] backend.exe not found
    echo           Expected: %APP%\backend.exe
    echo           Please reinstall SudoStudio.
    echo.
    pause
    exit /b 1
)

:: Check runtime.exe
if not exist "%APP%\runtime.exe" (
    call :LOG "[PHASE 1] ERROR: runtime.exe not found"
    echo.
    echo   [ERROR] runtime.exe not found
    echo           Expected: %APP%\runtime.exe
    echo           Please reinstall SudoStudio.
    echo.
    pause
    exit /b 1
)

:: Check VSCodium.exe
if not exist "%APP%\VSCodium.exe" (
    call :LOG "[PHASE 1] ERROR: VSCodium.exe not found"
    echo.
    echo   [ERROR] VSCodium.exe not found
    echo           Expected: %APP%\VSCodium.exe
    echo           Please reinstall SudoStudio.
    echo.
    pause
    exit /b 1
)

:: Check Sudo AI extension (warning only — not fatal)
if not exist "%EXT%\extension.js" (
    call :LOG "[PHASE 1] WARNING: Sudo AI extension not found at %EXT%"
    echo.
    echo   [WARNING] Sudo AI extension not found.
    echo             VSCodium will open without Sudo AI features.
    echo.
)

call :LOG "[PHASE 1] All required files verified OK"
echo [1/4] Files OK

:: ============================================================
::  PHASE 2 -- AI RUNTIME (port 6000)
::  runtime.exe embeds Python + AI model loader
::  First run downloads AI model (~600 MB) -- up to 5 minutes
:: ============================================================
echo.
echo [2/4] Starting AI Runtime (port %RUNTIME_PORT%)...
echo        First run downloads AI model (~600MB, may take minutes)
call :LOG "[PHASE 2] Launching runtime.exe on port %RUNTIME_PORT%"

start "SudoRuntime" /B cmd /c ^""%APP%\runtime.exe" >> "%LOGS%\runtime.log" 2^>&1^"
call :LOG "[PHASE 2] runtime.exe launched"

:: -- Poll port 6000 -- timeout 300s (first run downloads model) --
set "RUNTIME_READY=0"
set "WAIT_COUNT=0"
set "LAST_MSG=0"
:wait_runtime
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! gtr 150 goto :runtime_done
    timeout /t 2 /nobreak >nul
    call :check_port %RUNTIME_PORT% /health RUNTIME_HIT
    if "!RUNTIME_HIT!"=="1" (
        set "RUNTIME_READY=1"
        goto :runtime_done
    )
    :: Print status every 15 seconds (every 7-8 polls of 2s)
    set /a ELAPSED=WAIT_COUNT*2
    set /a MSG_SLOT=ELAPSED/15
    if !MSG_SLOT! gtr !LAST_MSG! (
        set "LAST_MSG=!MSG_SLOT!"
        echo        Still loading AI model... (!ELAPSED!s elapsed)
    )
    goto :wait_runtime
:runtime_done

if "!RUNTIME_READY!"=="1" (
    call :LOG "[PHASE 2] AI Runtime ready on port %RUNTIME_PORT%"
    echo [2/4] AI Runtime ready on port %RUNTIME_PORT%
) else (
    call :LOG "[PHASE 2] WARNING: Runtime not responding after 300s -- continuing"
    echo.
    echo   [WARNING] AI Runtime not responding after 5 minutes.
    echo             AI features may be limited. Continuing anyway...
    echo             Check: %LOGS%\runtime.log
    echo.
)

:: ============================================================
::  PHASE 3 -- BACKEND (port 5000)
::  backend.exe embeds Node.js (compiled with pkg node18-win-x64)
::  NO system Node.js required
:: ============================================================
echo.
echo [3/4] Starting Backend (port %BACKEND_PORT%)...
call :LOG "[PHASE 3] Launching backend.exe on port %BACKEND_PORT%"

start "SudoBackend" /B cmd /c ^""%APP%\backend.exe" >> "%LOGS%\backend.log" 2^>&1^"
call :LOG "[PHASE 3] backend.exe launched"

:: -- Poll port 5000 -- timeout 60 seconds -------------------
set "BACKEND_READY=0"
set "WAIT_COUNT=0"
:wait_backend
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! gtr 60 goto :backend_done
    timeout /t 1 /nobreak >nul
    call :check_port %BACKEND_PORT% /api/system/health BACKEND_HIT
    if "!BACKEND_HIT!"=="1" (
        set "BACKEND_READY=1"
        goto :backend_done
    )
    goto :wait_backend
:backend_done

if "!BACKEND_READY!"=="1" (
    call :LOG "[PHASE 3] Backend ready on port %BACKEND_PORT%"
    echo [3/4] Backend ready on port %BACKEND_PORT%
) else (
    call :LOG "[PHASE 3] ERROR: Backend not responding after 60s"
    echo.
    echo   [ERROR] Backend not responding after 60 seconds.
    echo.
    echo   Check log: %LOGS%\backend.log
    if exist "%LOGS%\backend.log" (
        echo   Last lines:
        powershell -NoProfile -Command "Get-Content '%LOGS%\backend.log' -Tail 8 -ErrorAction SilentlyContinue" 2>nul
        echo.
    )
    echo   Solutions:
    echo     1. Check that port %BACKEND_PORT% is not already in use
    echo     2. Relaunch start.bat
    echo.
    pause
    exit /b 1
)

:: ============================================================
::  PHASE 4 -- VSCODIUM + SUDO AI EXTENSION
:: ============================================================
echo.
echo [4/4] Opening Sudo Studio in VSCodium...
call :LOG "[PHASE 4] Launching VSCodium"

:: Create data dirs if missing
if not exist "%DATA%" mkdir "%DATA%" 2>nul
if not exist "%APP%\extensions" mkdir "%APP%\extensions" 2>nul

set "VSCO_EXE=%APP%\VSCodium.exe"
set "VSCO_EXT_DIR=%APP%\extensions"
set "VSCO_USER_DIR=%DATA%"
set "VSCO_EXT_SRC=%EXT%"
call :LOG "[PHASE 4] EXE     : !VSCO_EXE!"
call :LOG "[PHASE 4] Ext-dir : !VSCO_EXT_DIR!"
call :LOG "[PHASE 4] Data-dir: !VSCO_USER_DIR!"
call :LOG "[PHASE 4] Ext-src : !VSCO_EXT_SRC!"

start "SudoStudio" "!VSCO_EXE!" --extensions-dir "!VSCO_EXT_DIR!" --user-data-dir "!VSCO_USER_DIR!" --extensionDevelopmentPath "!VSCO_EXT_SRC!"

echo [4/4] VSCodium launched with Sudo AI
call :LOG "[PHASE 4] VSCodium launched OK"

:: ============================================================
::  ALL SERVICES RUNNING
:: ============================================================
call :LOG "[OK] Sudo Studio v3.0 started successfully - %TIME%"
echo.
echo ============================================================
echo   SUDO STUDIO IS RUNNING
echo ============================================================
echo.
echo   Backend   : http://localhost:%BACKEND_PORT%
echo   AI Runtime: http://localhost:%RUNTIME_PORT%
echo.
echo   Logs      : %LOGS%\startup.log
echo   Backend   : %LOGS%\backend.log
echo   Runtime   : %LOGS%\runtime.log
echo.
echo ============================================================
echo.
echo   Keep this window open to maintain services.
echo   Close this window to stop everything.
echo.
echo %date% %time% - ALL SERVICES STARTED >> "%LOG_FILE%"

:: -- Keep terminal open (services stay alive as children) ----
:keep_alive
timeout /t 30 /nobreak >nul
goto :keep_alive
