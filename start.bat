@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Demarrage

echo.
echo ============================================================
echo   SUDO STUDIO v2.1 - Demarrage automatique
echo ============================================================
echo.

:: ─── Variables ──────────────────────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%backend"
set "RUNTIME_DIR=%SCRIPT_DIR%backend\runtime"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"

:: ─── Etape 1: Verification Python ───────────────────────────────────────────
echo [1/6] Verification Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo     Python non trouve - installation automatique via winget...
    winget install Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo     [ERREUR] Impossible d'installer Python automatiquement.
        echo     Veuillez installer Python 3.11+ depuis https://python.org
        echo     Puis relancer start.bat
        pause
        exit /b 1
    )
    :: Refresh PATH after install
    call refreshenv >nul 2>&1
    python --version >nul 2>&1
    if errorlevel 1 (
        echo     [AVERTISSEMENT] Python installe mais non accessible.
        echo     Redemarrez le terminal et relancez start.bat
        pause
        exit /b 1
    )
    echo     Python installe avec succes!
) else (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo     %%v detecte OK
)

:: ─── Etape 2: Verification Node.js ──────────────────────────────────────────
echo [2/6] Verification Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo     Node.js non trouve - installation automatique...
    winget install OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo     [ERREUR] Impossible d'installer Node.js.
        echo     Veuillez installer Node.js 18+ depuis https://nodejs.org
        pause
        exit /b 1
    )
    call refreshenv >nul 2>&1
    echo     Node.js installe!
) else (
    for /f "tokens=*" %%v in ('node --version 2^>^&1') do echo     Node.js %%v detecte OK
)

:: ─── Etape 3: Installation dependances Python IA ────────────────────────────
echo [3/6] Installation des dependances Python IA...
echo     (torch CPU ~180MB, transformers, flask, accelerate...)
pip install -q -r "%RUNTIME_DIR%\requirements.txt" --no-warn-script-location
if errorlevel 1 (
    echo     [AVERTISSEMENT] Certaines dependances Python ont echoue.
    echo     Tentative d'installation individuelle...
    pip install -q flask flask-cors psutil requests accelerate sentencepiece
    pip install -q torch --index-url https://download.pytorch.org/whl/cpu
    pip install -q transformers
)
echo     Dependances Python OK

:: ─── Etape 4: Installation dependances Node.js ──────────────────────────────
echo [4/6] Installation des dependances Node.js...
if not exist "%BACKEND_DIR%\node_modules" (
    echo     Installation npm...
    cd /d "%BACKEND_DIR%" && npm install --no-audit --no-fund -q
    cd /d "%SCRIPT_DIR%"
) else (
    echo     node_modules deja presents
)

:: ─── Etape 5: Demarrage Backend Node.js (port 5000) ─────────────────────────
echo [5/6] Demarrage du backend Node.js (port %BACKEND_PORT%)...
start /B "Sudo-Backend" cmd /c "cd /d "%BACKEND_DIR%" && node server.js > "%SCRIPT_DIR%logs\backend.log" 2>&1"

:: Poll port 5000 — up to 30 seconds
echo     Attente du backend...
set BACKEND_READY=0
for /l %%i in (1,1,30) do (
    if !BACKEND_READY!==0 goto :backend_done
    timeout /t 1 /nobreak >nul
    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr "200 401 403" >nul 2>&1
    if not errorlevel 1 (
        set BACKEND_READY=1
    )
)
:backend_done
if !BACKEND_READY!==1 (
    echo     Backend OK - port %BACKEND_PORT% repond
) else (
    echo     [AVERTISSEMENT] Backend lent a demarrer (continue...)
)

:: ─── Etape 6: Demarrage Runtime Python IA (port 6000) ───────────────────────
echo [6/6] Demarrage du runtime Python IA (port %RUNTIME_PORT%)...
start /B "Sudo-Runtime" cmd /c "cd /d "%RUNTIME_DIR%" && python server.enterprise.py --port %RUNTIME_PORT% > "%SCRIPT_DIR%logs\runtime.log" 2>&1"

:: Poll port 6000 — up to 60 seconds (model loading takes time)
echo     Attente du runtime IA...
set RUNTIME_READY=0
for /l %%i in (1,1,60) do (
    if !RUNTIME_READY!==0 goto :runtime_check_done
    timeout /t 1 /nobreak >nul
    curl -s -o nul -w "%%{http_code}" http://localhost:%RUNTIME_PORT%/health 2>nul | findstr "200" >nul 2>&1
    if not errorlevel 1 (
        set RUNTIME_READY=1
    )
)
:runtime_check_done
if !RUNTIME_READY!==1 (
    echo     Runtime IA OK - port %RUNTIME_PORT% repond
) else (
    echo     [AVERTISSEMENT] Runtime IA lent a demarrer (telechargement modele en cours...)
)

:: ─── Resume ─────────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   SUDO STUDIO DEMARRE
echo ============================================================
echo   Backend Node.js  : http://localhost:%BACKEND_PORT%
echo   Runtime Python IA: http://localhost:%RUNTIME_PORT%
echo   Logs backend     : logs\backend.log
echo   Logs runtime     : logs\runtime.log
echo ============================================================
echo.
echo Ouvrez VSCodium pour utiliser Sudo Studio.
echo Appuyez sur Ctrl+C pour arreter tous les services.
echo.
pause
