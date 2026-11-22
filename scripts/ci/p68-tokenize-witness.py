#!/usr/bin/env python3
"""P68-B (temoin) : le comptage de jetons qui sert VRAIMENT dans le produit.

Pourquoi ce fichier existe
--------------------------
`p68-context-bench.py` mesure deux choses differentes :
  1. la fenetre reelle du modele (critere : >= 70 % du nominal) ;
  2. l'ERREUR DE L'ESTIMATEUR hors ligne (formule chars/4 corrigee).
Le second chiffre est monte a 15,74 % et faisait echouer le job. C'etait une
comparaison mal posee : le produit n'utilise cette formule QUE si le runtime
est injoignable. Des qu'il repond, l'agent demande le compte exact au
tokeniseur du modele (POST /tokenize), et l'erreur est nulle PAR CONSTRUCTION.

Ce temoin mesure ce chemin-la, avec le vrai modele :
  a. demarre le vrai serveur sur un port libre, charge le modele ;
  b. pour chaque prompt du corpus : compare POST /tokenize au comptage
     effectue en direct par llama.cpp ;
  c. fait la meme chose a travers le code de l'agent (countTokens), donc par
     le chemin reel du produit ;
  d. ecrit p68-tokenize.json et sort 0 seulement si l'ecart maximal est 0.

Aucun chiffre n'est suppose : si le serveur ne repond pas, le temoin sort 3 et
le dit.

ASCII only.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNTIME = os.path.join(ROOT, "backend", "runtime")
AGENT = os.path.join(ROOT, "sudo-agent", "src")

# Corpus court mais varie : francais accentue, code, JSON, chemins Windows,
# sortie d'outil. C'est exactement ce que l'agent envoie.
CORPUS = [
    ("note-systeme", "Tu es un assistant. Reponds en francais, sans emoji."),
    ("code-py", "def lit(chemin):\n    with open(chemin, 'r', encoding='utf-8') as f:\n        return f.read()\n"),
    ("json-outils", '{"name": "read_file", "arguments": {"path": "src/app.js", "limit": 200}}'),
    ("prose-fr", "Le service de facturation traite les commandes du lundi au vendredi. "
                 "Chaque nuit, il recalcule les totaux et signale les ecarts superieurs a un centime."),
    ("chemins-win", r"C:\Users\jules\AppData\Local\SudoStudio\logs\runtime-supervisor.log"),
    ("accents", "Les eleves ont ete reunis a l'ecole ; l'annee a ete dense et l'equipe a ete recompensee."),
    ("sortie-outil", "\n".join("src/module_%02d.js  %d lignes" % (i, 40 + i) for i in range(20))),
    ("diff", "--- a/app.js\n+++ b/app.js\n@@ -1,3 +1,4 @@\n-const x = 1;\n+const x = 2;\n+const y = 3;\n"),
]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(url, body=None, timeout=30):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def wait_loaded(base, timeout=420):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            _, h = http(base + "/health", timeout=10)
            m = h.get("model") or {}
            if m.get("loaded") and not m.get("loading"):
                return h
        except Exception:
            pass
        time.sleep(2)
    return None


def agent_count(base, text):
    """Le chemin REEL du produit : sudo-agent/src/providers.js -> countTokens."""
    js = (
        "const p=require(%s);"
        "(async()=>{const r=await p.countTokens({type:'local',baseUrl:process.argv[1]},process.argv[2]);"
        "console.log(JSON.stringify(r));})();"
        % json.dumps(os.path.join(AGENT, "providers.js"))
    )
    out = subprocess.run(["node", "-e", js, base, text], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        return {"tokens": None, "source": "erreur node: " + (out.stderr or "")[:120]}
    try:
        return json.loads((out.stdout or "").strip().splitlines()[-1])
    except Exception:
        return {"tokens": None, "source": "sortie illisible"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="p68-results")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    port = free_port()
    base = "http://127.0.0.1:%d" % port
    logs = os.path.join(ROOT, "p68-logs")
    os.makedirs(logs, exist_ok=True)
    logf = open(os.path.join(logs, "tokenize-server.log"), "w")
    env = dict(os.environ)
    env["SUDO_STUDIO_LOGS"] = logs
    proc = subprocess.Popen([sys.executable, "server.enterprise.py", "--port", str(port),
                             "--model", args.model], cwd=RUNTIME, env=env,
                            stdout=logf, stderr=subprocess.STDOUT)
    result = {"model": os.path.basename(args.model), "checks": [], "ok": False}
    try:
        h = wait_loaded(base)
        if not h:
            print("ECHEC : le serveur n'a pas charge le modele (voir p68-logs/tokenize-server.log)")
            result["why"] = "modele non charge"
            json.dump(result, open(os.path.join(args.out, "p68-tokenize.json"), "w"), indent=1)
            return 3
        n_ctx = (h.get("model") or {}).get("n_ctx")
        print("serveur pret : n_ctx=%s  modele=%s" % (n_ctx, (h.get("model") or {}).get("name")))

        # comptage de reference, en direct
        from llama_cpp import Llama
        ref = Llama(model_path=args.model, n_ctx=512, verbose=False)

        rows = []
        max_diff = 0
        max_diff_agent = 0
        for cid, text in CORPUS:
            truth = len(ref.tokenize(text.encode("utf-8")))
            st, body = http(base + "/tokenize", {"text": text}, timeout=30)
            srv = body.get("tokens")
            ag = agent_count(base, text)
            d1 = abs(int(srv) - truth) if isinstance(srv, int) else None
            d2 = abs(int(ag["tokens"]) - truth) if isinstance(ag.get("tokens"), int) else None
            if d1 is not None:
                max_diff = max(max_diff, d1)
            if d2 is not None:
                max_diff_agent = max(max_diff_agent, d2)
            rows.append({"id": cid, "reel": truth, "serveur": srv, "agent": ag.get("tokens"),
                         "source_agent": ag.get("source"), "ecart_serveur": d1, "ecart_agent": d2})
            print("  %-13s reel=%4d  /tokenize=%4s  agent=%4s (%s)"
                  % (cid, truth, srv, ag.get("tokens"), ag.get("source")))

        result["rows"] = rows
        result["ecart_max_serveur"] = max_diff
        result["ecart_max_agent"] = max_diff_agent
        result["n"] = len(rows)
        result["ok"] = (max_diff == 0 and max_diff_agent == 0 and len(rows) == len(CORPUS))
        print("\n=== TEMOIN ===")
        print("prompts                 : %d" % len(rows))
        print("ecart max /tokenize      : %d jeton(s)  (critere : 0)" % max_diff)
        print("ecart max chemin agent   : %d jeton(s)  (critere : 0)" % max_diff_agent)
        print("verdict                  : %s" % ("OK" if result["ok"] else "ECHEC"))
        json.dump(result, open(os.path.join(args.out, "p68-tokenize.json"), "w"), ensure_ascii=True, indent=1)
        return 0 if result["ok"] else 1
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        logf.close()


if __name__ == "__main__":
    sys.exit(main())
