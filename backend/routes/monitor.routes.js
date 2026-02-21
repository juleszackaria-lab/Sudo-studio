const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/health', (req, res) => {
  try {
    const versionFile = path.join(__dirname, '..', 'version.json');
    const version = fs.existsSync(versionFile) ? JSON.parse(fs.readFileSync(versionFile, 'utf8')) : { version: 'unknown' };
    res.json({ status: 'OK', version: version.version, timestamp: new Date().toISOString() });
  } catch (e) {
    logger.error('Health check error', e);
    res.status(500).json({ status: 'ERROR' });
  }
});

router.get('/version', (req, res) => {
  try {
    const versionFile = path.join(__dirname, '..', 'version.json');
    if (!fs.existsSync(versionFile)) return res.status(404).json({ error: 'version.json not found' });
    const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    res.json(version);
  } catch (e) {
    logger.error('Version read error', e);
    res.status(500).json({ error: 'Failed to read version' });
  }
});

module.exports = router;
