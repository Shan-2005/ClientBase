const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join('D:', 'appwrite-clone', 'data', 'app.db');

// Ensure directory exists
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

module.exports = db;
