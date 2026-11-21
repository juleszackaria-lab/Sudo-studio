#!/usr/bin/env python3
"""P69-A: medecine legale du runtime. Ce module ne sert QU'A parler apres un
plantage : il ne doit jamais etre la cause d'un plantage.

Trois choses, et rien d'autre :

  1. faulthandler Python -> un fichier de crash (runtime_crash.log) dans le
     dossier de logs du produit. Une segmentation fault, un abort, un
     depassement de pile laissent une pile d'appels AVANT la mort du processus.

  2. une trace d'appel AVANT l'entree dans le moteur natif : identifiant,
     nombre de jetons du prompt, grammaire oui/non, n_ctx, max_tokens, modele.
     Le fichier last_call.json est reecrit a chaque appel et SUPPRIME a la fin
     normale : s'il existe encore apres la mort du processus, c'est l'appel en
     cours au moment du plantage.

  3. un etat partage (ETAT) que le battement de coeur (heartbeat.py) peut lire
     sans jamais toucher au moteur : occupe/libre, phase, jetons produits.

ASCII only. Aucune dependance hors stdlib.
"""
import json
import os
import sys
import time
import threading
import traceback

_LOCK = threading.Lock()
_CRASH_FH = None

# Etat lisible par le battement de coeur. Mis a jour uniquement par ce module.
ETAT = {
    "phase": "demarrage",     # demarrage | chargement | libre | generation
    "call_id": None,
    "call_started_at": None,
    "call_kind": None,        # chat | tools+grammaire | tools
    "prompt_tokens": None,
    "grammar": None,
    "n_ctx": None,
    "max_tokens": None,
    "calls_total": 0,
    "calls_failed": 0,
    "last_error": None,
    "last_call_ms": None,
}


def log_dir():
    """Le dossier de logs du produit, celui de P33 (une seule destination)."""
    for var in ("SUDO_STUDIO_LOGS", "SUDO_RUNTIME_LOGS"):
        v = os.environ.get(var)
        if v:
            return v
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local")
        return os.path.join(base, "SudoStudio", "logs")
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "sudo-studio", "logs")


def _ensure_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except Exception:
        return False


def crash_path():
    return os.path.join(log_dir(), "runtime_crash.log")


def last_call_path():
    return os.path.join(log_dir(), "last_call.json")


def enable_faulthandler(where=None):
    """Active faulthandler vers un fichier. Ne leve jamais.

    Renvoie un dict {ok, path, why} pour que l'appelant PUISSE le journaliser
    (un garde-fou muet n'est pas un garde-fou).
    """
    global _CRASH_FH
    import faulthandler
    d = where or log_dir()
    if not _ensure_dir(d):
        return {"ok": False, "path": None, "why": "dossier de logs non inscriptible: " + str(d)}
    path = os.path.join(d, "runtime_crash.log")
    try:
        # Append : les plantages precedents ne sont pas ecrases.
        fh = open(path, "a", encoding="utf-8", errors="replace")
        fh.write("\n=== session runtime pid=%d %s ===\n"
                 % (os.getpid(), time.strftime("%Y-%m-%dT%H:%M:%S")))
        fh.flush()
        faulthandler.enable(file=fh, all_threads=True)
        _CRASH_FH = fh  # garder la reference : sinon le fichier est ferme
        return {"ok": True, "path": path, "why": None}
    except Exception as e:  # pragma: no cover - depends on the platform
        return {"ok": False, "path": path, "why": str(e)[:160]}


def _write_json(path, obj):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=True)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def call_begin(kind, prompt_tokens=None, grammar=None, n_ctx=None, max_tokens=None,
               model=None):
    """Trace AVANT l'appel natif. Renvoie un identifiant d'appel."""
    cid = "%d-%d" % (int(time.time() * 1000), threading.get_ident() % 1000)
    rec = {
        "call_id": cid,
        "kind": kind,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "started_ts": time.time(),
        "pid": os.getpid(),
        "prompt_tokens": prompt_tokens,
        "grammar": bool(grammar) if grammar is not None else None,
        "n_ctx": n_ctx,
        "max_tokens": max_tokens,
        "model": model,
    }
    with _LOCK:
        ETAT.update({"phase": "generation", "call_id": cid,
                     "call_started_at": rec["started_ts"], "call_kind": kind,
                     "prompt_tokens": prompt_tokens, "grammar": rec["grammar"],
                     "n_ctx": n_ctx, "max_tokens": max_tokens})
        ETAT["calls_total"] = int(ETAT.get("calls_total") or 0) + 1
        _write_json(last_call_path(), rec)
    return cid


def call_end(call_id=None, ok=True, tokens=None, error=None):
    """Trace APRES l'appel. Efface last_call.json (l'appel n'est plus 'en cours')."""
    with _LOCK:
        started = ETAT.get("call_started_at")
        ms = int((time.time() - started) * 1000) if started else None
        ETAT.update({"phase": "libre", "call_id": None, "call_started_at": None,
                     "call_kind": None, "last_call_ms": ms})
        if not ok:
            ETAT["calls_failed"] = int(ETAT.get("calls_failed") or 0) + 1
            ETAT["last_error"] = str(error)[:200] if error else "erreur sans message"
        try:
            os.remove(last_call_path())
        except Exception:
            pass
    return ms


def set_phase(phase, **extra):
    with _LOCK:
        ETAT["phase"] = phase
        ETAT.update(extra or {})


def call_is_pending():
    """Y a-t-il un appel commence et non termine ? (lecture seule, sans verrou
    long : utilise par le battement de coeur)."""
    try:
        with open(last_call_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def snapshot():
    """Photo instantanee pour le battement de coeur (aucune operation lente)."""
    d = dict(ETAT)
    started = d.get("call_started_at")
    d["call_elapsed_ms"] = int((time.time() - started) * 1000) if started else None
    d["pid"] = os.getpid()
    d["now"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return d


def install_excepthook():
    """Les exceptions non attrapees laissent aussi une trace datée."""
    def _hook(exc_type, exc, tb):
        try:
            line = ("%s EXCEPTION NON ATTRAPEE pid=%d : %s\n%s"
                    % (time.strftime("%Y-%m-%dT%H:%M:%S"), os.getpid(),
                       "".join(traceback.format_exception_only(exc_type, exc)).strip(),
                       "".join(traceback.format_tb(tb))))
            with open(crash_path(), "a", encoding="utf-8", errors="replace") as f:
                f.write(line + "\n")
        except Exception:
            pass
    sys.excepthook = _hook
