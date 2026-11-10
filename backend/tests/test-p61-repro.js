/**
 * SUDO STUDIO - P61 partie A: REPRODUCTION des echecs E1..E5 sur le moteur
 * de l'agent tel qu'il est empaquete, avec un faux fournisseur deterministe.
 *
 * Ce fichier n'affirme rien : il MESURE et imprime. Il doit pouvoir tourner
 * tel quel sur l'ancien code (pour prouver l'echec) et sur le nouveau (pour
 * prouver la correction) : il n'utilise que l'API publique du moteur.
 *
 *   node backend/tests/test-p61-repro.js
 *
 * ASCII only. Stdlib only (no dependency).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createWorld, call, text, lastAssistant, journalLines } = require('./lib/agentHarness');

const out = [];
function line(s) { out.push(s); console.log(s); }

// P61-4: une entree n'est une EXECUTION que si elle a reellement tourne.
// already_done / corrective / skipped / denied sont des refus de l'agent :
// les compter comme des executions ferait dire au rapport le contraire de ce
// que les codes prouvent.
const NON_EXEC = ['already_done', 'corrective', 'skipped', 'denied', 'need_approval', 'asked',
    'loop', 'target_given_up', 'not_found_resolved', 'duplicate', 'plan_mode', 'bad_args'];
function countCalls(entries, tool) {
    return (entries || []).filter((c) => c.tool === tool && NON_EXEC.indexOf(c.code) === -1).length;
}
function countRequests(entries, tool) {
    return (entries || []).filter((c) => c.tool === tool).length;
}

async function E1() {
    line('\n===== E1 : appels d outil DOUBLES / audit repete =====');
    const w = createWorld({ files: {
        'package.json': JSON.stringify({ name: 'p61', version: '1.0.0' }),
        'src/app.js': 'const x = 1;\nconsole.log(x);\n',
        '.env': 'API_KEY=abcdef1234567890abcdef\n',
    } });
    // Realistic small-model behaviour: the same audit call, three rounds in a
    // row, then a free-text "done" (no reply/done tool).
    const r = await w.turn('Utilise la fonctionnalite de systeme audit et fais l audit complet puis corrige', [
        call('security_audit_run', {}),
        call('security_audit_run', {}),
        call('security_audit_run', {}),
        text('Audit termine, rien a corriger.'),
        text('Audit termine.'),
    ], { autoApprove: 'session', maxIt: 12 });

    const runs = countCalls(r.calls, 'security_audit_run');
    const requests = countRequests(r.calls, 'security_audit_run');
    line('  statut du tour       : ' + r.out.runStatus + ' (stopReason=' + (r.out.stopReason || '-') + ')');
    line('  toolCalls result     : ' + JSON.stringify((r.calls || []).map((c) => c.tool + ':' + c.code)));
    line('  security_audit_run   : ' + runs + ' execution(s) reelle(s) pour ' + requests + ' demande(s), ' +
        (r.calls || []).filter((c) => c.tool === 'security_audit_run' && c.ok).length + ' ok');
    line('  journal "tool ok"    : ' + journalLines(r.journal, 'tool ok').filter((l) => l.indexOf('security_audit_run') !== -1).length);
    const msg = lastAssistant(r.msgs);
    line('  message utilisateur  : ' + JSON.stringify(String(msg).slice(0, 220)));
    line('  -> lecture : ' + (runs > 1 ? 'DOUBLON CONFIRME (' + runs + ' executions du meme appel)' : 'pas de doublon'));
    return { runs, status: r.out.runStatus, stopReason: r.out.stopReason };
}

async function E2() {
    line('\n===== E2 : delete refuse APRES approbation (not_read) =====');
    const w = createWorld({ files: {
        'package.json': JSON.stringify({ name: 'p61', version: '1.0.0' }),
        'notes.txt': 'a supprimer\n',
    } });
    const r = await w.turn('Supprime le fichier notes.txt', [
        call('delete', { file: 'notes.txt' }),
        call('delete', { file: 'notes.txt' }),
        call('delete', { file: 'notes.txt' }),
        call('delete', { file: 'notes.txt' }),
        call('read', { file: 'notes.txt' }),
        text('Aucune modification : appels lecture seule uniquement.'),
        text('Aucune modification.'),
    ], { autoApprove: 'once', maxIt: 12 });

    const del = (r.calls || []).filter((c) => c.tool === 'delete');
    line('  statut du tour       : ' + r.out.runStatus);
    line('  delete appels        : ' + del.length + ' -> codes ' + JSON.stringify(del.map((c) => c.code)));
    line('  fichier encore la    : ' + w.exists('notes.txt'));
    line('  journal lecture auto : ' + (r.journal.indexOf('lecture automatique') !== -1 ? 'OUI' : 'NON'));
    line('  message utilisateur  : ' + JSON.stringify(String(lastAssistant(r.msgs)).slice(0, 200)));
    line('  -> lecture : ' + (w.exists('notes.txt') ? 'SUPPRESSION NON FAITE alors que la demande etait explicite' : 'supprime'));
    return { deleteRequests: del.length, deleteExecutions: countCalls(del, 'delete'),
      codes: del.map((c) => c.code), deleted: !w.exists('notes.txt'), status: r.out.runStatus };
}

async function E3() {
    line('\n===== E3 : fichier inexistant redemande en boucle =====');
    const w = createWorld({ files: {
        'package.json': JSON.stringify({ name: 'p61', version: '1.0.0' }),
        'README.md': '# Mon projet\n\nBienvenue.\n',
        'ARCHITECTURE.md': '# Archi\n',
    } });
    const r = await w.turn('Lis le fichier readme.md et dis moi ce qu il contient', [
        call('read', { file: 'readme.md' }),
        call('read', { file: 'readme.md' }),
        call('read', { file: 'readme.md' }),
        call('read', { file: 'readme.md' }),
        call('read', { file: 'readme.md' }),
        call('read', { file: 'readme.md' }),
        text('Je ne trouve pas le fichier.'),
    ], { autoApprove: 'session', maxIt: 8 });

    const reads = (r.calls || []).filter((c) => c.tool === 'read');
    line('  statut du tour       : ' + r.out.runStatus + ' (stopReason=' + (r.out.stopReason || '-') + ')');
    line('  read sur readme.md   : ' + reads.length + ' -> codes ' + JSON.stringify(reads.map((c) => c.code)));
    line('  resolution auto      : ' + (r.journal.indexOf('chemin resolu') !== -1 ? 'OUI' : 'NON'));
    line('  message utilisateur  : ' + JSON.stringify(String(lastAssistant(r.msgs)).slice(0, 200)));
    line('  -> lecture : ' + (r.out.stopReason === 'max_iters' ? 'BOUCLE jusqu a max_iters (aucune auto-correction du chemin)' : 'arret : ' + r.out.stopReason));
    return { reads: reads.length, stopReason: r.out.stopReason, status: r.out.runStatus };
}

async function E4() {
    line('\n===== E4 : runtime hors ligne en cours de tour =====');
    // Round 1: the runtime answers. Round 2: it dies (socket closed), then
    // comes back on the same port after ~1 s (client side: two providers).
    const w = createWorld({ files: { 'package.json': JSON.stringify({ name: 'p61' }) } });
    const r = await w.turn('Lis package.json', [
        call('read', { file: 'package.json' }),
        { downFor: 700 },                       // le runtime TOMBE (port ferme)
        call('read', { file: 'package.json' }),
        call('done', { summary: 'fichier lu' }),
    ], { maxIt: 8, runtimeWait: { attempts: 8, delayMs: 400, probeTimeoutMs: 300 } });

    line('  statut du tour       : ' + r.out.runStatus + ' (code=' + (r.out.code || '-') + ')');
    line('  evenements runtime   : ' + JSON.stringify((r.events || []).filter((e) => String(e.type).indexOf('runtime') !== -1).map((e) => e.type + (e.message ? '(' + String(e.message).slice(0, 40) + ')' : ''))));
    line('  message utilisateur  : ' + JSON.stringify(String(lastAssistant(r.msgs)).slice(0, 200)));
    line('  -> lecture : ' + (r.out.code === 'runtime_offline' || r.out.status === 'error' ? 'TOUR ECHOUE brutalement' : 'tour poursuivi'));
    return { status: r.out.status, code: r.out.code, events: (r.events || []).length };
}

async function E5() {
    line('\n===== E5 : statuts aborted / PARTIEL sans raison =====');
    const w = createWorld({ files: { 'package.json': JSON.stringify({ name: 'p61' }) } });
    // The model keeps calling a nonexistent tool: the turn must end with an
    // EXPLICIT reason the user can read.
    const r = await w.turn('Fais une chose impossible', [
        call('outil_inexistant', {}),
        call('outil_inexistant', {}),
        call('outil_inexistant', {}),
        call('outil_inexistant', {}),
        call('outil_inexistant', {}),
    ], { maxIt: 6 });
    const done = (r.events || []).filter((e) => e.type === 'turn.done').pop() || {};
    line('  statut du tour       : ' + r.out.runStatus + ' (stopReason=' + (r.out.stopReason || '-') + ')');
    line('  turn.done.reason     : ' + JSON.stringify(String(done.reason || '').slice(0, 200)));
    line('  message utilisateur  : ' + JSON.stringify(String(lastAssistant(r.msgs)).slice(0, 200)));
    const reasonOk = !!(done.reason && String(done.reason).trim().length > 10);
    line('  -> lecture : ' + (reasonOk ? 'raison presente' : 'STATUT PARTIEL SANS RAISON VISIBLE'));
    return { status: r.out.runStatus, reason: done.reason || '', stopReason: r.out.stopReason };
}

async function main() {
    line('P61-A REPRODUCTION - moteur : ' + path.join('sudo-agent', 'src', 'loop.js'));
    line('date : ' + new Date().toISOString());
    const res = {};
    for (const [name, fn] of [['E1', E1], ['E2', E2], ['E3', E3], ['E4', E4], ['E5', E5]]) {
        try { res[name] = await fn(); }
        catch (e) { res[name] = { harnessError: String((e && e.message) || e) }; line('  HARNAIS ERREUR : ' + ((e && e.stack) || e)); }
    }
    line('\n===== RESUME (JSON) =====');
    line(JSON.stringify(res, null, 1));
    try { fs.writeFileSync(process.env.P61_REPRO_OUT || '/tmp/p61-repro.json', JSON.stringify(res, null, 1)); } catch (_) {}
}

main().then(() => process.exit(0), (e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
