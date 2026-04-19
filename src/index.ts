import 'dotenv/config';
import { loadApiConfig } from './config/env.js';
import { buildServer } from './api/server.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from './db/client.js';
import { logger } from './utils/logger.js';
import { closeRedisClient } from './api/plugins/redis.plugin.js';
import { extractErrorDetails } from './utils/error.js';
import { startCloudflareIpRangesCron } from './cron/cloudflare-ip-ranges.js';
import { getCachedRangeInfo, getCloudflareIpRanges } from './utils/cloudflare-ip-validator.js';
import { releaseBrowser } from './utils/puppeteer-manager.js';
import { registerPlatformStrategies } from './services/platforms/index.js';

const config = loadApiConfig();

registerPlatformStrategies();
const PORT = config.PORT;
const HOST = config.HOST;

let server: Awaited<ReturnType<typeof buildServer>> | null = null;

async function start() {
  try {
    logger.info({ port: PORT, host: HOST, env: process.env.NODE_ENV }, 'Starting Archive API server');

    server = await buildServer();

    await server.listen({ port: Number(PORT), host: HOST });

    logger.info({ url: `http://${HOST}:${PORT}` }, 'Server started successfully');
    logger.info({ docs: `http://${HOST}:${PORT}/docs` }, 'Swagger documentation available');

    startClientCleanup();
    logger.info('DB client cleanup started');

    // Pre-fetch Cloudflare IP ranges (only if missing or expiring soon)
    try {
      const cacheInfo = await getCachedRangeInfo();
      if (!cacheInfo || cacheInfo.status === 'missing' || (cacheInfo.ttlRemaining ?? 0) < 3600) {
        await getCloudflareIpRanges();
        logger.info('Cloudflare IP ranges pre-fetched (cache was missing/expired)');
      } else {
        logger.debug({ ttlRemaining: cacheInfo.ttlRemaining }, 'Cloudflare IP ranges cache is fresh');
      }
    } catch (err) {
      const details = extractErrorDetails(err);
      logger.warn({ ...details }, 'Failed to check Cloudflare IP ranges cache');
    }

    // Start Cloudflare IP ranges refresh cron
    startCloudflareIpRangesCron();
    logger.info('Cloudflare IP ranges refresh cron started');
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.fatal({ ...details }, 'Failed to start server');
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error('Forced shutdown after 5 second timeout');
    process.exit(1);
  }, 5000);

  if (!server) {
    clearTimeout(shutdownTimeout);
    logger.warn('No server instance found, exiting immediately');
    process.exit(0);
  }

  try {
    // Release Puppeteer browser if instantiated (no-op if null)
    await releaseBrowser();
    logger.info('Puppeteer browser released');

    // Close HTTP server (waits for in-flight requests)
    await server.close();
    logger.info('HTTP server closed');

    // Close Redis client connection
    await closeRedisClient();
    logger.info('Redis connections closed');

    // Stop DB client cleanup interval
    stopClientCleanup();
    logger.info('DB client cleanup stopped');

    // Close all Prisma DB clients
    await closeAllClients();
    logger.info('Database connections closed');

    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    const details = extractErrorDetails(error);
    logger.error({ ...details }, 'Error during shutdown');
    process.exit(1);
  }
}

// Handle graceful shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the server
start();
