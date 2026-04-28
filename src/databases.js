const db = require('./db');
const crypto = require('crypto');

async function createDatabase(projectId, name) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO databases (id, projectId, name) VALUES (?, ?, ?)').run(id, projectId, name);
    return { id, name };
}

async function createCollection(databaseId, name) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO collections (id, databaseId, name) VALUES (?, ?, ?)').run(id, databaseId, name);
    const tableName = `doc_${id.replace(/-/g, '_')}`;
    db.exec(`
    CREATE TABLE "${tableName}" (
      "$id" TEXT PRIMARY KEY,
      "$createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP,
      "$updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
    return { id, name };
}

async function createAttribute(collectionId, key, type, required) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO attributes (id, collectionId, key, type, required) VALUES (?, ?, ?, ?, ?)').run(id, collectionId, key, type, required ? 1 : 0);
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    let sqliteType = 'TEXT';
    if (type === 'integer') sqliteType = 'INTEGER';
    if (type === 'float') sqliteType = 'REAL';
    if (type === 'boolean') sqliteType = 'INTEGER';
    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${key}" ${sqliteType}`);
    return { id, key, type, required };
}

async function deleteAttribute(collectionId, key) {
    db.prepare('DELETE FROM attributes WHERE collectionId = ? AND key = ?').run(collectionId, key);
    return { success: true };
}

async function createDocument(collectionId, data) {
    const id = data.$id || crypto.randomUUID();
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    const keys = Object.keys(data).filter(k => !k.startsWith('$'));
    const columns = ['$id', ...keys];
    const placeholders = columns.map(() => '?').join(',');
    const values = [id, ...keys.map(k => data[k])];
    db.prepare(`INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`).run(...values);
    return { $id: id, ...data };
}

async function getDocument(collectionId, docId) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) return null;
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    return db.prepare(`SELECT * FROM "${tableName}" WHERE "$id" = ?`).get(docId) || null;
}

async function updateDocument(collectionId, docId, data) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) throw new Error('Collection not found');
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    const keys = Object.keys(data).filter(k => !k.startsWith('$'));
    if (keys.length === 0) return getDocument(collectionId, docId);
    const setClause = keys.map(k => `"${k}" = ?`).join(', ');
    db.prepare(`UPDATE "${tableName}" SET ${setClause}, "$updatedAt" = CURRENT_TIMESTAMP WHERE "$id" = ?`).run(...keys.map(k => data[k]), docId);
    return getDocument(collectionId, docId);
}

async function deleteDocument(collectionId, docId) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) return { success: true };
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    db.prepare(`DELETE FROM "${tableName}" WHERE "$id" = ?`).run(docId);
    return { success: true };
}

async function deleteCollection(collectionId) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (collection) {
        try { db.exec(`DROP TABLE IF EXISTS "doc_${collection.id.replace(/-/g, '_')}"`); } catch (_) {}
    }
    db.prepare('DELETE FROM attributes WHERE collectionId = ?').run(collectionId);
    db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
    return { success: true };
}

async function listDocuments(collectionId, { limit = 25, offset = 0, orderBy = '$createdAt', orderDir = 'ASC' } = {}) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    if (!collection) return [];
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    const dir = orderDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    return db.prepare(`SELECT * FROM "${tableName}" ORDER BY "${orderBy}" ${dir} LIMIT ? OFFSET ?`).all(limit, offset);
}

module.exports = {
    createDatabase, createCollection,
    createAttribute, deleteAttribute,
    createDocument, getDocument, updateDocument, deleteDocument,
    deleteCollection, listDocuments
};
