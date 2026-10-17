# LICENSING — Clés, éditions, cérémonie

Sudo Studio est un **produit propriétaire** : pas d'utilisation sans clé
hors édition Community (fonctionnalités de base sans clé).

## 1. Format des clés de licence

- `base64url(payloadJSON).base64url(signature64)` — **Ed25519, 100 %
  hors ligne**, aucun serveur d'activation.
- Payload : `licenseId`, `client`, `edition`, `seats`, `issuedAt`,
  `expiresAt`, `features` (optionnel, borné par l'édition).
- Vérification : `backend/src/license/license.js` (miroir dans
  l'extension). Stockage : `~/.sudo_studio/license.json`
  (`SUDO_STUDIO_HOME` pour surcharger), sceau `license-seal.json`,
  révocations `revoked.json`.

## 2. Éditions et fonctionnalités

| Édition | Fonctionnalités |
|---|---|
| Community (sans clé) | `chat`, `doctor`, `sdk` |
| Team | + `devops`, `environment`, `agent` |
| Enterprise | + `security`, `duplication`, `central`, `cicd`, `license` |

Contrôle : `guardFeature()` côté backend + vérification miroir côté
extension avant ouverture des panneaux (suite P16, 12/12).

## 3. Cérémonie des clés (PC propriétaire uniquement)

1. La clé privée ne vit **que** sur le PC du propriétaire, dans le dépôt
   packaging séparé (`license-keygen`) — **jamais** dans ce dépôt, jamais
   en CI (l'installeur livré n'est pas signé, choix P23 assumé).
2. Générer la paire Ed25519 sur ce PC ; intégrer **seule la clé publique**
   (`PRODUCT_PUBLIC_KEY_SPKI_B64`) dans `license.js` (backend + extension).
3. Signer chaque clé client hors ligne ; transmettre la clé au client
   (fichier ou copier-coller dans le panneau License).
4. Révocation : liste `revoked.json` distribuée avec les mises à jour.

> Exception du 17/10/2026 : faute de configuration locale, l'agent a
> généré une paire + des clés PROD temporaires. **Rotation conseillée** :
> régénérer une paire sur le PC propriétaire et rééditer les clés.

## 4. Authenticité de la base avis (2e système de clés)

La base vulnérabilités embarquée (`advisories.json`) est signée et
vérifiée à l'import (`sudo-ai-extension/src/utils/advisorySig.js`,
suite P23, 57/57).

> **En attente (M1)** : la clé publique PROD de l'utilisateur n'a pas
> été reçue. En attendant, le code embarque une clé fictive qui
> **refuse tout import** (comportement prouvé par le test I8) : aucune
> base non authentifiée ne peut être chargée silencieusement.

## 5. Clés de développement

Des clés DEV existent pour les tests (chargeur P23, fixtures). Elles ne
donnent aucun droit PROD et ne sont pas documentées ici ; ne jamais
commiter de clé privée (`*.private.pem`, `private-keys/` sont ignorés).
