# sudo-agent (serveur agent, étape 1)

Serveur agent autonome pour Sudo Studio. Stdlib uniquement (zéro
dépendance).

## Lancement

```sh
SUDO_AGENT_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
SUDO_AGENT_PORT=0 \
SUDO_AGENT_PROVIDER='{"type":"local","baseUrl":"http://127.0.0.1:6000","model":""}' \
node src/server.js
```

Produit installe : l'extension lance ce meme fichier avec l'executable
Sudo Studio lui-meme en mode Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`,
fenetre masquee, supervision + relance par l'extension). Aucun Node.js
requis sur le PC, aucun second Node embarque (MINI node).

Le serveur affiche UNE ligne de poignée de main sur stdout :

```json
{"ready":true,"host":"127.0.0.1","port":12345,"pid":999,"version":"1.0.0"}
```

## Build (exe Windows, même chaîne que le backend)

```sh
npm run build:win   # pkg, node18-win-x64 -> dist/sudo-agent.exe
```

## Protocole

- Base : `http://127.0.0.1:<port>`, chaque point d'accès exige
  `Authorization: Bearer <SUDO_AGENT_TOKEN>` (santé incluse).
- `GET /health` -> `{ ok, version, uptimeSec, sessions, provider }`
- `POST /sessions { title?, projectRoot? }` -> session (201)
- `GET /sessions` -> `{ sessions: [...] }`
- `GET /sessions/:id` -> session complète (reprise)
- `DELETE /sessions/:id` -> `{ removed: true }`
- `POST /sessions/:id/messages { prompt }` -> `text/event-stream` :
  `turn.start`, `message.delta`, `message.done`, `turn.done`, `turn.error`.
  Runtime hors ligne / liste de modèles vide => erreur JSON immédiate
  (502), < 5 s.
- `POST /sessions/:id/abort` -> `{ aborted }` (tue aussi les processus
  d'outils en cours)
- `GET /tools` -> `{ tools: [...] }`
  (read/list/glob/grep/write/edit/patch/bash/todo)
- `GET /permissions` -> `{ mode: "ask-mutating", readonly, mutating,
  denyList, p8, l2 }` (`l2` = détection seule, exécution supprimée en P27)
- `GET /providers` -> fournisseur configuré SANS aucun secret
- `POST /sessions/:id/tools/call { tool, args }` ->
  `{ status: done | need-approval | denied | error, ... }`
  (409 pendant un tour ; chaque appel mutant direct est sa propre série
  d'annulation)
- `GET /sessions/:id/approvals` -> `{ pending: [...] }` (diffs inclus,
  plafonnés)
- `POST /sessions/:id/approvals { requestId, decision }` -> exécuté |
  refusé (decision : once | session | project | deny ; les règles
  project sont stockées HORS du projet, clé = hash de la racine projet)
- `POST /sessions/:id/undo { scope: last | session }` -> restauration
  vérifiée par hash (l'annulation vérifiée consomme l'historique : last
  dépile une série, session vide tout)
- `POST /sessions/:id/mode { mode: build | plan }` -> `{ mode }` (P26 ;
  plan refuse les outils mutants, 409 pendant un tour)
- `POST .../messages` accepte aussi `"verify": false` (P26 ; défaut :
  exécuter le contrôle projet détecté après modifications, sous
  permissions)

Boucle agent (P26) : modes Build/Plan (prompts système distincts) ;
profils de taille (small <= 3B ou local inconnu : 6 outils terses,
tâches découpées, 6 itérations ; full 7B+ : 9 outils + MCP, 10
itérations ; surcharge `SUDO_AGENT_PROFILE` ou `profile` du
fournisseur) ; une action par étape (extras sautés, transcription
gardée valide) ; détection de boucle (3 appels identiques -> PARTIEL) ;
budget de contexte depuis `SUDO_AGENT_CTX_TOKENS`, sinon `n_ctx` du
runtime (GET /v1/models), sinon 2048 local / 8000 cloud ; compression
passé 75 % (résumé écrit par le modèle : décisions, fichiers modifiés,
erreurs en cours ; échec -> PARTIEL honnête, jamais de perte
silencieuse) ; boucle de vérification après modifications (`npm test`,
`pytest`, `flutter test`, … détectés, ou `.sudo-verify` explicite ;
échecs réinjectés, 2 rondes, puis ECHEC honnête) ; outils MCP stdio
(`mcp__server__tool`, profil full uniquement) depuis
`<home>/.sudo_studio/agent/mcp.json` global, liste blanche admin
`mcp_policy.json` (échec fermé), spawn en fenêtre cachée, chaque appel
contrôlé par les permissions et journalé (les effets de bord MCP sont
HORS snapshots : aucune annulation promise) ; les déploiements exigent
`net_policy.json { deployAllowed: true }` ET une approbation fraîche de
l'opérateur à chaque fois (usage unique, jamais mémorisée).
`turn.done` ajoute `stopReason` (declared | max_iters | loop | context |
verify_approval | verify_denied | verify_failed | aborted).
Mesurer les taux d'appels d'outils :
`node scripts/measure-toolcalls.js --mock valid|mixed` (auto-test) ou
`--base-url <runtime> --model <id> --trials 20` (modèle réel).

Tours d'outils (P25) : une session AVEC `projectRoot` laisse le modèle
appeler des outils (`POST .../messages`, `"tools": false` optionnel
pour un tour simple historique). SSE ajoute `tool.start` /
`tool.result` ; `turn.done` porte un statut honnête : `TERMINE`
(déclaré + aucune erreur d'outil non résolue + liste des fichiers
modifiés), `ECHEC`, ou `PARTIEL` avec motif. Les appels en cours de
tour nécessitant une approbation ne s'exécutent PAS en v1 : le modèle
voit `need_approval`, l'opérateur approuve via l'API (résultat rendu à
l'opérateur, non réinjecté dans le tour terminé). `AGENTS.md` à la
racine du projet est injecté comme instructions système. Les résultats
d'outils sont filtrés des secrets avant d'atteindre un fournisseur
cloud.

Les sessions sont stockées HORS de tout projet :
`<SUDO_STUDIO_HOME|~>/.sudo_studio/agent/sessions/<id>.json`.
Logs : format P21 v1 dans `<home>/.sudo_studio/logs/agent.log`
(+ `.jsonl`).

## Supervision

L'extension lance ce serveur caché (`windowsHide`), passe le jeton et
la config fournisseur par l'ENVIRONNEMENT (jamais la ligne de
commande), lit la poignée de main sur stdout, et relance le serveur
automatiquement à la sortie (backoff). Voir
`../sudo-ai-extension/src/agent/AgentServer.js`.
