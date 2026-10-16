"""SUDO STUDIO - P15 3b: runtime-side admin policy gate.

Mirrors the extension-side isModelAllowed() (CentralMgmtPanel.js): the same
central_policies.json store ($SUDO_STUDIO_HOME/.sudo_studio/central/) is read
here so a direct HTTP call to the runtime (bypassing backend + extension)
cannot load a model the admin did not allow.

Same semantics as the extension: missing/empty allow-list = allow all.
Stdlib only, no side effects on import (safe to unit-test).
ASCII-only.
"""

import json
import os

POLICY_MSG = 'Modele bloque par la politique administrateur'


def central_dir():
    home = os.environ.get('SUDO_STUDIO_HOME') or os.path.expanduser('~')
    return os.path.join(home, '.sudo_studio', 'central')


def allowed_models():
    try:
        with open(os.path.join(central_dir(), 'central_policies.json'),
                  encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return []
    if not isinstance(d, dict):
        return []
    lst = d.get('allowedModels')
    if not isinstance(lst, list):
        return []
    return [x for x in lst if isinstance(x, str)]


def is_model_allowed(model_id):
    lst = allowed_models()
    if not lst:
        return True
    m = str(model_id or '').strip().lower()
    if not m:
        return False
    return any(a.strip().lower() == m for a in lst)
