#!/usr/bin/env python3
"""
patch_start_v25.py — Patch start.bat v2.4 → v2.5
  - Replace VSCodium launch command (line 575)
  - Add --extensions-dir, --user-data-dir, --extensionDevelopmentPath (isolation)
  - Output guaranteed CRLF
"""

import sys
import re

SRC  = "/home/user/webapp/start.bat"
DST  = "/home/user/webapp/start.bat"

# Exact old line (without CRLF — we strip before comparing)
OLD_LINE = '    start "SudoStudio" "" "!VSCODIUM_EXE!" --extensionDevelopmentPath="%ROOT%sudo-ai-extension"'

# New lines to replace it with (will be joined with CRLF)
# Rationale:
#   --extensions-dir  : isolates extensions to a project-local folder
#                        → GitHub Copilot / global extensions do NOT load
#   --user-data-dir   : project-local VSCodium profile (settings, keybindings…)
#                        → clean slate, no interference from user global profile
#   --extensionDevelopmentPath : loads sudo-ai-extension from its source folder
#                        → VSCodium treats it as a dev extension and loads it immediately
# Note: --disable-extensions is deliberately OMITTED because it would also
#       disable the extension loaded via --extensionDevelopmentPath in some
#       VSCodium builds.  The combination of --extensions-dir + --user-data-dir
#       pointing to project-local empty dirs already provides full isolation.
NEW_LINES = [
    '    set "VSCO_EXT_DIR=!ROOT!data\\extensions"',
    '    set "VSCO_USER_DIR=!ROOT!data\\user-data"',
    '    set "VSCO_EXT_SRC=!ROOT!sudo-ai-extension"',
    '    call :LOG "[PHASE 4] Extensions dir : !VSCO_EXT_DIR!"',
    '    call :LOG "[PHASE 4] User-data dir  : !VSCO_USER_DIR!"',
    '    start "SudoStudio" "!VSCODIUM_EXE!" --extensions-dir "!VSCO_EXT_DIR!" --user-data-dir "!VSCO_USER_DIR!" --extensionDevelopmentPath "!VSCO_EXT_SRC!"',
]

def patch():
    with open(SRC, "rb") as f:
        raw = f.read()

    # Normalise to lines (strip existing CRLF/LF)
    lines = raw.decode("utf-8").splitlines()

    found = False
    result = []
    for line in lines:
        if line.rstrip("\r") == OLD_LINE:
            found = True
            for new_line in NEW_LINES:
                result.append(new_line)
        else:
            result.append(line)

    if not found:
        print(f"ERROR: Old line not found in {SRC}")
        print(f"  Searching for: {repr(OLD_LINE)}")
        sys.exit(1)

    # Write back with CRLF
    output = "\r\n".join(result) + "\r\n"
    with open(DST, "wb") as f:
        f.write(output.encode("utf-8"))

    print(f"OK: Patched {len(lines)} → {len(result)} lines ({len(result) - len(lines):+d})")
    print(f"    Replacement: 1 line → {len(NEW_LINES)} lines")
    print(f"    Output: {DST}")

if __name__ == "__main__":
    patch()
