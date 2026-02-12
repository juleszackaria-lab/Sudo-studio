#!/bin/bash
set -e

echo "=== Sudo-studio Setup & Launch Script ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Backend Node.js setup
echo -e "${BLUE}[1/4] Setting up Node.js backend...${NC}"
cd backend
if [ ! -d "node_modules" ]; then
  npm install --no-audit --no-fund
else
  echo "Node modules already installed"
fi
cd ..

# Step 2: Python runtime setup
echo -e "${BLUE}[2/4] Setting up Python runtime...${NC}"
cd backend/runtime
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
  else
    source .venv/Scripts/activate 2>/dev/null || true
  fi
  pip install --upgrade pip
  pip install -r requirements.txt
else
  echo "Virtual environment already exists"
  if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
  else
    source .venv/Scripts/activate 2>/dev/null || true
  fi
fi
cd ../..

# Step 3: Verify setup
echo -e "${BLUE}[3/4] Verifying setup...${NC}"
cd backend
node -e "const m = require('./ai/aiModelsManager.js'); console.log('✓ Backend modules OK');"
cd ..

cd backend/runtime
python3 -c "import flask; import transformers; print('✓ Python dependencies OK')"
cd ../..

# Step 4: Ready to launch
echo -e "${GREEN}[4/4] Setup complete!${NC}"
echo ""
echo -e "${YELLOW}To start the backend, run:${NC}"
echo "  cd backend && npm run dev"
echo ""
echo -e "${YELLOW}To start a Python model server in another terminal, run:${NC}"
echo "  cd backend/runtime"
echo "  source .venv/bin/activate  # or .venv/Scripts/activate on Windows"
echo "  python server.py --model gpt2 --port 6000"
echo ""
echo -e "${YELLOW}Then open the web UI:${NC}"
echo "  http://localhost:5000/ui/index.html"
echo ""
