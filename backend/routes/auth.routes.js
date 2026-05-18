const express = require('express');
const router = express.Router();
const { generateDevToken, JWT_SECRET } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

/**
 * Auth Routes
 * Simple authentication for local development
 */

/**
 * POST /api/auth/login
 * Generate a development token
 */
router.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    // In development, accept any username/password
    // In production, this should validate against a database
    const user = username || 'local-user';
    
    const token = generateDevToken(user);
    
    logger.info('Login successful', { username: user });
    
    res.json({
      success: true,
      token,
      user: {
        username: user,
        role: 'developer'
      },
      expiresIn: '7d',
      message: 'Login successful'
    });
    
  } catch (error) {
    logger.error('Login failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Login failed',
      message: error.message
    });
  }
});

/**
 * GET /api/auth/dev-token
 * Get a development token without credentials (dev only)
 */
router.get('/api/auth/dev-token', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Dev token endpoint disabled in production'
    });
  }
  
  const token = generateDevToken('local-dev');
  
  res.json({
    token,
    message: 'Development token generated',
    note: 'This endpoint is only available in development mode',
    expiresIn: '7d',
    usage: 'Include in Authorization header: Bearer <token>'
  });
});

/**
 * POST /api/auth/verify
 * Verify if a token is valid
 */
router.post('/api/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        valid: false,
        error: 'No token provided'
      });
    }
    
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, JWT_SECRET);
    
    res.json({
      valid: true,
      user: decoded,
      message: 'Token is valid'
    });
    
  } catch (error) {
    res.json({
      valid: false,
      error: error.message,
      name: error.name
    });
  }
});

/**
 * GET /api/auth/status
 * Get auth system status
 */
router.get('/api/auth/status', (req, res) => {
  res.json({
    mode: process.env.NODE_ENV || 'development',
    devTokenAvailable: process.env.NODE_ENV !== 'production',
    endpoints: {
      login: '/api/auth/login (POST)',
      devToken: '/api/auth/dev-token (GET)',
      verify: '/api/auth/verify (POST)'
    }
  });
});

module.exports = router;
