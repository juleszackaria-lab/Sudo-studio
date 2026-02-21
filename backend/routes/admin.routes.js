const express = require('express');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const logger = require('../utils/logger');
const { getUserByUsername, createUser } = require('../models/user.model');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();
const JWT_SECRET = process.env.ENTERPRISE_JWT_SECRET || 'enterprise-secret';

router.post('/login', [
  body('username').isString().notEmpty(),
  body('password').isString().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { username, password } = req.body;
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      logger.warn(`Login failed for ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.warn(`Login failed for ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    logger.info(`Login success for ${username}`);
    res.json({ token });
  } catch (e) {
    logger.error('Login error', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Admin-only: create a new user
router.post('/admin/users', verifyToken, requireAdmin, [
  body('username').isString().notEmpty(),
  body('password').isString().isLength({ min: 6 }),
  body('role').isIn(['admin', 'developer']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const { username, password, role } = req.body;
    const id = await createUser(username, password, role);
    logger.info(`Admin ${req.user.username} created user ${username} with role ${role}`);
    res.json({ id, username, role });
  } catch (e) {
    logger.error('Create user error', e);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

module.exports = router;
