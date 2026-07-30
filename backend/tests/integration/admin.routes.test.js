const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Mock dependencies
jest.mock('../../models/user.model');
jest.mock('../../utils/logger');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

const { getUserByUsername, createUser } = require('../../models/user.model');
const adminRoutes = require('../../routes/admin.routes');

describe('Admin Routes Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/', adminRoutes);
  });

  describe('POST /login', () => {
    it('should login successfully with valid credentials', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        password: await bcrypt.hash('password123', 10),
        role: 'admin'
      };

      getUserByUsername.mockResolvedValue(mockUser);
      bcrypt.compare.mockResolvedValue(true);
      jwt.sign.mockReturnValue('mock-jwt-token');

      const response = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body.token).toBe('mock-jwt-token');
      expect(getUserByUsername).toHaveBeenCalledWith('testuser');
      expect(bcrypt.compare).toHaveBeenCalledWith('password123', mockUser.password);
    });

    it('should return 401 with invalid username', async () => {
      getUserByUsername.mockResolvedValue(null);

      const response = await request(app)
        .post('/login')
        .send({ username: 'wronguser', password: 'password123' });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    it('should return 401 with invalid password', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        password: await bcrypt.hash('password123', 10),
        role: 'admin'
      };

      getUserByUsername.mockResolvedValue(mockUser);
      bcrypt.compare.mockResolvedValue(false);

      const response = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'wrongpassword' });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    it('should return 400 when username is missing', async () => {
      const response = await request(app)
        .post('/login')
        .send({ password: 'password123' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('errors');
    });

    it('should return 400 when password is missing', async () => {
      const response = await request(app)
        .post('/login')
        .send({ username: 'testuser' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('errors');
    });

    it('should handle server errors gracefully', async () => {
      getUserByUsername.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Internal error');
    });
  });

  describe('POST /admin/users', () => {
    it('should create a new user as admin', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });
      createUser.mockResolvedValue(2);

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', 2);
      expect(response.body).toHaveProperty('username', 'newuser');
      expect(response.body).toHaveProperty('role', 'developer');
      expect(createUser).toHaveBeenCalledWith('newuser', 'password123', 'developer');
    });

    it('should return 401 when token is missing', async () => {
      const response = await request(app)
        .post('/admin/users')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Missing token');
    });

    it('should return 401 when token is invalid', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer invalid-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    it('should return 403 when user is not admin', async () => {
      jwt.verify.mockReturnValue({ id: 2, username: 'developer', role: 'developer' });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-developer-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error', 'Admin role required');
    });

    it('should return 400 when username is missing', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ password: 'password123', role: 'developer' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('errors');
    });

    it('should return 400 when password is too short', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ username: 'newuser', password: '12345', role: 'developer' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('errors');
    });

    it('should return 400 when role is invalid', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ username: 'newuser', password: 'password123', role: 'invalid-role' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('errors');
    });

    it('should handle server errors during user creation', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });
      createUser.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to create user');
    });
  });

  describe('JWT Token Validation', () => {
    it('should accept Bearer token format', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });
      createUser.mockResolvedValue(2);

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer valid-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(200);
    });

    it('should reject non-Bearer token format', async () => {
      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'InvalidFormat token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(401);
    });
  });

  describe('Role-Based Access Control', () => {
    it('should allow admin to create users', async () => {
      jwt.verify.mockReturnValue({ id: 1, username: 'admin', role: 'admin' });
      createUser.mockResolvedValue(2);

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer admin-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(200);
    });

    it('should deny developer from creating users', async () => {
      jwt.verify.mockReturnValue({ id: 2, username: 'dev', role: 'developer' });

      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', 'Bearer dev-token')
        .send({ username: 'newuser', password: 'password123', role: 'developer' });

      expect(response.status).toBe(403);
    });
  });
});
