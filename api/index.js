module.exports = async (req, res) => {
    try {
        const fastify = require('../server');
        await fastify.ready();
        fastify.server.emit('request', req, res);
    } catch (err) {
        res.status(500).json({
            error: err.message,
            stack: err.stack,
            env: process.env.NODE_ENV,
            cwd: process.cwd(),
            dataDir: process.env.DATA_DIR
        });
    }
};
