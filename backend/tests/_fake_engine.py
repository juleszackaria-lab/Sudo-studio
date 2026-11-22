#!/usr/bin/env python3
"""Faux MOTEUR pour test-p69-engine-isolation.js (pas le produit).

Sert le minimum que l'API proxifie : /health, /hb, /v1/chat/completions.
Il ne charge aucun modele : le but est de pouvoir le TUER a volonte.
"""
import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=6000)
a = ap.parse_args()
START = time.time()


class H(BaseHTTPRequestHandler):
    def log_message(self, *x):
        return

    def _j(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._j(200, {"status": "healthy",
                                 "model": {"loaded": True, "loading": False,
                                           "name": "faux-moteur", "n_ctx": 2048},
                                 "uptime_seconds": int(time.time() - START)})
        if self.path.startswith("/hb"):
            return self._j(200, {"alive": True, "busy": False, "phase": "libre"})
        if self.path.startswith("/models"):
            return self._j(200, {"models": [], "n_ctx": 2048})
        return self._j(404, {"error": "inconnu"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        if self.path.startswith("/v1/chat/completions"):
            return self._j(200, {"id": "fake", "object": "chat.completion",
                                 "choices": [{"index": 0,
                                              "message": {"role": "assistant", "content": "ok"},
                                              "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": 3, "completion_tokens": 1}})
        if self.path.startswith("/tokenize"):
            return self._j(200, {"tokens": 3})
        return self._j(404, {"error": "inconnu"})


ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
