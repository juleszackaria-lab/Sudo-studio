# BUILD — Reconstruire Sudo Studio depuis zéro

Deux chaînes : **développement** (n'importe quel OS, rejouée ici le
17/10/2026) et **packaging** (CI Windows uniquement, non rejouée dans
cette sandbox — procédure lue dans les workflows).

## A. Chaîne développement (vérifiée)

Prérequis : Git, Node.js 18+ (20.20 testé), Python 3.11+, `pip`.
Réseau requis une fois (dépendances + modèle).

```bash
# 0. Clone frais
git clone <url> sudo-studio && cd sudo-studio

# 1. Backend — tests statiques (aucun serveur requis)
cd backend && npm install && npm test
# attendu : 25 suites, 0 échec (compositeur tests/run-all.js)

# 2. Runtime IA — installation Python
cd runtime && pip install -r requirements.txt
python -m py_compile server.enterprise.py   # contrôle syntaxe
# Lancement : python server.enterprise.py --port 6000
# (télécharge Qwen2.5-Coder-1.5B Q4_K_M ≈ 1 Go au 1er besoin)

# 3. Backend — lancement (autre terminal, depuis backend/)
node server.js                                # écoute :5000

# 4. Preuve live (runtime + backend en route)
cd backend && SUDO_LIVE=1 node tests/test-ai-flow.js

# 5. Extension — depuis sudo-ai-extension/
npm install            # axios + marked (webviews)
# puis F5 dans VSCodium, ou : npx vsce package  → .vsix
```

Premier compte : `admin` / `admin123` (créé au 1er démarrage du
backend, hash bcrypt dans `data/enterprise.json`). **À changer.**

## B. Chaîne packaging (CI Windows, procédure lue)

Workflows `.github/workflows/` — ordre obligatoire :

| Étape | Workflow | Entrée → sortie |
|---|---|---|
| 1 | `01-backend-build.yml` | `backend/` → `backend.exe` (`pkg`, cible `node18-win-x64`) |
| 2 | `02-runtime-build.yml` | `backend/runtime/` → `runtime.exe` (PyInstaller) + variantes llama-cpp CPU (`compat` + `avx2`, source épinglée `llama-cpp-python==0.3.9`) |
| 3 | `03-package.yml` (dispatch manuel) | `backend.exe` + `runtime.exe` + extension + VSCodium marbré → **installeur final** |

Le workflow 03 exécute notamment :

- **7c.** `node backend/tools/build-advisory-db.js` — reconstruit la base
  avis hors ligne depuis les dumps OSV vers
  `sudo-ai-extension/src/data/advisories.json` ;
- marbrage VSCodium (`scripts/customize-vscodium.ps1` sur `vscodium/`) ;
- assemblage + script Inno Setup (`installer.iss`, a la racine).

État honnête : la chaîne 01→02→03 est lue et cohérente avec le dépôt,
mais **non ré-exécutée dans cette sandbox Linux** (binaires Windows).
La dernière exécution complète attestée reste celle du PC/CI.

## C. Vérification d'un clone frais (protocole P28)

1. `git clone` dans `/tmp` (jamais dans l'arbre de travail).
2. `cd backend && npm install && npm test` → 25/25 attendu.
3. `node --check` sur tout fichier JS modifié ; `bash -n` sur les `.sh`.
4. `SUDO_LIVE=1 npm test` avec runtime+backend en route (preuve live).
5. Sur PC Windows réel : `scripts/pc-verify.ps1` (12 sections, modèle L1)
   puis essai maquette du packaging si besoin.

## Dépannage

| Symptôme | Cause probable | Correctif |
|---|---|---|
| `npm test` : ECONNREFUSED | suites live sans serveurs | lancer runtime+backend, ou `npm test` sans `SUDO_LIVE` |
| `python … : No module flask` | dépendances non installées | `pip install -r backend/runtime/requirements.txt` |
| `0xc000001d` au chargement modèle | CPU sans AVX2 + mauvaise variante | variante `compat` (voir `requirements.txt`) |
| Extension : webview vide | `npm install` oublié | `cd sudo-ai-extension && npm install` |
| `/emulator/*` : erreur docker | docker absent | installer/démarrer Docker Desktop |
