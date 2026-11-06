#!/usr/bin/env python3
"""MISSION P55(2) - reparation des appels d'outils, tests deterministes.

Prouve, sans Flask ni llama, que le pipeline de reparation :

  - accepte l'objet attendu ;
  - retire les clotures markdown et le texte autour ;
  - decode des "arguments" donnes en TEXTE JSON ;
  - remplace des "arguments" absents par un objet vide ;
  - corrige une virgule finale / des guillemets typographiques ;
  - separe PLUSIEURS appels dans une meme reponse ;
  - rapproche un nom d'outil approximatif (casse, separateurs, prefixe) ;
  - refuse un outil inconnu avec une erreur STRUCTUREE (champ + message +
    exemple valide) au lieu d'une exception ;
  - refuse des arguments inutilisables de la meme facon.

Et que `openai_compat.parse_toolcall_json` (contrat P1) delegue bien a ce
pipeline : succes pour les cas reparables, explication structuree sinon.

Usage : python3 test_p55_toolcall_repair.py   (code 0 = tout passe)
ASCII only.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolcall_repair as R  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS " + name)
    else:
        FAIL += 1
        print("FAIL " + name + " :: " + str(detail)[:200])


TOOLS = [
    {"type": "function", "function": {"name": "read", "parameters": {
        "type": "object", "properties": {"file": {"type": "string"}}, "required": ["file"]}}},
    {"type": "function", "function": {"name": "write", "parameters": {
        "type": "object", "properties": {"file": {"type": "string"}, "content": {"type": "string"}},
        "required": ["file", "content"]}}},
    {"type": "function", "function": {"name": "done", "parameters": {
        "type": "object", "properties": {"summary": {"type": "string"}}}}},
]


def calls_of(text):
    r = R.repair_toolcall(text, TOOLS)
    return r, r.get("calls") or []


# 1. objet attendu
r, c = calls_of('{"name": "read", "arguments": {"file": "a.txt"}}')
check("objet attendu accepte", r.get("ok") and c[0]["name"] == "read"
      and c[0]["arguments"] == {"file": "a.txt"} and r.get("repairs") == [], r)

# 2. cloture markdown + texte autour
r, c = calls_of('Voici l appel :\n```json\n{"name":"read","arguments":{"file":"b.txt"}}\n```\nTermine.')
check("cloture markdown retiree", r.get("ok") and c[0]["arguments"] == {"file": "b.txt"}
      and "cloture-markdown-retiree" in r.get("repairs"), r)

# 3. arguments donnes en texte JSON
r, c = calls_of('{"name":"read","arguments":"{\\"file\\": \\"c.txt\\"}"}')
check("arguments texte JSON decodes", r.get("ok") and c[0]["arguments"] == {"file": "c.txt"}, r)

# 4. arguments absents -> objet vide
r, c = calls_of('{"name":"done"}')
check("arguments absents -> objet vide", r.get("ok") and c[0]["arguments"] == {}
      and "arguments-absent" in r.get("repairs"), r)

# 5. virgule finale + guillemets typographiques
r, c = calls_of('{"name":"read","arguments":{"file":"d.txt",}}')
check("virgule finale corrigee", r.get("ok") and c[0]["arguments"] == {"file": "d.txt"}, r)
r, c = calls_of('{\u201cname\u201d: \u201cread\u201d, \u201carguments\u201d: {\u201cfile\u201d: \u201ce.txt\u201d}}')
check("guillemets typographiques corriges", r.get("ok") and c[0]["arguments"] == {"file": "e.txt"}, r)

# 6. plusieurs appels dans une reponse
r, c = calls_of('{"name":"read","arguments":{"file":"f.txt"}}\n{"name":"read","arguments":{"file":"g.txt"}}')
check("appels multiples separes", r.get("ok") and len(c) == 2 and c[1]["arguments"] == {"file": "g.txt"}
      and "appels-multiples-separes" in r.get("repairs"), r)

# 7. format OpenAI imbrique
r, c = calls_of('{"tool_calls":[{"function":{"name":"read","arguments":"{\\"file\\":\\"h.txt\\"}"}}]}')
check("format tool_calls accepte", r.get("ok") and c[0]["name"] == "read"
      and c[0]["arguments"] == {"file": "h.txt"}, r)

# 8. noms approximatifs
for raw, expect in (("Read", "read"), ("read_file", "read"), ("READ-FILE", "read")):
    r, c = calls_of('{"name":"%s","arguments":{"file":"i.txt"}}' % raw)
    check("nom approximatif %s -> %s" % (raw, expect), r.get("ok") and c[0]["name"] == expect, r)

# 9. outil inconnu -> erreur structuree avec exemple valide
r, c = calls_of('{"name":"supprime_tout","arguments":{}}')
check("outil inconnu : erreur structuree", (not r.get("ok")) and r.get("code") == "invalid_tool_call"
      and r.get("field") == "name" and "outil inconnu" in r.get("detail", "")
      and isinstance(r.get("example"), dict) and r["example"].get("tool"), r)
check("message de reparation explicite", "Reponds par" in R.describe_error(r)
      and "Exemple valide" in R.describe_error(r), R.describe_error(r))

# 10. arguments inutilisables -> erreur structuree, pas d'exception
r, c = calls_of('{"name":"read","arguments":["a"]}')
check("arguments liste : erreur structuree", (not r.get("ok")) and r.get("field") == "arguments", r)
r, c = calls_of('Je vais lire le fichier.')
check("texte libre : erreur structuree", (not r.get("ok")) and r.get("field") == "json", r)
r, c = R.repair_toolcall(None, TOOLS), None
check("reponse vide : erreur structuree", (not r.get("ok")) and r.get("field") == "reply", r)

# 11. exemples d'appel valides pour le modele
ex = R.example_for(TOOLS, "write")
check("exemple construit depuis le schema", ex.get("tool") == "write" and "file" in ex.get("args", {}), ex)

# 12. le contrat P1 delegue bien (pas de exception, explication en cas d'echec)
import openai_compat as oc  # noqa: E402

p, e = oc.parse_toolcall_json('```json\n{"name":"read","arguments":"{\\"file\\":\\"j.txt\\"}"}\n```', TOOLS)
check("parse P1 : reparation transparente", p == {"name": "read", "arguments": {"file": "j.txt"}}, (p, e))
p, e = oc.parse_toolcall_json('{"name":"inconnu_xyz","arguments":{}}', TOOLS)
check("parse P1 : echec explique", p is None and "Appel invalide" in str(e), (p, e))

print("\n== %d PASS, %d FAIL ==" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
