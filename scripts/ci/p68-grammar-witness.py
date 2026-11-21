#!/usr/bin/env python3
"""P68-A3: TEMOIN DE GRAMMAIRE avec le vrai modele (aucun faux fournisseur).

Le banc pose 50 consignes francaises au modele avec le jeu d'outils du
produit, exactement comme le runtime le fait (note systeme decrivant le format
JSON + grammaire passee au moteur). Pour chaque sortie :

  - analyse STRICTE (json.loads), sans aucune reparation ;
  - validation de schema (objet {name, arguments}, nom dans la liste exposee,
    arguments = objet, champs requis presents).

Deux modes :

  --grammar fixed    la grammaire du depot (backend/runtime/grammar.py)
  --grammar legacy   la grammaire d'AVANT le correctif, reconstruite a
                     l'identique (temoins negatifs : la meme serie doit etre
                     rouge)

Le temoin negatif n'est pas un commentaire : c'est la meme mesure, au meme
moment, sur la version cassee.

Usage:
  python3 scripts/ci/p68-grammar-witness.py --model <fichier.gguf> \
      --grammar fixed --out p68-results

ASCII only. Ecrit un JSON + un tableau lisible sur la sortie standard.
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "backend", "runtime"))

# ---------------------------------------------------------------------------
# Outils exposes (schemas minimaux, ceux du produit)
# ---------------------------------------------------------------------------
TOOLS = [
    {"type": "function", "function": {"name": "read", "description": "Lire un fichier",
     "parameters": {"type": "object", "properties": {"file": {"type": "string"}}, "required": ["file"]}}},
    {"type": "function", "function": {"name": "write", "description": "Creer un fichier",
     "parameters": {"type": "object", "properties": {"file": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["file", "content"]}}},
    {"type": "function", "function": {"name": "edit", "description": "Remplacer une chaine exacte",
     "parameters": {"type": "object", "properties": {"file": {"type": "string"}, "old": {"type": "string"},
                                                    "new": {"type": "string"}},
                    "required": ["file", "old", "new"]}}},
    {"type": "function", "function": {"name": "list", "description": "Lister un dossier",
     "parameters": {"type": "object", "properties": {"dir": {"type": "string"}}, "required": []}}},
    {"type": "function", "function": {"name": "done", "description": "Terminer",
     "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": []}}},
]
REQUIRED = {"read": ["file"], "write": ["file", "content"], "edit": ["file", "old", "new"],
            "list": [], "done": []}

# 50 consignes francaises : 10 par outil, formulations variees.
PROMPTS = [
    ("Lis le fichier app.py", "read"),
    ("Ouvre le fichier src/index.js", "read"),
    ("Affiche le contenu de README.md", "read"),
    ("Montre-moi ce qu'il y a dans package.json", "read"),
    ("Lis config/settings.json s'il te plait", "read"),
    ("Je veux voir le fichier .gitignore", "read"),
    ("Ouvre styles/main.css", "read"),
    ("Lis le fichier notes.txt", "read"),
    ("Donne-moi le contenu de tests/test_app.py", "read"),
    ("Lis server.js", "read"),
    ("Cree un fichier test.txt contenant bonjour", "write"),
    ("Ecris un fichier notes.md avec le texte todo", "write"),
    ("Genere app.js qui contient console.log(1)", "write"),
    ("Cree README.md contenant le titre Projet", "write"),
    ("Ecris dans sortie.txt le mot fin", "write"),
    ("Fais un fichier data.json contenant {}", "write"),
    ("Cree un fichier config.ini avec debug=true", "write"),
    ("Ecris bonjour dans salut.txt", "write"),
    ("Cree le fichier main.c contenant int main", "write"),
    ("Genere un fichier log.txt contenant demarrage", "write"),
    ("Remplace node_modules par vendor dans .gitignore", "edit"),
    ("Dans app.py remplace print par logging", "edit"),
    ("Change la ligne debug=True en debug=False dans config.py", "edit"),
    ("Modifie le titre du README", "edit"),
    ("Remplace 8080 par 3000 dans server.js", "edit"),
    ("Corrige la faute bonjor en bonjour dans notes.txt", "edit"),
    ("Dans style.css remplace #3366cc par #22c55e", "edit"),
    ("Remplace la version 1.0.0 par 1.0.1 dans package.json", "edit"),
    ("Change le nom de la fonction foo par bar dans utils.js", "edit"),
    ("Edite index.html pour remplacer Ancien par Nouveau", "edit"),
    ("Liste les fichiers du projet", "list"),
    ("Montre le contenu du dossier courant", "list"),
    ("Quels fichiers dans src ?", "list"),
    ("Affiche l'arborescence du dossier tests", "list"),
    ("Liste le dossier docs", "list"),
    ("Donne la liste des fichiers de components", "list"),
    ("Montre les fichiers de la racine", "list"),
    ("Liste ce qu'il y a dans backend", "list"),
    ("Affiche les fichiers du repertoire config", "list"),
    ("Qu'y a-t-il dans le dossier public ?", "list"),
    ("J'ai termine, resume ce que tu as fait", "done"),
    ("C'est bon, termine la tache", "done"),
    ("Fin du travail, donne un resume", "done"),
    ("Termine et dis-moi ce qui a ete fait", "done"),
    ("Stop, c'est termine", "done"),
    ("Donne le bilan final", "done"),
    ("Termine avec un resume court", "done"),
    ("C'est fini, merci", "done"),
    ("Conclus le travail", "done"),
    ("Dis que tout est termine", "done"),
]


def sys_note(tools):
    """Meme note systeme que le runtime (openai_compat.tool_defs_for_prompt)."""
    compact = [{"name": t["function"]["name"], "description": t["function"]["description"],
                "parameters": t["function"]["parameters"]} for t in tools]
    return ("You can call functions. Reply with EXACTLY ONE JSON object and nothing else: "
            '{"name": "<function name>", "arguments": {<args>}}. '
            "Available functions: " + json.dumps(compact, ensure_ascii=True))


def legacy_grammar(tools):
    """Grammaire d'AVANT le correctif, reconstruite a l'identique (P68 temoin).

    Deux defauts y sont reproduits tels quels :
      - name ::= "read" | ...   -> litteral GBNF = identifiant NU (sans guillemets)
      - ws ::= [ \\t\\n]*         -> espaces et tabulations multiples
    """
    names = [t["function"]["name"] for t in tools]
    alts = " | ".join('"%s"' % n for n in names)
    head = ('root ::= "{" ws "\\"name\\"" ws ":" ws name ws "," ws '
            '"\\"arguments\\"" ws ":" ws value ws "}"\n'
            'name ::= %s\n' % alts)
    base = r'''
ws ::= [ \t\n]*
value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" ws ( pair ( ws "," ws pair )* )? ws "}"
pair ::= string ws ":" ws value
array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
string ::= "\"" chars "\""
chars ::= [^"\\]*
number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )?
'''
    return head + base


def strict_parse(text, allowed):
    """Analyse stricte + schema. Aucune reparation, aucun nettoyage."""
    raw = str(text or "")
    try:
        obj = json.loads(raw)
    except Exception as e:
        return False, raw, "json_invalide: " + str(e)[:60]
    if not isinstance(obj, dict):
        return False, raw, "pas_un_objet"
    name = obj.get("name")
    if not isinstance(name, str):
        return False, raw, "name_absent"
    if name not in allowed:
        return False, raw, "outil_inconnu:" + str(name)[:20]
    args = obj.get("arguments")
    if not isinstance(args, dict):
        return False, raw, "arguments_non_objet"
    for r in REQUIRED.get(name, []):
        if r not in args:
            return False, raw, "champ_manquant:" + r
    return True, raw, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--grammar", choices=["fixed", "legacy"], default="fixed")
    ap.add_argument("--out", default="p68-results")
    ap.add_argument("--n-ctx", type=int, default=4096)
    args = ap.parse_args()

    from llama_cpp import Llama, LlamaGrammar

    if args.grammar == "fixed":
        import grammar as grammar_mod
        gbnf = grammar_mod.toolcall_grammar(TOOLS)
    else:
        gbnf = legacy_grammar(TOOLS)
    print("=== GRAMMAIRE (%s) ===" % args.grammar)
    print(gbnf)

    gram = LlamaGrammar.from_string(gbnf)
    llm = Llama(model_path=args.model, n_ctx=args.n_ctx, n_threads=max(2, (os.cpu_count() or 4) - 1),
                verbose=False)

    note = sys_note(TOOLS)
    allowed = set(t["function"]["name"] for t in TOOLS)
    rows = []
    t0 = time.time()
    for i, (prompt, expected) in enumerate(PROMPTS, 1):
        msgs = [{"role": "system", "content": note}, {"role": "user", "content": prompt}]
        try:
            out = llm.create_chat_completion(messages=msgs, temperature=0.1, max_tokens=220,
                                             grammar=gram)
            text = ((out.get("choices") or [{}])[0].get("message") or {}).get("content", "")
            usage = out.get("usage") or {}
        except Exception as e:
            text, usage = "", {"error": str(e)[:80]}
        ok, raw, why = strict_parse(text, allowed)
        rows.append({"i": i, "prompt": prompt, "attendu": expected, "valide": ok,
                     "raison": why, "brut": raw[:200],
                     "jetons": usage.get("completion_tokens"), "ms": 0})
        print("[%02d] %s | attendu=%s | %s | %s" % (i, "VALIDE" if ok else "INVALIDE", expected,
                                                    why, raw[:90].replace("\n", " ")))

    total = len(rows)
    good = sum(1 for r in rows if r["valide"])
    dt = time.time() - t0
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "p68-witness-%s.json" % args.grammar)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"grammar": args.grammar, "model": os.path.basename(args.model),
                   "n_ctx": args.n_ctx, "total": total, "valides": good,
                   "duree_s": round(dt, 1), "rows": rows}, f, ensure_ascii=True, indent=1)
    print("\nTOTAL %s : %d/%d sorties JSON strictement valides (%.1f s)" % (args.grammar, good, total, dt))
    # Le temoin DOIT pouvoir echouer : on sort en code 1 si le mode "fixed"
    # n'atteint pas 100 %.
    if args.grammar == "fixed" and good < total:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
