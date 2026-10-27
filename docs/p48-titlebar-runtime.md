# P48 - Titlebar brand text + app-first title + English tree + runtime wait

Owner protocol for the INSTALLED package proofs (nothing below can be
proven from CI: it needs the real Windows install + a screen).

## 1. "Sudo Studio" in the title bar (before File)

- Open the installed Sudo Studio (recent build, P48 merged).
- EXPECT: between the app icon (top-left) and the File menu, the text
  "Sudo Studio" shows in the title bar. The menu itself is untouched.
- Switch theme dark -> light (and back): the text stays readable
  (theme variable, no hard-coded color).
- Shrink the window narrow (< ~720px): the text disappears while the
  File menu is still there.
- PROOF: 2 screenshots (dark + light) + 1 narrow-window screenshot.

## 2. App-first window title (taskbar thumbnail)

- Open a file, hover the taskbar icon (or Alt+Tab).
- EXPECT: the thumbnail title starts with "Sudo Studio" followed by
  the dirty flag, file name and folder (never truncated away).
- PROOF: 1 taskbar-thumbnail screenshot. The taskbar GROUPING
  (one button per window) is untouched by P48.

## 3. English tree, one icon, zero emoji

- Open the Sudo Studio activity bar view.
- EXPECT: 9 groups (Agent, AI Runtime, Project, Environment,
  Duplication, Security, Tools, Administration, Logs), 24 entries,
  English labels, no emoji anywhere, 1 icon per entry. Panel titles
  themselves are unchanged (French kept inside the panels).
- PROOF: 1 tree screenshot. Automated part: test-p47 C6/C8 (22/22).

## 4. Runtime restart: agent + chat wait, then resume

- Open Chat, note the runtime is up (Runtime panel: En ligne).
- Kill runtime.exe (Task Manager) and immediately send a chat message.
- EXPECT: the chat shows "Runtime restarting, attempt 1/5" (then 2/5,
  ...) instead of an instant error; when the supervisor has restarted
  the runtime (<= 60 s), the answer streams normally. No text anywhere
  orders to launch start.bat.
- Repeat with the Agent panel (same wait + resume).
- While the runtime is down, open the Runtime panel: a "Restart now"
  button is visible; clicking it forces an immediate supervised
  restart (backend log: "manual restart (Restart now)").
- Let the runtime stay dead (stop the supervisor first if needed):
  after attempt 5/5 the turn fails clean with "Runtime offline (...)"
  and STILL no start.bat order.
- PROOF: chat transcript screenshot showing attempt n/5 + resumed
  answer, Runtime panel screenshot showing Restart now, journal lines.

## Installed-package checks (already automated)

- scripts/verify/verify-installed.ps1 asserts product.json window.title
  is the app-first template and the workbench CSS carries the
  P48-TITLEBAR-BRAND block (parts: product.json, titlebar-svg,
  titlebar-text).
- 03 pack-time gate (build-manifest.ps1) refuses any build missing
  either piece.

## Test record (dev machine, 2026-10-27)

- backend/tests/test-p48-titlebar-runtime.js: 30/30 (titlebar CSS +
  template x3 + waitForRuntime unit + runTurn kill/restart integration
  on a stub runtime + engine step + wiring + supervisor manual).
- Neighbors: p47 22/22, p20 50 + H7 (pre-existing, stashed P47),
  p1 39, p12 12/12, p15 17, p27 54, p43 20/20, p46 green,
  ext-complete 76/76. Pre-existing, stash-proven, out of scope:
  p4 A4/A14, p6 A4, p21 F5, p29 C4 crash, p31 A4 crash.
