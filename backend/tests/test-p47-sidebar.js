/**
 * SUDO STUDIO - PROMPT 47: "Sudo Studio" sidebar + robot icon.
 * A: container | B: single tree view | C: model coverage/exactness |
 * D: registration + wiring | E: hygiene. Hermetic reads only. ASCII-only.
 *
 * Coverage rule (owner list forces one shared command: "Test Coverage"
 * opens the Security panel like "Security Audit", so the test is
 * "every non-internal command has >= 1 entry", plus "no duplicate
 * (label, command) entry"). P48: labels are the English set (C6/C8).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'sudo-ai-extension');
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
const { GROUPS, INTERNAL_COMMANDS } = require('../../sudo-ai-extension/src/views/sidebarModel');

// -- A: activity-bar container (proven root cause, installed editor) ----------
const bars = (pkg.contributes.viewsContainers || {}).activitybar || [];
check('A1: exactly one container: id/title/icon-string',
    bars.length === 1 && bars[0].id === 'sudo-studio' && bars[0].title === 'Sudo Studio' &&
    typeof bars[0].icon === 'string' && bars[0].icon === 'resources/sudo-robot.svg',
    JSON.stringify(bars));
const robotPath = path.join(EXT, 'resources', 'sudo-robot.svg');
const robot = fs.existsSync(robotPath) ? fs.readFileSync(robotPath, 'utf8') : '';
check('A2: robot SVG on disk, 24px, currentColor, no hard colors, ASCII',
    fs.existsSync(robotPath) && robot.indexOf('viewBox="0 0 24 24"') !== -1 &&
    robot.indexOf('currentColor') !== -1 && !/#[0-9A-Fa-f]{3}/.test(robot) &&
    [...robot].every((c) => c.codePointAt(0) < 128));

// -- B: exactly one tree view --------------------------------------------------
const views = pkg.contributes.views || {};
const studioViews = views['sudo-studio'] || [];
const DELETED = ['sudoAgentLauncher', 'sudoStudioDashboard', 'sudoStudioEnvironment',
    'sudoStudioSecurity', 'sudoStudioDuplication', 'sudoStudioCentral', 'sudoStudioLicense'];
check('B1: single "Sudo Studio" view in the container',
    studioViews.length === 1 && studioViews[0].id === 'sudoStudio' &&
    studioViews[0].name === 'Sudo Studio',
    JSON.stringify(studioViews.map((v) => v.id)));
check('B2: no Sudo view anywhere else (explorer / old container)',
    !views.explorer && !views['sudo-agent'] &&
    !bars.some((b) => b.id === 'sudo-agent'));
check('B3: no orphan menu whens on deleted views',
    DELETED.every((g) => JSON.stringify(pkg.contributes.menus).indexOf(g) === -1));
check('B4: no stale view/title buttons left',
    (pkg.contributes.menus['view/title'] || []).length === 0);

// -- C: model coverage + exactness ---------------------------------------------
const entries = [];
GROUPS.forEach((g) => (g.entries || []).forEach((e) => entries.push({ group: g.id, label: e.label, command: e.command, icon: e.icon })));
const contributed = (pkg.contributes.commands || []).map((c) => c.command);
check('C1: every referenced command is contributed',
    entries.every((e) => contributed.indexOf(e.command) !== -1),
    JSON.stringify(entries.filter((e) => contributed.indexOf(e.command) === -1)));
const regBlock = extSrc.slice(extSrc.indexOf('const commands = ['), extSrc.indexOf('commands.forEach'));
check('C2: every referenced command is registered with a handler',
    entries.every((e) => regBlock.indexOf("'" + e.command + "'") !== -1),
    JSON.stringify(entries.filter((e) => regBlock.indexOf("'" + e.command + "'") === -1).map((e) => e.command)));
const seen = new Set();
const dupes = entries.filter((e) => {
    const k = e.label + '|' + e.command;
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
});
check('C3: no duplicate (label, command) entry', dupes.length === 0, JSON.stringify(dupes));
const covered = new Set(entries.map((e) => e.command));
const internal = new Set(Object.keys(INTERNAL_COMMANDS));
const missing = contributed.filter((c) => !covered.has(c) && !internal.has(c));
const extraInternal = [...internal].filter((c) => contributed.indexOf(c) === -1);
check('C4: every non-internal command has >= 1 entry; internal list exact',
    missing.length === 0 && extraInternal.length === 0,
    'missing=' + JSON.stringify(missing) + ' extraInternal=' + JSON.stringify(extraInternal));
check('C5: tree/internal partition covers all 59 commands exactly once',
    contributed.length === 59 && covered.size + internal.size === 59 &&
    [...covered].every((c) => !internal.has(c)),
    'covered=' + covered.size + ' internal=' + internal.size);
// P48: tree labels are the EXACT English set (no emoji); panel webview
// titles themselves are unchanged (French, untouched by P48).
const EXPECTED_LABELS = {
    'sudoStudio.openAgentPanel': ['Sudo Agent'],
    'sudoStudio.openChat': ['Sudo Chat'],
    'sudoStudio.openLogsViewer': ['Agent Logs'],
    'sudoStudio.openRuntimePanel': ['Runtime & Models'],
    'sudoStudio.openProvidersPanel': ['AI Providers'],
    'sudoStudio.openAnalysisPanel': ['Project Analysis'],
    'sudoStudio.openEnvironmentPanel': ['Reproducible Environment'],
    'sudoStudio.backupEnvironment': ['Backup Environment'],
    'sudoStudio.restoreEnvironment': ['Restore Environment'],
    'sudoStudio.cloneEnvironment': ['Clone Environment'],
    'sudoStudio.createSnapshot': ['Create Snapshot'],
    'sudoStudio.openDuplicationPanel': ['Enterprise Duplication'],
    'sudoStudio.openSecurityPanel': ['Security Audit', 'Test Coverage'],
    'sudoStudio.runSecurityAudit': ['Run Security Audit'],
    'sudoStudio.runDoctor': ['System Doctor'],
    'sudoStudio.openSDKPanel': ['SDK Manager'],
    'sudoStudio.openSdkInstallPanel': ['SDK Install'],
    'sudoStudio.openDevOpsPanel': ['DevOps Automation'],
    'sudoStudio.openCentralMgmtPanel': ['Central Management'],
    'sudoStudio.openAuditLog': ['Audit Log'],
    'sudoStudio.openLicensePanel': ['License Management'],
    'sudoStudio.openLogsFolder': ['Open Logs Folder'],
    'sudoStudio.exportDiagnostics': ['Export Diagnostics'],
};
const EXPECTED_GROUPS = ['Agent', 'AI Runtime', 'Project', 'Environment',
    'Duplication', 'Security', 'Tools', 'Administration', 'Logs'];
const actualPairs = entries.map((e) => e.command + '|' + e.label).sort();
const expectedPairs = [];
Object.keys(EXPECTED_LABELS).forEach((c) => EXPECTED_LABELS[c].forEach((l) => expectedPairs.push(c + '|' + l)));
expectedPairs.sort();
const actualGroups = GROUPS.map((g) => g.label);
check('C6: tree labels are exactly the P48 English set (no emoji)',
    JSON.stringify(actualPairs) === JSON.stringify(expectedPairs) &&
    JSON.stringify(actualGroups) === JSON.stringify(EXPECTED_GROUPS),
    'pairs=' + JSON.stringify(actualPairs.filter((p) => expectedPairs.indexOf(p) === -1)) +
    ' groups=' + JSON.stringify(actualGroups));
// every icon must be a bundled codicon
const css = fs.readFileSync(path.join(EXT, 'media', 'codicon.css'), 'utf8');
const allIcons = [];
GROUPS.forEach((g) => { allIcons.push(g.icon); (g.entries || []).forEach((e) => allIcons.push(e.icon)); });
check('C7: every group/entry icon is a bundled codicon',
    allIcons.every((i) => css.indexOf('.codicon-' + i + ':') !== -1 || css.indexOf('.codicon-' + i + '::') !== -1 || css.indexOf('.codicon-' + i + ' :') !== -1),
    JSON.stringify(allIcons.filter((i) => css.indexOf('.codicon-' + i) === -1)));
// P48: labels carry no emoji and no accents (ASCII printable only).
const asciiRe = /^[\x20-\x7E]+$/;
const badLabels = [];
GROUPS.forEach((g) => {
    if (!asciiRe.test(g.label)) badLabels.push(g.label);
    (g.entries || []).forEach((e) => { if (!asciiRe.test(e.label)) badLabels.push(e.label); });
});
check('C8: every group/entry label is ASCII-only (no emoji, no accents)',
    badLabels.length === 0, JSON.stringify(badLabels));

// -- D: registration + wiring ---------------------------------------------------
check('D1: only the single tree registration left',
    extSrc.indexOf("registerTreeDataProvider('sudoStudio'") !== -1 &&
    DELETED.every((g) => extSrc.indexOf("registerTreeDataProvider('" + g + "'") === -1) &&
    extSrc.indexOf('registerWebviewViewProvider') === -1 &&
    extSrc.indexOf('AgentActivityView') === -1);
check('D2: deleted provider files really gone',
    ['Dashboard', 'Chat', 'Doctor', 'SDK', 'DevOps', 'Environment', 'Runtime',
        'Security', 'Duplication', 'Central', 'License'].every((n) =>
        !fs.existsSync(path.join(EXT, 'src', 'providers', n + 'Provider.js'))) &&
    !fs.existsSync(path.join(EXT, 'src', 'agent', 'AgentActivityView.js')));
const resetFn = extSrc.slice(extSrc.indexOf('async function resetLayout()'), extSrc.indexOf('async function resetLayout()') + 900);
check('D3: resetLayout collapses the single view only',
    resetFn.indexOf('async function resetLayout()') !== -1 &&
    resetFn.indexOf("'sudoStudio'") !== -1 &&
    DELETED.every((g) => resetFn.indexOf(g) === -1),
    resetFn.slice(0, 120));
check('D4: reveal-once per version kept (containerShownFor)',
    extSrc.indexOf('workbench.view.extension.sudo-studio') !== -1 &&
    extSrc.indexOf('sudoStudio.containerShownFor') !== -1);
check('D5: all 59 commands still registered',
    contributed.every((c) => regBlock.indexOf("'" + c + "'") !== -1),
    'count=' + contributed.length);

// -- E: hygiene ------------------------------------------------------------------
const chk1 = spawnSync(process.execPath, ['--check', path.join(EXT, 'src', 'views', 'sidebarModel.js')]);
const chk2 = spawnSync(process.execPath, ['--check', path.join(EXT, 'src', 'providers', 'SudoStudioProvider.js')]);
const chk3 = spawnSync(process.execPath, ['--check', path.join(EXT, 'extension.js')]);
check('E1: sidebar sources compile', chk1.status === 0 && chk2.status === 0 && chk3.status === 0);
const asciiOk = (f) => [...fs.readFileSync(f, 'utf8')].every((c) => c.codePointAt(0) < 128);
check('E2: new sidebar sources are ASCII-only',
    asciiOk(path.join(EXT, 'src', 'views', 'sidebarModel.js')) &&
    asciiOk(path.join(EXT, 'src', 'providers', 'SudoStudioProvider.js')) &&
    asciiOk(__filename));
check('E3: 9 groups, collapsible, entries non-empty with icons',
    GROUPS.length === 9 && GROUPS.every((g) => g.id && g.label && g.icon &&
        Array.isArray(g.entries) && g.entries.length > 0 &&
        g.entries.every((e) => e.label && e.command && e.icon)));

console.log('\nP47: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
