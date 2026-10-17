/**
 * SUDO STUDIO - PROMPT 23 suite: shipped advisory DB + offline update.
 * A: hermetic OSV build (crafted zips, per-eco counts) | B: severity mapping |
 * C: conversion policy (withdrawn/MAL/GIT/versions/unbounded/dupe) |
 * D: 7-eco match proof (vuln detected, fixed silent) | E: comparators |
 * F: lockfile parsers | G: coverage | H: 90-day staleness |
 * I: sign/verify/import policy | J: advisorySig units | K: CVSS v3 units.
 * Hermetic: crafted zips via minizip, temp dirs, no network. ASCII-only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'backend', 'tools', 'build-advisory-db.js');
const L = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'utils', 'localAudit.js'));
const SIG = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'utils', 'advisorySig.js'));
const MZ = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'utils', 'minizip.js'));

const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-fx-'));
function wf(rel, content) {
    const full = path.join(FX, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function runNode(args) {
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

// -- crafted OSV records (one zips dir, 7 ecosystem dumps) --------------------
function rec(id, o) {
    const r = { id, summary: o.summary || ('test ' + id), details: 'details ' + id,
        aliases: o.aliases || [], affected: o.affected || [] };
    if (o.withdrawn) r.withdrawn = o.withdrawn;
    if (o.dsSev) r.database_specific = { severity: o.dsSev };
    if (o.sev) r.severity = o.sev;
    return r;
}
function aff(pkg, eco, ranges, versions) {
    const a = { package: { name: pkg, ecosystem: eco } };
    if (ranges) a.ranges = ranges;
    if (versions) a.versions = versions;
    return a;
}
function rng(type, events) { return { type, events }; }

const V32 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'; // 9.8 critical
const V40 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';

function fixtureZips() {
    const zips = {};
    zips['npm-all.zip'] = [
        rec('GHSA-test-npm1', { dsSev: 'HIGH', aliases: ['CVE-2026-00001'],
            affected: [aff('leftpad-test', 'npm', [rng('ECOSYSTEM', [{ introduced: '0' }, { fixed: '2.0.0' }])])] }),
        rec('GHSA-test-wd', { withdrawn: '2026-01-01',
            affected: [aff('ghost', 'npm', [rng('ECOSYSTEM', [{ introduced: '0' }, { fixed: '9.9.9' }])])] }),
        rec('MAL-2026-1', { affected: [aff('evil', 'npm', [rng('ECOSYSTEM', [{ introduced: '0' }])])] }),
        rec('GHSA-test-git', { dsSev: 'LOW',
            affected: [aff('gitonly', 'npm', [rng('GIT', [{ introduced: 'abc' }, { fixed: 'def' }])])] }),
        rec('GHSA-test-vers', { dsSev: 'MEDIUM',
            affected: [aff('versonly', 'npm', null,
                Array.from({ length: 70 }, (_, i) => '0.0.' + (i + 1)))] }),
        rec('GHSA-test-unb', { dsSev: 'LOW',
            affected: [aff('unbound', 'npm', [rng('ECOSYSTEM', [{ introduced: '1.0' }])])] }),
        rec('GHSA-test-unb0', { dsSev: 'LOW',
            affected: [aff('eternalvuln', 'npm', [rng('ECOSYSTEM', [{ introduced: '0' }])])] }),
    ];
    zips['pypi-all.zip'] = [
        rec('PYSEC-test-1', { sev: [{ type: 'CVSS_V4', score: V40 }], aliases: ['CVE-2026-00002'],
            affected: [aff('testpkg', 'PyPI', [rng('ECOSYSTEM', [{ introduced: '1.0' }, { fixed: '1.5' }])])] }),
    ];
    zips['crates_io-all.zip'] = [
        rec('RUSTSEC-test-1', { sev: [{ type: 'CVSS_V3', score: V32 }],
            affected: [aff('testcrate', 'crates.io', [rng('ECOSYSTEM', [{ introduced: '0.1.0' }, { fixed: '0.2.0' }])])] }),
        rec('GHSA-test-dupe', { dsSev: 'LOW',
            affected: [aff('dupepkg', 'crates.io', [
                rng('ECOSYSTEM', [{ introduced: '0' }, { fixed: '9.9.9' }]),
                rng('SEMVER', [{ introduced: '0' }, { fixed: '9.9.9' }])])] }),
    ];
    zips['go-all.zip'] = [
        rec('GO-test-1', { aliases: ['CVE-2026-00004'],
            affected: [aff('example.test/mod', 'Go', [rng('SEMVER', [{ introduced: 'v0.1.0' }, { fixed: 'v0.2.0' }])])] }),
    ];
    zips['maven-all.zip'] = [
        rec('GHSA-test-mvn1', { dsSev: 'MEDIUM', aliases: ['CVE-2026-00005'],
            affected: [aff('test.group:test-art', 'Maven', [rng('ECOSYSTEM', [{ introduced: '1.0' }, { fixed: '1.2' }])])] }),
    ];
    zips['nuget-all.zip'] = [
        rec('GHSA-test-nug1', { dsSev: 'LOW', aliases: ['CVE-2026-00006'],
            affected: [aff('Test.Package', 'NuGet', [rng('ECOSYSTEM', [{ introduced: '3.0.0' }, { fixed: '3.0.1' }])])] }),
    ];
    zips['pub-all.zip'] = [
        rec('GHSA-test-pub1', { dsSev: 'CRITICAL', aliases: ['CVE-2026-00007'],
            affected: [aff('testpkg_pub', 'Pub', [rng('ECOSYSTEM', [{ introduced: '0' }, { fixed: '1.0.0' }])])] }),
    ];
    for (const [file, recs] of Object.entries(zips)) {
        const entries = recs.map((r) => ({ name: r.id + '.json', data: Buffer.from(JSON.stringify(r), 'utf8') }));
        wf('zips/' + file, MZ.writeZip(entries));
    }
}

function main() {
    fixtureZips();
    const dbPath = path.join(FX, 'db.json');

    // -- A: hermetic build ----------------------------------------------------
    const b = runNode([BUILDER, 'build', '--out', dbPath, '--date', '2026-10-17', '--zip-dir', path.join(FX, 'zips')]);
    check('A1: builder exits 0', b.status === 0, (b.stderr || '').slice(0, 200));
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const perEco = {};
    for (const a of db.advisories) perEco[a.ecosystem] = (perEco[a.ecosystem] || 0) + 1;
    check('A2: per-eco entry counts', perEco.npm === 67 && perEco.pip === 1 && perEco.crates === 2 &&
        perEco.go === 1 && perEco.maven === 1 && perEco.nuget === 1 && perEco.pub === 1, JSON.stringify(perEco));
    check('A3: total 74 entries + date + format + sources', db.advisories.length === 74 &&
        db.generatedAt === '2026-10-17' && db.format === 2 && !!db.sources && !!db.stats);
    const st = db.stats;
    check('A4: policy counters', st.npm.withdrawn === 1 && st.npm.malware === 1 && st.npm.gitRanges === 1 &&
        st.npm.versionsOnly === 1 && st.npm.versionsTruncated === 6 && st.npm.unbounded === 1 &&
        st.crates.deduped === 1, JSON.stringify({ n: st.npm, c: st.crates }));
    check('A5: report line carries size+counts', /entries: 74/.test(b.stdout) && /size: \d+ bytes/.test(b.stdout) &&
        /severity sources:/.test(b.stdout));
    const byId = {};
    for (const a of db.advisories) (byId[a.id] = byId[a.id] || []).push(a);

    // -- B: severity mapping --------------------------------------------------
    check('B1: db_specific HIGH wins', byId['GHSA-test-npm1'][0].severity === 'high');
    check('B2: CVSS v3 9.8 vector -> critical', byId['RUSTSEC-test-1'][0].severity === 'critical');
    check('B3: v4-only -> unknown (honest)', byId['PYSEC-test-1'][0].severity === 'unknown');
    check('B4: no severity anywhere -> unknown (GO-style)', byId['GO-test-1'][0].severity === 'unknown');
    check('B5: entry keeps id/cve/ranges/fixed/summary', ['GHSA-test-mvn1', 'GHSA-test-nug1', 'GHSA-test-pub1'].every((id) => {
        const e = byId[id][0];
        return e.cve.indexOf('CVE-2026-') === 0 && e.vulnerable.indexOf('<') !== -1 &&
            e.fixedIn !== 'n/a' && e.summary.length > 0 && e.package.length > 0;
    }));
    check('B6: missing CVE alias -> n/a, not invented', byId['RUSTSEC-test-1'][0].cve === 'n/a');

    // -- C: conversion policy -------------------------------------------------
    check('C1: withdrawn + MAL excluded', !byId['GHSA-test-wd'] && !byId['MAL-2026-1']);
    check('C2: GIT-only range -> no entry', !byId['GHSA-test-git']);
    check('C3: versions-only capped at 64', byId['GHSA-test-vers'].length === 64 &&
        byId['GHSA-test-vers'][0].vulnerable === '=0.0.1' && byId['GHSA-test-vers'][0].fixedIn === 'n/a');
    check('C4: unbounded range kept open', byId['GHSA-test-unb'][0].vulnerable === '>=1.0' &&
        byId['GHSA-test-unb'][0].fixedIn === 'n/a');
    check('C5: identical SEMVER+ECOSYSTEM ranges deduped', byId['GHSA-test-dupe'].length === 1);
    check('C6: introduced-0 without fixed means every version', byId['GHSA-test-unb0'][0].vulnerable === '>=0' &&
        byId['GHSA-test-unb0'][0].fixedIn === 'n/a');

    // -- D: 7-eco match proof -------------------------------------------------
    const vulnWs = path.join(FX, 'ws-vuln'), fixedWs = path.join(FX, 'ws-fixed');
    fs.mkdirSync(vulnWs, { recursive: true }); fs.mkdirSync(fixedWs, { recursive: true });
    const V = { npm: '1.9.9', pip: '1.4', crates: '0.1.5', go: 'v0.1.9', maven: '1.1', nuget: '3.0.0', pub: '0.9.0' };
    const F = { npm: '2.0.0', pip: '1.5', crates: '0.2.0', go: 'v0.2.0', maven: '1.2', nuget: '3.0.1', pub: '1.0.0' };
    for (const [dir, M] of [[vulnWs, V], [fixedWs, F]]) {
        fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: {
            'node_modules/leftpad-test': { version: M.npm },
            'node_modules/versonly': { version: M.npm === V.npm ? '0.0.3' : '9.9.9' },
            'node_modules/unbound': { version: M.npm === V.npm ? '5.0.0' : '0.5' } } }));
        fs.writeFileSync(path.join(dir, 'requirements.txt'), 'testpkg==' + M.pip + '\n');
        fs.writeFileSync(path.join(dir, 'Cargo.lock'), '[[package]]\nname = "testcrate"\nversion = "' + M.crates + '"\n');
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module x.test/y\n\ngo 1.21\n\nrequire example.test/mod ' + M.go + '\n');
        fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><dependencies><dependency><groupId>test.group</groupId>' +
            '<artifactId>test-art</artifactId><version>' + M.maven + '</version></dependency></dependencies></project>');
        fs.writeFileSync(path.join(dir, 'packages.lock.json'), JSON.stringify({ version: 1,
            dependencies: { net8_0: { 'Test.Package': { resolved: M.nuget } } } }));
        fs.writeFileSync(path.join(dir, 'pubspec.lock'), 'packages:\n  testpkg_pub:\n    version: "' + M.pub + '"\n');
    }
    const pkgsV = L.collectPackages(vulnWs), mV = L.matchAdvisories(pkgsV, db);
    check('D1: vuln ws scans 9 packages over 7 ecos', pkgsV.length === 9 &&
        new Set(pkgsV.map((p) => p.ecosystem)).size === 7, String(pkgsV.length));
    const expect = [
        ['npm', 'GHSA-test-npm1', 'high', '2.0.0', 'CVE-2026-00001'],
        ['pip', 'PYSEC-test-1', 'unknown', '1.5', 'CVE-2026-00002'],
        ['crates', 'RUSTSEC-test-1', 'critical', '0.2.0', 'n/a'],
        ['go', 'GO-test-1', 'unknown', 'v0.2.0', 'CVE-2026-00004'],
        ['maven', 'GHSA-test-mvn1', 'medium', '1.2', 'CVE-2026-00005'],
        ['nuget', 'GHSA-test-nug1', 'low', '3.0.1', 'CVE-2026-00006'],
        ['pub', 'GHSA-test-pub1', 'critical', '1.0.0', 'CVE-2026-00007'],
    ];
    let dOk = true;
    for (const [eco, id, sev, fix, cve] of expect) {
        const hit = mV.find((m) => m.ecosystem === eco && m.id === id);
        if (!hit || hit.severity !== sev || hit.fixedIn !== fix || hit.cve !== cve) dOk = false;
    }
    check('D2: 1 known-vuln dep per eco detected (id+severity+fixed)', dOk);
    check('D3: bonus npm matches (versions-only + unbounded)',
        mV.some((m) => m.id === 'GHSA-test-vers') && mV.some((m) => m.id === 'GHSA-test-unb'));
    const mF = L.matchAdvisories(L.collectPackages(fixedWs), db);
    check('D4: fixed versions match NOTHING (strict, hermetic)', mF.length === 0, JSON.stringify(mF.slice(0, 2)));
    check('D5: match carries id for the report proof', mV.every((m) => typeof m.id === 'string'));

    // -- E: comparators -------------------------------------------------------
    check('E1: semver core+prerelease',
        L.compareSemver('1.2.3', '1.2.4') === -1 && L.compareSemver('1.0', '1.0.0') === 0 &&
        L.compareSemver('1.0.0-alpha', '1.0.0') === -1 && L.compareSemver('v2.1.0+x', '2.1.0') === 0 &&
        L.compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') === -1);
    check('E2: semver refuses garbage', L.compareSemver('xyz', '1.0') === null);
    check('E3: pep440 ordering (+dev-regression)',
        L.comparePep440('1.0a1', '1.0') === -1 && L.comparePep440('1.0', '1.0.0') === 0 &&
        L.comparePep440('2!0.1', '9.9') === 1 && L.comparePep440('1.0.post1', '1.0') === 1 &&
        L.comparePep440('1.0.dev1', '1.0a1') === -1 && L.comparePep440('2.0rc1', '2.0b9') === 1);
    check('E4: pep440 refuses debian-style', L.comparePep440('1.0-1ubuntu1', '1.0') === null);
    check('E5: maven qualifiers',
        L.compareMaven('1.0-SNAPSHOT', '1.0') === -1 && L.compareMaven('1.0', '1.0-sp') === -1 &&
        L.compareMaven('1.0-alpha-1', '1.0-alpha-2') === -1 && L.compareMaven('1.0', '1.0.0') === 0 &&
        L.compareMaven('2.0-rc1', '2.0') === -1);
    check('E6: ranges dispatch per eco',
        L.satisfiesRange('4.17.20', '<4.17.21', 'npm') && !L.satisfiesRange('4.17.21', '<4.17.21', 'npm') &&
        L.satisfiesRange('2.30.0', '<2.31.0', 'pip') && L.satisfiesRange('1.0-SNAPSHOT', '<1.0', 'maven') &&
        L.satisfiesRange('v0.1.9', '<v0.2.0', 'go') && L.satisfiesRange('1.0', '>=0', 'npm') &&
        !L.satisfiesRange('1.0', '', 'npm') && !L.satisfiesRange('xyz', '<2.0', 'npm'));

    // -- F: lockfile parsers --------------------------------------------------
    const px = path.join(FX, 'parse');
    fs.mkdirSync(px, { recursive: true });
    fs.writeFileSync(path.join(px, 'go.mod'), 'module x.test/y\n\ngo 1.21\n\nrequire (\n\ta.test/a v1.2.3\n\tb.test/b v0.0.0-20200101120000-abcdef123456 // indirect\n)\n\nrequire c.test/c v2.0.0\n');
    fs.writeFileSync(path.join(px, 'Cargo.lock'), '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "x"\n');
    fs.writeFileSync(path.join(px, 'pom.xml'), '<project><dependencies>' +
        '<dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.2</version></dependency>' +
        '<dependency><groupId>g</groupId><artifactId>p</artifactId><version>${v}</version></dependency>' +
        '</dependencies></project>');
    fs.writeFileSync(path.join(px, 'packages.lock.json'), JSON.stringify({ version: 1, dependencies: {
        net6_0: { 'P.A': { resolved: '1.0' }, 'P.B': {} }, net8_0: { 'p.a': { resolved: '2.0' } } } }));
    fs.writeFileSync(path.join(px, 'packages.config'), '<packages><package id="Old.P" version="4.5.6" /></packages>');
    const gm = L.parseGoMod(path.join(px, 'go.mod'));
    check('F1: go.mod block + single + pseudo', gm.length === 3 && gm[0].version === 'v1.2.3' &&
        gm[1].version === 'v0.0.0-20200101120000-abcdef123456' && gm[2].name === 'c.test/c');
    const cl = L.parseCargoLock(path.join(px, 'Cargo.lock'));
    check('F2: Cargo.lock skips version-less', cl.length === 1 && cl[0].name === 'serde' && cl[0].version === '1.0.0');
    const pom = L.parsePomXml(path.join(px, 'pom.xml'));
    check('F3: pom group:artifact, ${prop} -> null', pom.length === 2 && pom[0].name === 'g:a' &&
        pom[0].version === '1.2' && pom[1].version === null);
    const nl = L.parseNugetLock(path.join(px, 'packages.lock.json'));
    check('F4: nuget lock dedupes across frameworks', nl.length === 2 &&
        nl.some((p) => p.name === 'P.A' && p.version === '1.0') && nl.some((p) => p.version === null));
    const pc = L.parsePackagesConfig(path.join(px, 'packages.config'));
    check('F5: packages.config fallback', pc.length === 1 && pc[0].name === 'Old.P' && pc[0].version === '4.5.6');
    check('F6: missing files -> []', L.parseGoMod(path.join(px, 'nope')).length === 0 &&
        L.parsePomXml(path.join(px, 'nope')).length === 0);

    // -- G: coverage ----------------------------------------------------------
    const npmOnly = { advisories: [{ ecosystem: 'npm' }] };
    check('G1: dbEcosystems lists tags', JSON.stringify(L.dbEcosystems(db)) === JSON.stringify(
        ['crates', 'go', 'maven', 'npm', 'nuget', 'pip', 'pub']));
    const unc = L.uncoveredEcosystems(pkgsV, npmOnly);
    check('G2: scanned-but-absent ecos reported with counts', unc.length === 6 &&
        unc.every((u) => u.count >= 1) && unc[0].ecosystem === 'crates', JSON.stringify(unc));
    check('G3: full DB covers everything', L.uncoveredEcosystems(pkgsV, db).length === 0);

    // -- H: 90-day staleness --------------------------------------------------
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    check('H1: STALE_DAYS is 90', L.STALE_DAYS === 90);
    check('H2: fresh/today not stale', !L.dbIsStale(daysAgo(0)) && !L.dbIsStale(daysAgo(89)));
    check('H3: 91 days + garbage stale', L.dbIsStale(daysAgo(91)) && L.dbIsStale('garbage') && L.dbIsStale(null));

    // -- I: sign / verify / import policy (CLI round-trip) --------------------
    const kg = runNode([BUILDER, 'keygen', '--key-id', 'p23-test']);
    check('I1: keygen exits 0 with both halves', kg.status === 0 &&
        /PUBLIC_SPKI_B64=/.test(kg.stdout) && /PRIVATE_PKCS8_B64=/.test(kg.stdout));
    const pub = /PUBLIC_SPKI_B64=(\S+)/.exec(kg.stdout)[1];
    const priv = /PRIVATE_PKCS8_B64=(\S+)/.exec(kg.stdout)[1];
    wf('priv.key', priv + '\n');
    const pkgPath = path.join(FX, 'pkg.json');
    const s = runNode([BUILDER, 'sign', '--in', dbPath, '--out', pkgPath,
        '--key-file', path.join(FX, 'priv.key'), '--key-id', 'p23-test']);
    check('I2: sign exits 0 with self-check', s.status === 0 && /SIGNED /.test(s.stdout), (s.stderr || '').slice(0, 160));
    const v = runNode([BUILDER, 'verify', '--in', pkgPath, '--pubkey-b64', pub]);
    check('I3: verify accepts (explicit key)', v.status === 0 && /^VALID: /m.test(v.stdout));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.advisories[0].summary = 'forged summary';
    wf('tampered.json', JSON.stringify(tampered));
    const vt = runNode([BUILDER, 'verify', '--in', path.join(FX, 'tampered.json'), '--pubkey-b64', pub]);
    check('I4: verify refuses tampered bytes', vt.status !== 0 && /INVALID: signature invalide/.test(vt.stdout));
    const keyOpts = { publicKeySpkiB64: pub };
    check('I5: importable beats an older base', SIG.assertImportable(pkg, { generatedAt: '2020-01-01' }, keyOpts).ok);
    check('I6: older package refused', !SIG.assertImportable(pkg, { generatedAt: '2026-10-17' }, keyOpts).ok &&
        /ancien/.test(SIG.assertImportable(pkg, { generatedAt: '2027-01-01' }, keyOpts).reason));
    check('I7: unsigned package refused', !SIG.assertImportable(db, { generatedAt: '2020-01-01' }, keyOpts).ok &&
        /non signe/.test(SIG.assertImportable(db, null, keyOpts).reason));
    check('I8: embedded placeholder key refuses (pre-keygen state)',
        /invalide/.test(SIG.verifyPackage(pkg).reason));
    // NOTE: I8 evolves the day the maintainer key is embedded (like P10-A10).

    // -- J: advisorySig units -------------------------------------------------
    check('J1: shapeOk gates the shape', SIG.shapeOk(pkg) && !SIG.shapeOk(null) &&
        !SIG.shapeOk({ generatedAt: '2026-10-17' }) && !SIG.shapeOk({ generatedAt: 'nope', advisories: [] }));
    check('J2: parseDateOnly strict', SIG.parseDateOnly('2026-10-17') === Date.parse('2026-10-17T00:00:00Z') &&
        SIG.parseDateOnly('17/10/2026') === null && SIG.parseDateOnly('') === null);
    const badAlg = JSON.parse(JSON.stringify(pkg));
    badAlg.signature.alg = 'rsa';
    check('J3: unknown alg refused', !SIG.verifyPackage(badAlg, keyOpts).ok);
    const emptySig = JSON.parse(JSON.stringify(pkg));
    emptySig.signature.sig = '';
    check('J4: empty signature refused', !SIG.verifyPackage(emptySig, keyOpts).ok);
    check('J5: garbage key refused, never throws', !SIG.verifyPackage(pkg, { publicKeySpkiB64: '!!' }).ok);

    // -- K: CVSS v3 units -----------------------------------------------------
    const BLD = require(BUILDER);
    check('K1: reference 9.8 vector', BLD.cvssV3Base('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') === 9.8);
    check('K2: reference 8.1 vector', BLD.cvssV3Base('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H') === 8.1);
    check('K3: garbage + v4 + truncated -> null',
        BLD.cvssV3Base('bogus') === null && BLD.cvssV3Base(V40) === null &&
        BLD.cvssV3Base('CVSS:3.1/AV:N/AC:L') === null);
    check('K4: level bands', BLD.levelFromScore(9.8) === 'critical' && BLD.levelFromScore(7) === 'high' &&
        BLD.levelFromScore(4) === 'medium' && BLD.levelFromScore(0.5) === 'low' &&
        BLD.levelFromScore(null) === 'unknown');

    assert.ok(pass > 0, 'suite ran');
}

main();
console.log(fail === 0 ? '\nP23: ' + pass + ' checks passed (all green)'
    : '\nP23: ' + pass + ' passed, ' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
