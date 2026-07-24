/**
 * user.model.js — sql.js edition
 *
 * WHY sql.js instead of better-sqlite3:
 *   better-sqlite3 ships a native C++ binding (better_sqlite3.node).
 *   Under pkg that .node file is embedded inside the read-only virtual
 *   snapshot and process.dlopen() cannot load it → immediate crash.
 *
 *   sql.js is SQLite compiled to WebAssembly / pure JavaScript via
 *   Emscripten. ZERO native .node files. Works perfectly with pkg.
 *
 * sql.js API differences from better-sqlite3:
 *   - Initialisation is async (await initSqlJs(...))
 *   - DB is in-memory; we persist it manually with db.export() → fs.writeFileSync()
 *   - Query: db.run(sql, params), db.prepare(sql), stmt.step(), stmt.getAsObject()
 *   - No .pragma(), use PRAGMA SQL statement via db.run()
 *
 * All exported functions remain async so callers need zero changes.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs'); // pure-JS, no .node binary

// ---------------------------------------------------------------------------
// PKG-SAFE db path
// ---------------------------------------------------------------------------
function getDbDir() {
  if (process.pkg) {
    // Inside pkg exe, __dirname = /snapshot/... (read-only virtual FS)
    // Use the real disk directory that contains the exe
    const exeDir = path.dirname(process.execPath);
    return path.join(exeDir, '..', 'data');
  }
  return path.join(__dirname, '..', 'data');
}

const dbDir  = getDbDir();
const dbPath = path.join(dbDir, 'enterprise.db');

try {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch (e) {
  process.stderr.write('[user.model] WARNING: Cannot create dbDir: ' + e.message + '\n');
}

// ---------------------------------------------------------------------------
// sql.js WASM location — pkg-safe
// ---------------------------------------------------------------------------
function locateWasmFile(filename /*, prefix*/) {
  // sql.js calls this to find sql-wasm.wasm
  // Under pkg: try next to the exe first, then next to execPath/../
  if (process.pkg) {
    const exeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(exeDir, filename),
      path.join(exeDir, '..', filename),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Fallback: let sql.js use asm.js (no wasm needed) — handled below
    return path.join(exeDir, filename);
  }
  // Dev: wasm file is inside node_modules/sql.js/dist/
  return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', filename);
}

// ---------------------------------------------------------------------------
// Module-level DB instance (initialized lazily via initDB())
// ---------------------------------------------------------------------------
let db       = null;
let dbReady  = false;
let dbError  = null;
let SQL      = null; // sql.js SQL class (needed for db.export())

// Persist DB to disk after every write operation
function persistDB() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    process.stderr.write('[user.model] WARNING: Cannot persist DB: ' + e.message + '\n');
  }
}

// ---------------------------------------------------------------------------
// initDB() — call once at startup (async, safe to call multiple times)
// ---------------------------------------------------------------------------
let _initPromise = null;

async function initDB() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInitDB();
  return _initPromise;
}

async function _doInitDB() {
  try {
    // Try wasm build first; fall back to asm.js if wasm is missing under pkg
    let initSqlJs;
    try {
      initSqlJs = require('sql.js');
    } catch (e) {
      dbError = e;
      process.stderr.write('[user.model] FATAL: Cannot require sql.js: ' + e.message + '\n');
      return;
    }

    // Initialise sql.js — locateFile lets it find the .wasm next to the exe
    try {
      SQL = await initSqlJs({ locateFile: locateWasmFile });
    } catch (e) {
      // Wasm not found or failed — try asm.js build (truly pure JS, no wasm)
      process.stderr.write('[user.model] wasm init failed (' + e.message + '), trying asm.js build\n');
      try {
        initSqlJs = require('sql.js/dist/sql-asm.js');
        SQL = await initSqlJs();
      } catch (e2) {
        dbError = e2;
        process.stderr.write('[user.model] FATAL: sql.js asm.js also failed: ' + e2.message + '\n');
        return;
      }
    }

    // Load existing DB from disk or create fresh in-memory DB
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      process.stderr.write('[user.model] Loaded existing DB from ' + dbPath + '\n');
    } else {
      db = new SQL.Database();
      process.stderr.write('[user.model] Created new in-memory DB (will persist to ' + dbPath + ')\n');
    }

    // Enable WAL-equivalent performance via PRAGMA (sql.js supports PRAGMA via db.run)
    db.run('PRAGMA journal_mode=WAL;');

    // Create schema
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT    UNIQUE NOT NULL,
        password   TEXT    NOT NULL,
        role       TEXT    NOT NULL DEFAULT 'developer',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create default admin if not exists
    const existing = _queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
    if (!existing) {
      const hashed = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', hashed, 'admin']);
      persistDB();
      process.stderr.write('[user.model] Default admin created (username: admin, password: admin123)\n');
    } else {
      process.stderr.write('[user.model] DB ready, admin user already exists\n');
    }

    dbReady = true;
  } catch (e) {
    dbError = e;
    process.stderr.write('[user.model] initDB error: ' + e.message + '\n');
  }
}

// ---------------------------------------------------------------------------
// Internal sql.js query helpers
// ---------------------------------------------------------------------------

/**
 * Execute a SELECT and return the FIRST row as a plain object, or null.
 */
function _queryOne(sql, params) {
  if (!db) return null;
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params || []);
    if (!stmt.step()) return null;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

/**
 * Execute a SELECT and return ALL rows as plain objects.
 */
function _queryAll(sql, params) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params || []);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
  } finally {
    stmt.free();
  }
  return rows;
}

/**
 * Execute an INSERT/UPDATE/DELETE and return { changes, lastInsertRowid }.
 * sql.js does not expose affected-rows directly, so we read them via SQL.
 */
function _run(sql, params) {
  if (!db) throw new Error('Database not available');
  db.run(sql, params || []);
  // sql.js stores last insert rowid accessible via a SELECT
  const row = _queryOne('SELECT last_insert_rowid() AS lastId, changes() AS changes', []);
  return {
    lastInsertRowid: row ? row.lastId  : 0,
    changes:         row ? row.changes : 0,
  };
}

// ---------------------------------------------------------------------------
// Public CRUD functions (async, backward-compatible API)
// ---------------------------------------------------------------------------

async function getUserByUsername(username) {
  if (!dbReady) await initDB();
  if (!db) return null;
  try {
    return _queryOne('SELECT * FROM users WHERE username = ?', [username]);
  } catch (e) {
    process.stderr.write('[user.model] getUserByUsername error: ' + e.message + '\n');
    return null;
  }
}

async function getUserById(id) {
  if (!dbReady) await initDB();
  if (!db) return null;
  try {
    return _queryOne('SELECT * FROM users WHERE id = ?', [id]);
  } catch (e) {
    process.stderr.write('[user.model] getUserById error: ' + e.message + '\n');
    return null;
  }
}

async function createUser(username, password, role = 'developer') {
  if (!dbReady) await initDB();
  if (!db) throw new Error('Database not available');
  const hashed = bcrypt.hashSync(password, 10);
  try {
    const info = _run(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashed, role]
    );
    persistDB();
    return info.lastInsertRowid;
  } catch (e) {
    throw e;
  }
}

async function getAllUsers() {
  if (!dbReady) await initDB();
  if (!db) return [];
  try {
    return _queryAll('SELECT id, username, role, created_at FROM users', []);
  } catch (e) {
    process.stderr.write('[user.model] getAllUsers error: ' + e.message + '\n');
    return [];
  }
}

async function deleteUser(id) {
  if (!dbReady) await initDB();
  if (!db) return 0;
  try {
    const info = _run('DELETE FROM users WHERE id = ?', [id]);
    persistDB();
    return info.changes;
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
  getDb:    () => db,       // expose for direct use if needed
  dbError:  () => dbError,  // expose so server.js can log init errors
};
