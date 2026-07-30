'use strict'
const path = require('path')
const fs = require('fs')
const bcryptjs = require('bcryptjs')

console.log('[user.model] Starting with lowdb...')

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

const BASE = process.pkg
  ? path.join(path.dirname(process.execPath), '..')
  : path.join(__dirname, '..', '..')

const dbDir = path.join(BASE, 'data')
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

const dbPath = path.join(dbDir, 'enterprise.json')
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
