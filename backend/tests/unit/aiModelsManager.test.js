const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

// Mock dependencies
jest.mock('fs');
jest.mock('axios');
jest.mock('child_process');

const aiModelsManager = require('../../ai/aiModelsManager');

describe('AI Models Manager Unit Tests', () => {
  const mockModelsDir = path.join(__dirname, '../../ai/models');
  const mockMetadataFile = path.join(mockModelsDir, 'models.json');

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default fs mocks
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      'test-model': {
        url: 'http://example.com/model.bin',
        path: '/path/to/test-model',
        size: 2048
      }
    }));
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
    fs.statSync.mockReturnValue({ size: 2048 });
  });

  describe('listModels', () => {
    it('should return an array of models with status', () => {
      const models = aiModelsManager.listModels();
      expect(Array.isArray(models)).toBe(true);
      if (models.length > 0) {
        expect(models[0]).toHaveProperty('name');
        expect(models[0]).toHaveProperty('status');
      }
    });

    it('should include stopped status for models not running', () => {
      const models = aiModelsManager.listModels();
      const stoppedModel = models.find(m => m.status === 'stopped');
      expect(stoppedModel).toBeDefined();
    });
  });

  describe('getModelInfo', () => {
    it('should return model info when model exists', () => {
      const info = aiModelsManager.getModelInfo('test-model');
      expect(info).toBeDefined();
      expect(info).toHaveProperty('name', 'test-model');
      expect(info).toHaveProperty('status');
    });

    it('should return null when model does not exist', () => {
      const info = aiModelsManager.getModelInfo('nonexistent-model');
      expect(info).toBeNull();
    });

    it('should include size and path information', () => {
      const info = aiModelsManager.getModelInfo('test-model');
      if (info) {
        expect(info).toHaveProperty('size');
        expect(info).toHaveProperty('path');
      }
    });
  });

  describe('downloadModel', () => {
    it('should download a model successfully', async () => {
      const mockStream = {
        pipe: jest.fn().mockReturnThis(),
        on: jest.fn()
      };

      axios.mockResolvedValue({
        data: mockStream
      });

      const mockWriter = {
        on: jest.fn((event, handler) => {
          if (event === 'finish') {
            setTimeout(() => handler(), 0);
          }
          return mockWriter;
        })
      };

      fs.createWriteStream.mockReturnValue(mockWriter);
      fs.existsSync.mockReturnValue(false);

      const modelPath = await aiModelsManager.downloadModel('new-model', 'http://example.com/model.bin');
      
      expect(fs.createWriteStream).toHaveBeenCalled();
      expect(axios).toHaveBeenCalledWith({
        url: 'http://example.com/model.bin',
        method: 'GET',
        responseType: 'stream'
      });
      expect(modelPath).toContain('new-model');
    });

    it('should not re-download if model already exists', async () => {
      fs.existsSync.mockReturnValue(true);
      
      const modelPath = await aiModelsManager.downloadModel('existing-model', 'http://example.com/model.bin');
      
      expect(axios).not.toHaveBeenCalled();
      expect(modelPath).toContain('existing-model');
    });
  });

  describe('deleteModel', () => {
    it('should delete a model successfully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {});

      expect(() => {
        aiModelsManager.deleteModel('test-model');
      }).not.toThrow();

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should handle deletion of non-existent model gracefully', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => {
        aiModelsManager.deleteModel('nonexistent-model');
      }).not.toThrow();
    });
  });

  describe('startModel', () => {
    it('should start a model and return runtime state', () => {
      const mockChild = {
        pid: 12345,
        unref: jest.fn()
      };

      spawn.mockReturnValue(mockChild);

      const state = aiModelsManager.startModel('test-model');
      
      expect(state).toBeDefined();
      expect(state).toHaveProperty('status', 'running');
      expect(state).toHaveProperty('pid');
      expect(state).toHaveProperty('port');
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining(['--model', 'test-model', '--port']),
        expect.any(Object)
      );
    });

    it('should throw error when starting non-existent model', () => {
      expect(() => {
        aiModelsManager.startModel('nonexistent-model');
      }).toThrow('Model not found');
    });

    it('should not restart already running model', () => {
      const mockChild = {
        pid: 12345,
        unref: jest.fn()
      };

      spawn.mockReturnValue(mockChild);

      const state1 = aiModelsManager.startModel('test-model');
      const state2 = aiModelsManager.startModel('test-model');
      
      expect(state1).toEqual(state2);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopModel', () => {
    it('should stop a running model', () => {
      const mockChild = {
        pid: 12345,
        unref: jest.fn()
      };

      spawn.mockReturnValue(mockChild);
      process.kill = jest.fn();

      aiModelsManager.startModel('test-model');
      aiModelsManager.stopModel('test-model');

      expect(process.kill).toHaveBeenCalledWith(12345);
    });

    it('should handle stopping non-running model gracefully', () => {
      expect(() => {
        aiModelsManager.stopModel('test-model');
      }).not.toThrow();
    });
  });

  describe('infer', () => {
    it('should perform inference successfully', async () => {
      const mockChild = {
        pid: 12345,
        unref: jest.fn()
      };

      spawn.mockReturnValue(mockChild);
      axios.post = jest.fn().mockResolvedValue({
        data: { reply: 'AI response' }
      });

      aiModelsManager.startModel('test-model');
      
      const result = await aiModelsManager.infer('test-model', 'test input');
      
      expect(result).toBeDefined();
      expect(result).toHaveProperty('reply');
    });

    it('should throw error when inferring with unavailable model', async () => {
      await expect(aiModelsManager.infer('nonexistent-model', 'test input'))
        .rejects.toThrow('Model not available');
    });

    it('should handle inference errors gracefully', async () => {
      const mockChild = {
        pid: 12345,
        unref: jest.fn()
      };

      spawn.mockReturnValue(mockChild);
      axios.post = jest.fn().mockRejectedValue(new Error('Connection failed'));

      aiModelsManager.startModel('test-model');
      
      const result = await aiModelsManager.infer('test-model', 'test input');
      
      expect(result).toHaveProperty('reply');
      expect(result.reply).toContain('failed');
    });
  });

  describe('Port Management', () => {
    it('should assign different ports to multiple models', () => {
      const mockChild1 = { pid: 12345, unref: jest.fn() };
      const mockChild2 = { pid: 12346, unref: jest.fn() };

      spawn
        .mockReturnValueOnce(mockChild1)
        .mockReturnValueOnce(mockChild2);

      // Add another model to metadata
      fs.readFileSync.mockReturnValue(JSON.stringify({
        'test-model': { url: 'http://example.com/model1.bin', path: '/path/to/test-model', size: 2048 },
        'test-model-2': { url: 'http://example.com/model2.bin', path: '/path/to/test-model-2', size: 2048 }
      }));

      const state1 = aiModelsManager.startModel('test-model');
      const state2 = aiModelsManager.startModel('test-model-2');

      expect(state1.port).not.toEqual(state2.port);
      expect(state2.port).toBeGreaterThan(state1.port);
    });
  });
});
