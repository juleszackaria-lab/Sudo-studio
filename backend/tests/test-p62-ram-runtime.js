/**
 * SUDO STUDIO - P62-C : la politique RAM du RUNTIME (Python) est-elle reelle ?
 *
 * Le moteur de decision vit dans backend/runtime/openai_compat.py (c'est ce
 * fichier qui est embarque dans le runtime fige). Ce test l'execute pour de
 * vrai via python3 : si python3 est absent, il le DIT (aucun faux vert).
 *
 * Verifie :
 *   C1  n_ctx / n_threads / n_batch choisis selon la RAM libre, avec message FR ;
 *   C2  427 Mo libres (chiffres de la video) -> refus explique, pas de plantage ;
 *   C3  sous pression -> contexte divise pour l'appel suivant ;
 *   F-2 le budget d'appel est 60 % du contexte et les vieux messages sortent.
 *
 * ASCII only. Lancer : node backend/tests/test-p62-ram-runtime.js
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME = path.join(__dirname, '..', 'runtime');
let pass = 0;
const fails = [];
function check(name, cond, detail) {
    if (cond) { pass += 1; console.log('ok - ' + name); }
    else { fails.push(name + ' :: ' + (detail || '')); console.log('FAIL ' + name + ' :: ' + (detail || '')); }
}

function py(code) {
    const r = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, ".")\n' + code],
        { cwd: RUNTIME, encoding: 'utf8', timeout: 60000 });
    if (r.error) return { ok: false, error: String(r.error.message || r.error) };
    if (r.status !== 0) return { ok: false, error: (r.stderr || '').slice(0, 400) };
    try { return { ok: true, value: JSON.parse(r.stdout) }; }
    catch (e) { return { ok: false, error: 'sortie illisible: ' + String(r.stdout).slice(0, 200) }; }
}

const hasPython = (() => {
    const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
})();

if (!hasPython) {
    console.log('INDISPONIBLE: python3 absent de cette machine -> politique RAM runtime NON TESTEE ici.');
    console.log('(le paquet Windows embarque son propre interpreteur : ce test tourne en CI Linux)');
    process.exit(2);
}

// 1) Les trois regimes de RAM, avec les chiffres reels de la video.
const regimes = py(`
import json, openai_compat as o
out = {}
out["video"] = o.low_ram_profile("Qwen2.5-Coder-1.5B-Instruct", 1.1, 0.427)
out["mid"] = o.low_ram_profile("Qwen2.5-Coder-1.5B-Instruct", 1.1, 3.0)
out["big"] = o.low_ram_profile("Qwen2.5-Coder-1.5B-Instruct", 1.1, 12.0, cpus=8)
out["tiny_model_low"] = o.low_ram_profile("Qwen2.5-Coder-0.5B-Instruct", 0.4, 1.1, cpus=4)
out["pressure"] = o.context_under_pressure(4096, 0.3)
out["calm"] = o.context_under_pressure(4096, 2.6)
out["budget"] = o.context_budget_tokens(4096)
msgs = [{"role":"system","content":"sys"},{"role":"user","content":"x"*8000},{"role":"assistant","content":"a"},{"role":"user","content":"dernier"}]
out["trimmed"] = o.trim_messages_to_budget(msgs, 512)
print(json.dumps(out))
`);

check('C0: le module de politique RAM du runtime est importable', regimes.ok === true, regimes.error);
if (regimes.ok) {
    const v = regimes.value;
    check('C1-a: 427 Mo libres (video) -> refus explique, aucun contexte choisi',
        v.video.ok === false && v.video.n_ctx === null && /RAM libre insuffisante/.test(v.video.message),
        JSON.stringify(v.video).slice(0, 220));
    check('C2-a: le refus dit combien il faut et quoi faire',
        v.video.needed_gb > 1 && /Ferme d autres applications/.test(v.video.message),
        v.video.message);
    check('C1-b: 3 Go libres -> contexte 4096 et message en francais avec les chiffres',
        v.mid.ok === true && v.mid.n_ctx === 4096 && /contexte 4096/.test(v.mid.message) &&
        v.mid.message.indexOf('3.00') !== -1, JSON.stringify(v.mid).slice(0, 240));
    check('C1-c: 12 Go libres -> contexte 8192, plusieurs fils, lot 512',
        v.big.ok === true && v.big.n_ctx === 8192 && v.big.n_threads >= 4 && v.big.n_batch === 512,
        JSON.stringify(v.big).slice(0, 200));
    check('C1-d: RAM serree -> lot reduit a 128 et fils plafonnes a 4',
        v.tiny_model_low.ok === true && v.tiny_model_low.n_batch === 128 && v.tiny_model_low.n_threads <= 4,
        JSON.stringify(v.tiny_model_low).slice(0, 200));
    check('C1-e: le budget engage reste sous 70 % de la RAM libre',
        v.mid.needed_gb <= v.mid.budget_gb && v.big.needed_gb <= v.big.budget_gb,
        JSON.stringify({ mid: [v.mid.needed_gb, v.mid.budget_gb], big: [v.big.needed_gb, v.big.budget_gb] }));
    check('C3-a: sous pression, le contexte du prochain appel est divise (4096 -> 2048)',
        v.pressure.changed === true && v.pressure.n_ctx === 2048, JSON.stringify(v.pressure));
    check('C3-b: la reduction est annoncee en francais', /RAM libre faible/.test(v.pressure.message), v.pressure.message);
    check('C3-c: RAM correcte -> aucun changement', v.calm.changed === false && v.calm.n_ctx === 4096);
    check('F-2a: le budget d appel vaut 60 % du contexte', v.budget === 2457, String(v.budget));
    check('F-2b: le message geant sort du budget, le systeme et le dernier restent',
        v.trimmed.every((m) => String(m.content).length < 1000) &&
        v.trimmed[0].role === 'system' && v.trimmed[v.trimmed.length - 1].content === 'dernier',
        JSON.stringify(v.trimmed.map((m) => m.role + ':' + String(m.content).slice(0, 10))));
}

// 2) Non-regression : les fonctions existantes de n_ctx restent en place.
const legacy = py(`
import json, openai_compat as o
print(json.dumps({
  "default4096": o.default_n_ctx(4.0),
  "default8192": o.default_n_ctx(12.0),
  "clamp_low": o.clamp_n_ctx(1),
  "clamp_high": o.clamp_n_ctx(999999),
  "auto": o.auto_n_ctx("Qwen2.5-Coder-1.5B-Instruct", 1.1, 4.0)["n_ctx"],
}))
`);
check('C4: les decisions existantes (default_n_ctx, clamp, auto_n_ctx) sont inchangees',
    legacy.ok && legacy.value.default4096 === 4096 && legacy.value.default8192 === 8192 &&
    legacy.value.clamp_low === 512 && legacy.value.clamp_high === 32768 && legacy.value.auto === 8192,
    legacy.ok ? JSON.stringify(legacy.value) : legacy.error);

// 2b) P62-F5 : decodage contraint (GBNF) — grammaire reelle et valide.
const gram = py(`
import json, grammar as g
tools = [{"type":"function","function":{"name":"read_file"}},
         {"type":"function","function":{"name":"write_file"}}]
gb = g.toolcall_grammar(tools)
out = {"lint": g.lint_gbnf(gb), "stats": g.grammar_stats(gb),
       "has_read": '"read_file"' in gb, "has_write": '"write_file"' in gb,
       "obj": g.lint_gbnf(g.json_object_grammar()),
       "empty": g.toolcall_grammar([]),
       "bad": g.lint_gbnf("root ::= missing_rule")}
print(json.dumps(out))
`);
check('F5-a: la grammaire GBNF des appels d outils est generee et valide',
    gram.ok && gram.value.lint.ok === true && gram.value.stats.rules >= 9,
    gram.ok ? JSON.stringify(gram.value.lint) : gram.error);
check('F5-b: seuls les outils reellement exposes sont autorises',
    gram.ok && gram.value.has_read === true && gram.value.has_write === true,
    gram.ok ? String(gram.value.stats) : '');
check('F5-c: sans outil, aucune grammaire (repli propre, pas de faux succes)',
    gram.ok && gram.value.empty === null, gram.ok ? JSON.stringify(gram.value.empty) : '');
check('F5-d: une grammaire incoherente est refusee par le controle',
    gram.ok && gram.value.bad.ok === false && /missing_rule/.test(gram.value.bad.error),
    gram.ok ? JSON.stringify(gram.value.bad) : '');
check('F5-e: la grammaire JSON generique est valide', gram.ok && gram.value.obj.ok === true);

// 3) Le code du serveur runtime compile toujours.
const compile = spawnSync('python3', ['-m', 'py_compile', 'server.enterprise.py', 'openai_compat.py', 'grammar.py'],
    { cwd: RUNTIME, encoding: 'utf8', timeout: 120000 });
check('C5: server.enterprise.py, openai_compat.py et grammar.py compilent', compile.status === 0,
    (compile.stderr || '').slice(0, 300));

console.log('\nP62-C runtime: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
if (fails.length) { for (const f of fails) console.log('  - ' + f); }
process.exit(fails.length ? 1 : 0);
