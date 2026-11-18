// P65-B - profils de CAPACITE par modele, charges depuis une DONNEE.
//
// Pourquoi une donnee et pas du code : un modele americain, europeen ou
// fourni par le client doit pouvoir etre ajoute SANS toucher au moteur. Le
// moteur ne fait que LIRE un manifeste et appliquer les reglages.
//
// Ordre de priorite (le dernier gagne) :
//   1. defaults du manifeste ;
//   2. entree du modele (correspondance normalisee sur l'identifiant) ;
//   3. fichier ADMIN  <home>/capability-profiles.json  (meme schema, fusion
//      par modele) : l'administrateur peut corriger ou ajouter sans rebuild ;
//   4. variable d'environnement SUDO_AGENT_CAPABILITY (chemin d'un manifeste).
//
// Modele inconnu : profil PRUDENT + avertissement (jamais un plantage, jamais
// un profil optimiste silencieux).
//
// Stdlib only. ASCII only. Aucune valeur n'est une mesure : le manifeste dit
// lui-meme, champ par champ, si la valeur est 'policy' ou 'measured'.
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'sudo-capability-profiles/1';
const DEFAULT_FILE = path.join(__dirname, 'capability-profiles.json');

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (_) { return null; }
}

// "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF" -> "qwen2.5-coder-3b-instruct"
function normalizeId(id) {
  let s = String(id == null ? '' : id).trim().toLowerCase();
  // P67-D13: le nom AFFICHE par l'interface peut porter un suffixe de format
  // entre parentheses ("Qwen2.5-Coder-1.5B-Q4_K_M (GGUF)"). Il ne doit pas
  // empecher la reconnaissance du modele par le manifeste.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\\/g, '/');
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  s = s.replace(/[-_.]gguf$/i, '');
  s = s.replace(/[-_.](q\d[_a-z0-9]*|f16|f32|fp16|bf16|mxfp4)$/i, '');
  s = s.replace(/[-_.]q\d[-_a-z0-9]*$/i, '');
  s = s.replace(/[^a-z0-9.]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function merge(base, over) {
  const out = Object.assign({}, base || {});
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadManifest(home) {
  const packaged = readJson(DEFAULT_FILE);
  const envFile = process.env.SUDO_AGENT_CAPABILITY;
  const adminFile = home ? path.join(String(home), 'capability-profiles.json') : null;
  let out = packaged ? JSON.parse(JSON.stringify(packaged)) : {
    schema: SCHEMA, defaults: {}, unknown: {}, models: {},
  };
  const sources = ['paquet'];
  for (const f of [envFile, adminFile]) {
    if (!f) continue;
    const o = readJson(f);
    if (!o) continue;
    if (o.defaults) out.defaults = merge(out.defaults, o.defaults);
    if (o.unknown) out.unknown = merge(out.unknown, o.unknown);
    if (o.models && typeof o.models === 'object') {
      out.models = out.models || {};
      for (const k of Object.keys(o.models)) {
        const key = normalizeId(k);
        out.models[key] = merge(out.models[key], o.models[k]);
      }
    }
    sources.push(f);
  }
  out._sources = sources;
  return out;
}

// opts: { home, modelId, override }  (override = identifiant de profil impose)
// Renvoie TOUJOURS un objet exploitable :
//   { id, source: 'manifeste'|'inconnu'|'impose', warning, profile: {...} }
function resolve(modelId, opts) {
  opts = opts || {};
  const man = loadManifest(opts.home);
  const models = man.models || {};
  const base = man.defaults || {};
  const unk = man.unknown || {};
  const wanted = normalizeId(opts.override || modelId);

  if (opts.override && models[wanted]) {
    const p = merge(merge(base, models[wanted]), {});
    return { id: wanted, source: 'impose', warning: '', profile: p, sources: man._sources };
  }
  if (models[wanted]) {
    const p = merge(base, models[wanted]);
    return { id: wanted, source: 'manifeste', warning: '', profile: p, sources: man._sources };
  }
  // Correspondance tolerante : prefixe (variantes de quantisation) puis
  // suffixe (prefixe d'editeur : "meta-llama-3.1-8b-instruct" ->
  // "llama-3.1-8b-instruct"). Aucun nom d'editeur n'est code en dur.
  const keys = Object.keys(models);
  for (const k of keys) {
    if (wanted === k) continue;
    if (wanted.indexOf(k) === 0 || k.indexOf(wanted) === 0) {
      return { id: k, source: 'manifeste', warning: '', profile: merge(base, models[k]), sources: man._sources };
    }
  }
  const scored = [];
  for (const k of keys) {
    if (wanted.length > k.length && wanted.slice(-(k.length + 1)) === '-' + k) scored.push(k);
  }
  if (scored.length) {
    scored.sort((a, b) => b.length - a.length);
    const k = scored[0];
    return { id: k, source: 'manifeste', warning: '', profile: merge(base, models[k]), sources: man._sources };
  }
  // P67-D13: dernier recours AVANT "inconnu" : correspondance par JETONS.
  // "qwen2.5-coder-1.5b-q4_k_m-gguf" contient tous les jetons de la cle
  // "qwen2.5-coder-1.5b-instruct" (le suffixe "instruct" est un mot de
  // variante, pas une famille). Il faut au moins 3 jetons et la meme famille.
  const toks = (x) => String(x || '').split(/[-._]+/).filter((t) => t && t !== 'instruct' && t !== 'chat');
  const wt = toks(wanted);
  let best = null;
  for (const k of keys) {
    const kt = toks(k);
    if (kt.length < 3 || wt.length < 3) continue;
    if (kt[0] !== wt[0]) continue;
    const all = kt.every((t) => wt.indexOf(t) !== -1);
    if (!all) continue;
    if (!best || kt.length > toks(best).length) best = k;
  }
  if (best) {
    return { id: best, source: 'manifeste', warning: '', profile: merge(base, models[best]), sources: man._sources };
  }
  const prudent = merge(merge(base, unk), {});
  return {
    id: String(unk.id || 'prudent'),
    source: 'inconnu',
    warning: String(unk.warning || 'Modele inconnu du manifeste : profil prudent applique.'),
    profile: prudent,
    sources: man._sources,
  };
}

// Application a la liste d'outils : jamais plus que toolsMax, mais les outils
// de SORTIE (reply/done) et les outils COEUR (read/edit) ne partent JAMAIS :
// un modele a qui on retire `done` ne peut plus terminer son tour, et un
// modele a qui on retire `read` ne peut plus rien verifier. Un plafond ne doit
// jamais casser la boucle (regle P61-16).
const KEEP_ALWAYS = ['reply', 'done', 'read', 'edit'];
function limitTools(schemas, cap) {
  const n = Number(cap && cap.profile && cap.profile.toolsMax);
  const list = Array.isArray(schemas) ? schemas : [];
  if (!Number.isFinite(n) || n <= 0 || list.length <= n) return list;
  const nameOf = (x) => String((x && x.function && x.function.name) || (x && x.name) || '');
  const kept = list.filter((x) => KEEP_ALWAYS.indexOf(nameOf(x)) !== -1);
  const out = kept.slice();
  for (const x of list) {
    if (out.length >= n) break;
    if (out.indexOf(x) === -1) out.push(x);
  }
  // Ordre d'origine conserve (le modele voit toujours la meme surface).
  return list.filter((x) => out.indexOf(x) !== -1);
}

module.exports = { SCHEMA, DEFAULT_FILE, normalizeId, loadManifest, resolve, limitTools, merge };
