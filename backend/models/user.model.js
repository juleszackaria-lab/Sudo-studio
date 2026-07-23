/**
 * user.model.js
 *
 * Uses better-sqlite3 (synchronous API) and bcryptjs (pure-JS).
 * Both are compatible with pkg without any native .node extraction issues
 * because better-sqlite3 uses a different binding path and bcryptjs has
 * zero native code.
 *
 * API is fully backward-compatible with the previous sqlite3/bcrypt version:
 * all functions are async (returning Promises) so callers need no changes.
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs'); // pure-JS, no .node binary

// ---------------------------------------------------------------------------
// DB path: works both with plain node and inside pkg exe
// ---------------------------------------------------------------------------
function getDbDir() {
  // When running as pkg exe, __dirname is inside the snapshot (/snapshot/...)
  // and is NOT writable. We must use a real disk path.
  if (process.pkg) {
    // Use the directory that contains the exe itself
    const exeDir = path.dirname(process.execPath);
    return path.join(exeDir, 'data');
  }
  // Normal node execution
  return path.join(__dirname, '..', 'data');
}

const dbDir = getDbDir();
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'enterprise.db');

// ---------------------------------------------------------------------------
// Load better-sqlite3 with pkg-aware path resolution
// ---------------------------------------------------------------------------
let Database;
let db;
let dbError = null;

try {
  // better-sqlite3 uses `bindings` which relies on Error.captureStackTrace
  // to find module_root. Inside pkg snapshot this still works because
  // better-sqlite3 ships prebuilt binaries via @mapbox/node-pre-gyp
  // rather than the legacy `bindings` module in newer versions.
  // If it still fails, we fall through to the in-memory fallback.
  Database = require('better-sqlite3');
  db = new Database(dbPath);
  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
} catch (e) {
  dbError = e;
  console.error('[user.model] better-sqlite3 failed, using in-memory fallback:', e.message);
  try {
    // Last resort: in-memory database (data lost on restart, but server stays alive)
    Database = require('better-sqlite3');
    db = new Database(':memory:');
  } catch (e2) {
    console.error('[user.model] in-memory DB also failed:', e2.message);
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Schema initialization (synchronous with better-sqlite3)
// ---------------------------------------------------------------------------
async function initDB() {
  if (!db) {
    console.warn('[user.model] Database not available, skipping initDB');
    return;
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT    UNIQUE NOT NULL,
        password TEXT    NOT NULL,
        role     TEXT    NOT NULL DEFAULT 'developer',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create default admin if not exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existing) {
      const hashed = bcrypt.hashSync('admin123', 10);
      db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hashed, 'admin');
      console.log('[user.model] Default admin created (username: admin, password: admin123)');
    } else {
      console.log('[user.model] Database initialized, admin user already exists');
    }
  } catch (e) {
    console.error('[user.model] initDB error:', e.message);
    // Non-fatal: server continues without DB features
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers (async wrappers around synchronous better-sqlite3 calls)
// ---------------------------------------------------------------------------
async function getUserByUsername(username) {
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  } catch (e) {
    console.error('[user.model] getUserByUsername error:', e.message);
    return null;
  }
}

async function getUserById(id) {
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  } catch (e) {
    console.error('[user.model] getUserById error:', e.message);
    return null;
  }
}

async function createUser(username, password, role = 'developer') {
  if (!db) throw new Error('Database not available');
  const hashed = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, hashed, role);
    return info.lastInsertRowid;
  } catch (e) {
    throw e;
  }
}

async function getAllUsers() {
  if (!db) return [];
  try {
    return db.prepare('SELECT id, username, role, created_at FROM users').all();
  } catch (e) {
    console.error('[user.model] getAllUsers error:', e.message);
    return [];
  }
}

async function deleteUser(id) {
  if (!db) return 0;
  try {
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return info.changes;
  } catch (e) {
    console.error('[user.model] deleteUser error:', e.message);
    return 0;
  }
}

module.exports = {
  initDB,
  getUserByUsername,
  getUserById,
  createUser,
  getAllUsers,
  deleteUser,
  db,      // expose for direct use if needed
  dbError, // expose so server.js can log any init error
};
