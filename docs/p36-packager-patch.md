# P36 - Packager patch spec (03-package.yml)

Companion: `docs/p35-packager-patch.md` (panel-render job, hidden launcher,
`-SudoStudioCommit`, STEP 4e2). This spec adds the P36 matrix gate.
Language: EN (packager convention). ASCII-only.

## 1. Ship the verify payload (extraFiles / staging step)

Add to the installer payload, at install ROOT:

- `verify-installed.ps1` <- `_sudo-studio-source/scripts/verify/verify-installed.ps1`
- Do NOT ship `scripts-verify/`: CI runs the matrix from the Sudo-studio
  checkout (`_sudo-studio-source/scripts/verify/`), the install needs only
  the user-runnable ps1.

FAIL the build if `verify-installed.ps1` is missing from staging
(the matrix line P36-VERIFY-PS1 fails otherwise, by design).

## 2. New step in the TestFiles job: matrix gate (source: checked-out Sudo-studio)

AFTER the smoke + e2e steps (smoke uninstalls its own copy in section 10,
so the matrix step REINSTALLS silent to `$env:TEMP\SudoMatrix` first, then
runs the runner against that fresh dir, then uninstalls it):

```powershell
$mdir = Join-Path $env:TEMP 'SudoMatrix'
if (Test-Path $mdir) { Remove-Item $mdir -Recurse -Force }
$ip = Start-Process -FilePath (Join-Path (Get-Location) 'smoke-dl\SudoStudio-Setup.exe') -ArgumentList '/SILENT','/NORESTART',("/DIR=$mdir") -Wait -PassThru
if ($ip.ExitCode -ne 0) { throw 'matrix reinstall failed' }
node _sudo-studio-source\scripts\verify\run-matrix.js --install $mdir --smoke-log (Join-Path (Get-Location) 'smoke-out\summary.txt') --out matrix-result.json
if ($LASTEXITCODE -ne 0) { throw 'P36 matrix gate FAILED (see matrix-result.json)' }
```

- The runner exits 1 on any FAIL line -> the step fails -> packaging FAILS (P36e).
- Upload `matrix-result.json` as an artifact (with smoke-logs).
- Print the gate line + FAIL lines + non-Windows list to the step summary
  (the runner already prints all three).

Prerequisites in the job: node 20 on PATH (already true), ports 5000/6000 free
after smoke (smoke stops its processes; if not, the spawn poll still passes
because "up" is "up" - but prefer a clean stop + free ports for honesty).

Time budget: ~60-90 s (spawn polls + 4 suites + manifest re-hash + ps1 run).

## 3. What the runner does (for review)

1. Spawns `<install>\backend.exe` + `<install>\runtime.exe`, polls
   `/api/system/health` and `/health` (40 s each), records up/down.
2. Runs the 4 P36 suites with `--ext <install>\extensions\sudo-ai`
   (doctor gets `--require-backend`: backend MUST be up in CI).
3. Re-hashes EVERY file in `build-manifest.json:files` + checks components
   commits, brand block, container `sudo-studio`, product `Sudo Studio`.
4. Executes the SHIPPED `<install>\verify-installed.ps1 -OutFile <tmp>`
   and reads its verdict (proves the user-runnable script works).
5. Parses smoke `summary.txt` (`[PASS]/[FAIL]/[SKIP] name` lines) for the
   12 smoke-mapped matrix lines. A mapped check MISSING from the log = FAIL.
   A mapped check SKIPped by smoke flags = line SKIP (visible, not a FAIL).
6. Writes `matrix-result.json` (56 lines + summary + gate), kills the spawned
   exes, exits 1 iff any FAIL.

## 4. Gate mapping (P36e - packaging FAILS if...)

| scope | enforced by |
|---|---|
| p36/smoke/manifest lines (27) | this matrix step (exit 1) |
| panel-job lines (3) | informational (best-effort job, user decision 19/10) |
| e2e-job line (1) | agent-e2e step must be green (existing) |
| unit lines (22) | pre-existing 03 gate (01+02 green, pins==main) |
| doc lines (3) | SKIP by nature (paper prompts) |

## 5. Do NOT break (constraints from prior prompts)

- No change to `.github/` of Sudo-studio (packager repo only).
- No network fetch of tools (node already present; no npm install in TestFiles).
- The matrix step must run BEFORE any uninstall/cleanup step and AFTER smoke.
- Keep P32 screenshot flow + P35 panel job untouched (external gates).
- ASCII-only logs preferred (the runner prints ASCII).
