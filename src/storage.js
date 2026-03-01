const fs = require('fs');
const path = require('path');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const storageDir = path.join('D:', 'appwrite-clone', 'storage');

// Ensure storage directory exists
if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

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
        throw new Error('Local SSD Storage Limit Reached (5GB cap)');
    }

    const bucket = db.prepare('SELECT * FROM buckets WHERE id = ?').get(bucketId);
    if (!bucket) throw new Error('Bucket not found');

    const fileId = uuidv4();
    const filePath = path.join(storageDir, fileId);

    fs.writeFileSync(filePath, buffer);

    db.prepare(`
        INSERT INTO files (id, bucketId, name, path, size, mimeType)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(fileId, bucketId, name, filePath, size, mimeType);

    return { id: fileId, name, size, mimeType, bucketId };
}

async function createBucket(projectId, name, fileSizeLimit = null) {
    const id = uuidv4();
    db.prepare('INSERT INTO buckets (id, projectId, name, fileSizeLimit) VALUES (?, ?, ?, ?)').run(id, projectId, name, fileSizeLimit);
    return { id, name };
}

async function deleteFile(fileId) {
    const file = db.prepare('SELECT path FROM files WHERE id = ?').get(fileId);
    if (file) {
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    }
}

module.exports = { saveFile, deleteFile, getUsedStorage, getStorageLimit, createBucket };
