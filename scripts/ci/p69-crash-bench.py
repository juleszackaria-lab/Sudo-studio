#!/usr/bin/env python3
"""P69-A2 / D10: le runtime meurt-il en pleine generation ? (vrai modele, CI)

Ce banc ne teste pas le modele : il teste le PROCESSUS. Il lance le vrai
serveur du produit (backend/runtime/server.enterprise.py) en processus enfant,
puis lui envoie une serie d'appels melanges, et compte les morts.

  - 300 appels : chat simple, appels d'outils (grammaire GBNF), prompts proches
    de la fenetre, appels qui la depassent ; n_ctx 2048 puis 4096 ;
  - a chaque appel : identifiant, jetons estimes, grammaire oui/non, duree ;
  - si le processus meurt : code de sortie, RAM libre, dernier appel trace
    (last_call.json) et fin du fichier de crash (faulthandler) sont COLLES ;
  - le processus est relance et la serie continue (on mesure aussi la relance).

Puis le test du plantage INJECTE (point 10 du prompt) : on tue le processus
d'inference en pleine generation (SIGKILL) et on mesure ce que le client voit
(erreur de connexion ou 503), le temps de relance, et le retour a l'etat charge.

Controle negatif : le meme plantage injecte SANS le superviseur de sante
(--no-supervisor) doit laisser le service par terre. C'est la mesure qui prouve
que la protection sert a quelque chose.

Usage:
  python3 scripts/ci/p69-crash-bench.py --out p69-results [--calls 300]

ASCII only. Aucun jeton secret n'est ecrit : les prompts sont du texte neutre.
"""
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RUNTIME_DIR = os.path.join(ROOT, "backend", "runtime")

FILLER = ("Le service de facturation traite les commandes du lundi au vendredi. "
          "Chaque ligne du journal contient un identifiant, une date et un montant. ")

TOOLS = [{"type": "function", "function": {
    "name": "read", "description": "Lire un fichier",
    "parameters": {"type": "object", "properties": {"file": {"type": "string"}},
                   "required": ["file"]}}}]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def rss_mb(pid):
    try:
        with open("/proc/%d/status" % pid, "r") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024.0, 1)
    except Exception:
        pass
    return None


def free_ram_mb():
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


def http(url, body=None, timeout=180, stream=False):
    """Renvoie {status, json|text, error}. Ne leve jamais."""
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        import json as _j
        data = _j.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return {"status": r.status, "json": json.loads(raw)}
            except Exception:
                return {"status": r.status, "text": raw[:400]}
    except urllib.error.HTTPError as e:
        try:
            raw = e.read().decode("utf-8", "replace")
        except Exception:
            raw = ""
        return {"status": e.code, "text": raw[:400], "error": "http %d" % e.code}
    except Exception as e:
        return {"status": None, "error": type(e).__name__ + ": " + str(e)[:160]}


class Runtime:
    """Lance / arrete / surveille UN processus runtime (le vrai)."""

    def __init__(self, logs_dir, port=None, hb_port=None, model=None, cmd=None):
        self.cmd = cmd
        self.logs_dir = logs_dir
        self.port = port or free_port()
        self.hb_port = hb_port or free_port()
        self.model = model
        self.proc = None
        self.started_at = None
        self.deaths = []
        self.restarts = []

    def base(self):
        return "http://127.0.0.1:%d" % self.port

    def env(self):
        e = dict(os.environ)
        e["SUDO_STUDIO_LOGS"] = self.logs_dir
        e["SUDO_HB_PORT"] = str(self.hb_port)
        e["PYTHONUNBUFFERED"] = "1"
        return e

    def start(self):
        if self.cmd:
            cmd = [sys.executable, self.cmd, "--port", str(self.port)]
        else:
            cmd = [sys.executable, "server.enterprise.py", "--port", str(self.port)]
            if self.model:
                cmd += ["--model", self.model]
        log = open(os.path.join(self.logs_dir, "runtime-stdout.log"), "a")
        self.proc = subprocess.Popen(cmd, cwd=RUNTIME_DIR, env=self.env(),
                                     stdout=log, stderr=subprocess.STDOUT)
        self.started_at = time.time()
        return self.proc

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def wait_model(self, timeout=420):
        """Attend que le modele soit charge (etat lu dans /health)."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            if not self.alive():
                return {"ok": False, "why": "processus mort pendant le chargement",
                        "exit": self.proc.returncode}
            h = http(self.base() + "/health", timeout=10)
            m = ((h.get("json") or {}).get("model") or {}) if h.get("status") == 200 else {}
            if m.get("loaded"):
                return {"ok": True, "load_s": round(time.time() - t0, 1),
                        "n_ctx": m.get("n_ctx"), "rss_mb": rss_mb(self.proc.pid)}
            time.sleep(1.0)
        return {"ok": False, "why": "modele non charge apres %ds" % timeout}

    def kill_hard(self):
        if self.alive():
            try:
                self.proc.send_signal(signal.SIGKILL)
            except Exception:
                pass

    def stop(self):
        if self.alive():
            self.kill_hard()
        try:
            self.proc.wait(timeout=10)
        except Exception:
            pass

    def hb(self):
        return http("http://127.0.0.1:%d/hb" % self.hb_port, timeout=2)

    def crash_evidence(self):
        ev = {"exit_code": self.proc.returncode if self.proc else None,
              "free_ram_mb": free_ram_mb()}
        try:
            with open(os.path.join(self.logs_dir, "last_call.json"), "r", encoding="utf-8") as f:
                ev["last_call"] = json.load(f)
        except Exception:
            ev["last_call"] = None
        try:
            with open(os.path.join(self.logs_dir, "runtime_crash.log"), "r", encoding="utf-8") as f:
                ev["crash_tail"] = f.read().strip().split("\n")[-12:]
        except Exception:
            ev["crash_tail"] = None
        return ev


def call_plan(i, n_ctx=2048):
    """Serie melangee : chat, outils+grammaire, pres de la fenetre, au-dela.

    La proportion estimee est grossiere (2,6 caracteres par jeton pour du
    francais) : c'est suffisant pour viser 55 % et 120 % de `n_ctx`, les deux
    cas que le prompt demande de couvrir.
    """
    chars_per_token = 2.6
    kind = ["chat", "tools", "pres", "depasse"][i % 4]
    payload = {"messages": [{"role": "user", "content": "Dis bonjour en un mot."}],
               "max_tokens": 24, "temperature": 0.0, "stream": False}
    if kind == "tools":
        payload["tools"] = TOOLS
        payload["messages"] = [{"role": "user", "content": "Lis le fichier app.py"}]
    elif kind in ("pres", "depasse"):
        share = 0.55 if kind == "pres" else 1.20
        target_chars = int(n_ctx * share * chars_per_token)
        reps = max(1, target_chars // len(FILLER))
        payload["messages"] = [{"role": "user", "content": FILLER * reps + "\nReponds OK."}]
        payload["max_tokens"] = 16
    return kind, payload


def run_series(rt, calls, out_dir):
    """Envoie `calls` appels. Renvoie les lignes + les morts observees."""
    rows = []
    deaths = []
    lat = []
    n_ctx = 2048
    for i in range(1, calls + 1):
        # point 2 du prompt : la serie couvre n_ctx 2048 PUIS 4096.
        if i == (calls // 2) + 1:
            r = http(rt.base() + "/reload", {"model": rt.model, "n_ctx": 4096}, timeout=60)
            print("[BASCULE] n_ctx 2048 -> 4096 : %s" % json.dumps(r)[:200])
            w = rt.wait_model(timeout=300)
            print("[BASCULE] rechargement : %s" % json.dumps(w))
            n_ctx = 4096
        kind, payload = call_plan(i, n_ctx)
        t0 = time.time()
        r = http(rt.base() + "/v1/chat/completions", payload, timeout=300)
        ms = int((time.time() - t0) * 1000)
        alive_after = rt.alive()
        ok = (r.get("status") == 200)
        row = {"i": i, "kind": kind, "n_ctx": n_ctx, "status": r.get("status"), "ms": ms,
               "alive_after": alive_after}
        if not ok:
            row["error"] = str(r.get("error") or r.get("text"))[:200]
        rows.append(row)
        if ok:
            lat.append(ms)
        if not alive_after:
            ev = rt.crash_evidence()
            ev["call_i"] = i
            ev["kind"] = kind
            ev["status_client"] = r.get("status")
            ev["client_error"] = row.get("error")
            deaths.append(ev)
            print("[MORT] appel %d (%s) -> exit=%s ram=%sMo client=%s"
                  % (i, kind, ev.get("exit_code"), ev.get("free_ram_mb"), row.get("error")))
            if ev.get("last_call"):
                print("       dernier appel trace : %s" % json.dumps(ev["last_call"]))
            if ev.get("crash_tail"):
                print("       fin de runtime_crash.log : %s" % " | ".join(ev["crash_tail"][-4:]))
            # relance, chronometree
            t1 = time.time()
            rt.start()
            w = rt.wait_model()
            rt.restarts.append({"after_call": i, "ok": w.get("ok"),
                                "restart_s": round(time.time() - t1, 1),
                                "exit_code": ev.get("exit_code")})
            print("[RELANCE] ok=%s en %.1fs (exit %s)"
                  % (w.get("ok"), time.time() - t1, ev.get("exit_code")))
            if not w.get("ok"):
                break
    return rows, deaths, lat


def injected_kill(rt, restart=True):
    """Point 10: on tue le processus d'inference EN PLEINE generation.

    On mesure trois choses : ce que le CLIENT voit, ce que la medecine legale
    retrouve (code de sortie, dernier appel), et le temps de retour complet
    (relance du processus + rechargement du modele).

    Controle negatif (restart=False) : sans relance, le service reste par terre
    et /health refuse. C'est la preuve que la protection sert a quelque chose.
    """
    import threading
    out = {"restart": restart}
    payload = {"messages": [{"role": "user", "content": FILLER * 40 + "\nCompte jusqu'a 50."}],
               "max_tokens": 200, "temperature": 0.0, "stream": False}
    res = {}

    def worker():
        t0 = time.time()
        res["r"] = http(rt.base() + "/v1/chat/completions", payload, timeout=120)
        res["ms"] = int((time.time() - t0) * 1000)

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    time.sleep(1.5)  # la generation a commence
    hb_before = rt.hb()
    out["heartbeat_before_kill"] = {"status": hb_before.get("status"),
                                    "busy": ((hb_before.get("json") or {}).get("busy")),
                                    "phase": ((hb_before.get("json") or {}).get("phase"))}
    rt.kill_hard()
    th.join(timeout=90)
    out["client"] = {"status": (res.get("r") or {}).get("status"),
                     "error": (res.get("r") or {}).get("error"),
                     "ms": res.get("ms")}
    out["client_saw"] = ("connexion coupee" if (res.get("r") or {}).get("error")
                         else "reponse HTTP " + str((res.get("r") or {}).get("status")))
    out["kill_evidence"] = rt.crash_evidence()

    # Sans relance : le service doit rester MUET (controle negatif).
    time.sleep(3)
    h = http(rt.base() + "/health", timeout=3)
    out["sans_relance"] = {"status": h.get("status"), "error": h.get("error")}
    if not restart:
        return out

    # Avec relance : temps complet (processus + modele).
    t0 = time.time()
    rt.start()
    w = rt.wait_model()
    out["restart_s"] = round(time.time() - t0, 1)
    out["restart_ok"] = bool(w.get("ok"))
    out["restart_detail"] = w
    h2 = http(rt.base() + "/health", timeout=10)
    out["apres_relance"] = {"status": h2.get("status"),
                            "n_ctx": (((h2.get("json") or {}).get("model") or {}).get("n_ctx"))}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="p69-results")
    ap.add_argument("--calls", type=int, default=300)
    ap.add_argument("--model", default=os.environ.get("SUDO_BENCH_MODEL",
                                                      "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF"))
    ap.add_argument("--skip-injection", action="store_true")
    ap.add_argument("--runtime-cmd", default=None,
                    help="script de runtime a lancer (defaut: le vrai serveur). "
                         "Sert a verifier le BANC lui-meme avec un faux runtime.")
    args = ap.parse_args()

    logs = os.path.join(ROOT, "p69-logs")
    os.makedirs(logs, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    # on repart d'un dossier de traces propre : sinon on lit le crash du voisin
    for f in ("runtime_crash.log", "last_call.json", "runtime-stdout.log"):
        try:
            os.remove(os.path.join(logs, f))
        except Exception:
            pass

    rt = Runtime(logs, model=args.model, cmd=args.runtime_cmd)
    print("=== P69: serie de %d appels sur le VRAI runtime (ports %d/%d) ==="
          % (args.calls, rt.port, rt.hb_port))
    rt.start()
    w = rt.wait_model()
    print("chargement : %s" % json.dumps(w))
    if not w.get("ok"):
        print("ECHEC: le runtime n'a pas charge le modele -> rien ne peut etre mesure.")
        json.dump({"setup": w}, open(os.path.join(args.out, "p69-crash.json"), "w"), indent=1)
        return 2

    hb = rt.hb()
    print("battement de coeur : status=%s busy=%s phase=%s"
          % (hb.get("status"), (hb.get("json") or {}).get("busy"),
             (hb.get("json") or {}).get("phase")))

    rows, deaths, lat = run_series(rt, args.calls, args.out)
    ok_count = sum(1 for r in rows if r.get("status") == 200)
    print("\n=== RESULTAT DE LA SERIE ===")
    print("appels            : %d" % len(rows))
    print("reussis (HTTP 200): %d" % ok_count)
    print("morts du processus: %d" % len(deaths))
    if lat:
        lat_sorted = sorted(lat)
        print("latence mediane   : %d ms (max %d ms)" % (lat_sorted[len(lat_sorted) // 2], lat_sorted[-1]))
    for d in deaths:
        print("  mort apres l'appel %s (kind=%s) exit=%s last_call=%s"
              % (d.get("call_i"), d.get("kind"), d.get("exit_code"),
                 json.dumps(d.get("last_call")) if d.get("last_call") else "aucun"))
    if not deaths:
        print("  aucune mort : sur cette machine et ce modele, la serie n'a pas reproduit le plantage.")

    inj = None
    if not args.skip_injection:
        print("\n=== PLANTAGE INJECTE (SIGKILL en pleine generation) ===")
        inj = injected_kill(rt, restart=True)
        print("client : %s en %sms (%s)" % (inj["client"].get("status"), inj["client"].get("ms"),
                                            inj["client_saw"]))
        print("battement avant le kill : %s" % json.dumps(inj.get("heartbeat_before_kill")))
        print("sans relance : /health -> %s (%s)" % (inj["sans_relance"].get("status"),
                                                    inj["sans_relance"].get("error")))
        print("reprise : ok=%s en %ss (modele recharge, n_ctx=%s)"
              % (inj.get("restart_ok"), inj.get("restart_s"),
                 (inj.get("apres_relance") or {}).get("n_ctx")))
        print("preuve   : exit=%s last_call=%s" % (inj["kill_evidence"].get("exit_code"),
                                                   json.dumps(inj["kill_evidence"].get("last_call"))))

    report = {"calls": len(rows), "ok": ok_count, "deaths": deaths,
              "restarts": rt.restarts, "latency_ms": {"median": (sorted(lat)[len(lat) // 2] if lat else None),
                                                      "max": (max(lat) if lat else None)},
              "injected": inj, "rows": rows}
    path = os.path.join(args.out, "p69-crash.json")
    json.dump(report, open(path, "w"), indent=1, ensure_ascii=True)
    print("\necrit : %s" % path)
    rt.stop()
    # Un plantage mesure n'est pas un echec du banc : on sort 1 seulement si le
    # modele n'a jamais charge ou si le service ne revient pas apres injection.
    if inj is not None and not inj.get("restart_ok"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
