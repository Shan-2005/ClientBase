const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = path.join(dbDir, 'app.db');

// Ensure directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  -- Core Systems
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    apiKey TEXT UNIQUE,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    email TEXT,
    password TEXT,
    name TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id),
    UNIQUE(projectId, email)
  );

  -- Database System
  CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    databaseId TEXT,
    name TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(databaseId) REFERENCES databases(id)
  );

  CREATE TABLE IF NOT EXISTS attributes (
    id TEXT PRIMARY KEY,
    collectionId TEXT,
    key TEXT,
    type TEXT, -- string, integer, boolean, float
    required INTEGER,
    FOREIGN KEY(collectionId) REFERENCES collections(id)
  );

  -- Storage System
  CREATE TABLE IF NOT EXISTS buckets (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    fileSizeLimit INTEGER,
    allowedExtensions TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    bucketId TEXT,
    name TEXT,
    path TEXT,
    data BLOB,
    size INTEGER,
    mimeType TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(bucketId) REFERENCES buckets(id)
  );

  -- Functions System
  CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    runtime TEXT, -- nodejs-18, etc.
    code TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed Default Project and Settings
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('storage_limit_bytes', (5 * 1024 * 1024 * 1024).toString());
db.prepare('INSERT OR IGNORE INTO projects (id, name, apiKey) VALUES (?, ?, ?)').run('default', 'Default Project', 'master-key-ssd-secret');
db.prepare('INSERT OR IGNORE INTO buckets (id, projectId, name) VALUES (?, ?, ?)').run('default', 'default', 'Default Bucket');

// Migration: add 'data' BLOB column to files if it doesn't exist yet (for existing DBs)
try { db.exec('ALTER TABLE files ADD COLUMN data BLOB'); } catch (_) { /* already exists */ }

// Sessions, Teams, Memberships, Execution Logs
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    userId TEXT,
    projectId TEXT,
    token TEXT UNIQUE,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME,
    FOREIGN KEY(userId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    teamId TEXT,
    userId TEXT,
    roles TEXT DEFAULT 'member',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teamId) REFERENCES teams(id)
  );

  CREATE TABLE IF NOT EXISTS execution_logs (
    id TEXT PRIMARY KEY,
    functionId TEXT,
    status TEXT,
    response TEXT,
    duration REAL,
    trigger TEXT DEFAULT 'manual',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(functionId) REFERENCES functions(id)
  );
`);

module.exports = db;
