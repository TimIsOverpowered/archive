import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { extractErrorDetails } from '../utils/error.js';
import { configService } from '../config/tenant-config.js';
import { registerTenantConfigSubscriberWorker } from '../config/tenant-config-subscriber.js';
import { QUEUE_NAMES, closeQueues } from './queues/queue.js';
import { Queue } from 'bullmq';
import { getRedisInstance, initWorkersRedis, closeWorkersRedis, waitForRedisReady } from './redis.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from './monitor/index.js';
import { getLogger, setLoggerConfig } from '../utils/logger.js';
import { registerWorkers } from './worker-definitions.js';
import { waitForWorkersReady, workerRegistry } from './create-worker.js';
import { loadWorkersConfig } from '../config/env.js';
import { VOD_LIVE_HEADROOM, VOD_MIN_CONCURRENCY, SHUTDOWN_TIMEOUT_MS } from '../constants.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from '../db/streamer-client.js';
import { registerPlatformStrategies } from '../services/platforms/index.js';
import { closeMetaClient } from '../db/meta-client.js';
import { initCycleTLS, closeCycleTLS } from '../utils/cycletls.js';

process.on('unhandledRejection', (reason) => {
  getLogger().error({ error: extractErrorDetails(reason) }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  getLogger().fatal({ error: extractErrorDetails(err) }, 'Uncaught exception');
  process.exit(1);
});

async function clearAllJobsOnStartup(workerConfig: ReturnType<typeof loadWorkersConfig>) {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  getLogger().warn(
    { component: 'queues' },
    'CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted'
  );

  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = new Queue(name, { connection: getRedisInstance() });
    await queue.pause();
    await queue.obliterate({ force: true });
    await queue.resume();

    getLogger().warn({ queue: name }, 'Queue obliterated and reset');
  }

  getLogger().warn({ component: 'queues' }, 'All queues cleared and reset');
}

export async function bootstrap() {
  const workerConfig = loadWorkersConfig();
  setLoggerConfig({ level: workerConfig.LOG_LEVEL, isProduction: workerConfig.NODE_ENV === 'production' });
  await initWorkersRedis();

  getLogger().info({ nodeEnv: workerConfig.NODE_ENV }, 'Starting worker process');

  try {
    registerPlatformStrategies();
    const configs = await configService.loadAll();
    await waitForRedisReady();

    const tenantConfigSubscriber = registerTenantConfigSubscriberWorker();
    getLogger().info('Tenant config subscriber registered');

    startTokenHealthCron();
    await clearAllJobsOnStartup(workerConfig);

    registerWorkers(getRedisInstance(), configs, VOD_LIVE_HEADROOM, VOD_MIN_CONCURRENCY);

    await waitForWorkersReady(workerRegistry.getAll().map((entry) => entry.worker));

    registerShutdownHandlers(tenantConfigSubscriber);

    await startMonitorService();

    startClientCleanup();
    getLogger().info('DB client cleanup started');

    await initCycleTLS();

    getLogger().info('All workers started successfully');
  } catch (error) {
    getLogger().error(extractErrorDetails(error), 'Failed to start workers');
    process.exit(1);
  }
}

function registerShutdownHandlers(tenantConfigSubscriber: ReturnType<typeof registerTenantConfigSubscriberWorker>) {
  const shutdown = async () => {
    getLogger().info('Shutting down workers...');

    const forceExitTimer = setTimeout(() => {
      getLogger().error('Forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      stopMonitorService();

      for (const { name, worker } of workerRegistry.getAll()) {
        await worker.close(true);
        getLogger().info({ name }, 'Worker closed');
      }

      await closeQueues();

      await closeCycleTLS();

      stopClientCleanup();
      await closeAllClients();
      await closeMetaClient();

      try {
        await tenantConfigSubscriber.quit();
      } catch {
        /* subscriber already closed */
      }

      await closeWorkersRedis();
      configService.reset();

      clearTimeout(forceExitTimer);
      getLogger().info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      const details = extractErrorDetails(error);
      getLogger().error({ ...details }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

const scriptPath = process.argv[1];
if (scriptPath != null && import.meta.url === pathToFileURL(scriptPath).href) {
  void bootstrap();
}
