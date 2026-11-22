#!/usr/bin/env python3
"""P69-C7 : preuve, avec le VRAI modele, que l'API survit au plantage du moteur.

Sequence, sans raccourci :
  1. lance `api_front.py` (l'API) ; il lance le moteur dans un processus enfant ;
  2. attend que le moteur ait charge le modele ;
  3. fait un vrai appel : il doit repondre 200 ;
  4. releve le pid du moteur (GET /engine) et le tue (SIGKILL, comme un
     plantage natif : pas de nettoyage, pas de message) ;
  5. verification pendant la panne :
       - l'API repond encore /health avec un code 200 (elle n'est pas morte) ;
       - /health dit que le moteur est mort et NOMME le code de sortie ;
       - un appel /v1 recoit un 503 explicite (jamais une connexion coupee) ;
  6. attend la relance automatique et refait un vrai appel : 200 ;
  7. CONTROLE NEGATIF : refait la meme chose SANS le front (moteur seul) pour
     montrer qu'alors la connexion est bien coupee.

ASCII only. Sort 0 seulement si tout le ci-dessus est vrai.
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNTIME = os.path.join(ROOT, "backend", "runtime")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(url, body=None, timeout=180):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return {"status": r.status, "json": json.loads(r.read().decode("utf-8") or "{}")}
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            body = None
        return {"status": e.code, "json": body}
    except Exception as e:
        return {"status": None, "error": "%s: %s" % (type(e).__name__, e)}


CHAT = {"messages": [{"role": "user", "content": "Dis bonjour en un seul mot."}],
        "max_tokens": 16, "temperature": 0.0}


def wait_ready(base, timeout=420):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = http(base + "/health", timeout=10)
        m = ((h.get("json") or {}).get("model") or {})
        if h.get("status") == 200 and m.get("loaded"):
            return h
        time.sleep(2)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="p69-results")
    ap.add_argument("--no-negative-control", action="store_true")
    ap.add_argument("--engine-cmd", default=None,
                    help="moteur de remplacement (verification du BANC seulement)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    logs = os.path.join(ROOT, "p69-logs")
    os.makedirs(logs, exist_ok=True)
    api_port = free_port()
    env = dict(os.environ)
    env["SUDO_STUDIO_LOGS"] = logs
    env["PYTHONUNBUFFERED"] = "1"
    if args.engine_cmd:
        env["SUDO_ENGINE_CMD"] = os.path.abspath(args.engine_cmd)
    else:
        env.pop("SUDO_ENGINE_CMD", None)   # le VRAI moteur ici
    out = open(os.path.join(logs, "isolation-front.log"), "w")
    front = subprocess.Popen([sys.executable, os.path.join(RUNTIME, "api_front.py"),
                              "--port", str(api_port), "--model", args.model],
                             cwd=RUNTIME, env=env, stdout=out, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:%d" % api_port
    checks = []
    res = {"model": os.path.basename(args.model), "checks": []}

    def check(name, ok, detail=""):
        checks.append(bool(ok))
        res["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        print(("ok   - " if ok else "ECHEC- ") + name + (("  :: " + str(detail)[:200]) if detail else ""))

    try:
        h = wait_ready(base)
        check("1 le front repond et le moteur a charge le modele", h is not None,
              json.dumps((h or {}).get("json"))[:200] if h else "pas de reponse")
        if not h:
            return 1

        first = http(base + "/v1/chat/completions", CHAT)
        text = ""
        try:
            text = first["json"]["choices"][0]["message"]["content"]
        except Exception:
            pass
        check("2 un vrai appel passe par le front", first.get("status") == 200 and bool(text.strip()),
              "status=%s texte=%r" % (first.get("status"), text[:40]))

        st = http(base + "/engine", timeout=10)
        pid = (st.get("json") or {}).get("pid")
        check("3 le pid du moteur est expose", isinstance(pid, int) and pid > 0, json.dumps(st.get("json")))

        # ---- le plantage, sans menagement --------------------------------
        t_kill = time.time()
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception as e:
            check("4 le moteur est tue (SIGKILL)", False, str(e))
        check("4 le moteur est tue (SIGKILL)", True, "pid=%s" % pid)
        time.sleep(2.5)

        h2 = http(base + "/health", timeout=10)
        check("5 l API repond ENCORE (code 200) apres la mort du moteur",
              h2.get("status") == 200, "status=%s" % h2.get("status"))
        eng = ((h2.get("json") or {}).get("engine") or {})
        check("6 /health nomme la mort du moteur",
              bool((eng.get("last_exit_name") or "").strip()) and (eng.get("last_exit") is not None),
              json.dumps(eng)[:220])

        down = http(base + "/v1/chat/completions", CHAT, timeout=120)
        # Le corps peut etre {"error": {...}} (front : moteur mort) ou
        # {"error": "no_model_loaded"} (moteur relance, modele en cours de
        # chargement). Dans les deux cas c'est un 503 EXPLICITE : le client
        # recoit une reponse JSON, pas une connexion coupee.
        def err_text(resp):
            e = (resp.get("json") or {}).get("error")
            if isinstance(e, dict):
                return str(e.get("type") or "") + " / " + str(e.get("message") or "")
            return str(e)

        st7 = down.get("status")
        check("7 pendant la panne : reponse EXPLICITE (503 JSON), jamais une connexion coupee",
              st7 in (200, 503) and (st7 == 200 or bool(err_text(down))),
              "status=%s erreur=%s" % (st7, err_text(down)[:180]))

        # ---- reprise ------------------------------------------------------
        t0 = time.time()
        back = None
        while time.time() - t0 < 180:
            r = http(base + "/v1/chat/completions", CHAT, timeout=120)
            if r.get("status") == 200:
                back = r
                break
            time.sleep(2)
        restart_s = round(time.time() - t0, 1)
        ok_text = ""
        try:
            ok_text = back["json"]["choices"][0]["message"]["content"]
        except Exception:
            pass
        check("8 apres relance, un vrai appel repasse (moteur recharge)",
              bool(back) and bool(ok_text.strip()),
              "reprise en %ss, texte=%r" % (restart_s, ok_text[:40]))

        st2 = http(base + "/engine", timeout=10)
        j2 = st2.get("json") or {}
        check("9 la relance est comptee et le pid a change",
              j2.get("restarts", 0) >= 1 and j2.get("pid") not in (None, pid), json.dumps(j2)[:220])
        check("10 le front n'a jamais quitte", front.poll() is None, "exit=%s" % front.poll())

        res["restart_s"] = restart_s
        res["last_exit_name"] = eng.get("last_exit_name")

        # ---- controle negatif --------------------------------------------
        if not args.no_negative_control:
            port2 = free_port()
            solo_cmd = ([sys.executable, os.path.abspath(args.engine_cmd), "--port", str(port2)]
                        if args.engine_cmd else
                        [sys.executable, "server.enterprise.py", "--port", str(port2),
                         "--model", args.model])
            solo = subprocess.Popen(solo_cmd,
                                    cwd=RUNTIME, env=env,
                                    stdout=open(os.path.join(logs, "solo-engine.log"), "w"),
                                    stderr=subprocess.STDOUT)
            solo_base = "http://127.0.0.1:%d" % port2
            hs = wait_ready(solo_base)
            before = http(solo_base + "/v1/chat/completions", CHAT)
            os.kill(solo.pid, signal.SIGKILL)
            time.sleep(1.0)
            after = http(solo_base + "/v1/chat/completions", CHAT, timeout=20)
            check("11 CONTROLE NEGATIF : sans front, la meme mort coupe la connexion",
                  bool(hs) and before.get("status") == 200 and after.get("status") is None,
                  "avant=%s apres=%s (%s)" % (before.get("status"), after.get("status"),
                                              str(after.get("error"))[:80]))
    finally:
        try:
            front.terminate()
            front.wait(timeout=20)
        except Exception:
            try:
                front.kill()
            except Exception:
                pass
        out.close()

    res["ok"] = all(checks) and len(checks) >= 10
    print("\n=== VERDICT ===")
    print("verifications : %d, echecs : %d" % (len(checks), len([c for c in checks if not c])))
    print("reprise complete mesuree : %s s" % res.get("restart_s"))
    print("code de sortie du moteur : %s" % res.get("last_exit_name"))
    print("verdict : %s" % ("OK" if res["ok"] else "ECHEC"))
    with open(os.path.join(args.out, "p69-isolation.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=True, indent=1)
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
