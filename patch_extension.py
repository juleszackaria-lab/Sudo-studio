#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_extension.py
Patches sudo-ai-extension/extension.js:
  - activate() becomes non-blocking (UI loads instantly)
  - console.log added at start of activate()
  - autoStartRuntime() disabled (start.bat already handles it)
  - await initializeBackend() moved to setTimeout(2000) background call
"""

import re

EXTENSION_PATH = "sudo-ai-extension/extension.js"

with open(EXTENSION_PATH, "r", encoding="utf-8") as f:
    content = f.read()

# ─────────────────────────────────────────────────────────────────────────────
# OLD activate() block (lines 40-88 inclusive)
# We match from the JSDoc comment to the closing brace
# ─────────────────────────────────────────────────────────────────────────────
OLD_ACTIVATE = """\
/**
 * Extension activation - POINT D'ENTRÉE PRINCIPAL
 */
async function activate(ctx) {
    context = ctx;
    console.log('\U0001f680 Sudo Studio Enterprise - Activation starting...');

    try {
        // Initialize core services
        backend = getBackendService();
        state = getStateManager();

        // Initialize backend connection
        await initializeBackend();

        // Register all providers
        registerProviders();

        // Register all commands
        registerCommands();

        // Setup event listeners
        setupEventListeners();

        // Status bar for AI runtime
        setupStatusBar(ctx);

        // AUTO-START: Launch runtime automatically via spawn()
        autoStartRuntime();

        // Auto-start runtime model download check
        setTimeout(() => autoEnsureModelDownload(), 3000);

        // Show welcome message \u2014 confirmation that Sudo AI is loaded and connected
        vscode.window.showInformationMessage(
            '\u2705 Sudo AI pr\u00eat \u2014 Backend et Runtime connect\u00e9s',
            'Ouvrir Chat', 'Ouvrir Runtime'
        ).then(selection => {
            if (selection === 'Ouvrir Chat') openChat();
            else if (selection === 'Ouvrir Runtime') openRuntimePanel();
        });

        console.log('\u2705 Sudo Studio Enterprise fully activated!');
        
    } catch (error) {
        console.error('\u274c Activation error:', error);
        vscode.window.showErrorMessage(`Sudo Studio activation failed: ${error.message}`);
    }
}"""

NEW_ACTIVATE = """\
/**
 * Extension activation - POINT D'ENTREE PRINCIPAL
 * v4.4: Non-blocking - UI loads immediately, backend connects in background
 */
async function activate(ctx) {
    context = ctx;
    console.log('Sudo AI extension activating...');
    console.log('Sudo Studio Enterprise - Activation starting...');

    try {
        // Initialize core services (synchronous - no network calls)
        backend = getBackendService();
        state = getStateManager();

        // Register all providers IMMEDIATELY (synchronous - loads UI fast)
        registerProviders();

        // Register all commands (synchronous)
        registerCommands();

        // Setup event listeners (synchronous)
        setupEventListeners();

        // Status bar for AI runtime (synchronous)
        setupStatusBar(ctx);

        // NON-BLOCKING: Connect to backend after 2s delay
        // This lets VSCodium finish loading the UI before any network calls.
        // start.bat already launched backend.exe and runtime.exe.
        setTimeout(() => {
            initializeBackend().catch(function(err) {
                console.warn('Background backend init (non-fatal):', err.message);
            });
        }, 2000);

        // autoStartRuntime() intentionally disabled:
        // start.bat already launches runtime.exe - no need to spawn again.
        // Calling it here would cause double-launch + 5min polling loop.

        // Show welcome message immediately (does not wait for backend)
        vscode.window.showInformationMessage(
            'Sudo AI pret',
            'Ouvrir Chat', 'Ouvrir Runtime'
        ).then(function(selection) {
            if (selection === 'Ouvrir Chat') openChat();
            else if (selection === 'Ouvrir Runtime') openRuntimePanel();
        });

        console.log('Sudo Studio Enterprise fully activated!');

    } catch (error) {
        console.error('Activation error:', error.message);
        vscode.window.showErrorMessage('Sudo Studio activation failed: ' + error.message);
    }
}"""

if OLD_ACTIVATE not in content:
    print("ERROR: OLD_ACTIVATE block not found in extension.js!")
    print("Trying to find activate() manually...")
    idx = content.find("async function activate(ctx)")
    if idx != -1:
        print(f"  Found at char {idx}")
        print("  First 200 chars of function:")
        print(repr(content[idx:idx+200]))
    else:
        print("  activate() function NOT found at all!")
    exit(1)

new_content = content.replace(OLD_ACTIVATE, NEW_ACTIVATE, 1)

if new_content == content:
    print("ERROR: Replace had no effect!")
    exit(1)

with open(EXTENSION_PATH, "w", encoding="utf-8") as f:
    f.write(new_content)

print(f"OK Patched: {EXTENSION_PATH}")
print(f"   Old size: {len(content)} chars")
print(f"   New size: {len(new_content)} chars")
print(f"   Delta   : {len(new_content) - len(content):+d} chars")

# Verify the patch
print()
print("=== VERIFICATION ===")
checks = [
    ("Sudo AI extension activating...",     True,  "console.log at top of activate()"),
    ("registerProviders();",                True,  "registerProviders() still present"),
    ("await initializeBackend();",          False, "NO await initializeBackend() at top level"),
    ("setTimeout(() => {",                  True,  "setTimeout for background backend init"),
    ("initializeBackend().catch",           True,  "background initializeBackend() with .catch"),
    ("autoStartRuntime();",                 False, "NO autoStartRuntime() call"),
    ("Sudo AI pret",                        True,  "welcome message present (ASCII)"),
    ("Sudo Studio Enterprise fully activated!", True, "activation success log"),
]

all_ok = True
for text, must_exist, desc in checks:
    # Only check in the new activate() block
    present = text in new_content
    if must_exist:
        if present:
            print(f"  PASS - {desc}")
        else:
            print(f"  FAIL - {desc} -- '{text}' not found!")
            all_ok = False
    else:
        # Check if it appears in the activate() function specifically
        activate_idx = new_content.find("async function activate(ctx)")
        next_func_idx = new_content.find("\nasync function ", activate_idx + 10)
        activate_block = new_content[activate_idx:next_func_idx] if next_func_idx > 0 else new_content[activate_idx:activate_idx+2000]
        in_activate = text in activate_block
        if not in_activate:
            print(f"  PASS - {desc}")
        else:
            print(f"  FAIL - {desc} -- '{text}' still in activate()!")
            all_ok = False

print()
if all_ok:
    print("=== ALL CHECKS PASSED === extension.js v4.4 ready")
else:
    print("=== SOME CHECKS FAILED === Review above")
