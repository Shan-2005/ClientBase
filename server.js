require('dotenv').config();
const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs');

// Plugins
fastify.register(require('@fastify/cors'), { origin: '*' });
fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: 100 * 1024 * 1024 }
});
fastify.register(require('@fastify/static'), {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
});

// Internal Modules
const db = require('./src/db');
const auth = require('./src/auth');
const storage = require('./src/storage');
const databases = require('./src/databases');
const functions = require('./src/functions');

// --- Analytics Tracking Tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    secret TEXT UNIQUE,
    scopes TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    path TEXT,
    statusCode INTEGER,
    responseTime REAL,
    bytes INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS websites (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    name TEXT,
    bucketId TEXT,
    domain TEXT,
    enabled INTEGER DEFAULT 1,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(projectId) REFERENCES projects(id),
    FOREIGN KEY(bucketId) REFERENCES buckets(id)
  );
`);

// --- Analytics Middleware ---
fastify.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/v1')) {
        try {
            db.prepare('INSERT INTO request_logs (method, path, statusCode, responseTime) VALUES (?, ?, ?, ?)').run(
                request.method,
                request.url,
                reply.statusCode,
                reply.elapsedTime || 0
            );
        } catch (e) { /* silently ignore logging errors */ }
    }
});

// --- Middleware: API Key Verification ---
fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1')) {
        const apiKey = request.headers['x-appwrite-key'];
        if (apiKey) {
            const project = db.prepare('SELECT * FROM projects WHERE apiKey = ?').get(apiKey);
            if (project) { request.projectId = project.id; return; }
            const key = db.prepare('SELECT * FROM api_keys WHERE secret = ?').get(apiKey);
            if (key) { request.projectId = key.projectId; return; }
            return reply.status(401).send({ error: 'Invalid API Key' });
        } else {
            request.projectId = 'default';
        }
    }
});

// ============ API ROUTES ============

// 0. Health & System
fastify.get('/v1/health', async () => ({ status: 'ok', version: '2.0.0-clientbase', uptime: process.uptime() }));

fastify.get('/v1/storage/usage', async () => {
    const used = await storage.getUsedStorage();
    const limit = await storage.getStorageLimit();
    return { used, limit, percent: (used / limit) * 100 };
});

// 1. Projects
fastify.get('/v1/projects', async () => {
    return db.prepare('SELECT * FROM projects').all();
});

fastify.post('/v1/projects', async (request) => {
    const { name } = request.body;
    const id = require('uuid').v4();
    const apiKey = `secret-${id}`;
    db.prepare('INSERT INTO projects (id, name, apiKey) VALUES (?, ?, ?)').run(id, name, apiKey);
    return { id, name, apiKey };
});

// 2. API Keys
fastify.get('/v1/keys', async (request) => {
    return db.prepare('SELECT * FROM api_keys WHERE projectId = ?').all(request.projectId);
});

fastify.post('/v1/keys', async (request) => {
    const { name, scopes } = request.body;
    const id = require('uuid').v4();
    const secret = `key-${id}`;
    db.prepare('INSERT INTO api_keys (id, projectId, name, secret, scopes) VALUES (?, ?, ?, ?, ?)').run(id, request.projectId, name, secret, scopes || 'all');
    return { id, name, secret, scopes: scopes || 'all' };
});

fastify.delete('/v1/keys/:keyId', async (request) => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(request.params.keyId);
    return { success: true };
});

// 3. Databases & Collections
fastify.post('/v1/databases', async (request) => {
    return await databases.createDatabase(request.projectId, request.body.name);
});

fastify.get('/v1/databases', async (request) => {
    return db.prepare('SELECT * FROM databases WHERE projectId = ?').all(request.projectId);
});

fastify.delete('/v1/databases/:dbId', async (request) => {
    db.prepare('DELETE FROM databases WHERE id = ?').run(request.params.dbId);
    return { success: true };
});

fastify.post('/v1/databases/:dbId/collections', async (request) => {
    return await databases.createCollection(request.params.dbId, request.body.name);
});

fastify.get('/v1/databases/:dbId/collections', async (request) => {
    return db.prepare('SELECT * FROM collections WHERE databaseId = ?').all(request.params.dbId);
});

fastify.post('/v1/databases/:dbId/collections/:colId/attributes/string', async (request) => {
    const { key, type, required } = request.body;
    return await databases.createAttribute(request.params.colId, key, type || 'string', required);
});

fastify.get('/v1/databases/:dbId/collections/:colId/attributes', async (request) => {
    return db.prepare('SELECT * FROM attributes WHERE collectionId = ?').all(request.params.colId);
});

fastify.post('/v1/databases/:dbId/collections/:colId/documents', async (request) => {
    return await databases.createDocument(request.params.colId, request.body);
});

fastify.get('/v1/databases/:dbId/collections/:colId/documents', async (request) => {
    return await databases.listDocuments(request.params.colId);
});

// 4. Storage
fastify.post('/v1/storage/buckets', async (request) => {
    return await storage.createBucket(request.projectId, request.body.name);
});

fastify.get('/v1/storage/buckets', async (request) => {
    return db.prepare('SELECT * FROM buckets WHERE projectId = ?').all(request.projectId);
});

fastify.get('/v1/storage/buckets/:bucketId/files', async (request) => {
    return db.prepare('SELECT * FROM files WHERE bucketId = ?').all(request.params.bucketId);
});

fastify.post('/v1/storage/buckets/:bucketId/files', async (request, reply) => {
    const data = await request.file();
    const buffer = await data.toBuffer();
    try {
        const file = await storage.saveFile({
            bucketId: request.params.bucketId,
            name: data.filename,
            mimeType: data.mimetype,
            buffer
        });
        return file;
    } catch (err) {
        reply.status(400).send({ error: err.message });
    }
});

fastify.delete('/v1/storage/buckets/:bucketId/files/:fileId', async (request) => {
    await storage.deleteFile(request.params.fileId);
    return { success: true };
});

// 5. Functions
fastify.post('/v1/functions', async (request) => {
    const { name, code } = request.body;
    return await functions.createFunction(request.projectId, name, code);
});

fastify.get('/v1/functions', async (request) => {
    return db.prepare('SELECT * FROM functions WHERE projectId = ?').all(request.projectId);
});

fastify.post('/v1/functions/:fnId/executions', async (request) => {
    return await functions.executeFunction(request.params.fnId, request.body);
});

fastify.delete('/v1/functions/:fnId', async (request) => {
    db.prepare('DELETE FROM functions WHERE id = ?').run(request.params.fnId);
    return { success: true };
});

// 6. Analytics
fastify.get('/v1/analytics/overview', async () => {
    const totalRequests = db.prepare('SELECT COUNT(*) as c FROM request_logs').get().c;
    const today = db.prepare("SELECT COUNT(*) as c FROM request_logs WHERE timestamp >= datetime('now', '-1 day')").get().c;
    const avgLatency = db.prepare('SELECT AVG(responseTime) as avg FROM request_logs').get().avg || 0;
    const errorRate = db.prepare("SELECT COUNT(*) as c FROM request_logs WHERE statusCode >= 400").get().c;
    const topEndpoints = db.prepare('SELECT path, COUNT(*) as hits FROM request_logs GROUP BY path ORDER BY hits DESC LIMIT 10').all();
    const hourlyTraffic = db.prepare("SELECT strftime('%H', timestamp) as hour, COUNT(*) as hits FROM request_logs WHERE timestamp >= datetime('now', '-1 day') GROUP BY hour ORDER BY hour").all();
    return { totalRequests, today, avgLatency: avgLatency.toFixed(2), errorRate, topEndpoints, hourlyTraffic };
});

fastify.get('/v1/analytics/logs', async () => {
    return db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT 100').all();
});

// 7. Websites
fastify.get('/v1/websites', async (request) => {
    return db.prepare('SELECT * FROM websites WHERE projectId = ?').all(request.projectId);
});

fastify.post('/v1/websites', async (request) => {
    const { name, bucketId, domain } = request.body;
    const id = require('uuid').v4();
    db.prepare('INSERT INTO websites (id, projectId, name, bucketId, domain) VALUES (?, ?, ?, ?, ?)').run(id, request.projectId, name, bucketId, domain || `${name}.local`);
    return { id, name, bucketId, domain: domain || `${name}.local` };
});

fastify.delete('/v1/websites/:siteId', async (request) => {
    db.prepare('DELETE FROM websites WHERE id = ?').run(request.params.siteId);
    return { success: true };
});

// Only start the server if this file is run directly (not as a module)
if (require.main === module) {
    const start = async () => {
        try {
            const port = process.env.PORT || 3000;
            await fastify.listen({ port, host: '0.0.0.0' });
            console.log(`ClientBase v2.0 running at http://localhost:${port}`);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    };
    start();
}

module.exports = fastify;
