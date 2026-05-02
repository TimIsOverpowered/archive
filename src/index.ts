import 'dotenv/config';
import { loadApiConfig } from './config/env.js';
import { buildServer } from './api/server.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from './db/streamer-client.js';
import { getLogger, setLoggerConfig } from './utils/logger.js';
import { closeRedisClient } from './api/plugins/redis.plugin.js';
import { extractErrorDetails } from './utils/error.js';
import { registerShutdownHandlers } from './utils/shutdown.js';
import { startCloudflareIpRangesCron } from './cron/cloudflare-ip-ranges.js';
import { getCachedRangeInfo, getCloudflareIpRanges } from './utils/cloudflare-ip-validator.js';
import { registerPlatformStrategies } from './services/platforms/index.js';
import { closeMetaClient } from './db/meta-client.js';
import { CacheRefresh } from './constants.js';

process.on('unhandledRejection', (reason) => {
  getLogger().error({ error: extractErrorDetails(reason) }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  getLogger().fatal({ error: extractErrorDetails(err) }, 'Uncaught exception');
  process.exit(1);
});

const config = loadApiConfig();
setLoggerConfig({ level: config.LOG_LEVEL, isProduction: config.NODE_ENV === 'production' });

registerPlatformStrategies();
const PORT = config.PORT;
const HOST = config.HOST;

let server: Awaited<ReturnType<typeof buildServer>> | null = null;

async function start() {
  try {
    getLogger().info({ port: PORT, host: HOST, env: config.NODE_ENV }, 'Starting Archive API server');

    server = await buildServer(config);

    await server.listen({ port: Number(PORT), host: HOST });

    getLogger().info({ url: `http://${HOST}:${PORT}` }, 'Server started successfully');
    getLogger().info({ docs: `http://${HOST}:${PORT}/docs` }, 'Swagger documentation available');

    startClientCleanup();
    getLogger().info('DB client cleanup started');

    // Pre-fetch Cloudflare IP ranges (only if missing or expiring soon)
    try {
      const cacheInfo = await getCachedRangeInfo();
      if (
        !cacheInfo ||
        cacheInfo.status === 'missing' ||
        (cacheInfo.ttlRemaining ?? 0) < CacheRefresh.TTL_REMAINING_THRESHOLD
      ) {
        await getCloudflareIpRanges();
        getLogger().info('Cloudflare IP ranges pre-fetched (cache was missing/expired)');
      } else {
        getLogger().debug({ ttlRemaining: cacheInfo.ttlRemaining }, 'Cloudflare IP ranges cache is fresh');
      }
    } catch (err) {
      const details = extractErrorDetails(err);
      getLogger().warn({ ...details }, 'Failed to check Cloudflare IP ranges cache');
    }

    // Start Cloudflare IP ranges refresh cron
    startCloudflareIpRangesCron();
    getLogger().info('Cloudflare IP ranges refresh cron started');
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().fatal({ ...details }, 'Failed to start server');
    process.exit(1);
  }
}

registerShutdownHandlers([
  {
    name: 'http-server',
    close: async () => {
      if (!server) {
        getLogger().warn('No server instance found, skipping shutdown');
        return;
      }
      await server.close();
    },
  },
  { name: 'redis', close: closeRedisClient },
  {
    name: 'db-client-cleanup',
    close: () => {
      stopClientCleanup();
      return Promise.resolve();
    },
  },
  {
    name: 'database',
    close: async () => {
      await closeAllClients();
      await closeMetaClient();
    },
  },
]);

// Start the server
void start();
