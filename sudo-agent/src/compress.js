// Sudo Agent context compression (P26-c, budget P61-16: 70 % max de n_ctx).
// Past the budget, old exchanges are summarized by the model; if the model
// gives nothing usable, a DETERMINISTIC summary takes over (the agent must
// never fail because the model failed). Stdlib only, ASCII only.
'use strict';

function summarizePrompt() {
  return [
    'Summarize this agent session for continuation. Keep, concisely:',
    '1. the current goal, 2. decisions taken, 3. MODIFIED FILES (exact paths',
    'and what changed), 4. ongoing errors with their last message.',
    'Drop chit-chat and superseded attempts. Answer with the summary only.',
  ].join('\n');
}

// Replace old history with [summary-marker, ...kept-tail].
// P61-16: la queue est BORNEE elle aussi (les gros resultats d'outils sont ce
// qui fait exploser le budget d'un petit modele) : 600 car. par resultat,
// 800 par message assistant, sans jamais couper un appel d'outil en deux.
function capTail(list) {
  return (list || []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const c = String(m.content === undefined || m.content === null ? '' : m.content);
    const max = m.role === 'tool' ? 600 : 800;
    if (c.length <= max) return m;
    return Object.assign({}, m, { content: c.slice(0, max) + ' [tronque ' + (c.length - max) + ' car.]' });
  });
}

function spliceHistory(summary, messages, keepTail) {
  keepTail = keepTail == null ? 4 : keepTail;
  const tail = capTail((messages || []).slice(-keepTail));
  const head = { role: 'system', content: '[Resume auto de la session (compression contexte)]:\n' + String(summary || '').slice(0, 4000) };
  return [head].concat(tail);
}

// P61-16: resume DETERMINISTE, sans appel modele. Utilise quand le fournisseur
// ne rend pas de resume (panne, reponse vide, petit modele qui repete) : la
// compression ne doit jamais echouer par dependance au modele.
// Regles : garde les APPELS D'OUTILS (outil + cible + code) et les erreurs, qui
// sont les faits utiles pour continuer ; borne a 3000 caracteres.
function deterministicSummary(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const files = [];
  const errors = [];
  const tools = [];
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const a = tc && tc.argsText ? String(tc.argsText) : '';
        const f = /"(?:file|from|dir|path)"\s*:\s*"([^"]{1,160})"/.exec(a);
        const line = String((tc && tc.name) || '?') + (f ? ' ' + f[1] : '');
        if (tools.indexOf(line) === -1) tools.push(line);
      }
    }
    if (m.role === 'tool') {
      let o = null;
      try { o = JSON.parse(String(m.content || '')); } catch (_) { o = null; }
      if (o && o.ok === false) {
        const e = String(o.error || o.code || '').slice(0, 120);
        if (e && errors.indexOf(e) === -1) errors.push(e);
      }
      const fm = /"rel"\s*:\s*"([^"]{1,160})"/.exec(String(m.content || ''));
      if (fm && files.indexOf(fm[1]) === -1) files.push(fm[1]);
    }
  }
  const parts = [];
  parts.push('Objectif et etat (resume deterministe, sans modele) : ' + msgs.length + ' messages compresses.');
  if (tools.length) parts.push('Appels d outils deja faits : ' + tools.slice(-20).join(', ') + '.');
  if (files.length) parts.push('Fichiers vus/modifies : ' + files.slice(-20).join(', ') + '.');
  if (errors.length) parts.push('Erreurs vues : ' + errors.slice(-8).join(' | ') + '.');
  return parts.join('\n').slice(0, 3000);
}

module.exports = { summarizePrompt, spliceHistory, deterministicSummary };
