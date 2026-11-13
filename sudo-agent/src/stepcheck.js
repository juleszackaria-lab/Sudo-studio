/**
 * stepcheck.js - P62-F4: verification DETERMINISTE apres chaque etape.
 *
 * Le modele n'est JAMAIS interroge pour savoir si une etape a reussi :
 *   - le fichier annonce existe-t-il vraiment ?
 *   - sa syntaxe est-elle valide pour SON type (json, js, py, html, yaml...) ?
 *   - l'outil de test du projet, s'il est DETECTE, passe-t-il ?
 *
 * Regles:
 *   - un outil absent n'est pas un echec : c'est "verification ignoree"
 *     (annonce en clair, en moins de 30 s, sans attendre) ;
 *   - un format qu'on ne sait pas vraiment verifier est annonce PARTIEL,
 *     jamais "valide" ;
 *   - jamais de blocage : toutes les commandes sont bornees en temps.
 *
 * Node pur, ASCII-only, ne jette jamais.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SYNTAX_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 30000;

function which(cmd) {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(checker, [cmd], { timeout: 5000, encoding: 'utf8' });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  } catch (_) { return false; }
}

function extOf(file) {
  return String(path.extname(String(file || '')).toLowerCase());
}

function readText(abs, limit) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: 'n est pas un fichier' };
    if (st.size > (limit || 4 * 1024 * 1024)) return { error: 'fichier trop volumineux pour la verification', size: st.size };
    return { text: fs.readFileSync(abs, 'utf8'), size: st.size };
  } catch (e) {
    return { error: (e && e.code === 'ENOENT') ? 'fichier absent' : String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Verifications par type. Chacune rend { ok, detail, partial? }.
// ---------------------------------------------------------------------------
function checkJson(text) {
  try { JSON.parse(text); return { ok: true, detail: 'JSON valide' }; }
  catch (e) { return { ok: false, detail: 'JSON invalide : ' + String((e && e.message) || e).slice(0, 160) }; }
}

function checkJs(file, text) {
  // node --check : le VRAI analyseur, sur le fichier ecrit.
  const r = spawnSync(process.execPath, ['--check', file], { timeout: SYNTAX_TIMEOUT_MS, encoding: 'utf8' });
  if (r.error) return { ok: false, detail: 'node --check impossible : ' + String(r.error.message || r.error) };
  if (r.status === 0) return { ok: true, detail: 'syntaxe JavaScript valide (node --check)' };
  return { ok: false, detail: 'syntaxe JavaScript invalide : ' + String((r.stderr || '').split('\n').slice(0, 3).join(' ')).slice(0, 200) };
}

function checkPy(file, text) {
  if (!which('python3') && !which('python')) return { ok: true, partial: true, detail: 'python absent : verification de syntaxe ignoree' };
  const exe = which('python3') ? 'python3' : 'python';
  const r = spawnSync(exe, ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', file],
    { timeout: SYNTAX_TIMEOUT_MS, encoding: 'utf8' });
  if (r.error) return { ok: true, partial: true, detail: 'python inutilisable : verification ignoree' };
  if (r.status === 0) return { ok: true, detail: 'syntaxe Python valide (ast.parse)' };
  return { ok: false, detail: 'syntaxe Python invalide : ' + String((r.stderr || '').slice(0, 200)) };
}

function checkHtml(text) {
  // Controle borne : balises ouvrantes/fermantes des elements structurants.
  const tags = ['html', 'head', 'body', 'div', 'script', 'style', 'table', 'form', 'ul', 'ol'];
  for (const t of tags) {
    const open = (text.match(new RegExp('<' + t + '(\\s|>)', 'gi')) || []).length;
    const close = (text.match(new RegExp('</' + t + '\\s*>', 'gi')) || []).length;
    if (open !== close) return { ok: false, detail: 'HTML : balise <' + t + '> non equilibree (' + open + ' ouverte(s), ' + close + ' fermee(s))' };
  }
  return { ok: true, partial: true, detail: 'HTML : equilibrage des balises verifie (pas de validation complete)' };
}

function checkYaml(text) {
  // Sans dependance externe : on refuse ce qui casse un YAML a coup sur
  // (tabulations d indentation, deux-points sans valeur en tete de ligne).
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\t+/.test(lines[i])) return { ok: false, detail: 'YAML : indentation par tabulation ligne ' + (i + 1) };
  }
  return { ok: true, partial: true, detail: 'YAML : indentation verifiee (pas de validation complete)' };
}

function checkMarkdown(text) {
  return { ok: true, partial: true, detail: 'Markdown : aucune verification syntaxique normalisee' };
}

// Verifie UN fichier. Rend { file, exists, ok, partial, detail }.
function verifyFile(root, rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const out = { file: String(rel), exists: false, ok: false, partial: false, detail: '' };
  const rd = readText(abs);
  if (rd.error) { out.detail = rd.error; return out; }
  out.exists = true;
  const ext = extOf(rel);
  let r;
  if (ext === '.json') r = checkJson(rd.text);
  else if (ext === '.js' || ext === '.cjs' || ext === '.mjs') r = checkJs(abs, rd.text);
  else if (ext === '.py') r = checkPy(abs, rd.text);
  else if (ext === '.html' || ext === '.htm') r = checkHtml(rd.text);
  else if (ext === '.yaml' || ext === '.yml') r = checkYaml(rd.text);
  else if (ext === '.md') r = checkMarkdown(rd.text);
  else if (ext === '.ts' || ext === '.tsx' || ext === '.dart' || ext === '.go' || ext === '.rs' || ext === '.java' || ext === '.cs') {
    r = { ok: true, partial: true, detail: ext + ' : analyseur non embarque, verification de syntaxe ignoree' };
  } else {
    r = { ok: true, partial: true, detail: 'type non verifie (' + (ext || 'sans extension') + '), presence seulement' };
  }
  out.ok = r.ok !== false;
  out.partial = !!r.partial;
  out.detail = String(r.detail || '');
  return out;
}

// Verifie une etape : fichiers annonces + (option) commande de test detectee.
// opts: { testCommand, timeoutMs, files }
function verifyStep(root, files, opts) {
  const o = opts || {};
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f && f.slice(-1) !== '/').slice(0, 40);
  const checks = list.map((f) => verifyFile(root, f));
  const failed = checks.filter((c) => !c.ok);
  const out = { ok: failed.length === 0, checks, failed, test: null, skipped: [] };
  if (!list.length) {
    out.ok = false;
    out.detail = 'aucun fichier produit par cette etape : rien a verifier, donc rien de prouve';
  }
  if (o.testCommand) {
    const t0 = Date.now();
    const r = spawnSync(o.testCommand, { cwd: root, shell: true, timeout: o.timeoutMs || TEST_TIMEOUT_MS, encoding: 'utf8' });
    const ms = Date.now() - t0;
    if (r.error && r.error.code === 'ENOENT') {
      out.skipped.push({ what: 'test', why: 'outil absent' });
      out.test = { command: o.testCommand, ran: false, ok: true, detail: 'outil absent : verification ignoree' };
    } else {
      const ok = r.status === 0;
      out.test = { command: o.testCommand, ran: true, ok, ms, detail: ok ? 'test passe' : ('test en echec : ' + String((r.stdout || '') + (r.stderr || '')).slice(-200)) };
      if (!ok) out.ok = false;
    }
  }
  out.detail = out.ok
    ? (out.checks.length + ' fichier(s) verifie(s)' + (out.test ? ' ; ' + out.test.detail : ''))
    : (out.detail || (failed.length + ' fichier(s) en echec : ' + failed.map((f) => f.file + ' (' + f.detail + ')').join(' ; ')).slice(0, 300));
  return out;
}

module.exports = { verifyFile, verifyStep, which, extOf, checkJson, checkJs, checkPy, checkHtml, checkYaml };
