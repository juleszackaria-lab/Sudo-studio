# Conformite des modeles livres (P64, parties D a F)

Ce document technique accompagne `models-manifest.json`. Il ne conclut jamais
" c est legal " : il constate, signale un risque et propose une correction.

## 1. Ce que le produit fait aujourd hui

- Les poids ne sont **pas** embarques : ils sont **telecharges a l execution**
  depuis Hugging Face (`backend/runtime/server.enterprise.py` l.1051 construit
  `https://huggingface.co/<repo>/resolve/main/<fichier>`).
  Consequence d achat : ce n est pas une redistribution de poids par le vendeur,
  mais c est un **trafic sortant** au premier lancement, et cela depend d un
  service tiers (disponibilite, conditions d usage, coupure reseau).
- Le catalogue affiche (interface, `RuntimePanel.js` l.29) contient 13 modeles.
  Une **seconde** liste existe dans `backend/routes/models.routes.js` (6 modeles,
  dont TinyLlama, phi-2, DeepSeek 1.3B) : deux sources de verite divergentes,
  a unifier (voir rapport, constat I-1).
- Le modele par defaut est `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF`
  (`server.enterprise.py` l.180), **Apache-2.0** verifie.

## 2. Manifeste signe et profils de livraison (outillage livre)

| Element | Fichier |
|---|---|
| Manifeste (13 modeles, licence + empreinte + pays + obligations) | `models-manifest.json` |
| Generateur / validateur / filtrage par profil | `scripts/ci/build-models-manifest.js` |
| Tests de non-fuite (25 verifications) | `backend/tests/test-p64-profiles.js` |

Utilisation :

    node scripts/ci/build-models-manifest.js --profile us
    node scripts/ci/build-models-manifest.js --profile eu
    node scripts/ci/build-models-manifest.js --profile neutre
    node scripts/ci/build-models-manifest.js --profile client
    node scripts/ci/build-models-manifest.js --profile global      # defaut

Sorties : `dist-models/<profil>/catalogue.json` et `MODEL_NOTICES.md`.

Regles appliquees par le generateur :

| Profil | Regle |
|---|---|
| `global` | catalogue actuel, **rien ne disparait** (comportement par defaut inchange) ; chaque modele a risque porte un champ `warnings` |
| `us` | `country == "US"` **et** usage commercial autorise |
| `eu` | pays de l Union europeenne **et** usage commercial autorise |
| `neutre` | licence permissive (Apache-2.0, MIT, BSD, ISC) **et** usage commercial autorise |
| `client` | **aucun** modele : le client branche le sien (fournisseur compatible OpenAI, hote interne) |

Un modele dont la licence interdit l usage commercial n entre dans **aucun**
profil vendu, quel que soit le pays.

## 3. Constats de licence a connaitre avant de vendre

1. **`bartowski/Qwen2.5-Coder-3B-Instruct-GGUF` est sous licence de RECHERCHE**
   (`Qwen RESEARCH LICENSE AGREEMENT`, empreinte
   `ef52482bb785733093dc9a2e8edd8e764c77d12d8e9d8f10a80c9b547d32d0f9`) :
   " FOR NON-COMMERCIAL PURPOSES ONLY " et " If you are commercially using the
   Materials, you shall request a license from us ". Il figure pourtant dans le
   catalogue livre. Correction : retirer ce modele de tout profil vendu
   (fait par le generateur) et le remplacer par un modele Apache-2.0.
2. **Quatre entrees du catalogue repondent 401** (acces restreint/absent) :
   `bartowski/CodeLlama-7b-Instruct-GGUF`, `bartowski/mistral-7b-instruct-v0.2-GGUF`,
   `bartowski/Meta-Llama-3.1-13B-Instruct-GGUF`, `bartowski/CodeLlama-13b-Instruct-GGUF`.
   Leur licence est donc **NON VERIFIEE** et, en pratique, le telechargement
   echouera pour un client sans jeton. Correction : retirer ou remplacer par un
   depot accessible, et re-mesurer.
3. **Llama 3.1 / 3.2** (Meta) : usage commercial autorise mais obligations
   reelles : copie de l accord, mention " Built with Llama " visible, respect de
   l Acceptable Use Policy, et **plafond de 700 millions d utilisateurs actifs
   mensuels**. Ces obligations ne sont ecrites nulle part dans le produit.
4. **DeepSeek License 1.0** : la redistribution est permise a condition de
   **reproduire les restrictions d usage (Attachment A) dans tout contrat de
   distribution** et de fournir une copie de la licence. Non fait aujourd hui.
5. **`license_sha256` non mesure** pour 6 entrees : l empreinte du texte de
   licence n a pas ete relevee (fichier absent du depot). A completer avant
   toute annexe contractuelle.

## 4. Ce qui reste a faire (non fait ici)

- Cabler le profil sur le **build** (variable lue par le workflow 03/04) et
  prouver l exclusion sur le **paquet installe** : aujourd hui la preuve porte
  sur les fichiers generes, pas sur un installeur compile en profil `us`.
- Ecran " Modeles et licences " dans l interface : NON FAIT.
- Import hors ligne d un pack de modeles avec verification SHA256 et
  desactivation du telechargement : NON FAIT (le telechargement reste le seul
  chemin).
- Politique d administration par editeur/pays/licence : NON FAIT (seul le
  filtrage par profil au build existe).
