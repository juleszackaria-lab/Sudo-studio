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
echo   SUDO STUDIO v2.1 - Demarrage automatique
echo ============================================================
echo.

:: ────────────────────────────────────────────────────────────
::  PHASE 1 — NODE.JS
::
::  Strategie en 4 couches :
::    [0] node deja dans PATH           → OK direct
::    [1] node.exe trouvable sur disque → injecter PATH
::    [2] winget disponible             → installer LTS silencieux
::    [3] fallback MSI PowerShell       → telecharger + verifier
::                                         taille + /qn + ExitCode
::    [R] MSI reussit mais ExitCode=3010 → reboot auto + reprise
::        via HKCU\Run
:: ────────────────────────────────────────────────────────────
echo [1/4] Verification Node.js...

:: ── [0] Détection dans PATH ──────────────────────────────────
node --version >nul 2>&1
if %errorlevel% equ 0 goto :node_found

:: ── [1] node.exe présent sur disque mais pas dans PATH ───────
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       Node.js trouve dans Program Files - PATH mis a jour.
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       Node.js trouve dans Program Files (x64) - PATH mis a jour.
        goto :node_found
    )
)

echo       Node.js absent - installation automatique...
echo.

:: ── [2] winget ───────────────────────────────────────────────
winget --version >nul 2>&1
if %errorlevel% equ 0 (
    echo       [2] Installation via winget (Windows Package Manager)...
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    :: winget ecrit dans le registre mais pas dans la session courante
    call :refresh_node_path
    node --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       Node.js installe via winget.
        goto :node_found
    )
    :: Chercher directement même si PATH stale
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
        node --version >nul 2>&1
        if %errorlevel% equ 0 (
            echo       Node.js installe via winget (chemin direct).
            goto :node_found
        )
    )
    echo       winget OK mais node introuvable - fallback MSI...
) else (
    echo       winget absent - fallback MSI PowerShell...
)

:: ── [3] Fallback MSI via PowerShell ──────────────────────────
echo       [3] Telechargement Node.js v20.18.1 MSI...
echo.

:: Générer un script .ps1 dans %TEMP% pour éviter les problèmes
:: d'échappement de guillemets dans -Command
set "PS1=%TEMP%\sudo_node_install.ps1"

:: Ecrire le script PowerShell ligne par ligne
(echo $ErrorActionPreference = 'Stop') > "%PS1%"
(echo $url = 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi') >> "%PS1%"
(echo $out = Join-Path $env:TEMP 'sudo_nodejs_v20.18.1.msi') >> "%PS1%"
(echo.) >> "%PS1%"
(echo Write-Host '      Telechargement en cours (~35 MB)...') >> "%PS1%"
(echo try {) >> "%PS1%"
(echo     $wc = New-Object System.Net.WebClient) >> "%PS1%"
(echo     $wc.DownloadFile($url, $out^)) >> "%PS1%"
(echo } catch {) >> "%PS1%"
(echo     Write-Host "ERREUR telechargement : $($_.Exception.Message^)") >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Verifier taille minimale 20 MB) >> "%PS1%"
(echo $file = Get-Item $out) >> "%PS1%"
(echo if ($file.Length -lt 20MB^) {) >> "%PS1%"
(echo     Write-Host "ERREUR : fichier trop petit ($($file.Length^) octets^) - telechargement incomplet") >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo Write-Host "      Fichier OK ($([math]::Round($file.Length / 1MB^)) MB^) - installation...") >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Installer avec /qn (silencieux total^) - capturer ExitCode reel) >> "%PS1%"
(echo $proc = Start-Process msiexec.exe -ArgumentList '/i', $out, '/qn', '/norestart' -Wait -PassThru) >> "%PS1%"
(echo.) >> "%PS1%"
(echo if ($proc.ExitCode -eq 0^) {) >> "%PS1%"
(echo     Write-Host '      Installation reussie (ExitCode=0^).') >> "%PS1%"
(echo     exit 0) >> "%PS1%"
(echo } elseif ($proc.ExitCode -eq 3010^) {) >> "%PS1%"
(echo     # ExitCode 3010 = succes + reboot Windows requis (comportement MSI normal^)) >> "%PS1%"
(echo     Write-Host 'REBOOT_REQUIRED') >> "%PS1%"
(echo     exit 3010) >> "%PS1%"
(echo } else {) >> "%PS1%"
(echo     Write-Host "ERREUR msiexec ExitCode=$($proc.ExitCode^)") >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"

:: Lancer le script et capturer son code de sortie
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "PS_EXIT=%errorlevel%"
del "%PS1%" >nul 2>&1

:: ExitCode 3010 = MSI installe mais reboot Windows requis
if "%PS_EXIT%"=="3010" goto :node_reboot_required

:: Autre erreur
if %PS_EXIT% neq 0 (
    echo.
    echo   *** ERREUR : Installation Node.js echouee (ExitCode %PS_EXIT%^) ***
    echo.
    echo   Solutions manuelles :
    echo     1. Telecharger : https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi
    echo     2. Installer normalement, relancer start.bat
    echo.
    pause
    exit /b 1
)

:: MSI ok — rafraichir PATH depuis le registre Windows
call :refresh_node_path

:: Verifier node dans PATH apres refresh
node --version >nul 2>&1
if %errorlevel% equ 0 (
    echo       Node.js installe et detecte.
    goto :node_found
)

:: PATH encore stale (rare) — tester les chemins d'installation directs
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       Node.js detecte via chemin direct.
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo       Node.js detecte via chemin direct (x64^).
        goto :node_found
    )
)

:: MSI ok mais node toujours introuvable = reboot requis
goto :node_reboot_required

:: ── [R] Reboot automatique avec reprise ─────────────────────
:node_reboot_required
echo.
echo   +----------------------------------------------------------+
echo   ^|  Node.js est installe mais Windows doit redemarrer       ^|
echo   ^|  pour finaliser l'installation (comportement normal MSI^). ^|
echo   ^|                                                          ^|
echo   ^|  start.bat sera relance automatiquement au prochain      ^|
echo   ^|  demarrage de Windows.                                   ^|
echo   ^|                                                          ^|
echo   ^|  Appuyez sur ENTREE pour redemarrer maintenant.          ^|
echo   ^|  Fermez cette fenetre pour redemarrer plus tard.         ^|
echo   +----------------------------------------------------------+
echo.
:: Inscrire start.bat dans HKCU\Run pour reprise automatique apres reboot
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
    /v "SudoStudioAutoStart" ^
    /t REG_SZ ^
    /d "\"%ROOT%start.bat\"" ^
    /f >nul 2>&1
echo   Reprise automatique enregistree dans le registre.
echo   (HKCU\Software\Microsoft\Windows\CurrentVersion\Run^)
echo.
pause
shutdown /r /t 5 /c "Sudo Studio - finalisation Node.js"
exit /b 0

:: ── Sous-routine : rafraichir PATH depuis registre ───────────
:refresh_node_path
    for /f "tokens=2*" %%A in (
        'reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul'
    ) do set "SYS_PATH=%%B"
    for /f "tokens=2*" %%A in (
        'reg query "HKCU\Environment" /v Path 2^>nul'
    ) do set "USR_PATH=%%B"
    if defined SYS_PATH set "PATH=%SYS_PATH%"
    if defined USR_PATH set "PATH=%PATH%;%USR_PATH%"
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    exit /b 0

:: ── Node.js confirmé — supprimer clé Run si elle existe ─────
:node_found
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "SudoStudioAutoStart" /f >nul 2>&1
for /f "tokens=*" %%v in ('node --version 2^>^&1') do set "NODE_VER=%%v"
echo [1/4] Node.js %NODE_VER% OK

:: ────────────────────────────────────────────────────────────
::  PHASE 2 — RUNTIME IA (runtime.exe ou server.enterprise.py)
:: ────────────────────────────────────────────────────────────
:phase2_runtime
echo.
echo [2/4] Demarrage Runtime IA (port %RUNTIME_PORT%)...

:: Verifier si runtime.exe existe a la racine du projet
if exist "%ROOT%runtime.exe" (
    echo       Lancement runtime.exe...
    start "" /B "%ROOT%runtime.exe"
) else if exist "%RUNTIME_DIR%\server.enterprise.py" (
    :: Fallback : lancer directement le script Python
    echo       runtime.exe absent - lancement via Python...
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

:: Verifier que server.js existe bien
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
