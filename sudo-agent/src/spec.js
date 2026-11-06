/**
 * spec.js - P56: long specifications (cahiers des charges) become projects.
 *
 * A 50/60/1000 line brief is NEVER pasted whole into the model context.
 * It is stored as a document on disk (<root>/.sudo-agent/specs/spec-<id>.md)
 * and the engine extracts, DETERMINISTICALLY first:
 *   - a plan of SECTIONS (markdown headings, numbered titles, or one block);
 *   - a numbered list of REQUIREMENTS (R1..Rn) with their section.
 * A model pass (chunk by chunk) can REFINE the list when the deterministic
 * pass finds too little - it never replaces it, it completes it.
 *
 * Then planSteps() groups requirements into steps that CITE the requirement
 * ids they cover, so the final coverage table ("exigence -> fichiers -> test
 * -> fait / non fait / echec") is checkable and honest.
 *
 * Everything is pure Node + files under .sudo-agent/specs, ASCII-only source,
 * never throws at the caller (errors come back in { error }).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
// Above these thresholds a prompt is treated as a document, not as a message.
const THRESHOLD_LINES = 40;
const THRESHOLD_CHARS = 3000;
const MAX_REQUIREMENTS = 400;
const MAX_STEPS = 60;
const SECTION_READ_CHARS = 6000;
const REQS_PER_STEP = 3;

function specsDir(root) { return path.join(root, '.sudo-agent', 'specs'); }
function specPath(root, id) { return path.join(specsDir(root), safeId(id) + '.md'); }
function metaPath(root, id) { return path.join(specsDir(root), safeId(id) + '.json'); }
function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }

function sha8(s) {
  try { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }
  catch (_) { return String(Date.now()); }
}

// A prompt is a SPEC when it is long enough to be a document.
function isLongSpec(text, opts) {
  const t = String(text || '');
  const o = opts || {};
  const lines = t.split('\n').length;
  const minLines = Number.isFinite(o.minLines) ? o.minLines : intEnv('SUDO_AGENT_SPEC_LINES', THRESHOLD_LINES);
  const minChars = Number.isFinite(o.minChars) ? o.minChars : intEnv('SUDO_AGENT_SPEC_CHARS', THRESHOLD_CHARS);
  return lines >= minLines || t.length >= minChars;
}

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ---------------------------------------------------------------------------
// Sections: markdown headings first, then numbered titles, else one block.
// ---------------------------------------------------------------------------
const HEADING_RE = /^(#{1,6})\s+(.{1,120})$/;
const NUMTITLE_RE = /^(\d{1,2})[.)]\s+([A-Z][^.]{2,70})$/;

function extractSections(text) {
  const lines = String(text || '').split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\s+$/, '');
    const h = HEADING_RE.exec(l);
    if (h) { found.push({ title: h[2].trim(), line: i }); continue; }
    const nt = NUMTITLE_RE.exec(l);
    if (nt && l.length < 80 && !/[.!?]$/.test(l)) found.push({ title: nt[2].trim(), line: i });
  }
  if (!found.length) {
    return [{ n: 1, title: 'Document', startLine: 0, endLine: lines.length - 1 }];
  }
  const out = [];
  for (let k = 0; k < found.length; k++) {
    const start = k === 0 && found[0].line > 0 ? 0 : found[k].line;
    const end = (k + 1 < found.length) ? found[k + 1].line - 1 : lines.length - 1;
    out.push({ n: out.length + 1, title: found[k].title, startLine: start, endLine: end });
  }
  return out;
}

function sectionOfLine(sections, line) {
  for (const s of sections) if (line >= s.startLine && line <= s.endLine) return s.n;
  return sections.length ? sections[sections.length - 1].n : 1;
}

// ---------------------------------------------------------------------------
// Requirements: bullets, numbered items, checkboxes; fallback = "doit/must".
// ---------------------------------------------------------------------------
const BULLET_RE = /^\s{0,6}[-*+]\s+(.{6,400})$/;
const NUMITEM_RE = /^\s{0,6}\(\d{1,3}\)\s+(.{6,400})$|^\s{0,6}\d{1,3}[.)]\s+(.{6,400})$/;
const CHECKBOX_RE = /^\s{0,6}\[[ xX]\]\s+(.{6,400})$/;
const MUST_RE = /^.{0,200}?\b(doit|doivent|must|shall|obligatoire|exigence)\b.{4,400}$/i;

function cleanReq(s) {
  let t = String(s || '').trim();
  t = t.replace(/^[-*+]\s+/, '').replace(/^\[[ xX]\]\s+/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 300);
}

function extractRequirements(text, sections) {
  const lines = String(text || '').split('\n');
  const secs = sections || extractSections(text);
  const seen = {};
  const out = [];
  const push = (raw, line) => {
    const t = cleanReq(raw);
    if (!t || t.length < 6) return;
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen[key]) return;
    seen[key] = true;
    if (out.length >= MAX_REQUIREMENTS) return;
    out.push({ id: 'R' + (out.length + 1), text: t, section: sectionOfLine(secs, line), line: line + 1, source: 'det' });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cb = CHECKBOX_RE.exec(l);
    if (cb) { push(cb[1], i); continue; }
    const b = BULLET_RE.exec(l);
    if (b) { push(b[1], i); continue; }
    const ni = NUMITEM_RE.exec(l);
    if (ni) { push(ni[1] || ni[2], i); continue; }
  }
  if (!out.length) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].replace(/\s+$/, '');
      if (l.length < 12) continue;
      if (MUST_RE.test(l)) push(l, i);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan of steps: requirements grouped, each step CITES the ids it covers.
// ---------------------------------------------------------------------------
function planSteps(spec) {
  const reqs = (spec && spec.requirements) || [];
  const sections = (spec && spec.sections) || [];
  const steps = [];
  const bySection = {};
  reqs.forEach((r) => {
    const k = r.section || 1;
    (bySection[k] = bySection[k] || []).push(r);
  });
  const secTitle = (n) => {
    const s = sections.find((x) => x.n === n);
    return s ? s.title : ('Section ' + n);
  };
  const keys = Object.keys(bySection).map(Number).sort((a, b) => a - b);
  if (!keys.length) {
    // No requirement at all: one step per section (still runnable and honest).
    const use = sections.length ? sections : [{ n: 1, title: 'Document' }];
    use.slice(0, MAX_STEPS).forEach((s, i) => {
      steps.push({ i, text: 'Traiter la section "' + s.title + '" du cahier des charges', reqs: [], section: s.n, complex: false });
    });
    return steps;
  }
  for (const k of keys) {
    const list = bySection[k];
    for (let j = 0; j < list.length; j += REQS_PER_STEP) {
      const chunk = list.slice(j, j + REQS_PER_STEP);
      const ids = chunk.map((r) => r.id);
      const head = chunk[0].text.slice(0, 120);
      steps.push({
        i: steps.length,
        section: k,
        reqs: ids,
        text: 'Section "' + secTitle(k) + '" : realiser ' + ids.join(', ') + ' (' + head + ')',
        complex: false,
      });
    }
  }
  if (steps.length > MAX_STEPS) steps.length = MAX_STEPS;
  // "complex" = the widest steps; the model policy may route them elsewhere.
  const maxReqs = steps.reduce((m, s) => Math.max(m, s.reqs.length), 1);
  steps.forEach((s) => { s.complex = s.reqs.length >= maxReqs && maxReqs > 1; });
  return steps;
}

// ---------------------------------------------------------------------------
// Persistence + ingest
// ---------------------------------------------------------------------------
function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); return true; } catch (_) { return false; }
}

function ingest(root, prompt, opts) {
  const text = String(prompt || '');
  if (!text.trim()) return { error: 'cahier des charges vide' };
  const o = opts || {};
  const id = 'spec-' + sha8(text.slice(0, 4000) + '|' + text.length);
  const sections = extractSections(text);
  const requirements = extractRequirements(text, sections);
  const title = (sections[0] && sections[0].title) || 'Cahier des charges';
  const meta = {
    v: VERSION, id, title,
    lines: text.split('\n').length,
    chars: text.length,
    createdAt: new Date().toISOString(),
    sections, requirements,
    refined: false,
  };
  try {
    ensureDir(specsDir(root));
    fs.writeFileSync(specPath(root, id), text, 'utf8');
    fs.writeFileSync(metaPath(root, id), JSON.stringify(meta, null, 1), 'utf8');
  } catch (e) {
    return { error: 'ecriture du cahier impossible: ' + String((e && e.message) || e) };
  }
  return meta;
}

function load(root, id) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(root, id), 'utf8'));
    if (!meta || meta.v !== VERSION) return null;
    return meta;
  } catch (_) { return null; }
}

function save(root, meta) {
  try {
    ensureDir(specsDir(root));
    fs.writeFileSync(metaPath(root, meta.id), JSON.stringify(meta, null, 1), 'utf8');
    return true;
  } catch (_) { return false; }
}

function documentText(root, id) {
  try { return fs.readFileSync(specPath(root, id), 'utf8'); } catch (_) { return ''; }
}

// ONLY the useful slice ever reaches a step context (never the whole file).
function readSection(root, id, n) {
  const meta = load(root, id);
  if (!meta) return '';
  const text = documentText(root, id);
  const sec = (meta.sections || []).find((s) => s.n === Number(n)) || (meta.sections || [])[0];
  if (!sec) return text.slice(0, SECTION_READ_CHARS);
  const lines = text.split('\n');
  const slice = lines.slice(sec.startLine, sec.endLine + 1).join('\n');
  return slice.slice(0, SECTION_READ_CHARS);
}

// ---------------------------------------------------------------------------
// Model refinement (optional, chunked): the deterministic list is the floor.
// provider must expose chatOnce(provider, {model, messages}) like the loop's.
// ---------------------------------------------------------------------------
function chunks(text, size) {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = [];
  let n = 0;
  for (const l of lines) {
    cur.push(l);
    n += l.length + 1;
    if (n >= size) { out.push(cur.join('\n')); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

async function refineWithModel(opts) {
  const o = opts || {};
  const root = o.root;
  const meta = load(root, o.specId);
  if (!meta) return { error: 'cahier introuvable' };
  if (typeof o.chat !== 'function') return { error: 'chat indisponible' };
  const text = documentText(root, o.specId);
  const parts = chunks(text, o.chunkChars || 6000);
  const added = [];
  for (let i = 0; i < parts.length; i++) {
    const prompt = 'Extrait ' + (i + 1) + '/' + parts.length + ' d\'un cahier des charges.\n' +
      'Liste UNIQUEMENT les exigences verifiables, une par ligne, sans numero, sans commentaire.\n' +
      'Maximum 20 lignes. Si aucune exigence, reponds exactement: AUCUNE\n---\n' + parts[i];
    let reply = '';
    try {
      const r = await o.chat({ model: o.model, messages: [{ role: 'user', content: prompt }] });
      reply = String((r && r.text) || '');
    } catch (e) {
      return { error: 'appel modele echoue: ' + String((e && e.message) || e).slice(0, 160), added };
    }
    if (/^\s*AUCUNE\s*$/i.test(reply)) continue;
    const seen = {};
    meta.requirements.forEach((r) => { seen[r.text.toLowerCase()] = true; });
    reply.split('\n').map((l) => cleanReq(l)).filter((l) => l.length >= 8 && !/^AUCUNE$/i.test(l)).forEach((line) => {
      if (seen[line.toLowerCase()]) return;
      if (meta.requirements.length >= MAX_REQUIREMENTS) return;
      seen[line.toLowerCase()] = true;
      const r = { id: 'R' + (meta.requirements.length + 1), text: line, section: 1, line: 0, source: 'model' };
      meta.requirements.push(r);
      added.push(r);
    });
  }
  meta.refined = added.length > 0;
  save(root, meta);
  return { ok: true, added: added.length, total: meta.requirements.length, meta };
}

// Human-facing plan (what the user validates before anything runs).
function planText(spec, steps) {
  const st = steps || planSteps(spec);
  const L = [];
  L.push('PLAN DU CAHIER DES CHARGES : ' + spec.title);
  L.push(spec.lines + ' ligne(s), ' + (spec.sections || []).length + ' section(s), ' +
    (spec.requirements || []).length + ' exigence(s) numerotee(s), ' + st.length + ' etape(s).');
  L.push('');
  L.push('SECTIONS');
  (spec.sections || []).slice(0, 20).forEach((s) => L.push('  ' + s.n + '. ' + s.title));
  L.push('');
  L.push('EXIGENCES');
  (spec.requirements || []).slice(0, 40).forEach((r) => L.push('  ' + r.id + ' (S' + r.section + ') ' + r.text));
  if ((spec.requirements || []).length > 40) L.push('  ... ' + ((spec.requirements || []).length - 40) + ' autre(s)');
  L.push('');
  L.push('ETAPES');
  st.slice(0, 40).forEach((s) => L.push('  ' + (s.i + 1) + '/' + st.length + ' [' + (s.reqs.join(',') || 'section') + '] ' + s.text.slice(0, 140)));
  if (st.length > 40) L.push('  ... ' + (st.length - 40) + ' autre(s)');
  L.push('');
  L.push('Validez pour lancer (Lancer / Modifier), ou repondez "modifier" pour ajuster.');
  return L.join('\n');
}

module.exports = {
  VERSION, THRESHOLD_LINES, THRESHOLD_CHARS, MAX_REQUIREMENTS, MAX_STEPS, SECTION_READ_CHARS, REQS_PER_STEP,
  specsDir, specPath, metaPath,
  isLongSpec, extractSections, extractRequirements, planSteps,
  ingest, load, save, documentText, readSection,
  refineWithModel, planText, chunks, cleanReq, sectionOfLine,
};
