const db = require('./db');
const crypto = require('crypto');

async function getUsedStorage() {
    const result = db.prepare('SELECT SUM(size) as total FROM files').get();
    return result.total || 0;
}

async function getStorageLimit() {
    const result = db.prepare('SELECT value FROM settings WHERE key = ?').get('storage_limit_bytes');
    return parseInt(result.value);
}

async function saveFile(payload) {
    const { bucketId, name, mimeType, buffer } = payload;
    const size = buffer.length;

    const used = await getUsedStorage();
    const limit = await getStorageLimit();

    if (used + size > limit) {
        throw new Error('Storage limit reached (5GB cap)');
    }

    const bucket = db.prepare('SELECT * FROM buckets WHERE id = ?').get(bucketId);
    if (!bucket) throw new Error('Bucket not found');

    const fileId = crypto.randomUUID();

    // Store file bytes as BLOB in SQLite — no filesystem dependency
    db.prepare(`
        INSERT INTO files (id, bucketId, name, data, size, mimeType)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(fileId, bucketId, name, buffer, size, mimeType);

    return { id: fileId, name, size, mimeType, bucketId };
}

async function createBucket(projectId, name, fileSizeLimit = null) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO buckets (id, projectId, name, fileSizeLimit) VALUES (?, ?, ?, ?)').run(id, projectId, name, fileSizeLimit);
    return { id, name };
}

async function deleteFile(fileId) {
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

module.exports = { saveFile, deleteFile, getUsedStorage, getStorageLimit, createBucket };
