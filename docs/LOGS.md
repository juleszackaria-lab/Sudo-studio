# Sudo Studio — Journaux techniques (PROMPT 21)

Un dossier unique pour tous les composants (backend, supervisor, sdk,
extension, autofix, duplication, runtime). Le journal d'audit métier
(`audit.json`) est séparé et inchangé ; ceux-ci sont les journaux
techniques.

## Dossier

| Plateforme | Dossier |
|---|---|
| Windows | `%LOCALAPPDATA%\SudoStudio\logs` |
| macOS / Linux | `~/.sudo_studio/logs` |

`SUDO_STUDIO_LOGS` surcharge le dossier (utilisé par les tests et la
packaging entreprise). Le dossier est créé à la première écriture,
**ajout uniquement, jamais tronqué au redémarrage** : chaque démarrage
ajoute un nouvel en-tête de session.

L'ouvrir depuis l'app : commande **« Sudo : Ouvrir le dossier des
journaux »**, ou la visionneuse intégrée **« Sudo : Voir les
journaux »** (filtres composant + niveau, rafraîchir). La commande
**« Sudo : Exporter le diagnostic »** construit un `.zip` (queues de
logs récentes, versions, config assainie, état runtime) avec zéro
secret et zéro contenu projet.

## Fichiers et rotation

Par composant `<c>` : `<c>.log` (humain) + `<c>.jsonl` (jumeau JSON, un
objet par ligne), rotation à **10 Mo**, **10 fichiers conservés**
(`<c>.log`, `<c>.log.1` … `<c>.log.9`, idem `.jsonl`).

## Format de ligne (v1, identique en Node et Python)

Humain :

```text
2026-10-17T14:23:01.123+02:00 [INFO ] [backend] [req-a1b2c3d4] message | code=0 durationMs=45
```

`horodatage+fuseau [niveau] [composant] [correlation] message |
champs`. Jumeau JSON : `{"v":1,"ts":...,"level":...,"component":...,
"corr":...,"msg":...,"fields":{...}}`.

Corrélation : en-tête de requête `X-Correlation-Id` / `X-Request-Id`
si présent, sinon `req-<8hex>` par requête, `sess-<8hex>` par session.

## En-tête de session

Chaque démarrage ajoute : build/version, version Node ou Python, OS,
CPU, variante llama.cpp (`SUDO_LLAMACPP_VARIANT`), RAM totale/libre,
modèle chargé, ports, résumé de la politique active. **Jamais aucun
secret** (les en-têtes sont masqués aussi).

## Filtre à secrets

Avant TOUTE écriture, les valeurs ressemblant à clés/jetons/mots de
passe/URL à identifiants sont remplacées par `[REDACTED]` (clés
privées : `[REDACTED-PRIVATE-KEY]`). Couvert : `sk-`, `ghp_`, `gsk_`,
`xox[bpas]-`, `AKIA…`, `AIza…`, JWT, affectations
`password/passwd/pwd/secret/api_key/auth_token/access_token/client_secret`,
en-têtes `Bearer`, URL `scheme://user:pass@host`, blocs PEM, plus les
clés JSON sensibles (`authorization`, `cookie`, …). Échec fermé.

## Écrivains par composant

- `backend`, `supervisor` : `backend/utils/techLog.js` (câblé dans
  `server.js`).
- `sdk` : chaque commande d'installation est journalée
  (`backend/installers/sdkInstaller*.js`).
- `extension`, `autofix`, `duplication` :
  `sudo-ai-extension/src/utils/techLog.js` (logique identique à l'octet
  à la copie backend : le paquet pkg et l'hôte d'extension ne peuvent
  pas partager de fichiers ; un test affirme une sortie identique,
  format v1).
- `runtime` : `backend/runtime/p21_journal.py` (partagé par `server.py`
  et `server.enterprise.py`) : même forme de ligne, même masquage,
  `RotatingFileHandler` 10 x 10 Mo pour `runtime.log` + `runtime.jsonl`,
  identifiants de corrélation par requête.

## Superviseur (chien de garde du runtime)

Chaque détection d'arrêt, tentative de redémarrage, issue, suppression
et démarrage/arrêt du superviseur est journalée (composant
`supervisor`) avec motif, numéro de tentative, backoff, résultat du
kill, statut du spawn et code de sortie (`null` quand la plateforme
n'en rapporte aucun — spawn détaché/taskkill — `error` sur
exception). Test de kill : arrêter `runtime.exe` dans le Gestionnaire
des tâches → le superviseur détecte la panne après 3 sondages ratés
(3 x 5 s = 15 s) et relance en moins de 30 s ; preuve = entrées
`supervisor.log` + bannière de barre de statut.

## Tests liés

`backend/tests/test-p21-logs.js` (format, en-têtes, rotation, masquage,
export, visionneuse, superviseur, journalisation
autofix/sdk/duplication).
