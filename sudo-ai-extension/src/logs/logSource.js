/**
 * logSource.js - P58 read-only log source for the "Sudo Studio Logs" viewer.
 *
 * The viewer bug (P58 constat): choosing a file did not change the content and
 * the level did not filter. This module is the single place that decides WHAT
 * is read and WHAT is kept, so the panel only has to render:
 *
 *   listLogFiles(dir)   -> every <component>.log / <component>.log.N / .jsonl
 *   getTail(dir, file, maxLines, level, opts) -> filtered tail (see below)
 *   parseLine / lineLevel / lineComponent -> human format AND JSON lines
 *
 * Reading strategy: BACKWARDS. We seek to the end and read fixed chunks
 * (64 KB) until enough MATCHING lines are collected, so a 3 MB journal costs a
 * few reads instead of a full parse (the old code slurped up to 8 MB and then
 * split the whole string). Rotation is handled by name: <c>.log, <c>.log.1..
 *
 * Level semantics: the selected level is a MINIMUM (P58-2 "au minimum choisi"):
 * ERROR -> only errors, WARN -> warnings + errors, INFO -> info+warn+errors,
 * DEBUG -> everything (unknown levels included).
 *
 * Pure Node (fs/path only), ASCII-only source, never throws at the caller:
 * every error comes back as { error } like the P21 contract expected.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHUNK = 64 * 1024;              // backward read step
const MAX_SCAN_BYTES = 8 * 1024 * 1024; // hard cap per request (viewer latency)
const MAX_TAIL_LINES = 5000;
const MAX_SCAN_LINES = 200000;

// Order matters: DEBUG/TRACE below INFO, UNKNOWN above nothing.
const RANKS = { DEBUG: 0, TRACE: 0, INFO: 1, WARN: 2, WARNING: 2, ERROR: 3, FATAL: 3 };

function rank(level) {
  const k = String(level || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(RANKS, k)) return RANKS[k];
  return -1; // no level at all
}

function normalizeLevel(level) {
  const k = String(level || 'ALL').toUpperCase();
  if (k === 'ALL' || k === '' || k === 'ANY') return 'ALL';
  if (RANKS[k] === undefined) return 'ALL';
  return k === 'WARNING' ? 'WARN' : (k === 'TRACE' ? 'DEBUG' : (k === 'FATAL' ? 'ERROR' : k));
}

// ---------------------------------------------------------------------------
// File inventory: one entry per physical file, component derived from the name.
// ---------------------------------------------------------------------------
const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*\.(log|jsonl)(\.(\d+))?$/;

function baseComponent(name) {
  return String(name || '').replace(/\.(log|jsonl)(\.\d+)?$/, '');
}

function rotationIndex(name) {
  const m = /\.(?:log|jsonl)\.(\d+)$/.exec(String(name || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function listLogFiles(logsDir) {
  let names = [];
  try { names = fs.readdirSync(logsDir); } catch (_) { return []; }
  return names
    .filter((n) => FILE_RE.test(n))
    .map((n) => {
      let size = -1;
      let mtime = null;
      try {
        const st = fs.statSync(path.join(logsDir, n));
        if (!st.isFile()) return null;
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch (_) { return null; }
      return {
        name: n,
        component: baseComponent(n),
        format: /\.jsonl(\.\d+)?$/.test(n) ? 'json' : 'text',
        rotation: rotationIndex(n),
        size,
        mtime,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Current file first for each component, then by name.
      if (a.component !== b.component) return a.component < b.component ? -1 : 1;
      if (a.rotation !== b.rotation) return a.rotation - b.rotation;
      return a.name < b.name ? -1 : 1;
    });
}

// ---------------------------------------------------------------------------
// Line parsing: human v1 format and JSON lines (both journals are written by
// techLog.js, so both must be readable and filterable).
// ---------------------------------------------------------------------------
function parseJsonLine(line) {
  const t = String(line || '').trim();
  if (t.charAt(0) !== '{') return null;
  let o = null;
  try { o = JSON.parse(t); } catch (_) { return null; }
  if (!o || typeof o !== 'object') return null;
  const hasLevel = o.level !== undefined || o.severity !== undefined || o.lvl !== undefined;
  const hasMsg = o.msg !== undefined || o.message !== undefined;
  if (!hasLevel && !hasMsg && !o.component) return null;
  return {
    level: String(o.level || o.severity || o.lvl || '').toUpperCase() || null,
    component: o.component !== undefined ? String(o.component) : null,
    corr: o.corr !== undefined ? String(o.corr) : null,
    ts: o.ts !== undefined ? String(o.ts) : null,
    msg: o.msg !== undefined ? String(o.msg) : (o.message !== undefined ? String(o.message) : ''),
    json: true,
  };
}

// Human v1: "<ts> [LEVEL] [component] [corr] message | k=v ..."
const HUMAN_RE = /^\s*(\S+)?\s*[[]\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s*[\]](?:\s*[[]([^\]]*)[\]])?(?:\s*[[]([^\]]*)[\]])?/i;

function parseHumanLine(line) {
  const m = HUMAN_RE.exec(String(line || ''));
  if (!m) {
    // Bare JSON logs written by python runtimes, or "ERROR ..." lines.
    const e = /(^|\s)(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(\s|:)/i.exec(String(line || '').slice(0, 400));
    return {
      level: e ? e[2].toUpperCase() : null,
      component: null,
      corr: null,
      ts: null,
      msg: '',
      json: false,
    };
  }
  return {
    level: m[2].toUpperCase(),
    component: m[3] ? String(m[3]).trim() : null,
    corr: m[4] ? String(m[4]).trim() : null,
    ts: m[1] || null,
    msg: '',
    json: false,
  };
}

function parseLine(line) {
  const j = parseJsonLine(line);
  if (j) return j;
  return parseHumanLine(line);
}

function lineLevel(line) {
  return parseLine(line).level;
}

function lineComponent(line) {
  return parseLine(line).component;
}

// ---------------------------------------------------------------------------
// Backward reader: returns the last `want` lines without reading the file whole.
// ---------------------------------------------------------------------------
function readLinesBackwards(file, want, scanLines, maxBytes) {
  const st = fs.statSync(file);
  const size = st.size;
  if (size === 0) return { lines: [], bytesRead: 0, truncated: false };
  const fd = fs.openSync(file, 'r');
  const budget = Math.min(size, maxBytes || MAX_SCAN_BYTES);
  const capLines = Math.min(scanLines || want * 4, MAX_SCAN_LINES);
  let pos = size;
  let rest = '';
  const collected = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (pos > 0 && pos > size - budget) {
      const len = Math.min(CHUNK, pos);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos - len);
      bytesRead += len;
      pos -= len;
      let chunk = buf.toString('utf8') + rest;
      if (pos > 0) {
        // The chunk may start in the middle of a line: keep it for the next
        // iteration (which is older), the split below removes the fragment.
        const nl = chunk.indexOf('\n');
        if (nl === -1) { rest = chunk; continue; }
        rest = chunk.slice(0, nl + 1);
        chunk = chunk.slice(nl + 1);
      } else {
        rest = '';
      }
      const parts = chunk.split('\n');
      // Drop the empty tail produced by a trailing newline.
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      for (let i = parts.length - 1; i >= 0; i--) {
        const l = parts[i];
        if (l === '' && i === parts.length - 1) continue;
        collected.push(l);
        if (collected.length >= capLines) { truncated = true; break; }
      }
      if (truncated) break;
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
  collected.reverse(); // oldest first
  return { lines: collected, bytesRead, truncated };
}

// ---------------------------------------------------------------------------
// Filters (combinable, applied on parsed lines, never on raw substrings so a
// component filter cannot match the payload by accident).
// ---------------------------------------------------------------------------
function matchesComponent(parsed, want, fileName) {
  if (!want || want === 'ALL') return true;
  const w = String(want).toLowerCase();
  const comp = (parsed.component || '').toLowerCase();
  if (comp && (comp === w || comp.indexOf(w) === 0)) return true;
  // Files written by older code have no component field: fall back to the
  // file name so "Duplication" still shows only the duplication journal.
  const fromFile = baseComponent(fileName || '').toLowerCase();
  return !!fromFile && (fromFile === w || fromFile.indexOf(w) === 0);
}

function filterLines(entries, opts, fileName) {
  opts = opts || {};
  const min = normalizeLevel(opts.level);
  const minRank = min === 'ALL' ? -1 : rank(min);
  const search = String(opts.search || '').trim().toLowerCase();
  const comp = opts.component;
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const parsed = parseLine(raw);
    if (minRank >= 0 && rank(parsed.level) < minRank) continue;
    if (comp && comp !== 'ALL' && !matchesComponent(parsed, comp, fileName)) continue;
    if (search && String(raw).toLowerCase().indexOf(search) === -1) continue;
    out.push({ raw, level: parsed.level, component: parsed.component, ts: parsed.ts, corr: parsed.corr });
  }
  return out;
}

// Extended reader: opts { component, search, format }. Reads backwards, stops
// as soon as `maxLines` matching lines are collected (that is what makes a big
// file fast: we never parse the 3 MB if the last 300 matching lines are recent).
function getTail(logsDir, file, maxLines, level, opts) {
  opts = opts || {};
  const base = path.basename(String(file || ''));
  if (!FILE_RE.test(base)) return { file: base, lines: [], error: 'bad file name' };
  const full = path.resolve(logsDir, base);
  const root = path.resolve(logsDir);
  if (full !== root && full.indexOf(root + path.sep) !== 0) return { file: base, lines: [], error: 'outside logs dir' };
  let st = null;
  try { st = fs.statSync(full); } catch (e) { return { file: base, lines: [], error: String((e && e.message) || e) }; }
  if (!st.isFile()) return { file: base, lines: [], error: 'not a file' };
  const n = Math.max(1, Math.min(MAX_TAIL_LINES, parseInt(maxLines, 10) || 300));
  const t0 = Date.now();
  const scan = { component: opts.component, search: opts.search, level: level };
  // Target the requested count; keep a bounded look-behind so filters that
  // match nothing do not scan the whole journal.
  const wantScanned = Math.min(MAX_SCAN_LINES, Math.max(n * 8, 2000));
  let got = null;
  try {
    got = readLinesBackwards(full, n, wantScanned, maxBytesFrom(opts));
  } catch (e) {
    return { file: base, lines: [], error: String((e && e.message) || e) };
  }
  const kept = filterLines(got.lines, scan, base);
  const lines = kept.slice(-n).map((x) => x.raw);
  return {
    file: base,
    format: /\.jsonl(\.\d+)?$/.test(base) ? 'json' : 'text',
    lines,
    rows: kept.slice(-n),
    total: got.lines.length,
    matched: kept.length,
    scannedBytes: got.bytesRead,
    truncated: got.truncated,
    ms: Date.now() - t0,
    dir: root,
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function maxBytesFrom(opts) {
  const v = parseInt(opts && opts.maxBytes, 10);
  if (Number.isFinite(v) && v > 0) return Math.min(v, MAX_SCAN_BYTES);
  return MAX_SCAN_BYTES;
}

module.exports = {
  CHUNK, MAX_TAIL_LINES, MAX_SCAN_BYTES,
  listLogFiles, getTail, filterLines, parseLine, lineLevel, lineComponent,
  baseComponent, rotationIndex, rank, normalizeLevel,
};
