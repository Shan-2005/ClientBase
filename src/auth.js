const jwt = require('jsonwebtoken');
const db = require('./db');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'appwrite-lite-secret-123';

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

async function register(email, password, name, projectId = 'default') {
    const id = crypto.randomUUID();
    const hashed = hashPassword(password);

    try {
        db.prepare(`
      INSERT INTO users (id, projectId, email, password, name)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, projectId, email, hashed, name);

        return { id, email, name, projectId };
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            throw new Error('User already exists');
        }
        throw err;
    }
}

async function login(email, password, projectId = 'default') {
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND projectId = ?').get(email, projectId);
    if (!user) throw new Error('Invalid credentials');

    const hashed = hashPassword(password);
    if (user.password !== hashed) throw new Error('Invalid credentials');

    const token = jwt.sign({ id: user.id, email: user.email, projectId: user.projectId }, SECRET, { expiresIn: '24h' });
    return { token, user: { id: user.id, email: user.email, name: user.name } };
}

function verifyToken(token) {
    return jwt.verify(token, SECRET);
}

module.exports = { register, login, verifyToken };
