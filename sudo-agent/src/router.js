// Sudo Agent deterministic pre-router (P59-B).
//
// A 1.5B model cannot pick the right tool among thirty. So the AGENT decides
// the domain BEFORE the model speaks, from keywords (French and English), and
// then:
//   1. exposes at most MAX_EXPOSED platform tools for this turn,
//   2. pre-fetches the matching READ tool and injects its (bounded, masked)
//      result into the context, so the model only has to reason, not search.
//
// Deterministic: same prompt, same route. No model call, no randomness.
// Order matters: the first domain with the best score wins; ties are broken
// by the fixed DOMAIN order below.
// ASCII only.
'use strict';

const MAX_EXPOSED = 6;

// [domain, regex, weight]. Folded text (accents stripped) is tested.
const RULES = [
  ['security', /\b(securit\w*|securis\w*|security|audit\w*|failles?|vulnerab\w*|vuln\w*|secrets?|fuites?|cve|pentest|exploit\w*)\b/, 3],
  ['analysis', /\b(analyse?|analysis|analyz\w*|structure|amelior\w*|improve\w*|qualite|quality|maintenab\w*|complexit\w*|refactor\w*)\b/, 2],
  ['devops', /\b(devops|pipelines?|ci|cd|workflows?|yaml|yml|docker\w*|kubernetes|k8s|deploy\w*|deploi\w*|gitlab|jenkins)\b/, 3],
  ['doctor', /\b(doctor|docteur|diagnostic|manqu\w*|missing|installe\w*|install\w*|environnement|environment|sdk|prerequis|prerequisites?)\b/, 2],
  ['logs', /\b(journaux|journal|logs?|erreurs?|errors?|traces?|crash\w*|exception\w*|stack ?trace)\b/, 2],
  ['extensions', /\b(extensions?|skills?|competences?|mcp|plugins?|outils? externes?)\b/, 2],
];

// Platform tools exposed per domain (<= MAX_EXPOSED). Core tools (read/edit/
// bash/...) stay available: this list only decides the platform surface.
const DOMAIN_TOOLS = {
  security: ['security_audit_read', 'security_audit_run', 'license_status'],
  analysis: ['project_analysis_read', 'project_analysis_run', 'logs_read'],
  devops: ['devops_read', 'devops_generate', 'logs_read'],
  doctor: ['doctor_read', 'doctor_run', 'environment_read', 'runtime_status'],
  logs: ['logs_read', 'runtime_status', 'doctor_read'],
  extensions: ['extensions_list', 'extensions_describe', 'mcp_call', 'skill_load', 'task'],
};

const DOMAIN_PREFETCH = {
  security: 'security_audit_read',
  analysis: 'project_analysis_read',
  devops: 'devops_read',
  doctor: 'doctor_read',
  logs: 'logs_read',
  extensions: 'extensions_list',
};

function fold(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5]/g, 'a')
    .replace(/[\u00e8\u00ea\u00eb\u00e9]/g, 'e')
    .replace(/[\u00ee\u00ef\u00ec\u00ed]/g, 'i')
    .replace(/[\u00f4\u00f6\u00f2\u00f3\u00f5]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g, 'u')
    .replace(/[\u00e7]/g, 'c')
    .replace(/[\u00f1]/g, 'n');
}

// Returns { domain|null, scores, tools, prefetch, hits }.
// domain is null when nothing matches: the turn keeps the full tool surface.
function route(prompt) {
  const t = fold(prompt);
  const scores = {};
  const hits = [];
  for (const [domain, re, weight] of RULES) {
    let n = 0;
    const m = t.match(new RegExp(re.source, 'g'));
    if (m) n = m.length;
    if (n > 0) {
      scores[domain] = (scores[domain] || 0) + n * weight;
      hits.push(domain);
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [domain] of RULES) {
    const s = scores[domain] || 0;
    if (s > bestScore) { best = domain; bestScore = s; }
  }
  const tools = best ? DOMAIN_TOOLS[best].slice(0, MAX_EXPOSED) : [];
  return {
    domain: best,
    scores,
    hits,
    tools,
    prefetch: best ? DOMAIN_PREFETCH[best] : null,
    reason: best ? ('mots-cles ' + best + ' score ' + bestScore) : 'aucun domaine detecte',
  };
}

// "corrige les failles" -> the full fix flow (P59-5). Detected deterministically.
const FIX_RE = /\b(corrige|corriger|fix|repare|reparer|rem[e\u00e9]die|resous|resoudre|patch)\b/;
function wantsFix(prompt) {
  const t = fold(prompt);
  if (!FIX_RE.test(t)) return false;
  return /\b(faill\w*|vulnerab\w*|securit\w*|security|audit\w*|devops|pipeline|erreurs?|bugs?)\b/.test(t);
}

module.exports = { route, wantsFix, MAX_EXPOSED, DOMAIN_TOOLS, DOMAIN_PREFETCH, fold };
