/**
 * supervisor.routes.js - MISSION P1-d
 * Public endpoints for the runtime supervisor (no auth, like /health):
 *   GET  /api/supervisor/runtime-status
 *   POST /api/supervisor/runtime-restart   (P48: "Restart now" button)
 * The Runtime panel polls the status to display
 * "Runtime redemarre a HH:MM (raison)".
 * ASCII-only source (project rule).
 */
'use strict';

const express = require('express');
const router = express.Router();
const { getSupervisor } = require('../supervisor/runtimeSupervisor');

router.get('/api/supervisor/runtime-status', (req, res) => {
  try {
    res.json(getSupervisor().status());
  } catch (e) {
    res.status(500).json({ error: 'supervisor status failed', detail: e.message });
  }
});

// P48(4): force an immediate supervised restart ("Restart now" button in
// the Runtime panel). Manual: bypasses the boot grace; the 10-minute
// restart cap still applies. Best effort, never throws.
router.post('/api/supervisor/runtime-restart', async (req, res) => {
  try {
    const sup = getSupervisor();
    const r = await sup.maybeRestart('manual restart (Restart now)', { manual: true });
    const restarted = r.action === 'restarted';
    res.json({ ok: restarted ? !!r.ok : false, action: r.action,
      detail: r.detail || (sup.lastSuppressed && sup.lastSuppressed.reason) || null });
  } catch (e) {
    res.status(500).json({ error: 'supervisor restart failed', detail: e.message });
  }
});

module.exports = router;
