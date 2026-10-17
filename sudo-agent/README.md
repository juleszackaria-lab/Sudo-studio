# sudo-agent (core server, step 1)

Standalone agent server for Sudo Studio. Stdlib only (zero dependencies).

## Run

```sh
SUDO_AGENT_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
SUDO_AGENT_PORT=0 \
SUDO_AGENT_PROVIDER='{"type":"local","baseUrl":"http://127.0.0.1:6000","model":""}' \
node src/server.js
```

The server prints ONE handshake line on stdout:

```json
{"ready":true,"host":"127.0.0.1","port":12345,"pid":999,"version":"1.0.0"}
```

## Build (Windows exe, same chain as the backend)

```sh
npm run build:win   # pkg, node18-win-x64 -> dist/sudo-agent.exe
```

## Protocol

- Base: `http://127.0.0.1:<port>`, every endpoint requires
  `Authorization: Bearer <SUDO_AGENT_TOKEN>` (health included).
- `GET /health` -> `{ ok, version, uptimeSec, sessions, provider }`
- `POST /sessions { title?, projectRoot? }` -> session (201)
- `GET /sessions` -> `{ sessions: [...] }`
- `GET /sessions/:id` -> full session (resume)
- `DELETE /sessions/:id` -> `{ removed: true }`
- `POST /sessions/:id/messages { prompt }` -> `text/event-stream`:
  `turn.start`, `message.delta`, `message.done`, `turn.done`, `turn.error`.
  Offline runtime / empty model list => immediate JSON error (502), <5s.
- `POST /sessions/:id/abort` -> `{ aborted }`
- `GET /tools` -> `{ tools: [] }` (registry empty, step 1)
- `GET /permissions` -> `{ mode: "deny-all", ... }`
- `GET /providers` -> configured provider WITHOUT any secret

Sessions are stored OUTSIDE any project:
`<SUDO_STUDIO_HOME|~>/.sudo_studio/agent/sessions/<id>.json`.
Logs: P21 format v1 in `<home>/.sudo_studio/logs/agent.log` (+ `.jsonl`).

## Supervision

The extension spawns this server hidden (`windowsHide`), passes the token and
the provider config via ENVIRONMENT (never command line), reads the handshake
from stdout, and restarts the server automatically on exit (backoff). See
`../sudo-ai-extension/src/agent/AgentServer.js`.
