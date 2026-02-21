const jwt = require('jsonwebtoken');
const { getUserByUsername } = require('../models/user.model');

const JWT_SECRET = process.env.ENTERPRISE_JWT_SECRET || 'enterprise-secret';

async function verifyToken(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    // attach minimal user
    req.user = { id: decoded.id, username: decoded.username, role: decoded.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

function requireDeveloper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'developer' && req.user.role !== 'admin') return res.status(403).json({ error: 'Developer role required' });
  next();
}

module.exports = {
  verifyToken,
  requireAdmin,
  requireDeveloper,
};
