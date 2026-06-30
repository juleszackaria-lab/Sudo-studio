@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Demarrage

:: ============================================================
::   SUDO STUDIO v2.2 — Lanceur automatique Windows
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
echo   SUDO STUDIO v2.2 - Demarrage automatique
echo ============================================================
echo.

:: ────────────────────────────────────────────────────────────
::  PHASE 1 — NODE.JS
::
::  Strategie en 4 couches :
::    [0] node deja dans PATH           → OK direct
::    [1] node.exe trouvable sur disque → injecter PATH
::    [2] winget disponible             → installer LTS silencieux
::    [3] fallback MSI PowerShell       → version LTS dynamique
::                                         taille > 20MB + /qn +
::                                         -PassThru + ExitCode reel
::    [R] MSI reussit ExitCode=3010     → reboot auto + HKCU\Run
:: ────────────────────────────────────────────────────────────
echo [1/4] Verification Node.js...

:: ── [0] Detection dans PATH ──────────────────────────────────
node --version >nul 2>&1
if %errorlevel% equ 0 goto :node_found

:: ── [1] node.exe present sur disque mais pas dans PATH ───────
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        echo       Node.js trouve dans Program Files - PATH mis a jour.
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        echo       Node.js trouve dans Program Files x64 - PATH mis a jour.
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
    if !errorlevel! equ 0 (
        echo       Node.js installe via winget.
        goto :node_found
    )
    :: Chercher directement meme si PATH stale
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
        node --version >nul 2>&1
        if !errorlevel! equ 0 (
            echo       Node.js installe via winget (chemin direct).
            goto :node_found
        )
    )
    if exist "%ProgramW6432%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
        node --version >nul 2>&1
        if !errorlevel! equ 0 (
            echo       Node.js installe via winget (chemin x64).
            goto :node_found
        )
    )
    echo       winget OK mais node introuvable - fallback MSI...
) else (
    echo       winget absent - fallback MSI PowerShell...
)

:: ── [3] Fallback MSI via PowerShell ──────────────────────────
echo       [3] Preparation installation Node.js LTS via MSI...
echo.

:: Generer le script .ps1 dans %TEMP% ligne par ligne
:: (evite les problemes d'echappement de guillemets dans -Command)
set "PS1=%TEMP%\sudo_node_install.ps1"

:: -- Ecriture du script PowerShell ligne par ligne --
(echo $ErrorActionPreference = 'Stop') > "%PS1%"
(echo.) >> "%PS1%"
(echo # ── Detection dynamique de la derniere version LTS Node.js 20.x ──) >> "%PS1%"
(echo $fallbackVersion = 'v20.18.1') >> "%PS1%"
(echo $nodeVersion = $fallbackVersion) >> "%PS1%"
(echo try {) >> "%PS1%"
(echo     Write-Host '      Detection version LTS Node.js...') >> "%PS1%"
(echo     $page = (New-Object System.Net.WebClient^).DownloadString('https://nodejs.org/dist/latest-v20.x/'^)) >> "%PS1%"
(echo     $match = [regex]::Match($page, 'node-(v20\.\d+\.\d+)-x64\.msi'^)) >> "%PS1%"
(echo     if ($match.Success^) {) >> "%PS1%"
(echo         $nodeVersion = $match.Groups[1].Value) >> "%PS1%"
(echo         Write-Host "      Version LTS detectee : $nodeVersion") >> "%PS1%"
(echo     } else {) >> "%PS1%"
(echo         Write-Host "      Detection impossible - fallback $fallbackVersion") >> "%PS1%"
(echo     }) >> "%PS1%"
(echo } catch {) >> "%PS1%"
(echo     Write-Host "      Reseau indisponible - fallback $fallbackVersion") >> "%PS1%"
(echo     $nodeVersion = $fallbackVersion) >> "%PS1%"
(echo }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo $msiName = "node-$nodeVersion-x64.msi") >> "%PS1%"
(echo $url = "https://nodejs.org/dist/$nodeVersion/$msiName") >> "%PS1%"
(echo $out = Join-Path $env:TEMP $msiName) >> "%PS1%"
(echo.) >> "%PS1%"
(echo Write-Host "      Telechargement $msiName (~35 MB)...") >> "%PS1%"
(echo Write-Host "      URL : $url") >> "%PS1%"
(echo.) >> "%PS1%"
(echo # -- Telecharger le MSI --) >> "%PS1%"
(echo try {) >> "%PS1%"
(echo     $wc = New-Object System.Net.WebClient) >> "%PS1%"
(echo     $wc.DownloadFile($url, $out^)) >> "%PS1%"
(echo } catch {) >> "%PS1%"
(echo     Write-Host "ERREUR telechargement : $($_.Exception.Message^)") >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo # -- Verifier taille minimale 20 MB --) >> "%PS1%"
(echo if (-not (Test-Path $out^)^) {) >> "%PS1%"
(echo     Write-Host 'ERREUR : fichier MSI absent apres telechargement') >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo $file = Get-Item $out) >> "%PS1%"
(echo $sizeMB = [math]::Round($file.Length / 1MB, 1^)) >> "%PS1%"
(echo if ($file.Length -lt 20MB^) {) >> "%PS1%"
(echo     Write-Host "ERREUR : fichier trop petit ($sizeMB MB^) - telechargement incomplet") >> "%PS1%"
(echo     Remove-Item $out -Force -ErrorAction SilentlyContinue) >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo Write-Host "      Fichier OK ($sizeMB MB^) - lancement installation...") >> "%PS1%"
(echo.) >> "%PS1%"
(echo # -- Installer avec /qn (silencieux total^) + -PassThru pour ExitCode reel --) >> "%PS1%"
(echo $proc = Start-Process msiexec.exe -ArgumentList '/i', $out, '/qn', '/norestart' -Wait -PassThru) >> "%PS1%"
(echo.) >> "%PS1%"
(echo # -- Nettoyer le MSI telecharge --) >> "%PS1%"
(echo Remove-Item $out -Force -ErrorAction SilentlyContinue) >> "%PS1%"
(echo.) >> "%PS1%"
(echo Write-Host "      msiexec ExitCode = $($proc.ExitCode^)") >> "%PS1%"
(echo.) >> "%PS1%"
(echo if ($proc.ExitCode -eq 0^) {) >> "%PS1%"
(echo     # -- Rafraichir PATH depuis registre Windows dans cette session PS --) >> "%PS1%"
(echo     $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine'^)) >> "%PS1%"
(echo     $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User'^)) >> "%PS1%"
(echo     if ($machinePath^) { $env:Path = $machinePath }) >> "%PS1%"
(echo     if ($userPath^)    { $env:Path += ';' + $userPath }) >> "%PS1%"
(echo     # -- Ajouter le dossier Node.js si absent du PATH refresh --) >> "%PS1%"
(echo     $nodeDirs = @('C:\Program Files\nodejs', 'C:\Program Files (x86^)\nodejs'^)) >> "%PS1%"
(echo     foreach ($d in $nodeDirs^) {) >> "%PS1%"
(echo         if ((Test-Path "$d\node.exe"^) -and ($env:Path -notlike "*$d*"^)^) {) >> "%PS1%"
(echo             $env:Path += ";$d") >> "%PS1%"
(echo         }) >> "%PS1%"
(echo     }) >> "%PS1%"
(echo     # -- Verifier node dans cette session PS --) >> "%PS1%"
(echo     try {) >> "%PS1%"
(echo         $v = & node --version 2^>$null) >> "%PS1%"
(echo         Write-Host "      Node.js detecte dans PS : $v") >> "%PS1%"
(echo     } catch {) >> "%PS1%"
(echo         Write-Host "      Note: node non detecte dans PS - sera detecte par cmd apres refresh") >> "%PS1%"
(echo     }) >> "%PS1%"
(echo     Write-Host 'INSTALL_OK') >> "%PS1%"
(echo     exit 0) >> "%PS1%"
(echo } elseif ($proc.ExitCode -eq 3010^) {) >> "%PS1%"
(echo     # ExitCode 3010 = succes + reboot Windows requis (comportement MSI normal^)) >> "%PS1%"
(echo     Write-Host 'REBOOT_REQUIRED') >> "%PS1%"
(echo     exit 3010) >> "%PS1%"
(echo } else {) >> "%PS1%"
(echo     Write-Host "ERREUR msiexec ExitCode=$($proc.ExitCode^)") >> "%PS1%"
(echo     exit 2) >> "%PS1%"
(echo }) >> "%PS1%"

:: Lancer le script et capturer son code de sortie
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "PS_EXIT=%errorlevel%"
del "%PS1%" >nul 2>&1

:: ExitCode 3010 = MSI installe mais reboot Windows requis
if %PS_EXIT% equ 3010 goto :node_reboot_required

:: Autre erreur MSI
if %PS_EXIT% neq 0 (
    echo.
    echo   *** ERREUR : Installation Node.js echouee (code %PS_EXIT%^) ***
    echo.
    echo   Solutions manuelles :
    echo     1. Telecharger : https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi
    echo     2. Installer normalement en double-cliquant
    echo     3. Relancer start.bat
    echo.
    pause
    exit /b 1
)

:: MSI ok (ExitCode 0) — rafraichir PATH depuis registre Windows
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
    if !errorlevel! equ 0 (
        echo       Node.js detecte via chemin direct.
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        echo       Node.js detecte via chemin direct x64.
        goto :node_found
    )
)

:: Verifier si un exe node existe dans les chemins standards
:: avant de conclure qu un reboot est necessaire
set "NODE_EXE_FOUND=0"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE_FOUND=1"
if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE_FOUND=1"

if "%NODE_EXE_FOUND%"=="1" (
    echo.
    echo   [INFO] Node.js installe mais PATH non rafraichi apres MSI.
    echo   Tentative de relancement via chemin absolu...
    echo.
    :: Reessayer une derniere fois avec PATH elargi
    call :refresh_node_path
    node --version >nul 2>&1
    if !errorlevel! equ 0 goto :node_found
)

:: MSI ok mais node toujours introuvable = reboot Windows requis
goto :node_reboot_required

:: ── [R] Reboot automatique avec reprise ─────────────────────
:node_reboot_required
echo.
echo   +----------------------------------------------------------+
echo   ^|  Node.js est installe mais Windows doit redemarrer       ^|
echo   ^|  pour finaliser l'enregistrement du PATH.                ^|
echo   ^|  (Comportement normal de l'installeur MSI Windows^)       ^|
echo   ^|                                                          ^|
echo   ^|  start.bat sera relance AUTOMATIQUEMENT apres reboot.    ^|
echo   ^|                                                          ^|
echo   ^|  Appuyez sur ENTREE pour redemarrer maintenant.          ^|
echo   ^|  Fermez cette fenetre pour redemarrer plus tard.         ^|
echo   +----------------------------------------------------------+
echo.
:: Inscrire start.bat dans HKCU\Run pour reprise automatique apres reboot
:: Script PS1 externe pour eviter les problemes d echappement de guillemets
set "RUN_PS1=%TEMP%\sudo_run_register.ps1"
(echo $batPath = $env:SUDO_BAT_PATH) > "%RUN_PS1%"
(echo $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run") >> "%RUN_PS1%"
(echo $value = "cmd /k `"$batPath`"") >> "%RUN_PS1%"
(echo Set-ItemProperty -Path $regPath -Name "SudoStudioAutoStart" -Value $value -Force) >> "%RUN_PS1%"
set "SUDO_BAT_PATH=%ROOT%start.bat"
powershell -NoProfile -ExecutionPolicy Bypass -File "%RUN_PS1%" >nul 2>&1
del "%RUN_PS1%" >nul 2>&1
echo   Reprise automatique enregistree.
echo   (HKCU\Software\Microsoft\Windows\CurrentVersion\Run^)
pause
shutdown /r /t 5 /c "Sudo Studio - finalisation Node.js (PATH)"
exit /b 0

:: ── Sous-routine : rafraichir PATH depuis registre Windows ───
:refresh_node_path
    :: findstr filtre directement les lignes REG_SZ/REG_EXPAND_SZ
    :: tokens=3* : skip type (REG_EXPAND_SZ) et capturer la valeur
    for /f "tokens=3*" %%A in (
        'reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr /i "REG_SZ REG_EXPAND_SZ"'
    ) do set "SYS_PATH=%%B"
    for /f "tokens=3*" %%A in (
        'reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /i "REG_SZ REG_EXPAND_SZ"'
    ) do set "USR_PATH=%%B"
    if defined SYS_PATH set "PATH=%SYS_PATH%"
    if defined USR_PATH set "PATH=%PATH%;%USR_PATH%"
    :: Ajouter les chemins Node.js connus au cas ou
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    exit /b 0

:: ── Node.js confirme — supprimer cle Run si elle existe ─────
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
    if !errorlevel! neq 0 (
        python3 --version >nul 2>&1
        if !errorlevel! neq 0 (
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

:: Poll port 6000 — timeout 90 secondes (2s par iteration = 180s max)
echo       Attente du Runtime IA (max 90 tentatives x 2s)...
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
    echo [2/4] Runtime IA : demarrage lent (modele en cours de chargement^)
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
    if !errorlevel! neq 0 (
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

:: Poll port 5000 — timeout 60 secondes (1s par iteration)
echo       Attente du Backend (max 60s)...
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
    echo   Dernieres lignes du log :
    if exist "%LOGS_DIR%\backend.log" (
        powershell -NoProfile -Command "Get-Content '%LOGS_DIR%\backend.log' -Tail 5 -ErrorAction SilentlyContinue"
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
::   4. Dans PATH (fallback where codium)
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
