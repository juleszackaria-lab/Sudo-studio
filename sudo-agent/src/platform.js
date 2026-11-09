// Sudo Agent platform bridge (P59-A).
//
// The agent must be able to USE every Sudo Studio feature from the prompt bar:
// security audit, project analysis, DevOps, Doctor, environment, logs,
// extensions, runtime, licence. This module is the single bridge:
//
//   - read tools   : return the LAST stored platform result (or run it once
//                    when nothing was ever stored, and say so);
//   - run tools    : execute the REAL engine and store the result;
//   - writes       : never written here. devops_generate returns the file
//                    content, the model writes it through write/edit/patch,
//                    which are already approval-gated. So the platform layer
//                    cannot bypass the diff/approval system.
//
// Sources, honest by construction:
//   local engine (biz.js)  : security audit, project analysis, logs, doctor
//                            fallback. Real walks of the project root.
//   backend HTTP           : doctor (POST /api/system/doctor), devops templates
//                            (POST /api/devops/generate), environment
//                            (GET /api/environment/status), runtime
//                            (GET /api/supervisor/runtime-status), edition
//                            (GET /api/platform/edition).
//   Never consumed          : POST /api/project/analyze. That route returns
//                            HARDCODED demo numbers (142 files, 2 vulnerable
//                            deps). Presenting them as a real analysis would
//                            be a lie, so the agent uses the real analyzer and
//                            the fact is journaled.
//
// Result rules (P59-3):
//   - bounded: never more than 25% of n_ctx per result (chars = 4 * tokens);
//   - secrets NEVER in clear: file, line, type and a masked value only;
//   - editions respected: a feature outside the edition answers
//     "fonction non incluse dans votre edition" and is never worked around.
//
// Pure Node + stdlib. ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const biz = require('./biz');

// --------------------------------------------------------------- tool specs
// domain is what the pre-router (router.js) turns on. feature is the licence
// feature name used by the backend (license.middleware.js).
const SPECS = {
  security_audit_read: {
    domain: 'security', kind: 'read', feature: 'security', mutating: false,
    description: 'Dernier resultat du Security Audit (secrets + dependances vulnerables).',
    props: {}, required: [],
  },
  security_audit_run: {
    domain: 'security', kind: 'run', feature: 'security', mutating: false,
    description: 'Relance le Security Audit du projet et enregistre le score.',
    props: { deep: { type: 'boolean', description: 'Scan complet.' } }, required: [],
  },
  project_analysis_read: {
    domain: 'analysis', kind: 'read', feature: null, mutating: false,
    description: 'Derniere Project Analysis (structure, langages, tests, TODO, score).',
    props: {}, required: [],
  },
  project_analysis_run: {
    domain: 'analysis', kind: 'run', feature: null, mutating: false,
    description: 'Relance la Project Analysis du projet et enregistre le resultat.',
    props: {}, required: [],
  },
  devops_read: {
    domain: 'devops', kind: 'read', feature: 'devops', mutating: false,
    description: 'Pipelines et erreurs DevOps du projet (CI, Dockerfile, compose).',
    props: {}, required: [],
  },
  devops_generate: {
    domain: 'devops', kind: 'run', feature: 'devops', mutating: false,
    description: 'Genere un fichier DevOps (dockerfile|github-actions|...) ; le fichier est ecrit par write/edit avec approbation.',
    props: {
      type: { type: 'string', description: 'dockerfile|docker-compose|github-actions|gitlab-ci|kubernetes|nginx|env.' },
      stack: { type: 'string', description: 'node|python|dart|java|go|rust.' },
    }, required: ['type'],
  },
  doctor_read: {
    domain: 'doctor', kind: 'read', feature: 'doctor', mutating: false,
    description: 'Dernier diagnostic System Doctor (outils, runtime, systeme).',
    props: {}, required: [],
  },
  doctor_run: {
    domain: 'doctor', kind: 'run', feature: 'doctor', mutating: false,
    description: 'Relance le System Doctor (diagnostic seulement, aucune installation).',
    props: {}, required: [],
  },
  environment_read: {
    domain: 'doctor', kind: 'read', feature: 'environment', mutating: false,
    description: 'Etat de l environnement de developpement (SDK, versions).',
    props: {}, required: [],
  },
  logs_read: {
    domain: 'logs', kind: 'read', feature: null, mutating: false,
    description: 'Lignes des journaux (runtime, backend, agent), filtrees par niveau.',
    props: {
      niveau: { type: 'string', description: 'ERROR|WARN|INFO (defaut ERROR).' },
      lignes: { type: 'integer', description: 'Nombre de lignes (defaut 40, max 200).' },
      fichier: { type: 'string', description: 'runtime|backend|agent (defaut : tous).' },
    }, required: [],
  },
  runtime_status: {
    domain: 'doctor', kind: 'read', feature: null, mutating: false,
    description: 'Etat du runtime local (sante, modele, port) et du backend.',
    props: {}, required: [],
  },
  license_status: {
    domain: 'security', kind: 'read', feature: null, mutating: false,
    description: 'Edition et fonctions incluses dans la licence.',
    props: {}, required: [],
  },
};

const TOOL_NAMES = Object.keys(SPECS);

function isPlatformTool(name) { return Object.prototype.hasOwnProperty.call(SPECS, name); }
function specOf(name) { return SPECS[name] || null; }

// ------------------------------------------------------------------ budget
// 25% of the context, per result. Chars = 4 * tokens (same estimate the rest
// of the agent uses, see profiles.estimateTokens).
function budgetChars(ctxTokens) {
  const t = Number.isFinite(Number(ctxTokens)) && Number(ctxTokens) > 0 ? Number(ctxTokens) : 2048;
  return Math.max(600, Math.floor(t * 4 * 0.25));
}

function cut(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 20)) + '\n... [tronque ' + (s.length - max) + ' car.]';
}

// ------------------------------------------------------------ secret masking
// A secret value never leaves this function in clear. Only the shape survives.
function maskValue(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!s) return '***';
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '***' + s.slice(-1);
}

// Deep mask for any object that could carry a raw secret. Keys that are known
// carriers are replaced; scanning results only keep file/line/type anyway.
const SECRET_KEYS = /^(value|secret|token|password|passwd|key|apikey|api_key|authorization|bearer|cookie|match|snippet|line_text|content)$/i;
function maskDeep(obj, depth) {
  const d = depth || 0;
  if (d > 6) return '***';
  if (Array.isArray(obj)) return obj.slice(0, 200).map((x) => maskDeep(x, d + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (SECRET_KEYS.test(k)) { out[k] = maskValue(obj[k]); continue; }
      out[k] = maskDeep(obj[k], d + 1);
    }
    return out;
  }
  return obj;
}

// --------------------------------------------------------------- persistence
function platformDir(home) {
  const base = home || process.env.SUDO_STUDIO_HOME || process.cwd();
  return path.join(base, 'platform');
}
function lastPath(home, kind) { return path.join(platformDir(home), kind + '-last.json'); }

function saveLast(home, kind, payload) {
  try {
    const dir = platformDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const body = Object.assign({ at: new Date().toISOString() }, payload);
    fs.writeFileSync(lastPath(home, kind), JSON.stringify(body, null, 1), 'utf8');
    return true;
  } catch (_) { return false; }
}
function readLast(home, kind) {
  try { return JSON.parse(fs.readFileSync(lastPath(home, kind), 'utf8')); }
  catch (_) { return null; }
}

// ------------------------------------------------------------ backend client
function backendConfig(ctx) {
  const raw = (ctx && ctx.backendUrl) || process.env.SUDO_BACKEND_URL || '';
  let base = raw;
  if (!base) base = 'http://127.0.0.1:' + (process.env.SUDO_BACKEND_PORT || '5000');
  const token = (ctx && ctx.backendToken) || process.env.SUDO_BACKEND_TOKEN ||
    process.env.SUDO_AGENT_TOKEN || '';
  return { base: String(base).replace(/\/+$/, ''), token };
}

// Resolves { ok, status, body, error, code }. Never throws.
function backendCall(ctx, method, p, body, timeoutMs) {
  const cfg = backendConfig(ctx);
  return new Promise((resolve) => {
    let url = null;
    try { url = new URL(cfg.base + p); } catch (_) { resolve({ ok: false, code: 'bad_backend', error: 'URL backend invalide' }); return; }
    const lib = url.protocol === 'https:' ? require('https') : http;
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = {};
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = lib.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: timeoutMs || 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', (e) => {
      const msg = String((e && e.message) || e);
      resolve({ ok: false, code: 'backend_offline', error: msg, status: 0 });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- editions
// The backend is the only source of truth for the edition. When it cannot be
// reached we DO NOT guess: the feature is reported as "verification impossible"
// and the read tools that only need the local engine stay available.
let editionCache = null;
async function edition(ctx) {
  if (editionCache && Date.now() - editionCache.at < 30000) return editionCache.value;
  const r = await backendCall(ctx, 'GET', '/api/platform/edition', null, 3000);
  let value;
  if (r.ok && r.body && r.body.edition) value = { known: true, edition: r.body.edition, features: r.body.features || {} };
  else value = { known: false, edition: (process.env.SUDO_EDITION || 'inconnue'), features: {} };
  editionCache = { at: Date.now(), value };
  return value;
}
function resetEditionCache() { editionCache = null; }

async function featureAllowed(ctx, feature) {
  if (!feature) return { allowed: true, known: true };
  const ed = await edition(ctx);
  if (!ed.known) return { allowed: true, known: false, edition: ed.edition };
  const v = ed.features[feature];
  if (v === undefined) return { allowed: true, known: true, edition: ed.edition };
  return { allowed: !!v, known: true, edition: ed.edition };
}

function notInEdition(feature, ed) {
  return {
    ok: false, code: 'not_in_edition',
    error: 'fonction non incluse dans votre edition' + (feature ? ' (' + feature + ')' : '') +
      (ed && ed.edition ? ' - edition ' + ed.edition : ''),
  };
}

// ------------------------------------------------------------------ engines
// Deterministic score: secrets weigh more than advisories. Never negative.
function securityScore(r) {
  const s = (r && Array.isArray(r.secrets) ? r.secrets.length : 0);
  const a = (r && Array.isArray(r.advisories) ? r.advisories.length : 0);
  return Math.max(0, 100 - 12 * s - 6 * a);
}

function runSecurity(ctx) {
  const r = biz.secaudit(ctx.root);
  // P59-5: the previous stored score travels with the new one, so "before /
  // after" is a fact of the same series, never a model claim.
  const prev = readLast(ctx.home, 'security');
  // Findings: file/line/type only. The value is masked at the source.
  const secrets = (r.secrets || []).slice(0, 200).map((s) => ({
    fichier: s.rel || s.file, ligne: s.line, type: s.label || s.type,
    // biz.secaudit already reduces the match to a hint ("api_... (26 car.)");
    // maskValue is applied again so a raw value can never slip through.
    valeur: maskValue(s.hint || s.match || s.value || ''),
  }));
  const advisories = (r.advisories || []).slice(0, 200).map((a) => ({
    cve: a.cve, paquet: a.pkg || a.package, version: a.version,
    gravite: a.severity || a.gravite, titre: a.title,
  }));
  const score = securityScore(r);
  const out = {
    score,
    scoreAvant: prev && Number.isFinite(prev.score) ? prev.score : null,
    delta: prev && Number.isFinite(prev.score) ? score - prev.score : null,
    secrets, advisories,
    fichiersAnalyses: r.secretFiles || r.filesScanned || 0,
    source: 'moteur local (analyse reelle du projet)',
  };
  saveLast(ctx.home, 'security', out);
  return out;
}

function runAnalysis(ctx) {
  const a = biz.analyze(ctx.root);
  const langages = {};
  for (const k of Object.keys(a.byLang || {})) {
    const v = a.byLang[k];
    langages[k] = (v && v.files !== undefined) ? v.files : v;
  }
  // "Ce qui est a ameliorer": deterministic facts, never invented.
  const problemes = [];
  if (!a.tests || (a.tests.files !== undefined && a.tests.files === 0)) problemes.push('aucun test detecte');
  if (!a.ci || (Array.isArray(a.ci) && a.ci.length === 0)) problemes.push('aucune CI detectee');
  if (!a.readme) problemes.push('README absent');
  if (a.todo) problemes.push(a.todo + ' TODO');
  if (a.fixme) problemes.push(a.fixme + ' FIXME');
  if ((a.skipped || 0) > 0) problemes.push(a.skipped + ' entree(s) ignoree(s) (dossiers techniques)');
  const out = {
    fichiers: a.files !== undefined ? a.files : null,
    dossiers: a.dirs !== undefined ? a.dirs : null,
    lignes: a.lines !== undefined ? a.lines : null,
    langages,
    manifestes: (a.manifests || []).slice(0, 12),
    tests: a.tests || null,
    ci: a.ci || null,
    readme: a.readme || null,
    todo: a.todo || 0,
    fixme: a.fixme || 0,
    plusGros: (a.biggest || []).slice(0, 5),
    problemes,
    source: 'moteur local (analyse reelle du projet)',
  };
  saveLast(ctx.home, 'analysis', out);
  return out;
}

// DevOps read: real files of the project, plus their parse status. No backend
// call: what a pipeline "is" lives in the repo, not in a server.
function runDevopsRead(ctx) {
  const found = [];
  const errors = [];
  const wfDir = path.join(ctx.root, '.github', 'workflows');
  try {
    for (const f of fs.readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const p = path.join(wfDir, f);
      const txt = fs.readFileSync(p, 'utf8');
      const rec = { fichier: '.github/workflows/' + f, taille: txt.length, etapes: (txt.match(/^\s*-\s+name:/gm) || []).length };
      if (/\t/.test(txt)) { rec.erreur = 'tabulation dans un YAML (interdit)'; errors.push(rec.fichier + ' : tabulation'); }
      if (!/^on:/m.test(txt)) { rec.erreur = "'on:' absent"; errors.push(rec.fichier + " : 'on:' absent"); }
      if (!/^jobs:/m.test(txt)) { rec.erreur = "'jobs:' absent"; errors.push(rec.fichier + " : 'jobs:' absent"); }
      found.push(rec);
    }
  } catch (_) { /* pas de workflows */ }
  for (const rel of ['.gitlab-ci.yml', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore']) {
    try {
      const p = path.join(ctx.root, rel);
      const st = fs.statSync(p);
      if (st.isFile()) found.push({ fichier: rel, taille: st.size, etapes: null });
    } catch (_) { /* absent */ }
  }
  const out = { pipelines: found, erreurs: errors.slice(0, 20), nb: found.length, source: 'fichiers du projet (lecture reelle)' };
  saveLast(ctx.home, 'devops', out);
  return out;
}

async function runDoctor(ctx) {
  const r = await backendCall(ctx, 'POST', '/api/system/doctor', {}, 15000);
  if (r.ok && r.body && Array.isArray(r.body.results)) {
    const out = {
      score: r.body.score, checks: r.body.results.map((c) => ({ nom: c.name, statut: c.status, valeur: c.value, correctif: c.fix || null })),
      manquants: r.body.results.filter((c) => c.status === 'error').map((c) => c.name),
      source: 'backend /api/system/doctor (reel)',
    };
    saveLast(ctx.home, 'doctor', out);
    return out;
  }
  // Backend unreachable: the local doctor is still real (it probes the same
  // tools), and the source line says so.
  const local = await biz.doctor();
  const checks = (local.checks || []).map((c) => ({ nom: c.name, statut: c.status, valeur: c.value, correctif: c.fix || null }));
  const out = {
    score: checks.length ? Math.round((checks.filter((c) => c.statut === 'ok').length / checks.length) * 100) : null,
    checks, manquants: checks.filter((c) => c.statut === 'error').map((c) => c.nom),
    source: 'moteur local (backend injoignable)',
  };
  saveLast(ctx.home, 'doctor', out);
  return out;
}

const LOG_FILES = { runtime: ['runtime.log'], backend: ['backend.log'], agent: ['agent.log', 'agent-json.log'] };
function logsDir(home) {
  const env = process.env.SUDO_STUDIO_LOGS;
  if (env) return env;
  const candidates = [path.join(home || '', 'logs'), path.join(home || '', 'data', 'logs')];
  return candidates.find((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } }) || candidates[0];
}
function readLogs(ctx, args) {
  const level = String(args.niveau || args.level || 'ERROR').toUpperCase();
  const n = Math.min(200, Math.max(1, parseInt(args.lignes || args.lines, 10) || 40));
  const which = String(args.fichier || '').toLowerCase();
  const dir = logsDir(ctx.home);
  const files = [];
  for (const k of Object.keys(LOG_FILES)) {
    if (which && which !== 'tous' && which !== 'all' && which !== k) continue;
    for (const base of LOG_FILES[k]) {
      const p = path.join(dir, base);
      try { if (fs.statSync(p).isFile()) files.push({ kind: k, p }); } catch (_) { /* absent */ }
    }
  }
  const hits = [];
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f.p, 'utf8'); } catch (_) { continue; }
    const lines = txt.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && hits.length < n * 4; i--) {
      const line = lines[i];
      if (!line) continue;
      const isLevel = level === 'ALL' || new RegExp('\\b' + level + '\\b', 'i').test(line);
      if (!isLevel) continue;
      hits.push({ fichier: f.kind, ligne: maskSecretsInLine(line).slice(0, 300) });
      if (hits.length >= n) break;
    }
    if (hits.length >= n) break;
  }
  return {
    niveau: level, demandees: n, trouvees: hits.length,
    lignes: hits.slice(0, n), dossier: dir,
    source: files.length ? 'journaux locaux (lecture reelle)' : 'aucun journal trouve',
  };
}

function maskSecretsInLine(line) {
  return String(line)
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)("[^"]{6,}"|'[^']{6,}'|[A-Za-z0-9_\-\.]{8,})/gi, (m, p1) => p1 + '***')
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,})\b/g, '***');
}

async function runtimeStatus(ctx) {
  const sup = await backendCall(ctx, 'GET', '/api/supervisor/runtime-status', null, 4000);
  const port = process.env.SUDO_RUNTIME_PORT || '6000';
  const health = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: '/health', method: 'GET', timeout: 2500 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { b = null; } resolve({ ok: res.statusCode === 200, status: res.statusCode, body: b }); });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: String(e.message || e) }));
    req.end();
  });
  return {
    runtime: { port: Number(port), joignable: health.ok, http: health.status || 0, modele: (health.body && (health.body.model || health.body.model_id)) || null },
    superviseur: sup.ok ? sup.body : { joignable: false, erreur: sup.error || 'backend injoignable' },
    source: 'sondes reelles (/health + superviseur)',
  };
}

async function licenseStatus(ctx) {
  const ed = await edition(ctx);
  return {
    edition: ed.edition,
    verification: ed.known ? 'backend (reelle)' : 'impossible (backend injoignable) - valeur non verifiee',
    fonctions: ed.features,
  };
}

// ------------------------------------------------------------------ summaries
// One bounded French summary per tool. The model gets this text; the full
// (already masked) object travels in data for the UI.
function summarize(name, r, maxChars) {
  let s = '';
  if (name === 'security_audit_run' || name === 'security_audit_read') {
    s = 'Security Audit : score ' + r.score + '/100' +
      (Number.isFinite(r.scoreAvant) ? ' (avant ' + r.scoreAvant + ', ' + (r.delta >= 0 ? '+' : '') + r.delta + ')' : '') +
      ', ' + r.secrets.length + ' secret(s), ' + r.advisories.length + ' dependance(s) vulnerable(s).\n' +
      r.secrets.slice(0, 10).map((x) => '- ' + x.type + ' ' + x.fichier + ':' + x.ligne + ' valeur ' + x.valeur).join('\n') +
      (r.advisories.length ? '\n' + r.advisories.slice(0, 10).map((a) => '- ' + (a.cve || '?') + ' ' + (a.paquet || '') + ' ' + (a.gravite || '')).join('\n') : '');
  } else if (name === 'project_analysis_run' || name === 'project_analysis_read') {
    const langs = Object.keys(r.langages || {}).slice(0, 6).map((k) => k + ':' + r.langages[k]).join(', ');
    s = 'Project Analysis : ' + (r.fichiers === null || r.fichiers === undefined ? '?' : r.fichiers) + ' fichier(s), ' +
      (r.lignes === null || r.lignes === undefined ? '?' : r.lignes) + ' ligne(s).\n' +
      'Langages : ' + (langs || 'inconnus') + '\n' +
      'Tests : ' + (r.tests ? JSON.stringify(r.tests).slice(0, 120) : 'aucun') + ' | CI : ' + (r.ci ? JSON.stringify(r.ci).slice(0, 100) : 'aucune') + '\n' +
      (r.problemes && r.problemes.length ? 'A ameliorer : ' + r.problemes.slice(0, 8).join(' | ') : 'Aucun probleme detecte.');
  } else if (name === 'devops_read') {
    s = 'DevOps : ' + r.nb + ' fichier(s) de pipeline/docker.\n' +
      r.pipelines.slice(0, 12).map((p) => '- ' + p.fichier + (p.etapes ? ' (' + p.etapes + ' etapes)' : '') + (p.erreur ? ' ERREUR: ' + p.erreur : '')).join('\n') +
      (r.erreurs.length ? '\nErreurs : ' + r.erreurs.join(' | ') : '');
  } else if (name === 'doctor_run' || name === 'doctor_read') {
    s = 'System Doctor : score ' + (r.score === null ? '?' : r.score) + '/100. Manquants : ' + (r.manquants.length ? r.manquants.join(', ') : 'aucun') + '.\n' +
      r.checks.slice(0, 14).map((c) => '- ' + c.nom + ' : ' + c.statut + (c.valeur ? ' (' + c.valeur + ')' : '')).join('\n');
  } else if (name === 'logs_read') {
    s = 'Journaux ' + r.niveau + ' : ' + r.trouvees + ' ligne(s) trouvee(s) dans ' + r.dossier + '.\n' + r.lignes.slice(0, 20).map((l) => '[' + l.fichier + '] ' + l.ligne).join('\n');
  } else if (name === 'runtime_status') {
    s = 'Runtime : ' + (r.runtime.joignable ? 'joignable' : 'INJOIGNABLE') + ' sur le port ' + r.runtime.port +
      (r.runtime.modele ? ' (modele ' + r.runtime.modele + ')' : '') + '. Superviseur : ' + (r.superviseur && r.superviseur.joignable !== false ? 'joignable' : 'injoignable') + '.';
  } else if (name === 'license_status') {
    s = 'Edition : ' + r.edition + ' (' + r.verification + ').';
  } else if (name === 'environment_read') {
    s = 'Environnement : ' + cut(JSON.stringify(r.data || r), 400);
  } else if (name === 'devops_generate') {
    s = 'Fichier genere : ' + r.fichier + ' (' + r.contenu.length + ' car.). Ecris-le avec write/edit (approbation).';
  } else {
    s = cut(JSON.stringify(r), 400);
  }
  return cut(s, maxChars);
}

// -------------------------------------------------------------------- runner
// ctx: { root, home, log, corr, ctxTokens, backendUrl, backendToken }
// Returns { ok, code?, error?, data, summary, tool }.
async function run(ctx, name, args) {
  const spec = SPECS[name];
  if (!spec) return { ok: false, code: 'unknown_tool', error: 'outil plateforme inconnu : ' + String(name).slice(0, 40) };
  const maxChars = budgetChars(ctx.ctxTokens);
  const a = args && typeof args === 'object' ? args : {};

  // Edition gate first: an excluded function must answer clearly, never
  // "run anyway" (P59-2).
  if (spec.feature) {
    const g = await featureAllowed(ctx, spec.feature);
    if (g.known && !g.allowed) {
      const ed = await edition(ctx);
      return Object.assign({ tool: name, data: { edition: ed.edition, feature: spec.feature } }, notInEdition(spec.feature, ed));
    }
  }

  let payload = null;
  try {
    switch (name) {
      case 'security_audit_run':
        payload = runSecurity(ctx); break;
      case 'security_audit_read': {
        const last = readLast(ctx.home, 'security');
        if (last) { payload = last; payload.reused = true; break; }
        payload = runSecurity(ctx);
        payload.firstRun = true;
        break;
      }
      case 'project_analysis_run':
        payload = runAnalysis(ctx); break;
      case 'project_analysis_read': {
        const last = readLast(ctx.home, 'analysis');
        if (last) { payload = last; payload.reused = true; break; }
        payload = runAnalysis(ctx);
        payload.firstRun = true;
        break;
      }
      case 'devops_read':
        payload = runDevopsRead(ctx); break;
      case 'devops_generate': {
        const type = String(a.type || '').trim();
        if (!type) return { ok: false, code: 'bad_args', error: 'devops_generate : type requis (dockerfile, github-actions, ...)' };
        const r = await backendCall(ctx, 'POST', '/api/devops/generate', { type, stack: a.stack || 'node', options: {} }, 15000);
        if (r.status === 403) {
          const b = r.body || {};
          return { tool: name, ok: false, code: 'not_in_edition', data: { edition: b.edition, feature: b.feature },
            error: 'fonction non incluse dans votre edition (' + (b.feature || 'cicd') + ') - edition ' + (b.edition || '?') };
        }
        if (!r.ok || !r.body) return { tool: name, ok: false, code: 'backend_offline', error: 'backend injoignable pour devops_generate' };
        payload = { fichier: r.body.filename || r.body.file || type, contenu: String(r.body.content || ''), source: 'backend /api/devops/generate (reel)' };
        break;
      }
      case 'doctor_run':
        payload = await runDoctor(ctx); break;
      case 'doctor_read': {
        const last = readLast(ctx.home, 'doctor');
        if (last) { payload = last; payload.reused = true; break; }
        payload = await runDoctor(ctx);
        payload.firstRun = true;
        break;
      }
      case 'environment_read': {
        const r = await backendCall(ctx, 'GET', '/api/environment/status', null, 8000);
        if (r.status === 403) {
          const b = r.body || {};
          return { tool: name, ok: false, code: 'not_in_edition', data: { edition: b.edition, feature: b.feature },
            error: 'fonction non incluse dans votre edition (' + (b.feature || 'environment') + ') - edition ' + (b.edition || '?') };
        }
        if (!r.ok) return { tool: name, ok: false, code: 'backend_offline', error: 'backend injoignable pour environment_read' };
        payload = { data: r.body, source: 'backend /api/environment/status (reel)' };
        break;
      }
      case 'logs_read':
        payload = readLogs(ctx, a); break;
      case 'runtime_status':
        payload = await runtimeStatus(ctx); break;
      case 'license_status':
        payload = await licenseStatus(ctx); break;
      default:
        return { ok: false, code: 'unknown_tool', error: 'outil plateforme inconnu' };
    }
  } catch (e) {
    return { tool: name, ok: false, code: 'platform_error', error: name + ' : ' + String((e && e.message) || e).slice(0, 200) };
  }

  const safe = maskDeep(payload);
  const summary = summarize(name, safe, maxChars);
  return { ok: true, tool: name, data: safe, summary, chars: summary.length };
}

module.exports = {
  SPECS, TOOL_NAMES, isPlatformTool, specOf, run, summarize, maskValue, maskDeep,
  maskSecretsInLine, budgetChars, securityScore, saveLast, readLast, platformDir,
  backendCall, edition, featureAllowed, resetEditionCache, readLogs, logsDir,
};
