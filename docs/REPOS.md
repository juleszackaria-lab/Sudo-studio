# Depots du projet Sudo Studio

## `juleszackaria-lab/Sudo-studio` (ce depot)

Role : **tout le code du produit**. Il construit et teste :

- `00-test-suite.yml` : suites de tests du produit.
- `01-backend-build.yml` : backend (produit l'artefact `backend-exe`).
- `02-runtime-build.yml` : runtime (produit l'artefact `runtime-exe`).
- `06-smoke-installed.yml` : fumee sur un paquet **installe** ; il consomme un installateur
  deja construit, donc il est logiquement lie au depot de packaging (voir ci-dessous).

Ce depot **ne construit plus d'installateur** : le workflow `03-package.yml` y a ete supprime
(commit `af42630`, decision d'origine : commit `1c3b8a92`), car le packaging officiel vit dans
`sudo-studio-packager`.

## `juleszackaria-lab/sudo-studio-packager`

Role : **packaging uniquement** (installateur Windows, futurs paquets Linux), aucun code produit.
Il ne compile pas le produit : il telecharge les artefacts `backend-exe` et `runtime-exe` produits
par les workflows 01 et 02 de `Sudo-studio`, puis assemble et signe le paquet.

## Regle de travail

**Tout le travail se fait sur `main`. Aucune autre branche n'est conservee.**
Une modification = un commit sur `main` (ou une pull request dont la branche est supprimee apres
fusion). L'historique de `main` ne se reecrit pas : pas de force-push.

## References (pins)

Le packaging ne devine jamais quoi assembler : il est **epingle** sur des identifiants precis,
definis dans `.github/workflows/03-package.yml` du depot `sudo-studio-packager` :

| Variable | Valeur attendue |
|---|---|
| `SUDO_STUDIO_REF` | SHA complet (40 caracteres) de `main` de `Sudo-studio` |
| `BACKEND_RUN_ID` | identifiant du run **01** construit sur ce SHA |
| `RUNTIME_RUN_ID` | identifiant du run **02** construit sur ce SHA |

Le workflow verifie la coherence avant d'assembler : il refuse de produire un paquet si le SHA du
run ne correspond pas a `SUDO_STUDIO_REF`, si la conclusion du run n'est pas `success`, ou si les
artefacts sont trop petits. Un paquet n'est donc jamais construit a partir d'un code non teste.

Mise a jour d'une epingle : pousser d'abord sur `main` de `Sudo-studio`, attendre la fin des runs
01 et 02, puis reporter les trois valeurs et relancer le packaging.
