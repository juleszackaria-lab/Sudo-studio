'use strict';
/**
 * P70-B5..B9 : chemin RAPIDE, SANS MODELE, pour les operations de base.
 *
 *   supprimer, lire/afficher, lister, creer (contenu fourni litteralement),
 *   renommer, deplacer, copier.
 *
 * Regles tenues ici :
 *   - 0 appel modele (compte et affiche) ;
 *   - resolution deterministe, UNIQUE ; plusieurs candidats -> on demande ;
 *   - approbation affichee avant toute suppression, verification sur le disque
 *     apres, point de retour disponible ;
 *   - le texte rendu est un RAPPORT, pas une parole de modele.
 *
 * ASCII only.
 */
const fs = require('fs');
const path = require('path');
const intentMod = require('./intent');
const paths = require('./paths');
const ops = require('./ops');
const verified = require('./verified');
const timing = require('./timing');

const MAX_READ_BYTES = 60000;
const MAX_LIST = 200;

// Etat court du chemin rapide, par session :
//   PENDING  : une suppression attend l'accord de l'operateur ;
//   LAST_CKPT: le dernier point de retour, pour "annule le run".
const PENDING = new Map();
const PENDING_REST = new Map();   // sous-taches qui restent apres une approbation
const LAST_CKPT = new Map();
const CONFIRM_RE = /^\s*(oui|ok|d'accord|daccord|vas[- ]?y|go|confirme|je confirme|yes|confirm|supprime)\b/i;
const CANCEL_RE = /^\s*(non|annule|cancel|stop|abandonne)\b/i;
const UNDO_RE = /\b(annule le run|annuler le run|undo|restaure|restaurer)\b/i;

function report(status, text, extra) {
  const out = Object.assign({ handled: true, status, modelCalls: 0,
    text: verified.resultLine(status, text) }, extra || {});
  return out;
}

function choiceReport(res, op) {
  const lines = ['Je ne choisis pas a votre place : ' + res.candidates.length + ' cibles correspondent.'];
  res.candidates.forEach((c, i) => lines.push('  ' + (i + 1) + '. ' + c));
  return report('EN_ATTENTE', lines.join('\n') + '\nRepondez par le numero, ou donnez le chemin complet.', {
    needsChoice: true, candidates: res.candidates, op,
  });
}

function absentReport(res, op) {
  const s = (res.suggestions || []);
  const lines = ['"' + String(res.target || '?') + '" n\'existe pas dans le projet.'];
  if (s.length) lines.push('Fichiers proches : ' + s.join(', '));
  return report('ECHEC', lines.join(' '), { op, suggestions: s });
}

function doRead(root, rel, abs) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return report('ECHEC', 'Lecture impossible : ' + e.message); }
  if (st.isDirectory()) {
    const names = fs.readdirSync(abs).slice(0, MAX_LIST);
    return report('TERMINE', '"' + rel + '" est un dossier (' + names.length + ' entrees) : ' + names.join(', '),
      { facts: { deleted: [], created: [], modified: [] }, toolCall: { tool: 'read', target: rel, ok: true, code: 'ok' } });
  }
  const buf = fs.readFileSync(abs);
  const txt = buf.slice(0, MAX_READ_BYTES).toString('utf8');
  const trunc = buf.length > MAX_READ_BYTES;
  return report('TERMINE', 'Contenu de "' + rel + '"' + (trunc ? ' (tronque a ' + MAX_READ_BYTES + ' octets)' : '') +
    ' :\n' + txt, { facts: { deleted: [], created: [], modified: [] }, bytes: buf.length,
      toolCall: { tool: 'read', target: rel, ok: true, code: 'ok' } });
}

function doList(root, rel, abs) {
  const base = abs || root;
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); }
  catch (e) { return report('ECHEC', 'Listing impossible : ' + e.message); }
  const lines = entries.slice(0, MAX_LIST).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
  const where = rel || '.';
  return report('TERMINE', 'Contenu de "' + where + '" (' + entries.length + ') : ' + lines.join(', '),
    { facts: { deleted: [], created: [], modified: [] }, entries: lines.length,
      toolCall: { tool: 'list', target: where, ok: true, code: 'ok' } });
}

function doCreateFile(root, rel, abs, content) {
  if (content === null || content === undefined || !String(content).trim()) {
    return report('EN_ATTENTE', 'Quel contenu mettre dans "' + rel + '" ? ' +
      'Donnez-le texte (je n\'invente pas le contenu), ou utilisez un bloc de code.',
    { needsContent: true });
  }
  if (fs.existsSync(abs)) {
    return report('EN_ATTENTE', '"' + rel + '" existe deja. Ecraser, ou donner un autre nom ?',
      { needsApproval: true });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content), 'utf8');
  const there = fs.existsSync(abs) && fs.statSync(abs).size > 0;
  const facts = { deleted: [], created: there ? [rel] : [], modified: [] };
  return report(there ? 'TERMINE' : 'ECHEC',
    there ? 'Cree : "' + rel + '" est sur le disque (' + fs.statSync(abs).size + ' octets, verifie).'
          : 'ECHEC : "' + rel + '" n\'est pas sur le disque apres la creation.', { facts });
}

function doCreateDir(root, rel, abs) {
  if (fs.existsSync(abs)) return report('TERMINE', 'Le dossier "' + rel + '" existe deja (rien a faire).', { alreadyDone: true });
  fs.mkdirSync(abs, { recursive: true });
  const there = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  return report(there ? 'TERMINE' : 'ECHEC',
    there ? 'Cree : le dossier "' + rel + '" existe sur le disque (verifie).' : 'ECHEC : dossier absent apres creation.');
}

function doRename(root, fromAbs, fromRel, toAbs, toRel, copyOnly) {
  if (!fs.existsSync(fromAbs)) return report('ECHEC', '"' + fromRel + '" n\'existe pas.');
  if (fs.existsSync(toAbs)) return report('EN_ATTENTE', '"' + toRel + '" existe deja : je n\'ecrase pas sans votre accord.');
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  if (copyOnly) fs.cpSync(fromAbs, toAbs, { recursive: true });
  else fs.renameSync(fromAbs, toAbs);
  const destOk = fs.existsSync(toAbs);
  const srcGone = copyOnly ? true : !fs.existsSync(fromAbs);
  const ok = destOk && srcGone;
  const facts = { deleted: (!copyOnly && srcGone) ? [fromRel] : [], created: destOk ? [toRel] : [], modified: [] };
  return report(ok ? 'TERMINE' : 'ECHEC',
    ok ? (copyOnly ? 'Copie : "' + fromRel + '" -> "' + toRel + '" (verifie).'
                   : 'Renomme : "' + fromRel + '" -> "' + toRel + '" (verifie).')
       : 'ECHEC : operation non confirmee sur le disque.', { facts });
}

/**
 * Traite une consigne si elle est une operation de base.
 * Renvoie {handled:false, why} sinon (le tour continue normalement).
 */
function tryHandle(input) {
  input = input || {};
  const t = timing.start();
  const prompt = String(input.prompt || '');
  const sid = input.sessionId || 'session';

  // P70-B7 : "annule le run" restaure la derniere cible supprimee.
  if (UNDO_RE.test(prompt)) {
    const last = LAST_CKPT.get(sid);
    if (!last) return report('ECHEC', 'Aucun point de retour pour cette session : rien a annuler.');
    try {
      const r = ops.restore(last.dir);
      return report(r.ok ? 'TERMINE' : 'ECHEC',
        r.ok ? 'Annule : "' + r.rel + '" est de retour sur le disque (verifie).'
             : 'ECHEC : "' + r.rel + '" n\'a pas ete restaure.', { facts: { deleted: [], created: [r.rel], modified: [] } });
    } catch (e) {
      return report('ECHEC', 'Restauration impossible : ' + String(e.message || e).slice(0, 160));
    }
  }

  // P70-B7 : la reponse a l'approbation est traitee SANS modele.
  const pend = PENDING.get(sid);
  if (pend && CONFIRM_RE.test(prompt)) {
    PENDING.delete(sid);
    const r = ops.remove(pend.abs, pend.rel, { approve: true, confirmProtected: true,
      cls: pend.cls, home: input.home || pend.home, sessionId: sid });
    // Le dossier du point de retour vient d'ops.remove : "annule le run" le restaure.
    if (r.checkpoint && r.__dir) LAST_CKPT.set(sid, { dir: r.__dir, manifest: r.checkpoint });
    const rest = PENDING_REST.get(sid) || [];
    PENDING_REST.delete(sid);
    if (rest.length) {
      return report('PARTIEL', r.text + ' RESTE A TRAITER (le modele s en occupe) : ' + rest.join(' ; '),
        { facts: r.facts, checkpoint: r.checkpoint, plan: r.plan, remaining: rest });
    }
    return report(r.status, r.text, { facts: r.facts, checkpoint: r.checkpoint, plan: r.plan });
  }
  if (pend && CANCEL_RE.test(prompt)) {
    PENDING.delete(sid);
    return report('TERMINE', 'Suppression annulee : rien n\'a ete touche sur le disque.', { alreadyDone: true });
  }

  const parsed = intentMod.parse(input.prompt);
  if (parsed.kind === 'complex') return { handled: false, why: parsed.why, modelCalls: 0 };

  // Composee : on execute les sous-taches DANS L'ORDRE, et on s'arrete au
  // premier echec (on ne continue pas sur un etat inconnu).
  const steps = parsed.kind === 'composed' ? parsed.parts : [parsed];
  const results = [];
  for (const step of steps) {
    if (step.kind !== 'file-op') {
      return { handled: false, why: 'sous-tache complexe : ' + (step.why || '?'), modelCalls: 0, partial: results };
    }
    const r = handleOne(step, input, t);
    if (!r.handled) return { handled: false, why: r.why, modelCalls: 0, partial: results };
    results.push(r);
    // En attente d'approbation : on memorise ce qui RESTE a faire, sinon la
    // suite de la consigne composee serait perdue au tour suivant.
    if (r.status === 'EN_ATTENTE' && parsed.kind === 'composed') {
      PENDING_REST.set(sid, steps.slice(results.length).map((x) => x.text || x.why || x.op).filter(Boolean));
    }
    if (r.status === 'ECHEC' || r.status === 'EN_ATTENTE') {
      return Object.assign({}, r, { steps: results, timing: t.finish(), modelCalls: 0 });
    }
  }
  if (results.length === 1) return Object.assign({}, results[0], { timing: t.finish(), modelCalls: 0 });
  const text = results.map((r) => r.text).join('\n');
  const facts = results.reduce((a, r) => {
    const f = (r && r.facts) || {};
    a.deleted = a.deleted.concat(f.deleted || []);
    a.created = a.created.concat(f.created || []);
    a.modified = a.modified.concat(f.modified || []);
    return a;
  }, { deleted: [], created: [], modified: [] });
  return report('TERMINE', text, { steps: results, facts, timing: t.finish(), composed: true });
}

function handleOne(step, input, t) {
  const root = path.resolve(input.root || process.cwd());
  const home = input.home || root;
  const sessionId = input.sessionId || 'session';
  const op = step.op;

  // ---- list sans cible : le projet entier
  if (op === 'list' && !step.target) {
    return doList(root, '', root);
  }
  // Creation : la cible n'existe pas encore, c'est normal. On construit le
  // chemin dans le projet, en refusant tout ce qui sort ou qui touche une
  // zone protegee.
  if (op === 'create_file' || op === 'create_dir') {
    // "cree X avec ce contenu" : le contenu est dans le contexte du modele,
    // pas dans la consigne. On ne devine pas : le tour normal s'en charge.
    const promptTxt = String(input.prompt || '');
    if (op === 'create_file' && step.content == null &&
        /(ce contenu|le contenu|contenu suivant|contenu ci|```)/i.test(promptTxt)) {
      return { handled: false, why: 'contenu fourni par le modele (bloc de code ou "ce contenu")', modelCalls: 0 };
    }
    const rel0 = paths.normalizeTarget(step.target || '');
    if (!rel0) return report('EN_ATTENTE', 'Quel fichier creer ? Donnez un chemin dans le projet.', { needsTarget: true });
    const abs0 = path.isAbsolute(rel0) ? rel0 : path.join(root, rel0);
    const cls0 = paths.classify(abs0, root);
    if (cls0 === 'outside') return report('ECHEC', 'Refus : "' + rel0 + '" est hors du projet.');
    if (cls0 === 'protected') return report('ECHEC', 'Refus : "' + rel0 + '" est dans une zone protegee.');
    return op === 'create_file'
      ? doCreateFile(root, rel0, abs0, step.content)
      : doCreateDir(root, rel0, abs0);
  }
  const res = paths.resolve(root, step.target || '');
  t.mark('resolve');
  if (!res.ok) {
    if (res.reason === 'ambiguous') return choiceReport(res, op);
    // Cible absente : la resolution guidee (liste, "cible abandonnee", arret
    // apres 2 echecs) appartient au moteur. On lui rend la main au lieu de
    // court-circuiter ses protections.
    if (res.reason === 'absent') {
      return { handled: false, why: 'cible absente : resolution et liste gerees par le moteur', modelCalls: 0 };
    }
    if (res.reason === 'no_target') {
      return report('EN_ATTENTE', 'Sur quoi ? Donnez un chemin dans le projet (je ne devine pas la cible).', { needsTarget: true });
    }
    return report('ECHEC', 'Cible refusee : ' + res.reason + (res.target ? ' (' + res.target + ')' : ''));
  }
  if (op === 'read') return doRead(root, res.rel, res.abs);
  if (op === 'list') return doList(root, res.rel, res.abs);

  if (op === 'delete') {
    const r = ops.remove(res.abs, res.rel, {
      approve: !!input.approve,
      confirmProtected: !!input.confirmProtected,
      cls: res.cls, home, sessionId,
    });
    if (r.code === 'checkpoint_failed' || r.code === 'outside') {
      return report(r.status || 'ECHEC', r.text);
    }
    if ((r.code === 'needs_approval' || r.code === 'needs_protected_confirmation') && input.engineApproval) {
      // L'operateur peut repondre (interface) : on lui pose la question par le
      // mecanisme d'approbation du moteur, pas par un second systeme. Aucun
      // appel modele, et l'operation n'est PAS executee ici.
      return { handled: true, needsEngineApproval: true, status: 'EN_ATTENTE', modelCalls: 0,
        text: verified.resultLine('EN_ATTENTE', r.approval),
        request: { id: 'p70-' + sessionId + '-' + Date.now(), tool: 'delete',
          summary: r.approval, pattern: { text: res.rel } },
        hold: { abs: res.abs, rel: res.rel, cls: res.cls, home: home, sessionId: sessionId, plan: r.plan },
        plan: r.plan, protected: r.code === 'needs_protected_confirmation' };
    }
    if (r.code === 'needs_approval' || r.code === 'needs_protected_confirmation') {
      PENDING.set(sessionId, { abs: res.abs, rel: res.rel, plan: r.plan, cls: res.cls,
        home: home, ts: Date.now() });
      return report('EN_ATTENTE', r.approval + ' Repondez "oui" pour confirmer, "non" pour annuler.',
        { needsApproval: true, plan: r.plan, code: r.code,
          protected: r.code === 'needs_protected_confirmation' });
    }
    if (r.code === 'absent') return absentReport({ target: res.rel, suggestions: [] }, op);
    return report(r.status, r.text, { facts: r.facts, checkpoint: r.checkpoint, plan: r.plan });
  }

  if (op === 'create_file') return doCreateFile(root, res.rel, res.abs, step.content);
  if (op === 'create_dir') return doCreateDir(root, res.rel, res.abs);

  if (op === 'rename' || op === 'move' || op === 'copy') {
    if (!step.to) return report('EN_ATTENTE', 'Nouveau nom ? (exemple : "renomme ' + res.rel + ' en notes.txt")', { needsTarget: true });
    const to = paths.resolve(root, step.to);
    const toAbs = to.ok ? to.abs : path.join(root, paths.normalizeTarget(step.to));
    const toRel = to.ok ? to.rel : paths.normalizeTarget(step.to);
    return doRename(root, res.abs, res.rel, toAbs, toRel, op === 'copy');
  }
  return { handled: false, why: 'operation non prise en charge par le chemin rapide : ' + op, modelCalls: 0 };
}

/** Execute une operation mise en attente, APRES accord de l'operateur. */
function executeApproved(hold, input) {
  input = input || {};
  hold = hold || {};
  const t = timing.start();
  const sid = hold.sessionId || input.sessionId || 'session';
  try {
    const r = ops.remove(hold.abs, hold.rel, { approve: true, confirmProtected: true,
      cls: hold.cls, home: hold.home || hold.abs, sessionId: sid });
    if (r.checkpoint && r.__dir) LAST_CKPT.set(sid, { dir: r.__dir, manifest: r.checkpoint });
    const rest = PENDING_REST.get(sid) || [];
    PENDING_REST.delete(sid);
    const text = rest.length
      ? r.text + ' RESTE A TRAITER (le modele s en occupe) : ' + rest.join(' ; ')
      : r.text;
    const out = report(rest.length ? 'PARTIEL' : r.status, text,
      { facts: r.facts, checkpoint: r.checkpoint, plan: r.plan, remaining: rest });
    out.timing = t.finish();
    return out;
  } catch (e) {
    const out = report('ECHEC', 'Suppression impossible : ' + String((e && e.message) || e).slice(0, 160));
    out.timing = t.finish();
    return out;
  }
}

module.exports = { tryHandle, handleOne, executeApproved, PENDING, LAST_CKPT };
