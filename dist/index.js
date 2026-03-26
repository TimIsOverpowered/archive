"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./api/server");
const client_1 = require("./db/client");
const logger_1 = require("./utils/logger");
const PORT = process.env.PORT || 3030;
const HOST = process.env.HOST || '0.0.0.0';
let server = null;
async function start() {
    try {
        logger_1.logger.info({ port: PORT, host: HOST, env: process.env.NODE_ENV }, 'Starting Archive API server');
        server = await (0, server_1.buildServer)();
        await server.listen({ port: Number(PORT), host: HOST });
        logger_1.logger.info({ url: `http://${HOST}:${PORT}` }, 'Server started successfully');
        logger_1.logger.info({ docs: `http://${HOST}:${PORT}/docs` }, 'Swagger documentation available');
        logger_1.logger.info({ metrics: `http://${HOST}:${PORT}/metrics` }, 'Prometheus metrics available');
    }
    catch (error) {
        logger_1.logger.fatal({ error }, 'Failed to start server');
        process.exit(1);
    }
}
async function shutdown(signal) {
    logger_1.logger.info({ signal }, `Received ${signal}, starting graceful shutdown...`);
    // Force exit after 30 seconds if graceful shutdown hangs
    const shutdownTimeout = setTimeout(() => {
        logger_1.logger.error('Forced shutdown after 30 second timeout');
        process.exit(1);
    }, 30000);
    if (!server) {
        clearTimeout(shutdownTimeout);
        logger_1.logger.warn('No server instance found, exiting immediately');
        process.exit(0);
    }
    try {
        // Close HTTP server (waits for in-flight requests)
        await server.close();
        logger_1.logger.info('HTTP server closed');
        // Close all Prisma DB clients
        await (0, client_1.closeAllClients)();
        logger_1.logger.info('Database connections closed');
        clearTimeout(shutdownTimeout);
        logger_1.logger.info('Graceful shutdown complete');
        process.exit(0);
    }
    catch (error) {
        clearTimeout(shutdownTimeout);
        logger_1.logger.error({ error }, 'Error during shutdown');
        process.exit(1);
    }
}
// Handle graceful shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Start the server
start();
//# sourceMappingURL=index.js.map