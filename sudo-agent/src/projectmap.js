// Sudo Agent project map + preload + deterministic fallback (P39-a/c/d).
// - buildProjectMap: root, depth-2 tree (60 entries max, dependency and
//   output dirs skipped), project type, EXISTING key files, token budget.
// - isGeneralQuestion / buildPreload: general questions ("explique ce
//   projet", ...) get README + manifests + deterministic mini-analysis
//   in context before the first model call.
// - notFoundHint: enriched not_found data (close files + parent listing).
// - deterministicFallback: last-resort answer when the loop detector fires
//   and the no-tools rescue round fails (labelled, deterministic).
// Sync fs, bounded, never throws (returns ok:false). Stdlib, ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');

const MAP_SKIP = ['node_modules', '.next', 'build', 'dist', '.dart_tool', '.git'];
const MAP_MAX_ENTRIES = 60;
const MAP_TOKEN_BUDGET = 1200;
const PRELOAD_README_CHARS = 3000;
const PRELOAD_TOTAL_CHARS = 6000;
const HINT_PARENT_MAX = 20;
const HINT_CLOSE_MAX = 5;
const FALLBACK_MAX_CHARS = 2500;

// Key files looked up at the project root (EXISTENCE only, cheap stats).
// [paths...] groups share one tag; the first existing path wins the label.
const KEY_GROUPS = [
  { tag: 'node', paths: ['package.json'] },
  { tag: 'node-lock', paths: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] },
  { tag: 'next', paths: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { tag: 'flutter', paths: ['pubspec.yaml'] },
  { tag: 'flutter-lock', paths: ['pubspec.lock'] },
  { tag: 'requirements', paths: ['requirements.txt'] },
  { tag: 'pyproject', paths: ['pyproject.toml'] },
  { tag: 'setup.py', paths: ['setup.py'] },
  { tag: 'go', paths: ['go.mod'] },
  { tag: 'rust', paths: ['Cargo.toml'] },
  { tag: 'maven', paths: ['pom.xml'] },
  { tag: 'gradle', paths: ['build.gradle', 'build.gradle.kts', 'settings.gradle'] },
  { tag: 'composer', paths: ['composer.json'] },
  { tag: 'gemfile', paths: ['Gemfile'] },
  { tag: 'tsconfig', paths: ['tsconfig.json'] },
  { tag: 'vite', paths: ['vite.config.js', 'vite.config.ts'] },
  { tag: 'docker', paths: ['Dockerfile'] },
  { tag: 'compose', paths: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'] },
  { tag: 'agents', paths: ['AGENTS.md'] },
  { tag: 'gitignore', paths: ['.gitignore'] },
];

function estTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function stripAccents(s) {
  // Unicode escapes stay ASCII in source; fold common French accents.
  return String(s || '').toLowerCase()
    .replace(/[\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5]/g, 'a')
    .replace(/[\u00e8\u00ea\u00eb\u00e9]/g, 'e')
    .replace(/[\u00ee\u00ef\u00ec\u00ed]/g, 'i')
    .replace(/[\u00f4\u00f6\u00f2\u00f3\u00f5]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g, 'u')
    .replace(/[\u00e7]/g, 'c').replace(/[\u00f1]/g, 'n')
    .replace(/[\u00ff]/g, 'y');
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function readDirNames(abs) {
  try {
    const names = fs.readdirSync(abs);
    names.sort();
    return names;
  } catch (_) { return null; }
}

// Depth-2 tree: root children (depth 1) + one level below each directory
// (depth 2). Skips MAP_SKIP at any level. Stops at MAP_MAX_ENTRIES.
function walkTree(root) {
  const lines = [];
  let total = 0; // entries seen (for the "+N autres" overflow note)
  const d1 = readDirNames(root) || [];
  const pending = [];
  for (const name of d1) {
    if (MAP_SKIP.indexOf(name) !== -1) continue;
    total += 1;
    let dir = false;
    try { dir = fs.statSync(path.join(root, name)).isDirectory(); } catch (_) { dir = false; }
    if (lines.length < MAP_MAX_ENTRIES) lines.push((dir ? name + '/' : name));
    if (dir) pending.push(name);
  }
  for (const d of pending) {
    if (lines.length >= MAP_MAX_ENTRIES) break;
    const kids = readDirNames(path.join(root, d)) || [];
    for (const k of kids) {
      if (MAP_SKIP.indexOf(k) !== -1) continue;
      total += 1;
      if (lines.length >= MAP_MAX_ENTRIES) break;
      let dir = false;
      try { dir = fs.statSync(path.join(root, d, k)).isDirectory(); } catch (_) { dir = false; }
      lines.push('  ' + d + '/' + (dir ? k + '/' : k));
    }
  }
  return { lines, total };
}

function findKeyFiles(root) {
  const found = [];
  for (const g of KEY_GROUPS) {
    for (const p of g.paths) {
      if (isFile(path.join(root, p))) { found.push({ tag: g.tag, path: p }); break; }
    }
  }
  // README* at root (any case/extension): README.md, Readme.txt, LISEZMOI...
  const d1 = readDirNames(root) || [];
  for (const n of d1) {
    const low = n.toLowerCase();
    if ((low === 'readme' || low.indexOf('readme.') === 0 || low.indexOf('readme-') === 0 ||
      low === 'lisezmoi' || low.indexOf('lisezmoi.') === 0) && found.every((f) => f.path !== n)) {
      found.push({ tag: 'readme', path: n });
    }
  }
  // C# solutions/projects at root.
  for (const n of d1) {
    const low = n.toLowerCase();
    if ((low.endsWith('.sln') || low.endsWith('.csproj')) && found.every((f) => f.path !== n)) {
      found.push({ tag: 'csharp', path: n });
    }
  }
  return found;
}

function detectTypes(root, keyFiles) {
  const tags = {};
  for (const k of keyFiles) tags[k.tag] = k.path;
  const types = [];
  if (tags.flutter) types.push('flutter');
  if (tags.node) {
    let isNext = !!tags.next;
    if (!isNext) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
        if (deps && deps.next) isNext = true;
      } catch (_) {}
    }
    types.push(isNext ? 'next.js' : 'node');
  }
  if (tags.requirements || tags.pyproject || tags['setup.py']) types.push('python');
  if (tags.go) types.push('go');
  if (tags.rust) types.push('rust');
  if (tags.maven || tags.gradle) types.push('java');
  if (tags.csharp) types.push('csharp');
  if (tags.composer) types.push('php');
  if (tags.gemfile) types.push('ruby');
  if (!types.length) types.push('unknown');
  return types;
}

function buildProjectMap(root, opts) {
  opts = opts || {};
  try {
    const abs = String(root || '');
    if (!abs || !isDir(abs)) return { ok: false, error: 'dossier de projet invalide.' };
    const keys = findKeyFiles(abs);
    const types = detectTypes(abs, keys);
    const tree = walkTree(abs);
    const keyList = keys.length ? keys.map((k) => k.path).join(', ') : '(aucun)';
    const head = '[carte du projet]\nracine: ' + abs + '\ntype: ' + types.join('+') +
      '\narborescence (profondeur 2, ' + MAP_MAX_ENTRIES + ' max) :\n';
    const tail = '\nfichiers cles existants : ' + keyList;
    // Fit the token budget: shrink the tree first, never the key files.
    let lines = tree.lines.slice();
    let text = head + lines.join('\n') + tail;
    while (lines.length > 4 && estTokens(text) > MAP_TOKEN_BUDGET) {
      lines = lines.slice(0, Math.max(4, Math.floor(lines.length * 0.7)));
      text = head + lines.join('\n') + tail;
    }
    const overflow = tree.total - lines.length;
    if (overflow > 0) text += '\n(+ ' + overflow + ' autres entrees, voir list/glob)';
    const tokens = estTokens(text);
    return {
      ok: true, text, tokens,
      entries: lines.length, total: tree.total,
      type: types.join('+'), types,
      keyFiles: keys.map((k) => k.path),
      truncated: overflow > 0 || tokens > MAP_TOKEN_BUDGET,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}

// ---------------------------------------------------------------------------
// General-question preload (P39-c).
// ---------------------------------------------------------------------------
const GENERAL_RES = [
  /explique/, /explain/, /describe/, /decris/, /presente/, /overview/,
  /resume/, /summary/, /summar/,
  /que propose/, /quoi.*\b(sert|fait|consiste)\b/, /c'? ?est quoi/,
  /\brole\b.*\b(app|projet|project|application)\b/,
  /a quoi .*sert/, /how does .*work/, /what does .*do/,
];

function isGeneralQuestion(prompt) {
  const t = stripAccents(prompt);
  if (!t || t.length > 2000) return false;
  // Task verbs win over explanation words ("explique puis corrige" = task).
  if (/\b(corrige|fix|ajoute|add|cree|create|modifie|change|supprime|delete|refactor|teste|test|debug|deploie|deploy|implemente|ecris|write)\b/.test(t)) return false;
  for (const re of GENERAL_RES) {
    if (re.test(t)) return true;
  }
  return false;
}

function parseManifestDeps(root, keyFiles) {
  const out = [];
  const keys = keyFiles || [];
  if (keys.indexOf('package.json') !== -1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const dn = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
      const dd = pkg.devDependencies ? Object.keys(pkg.devDependencies) : [];
      const sc = pkg.scripts ? Object.keys(pkg.scripts) : [];
      if (pkg.name) out.push('node: ' + String(pkg.name).slice(0, 80));
      if (dn.length) out.push('dependances (' + dn.length + ') : ' + dn.slice(0, 30).join(', '));
      if (dd.length) out.push('dev (' + dd.length + ') : ' + dd.slice(0, 20).join(', '));
      if (sc.length) out.push('scripts : ' + sc.slice(0, 15).join(', '));
    } catch (_) { out.push('package.json illisible.'); }
  }
  if (keys.indexOf('pubspec.yaml') !== -1) {
    try {
      const lines = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8').split('\n');
      const deps = [];
      let inDeps = false;
      for (const ln of lines) {
        if (/^dependencies:\s*$/.test(ln)) { inDeps = true; continue; }
        if (/^[a-z_]+:/.test(ln)) inDeps = false;
        if (inDeps) {
          const m = /^  ([A-Za-z0-9_]+):/.exec(ln);
          if (m && deps.length < 30) deps.push(m[1]);
        }
      }
      out.push('flutter: ' + (deps.length ? deps.join(', ') : '(dependances non lues)'));
    } catch (_) { out.push('pubspec.yaml illisible.'); }
  }
  if (keys.indexOf('requirements.txt') !== -1) {
    try {
      const lines = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8').split('\n');
      const deps = [];
      for (const ln of lines) {
        const t = ln.trim();
        if (t && t[0] !== '#' && deps.length < 30) deps.push(t.slice(0, 60));
      }
      if (deps.length) out.push('python: ' + deps.join(', '));
    } catch (_) { out.push('requirements.txt illisible.'); }
  }
  return out;
}

function buildPreload(root, map) {
  try {
    const keys = (map && map.keyFiles) || [];
    const parts = [];
    // README first (root only), bounded.
    let readmeBudget = PRELOAD_README_CHARS;
    for (const k of keys) {
      if (readmeBudget <= 0) break;
      const low = k.toLowerCase();
      if (low.indexOf('readme') !== 0 && low.indexOf('lisezmoi') !== 0) continue;
      try {
        const text = fs.readFileSync(path.join(root, k), 'utf8').slice(0, readmeBudget);
        if (text.trim()) {
          parts.push('--- ' + k + ' ---\n' + text);
          readmeBudget -= text.length;
        }
      } catch (_) {}
    }
    const deps = parseManifestDeps(root, keys);
    if (deps.length) parts.push('--- dependances (manifestes) ---\n' + deps.join('\n'));
    if (map && map.type) parts.push('--- structure ---\ntype : ' + map.type + '\nfichiers cles : ' + (keys.join(', ') || '(aucun)'));
    if (!parts.length) return null;
    let text = '[contexte precharge : question generale]\n' + parts.join('\n');
    if (text.length > PRELOAD_TOTAL_CHARS) text = text.slice(0, PRELOAD_TOTAL_CHARS) + '\n[...tronque]';
    return { text, tokens: estTokens(text) };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Enriched not_found hint (P39-b). Bounded parent listing + close names
// (same extension, shared prefix, or case variant). Never throws.
// ---------------------------------------------------------------------------
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function notFoundHint(root, absPath) {
  try {
    const abs = String(absPath || '');
    const base = path.basename(abs);
    if (!base) return null;
    let parent = path.dirname(abs);
    // Climb to the nearest existing ancestor inside root (max 4 levels).
    for (let i = 0; i < 4; i++) {
      try {
        if (fs.statSync(parent).isDirectory()) break;
      } catch (_) { parent = path.dirname(parent); }
    }
    let entries = [];
    try {
      entries = fs.readdirSync(parent).sort().slice(0, HINT_PARENT_MAX);
    } catch (_) { return null; }
    if (!entries.length) return { parent: [], close: [] };
    const lowBase = base.toLowerCase();
    const ext = lowBase.slice(lowBase.lastIndexOf('.'));
    const scored = [];
    for (const e of entries) {
      if (e === base) continue;
      const low = e.toLowerCase();
      let score = 0;
      if (low === lowBase) score = 100; // case variant
      else {
        if (ext && low.endsWith(ext)) score += 10;
        const cp = commonPrefixLen(low, lowBase);
        if (cp >= 3) score += cp;
      }
      if (score > 0) scored.push({ name: e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return { parent: entries, close: scored.slice(0, HINT_CLOSE_MAX).map((s) => s.name) };
  } catch (_) { return null; }
}

function formatNotFound(rel, hint) {
  let s = 'introuvable : ' + rel;
  if (hint) {
    s += ' ; fichiers proches : [' + (hint.close.length ? hint.close.join(', ') : '(aucun)') + ']';
    s += ' ; contenu du dossier parent : [' + (hint.parent.length ? hint.parent.join(', ') : '(vide)') + ']';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Deterministic fallback (P39-d). Labelled "generee sans IA" (ASCII).
// ---------------------------------------------------------------------------
function deterministicFallback(opts) {
  opts = opts || {};
  const map = opts.map || null;
  const calls = Array.isArray(opts.calls) ? opts.calls : [];
  const loopKey = String(opts.loopKey || '').slice(0, 160);
  // P43-3: why = 'loop' (unchanged text) | 'context' (saturation rescue
  // failed) | 'question' (single question call failed).
  const WHY = {
    loop: 'Boucle repetitive detectee et arretee : l\'appel "' + (loopKey || '?') +
      '" a ete repete 3 fois a l\'identique. Le dernier tour sans outils n\'a pas abouti, ' +
      'voici donc un resume deterministe (sans modele).',
    context: 'Contexte sature : le tour a depasse le budget du modele meme apres ' +
      'compression, et l\'appel de secours minimal n\'a pas abouti, voici donc un ' +
      'resume deterministe (sans modele).',
    question: 'Le fournisseur n\'a pas repondu (un seul appel, sans outils) : voici ' +
      'donc un resume deterministe (sans modele).',
  };
  const lines = [];
  lines.push('[reponse generee sans IA]');
  lines.push('');
  lines.push(WHY[opts.why] || WHY.loop);
  lines.push('');
  if (map && map.type) {
    lines.push('Projet : type ' + map.type + '.');
    if (map.keyFiles && map.keyFiles.length) lines.push('Fichiers cles : ' + map.keyFiles.slice(0, 12).join(', ') + '.');
  } else {
    lines.push('Projet : carte indisponible.');
  }
  const okCalls = calls.filter((c) => c && c.ok);
  if (okCalls.length) {
    lines.push('Deja collecte (' + okCalls.length + ' appel(s) reussi(s)) :');
    for (const c of okCalls.slice(-5)) {
      lines.push('- ' + c.tool + ' ' + String(c.target || '').slice(0, 100) + ' : ' + String(c.summary || 'ok').slice(0, 120));
    }
  } else {
    lines.push('Rien n\'a pu etre collecte avant la boucle.');
  }
  lines.push('');
  lines.push('Pour avancer : listez le dossier vise (list), cherchez par motif (glob/grep), ' +
    'puis relisez le chemin exact tel qu\'il apparait dans la liste.');
  let text = lines.join('\n');
  if (text.length > FALLBACK_MAX_CHARS) text = text.slice(0, FALLBACK_MAX_CHARS) + '\n[...tronque]';
  return text;
}

// ---------------------------------------------------------------------------
// Question context (P43-2). Deterministic, bounded: README head + key
// manifest heads in a FIXED candidate order (same input -> same output).
// ---------------------------------------------------------------------------
const QCTX_FILES = ['README.md', 'package.json', 'pubspec.yaml',
  'requirements.txt', 'pyproject.toml', 'go.mod'];
const QCTX_PER_FILE = 1500;
const QCTX_TOTAL = 6000;

function buildQuestionContext(root, map, opts) {
  opts = opts || {};
  const lines = [];
  const files = [];
  lines.push('[contexte question]');
  if (map && map.type) {
    lines.push('Type detecte : ' + map.type + '.');
    if (map.keyFiles && map.keyFiles.length) {
      lines.push('Fichiers cles : ' + map.keyFiles.slice(0, 12).join(', ') + '.');
    }
  }
  let left = opts.totalCap || QCTX_TOTAL;
  const per = opts.perFileCap || QCTX_PER_FILE;
  for (const name of QCTX_FILES) {
    if (left <= 0) break;
    let s = null;
    try {
      const abs = path.join(String(root || ''), name);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size <= 0 || st.size > 200000) continue;
      s = fs.readFileSync(abs, 'utf8');
    } catch (_) { continue; }
    if (!s) continue;
    const head = s.slice(0, Math.min(per, left));
    files.push(name);
    left -= head.length;
    lines.push('');
    lines.push('--- ' + name + ' (tete, ' + head.length + ' car.) ---');
    lines.push(head);
  }
  const text = lines.join('\n');
  return { text, tokens: estTokens(text), files };
}

module.exports = {
  MAP_SKIP, MAP_MAX_ENTRIES, MAP_TOKEN_BUDGET,
  estTokens, buildProjectMap, isGeneralQuestion, buildPreload,
  parseManifestDeps, notFoundHint, formatNotFound, deterministicFallback,
  buildQuestionContext,
};

// ---------------------------------------------------------------------------
// P65-D10: CARTE DU DEPOT SANS MODELE + recherche lexicale.
//
// La carte existante (buildProjectMap) donne l'arborescence et les fichiers
// cles. Ici on va plus loin, toujours sans appeler le modele :
//   - symbolIndex : symboles declares par fichier (fonctions, classes,
//     exports) par analyse de motifs selon l'extension ;
//   - relevantFiles : quels fichiers de CODE meritent d'entrer dans le
//     contexte pour CETTE demande (recouvrement lexical chemin + symboles).
//
// Objectif : un petit modele recoit 3 a 8 fichiers pertinents au lieu d'une
// arborescence muette ou d'un depot entier (budget de contexte).
// Bornes strictes : 400 fichiers, profondeur 5, 60 symboles par fichier.
// Ne jette jamais : un dossier illisible rend une liste vide.
// ---------------------------------------------------------------------------
const SYMBOL_MAX_FILES = 400;
const SYMBOL_MAX_DEPTH = 5;
const SYMBOL_MAX_PER_FILE = 60;
const RELEVANT_MAX = 8;

const SYMBOL_PATTERNS = {
  '.js': [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, /\bexports\.([A-Za-z_$][\w$]*)/g],
  '.mjs': [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g],
  '.ts': [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g],
  '.jsx': [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g],
  '.py': [/\bdef\s+([A-Za-z_]\w*)/g, /\bclass\s+([A-Za-z_]\w*)/g],
  '.dart': [/\bclass\s+([A-Za-z_]\w*)/g, /\b(?:void|Widget|Future<void>)\s+([A-Za-z_]\w*)\s*\(/g],
  '.go': [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g],
  '.rs': [/\bfn\s+([A-Za-z_]\w*)/g, /\bstruct\s+([A-Za-z_]\w*)/g],
};

function symbolsOf(text, ext) {
  const pats = SYMBOL_PATTERNS[ext];
  if (!pats) return [];
  const out = [];
  for (const re of pats) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null && out.length < SYMBOL_MAX_PER_FILE) {
      const n = m[1];
      if (n && out.indexOf(n) === -1) out.push(n);
    }
  }
  return out;
}

function walkCode(root, limit) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    if (cur.depth > SYMBOL_MAX_DEPTH) continue;
    let entries = [];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (_) { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limit) break;
      if (e.name[0] === '.' && e.name !== '.') continue;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (MAP_SKIP.indexOf(e.name) !== -1) continue;
        stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SYMBOL_PATTERNS[ext]) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) { continue; }
        if (size > 256 * 1024) continue;
        out.push({ abs: full, rel: path.relative(root, full).replace(/\\/g, '/'), ext });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// P65-D14: CACHE DES PARTIES STABLES DU PROMPT.
//
// L'index des symboles coute la LECTURE de tous les fichiers de code. Il ne
// change pas tant que rien n'est ecrit. On le met donc en cache, avec une
// signature (chemin + taille + mtime) : au moindre changement, la signature
// differe et le cache est ignore. Aucune donnee perimee n'est servie.
// Statistiques exposees (hits/misses) pour la preuve au banc d'essai.
// ---------------------------------------------------------------------------
const PM_CACHE = new Map();
const PM_CACHE_MAX = 4;
const PM_STATS = { hits: 0, misses: 0, reads: 0 };

function fileSignature(files) {
  const parts = [];
  for (const f of files) {
    let st = null;
    try { st = fs.statSync(f.abs); } catch (_) { st = null; }
    parts.push(f.rel + ':' + (st ? st.size + ':' + Math.round(st.mtimeMs) : '-'));
  }
  // Une chaine suffisante pour detecter un changement structurel.
  return parts.join('|').length + '#' + parts.join('|').slice(0, 4000);
}

function cacheStats() {
  return { hits: PM_STATS.hits, misses: PM_STATS.misses, reads: PM_STATS.reads, entries: PM_CACHE.size };
}

function resetCache() { PM_CACHE.clear(); PM_STATS.hits = 0; PM_STATS.misses = 0; PM_STATS.reads = 0; }

function symbolIndexCached(root) {
  const files = walkCode(String(root || ''), SYMBOL_MAX_FILES);
  const sig = String(root) + '/' + fileSignature(files);
  const hit = PM_CACHE.get(String(root));
  if (hit && hit.sig === sig) {
    PM_STATS.hits += 1;
    return hit.value;
  }
  PM_STATS.misses += 1;
  PM_STATS.reads += files.length;
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch (_) { continue; }
    out.push({ rel: f.rel, ext: f.ext, symbols: symbolsOf(text, f.ext) });
  }
  PM_CACHE.set(String(root), { sig, value: out });
  while (PM_CACHE.size > PM_CACHE_MAX) {
    const first = PM_CACHE.keys().next();
    PM_CACHE.delete(first.value);
  }
  return out;
}

// index: [{ rel, ext, symbols: [..] }]
function symbolIndex(root, opts) {
  const o = opts || {};
  const files = walkCode(String(root || ''), Number(o.maxFiles) > 0 ? Number(o.maxFiles) : SYMBOL_MAX_FILES);
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch (_) { continue; }
    out.push({ rel: f.rel, ext: f.ext, symbols: symbolsOf(text, f.ext) });
  }
  return out;
}

const STOPWORDS = ['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'en', 'a', 'au',
  'aux', 'dans', 'sur', 'pour', 'avec', 'par', 'ce', 'cette', 'ces', 'que', 'qui', 'quoi', 'est',
  'sont', 'the', 'and', 'for', 'with', 'this', 'that', 'les', 'son', 'sa', 'ses', 'il', 'elle',
  'je', 'tu', 'nous', 'vous', 'fichier', 'fichiers', 'fonction', 'ajoute', 'change', 'cree',
  'creer', 'corrige', 'modifie', 'dans', 'projet', 'code', 'puis', 'fait', 'faire', 'tout'];

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(' ')
    .filter((w) => w.length > 2 && STOPWORDS.indexOf(w) === -1);
}

// Quels fichiers de code meritent le contexte. score = mots de la demande
// presents dans le CHEMIN (x2) ou dans les SYMBOLES (x1). Deterministe.
function relevantFiles(root, prompt, opts) {
  const o = opts || {};
  const max = Number(o.max) > 0 ? Number(o.max) : RELEVANT_MAX;
  const q = [];
  for (const w of words(prompt)) if (q.indexOf(w) === -1) q.push(w);
  if (!q.length) return [];
  const idx = o.index || symbolIndexCached(root);
  const scored = [];
  for (const f of idx) {
    const inPath = words(f.rel);
    const inSym = [];
    for (const s of (f.symbols || [])) for (const w of words(s)) if (inSym.indexOf(w) === -1) inSym.push(w);
    let score = 0;
    const hits = [];
    for (const w of q) {
      if (inPath.indexOf(w) !== -1) { score += 3; hits.push(w); continue; }
      if (inSym.indexOf(w) !== -1) { score += 2; hits.push(w); continue; }
      if (String(f.rel).toLowerCase().indexOf(w) !== -1) { score += 1; hits.push(w); }
    }
    if (score > 0) scored.push({ rel: f.rel, score, hits, symbols: (f.symbols || []).slice(0, 8) });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.rel < b.rel ? -1 : 1));
  return scored.slice(0, max);
}

// Bloc de contexte borne, pret a etre injecte (aucune invention : le moteur
// ne fait que nommer des fichiers et des symboles reellement lus).
function relevantBlock(root, prompt, opts) {
  const list = relevantFiles(root, prompt, opts);
  if (!list.length) return { text: '', files: [], tokens: 0 };
  const lines = ['FICHIERS PERTINENTS (carte du depot, calculee sans modele) :'];
  for (const f of list) {
    lines.push('- ' + f.rel + (f.symbols.length ? ' : ' + f.symbols.join(', ') : ''));
  }
  lines.push('Lis un de ces fichiers (read) avant de le modifier. Ne devine pas de chemin.');
  const text = lines.join('\n').slice(0, 1200);
  return { text, files: list.map((f) => f.rel), tokens: estTokens(text) };
}

module.exports.symbolIndex = symbolIndex;
module.exports.symbolIndexCached = symbolIndexCached;
module.exports.cacheStats = cacheStats;
module.exports.resetCache = resetCache;
module.exports.relevantFiles = relevantFiles;
module.exports.relevantBlock = relevantBlock;
module.exports.symbolsOf = symbolsOf;
