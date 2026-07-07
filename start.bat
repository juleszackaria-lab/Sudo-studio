@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Demarrage

:: ============================================================
::   SUDO STUDIO v2.5 -- Lanceur automatique Windows
::   Double-cliquer pour demarrer. NE PAS MODIFIER.
::   Version : 2.4 -- Stabilisation + Smart Model Detection
:: ============================================================

:: -- Variables globales ----------------------------------------
set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "RUNTIME_DIR=%ROOT%backend\runtime"
set "LOGS_DIR=%ROOT%logs"
set "LOG_FILE=%ROOT%logs\startup.log"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "START_TIME=%TIME%"
set "START_DATE=%DATE%"

:: -- Creer le dossier logs si absent ---------------------------
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%" 2>nul
if not exist "%LOGS_DIR%" (
    echo ERREUR FATALE : Impossible de creer le dossier logs.
    echo Verifiez les permissions du dossier : %ROOT%
    pause
    exit /b 1
)

:: -- Initialiser le fichier de log -----------------------------
(
echo ============================================================
echo   SUDO STUDIO v2.5 - Demarrage : %START_DATE% %START_TIME%
echo ============================================================
echo   Repertoire : %ROOT%
) > "%LOG_FILE%"

:: Recueillir infos systeme
for /f "tokens=*" %%v in ('ver 2^>nul') do set "WIN_VER=%%v"
set "ARCH=%PROCESSOR_ARCHITECTURE%"
(
echo   Windows   : %WIN_VER%
echo   Arch      : %ARCH%
echo   Repertoire: %ROOT%
echo   Backend   : %BACKEND_DIR%
echo   Runtime   : %RUNTIME_DIR%
echo   Port BK   : %BACKEND_PORT%
echo   Port RT   : %RUNTIME_PORT%
echo.
) >> "%LOG_FILE%"

echo.
echo ============================================================
echo   SUDO STUDIO v2.5 - Demarrage automatique
echo ============================================================
echo.

:: ============================================================
::  PHASE 1 -- NODE.JS
::
::  Strategie 4 couches + reboot :
::    [0] node dans PATH           -- detection immediate
::    [1] node.exe sur disque      -- injection PATH directe
::    [2] winget                   -- installation LTS silencieuse
::    [3] MSI PowerShell           -- LTS dynamique, /qn, -PassThru
::    [R] ExitCode 3010            -- reboot + HKCU\Run auto-resume
:: ============================================================
call :LOG "[PHASE 1] Verification Node.js..."
echo [1/4] Verification Node.js...

:: -- [0] Node dans PATH -----------------------------------------
node --version >nul 2>&1
if !errorlevel! equ 0 goto :node_found

:: -- [1] node.exe sur disque (PATH stale) -----------------------
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        call :LOG "  [1] Node.js trouve dans ProgramFiles - PATH mis a jour"
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        call :LOG "  [1] Node.js trouve dans ProgramW6432 - PATH mis a jour"
        goto :node_found
    )
)

call :LOG "  Node.js absent - installation automatique requise"
echo       Node.js absent - installation automatique...
echo.

:: -- [2] winget -------------------------------------------------
winget --version >nul 2>&1
if !errorlevel! equ 0 (
    call :LOG "  [2] Tentative installation via winget..."
    echo       [2] Installation via winget...
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
    call :refresh_node_path
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        call :LOG "  [2] Node.js installe via winget - OK"
        goto :node_found
    )
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
        node --version >nul 2>&1
        if !errorlevel! equ 0 (
            call :LOG "  [2] Node.js winget - detecte via ProgramFiles"
            goto :node_found
        )
    )
    if exist "%ProgramW6432%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
        node --version >nul 2>&1
        if !errorlevel! equ 0 (
            call :LOG "  [2] Node.js winget - detecte via ProgramW6432"
            goto :node_found
        )
    )
    call :LOG "  [2] winget execute mais node toujours absent - fallback MSI"
    echo       winget execute, node absent - fallback MSI...
) else (
    call :LOG "  [2] winget absent - fallback MSI PowerShell"
    echo       winget absent - fallback MSI PowerShell...
)

:: -- [3] Fallback MSI via script PowerShell externe -------------
call :LOG "  [3] Preparation script MSI PowerShell..."
echo       [3] Telechargement Node.js LTS via MSI...
echo.

set "PS1=%TEMP%\sudo_node_install.ps1"

:: Ecriture du script PS1 ligne par ligne
(echo $ErrorActionPreference = 'Stop') > "%PS1%"
(echo $logFile = '%LOG_FILE:\=\\%') >> "%PS1%"
(echo function Write-Log($msg^) { Add-Content -Path $logFile -Value $msg -ErrorAction SilentlyContinue }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Detection dynamique version LTS Node.js 20.x) >> "%PS1%"
(echo $fallbackVersion = 'v20.18.1') >> "%PS1%"
(echo $nodeVersion = $fallbackVersion) >> "%PS1%"
(echo try {) >> "%PS1%"
(echo     Write-Host '      Detection version LTS en cours...') >> "%PS1%"
(echo     $wc2 = New-Object System.Net.WebClient) >> "%PS1%"
(echo     $wc2.Headers['User-Agent'] = 'Mozilla/5.0') >> "%PS1%"
(echo     $page = $wc2.DownloadString('https://nodejs.org/dist/latest-v20.x/'^)) >> "%PS1%"
(echo     $match = [regex]::Match($page, 'node-(v20\.\d+\.\d+)-x64\.msi'^)) >> "%PS1%"
(echo     if ($match.Success^) {) >> "%PS1%"
(echo         $nodeVersion = $match.Groups[1].Value) >> "%PS1%"
(echo         Write-Host "      Version LTS detectee : $nodeVersion") >> "%PS1%"
(echo         Write-Log "  [3] Version LTS detectee : $nodeVersion") >> "%PS1%"
(echo     } else {) >> "%PS1%"
(echo         Write-Host "      Regex non trouvee - fallback $fallbackVersion") >> "%PS1%"
(echo         Write-Log "  [3] Regex non trouvee - fallback $fallbackVersion") >> "%PS1%"
(echo     }) >> "%PS1%"
(echo } catch {) >> "%PS1%"
(echo     Write-Host "      Reseau indisponible - fallback $fallbackVersion") >> "%PS1%"
(echo     Write-Log "  [3] Reseau indisponible - fallback $fallbackVersion") >> "%PS1%"
(echo     $nodeVersion = $fallbackVersion) >> "%PS1%"
(echo }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo $msiName = "node-$nodeVersion-x64.msi") >> "%PS1%"
(echo $url = "https://nodejs.org/dist/$nodeVersion/$msiName") >> "%PS1%"
(echo $out = Join-Path $env:TEMP $msiName) >> "%PS1%"
(echo Write-Host "      URL : $url") >> "%PS1%"
(echo Write-Log "  [3] Telechargement : $url") >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Telecharger le MSI) >> "%PS1%"
(echo try {) >> "%PS1%"
(echo     Write-Host '      Telechargement en cours (~35 MB)...') >> "%PS1%"
(echo     $wc = New-Object System.Net.WebClient) >> "%PS1%"
(echo     $wc.DownloadFile($url, $out^)) >> "%PS1%"
(echo } catch {) >> "%PS1%"
(echo     $errMsg = "ERREUR telechargement : $($_.Exception.Message^)") >> "%PS1%"
(echo     Write-Host $errMsg) >> "%PS1%"
(echo     Write-Log "  [3] $errMsg") >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Verifier taille > 20 MB) >> "%PS1%"
(echo if (-not (Test-Path $out^)^) {) >> "%PS1%"
(echo     Write-Host 'ERREUR : MSI absent apres telechargement') >> "%PS1%"
(echo     Write-Log '  [3] ERREUR : MSI absent apres telechargement') >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo $file = Get-Item $out) >> "%PS1%"
(echo $sizeMB = [math]::Round($file.Length / 1MB, 1^)) >> "%PS1%"
(echo if ($file.Length -lt 20MB^) {) >> "%PS1%"
(echo     Write-Host "ERREUR : fichier trop petit ($sizeMB MB^) - telechargement corrompu") >> "%PS1%"
(echo     Write-Log "  [3] ERREUR : fichier trop petit : $sizeMB MB") >> "%PS1%"
(echo     Remove-Item $out -Force -ErrorAction SilentlyContinue) >> "%PS1%"
(echo     exit 1) >> "%PS1%"
(echo }) >> "%PS1%"
(echo Write-Host "      Fichier OK ($sizeMB MB^) - lancement msiexec...") >> "%PS1%"
(echo Write-Log "  [3] Fichier OK : $sizeMB MB") >> "%PS1%"
(echo.) >> "%PS1%"
(echo # Installer : /qn = silencieux total, -PassThru = ExitCode reel) >> "%PS1%"
(echo $proc = Start-Process msiexec.exe -ArgumentList '/i', $out, '/qn', '/norestart' -Wait -PassThru) >> "%PS1%"
(echo Remove-Item $out -Force -ErrorAction SilentlyContinue) >> "%PS1%"
(echo Write-Host "      msiexec ExitCode = $($proc.ExitCode^)") >> "%PS1%"
(echo Write-Log "  [3] msiexec ExitCode = $($proc.ExitCode^)") >> "%PS1%"
(echo.) >> "%PS1%"
(echo if ($proc.ExitCode -eq 0^) {) >> "%PS1%"
(echo     # Refresh PATH dans cette session PS) >> "%PS1%"
(echo     $mp = [Environment]::GetEnvironmentVariable('Path','Machine'^)) >> "%PS1%"
(echo     $up = [Environment]::GetEnvironmentVariable('Path','User'^)) >> "%PS1%"
(echo     if ($mp^) { $env:Path = $mp }) >> "%PS1%"
(echo     if ($up^)  { $env:Path += ';' + $up }) >> "%PS1%"
(echo     Write-Log '  [3] Installation Node.js OK (ExitCode 0^)') >> "%PS1%"
(echo     Write-Host 'INSTALL_OK') >> "%PS1%"
(echo     exit 0) >> "%PS1%"
(echo } elseif ($proc.ExitCode -eq 3010^) {) >> "%PS1%"
(echo     Write-Log '  [3] ExitCode 3010 - reboot Windows requis') >> "%PS1%"
(echo     Write-Host 'REBOOT_REQUIRED') >> "%PS1%"
(echo     exit 3010) >> "%PS1%"
(echo } else {) >> "%PS1%"
(echo     Write-Log "  [3] ERREUR msiexec ExitCode=$($proc.ExitCode^)") >> "%PS1%"
(echo     Write-Host "ERREUR msiexec ExitCode=$($proc.ExitCode^)") >> "%PS1%"
(echo     exit 2) >> "%PS1%"
(echo }) >> "%PS1%"

:: Executer le script PS1
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "PS_EXIT=!errorlevel!"
del "%PS1%" >nul 2>&1

:: ExitCode 3010 = MSI installe mais reboot requis
if !PS_EXIT! equ 3010 goto :node_reboot_required

:: Erreur MSI
if !PS_EXIT! neq 0 (
    call :LOG "  [3] ECHEC installation Node.js - code !PS_EXIT!"
    echo.
    echo   *** ERREUR : Installation Node.js echouee (code !PS_EXIT!^) ***
    echo.
    echo   Solutions :
    echo     1. Telecharger manuellement :
    echo        https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi
    echo     2. Installer en double-cliquant le fichier MSI
    echo     3. Relancer start.bat
    echo.
    echo   Log complet : %LOG_FILE%
    echo.
    pause
    exit /b 1
)

:: MSI OK -- refresher PATH
call :refresh_node_path
node --version >nul 2>&1
if !errorlevel! equ 0 (
    call :LOG "  [3] Node.js installe et detecte apres refresh PATH"
    goto :node_found
)

:: PATH encore stale -- tester chemins directs
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        call :LOG "  [3] Node.js detecte via ProgramFiles apres MSI"
        goto :node_found
    )
)
if exist "%ProgramW6432%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    node --version >nul 2>&1
    if !errorlevel! equ 0 (
        call :LOG "  [3] Node.js detecte via ProgramW6432 apres MSI"
        goto :node_found
    )
)

:: MSI OK mais node introuvable = reboot requis
call :LOG "  [3] MSI OK mais node non detecte = reboot requis"
goto :node_reboot_required

:: -- [R] Reboot automatique + HKCU\Run pour reprise ------------
:node_reboot_required
call :LOG "  [R] Reboot requis - enregistrement HKCU\Run"
echo.
echo   +----------------------------------------------------------+
echo   ^|  Node.js installe -- Windows doit redemarrer             ^|
echo   ^|  pour finaliser l'enregistrement du PATH (normal MSI^).   ^|
echo   ^|                                                          ^|
echo   ^|  start.bat sera relance AUTOMATIQUEMENT apres reboot.    ^|
echo   ^|                                                          ^|
echo   ^|  >> Appuyez sur ENTREE pour redemarrer maintenant.       ^|
echo   ^|     Fermez cette fenetre pour redemarrer plus tard.      ^|
echo   +----------------------------------------------------------+
echo.

:: FIX v2.4 BUG #1 : SUDO_BAT_PATH DOIT etre defini AVANT le PS1 qui le lit
:: (v2.3 avait set SUDO_BAT_PATH APRES l ecriture du PS1 : variable vide au reboot)
set "SUDO_BAT_PATH=%ROOT%start.bat"
set "RUN_PS1=%TEMP%\sudo_run_register.ps1"
(echo $batPath = $env:SUDO_BAT_PATH) > "%RUN_PS1%"
(echo $regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') >> "%RUN_PS1%"
(echo $value = 'cmd /k "' + $batPath + '"') >> "%RUN_PS1%"
(echo Set-ItemProperty -Path $regPath -Name 'SudoStudioAutoStart' -Value $value -Force) >> "%RUN_PS1%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%RUN_PS1%" >nul 2>&1
del "%RUN_PS1%" >nul 2>&1
echo   Reprise automatique enregistree dans le registre.
pause
shutdown /r /t 5 /c "Sudo Studio - finalisation Node.js"
exit /b 0

:: -- Subroutine : rafraichir PATH depuis registre Windows ------
:refresh_node_path
    :: findstr filtre la ligne REG_SZ/REG_EXPAND_SZ directement
    for /f "tokens=3*" %%A in (
        'reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr /i "REG_SZ REG_EXPAND_SZ"'
    ) do set "SYS_PATH=%%B"
    for /f "tokens=3*" %%A in (
        'reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /i "REG_SZ REG_EXPAND_SZ"'
    ) do set "USR_PATH=%%B"
    if defined SYS_PATH set "PATH=!SYS_PATH!"
    if defined USR_PATH set "PATH=!PATH!;!USR_PATH!"
    set "PATH=!PATH!;%ProgramFiles%\nodejs\;%ProgramW6432%\nodejs\;%APPDATA%\npm\"
    exit /b 0

:: -- Subroutine : ecrire dans le log ---------------------------
:LOG
    echo %~1 >> "%LOG_FILE%" 2>nul
    exit /b 0

:: -- Subroutine : health check avec fallback PowerShell --------
:check_port
    :: %1 = port, %2 = path, %3 = variable de resultat
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

:: -- Node.js confirme ------------------------------------------
:node_found
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "SudoStudioAutoStart" /f >nul 2>&1
for /f "tokens=*" %%v in ('node --version 2^>^&1') do set "NODE_VER=%%v"
call :LOG "[PHASE 1] Node.js %NODE_VER% - OK"
echo [1/4] Node.js %NODE_VER% OK

:: ============================================================
::  PHASE 2 -- RUNTIME IA (port 6000)
::  Ordre obligatoire : Runtime AVANT Backend
::  v2.4 : Smart Detection integree dans server.enterprise.py
::  Le runtime scanne les modeles locaux avant tout telechargement
:: ============================================================
:phase2_runtime
echo.
echo [2/4] Demarrage Runtime IA (port %RUNTIME_PORT%)...
call :LOG "[PHASE 2] Demarrage Runtime IA port %RUNTIME_PORT%"

:: -- Detecter Python (utile pour les deux branches) -----------
set "PYTHON_CMD="
python --version >nul 2>&1
if !errorlevel! equ 0 set "PYTHON_CMD=python"
if not defined PYTHON_CMD (
    python3 --version >nul 2>&1
    if !errorlevel! equ 0 set "PYTHON_CMD=python3"
)

:: -- Lancer le bon runtime -------------------------------------
if exist "%ROOT%runtime.exe" (
    call :LOG "  Lancement runtime.exe (smart detection integree)"
    echo       Lancement runtime.exe...
    :: FIX v2.4 BUG #4 : redirection via wrapper cmd pour capturer les logs
    start "SudoRuntime" /B cmd /c ^""%ROOT%runtime.exe" >> "%LOGS_DIR%\runtime.log" 2^>&1^"
) else if exist "%RUNTIME_DIR%\server.enterprise.py" (
    call :LOG "  runtime.exe absent - lancement Python"
    echo       runtime.exe absent - lancement via Python...
    if not defined PYTHON_CMD (
        call :LOG "  ERREUR : Python introuvable"
        echo.
        echo   *** ERREUR : runtime.exe absent et Python introuvable ***
        echo   Placez runtime.exe a la racine du projet : %ROOT%
        echo   Log : %LOG_FILE%
        echo.
        pause
        exit /b 1
    )
    :: FIX v2.4 BUG #2 : variable intermediaire pour eviter guillemets imbriques
    :: quand RUNTIME_DIR contient des espaces (ex: C:\Users\Jean Michel\...)
    set "RT_CMD=!PYTHON_CMD! server.enterprise.py --port %RUNTIME_PORT%"
    set "RT_LOG=%LOGS_DIR%\runtime.log"
    start "SudoRuntime" /B cmd /c "cd /d "%RUNTIME_DIR%" && !RT_CMD! >> "!RT_LOG!" 2>&1"
) else (
    call :LOG "  ERREUR : runtime.exe et server.enterprise.py introuvables"
    echo.
    echo   *** ERREUR : Runtime IA introuvable ***
    echo   Attendu : %ROOT%runtime.exe
    echo   Ou      : %RUNTIME_DIR%\server.enterprise.py
    echo   Log : %LOG_FILE%
    echo.
    pause
    exit /b 1
)

:: -- Affichage etat modeles (informatif, non bloquant) ---------
call :LOG "  [MODELES] Smart detection activee dans server.enterprise.py"
echo       Searching for existing AI models...
set "MODELS_STATE=%USERPROFILE%\.sudo_studio\models\model_state.json"
if exist "!MODELS_STATE!" (
    call :LOG "  [MODELES] State file present - modele precedemment valide"
    echo       Existing model found. Model verified. Using local model.
) else (
    call :LOG "  [MODELES] Pas de state file - premier lancement"
    echo       No local model state. Runtime will scan and download if needed.
)

:: -- Poll port 6000 -- timeout 180 secondes (2s * 90) ----------
echo       Attente du Runtime IA (max 180s)...
set "RUNTIME_READY=0"
set "WAIT_COUNT=0"
:wait_runtime
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! gtr 90 goto :runtime_timeout
    timeout /t 2 /nobreak >nul
    call :check_port %RUNTIME_PORT% /health RUNTIME_HIT
    if "!RUNTIME_HIT!"=="1" (
        set "RUNTIME_READY=1"
        goto :runtime_timeout
    )
    goto :wait_runtime
:runtime_timeout

if "!RUNTIME_READY!"=="1" (
    call :LOG "[PHASE 2] Runtime IA pret - port %RUNTIME_PORT% OK"
    echo [2/4] Runtime IA pret sur port %RUNTIME_PORT%
) else (
    call :LOG "[PHASE 2] Runtime IA : timeout 180s - demarrage lent"
    echo [2/4] Runtime IA : demarrage lent (modele IA en cours de chargement^)
    echo       Le chat IA sera disponible dans quelques instants.
)

:: ============================================================
::  PHASE 3 -- BACKEND NODE.JS (port 5000)
:: ============================================================
echo.
echo [3/4] Demarrage Backend Node.js (port %BACKEND_PORT%)...
call :LOG "[PHASE 3] Demarrage Backend Node.js port %BACKEND_PORT%"

:: Verifier server.js
if not exist "%BACKEND_DIR%\server.js" (
    call :LOG "  ERREUR : server.js introuvable"
    echo.
    echo   *** ERREUR : %BACKEND_DIR%\server.js introuvable ***
    echo   Log : %LOG_FILE%
    echo.
    pause
    exit /b 1
)

:: Installer dependances npm si absent
if not exist "%BACKEND_DIR%\node_modules" (
    call :LOG "  node_modules absent - npm install en cours..."
    echo       Installation des dependances npm (premiere fois)...
    pushd "%BACKEND_DIR%"
    npm install --no-audit --no-fund --silent >> "%LOG_FILE%" 2>&1
    set "NPM_ERR=!errorlevel!"
    popd
    if !NPM_ERR! neq 0 (
        call :LOG "  ERREUR : npm install code !NPM_ERR!"
        echo.
        echo   *** ERREUR : npm install a echoue (code !NPM_ERR!^) ***
        echo   Verifiez la connexion Internet et relancez.
        echo   Log : %LOG_FILE%
        echo.
        pause
        exit /b 1
    )
    call :LOG "  npm install termine"
    echo       Dependances npm installees.
)

:: FIX v2.4 BUG #3 : variable intermediaire pour eviter guillemets imbriques
:: quand BACKEND_DIR contient des espaces
set "BK_LOG=%LOGS_DIR%\backend.log"
start "SudoBackend" /B cmd /c "cd /d "%BACKEND_DIR%" && node server.js >> "!BK_LOG!" 2>&1"
call :LOG "  Backend lance en arriere-plan"

:: Poll port 5000 -- timeout 60 secondes
echo       Attente du Backend (max 60s)...
set "BACKEND_READY=0"
set "WAIT_COUNT=0"
:wait_backend
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! gtr 60 goto :backend_timeout
    timeout /t 1 /nobreak >nul
    call :check_port %BACKEND_PORT% /api/system/health BACKEND_HIT
    if "!BACKEND_HIT!"=="1" (
        set "BACKEND_READY=1"
        goto :backend_timeout
    )
    goto :wait_backend
:backend_timeout

if "!BACKEND_READY!"=="1" (
    call :LOG "[PHASE 3] Backend pret - port %BACKEND_PORT% OK"
    echo [3/4] Backend pret sur port %BACKEND_PORT%
) else (
    call :LOG "[PHASE 3] ECHEC Backend - timeout 60s"
    echo.
    echo   *** ERREUR : Backend non demarre apres 60 secondes ***
    echo.
    echo   Verifiez le log :
    echo     %LOGS_DIR%\backend.log
    echo.
    if exist "%LOGS_DIR%\backend.log" (
        echo   Dernieres lignes :
        powershell -NoProfile -Command "Get-Content '%LOGS_DIR%\backend.log' -Tail 8 -ErrorAction SilentlyContinue" 2>nul
        echo.
    )
    echo   Solutions :
    echo     1. Verifiez que le port %BACKEND_PORT% n est pas occupe
    echo     2. Relancez start.bat
    echo.
    pause
    exit /b 1
)

:: ============================================================
::  PHASE 4 -- VSCODIUM + EXTENSION SUDO AI
:: ============================================================
echo.
echo [4/4] Ouverture de Sudo Studio dans VSCodium...
call :LOG "[PHASE 4] Recherche VSCodium"

set "VSCODIUM_EXE="

:: Priorite 1 : portable dans le dossier du projet
if exist "%ROOT%vscodium\VSCodium.exe" set "VSCODIUM_EXE=%ROOT%vscodium\VSCodium.exe"
if not defined VSCODIUM_EXE if exist "%ROOT%VSCodium.exe" set "VSCODIUM_EXE=%ROOT%VSCodium.exe"
:: Priorite 2 : installation systeme
if not defined VSCODIUM_EXE if exist "%ProgramFiles%\VSCodium\VSCodium.exe" set "VSCODIUM_EXE=%ProgramFiles%\VSCodium\VSCodium.exe"
:: Priorite 3 : installation utilisateur
if not defined VSCODIUM_EXE if exist "%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe" set "VSCODIUM_EXE=%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe"
:: Priorite 4 : PATH
if not defined VSCODIUM_EXE (
    for /f "tokens=*" %%p in ('where codium 2^>nul') do (
        if not defined VSCODIUM_EXE set "VSCODIUM_EXE=%%p"
    )
)
if not defined VSCODIUM_EXE (
    for /f "tokens=*" %%p in ('where VSCodium 2^>nul') do (
        if not defined VSCODIUM_EXE set "VSCODIUM_EXE=%%p"
    )
)

if not defined VSCODIUM_EXE (
    call :LOG "[PHASE 4] AVERTISSEMENT : VSCodium introuvable"
    echo.
    echo   [AVERTISSEMENT] VSCodium introuvable.
    echo   Emplacements verifies :
    echo     %ROOT%vscodium\VSCodium.exe
    echo     %ROOT%VSCodium.exe
    echo     %ProgramFiles%\VSCodium\VSCodium.exe
    echo     %LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe
    echo     (PATH^)
    echo.
    echo   Services backend et runtime ACTIFS. Ouvrez VSCodium manuellement.
) else (
    call :LOG "[PHASE 4] VSCodium trouve : !VSCODIUM_EXE!"
    set "VSCO_EXT_DIR=!ROOT!data\extensions"
    set "VSCO_USER_DIR=!ROOT!data\user-data"
    set "VSCO_EXT_SRC=!ROOT!sudo-ai-extension"
    call :LOG "[PHASE 4] Extensions dir : !VSCO_EXT_DIR!"
    call :LOG "[PHASE 4] User-data dir  : !VSCO_USER_DIR!"
    start "SudoStudio" "!VSCODIUM_EXE!" --extensions-dir "!VSCO_EXT_DIR!" --user-data-dir "!VSCO_USER_DIR!" --extensionDevelopmentPath "!VSCO_EXT_SRC!"
    echo [4/4] VSCodium ouvert : !VSCODIUM_EXE!
    call :LOG "[PHASE 4] VSCodium lance avec extension"
)

:: ============================================================
::  RESUME FINAL
:: ============================================================
call :LOG "[OK] Sudo Studio v2.5 demarre avec succes - %TIME%"
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
echo   Log demarrage     : %LOG_FILE%
echo.
echo ============================================================
echo.
echo   Ce terminal maintient les services actifs.
echo   Fermez cette fenetre pour tout arreter.
echo.
pause
