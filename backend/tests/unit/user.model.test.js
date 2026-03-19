const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3');
const path = require('path');

// Mock dependencies
jest.mock('sqlite3');
jest.mock('bcrypt');
jest.mock('fs');

const fs = require('fs');

describe('User Model Tests', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock fs
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});

    // Create mock database
    mockDb = {
      serialize: jest.fn((callback) => callback()),
      run: jest.fn((query, params, callback) => {
        if (typeof params === 'function') {
          callback = params;
          params = [];
        }
        if (callback) callback.call({ lastID: 1, changes: 1 }, null);
      }),
      get: jest.fn((query, params, callback) => {
        if (callback) callback(null, null);
      }),
      all: jest.fn((query, callback) => {
        if (callback) callback(null, []);
      }),
    };

    sqlite3.Database.mockImplementation(() => mockDb);
  });

  describe('initDB', () => {
    it('should create users table if not exists', async () => {
      // Reload module to trigger initialization
      jest.isolateModules(() => {
        const userModel = require('../../models/user.model');
        
        expect(mockDb.serialize).toHaveBeenCalled();
        expect(mockDb.run).toHaveBeenCalled();
      });
    });

    it('should create default admin user if not exists', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // No admin exists
      });

      bcrypt.hash.mockResolvedValue('hashed-admin-password');

      jest.isolateModules(() => {
        const userModel = require('../../models/user.model');
        
        // Wait for async operations
        setTimeout(() => {
          expect(bcrypt.hash).toHaveBeenCalledWith('admin123', 10);
        }, 100);
      });
    });

    it('should not create admin if already exists', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, username: 'admin', role: 'admin' });
      });

      jest.isolateModules(() => {
        const userModel = require('../../models/user.model');
        
        setTimeout(() => {
          expect(mockDb.run).toHaveBeenCalledTimes(1); // Only CREATE TABLE
        }, 100);
      });
    });
  });

  describe('getUserByUsername', () => {
    it('should return user when found', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        password: 'hashed-password',
        role: 'developer'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, mockUser);
      });

      jest.isolateModules(async () => {
        const { getUserByUsername } = require('../../models/user.model');
        const user = await getUserByUsername('testuser');

        expect(user).toEqual(mockUser);
        expect(mockDb.get).toHaveBeenCalledWith(
          'SELECT * FROM users WHERE username = ?',
          ['testuser'],
          expect.any(Function)
        );
      });
    });

    it('should return null when user not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      jest.isolateModules(async () => {
        const { getUserByUsername } = require('../../models/user.model');
        const user = await getUserByUsername('nonexistent');

        expect(user).toBeNull();
      });
    });

    it('should handle database errors', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'));
      });

      jest.isolateModules(async () => {
        const { getUserByUsername } = require('../../models/user.model');
        
        await expect(getUserByUsername('testuser')).rejects.toThrow('Database error');
      });
    });
  });

  describe('getUserById', () => {
    it('should return user when found by id', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        password: 'hashed-password',
        role: 'developer'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, mockUser);
      });

      jest.isolateModules(async () => {
        const { getUserById } = require('../../models/user.model');
        const user = await getUserById(1);

        expect(user).toEqual(mockUser);
        expect(mockDb.get).toHaveBeenCalledWith(
          'SELECT * FROM users WHERE id = ?',
          [1],
          expect.any(Function)
        );
      });
    });

    it('should return null when user not found by id', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      jest.isolateModules(async () => {
        const { getUserById } = require('../../models/user.model');
        const user = await getUserById(999);

        expect(user).toBeNull();
      });
    });
  });

  describe('createUser', () => {
    it('should create a new user with hashed password', async () => {
      bcrypt.hash.mockResolvedValue('hashed-password');

      mockDb.run.mockImplementation(function (query, params, callback) {
        callback.call({ lastID: 5 }, null);
      });

      jest.isolateModules(async () => {
        const { createUser } = require('../../models/user.model');
        const userId = await createUser('newuser', 'password123', 'developer');

        expect(userId).toBe(5);
        expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
          ['newuser', 'hashed-password', 'developer'],
          expect.any(Function)
        );
      });
    });

    it('should default to developer role if not specified', async () => {
      bcrypt.hash.mockResolvedValue('hashed-password');

      mockDb.run.mockImplementation(function (query, params, callback) {
        callback.call({ lastID: 6 }, null);
      });

      jest.isolateModules(async () => {
        const { createUser } = require('../../models/user.model');
        await createUser('newuser2', 'password123');

        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
          ['newuser2', 'hashed-password', 'developer'],
          expect.any(Function)
        );
      });
    });

    it('should handle database errors during user creation', async () => {
      bcrypt.hash.mockResolvedValue('hashed-password');

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Duplicate username'));
      });

      jest.isolateModules(async () => {
        const { createUser } = require('../../models/user.model');
        
        await expect(createUser('duplicate', 'password123')).rejects.toThrow('Duplicate username');
      });
    });
  });

  describe('getAllUsers', () => {
    it('should return all users without password field', async () => {
      const mockUsers = [
        { id: 1, username: 'admin', role: 'admin', created_at: '2024-01-01' },
        { id: 2, username: 'dev1', role: 'developer', created_at: '2024-01-02' }
      ];

      mockDb.all.mockImplementation((query, callback) => {
        callback(null, mockUsers);
      });

      jest.isolateModules(async () => {
        const { getAllUsers } = require('../../models/user.model');
        const users = await getAllUsers();

        expect(users).toEqual(mockUsers);
        expect(mockDb.all).toHaveBeenCalledWith(
          'SELECT id, username, role, created_at FROM users',
          expect.any(Function)
        );
      });
    });

    it('should return empty array when no users exist', async () => {
      mockDb.all.mockImplementation((query, callback) => {
        callback(null, []);
      });

      jest.isolateModules(async () => {
        const { getAllUsers } = require('../../models/user.model');
        const users = await getAllUsers();

        expect(users).toEqual([]);
      });
    });

    it('should handle database errors', async () => {
      mockDb.all.mockImplementation((query, callback) => {
        callback(new Error('Database error'));
      });

      jest.isolateModules(async () => {
        const { getAllUsers } = require('../../models/user.model');
        
        await expect(getAllUsers()).rejects.toThrow('Database error');
      });
    });
  });

  describe('deleteUser', () => {
    it('should delete user successfully', async () => {
      mockDb.run.mockImplementation(function (query, params, callback) {
        callback.call({ changes: 1 }, null);
      });

      jest.isolateModules(async () => {
        const { deleteUser } = require('../../models/user.model');
        const changes = await deleteUser(5);

        expect(changes).toBe(1);
        expect(mockDb.run).toHaveBeenCalledWith(
          'DELETE FROM users WHERE id = ?',
          [5],
          expect.any(Function)
        );
      });
    });

    it('should return 0 changes when user does not exist', async () => {
      mockDb.run.mockImplementation(function (query, params, callback) {
        callback.call({ changes: 0 }, null);
      });

      jest.isolateModules(async () => {
        const { deleteUser } = require('../../models/user.model');
        const changes = await deleteUser(999);

        expect(changes).toBe(0);
      });
    });

    it('should handle database errors during deletion', async () => {
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Foreign key constraint'));
      });

      jest.isolateModules(async () => {
        const { deleteUser } = require('../../models/user.model');
        
        await expect(deleteUser(5)).rejects.toThrow('Foreign key constraint');
      });
    });
  });

  describe('Password Security', () => {
    it('should use bcrypt with cost factor 10', async () => {
      bcrypt.hash.mockResolvedValue('hashed-password');

      mockDb.run.mockImplementation(function (query, params, callback) {
        callback.call({ lastID: 1 }, null);
      });

      jest.isolateModules(async () => {
        const { createUser } = require('../../models/user.model');
        await createUser('user', 'password');

        expect(bcrypt.hash).toHaveBeenCalledWith('password', 10);
      });
    });
  });
});
