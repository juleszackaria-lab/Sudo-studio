"""
grammar.py - P62-F5 : decodage contraint (GBNF) pour les appels d'outils.

Pourquoi : un petit modele (1,5B) qui doit repondre "un seul objet JSON" se
trompe souvent (texte avant, virgule en trop, cle inventee). Le decodage
contraint rend ces sorties IMPOSSIBLES : le moteur ne peut produire que des
jetons qui menent a un objet JSON valide, avec un nom d'outil de la liste.

Ce module est du texte pur (stdlib seulement) :
  - toolcall_grammar(tools)   -> grammaire GBNF pour {"name": ..., "arguments": {...}}
  - json_object_grammar()     -> grammaire GBNF pour un objet JSON quelconque
  - lint_gbnf(text)           -> controle structurel (regles definies / utilisees)
  - to_llama_grammar(text)    -> objet llama_cpp.LlamaGrammar, ou None

Rien ici ne leve d'exception vers l'appelant : si la grammaire n'est pas
acceptee par le moteur installe, on repart sans contrainte (le pipeline de
reparation P55 reste en place) et on le DIT dans le journal.

ASCII only.
"""

import json
import re

WS = 'ws ::= [ \\t\\n]*\n'

BASE_RULES = r'''
ws ::= [ \t\n]*
value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" ws ( pair ( ws "," ws pair )* )? ws "}"
pair ::= string ws ":" ws value
array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
string ::= "\"" chars "\""
chars ::= [^"\\]*
number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )?
'''


def _tool_names(tools):
    """Extrait les noms d'outils d'une liste de definitions OpenAI."""
    names = []
    for t in (tools or []):
        if not isinstance(t, dict):
            continue
        fn = t.get('function') if isinstance(t.get('function'), dict) else t
        n = fn.get('name')
        if isinstance(n, str) and re.match(r'^[A-Za-z0-9_.-]{1,64}$', n):
            names.append(n)
    # ordre stable + unicite
    seen = []
    for n in names:
        if n not in seen:
            seen.append(n)
    return seen


def toolcall_grammar(tools):
    """GBNF : {"name": "<un des outils>", "arguments": <objet JSON>} exactement."""
    names = _tool_names(tools)
    if not names:
        return None
    alts = ' | '.join('"%s"' % n for n in names)
    head = (
        'root ::= "{" ws "\\"name\\"" ws ":" ws name ws "," ws '
        '"\\"arguments\\"" ws ":" ws value ws "}"\n'
        'name ::= %s\n' % alts
    )
    return head + BASE_RULES


def json_object_grammar():
    """GBNF : un objet JSON, rien d'autre (sans contrainte de nom d'outil)."""
    return 'root ::= object\n' + BASE_RULES


RULE_RE = re.compile(r'^([a-zA-Z0-9_-]+)\s*::=\s*(.*)$')


def _strip_literals(body):
    """Retire les litteraux "..." et les classes [...] d'une regle GBNF."""
    out = []
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        if c == '"':
            i += 1
            while i < n:
                if body[i] == '\\':
                    i += 2
                    continue
                if body[i] == '"':
                    i += 1
                    break
                i += 1
            out.append(' ')
            continue
        if c == '[':
            j = body.find(']', i)
            i = (j + 1) if j != -1 else n
            out.append(' ')
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def lint_gbnf(text):
    """Controle structurel minimal. Retourne {'ok', 'rules', 'undefined', 'error'}."""
    rules = {}
    for line in str(text or '').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = RULE_RE.match(line)
        if not m:
            return {'ok': False, 'rules': len(rules), 'undefined': [],
                    'error': 'ligne de regle invalide : ' + line[:60]}
        rules[m.group(1)] = m.group(2)
    if 'root' not in rules:
        return {'ok': False, 'rules': len(rules), 'undefined': [], 'error': 'regle root absente'}
    # toute reference doit exister (on ignore les litteraux "..." et les
    # classes de caracteres [...] qui ne sont pas des references de regle)
    undefined = []
    for name, body in rules.items():
        for token in re.findall(r'[a-zA-Z][a-zA-Z0-9_-]*', _strip_literals(body)):
            if token in ('true', 'false', 'null'):
                continue
            if token not in rules and token not in undefined:
                undefined.append(token)
    return {'ok': not undefined, 'rules': len(rules), 'undefined': undefined,
            'error': '' if not undefined else 'regles non definies : ' + ', '.join(undefined[:6])}


def grammar_stats(text):
    """Informations utiles au journal (taille, nombre de regles)."""
    lint = lint_gbnf(text)
    return {'rules': lint['rules'], 'chars': len(text or ''),
            'undefined': lint['undefined'], 'ok': lint['ok']}


def to_llama_grammar(text, logger=None):
    """Objet LlamaGrammar pret pour create_chat_completion, ou None.

    Ne leve jamais : une version de llama-cpp-python sans grammaire renvoie
    None et l'appelant continue sans contrainte (jamais un 500).
    """
    if not text:
        return None
    lint = lint_gbnf(text)
    if not lint['ok']:
        if logger:
            try:
                logger('[GRAMMAR] grammaire refusee : ' + str(lint['error']))
            except Exception:
                pass
        return None
    try:
        from llama_cpp import LlamaGrammar  # import tardif : absent en test unitaire
    except Exception:
        return None
    try:
        return LlamaGrammar.from_string(text, verbose=False)
    except TypeError:
        try:
            return LlamaGrammar.from_string(text)
        except Exception:
            return None
    except Exception:
        return None


if __name__ == '__main__':  # petit auto-controle
    demo = toolcall_grammar([
        {'type': 'function', 'function': {'name': 'read_file'}},
        {'type': 'function', 'function': {'name': 'write_file'}},
    ])
    print(json.dumps({'lint': lint_gbnf(demo), 'stats': grammar_stats(demo),
                      'object': lint_gbnf(json_object_grammar())}, indent=2))
