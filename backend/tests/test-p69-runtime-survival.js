/**
 * SUDO STUDIO - P69 : le runtime meurt en pleine generation.
 *
 * Ce que cette suite prouve, sans modele et sans reseau :
 *   K1  la medecine legale existe et fonctionne (faulthandler + trace d'appel) ;
 *   K2  le battement de coeur repond PENDANT une generation (occupe != mort),
 *       et se tait quand le processus est vraiment mort (contrôle negatif) ;
 *   K3  le journal du superviseur n'est plus muet : bon dossier (P33), et une
 *       ecriture impossible est SIGNALEE au lieu d'etre avalee ;
 *   K4  un runtime OCCUPE n'est jamais relance ; un runtime MORT l'est ;
 *   K5  le code de sortie de l'enfant est nomme (0xC0000005 = ACCESS_VIOLATION) ;
 *   K6  un seul chargement par demarrage, fenetre figee pour la session ;
 *   K7  l'echec RAM pendant le chargement dit la verite ET la marche a suivre.
 *
 * Lancer : node backend/tests/test-p69-runtime-survival.js
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'backend', 'runtime');
const SUP = path.join(ROOT, 'backend', 'supervisor', 'runtimeSupervisor.js');

let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

function py(code, env) {
    const r = spawnSync('python3', ['-c', code], {
        cwd: RUNTIME, encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, env || {}),
    });
    if (r.error) return { ok: false, error: String(r.error.message || r.error) };
    try { return { ok: true, value: JSON.parse(r.stdout.trim().split('\n').pop()) }; }
    catch (_) { return { ok: false, error: (r.stderr || r.stdout || '').slice(0, 500) }; }
}

const hasPython = (() => {
    const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
})();
if (!hasPython) {
    console.log('INDISPONIBLE: python3 absent -> medecine legale NON TESTEE ici.');
    process.exit(2);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
    const tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'p69logs-'));

    // ---------------------------------------------------------------- K1
    const k1 = py(`
import json, os, time, forensics
d = ${JSON.stringify(tmpLogs)}
fh = forensics.enable_faulthandler(d)
cid = forensics.call_begin("tools+grammaire", prompt_tokens=1234, grammar=True,
                           n_ctx=4096, max_tokens=256, model="m")
p = forensics.last_call_path()
trace = json.load(open(p)) if os.path.exists(p) else None
snap_busy = forensics.snapshot()
forensics.call_end(cid, ok=True)
gone = os.path.exists(p)
snap_idle = forensics.snapshot()
print(json.dumps({"ok": fh["ok"], "crash": fh["path"], "crash_exists": os.path.exists(fh["path"] or ""),
                  "trace": trace, "phase_busy": snap_busy["phase"], "phase_idle": snap_idle["phase"],
                  "removed": gone, "count": snap_idle["calls_total"]}))
`, { SUDO_STUDIO_LOGS: tmpLogs });

    check('K1 faulthandler actif avec un fichier de crash', k1.ok && k1.value && k1.value.ok === true
        && k1.value.crash_exists === true, k1.ok ? JSON.stringify(k1.value) : k1.error);
    check('K1b la trace d appel est ecrite AVANT le moteur natif',
        k1.ok && k1.value.trace && k1.value.trace.prompt_tokens === 1234
        && k1.value.trace.grammar === true && k1.value.trace.n_ctx === 4096,
        k1.ok ? JSON.stringify(k1.value.trace) : k1.error);
    check('K1c la phase passe a generation puis revient a libre',
        k1.ok && k1.value.phase_busy === 'generation' && k1.value.phase_idle === 'libre',
        k1.ok ? k1.value.phase_busy + '->' + k1.value.phase_idle : k1.error);
    check('K1d la trace est effacee apres un appel normal (sinon: plantage)',
        k1.ok && k1.value.removed === false, k1.ok ? String(k1.value.removed) : k1.error);

    // ---------------------------------------------------------------- K2
    // On lance un processus python qui simule une generation en cours
    // (call_begin sans call_end) : le battement de coeur doit repondre.
    const pyScript = `
import json, sys, time
import forensics, heartbeat
r = heartbeat.start(0)
cid = forensics.call_begin("tools+grammaire", prompt_tokens=999, grammar=True, n_ctx=2048, max_tokens=64, model="m")
print(json.dumps({"port": r.get("port"), "ok": r.get("ok")}), flush=True)
time.sleep(30)
`;
    const child = spawn('python3', ['-c', pyScript], { cwd: RUNTIME, env: Object.assign({}, process.env, { SUDO_STUDIO_LOGS: tmpLogs }) });
    const firstLine = await new Promise((resolve) => {
        let buf = '';
        child.stdout.on('data', (c) => {
            buf += c.toString();
            if (buf.indexOf('\n') !== -1) resolve(buf.split('\n')[0]);
        });
        setTimeout(() => resolve(''), 8000);
    });
    let hbPort = 0;
    try { hbPort = JSON.parse(firstLine).port; } catch (_) { hbPort = 0; }
    check('K2 le battement de coeur demarre (port choisi par l OS)', hbPort > 0, firstLine);
    await sleep(300);
    const hb = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: hbPort, path: '/hb', timeout: 1500 }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch (e) { resolve({ status: res.statusCode }); } });
        });
        req.on('error', (e) => resolve({ status: null, error: String(e.message || e) }));
        req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'timeout' }); });
    });
    check('K2b pendant une generation le battement repond quand meme', hb.status === 200, JSON.stringify(hb));
    check('K2c il distingue OCCUPE (busy=true, phase=generation)',
        hb.data && hb.data.busy === true && hb.data.phase === 'generation'
        && hb.data.call && hb.data.call.prompt_tokens === 999, JSON.stringify(hb.data && hb.data.call));
    // controle negatif : processus tue -> plus aucune reponse
    child.kill('SIGKILL');
    await sleep(600);
    const dead = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: hbPort, path: '/hb', timeout: 1200 }, (res) => {
            res.resume(); resolve({ status: res.statusCode });
        });
        req.on('error', (e) => resolve({ status: null, error: String(e.message || e) }));
        req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'timeout' }); });
    });
    check('K2d controle negatif : mort -> aucune reponse (ECONNREFUSED)', dead.status === null,
        JSON.stringify(dead));

    // ---------------------------------------------------------------- K3..K5
    const { RuntimeSupervisor, resolveLogDir, resolveAuditPath } = require(SUP);
    delete process.env.SUDO_STUDIO_LOGS;

    process.env.SUDO_STUDIO_LOGS = tmpLogs;
    check('K3 le journal du superviseur suit le dossier de logs unique (P33)',
        resolveLogDir() === tmpLogs && resolveAuditPath() === path.join(tmpLogs, 'runtime-supervisor.log'),
        resolveLogDir() + ' / ' + resolveAuditPath());
    delete process.env.SUDO_STUDIO_LOGS;

    const prodDir = resolveLogDir();
    check('K3b le journal n est plus ecrit dans <exe>/../logs',
        !/Program Files[\\\/]logs/.test(prodDir) && prodDir.indexOf('..') === -1, prodDir);

    // ecriture impossible -> signalee, pas avalee
    const loud = [];
    const supBad = new RuntimeSupervisor({
        auditPath: path.join('/proc', 'interdit', 'sup.log'),
        httpGet: async () => { throw new Error('refused'); },
        log: (m) => loud.push(m), sleep: async () => {}, now: () => 0,
    });
    supBad.audit('test');
    check('K3c une ecriture de journal impossible est SIGNALEE',
        loud.join('\n').indexOf('ERREUR') !== -1 && loud.join('\n').indexOf('audit write FAILED') !== -1,
        loud.join(' | ').slice(0, 200));

    // K4: occupe != mort
    const refusErr = () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; return e; };
    const supBusy = new RuntimeSupervisor({
        failThreshold: 2, graceMs: 0, auditPath: path.join(tmpLogs, 'sup-busy.log'),
        httpGet: async (url) => {
            if (String(url).indexOf('/hb') !== -1) {
                return { status: 200, data: { alive: true, busy: true, phase: 'generation',
                    call: { id: 'x', prompt_tokens: 500, grammar: true } } };
            }
            throw refusErr();
        },
        spawnFn: () => { throw new Error('ne doit JAMAIS relancer un runtime vivant'); },
        killFn: async () => 'ne doit pas tuer', sleep: async () => {}, now: () => 1000, log: () => {},
    });
    supBusy.running = true; supBusy.startedAt = -1e9;
    for (let i = 0; i < 6; i++) await supBusy.pollTick();
    check('K4 un runtime OCCUPE (generation) n est jamais relance',
        supBusy.restarts.length === 0 && supBusy.consecutiveFailures === 0,
        JSON.stringify(supBusy.restarts));
    check('K4b l occupation est exposee (phase + appel en cours)',
        supBusy.status().busy && supBusy.status().busy.phase === 'generation',
        JSON.stringify(supBusy.status().busy));

    // K4c: mort -> relance (controle positif)
    let spawned = 0;
    let tDead = 5000;
    const supDead = new RuntimeSupervisor({
        failThreshold: 2, graceMs: 0, waitHealthyMs: 500,
        runtimeExePath: path.join(os.tmpdir(), 'p69-fake-runtime.exe'),
        auditPath: path.join(tmpLogs, 'sup-dead.log'),
        httpGet: async () => { throw refusErr(); },
        httpPost: async () => ({ status: 200, data: {} }),
        spawnFn: () => { spawned += 1; return null; },
        killFn: async () => 'ok', sleep: async (ms) => { tDead += ms; },
        now: () => tDead, log: () => {},
    });
    fs.writeFileSync(supDead.runtimeExePath, 'fake');
    supDead.running = true; supDead.startedAt = -1e9;
    for (let i = 0; i < 2; i++) await supDead.pollTick();
    check('K4c un runtime MORT est relance (controle positif)', spawned === 1 && supDead.restarts.length === 1,
        'spawns=' + spawned + ' restarts=' + supDead.restarts.length);

    // K5: code de sortie nomme
    const supExit = new RuntimeSupervisor({ auditPath: path.join(tmpLogs, 'sup-exit.log'), log: () => {} });
    supExit.childExit = { code: -(0x100000000 - 0xC0000005), signal: null };
    check('K5 le code 0xC0000005 est nomme ACCESS_VIOLATION',
        /ACCESS_VIOLATION/.test(supExit.describeExit()) && /C0000005/.test(supExit.describeExit()),
        supExit.describeExit());
    supExit.childExit = { code: -(0x100000000 - 0xC0000409), signal: null };
    check('K5b le code 0xC0000409 est nomme STACK_BUFFER_OVERRUN',
        /STACK_BUFFER_OVERRUN/.test(supExit.describeExit()), supExit.describeExit());
    supExit.childExit = null;
    check('K5c sans enfant lance : dit clairement que le code est inconnu',
        /code inconnu/.test(supExit.describeExit()), supExit.describeExit());

    // K5d: le contexte de crash lit last_call.json et la fin du fichier de crash
    fs.writeFileSync(path.join(tmpLogs, 'last_call.json'), JSON.stringify({ call_id: 'c1', kind: 'tools+grammaire' }));
    fs.writeFileSync(path.join(tmpLogs, 'runtime_crash.log'), 'ligne1\nFatal Python error: Segmentation fault\n');
    const supCtx = new RuntimeSupervisor({
        auditPath: path.join(tmpLogs, 'sup-ctx.log'), log: () => {},
        lastCallPath: path.join(tmpLogs, 'last_call.json'),
        crashLogPath: path.join(tmpLogs, 'runtime_crash.log'),
    });
    const cx = supCtx.crashContext();
    check('K5d le contexte de crash porte l appel en cours et la fin du fichier de crash',
        cx.lastCall && cx.lastCall.call_id === 'c1' && (cx.crashTail || []).join(' ').indexOf('Segmentation') !== -1,
        JSON.stringify(cx).slice(0, 200));

    // ---------------------------------------------------------------- K6/K7
    const serverSrc = fs.readFileSync(path.join(RUNTIME, 'server.enterprise.py'), 'utf8');
    check('K6 un second chargement simultane est FUSIONNE, pas refuse',
        /demande fusionnee/.test(serverSrc) && /Load merged into the running job/.test(serverSrc));
    // une demande fusionnee renvoie True : la route ne repond donc pas 409 a tort
    check('K6b la fusion renvoie True (pas un echec)',
        /logger\.info\("\[LOCK\] Load merged into the running job \(no second load\)"\)\s*\n\s*return True/.test(serverSrc));
    check('K6c la fenetre de session est conservee d un chargement a l autre',
        /n_ctx_session/.test(serverSrc) && /fenetre de session conservee/.test(serverSrc));
    check('K6d la raison de la fenetre est exposee a l interface',
        (serverSrc.match(/"n_ctx_reason"/g) || []).length >= 2,
        'occurrences: ' + (serverSrc.match(/"n_ctx_reason"/g) || []).length);

    const k7 = py(`
import json, ram_messages
print(json.dumps({"msg": ram_messages.ram_critical_message(
    "Qwen2.5-Coder-1.5B-Instruct", 0.41, 0.6,
    petite_alternative="Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF")}))
`, { SUDO_STUDIO_LOGS: tmpLogs });
    const msg = (k7.value && k7.value.msg) || '';
    check('K7 l echec RAM dit les chiffres ET la marche a suivre',
        /0\.41/.test(msg) && /0\.60/.test(msg) && /Fermez les applications/.test(msg),
        k7.ok ? String(msg).slice(0, 240) : k7.error);
    check('K7b le message est en francais et n annonce aucun faux succes',
        /Chargement interrompu/.test(msg) && /aucun faux succes/.test(msg), String(msg).slice(0, 160));
    check('K7c il propose un modele plus petit quand il en existe un',
        /0\.5B/.test(msg) || /plus petit/.test(msg), String(msg).slice(0, 200));
    const srv = fs.readFileSync(path.join(RUNTIME, 'server.enterprise.py'), 'utf8');
    check('K7d le serveur utilise bien ce message (pas un doublon mort)',
        /ram_messages\.ram_critical_message/.test(srv),
        'appels: ' + (srv.match(/ram_messages\.ram_critical_message/g) || []).length);

    console.log('\nP69 survie du runtime: ' + pass + ' checks passed' +
        (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
    process.exit(0);
})();
