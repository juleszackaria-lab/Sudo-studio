#!/usr/bin/env python3
"""
SUDO STUDIO - AI RUNTIME SERVER v2.2
Intelligent model detection: scans local cache BEFORE downloading.
Never re-downloads a model that is already present.

Boot logic:
  1. Scan ~/.sudo_studio/models + HF cache for existing compatible models
  2. If found → use it directly (no download)
  3. If multiple found → pick best (priority list)
  4. If found but corrupted → skip it, log why, download fresh copy
  5. Only if nothing valid found → download default model
  6. Idempotent: successive runs never create duplicates
"""

# ── OFFLINE MODE: force HuggingFace to load from local cache only ──────────
# Must be set BEFORE any transformers / huggingface_hub import.
# Prevents network calls on startup and avoids HF connection errors
# when running as a distributed runtime.exe with no internet access.
import os
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
# ───────────────────────────────────────────────────────────────────────────

import sys, os, json, logging, time, threading, gc, hashlib
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

# ─── Logging ────────────────────────────────────────────────────────────────────
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
    model        = None
    tokenizer    = None
    model_name   = None
    loaded       = False
    loading      = False
    error        = None
    device       = 'cpu'
    download_progress = 0   # 0-100
    startup_time = time.time()
    requests     = 0
    # NEW: detection result info
    detected_local = False   # True if model was found locally
    detection_log  = []      # Messages from the scan phase

state = State()

# ─── Model config ───────────────────────────────────────────────────────────────
DEFAULT_MODEL = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"

# Sudo Studio dedicated models directory
MODELS_DIR = Path(os.path.expanduser("~")) / ".sudo_studio" / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# State file: remembers which model was last validated
STATE_FILE = MODELS_DIR / "model_state.json"

# RAM requirements per model (GB)
MODEL_RAM_REQUIREMENTS = {
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0":       2.5,
    "deepseek-ai/deepseek-coder-1.3b-instruct":  3.0,
    "meta-llama/Llama-3.2-1B-Instruct":          2.5,
    "Qwen/Qwen2.5-Coder-1.5B-Instruct":          3.5,
    "microsoft/phi-2":                            6.0,
    "mistralai/Mistral-7B-Instruct-v0.2":         16.0,
}

# Priority order: lighter models first (better for test machines)
# A model present locally is always preferred over downloading
MODEL_PRIORITY = [
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
    "deepseek-ai/deepseek-coder-1.3b-instruct",
    "meta-llama/Llama-3.2-1B-Instruct",
    "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    "microsoft/phi-2",
    "mistralai/Mistral-7B-Instruct-v0.2",
]

# ─── RAM helpers ────────────────────────────────────────────────────────────────
def get_available_ram_gb() -> float:
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
    try:
        import ctypes
        class MEMSTATUS(ctypes.Structure):
            _fields_ = [("dwLength",              ctypes.c_ulong),
                        ("dwMemoryLoad",           ctypes.c_ulong),
                        ("ullTotalPhys",           ctypes.c_ulonglong),
                        ("ullAvailPhys",           ctypes.c_ulonglong),
                        ("ullTotalPageFile",       ctypes.c_ulonglong),
                        ("ullAvailPageFile",       ctypes.c_ulonglong),
                        ("ullTotalVirtual",        ctypes.c_ulonglong),
                        ("ullAvailVirtual",        ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual",ctypes.c_ulonglong)]
        ms = MEMSTATUS()
        ms.dwLength = ctypes.sizeof(MEMSTATUS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        return ms.ullAvailPhys / 1e9
    except Exception:
        return 4.0

def get_total_ram_gb() -> float:
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

def check_ram_for_model(model_id: str):
    required  = MODEL_RAM_REQUIREMENTS.get(model_id, 3.0)
    available = get_available_ram_gb()
    if available < required:
        msg = (f"Insufficient RAM: {available:.1f}GB available, "
               f"{required:.1f}GB required for {model_id}.")
        return False, available, required, msg
    return True, available, required, "OK"

# ─── State persistence ──────────────────────────────────────────────────────────
def load_model_state() -> dict:
    """Load persisted model state (last valid model path/id)."""
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        logger.debug(f"[STATE] Could not read state file: {e}")
    return {}

def save_model_state(model_id: str, cache_path: str = ""):
    """Persist which model was last validated, to avoid re-scanning on restart."""
    try:
        data = {
            "model_id":   model_id,
            "cache_path": cache_path,
            "saved_at":   time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with open(STATE_FILE, 'w') as f:
            json.dump(data, f, indent=2)
        logger.debug(f"[STATE] Saved model state: {model_id}")
    except Exception as e:
        logger.warning(f"[STATE] Could not save state: {e}")

# ─── Local model detection ──────────────────────────────────────────────────────
def _log_detect(msg: str):
    """Log detection message to both logger and state."""
    logger.info(msg)
    state.detection_log.append(msg)

def scan_hf_cache_for_models() -> list:
    """
    Scan the HuggingFace cache for any previously downloaded models.
    Returns list of dicts: [{model_id, cache_dir, size_mb, valid}]
    """
    found = []
    try:
        from huggingface_hub import scan_cache_dir
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            if repo.repo_type != 'model':
                continue
            size_mb = repo.size_on_disk / (1024 * 1024)
            # A valid model cache must be > 50 MB (avoids stubs / partial downloads)
            valid = (repo.size_on_disk > 50 * 1024 * 1024)
            found.append({
                'model_id': repo.repo_id,
                'size_mb':  round(size_mb, 1),
                'valid':    valid,
                'source':   'hf_cache',
            })
        _log_detect(f"[SCAN] HuggingFace cache: {len(found)} model(s) found")
    except ImportError:
        _log_detect("[SCAN] huggingface_hub not available, skipping HF cache scan")
    except Exception as e:
        _log_detect(f"[SCAN] HF cache scan error: {e}")
    return found

def scan_sudo_models_dir() -> list:
    """
    Scan ~/.sudo_studio/models for any downloaded models.
    A valid model folder must contain config.json and at least one weight file.
    """
    found = []
    if not MODELS_DIR.exists():
        return found
    try:
        # HuggingFace stores models as: models--Owner--Repo/snapshots/HASH/
        # We also check direct sub-directories
        for candidate in MODELS_DIR.rglob("config.json"):
            model_dir = candidate.parent
            # Check for at least one weight file
            weight_files = (
                list(model_dir.glob("*.bin")) +
                list(model_dir.glob("*.safetensors")) +
                list(model_dir.glob("*.gguf")) +
                list(model_dir.glob("pytorch_model*.bin"))
            )
            if not weight_files:
                _log_detect(f"[SCAN] Skipping {model_dir.name}: config.json present but no weights")
                continue
            # Try to determine model id from config
            model_id = _extract_model_id_from_config(candidate)
            total_size = sum(f.stat().st_size for f in model_dir.rglob("*") if f.is_file())
            size_mb = round(total_size / (1024 * 1024), 1)
            valid = (total_size > 50 * 1024 * 1024)
            found.append({
                'model_id':   model_id or model_dir.name,
                'cache_dir':  str(model_dir),
                'size_mb':    size_mb,
                'valid':      valid,
                'source':     'sudo_models_dir',
            })
        _log_detect(f"[SCAN] Sudo models dir: {len(found)} model(s) found")
    except Exception as e:
        _log_detect(f"[SCAN] Models dir scan error: {e}")
    return found

def _extract_model_id_from_config(config_path: Path) -> str:
    """Try to extract model_type or _name_or_path from config.json."""
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        # _name_or_path is the canonical HuggingFace model ID
        name = cfg.get('_name_or_path', '')
        if name and '/' in name:
            return name
        # Fallback: use architectures
        archs = cfg.get('architectures', [])
        if archs:
            return archs[0]
    except Exception:
        pass
    return ""

def select_best_local_model(all_found: list) -> dict | None:
    """
    Given all locally found models, pick the best one:
      1. Only valid (> 50 MB, has weights)
      2. Match against MODEL_PRIORITY list (lighter first)
      3. Fallback: any valid model found
    Returns the selected entry or None.
    """
    valid = [m for m in all_found if m['valid']]
    if not valid:
        return None

    avail_ram = get_available_ram_gb()

    # Try priority order first
    for priority_id in MODEL_PRIORITY:
        for m in valid:
            mid = m['model_id']
            # Match if model_id contains the priority id (handles partial paths)
            if priority_id.lower() in mid.lower() or mid.lower() in priority_id.lower():
                ram_req = MODEL_RAM_REQUIREMENTS.get(priority_id, 3.0)
                if avail_ram >= ram_req:
                    _log_detect(f"[SELECT] Best match: {priority_id} ({m['size_mb']}MB, RAM OK)")
                    m['resolved_id'] = priority_id
                    return m
                else:
                    _log_detect(f"[SELECT] Skip {priority_id}: needs {ram_req}GB, only {avail_ram:.1f}GB available")

    # Fallback: first valid model, regardless of priority
    m = valid[0]
    _log_detect(f"[SELECT] Fallback: using first valid model: {m['model_id']} ({m['size_mb']}MB)")
    m['resolved_id'] = m['model_id']
    return m

def detect_existing_model(requested_model: str) -> dict | None:
    """
    Main detection function. Returns the best model to use or None.

    Priority:
      1. State file (last validated model) — fastest path
      2. HF cache scan
      3. Sudo models dir scan
      4. None → caller must download
    """
    _log_detect("[DETECT] Searching for existing AI models...")

    # ── Step 1: check persisted state ──────────────────────────────────────
    saved = load_model_state()
    if saved.get('model_id'):
        saved_id = saved['model_id']
        saved_path = saved.get('cache_path', '')
        _log_detect(f"[DETECT] State file: last model = {saved_id}")
        # Quick validation: try to find config.json in saved path
        if saved_path and Path(saved_path).exists():
            config_p = Path(saved_path) / "config.json"
            if config_p.exists():
                _log_detect(f"[DETECT] Existing model found (state file validated).")
                return {
                    'model_id':    saved_id,
                    'resolved_id': saved_id,
                    'cache_dir':   saved_path,
                    'source':      'state_file',
                    'valid':       True,
                    'size_mb':     0,
                }
        _log_detect(f"[DETECT] State file path no longer valid, running full scan...")

    # ── Step 2: if a specific model was requested, check it first ───────────
    if requested_model and requested_model != DEFAULT_MODEL:
        _log_detect(f"[DETECT] Checking requested model: {requested_model}")
        hf_found = _check_model_in_hf_cache(requested_model)
        if hf_found:
            _log_detect(f"[DETECT] Requested model found in cache. Using local model.")
            return hf_found

    # ── Step 3: full scan ────────────────────────────────────────────────────
    _log_detect("[DETECT] Running full local scan...")
    all_found = []
    all_found.extend(scan_hf_cache_for_models())
    all_found.extend(scan_sudo_models_dir())

    # Deduplicate by model_id
    seen = set()
    deduped = []
    for m in all_found:
        key = m['model_id'].lower()
        if key not in seen:
            seen.add(key)
            deduped.append(m)

    _log_detect(f"[DETECT] Total unique models found: {len(deduped)}")

    if not deduped:
        _log_detect("[DETECT] No compatible model found locally.")
        return None

    # List all found models
    for m in deduped:
        status = "valid" if m['valid'] else "INVALID (too small / corrupted)"
        _log_detect(f"[DETECT]   • {m['model_id']} — {m['size_mb']}MB [{status}]")

    best = select_best_local_model(deduped)
    if best:
        _log_detect(f"[DETECT] Model verified. Using local model: {best.get('resolved_id', best['model_id'])}")
    else:
        _log_detect("[DETECT] All found models are invalid (corrupted/incomplete). Will download.")
    return best

def _check_model_in_hf_cache(model_id: str) -> dict | None:
    """Check if a specific model_id is in the HuggingFace cache."""
    try:
        from huggingface_hub import scan_cache_dir
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            if repo.repo_id.lower() == model_id.lower():
                valid = repo.size_on_disk > 50 * 1024 * 1024
                if valid:
                    return {
                        'model_id':    repo.repo_id,
                        'resolved_id': repo.repo_id,
                        'size_mb':     round(repo.size_on_disk / (1024*1024), 1),
                        'valid':       True,
                        'source':      'hf_cache',
                    }
                else:
                    _log_detect(f"[DETECT] {model_id} in cache but too small ({repo.size_on_disk//1024}KB) — corrupted?")
    except Exception:
        pass
    return None

# ─── Model loading ──────────────────────────────────────────────────────────────
def load_model_thread(model_id: str, force_download: bool = False):
    """
    Load model in background thread.
    If model is already cached locally, loads from cache (no download).
    Only downloads if not present OR force_download=True.
    """
    state.loading = True
    state.error   = None
    state.download_progress = 0
    state.detection_log = []
    logger.info(f"[MODEL] Starting load: {model_id}")

    try:
        # ── RAM pre-check ─────────────────────────────────────────────────
        ok, avail, req, msg = check_ram_for_model(model_id)
        if not ok:
            logger.warning(f"[MODEL] RAM warning: {msg}")
            state.error = f"Low RAM ({avail:.1f}GB available, {req:.1f}GB recommended). Loading anyway..."

        # ── Detect existing local model ────────────────────────────────────
        local_model = None
        if not force_download:
            local_model = detect_existing_model(model_id)

        if local_model:
            resolved_id  = local_model.get('resolved_id', local_model['model_id'])
            cache_dir_used = local_model.get('cache_dir', '')
            _log_detect(f"[MODEL] Model already installed. Skipping download.")
            _log_detect(f"[MODEL] Using local model: {resolved_id}")
            # Use the resolved id for loading
            model_id = resolved_id
        else:
            if force_download:
                _log_detect(f"[MODEL] Force download requested for: {model_id}")
            else:
                _log_detect(f"[MODEL] No compatible model found. Downloading default model: {model_id}")

        # ── Import torch / transformers ────────────────────────────────────
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
            trust_remote_code=True,
            local_files_only=(local_model is not None),   # skip network if local
        )
        state.download_progress = 40
        logger.info("[MODEL] Tokenizer loaded. Loading weights...")

        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            cache_dir=cache_dir,
            torch_dtype=torch.float16 if state.device == 'cuda' else torch.float32,
            low_cpu_mem_usage=True,
            trust_remote_code=True,
            local_files_only=(local_model is not None),   # skip network if local
        )
        state.download_progress = 80
        logger.info(f"[MODEL] Weights loaded. Moving to {state.device}...")

        model = model.to(state.device)
        model.eval()

        state.tokenizer  = tokenizer
        state.model      = model
        state.model_name = model_id
        state.loaded     = True
        state.error      = None
        state.download_progress  = 100
        state.detected_local = (local_model is not None)

        logger.info(f"[MODEL] ✅ Ready: {model_id} on {state.device}")

        # Persist the valid model for next runs
        cache_dir_path = str(MODELS_DIR)
        save_model_state(model_id, cache_dir_path)

    except OSError as e:
        # local_files_only=True but files not found — retry with download
        if local_model is not None and 'local_files_only' in str(e).lower() or 'No such file' in str(e):
            logger.warning(f"[MODEL] Local cache stale, retrying with download: {e}")
            state.loading = False
            load_model_thread(model_id, force_download=True)
            return
        state.error   = str(e)
        state.loading = False
        state.download_progress = 0
        logger.error(f"[MODEL] ❌ Failed: {e}")
        gc.collect()

    except MemoryError as e:
        avail = get_available_ram_gb()
        state.error   = f"Out of memory ({avail:.1f}GB available). Free RAM and retry."
        state.loading = False
        state.download_progress = 0
        logger.error(f"[MODEL] ❌ OOM: {e}")
        gc.collect()

    except Exception as e:
        state.error   = str(e)
        state.loading = False
        state.download_progress = 0
        logger.error(f"[MODEL] ❌ Failed to load {model_id}: {e}")
        logger.info("[MODEL] Falling back to mock mode")
        gc.collect()

    finally:
        state.loading = False


def start_model_load(model_id: str = DEFAULT_MODEL, force_download: bool = False):
    t = threading.Thread(
        target=load_model_thread,
        args=(model_id, force_download),
        daemon=True
    )
    t.start()


# ─── Inference ──────────────────────────────────────────────────────────────────
def run_inference(prompt: str, max_tokens: int = 256, temperature: float = 0.7) -> dict:
    start = time.time()

    if not state.loaded or state.model is None:
        mock_reply = generate_mock_reply(prompt)
        return {
            "reply":      mock_reply,
            "mock":       True,
            "model":      "mock",
            "latency_ms": int((time.time() - start) * 1000),
            "tokens":     len(mock_reply.split())
        }

    try:
        import torch
        inputs    = state.tokenizer(prompt, return_tensors="pt").to(state.device)
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

        latency     = int((time.time() - start) * 1000)
        token_count = len(new_tokens)

        return {
            "reply":      reply,
            "mock":       False,
            "model":      state.model_name,
            "latency_ms": latency,
            "tokens":     token_count
        }

    except MemoryError:
        gc.collect()
        return {
            "reply":      "Out of memory during inference. Try freeing RAM or use a smaller model.",
            "mock":       True,
            "model":      state.model_name,
            "latency_ms": int((time.time() - start) * 1000),
            "tokens":     0,
            "error":      "OOM"
        }
    except Exception as e:
        logger.error(f"[INFER] Error: {e}")
        return {
            "reply":      f"Inference error: {str(e)}",
            "mock":       True,
            "model":      state.model_name,
            "latency_ms": int((time.time() - start) * 1000),
            "tokens":     0,
            "error":      str(e)
        }


def generate_mock_reply(prompt: str) -> str:
    p = prompt.lower()
    if any(w in p for w in ['bonjour', 'salut', 'hello', 'hi', 'hey']):
        return "Bonjour ! Je suis Sudo AI. Le modèle IA est en cours de chargement. En attendant, je peux vous répondre en mode basique. Comment puis-je vous aider ?"
    if any(w in p for w in ['code', 'function', 'class', 'def ', 'var ', 'const ']):
        return "Je détecte une question sur du code. Le modèle IA complet est en cours de chargement. Une fois chargé, je pourrai analyser et améliorer votre code en détail."
    if any(w in p for w in ['error', 'erreur', 'bug', 'fix', 'broken']):
        return "Je vois un problème à résoudre. Le modèle IA se charge pour vous donner une réponse précise."
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
        "status":       "healthy",
        "uptime_seconds": int(time.time() - state.startup_time),
        "model": {
            "loaded":             state.loaded,
            "loading":            state.loading,
            "name":               state.model_name or DEFAULT_MODEL,
            "device":             state.device,
            "download_progress":  state.download_progress,
            "error":              state.error,
            "from_local_cache":   state.detected_local,
        },
        "system": {
            "ram_available_gb":  round(avail_ram, 2),
            "ram_total_gb":      round(total_ram, 2),
            "ram_sufficient":    avail_ram >= MODEL_RAM_REQUIREMENTS.get(DEFAULT_MODEL, 2.5),
        },
        "requests_served": state.requests,
        "mock_mode":       not state.loaded,
        "detection_log":   state.detection_log,
    })


@app.route('/infer', methods=['POST'])
def infer():
    state.requests += 1
    data   = request.get_json(force=True, silent=True) or {}
    prompt = (
        data.get('message') or
        data.get('prompt')  or
        data.get('input')   or
        data.get('text')    or
        ''
    ).strip()
    if not prompt:
        return jsonify({"error": "No prompt provided", "fields": ["message", "prompt", "input"]}), 400
    max_tokens  = min(int(data.get('max_tokens', 256)), 512)
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
        {"id": "TinyLlama/TinyLlama-1.1B-Chat-v1.0",      "name": "TinyLlama 1.1B (Default)", "size": "~600MB",  "ram_required_gb": 2.5,  "can_load": avail >= 2.5},
        {"id": "deepseek-ai/deepseek-coder-1.3b-instruct", "name": "DeepSeek Coder 1.3B",      "size": "~1.3GB",  "ram_required_gb": 3.0,  "can_load": avail >= 3.0},
        {"id": "meta-llama/Llama-3.2-1B-Instruct",         "name": "Llama 3.2 1B",             "size": "~1.2GB",  "ram_required_gb": 2.5,  "can_load": avail >= 2.5},
        {"id": "Qwen/Qwen2.5-Coder-1.5B-Instruct",         "name": "Qwen2.5 Coder 1.5B",       "size": "~1.5GB",  "ram_required_gb": 3.5,  "can_load": avail >= 3.5},
        {"id": "microsoft/phi-2",                          "name": "Phi-2 2.7B",               "size": "~2.7GB",  "ram_required_gb": 6.0,  "can_load": avail >= 6.0},
        {"id": "mistralai/Mistral-7B-Instruct-v0.2",       "name": "Mistral 7B",               "size": "~7GB",    "ram_required_gb": 16.0, "can_load": avail >= 16.0},
    ]
    return jsonify({
        "current":              state.model_name or DEFAULT_MODEL,
        "loaded":               state.loaded,
        "loading":              state.loading,
        "download_progress":    state.download_progress,
        "available":            available_models,
        "system_ram_available_gb": round(avail, 2),
        "from_local_cache":     state.detected_local,
    })


@app.route('/reload', methods=['POST'])
def reload_model():
    data     = request.get_json(silent=True) or {}
    model_id = data.get('model', DEFAULT_MODEL)
    force    = data.get('force_download', False)
    ok, avail, req, msg = check_ram_for_model(model_id)
    if not ok:
        logger.warning(f"[RELOAD] {msg}")
    state.loaded    = False
    state.model     = None
    state.tokenizer = None
    gc.collect()
    start_model_load(model_id, force_download=force)
    return jsonify({
        "status":           "reloading",
        "model":            model_id,
        "force_download":   force,
        "ram_available_gb": round(avail, 2),
        "ram_required_gb":  req,
    })


@app.route('/download', methods=['POST'])
def download_model():
    """Force download/reload a specific model (bypasses local detection)."""
    data     = request.get_json(silent=True) or {}
    model_id = data.get('model', DEFAULT_MODEL)
    if state.loading:
        return jsonify({"status": "already_loading", "model": state.model_name}), 409
    ok, avail, req, msg = check_ram_for_model(model_id)
    if not ok:
        logger.warning(f"[DOWNLOAD] {msg}")
    state.loaded    = False
    state.model     = None
    state.tokenizer = None
    gc.collect()
    # force_download=True bypasses local detection
    start_model_load(model_id, force_download=True)
    return jsonify({
        "status":           "downloading",
        "model":            model_id,
        "ram_available_gb": round(avail, 2),
        "ram_required_gb":  req,
        "ram_warning":      None if ok else msg,
    })


@app.route('/scan', methods=['GET'])
def scan_models():
    """Scan local cache and return all found models (no loading)."""
    log_backup = list(state.detection_log)
    state.detection_log = []

    hf_models    = scan_hf_cache_for_models()
    local_models = scan_sudo_models_dir()
    all_models   = hf_models + local_models
    best         = select_best_local_model(all_models)

    scan_log = list(state.detection_log)
    state.detection_log = log_backup  # restore

    return jsonify({
        "scan_log":       scan_log,
        "total_found":    len(all_models),
        "valid_count":    len([m for m in all_models if m['valid']]),
        "all_models":     all_models,
        "best_candidate": best,
        "models_dir":     str(MODELS_DIR),
    })


@app.route('/', methods=['GET'])
def index():
    return jsonify({
        "name":         "Sudo Studio AI Runtime",
        "version":      "2.2.0",
        "endpoints":    ["/health", "/infer", "/chat", "/models", "/reload", "/download", "/scan"],
        "model_status": "loaded" if state.loaded else ("loading" if state.loading else "not_loaded"),
        "smart_detection": True,
    })


# ─── Main ────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Sudo Studio AI Runtime v2.2 — Smart Model Detection')
    parser.add_argument('--port',              type=int, default=6000)
    parser.add_argument('--host',              default='0.0.0.0')
    parser.add_argument('--model',             default=DEFAULT_MODEL,
                        help='Model to use (will check local cache first)')
    parser.add_argument('--no-auto-download',  action='store_true',
                        help='Start without downloading model (mock mode only)')
    parser.add_argument('--force-download',    action='store_true',
                        help='Force re-download even if model is already cached')
    args = parser.parse_args()

    avail_ram = get_available_ram_gb()
    total_ram = get_total_ram_gb()

    print("=" * 60)
    print("  SUDO STUDIO - AI Runtime v2.2.0 (Smart Detection)")
    print(f"  Port       : {args.port}")
    print(f"  Model      : {args.model}")
    print(f"  Cache Dir  : {MODELS_DIR}")
    print(f"  RAM        : {avail_ram:.1f}GB available / {total_ram:.1f}GB total")
    print(f"  Detection  : {'FORCED DOWNLOAD' if args.force_download else 'Smart (local-first)'}")
    print("=" * 60)

    if not args.no_auto_download:
        ok, avail, req, msg = check_ram_for_model(args.model)
        if not ok:
            logger.warning(f"[BOOT] RAM WARNING: {msg}")
            logger.info("[BOOT] Attempting to load anyway (page file may help on Windows)...")
        start_model_load(args.model, force_download=args.force_download)
    else:
        logger.info("[BOOT] Mock mode — no model will be loaded")

    app.run(host=args.host, port=args.port, debug=False, threaded=True)
