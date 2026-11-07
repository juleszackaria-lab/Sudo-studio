'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const bcryptjs = require('bcryptjs')

console.log('[user.model] Starting with lowdb...')

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

// P57-linux: the pkg data dir used to be Windows-only. On Linux/macOS it fell
// back to <home>/AppData/Local, which does not exist there (and made the boot
// fatal on a read-only home). Per-OS resolution, same convention as
// crashHandler.js: LOCALAPPDATA on Windows, SUDO_STUDIO_HOME or ~/.sudo_studio
// elsewhere.
function resolveBase() {
  if (!process.pkg) return path.join(__dirname, '..', '..')
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SudoStudio')
  }
  return process.env.SUDO_STUDIO_HOME || path.join(os.homedir(), '.sudo_studio')
}

const BASE = resolveBase()

// The data dir must never decide whether the backend boots: prefer the user
// dir, then the portable install dir, and only then give up with a clear log.
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (_) {
    return false
  }
}
let dbDir = path.join(BASE, 'data')
if (!ensureDir(dbDir)) {
  const fallback = path.join(path.dirname(process.execPath), '..', 'data')
  console.log('[user.model] WARNING: cannot use ' + dbDir + ' -> falling back to ' + fallback)
  dbDir = fallback
  ensureDir(dbDir)
}

const dbPath = path.join(dbDir, 'enterprise.json')
// One-way migration from the pre-hotfix location (sibling `data` next to
// the install dir): copy only, never delete, never blocks boot.
try {
  if (process.pkg && !fs.existsSync(dbPath)) {
    const legacyDb = path.join(path.dirname(process.execPath), '..', 'data', 'enterprise.json')
    if (fs.existsSync(legacyDb)) {
      fs.copyFileSync(legacyDb, dbPath)
      console.log('[user.model] migrated legacy DB to', dbPath)
    }
  }
} catch (_) { /* best-effort migration */ }
const adapter = new FileSync(dbPath)
const db = low(adapter)
db.defaults({ users: [], sessions: [] }).write()

const admin = db.get('users')
  .find({ username: 'admin' }).value()
if (!admin) {
  const hash = bcryptjs.hashSync('admin123', 10)
  db.get('users').push({
    id: 1,
    username: 'admin',
    password: hash,
    role: 'admin',
    createdAt: new Date().toISOString()
  }).write()
}

console.log('[user.model] lowdb OK — ZERO sql.js')

// initDB kept for backward compatibility with server.js
async function initDB() {
  // Already initialized at module load — nothing to do
}

module.exports = {
  initDB,
  findByUsername: (username) => {
    return db.get('users')
      .find({ username }).value() || null
  },
  findById: (id) => {
    return db.get('users')
      .find({ id: Number(id) }).value() || null
  },
  // Backward-compat aliases for admin.routes.js and auth.routes.js
  getUserByUsername: (username) => {
    return db.get('users')
      .find({ username }).value() || null
  },
  getUserById: (id) => {
    return db.get('users')
      .find({ id: Number(id) }).value() || null
  },
  createUser: (username, password, role) => {
    const hash = bcryptjs.hashSync(password, 10)
    const user = {
      id: Date.now(),
      username,
      password: hash,
      role: role || 'user',
      createdAt: new Date().toISOString()
    }
    db.get('users').push(user).write()
    return user
  },
  updateUser: (id, data) => {
    db.get('users')
      .find({ id: Number(id) })
      .assign(data).write()
    return db.get('users')
      .find({ id: Number(id) }).value()
  },
  getAllUsers: () => {
    return db.get('users').value() || []
  },
  deleteUser: (id) => {
    db.get('users')
      .remove({ id: Number(id) }).write()
  }
}
