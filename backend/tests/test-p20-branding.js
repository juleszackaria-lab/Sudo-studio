/**
 * SUDO STUDIO - PROMPT 20: brand, logos, activity bar, license texts.
 * A: activity container | B: license panel | C: customize script |
 * D: pattern-logic simulation | E: product/icons. Hermetic reads only. ASCII-only.
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
const licSrc = fs.readFileSync(path.join(EXT, 'src', 'panels', 'LicensePanel.js'), 'utf8');
const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'customize-vscodium.ps1'), 'utf8');

// -- A: single activity-bar container -------------------------------------------
const bars = (pkg.contributes.viewsContainers || {}).activitybar || [];
check('A1: exactly one activitybar container (sudo-studio)',
    bars.length === 1 && bars[0].id === 'sudo-studio' && bars[0].title === 'Sudo Studio',
    JSON.stringify(bars.map((b) => b.id)));
const iconL = bars[0] && bars[0].icon && bars[0].icon.light;
const iconD = bars[0] && bars[0].icon && bars[0].icon.dark;
check('A2: container icon is the robot SVG (both themes, on disk)',
    iconL === 'resources/sudo-robot.svg' && iconD === 'resources/sudo-robot.svg' &&
    fs.existsSync(path.join(EXT, iconL)));
const robot = fs.readFileSync(path.join(EXT, 'resources', 'sudo-robot.svg'), 'utf8');
check('A3: robot is 24px + currentColor, no hardcoded colors',
    robot.indexOf('viewBox="0 0 24 24"') !== -1 && robot.indexOf('currentColor') !== -1 &&
    !/#[0-9A-Fa-f]{3}/.test(robot) && [...robot].every((c) => c.codePointAt(0) < 128));
const views = pkg.contributes.views || {};
const studioViews = views['sudo-studio'] || [];
const ids = studioViews.map((v) => v.id);
check('A4: 12 Sudo views in the container (launcher + dashboard)',
    studioViews.length === 12 && ids.indexOf('sudoAgentLauncher') !== -1 &&
    ids.indexOf('sudoStudioDashboard') !== -1 && ids.indexOf('sudoStudioLicense') !== -1,
    String(studioViews.length));
check('A5: nothing under explorer or the old container',
    !views.explorer && !views['sudo-agent'] && !bars.some((b) => b.id === 'sudo-agent'));
check('A6: container icon is SVG art, not a codicon string',
    typeof bars[0].icon === 'object');
check('A7: old agent SVGs removed',
    !fs.existsSync(path.join(EXT, 'resources', 'agent-light.svg')) &&
    !fs.existsSync(path.join(EXT, 'resources', 'agent-dark.svg')));

// -- B: license panel --------------------------------------------------------------
check('B1: no prices left ($49/$199//mo)',
    licSrc.indexOf('$49') === -1 && licSrc.indexOf('$199') === -1 && licSrc.indexOf('/mo') === -1);
check('B2: no seats-times-price line', licSrc.indexOf('seats') !== -1 &&
    licSrc.indexOf('seats \u00b7') === -1 && licSrc.indexOf('d.price') === -1);
check('B3: French seat labels per edition',
    licSrc.indexOf("'1 poste'") !== -1 && licSrc.indexOf("'10 postes'") !== -1 &&
    licSrc.indexOf('Illimit&eacute;') !== -1);
check('B4: one-time help text (English, coherent)',
    licSrc.indexOf('one-time purchases') !== -1 && licSrc.indexOf('vendor sets the price') !== -1);
check('B5: feature lists kept', licSrc.indexOf('FEAT_LABELS') !== -1 &&
    licSrc.indexOf("features:['chat','doctor','sdk']") !== -1);
const chk = spawnSync(process.execPath, ['--check',
    path.join(EXT, 'src', 'panels', 'LicensePanel.js')]);
check('B6: LicensePanel compiles', chk.status === 0);
check('B7: no price field in edition defs', licSrc.indexOf('price:') === -1);

// -- C: customize script --------------------------------------------------------------
check('C1: STEP 2c replaces code-icon.svg content',
    ps1.indexOf('STEP 2c') !== -1 && ps1.indexOf('code-icon.svg') !== -1 &&
    ps1.indexOf('sudo-icon.svg') !== -1);
check('C2: old-logo markers + zero-verify',
    ps1.indexOf('path6008') !== -1 && ps1.indexOf('Gradient_1') !== -1 &&
    ps1.indexOf('0 old-logo occurrences remain') !== -1);
const orderKeys = ['Securing VSCodium', 'Microsoft Visual Studio Code', 'Microsoft VS Code',
    'Visual Studio Code(?![', 'VS Code(?![', 'VSCodium(?![', 'w-])Codium(?!['];
const tblStart = ps1.indexOf('$brandPatterns = @(');
const tbl = ps1.slice(tblStart, ps1.indexOf('[STEP 4e] Exhaustive', tblStart));
const orderIdx = orderKeys.map((k) => tbl.indexOf(k));
check('C3: ordered pattern table (phrase + Microsoft first, Codium last)',
    orderIdx.every((i) => i !== -1) && orderIdx.every((v, i) => i === 0 || v > orderIdx[i - 1]),
    JSON.stringify(orderIdx));
check('C4: legal skip covers ThirdPartyNotices/CREDITS/ATTRIBUTION',
    ps1.indexOf('THIRD-?PARTY') !== -1 && ps1.indexOf('CREDITS') !== -1 &&
    ps1.indexOf('ATTRIBUTION') !== -1);
check('C5: no single-pattern leftovers',
    ps1.indexOf('$displayPattern') === -1 && ps1.indexOf('$pattern') === -1);
check('C6: brand helpers defined',
    ps1.indexOf('function Invoke-BrandReplace') !== -1 &&
    ps1.indexOf('function Test-BrandMatch') !== -1);
const logo = fs.readFileSync(path.join(ROOT, 'resources', 'sudo-icon.svg'), 'utf8');
check('C7: replacement logo SVG (branded, not the old art)',
    logo.indexOf('<svg') === 0 && logo.indexOf('viewBox') !== -1 &&
    logo.indexOf('ssRing') !== -1 && logo.indexOf('path6008') === -1 &&
    [...logo].every((c) => c.codePointAt(0) < 128));

// -- D: pattern-logic simulation (JS mirror of the PS table) ------------------------------
const PATS = [
    [/Securing VSCodium/g, 'Sudo Studio'],
    [/Microsoft Visual Studio Code/g, 'Sudo Studio'],
    [/Microsoft VS Code/g, 'Sudo Studio'],
    [/(?<![\/\\.\w-])Visual Studio Code(?![\/\\.\w-])/g, 'Sudo Studio'],
    [/(?<![\/\\.\w-])VS Code(?![\/\\.\w-])/g, 'Sudo Studio'],
    [/(?<![\/\\.])VSCodium(?![\/\\.])/g, 'Sudo Studio'],
    [/(?<![\/\\.\w-])Codium(?![\/\\.\w-])/g, 'Sudo Studio'],
];
function mirror(s) {
    let out = s;
    for (const [re, to] of PATS) { re.lastIndex = 0; out = out.replace(re, to); }
    return out;
}
check('D1: announcement phrase + welcome text',
    mirror('Securing VSCodium') === 'Sudo Studio' &&
    mirror('Get Started with VSCodium') === 'Get Started with Sudo Studio');
check('D2: Microsoft variants collapse cleanly',
    mirror('Microsoft Visual Studio Code') === 'Sudo Studio' &&
    mirror('Download Microsoft VS Code now') === 'Download Sudo Studio now');
check('D3: bare VS Code / Visual Studio Code display strings',
    mirror('Open in VS Code') === 'Open in Sudo Studio' &&
    mirror('"Visual Studio Code"') === '"Sudo Studio"');
check('D4: technical names untouched',
    mirror('https://marketplace.visualstudio.com/x') === 'https://marketplace.visualstudio.com/x' &&
    mirror('vscode.postMessage({})') === 'vscode.postMessage({})' &&
    mirror('VSCodeReveal') === 'VSCodeReveal');
check('D5: URL/path contexts untouched',
    mirror('github.com/VSCodium/vscodium') === 'github.com/VSCodium/vscodium' &&
    mirror('raw.githubusercontent.com/VSCodium/vscodium/x.json') ===
        'raw.githubusercontent.com/VSCodium/vscodium/x.json');
check('D6: standalone Codium only',
    mirror('Codium') === 'Sudo Studio' && mirror('OpenCodium') === 'OpenCodium' &&
    mirror('https://vscodium.com') === 'https://vscodium.com');
const LEGAL_SKIP = /^(LICENSE|LICENCE|NOTICE|THIRD-?PARTY|COPYING|CREDITS|ATTRIBUTION)/i;
check('D7: legal filenames skipped, bundles swept',
    LEGAL_SKIP.test('ThirdPartyNotices.txt') && LEGAL_SKIP.test('THIRD-PARTY-NOTICES.txt') &&
    LEGAL_SKIP.test('LICENSE.txt') && !LEGAL_SKIP.test('workbench.desktop.main.js'));
check('D8: combined UI sentence',
    mirror('Welcome to VSCodium - VSCodium Docs (VS Code based)') ===
    'Welcome to Sudo Studio - Sudo Studio Docs (Sudo Studio based)');

// -- E: product + installer icons ---------------------------------------------------------
const prod = JSON.parse(fs.readFileSync(path.join(ROOT, 'product.json'), 'utf8'));
const prodV = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscodium', 'product.json'), 'utf8'));
check('E1: product.json stays Sudo Studio branded',
    prod.nameShort === 'Sudo Studio' && prod.nameLong === 'Sudo Studio' &&
    prod.win32DirName === 'Sudo Studio' && prodV.nameShort === 'Sudo Studio');
const ico = fs.readFileSync(path.join(ROOT, 'resources', 'icon.ico'));
check('E2: icon.ico is a real ICO (magic 00 00 01 00)',
    ico.length > 1000 && ico[0] === 0 && ico[1] === 0 && ico[2] === 1 && ico[3] === 0);
const iss = fs.readFileSync(path.join(ROOT, 'installer.iss'), 'utf8');
check('E3: installer uses brand icon + exe name',
    iss.indexOf('resources\\icon.ico') !== -1 && iss.indexOf('SudoStudio.exe') !== -1);

// -- F: wiring + legal preserved -----------------------------------------------------------------
const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
const avSrc = fs.readFileSync(path.join(EXT, 'src', 'agent', 'AgentActivityView.js'), 'utf8');
check('F1: launcher view still wired (same id)',
    avSrc.indexOf("VIEW_ID = 'sudoAgentLauncher'") !== -1 &&
    extSrc.indexOf('AgentActivityView.VIEW_ID') !== -1 &&
    extSrc.indexOf('registerWebviewViewProvider') !== -1);
check('F2: third-party notices preserved',
    fs.existsSync(path.join(EXT, 'THIRD_PARTY_NOTICES.md')));

console.log(fail === 0 ? `\nP20: ${pass} checks passed (all green)`
    : `\nP20: ${pass} passed, ${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
