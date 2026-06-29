@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Demarrage

:: ============================================================
::   SUDO STUDIO v2.1 — Lanceur automatique Windows
::   Ce fichier est le SEUL point d'entree.
::   Ne rien modifier dans backend/, runtime/, extension/
:: ============================================================

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "RUNTIME_DIR=%ROOT%backend\runtime"
set "LOGS_DIR=%ROOT%logs"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "NODE_MIN_VER=18"

:: Creer le dossier logs si absent
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"

echo.
echo ============================================================
echo   SUDO STUDIO v2.1 — Demarrage automatique
echo ============================================================
echo.

:: ────────────────────────────────────────────────────────────
::  PHASE 1 — NODE.JS
:: ────────────────────────────────────────────────────────────
echo [1/4] Verification Node.js...

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo       Node.js absent — installation en cours...
    echo.

    :: Tentative 1 : winget (disponible Windows 10 1709+ et Windows 11)
    winget --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       [1/4] Tentative via winget...
        winget install OpenJS.NodeJS.LTS ^
            --silent ^
            --accept-package-agreements ^
            --accept-source-agreements
    ) else (
        echo       winget absent — passage au fallback PowerShell...
    )

    :: Tentative 2 : PowerShell Invoke-WebRequest (fallback universel)
    node --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo       [1/4] Telechargement Node.js via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
            "$ErrorActionPreference='Stop';" ^
            "try {" ^
            "  $url='https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi';" ^
            "  $out=[System.IO.Path]::Combine($env:TEMP,'nodejs_setup.msi');" ^
            "  Write-Host '      Telechargement en cours (~30 MB)...';" ^
            "  (New-Object System.Net.WebClient).DownloadFile($url,$out);" ^
            "  Write-Host '      Installation silencieuse...';" ^
            "  Start-Process msiexec.exe -ArgumentList '/i',$out,'/quiet','/norestart','ADDLOCAL=ALL' -Wait -NoNewWindow;" ^
            "  Write-Host '      Node.js installe.';" ^
            "} catch { Write-Host ('ERREUR: '+$_.Exception.Message); exit 1 }"
        if %errorlevel% neq 0 (
            echo.
            echo   *** ERREUR : Impossible d'installer Node.js ***
            echo.
            echo   Solutions :
            echo     1. Installer manuellement : https://nodejs.org
            echo     2. Redemarrer ce PC puis relancer start.bat
            echo.
            pause
            exit /b 1
        )
    )

    :: Rafraichir PATH dans la session courante sans redemarrage
    ::   Node.js s'installe dans %ProgramFiles%\nodejs
    ::   npm global s'installe dans %APPDATA%\npm
    for /f "tokens=2*" %%A in (
        'reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul'
    ) do set "SYS_PATH=%%B"
    for /f "tokens=2*" %%A in (
        'reg query "HKCU\Environment" /v Path 2^>nul'
    ) do set "USR_PATH=%%B"
    set "PATH=%SYS_PATH%;%USR_PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"

    :: Verification finale
    node --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo   *** ERREUR : Node.js installe mais toujours introuvable ***
        echo.
        echo   Le PATH a ete mis a jour mais le shell doit etre reouvert.
        echo   Fermez ce terminal, puis relancez start.bat.
        echo.
        pause
        exit /b 1
    )
    echo       Node.js installe avec succes.
)

for /f "tokens=*" %%v in ('node --version 2^>^&1') do set "NODE_VER=%%v"
echo [1/4] Node.js %NODE_VER% OK

:: ────────────────────────────────────────────────────────────
::  PHASE 2 — RUNTIME IA (runtime.exe ou server.enterprise.py)
:: ────────────────────────────────────────────────────────────
echo.
echo [2/4] Demarrage Runtime IA (port %RUNTIME_PORT%)...

:: Verifier si runtime.exe existe a la racine du projet
if exist "%ROOT%runtime.exe" (
    echo       Lancement runtime.exe...
    start "" /B "%ROOT%runtime.exe"
) else if exist "%RUNTIME_DIR%\server.enterprise.py" (
    :: Fallback : lancer directement le script Python
    echo       runtime.exe absent — lancement via Python...
    python --version >nul 2>&1
    if %errorlevel% neq 0 (
        python3 --version >nul 2>&1
        if %errorlevel% neq 0 (
            echo.
            echo   *** ERREUR : runtime.exe absent et Python introuvable ***
            echo   Placer runtime.exe a la racine du projet.
            echo.
            pause
            exit /b 1
        )
        set "PYTHON_CMD=python3"
    ) else (
        set "PYTHON_CMD=python"
    )
    start "" /B cmd /c "cd /d "%RUNTIME_DIR%" && !PYTHON_CMD! server.enterprise.py --port %RUNTIME_PORT% >> "%LOGS_DIR%\runtime.log" 2>&1"
) else (
    echo.
    echo   *** ERREUR : ni runtime.exe ni server.enterprise.py trouve ***
    echo   Structure attendue :
    echo     %ROOT%runtime.exe          (binaire autonome)
    echo     OU
    echo     %RUNTIME_DIR%\server.enterprise.py
    echo.
    pause
    exit /b 1
)

:: Poll port 6000 — timeout 90 secondes
echo       Attente du Runtime IA...
set "RUNTIME_READY=0"
set "WAIT_COUNT=0"
:wait_runtime
    set /a WAIT_COUNT+=1
    if %WAIT_COUNT% gtr 90 goto runtime_timeout
    timeout /t 2 /nobreak >nul
    curl -s -o nul -w "%%{http_code}" http://localhost:%RUNTIME_PORT%/health 2>nul | findstr /B "200" >nul 2>&1
    if %errorlevel% neq 0 goto wait_runtime
    set "RUNTIME_READY=1"
goto runtime_timeout
:runtime_timeout

if "%RUNTIME_READY%"=="1" (
    echo [2/4] Runtime IA pret sur port %RUNTIME_PORT%
) else (
    echo [2/4] Runtime IA : demarrage lent (modele en cours de chargement)
    echo       Le chat IA sera disponible dans quelques instants.
)

:: ────────────────────────────────────────────────────────────
::  PHASE 3 — BACKEND NODE.JS
:: ────────────────────────────────────────────────────────────
echo.
echo [3/4] Demarrage Backend Node.js (port %BACKEND_PORT%)...

:: Installer les dependances si node_modules absent
if not exist "%BACKEND_DIR%\node_modules" (
    echo       Installation des dependances npm...
    cd /d "%BACKEND_DIR%"
    npm install --no-audit --no-fund --silent
    if %errorlevel% neq 0 (
        echo.
        echo   *** ERREUR : npm install a echoue ***
        echo   Verifiez votre connexion Internet et relancez.
        echo.
        pause
        exit /b 1
    )
    cd /d "%ROOT%"
    echo       Dependances npm installees.
)

:: Verifier que package.json existe bien
if not exist "%BACKEND_DIR%\server.js" (
    echo.
    echo   *** ERREUR : %BACKEND_DIR%\server.js introuvable ***
    echo.
    pause
    exit /b 1
)

:: Lancer le backend en arriere-plan avec redirection logs
start "" /B cmd /c "cd /d "%BACKEND_DIR%" && node server.js >> "%LOGS_DIR%\backend.log" 2>&1"

:: Poll port 5000 — timeout 60 secondes
echo       Attente du Backend...
set "BACKEND_READY=0"
set "WAIT_COUNT=0"
:wait_backend
    set /a WAIT_COUNT+=1
    if %WAIT_COUNT% gtr 60 goto backend_timeout
    timeout /t 1 /nobreak >nul
    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1
    if %errorlevel% neq 0 goto wait_backend
    set "BACKEND_READY=1"
goto backend_timeout
:backend_timeout

if "%BACKEND_READY%"=="1" (
    echo [3/4] Backend pret sur port %BACKEND_PORT%
) else (
    echo.
    echo   *** ERREUR : Backend non demarre apres 60 secondes ***
    echo   Consultez les logs : %LOGS_DIR%\backend.log
    echo.
    echo   Derniere ligne du log :
    if exist "%LOGS_DIR%\backend.log" (
        more "%LOGS_DIR%\backend.log" | find /V ""
    )
    echo.
    echo   Appuyez sur une touche pour quitter.
    pause
    exit /b 1
)

:: ────────────────────────────────────────────────────────────
::  PHASE 4 — VSCODIUM
:: ────────────────────────────────────────────────────────────
echo.
echo [4/4] Ouverture de Sudo Studio dans VSCodium...

:: Chercher VSCodium dans l'ordre de priorite :
::   1. A la racine du projet (distribution portable)
::   2. Dans Program Files (installation systeme)
::   3. Dans AppData (installation utilisateur)
set "VSCODIUM_EXE="

if exist "%ROOT%VSCodium.exe" (
    set "VSCODIUM_EXE=%ROOT%VSCodium.exe"
) else if exist "%ProgramFiles%\VSCodium\VSCodium.exe" (
    set "VSCODIUM_EXE=%ProgramFiles%\VSCodium\VSCodium.exe"
) else if exist "%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe" (
    set "VSCODIUM_EXE=%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe"
) else (
    :: Fallback : chercher dans PATH
    for /f "tokens=*" %%p in ('where codium 2^>nul') do (
        if "!VSCODIUM_EXE!"=="" set "VSCODIUM_EXE=%%p"
    )
)

if "!VSCODIUM_EXE!"=="" (
    echo.
    echo   [AVERTISSEMENT] VSCodium introuvable.
    echo   Emplacements verifies :
    echo     - %ROOT%VSCodium.exe
    echo     - %ProgramFiles%\VSCodium\VSCodium.exe
    echo     - %LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe
    echo.
    echo   Les services backend et runtime sont actifs.
    echo   Ouvrez VSCodium manuellement pour utiliser Sudo Studio.
) else (
    start "" "!VSCODIUM_EXE!"
    echo [4/4] VSCodium ouvert : !VSCODIUM_EXE!
)

:: ────────────────────────────────────────────────────────────
::  RESUME FINAL — terminal reste ouvert
:: ────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   SUDO STUDIO DEMARRE
echo ============================================================
echo.
echo   Backend Node.js   : http://localhost:%BACKEND_PORT%
echo   Runtime Python IA : http://localhost:%RUNTIME_PORT%
echo.
echo   Logs backend      : %LOGS_DIR%\backend.log
echo   Logs runtime      : %LOGS_DIR%\runtime.log
echo.
echo ============================================================
echo.
echo   Ce terminal maintient les services actifs.
echo   Fermez cette fenetre pour tout arreter.
echo   (ou Ctrl+C pour stopper proprement)
echo.
pause
