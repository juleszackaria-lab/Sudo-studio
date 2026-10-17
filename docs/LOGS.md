# Sudo Studio — Technical journals (PROMPT 21)

One unified folder for every component (backend, supervisor, sdk, extension,
autofix, duplication, runtime). The business audit log (`audit.json`) is
separate and unchanged; these journals are the technical ones.

## Folder

| Platform | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\SudoStudio\logs` |
| macOS / Linux | `~/.sudo_studio/logs` |

`SUDO_STUDIO_LOGS` overrides the folder (used by tests and enterprise
packaging). The folder is created on first write, **append-only, never
truncated on restart**: each boot appends a new session header.

Open it from the app: command **"Sudo : Ouvrir le dossier des journaux"**,
or the in-app viewer **"Sudo : Voir les journaux"** (component + level
filters, refresh). Command **"Sudo : Exporter le diagnostic"** builds a
`.zip` (recent log tails, versions, sanitized config, runtime state) with
zero secrets and zero project content.

## Files and rotation

Per component `<c>`: `<c>.log` (human) + `<c>.jsonl` (JSON twin, one object
per line), rotated at **10 MB**, **10 files kept** (`<c>.log`, `<c>.log.1`
… `<c>.log.9`, same for `.jsonl`).

## Line format (v1, identical in Node and Python)

Human:

```text
2026-10-17T14:23:01.123+02:00 [INFO ] [backend] [req-a1b2c3d4] message | code=0 durationMs=45
```

`timestamp+timezone [level] [component] [correlation] message | fields`.
JSON twin: `{"v":1,"ts":...,"level":...,"component":...,"corr":...,
"msg":...,"fields":{...}}`.

Correlation: `X-Correlation-Id` / `X-Request-Id` request header when present,
else `req-<8hex>` per request, `sess-<8hex>` per session.

## Session header

Every boot appends: build/version, Node or Python version, OS, CPU,
llama.cpp variant (`SUDO_LLAMACPP_VARIANT`), RAM total/free, loaded model,
ports, active-policy summary. **Never any secret** (headers are masked too).

## Secret filter

Before ANY write, values matching keys/tokens/passwords/credentialed URLs
are replaced by `[REDACTED]` (private keys: `[REDACTED-PRIVATE-KEY]`).
Covered: `sk-`, `ghp_`, `gsk_`, `xox[bpas]-`, `AKIA…`, `AIza…`, JWT,
`password/passwd/pwd/secret/api_key/auth_token/access_token/client_secret`
assignments, `Bearer` headers, `scheme://user:pass@host` URLs, PEM blocks,
plus sensitive JSON keys (`authorization`, `cookie`, …). Fail closed.

## Component writers

- `backend`, `supervisor`: `backend/utils/techLog.js` (wired in `server.js`).
- `sdk`: every installer command is journaled
  (`backend/installers/sdkInstaller*.js`).
- `extension`, `autofix`, `duplication`: `sudo-ai-extension/src/utils/techLog.js`
  (byte-identical logic to the backend copy: the pkg bundle and the extension
  host cannot share files; a test asserts identical output, format v1).
- `runtime`: `backend/runtime/p21_journal.py` (shared by `server.py` and
  `server.enterprise.py`): same line shape, same masking, `RotatingFileHandler`
  10 x 10 MB for `runtime.log` + `runtime.jsonl`, per-request correlation ids.

## Supervisor (runtime watchdog)

Every stop detection, restart attempt, restart outcome, suppression and
supervisor start/stop is journaled (component `supervisor`) with reason,
attempt number, backoff, kill result, spawn status and exit code (`null`
when the platform reports none — detached spawn/taskkill — `error` on
exception). Kill test: stop `runtime.exe` in Task Manager → the supervisor
detects the outage after 3 failed polls (3 x 5 s = 15 s) and respawns in
under 30 s; proof = `supervisor.log` entries + status-bar banner.

## Related tests

`backend/tests/test-p21-logs.js` (format, headers, rotation, masking,
export, viewer, supervisor, autofix/sdk/duplication journaling).
