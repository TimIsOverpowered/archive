import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { extractErrorDetails } from '../utils/error.js';
import { loadTenantConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, getQueue, closeQueues, QUEUES_VALUES } from './jobs/queues.js';
import { initWorkersRedis, getRedisInstance, closeWorkersRedis, waitForRedisReady } from './redis.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from './monitor/index.js';
import { getLogger, setLoggerConfig } from '../utils/logger.js';
import { getWorkerDefinitions } from './worker-definitions.js';
import { createWorker, waitForWorkersReady, workers } from './create-worker.js';
import { loadWorkersConfig } from '../config/env.js';
import { VOD_LIVE_HEADROOM, VOD_MIN_CONCURRENCY, SHUTDOWN_TIMEOUT_MS } from '../constants.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from '../db/client.js';
import { registerPlatformStrategies } from '../services/platforms/index.js';
import { closeMetaClient } from '../db/meta-client.js';

process.on('unhandledRejection', (reason) => {
  getLogger().error({ error: extractErrorDetails(reason) }, 'Unhandled promise rejection');
});

async function clearAllJobsOnStartup(workerConfig: ReturnType<typeof loadWorkersConfig>) {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  getLogger().warn('[Queues] CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted');

  for (const name of QUEUES_VALUES) {
    const queue = getQueue(name);
    await queue.pause();
    await queue.obliterate({ force: true });
    await queue.resume();

    getLogger().warn({ queue: name }, 'Queue obliterated and reset');
  }

  getLogger().warn('[Queues] All queues cleared and reset');
}

export async function bootstrap() {
  const workerConfig = loadWorkersConfig();
  setLoggerConfig({ level: workerConfig.LOG_LEVEL, isProduction: workerConfig.NODE_ENV === 'production' });
  await initWorkersRedis();

  getLogger().info({ nodeEnv: workerConfig.NODE_ENV }, 'Starting worker process');

  try {
    registerPlatformStrategies();
    const configs = await loadTenantConfigs();
    await waitForRedisReady();
    startTokenHealthCron();
    await clearAllJobsOnStartup(workerConfig);

    const workerInstances = getWorkerDefinitions().map((def) => {
      if (def.name === QUEUE_NAMES.VOD_LIVE) {
        const liveTenants = configs.filter((c) => c.settings.vodDownload && (c.twitch?.enabled || c.kick?.enabled));
        const liveConcurrency = Math.max(liveTenants.length * 2 * VOD_LIVE_HEADROOM, VOD_MIN_CONCURRENCY);
        def.concurrency = liveConcurrency;
        getLogger().info(
          { liveTenants: liveTenants.length, concurrency: liveConcurrency },
          'vod_live concurrency calculated'
        );
      }
      return createWorker({ ...def, connection: getRedisInstance() });
    });

    await waitForWorkersReady(workerInstances);

    registerShutdownHandlers();

    await startMonitorService();

    startClientCleanup();
    getLogger().info('DB client cleanup started');

    getLogger().info('All workers started successfully');
  } catch (error) {
    getLogger().error(extractErrorDetails(error), 'Failed to start workers');
    process.exit(1);
  }
}

function registerShutdownHandlers() {
  const shutdown = async () => {
    getLogger().info('Shutting down workers...');
    await stopMonitorService();

    for (const [name, worker] of workers.entries()) {
      await worker.close(true);
      getLogger().info({ name }, 'Worker closed');
    }

    await closeQueues();

    stopClientCleanup();
    await closeAllClients();
    await closeMetaClient();
    await closeWorkersRedis();
    clearConfigCache();
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  };

  process.on('SIGTERM', () => {
    shutdown();
  });
  process.on('SIGINT', () => {
    shutdown();
  });
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  bootstrap();
}
