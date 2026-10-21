// Sudo Agent project boundary (P25-b). Every tool path is normalized and
// contained: .., absolute paths, symlinks, UNC, drive changes are refused
// when they escape the open project folder. Pure + fs hybrid, stdlib only.
// Win32 spellings can be evaluated with { platform:'win32' } on any host
// (lexical logic is real; only the host fs differs). ASCII only.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_PATH_CHARS = 4096;

function tokenFlavor(t) {
  if (/^[A-Za-z]:[\\/]/.test(t) || t.indexOf('\\\\') === 0) return 'win32';
  return 'posix';
}

function isUNC(t) {
  return /^\\\\[^\\]/.test(t);
}

// Nearest existing ancestor, realpath()ed, rest re-appended (symlink-aware).
function resolveLinks(mod, abs) {
  try {
    let cur = abs;
    const rest = [];
    for (;;) {
      if (fs.existsSync(cur)) break;
      const parent = mod.dirname(cur);
      if (!parent || parent === cur) return abs;
      rest.unshift(mod.basename(cur));
      cur = parent;
    }
    let real = cur;
    try { real = fs.realpathSync(cur); } catch (_) { return abs; }
    return rest.length ? mod.join(real, ...rest) : real;
  } catch (_) { return abs; }
}

// Rewalk root -> abs segment by segment, matching each segment against the
// real directory entries case-insensitively. Returns the corrected absolute
// path on full match, null otherwise. Bounded, never throws.
function fixCaseSegments(root, abs, mod) {
  try {
    let rel = mod.relative(root, abs);
    if (!rel || rel === '..' || rel.indexOf('..' + mod.sep) === 0) return null;
    const segs = rel.split(mod.sep).filter((s) => s && s !== '.');
    if (!segs.length || segs.length > 64) return null;
    // Lexical segments come from `mod` (win32 spelling); the fs walk uses
    // the HOST path module so { platform:'win32' } stays testable on posix.
    let cur = root;
    const fixed = [];
    for (const seg of segs) {
      let entries = null;
      try { entries = fs.readdirSync(cur); } catch (_) { return null; }
      const low = seg.toLowerCase();
      let hit = null;
      for (const e of entries) {
        if (e.toLowerCase() === low) { hit = e; break; }
      }
      if (hit === null) return null;
      fixed.push(hit);
      cur = path.join(cur, hit);
    }
    return cur; // host-joined: identical on win32, usable under override
  } catch (_) { return null; }
}

// Resolve `input` inside `root`.
// Returns { ok:true, abs, rel, flavor } or { ok:false, reason, code }.
// Codes: bad_input | unc | win32_on_posix | ads | drive | outside | symlink_escape.
function resolveInRoot(root, input, opts) {
  opts = opts || {};
  const plat = opts.platform || process.platform;
  const mod = plat === 'win32' ? path.win32 : path.posix;
  const fail = (code, reason) => ({ ok: false, code, reason });

  if (typeof root !== 'string' || !root) return fail('bad_input', 'dossier du projet manquant.');
  let raw = input === undefined || input === null ? '' : String(input);
  if (!raw.trim()) return fail('bad_input', 'chemin vide.');
  if (raw.length > MAX_PATH_CHARS) return fail('bad_input', 'chemin trop long.');
  raw = raw.trim();
  if (raw.indexOf('\0') !== -1) return fail('bad_input', 'chemin invalide (NUL).');

  // Home shortcut: expand, then contain (almost always refused, unless inside).
  if (raw === '~' || raw.indexOf('~/') === 0 || raw.indexOf('~\\') === 0) {
    try {
      const os = require('os');
      raw = os.homedir() + raw.slice(1);
    } catch (_) { return fail('bad_input', 'chemin invalide (~).'); }
  }

  // UNC can never be inside a local project root.
  if (isUNC(raw)) return fail('unc', 'chemin reseau (UNC) interdit : hors projet.');

  const flavor = tokenFlavor(raw);
  // A Windows-spelled path on a non-Windows host is, by definition, outside.
  if (flavor === 'win32' && plat !== 'win32') {
    return fail('win32_on_posix', 'chemin Windows hors projet (autre lecteur).');
  }
  // ADS streams (file:stream) are refused on win32 spellings.
  if (flavor === 'win32') {
    const stripped = raw.replace(/^[A-Za-z]:[\\/]/, '');
    if (stripped.indexOf(':') !== -1) return fail('ads', 'flux ADS interdit.');
  }

  let abs = null;
  try {
    abs = mod.isAbsolute(raw) ? mod.normalize(raw) : mod.resolve(root, raw);
  } catch (_) { return fail('bad_input', 'chemin invalide.'); }

  // Drive change (win32): root C:\... vs abs D:\... -> refuse.
  if (plat === 'win32') {
    let rootDrive = '';
    let absDrive = '';
    try { rootDrive = String(mod.parse(root).root || '').toLowerCase(); } catch (_) {}
    try { absDrive = String(mod.parse(abs).root || '').toLowerCase(); } catch (_) {}
    if (rootDrive && absDrive && rootDrive !== absDrive) {
      return fail('drive', 'autre lecteur interdit : hors projet.');
    }
  }

  const contained = (candidate) => {
    let rel = null;
    try { rel = mod.relative(root, candidate); } catch (_) { return null; }
    if (plat === 'win32') rel = rel.toLowerCase();
    if (rel === '' ) return { rel: '' };
    if (rel === '..' || rel.indexOf('..' + mod.sep) === 0 || mod.isAbsolute(rel)) return null;
    return { rel };
  };

  let lex = contained(abs);
  if (!lex) return fail('outside', 'chemin hors projet (.. ou absolu exterieur).');

  // P39-b: on win32 spellings, resolve each segment against the real
  // directory entries (case-insensitive, like the OS). A full match
  // corrects the case; a partial match leaves the original spelling so
  // the caller reports not_found with an enriched hint. Separators / and
  // \ are both accepted by mod.resolve above on win32.
  if (plat === 'win32' && lex.rel !== '') {
    const fixed = fixCaseSegments(root, abs, mod);
    if (fixed && fixed !== abs) {
      const lex2 = contained(fixed);
      if (lex2) { abs = fixed; lex = lex2; }
    }
  }

  // Symlink-aware recheck on the real path.
  const real = resolveLinks(mod, abs);
  if (real !== abs) {
    const recheck = contained(real);
    if (!recheck) return fail('symlink_escape', 'lien symbolique hors projet.');
    return { ok: true, abs: real, rel: recheck.rel, flavor, viaSymlink: true };
  }
  return { ok: true, abs, rel: lex.rel, flavor, viaSymlink: false };
}

module.exports = { resolveInRoot, tokenFlavor, isUNC, MAX_PATH_CHARS, fixCaseSegments };
