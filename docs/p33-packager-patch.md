# P33 - packager patch (workflow 03): refuse stale runtime artifacts

Date: 2026-10-18. Repo patch: safe/mission-p33 (NOT pushed unless ordered).
Companion: scripts/ci/check-runtime-fresh.ps1 (ships in the Sudo-studio
checkout that 03 already makes - P29 doc step 0).

## Why (P33-a)

Workflow 02 (Build Runtime) has NO push trigger: it runs only via manual
workflow_dispatch. On 2026-10-17 the evening backend rebuild (22:37+) ran
WITHOUT a runtime rebuild, so 03 packaged a runtime.exe built at 01:53 -
BEFORE the P21 journal commit (13:26) and the P26 llama fix (16:16).
This patch makes 03 REFUSE any runtime artifact older than the last commit
that touched backend/runtime.

## Patch 03

Insert AFTER the Sudo-studio checkout step and BEFORE the step that
downloads/uses the runtime-exe artifact:

```yaml
      - name: Guard against stale runtime artifact (P33-a)
        shell: powershell
        run: |
          powershell -NoProfile -ExecutionPolicy Bypass -File "<checkout-dir>\scripts\ci\check-runtime-fresh.ps1" -RunId '${{ inputs.RUNTIME_RUN_ID }}' -SourceDir <checkout-dir>
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Notes:
- Replace <checkout-dir> with the path of your existing Sudo-studio
  checkout (the P29-doc step-0 directory). No new checkout needed.
- RUNTIME_RUN_ID: the 02 run id whose runtime-exe artifact this 03 run
  consumes (the value your download step already uses).
- GH_TOKEN: needs read access to the Sudo-studio repo (actions API).
  secrets.GITHUB_TOKEN works when the repos share visibility and the
  token has actions:read on Sudo-studio; otherwise use the same PAT
  secret your artifact-download step uses.
- FAIL output looks like:
  [RUNTIME-FRESH] FAIL: runtime artifact is STALE (run created ...,
  before last runtime-source touch ...). Re-run workflow 02 first.
  -> re-run 02 (manual dispatch), then re-run 03 with the new run id.

## Nothing else changes in 03 for P33

- (b) journal header: enforced by the new 02 gate ("Verify P21 journal
  header in built runtime" in 02-runtime-build.yml), not by 03.
  Paste the gate's [GATE] line as proof.
- (c) single logs folder: code-driven (launcher + backend + runtime +
  extension). No 03 change. The installer may keep creating {app}\logs
  (harmless legacy dir, asserted empty by the smoke test).
- (d) open/export: follow (c) automatically (resolveLogsDir).

## Proof checklist (mission P33)

1. Guard output: the [RUNTIME-FRESH] PASS line from this 03 run.
2. Runtime journal first line: run the packaged runtime.exe once with a
   fresh SUDO_STUDIO_LOGS dir and paste the first line (must contain
   "# === session start ===" with build commit=...).
3. Single-dir listing: after starting every component, paste
   dir %LOCALAPPDATA%\SudoStudio\logs.
4. Diag export: paste the file list bundled by "Exporter le diagnostic".
