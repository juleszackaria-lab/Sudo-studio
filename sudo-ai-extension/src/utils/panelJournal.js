/**
 * panelJournal.js - P58-3: every feature writes its technical events with a
 * component marker, so the viewer's "composant" filter shows exactly what that
 * feature did and nothing else.
 *
 * One call per handled webview message is enough to make a feature visible in
 * "Sudo Studio Logs" (component filter), and it is cheap: sharedLog() is a
 * NOOP until the extension host enables technical logs, and this helper never
 * throws into a panel.
 *
 * Usage (top of a panel's message handler):
 *   const { note } = require('../utils/panelJournal');
 *   note('duplication', msg);
 *
 * ASCII only, zero dependency.
 */
'use strict';

const { sharedLog } = require('./techLog');

function note(component, msgOrAction, fields) {
  const action = (msgOrAction && typeof msgOrAction === 'object')
    ? String(msgOrAction.type || msgOrAction.action || '')
    : String(msgOrAction || '');
  const extra = Object.assign({ action }, fields || {});
  try { sharedLog(component).info('panel action', extra); } catch (_) { /* journal never breaks a panel */ }
  return action;
}

function noteFeature(component, action, fields) {
  try { sharedLog(component).info(String(action || 'feature'), fields || {}); } catch (_) { /* ignore */ }
}

module.exports = { note, noteFeature };
