// Sudo Agent engine planner (P52). The MODEL never manages todos: the
// driver builds the plan from the user prompt, verifies each step effect
// on disk, and marks steps done only when VERIFIED. Also hosts the
// tool-loop guard (same tool + same args + same result, corrective
// strategy before any stop) shared by the inline loop and the
// orchestrator. Pure + stdlib + ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');
const ckpt = require('./checkpoints');

function intEnv(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

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

// ---------------------------------------------------------------------------
// Stable stringify (sorted keys) for loop-guard signatures.
// ---------------------------------------------------------------------------
function stableStringify(v, depth) {
  depth = depth === undefined ? 0 : depth;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 2000));
  if (typeof v !== 'object') return JSON.stringify(v);
  if (depth > 4) return '"..."';
  if (Array.isArray(v)) return '[' + v.slice(0, 50).map((x) => stableStringify(x, depth + 1)).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.slice(0, 50).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k], depth + 1)).join(',') + '}';
}

// Loop-guard signature: same tool AND same args AND same result.
// ok results sign 'ok' (summaries carry unstable bits like ms); errors
// sign their code (a different code means the situation changed).
function callSig(tool, args, ok, code) {
  return String(tool || '?') + '|' + stableStringify(args || {}).slice(0, 2000) + '|' + (ok ? 'ok' : 'err:' + String(code || 'error'));
}

// Tool+args signature (pre-execution restriction key: the result is not
// known yet, so the full callSig cannot be compared before running).
function argSig(tool, args) {
  return String(tool || '?') + '|' + stableStringify(args || {}).slice(0, 2000);
}

// Guard: consecutive identical signatures. 1-2 -> 'ok', 3rd -> 'correct'
// (enter corrective mode: the caller injects the strategy and restricts
// the identical tool+args; anything different resets to 1). While
// corrective, repeating the IDENTICAL call is refused with guidance
// (correctiveRefusals counts them); the 2nd identical repeat stops the
// turn (loopStop). 'stop' from note() is defensive only (the pre-exec
// restriction normally prevents re-executing the identical call).
// Approvals and state reads never reach note() (callers only note
// COMPLETED mutating/state-changing calls).
function createLoopGuard() {
  const g = { last: '', count: 0, corrective: false, forbiddenArgs: '', correctiveRefusals: 0 };
  g.note = (sig) => {
    if (!sig) { g.reset(); return 'ok'; }
    if (g.corrective) {
      if (sig === g.last) return 'stop';
      g.reset();
      g.last = sig; g.count = 1;
      return 'ok';
    }
    if (sig === g.last) g.count += 1;
    else { g.last = sig; g.count = 1; }
    if (g.count >= 3) {
      g.corrective = true;
      return 'correct';
    }
    return 'ok';
  };
  g.reset = () => { g.last = ''; g.count = 0; g.corrective = false; g.forbiddenArgs = ''; g.correctiveRefusals = 0; };
  return g;
}

// ---------------------------------------------------------------------------
// Plan parsing: pasted task list (intent.taskItems) else semicolon-numbered
// ("1. ... ; 2. ...") else the whole prompt as one step.
// ---------------------------------------------------------------------------
const LEAD_NUM = /^[ \t]*\d{1,3}[.)\]}][ \t]+/;

function splitNumbered(text) {
  const parts = String(text || '').split(/;[ \t]*(?=\d{1,3}[.)\]}][ \t]+\S)/);
  if (parts.length < 2) return null;
  const steps = parts.map((p) => String(p || '').replace(LEAD_NUM, '').trim().slice(0, 2000)).filter(Boolean);
  return steps.length >= 2 ? steps.slice(0, 50) : null;
}

function parseSteps(prompt, taskItems) {
  // Two granularities compete: intent items (per-line, each truncated to
  // 200 chars, so a single-line '1. a ; ... ; 30. z' under-splits) and a
  // whole-prompt '; N.' split (which would wrongly merge newline-separated
  // pasted items). Compute BOTH, keep the finer (ties: intent version).
  let viaItems = [];
  if (Array.isArray(taskItems) && taskItems.length) {
    for (const item of taskItems.slice(0, 50)) {
      const t = String(item || '').replace(LEAD_NUM, '').trim().slice(0, 2000);
      if (!t) continue;
      const sub = splitNumbered(t);
      if (sub) { for (const x of sub) { if (viaItems.length < 50) viaItems.push(x); } }
      else if (viaItems.length < 50) viaItems.push(t);
    }
  }
  const text = String(prompt || '').trim();
  const viaWhole = splitNumbered(text) || [];
  if (viaWhole.length > viaItems.length) return viaWhole;
  if (viaItems.length) return viaItems;
  if (viaWhole.length) return viaWhole;
  if (!text) return [];
  return [text.slice(0, 2000)];
}

// First path-ish token (file with an extension). Trailing punctuation
// (",", ".", ";", quotes, parens) is not part of the path.
function fileToken(s) {
  const m = /(?:^|[\s"'`(\[])([A-Za-z0-9_~][A-Za-z0-9_~.\/-]*\.[A-Za-z0-9]{1,6})(?=[\s"'`)\].,;:!?]|$)/.exec(String(s || ''));
  return m ? m[1] : '';
}

function dirToken(s) {
  const m = /(?:dossier|repertoire|directory)\s+([A-Za-z0-9_~][A-Za-z0-9_~/.-]*)/i.exec(String(s || ''));
  if (!m) return '';
  return String(m[1]).replace(/[.,;:!?"'`)\]]+$/, '');
}

function cleanTail(s) {
  return String(s || '').trim().replace(/^[`'"]+|[`'".,;:!?)]+$/g, '').trim();
}

// Step analysis -> { text, op, file, file2, dir, content, growth }.
// op: create|append|dir|absent|renamed|modify|anychange|declared.
// Unresolvable file references (pronoun with no previous file) degrade
// to anychange/declared (weak but never blocking: item 3 forbids
// refusing the finish over open tasks).
function analyzeStep(rawText, prevFile) {
  const text = String(rawText || '').trim().slice(0, 2000);
  const t = fold(text);
  const prev = String(prevFile || '');
  // 1. rename: "renomme X en Y" (before create: no overlap, order stable).
  let m = text.match(/renomme[r|z|s]?\s+(?:le\s+fichier\s+|le\s+|la\s+|les\s+|l')?(\S+)\s+en\s+(\S+)/i);
  if (m) {
    const from = cleanTail(m[1]);
    const to = cleanTail(m[2]);
    if (from && to && from !== 'le' && from !== 'la' && from !== 'les') {
      return { text, op: 'renamed', file: from, file2: to };
    }
    if (prev) return { text, op: 'renamed', file: prev, file2: to };
    return { text, op: 'declared', weak: 'rename sans cible resolue' };
  }
  // Pronoun rename ("renomme-le en X").
  m = text.match(/renomme[\s-]+(le|la|les)\s+en\s+(\S+)/i);
  if (m) {
    if (prev) return { text, op: 'renamed', file: prev, file2: cleanTail(m[2]) };
    return { text, op: 'declared', weak: 'rename sans cible resolue' };
  }
  // 2. delete: explicit file or pronoun ("supprime-le", "supprime le X").
  m = text.match(/(?:supprime[r|z|s]?|efface[r]?|delete|remove)\s+(?:le\s+fichier\s+|le\s+|la\s+|les\s+|l')?(\S+)/i);
  if (m && ['le', 'la', 'les'].indexOf(m[1]) === -1) {
    return { text, op: 'absent', file: cleanTail(m[1]) };
  }
  if (/\b(supprime|efface)[\s-]+(le|la|les)\b/.test(t) || (m && ['le', 'la', 'les'].indexOf(m[1]) !== -1)) {
    if (prev) return { text, op: 'absent', file: prev };
    return { text, op: 'declared', weak: 'suppression sans cible resolue' };
  }
  // 3. mkdir: "cree le dossier X".
  if (/\b(dossier|repertoire|directory)\b/.test(t) && /\b(cree|creer|ajoute|ajouter|make|mkdir)\b/.test(t)) {
    const d = dirToken(text);
    if (d) return { text, op: 'dir', dir: d };
  }
  // 4. append: "... ajoute ... a la fin [de X]".
  if (/\ba\s+la\s+fin\b/.test(t) && /\bajout/.test(t)) {
    const f = text.match(/(?:\ba|\u00e0)\s+la\s+fin\s+(?:de\s+|du\s+|d')(\S+)/i);
    let content = null;
    const cm = text.match(/\bajout(?:e|er|ez|ons)?\s+(.+?)\s+(?:a|\u00e0)\s+la\s+fin\b/i);
    if (cm) {
      let raw = cleanTail(cm[1]).replace(/^(la\s+ligne\s+|les\s+lignes\s+|le\s+texte\s+|une?\s+ligne\s+de\s+)/i, '').trim();
      if (!/^(une?\s+ligne|du\s+contenu|quelques?\s+lignes?|du\s+texte)\.?$/.test(raw) && raw) content = raw;
    }
    const file = f ? cleanTail(f[1]) : prev;
    if (file) return { text, op: 'append', file, content, growth: !content };
    return { text, op: 'anychange', weak: 'append sans fichier resolu' };
  }
  // 5. create: "cree X [avec ...]" (file token with extension).
  if (/\b(cree|creer|ecris?|redige|create|write)\b/.test(t)) {
    const sides = text.split(/\s+avec\s+(?:le\s+contenu\s+)?/i);
    const f = fileToken(sides[0]);
    if (f) {
      const content = sides.length > 1 ? cleanTail(sides.slice(1).join(' avec ')).slice(0, 2000) : '';
      return { text, op: 'create', file: f, content };
    }
  }
  // 6. modify: explicit file + change verb, or bare change verb.
  if (/\b(modifie|corrige|remplace|edite|change|update|fix)\b/.test(t)) {
    const f = fileToken(text);
    if (f) return { text, op: 'modify', file: f };
    if (prev && /\b(le|la|les|lui)\b/.test(t)) return { text, op: 'modify', file: prev };
    return { text, op: 'anychange', weak: 'modification sans fichier resolu' };
  }
  // 7. default: non-verifiable step (weak accept on declared finish).
  return { text, op: 'declared', weak: 'effet non verifiable automatiquement' };
}

const OP_TOOL = { create: 'write', append: 'append', dir: 'mkdir', absent: 'delete', renamed: 'rename', modify: 'edit', anychange: 'edit', declared: '' };

function verifyText(step) {
  const s = step || {};
  const fc = (f) => ' ' + String(f || '?').slice(0, 80);
  switch (s.op) {
    case 'create': return 'fichier' + fc(s.file) + ' present' + (s.content ? ' contenant "' + String(s.content).slice(0, 60) + '"' : '');
    case 'append': return fc(s.file) + ' a grandi' + (s.content ? ' et contient "' + String(s.content).slice(0, 60) + '"' : '');
    case 'dir': return 'dossier' + fc(s.dir) + ' present';
    case 'absent': return 'fichier' + fc(s.file) + ' absent';
    case 'renamed': return fc(s.file) + ' devenu' + fc(s.file2);
    case 'modify': return fc(s.file) + ' modifie';
    case 'anychange': return 'au moins un fichier modifie';
    default: return 'declare termine (' + String(s.weak || 'faible') + ')';
  }
}

// Build analyzed steps with sequential pronoun resolution (lastFile
// threads through: create/append/modify/absent/dir/renamed update it).
function buildPlan(stepTexts) {
  const steps = [];
  let lastFile = '';
  for (const raw of stepTexts) {
    const st = analyzeStep(raw, lastFile);
    steps.push(st);
    if (st.file) lastFile = st.file;
    else if (st.op === 'append' && lastFile) st.file = lastFile;
    if (st.op === 'renamed' && st.file2) lastFile = st.file2;
  }
  return steps;
}

// Snapshot { rel: { size, hash } } for the given rels (missing -> null
// hash) + a global walk digest for anychange steps.
function snapFiles(root, rels) {
  const files = {};
  for (const rel of rels || []) {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!r) continue;
    try {
      const buf = fs.readFileSync(path.join(root, r));
      files[r] = { size: buf.length, hash: ckpt.hashContent(buf) };
    } catch (_) {
      try {
        if (fs.statSync(path.join(root, r)).isDirectory()) files[r] = { size: -2, hash: 'dir' };
        else files[r] = { size: -1, hash: null };
      } catch (_) { files[r] = { size: -1, hash: null }; }
    }
  }
  let global = '';
  try {
    const w = ckpt.walkFiles(root, {});
    global = ckpt.hashContent(Buffer.from(Object.keys(w.files).sort().map((k) => k + ':' + w.files[k].hash).join('|'), 'utf8'));
  } catch (_) { global = ''; }
  return { files, global };
}

function readText(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; }
}

// Verify one analyzed step against a snapshot. Returns { ok, detail }.
function verifyStep(root, step, snap, acceptDeclared) {
  const s = step || {};
  const files = (snap && snap.files) || {};
  const before = files[s.file] || files[s.dir] || { size: -1, hash: null };
  const norm = (r) => String(r || '').replace(/\\/g, '/').replace(/^\/+/, '');
  switch (s.op) {
    case 'create': {
      const txt = readText(root, norm(s.file));
      if (txt === null) return { ok: false, detail: s.file + ' absent' };
      if (s.content && txt.indexOf(String(s.content).slice(0, 500)) === -1) {
        return { ok: false, detail: s.file + ' present mais contenu attendu introuvable' };
      }
      return { ok: true, detail: s.file + ' cree' + (s.content ? ' (contenu verifie)' : '') };
    }
    case 'append': {
      const txt = readText(root, norm(s.file));
      if (txt === null) return { ok: false, detail: s.file + ' absent' };
      const grew = before.size !== undefined && before.size >= 0 ? txt.length > before.size : txt.length > 0;
      if (!grew) return { ok: false, detail: s.file + ' n\'a pas grandi' };
      if (s.content && txt.indexOf(String(s.content).slice(0, 500)) === -1) {
        return { ok: false, detail: s.file + ' a grandi mais ligne attendue introuvable' };
      }
      return { ok: true, detail: s.file + ' complete' };
    }
    case 'dir': {
      try {
        if (fs.statSync(path.join(root, norm(s.dir))).isDirectory()) return { ok: true, detail: s.dir + ' present' };
      } catch (_) {}
      return { ok: false, detail: s.dir + ' absent' };
    }
    case 'absent': {
      try { fs.statSync(path.join(root, norm(s.file))); } catch (_) { return { ok: true, detail: s.file + ' supprime' }; }
      return { ok: false, detail: s.file + ' encore present' };
    }
    case 'renamed': {
      let fromGone = false;
      try { fs.statSync(path.join(root, norm(s.file))); } catch (_) { fromGone = true; }
      let toHere = false;
      try { toHere = fs.statSync(path.join(root, norm(s.file2))).isFile(); } catch (_) {}
      if (fromGone && toHere) return { ok: true, detail: s.file + ' -> ' + s.file2 };
      return { ok: false, detail: 'rename non constate (' + s.file + (fromGone ? ' parti' : ' present') + ', ' + s.file2 + (toHere ? ' present' : ' absent') + ')' };
    }
    case 'modify': {
      const txt = readText(root, norm(s.file));
      if (txt === null) return { ok: false, detail: s.file + ' absent' };
      if (before.hash && ckpt.hashContent(Buffer.from(txt, 'utf8')) === before.hash) {
        return { ok: false, detail: s.file + ' inchange' };
      }
      return { ok: true, detail: s.file + ' modifie' };
    }
    case 'anychange': {
      let global = '';
      try {
        const w = ckpt.walkFiles(root, {});
        global = ckpt.hashContent(Buffer.from(Object.keys(w.files).sort().map((k) => k + ':' + w.files[k].hash).join('|'), 'utf8'));
      } catch (_) { global = ''; }
      if (global && snap && snap.global && global !== snap.global) return { ok: true, detail: 'fichiers modifies constates' };
      return { ok: false, detail: 'aucun changement constate' };
    }
    default:
      // Unverifiable steps are weakly accepted ONLY on declared finish
      // (done-accept sweep or a child that declared done): never mid-turn
      // (a mere read must not close them).
      if (acceptDeclared) return { ok: true, detail: 'declare (' + String(s.weak || 'faible') + ')', weak: true };
      return { ok: false, detail: 'en attente de declaration (effet non verifiable automatiquement)' };
  }
}

// ---------------------------------------------------------------------------
// Engine todo store (session meta.todos, same shape as the model-era tool
// plus engine fields). The model never writes these (P52 item 3).
// ---------------------------------------------------------------------------
function getTodos(store, sessionId) {
  try {
    const cur = store.get(sessionId);
    if (cur && cur.meta && Array.isArray(cur.meta.todos)) return cur.meta.todos;
  } catch (_) {}
  return [];
}

// Seed a fresh engine plan (prunes old resolved todos, bounded).
function seedPlan(store, sessionId, turnId, steps, root) {
  const rels = [];
  for (const st of steps) {
    if (st.file) rels.push(st.file);
    if (st.file2) rels.push(st.file2);
    if (st.dir) rels.push(st.dir);
  }
  const snap = snapFiles(root, rels);
  let seeded = [];
  store.update(sessionId, (s) => {
    if (!s.meta) s.meta = {};
    if (!Array.isArray(s.meta.todos)) s.meta.todos = [];
    const open = s.meta.todos.filter((x) => x && !x.done && x.status !== 'abandoned');
    const resolved = s.meta.todos.filter((x) => x && (x.done || x.status === 'abandoned')).slice(-20);
    s.meta.todos = open.concat(resolved);
    if (!s.meta.todoSeq) s.meta.todoSeq = s.meta.todos.length;
    for (let i = 0; i < steps.length; i++) {
      s.meta.todoSeq += 1;
      seeded.push({ id: 't' + s.meta.todoSeq, text: steps[i].text, done: false, engine: true,
        turnId, step: i, verify: steps[i], status: 'open', at: new Date().toISOString() });
    }
    for (const it of seeded) s.meta.todos.push(it);
    s.meta.planSnap = { turnId, at: new Date().toISOString(), snap };
  });
  return { todos: seeded, snap };
}

function planSnap(store, sessionId) {
  try {
    const cur = store.get(sessionId);
    if (cur && cur.meta && cur.meta.planSnap && cur.meta.planSnap.snap) return cur.meta.planSnap.snap;
  } catch (_) {}
  return { files: {}, global: '' };
}

function firstOpen(store, sessionId) {
  const todos = getTodos(store, sessionId);
  for (const t of todos) {
    if (t && !t.done && t.status !== 'abandoned') return t;
  }
  return null;
}

// Verify-then-mark loop helper: marks the FIRST open step when its
// effect is verified. Returns the marked item or null.
function verifyCurrent(store, sessionId, root, acceptDeclared) {
  const cur = firstOpen(store, sessionId);
  if (!cur || !cur.verify) return null;
  const snap = planSnap(store, sessionId);
  let res = null;
  try { res = verifyStep(root, cur.verify, snap, acceptDeclared); } catch (e) {
    res = { ok: false, detail: 'verification impossible: ' + String((e && e.message) || e).slice(0, 120) };
  }
  if (!res.ok) return null;
  const id = cur.id;
  store.update(sessionId, (s) => {
    const f = (s.meta.todos || []).find((x) => x && x.id === id);
    if (f) { f.done = true; f.status = 'done'; f.verifiedAt = new Date().toISOString(); f.detail = String(res.detail).slice(0, 300); }
  });
  cur.done = true; cur.status = 'done'; cur.detail = res.detail;
  return cur;
}

// Sweep: verify ALL open steps once (done-accept time catch-up).
function sweepVerify(store, sessionId, root, acceptDeclared) {
  const marked = [];
  for (;;) {
    const it = verifyCurrent(store, sessionId, root, acceptDeclared);
    if (!it) break;
    marked.push(it);
    if (marked.length >= 50) break;
  }
  return marked;
}

// Stale = open but from a previous turn (model-era todos have no turnId
// and count as stale: the old world drains through one choice, then out).
function openStale(store, sessionId, turnId) {
  return getTodos(store, sessionId).filter((t) => t && !t.done && t.status !== 'abandoned' && t.turnId !== turnId);
}

function abandonTodos(store, sessionId, ids, why) {
  const set = {};
  for (const id of ids || []) set[String(id)] = true;
  store.update(sessionId, (s) => {
    for (const t of (s.meta.todos || [])) {
      if (t && set[t.id] && !t.done && t.status !== 'abandoned') {
        t.status = 'abandoned'; t.detail = String(why || 'abandonne').slice(0, 200);
      }
    }
  });
}

function reactivateTodos(store, sessionId, ids, turnId) {
  const set = {};
  for (const id of ids || []) set[String(id)] = true;
  store.update(sessionId, (s) => {
    for (const t of (s.meta.todos || [])) {
      if (t && set[t.id]) t.turnId = turnId;
    }
  });
}

// Split stale todos by age: older than abandonMs are auto-abandoned now
// (returned in auto), the rest need the Reprendre/Abandonner choice.
function splitStaleByAge(store, sessionId, stale, abandonMs) {
  const now = Date.now();
  const auto = [];
  const fresh = [];
  for (const t of stale) {
    let age = -1;
    try { age = now - new Date(t.at).getTime(); } catch (_) { age = -1; }
    if (age >= 0 && age > abandonMs) auto.push(t);
    else fresh.push(t);
  }
  if (auto.length) abandonTodos(store, sessionId, auto.map((t) => t.id), 'abandon automatique (delai depasse)');
  return { auto, fresh };
}

// Pending choice (survives restarts: session meta).
function setPendingChoice(store, sessionId, staleIds, stored) {
  store.update(sessionId, (s) => {
    if (!s.meta) s.meta = {};
    s.meta.pendingChoice = { staleIds: staleIds.slice(), stored: String(stored || '').slice(0, 2000), at: new Date().toISOString() };
  });
}

function getPendingChoice(store, sessionId) {
  try {
    const cur = store.get(sessionId);
    if (cur && cur.meta && cur.meta.pendingChoice && Array.isArray(cur.meta.pendingChoice.staleIds)) return cur.meta.pendingChoice;
  } catch (_) {}
  return null;
}

function clearPendingChoice(store, sessionId) {
  store.update(sessionId, (s) => { if (s.meta) delete s.meta.pendingChoice; });
}

// Resolve a pending choice against the new user message. Returns null
// when no choice pends, else { action, effective, note }:
// - resume (REPRENDRE): reactivate stale + run the STORED prompt.
// - abandon ('abandonner'): abandon stale + run the STORED prompt.
// - other: abandon stale (implicit, journaled) + run the NEW message
//   (the stored prompt is superseded).
// A pending choice older than abandonMs auto-abandons first; an explicit
// REPRENDRE then still runs the stored prompt alone.
function resolvePendingChoice(store, sessionId, turnId, message, abandonMs) {
  const pend = getPendingChoice(store, sessionId);
  if (!pend) return null;
  const t = fold(message);
  let age = -1;
  try { age = Date.now() - new Date(pend.at).getTime(); } catch (_) { age = -1; }
  const expired = age >= 0 && age > abandonMs;
  const staleIds = pend.staleIds.slice();
  const stored = pend.stored;
  clearPendingChoice(store, sessionId);
  if (/\breprend|resume\b/.test(t) && !expired) {
    reactivateTodos(store, sessionId, staleIds, turnId);
    return { action: 'resume', effective: stored,
      note: 'Choix : REPRENDRE (' + staleIds.length + ' tache(s) precedente(s) reactives), puis la demande mise en attente.' };
  }
  abandonTodos(store, sessionId, staleIds, expired ? 'abandon automatique (delai depasse)' : 'abandonne (choix)');
  if (/\babandon/.test(t) || /\breprend|resume\b/.test(t)) {
    return { action: 'abandon', effective: stored,
      note: 'Choix : ' + (expired ? 'delai depasse, anciennes taches abandonnees ; execution de la demande mise en attente.' : 'ABANDONNER : anciennes taches abandonnees ; execution de la demande mise en attente.') };
  }
  return { action: 'abandon', effective: String(message || ''),
    note: 'Choix implicite : nouvelle demande, ' + staleIds.length + ' ancienne(s) tache(s) abandonnee(s) (demande precedente remplacee).' };
}

function choiceMessage(stale, stored) {
  const lines = stale.slice(0, 10).map((t) => '- ' + t.id + ' : ' + String(t.text || '').slice(0, 120));
  if (stale.length > 10) lines.push('- ... (' + (stale.length - 10) + ' autres)');
  return 'Taches precedentes inachevees (' + stale.length + ') :\n' + lines.join('\n') +
    '\nRepondez REPRENDRE pour les terminer d\'abord, ou ABANDONNER pour les abandonner et executer : "' +
    String(stored || '').slice(0, 200) + '". (Abandon automatique apres delai.)';
}

function planNote(todos) {
  const lines = ['PLAN MOTEUR (' + todos.length + ' etape(s), verifiees dans l\'ordre) :'];
  todos.forEach((t, i) => {
    const tool = OP_TOOL[(t.verify && t.verify.op) || 'declared'] || '';
    lines.push((i + 1) + '. [' + t.id + '] ' + String(t.text || '').slice(0, 160) +
      ' -- verif : ' + verifyText(t.verify) + (tool ? ' -- outil conseille : ' + tool : ''));
  });
  lines.push('Ne gere pas de todos toi-meme : agis etape par etape, le moteur verifie chaque effet.');
  return lines.join('\n');
}

function planAppendix(store, sessionId) {
  const todos = getTodos(store, sessionId).filter((t) => t && t.engine);
  if (!todos.length) return '';
  const done = todos.filter((t) => t.done).length;
  const rest = todos.filter((t) => !t.done && t.status !== 'abandoned');
  let s = 'Plan moteur : ' + done + '/' + todos.length + ' verifiees.';
  if (rest.length) s += ' Restantes : ' + rest.slice(0, 5).map((t) => t.id + ' (' + String(t.text || '').slice(0, 60) + ')').join(' ; ') + '.';
  return s;
}

module.exports = {
  intEnv,
  fold,
  stableStringify,
  callSig,
  argSig,
  createLoopGuard,
  parseSteps,
  analyzeStep,
  buildPlan,
  verifyText,
  verifyStep,
  snapFiles,
  getTodos,
  seedPlan,
  planSnap,
  firstOpen,
  verifyCurrent,
  sweepVerify,
  openStale,
  abandonTodos,
  reactivateTodos,
  splitStaleByAge,
  setPendingChoice,
  getPendingChoice,
  clearPendingChoice,
  resolvePendingChoice,
  choiceMessage,
  planNote,
  planAppendix,
  OP_TOOL,
};
