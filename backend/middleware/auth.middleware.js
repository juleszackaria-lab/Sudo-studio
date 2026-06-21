/**
 * Simple Authentication Middleware
 * For local development, uses a simple token-based auth
 * In production, this should be replaced with proper JWT + secure storage
 */

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Secret key for JWT (in production, use env variable)
const JWT_SECRET = process.env.JWT_SECRET || 'sudo-studio-local-dev-secret-2024';
const TOKEN_EXPIRY = '7d'; // 7 days for local development

/**
 * Generate a development token for local use
 */
function generateDevToken(username = 'local-user') {
  const payload = {
    username,
    role: 'developer',
    env: 'local',
    timestamp: Date.now()
  };
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verify JWT token middleware
 */
function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    // Allow requests without auth in local development mode
    if (process.env.NODE_ENV !== 'production' && !authHeader) {
      logger.warn('No auth token provided - allowing in dev mode');
      req.user = { username: 'local-dev', role: 'developer' };
      return next();
    }
    
    if (!authHeader) {
      return res.status(401).json({ 
        error: 'No authorization token provided',
        hint: 'Include Authorization: Bearer <token> header'
      });
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    
    logger.debug('Token verified', { username: decoded.username });
    next();
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired',
        hint: 'Please login again'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      logger.warn('Invalid token provided', { error: error.message });
      
      // In development, allow requests with invalid tokens
      if (process.env.NODE_ENV !== 'production') {
        req.user = { username: 'local-dev', role: 'developer' };
        return next();
      }
      
      return res.status(401).json({ 
        error: 'Invalid token',
        hint: 'Please login again'
      });
    }
    
    logger.error('Auth middleware error', { error: error.message });
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional auth middleware (doesn't block if no token)
 */
function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      req.user = { username: 'anonymous', role: 'guest' };
      return next();
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    
  } catch (error) {
    req.user = { username: 'anonymous', role: 'guest' };
  }
  
  next();
}

/**
 * Check if user has specific role
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    if (req.user.role !== role) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: role,
        current: req.user.role
      });
    }
    
    next();
  };
}

module.exports = {
  verifyToken,
  optionalAuth,
  requireRole,
  requireAdmin: requireRole('admin'),  // Alias for common admin check
  generateDevToken,
  JWT_SECRET
};
