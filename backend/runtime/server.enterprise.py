#!/usr/bin/env python3
"""
SUDO STUDIO - AI RUNTIME SERVER v2.1
Auto-downloads a model on first start, serves /health and /infer endpoints.
Includes RAM pre-check, graceful OOM handling, and psutil metrics.
"""

import sys, os, json, logging, time, threading, gc
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

# ─── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger('sudo-runtime')

# ─── App ────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ─── State ──────────────────────────────────────────────────────────────────────
class State:
    model = None
    tokenizer = None
    model_name = None
    loaded = False
    loading = False
    error = None
    device = 'cpu'
    download_progress = 0   # 0-100
    startup_time = time.time()
    requests = 0

state = State()

# ─── Model config ───────────────────────────────────────────────────────────────
DEFAULT_MODEL = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"
MODELS_DIR = Path(os.path.expanduser("~")) / ".sudo_studio" / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Minimum RAM required per model (in GB)
MODEL_RAM_REQUIREMENTS = {
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0":        2.5,
    "deepseek-ai/deepseek-coder-1.3b-instruct":   3.0,
    "meta-llama/Llama-3.2-1B-Instruct":           2.5,
    "Qwen/Qwen2.5-Coder-1.5B-Instruct":           3.5,
    "microsoft/phi-2":                             6.0,
    "mistralai/Mistral-7B-Instruct-v0.2":          16.0,
}

# ─── RAM helpers ────────────────────────────────────────────────────────────────
def get_available_ram_gb() -> float:
    """Return available RAM in GB."""
    try:
        with open('/proc/meminfo') as f:
            info = dict(line.split()[:2] for line in f if len(line.split()) >= 2)
        return int(info.get('MemAvailable:', 0)) / 1024 / 1024
    except Exception:
        pass
    try:
        import psutil
        return psutil.virtual_memory().available / 1e9
    except Exception:
        pass
    # Windows fallback via ctypes
    try:
        import ctypes
        class MEMSTATUS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        ms = MEMSTATUS()
        ms.dwLength = ctypes.sizeof(MEMSTATUS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        return ms.ullAvailPhys / 1e9
    except Exception:
        return 4.0  # assume 4GB if we can't detect

def get_total_ram_gb() -> float:
    """Return total RAM in GB."""
    try:
        with open('/proc/meminfo') as f:
            info = dict(line.split()[:2] for line in f if len(line.split()) >= 2)
        return int(info.get('MemTotal:', 0)) / 1024 / 1024
    except Exception:
        pass
    try:
        import psutil
        return psutil.virtual_memory().total / 1e9
    except Exception:
        return 4.0

def check_ram_for_model(model_id: str) -> tuple:
    """Returns (ok: bool, available_gb: float, required_gb: float, message: str)."""
    required = MODEL_RAM_REQUIREMENTS.get(model_id, 3.0)
    available = get_available_ram_gb()
    if available < required:
        msg = (f"Insufficient RAM: {available:.1f}GB available, "
               f"{required:.1f}GB required for {model_id}. "
               f"Close other applications or use a smaller model.")
        return False, available, required, msg
    return True, available, required, "OK"

# ─── Model loading ──────────────────────────────────────────────────────────────
def load_model_thread(model_id: str):
    """Load or download model in background thread."""
    state.loading = True
    state.error = None
    state.download_progress = 0
    logger.info(f"[MODEL] Starting load: {model_id}")

    try:
        # Pre-check RAM before attempting load
        ok, avail, req, msg = check_ram_for_model(model_id)
        if not ok:
            logger.warning(f"[MODEL] RAM warning: {msg}")
            # Don't abort — Windows has page file, may still work
            # But warn the user via state.error
            state.error = f"Low RAM ({avail:.1f}GB available, {req:.1f}GB recommended). Loading anyway..."

        from transformers import AutoTokenizer, AutoModelForCausalLM
        import torch

        state.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        logger.info(f"[MODEL] Device: {state.device}")

        cache_dir = str(MODELS_DIR)
        state.download_progress = 10
        logger.info(f"[MODEL] Loading tokenizer (cache: {cache_dir})...")

        tokenizer = AutoTokenizer.from_pretrained(
            model_id,
            cache_dir=cache_dir,
            trust_remote_code=True
        )
        state.download_progress = 40
        logger.info("[MODEL] Tokenizer loaded. Loading weights...")

        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            cache_dir=cache_dir,
            torch_dtype=torch.float16 if state.device == 'cuda' else torch.float32,
            low_cpu_mem_usage=True,
            trust_remote_code=True
        )
        state.download_progress = 80
        logger.info(f"[MODEL] Weights loaded. Moving to {state.device}...")

        model = model.to(state.device)
        model.eval()

        state.tokenizer = tokenizer
        state.model = model
        state.model_name = model_id
        state.loaded = True
        state.error = None   # clear any pre-load warning
        state.download_progress = 100
        logger.info(f"[MODEL] ✅ Ready: {model_id} on {state.device}")

    except MemoryError as e:
        avail = get_available_ram_gb()
        state.error = f"Out of memory ({avail:.1f}GB available). Free RAM and retry, or use a smaller model."
        state.loading = False
        state.download_progress = 0
        logger.error(f"[MODEL] ❌ OOM loading {model_id}: {e}")
        logger.info("[MODEL] Falling back to mock mode")
        # Force GC to recover memory
        gc.collect()

    except Exception as e:
        state.error = str(e)
        state.loading = False
        state.download_progress = 0
        logger.error(f"[MODEL] ❌ Failed to load {model_id}: {e}")
        logger.info("[MODEL] Falling back to mock mode - all requests will return mock responses")
        gc.collect()

    finally:
        state.loading = False


def start_model_load(model_id: str = DEFAULT_MODEL):
    t = threading.Thread(target=load_model_thread, args=(model_id,), daemon=True)
    t.start()


# ─── Inference ──────────────────────────────────────────────────────────────────
def run_inference(prompt: str, max_tokens: int = 256, temperature: float = 0.7) -> dict:
    """Run inference, returns dict with 'reply' key."""
    start = time.time()

    if not state.loaded or state.model is None:
        mock_reply = generate_mock_reply(prompt)
        return {
            "reply": mock_reply,
            "mock": True,
            "model": "mock",
            "latency_ms": int((time.time() - start) * 1000),
            "tokens": len(mock_reply.split())
        }

    try:
        import torch
        inputs = state.tokenizer(prompt, return_tensors="pt").to(state.device)
        input_len = inputs['input_ids'].shape[1]

        with torch.no_grad():
            output = state.model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=temperature,
                do_sample=temperature > 0,
                pad_token_id=state.tokenizer.eos_token_id,
                eos_token_id=state.tokenizer.eos_token_id,
            )

        new_tokens = output[0][input_len:]
        reply = state.tokenizer.decode(new_tokens, skip_special_tokens=True).strip()

        if not reply:
            reply = "I understand your question. Let me help you with that."

        latency = int((time.time() - start) * 1000)
        token_count = len(new_tokens)

        return {
            "reply": reply,
            "mock": False,
            "model": state.model_name,
            "latency_ms": latency,
            "tokens": token_count
        }

    except MemoryError:
        gc.collect()
        return {
            "reply": "Out of memory during inference. Try freeing RAM or using a smaller model.",
            "mock": True,
            "model": state.model_name,
            "latency_ms": int((time.time() - start) * 1000),
            "tokens": 0,
            "error": "OOM"
        }
    except Exception as e:
        logger.error(f"[INFER] Error: {e}")
        return {
            "reply": f"Inference error: {str(e)}",
            "mock": True,
            "model": state.model_name,
            "latency_ms": int((time.time() - start) * 1000),
            "tokens": 0,
            "error": str(e)
        }


def generate_mock_reply(prompt: str) -> str:
    """Generate a helpful mock reply while the model loads."""
    p = prompt.lower()
    if any(w in p for w in ['bonjour', 'salut', 'hello', 'hi', 'hey']):
        return "Bonjour ! Je suis Sudo AI. Le modèle IA est en cours de chargement (~600MB). En attendant, je peux vous répondre en mode basique. Comment puis-je vous aider ?"
    if any(w in p for w in ['code', 'function', 'class', 'def ', 'var ', 'const ']):
        return "Je détecte une question sur du code. Le modèle IA complet est en cours de chargement. Une fois chargé, je pourrai analyser et améliorer votre code en détail."
    if any(w in p for w in ['error', 'erreur', 'bug', 'fix', 'broken']):
        return "Je vois un problème à résoudre. Le modèle IA se charge pour vous donner une réponse précise. Vérifiez les logs et assurez-vous que toutes les dépendances sont installées."
    if any(w in p for w in ['docker', 'container', 'kubernetes', 'deploy']):
        return "Question sur le déploiement. Je peux générer des Dockerfiles et configurations CI/CD via les commandes DevOps dans la sidebar."
    return (f"⚙️ Modèle IA en chargement ({state.download_progress}%)...\n\n"
            f"Votre message a bien été reçu. Une fois le modèle chargé, vous aurez des réponses IA complètes.\n\n"
            f"En attendant, utilisez les commandes dans la sidebar : System Doctor, SDK Manager, DevOps.")


# ─── Routes ─────────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    avail_ram = get_available_ram_gb()
    total_ram = get_total_ram_gb()
    return jsonify({
        "status": "healthy",
        "uptime_seconds": int(time.time() - state.startup_time),
        "model": {
            "loaded": state.loaded,
            "loading": state.loading,
            "name": state.model_name or DEFAULT_MODEL,
            "device": state.device,
            "download_progress": state.download_progress,
            "error": state.error
        },
        "system": {
            "ram_available_gb": round(avail_ram, 2),
            "ram_total_gb": round(total_ram, 2),
            "ram_sufficient": avail_ram >= MODEL_RAM_REQUIREMENTS.get(DEFAULT_MODEL, 2.5)
        },
        "requests_served": state.requests,
        "mock_mode": not state.loaded
    })


@app.route('/infer', methods=['POST'])
def infer():
    state.requests += 1
    data = request.get_json(force=True, silent=True) or {}

    prompt = (
        data.get('message') or
        data.get('prompt') or
        data.get('input') or
        data.get('text') or
        ''
    ).strip()

    if not prompt:
        return jsonify({"error": "No prompt provided", "fields": ["message", "prompt", "input"]}), 400

    max_tokens = min(int(data.get('max_tokens', 256)), 512)
    temperature = float(data.get('temperature', 0.7))

    result = run_inference(prompt, max_tokens, temperature)
    return jsonify(result)


@app.route('/chat', methods=['POST'])
def chat():
    """Alias for /infer with chat format."""
    return infer()


@app.route('/models', methods=['GET'])
def models():
    avail = get_available_ram_gb()
    available_models = [
        {"id": "TinyLlama/TinyLlama-1.1B-Chat-v1.0",       "name": "TinyLlama 1.1B (Default)", "size": "~600MB", "ram_required_gb": 2.5, "can_load": avail >= 2.5},
        {"id": "deepseek-ai/deepseek-coder-1.3b-instruct",  "name": "DeepSeek Coder 1.3B",      "size": "~1.3GB", "ram_required_gb": 3.0, "can_load": avail >= 3.0},
        {"id": "meta-llama/Llama-3.2-1B-Instruct",          "name": "Llama 3.2 1B",             "size": "~1.2GB", "ram_required_gb": 2.5, "can_load": avail >= 2.5},
        {"id": "Qwen/Qwen2.5-Coder-1.5B-Instruct",         "name": "Qwen2.5 Coder 1.5B",       "size": "~1.5GB", "ram_required_gb": 3.5, "can_load": avail >= 3.5},
        {"id": "microsoft/phi-2",                           "name": "Phi-2 2.7B",               "size": "~2.7GB", "ram_required_gb": 6.0, "can_load": avail >= 6.0},
        {"id": "mistralai/Mistral-7B-Instruct-v0.2",       "name": "Mistral 7B",               "size": "~7GB",   "ram_required_gb": 16.0, "can_load": avail >= 16.0},
    ]
    return jsonify({
        "current": state.model_name or DEFAULT_MODEL,
        "loaded": state.loaded,
        "loading": state.loading,
        "download_progress": state.download_progress,
        "available": available_models,
        "system_ram_available_gb": round(avail, 2)
    })


@app.route('/reload', methods=['POST'])
def reload_model():
    data = request.get_json(silent=True) or {}
    model_id = data.get('model', DEFAULT_MODEL)

    # RAM pre-check
    ok, avail, req, msg = check_ram_for_model(model_id)
    if not ok:
        logger.warning(f"[RELOAD] {msg}")

    state.loaded = False
    state.model = None
    state.tokenizer = None
    gc.collect()
    start_model_load(model_id)
    return jsonify({"status": "reloading", "model": model_id,
                    "ram_available_gb": round(avail, 2), "ram_required_gb": req})


@app.route('/download', methods=['POST'])
def download_model():
    """Download/load a specific model."""
    data = request.get_json(silent=True) or {}
    model_id = data.get('model', DEFAULT_MODEL)

    if state.loading:
        return jsonify({"status": "already_loading", "model": state.model_name}), 409

    # RAM pre-check
    ok, avail, req, msg = check_ram_for_model(model_id)
    if not ok:
        logger.warning(f"[DOWNLOAD] {msg}")

    state.loaded = False
    state.model = None
    state.tokenizer = None
    gc.collect()
    start_model_load(model_id)
    return jsonify({
        "status": "downloading",
        "model": model_id,
        "ram_available_gb": round(avail, 2),
        "ram_required_gb": req,
        "ram_warning": None if ok else msg
    })


@app.route('/', methods=['GET'])
def index():
    return jsonify({
        "name": "Sudo Studio AI Runtime",
        "version": "2.1.0",
        "endpoints": ["/health", "/infer", "/chat", "/models", "/reload", "/download"],
        "model_status": "loaded" if state.loaded else ("loading" if state.loading else "not_loaded")
    })


# ─── Main ────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=6000)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--model', default=DEFAULT_MODEL)
    parser.add_argument('--no-auto-download', action='store_true',
                        help='Start without downloading model (mock mode only)')
    args = parser.parse_args()

    avail_ram = get_available_ram_gb()
    total_ram = get_total_ram_gb()

    print("=" * 60)
    print("  SUDO STUDIO - AI Runtime v2.1.0")
    print(f"  Port   : {args.port}")
    print(f"  Model  : {args.model}")
    print(f"  Cache  : {MODELS_DIR}")
    print(f"  RAM    : {avail_ram:.1f}GB available / {total_ram:.1f}GB total")
    print("=" * 60)

    if not args.no_auto_download:
        ok, avail, req, msg = check_ram_for_model(args.model)
        if ok:
            logger.info(f"[BOOT] RAM OK ({avail:.1f}GB available). Auto-downloading model...")
        else:
            logger.warning(f"[BOOT] RAM WARNING: {msg}")
            logger.info("[BOOT] Attempting to load anyway (page file may help on Windows)...")
        start_model_load(args.model)
    else:
        logger.info("[BOOT] Mock mode - no model will be loaded")

    app.run(host=args.host, port=args.port, debug=False, threaded=True)
