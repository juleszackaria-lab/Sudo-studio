@echo off
setlocal enabledelayedexpansion
title Sudo Studio - Starting...

:: ============================================================
::  SUDO STUDIO v4.6 - Windows Launcher
::  backend.exe  = Node.js/Express (pkg node18-win-x64)
::  runtime.exe  = Python/Flask + HuggingFace AI
::  No system Node.js or Python required.
::  v4.6: runtime timeout 600s + chat fixes
:: ============================================================

:: -- CRITICAL: Set working directory to script location ------
cd /d "%~dp0"

:: -- Global Variables ----------------------------------------
set "ROOT=%~dp0"
set "APP=%ROOT%"
:: P33(c): SINGLE logs folder (never the install dir: wiped on every update).
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "LOGS=%LOCALAPPDATA%\SudoStudio\logs"
set "LOG_FILE=%LOGS%\startup.log"
:: Inherited by backend.exe / runtime.exe / node children (single-dir override).
set "SUDO_STUDIO_LOGS=%LOGS%"
:: P35(c): ALL writable state lives outside the install dir.
set "SSDATA=%LOCALAPPDATA%\SudoStudio"
:: P35(c)+P31(a): true install root for children (AgentServer env-first).
set "SUDO_STUDIO_ROOT=%ROOT%"
set "BACKEND_PORT=5000"
set "RUNTIME_PORT=6000"
set "EXT=%ROOT%extensions\sudo-ai"
set "DATA=%ROOT%data"

:: -- Editor EXE: single detection (set once, used everywhere) -
:: Prefer SudoStudio.exe (packaged builds), fall back to VSCodium.exe (legacy).
:: V_EXE is used in STEP 2 check AND PHASE 5 launch — never re-detected.
set "V_EXE="
if exist "%ROOT%SudoStudio.exe" set "V_EXE=%ROOT%SudoStudio.exe"
if not defined V_EXE if exist "%ROOT%VSCodium.exe" set "V_EXE=%ROOT%VSCodium.exe"

:: -- STEP 1: Confirm script is actually running ---------------
echo.
echo ============================================================
echo   SUDO STUDIO v4.6
echo ============================================================
echo   STEP 1 - Script is running
echo   Root directory: %ROOT%
echo ============================================================
echo.

:: -- Create logs folder ---------------------------------------
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
del "%LOGS%\startup-errors.txt" 2>nul
if not exist "%LOGS%" (
    echo [ERROR] Cannot create logs folder at: %LOGS%
    echo         Check write permissions.
    echo.
    pause
    exit /b 1
)

:: -- Migrate legacy journals to the single folder (P33-c) ------
:: Copy newer-only (/D), never delete: the sources live under the
:: install folder (wiped on update) or the old agent folder, so the
:: migrated copies are the only survivors. *.log* covers rotations.
if exist "%ROOT%logs" xcopy /Y /D /I "%ROOT%logs\*.log*" "%LOGS%\" >nul 2>&1
if exist "%ROOT%..\logs" xcopy /Y /D /I "%ROOT%..\logs\*.log*" "%LOGS%\" >nul 2>&1
if exist "%USERPROFILE%\.sudo_studio\logs" xcopy /Y /D /I "%USERPROFILE%\.sudo_studio\logs\*.log*" "%LOGS%\" >nul 2>&1
if exist "%ROOT%logs" xcopy /Y /D /I "%ROOT%logs\*.jsonl" "%LOGS%\" >nul 2>&1
if exist "%ROOT%..\logs" xcopy /Y /D /I "%ROOT%..\logs\*.jsonl" "%LOGS%\" >nul 2>&1
if exist "%USERPROFILE%\.sudo_studio\logs" xcopy /Y /D /I "%USERPROFILE%\.sudo_studio\logs\*.jsonl" "%LOGS%\" >nul 2>&1

:: -- Build manifest (P29-e): commit first in log ----------------
set "BUILD_COMMIT=dev (no build-manifest.json)"
if exist "%ROOT%build-manifest.json" (
    for /f "delims=" %%c in ('powershell -NoProfile -Command "try { $mf = Join-Path $env:ROOT 'build-manifest.json'; $m = Get-Content $mf -Raw | ConvertFrom-Json; if ($m.sudo_studio_commit) { $m.sudo_studio_commit } elseif ($m.commit) { $m.commit } else { '' } } catch { '' }" 2^>nul') do (
        if not "%%c"=="" set "BUILD_COMMIT=%%c"
    )
    for /f "delims=" %%v in ('powershell -NoProfile -Command "try { $mf = Join-Path $env:ROOT 'build-manifest.json'; $m = Get-Content $mf -Raw | ConvertFrom-Json; if ($m.version) { $m.version } else { '' } } catch { '' }" 2^>nul') do (
        if not "%%v"=="" set "BUILD_VERSION=%%v"
    )
)
if "%BUILD_VERSION%"=="" set "BUILD_VERSION=4.3"

:: -- Init log file --------------------------------------------
(
    echo ============================================================
    echo   SUDO STUDIO v%BUILD_VERSION% - %DATE% %TIME%
    echo   Build commit: %BUILD_COMMIT%
    echo   Root: %ROOT%
    echo ============================================================
) >> "%LOG_FILE%"
echo [LOG] Logging to: %LOG_FILE%
echo.

:: ============================================================
::  PHASE 1 - VERIFY ALL EXECUTABLES (STEP 2)
:: ============================================================
echo [STEP 2] Checking application files...
echo [PHASE 1] Checking files... >> "%LOG_FILE%"
echo.

:: --- backend.exe ---
set "FOUND_BE=0"
if exist "%APP%backend.exe" set "FOUND_BE=1"
if "%FOUND_BE%"=="1" (
    echo   [OK] backend.exe found
    echo   [OK] backend.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] backend.exe
    echo   Expected at: %APP%backend.exe
    echo   [ERROR] backend.exe not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] backend.exe is missing.
    echo backend.exe is missing - reinstall Sudo Studio>>"%LOGS%\startup-errors.txt"
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- runtime.exe ---
set "FOUND_RT=0"
if exist "%APP%runtime.exe" set "FOUND_RT=1"
if "%FOUND_RT%"=="1" (
    echo   [OK] runtime.exe found
    echo   [OK] runtime.exe >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] runtime.exe
    echo   Expected at: %APP%runtime.exe
    echo   [ERROR] runtime.exe not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] runtime.exe is missing.
    echo runtime.exe is missing - reinstall Sudo Studio>>"%LOGS%\startup-errors.txt"
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- Editor executable (SudoStudio.exe or VSCodium.exe) ---
:: V_EXE was already resolved above in Global Variables section.
if defined V_EXE (
    echo   [OK] Editor found: %V_EXE%
    echo   [OK] Editor: %V_EXE% >> "%LOG_FILE%"
) else (
    echo   [NOT FOUND] No editor executable found.
    echo   Looked for SudoStudio.exe and VSCodium.exe in: %ROOT%
    echo   [ERROR] Editor not found >> "%LOG_FILE%"
    echo.
    echo [FATAL] No editor executable found in install folder.
    echo No editor executable found - reinstall Sudo Studio>>"%LOGS%\startup-errors.txt"
    echo         Please reinstall Sudo Studio.
    echo.
    pause
    exit /b 1
)

:: --- Sudo AI Extension (warning only - not fatal) ---
set "FOUND_EXTJS=0"
if exist "%EXT%\extension.js" set "FOUND_EXTJS=1"
if "%FOUND_EXTJS%"=="1" (
    echo   [OK] Sudo AI extension found
    echo   [OK] extension.js >> "%LOG_FILE%"
) else (
    echo   [WARNING] Sudo AI extension not found at:
    echo             %EXT%\extension.js
    echo   [WARNING] Extension missing - Sudo Studio will open without Sudo AI >> "%LOG_FILE%"
)

echo.
echo [STEP 2] All required files verified.
echo [PHASE 1] All files OK >> "%LOG_FILE%"
echo.

:: ============================================================
::  PHASE 2 - LAUNCH AI RUNTIME (port 6000) (STEP 3)
:: ============================================================
echo [STEP 3] Starting AI Runtime on port %RUNTIME_PORT%...
echo          (TinyLlama 2.1GB - first load 3-5 min. Waiting up to 10 min.)
echo [PHASE 2] Launching runtime.exe on port %RUNTIME_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing runtime on port 6000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch runtime.exe in a minimized window
start "SudoRuntime" /MIN "%APP%runtime.exe"
echo [PHASE 2] runtime.exe launched >> "%LOG_FILE%"
echo   [LAUNCHED] runtime.exe -> port %RUNTIME_PORT%
echo.

:: -- Poll port 6000 every 3s, timeout 600s (10 min for 2GB model load) --
set "RUNTIME_READY=0"
set "RUNTIME_WAIT=0"

:wait_runtime
    set /a RUNTIME_WAIT+=1
    if !RUNTIME_WAIT! gtr 200 goto :runtime_timeout
    timeout /t 3 /nobreak >nul

    :: Try curl first (faster)
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

    :: Print progress every 15 seconds
    set /a RUNTIME_ELAPSED=RUNTIME_WAIT*3
    set /a RUNTIME_MOD=RUNTIME_ELAPSED %% 15
    if !RUNTIME_MOD! equ 0 (
        echo   [AI Loading] !RUNTIME_ELAPSED!s elapsed - TinyLlama loading... ^(up to 600s^)
        echo   [AI Loading] !RUNTIME_ELAPSED!s >> "%LOG_FILE%"
    )
    goto :wait_runtime

:runtime_timeout
    echo.
    echo   [WAIT] 600s elapsed. runtime.exe is STILL RUNNING and loading the model.
    echo   [WAIT] Sudo Studio will open now. Chat will work once model finishes loading.
    echo   [WAIT] Watch SudoRuntime window for: Model Ready on cpu
    echo [PHASE 2] 600s timeout - runtime still loading >> "%LOG_FILE%"
    goto :runtime_done

:runtime_ok
    echo   [OK] AI Runtime ready on port %RUNTIME_PORT%
    echo [PHASE 2] Runtime ready on port %RUNTIME_PORT% >> "%LOG_FILE%"

:runtime_done
echo.

:: ============================================================
::  PHASE 3 - LAUNCH BACKEND (port 5000) (STEP 4)
:: ============================================================
echo [STEP 4] Starting Backend on port %BACKEND_PORT%...
echo [PHASE 3] Launching backend.exe on port %BACKEND_PORT% >> "%LOG_FILE%"
echo.

:: Kill any existing backend on port 5000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Launch backend.exe in a minimized window
start "SudoBackend" /MIN "%APP%backend.exe"
echo [PHASE 3] backend.exe launched >> "%LOG_FILE%"
echo   [LAUNCHED] backend.exe -> port %BACKEND_PORT%
echo.

:: -- Poll port 5000 every 2 seconds, timeout 60s --
set "BACKEND_READY=0"
set "BACKEND_WAIT=0"

:wait_backend
    set /a BACKEND_WAIT+=1
    if !BACKEND_WAIT! gtr 30 goto :backend_timeout
    timeout /t 2 /nobreak >nul

    :: Try curl first
    curl -s -o nul -w "%%{http_code}" http://localhost:%BACKEND_PORT%/api/system/health 2>nul | findstr /B "200" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    :: Fallback: PowerShell
    powershell -NoProfile -WindowStyle Hidden -Command "try{$r=(Invoke-WebRequest -Uri 'http://localhost:%BACKEND_PORT%/api/system/health' -TimeoutSec 2 -UseBasicParsing -EA Stop).StatusCode;if($r -eq 200){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 (
        set "BACKEND_READY=1"
        goto :backend_ok
    )

    echo   Waiting for Backend... !BACKEND_WAIT! / 30
    goto :wait_backend

:backend_timeout
    echo.
    echo   [ERROR] Backend did not respond after 60 seconds - opening the editor WITHOUT backend.
    echo   [ERROR] Backend timeout - editor opening WITHOUT backend >> "%LOG_FILE%"
    echo   [ERROR] Diagnose: %LOGS%\backend.log and http://localhost:%BACKEND_PORT%/api/system/health
    echo.
    goto :backend_done

:backend_ok
    echo   [OK] Backend ready on port %BACKEND_PORT%
    echo [PHASE 3] Backend ready on port %BACKEND_PORT% >> "%LOG_FILE%"

:backend_done
echo.

:: ============================================================
::  PHASE 4 - HEALTH CHECK SUMMARY (STEP 5)
:: ============================================================
echo [PHASE 4] Health check summary >> "%LOG_FILE%"
echo [STEP 5] Services running:
echo   Runtime  : port 6000
echo   Backend  : port 5000
echo [PHASE 4] Done >> "%LOG_FILE%"
echo.

:: ============================================================
::  PHASE 5 - LAUNCH VSCODIUM + SUDO AI EXTENSION (STEP 6)
:: ============================================================
echo DEBUG PHASE 5 START >> "%LOG_FILE%"
echo [STEP 6] Opening Sudo Studio (Editor + Sudo AI)...
echo [PHASE 5] Preparing Sudo Studio... >> "%LOG_FILE%"
echo.

:: V_EXE already set in Global Variables section — no re-detection needed.
echo [PHASE 5] Editor exe: %V_EXE% >> "%LOG_FILE%"
:: P35(c): user-data + extensions live in %LOCALAPPDATA%\SudoStudio (never install).
set "V_EXT=%SSDATA%\extensions"
set "V_DAT=%SSDATA%\userdata"
set "V_SRC=%ROOT%sudo-ai-extension"
set "V_DEV=%SSDATA%\extensions\sudo-ai"
:: Shipped read-only master (packager STEP 12).
set "V_MASTER=%ROOT%extensions\sudo-ai"

:: Creer dossiers necessaires
if not exist "%V_DAT%" mkdir "%V_DAT%" 2>nul
if not exist "%V_EXT%" mkdir "%V_EXT%" 2>nul
if not exist "%V_DAT%\User" mkdir "%V_DAT%\User" 2>nul
:: P35(c): one-way migration of pre-P35 user-data (copy-only, never delete).
if exist "%ROOT%data\User\settings.json" if not exist "%V_DAT%\User\settings.json" xcopy /S /E /Y /Q /I "%ROOT%data" "%V_DAT%\" >nul 2>&1
if not exist "%V_DEV%\package.json" if exist "%ROOT%extensions" xcopy /S /E /Y /Q /I "%ROOT%extensions" "%V_EXT%\" >nul 2>&1

:: -- Seed default settings on FIRST run only (never overwrite user settings) --
:: The custom titlebar shows no product name by default ("Welcome" only), so
:: seed an explicit window title ending with Sudo Studio.
if not exist "%V_DAT%\User\settings.json" (
    echo {"window.title": "${dirty}${activeEditorShort}${separator}${rootName}${separator}Sudo Studio"}>"%V_DAT%\User\settings.json"
    echo [PHASE 5] Default settings seeded - window title set
)

:: -- Sync extension to extensions\sudo-ai (production mode, no [Extension Development Host]) --
:: This replaces --extensionDevelopmentPath (dev/debug mode) with proper extension installation.
:: Copy sudo-ai-extension/ -> extensions\sudo-ai/ so VSCodium loads it as a real extension.
:: P29(c): installed layout ships the extension directly at extensions\sudo-ai
:: (packager STEP 12). The ROOT\sudo-ai-extension source copy exists only in
:: dev layouts. Test installed-first; sync only when source exists and target
:: is missing; otherwise fail LOUD with both expected paths (no silent skip).
set "EXT_HAVE_MASTER=0"
set "EXT_HAVE_LIVE=0"
set "EXT_HAVE_SRC=0"
if exist "%V_MASTER%\package.json" set "EXT_HAVE_MASTER=1"
if exist "%V_DEV%\package.json" set "EXT_HAVE_LIVE=1"
if exist "%V_SRC%\package.json" set "EXT_HAVE_SRC=1"
if "%EXT_HAVE_LIVE%"=="1" if "%EXT_HAVE_MASTER%"=="1" (
    echo [PHASE 5] Refreshing live extension from shipped master...
    xcopy /S /E /Y /D /Q /I "%V_MASTER%" "%V_DEV%\" >nul 2>&1
    echo   [OK] Extension live at %V_DEV%
    echo   [OK] Extension refreshed >> "%LOG_FILE%"
)
if "%EXT_HAVE_LIVE%"=="0" if "%EXT_HAVE_MASTER%"=="1" (
    echo [PHASE 5] Installing extension to live dir...
    echo [PHASE 5] Installing extension >> "%LOG_FILE%"
    if not exist "%V_DEV%" mkdir "%V_DEV%" 2>nul
    xcopy /S /E /Y /Q /I "%V_MASTER%" "%V_DEV%\" >nul 2>&1
    echo   [OK] Extension installed at %V_DEV%
    echo   [OK] Extension installed >> "%LOG_FILE%"
)
if "%EXT_HAVE_LIVE%"=="0" if "%EXT_HAVE_MASTER%"=="0" if "%EXT_HAVE_SRC%"=="1" (
    echo [PHASE 5] Syncing extension from dev source...
    echo [PHASE 5] Syncing extension (dev) >> "%LOG_FILE%"
    if not exist "%V_DEV%" mkdir "%V_DEV%" 2>nul
    xcopy /S /E /Y /Q /I "%V_SRC%" "%V_DEV%\" >nul 2>&1
    echo   [OK] Extension synced to %V_DEV%
    echo   [OK] Extension synced (dev) >> "%LOG_FILE%"
)
if "%EXT_HAVE_LIVE%"=="1" if "%EXT_HAVE_MASTER%"=="0" (
    echo   [OK] Extension live at %V_DEV% (dev)
    echo   [OK] Extension live (dev) >> "%LOG_FILE%"
)
if "%EXT_HAVE_LIVE%"=="0" if "%EXT_HAVE_MASTER%"=="0" if "%EXT_HAVE_SRC%"=="0" (
    echo   [ERROR] No extension found - Sudo AI will NOT load.
    echo   [ERROR] Looked for: %V_MASTER%\package.json, %V_DEV%\package.json and %V_SRC%\package.json
    echo   [ERROR] Reinstall Sudo Studio. Full log: %LOG_FILE%
    echo   [ERROR] Extension missing (both paths) >> "%LOG_FILE%"
)

:: Confirm V_EXE still valid (belt-and-suspenders, should always be set)
if not defined V_EXE (
    echo [FATAL] V_EXE undefined at launch time >> "%LOG_FILE%"
    echo [FATAL] Editor path not set - cannot launch.
    echo Editor path not set - cannot launch>>"%LOGS%\startup-errors.txt"
    pause
    exit /b 1
)
if not exist "%V_EXE%" (
    echo [FATAL] Editor not found at: %V_EXE% >> "%LOG_FILE%"
    echo [FATAL] Editor not found at: %V_EXE%
    echo Editor not found - reinstall Sudo Studio>>"%LOGS%\startup-errors.txt"
    pause
    exit /b 1
)
echo [PHASE 5] Launching: %V_EXE% >> "%LOG_FILE%"

:: Ecrire un script de lancement propre (bloc parenthese - seule methode sans corruption)
set "LAUNCHER=%SSDATA%\launch.bat"
(
    echo @echo off
    echo start "" "%V_EXE%" --extensions-dir "%V_EXT%" --user-data-dir "%V_DAT%"
) > "%LAUNCHER%"

:: Lancer via le script propre
echo [PHASE 5] Launching via launcher... >> "%LOG_FILE%"
call "%LAUNCHER%"

:: Attendre et verifier
timeout /t 5 /nobreak >nul
tasklist 2>nul | findstr /I "SudoStudio VSCodium" >nul 2>&1
if not errorlevel 1 (
    echo [PHASE 5] Sudo Studio running OK >> "%LOG_FILE%"
    echo   [OK] Sudo Studio is running
) else (
    echo [PHASE 5] Sudo Studio not detected >> "%LOG_FILE%"
    echo   [WARNING] Sudo Studio may have closed
)

echo.

:: ============================================================
::  PHASE 6 - EXTENSION VERIFICATION (STEP 7)
:: ============================================================
echo [STEP 7] Extension Verification:
set "FOUND_P6_JS=0"
if exist "%EXT%\extension.js" set "FOUND_P6_JS=1"
if "%FOUND_P6_JS%"=="1" (
    echo   [OK] extension.js present
) else (
    echo   [WARN] extension.js not found - Sudo AI features unavailable
)
set "FOUND_P6_JSON=0"
if exist "%EXT%\package.json" set "FOUND_P6_JSON=1"
if "%FOUND_P6_JSON%"=="1" (
    echo   [OK] package.json present
) else (
    echo   [WARN] package.json not found
)
set "FOUND_P6_SRC=0"
if exist "%EXT%\src" set "FOUND_P6_SRC=1"
if "%FOUND_P6_SRC%"=="1" (
    echo   [OK] src\ directory present
) else (
    echo   [WARN] src\ directory not found
)
echo.

:: ============================================================
::  ALL SERVICES RUNNING
:: ============================================================
echo [DONE] >> "%LOG_FILE%"
echo %DATE% %TIME% - ALL SERVICES STARTED >> "%LOG_FILE%"
echo.
echo ============================================================
echo   SUDO STUDIO IS RUNNING
echo ============================================================
echo.
echo   Backend   : http://localhost:%BACKEND_PORT%
echo   AI Runtime: http://localhost:%RUNTIME_PORT%
echo.
echo   Logs      : %LOGS%\startup.log
echo   AI journal : %LOGS%\runtime.log
echo.
echo   Sudo Studio should now be opening with Sudo AI loaded.
    echo   If Sudo Studio is not open yet, wait 5-10 seconds.
echo.
echo ============================================================
echo   Closing the editor stops Backend + Runtime automatically.
echo   This window closes itself once everything has stopped.
echo ============================================================
echo.

:: -- P29(c): monitor the editor main process; on close, stop our children --
:: Editor-main = process whose command line carries OUR --extensions-dir path.
:: (Plain tasklist matching would also match agent nodes and VS Code helpers,
:: which share the SudoStudio.exe image name.)
:: Cleanup kills ONLY processes whose exe lives under this install dir.
set "MON_SEEN=0"
set "MON_WAIT=0"
echo [MONITOR] Waiting for the editor main process...
:mon_appear
powershell -NoProfile -WindowStyle Hidden -Command "try { $p1 = '--extensions' + '-dir'; $hit = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $p1 + '*') -and $_.CommandLine -like ('*' + $env:V_EXT + '*') }; if ($hit) { exit 0 } else { exit 1 } } catch { exit 0 }" >nul 2>&1
if !errorlevel! equ 0 (
    set "MON_SEEN=1"
    echo [MONITOR] Editor detected - watching. Close the editor to stop everything.
    echo [MONITOR] Editor detected >> "%LOG_FILE%"
    goto :mon_loop
)
set /a MON_WAIT+=1
if !MON_WAIT! gtr 24 goto :mon_never
timeout /t 5 /nobreak >nul
goto :mon_appear
:mon_never
echo [WARN] Editor main process not appeared yet - services running, still watching.
echo [WARN] Editor not yet appeared, still watching >> "%LOG_FILE%"
set "MON_WAIT=0"
goto :mon_appear
:mon_loop
timeout /t 10 /nobreak >nul
powershell -NoProfile -WindowStyle Hidden -Command "try { $p1 = '--extensions' + '-dir'; $hit = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $p1 + '*') -and $_.CommandLine -like ('*' + $env:V_EXT + '*') }; if ($hit) { exit 0 } else { exit 1 } } catch { exit 0 }" >nul 2>&1
if !errorlevel! equ 0 goto :mon_loop
echo.
echo [STOP] Editor closed - stopping Sudo Studio services...
echo [STOP] Editor closed - cleanup >> "%LOG_FILE%"
powershell -NoProfile -WindowStyle Hidden -Command "$r='%ROOT%'; $names=('backend.exe','runtime.exe','SudoStudio.exe','VSCodium.exe'); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($r + '*') -and ($names -contains $_.Name) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -EA Stop } catch {} }" >nul 2>&1
timeout /t 3 /nobreak >nul
powershell -NoProfile -WindowStyle Hidden -Command "$r='%ROOT%'; $names=('backend.exe','runtime.exe','SudoStudio.exe','VSCodium.exe'); $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($r + '*') -and ($names -contains $_.Name) }).Count; exit $left" >nul 2>&1
if !errorlevel! equ 0 (
    echo   [OK] All Sudo Studio processes stopped. Log: %LOG_FILE%
    echo [STOP] Cleanup done - 0 remaining >> "%LOG_FILE%"
) else (
    echo   [WARN] !errorlevel! process(es) still alive - kill them manually or reboot.
    echo   [WARN] Cleanup incomplete: !errorlevel! remaining >> "%LOG_FILE%"
)
timeout /t 3 /nobreak >nul
exit /b 0

:: -- Fallback: editor never started; keep services up until window closes --
:keep_alive
timeout /t 30 /nobreak >nul
goto :keep_alive
