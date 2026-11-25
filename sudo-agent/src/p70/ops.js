'use strict';
/**
 * P70-B7 : execution des operations de base, avec preuve sur le disque.
 *
 * Principes :
 *   - on PLANIFIE d'abord (ce qui va disparaitre, combien de fichiers) ;
 *   - l'approbation est affichee AVANT (le texte est produit ici, pas par le modele) ;
 *   - les suppressions passent par un point de retour CIBLE (copie exacte de la
 *     cible + manifeste), pas un instantane de 500 fichiers ;
 *   - apres execution, on VERIFIE sur le disque : le fait affiche vient de
 *     fs.existsSync, jamais du modele ;
 *   - les cibles protegees demandent une confirmation distincte.
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
}

function countTree(abs) {
  const files = [];
  let bytes = 0;
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return { kind: 'file', files: [abs], count: 1, bytes: st.size };
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        files.push(p);
        try { bytes += fs.statSync(p).size; } catch (_) { /* ignore */ }
      }
    }
  }
  return { kind: 'dir', files, count: files.length, bytes };
}

/** Plan d'une operation destructive : ce que l'operateur doit voir. */
function plan(abs, rel) {
  const info = countTree(abs);
  return {
    abs, rel, kind: info.kind, count: info.count, bytes: info.bytes,
    sample: info.files.slice(0, 10).map((f) => path.relative(path.dirname(abs), f)),
  };
}

function approvalText(plan_) {
  if (!plan_) return '';
  if (plan_.kind === 'dir') {
    return 'Je vais supprimer le dossier "' + plan_.rel + '" : ' + plan_.count +
      ' fichier(s), ' + plan_.bytes + ' octets.';
  }
  return 'Je vais supprimer le fichier "' + plan_.rel + '" (' + plan_.bytes + ' octets).';
}

/** Point de retour cible : copie exacte + manifeste. */
function checkpointTarget(home, sessionId, plan_) {
  const dir = path.join(home, 'p70-checkpoints', String(sessionId || 'session'), nowId());
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'payload');
  fs.cpSync(plan_.abs, dest, { recursive: true });
  const manifest = {
    id: path.basename(dir), created: new Date().toISOString(),
    rel: plan_.rel, abs: plan_.abs, kind: plan_.kind, count: plan_.count, bytes: plan_.bytes,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
  return { dir, manifest };
}

/** Restaure une cible supprimee. Verifie ensuite sur le disque. */
function restore(checkpointDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(checkpointDir, 'manifest.json'), 'utf8'));
  const payload = path.join(checkpointDir, 'payload');
  fs.mkdirSync(path.dirname(manifest.abs), { recursive: true });
  fs.cpSync(payload, manifest.abs, { recursive: true });
  const back = fs.existsSync(manifest.abs);
  return { ok: back, rel: manifest.rel, restored: back };
}

/**
 * Execute une suppression.
 * opts : { approve:boolean, confirmProtected:boolean, home, sessionId, cls }
 * -> { ok, status, facts:{deleted:[], stillThere:[]}, checkpoint, approval }
 */
function remove(abs, rel, opts) {
  opts = opts || {};
  const cls = opts.cls || 'project';
  if (cls === 'outside') {
    return { ok: false, code: 'outside', status: 'ECHEC',
      text: 'Refus : "' + rel + '" est hors du projet. Aucune suppression hors projet.' };
  }
  if (!fs.existsSync(abs)) {
    return { ok: false, code: 'absent', status: 'ECHEC',
      text: 'Rien a supprimer : "' + rel + '" n\'existe pas sur le disque.' };
  }
  const p = plan(abs, rel);
  const approval = approvalText(p);
  if (cls === 'protected' && !opts.confirmProtected) {
    return { ok: false, code: 'needs_protected_confirmation', status: 'EN_ATTENTE', plan: p,
      approval: approval + ' ATTENTION : cible protegee (' + rel.split('/')[0] + '). ' +
        'Confirmation explicite distincte requise.' };
  }
  if (!opts.approve) {
    return { ok: false, code: 'needs_approval', status: 'EN_ATTENTE', plan: p, approval };
  }
  let checkpoint = null;
  if (opts.home) {
    try { checkpoint = checkpointTarget(opts.home, opts.sessionId, p); }
    catch (e) {
      return { ok: false, code: 'checkpoint_failed', status: 'ECHEC',
        text: 'Suppression refusee : le point de retour n\'a pas pu etre cree (' + String(e.message || e).slice(0, 120) + ').' };
    }
  }
  let removed = false;
  let err = null;
  try {
    fs.rmSync(abs, { recursive: true, force: false });
    removed = true;
  } catch (e) { err = String((e && e.message) || e).slice(0, 160); }
  const still = fs.existsSync(abs);
  const facts = { deleted: still ? [] : [rel], stillThere: still ? [rel] : [], kind: p.kind, count: p.count };
  let status = 'TERMINE';
  let text;
  if (still) {
    status = 'ECHEC';
    text = 'ECHEC : "' + rel + '" existe ENCORE sur le disque apres la commande' +
      (err ? ' (' + err + ')' : '') + (checkpoint ? '. Le point de retour est disponible.' : '.');
  } else {
    text = p.kind === 'dir'
      ? 'Supprime : le dossier "' + rel + '" et ses ' + p.count + ' fichier(s) ne sont plus sur le disque (verifie).'
      : 'Supprime : "' + rel + '" n\'est plus sur le disque (verifie).';
    if (checkpoint) text += ' Point de retour : ' + checkpoint.manifest.id + ' (annulable).';
  }
  return { ok: !still, status, text, facts, plan: p, approval,
    checkpoint: checkpoint && checkpoint.manifest, __dir: checkpoint && checkpoint.dir,
    error: err, removed };
}

/** Verifie une liste de faits directement sur le disque. */
function verifyFacts(root, facts) {
  facts = facts || {};
  const out = { deleted: [], created: [], modified: [], commands: facts.commands || [] };
  for (const rel of (facts.deleted || [])) {
    if (!fs.existsSync(path.join(root, rel))) out.deleted.push(rel);
  }
  for (const rel of (facts.created || [])) {
    if (fs.existsSync(path.join(root, rel))) out.created.push(rel);
  }
  for (const rel of (facts.modified || [])) {
    if (fs.existsSync(path.join(root, rel))) out.modified.push(rel);
  }
  return out;
}

module.exports = { plan, approvalText, checkpointTarget, restore, remove, countTree, verifyFacts, nowId };
