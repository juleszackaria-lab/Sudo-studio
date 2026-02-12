@echo off
REM Sudo-studio Setup & Launch Script for Windows

setlocal enabledelayedexpansion

echo ====================================
echo Sudo-studio Setup for Windows
echo ====================================
echo.

REM Step 1: Backend Node.js setup
echo [1/4] Setting up Node.js backend...
cd backend
if not exist "node_modules" (
  call npm install --no-audit --no-fund
) else (
  echo Node modules already installed
)
cd ..

REM Step 2: Python runtime setup
echo [2/4] Setting up Python runtime...
cd backend\runtime
if not exist ".venv" (
  python -m venv .venv
  call .venv\Scripts\activate.bat
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  echo Virtual environment already exists
  call .venv\Scripts\activate.bat
)
cd ..\..

REM Step 3: Verify setup
echo [3/4] Verifying setup...
cd backend
node -e "const m = require('./ai/aiModelsManager.js'); console.log('✓ Backend modules OK');"
cd ..

cd backend\runtime
python -c "import flask; import transformers; print('✓ Python dependencies OK')"
cd ..\..

REM Step 4: Ready to launch
echo [4/4] Setup complete!
echo.
echo To start the backend, run:
echo   cd backend
echo   npm run dev
echo.
echo To start a Python model server in another terminal, run:
echo   cd backend\runtime
echo   .venv\Scripts\activate.bat
echo   python server.py --model gpt2 --port 6000
echo.
echo Then open the web UI:
echo   http://localhost:5000/ui/index.html
echo.
pause
