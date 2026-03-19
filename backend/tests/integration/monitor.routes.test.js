const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Mock dependencies
jest.mock('fs');
jest.mock('../../utils/logger');

const monitorRoutes = require('../../routes/monitor.routes');

describe('Monitor Routes Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/', monitorRoutes);
  });

  describe('GET /health', () => {
    it('should return OK status with version when version.json exists', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0', build: '123' }));

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'OK');
      expect(response.body).toHaveProperty('version', '1.0.0');
      expect(response.body).toHaveProperty('timestamp');
      
      // Validate timestamp is recent
      const timestamp = new Date(response.body.timestamp);
      const now = new Date();
      const diff = Math.abs(now - timestamp);
      expect(diff).toBeLessThan(5000); // Within 5 seconds
    });

    it('should return OK status with unknown version when version.json does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'OK');
      expect(response.body).toHaveProperty('version', 'unknown');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should handle JSON parse errors gracefully', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json');

      const response = await request(app).get('/health');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('status', 'ERROR');
    });

    it('should handle file system errors', async () => {
      fs.existsSync.mockImplementation(() => {
        throw new Error('File system error');
      });

      const response = await request(app).get('/health');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('status', 'ERROR');
    });

    it('should include ISO 8601 formatted timestamp', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('GET /version', () => {
    it('should return version information when file exists', async () => {
      const mockVersion = {
        version: '1.0.0',
        build: '123',
        date: '2024-01-01',
        commit: 'abc123'
      };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(mockVersion));

      const response = await request(app).get('/version');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockVersion);
      expect(response.body).toHaveProperty('version', '1.0.0');
      expect(response.body).toHaveProperty('build', '123');
      expect(response.body).toHaveProperty('date', '2024-01-01');
      expect(response.body).toHaveProperty('commit', 'abc123');
    });

    it('should return 404 when version.json does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const response = await request(app).get('/version');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'version.json not found');
    });

    it('should handle JSON parse errors', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{ invalid json }');

      const response = await request(app).get('/version');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to read version');
    });

    it('should handle file read errors', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const response = await request(app).get('/version');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to read version');
    });

    it('should return complete version object structure', async () => {
      const mockVersion = {
        version: '2.5.1',
        build: '456',
        date: '2024-03-19',
        commit: 'def456',
        branch: 'main',
        author: 'CI/CD'
      };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(mockVersion));

      const response = await request(app).get('/version');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject(mockVersion);
      expect(Object.keys(response.body)).toEqual(Object.keys(mockVersion));
    });
  });

  describe('Health Check Reliability', () => {
    it('should always respond even if version check fails', async () => {
      fs.existsSync.mockImplementation(() => {
        throw new Error('Catastrophic failure');
      });

      const response = await request(app).get('/health');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('status');
    });

    it('should be fast to respond', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const startTime = Date.now();
      const response = await request(app).get('/health');
      const endTime = Date.now();

      expect(response.status).toBe(200);
      expect(endTime - startTime).toBeLessThan(1000); // Should respond within 1 second
    });
  });

  describe('Version File Path Resolution', () => {
    it('should look for version.json in parent directory', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      await request(app).get('/version');

      expect(fs.existsSync).toHaveBeenCalled();
      const calledPath = fs.existsSync.mock.calls[0][0];
      expect(calledPath).toContain('version.json');
      expect(calledPath).toContain('..');
    });
  });

  describe('Concurrent Health Checks', () => {
    it('should handle multiple simultaneous health checks', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const requests = Array(10).fill(null).map(() => 
        request(app).get('/health')
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'OK');
      });
    });
  });

  describe('API Response Headers', () => {
    it('should return JSON content type', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should return JSON content type for version endpoint', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));

      const response = await request(app).get('/version');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });
});
