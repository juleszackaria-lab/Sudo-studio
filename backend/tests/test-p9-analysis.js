/**
 * SUDO STUDIO - PROMPT 9 suite: real deterministic project analysis.
 * A: fixtures stats | B: lockfile deps | C: independent totals (find) |
 * D: progress/cancel/timeout/errors | E: AGENTS.md | F: AI prompt hygiene |
 * G: panel protocol (bugfix regression) | H: JSON export round-trip.
 * Hermetic (SUDO_STUDIO_HOME) + vscode/axios mocked. ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;

const analyzer = require('../../sudo-ai-extension/src/analysis/projectAnalyzer');
const { getAuditLog } = require('../../sudo-ai-extension/src/utils/auditLog');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-fx-'));
function wf(root, rel, content) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

// Independent re-implementation (different code path) for cross-checks.
function independentStats(dir) {
    const skip = new Set(analyzer.SKIP_DIRS);
    const out = { files: 0, lines: 0, byLang: {} };
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (skip.has(e.name)) continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(full); continue; }
            if (!e.isFile()) continue;
            out.files++;
            const lang = analyzer.langOf(e.name);
            const slot = out.byLang[lang] || (out.byLang[lang] = { files: 0, lines: 0 });
            slot.files++;
            const buf = fs.readFileSync(full);
            if (buf.subarray(0, Math.min(buf.length, 8192)).indexOf(0) === -1) {
                const n = buf.toString('utf8').split('\n').length;
                slot.lines += n;
                out.lines += n;
            }
        }
    }
    return out;
}

function buildFixtures() {
    const F = path.join(FX, 'fx-flutter');
    wf(F, 'pubspec.yaml', 'name: scannernum\ndescription: demo\ndependencies:\n  http: ^1.2.0\n  provider: 6.0.0\n');
    wf(F, 'pubspec.lock', 'packages:\n  http:\n    version: "1.2.1"\n  provider:\n    version: "6.0.0"\n');
    wf(F, 'lib/main.dart', 'void main() {\n  runApp();\n}\n// TODO: scan\n');
    wf(F, 'lib/util.dart', '// CANARY_P9_SECRET_XYZ\nint add(int a, int b) {\n  return a + b;\n}\n');
    wf(F, 'test/widget_test.dart', 'void main() {\n  testWidgets();\n}\n// FIXME: flaky\n');
    wf(F, 'README.md', '# ScannerNum\nDemo fixture.\n');
    wf(F, '.github/workflows/ci.yml', 'name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu\n');
    wf(F, 'node_modules/x/decoy.js', 'x\nx\n');
    wf(F, 'build/out/decoy2.js', 'x\n');
    wf(F, '.dart_tool/decoy3.json', '{}\n');
    wf(F, '.git/HEAD', 'ref\n');
    wf(F, 'venv/lib/decoy.py', 'x\n');

    const N = path.join(FX, 'fx-node');
    wf(N, 'package.json', JSON.stringify({ name: 'n', version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0', react: '^18.0.0' },
        devDependencies: { jest: '29.0.0' }, scripts: { test: 'jest', build: 'tsc' } }));
    wf(N, 'package-lock.json', JSON.stringify({ packages: {
        '': { dependencies: { 'left-pad': '1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/jest': { version: '29.0.0' } } }));
    wf(N, 'src/index.js', 'console.log(1);\nconsole.log(2);\n');
    wf(N, 'src/app.js', 'module.exports = {};\n// TODO: routes\n');
    wf(N, 'test/app.test.js', 'test(1);\ntest(2);\ntest(3);\n');
    wf(N, 'Jenkinsfile', 'pipeline {}\n');
    wf(N, 'README.md', '# N\n');
    wf(N, 'node_modules/react/index.js', 'x\n');
    wf(N, 'dist/bundle.js', 'x\n');

    const Y = path.join(FX, 'fx-yarn');
    wf(Y, 'package.json', JSON.stringify({ name: 'y', dependencies: { a: '^1.0.0' } }));
    wf(Y, 'yarn.lock', '# yarn lockfile v1\na@^1.0.0:\n  version "1.0.5"\n  resolved "https://x"\n');
    const P = path.join(FX, 'fx-py');
    wf(P, 'requirements.txt', 'requests==2.31.0\nflask>=3.0\n');
    wf(P, 'poetry.lock', '[[package]]\nname = "requests"\nversion = "2.31.0"\n');
    wf(P, 'main.py', 'print(1)\n');
    const G = path.join(FX, 'fx-go');
    wf(G, 'go.mod', 'module example.com/m\n\ngo 1.21\n\nrequire example.com/dep v1.2.3\n');
    wf(G, 'go.sum', 'example.com/dep v1.2.3 h1:abc=\n');
    wf(G, 'main.go', 'package main\nfunc main() {}\n');
    const C = path.join(FX, 'fx-cs');
    wf(C, 'app.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>\n');
    wf(C, 'packages.lock.json', JSON.stringify({ dependencies: { 'net8.0': {
        'Newtonsoft.Json': { resolved: '13.0.3' } } } }));
    wf(C, 'Program.cs', 'class P {}\n');
    const M = path.join(FX, 'fx-mvn');
    wf(M, 'pom.xml', '<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></project>\n');
    const NL = path.join(FX, 'fx-nolock');
    wf(NL, 'package.json', JSON.stringify({ name: 'nl', dependencies: { x: '1.0.0' } }));
    const MP = path.join(FX, 'fx-multi');
    wf(MP, 'package.json', JSON.stringify({ name: 'mp' }));
    wf(MP, 'requirements.txt', 'requests==2.31.0\n');
    const BIG = path.join(FX, 'fx-big');
    for (let i = 0; i < 300; i++) wf(BIG, 'src/f' + i + '.js', 'var x' + i + ' = ' + i + ';\n');
    const HUGE = path.join(FX, 'fx-huge');
    for (let i = 0; i < 2000; i++) wf(HUGE, 'd' + (i % 20) + '/f' + i + '.txt', 'line\n');
    return { F, N, Y, P, G, C, M, NL, MP, BIG, HUGE };
}

async function main() {
    const fx = buildFixtures();
    const t0 = Date.now();
    const repF = await analyzer.analyzeProject(fx.F);
    const tF = Date.now() - t0;
    const t1 = Date.now();
    const repN = await analyzer.analyzeProject(fx.N);
    const tN = Date.now() - t1;
    console.log('INFO durations: flutter=' + tF + 'ms node=' + tN + 'ms');

    // -- A: fixture stats ---------------------------------------------------
    check('A1: flutter type detected', repF.types.length === 1 && repF.types[0].type === 'flutter');
    check('A2: node type detected', repN.types.length === 1 && repN.types[0].type === 'node');
    const repMP = await analyzer.analyzeProject(fx.MP);
    check('A3: multi-type detected',
        repMP.types.map((t) => t.type).sort().join(',') === 'node,python');
    check('A4: flutter files exact (7, skips excluded)', repF.stats.files === 7, String(repF.stats.files));
    check('A5: node files exact (7, skips excluded)', repN.stats.files === 7, String(repN.stats.files));
    const indF = independentStats(fx.F);
    check('A6: flutter lines/langs match independent count',
        indF.files === repF.stats.files && indF.lines === repF.stats.lines &&
        JSON.stringify(indF.byLang) === JSON.stringify(repF.stats.byLang),
        'ind=' + indF.files + '/' + indF.lines + ' rep=' + repF.stats.files + '/' + repF.stats.lines);
    const indN = independentStats(fx.N);
    check('A7: node lines/langs match independent count',
        indN.files === repN.stats.files && indN.lines === repN.stats.lines &&
        JSON.stringify(indN.byLang) === JSON.stringify(repN.stats.byLang));
    const segHit = (p) => String(p).split('/').some((s) =>
        ['node_modules', 'build', '.dart_tool', '.git', 'venv'].indexOf(s) !== -1);
    check('A8: skipped dirs absent everywhere (exact segments)',
        !repF.biggest.some((b) => segHit(b.path)) &&
        !repF.tree.some((t) => segHit(t.path)) &&
        !repF.tests.sample.some(segHit));
    const libRow = repF.tree.find((t) => t.path === 'lib');
    check('A9: tree rollup (lib=2)', !!libRow && libRow.files === 2);
    const indMax = (() => {
        let best = { path: '', bytes: -1 };
        const skip = new Set(analyzer.SKIP_DIRS);
        const stack = [fx.F];
        while (stack.length) {
            const d = stack.pop();
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (skip.has(e.name)) continue;
                const full = path.join(d, e.name);
                if (e.isDirectory()) { stack.push(full); continue; }
                if (!e.isFile()) continue;
                const s = fs.statSync(full).size;
                if (s > best.bytes) best = { path: path.relative(fx.F, full).replace(/\\/g, '/'), bytes: s };
            }
        }
        return best;
    })();
    check('A10: biggest[0] is the largest file',
        repF.biggest[0].path === indMax.path && repF.biggest[0].bytes === indMax.bytes,
        JSON.stringify(repF.biggest[0]));
    check('A11: flutter entry lib/main.dart',
        repF.entryPoints.some((e) => e.type === 'flutter' && e.path === 'lib/main.dart'));
    check('A12: node entry src/index.js',
        repN.entryPoints.some((e) => e.type === 'node' && e.path === 'src/index.js'));
    check('A13: flutter tests count 1', repF.tests.count === 1, String(repF.tests.count));
    check('A14: node tests count 1 + jest framework',
        repN.tests.count === 1 && repN.tests.frameworks.join(',') === 'jest');
    check('A15: flutter CI github-actions',
        repF.ci.some((c) => c.system === 'github-actions' && c.path === '.github/workflows/ci.yml'));
    check('A16: node CI jenkins', repN.ci.some((c) => c.system === 'jenkins'));
    check('A17: flutter README present', repF.readme.present === true && repF.readme.path === 'README.md');
    check('A18: flutter TODO/FIXME exact (1+1)',
        repF.todos.todo === 1 && repF.todos.fixme === 1 && repF.todos.count === 2);
    check('A19: meta stamps (duration + ISO date)',
        typeof repF.durationMs === 'number' && /^\d{4}-\d{2}-\d{2}T/.test(repF.analyzedAt));

    // -- B: lockfile deps -----------------------------------------------------
    const nodeDeps = repN.deps.find((d) => d.ecosystem === 'node');
    check('B1: package-lock versions (left-pad 1.3.0, jest 29.0.0)',
        nodeDeps.lockfile === 'package-lock.json' &&
        nodeDeps.locked.some((l) => l.name === 'left-pad' && l.version === '1.3.0') &&
        nodeDeps.locked.some((l) => l.name === 'jest' && l.version === '29.0.0'));
    check('B2: react unlocked (missing from lock)',
        nodeDeps.unlocked.indexOf('react') !== -1, JSON.stringify(nodeDeps.unlocked));
    check('B3: react unpinned, left-pad pinned',
        nodeDeps.unpinned.indexOf('react') !== -1 &&
        nodeDeps.unpinned.indexOf('left-pad') === -1);
    const repY = await analyzer.analyzeProject(fx.Y);
    const yDeps = repY.deps.find((d) => d.ecosystem === 'node');
    check('B4: yarn.lock parsed (a 1.0.5)',
        yDeps.lockfile === 'yarn.lock' &&
        yDeps.locked.some((l) => l.name === 'a' && l.version === '1.0.5'));
    const repP = await analyzer.analyzeProject(fx.P);
    const pDeps = repP.deps.find((d) => d.ecosystem === 'python');
    check('B5: poetry.lock (requests locked, flask unlocked+unpinned)',
        pDeps.lockfile === 'poetry.lock' &&
        pDeps.locked.some((l) => l.name === 'requests' && l.version === '2.31.0') &&
        pDeps.unlocked.indexOf('flask') !== -1 && pDeps.unpinned.indexOf('flask') !== -1);
    const repG = await analyzer.analyzeProject(fx.G);
    const gDeps = repG.deps.find((d) => d.ecosystem === 'go');
    check('B6: go.sum locks versions',
        gDeps.lockfile === 'go.sum' && gDeps.locked.length === 1 && gDeps.unlocked.length === 0);
    const repC = await analyzer.analyzeProject(fx.C);
    const cDeps = repC.deps.find((d) => d.ecosystem === 'csharp');
    check('B7: packages.lock.json (Newtonsoft 13.0.3)',
        cDeps.lockfile === 'packages.lock.json' &&
        cDeps.locked.some((l) => l.name === 'Newtonsoft.Json' && l.version === '13.0.3'));
    const repM = await analyzer.analyzeProject(fx.M);
    const mDeps = repM.deps.find((d) => d.ecosystem === 'java-maven');
    check('B8: pom listed + honest no-lockfile note',
        mDeps.manifestDeps.some((d) => d.name === 'junit:junit' && d.range === '4.13.2') &&
        mDeps.lockfile === null && mDeps.note.length > 0);
    const repNL = await analyzer.analyzeProject(fx.NL);
    const nlDeps = repNL.deps.find((d) => d.ecosystem === 'node');
    check('B9: missing lockfile flagged (unlocked all + note)',
        nlDeps.lockfile === null && nlDeps.unlocked.join(',') === 'x' && nlDeps.note.length > 0);
    const fDeps = repF.deps.find((d) => d.ecosystem === 'flutter');
    check('B10: pubspec.lock (http 1.2.1)',
        fDeps.lockfile === 'pubspec.lock' &&
        fDeps.locked.some((l) => l.name === 'http' && l.version === '1.2.1'));

    // -- C: independent totals (PC repeats with Get-ChildItem) ---------------
    function findTotal(dir) {
        const r = spawnSync('find', [dir, '-type', 'f'], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, 'find failed');
        const skip = new Set(analyzer.SKIP_DIRS);
        return r.stdout.split('\n').filter(Boolean).filter((p) => {
            const rel = path.relative(dir, p).split(path.sep);
            return !rel.some((seg) => skip.has(seg));
        }).length;
    }
    check('C1: flutter total matches find(1)', findTotal(fx.F) === repF.stats.files,
        'find=' + findTotal(fx.F) + ' rep=' + repF.stats.files);
    check('C2: node total matches find(1)', findTotal(fx.N) === repN.stats.files);

    // -- D: progress / cancel / timeout / errors ------------------------------
    const prog = [];
    const repBig = await analyzer.analyzeProject(fx.BIG, {
        onProgress: (p) => prog.push(p.files),
    });
    const mono = prog.every((v, i) => i === 0 || v >= prog[i - 1]);
    check('D1: progress fires, monotonic, ends at 300',
        prog.length > 0 && mono && prog[prog.length - 1] === 300 && repBig.stats.files === 300);
    const ctl = new AbortController();
    let d2err = null;
    try {
        await analyzer.analyzeProject(fx.BIG, {
            signal: ctl.signal,
            onProgress: (p) => { if (p.files >= 60) ctl.abort(); },
        });
    } catch (e) { d2err = e; }
    check('D2: cancel aborts with partial counters',
        !!d2err && d2err.code === 'ANALYSIS_ABORTED' && d2err.partial &&
        d2err.partial.stats.files >= 60);
    let d3err = null;
    try {
        await analyzer.analyzeProject(fx.HUGE, { timeoutMs: 1 });
    } catch (e) { d3err = e; }
    check('D3: timeout fires with partial counters',
        !!d3err && d3err.code === 'ANALYSIS_TIMEOUT' && !!d3err.partial);
    let d4err = null;
    try {
        await analyzer.analyzeProject(path.join(FX, 'nope-missing'));
    } catch (e) { d4err = e; }
    check('D4: missing dir is a clear error', !!d4err && d4err.code === 'ANALYSIS_NOT_FOUND');
    const repCap = await analyzer.analyzeProject(fx.F, { maxFiles: 5 });
    check('D5: maxFiles truncates honestly',
        repCap.truncated === true && repCap.stats.files === 5);

    // -- E: AGENTS.md ---------------------------------------------------------
    const md = analyzer.buildAgentsMd(repN);
    check('E1: AGENTS.md carries facts (name, types, counts, scripts)',
        md.indexOf('# fx-node') !== -1 && md.indexOf('node (package.json)') !== -1 &&
        md.indexOf('Fichiers: 7') !== -1 && md.indexOf('Scripts npm: test, build') !== -1 &&
        md.indexOf('deterministe, sans IA') !== -1);
    const mdNL = analyzer.buildAgentsMd(repNL);
    check('E2: AGENTS.md warns on missing lock', mdNL.indexOf('SANS VERROUILLAGE') !== -1);
    const dSame = analyzer.diffLines(md, md);
    check('E3: identical contents diff clean', dSame.same === true);
    const dChg = analyzer.diffLines('a\nb\nc\n', 'a\nX\nc\nd\n');
    check('E4: changed contents show middles + counts',
        dChg.same === false && dChg.oldLines === 4 && dChg.newLines === 5 &&
        dChg.oldMiddle.join('|') === 'b|c' && dChg.newMiddle.join('|') === 'X|c|d');
    check('E5: AGENTS.md generation is deterministic',
        analyzer.buildAgentsMd(repN) === analyzer.buildAgentsMd(repN));

    // -- F: AI prompt hygiene --------------------------------------------------
    const prompt = analyzer.aiSummaryPrompt(repF);
    check('F1: prompt has aggregates only (no file contents)',
        prompt.indexOf('CANARY_P9_SECRET_XYZ') === -1 &&
        prompt.indexOf('fichiers: 7') !== -1 && prompt.indexOf('flutter') !== -1);
    check('F2: prompt capped', prompt.length <= 4000, String(prompt.length));

    // -- G: panel protocol (root-cause regression included) --------------------
    const vscodeMock = { workspace: { workspaceFolders: [] }, window: {}, ViewColumn: { One: 1 } };
    vscodeMock.window.showInformationMessage = () => {};
    vscodeMock.window.showErrorMessage = () => {};
    vscodeMock.window.showSaveDialog = async () => null;
    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req === 'vscode') return vscodeMock;
        if (req === 'axios') return { post: async () => { throw new Error('no axios'); } };
        return origLoad.call(this, req, parent, isMain);
    };
    const { ProjectAnalysisPanel } =
        require('../../sudo-ai-extension/src/panels/ProjectAnalysisPanel');
    function fakePanel() {
        return { webview: { html: '', posted: [],
            async postMessage(m) { this.posted.push(m); return true; },
            onDidReceiveMessage() {} },
        onDidDispose() {}, reveal() {}, dispose() {} };
    }
    function mkPanel(dir) {
        vscodeMock.workspace.workspaceFolders = dir ? [{ uri: { fsPath: dir } }] : [];
        const fp = fakePanel();
        const p = new ProjectAnalysisPanel(fp, null);
        try { clearTimeout(p._analysisTimeout); } catch (_) {}
        return { p, fp };
    }
    const g1 = mkPanel(fx.N);
    await g1.p.analyzeProject();
    const g1types = g1.fp.webview.posted.map((m) => m.type);
    const g1res = g1.fp.webview.posted.find((m) => m.type === 'analysisResult');
    check('G1: panel posts analyzing then analysisResult with real counts',
        g1types[0] === 'analyzing' && g1types.indexOf('analysisResult') !== -1 &&
        g1res.result.metrics.fileCount === 7 && g1res.analysis.stats.files === 7);
    const realAnalyze = analyzer.analyzeProject;
    analyzer.analyzeProject = async (root, opts) => {
        await new Promise((_, rej) => {
            const t = setInterval(() => {
                if (opts.signal.aborted) {
                    clearInterval(t);
                    const e = new Error('x');
                    e.code = 'ANALYSIS_ABORTED';
                    e.partial = { stats: { files: 5 } };
                    rej(e);
                }
            }, 10);
        });
    };
    try {
        const g2 = mkPanel(fx.N);
        const runP = g2.p.analyzeProject();
        await sleep(40);
        await g2.p.handleMessage({ type: 'cancelAnalysis' });
        await runP;
        const g2cancel = g2.fp.webview.posted.find((m) => m.type === 'analysisCancelled');
        check('G2: cancel button aborts the run (clear state)',
            !!g2cancel && g2cancel.text.indexOf('annulee') !== -1);
    } finally {
        analyzer.analyzeProject = realAnalyze;
    }
    const g3 = mkPanel(null);
    await sleep(250);
    check('G3: no folder is a clear state',
        g3.fp.webview.posted.some((m) => m.type === 'noWorkspace'));
    const expFile = path.join(FX, 'report.json');
    vscodeMock.window.showSaveDialog = async () => ({ fsPath: expFile });
    const g4 = mkPanel(fx.N);
    await g4.p.exportJson();
    const exported = JSON.parse(fs.readFileSync(expFile, 'utf8'));
    check('G4: export writes the JSON report + audits',
        exported.stats.files === 7 && exported.version === 1 &&
        getAuditLog(500).some((e) => e.action === 'ANALYSIS_EXPORT'));
    check('H1: exported JSON round-trips the full report',
        JSON.stringify(exported) === JSON.stringify(g4.p._lastAnalysis));
    const GX = path.join(FX, 'fx-agents');
    wf(GX, 'package.json', JSON.stringify({ name: 'gx' }));
    const g5 = mkPanel(GX);
    await g5.p.genAgents();
    const written5 = g5.fp.webview.posted.find((m) => m.type === 'agentsWritten');
    check('G5: AGENTS.md created when absent (no confirm needed)',
        !!written5 && written5.created === true &&
        fs.readFileSync(path.join(GX, 'AGENTS.md'), 'utf8').indexOf('# fx-agents') === 0);
    fs.writeFileSync(path.join(GX, 'AGENTS.md'), 'old text\n');
    const g6 = mkPanel(GX);
    await g6.p.genAgents();
    const diff6 = g6.fp.webview.posted.find((m) => m.type === 'agentsDiff');
    const stillOld = fs.readFileSync(path.join(GX, 'AGENTS.md'), 'utf8') === 'old text\n';
    check('G6: existing AGENTS.md shows diff, never silent overwrite',
        !!diff6 && diff6.diff.oldMiddle.join('|') === 'old text' && stillOld);
    await g6.p.confirmAgents();
    const after6 = fs.readFileSync(path.join(GX, 'AGENTS.md'), 'utf8');
    check('G7: confirmed overwrite writes regenerated content',
        after6.indexOf('# fx-agents') === 0 &&
        g6.fp.webview.posted.some((m) => m.type === 'agentsWritten'));
    const html = ProjectAnalysisPanel.prototype.getHtmlContent.call({});
    const clientJs = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const clientFile = path.join(FX, 'client-extract.js');
    fs.writeFileSync(clientFile, clientJs);
    const chk = spawnSync(process.execPath, ['--check', clientFile]);
    check('G8: panel client script compiles (root-cause regression)', chk.status === 0,
        String((chk.stderr || '').toString().split('\n')[0]).slice(0, 120));
    check('G9: emitted onclick escaping is intact',
        clientJs.indexOf("runFix(\\'") !== -1 && clientJs.indexOf("runFix(''") === -1);
    let gotPrompt = '';
    const g10 = mkPanel(fx.F);
    g10.p._aiComplete = async (pr) => { gotPrompt = pr; return { reply: 'FAKE SUMMARY' }; };
    await g10.p.aiSummary();
    const sum10 = g10.fp.webview.posted.find((m) => m.type === 'aiSummary' && !m.loading);
    check('G10: AI summary uses chosen provider path, facts-only prompt',
        !!sum10 && sum10.text === 'FAKE SUMMARY' &&
        gotPrompt.indexOf('CANARY_P9_SECRET_XYZ') === -1 &&
        gotPrompt.indexOf('fichiers: 7') !== -1);
    assert.ok(pass > 0, 'suite ran');

}

main().then(() => {
    console.log(fail === 0 ? `\nP9: ${pass} checks passed (all green)`
        : `\nP9: ${pass} passed, ${fail} FAILED`);
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
