/**
 * SUDO STUDIO - PROMPT 22: real dependency reading + verifiable detections.
 * A: flutter records | B: node records | C: pyproject | D: other ecosystems |
 * E: no-manifest | F: panel dep counts | G: git states | H: arch evidence |
 * I: client render. Hermetic (SUDO_STUDIO_HOME) + vscode/axios mocked. ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-home-'));
process.env.SUDO_STUDIO_HOME = TMP_HOME;

const analyzer = require('../../sudo-ai-extension/src/analysis/projectAnalyzer');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-fx-'));
function wf(root, rel, content) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

const PUBSPEC = `name: demo
description: x
environment:
  sdk: '>=3.0.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  provider: 6.0.0
dev_dependencies:
  flutter_test:
    sdk: flutter
  mockito: ^5.4.0
flutter:
  uses-material-design: true
`;
const PUBLOCK = `packages:
  http:
    version: "1.2.1"
  provider:
    version: "6.0.0"
  mockito:
    version: "5.4.2"
`;
const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"
dependencies = [
  "requests>=2.31",
  "flask[async]==3.0.0",
]
[project.optional-dependencies]
test = ["pytest>=7"]
[tool.poetry.group.dev.dependencies]
ruff = "^0.1.0"
`;
const POETRYLOCK = `[[package]]
name = "requests"
version = "2.31.0"
[[package]]
name = "flask"
version = "3.0.0"
`;
const GRADLE = `dependencies {
  implementation 'com.google.code.gson:gson:2.10.1'
  testImplementation 'junit:junit:4.13.2'
}
`;

function buildFixtures() {
    const F = path.join(FX, 'fx-flutter');
    wf(F, 'pubspec.yaml', PUBSPEC);
    wf(F, 'pubspec.lock', PUBLOCK);
    wf(F, 'lib/main.dart', 'void main() {}\n');
    wf(F, 'test/widget_test.dart', 'void main() {}\n');
    wf(F, 'analysis_options.yaml', 'linter:\n  rules: {}\n');
    wf(F, 'Dockerfile', 'FROM scratch\n');
    wf(F, 'docker-compose.yml', 'services: {}\n');
    wf(F, '.env', 'K=V\n');
    wf(F, '.env.local', 'K2=V2\n');
    wf(F, 'README.md', '# Demo\n');
    wf(F, '.github/workflows/ci.yml', 'name: ci\non: push\njobs:\n  b:\n    runs-on: ubuntu\n');

    const N = path.join(FX, 'fx-node');
    wf(N, 'package.json', JSON.stringify({ name: 'n', version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0', react: '^18.0.0' },
        devDependencies: { jest: '29.0.0' } }));
    wf(N, 'package-lock.json', JSON.stringify({ packages: {
        '': { dependencies: { 'left-pad': '1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/jest': { version: '29.0.0' } } }));
    wf(N, 'src/index.js', 'console.log(1);\n');

    const PY = path.join(FX, 'fx-pyproj');
    wf(PY, 'pyproject.toml', PYPROJECT);
    wf(PY, 'poetry.lock', POETRYLOCK);
    wf(PY, 'main.py', 'print(1)\n');

    const RQ = path.join(FX, 'fx-req');
    wf(RQ, 'requirements.txt', 'requests==2.31.0\nflask>=3.0\n');
    wf(RQ, 'main.py', 'print(1)\n');

    const M = path.join(FX, 'fx-pom');
    wf(M, 'pom.xml', '<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></project>\n');

    const G = path.join(FX, 'fx-gradle');
    wf(G, 'build.gradle', GRADLE);

    const GO = path.join(FX, 'fx-go');
    wf(GO, 'go.mod', 'module example.com/m\n\ngo 1.21\n\nrequire example.com/dep v1.2.3\n');
    wf(GO, 'go.sum', 'example.com/dep v1.2.3 h1:abc=\n');
    wf(GO, 'main.go', 'package main\nfunc main() {}\n');

    const C = path.join(FX, 'fx-cs');
    wf(C, 'app.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>\n');
    wf(C, 'packages.lock.json', JSON.stringify({ dependencies: { 'net8.0': {
        'Newtonsoft.Json': { resolved: '13.0.3' } } } }));

    const E = path.join(FX, 'fx-empty');
    wf(E, 'notes.txt', 'nothing here\n');

    const NG = path.join(FX, 'fx-nogit');
    wf(NG, 'notes.txt', 'no git here\n');

    const B = path.join(FX, 'fx-bare');
    wf(B, 'notes.txt', 'bare\n');

    const GR = path.join(FX, 'fx-git');
    wf(GR, 'README.md', '# G\n');
    wf(GR, 'main.py', 'print(1)\n');
    return { F, N, PY, RQ, M, G, GO, C, E, NG, B, GR };
}

function gitGone() {
    const r = spawnSync('git', ['--version']);
    return r.status !== 0;
}

function initGitRepo(dir) {
    const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    let r = run(['init']);
    assert.strictEqual(r.status, 0, 'git init failed');
    run(['config', 'user.email', 'p22@test']);
    run(['config', 'user.name', 'p22']);
    run(['add', '.']);
    r = run(['commit', '-m', 'init']);
    assert.strictEqual(r.status, 0, 'git commit failed: ' + (r.stderr || ''));
    fs.appendFileSync(path.join(dir, 'main.py'), 'print(2)\n');
    wf(dir, 'untracked.txt', 'ignored by status count\n');
    const br = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return String(br.stdout || '').trim();
}

// Panel harness (same mock pattern as P9).
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
async function runPanel(dir) {
    vscodeMock.workspace.workspaceFolders = dir ? [{ uri: { fsPath: dir } }] : [];
    const fp = fakePanel();
    const p = new ProjectAnalysisPanel(fp, null);
    try { clearTimeout(p._analysisTimeout); } catch (_) {}
    await p.analyzeProject();
    const res = fp.webview.posted.find((m) => m.type === 'analysisResult');
    return { p, fp, res };
}

async function main() {
    const fx = buildFixtures();
    assert.ok(pass >= 0, 'suite ran');

    // -- A: flutter records -------------------------------------------------
    const repF = await analyzer.analyzeProject(fx.F);
    const fDeps = repF.deps.find((d) => d.ecosystem === 'flutter');
    check('A1: flutter 5 declarations (3 prod + 2 dev)',
        fDeps.manifestDeps.length === 5, String(fDeps.manifestDeps.length));
    const prod = fDeps.manifestDeps.filter((d) => !d.dev).map((d) => d.name).sort().join(',');
    const dev = fDeps.manifestDeps.filter((d) => d.dev).map((d) => d.name).sort().join(',');
    check('A2: prod/dev split exact', prod === 'flutter,http,provider' && dev === 'flutter_test,mockito',
        prod + ' / ' + dev);
    const http = fDeps.manifestDeps.find((d) => d.name === 'http');
    check('A3: http declared+locked+source',
        http.range === '^1.2.0' && http.locked === '1.2.1' && http.source === 'pubspec.yaml' && http.dev === false,
        JSON.stringify(http));
    const fl = fDeps.manifestDeps.find((d) => d.name === 'flutter');
    check('A4: nested sdk captured as detail, unlocked',
        fl.range === '' && fl.detail === 'sdk: flutter' && fl.locked === null, JSON.stringify(fl));
    const mo = fDeps.manifestDeps.find((d) => d.name === 'mockito');
    check('A5: dev dep locked from pubspec.lock',
        mo.dev === true && mo.locked === '5.4.2' && mo.range === '^5.4.0', JSON.stringify(mo));
    check('A6: unlocked = flutter,flutter_test',
        fDeps.unlocked.sort().join(',') === 'flutter,flutter_test', fDeps.unlocked.join(','));
    check('A7: unpinned = http,mockito (provider exact, sdk excluded)',
        fDeps.unpinned.sort().join(',') === 'http,mockito', fDeps.unpinned.join(','));

    // -- B: node records ------------------------------------------------------
    const repN = await analyzer.analyzeProject(fx.N);
    const nDeps = repN.deps.find((d) => d.ecosystem === 'node');
    check('B1: node 3 records with dev flags',
        nDeps.manifestDeps.length === 3 &&
        nDeps.manifestDeps.filter((d) => d.dev).map((d) => d.name).join(',') === 'jest');
    const lp = nDeps.manifestDeps.find((d) => d.name === 'left-pad');
    const jt = nDeps.manifestDeps.find((d) => d.name === 'jest');
    const rc = nDeps.manifestDeps.find((d) => d.name === 'react');
    check('B2: left-pad prod locked, jest dev locked',
        lp.dev === false && lp.locked === '1.3.0' && jt.dev === true && jt.locked === '29.0.0' &&
        lp.source === 'package.json' && jt.source === 'package.json');
    check('B3: react unlocked (locked null)', rc.locked === null && rc.dev === false);

    // -- C: pyproject -----------------------------------------------------------
    const repPY = await analyzer.analyzeProject(fx.PY);
    const pyDeps = repPY.deps.find((d) => d.ecosystem === 'python');
    check('C1: pyproject 4 records', pyDeps.manifestDeps.length === 4,
        JSON.stringify(pyDeps.manifestDeps.map((d) => d.name)));
    const rq = pyDeps.manifestDeps.find((d) => d.name === 'requests');
    const fl2 = pyDeps.manifestDeps.find((d) => d.name === 'flask');
    const pt = pyDeps.manifestDeps.find((d) => d.name === 'pytest');
    const rf = pyDeps.manifestDeps.find((d) => d.name === 'ruff');
    check('C2: pytest+ruff dev, requests+flask prod',
        pt.dev === true && rf.dev === true && rq.dev === false && fl2.dev === false);
    check('C3: flask extras stripped, exact pin locked',
        fl2.range === '==3.0.0' && fl2.locked === '3.0.0' && fl2.source === 'pyproject.toml',
        JSON.stringify(fl2));
    check('C4: requests range kept, locked from poetry.lock',
        rq.range === '>=2.31' && rq.locked === '2.31.0', JSON.stringify(rq));

    // -- D: other ecosystems -----------------------------------------------------
    const repRQ = await analyzer.analyzeProject(fx.RQ);
    const rqDeps = repRQ.deps.find((d) => d.ecosystem === 'python');
    check('D1: requirements regression (2, prod, sourced)',
        rqDeps.manifestDeps.length === 2 &&
        rqDeps.manifestDeps.every((d) => d.dev === false && d.source === 'requirements.txt'));
    const repM = await analyzer.analyzeProject(fx.M);
    const mDeps = repM.deps.find((d) => d.ecosystem === 'java-maven');
    check('D2: pom record (junit:junit, no lock)',
        mDeps.manifestDeps.length === 1 && mDeps.manifestDeps[0].name === 'junit:junit' &&
        mDeps.manifestDeps[0].locked === null && mDeps.manifestDeps[0].source === 'pom.xml');
    const repG = await analyzer.analyzeProject(fx.G);
    const gDeps = repG.deps.find((d) => d.ecosystem === 'java-gradle');
    const gson = gDeps.manifestDeps.find((d) => d.name === 'com.google.code.gson:gson');
    const jun = gDeps.manifestDeps.find((d) => d.name === 'junit:junit');
    check('D3: gradle test scope is dev, impl is prod',
        gson.dev === false && gson.configuration === 'implementation' &&
        jun.dev === true && jun.configuration === 'testImplementation' &&
        gson.source === 'build.gradle');
    const repGO = await analyzer.analyzeProject(fx.GO);
    const goDeps = repGO.deps.find((d) => d.ecosystem === 'go');
    check('D4: go locked from go.sum',
        goDeps.manifestDeps.length === 1 && goDeps.manifestDeps[0].locked === 'v1.2.3' &&
        goDeps.manifestDeps[0].source === 'go.mod');
    const repC = await analyzer.analyzeProject(fx.C);
    const cDeps = repC.deps.find((d) => d.ecosystem === 'csharp');
    check('D5: csharp locked + csproj source',
        cDeps.manifestDeps.length === 1 && cDeps.manifestDeps[0].locked === '13.0.3' &&
        cDeps.manifestDeps[0].source === 'app.csproj');

    // -- E: no manifest ------------------------------------------------------------
    const repE = await analyzer.analyzeProject(fx.E);
    check('E1: no manifest means no deps', repE.deps.length === 0);

    // -- F: panel dep counts ---------------------------------------------------------
    const pf = await runPanel(fx.F);
    check('F1: flutter panel counts 3 deps / 2 devDeps (never 0/0)',
        pf.res.result.metrics.depCount === 3 && pf.res.result.metrics.devDepCount === 2,
        JSON.stringify(pf.res.result.metrics));
    check('F2: flutter name lists carried',
        pf.res.result.deps.indexOf('http') !== -1 &&
        pf.res.result.devDeps.indexOf('mockito') !== -1);
    const pn = await runPanel(fx.N);
    check('F3: node panel counts unchanged (2/1)',
        pn.res.result.metrics.depCount === 2 && pn.res.result.metrics.devDepCount === 1);
    const pe = await runPanel(fx.E);
    check('F4: empty panel counts 0/0',
        pe.res.result.metrics.depCount === 0 && pe.res.result.metrics.devDepCount === 0);

    // -- G: git states ----------------------------------------------------------------
    if (gitGone()) {
        check('G0: git available for fixtures', false, 'git not found');
    } else {
        const branch = initGitRepo(fx.GR);
        const pg = await runPanel(fx.GR);
        const g = pg.res.result.architecture.hasGit;
        check('G1: git ok cites branch + dirty count',
            g.state === 'ok' && g.evidence.indexOf(branch) !== -1 &&
            g.evidence.indexOf('1 modifie(s)') !== -1, JSON.stringify(g));
    }
    const png = await runPanel(fx.NG);
    const ng = png.res.result.architecture.hasGit;
    check('G2: no repo is missing with command evidence',
        ng.state === 'missing' && ng.evidence.indexOf('rev-parse') !== -1, JSON.stringify(ng));
    const savedPath = process.env.PATH;
    try {
        process.env.PATH = '';
        const pun = await runPanel(fx.NG);
        const un = pun.res.result.architecture.hasGit;
        check('G3: git binary missing is unverified (reason)',
            un.state === 'unverified' && un.evidence.length > 0, JSON.stringify(un));
    } finally {
        process.env.PATH = savedPath;
    }

    // -- H: arch evidence ----------------------------------------------------------------
    const aF = pf.res.result.architecture;
    check('H1: docker ok cites files',
        aF.hasDocker.state === 'ok' && aF.hasDocker.evidence.indexOf('Dockerfile') !== -1 &&
        aF.hasDocker.evidence.indexOf('docker-compose.yml') !== -1, JSON.stringify(aF.hasDocker));
    check('H2: lint ok cites analysis_options.yaml',
        aF.hasLint.state === 'ok' && aF.hasLint.evidence.indexOf('analysis_options.yaml') !== -1);
    check('H3: tests/ci/env/readme ok with evidence',
        aF.hasTests.state === 'ok' && aF.hasTests.evidence.indexOf('1 fichier') !== -1 &&
        aF.hasCI.state === 'ok' && aF.hasCI.evidence.indexOf('github-actions') !== -1 &&
        aF.hasEnv.state === 'ok' && aF.hasEnv.evidence.indexOf('.env.local') !== -1 &&
        aF.hasReadme.state === 'ok' && aF.hasReadme.evidence.indexOf('README.md') !== -1);
    const pb = await runPanel(fx.B);
    const aB = pb.res.result.architecture;
    const keys = ['hasDocker', 'hasCI', 'hasTests', 'hasGit', 'hasLint', 'hasFormat', 'hasEnv', 'hasReadme', 'hasDocs'];
    check('H4: bare project misses everything, each with evidence',
        keys.every((k) => aB[k].state === 'missing' && (aB[k].evidence || '').length > 5),
        JSON.stringify(aB));
    const dockerIssueB = pb.res.result.issues.some((i) => i.area === 'Docker');
    const dockerIssueF = pf.res.result.issues.some((i) => i.area === 'Docker');
    check('H5: Docker issue only when really missing',
        dockerIssueB === true && dockerIssueF === false);

    // -- I: client render -------------------------------------------------------------------
    const html = ProjectAnalysisPanel.prototype.getHtmlContent.call({});
    const clientJs = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const clientFile = path.join(FX, 'client-extract.js');
    fs.writeFileSync(clientFile, clientJs);
    const chk = spawnSync(process.execPath, ['--check', clientFile]);
    check('I1: panel client script compiles', chk.status === 0);
    check('I2: unverified state rendered',
        clientJs.indexOf('arch-unver') !== -1 && clientJs.indexOf('non verifie') !== -1);
    check('I3: per-dep table headers rendered',
        clientJs.indexOf('verrouillee') !== -1 && clientJs.indexOf('<table') !== -1);
    check('I4: explicit no-manifest message',
        clientJs.indexOf('Aucun manifeste trouve') !== -1);
}

main().then(() => {
    console.log(fail === 0 ? `\nP22: ${pass} checks passed (all green)`
        : `\nP22: ${pass} passed, ${fail} FAILED`);
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
