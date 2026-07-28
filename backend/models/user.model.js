/**
 * user.model.js — lowdb edition
 *
 * WHY lowdb instead of sql.js / better-sqlite3:
 *   - better-sqlite3: native C++ .node file → dlopen crash under pkg
 *   - sql.js: WebAssembly → pkg cannot locate sql-wasm.wasm at runtime
 *   - lowdb@1.0.0: 100% pure JavaScript, JSON file on disk, ZERO deps
 *     that could fail under pkg. Works identically in dev and exe.
 *
 * Storage: enterprise.json next to the exe (PKG-SAFE path).
 *
 * Public API is backward-compatible with the previous sql.js version:
 *   initDB(), getUserByUsername(), getUserById(),
 *   createUser(), getAllUsers(), deleteUser()
 * All functions are async (returning Promises) so callers need no changes.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const low     = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// ---------------------------------------------------------------------------
// PKG-SAFE data directory
// pkg  → exe is at process.execPath (e.g. C:\SudoStudio\app\backend.exe)
//        data goes to C:\SudoStudio\data\  (install root / data)
// dev  → data goes to backend/../data/
// ---------------------------------------------------------------------------
const dataDir = process.pkg
  ? path.join(path.dirname(process.execPath), '..', 'data')
  : path.join(__dirname, '..', 'data');

const dbPath = path.join(dataDir, 'enterprise.json');

process.stderr.write('[user.model] DB path: ' + dbPath + '\n');

// Ensure data directory exists before lowdb tries to open the file
try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    process.stderr.write('[user.model] Created data dir: ' + dataDir + '\n');
  }
} catch (e) {
  process.stderr.write('[user.model] WARNING: Cannot create data dir: ' + e.message + '\n');
}

// ---------------------------------------------------------------------------
// lowdb setup — synchronous JSON adapter, no wasm, no native code
// ---------------------------------------------------------------------------
const adapter = new FileSync(dbPath);
const db      = low(adapter);

// ---------------------------------------------------------------------------
// initDB() — idempotent, safe to call multiple times
// Sets up schema defaults and creates the default admin if absent.
// ---------------------------------------------------------------------------
let _initDone = false;

async function initDB() {
  if (_initDone) return;

  try {
    // Set schema defaults (creates file if it doesn't exist)
    db.defaults({ users: [] }).write();

    // Create default admin user if not present
    const existing = db.get('users').find({ username: 'admin' }).value();
    if (!existing) {
      const hashed = bcrypt.hashSync('admin123', 10);
      db.get('users').push({
        id: 1,
        username: 'admin',
        password: hashed,
        role: 'admin',
        created_at: new Date().toISOString(),
      }).write();
      process.stderr.write('[user.model] Default admin created (username: admin, password: admin123)\n');
    } else {
      process.stderr.write('[user.model] DB ready, admin user already exists\n');
    }

    _initDone = true;
  } catch (e) {
    process.stderr.write('[user.model] initDB error: ' + e.message + '\n');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

async function getUserByUsername(username) {
  if (!_initDone) await initDB();
  try {
    return db.get('users').find({ username }).value() || null;
  } catch (e) {
    process.stderr.write('[user.model] getUserByUsername error: ' + e.message + '\n');
    return null;
  }
}

async function getUserById(id) {
  if (!_initDone) await initDB();
  try {
    // id may be number or string — coerce both to number for comparison
    return db.get('users').find(u => Number(u.id) === Number(id)).value() || null;
  } catch (e) {
    process.stderr.write('[user.model] getUserById error: ' + e.message + '\n');
    return null;
  }
}

async function createUser(username, password, role = 'developer') {
  if (!_initDone) await initDB();
  const hashed = bcrypt.hashSync(password, 10);
  const user = {
    id: Date.now(),
    username,
    password: hashed,
    role,
    created_at: new Date().toISOString(),
  };
  try {
    db.get('users').push(user).write();
    return user.id;
  } catch (e) {
    throw e;
  }
}

async function getAllUsers() {
  if (!_initDone) await initDB();
  try {
    return db.get('users').map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      created_at: u.created_at,
    })).value();
  } catch (e) {
    process.stderr.write('[user.model] getAllUsers error: ' + e.message + '\n');
    return [];
  }
}

async function deleteUser(id) {
  if (!_initDone) await initDB();
  try {
    const before = db.get('users').size().value();
    db.get('users').remove(u => Number(u.id) === Number(id)).write();
    const after = db.get('users').size().value();
    return before - after; // number of deleted rows
  } catch (e) {
    process.stderr.write('[user.model] deleteUser error: ' + e.message + '\n');
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
};
