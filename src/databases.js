const db = require('./db');
const { v4: uuidv4 } = require('uuid');

async function createDatabase(projectId, name) {
    const id = uuidv4();
    db.prepare('INSERT INTO databases (id, projectId, name) VALUES (?, ?, ?)').run(id, projectId, name);
    return { id, name };
}

async function createCollection(databaseId, name) {
    const id = uuidv4();
    db.prepare('INSERT INTO collections (id, databaseId, name) VALUES (?, ?, ?)').run(id, databaseId, name);

    // Create the physical table for this collection
    // Table name format: doc_[collectionId] to avoid collisions
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
    const id = uuidv4();
    db.prepare('INSERT INTO attributes (id, collectionId, key, type, required) VALUES (?, ?, ?, ?, ?)').run(id, collectionId, key, type, required ? 1 : 0);

    // Alter Table to add column
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;

    let sqliteType = 'TEXT';
    if (type === 'integer') sqliteType = 'INTEGER';
    if (type === 'float') sqliteType = 'REAL';
    if (type === 'boolean') sqliteType = 'INTEGER';

    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${key}" ${sqliteType}`);

    return { id, key, type, required };
}

async function createDocument(collectionId, data) {
    const id = data.$id || uuidv4();
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;

    const keys = Object.keys(data).filter(k => !k.startsWith('$'));
    const columns = ['$id', ...keys];
    const placeholders = columns.map(() => '?').join(',');
    const values = [id, ...keys.map(k => data[k])];

    const sql = `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`;
    db.prepare(sql).run(...values);

    return { $id: id, ...data };
}

async function listDocuments(collectionId) {
    const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId);
    const tableName = `doc_${collection.id.replace(/-/g, '_')}`;
    return db.prepare(`SELECT * FROM "${tableName}"`).all();
}

module.exports = {
    createDatabase,
    createCollection,
    createAttribute,
    createDocument,
    listDocuments
};
