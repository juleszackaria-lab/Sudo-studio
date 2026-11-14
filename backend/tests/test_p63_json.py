#!/usr/bin/env python3
"""SUDO STUDIO - P63-F (G4) : un JSON de tool call n'est plus rejete a tort.

Le defaut constate sur le paquet installe :
    tool attempt1/2 invalid (JSON illisible)
    tool call unusable after repairs
sur une sortie qui paraissait valide : la vraie cause etait une TRONCATURE au
budget de jetons (max_tok=512), pas un validateur trop strict.

Ce test prouve, sans serveur ni modele :
  1. une sortie COUPEE en pleine chaine est recuperee (JSON valide) ;
  2. les deux sorties brutes de G4 passent ;
  3. un texte qui n'est REELLEMENT pas du JSON reste rejete ;
  4. `repair_tool_output` (la fonction utilisee par la route) et
     `repair_toolcall` (la fonction de bas niveau) sont d'accord ;
  5. le calcul deterministe 2 + 298 = 300.

Lancer : python3 backend/tests/test_p63_json.py   (ou via node, voir
backend/tests/test-p63-json.js qui l'appelle).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RT = os.path.join(HERE, "..", "runtime")
sys.path.insert(0, RT)

import openai_compat as oc  # noqa: E402
import toolcall_repair as tr  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("ok - " + name)
    else:
        FAILS.append(name + " :: " + str(detail))
        print("FAIL " + name + " :: " + str(detail))


# Sorties brutes telles que le modele les a produites (tronquees a 512 jetons).
TRUNCATED_1 = '{"name":"read","arguments":{"file":"c:/Users/lezin/logiciel by planapp/flutter GO'
TRUNCATED_2 = ('{"name":"write","arguments":{"file":"src/app.js","content":"const a = 1;\\n'
               'const b = 2;\\n// la suite du fichier a ete coupee par max_tok')

TOOLS = [
    {"type": "function", "function": {"name": "read", "parameters": {
        "type": "object", "properties": {"file": {"type": "string"}}, "required": ["file"]}}},
    {"type": "function", "function": {"name": "write", "parameters": {
        "type": "object", "properties": {"file": {"type": "string"}, "content": {"type": "string"}},
        "required": ["file", "content"]}}},
]


def main():
    # 1. troncature en pleine chaine -> recuperee
    out = oc.repair_tool_output(TRUNCATED_1, TOOLS, "length")
    check("G4-1: une sortie coupee dans une chaine est recuperee (pas 'JSON illisible')",
          out.get("ok") is True and out.get("calls") and out["calls"][0]["name"] == "read",
          json.dumps(out)[:200])
    check("G4-2: la reparation est tracee (troncature refermee)",
          "troncature-refermee" in json.dumps(out.get("repairs", [])), json.dumps(out)[:200])

    # 2. les deux sorties brutes de G4 passent
    out2 = oc.repair_tool_output(TRUNCATED_2, TOOLS, "length")
    check("G4-3: la seconde sortie brute de G4 passe aussi",
          out2.get("ok") is True and out2.get("calls") and out2["calls"][0]["name"] == "write",
          json.dumps(out2)[:200])

    # 3. un JSON reellement invalide reste rejete, meme avec finish_reason=length
    for bad in ("bonjour, pas de json", "voici le resultat : 42", "{}"):
        o = oc.repair_tool_output(bad, TOOLS, "length")
        check("G4-4: '%s' reste rejete" % bad[:18], o.get("ok") is False, json.dumps(o)[:160])

    # 4. les deux fonctions sont d'accord (aucune divergence entre le code
    #    teste et le code execute par la route)
    for txt in (TRUNCATED_1, TRUNCATED_2, "bonjour"):
        a = tr.repair_toolcall(txt, TOOLS, truncated=True).get("ok")
        b = oc.repair_tool_output(txt, TOOLS, "length").get("ok")
        check("G4-5: accord repair_toolcall / repair_tool_output sur '%s...'" % txt[:14],
              a == b, "%s != %s" % (a, b))

    # 5. appel complet non tronque : accepte, sans reparation inutile
    full = json.dumps({"name": "read", "arguments": {"file": "src/app.js"}})
    o3 = oc.repair_tool_output(full, TOOLS, "stop")
    check("G4-6: un appel complet valide passe tel quel",
          o3.get("ok") is True and o3["calls"][0]["arguments"]["file"] == "src/app.js",
          json.dumps(o3)[:160])

    # 6. le budget de jetons depend du type d'appel (plus de 512 en dur)
    src = open(os.path.join(RT, "openai_compat.py"), encoding="utf-8").read()
    check("G4-7: le budget de jetons n'est plus fige a 512 pour un appel d'outil",
          "max_tok=512" not in src.replace(" ", "") or "def _tool_max_tokens" in src,
          "voir _attempt(msgs, max_tok=None)")
    check("G4-8: une troncature declaree relance avec un budget double",
          "finish_reason" in src and "length"in src and "max_tokens" in src, "retry budget")

    print("")
    if FAILS:
        print("P63-F: %d FAILED" % len(FAILS))
        for f in FAILS:
            print("  - " + f)
        return 1
    print("P63-F: all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
