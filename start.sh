#!/usr/bin/env bash
# ============================================================
#   SUDO STUDIO v2.1 - Démarrage automatique Linux/Mac
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
RUNTIME_DIR="$SCRIPT_DIR/backend/runtime"
BACKEND_PORT=5000
RUNTIME_PORT=6000
LOGS_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOGS_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "============================================================"
echo "  SUDO STUDIO v2.1 - Démarrage automatique"
echo "============================================================"
echo ""

# ─── Étape 1: Vérification Python ───────────────────────────
echo -e "[1/6] Vérification Python..."
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
    PYTHON_VER=$(python3 --version 2>&1)
    echo -e "    ${GREEN}$PYTHON_VER détecté OK${NC}"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
    PYTHON_VER=$(python --version 2>&1)
    echo -e "    ${GREEN}$PYTHON_VER détecté OK${NC}"
else
    echo -e "    ${YELLOW}Python non trouvé - installation automatique...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            brew install python@3.11
        else
            echo -e "    ${YELLOW}Installation Homebrew d'abord...${NC}"
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            brew install python@3.11
        fi
        PYTHON_CMD="python3"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get &> /dev/null; then
            sudo apt-get update -qq
            sudo apt-get install -y python3 python3-pip python3-venv
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y python3 python3-pip
        elif command -v yum &> /dev/null; then
            sudo yum install -y python3 python3-pip
        elif command -v pacman &> /dev/null; then
            sudo pacman -S --noconfirm python python-pip
        fi
        PYTHON_CMD="python3"
    else
        echo -e "    ${RED}[ERREUR] OS non supporté. Installez Python 3.11+ manuellement.${NC}"
        exit 1
    fi
    
    if ! command -v "$PYTHON_CMD" &> /dev/null; then
        echo -e "    ${RED}[ERREUR] Python toujours non accessible après installation.${NC}"
        exit 1
    fi
    echo -e "    ${GREEN}Python installé avec succès!${NC}"
fi

# ─── Étape 2: Vérification Node.js ──────────────────────────
echo -e "[2/6] Vérification Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "    ${YELLOW}Node.js non trouvé - installation automatique...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install node@18
        export PATH="/opt/homebrew/opt/node@18/bin:$PATH"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Install Node 18 LTS via NodeSource
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    echo -e "    ${GREEN}Node.js installé!${NC}"
else
    NODE_VER=$(node --version 2>&1)
    echo -e "    ${GREEN}Node.js $NODE_VER détecté OK${NC}"
fi

# ─── Étape 3: Installation dépendances Python IA ────────────
echo -e "[3/6] Installation des dépendances Python IA..."
echo "    (torch CPU ~180MB, transformers, flask, accelerate...)"
PIP_CMD=""
if command -v pip3 &> /dev/null; then
    PIP_CMD="pip3"
elif command -v pip &> /dev/null; then
    PIP_CMD="pip"
else
    $PYTHON_CMD -m ensurepip --upgrade 2>/dev/null || true
    PIP_CMD="$PYTHON_CMD -m pip"
fi

$PIP_CMD install -q -r "$RUNTIME_DIR/requirements.txt" --no-warn-script-location 2>&1 | tail -5 || {
    echo -e "    ${YELLOW}[AVERTISSEMENT] Tentative d'installation individuelle...${NC}"
    $PIP_CMD install -q flask flask-cors psutil requests accelerate sentencepiece
    $PIP_CMD install -q torch --index-url https://download.pytorch.org/whl/cpu
    $PIP_CMD install -q transformers
}
echo -e "    ${GREEN}Dépendances Python OK${NC}"

# ─── Étape 4: Installation dépendances Node.js ──────────────
echo -e "[4/6] Installation des dépendances Node.js..."
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo "    Installation npm..."
    cd "$BACKEND_DIR" && npm install --no-audit --no-fund -q
    cd "$SCRIPT_DIR"
else
    echo -e "    ${GREEN}node_modules déjà présents${NC}"
fi

# ─── Étape 5: Démarrage Backend Node.js ─────────────────────
echo -e "[5/6] Démarrage du backend Node.js (port $BACKEND_PORT)..."
cd "$BACKEND_DIR"
NODE_ENV=development node server.js > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo $BACKEND_PID > "$LOGS_DIR/backend.pid"
cd "$SCRIPT_DIR"

# Poll port 5000 — up to 30 seconds
echo "    Attente du backend..."
BACKEND_READY=0
for i in $(seq 1 30); do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$BACKEND_PORT/api/system/health" 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" =~ ^(200|401|403)$ ]]; then
        BACKEND_READY=1
        break
    fi
done

if [ $BACKEND_READY -eq 1 ]; then
    echo -e "    ${GREEN}Backend OK - port $BACKEND_PORT répond${NC}"
else
    echo -e "    ${YELLOW}[AVERTISSEMENT] Backend lent à démarrer (continue...)${NC}"
fi

# ─── Étape 6: Démarrage Runtime Python IA ───────────────────
echo -e "[6/6] Démarrage du runtime Python IA (port $RUNTIME_PORT)..."
cd "$RUNTIME_DIR"
$PYTHON_CMD server.enterprise.py --port $RUNTIME_PORT > "$LOGS_DIR/runtime.log" 2>&1 &
RUNTIME_PID=$!
echo $RUNTIME_PID > "$LOGS_DIR/runtime.pid"
cd "$SCRIPT_DIR"

# Poll port 6000 — up to 60 seconds
echo "    Attente du runtime IA..."
RUNTIME_READY=0
for i in $(seq 1 60); do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$RUNTIME_PORT/health" 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "200" ]]; then
        RUNTIME_READY=1
        break
    fi
done

if [ $RUNTIME_READY -eq 1 ]; then
    echo -e "    ${GREEN}Runtime IA OK - port $RUNTIME_PORT répond${NC}"
else
    echo -e "    ${YELLOW}[AVERTISSEMENT] Runtime IA lent à démarrer (téléchargement modèle en cours...)${NC}"
fi

# ─── Résumé ──────────────────────────────────────────────────
echo ""
echo "============================================================"
echo -e "  ${GREEN}SUDO STUDIO DÉMARRÉ${NC}"
echo "============================================================"
echo "  Backend Node.js  : http://localhost:$BACKEND_PORT"
echo "  Runtime Python IA: http://localhost:$RUNTIME_PORT"
echo "  Logs backend     : logs/backend.log (PID: $BACKEND_PID)"
echo "  Logs runtime     : logs/runtime.log (PID: $RUNTIME_PID)"
echo "============================================================"
echo ""
echo "Ouvrez VSCodium pour utiliser Sudo Studio."
echo "Appuyez sur Ctrl+C pour arrêter tous les services."
echo ""

# Fonction de nettoyage à la fermeture
cleanup() {
    echo ""
    echo "Arrêt de Sudo Studio..."
    [ -n "$BACKEND_PID" ] && kill $BACKEND_PID 2>/dev/null && echo "  Backend arrêté (PID $BACKEND_PID)"
    [ -n "$RUNTIME_PID" ] && kill $RUNTIME_PID 2>/dev/null && echo "  Runtime IA arrêté (PID $RUNTIME_PID)"
    exit 0
}
trap cleanup SIGINT SIGTERM

# Attente infinie (les services tournent en arrière-plan)
wait
