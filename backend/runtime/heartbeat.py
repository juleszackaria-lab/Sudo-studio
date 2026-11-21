#!/usr/bin/env python3
"""P69-B: battement de coeur du runtime, INBLOQUABLE par la generation.

Le probleme mesure : pendant une generation (ou un chargement) le serveur
Flask ne repond plus au sondage de sante. Le superviseur ne peut donc pas
distinguer "occupe" de "mort" : il compte des echecs et relance un runtime
parfaitement vivant (ou declare "relance impossible (timeout)").

La reponse : un second serveur HTTP, minuscule, dans un THREAD separe, qui ne
touche JAMAIS au moteur. Il lit un dictionnaire deja rempli (forensics.ETAT)
et repond en microsecondes. La generation ne peut pas l'empecher de repondre :
llama.cpp libere le GIL pendant le calcul natif, et ce thread n'appelle aucune
API du moteur.

  GET /hb   -> {"alive": true, "busy": true|false, "phase": "...", ...}

Un port separe (6001 par defaut) est volontaire : il survit meme si le serveur
Flask principal est bloque ou en cours de redemarrage interne.

ASCII only, stdlib only.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import forensics

DEFAULT_PORT = 6001
_STARTED = threading.Event()
_SERVER = None
_PORT = None
_T0 = time.time()


_STATE_PROVIDER = None


def set_state_provider(fn):
    """Le serveur enregistre ici une fonction qui rend l'etat du modele.
    Aucun import croise : le battement de coeur ne depend pas de Flask."""
    global _STATE_PROVIDER
    _STATE_PROVIDER = fn if callable(fn) else None


def _state_extra():
    if not _STATE_PROVIDER:
        return {}
    try:
        d = _STATE_PROVIDER() or {}
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence : pas de bruit dans les logs
        return

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=True).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        if self.path.split("?")[0] not in ("/hb", "/health", "/"):
            self._send(404, {"error": "not found"})
            return
        try:
            snap = forensics.snapshot()
        except Exception as e:
            snap = {"phase": "inconnu", "error": str(e)[:120]}
        extra = _state_extra()
        busy = snap.get("phase") == "generation" or extra.get("loading") is True
        out = {
            "alive": True,
            "busy": bool(busy),
            "phase": snap.get("phase"),
            "uptime_s": int(time.time() - _T0),
            "pid": snap.get("pid"),
            "call": {
                "id": snap.get("call_id"),
                "kind": snap.get("call_kind"),
                "prompt_tokens": snap.get("prompt_tokens"),
                "grammar": snap.get("grammar"),
                "n_ctx": snap.get("n_ctx"),
                "max_tokens": snap.get("max_tokens"),
                "elapsed_ms": snap.get("call_elapsed_ms"),
            },
            "calls_total": snap.get("calls_total"),
            "calls_failed": snap.get("calls_failed"),
            "last_error": snap.get("last_error"),
            "last_call_ms": snap.get("last_call_ms"),
            "model": extra,
            "crashed_call": None if busy else _pending_call(),
        }
        self._send(200, out)

    def do_HEAD(self):
        self._send(200, {"alive": True})


def _pending_call():
    """Un appel reste 'en cours' alors que la phase dit 'libre' : le processus
    precedent est mort en pleine generation (fichier last_call.json orphelin)."""
    try:
        return forensics.call_is_pending()
    except Exception:
        return None


def start(port=DEFAULT_PORT, host="127.0.0.1"):
    """Demarre le battement de coeur. Ne leve jamais : renvoie {ok, port, why}."""
    global _SERVER, _PORT
    if _STARTED.is_set():
        return {"ok": True, "port": _PORT, "why": "deja demarre"}
    try:
        srv = ThreadingHTTPServer((host, int(port)), _Handler)
        srv.daemon_threads = True
    except Exception as e:
        return {"ok": False, "port": port, "why": str(e)[:160]}
    t = threading.Thread(target=srv.serve_forever, name="heartbeat", daemon=True)
    t.start()
    _SERVER = srv
    # port 0 = port libre choisi par l'OS : on lit le vrai port binde
    _PORT = int(srv.server_address[1])
    _STARTED.set()
    return {"ok": True, "port": _PORT, "why": None}


def stop():
    global _SERVER
    if _SERVER is not None:
        try:
            _SERVER.shutdown()
            _SERVER.server_close()
        except Exception:
            pass
        _SERVER = None
    _STARTED.clear()


def port():
    return _PORT
