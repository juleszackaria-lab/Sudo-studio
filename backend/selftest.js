/**
 * selftest.js - P30(b): static require() audit for the packaged backend.
 *
 * Walks the require() tree transitively from an entry file (server.js) and
 * verifies EVERY literal require() resolves (dev tree or pkg snapshot).
 *   - bare require() that does not resolve  -> FATAL (would crash the boot,
 *    like the P29 ./ai/aiModelsManager crash) -> exit code 1 + missing list.
 *   - safeRequire() that does not resolve    -> WARNING (degraded 503 route
 *    by design, boot survives) -> exit code stays 0.
 *   - dynamic require() (variable path)      -> UNVERIFIABLE, listed, exit 0.
 * Builtins only (fs, path): runs even when node_modules is broken, and
 * inside the pkg snapshot (/snapshot/...) where require.resolve works.
 * ASCII only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Literal require shapes: require('x') and safeRequire('x', ...).
// NOTE: matches code AND comments, so comments are stripped before scanning
// (string-aware stripComments: block + line comments, offsets preserved).
const REQUIRE_RE = /(require|safeRequire)\s*\(\s*['"]([^'"]+)['"]/g;
// Any other require( shape = dynamic (variable, template, expression).
const REQUIRE_ANY_RE = /(require|safeRequire)\s*\(/g;

// String-aware comment stripper. Removes // and /* */ comments ONLY outside
// string literals (a '/*' inside '*/*' must not eat code). Template ${...}
// expressions are real code: comments inside them ARE stripped. Output keeps
// the exact length and newlines of the input (offsets stay valid).
function stripComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const tmpl = []; // stack of true while inside a template literal
  const expr = []; // stack of brace depths for ${...} inside templates
  while (i < n) {
    const c = src[i];
    const inStr = tmpl.length > 0 && tmpl[tmpl.length - 1] !== '`';
    const inTmplText = tmpl.length > 0 && tmpl[tmpl.length - 1] === '`' && expr.length < tmpl.length;
    if (!inStr && !inTmplText && c === '/') {
      if (src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') { out.push(' '); i++; }
        continue;
      }
      if (src[i + 1] === '*') {
        out.push(' ', ' ');
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out.push(src[i] === '\n' ? '\n' : ' ');
          i++;
        }
        if (i < n) { out.push(' ', ' '); i += 2; }
        continue;
      }
      // Possible regex literal (or division). A quote/backtick inside a
      // regex (e.g. /'/ or /`/) must NOT open a string: skip regexes with
      // the same heuristic as tryRanges (kept verbatim in the output).
      let j = i - 1;
      while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j--;
      const p = j >= 0 ? src[j] : '';
      if (p === '' || '([{,;=:!&|?+-*%<>^~'.indexOf(p) !== -1) {
        out.push(c);
        i++; // step past the OPENING slash (else it reads as the closing one)
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') { out.push(src[i], src[i + 1] || ''); i += 2; continue; }
          out.push(src[i]);
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { i++; break; }
          else if (src[i] === '\n') break;
          i++;
        }
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    if (!inStr && !inTmplText && (c === "'" || c === '"' || c === '`')) {
      tmpl.push(c);
      if (c !== '`') expr.push(-1); // keep stacks aligned: plain strings never hold ${}
      out.push(c);
      i++;
      continue;
    }
    if (inStr || inTmplText) {
      if (c === '\\') { out.push(c, src[i + 1] || ''); i += 2; continue; }
      const q = tmpl[tmpl.length - 1];
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        expr.push(0);
        out.push('$', '{');
        i += 2;
        continue;
      }
      if (c === q && !(q === '`' && expr.length >= tmpl.length)) {
        tmpl.pop();
        if (q !== '`') expr.pop();
        out.push(c);
        i++;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    // plain code (or inside ${...}): track braces for ${ depth
    if (c === '{' && expr.length >= tmpl.length && tmpl.length > 0 && tmpl[tmpl.length - 1] === '`') {
      expr[expr.length - 1]++;
    }
    if (c === '}' && expr.length >= tmpl.length && tmpl.length > 0 && tmpl[tmpl.length - 1] === '`') {
      if (expr[expr.length - 1] === 0) {
        expr.pop();
        out.push(c);
        i++;
        continue;
      }
      expr[expr.length - 1]--;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

function collectRequires(src) {
  const clean = stripComments(src);
  const literals = [];
  const seen = new Set();
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(clean)) !== null) {
    const before = m.index > 0 ? clean[m.index - 1] : '';
    if (before === '.' || /[\w$]/.test(before)) continue; // member access / longer identifier
    literals.push({ spec: m[2], tolerated: m[1] === 'safeRequire', line: lineOf(src, m.index), index: m.index });
    seen.add(m.index);
  }
  const dynamic = [];
  REQUIRE_ANY_RE.lastIndex = 0;
  while ((m = REQUIRE_ANY_RE.exec(clean)) !== null) {
    if (seen.has(m.index)) continue;
    // 'require' matched inside 'require.resolve(' or 'require.main' etc:
    // the char right after optional spaces is '.', not '(' content... actually
    // REQUIRE_ANY requires '(' after the name, so require.resolve( MATCHES here.
    // Exclude member access: char before 'require' is '.' or word char.
    const before = m.index > 0 ? clean[m.index - 1] : '';
    if (before === '.' || /[\w$]/.test(before)) continue;
    const pre = clean.slice(Math.max(0, m.index - 9), m.index);
    if (/function\s+$/.test(pre)) continue; // 'function safeRequire(' definition
    dynamic.push({ line: lineOf(src, m.index) });
  }
  return { literals, dynamic };
}

// Scan comment-stripped source, return [{start, end}] ranges of try{...} BODIES
// (catch/finally bodies excluded: a require failing there still crashes).
// String/comment-aware ({, } inside strings/templates/regex do not count).
// Returns { ranges, balanced } - balanced=false on brace mismatch (caller
// then treats the file as strictly as if no try existed, and reports it).
function tryRanges(clean) {
  const ranges = [];
  const stack = []; // {ch, tryStart, tmpl} entries for '{' (and '${' markers)
  const trys = []; // open try-body depths: {depth}
  let depth = 0;
  let i = 0;
  const n = clean.length;
  let balanced = true;
  const pushTmpl = [];
  while (i < n) {
    const c = clean[i];
    // strings
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (clean[i] === '\\') { i += 2; continue; }
        if (q === '`' && clean[i] === '$' && clean[i + 1] === '{') {
          pushTmpl.push(depth);
          depth++;
          stack.push({ tmpl: true });
          i += 2;
          continue;
        }
        if (clean[i] === q) { i++; break; }
        // inside ${...} of a template: braces handled by the main loop below;
        // detect the closing '}' via the tmpl marker when depth matches.
        if (q === '`' && clean[i] === '}' && pushTmpl.length > 0 && depth === pushTmpl[pushTmpl.length - 1] + 1) {
          pushTmpl.pop();
          stack.pop();
          depth--;
          i++;
          continue;
        }
        if (q === '`' && (clean[i] === '{' || clean[i] === '}')) {
          // brace inside template expression nesting - count it
          if (clean[i] === '{') { depth++; stack.push({}); }
          else {
            if (stack.length === 0) { balanced = false; break; }
            stack.pop();
            depth--;
            while (trys.length > 0 && trys[trys.length - 1].depth === depth) {
              const t = trys.pop();
              ranges.push({ start: t.start, end: i });
            }
          }
          i++;
          continue;
        }
        if (clean[i] === '\n' && q !== '`') break; // unterminated - give up on this string
        i++;
      }
      continue;
    }
    // regex literal (heuristic): '/' whose previous significant char cannot end an expression
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && (clean[j] === ' ' || clean[j] === '\t' || clean[j] === '\n' || clean[j] === '\r')) j--;
      const p = j >= 0 ? clean[j] : '';
      if (p === '' || '([{,;=:!&|?+-*%<>^~'.indexOf(p) !== -1) {
        i++;
        let inClass = false;
        while (i < n) {
          if (clean[i] === '\\') { i += 2; continue; }
          if (clean[i] === '[') inClass = true;
          else if (clean[i] === ']') inClass = false;
          else if (clean[i] === '/' && !inClass) { i++; break; }
          else if (clean[i] === '\n') break;
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    if (c === '{') { depth++; stack.push({}); i++; continue; }
    if (c === '}') {
      if (stack.length === 0) { balanced = false; break; }
      stack.pop();
      depth--;
      while (trys.length > 0 && trys[trys.length - 1].depth === depth) {
        const t = trys.pop();
        ranges.push({ start: t.start, end: i });
      }
      i++;
      continue;
    }
    // identifier 'try' followed by '{'
    if ((c === 't') && clean.slice(i, i + 3) === 'try' &&
        (i === 0 || !/[\w$]/.test(clean[i - 1])) &&
        (i + 3 >= n || !/[\w$]/.test(clean[i + 3]))) {
      let k = i + 3;
      while (k < n && (clean[k] === ' ' || clean[k] === '\t' || clean[k] === '\n' || clean[k] === '\r')) k++;
      if (clean[k] === '{') {
        // Record the depth BEFORE the try's '{': its matching '}' brings
        // the depth back to this value (compare after decrement on '}').
        trys.push({ depth, start: k });
      }
      i += 3;
      continue;
    }
    i++;
  }
  if (stack.length !== 0 || trys.length !== 0) balanced = false;
  return { ranges, balanced };
}

function inTry(ranges, pos) {
  for (const r of ranges) {
    if (pos > r.start && pos < r.end) return true;
  }
  return false;
}

function tryResolve(spec, fromDir) {
  try {
    return { ok: true, file: require.resolve(spec, { paths: [fromDir] }) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).split('\n')[0] };
  }
}

function audit(entryFile) {
  const fatal = [];
  const warnings = [];
  const dynamic = [];
  const files = [];
  const resolvedCount = { n: 0 };
  const visited = new Set();
  const queue = [path.resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      fatal.push({ file, line: 0, spec: '(unreadable: ' + e.message + ')', error: e.message });
      continue;
    }
    files.push(file);
    const clean = stripComments(src);
    const { literals, dynamic: dyn } = collectRequires(src);
    for (const d of dyn) dynamic.push({ file, line: d.line });
    const tr = tryRanges(clean);
    if (!tr.balanced) dynamic.push({ file, line: 0, note: 'brace scan unbalanced - strict verdicts' });
    const fromDir = path.dirname(file);
    for (const lit of literals) {
      const r = tryResolve(lit.spec, fromDir);
      if (r.ok) {
        resolvedCount.n++;
        if (/\.js$/.test(r.file) && !visited.has(r.file)) queue.push(r.file);
      } else if (lit.tolerated) {
        warnings.push({ file, line: lit.line, spec: lit.spec, error: r.error, via: 'safeRequire' });
      } else if (tr.balanced && inTry(tr.ranges, lit.index)) {
        warnings.push({ file, line: lit.line, spec: lit.spec, error: r.error, via: 'try/catch' });
      } else {
        fatal.push({ file, line: lit.line, spec: lit.spec, error: r.error });
      }
    }
  }
  return { files, resolved: resolvedCount.n, fatal, warnings, dynamic };
}

function printReport(res) {
  const out = [];
  out.push('SELFTEST: ' + res.files.length + ' files scanned, ' + res.resolved + ' require() resolved');
  for (const w of res.warnings) {
    out.push('SELFTEST WARNING (' + (w.via || 'safeRequire') + ', boot survives): ' + w.file + ':' + w.line + " -> '" + w.spec + "'");
  }
  for (const d of res.dynamic) {
    out.push('SELFTEST UNVERIFIABLE (dynamic require' + (d.note ? ': ' + d.note : '') + '): ' + d.file + ':' + d.line);
  }
  for (const f of res.fatal) {
    out.push('SELFTEST MISSING: ' + f.file + ':' + f.line + " -> '" + f.spec + "' (" + f.error + ')');
  }
  if (res.fatal.length === 0) out.push('SELFTEST PASS');
  else out.push('SELFTEST FAIL: ' + res.fatal.length + ' missing module(s)');
  return out.join('\n') + '\n';
}

function runAndExit(entryFile) {
  const res = audit(entryFile);
  const report = printReport(res);
  try { fs.writeSync(1, report); } catch (_) { console.log(report); }
  process.exit(res.fatal.length === 0 ? 0 : 1);
}

module.exports = { audit, printReport, runAndExit, collectRequires, stripComments, tryRanges, inTry };
