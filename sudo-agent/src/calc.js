// P63-F18 - calcul deterministe, sans modele.
//
// "2 + 298" n'a aucune raison de passer par un LLM : un petit evaluateur
// d'expressions arithmetiques rend le resultat exact, reproductible et
// instantane. Toute autre demande rend null (le modele reprend la main).
//
// Grammaire : nombres (entiers/decimaux), + - * / % ( ), exposant ^.
// Aucune fonction, aucune variable, aucun acces au disque ou au reseau.
'use strict';

const ALLOWED = /^[\d\s+\-*/%().,^]+$/;

function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src).replace(/,/g, '.').replace(/\s+/g, '');
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) return null;
      out.push({ t: 'n', v: num });
      i = j;
      continue;
    }
    if ('+-*/%^()'.indexOf(c) !== -1) { out.push({ t: c }); i++; continue; }
    return null;
  }
  return out;
}

// Shunting-yard -> notation polonaise -> evaluation.
function evaluate(src) {
  const raw = String(src == null ? '' : src).trim();
  if (!raw || !ALLOWED.test(raw)) return null;
  const toks = tokenize(raw);
  if (!toks || !toks.length) return null;
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  const out = [];
  const ops = [];
  let prev = null;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === 'n') { out.push(tk.v); prev = 'n'; continue; }
    if (tk.t === '(') { ops.push('('); prev = '('; continue; }
    if (tk.t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (!ops.length) return null;
      ops.pop();
      prev = ')';
      continue;
    }
    // operateur unaire : "-3" ou "+3" en debut d'expression
    if ((tk.t === '-' || tk.t === '+') && (prev === null || prev === '(' || prec[prev])) {
      out.push(0);
    }
    while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[tk.t]) {
      out.push(ops.pop());
    }
    ops.push(tk.t);
    prev = tk.t;
  }
  while (ops.length) {
    const o = ops.pop();
    if (o === '(') return null;
    out.push(o);
  }
  // evaluation
  const st = [];
  for (let k = 0; k < out.length; k++) {
    const v = out[k];
    if (typeof v === 'number') { st.push(v); continue; }
    const b = st.pop();
    const a = st.pop();
    if (a === undefined || b === undefined) return null;
    if (v === '+') st.push(a + b);
    else if (v === '-') st.push(a - b);
    else if (v === '*') st.push(a * b);
    else if (v === '/') { if (b === 0) return null; st.push(a / b); }
    else if (v === '%') { if (b === 0) return null; st.push(a % b); }
    else if (v === '^') st.push(Math.pow(a, b));
    else return null;
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) return null;
  return st[0];
}

// Une demande "calcul" : l'expression seule, eventuellement suivie de "=".
function isCalc(text) {
  const t = String(text == null ? '' : text).trim().replace(/[?=]+\s*$/, '').trim();
  if (!t || t.length > 120) return false;
  if (!ALLOWED.test(t)) return false;
  if (!/[0-9]/.test(t) || !/[+\-*/%^]/.test(t)) return false;
  return evaluate(t) !== null;
}

// Formate sans bruit flottant : 300, 0.5, 1.25.
function format(v) {
  if (Number.isInteger(v)) return String(v);
  const s = String(Math.round(v * 1e10) / 1e10);
  return s;
}

function answer(text) {
  const t = String(text == null ? '' : text).trim().replace(/[?=]+\s*$/, '').trim();
  const v = evaluate(t);
  if (v === null) return null;
  return format(v);
}

module.exports = { evaluate, isCalc, format, answer, ALLOWED };
