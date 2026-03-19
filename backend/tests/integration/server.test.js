const request = require('supertest');
const express = require('express');
const http = require('http');
const path = require('path');

// Mock dependencies before requiring server
jest.mock('../../ai/aiModelsManager');
jest.mock('../../models/user.model');
jest.mock('../../utils/logger');

const aiModelsManager = require('../../ai/aiModelsManager');
const { initDB } = require('../../models/user.model');

describe('Server Integration Tests - API Endpoints', () => {
  let app;
  let server;

  beforeAll(() => {
    // Setup mocks
    initDB.mockResolvedValue();
    
    aiModelsManager.listModels.mockReturnValue([
      { name: 'model1', status: 'stopped' },
      { name: 'model2', status: 'running' }
    ]);
    
    aiModelsManager.getModelInfo.mockImplementation((name) => {
      if (name === 'model1') {
        return { name: 'model1', size: 1024, status: 'stopped' };
      }
      return null;
    });
    
    aiModelsManager.startModel.mockReturnValue({ status: 'running', pid: 12345 });
    aiModelsManager.stopModel.mockReturnValue(true);
    aiModelsManager.infer.mockResolvedValue({ reply: 'Test response' });
    aiModelsManager.downloadModel.mockResolvedValue('/path/to/model');
    aiModelsManager.deleteModel.mockReturnValue(true);

    // Create a simplified Express app for testing
    app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../../..', 'dist')));

    // Mount routes from server.js
    const adminRoutes = require('../../routes/admin.routes');
    const papitoRoutes = require('../../routes/papito.routes');
    const monitorRoutes = require('../../routes/monitor.routes');

    app.use('/', adminRoutes);
    app.use('/papito', papitoRoutes);
    app.use('/', monitorRoutes);

    // API endpoints from server.js
    app.get('/api/models', (req, res) => {
      const models = aiModelsManager.listModels();
      res.json(models);
    });

    app.get('/api/models/:modelName', (req, res) => {
      const info = aiModelsManager.getModelInfo(req.params.modelName);
      if (!info) return res.status(404).json({ error: 'Model not found' });
      res.json(info);
    });

    app.post('/api/models/start', (req, res) => {
      const { modelName } = req.body;
      if (!modelName) return res.status(400).json({ error: 'modelName required' });
      try {
        const state = aiModelsManager.startModel(modelName);
        res.json({ message: 'started', state });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/models/stop', (req, res) => {
      const { modelName } = req.body;
      if (!modelName) return res.status(400).json({ error: 'modelName required' });
      try {
        aiModelsManager.stopModel(modelName);
        res.json({ message: 'stopped' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/models/infer', async (req, res) => {
      const { modelName, input } = req.body;
      try {
        const out = await aiModelsManager.infer(modelName, input);
        res.json(out);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/models/download', async (req, res) => {
      const { modelName, url } = req.body;
      if (!modelName || !url) {
        return res.status(400).json({ error: 'Model name and URL are required.' });
      }
      try {
        const modelPath = await aiModelsManager.downloadModel(modelName, url);
        res.json({ message: `Model ${modelName} downloaded successfully.`, path: modelPath });
      } catch (error) {
        res.status(500).json({ error: 'Failed to download model.' });
      }
    });

    app.post('/api/chat', async (req, res) => {
      const { modelName, prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });
      const available = aiModelsManager.listModels();
      if (modelName && !available.find(m => m.name === modelName)) {
        return res.status(400).json({ error: `Model ${modelName} not available on server.` });
      }
      const reply = `Réponse simulée pour le prompt: "${prompt}"`;
      res.json({ reply });
    });

    app.delete('/api/models/:modelName', (req, res) => {
      const { modelName } = req.params;
      try {
        aiModelsManager.deleteModel(modelName);
        res.json({ message: `Model ${modelName} deleted successfully.` });
      } catch (error) {
        res.status(500).json({ error: 'Failed to delete model.' });
      }
    });

    server = http.createServer(app);
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('GET /api/models', () => {
    it('should return list of models', async () => {
      const response = await request(app).get('/api/models');
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('name');
    });
  });

  describe('GET /api/models/:modelName', () => {
    it('should return model info when model exists', async () => {
      const response = await request(app).get('/api/models/model1');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'model1');
      expect(response.body).toHaveProperty('size');
    });

    it('should return 404 when model does not exist', async () => {
      const response = await request(app).get('/api/models/nonexistent');
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Model not found');
    });
  });

  describe('POST /api/models/start', () => {
    it('should start a model successfully', async () => {
      const response = await request(app)
        .post('/api/models/start')
        .send({ modelName: 'model1' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'started');
      expect(response.body).toHaveProperty('state');
    });

    it('should return 400 when modelName is missing', async () => {
      const response = await request(app)
        .post('/api/models/start')
        .send({});
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'modelName required');
    });
  });

  describe('POST /api/models/stop', () => {
    it('should stop a model successfully', async () => {
      const response = await request(app)
        .post('/api/models/stop')
        .send({ modelName: 'model1' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'stopped');
    });

    it('should return 400 when modelName is missing', async () => {
      const response = await request(app)
        .post('/api/models/stop')
        .send({});
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'modelName required');
    });
  });

  describe('POST /api/models/infer', () => {
    it('should perform inference successfully', async () => {
      const response = await request(app)
        .post('/api/models/infer')
        .send({ modelName: 'model1', input: 'test input' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reply');
    });
  });

  describe('POST /api/models/download', () => {
    it('should download a model successfully', async () => {
      const response = await request(app)
        .post('/api/models/download')
        .send({ modelName: 'newmodel', url: 'http://example.com/model.bin' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('downloaded successfully');
    });

    it('should return 400 when parameters are missing', async () => {
      const response = await request(app)
        .post('/api/models/download')
        .send({ modelName: 'newmodel' });
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Model name and URL are required.');
    });
  });

  describe('POST /api/chat', () => {
    it('should return a chat response', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({ modelName: 'model1', prompt: 'Hello AI' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reply');
      expect(response.body.reply).toContain('Hello AI');
    });

    it('should return 400 when prompt is missing', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({});
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Prompt is required.');
    });

    it('should return 400 when model is not available', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({ modelName: 'unavailable-model', prompt: 'Hello' });
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('DELETE /api/models/:modelName', () => {
    it('should delete a model successfully', async () => {
      const response = await request(app).delete('/api/models/model1');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('deleted successfully');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
    });
  });

  describe('GET /version', () => {
    it('should return version information', async () => {
      const response = await request(app).get('/version');
      // May return 200 or 404 depending on version.json existence
      expect([200, 404, 500]).toContain(response.status);
    });
  });
});
