const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');
const emulatorController = require('../controllers/emulator.controller');

const router = express.Router();

/**
 * P28: real docker-based emulator controls, extracted from the deleted
 * papito.routes.js (whose /analyze, /debug, /create-project and /devops
 * endpoints only ever returned simulated responses).
 *
 * POST /emulator/start|status|stop - admin only, docker required.
 */
router.post('/emulator/start', verifyToken, requireAdmin, emulatorController.start);
router.post('/emulator/status', verifyToken, requireAdmin, emulatorController.status);
router.post('/emulator/stop', verifyToken, requireAdmin, emulatorController.stop);

module.exports = router;
