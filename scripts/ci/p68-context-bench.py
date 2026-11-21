#!/usr/bin/env python3
"""P68-B: MESURE DE LA FENETRE DE CONTEXTE REELLE (vrai modele, aucun faux fournisseur).

Trois questions, trois mesures, sur le modele GGUF du produit :

  1. FENETRE REELLE : pour n_ctx = 2048 / 4096 / 8192, quelle part du contexte
     nominal est REELLEMENT utilisable ? On remplit le prompt de texte neutre,
     on cache un mot temoin AU DEBUT du remplissage, et on exige que le modele
     le restitue. S'il ne le restitue plus, le debut du prompt n'est plus lu :
     c'est la fenetre REELLE, pas la fenetre annoncee. Recherche dichotomique.

  2. MEMOIRE : RSS du processus apres chargement, par n_ctx (le profil RAM 2048
     doit tenir dans une machine modeste).

  3. ESTIMATEUR DE JETONS : l'estimateur du produit (sudo-agent/src/profiles.js,
     chars/4 + 64) est-il a moins de 5 % du comptage REEL du modele ? On compare
     sur un corpus de textes realistes (francais, code, JSON, chemins Windows).

Sortie : un JSON + un tableau lisible. Code de sortie 1 si un critere echoue
(fenetre < 70 % au nominal, ou estimateur > 5 % d'erreur moyenne), 0 sinon :
le job CI doit pouvoir etre ROUGE.

Usage :
  python3 scripts/ci/p68-context-bench.py --model <fichier.gguf> --out p68-results \
      [--ctx 2048,4096,8192] [--node node]

ASCII only pour la sortie standard.
"""

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

SECRET = "ZORBULAX"
FILLER = ("Le service de facturation traite les commandes du lundi au vendredi. "
          "Chaque ligne du journal contient un identifiant, une date et un montant. "
          "Les erreurs sont reessayees trois fois avant d etre signalees. ")

# Corpus pour l'estimateur : ce que le produit envoie VRAIMENT au modele.
# Le critere porte sur la colonne "long" (>=300 caracteres) : c'est la que
# l'estimateur sert a quelque chose (budget de contexte). Les entrees courtes
# restent affichees a titre indicatif : une marge forfaitaire y pese forcement
# trop lourd en pourcentage, ce n'est pas une erreur de conversion.
CORPUS = [
    ("note-systeme-fr", "long",
     "Tu es un agent de developpement integre a l editeur. Tu disposes d outils pour lire, "
     "ecrire et modifier des fichiers du projet. Reponds toujours en francais, de facon concise "
     "et directement actionnable. N invente jamais un chemin de fichier : si un fichier est "
     "demande par un nom approximatif, cherche d abord la correspondance la plus proche dans le "
     "projet avant de repondre. Si une commande echoue, lis le message d erreur et corrige la "
     "cause au lieu de reessayer a l identique. Termine toujours par un resume de ce que tu as "
     "fait et de ce qui reste a faire."),
    ("code-js", "long",
     "function estimateTokens(messages, schemaChars) {\n"
     "  let chars = 0;\n  for (const m of messages || []) {\n    chars += 32;\n"
     "    if (m && typeof m.content === 'string') chars += m.content.length;\n"
     "    if (m && Array.isArray(m.tool_calls)) {\n"
     "      for (const c of m.tool_calls) chars += String((c && c.function && c.function.arguments) || '').length + 32;\n"
     "    }\n  }\n  chars += schemaChars || 0;\n  return Math.ceil(chars / 4) + 64;\n}\n"),
    ("code-py", "long",
     "def trim_messages_to_budget(messages, budget_tokens):\n"
     "    \"\"\"Garde le systeme et les derniers messages dans le budget.\"\"\"\n"
     "    keep = []\n    total = 0\n    for m in reversed(messages or []):\n"
     "        n = len(str(m.get('content') or '')) // 4 + 32\n"
     "        if keep and total + n > budget_tokens:\n            break\n"
     "        keep.append(m)\n        total += n\n    return list(reversed(keep))\n"),
    ("json-outils", "long",
     '[{"type":"function","function":{"name":"read","description":"Lire un fichier du projet",'
     '"parameters":{"type":"object","properties":{"file":{"type":"string"}},"required":["file"]}}},'
     '{"type":"function","function":{"name":"write","description":"Creer un fichier du projet",'
     '"parameters":{"type":"object","properties":{"file":{"type":"string"},"content":{"type":"string"}},'
     '"required":["file","content"]}}},{"type":"function","function":{"name":"edit",'
     '"description":"Remplacer une chaine exacte","parameters":{"type":"object","properties":'
     '{"file":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}},'
     '"required":["file","old","new"]}}}]'),
    ("liste-fichiers", "long",
     "\n".join("src/modules/module_%02d.js  (lignes 1-%d, modifie il y a %d jours)" % (i, 40 + i, i)
               for i in range(25))),
    ("sortie-outil", "long",
     "".join("ligne %d : ok  (backend/tests/test-p%02d.js)  %d ms\n" % (i, i, 3 * i) for i in range(80))),
    ("prose-fr", "long",
     FILLER * 6),
    ("chemins-win", "long",
     "\r\n".join("C:\\Users\\jules\\Documents\\projets\\sudo-studio\\backend\\runtime\\module_%02d.py" % i
                  for i in range(20))),
    ("accents-courts", "court",
     "Les eleves ont ecrit une histoire drole, cependant la maitresse a souligne les fautes."),
    ("consigne-courte", "court",
     "Utilise l audit de securite sur ce projet et dis moi s il y a des secrets exposes."),
]


def filler_for(tokens, model_tok):
    """Texte neutre d'environ `tokens` jetons (mesure reelle par le tokeniseur)."""
    unit = FILLER
    n_unit = len(model_tok(unit))
    if n_unit <= 0:
        return ""
    reps = max(1, int(tokens / n_unit))
    return unit * reps


def rss_mb():
    try:
        with open("/proc/self/status", "r") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024.0, 1)
    except Exception:
        pass
    try:
        import resource
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)
    except Exception:
        return None


def probe(llm, model_tok, n_ctx, budget):
    """Un essai : le mot temoin est au DEBUT, on demande de le recopier."""
    body = filler_for(max(0, budget - 120), model_tok)
    prompt = ("MOT TEMOIN : %s\n\n%s\n\nQuestion : quel est le MOT TEMOIN indique "
              "au tout debut de ce message ? Reponds uniquement par ce mot.\n" % (SECRET, body))
    n_prompt = len(model_tok(prompt))
    t0 = time.time()
    try:
        out = llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0, max_tokens=24)
        text = ((out.get("choices") or [{}])[0].get("message") or {}).get("content", "") or ""
        usage = out.get("usage") or {}
        pt = int(usage.get("prompt_tokens") or n_prompt)
        ct = int(usage.get("completion_tokens") or 0)
        err = None
    except Exception as e:
        text, pt, ct, err = "", n_prompt, 0, str(e)[:120]
    dt = time.time() - t0
    ok = (err is None) and (SECRET in text.upper()) and (pt + ct <= n_ctx)
    return {"budget": budget, "prompt_tokens": pt, "completion_tokens": ct,
            "ok": ok, "err": err, "secondes": round(dt, 2),
            "reponse": text.strip()[:60]}


def real_window(llm, model_tok, n_ctx):
    """Dichotomie : plus grand prompt dont le debut est encore lu et la reponse valide."""
    lo, hi = 128, max(256, n_ctx - 64)
    best = 0
    trace = []
    # premier sondage a 70 % : c'est l'hypothese du jour, on la teste en premier
    first = probe(llm, model_tok, n_ctx, int(n_ctx * 0.70))
    trace.append(first)
    if first["ok"]:
        best = first["budget"]
        lo = first["budget"]
    else:
        hi = first["budget"]
    while hi - lo > 64:
        mid = (lo + hi) // 2
        r = probe(llm, model_tok, n_ctx, mid)
        trace.append(r)
        if r["ok"]:
            best = mid
            lo = mid
        else:
            hi = mid
    return best, trace


def estimator_errors(node_bin):
    """Erreur de l'estimateur du produit : renvoie (rows, moyenne, max)."""
    import json as _json
    payload = [{"id": cid, "text": txt} for cid, txt in CORPUS]
    js = (
        "const path=require('path');\n"
        "const root=process.argv[2];\n"
        "const p=require(path.join(root,'sudo-agent','src','profiles.js'));\n"
        "const data=JSON.parse(require('fs').readFileSync(0,'utf8'));\n"
        "const out=data.map(d=>({id:d.id,est:p.estimateTokens([{role:'user',content:d.text}],0)}));\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    tmp = os.path.join(ROOT, ".p68-estimator.js")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(js)
    try:
        proc = subprocess.run([node_bin, tmp, ROOT], input=_json.dumps(payload),
                              capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "node")[:200])
        est = {r["id"]: int(r["est"]) for r in _json.loads(proc.stdout)}
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
    return est


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="p68-results")
    ap.add_argument("--ctx", default="2048,4096,8192")
    ap.add_argument("--node", default="node")
    args = ap.parse_args()

    ctxs = [int(x) for x in str(args.ctx).split(",") if x.strip()]
    from llama_cpp import Llama

    results = {"model": os.path.basename(args.model), "ctx": {}, "estimateur": {},
               "verdict": {}}

    # ---- estimateur (independant du chargement) -----------------------------
    est = estimator_errors(args.node)

    for n_ctx in ctxs:
        print("\n=== n_ctx = %d ===" % n_ctx)
        t_load = time.time()
        llm = Llama(model_path=args.model, n_ctx=n_ctx, n_threads=max(2, (os.cpu_count() or 4) - 1),
                    verbose=False)
        load_s = round(time.time() - t_load, 1)
        base_rss = rss_mb()
        model_tok = lambda s: llm.tokenize(s.encode("utf-8"))

        best, trace = real_window(llm, model_tok, n_ctx)
        ratio = round(100.0 * best / n_ctx, 1)
        print("fenetre reelle : %d / %d jetons = %.1f %% (%d sondes, chargement %.1fs, RSS %.0f Mo)"
              % (best, n_ctx, ratio, len(trace), load_s, base_rss or 0))

        # ---- estimateur, mesure reelle par le tokeniseur de CE modele --------
        rows = []
        tot_chars = tot_real = 0
        for cid, kind, txt in CORPUS:
            real = len(model_tok(txt))
            e = est.get(cid, 0)
            err = (100.0 * (e - real) / real) if real else 0.0
            rows.append({"id": cid, "classe": kind, "chars": len(txt), "reel": real,
                         "estime": e, "chars_par_jeton": round(len(txt) / real, 2) if real else None,
                         "erreur_pct": round(err, 1)})
            print("  %-18s %-5s %5d car. reel=%5d estime=%5d erreur=%+7.1f %%"
                  % (cid, kind, len(txt), real, e, err))
            if kind == "long":
                tot_chars += len(txt)
                tot_real += real
        longs = [r for r in rows if r["classe"] == "long"]
        mean_abs = round(sum(abs(r["erreur_pct"]) for r in longs) / max(1, len(longs)), 2)
        max_abs = round(max(abs(r["erreur_pct"]) for r in longs), 2) if longs else 0.0
        ratio = round(tot_chars / tot_real, 2) if tot_real else None
        print("  PROMPTS REELS : erreur moyenne |%%| = %.2f  (max %.2f)  calibrage observe : %.2f car./jeton"
              % (mean_abs, max_abs, ratio or 0))

        results["ctx"][str(n_ctx)] = {
            "fenetre_reelle": best, "ratio_pct": ratio, "sondes": trace,
            "chargement_s": load_s, "rss_mo": base_rss,
        }
        results["estimateur"][str(n_ctx)] = {"rows": rows, "erreur_moyenne_pct": mean_abs,
                                             "erreur_max_pct": max_abs,
                                             "chars_par_jeton": ratio}
        del llm

    ratios = [results["ctx"][str(c)]["ratio_pct"] for c in ctxs]
    est_mean = max(results["estimateur"][str(c)]["erreur_moyenne_pct"] for c in ctxs)
    est_max = max(results["estimateur"][str(c)]["erreur_max_pct"] for c in ctxs)
    results["verdict"] = {
        "fenetre_min_pct": min(ratios),
        "fenetre_critere_pct": 70.0,
        "fenetre_ok": min(ratios) >= 70.0,
        "estimateur_moyen_pct": est_mean,
        "estimateur_max_pct": est_max,
        "estimateur_critere_pct": 5.0,
        "estimateur_ok": est_mean <= 5.0,
        "rss_2048_mo": results["ctx"].get("2048", {}).get("rss_mo"),
        "chars_par_jeton": results["estimateur"][str(ctxs[0])].get("chars_par_jeton"),
    }
    v = results["verdict"]
    print("\n=== VERDICT ===")
    print("fenetre reelle minimale : %.1f %% (critere >= 70 %%) -> %s"
          % (v["fenetre_min_pct"], "OK" if v["fenetre_ok"] else "ECHEC"))
    print("estimateur             : moyenne %.2f %% / max %.2f %% (critere <= 5 %%) -> %s"
          % (v["estimateur_moyen_pct"], v["estimateur_max_pct"],
             "OK" if v["estimateur_ok"] else "ECHEC"))
    print("RSS au profil 2048      : %s Mo" % v["rss_2048_mo"])
    print("calibrage observe       : %s car./jeton (l estimateur du produit divise par 4)" % v["chars_par_jeton"])

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "p68-context.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=True, indent=1)
    print("ecrit : %s" % path)
    return 0 if (v["fenetre_ok"] and v["estimateur_ok"]) else 1


if __name__ == "__main__":
    sys.exit(main())
