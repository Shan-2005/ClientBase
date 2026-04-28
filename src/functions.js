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

    const start = Date.now();
    try {
        // Wrap user code as an async function body so they can write plain statements:
        // const x = 1; return x;   ← works
        // (req, res) => {}          ← also works (we detect and call it)
        let wrappedCode;
        const trimmed = fn.code.trim();
        if (trimmed.startsWith('function') || trimmed.startsWith('async function') || trimmed.startsWith('(') || trimmed.startsWith('req =>') || trimmed.startsWith('async (')) {
            // User wrote a function expression — call it directly
            wrappedCode = `(${trimmed})(req, res)`;
        } else {
            // User wrote statements — wrap in async function body
            wrappedCode = `(async (req, res) => { ${trimmed} })(req, res)`;
        }
        const raw = vm.runInContext(wrappedCode, context, { timeout: 5000 });
        const result = await Promise.resolve(raw);
        const duration = Date.now() - start;
        const logId = crypto.randomUUID();
        try { db.prepare('INSERT INTO execution_logs (id, functionId, status, response, duration) VALUES (?, ?, ?, ?, ?)').run(logId, functionId, 'completed', JSON.stringify(result), duration); } catch (_) {}
        return { success: true, status: 'completed', result, response: result, duration };
    } catch (err) {
        const duration = Date.now() - start;
        const logId2 = crypto.randomUUID();
        try { db.prepare('INSERT INTO execution_logs (id, functionId, status, response, duration) VALUES (?, ?, ?, ?, ?)').run(logId2, functionId, 'failed', err.message, duration); } catch (_) {}
        return { success: false, status: 'failed', error: err.message, duration };
    }
}

module.exports = { createFunction, executeFunction };
