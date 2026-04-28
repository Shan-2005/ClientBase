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

// 0a. Authentication
fastify.post('/v1/auth/register', async (request, reply) => {
    const { email, password, name } = request.body;
    try {
        const user = await auth.register(email, password, name, request.projectId);
        return user;
    } catch (err) {
        return reply.status(400).send({ error: err.message });
    }
});

fastify.post('/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body;
    try {
        return await auth.login(email, password, request.projectId);
    } catch (err) {
        return reply.status(401).send({ error: err.message });
    }
});

fastify.get('/v1/auth/me', async (request, reply) => {
    const token = (request.headers.authorization || '').replace('Bearer ', '');
    if (!token) return reply.status(401).send({ error: 'No token provided' });
    try {
        const payload = auth.verifyToken(token);
        const user = db.prepare('SELECT id, email, name, createdAt FROM users WHERE id = ?').get(payload.id);
        if (!user) return reply.status(404).send({ error: 'User not found' });
        return user;
    } catch (err) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
    }
});

fastify.get('/v1/auth/users', async (request) => {
    return db.prepare('SELECT id, email, name, createdAt FROM users WHERE projectId = ?').all(request.projectId);
});

// Sessions
fastify.get('/v1/account/sessions', async (request, reply) => {
    const token = (request.headers.authorization || '').replace('Bearer ', '');
    if (!token) return reply.status(401).send({ error: 'No token' });
    try { const p = auth.verifyToken(token); return db.prepare('SELECT id, createdAt, expiresAt FROM sessions WHERE userId = ?').all(p.id); }
    catch (e) { return reply.status(401).send({ error: 'Invalid token' }); }
});

fastify.delete('/v1/account/sessions', async (request, reply) => {
    const token = (request.headers.authorization || '').replace('Bearer ', '');
    if (!token) return reply.status(401).send({ error: 'No token' });
    try { const p = auth.verifyToken(token); db.prepare('DELETE FROM sessions WHERE userId = ?').run(p.id); return { success: true }; }
    catch (e) { return reply.status(401).send({ error: 'Invalid token' }); }
});

fastify.delete('/v1/account/sessions/:sessionId', async (request) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(request.params.sessionId);
    return { success: true };
});

fastify.patch('/v1/account/name', async (request, reply) => {
    const token = (request.headers.authorization || '').replace('Bearer ', '');
    if (!token) return reply.status(401).send({ error: 'No token' });
    try { const p = auth.verifyToken(token); db.prepare('UPDATE users SET name = ? WHERE id = ?').run(request.body.name, p.id); return { success: true }; }
    catch (e) { return reply.status(401).send({ error: 'Invalid token' }); }
});

// Users API (server-side)
fastify.get('/v1/users', async (request) => {
    return db.prepare('SELECT id, email, name, createdAt FROM users WHERE projectId = ?').all(request.projectId);
});

fastify.get('/v1/users/:userId', async (request, reply) => {
    const u = db.prepare('SELECT id, email, name, createdAt FROM users WHERE id = ?').get(request.params.userId);
    return u || reply.status(404).send({ error: 'User not found' });
});

fastify.patch('/v1/users/:userId', async (request) => {
    const { name, email } = request.body;
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, request.params.userId);
    if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, request.params.userId);
    return db.prepare('SELECT id, email, name, createdAt FROM users WHERE id = ?').get(request.params.userId);
});

fastify.delete('/v1/users/:userId', async (request) => {
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(request.params.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(request.params.userId);
    return { success: true };
});

// Teams
fastify.post('/v1/teams', async (request) => {
    const id = require('crypto').randomUUID();
    db.prepare('INSERT INTO teams (id, projectId, name) VALUES (?, ?, ?)').run(id, request.projectId, request.body.name);
    return { id, name: request.body.name };
});

fastify.get('/v1/teams', async (request) => {
    return db.prepare('SELECT * FROM teams WHERE projectId = ?').all(request.projectId);
});

fastify.get('/v1/teams/:teamId', async (request, reply) => {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(request.params.teamId);
    return t || reply.status(404).send({ error: 'Team not found' });
});

fastify.delete('/v1/teams/:teamId', async (request) => {
    db.prepare('DELETE FROM memberships WHERE teamId = ?').run(request.params.teamId);
    db.prepare('DELETE FROM teams WHERE id = ?').run(request.params.teamId);
    return { success: true };
});

fastify.post('/v1/teams/:teamId/memberships', async (request) => {
    const id = require('crypto').randomUUID();
    const { userId, roles } = request.body;
    db.prepare('INSERT INTO memberships (id, teamId, userId, roles) VALUES (?, ?, ?, ?)').run(id, request.params.teamId, userId, roles || 'member');
    return { id, teamId: request.params.teamId, userId, roles: roles || 'member' };
});

fastify.get('/v1/teams/:teamId/memberships', async (request) => {
    return db.prepare('SELECT m.*, u.email, u.name FROM memberships m LEFT JOIN users u ON m.userId = u.id WHERE m.teamId = ?').all(request.params.teamId);
});

fastify.delete('/v1/teams/:teamId/memberships/:membershipId', async (request) => {
    db.prepare('DELETE FROM memberships WHERE id = ?').run(request.params.membershipId);
    return { success: true };
});

// 0. Health & System
fastify.get('/v1/health', async () => ({ 
    status: 'ok', 
    version: '2.0.0-clientbase', 
    uptime: process.uptime(),
    environment: process.env.AWS_REGION ? 'AWS App Runner' : 'Local Dev'
}));

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
    const id = require('crypto').randomUUID();
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
    const id = require('crypto').randomUUID();
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
    const { limit, offset, orderBy, orderDir } = request.query;
    return await databases.listDocuments(request.params.colId, {
        limit: limit ? parseInt(limit) : 25,
        offset: offset ? parseInt(offset) : 0,
        orderBy: orderBy || '$createdAt',
        orderDir: orderDir || 'ASC'
    });
});

fastify.get('/v1/databases/:dbId/collections/:colId/documents/:docId', async (request, reply) => {
    const doc = await databases.getDocument(request.params.colId, request.params.docId);
    return doc || reply.status(404).send({ error: 'Document not found' });
});

fastify.patch('/v1/databases/:dbId/collections/:colId/documents/:docId', async (request) => {
    return await databases.updateDocument(request.params.colId, request.params.docId, request.body);
});

fastify.delete('/v1/databases/:dbId/collections/:colId/documents/:docId', async (request) => {
    return await databases.deleteDocument(request.params.colId, request.params.docId);
});

fastify.delete('/v1/databases/:dbId/collections/:colId', async (request) => {
    return await databases.deleteCollection(request.params.colId);
});

fastify.delete('/v1/databases/:dbId/collections/:colId/attributes/:key', async (request) => {
    return await databases.deleteAttribute(request.params.colId, request.params.key);
});

// 4. Storage
fastify.post('/v1/storage/buckets', async (request) => {
    return await storage.createBucket(request.projectId, request.body.name);
});

fastify.get('/v1/storage/buckets', async (request) => {
    return db.prepare('SELECT * FROM buckets WHERE projectId = ?').all(request.projectId);
});

fastify.delete('/v1/storage/buckets/:bucketId', async (request) => {
    const files = db.prepare('SELECT id FROM files WHERE bucketId = ?').all(request.params.bucketId);
    for (const f of files) await storage.deleteFile(f.id);
    db.prepare('DELETE FROM websites WHERE bucketId = ?').run(request.params.bucketId);
    db.prepare('DELETE FROM buckets WHERE id = ?').run(request.params.bucketId);
    return { success: true };
});

fastify.get('/v1/storage/buckets/:bucketId/files/:fileId', async (request, reply) => {
    const f = db.prepare('SELECT id, bucketId, name, size, mimeType, createdAt FROM files WHERE id = ? AND bucketId = ?').get(request.params.fileId, request.params.bucketId);
    return f || reply.status(404).send({ error: 'File not found' });
});

fastify.get('/v1/storage/buckets/:bucketId/files/:fileId/download', async (request, reply) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND bucketId = ?').get(request.params.fileId, request.params.bucketId);
    if (!file || !file.data) return reply.status(404).send({ error: 'File not found' });
    reply.header('Content-Type', file.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${file.name}"`);
    reply.header('Content-Length', file.size);
    return reply.send(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
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

// Download / view a file by its ID — serves raw bytes with correct MIME type
fastify.get('/v1/storage/buckets/:bucketId/files/:fileId/view', async (request, reply) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND bucketId = ?').get(
        request.params.fileId,
        request.params.bucketId
    );
    if (!file) return reply.status(404).send({ error: 'File not found' });
    if (!file.data) return reply.status(404).send({ error: 'File data not available' });
    reply.header('Content-Type', file.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${file.name}"`);
    reply.header('Content-Length', file.size);
    return reply.send(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
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

fastify.get('/v1/functions/:fnId', async (request, reply) => {
    const fn = db.prepare('SELECT * FROM functions WHERE id = ?').get(request.params.fnId);
    return fn || reply.status(404).send({ error: 'Function not found' });
});

fastify.patch('/v1/functions/:fnId', async (request) => {
    const { name, code } = request.body;
    if (name) db.prepare('UPDATE functions SET name = ? WHERE id = ?').run(name, request.params.fnId);
    if (code) db.prepare('UPDATE functions SET code = ? WHERE id = ?').run(code, request.params.fnId);
    return db.prepare('SELECT * FROM functions WHERE id = ?').get(request.params.fnId);
});

fastify.delete('/v1/functions/:fnId', async (request) => {
    db.prepare('DELETE FROM execution_logs WHERE functionId = ?').run(request.params.fnId);
    db.prepare('DELETE FROM functions WHERE id = ?').run(request.params.fnId);
    return { success: true };
});

fastify.get('/v1/functions/:fnId/executions', async (request) => {
    return db.prepare('SELECT * FROM execution_logs WHERE functionId = ? ORDER BY createdAt DESC LIMIT 20').all(request.params.fnId);
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
    const id = require('crypto').randomUUID();
    db.prepare('INSERT INTO websites (id, projectId, name, bucketId, domain) VALUES (?, ?, ?, ?, ?)').run(id, request.projectId, name, bucketId, domain || `${name}.local`);
    return { id, name, bucketId, domain: domain || `${name}.local` };
});

fastify.delete('/v1/websites/:siteId', async (request) => {
    db.prepare('DELETE FROM websites WHERE id = ?').run(request.params.siteId);
    return { success: true };
});

// ============ WEBSITE HOSTING ============
// Serve static files from the bucket linked to a deployed website.
// Upload your HTML/CSS/JS to a bucket, deploy as a website, and browse it here.

async function serveWebsiteFile(siteId, filePath, reply) {
    const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(siteId);
    if (!site || !site.enabled) return reply.status(404).type('text/html').send('<h1>404 — Site not found</h1>');

    // Normalise path — default to index.html
    const fileName = (filePath || 'index.html').split('/').filter(Boolean).pop() || 'index.html';

    // Try exact filename match in the bucket
    let file = db.prepare('SELECT * FROM files WHERE bucketId = ? AND name = ?').get(site.bucketId, fileName);

    // Fallback to index.html for SPA / directory requests
    if (!file) {
        file = db.prepare('SELECT * FROM files WHERE bucketId = ? AND name = ?').get(site.bucketId, 'index.html');
    }

    if (!file || !file.data) {
        return reply.status(404).type('text/html').send(
            `<h1>404 — No files found</h1><p>Upload files to bucket <code>${site.bucketId}</code> first.</p>`
        );
    }

    reply.header('Content-Type', file.mimeType || 'text/html');
    return reply.send(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
}

// GET /sites/:siteId  → serves index.html
fastify.get('/sites/:siteId', async (request, reply) => {
    return serveWebsiteFile(request.params.siteId, 'index.html', reply);
});

// GET /sites/:siteId/about.html  → serves about.html
// GET /sites/:siteId/css/style.css → serves style.css (by filename)
fastify.get('/sites/:siteId/*', async (request, reply) => {
    return serveWebsiteFile(request.params.siteId, request.params['*'], reply);
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
