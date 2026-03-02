const { VM } = require('vm2');
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

    const vm = new VM({
        timeout: 5000, // 5 seconds timeout
        sandbox: {
            req: payload,
            res: {
                json: (data) => data,
                send: (data) => data
            },
            console: console // For debugging, can be restricted later
        }
    });

    try {
        const result = await vm.run(`(${fn.code})(req, res)`);
        return { success: true, result };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = { createFunction, executeFunction };
