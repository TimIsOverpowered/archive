import 'dotenv/config';
import { type ConnectionOptions, Queue } from 'bullmq';
import { loadWorkersConfig } from '../config/env.ts';
import { configService } from '../config/tenant-config.ts';
import type { TenantConfigSubscriber } from '../config/tenant-config-subscriber.ts';
import { registerTenantConfigSubscriberWorker } from '../config/tenant-config-subscriber.ts';
import { Vod } from '../constants.ts';
import { closeMetaClient } from '../db/meta-client.ts';
import { closeAllClients, startClientCleanup, stopClientCleanup } from '../db/streamer-client.ts';
import { registerPlatformStrategies } from '../services/platforms/index.ts';
import { extractErrorDetails } from '../utils/error.ts';
import { closeImpit, initImpit } from '../utils/impit-wrapper.ts';
import { getLogger, setLoggerConfig } from '../utils/logger.ts';
import { registerProcessErrorHandlers } from '../utils/process-handlers.ts';
import { registerShutdownHandlers as registerShutdown } from '../utils/shutdown.ts';
import { waitForWorkersReady, workerRegistry } from './create-worker.ts';
import { startMonitorService, stopMonitorService } from './monitor/index.ts';
import { closeQueues, QUEUE_NAMES } from './queues/queue.ts';
import { closeWorkersRedis, getRedisInstance, initWorkersRedis, waitForRedisReady } from './redis.ts';
import { registerWorkers } from './worker-definitions.ts';

interface AppContext {
  workerConfig: ReturnType<typeof loadWorkersConfig>;
  configs: Awaited<ReturnType<typeof configService.loadAll>>;
  tenantConfigSubscriber: TenantConfigSubscriber;
}

registerProcessErrorHandlers();

async function clearAllJobsOnStartup(workerConfig: ReturnType<typeof loadWorkersConfig>) {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  getLogger().warn(
    { component: 'queues' },
    'CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted'
  );

  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = new Queue(name, {
      connection: getRedisInstance() as unknown as ConnectionOptions,
    });
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
    await initBackgroundServices();
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

  initImpit();
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

async function initBackgroundServices() {
  getLogger().info({ component: 'background' }, 'Initializing background services');

  await startMonitorService();
  getLogger().info({ component: 'monitor' }, 'Monitor service started');
}

function registerShutdownHandlers(ctx: AppContext) {
  registerShutdown([
    [
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
      {
        name: 'impit',
        close: () => {
          void closeImpit();
          return Promise.resolve();
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
    ],
    [
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
      { name: 'workers-redis', close: closeWorkersRedis },
      {
        name: 'config',
        close: () => {
          configService.reset();
          return Promise.resolve();
        },
      },
    ],
  ]);
}

void bootstrap();
