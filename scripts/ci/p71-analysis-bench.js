#!/usr/bin/env node
/**
 * SUDO STUDIO - P71 partie A (mesures) : tranche H1 / H2 / H3 avec des chiffres.
 *
 * Ce banc suppose un runtime deja demarre sur 127.0.0.1:6000 avec le VRAI
 * modele (Qwen2.5-Coder-1.5B Q4_K_M) et une fenetre n_ctx connue.
 *
 * Il mesure, pour le prompt d'analyse du produit (celui du panneau, apres
 * compactage P71) :
 *   - la taille du prompt (jetons estimes, et jetons reels si le runtime les
 *     renvoie dans usage.prompt_tokens) ;
 *   - le temps de lecture (prompt eval) quand le runtime le donne ;
 *   - le temps de generation et le temps total ;
 *   - le delai que le client P71 aurait calcule, et s'il aurait suffi.
 *
 * Verdict :
 *   H1  le prompt depasse la fenetre (ou 70 % de la fenetre)
 *   H2  le prompt tient, mais le delai fixe de 60 s etait trop court
 *   H3  ni l'un ni l'autre (le 60 s suffisait : autre cause)
 *
 * Usage : node scripts/ci/p71-analysis-bench.js [--out p71-analysis.json]
 * ASCII only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const analyzer = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', 'projectAnalyzer'));
const rec = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', 'recommendations'));
const ai = require(path.join(ROOT, 'sudo-ai-extension', 'src', 'analysis', 'aiBudget'));

const BASE = 'http://127.0.0.1:6000';
const OLD_TIMEOUT_MS = 60000;   // le delai fixe du panneau avant P71

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p71-next-'));
  const files = {
    'package.json': JSON.stringify({
      name: 'maquis-pos', version: '1.0.0',
      dependencies: { next: '14.0.0', react: '18.2.0', 'react-dom': '18.2.0', axios: '1.6.0' },
      devDependencies: { eslint: '8.0.0', typescript: '5.0.0' },
      scripts: { dev: 'next dev', build: 'next build' },
    }, null, 2),
    'app/page.js': 'export default function Page() {\n  // TODO: brancher la caisse\n  return null;\n}\n',
    'app/api/health/route.js': 'export function GET() { return Response.json({ ok: true }); }\n',
    'lib/db.js': 'export const db = null; // FIXME\n',
  };
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return dir;
}

async function getJson(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
  return r.json();
}

async function main() {
  const outFile = (process.argv.indexOf('--out') !== -1) ? process.argv[process.argv.indexOf('--out') + 1] : 'p71-analysis.json';
  const result = { at: new Date().toISOString(), host: { platform: process.platform, cpus: os.cpus().length, cpu: (os.cpus()[0] || {}).model } };

  // ---- partie deterministe (doit etre immediate)
  const root = fixture();
  const t0 = Date.now();
  const analysis = await analyzer.analyzeProject(root);
  const recs = rec.build(analysis, { root });
  const deterministicMs = Date.now() - t0;
  result.deterministic = { ms: deterministicMs, items: recs.items.length,
    ids: recs.items.map((i) => i.id) };
  console.log('deterministe | ' + deterministicMs + ' ms | ' + recs.items.length + ' points : ' + result.deterministic.ids.join(','));
  const A_OK = deterministicMs < 2000 && recs.items.length > 0;

  // ---- fenetre reelle
  let md = {};
  try { md = await getJson('/models'); } catch (_) {
    try { md = await getJson('/v1/models'); } catch (_) { md = {}; }
  }
  const argWindow = (process.argv.indexOf('--window') !== -1) ? Number(process.argv[process.argv.indexOf('--window') + 1]) : 0;
  const windowTokens = Number(md.real_window_tokens) || Number(md.n_ctx) ||
    Number((md.data && md.data[0] && md.data[0].n_ctx)) || argWindow || 0;
  result.window = { tokens: windowTokens, declaredBy: (Number(md.real_window_tokens) || Number(md.n_ctx)) ? 'runtime' : (argWindow ? 'ligne de commande' : 'inconnu'), raw: md };

  // ---- prompt compact P71
  const compact = ai.compactContext(analysis, { windowTokens: windowTokens || 2048 });
  const maxOutTokens = 320;
  const prompt = 'Analyse ce projet et donne 5 recommandations concretes (qualite, securite, maintenabilite). ' +
    'Sois concis et actionnable.\nContexte deterministe :\n' + compact.context;
  result.prompt = { estimatedTokens: compact.estimatedTokens, chars: prompt.length,
    maxTokensAllowed: compact.maxTokens, ratioUsed: compact.ratioUsed };

  // ---- appel reel, chronometre
  const t1 = Date.now();
  let reply = '', usage = {}, err = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    const r = await fetch(BASE + '/infer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: prompt, max_tokens: maxOutTokens }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    reply = String(data.reply || '');
    usage = data.usage || {};
  } catch (e) { err = String((e && e.message) || e); }
  const totalMs = Date.now() - t1;
  const promptTokensReal = Number(usage.prompt_tokens) || 0;
  const promptTokens = promptTokensReal || compact.estimatedTokens;
  const genTokens = Number(usage.completion_tokens) || 0;
  const tokPerSec = genTokens && totalMs ? +(genTokens / (totalMs / 1000)).toFixed(2) : 0;

  const budget = ai.deadlineMs({ promptTokens, maxOutTokens, tokPerSec: tokPerSec || 12 });
  const verdict = err ? (promptTokens > 0.7 * (windowTokens || 2048) ? 'H1'
    : (totalMs >= OLD_TIMEOUT_MS ? 'H2' : 'H3'))
    : (promptTokens > 0.7 * (windowTokens || 2048) ? 'H1' : (totalMs >= OLD_TIMEOUT_MS ? 'H2' : 'H3bis'));

  result.ai = { ok: !err, error: err, totalMs, promptTokens, promptTokensSource: promptTokensReal ? 'runtime' : 'estimation',
    genTokens, tokPerSec, replyChars: reply.length, deadlineMs: budget.ms,
    oldTimeoutMs: OLD_TIMEOUT_MS, oldTimeoutWouldFail: totalMs >= OLD_TIMEOUT_MS,
    newDeadlineWouldWaitEnough: budget.ms >= totalMs,
    classifyIfTimeout: err ? ai.classify({ message: err, code: /abort/i.test(err) ? 'ECONNABORTED' : '' },
      { windowTokens, promptTokens, deadlineMs: budget.ms, tokPerSec }) : null };
  result.verdict = verdict;
  result.journal = ai.journalLine({ promptTokens, windowTokens, ratioUsed: compact.ratioUsed, maxOutTokens,
    deadlineMs: budget.ms, durationMs: totalMs, tokPerSec, issue: err ? 'echec' : 'ok' });

  const lines = [
    'fenetre        : ' + (windowTokens || '?') + ' jetons (' + result.window.declaredBy + ')',
    'prompt         : ' + promptTokens + ' jetons (' + result.ai.promptTokensSource + '), ' + prompt.length + ' caracteres',
    'plafond P71    : ' + compact.maxTokens + ' jetons (70 % de la fenetre)',
    'temps total    : ' + totalMs + ' ms',
    'generation     : ' + genTokens + ' jetons, ' + (tokPerSec || '?') + ' jetons/s',
    'delai calcule  : ' + budget.ms + ' ms (ancien delai fixe : ' + OLD_TIMEOUT_MS + ' ms)',
    'echec          : ' + (err || 'aucun'),
    'verdict        : ' + verdict,
  ];
  lines.forEach((l) => console.log(l));
  console.log('journal        : ' + result.journal);

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log('resultat ecrit : ' + outFile);

  // Critere honnete : le deterministe doit passer, et si l'appel echoue il doit
  // y avoir une CAUSE classee (jamais un "delai depasse" nu).
  const aiOk = result.ai.ok || (result.ai.classifyIfTimeout && result.ai.classifyIfTimeout.code);
  if (!A_OK || !aiOk) {
    console.log('P71 bench: FAIL (deterministe=' + A_OK + ', ia=' + !!aiOk + ')');
    process.exit(1);
  }
  console.log('P71 bench: PASS');
}
main().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
