/**
 * supervisor.routes.js - MISSION P1-d
 * Public status endpoint for the runtime supervisor (no auth, like /health):
 *   GET /api/supervisor/runtime-status
 * The Runtime panel polls it to display "Runtime redemarre a HH:MM (raison)".
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

module.exports = router;
