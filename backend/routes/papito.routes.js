const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');
const papito = require('../ai/papito-core');
const emulatorController = require('../controllers/emulator.controller');

const router = express.Router();

router.post('/analyze', verifyToken, async (req, res) => {
  try {
    const data = req.body;
    if (typeof papito.analyzeData === 'function') {
      papito.analyzeData(data);
      logger.info(`User ${req.user.username} called /papito/analyze`);
      return res.json({ message: 'analyze started' });
    }
    logger.warn('/papito/analyze called but papito.analyzeData not available');
    res.status(501).json({ error: 'Analyze not available' });
  } catch (e) {
    logger.error('papito analyze error', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/debug', verifyToken, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (typeof papito.debugAI === 'function') {
      const issues = papito.debugAI(code);
      logger.info(`User ${req.user.username} called /papito/debug`);
      return res.json({ issues });
    }
    // fallback simulated response
    logger.warn('papito.debugAI not exported; returning simulated response');
    res.json({ issues: [{ message: 'Simulated debug: function not exported by papito-core' }] });
  } catch (e) {
    logger.error('papito debug error', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/create-project', verifyToken, async (req, res) => {
  try {
    const { projectName, template } = req.body || {};
    if (typeof papito.createCompleteProject === 'function') {
      papito.createCompleteProject(projectName, template);
      logger.info(`User ${req.user.username} called /papito/create-project`);
      return res.json({ message: 'project creation started' });
    }
    logger.warn('createCompleteProject not exported; simulated response');
    res.json({ message: 'Simulated project creation' });
  } catch (e) {
    logger.error('papito create-project error', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/devops', verifyToken, async (req, res) => {
  try {
    const { pipelineConfig } = req.body || {};
    if (typeof papito.aiDevOps === 'function') {
      papito.aiDevOps(pipelineConfig);
      logger.info(`User ${req.user.username} called /papito/devops`);
      return res.json({ message: 'devops started' });
    }
    logger.warn('aiDevOps not exported; simulated response');
    res.json({ message: 'Simulated devops pipeline' });
  } catch (e) {
    logger.error('papito devops error', e);
    res.status(500).json({ error: e.message });
  }
});

// Emulator routes require admin
router.post('/emulator/start', verifyToken, requireAdmin, emulatorController.start);
router.post('/emulator/status', verifyToken, requireAdmin, emulatorController.status);
router.post('/emulator/stop', verifyToken, requireAdmin, emulatorController.stop);

module.exports = router;
