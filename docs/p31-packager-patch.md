# P31 - Packager patch (sudo-studio-packager repo, workflow 03)

Status: SPEC READY, NOT APPLIED (packager repo unreachable from this
sandbox; apply with push-time access, then run CI). Anchors follow the
P29 patch doc conventions (`_sudo-studio-source\...` = Sudo-studio @ main,
artifact `SudoStudio-Installer` = `Output\SudoStudio-Setup.exe`).

Workflow file: the 03 file under `.github/workflows/` (the one that
compiles `installer.iss` with ISCC and uploads `SudoStudio-Installer`).

## P0 - Rebuild order (mandatory)

1. Merge P31 to `main` (Sudo-studio).
2. 01/02: fresh runs preferred (coherent set); reuse of recent green runs
   is acceptable - P31 changes no backend/runtime binary content (only the
   extension, the agent launcher, and the smoke scripts).
3. Run 03 with `BACKEND_RUN_ID` / `RUNTIME_RUN_ID` = those runs.

## P1 - Agent copy destination: KEEP THE ROOT (supersedes P29-P1)

P29-P1 (move the agent copy to `extensions\sudo-agent`) must NOT be
applied: P31 fixes the launcher instead, and the single documented
location is now the install ROOT (`<install>\sudo-agent\src\server.js`,
see `resolveInstallRoot()` in `sudo-ai-extension/src/agent/AgentServer.js`).

- If P29-P1 was never applied (agent copy step still targets
  `build\SudoStudio\sudo-agent\src`): nothing to do.
- If it WAS applied, revert it:
  - agent copy step (anchor: `$dst = "build\SudoStudio\extensions\sudo-agent\src"`):
    back to `$dst = "build\SudoStudio\sudo-agent\src"`;
  - validation step (anchor: `extensions\sudo-agent\src\server.js manquant`):
    back to the ROOT path check + success echo.

## P2 - Smoke + agent-e2e job (P29-a + P31-d)

Append ONE new job (runs after the package job; replace `<package-job-id>`
with the id of the job that runs ISCC). It runs the full installed-product
smoke test (P29-a, paths fixed to the root layout by P31) and then the P31
agent end-to-end (resolve + missing-file + scripted-provider task). Full
scope was chosen (no `-SkipEditorTest`): expected duration ~15-25 min.

```yaml
  smoke-windows:
    name: P29+P31 smoke (Windows install + agent e2e)
    runs-on: windows-latest
    needs: [<package-job-id>]
    timeout-minutes: 60
    steps:
      - name: Download installer
        uses: dawidd6/action-download-artifact@v5
        with:
          run_id: ${{ github.run_id }}
          name: SudoStudio-Installer
          path: smoke-dl
      - name: Check out Sudo-studio source (smoke scripts)
        uses: actions/checkout@v4
        with:
          repository: juleszackaria-lab/Sudo-studio
          ref: main
          path: _sudo-studio-source
      - name: Run installer smoke test (full)
        shell: powershell
        run: |
          powershell -NoProfile -ExecutionPolicy Bypass -File _sudo-studio-source\scripts\smoke\smoke-install.ps1 -InstallerPath (Join-Path (Get-Location) 'smoke-dl\SudoStudio-Setup.exe')
      - name: Setup Node.js (agent e2e)
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run agent e2e on the installed product (P31-d)
        shell: powershell
        run: |
          node _sudo-studio-source\scripts\smoke\agent-e2e.js --installer (Join-Path (Get-Location) 'smoke-dl\SudoStudio-Setup.exe') --installDir (Join-Path $env:TEMP 'SudoE2E') --outDir e2e-out
      - name: Upload smoke + e2e logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-logs
          path: |
            smoke-out/
            e2e-out/
```

Notes:
- The smoke step FAILS (exit 1) if any check fails; the e2e step FAILS
  (exit 1) if any agent check fails. Either fails the job (honest signal).
- The e2e script does its OWN silent install/uninstall under
  `%TEMP%\SudoE2E` (independent from the smoke install dir), so the two
  cannot clash; each uninstalls after itself.
- `smoke-out/summary.txt` + transcript and `e2e-out/e2e-summary.txt` +
  `agent-stderr.log` are always uploaded.

## P3 - Proofs to paste back (P31 verdict)

From the `smoke-windows` job log:
1. Resolved path (journal + stdout): the e2e `resolve-path` line, e.g.
   `[AGENT-E2E] resolve-path PASS C:\...\sudo-agent\src\server.js`.
2. Handshake: `[AGENT-E2E] e2e-handshake PASS port=...`.
3. End-to-end task: `e2e-turn1` (honest ECHEC), `e2e-approve`,
   `e2e-turn2` (TERMINE), `e2e-only-file` (hello.txt only).
4. Missing-file message: `missing-message` /
   `missing-journal` PASS lines (exact `server.js introuvable a <path>`).
5. `AGENT-E2E RESULT: SUCCESS` + `SMOKE RESULT: SUCCESS` lines, and the
   `smoke-logs` artifact (summary.txt, e2e-summary.txt, agent-stderr.log).

SUCCESS requires all of the above from CI; otherwise PARTIEL.
