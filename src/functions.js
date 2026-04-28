const vm = require('vm'); // Built-in Node.js module — no install needed
const db = require('./db');
const crypto = require('crypto');

async function createFunction(projectId, name, code, runtime = 'nodejs-18') {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO functions (id, projectId, name, runtime, code) VALUES (?, ?, ?, ?, ?)').run(id, projectId, name, runtime, code);
    return { id, name, runtime };
}

async function executeFunction(functionId, payload = {}) {
    const fn = db.prepare('SELECT * FROM functions WHERE id = ?').get(functionId);
    if (!fn) throw new Error('Function not found');

    const sandbox = {
        req: payload,
        res: {
            json: (data) => data,
            send: (data) => data
        },
        console: {
            log: (...args) => console.log('[fn]', ...args),
            error: (...args) => console.error('[fn]', ...args),
        },
        result: undefined
    };

    const context = vm.createContext(sandbox);

    try {
        const raw = vm.runInContext(`(${fn.code})(req, res)`, context, { timeout: 5000 });
        const result = await Promise.resolve(raw);
        return { success: true, result };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = { createFunction, executeFunction };
