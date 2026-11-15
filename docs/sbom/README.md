# SBOM et inventaire des licences (P64, partie A)

Ce dossier ne contient que des sorties d outils, pas de texte reecrit a la main.

| Fichier | Outil | Version | Commande exacte | Portee |
|---|---|---|---|---|
| `sbom-sudo-studio.cdx.json` | syft | 1.57.1 | `syft dir:/home/user/Sudo-studio -o cyclonedx-json=sbom-sudo-studio.cdx.json` | arbre de sources complet (445 composants) |
| `npm-licenses-backend.json` | license-checker | 25.x (npm) | `cd backend && license-checker --json --production` | 320 paquets npm du backend |
| `npm-licenses-sudo-agent.json` | license-checker | 25.x | `cd sudo-agent && license-checker --json --production` | 1 paquet (le paquet lui-meme : aucune dependance) |
| `npm-licenses-sudo-ai-extension.json` | license-checker | 25.x | `cd sudo-ai-extension && license-checker --json --production` | 29 paquets npm de l extension |
| `pypi-licenses-runtime.json` | PyPI JSON API | - | requete `https://pypi.org/pypi/<paquet>/json` | 10 dependances Python du runtime |

## Lecture des resultats

Backend (320 paquets) : MIT 240, Apache-2.0 33, BSD-3-Clause 17, ISC 16,
BSD-2-Clause 9, Python-2.0 1, Unlicense 1, 0BSD 1, `(BSD-3-Clause OR GPL-2.0)` 1,
UNKNOWN 1.

- `(BSD-3-Clause OR GPL-2.0)` = `node-forge`. Licence **double** : le choix
  BSD-3-Clause est permis, donc **aucune obligation copyleft** a condition de
  le dire explicitement dans les notices.
- `UNKNOWN` = le paquet `backend@1.0.0` lui-meme (il n a pas de champ
  `license` dans son package.json). A corriger : produit proprietaire, donc
  ecrire `UNLICENSED` comme pour les deux autres paquets.
- `Python-2.0` = `argparse` (permissif, compatible).
- Aucune GPL/AGPL/LGPL/SSPL/BUSL/Commons-Clause/CC-NC dans les dependances npm.

Runtime Python : flask BSD-3-Clause, flask-cors MIT, transformers Apache-2.0,
torch Apache-2.0 (+ composants BSD/BSL-1.0/Zlib), psutil BSD-3-Clause,
accelerate Apache, sentencepiece Apache-2.0, requests Apache-2.0,
huggingface_hub Apache-2.0, llama-cpp-python MIT.

Syft (arbre complet, 445 composants) : MIT 268, Apache-2.0 33, BSD-3-Clause 17,
ISC 16, BSD-2-Clause 9, Python-2.0 1, Unlicense 1, 0BSD 1, **licence ABSENTE
pour 96 composants** (essentiellement des fichiers de l arbre VSCodium vendorise
et des paquets sans metadonnee). Ces 96 cas sont ceux a documenter avant toute
revente : " licence inconnue " n est pas " libre ".

## Ce que la CI ne produit pas encore

Le SBOM ci-dessus a ete genere sur l ARBRE DE SOURCES, pas sur le paquet
installe. Pour l obtenir depuis le paquet : `syft dir:"C:\Program Files\Sudo
Studio"` sur un poste Windows (non fait ici, voir rapport, statut NON FAIT).
