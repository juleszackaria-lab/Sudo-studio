/** PROMPT 13 agent UI suite (ASCII-only): tokens, fonts, rail, contrast, stats. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.SUDO_STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-home-'));
const vscodeStub = { window: {}, workspace: {}, Uri: {}, ViewColumn: {}, commands: {} };
const origLoad = Module._load;
const axiosStub = { get: async () => ({ data: {} }) };
Module._load = function (req, ...rest) {
    if (req === 'vscode') return vscodeStub;
    if (req === 'axios') return axiosStub;
    return origLoad.call(this, req, ...rest);
};
const A = require('../../sudo-ai-extension/src/agent/AgentPanel.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const htmlA = A.getWebviewHtml({ nonce: 'N', cspSource: 'CSP', codiconUri: 'CODI' });
const htmlC = A.getWebviewHtml({ nonce: 'N', cspSource: 'CSP', codiconUri: 'CODI', variant: 'chat' });
const htmlW = A.getWebviewHtml({ nonce: 'N', cspSource: 'CSP', codiconUri: 'CODI',
    tokensUri: 'TOK', hljsUri: 'HLJS' });
const TOK = '../../sudo-ai-extension/media/agent-ui-tokens.css';
const tok = fs.readFileSync(TOK, 'utf8');

// T1: token file content
check('T1-tokens', ['--sudo-surface', '--sudo-raised', '--sudo-border', '--sudo-text',
    '--sudo-dim', '--sudo-accent', '--sudo-ok', '--sudo-warn', '--sudo-err',
    'body.vscode-light', '@font-face', '.hljs-keyword'].every((x) => tok.includes(x)));
const tokNoCom = tok.replace(/\/\*[\s\S]*?\*\//g, '');
check('T1b-tokens-clean', !/gradient|box-shadow|text-shadow|https?:\/\//i.test(tokNoCom));
check('T1c-scale', tok.includes('--fs-2: 14px') && tok.includes('--r-surf: 10px') &&
    tok.includes('--r-ctl: 6px') && tok.includes('--fs-4: 20px'));

// T2: embedded fonts + OFL
const fonts = ['sans-400', 'sans-500', 'sans-600', 'mono-400', 'mono-500'];
const woffOk = fonts.every((f) => {
    const b = fs.readFileSync('../../sudo-ai-extension/media/fonts/' + f + '.woff2');
    return b.length > 4000 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32;
});
const ofl = fs.readFileSync('../../sudo-ai-extension/media/fonts/OFL.txt', 'utf8');
check('T2-fonts', woffOk && ofl.includes('SIL Open Font License'));

// T3: vendored highlighter + BSD + 9 languages functional
const LIC = fs.readFileSync('../../sudo-ai-extension/media/vendor/highlight-LICENSE', 'utf8');
const hlSrc = fs.readFileSync('../../sudo-ai-extension/media/vendor/highlight.min.js', 'utf8');
let hlLangs = [];
try { hlLangs = new Function(hlSrc + '; return hljs.listLanguages();')(); } catch (e) { hlLangs = []; }
const need = ['dart', 'typescript', 'javascript', 'python', 'json', 'yaml', 'shell', 'xml', 'css'];
let hlWorks = false;
try {
    const out = new Function(hlSrc + '; return hljs.highlight("void main() {}", {language:"dart"}).value;')();
    hlWorks = out.includes('hljs-keyword');
} catch (e) { hlWorks = false; }
check('T3-hljs', LIC.includes('BSD') && need.every((l) => hlLangs.includes(l)) && hlWorks,
    'langs=' + hlLangs.length);

// T4: signature elements in html
check('T4-rail', htmlA.includes('class="rail"') === false /* built at runtime */ &&
    htmlA.includes('.rail::before') && htmlA.includes('"node " + cls') && htmlA.includes('aria-label", "Fil d'));
check('T4b-segmented', htmlA.includes('id="modeSel"') && htmlA.includes('role="radiogroup"') &&
    htmlA.includes('data-mode="build"') && htmlA.includes('data-mode="plan"') &&
    !htmlC.includes('id="modeSel"'));
check('T4c-changes', htmlA.includes('class="changes"') || htmlA.includes('.changes') &&
    htmlA.includes('Modifications (') && htmlA.includes('fileStats'));
check('T4d-code', htmlA.includes('codeblock') && htmlA.includes('Copier') &&
    htmlA.includes('Copier le bloc de code') && htmlA.includes('window.hljs'));
check('T4e-states', htmlA.includes('className = "skel"') && htmlA.includes('.txt.live::after') &&
    htmlA.includes('Recommencer') && htmlA.includes('Ouvrir Runtime') &&
    (htmlA.match(/data-sugg=/g) || []).length === 4);
check('T4f-approval', htmlA.includes('btn primary') && htmlA.includes('collapsed') &&
    htmlA.includes('done-line'));
check('T4g-chat', htmlC.includes('planbadge') && htmlC.includes('id="toAgentBtn"'));
check('T4h-wired', htmlW.includes('<link rel="stylesheet" href="TOK">') &&
    htmlW.includes('<script src="HLJS"></script>') && !htmlA.includes('href="TOK"'));

// T5: banned patterns in generated html
check('T5-clean', !/gradient/i.test(htmlA) && !/box-shadow|text-shadow/i.test(htmlA) &&
    !/#[0-9a-fA-F]{3,8}\b/.test(htmlA) &&
    !/\b(10|14|15|13\.5|11\.5|12\.5|9|7|5)px/.test(htmlA));
check('T5b-no-emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(htmlA));
check('T5c-offline', !/https?:\/\//.test(htmlA) && htmlA.includes("script-src 'nonce-N' CSP;"));
check('T5d-col', htmlA.includes('max-width:820px') && !htmlA.includes('880px'));

// T6: protocol intact both directions
// P28: '"setSandboxLevel"' removed from the pin (message deleted by P27 with OpenCode).
const toHost = ['"send"', '"stop"', '"approve"', '"setMode"',
    '"setProvider"', '"openDiff"', '"undo"', '"openRuntime"', '"toAgent"', '"refreshRuntime"'];
const toClient = ['"runState"', '"started"', '"step"', '"part"', '"approval"', '"actionable"',
    '"approvalResolved"', '"done"', '"error"', '"undoResult"', '"runtime"', '"providers"',
    '"mode"', '"sandbox"', '"cleared"', '"context"', '"history"'];
check('T6-protocol', toHost.every((x) => htmlA.includes(x)) &&
    toClient.every((x) => htmlA.includes(x)));

// T7: keyboard + motion + perf hooks
check('T7-a11y', htmlA.includes(':focus-visible') && htmlA.includes('prefers-reduced-motion') &&
    htmlA.includes('role="log"') && htmlA.includes('content-visibility') &&
    htmlA.includes('aria-checked'));

// T8: WCAG contrast computed from the real token file (>= 4.5 text pairs)
function lum(hex) {
    const c = [1, 3, 5].map((i) => {
        const v = parseInt(hex.substr(i, 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function tokenVar(name, light) {
    const scope = light ? tok.split('body.vscode-light {')[1] : tok.split('body.vscode-light {')[0];
    const m = scope.match(new RegExp(name.replace(/-/g, '\\-') + ':[^;]*?(#[0-9A-Fa-f]{6})'));
    return m ? m[1] : null;
}
const pairs = [
    ['text/surface', '--sudo-text', '--sudo-surface'], ['dim/surface', '--sudo-dim', '--sudo-surface'],
    ['accent/surface', '--sudo-accent', '--sudo-surface'],
    ['ink/accent', '--sudo-accent-ink', '--sudo-accent'],
    ['ok/surface', '--sudo-ok', '--sudo-surface'], ['warn/surface', '--sudo-warn', '--sudo-surface'],
    ['err/surface', '--sudo-err', '--sudo-surface'],
    ['kw/code', '--sudo-c-keyword', '--sudo-code-bg'], ['str/code', '--sudo-c-string', '--sudo-code-bg'],
    ['num/code', '--sudo-c-number', '--sudo-code-bg'], ['com/code', '--sudo-c-comment', '--sudo-code-bg'],
    ['fn/code', '--sudo-c-fn', '--sudo-code-bg'],
];
let worst = null;
for (const light of [false, true]) {
    for (const [label, fg, bg] of pairs) {
        const a = tokenVar(fg, light), b = tokenVar(bg, light);
        const r = ratio(a, b);
        if (!worst || r < worst.r) worst = { r, label: (light ? 'light:' : 'dark:') + label, a, b };
    }
}
check('T8-contrast', worst.r >= 4.5, JSON.stringify(worst));

// T9: lineStats / fileStat units
check('T9-stats', JSON.stringify(A.lineStats('a\nb\nc\n', 'a\nB\nc\nd\n')) === '{"added":2,"removed":1}' &&
    JSON.stringify(A.fileStat(undefined, 'x\ny\n')) === '{"added":3,"removed":0}' &&
    JSON.stringify(A.fileStat('x\ny\n', undefined)) === '{"added":0,"removed":3}' &&
    A.fileStat(undefined, 'a\0b') === null && A.lineStats('a', 'b') !== null &&
    A.lineStats('x\n'.repeat(5000), 'y') === null);

// T10: _onDone posts fileStats (behavioral, mocked panel)
(function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-proj-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const p = Object.create(A.AgentPanel.prototype);
    p.projectRoot = dir;
    p.mode = 'build';
    p._running = true;
    p._queue = [];
    const posted = [];
    p._post = (m) => posted.push(m);
    p._diffStore = new A.DiffStore(dir);
    p._diffStore.snapshot();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
    p._onDone({ status: 'TERMINE', reason: 'ok', reply: '', filesModified: ['a.txt', 'new.txt'],
        sessionId: 's1', mode: 'build' });
    const done = posted.find((m) => m.type === 'done');
    const a = done && done.fileStats && done.fileStats.find((x) => x.file === 'a.txt');
    const n = done && done.fileStats && done.fileStats.find((x) => x.file === 'new.txt');
    check('T10-filestats', !!done && !!a && a.added === 2 && a.removed === 1 &&
        !!n && n.added === 2 && n.removed === 0, JSON.stringify(done && done.fileStats));
})();

// T11: ASCII sources
for (const f of ['../../sudo-ai-extension/src/agent/AgentPanel.js',
    '../../sudo-ai-extension/src/panels/ChatPanel.js', TOK]) {
    const bad = (fs.readFileSync(f, 'utf8').match(/[^\x00-\x7F]/g) || []).length;
    check('T11-ascii ' + path.basename(f), bad === 0, 'bad=' + bad);
}

// T12: client JS parses (both variants)
for (const [label, h] of [['agent', htmlA], ['chat', htmlC]]) {
    try {
        const m = h.match(/<script nonce="N">([\s\S]*?)<\/script>/);
        new Function(m[1]);
        check('T12-parse ' + label, true);
    } catch (e) { check('T12-parse ' + label, false, e.message); }
}

console.log(`\nP13: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
