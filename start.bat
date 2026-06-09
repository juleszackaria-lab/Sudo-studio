@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  SUDO STUDIO - Main Launcher
::  Starts backend → runtime → VSCodium in correct order
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

:: ── Step 1: Start backend (port 5000) ───────────────────────
echo  [1/3] Starting Backend (port 5000)...
start "" "%APP%\backend.exe"
timeout /t 3 /nobreak >nul
echo       Backend started.

:: ── Step 2: Start AI runtime (port 6000) ────────────────────
echo  [2/3] Starting AI Runtime (port 6000)...
echo        (TinyLlama model will auto-download ~600MB on first run)
start "" "%APP%\runtime.exe"
timeout /t 4 /nobreak >nul
echo       Runtime started.

:: ── Step 3: Launch VSCodium with bundled extension ──────────
echo  [3/3] Launching VSCodium with Sudo AI extension...
start "" "%APP%\VSCodium.exe" --extensions-dir "%APP%\extensions"
echo       VSCodium launched.

echo.
echo  ============================================================
echo   All services started successfully!
echo   - Backend  : http://localhost:5000
echo   - AI Runtime: http://localhost:6000 (model loading...)
echo   - VSCodium : Opening now with Sudo AI extension
echo  ============================================================
echo.
echo  The AI model downloads automatically in the background.
echo  Check the "Runtime Status" bar in VSCodium for progress.
echo.

:: Keep window open briefly then close
timeout /t 5 /nobreak >nul
exit /b 0
