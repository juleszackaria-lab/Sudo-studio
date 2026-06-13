@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  SUDO STUDIO - Main Launcher v2.1
::  Starts backend → runtime → VSCodium in correct order
::  Includes port-polling health checks (no blind timeouts)
:: ============================================================

set "ROOT=%~dp0"
set "APP=%ROOT%app"

echo.
echo  ============================================================
echo   SUDO STUDIO - Starting all services...
echo  ============================================================
echo.
echo  Root    : %ROOT%
echo  App dir : %APP%
echo.

:: ── Verify required files exist ─────────────────────────────
if not exist "%APP%\backend.exe" (
    echo  [ERROR] backend.exe not found in %APP%
    echo  Please re-run the installer.
    pause
    exit /b 1
)

if not exist "%APP%\runtime.exe" (
    echo  [ERROR] runtime.exe not found in %APP%
    echo  Please re-run the installer.
    pause
    exit /b 1
)

if not exist "%APP%\VSCodium.exe" (
    echo  [ERROR] VSCodium.exe not found in %APP%
    echo  Please re-run the installer.
    pause
    exit /b 1
)

if not exist "%APP%\extensions\sudo-ai" (
    echo  [WARNING] Extension folder missing: %APP%\extensions\sudo-ai
    echo  The extension may not load. Continuing...
)

:: ── Create VSCodium data/ folder for portable isolation ──────
:: This prevents VSCodium from writing to %APPDATA%\VSCodium
:: and ensures complete isolation from any other VSCodium install
if not exist "%APP%\data" (
    mkdir "%APP%\data"
    echo  [INFO] Created VSCodium data folder for portable mode.
)

:: ── Step 1: Start backend (port 5000) ────────────────────────
echo  [1/3] Starting Backend (port 5000)...
start "" "%APP%\backend.exe"

:: Poll port 5000 — up to 30 seconds
set BACKEND_READY=0
for /l %%i in (1,1,30) do (
    if !BACKEND_READY!==0 (
        timeout /t 1 /nobreak >nul
        curl -s -o nul -w "%%{http_code}" http://localhost:5000/api/system/health 2>nul | findstr "200 401 403" >nul 2>&1
        if not errorlevel 1 (
            set BACKEND_READY=1
            echo        Backend ready after %%i second(s^).
        )
    )
)
if !BACKEND_READY!==0 (
    echo  [WARNING] Backend did not respond on port 5000 within 30s.
    echo            Continuing anyway - it may still be starting up.
)

:: ── Step 2: Start AI runtime (port 6000) ─────────────────────
echo  [2/3] Starting AI Runtime (port 6000)...
echo        (TinyLlama model will auto-download ~600MB on first run)
start "" "%APP%\runtime.exe"

:: Poll port 6000 — up to 30 seconds
set RUNTIME_READY=0
for /l %%i in (1,1,30) do (
    if !RUNTIME_READY!==0 (
        timeout /t 1 /nobreak >nul
        curl -s -o nul -w "%%{http_code}" http://localhost:6000/health 2>nul | findstr "200" >nul 2>&1
        if not errorlevel 1 (
            set RUNTIME_READY=1
            echo        Runtime ready after %%i second(s^).
        )
    )
)
if !RUNTIME_READY!==0 (
    echo  [WARNING] Runtime did not respond on port 6000 within 30s.
    echo            Continuing - it may still be loading the AI model.
)

:: ── Step 3: Launch VSCodium with bundled extension ───────────
echo  [3/3] Launching VSCodium with Sudo AI extension...
:: --extensions-dir : loads ONLY the bundled sudo-ai extension
:: --user-data-dir  : stores VSCodium settings inside app\data\
::                    (portable mode - no conflict with system VSCodium)
start "" "%APP%\VSCodium.exe" --extensions-dir "%APP%\extensions" --user-data-dir "%APP%\data"
echo        VSCodium launched.

echo.
echo  ============================================================
echo   All services started!
echo   - Backend   : http://localhost:5000
echo   - AI Runtime: http://localhost:6000  (model loading...)
echo   - VSCodium  : Opening now with Sudo AI extension
echo  ============================================================
echo.
echo  The AI model downloads automatically in the background.
echo  Check the "Runtime Status" panel in VSCodium for progress.
echo.
echo  This window will close in 5 seconds.
echo.
timeout /t 5 /nobreak >nul
exit /b 0
