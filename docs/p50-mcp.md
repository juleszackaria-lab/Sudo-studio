# P50 item 1 - Serveurs MCP + trousseau OS (doc)

P50 FULL, item 1 : l'agent peut appeler des serveurs MCP distants
(HTTP/SSE) dont le secret est garde par le trousseau du systeme.
Zero dependance ajoutee. Preuves paquet installe sinon PARTIEL.

## 1. Trousseau (`sudo-agent/src/keyring.js`)

- Windows uniquement : Credential Manager via powershell + P/Invoke
  Advapi32 (`CredReadW` / `CredWriteW` / `CredDeleteW`), code C# embarque.
- Le secret voyage en base64 dans le pipe STDIN de l'enfant et revient
  sur STDOUT : jamais en argv (visible), jamais en fichier, jamais au
  journal (le journal ne cite que le nom de la cible).
- Cibles : `SudoStudio/mcp/<serveur>`, validees par regex
  (`^[A-Za-z0-9][A-Za-z0-9/_.-]{0,120}$`).
- Hors Windows : `keyring_unavailable`, erreur claire, aucun repli
  silencieux (pas de fichier secrets).
- Seam de test : `setKeyringRunner(async (script) => ...)`.

## 2. Client MCP (`sudo-agent/src/mcp.js`)

- Transport HTTP : requetes JSON vers l'URL du serveur + SSE.
- Le jeton est lu au trousseau via `tokenTarget` au moment de l'appel
  (jamais stocke en config, jamais journalise).
- Validation des declarations serveur (URL http/https, champs requis) ;
  erreurs honnetes (`bad_config`, `mcp_unreachable`, ...).

## 3. Routes agent (7, dans `sudo-agent/src/server.js`)

- `GET /mcp/servers` : liste des serveurs declares (sans secrets).
- `POST /mcp/servers` : ajoute un serveur (validation).
- `DELETE /mcp/servers/<id>` : retire un serveur.
- `POST /mcp/servers/<id>/test` : ping reel du serveur.
- `GET /keyring/status` : `{ ok, via }` (credman / indisponible).
- `POST /keyring/secret` : `{ target, secret }` -> trousseau.
- `DELETE /keyring/secret` : `{ target }` -> oublie.

## 4. Panneau extension

- `sudo-ai-extension/src/panels/MCPServersPanel.js` : page serveurs MCP
  (liste, ajout, test, statut trousseau).
- Commande `sudoStudio.openMcpPanel` (`extension.js`, `package.json`).

## 5. Preuves (mocks, 28/10/2026)

- `backend/tests/test-p50-agent-caps.js`, groupes A (trousseau, 8 tests)
  + B (serveurs/routes, 8 tests) : **16/16**.
- Suite complete P50 : 47/47 stable (4 passages), voisins p26 28/28,
  p49 25/25, p25 50/50.
- Preuve paquet installe (PC proprietaire) : panneau MCP visible,
  `GET /keyring/status` -> `via: credman`, ajout + test + oubli d'un
  serveur depuis le panneau, aucun secret au journal.
