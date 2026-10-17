const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyToken, requireAdmin } = require('../middleware/auth.middleware');
const { requireFeature } = require('../middleware/license.middleware'); // P16: edition gates
const licCore = require('../src/license/license'); // P16: per-type cicd check


/**
 * P28: this module used to also serve /simulate, /metrics, /deploy,
 * /deployments and /rollback, which returned canned/random data
 * (Math.random metrics, hardcoded deployments). Those fake endpoints
 * were DELETED. Only the real template generator below remains.
 *
 * POST /api/devops/generate { type, stack?, options? }
 * Renders Dockerfile / docker-compose / github-actions / gitlab-ci /
 * kubernetes / nginx / .env.example templates (team edition; CI/CD
 * pipeline files require enterprise 'cicd').
 */
router.post('/api/devops/generate', verifyToken, requireFeature('devops'), async (req, res) => {
  try {
    const { type, stack = 'node', options = {} } = req.body;

    if (!type) {
      return res.status(400).json({
        error: 'type is required',
        allowed_types: ['dockerfile', 'docker-compose', 'github-actions', 'gitlab-ci', 'kubernetes', 'nginx', 'env']
      });
    }

    // P16: CI/CD pipeline files are an Enterprise feature ('cicd'); the rest is Team ('devops').
    if (type === 'github-actions' || type === 'gitlab-ci') {
      const g = licCore.guardFeature('cicd');
      if (!g.allowed) {
        return res.status(403).json({ error: g.message, feature: 'cicd', edition: g.edition, need: g.need });
      }
    }

    logger.info('DevOps file generation started', {
      user: req.user.username,
      type, stack, options
    });

    let content = '';
    let filename = '';

    switch (type) {
      case 'dockerfile':
        filename = 'Dockerfile';
        if (stack === 'python') {
          content = `FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\nCOPY . .\nEXPOSE 6000\nCMD ["python", "server.enterprise.py"]`;
        } else {
          content = `FROM node:18-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 5000\nCMD ["node", "server.js"]`;
        }
        break;
      case 'docker-compose':
        filename = 'docker-compose.yml';
        content = `version: '3.8'\nservices:\n  backend:\n    build: .\n    ports:\n      - "5000:5000"\n    environment:\n      - NODE_ENV=production\n  runtime:\n    build:\n      context: ./backend/runtime\n    ports:\n      - "6000:6000"`;
        break;
      case 'github-actions':
        filename = '.github/workflows/ci.yml';
        content = `name: CI\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '18'\n      - run: npm ci\n      - run: npm test`;
        break;
      case 'gitlab-ci':
        filename = '.gitlab-ci.yml';
        content = `stages:\n  - build\n  - test\n  - deploy\nbuild:\n  stage: build\n  script:\n    - npm ci\ntest:\n  stage: test\n  script:\n    - npm test`;
        break;
      case 'kubernetes':
        filename = 'k8s-deployment.yml';
        content = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: sudo-studio\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: sudo-studio\n  template:\n    metadata:\n      labels:\n        app: sudo-studio\n    spec:\n      containers:\n      - name: backend\n        image: sudo-studio:latest\n        ports:\n        - containerPort: 5000`;
        break;
      case 'nginx':
        filename = 'nginx.conf';
        content = `server {\n    listen 80;\n    location / {\n        proxy_pass http://localhost:5000;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n    }\n}`;
        break;
      case 'env':
        filename = '.env.example';
        content = `# Sudo Studio Environment Variables\nNODE_ENV=development\nPORT=5000\nJWT_SECRET=your-secret-key-change-in-production\nPYTHON_RUNTIME_URL=http://127.0.0.1:6000`;
        break;
      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }

    res.json({
      success: true,
      status: 'generated',
      type,
      stack,
      filename,
      content,
      size_bytes: content.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('DevOps generation failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;
