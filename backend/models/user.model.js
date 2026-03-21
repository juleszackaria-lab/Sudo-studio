const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'enterprise.db');
const db = new sqlite3.Database(dbPath);

async function initDB() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'developer',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Failed to create users table:', err);
          reject(err);
        } else {
          // Create default admin user if not exists
          const defaultAdminUsername = 'admin';
          const defaultAdminPassword = 'admin123';
          
          db.get('SELECT * FROM users WHERE username = ?', [defaultAdminUsername], async (err, row) => {
            if (err) {
              console.error('Error checking for default admin:', err);
              reject(err);
            } else if (!row) {
              try {
                const hashedPassword = await bcrypt.hash(defaultAdminPassword, 10);
                db.run(
                  'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
                  [defaultAdminUsername, hashedPassword, 'admin'],
                  (err) => {
                    if (err) {
                      console.error('Failed to create default admin:', err);
                      reject(err);
                    } else {
                      console.log('Default admin user created (username: admin, password: admin123)');
                      resolve();
                    }
                  }
                );
              } catch (e) {
                console.error('Error hashing password:', e);
                reject(e);
              }
            } else {
              console.log('Database initialized, admin user already exists');
              resolve();
            }
          });
        }
      });
    });
  });
}

async function getUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function createUser(username, password, role = 'developer') {
  const hashedPassword = await bcrypt.hash(password, 10);
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, username, role, created_at FROM users', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function deleteUser(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM users WHERE id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

module.exports = {
  initDB,
  getUserByUsername,
  getUserById,
  createUser,
  getAllUsers,
  deleteUser,
  db,
};
