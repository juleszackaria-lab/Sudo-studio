#!/usr/bin/env node
/**
 * SUDO STUDIO - headless secret scan (P41 proof tool).
 *
 * Runs the REAL SecurityPanel scanner on any folder, without VS Code:
 *   node scripts/security-scan.js <folder> [--before] [--show-hidden] [--json]
 *
 * --before       legacy pre-P41 scan (old noise included): run with and
 *                without it on the same folder for before/after numbers.
 * --show-hidden  also list masked (low-confidence) findings (redacted).
 * --json         machine-readable output (for the P41 proof paste).
 *
 * Snippets are redacted by the scanner; no raw secret is ever printed.
 * The score needs an advisory DB (panel import); headless it stays N/A.
 * Exit 0 on success, 2 on usage/scan error. ASCII-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// -- minimal vscode stub (the scan path only reads workspaceFolders) --------
const vscodeStub = {
    workspace: { workspaceFolders: [] },
    window: { showInformationMessage() {}, showErrorMessage() {}, showWarningMessage() {} },
    ViewColumn: { One: 1 },
    env: {},
    Uri: { file: (p) => ({ fsPath: p }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeStub;
    return origLoad.call(this, req, parent, isMain);
};

const EXT = path.join(__dirname, '..', 'sudo-ai-extension');
const { SecurityPanel } = require(path.join(EXT, 'src', 'panels', 'SecurityPanel.js'));
const ss = require(path.join(EXT, 'src', 'utils', 'securityScore.js'));

function usage() {
    console.log('Usage: node scripts/security-scan.js <folder> [--before] [--show-hidden] [--json]');
}

async function main() {
    const args = process.argv.slice(2);
    const dir = args.find((a) => a.charAt(0) !== '-');
    const before = args.indexOf('--before') !== -1;
    const showHidden = args.indexOf('--show-hidden') !== -1;
    const asJson = args.indexOf('--json') !== -1;
    if (!dir) { usage(); process.exitCode = 2; return; }
    const root = path.resolve(dir);
    let st = null;
    try { st = fs.statSync(root); } catch (_) { st = null; }
    if (!st || !st.isDirectory()) {
        console.error('Not a readable folder: ' + dir);
        process.exitCode = 2; return;
    }
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    const fp = { webview: { html: '', async postMessage() { return true; }, onDidReceiveMessage() {} },
        onDidDispose() {}, reveal() {}, dispose() {} };
    const panel = new SecurityPanel(fp, null);
    const t0 = Date.now();
    let hits = [];
    try {
        hits = await panel._scanSecrets(root, { legacy: before });
    } catch (e) {
        console.error('Scan failed: ' + String((e && e.message) || e));
        process.exitCode = 2; return;
    }
    const ms = Date.now() - t0;
    const hidden = panel._lastSecretsHidden || [];
    const meta = panel._lastSecretsMeta || { scanned: 0, skipped: {}, generatedDirs: [] };
    const scored = ss.computeSecurityScore({
        secrets: hits.concat(hidden), advisories: [],
        files: ss.checkSecurityFiles(root), hasTests: ss.hasTests(root), db: null,
    });
    const bySev = {};
    for (const h of hits) bySev[h.severity] = (bySev[h.severity] || 0) + 1;
    const byConf = {};
    for (const h of hits.concat(hidden)) byConf[h.confidence || '?'] = (byConf[h.confidence || '?'] || 0) + 1;
    const sk = meta.skipped || {};
    const out = {
        folder: root,
        mode: before ? 'before (legacy pre-P41)' : 'after (P41)',
        ms,
        scanned: meta.scanned || 0,
        skipped: { large: sk.large || 0, binary: sk.binary || 0, unreadable: sk.unreadable || 0,
            dirs: sk.dirs || 0, symlink: sk.symlink || 0 },
        generatedDirsSkipped: sk.generatedDirs || 0,
        generatedDirs: meta.generatedDirs || [],
        visible: hits.length,
        bySeverity: bySev,
        byConfidence: byConf,
        hiddenLowConfidence: hidden.length,
        score: scored.score,
        scoreStatus: scored.status,
        findings: hits.map((h) => ({ file: h.file, line: h.line, label: h.label,
            severity: h.severity, confidence: h.confidence, ignored: h.ignored, snippet: h.snippet })),
        masked: showHidden ? hidden.map((h) => ({ file: h.file, line: h.line, label: h.label,
            severity: h.severity, confidence: h.confidence, snippet: h.snippet })) : undefined,
    };
    if (asJson) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    console.log('Dossier : ' + root + '  (mode ' + (before ? 'AVANT' : 'APRES') + ', ' + ms + ' ms)');
    console.log('Fichiers analyses : ' + out.scanned +
        ' | generes ignores : ' + out.generatedDirsSkipped +
        (out.generatedDirs.length ? ' (' + out.generatedDirs.join(', ') + ')' : '') +
        ' | sautes : large=' + out.skipped.large + ' binaire=' + out.skipped.binary +
        ' illisible=' + out.skipped.unreadable);
    const sevTxt = ['critical', 'high', 'medium', 'low']
        .map((s) => s + '=' + (bySev[s] || 0)).join(' ');
    console.log('Constats visibles : ' + hits.length + ' (' + sevTxt + ')');
    console.log('Constats masques (faible confiance) : ' + hidden.length);
    console.log('Score : ' + (scored.score === null ? 'N/A (base d\'avis absente en headless)' : scored.score));
    for (const f of out.findings) {
        console.log('  ' + f.file + ':' + f.line + ' [' + f.severity + '/' + f.confidence + ']' +
            (f.ignored ? ' [ignore]' : '') + ' ' + f.label + ' :: ' + f.snippet);
    }
    if (showHidden) {
        for (const f of out.masked) {
            console.log('  (masque) ' + f.file + ':' + f.line + ' [' + f.severity + '/' + f.confidence +
                '] ' + f.label + ' :: ' + f.snippet);
        }
    }
}

main().then(() => { process.exit(process.exitCode || 0); })
    .catch((e) => { console.error('FATAL ' + String((e && e.stack) || e)); process.exit(2); });
