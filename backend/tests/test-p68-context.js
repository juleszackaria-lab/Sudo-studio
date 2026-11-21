/**
 * SUDO STUDIO - P68-B : la fenetre de contexte ANNONCEE est-elle celle OBTENUE ?
 *
 * Trois verites a tenir ensemble :
 *   H1  la fonction de decision (openai_compat.n_ctx_reduction_info) est reelle
 *       et parle francais : "Contexte reduit : 4096 -> 2048 jetons (...)";
 *   H2  quand rien n'est reduit, elle ne crie pas (reduced=false, message vide) ;
 *   H3  le runtime EXPOSE cette information (/health et /models) : sans cela
 *       l'utilisateur ne peut pas la voir ;
 *   H4  l'interface l'AFFICHE (bandeau "Contexte reduit") et le masque quand il
 *       n'y a pas de reduction : un bandeau colle en permanence ne previent de rien.
 *
 * ASCII only. Lancer : node backend/tests/test-p68-context.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'backend', 'runtime');
const PANEL = path.join(ROOT, 'sudo-ai-extension', 'src', 'panels', 'RuntimePanel.js');

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
    console.log('INDISPONIBLE: python3 absent -> politique de contexte NON TESTEE ici.');
    process.exit(2);
}

// ---------------------------------------------------------------- H1 / H2
const r = py(`
import json, openai_compat as o
out = {}
out["reduit"] = o.n_ctx_reduction_info(4096, 2048, "profil RAM faible (0.4 Go libres)")
out["intact"] = o.n_ctx_reduction_info(4096, 4096, None)
out["inconnu"] = o.n_ctx_reduction_info(None, None, None)
out["hausse"] = o.n_ctx_reduction_info(2048, 4096, None)
print(json.dumps(out))
`);

check('H1 la fonction de reduction existe et rend un objet', r.ok && r.value && !!r.value.reduit,
    r.ok ? 'valeur inattendue' : r.error);
if (r.ok && r.value && r.value.reduit) {
    const d = r.value.reduit;
    check('H1b reduced=true avec nominal/effective corrects',
        d.reduced === true && d.nominal === 4096 && d.effective === 2048,
        JSON.stringify(d));
    check('H1c le message dit les deux chiffres et la raison, en francais',
        /Contexte reduit/.test(d.message) && /4096/.test(d.message) && /2048/.test(d.message) &&
        /RAM/.test(d.message), d.message);
    check('H1d la raison est celle transmise', /profil RAM/.test(String(d.reason)), String(d.reason));
} else {
    check('H1b reduced=true avec nominal/effective corrects', false, 'pas de reduction');
    check('H1c le message dit les deux chiffres et la raison, en francais', false, 'pas de reduction');
    check('H1d la raison est celle transmise', false, 'pas de reduction');
}

if (r.ok && r.value) {
    const i = r.value.intact || {};
    check('H2 sans reduction : reduced=false et aucun message (pas de faux bandeau)',
        i.reduced === false && (i.message === '' || i.message === undefined), JSON.stringify(i));
    const k = r.value.inconnu || {};
    check('H2b valeurs absentes (None) : pas de plantage, pas de reduction',
        k.reduced === false, JSON.stringify(k));
    const h = r.value.hausse || {};
    check('H2c une hausse n\'est pas une reduction', h.reduced === false, JSON.stringify(h));
} else {
    check('H2 sans reduction : reduced=false et aucun message (pas de faux bandeau)', false, 'python');
    check('H2b valeurs absentes (None) : pas de plantage, pas de reduction', false, 'python');
    check('H2c une hausse n\'est pas une reduction', false, 'python');
}

// ---------------------------------------------------------------- H3
const serverSrc = fs.readFileSync(path.join(RUNTIME, 'server.enterprise.py'), 'utf8');
check('H3 /health expose n_ctx_reduction', /"n_ctx_reduction":\s*getattr\(state/.test(serverSrc));
check('H3b /models expose n_ctx_reduction', /"n_ctx_reduction":\s*getattr\(state/.test(serverSrc) &&
    (serverSrc.match(/"n_ctx_reduction"/g) || []).length >= 2,
    'occurrences: ' + (serverSrc.match(/"n_ctx_reduction"/g) || []).length);
check('H3c une reduction annoncee ne survit pas a un rechargement',
    /def load_model_thread[\s\S]{0,400}state\.n_ctx_reduction = None/.test(serverSrc));

// ---------------------------------------------------------------- H4
const panel = fs.readFileSync(PANEL, 'utf8');
check('H4 l\'interface a un bandeau dedie (ctxReducedBanner)',
    /id="ctxReducedBanner"/.test(panel));
check('H4b elle lit n_ctx_reduction du runtime',
    /n_ctx_reduction:\s*rm\.data\.n_ctx_reduction/.test(panel));
check('H4c elle affiche le bandeau quand reduced=true',
    /red\.reduced[\s\S]{0,200}display = 'block'/.test(panel));
check('H4d elle le masque sinon (aucun bandeau permanent)',
    /else \{[\s\S]{0,120}ctxBanner\.style\.display = 'none'/.test(panel));
check('H4e le bandeau nomme les deux tailles et la raison',
    /Contexte r\\u00e9duit : ' \+ red\.nominal \+ ' \\u2192 ' \+ red\.effective/.test(panel),
    'texte du bandeau introuvable');

// ---------------------------------------------------------------- H5/H6/H7
// Le comptage REEL : le runtime compte, l'agent ne devine plus.
const http = require('http');
const providers = require(path.join(ROOT, 'sudo-agent', 'src', 'providers.js'));
const profiles = require(path.join(ROOT, 'sudo-agent', 'src', 'profiles.js'));

async function avecFauxRuntime(handler, fn) {
    const srv = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try { return await fn(port); } finally { await new Promise((r) => srv.close(r)); }
}

(async () => {
    // H5: la route existe cote runtime
    check('H5 le runtime expose POST /tokenize', /@app\.route\('\/tokenize', methods=\['POST'\]\)/.test(serverSrc));
    check('H5b sans modele charge : 503 explicite, jamais un 500 muet',
        /aucun modele charge : impossible de compter/.test(serverSrc));

    // H6: l'agent prefere le comptage du runtime a son estimation
    const r1 = await avecFauxRuntime((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            // le faux tokeniseur renvoie un compte lie a la taille du texte
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens: Math.ceil(String(body.text || '').length / 2) }));
        });
    }, (port) => providers.countTokens({ type: 'local', baseUrl: 'http://127.0.0.1:' + port }, 'abcdefghij'));
    check('H6 le comptage du runtime est utilise tel quel',
        r1 && r1.tokens === 5 && r1.source === 'comptage runtime', JSON.stringify(r1));

    // H6b: runtime muet -> pas d'exception, l'appelant peut estimer
    const r2 = await avecFauxRuntime((req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'aucun modele charge' }));
    }, (port) => providers.countTokens({ type: 'local', baseUrl: 'http://127.0.0.1:' + port }, 'x'));
    check('H6b un refus du runtime ne casse rien (tokens=null)', r2 && r2.tokens === null, JSON.stringify(r2));

    const r3 = await providers.countTokens({ type: 'local', baseUrl: 'http://127.0.0.1:1' }, 'x');
    check('H6c runtime injoignable : tokens=null, aucune exception', r3 && r3.tokens === null, JSON.stringify(r3));

    // H7: l'estimation de repli est celle qui a ete MESUREE, sans marge fixe
    const court = [{ role: 'user', content: 'bonjour' }];
    const estLegacy = profiles.estimateTokens(court, 0);
    const estCal = profiles.estimateTokensCalibrated(court, 0);
    check('H7 estimateTokensCalibrated existe', typeof profiles.estimateTokensCalibrated === 'function');
    check('H7b la marge fixe de 64 jetons a disparu du repli mesure',
        estCal < estLegacy && estCal === Math.ceil((5 + 32) / 4), estLegacy + ' vs ' + estCal);
    const long = [{ role: 'user', content: 'x'.repeat(4000) }];
    check('H7c sur un prompt long le repli suit chars/4',
        profiles.estimateTokensCalibrated(long, 0) === Math.ceil((4000 + 32) / 4),
        String(profiles.estimateTokensCalibrated(long, 0)));

    // H8: la boucle de l'agent s'en sert pour decider de compresser
    const loopSrc = fs.readFileSync(path.join(ROOT, 'sudo-agent', 'src', 'loop.js'), 'utf8');
    check('H8 le budget du tour utilise le comptage runtime quand il existe',
        /countTokens\(provider/.test(loopSrc) && /comptage runtime/.test(loopSrc));
    check('H8b la source du chiffre est journalisee (aucun chiffre anonyme)',
        /'jetons du tour'/.test(loopSrc) && /source: counted\.source/.test(loopSrc));

    // ---------------------------------------------------------------- verdict
    fin();
})();

function fin() {
    console.log('\nP68-B contexte: ' + pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ' (all green)'));
    if (fails.length) {
        for (const f of fails) console.log('  - ' + f);
        process.exit(1);
    }
    process.exit(0);
}
