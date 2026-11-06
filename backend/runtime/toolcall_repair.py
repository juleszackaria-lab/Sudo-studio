"""P55 - Reparation des appels d'outils produits par le modele (runtime).

But (exigence P55-2) : une sortie de modele IMPARFAITE ne doit JAMAIS produire
un HTTP 500. On decode, on repare, on explique ; si l'appel reste inutilisable,
le runtime repond 200 avec une erreur STRUCTUREE que le moteur renvoie au
modele avec un exemple valide.

Pipeline (pur, sans Flask ni llama, donc testable seul) :
  1. retirer les clotures markdown et le texte autour ;
  2. trouver le ou les objets JSON equilibres (plusieurs appels -> separes) ;
  3. nom d'outil : champs tolerants (name/tool/function/...) + correspondance
     floue (casse, separateurs, distance d'edition) ;
  4. "arguments" : objet -> tel quel ; texte JSON -> decode ; absent/nul ->
     objet vide ; texte presque-JSON -> petites corrections (virgules finales,
     guillemets simples) ; reste -> erreur structuree ;
  5. outil inconnu -> erreur structuree avec suggestions.

ASCII only.
"""

import difflib
import json
import re

# Champs ou le modele place le nom de l'outil (ordre de priorite).
NAME_KEYS = ("name", "tool", "tool_name", "toolname", "function", "action", "nom")
# Champs ou le modele place les arguments.
ARG_KEYS = ("arguments", "args", "parameters", "params", "input", "argument")

_FENCE_RE = re.compile(r"```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n?(.*?)```", re.S)


def strip_fences(text):
    """Retire les clotures markdown. Renvoie (contenu, avait_cloture)."""
    s = str(text or "")
    m = _FENCE_RE.search(s)
    if m:
        inner = m.group(2)
        return inner.strip(), True
    if s.strip().startswith("```"):
        t = s.strip()[3:]
        if t[:4].lower() == "json":
            t = t[4:]
        return t.strip(), True
    return s, False


def _balanced_objects(text):
    """Extrait les objets JSON equilibres d'un texte (respecte les chaines).

    Renvoie une liste de couples (sous_chaine, objet_decode_ou_None).
    """
    out = []
    s = str(text or "")
    i = 0
    n = len(s)
    while i < n:
        if s[i] != "{":
            i += 1
            continue
        depth = 0
        in_str = False
        esc = False
        j = i
        while j < n:
            c = s[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
            j += 1
        if depth != 0:
            # objet non ferme : on garde le reste pour un eventuel sauvetage
            chunk = s[i:]
            out.append((chunk, _try_json(chunk)))
            break
        chunk = s[i:j + 1]
        out.append((chunk, _try_json(chunk)))
        i = j + 1
    return out


def _try_json(chunk):
    try:
        return json.loads(chunk)
    except (ValueError, TypeError):
        pass
    # petites corrections classiques d'un petit modele
    fixed = chunk
    fixed = re.sub(r",\s*([}\]])", r"\1", fixed)          # virgule finale
    fixed = fixed.replace("\u201c", '"').replace("\u201d", '"')
    try:
        return json.loads(fixed)
    except (ValueError, TypeError):
        pass
    # objet non ferme : on referme les accolades manquantes
    if fixed.count("{") > fixed.count("}"):
        try:
            return json.loads(fixed + "}" * (fixed.count("{") - fixed.count("}")))
        except (ValueError, TypeError):
            return None
    return None


def _norm_name(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def match_tool_name(name, valid_names):
    """Correspondance exacte puis floue. Renvoie (nom_valide|None, methode)."""
    names = [str(x) for x in (valid_names or []) if x]
    if not names:
        return (str(name) if name else None), "aucune-liste"
    raw = str(name or "").strip()
    if raw in names:
        return raw, "exact"
    low = raw.lower()
    for cand in names:
        if cand.lower() == low:
            return cand, "casse"
    nn = _norm_name(raw)
    if nn:
        for cand in names:
            if _norm_name(cand) == nn:
                return cand, "separateurs"
        # prefixe commun (read_file -> read)
        for cand in names:
            cn = _norm_name(cand)
            if nn.startswith(cn) and len(cn) >= 3:
                return cand, "prefixe"
        close = difflib.get_close_matches(nn, [_norm_name(c) for c in names], n=1, cutoff=0.75)
        if close:
            for cand in names:
                if _norm_name(cand) == close[0]:
                    return cand, "flou"
    return None, "inconnu"


def decode_arguments(raw):
    """Renvoie (dict, methode) ou (None, raison)."""
    if raw is None:
        return {}, "absent"
    if isinstance(raw, dict):
        return raw, "objet"
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}, "vide"
        dec = _try_json(s)
        if isinstance(dec, dict):
            return dec, "texte-json"
        # "arguments" en paires cle=valeur (petit modele bavard)
        if "=" in s and "{" not in s:
            pairs = {}
            okpairs = True
            for part in re.split(r"[,\n]", s):
                if "=" not in part:
                    continue
                k, v = part.split("=", 1)
                k = k.strip().strip('"')
                v = v.strip().strip('"')
                if not k:
                    okpairs = False
                    break
                pairs[k] = v
            if pairs and okpairs:
                return pairs, "paires-cle-valeur"
        if isinstance(dec, list):
            return None, "arguments est une liste (objet attendu)"
        return None, "texte non JSON"
    if isinstance(raw, list):
        return None, "arguments est une liste (objet attendu)"
    if isinstance(raw, (int, float, bool)):
        return None, "arguments est un scalaire (objet attendu)"
    return None, "arguments de type non gere"


def example_for(tools, name=None):
    """Exemple minimal d'appel valide, pour le message renvoye au modele."""
    picked = None
    for t in (tools or []):
        if not isinstance(t, dict):
            continue
        fn = t.get("function", {}) if isinstance(t.get("function"), dict) else {}
        if name and str(fn.get("name", "")) == name:
            picked = fn
            break
        if picked is None:
            picked = fn
    if not picked:
        return {"tool": "read", "args": {"file": "README.md"}}
    props = ((picked.get("parameters") or {}).get("properties") or {})
    args = {}
    for k in list(picked.get("parameters", {}).get("required", []) if isinstance(picked.get("parameters"), dict) else []):
        t = props.get(k, {})
        args[k] = t.get("default", "..." )
    if not args and props:
        k = list(props.keys())[0]
        args[k] = "..."
    return {"tool": picked.get("name", "read"), "args": args}


def _call_from_obj(obj):
    """Extrait (nom_brut, args_bruts) d'un objet candidat, champs tolerants."""
    name = None
    args = None
    if isinstance(obj, dict):
        fn = obj.get("function")
        if isinstance(fn, dict):
            name = fn.get("name")
            args = fn.get("arguments")
        elif isinstance(fn, str) and fn:
            name = fn
        for k in NAME_KEYS:
            if name is None and k in obj and not isinstance(obj.get(k), (dict, list)):
                name = obj.get(k)
        for k in ARG_KEYS:
            if args is None and k in obj:
                args = obj.get(k)
        # arguments imbriques dans "parameters"/"input" d'un appel type API
        if isinstance(args, dict) and len(args) == 1 and "properties" in args:
            args = None
        if name is None and len(obj) == 1:
            only_k = list(obj.keys())[0]
            if isinstance(obj[only_k], (dict, str)):
                name, args = only_k, obj[only_k]
    return name, args


def repair_toolcall(text, tools):
    """Repare une sortie de modele en une liste d'appels.

    Renvoie un dict :
      {"ok": True,  "calls": [{"name":..., "arguments":{...}}], "repairs": [...]}
      {"ok": False, "code": "invalid_tool_call", "field": ..., "message": ...,
       "example": {...}, "repairs": [...]}
    """
    valid_names = []
    for t in (tools or []):
        if isinstance(t, dict) and isinstance(t.get("function"), dict):
            n = t["function"].get("name")
            if n:
                valid_names.append(str(n))
    repairs = []
    if text is None:
        return _fail("reply", "reponse vide", tools, repairs)
    body, had_fence = strip_fences(text)
    if had_fence:
        repairs.append("cloture-markdown-retiree")
    blobs = _balanced_objects(body)
    if not blobs:
        return _fail("json", "aucun objet JSON trouve", tools, repairs)
    if len(blobs) > 1:
        repairs.append("appels-multiples-separes")

    calls = []
    first_error = None
    for chunk, obj in blobs:
        if obj is None:
            if first_error is None:
                first_error = ("json", "JSON illisible")
            continue
        if not isinstance(obj, dict):
            if first_error is None:
                first_error = ("json", "l'objet n'est pas un objet JSON")
            continue
        # objet "tool_calls" (format OpenAI) ?
        if isinstance(obj.get("tool_calls"), list):
            for tc in obj["tool_calls"]:
                one = _repair_one(tc, valid_names, tools, repairs)
                if one.get("ok"):
                    calls.append(one["call"])
                elif first_error is None:
                    first_error = (one["field"], one["message"])
            continue
        one = _repair_one(obj, valid_names, tools, repairs)
        if one.get("ok"):
            calls.append(one["call"])
        elif first_error is None:
            first_error = (one["field"], one["message"])

    if calls:
        return {"ok": True, "calls": calls, "repairs": repairs}
    field, msg = first_error or ("json", "aucun appel exploitable")
    return _fail(field, msg, tools, repairs)


def _repair_one(obj, valid_names, tools, repairs):
    name_raw, args_raw = _call_from_obj(obj)
    name, how = match_tool_name(name_raw, valid_names)
    if not name_raw:
        return {"ok": False, "field": "name", "message": "champ 'name' absent"}
    if name is None:
        sugg = difflib.get_close_matches(_norm_name(name_raw), [_norm_name(x) for x in valid_names], n=2, cutoff=0.5)
        return {"ok": False, "field": "name",
                "message": "outil inconnu '%s'%s" % (str(name_raw)[:40],
                                                     (" ; proches : " + ", ".join(sugg)) if sugg else "")}
    if how != "exact" and how != "aucune-liste":
        repairs.append("nom-outil-%s:%s->%s" % (how, str(name_raw)[:20], name))
    args, args_how = decode_arguments(args_raw)
    if args is None:
        return {"ok": False, "field": "arguments",
                "message": "champ 'arguments' inutilisable (%s)" % args_how}
    if args_how in ("texte-json", "vide", "absent", "paires-cle-valeur"):
        repairs.append("arguments-%s" % args_how)
    return {"ok": True, "call": {"name": name, "arguments": args}}


def _fail(field, message, tools, repairs):
    ex = example_for(tools)
    human = {
        "name": "Appel invalide : name. Reponds par {\"tool\": <nom>, \"args\": {...}}.",
        "arguments": "Appel invalide : arguments. Reponds par {\"tool\": <nom>, \"args\": {...}}.",
        "json": "Appel invalide : JSON. Reponds par {\"tool\": <nom>, \"args\": {...}}.",
        "reply": "Appel invalide : reponse vide. Reponds par {\"tool\": <nom>, \"args\": {...}}.",
    }.get(field, "Appel invalide : %s. Reponds par {\"tool\": <nom>, \"args\": {...}}." % field)
    return {"ok": False, "code": "invalid_tool_call", "field": field,
            "message": human, "detail": message, "example": ex, "repairs": repairs}


def describe_error(err):
    """Texte renvoye au modele : message + exemple valide, en une ligne."""
    ex = err.get("example") or {}
    return (err.get("message", "Appel invalide.") +
            " Exemple valide : " + json.dumps(ex, ensure_ascii=True) +
            (" (detail: %s)" % err["detail"] if err.get("detail") else ""))


def repair_prompt(err):
    """Message de reparation (role user) a renvoyer au modele apres un echec."""
    return describe_error(err) + " Reponds UNIQUEMENT par ce JSON, sans texte autour."
