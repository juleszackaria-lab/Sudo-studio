/**
 * ramProfile.js - P62-C : choisir n_ctx / n_threads / n_batch selon la RAM libre.
 *
 * Constat de depart (video de test, agent.log) : ramMB total=8052 free=427.
 * Sur une machine a 7,9 Go dont 400 Mo libres, un contexte de 8192 tue le
 * runtime. On choisit donc AUTOMATIQUEMENT un profil sur, et on DIT pourquoi
 * (message en francais), au lieu de planter en silence.
 *
 * Regles (documentees, testables) :
 *   - estimation memoire = modele + KV cache (~ n_ctx x 0,15 Mo pour un 1,5B Q4)
 *     + marge de securite ;
 *   - on vise au plus 70 % de la RAM libre ;
 *   - si meme le plus petit contexte ne tient pas : avertissement clair, on ne
 *     charge pas (jamais de plantage silencieux) ;
 *   - n_threads = coeurs physiques - 1 au maximum, borne a 4 sur petite RAM ;
 *   - n_batch = 128 quand la RAM est serree, 512 sinon.
 *
 * node pur, aucune dependance, jamais d'exception. ASCII only.
 */
'use strict';

const os = require('os');

const KB_PER_CTX_TOKEN_MB = 0.15;   // KV cache approximatif pour un 1,5B en Q4
const SAFE_SHARE = 0.70;            // au plus 70 % de la RAM libre
const CTX_LADDER = [8192, 4096, 2048, 1024, 512];
const MIN_FREE_WARN_MB = 800;

function freeRamMB() {
  try {
    const free = os.freemem() / (1024 * 1024);
    return Math.round(free);
  } catch (_) { return 0; }
}

function totalRamMB() {
  try { return Math.round(os.totalmem() / (1024 * 1024)); } catch (_) { return 0; }
}

function cpuCount() {
  try {
    const c = os.cpus();
    return Array.isArray(c) ? c.length : 2;
  } catch (_) { return 2; }
}

// Estimation memoire necessaire pour un contexte donne.
function estimateMB(modelMB, nCtx) {
  const m = Number(modelMB) > 0 ? Number(modelMB) : 1100; // 1,5B Q4_K_M ~ 1,1 Go
  const ctx = Number(nCtx) > 0 ? Number(nCtx) : 2048;
  return Math.round(m + ctx * KB_PER_CTX_TOKEN_MB + 250); // +250 Mo de marge
}

/**
 * decide({ freeMB, totalMB, modelMB, cpus, platform }) ->
 * { nCtx, nThreads, nBatch, variant, ok, reason, message, fits }
 */
function decide(opts) {
  const o = opts || {};
  const free = Number(o.freeMB) >= 0 ? Number(o.freeMB) : freeRamMB();
  const total = Number(o.totalMB) > 0 ? Number(o.totalMB) : totalRamMB();
  const modelMB = Number(o.modelMB) > 0 ? Number(o.modelMB) : 1100;
  const cpus = Number(o.cpus) > 0 ? Number(o.cpus) : cpuCount();
  const budget = Math.floor(free * SAFE_SHARE);

  let chosen = null;
  for (const ctxTok of CTX_LADDER) {
    if (estimateMB(modelMB, ctxTok) <= budget) { chosen = ctxTok; break; }
  }

  if (!chosen) {
    const min = estimateMB(modelMB, CTX_LADDER[CTX_LADDER.length - 1]);
    return {
      ok: false, fits: false,
      nCtx: null, nThreads: 1, nBatch: 64, variant: 'compat',
      freeMB: free, totalMB: total, modelMB, budgetMB: budget, neededMB: min,
      message: 'RAM libre insuffisante : ' + free + ' Mo libres, il en faut au moins ' + min +
        ' Mo pour charger ce modele. Ferme d autres applications ou choisis un modele plus leger.',
      reason: 'free=' + free + ' Mo < besoin minimal ' + min + ' Mo (70 % de securite)',
    };
  }

  // Fils : un par coeur disponible, mais on laisse toujours un coeur au systeme,
  // et on plafonne a 4 quand la RAM est serree (moins de 2 Go libres).
  let nThreads = Math.max(1, Math.min(cpus - 1, free < 2048 ? 4 : cpus));
  const nBatch = free < 1500 ? 128 : 512;
  const variant = (o.platform || process.platform) === 'win32' ? 'auto' : 'auto';

  const fits = estimateMB(modelMB, chosen) <= budget;
  const tight = free < MIN_FREE_WARN_MB;
  const message = 'Profil choisi automatiquement : contexte ' + chosen + ' jetons, ' + nThreads +
    ' fil(s), lot ' + nBatch + ' — RAM libre ' + free + ' Mo sur ' + total + ' Mo (estimation ' +
    estimateMB(modelMB, chosen) + ' Mo necessaires, budget ' + budget + ' Mo).' +
    (tight ? ' ATTENTION : moins de ' + MIN_FREE_WARN_MB + ' Mo libres, le contexte a ete reduit au minimum sur.' : '');

  return {
    ok: fits, fits,
    nCtx: chosen, nThreads, nBatch, variant,
    freeMB: free, totalMB: total, modelMB, budgetMB: budget, neededMB: estimateMB(modelMB, chosen),
    tight, reduced: chosen < CTX_LADDER[0],
    message,
    reason: 'free=' + free + ' Mo, budget 70 % = ' + budget + ' Mo, estimation ' + estimateMB(modelMB, chosen) + ' Mo',
  };
}

// Sous pression pendant un run : on divise le contexte par deux, jamais en
// silence (le message accompagne la decision).
function underPressure(currentCtx, freeMB) {
  const ctx = Number(currentCtx) > 0 ? Number(currentCtx) : 2048;
  const free = Number(freeMB) >= 0 ? Number(freeMB) : freeRamMB();
  if (free >= MIN_FREE_WARN_MB) return { changed: false, nCtx: ctx, message: '' };
  const next = Math.max(512, Math.floor(ctx / 2));
  return {
    changed: next !== ctx,
    nCtx: next,
    message: 'RAM libre faible (' + free + ' Mo) : le contexte du prochain appel passe de ' + ctx +
      ' a ' + next + ' jetons pour eviter un plantage.',
  };
}

// Catalogue minimal : RAM requise connue, pour guider le choix.
const CATALOG = [
  { id: 'Qwen2.5-Coder-0.5B-Instruct (Q4_K_M)', sizeMB: 400, ramMB: 1600 },
  { id: 'Qwen2.5-Coder-1.5B-Instruct (Q4_K_M)', sizeMB: 1100, ramMB: 2500 },
  { id: 'Qwen2.5-Coder-3B-Instruct (Q4_K_M)', sizeMB: 2000, ramMB: 4000 },
  { id: 'Qwen2.5-Coder-7B-Instruct (Q4_K_M)', sizeMB: 4700, ramMB: 8000 },
];

function catalogFor(freeMB) {
  const free = Number(freeMB) >= 0 ? Number(freeMB) : freeRamMB();
  return CATALOG.map((m) => Object.assign({}, m, {
    fits: m.ramMB <= free * 0.85,
    note: m.ramMB <= free * 0.85 ? 'tient dans la RAM libre' : 'demande plus de RAM que disponible',
  }));
}

module.exports = { decide, underPressure, catalogFor, estimateMB, freeRamMB, totalRamMB, catalog: CATALOG, SAFE_SHARE, CTX_LADDER };
