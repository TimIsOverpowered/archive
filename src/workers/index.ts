import 'dotenv/config';
import { extractErrorDetails } from '../utils/error.js';
import { loadTenantConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, getQueue, closeQueues } from './jobs/queues.js';
import { initWorkersRedis, getRedisInstance, closeWorkersRedis, waitForRedisReady } from './redis.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from './monitor/index.js';
import { logger } from '../utils/logger.js';
import { WORKER_DEFINITIONS } from './worker-definitions.js';
import { createWorker, waitForWorkersReady, workers } from './create-worker.js';
import { loadWorkersConfig } from '../config/env.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from '../db/client.js';
import { registerPlatformStrategies } from '../services/platforms/index.js';

const workerConfig = loadWorkersConfig();
await initWorkersRedis();

async function clearAllJobsOnStartup() {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  logger.warn('[Queues] CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted');

  const queueNames = [
    QUEUE_NAMES.VOD_LIVE,
    QUEUE_NAMES.VOD_STANDARD,
    QUEUE_NAMES.CHAT_DOWNLOAD,
    QUEUE_NAMES.YOUTUBE_UPLOAD,
    QUEUE_NAMES.DMCA_PROCESSING,
    QUEUE_NAMES.MONITOR,
  ];

  for (const name of queueNames) {
    const queue = getQueue(name);
    await queue.pause();
    await queue.obliterate({ force: true });
    await queue.resume();

    logger.info(`[Queues] Fully obliterated and reset queue: ${name}`);
  }

  logger.warn('[Queues] All queues cleared and reset');
}

async function bootstrap() {
  logger.info(`Starting worker process (NODE_ENV: ${workerConfig.NODE_ENV})`);

  try {
    registerPlatformStrategies();
    await loadTenantConfigs();
    await waitForRedisReady();
    startTokenHealthCron();
    await clearAllJobsOnStartup();

    const workerInstances = WORKER_DEFINITIONS.map((def) => createWorker({ ...def, connection: getRedisInstance() }));

    await waitForWorkersReady(workerInstances);

    registerShutdownHandlers();

    await startMonitorService();

    startClientCleanup();
    logger.info('DB client cleanup started');

    logger.info('All workers started successfully');
  } catch (error) {
    logger.error(extractErrorDetails(error), 'Failed to start workers');
    process.exit(1);
  }
}

function registerShutdownHandlers() {
  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await stopMonitorService();

    for (const [name, worker] of workers.entries()) {
      await worker.close(true);
      logger.info({ name }, 'Worker closed');
    }

    await closeQueues();

    await stopClientCleanup();
    await closeAllClients();
    await closeWorkersRedis();
    clearConfigCache();
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap();
