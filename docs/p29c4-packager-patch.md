# P29c4 - Packager patch: component manifest + refusal + P20 brand gate

Status: SPEC READY, NOT APPLIED (packager repo unreachable from this
sandbox; apply with push-time access, then run CI). SUPERSEDES the inline
P29-P3 snippet (same file, same shape, extended): the generation moves to
the repo script `_sudo-studio-source\scripts\ci\build-manifest.ps1`, which
also REFUSES mismatched components and gates the P20 brand.

Workflow file: the 03 file under `.github/workflows/` (ISCC + upload
`SudoStudio-Installer`). Conventions: P29 doc (`_sudo-studio-source\...`
= Sudo-studio @ main).

## P0 - Rebuild order (mandatory)

1. Merge to `main` (Sudo-studio) - this patch only.
2. Dispatch 01 and 02 on the merged `main` (fresh backend.exe /
   runtime.exe). No merge may land between the dispatches and 03:
   the script refuses runs whose `head_sha` differs from the 03 source
   checkout (re-dispatch after any new merge).
3. Run 03 with `BACKEND_RUN_ID` / `RUNTIME_RUN_ID` = those runs.

## P1 - Replace the P29-P3 step with the repo script call

DELETE the inline P29-P3 powershell (anchor: `$mfFiles = @(...`), and
insert AFTER the last step that writes into `build\SudoStudio` and
BEFORE the installer.iss step:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File _sudo-studio-source\scripts\ci\build-manifest.ps1 -BuildDir build\SudoStudio -SourceDir _sudo-studio-source -SudoStudioCommit (git -C _sudo-studio-source rev-parse HEAD).Trim() -BackendRunId '${{ inputs.BACKEND_RUN_ID }}' -RuntimeRunId '${{ inputs.RUNTIME_RUN_ID }}'
if ($LASTEXITCODE -ne 0) { Write-Error 'manifest/refusal gate failed'; exit 1 }
```

```yaml
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Notes:
- `RUNTIME_RUN_ID` replaces the P33 guard's standalone use for the
  runtime run: this script re-checks run success + commit match for
  BOTH runs (the P33 `check-runtime-fresh.ps1` step may stay as an
  early explicit gate or be dropped - same verdict).
- `GH_TOKEN` needs actions:read on Sudo-studio (run API records);
  otherwise use the PAT secret the artifact-download step uses.
- `-EditorVersion` defaults to `1.97.2`: pass the pinned base version
  when it changes. `-Version` is read from the source `installer.iss`.
- The old P29-P3 file list is kept, with the agent path fixed to the
  P31 ROOT layout (`sudo-agent\src\server.js`, not
  `extensions\sudo-agent\...`).

## P2 - Refusal semantics (what fails the 03 run)

`[MANIFEST] FAIL` + exit 1 when: a component file is missing (12
required); a 01/02 run is not `success`; a run `head_sha` differs from
`-SudoStudioCommit`; product.json is unbranded; the title-bar svg bytes
differ; the extension lacks the single `sudo-studio` container (or keeps
explorer views); the exe icon gate fails. No manifest is written, the
installer step never runs: a mismatched or misbranded package cannot be
produced. Every refusal prints the expected vs actual values.

## P3 - Manifest schema (extends P29-P3, backward compatible)

`build-manifest.json` keeps `version/date/sudo_studio_commit/
packager_commit/files{6 sha256}` and adds:

- `components.backend|runtime`: `{commit, date, run_id, sha256}`
  (`commit` = the 01/02 run `head_sha`, `date` = run `created_at`).
- `components.editor`: `{version, product, sha256}`.
- `components.extension`: `{commit, version, container, views}`
  (`commit` = source checkout, `container` = `sudo-studio`).
- `components.agent`: `{commit, path, sha256}`.
- `brand`: `{productName, logoSvgMatch: true,
  robotIcon, exeIcon: "PASS"}` (P20, verified pre-write).

## P4 - Smoke check (already in repo, runs via the P31-P2 job)

Section 4 now asserts the schema: `components.backend|runtime|
extension|agent.commit` all equal `sudo_studio_commit`, hashes of
backend/runtime recomputed, `brand.logoSvgMatch=true`,
`brand.exeIcon=PASS`, `extension.container=sudo-studio`. Any mismatch
fails `build-manifest` (and the job). No 03 change needed.

## P5 - Proofs to paste back (complement verdict)

1. `[MANIFEST] PASS: ...` line from the 03 log (version, ss commit,
   both run ids, `brand=P20-OK`).
2. `build-manifest.json` from the installed product (components +
   brand blocks).
3. `smoke-out/summary.txt` with `build-manifest PASS` (or FAIL lines).
4. One deliberate refusal (optional but recommended): run 03 with a
   stale `RUNTIME_RUN_ID` once and paste the `[MANIFEST] FAIL` line
   (expected vs actual commits), proving the gate bites.

SUCCESS requires 1-3 (4 recommended); otherwise PARTIEL.
