#!/usr/bin/env python3
"""P69-C7 : l'API survit au plantage du MOTEUR.

Le probleme, dit simplement
---------------------------
Aujourd'hui l'API Flask et le moteur llama.cpp vivent dans le MEME processus.
Un plantage natif (0xC0000005, instruction illegale, OOM brutal) tue tout :
le client voit sa connexion se couper et l'interface ne peut plus rien dire.

Ce que fait ce module
---------------------
Il fait tourner le moteur dans un processus ENFANT, et l'API dans le parent :

    client -> api_front (parent, ne touche JAMAIS au moteur)
                  |
                  +-- proxy HTTP -> server.enterprise.py (enfant : llama.cpp)

Consequences, verificables :
  * le moteur meurt -> l'API repond encore, dit la verite
    (`/health` 200 avec `engine.alive=false`, code de sortie nomme) et renvoie
    un 503 explicite sur `/v1/*` au lieu d'une connexion coupee ;
  * le moteur est relance automatiquement, avec une temporisation ;
  * quand il est revenu, l'appel suivant passe (le client n'a rien a faire).

Ce qui n'est PAS fait ici
-------------------------
Aucune reprise en vol : un appel interrompu par la mort du moteur est perdu.
C'est dit au client par un 503 `engine_restarting` et non par un silence.

ASCII only. Aucune dependance hors Flask/requests (deja dans le paquet).
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time

import requests
from flask import Flask, Response, jsonify, request

# --- etat partage (un seul moteur, un seul front) -------------------------
_LOCK = threading.Lock()
_STATE = {
    "proc": None,
    "engine_port": None,
    "alive": False,
    "restarts": 0,
    "last_exit": None,
    "last_exit_name": "",
    "last_started_at": None,
    "last_dead_at": None,
    "spawn_ms": None,
    "stop": False,
    "log_path": None,
}

# Nommer le code de sortie : c'est ce qui manquait le 21/11.
_LINUX_SIGNALS = {139: "SIGSEGV (segmentation fault)",
                  134: "SIGABRT (abandon)",
                  137: "SIGKILL (tue de l'exterieur ou OOM killer)",
                  136: "SIGFPE (erreur arithmetique)",
                  132: "SIGILL (instruction illegale)"}
_WIN_CODES = {0xC0000005: "ACCESS_VIOLATION",
              0xC0000409: "STACK_BUFFER_OVERRUN",
              0xC000001D: "ILLEGAL_INSTRUCTION",
              0xC0000094: "INTEGER_DIVIDE_BY_ZERO",
              0xC00000FD: "STACK_OVERFLOW"}


def describe_exit(code):
    """Code de sortie -> phrase lisible. Jamais muet."""
    if code is None:
        return "encore en cours"
    if code == 0:
        return "arret normal (code 0)"
    if code in _LINUX_SIGNALS:
        return "%s (code %d)" % (_LINUX_SIGNALS[code], code)
    if code in _WIN_CODES:
        return "%s (0x%08X)" % (_WIN_CODES[code], code & 0xFFFFFFFF)
    if code < 0:
        return "signal %d" % (-code)
    unsigned = code & 0xFFFFFFFF
    if unsigned in _WIN_CODES:
        return "%s (0x%08X)" % (_WIN_CODES[unsigned], unsigned)
    return "code de sortie inconnu (%d)" % code


def _log(msg):
    print("[FRONT] " + msg, flush=True)
    try:
        path = os.environ.get("SUDO_STUDIO_LOGS") or ""
        if not path:
            base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
            path = os.path.join(base, "SudoStudio", "logs")
        os.makedirs(path, exist_ok=True)
        p = os.path.join(path, "runtime-front.log")
        _STATE["log_path"] = p
        with open(p, "a", encoding="utf-8", errors="replace") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    except Exception:
        pass


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _engine_cmd(engine_port, model=None):
    """Comment relancer le moteur, y compris depuis un EXE fige.

    SUDO_ENGINE_CMD permet de mettre un AUTRE moteur (utilise par le harnais
    de test pour pouvoir le tuer a volonte). Le produit ne s'en sert pas.
    """
    override = os.environ.get("SUDO_ENGINE_CMD")
    if override:
        return [sys.executable, override, "--port", str(engine_port)]
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--port", str(engine_port)]
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        cmd = [sys.executable, os.path.join(here, "server.enterprise.py"),
               "--port", str(engine_port)]
    if model:
        cmd += ["--model", model]
    return cmd


def start_engine(engine_port=None, model=None, wait=True, timeout=420):
    """Lance (ou relance) le moteur. Renvoie l'etat, jamais d'exception."""
    with _LOCK:
        port = engine_port or _STATE.get("engine_port") or free_port()
        _STATE["engine_port"] = port
        env = dict(os.environ)
        env["SUDO_ENGINE_CHILD"] = "1"      # l'enfant ne relance jamais de front
        env["SUDO_HB_PORT"] = env.get("SUDO_ENGINE_HB_PORT") or env.get("SUDO_HB_PORT") or "6001"
        t0 = time.time()
        try:
            logdir = env.get("SUDO_STUDIO_LOGS") or ""
            if not logdir:
                base = env.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
                logdir = os.path.join(base, "SudoStudio", "logs")
            os.makedirs(logdir, exist_ok=True)
            out = open(os.path.join(logdir, "engine-child.log"), "a", encoding="utf-8", errors="replace")
            proc = subprocess.Popen(_engine_cmd(port, model), env=env,
                                    stdout=out, stderr=subprocess.STDOUT)
        except Exception as e:
            _STATE.update({"alive": False, "last_exit_name": "lancement impossible: %s" % e})
            _log("moteur NON lance : %s" % e)
            return engine_status()
        _STATE.update({"proc": proc, "alive": True, "last_started_at": time.time(),
                       "spawn_ms": int((time.time() - t0) * 1000)})
        _log("moteur lance pid=%s port=%s" % (proc.pid, port))
    if wait:
        ready = wait_engine(timeout=timeout)
        _STATE["spawn_ms"] = int((time.time() - _STATE["last_started_at"] or time.time()) * 1000)
        return ready
    return engine_status()


def wait_engine(timeout=420):
    """Attend que le moteur reponde /health. Dit ce qui bloque, sinon."""
    base = engine_base()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not engine_alive():
            return {"ok": False, "why": "moteur mort pendant le chargement",
                    "exit": _STATE.get("last_exit_name")}
        try:
            r = requests.get(base + "/health", timeout=5)
            if r.status_code == 200:
                return {"ok": True, "health": r.json(), "s": round(time.time() - t0, 1)}
        except Exception:
            pass
        time.sleep(2)
    return {"ok": False, "why": "pas de reponse /health apres %s s" % timeout}


def engine_base():
    return "http://127.0.0.1:%s" % (_STATE.get("engine_port") or 6000)


def engine_alive():
    p = _STATE.get("proc")
    return bool(p is not None and p.poll() is None)


def engine_status():
    """Etat honnete : la derniere mort CONNUE reste visible meme apres relance."""
    p = _STATE.get("proc")
    alive = engine_alive()
    last = _STATE.get("last_exit")
    return {"alive": alive,
            "pid": (p.pid if (p is not None and alive) else None),
            "port": _STATE.get("engine_port"),
            "restarts": _STATE.get("restarts", 0),
            "last_exit": last,
            "last_exit_name": _STATE.get("last_exit_name") or (describe_exit(last) if last is not None else ""),
            "last_dead_at": _STATE.get("last_dead_at"),
            "spawn_ms": _STATE.get("spawn_ms"),
            "since_start_s": (round(time.time() - _STATE["last_started_at"], 1)
                              if _STATE.get("last_started_at") else None)}


def watch(restart_delay_s=1.0, max_restarts=50, window_s=600):
    """Surveille le moteur : note la mort, la nomme, le relance. Tracant."""
    while not _STATE.get("stop"):
        time.sleep(1.0)
        p = _STATE.get("proc")
        if p is None:
            continue
        code = p.poll()
        if code is None:
            continue
        # mort detectee
        _STATE["alive"] = False
        _STATE["last_exit"] = code
        _STATE["last_exit_name"] = describe_exit(code)
        _STATE["last_dead_at"] = time.time()
        _log("MOTEUR MORT : %s" % _STATE["last_exit_name"])
        if _STATE.get("restarts", 0) >= max_restarts:
            _log("plafond de relances atteint (%d) : plus de relance automatique" % max_restarts)
            continue
        time.sleep(restart_delay_s)
        with _LOCK:
            _STATE["restarts"] = _STATE.get("restarts", 0) + 1
        _log("RELANCE du moteur (%d)" % _STATE["restarts"])
        start_engine(_STATE.get("engine_port"), wait=False)


# --------------------------------------------------------------- proxy ----
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
        "content-length"}


def _proxy(path, method):
    base = engine_base()
    if not engine_alive():
        return _engine_down_response(path)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    try:
        r = requests.request(method, base + path, headers=headers,
                             data=request.get_data() if method != "GET" else None,
                             params=request.args, stream=True, timeout=(5, 900))
    except Exception as e:
        # moteur injoignable alors qu'il semble vivant : on ne ment pas
        return _engine_down_response(path, detail=str(e))
    if r.status_code == 503 or not engine_alive():
        # le moteur est tombe pendant l'appel
        if not engine_alive():
            return _engine_down_response(path)
    status = r.status_code
    out_headers = [(k, v) for k, v in r.headers.items() if k.lower() not in _HOP]
    body = r.content
    resp = Response(body, status=status, headers=out_headers)
    return resp


def _proxy_stream(path, method):
    """Passage SSE : on relaie les octets tels quels (pas de mise en tampon)."""
    base = engine_base()
    if not engine_alive():
        return _engine_down_response(path)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    try:
        r = requests.request(method, base + path, headers=headers,
                             data=request.get_data(), stream=True, timeout=(5, 900))
    except Exception as e:
        return _engine_down_response(path, detail=str(e))

    def gen():
        try:
            for chunk in r.iter_content(chunk_size=256):
                if chunk:
                    yield chunk
        except Exception as e:
            yield ("data: " + json.dumps({"error": {"type": "engine_died",
                   "message": "moteur interrompu : %s" % e}}) + "\n\n").encode("utf-8")

    return Response(gen(), status=r.status_code,
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                    mimetype=r.headers.get("Content-Type", "text/event-stream"))


def _engine_down_response(path, detail=None):
    st = engine_status()
    msg = ("Le moteur d'inference a plante (%s). L'API est toujours en vie et le "
           "moteur est relance automatiquement : reessayez dans quelques secondes."
           % (st.get("last_exit_name") or "cause inconnue"))
    if detail:
        msg += " Detail : " + str(detail)[:160]
    payload = {"error": {"type": "engine_unavailable", "message": msg,
                         "engine": st, "path": path}}
    _log("503 sur %s : %s" % (path, msg))
    return jsonify(payload), 503


def make_app():
    app = Flask(__name__)

    @app.route("/health", methods=["GET"])
    def health():
        """Toujours 200 : c'est le but. Le detail dit si le moteur est la."""
        st = engine_status()
        if st["alive"]:
            try:
                r = requests.get(engine_base() + "/health", timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    data["engine"] = st
                    data["api"] = {"alive": True, "role": "front", "version": 1}
                    return jsonify(data), 200
            except Exception:
                pass
        return jsonify({"status": "degraded", "model": {"loaded": False, "loading": False},
                        "engine": st, "api": {"alive": True, "role": "front"},
                        "message": "moteur indisponible : " + (st.get("last_exit_name") or "inconnu")}), 200

    @app.route("/hb", methods=["GET"])
    def hb():
        """Battement du front : repond meme quand le moteur est mort."""
        st = engine_status()
        busy = False
        try:
            r = requests.get(engine_base() + "/hb", timeout=2)
            if r.status_code == 200:
                busy = bool((r.json() or {}).get("busy"))
        except Exception:
            busy = False
        return jsonify({"alive": True, "busy": busy, "phase": "front",
                        "engine_alive": st["alive"], "restarts": st["restarts"]})

    @app.route("/engine", methods=["GET"])
    def engine_info():
        return jsonify(engine_status())

    @app.route("/engine/restart", methods=["POST"])
    def engine_restart():
        p = _STATE.get("proc")
        if p is not None and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        time.sleep(0.5)
        r = start_engine(_STATE.get("engine_port"), wait=True)
        return jsonify({"restarted": True, "result": r, "engine": engine_status()})

    @app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    def everything(path):
        is_stream = False
        if request.method == "POST" and request.path.startswith("/v1/"):
            try:
                is_stream = bool((request.get_json(silent=True) or {}).get("stream"))
            except Exception:
                is_stream = False
        if is_stream:
            return _proxy_stream("/" + path, request.method)
        return _proxy("/" + path, request.method)

    return app


def run_front(port=6000, host="127.0.0.1", engine_port=None, model=None,
              wait=True, restart_delay_s=1.0):
    """Point d'entree : lance le moteur, puis sert l'API. Ne rend jamais la main."""
    os.environ["SUDO_API_FRONT"] = "1"
    t = threading.Thread(target=watch, kwargs={"restart_delay_s": restart_delay_s},
                         daemon=True)
    r = start_engine(engine_port, model=model, wait=wait)
    _log("demarrage : %s" % json.dumps(r)[:300])
    t.start()
    app = make_app()
    _log("API en ecoute sur %s:%s (moteur sur %s)" % (host, port, _STATE.get("engine_port")))
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="P69-C7 : front d'API resistant au plantage du moteur")
    ap.add_argument("--port", type=int, default=6000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--engine-port", type=int, default=None)
    ap.add_argument("--model", default=None)
    ap.add_argument("--no-wait", action="store_true")
    a = ap.parse_args()
    run_front(a.port, a.host, a.engine_port, a.model, wait=not a.no_wait)
