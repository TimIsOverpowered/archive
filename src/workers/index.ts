import 'dotenv/config';
import { Queue } from 'bullmq';
import { loadWorkersConfig } from '../config/env.js';
import { registerTenantConfigSubscriberWorker } from '../config/tenant-config-subscriber.js';
import { configService } from '../config/tenant-config.js';
import { Vod } from '../constants.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { closeMetaClient } from '../db/meta-client.js';
import { closeAllClients, startClientCleanup, stopClientCleanup } from '../db/streamer-client.js';
import { registerPlatformStrategies } from '../services/platforms/index.js';
import { initCycleTLS, closeCycleTLS } from '../utils/cycletls.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger, setLoggerConfig } from '../utils/logger.js';
import { registerProcessErrorHandlers } from '../utils/process-handlers.js';
import { registerShutdownHandlers as registerShutdown } from '../utils/shutdown.js';
import { waitForWorkersReady, workerRegistry } from './create-worker.js';
import { startMonitorService, stopMonitorService } from './monitor/index.js';
import { QUEUE_NAMES, closeQueues } from './queues/queue.js';
import { getRedisInstance, initWorkersRedis, closeWorkersRedis, waitForRedisReady } from './redis.js';
import { registerWorkers } from './worker-definitions.js';

interface AppContext {
  workerConfig: ReturnType<typeof loadWorkersConfig>;
  configs: Awaited<ReturnType<typeof configService.loadAll>>;
  tenantConfigSubscriber: ReturnType<typeof registerTenantConfigSubscriberWorker>;
}

registerProcessErrorHandlers();

async function clearAllJobsOnStartup(workerConfig: ReturnType<typeof loadWorkersConfig>) {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  getLogger().warn(
    { component: 'queues' },
    'CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted'
  );

  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = new Queue(name, { connection: getRedisInstance() });
    try {
      await queue.pause();
      await queue.obliterate({ force: true });
      await queue.resume();
    } finally {
      await queue.close();
    }
  }

  getLogger().warn({ component: 'queues' }, 'All queues cleared and reset');
}

export async function bootstrap() {
  const workerConfig = loadWorkersConfig();
  setLoggerConfig({ level: workerConfig.LOG_LEVEL, isProduction: workerConfig.NODE_ENV === 'production' });
  getLogger().info({ nodeEnv: workerConfig.NODE_ENV }, 'Starting worker process');

  try {
    await initInfrastructure();
    const { configs, tenantConfigSubscriber } = await initApplicationState();

    const ctx: AppContext = {
      workerConfig,
      configs,
      tenantConfigSubscriber,
    };

    await initWorkers(ctx);
    await initBackgroundServices(ctx);
    registerShutdownHandlers(ctx);

    getLogger().info('All workers started successfully');
  } catch (error) {
    getLogger().error(extractErrorDetails(error), 'Failed to start workers');
    process.exit(1);
  }
}

async function initInfrastructure() {
  getLogger().info({ component: 'infrastructure' }, 'Initializing infrastructure');

  await initWorkersRedis();
  await waitForRedisReady();
  getLogger().info({ component: 'redis' }, 'Redis connected');

  startClientCleanup();
  getLogger().info({ component: 'db' }, 'DB client cleanup started');

  await initCycleTLS();
}

async function initApplicationState() {
  getLogger().info({ component: 'application' }, 'Initializing application state');

  registerPlatformStrategies();

  const configs = await configService.loadAll();
  const tenantConfigSubscriber = registerTenantConfigSubscriberWorker();
  getLogger().info({ component: 'tenant-config' }, 'Tenant config subscriber registered');

  return { configs, tenantConfigSubscriber };
}

async function initWorkers(ctx: AppContext) {
  getLogger().info({ component: 'workers' }, 'Initializing workers');

  await clearAllJobsOnStartup(ctx.workerConfig);

  registerWorkers(getRedisInstance(), ctx.configs, Vod.LIVE_HEADROOM, Vod.LIVE_MIN_CONCURRENCY);

  await waitForWorkersReady(workerRegistry.getAll().map((entry) => entry.worker));
  getLogger().info({ component: 'workers' }, 'All workers ready');
}

async function initBackgroundServices(_ctx: AppContext) {
  getLogger().info({ component: 'background' }, 'Initializing background services');

  startTokenHealthCron();
  getLogger().info({ component: 'cron' }, 'Token health cron started');

  await startMonitorService();
  getLogger().info({ component: 'monitor' }, 'Monitor service started');
}

function registerShutdownHandlers(ctx: AppContext) {
  registerShutdown([
    {
      name: 'monitor',
      close: () => {
        stopMonitorService();
        return Promise.resolve();
      },
    },
    {
      name: 'workers',
      close: async () => {
        for (const { worker } of workerRegistry.getAll()) {
          await worker.close(true);
        }
      },
    },
    { name: 'queues', close: closeQueues },
    { name: 'cycletls', close: closeCycleTLS },
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
    {
      name: 'tenant-subscriber',
      close: async () => {
        try {
          await ctx.tenantConfigSubscriber.quit();
        } catch {
          /* subscriber already closed */
        }
      },
    },
    { name: 'workers-redis', close: closeWorkersRedis },
    {
      name: 'config',
      close: () => {
        configService.reset();
        return Promise.resolve();
      },
    },
  ]);
}

void bootstrap();
