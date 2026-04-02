import 'dotenv/config';
import { buildServer } from './api/server';
import { closeAllClients } from './db/client';
import { logger } from './utils/logger';
import { closeRedisClient } from './api/plugins/redis.plugin';
import { extractErrorDetails } from './utils/error.js';

const PORT = process.env.PORT || 3030;
const HOST = process.env.HOST || '0.0.0.0';

let server: Awaited<ReturnType<typeof buildServer>> | null = null;

async function start() {
  try {
    logger.info({ port: PORT, host: HOST, env: process.env.NODE_ENV }, 'Starting Archive API server');

    server = await buildServer();

    await server.listen({ port: Number(PORT), host: HOST });

    logger.info({ url: `http://${HOST}:${PORT}` }, 'Server started successfully');
    logger.info({ docs: `http://${HOST}:${PORT}/docs` }, 'Swagger documentation available');
    logger.info({ metrics: `http://${HOST}:${PORT}/metrics` }, 'Prometheus metrics available');
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.fatal({ ...details }, 'Failed to start server');
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown...`);

  // Force exit after 30 seconds if graceful shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    logger.error('Forced shutdown after 30 second timeout');
    process.exit(1);
  }, 30000);

  if (!server) {
    clearTimeout(shutdownTimeout);
    logger.warn('No server instance found, exiting immediately');
    process.exit(0);
  }

  try {
    // Close HTTP server (waits for in-flight requests)
    await server.close();
    logger.info('HTTP server closed');

    // Close Redis client connection
    await closeRedisClient();
    logger.info('Redis connections closed');

    // Close all Prisma DB clients
    await closeAllClients();
    logger.info('Database connections closed');

    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Handle graceful shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the server
start();
