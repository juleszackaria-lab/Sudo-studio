const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock dependencies
jest.mock('../../ai/papito-core');
jest.mock('../../controllers/emulator.controller');
jest.mock('../../utils/logger');
jest.mock('jsonwebtoken');

const papito = require('../../ai/papito-core');
const emulatorController = require('../../controllers/emulator.controller');
const papitoRoutes = require('../../routes/papito.routes');

describe('Papito Routes Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/papito', papitoRoutes);

    // Mock JWT verification
    jwt.verify.mockReturnValue({ id: 1, username: 'testuser', role: 'developer' });
  });

  describe('POST /papito/analyze', () => {
    it('should call analyzeData when authenticated', async () => {
      papito.analyzeData = jest.fn();

      const testData = { code: 'console.log("test");' };
      const response = await request(app)
        .post('/papito/analyze')
        .set('Authorization', 'Bearer valid-token')
        .send(testData);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'analyze started');
      expect(papito.analyzeData).toHaveBeenCalledWith(testData);
    });

    it('should return 401 when not authenticated', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app)
        .post('/papito/analyze')
        .send({ code: 'test' });

      expect(response.status).toBe(401);
    });

    it('should return 501 when analyzeData is not available', async () => {
      delete papito.analyzeData;

      const response = await request(app)
        .post('/papito/analyze')
        .set('Authorization', 'Bearer valid-token')
        .send({ code: 'test' });

      expect(response.status).toBe(501);
      expect(response.body).toHaveProperty('error', 'Analyze not available');
    });

    it('should handle errors gracefully', async () => {
      papito.analyzeData = jest.fn(() => {
        throw new Error('Analysis failed');
      });

      const response = await request(app)
        .post('/papito/analyze')
        .set('Authorization', 'Bearer valid-token')
        .send({ code: 'test' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Analysis failed');
    });
  });

  describe('POST /papito/debug', () => {
    it('should call debugAI when available', async () => {
      const mockIssues = [
        { line: 10, message: 'Possible null reference' },
        { line: 25, message: 'Unused variable' }
      ];
      papito.debugAI = jest.fn().mockReturnValue(mockIssues);

      const response = await request(app)
        .post('/papito/debug')
        .set('Authorization', 'Bearer valid-token')
        .send({ code: 'function test() {}' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('issues');
      expect(Array.isArray(response.body.issues)).toBe(true);
      expect(response.body.issues.length).toBeGreaterThan(0);
      expect(papito.debugAI).toHaveBeenCalledWith('function test() {}');
    });

    it('should return simulated response when debugAI is not available', async () => {
      delete papito.debugAI;

      const response = await request(app)
        .post('/papito/debug')
        .set('Authorization', 'Bearer valid-token')
        .send({ code: 'test code' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('issues');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });

    it('should return 401 when not authenticated', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app)
        .post('/papito/debug')
        .send({ code: 'test' });

      expect(response.status).toBe(401);
    });

    it('should handle errors in debugAI', async () => {
      papito.debugAI = jest.fn(() => {
        throw new Error('Debug failed');
      });

      const response = await request(app)
        .post('/papito/debug')
        .set('Authorization', 'Bearer valid-token')
        .send({ code: 'test' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Debug failed');
    });
  });

  describe('POST /papito/create-project', () => {
    it('should create a project when authenticated', async () => {
      papito.createCompleteProject = jest.fn();

      const response = await request(app)
        .post('/papito/create-project')
        .set('Authorization', 'Bearer valid-token')
        .send({ projectName: 'my-app', template: 'react' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(papito.createCompleteProject).toHaveBeenCalledWith('my-app', 'react');
    });

    it('should return simulated response when function not available', async () => {
      delete papito.createCompleteProject;

      const response = await request(app)
        .post('/papito/create-project')
        .set('Authorization', 'Bearer valid-token')
        .send({ projectName: 'my-app', template: 'vue' });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('Simulated');
    });

    it('should return 401 when not authenticated', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app)
        .post('/papito/create-project')
        .send({ projectName: 'my-app', template: 'react' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /papito/devops', () => {
    it('should setup DevOps pipeline when authenticated', async () => {
      papito.aiDevOps = jest.fn();

      const pipelineConfig = {
        build: 'npm run build',
        test: 'npm test',
        deploy: 'npm run deploy'
      };

      const response = await request(app)
        .post('/papito/devops')
        .set('Authorization', 'Bearer valid-token')
        .send({ pipelineConfig });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(papito.aiDevOps).toHaveBeenCalledWith(pipelineConfig);
    });

    it('should return simulated response when function not available', async () => {
      delete papito.aiDevOps;

      const response = await request(app)
        .post('/papito/devops')
        .set('Authorization', 'Bearer valid-token')
        .send({ pipelineConfig: {} });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('Simulated');
    });

    it('should return 401 when not authenticated', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app)
        .post('/papito/devops')
        .send({ pipelineConfig: {} });

      expect(response.status).toBe(401);
    });
  });

  describe('Emulator Routes (Admin Only)', () => {
    beforeEach(() => {
      emulatorController.start = jest.fn((req, res) => res.json({ message: 'emulator started' }));
      emulatorController.status = jest.fn((req, res) => res.json({ running: true }));
      emulatorController.stop = jest.fn((req, res) => res.json({ message: 'emulator stopped' }));
    });

    describe('POST /papito/emulator/start', () => {
      it('should start emulator when user is admin', async () => {
        jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

        const response = await request(app)
          .post('/papito/emulator/start')
          .set('Authorization', 'Bearer admin-token');

        expect(response.status).toBe(200);
        expect(emulatorController.start).toHaveBeenCalled();
      });

      it('should return 403 when user is not admin', async () => {
        jwt.verify.mockReturnValue({ id: 2, username: 'dev', role: 'developer' });

        const response = await request(app)
          .post('/papito/emulator/start')
          .set('Authorization', 'Bearer dev-token');

        expect(response.status).toBe(403);
        expect(response.body).toHaveProperty('error', 'Admin role required');
      });

      it('should return 401 when not authenticated', async () => {
        jwt.verify.mockImplementation(() => {
          throw new Error('Invalid token');
        });

        const response = await request(app)
          .post('/papito/emulator/start');

        expect(response.status).toBe(401);
      });
    });

    describe('POST /papito/emulator/status', () => {
      it('should get emulator status when user is admin', async () => {
        jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

        const response = await request(app)
          .post('/papito/emulator/status')
          .set('Authorization', 'Bearer admin-token');

        expect(response.status).toBe(200);
        expect(emulatorController.status).toHaveBeenCalled();
      });

      it('should return 403 when user is not admin', async () => {
        jwt.verify.mockReturnValue({ id: 2, username: 'dev', role: 'developer' });

        const response = await request(app)
          .post('/papito/emulator/status')
          .set('Authorization', 'Bearer dev-token');

        expect(response.status).toBe(403);
      });
    });

    describe('POST /papito/emulator/stop', () => {
      it('should stop emulator when user is admin', async () => {
        jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

        const response = await request(app)
          .post('/papito/emulator/stop')
          .set('Authorization', 'Bearer admin-token');

        expect(response.status).toBe(200);
        expect(emulatorController.stop).toHaveBeenCalled();
      });

      it('should return 403 when user is not admin', async () => {
        jwt.verify.mockReturnValue({ id: 2, username: 'dev', role: 'developer' });

        const response = await request(app)
          .post('/papito/emulator/stop')
          .set('Authorization', 'Bearer dev-token');

        expect(response.status).toBe(403);
      });
    });
  });
});
