'use strict';
/**
 * P71-A3/A4 : enrichissement IA FACULTATIF, borne et explique.
 *
 * Regles tenues ici :
 *   - le prompt compact ne depasse jamais 70 % de la fenetre REELLE du runtime ;
 *   - le delai du client est CALCULE a partir de la vitesse mesuree (jetons/s),
 *     pas un 60 s fixe, avec un plancher et un plafond configurables ;
 *   - un echec rend une cause en francais et une action, jamais un
///     "delai depasse" muet ;
 *   - tout est journalisable en une ligne, sans secret.
 *
 * ASCII only.
 */
const RATIO_MAX = 0.70;

// Approximation documentee : ~3.6 caracteres par jeton sur du texte FR/EN
// melange (code inclus). Sert a DECIDER ; les chiffres publies viennent du
// runtime (usage.prompt_tokens) quand il les donne.
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 3.6));
}

function clip(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n[...tronque]';
}

/** Contexte compact : jamais le depot entier, borne par la fenetre reelle. */
function compactContext(analysis, opts) {
  opts = opts || {};
  const windowTokens = Math.max(256, Number(opts.windowTokens) || 2048);
  const ratio = Math.min(RATIO_MAX, Number(opts.ratio) || RATIO_MAX);
  const maxTokens = Math.floor(windowTokens * ratio);
  const maxChars = Math.floor(maxTokens * 3.6);
  const a = analysis || {};
  const parts = [];
  parts.push('Projet: ' + (a.name || '?'));
  if (a.stats) parts.push('Fichiers: ' + a.stats.files + ' | lignes: ' + a.stats.lines);
  const langs = Object.entries((a.stats && a.stats.byLang) || {})
    .map(([k, v]) => k + ':' + (v.files || 0)).slice(0, 6);
  if (langs.length) parts.push('Langages: ' + langs.join(', '));
  const deps = [];
  for (const eco of a.deps || []) {
    for (const m of (eco.manifestDeps || []).slice(0, 10)) deps.push(m.name);
  }
  if (deps.length) parts.push('Dependances: ' + deps.slice(0, 20).join(', '));
  if (a.todos && a.todos.count) parts.push('TODO/FIXME: ' + a.todos.count);
  if (a.tests) parts.push('Tests: ' + (a.tests.count || 0) + ' fichier(s)');
  const arch = [];
  if (a.readme && a.readme.present) arch.push('README');
  if (a.ci && a.ci.present) arch.push('CI');
  if (arch.length) arch.push('');
  parts.push('Presents: ' + (arch.join(', ') || 'rien de notable'));
  const ctx = clip(parts.join('\n'), maxChars);
  const out = {
    context: ctx,
    windowTokens,
    maxTokens,
    ratioUsed: ratio,
    estimatedTokens: estimateTokens(ctx),
    maxChars,
  };
  if (out.estimatedTokens > maxTokens) {
    // Ne doit jamais arriver : on recoupe pour tenir la garantie.
    out.context = clip(ctx, Math.floor(maxChars * 0.9));
    out.estimatedTokens = estimateTokens(out.context);
  }
  return out;
}

/** Delai du client, calcule sur la vitesse mesuree. */
function deadlineMs(info) {
  info = info || {};
  const tokPerSec = Math.max(1, Number(info.tokPerSec) || 12);
  const promptTokens = Math.max(0, Number(info.promptTokens) || 0);
  const maxOutTokens = Math.max(1, Number(info.maxOutTokens) || 300);
  const floor = Math.max(1000, Number(info.floorMs) || 30000);
  const ceiling = Math.max(floor, Number(info.ceilingMs) || 180000);
  const readMs = (promptTokens / tokPerSec) * 1000;
  const genMs = (maxOutTokens / tokPerSec) * 1000;
  const margin = 8000;
  const raw = readMs + genMs + margin;
  const ms = Math.max(floor, Math.min(ceiling, Math.round(raw)));
  return {
    ms, raw: Math.round(raw), floorMs: floor, ceilingMs: ceiling,
    readMs: Math.round(readMs), genMs: Math.round(genMs), marginMs: margin,
    clamped: raw > ceiling ? 'plafond' : (raw < floor ? 'plancher' : 'aucun'),
    tokPerSec,
  };
}

/** Cause reelle d'un echec, en francais, avec l'action proposee. */
function classify(err, info) {
  info = info || {};
  const status = err && err.response ? Number(err.response.status) : 0;
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  const windowTokens = Number(info.windowTokens) || 0;
  const promptTokens = Number(info.promptTokens) || 0;

  if (status === 503) {
    return { code: 'busy', message: 'Le runtime est vivant mais aucun modele n est charge.',
      action: 'Ouvrez Runtime & Models et chargez un modele, puis relancez l enrichissement.' };
  }
  if (code === 'ECONNREFUSED') {
    return { code: 'offline', message: 'Runtime IA injoignable (connexion refusee).',
      action: 'Demarrez le runtime (port 6000), puis relancez.' };
  }
  if (windowTokens && promptTokens && promptTokens > windowTokens) {
    return { code: 'window',
      message: 'Fenetre de contexte depassee : ' + promptTokens + ' jetons de prompt pour une fenetre de ' + windowTokens + '.',
      action: 'Reduisez le contexte (bouton Recommandations deterministes) ou augmentez n_ctx du runtime.' };
  }
  if (code === 'ECONNABORTED' || /timeout/i.test(msg) || /delai/i.test(msg)) {
    const ms = info.deadlineMs || 0;
    const measured = info.tokPerSec ? ('vitesse mesuree ' + info.tokPerSec + ' jetons/s') : 'vitesse non mesuree';
    return { code: 'slow',
      message: 'Le runtime n a pas fini dans le delai calcule (' + Math.round(ms / 1000) + ' s, ' + measured + ').',
      action: 'Relancez (le modele est deja charge, la lecture du prompt sera plus rapide) ou baissez max_tokens.' };
  }
  if (status >= 500) {
    return { code: 'server', message: 'Le runtime a renvoye une erreur interne (HTTP ' + status + ').',
      action: 'Consultez le journal runtime_debug, puis rechargez le modele.' };
  }
  return { code: 'other', message: 'Echec de l enrichissement : ' + (msg || ('HTTP ' + status)).slice(0, 120),
    action: 'Les recommandations deterministes restent affichees ; relancez plus tard.' };
}

/** Une ligne de journal "analysis", sans secret. */
function journalLine(info) {
  info = info || {};
  const bits = [
    'analysis_ai',
    'prompt_tokens=' + (Number.isFinite(info.promptTokens) ? info.promptTokens : '?'),
    'window=' + (Number.isFinite(info.windowTokens) ? info.windowTokens : '?'),
    'ratio=' + (info.ratioUsed != null ? Number(info.ratioUsed).toFixed(2) : '?'),
    'max_out=' + (info.maxOutTokens != null ? info.maxOutTokens : '?'),
    'deadline_ms=' + (Number.isFinite(info.deadlineMs) ? info.deadlineMs : '?'),
    'duration_ms=' + (Number.isFinite(info.durationMs) ? info.durationMs : '?'),
    'tok_per_s=' + (Number.isFinite(info.tokPerSec) ? info.tokPerSec : '?'),
    'issue=' + (info.issue || 'ok'),
  ];
  return bits.join(' ');
}

module.exports = { RATIO_MAX, estimateTokens, compactContext, deadlineMs, classify, journalLine };
