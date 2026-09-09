import 'dotenv/config';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { type ConnectionOptions, Queue } from 'bullmq';
import { getLivePath, getTmpPath, getVodPath, loadWorkersConfig } from '../config/env.ts';
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
import { closeQueues, QUEUE_NAMES, VOD_STANDARD_QUEUE_PREFIX } from './queues/queue.ts';
import { closeWorkersRedis, getRedisInstance, initWorkersRedis, waitForRedisReady } from './redis.ts';
import { registerWorkers } from './worker-definitions.ts';
import { PART_SUFFIX } from './utils/atomic-file.ts';

interface AppContext {
  workerConfig: ReturnType<typeof loadWorkersConfig>;
  configs: Awaited<ReturnType<typeof configService.loadAll>>;
  tenantConfigSubscriber: TenantConfigSubscriber;
}

registerProcessErrorHandlers();

async function clearAllJobsOnStartup(
  workerConfig: ReturnType<typeof loadWorkersConfig>,
  configs: Awaited<ReturnType<typeof configService.loadAll>>
) {
  if (!workerConfig.CLEAR_QUEUES_ON_STARTUP) return;

  getLogger().warn(
    { component: 'queues' },
    'CLEAR_QUEUES_ON_STARTUP=true — all queued jobs will be permanently deleted'
  );

  const queueNames = [
    ...Object.values(QUEUE_NAMES),
    ...configs.map((config) => `${VOD_STANDARD_QUEUE_PREFIX}${config.id}`),
  ];

  for (const name of queueNames) {
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

/**
 * Deletes stray `*.part` files left behind by a copy/conversion that was
 * interrupted by a crash or hard kill (so the in-process unlink never ran).
 * Runs at startup, before any worker is registered, so no in-process writer is
 * active — safe given the single-instance fork deployment. Because a final file
 * is only ever produced via rename, any remaining `.part` is always stale.
 */
async function cleanupOrphanedPartFiles(): Promise<void> {
  const roots: string[] = [];
  const tmpPath = getTmpPath();
  const vodPath = getVodPath();
  const livePath = getLivePath();
  if (tmpPath != null) roots.push(tmpPath);
  if (vodPath != null) roots.push(vodPath);
  if (livePath != null) roots.push(livePath);

  let removed = 0;
  for (const root of roots) {
    removed += await removeOrphanedPartFilesUnderRoot(root);
  }

  if (removed > 0) {
    getLogger().warn({ component: 'queues', removed }, 'Removed orphaned .part files from a prior run');
  }
}

/**
 * Removes `*.part` files two directory levels below `root`
 * (`{root}/{tenantId}/{vodOrStreamId}/`). Never throws.
 */
async function removeOrphanedPartFilesUnderRoot(root: string): Promise<number> {
  let tenants: string[];
  try {
    tenants = await fsPromises.readdir(root);
  } catch {
    return 0; // root does not exist yet
  }

  let removed = 0;
  for (const tenant of tenants) {
    const tenantDir = path.join(root, tenant);
    let subDirs: string[];
    try {
      subDirs = await fsPromises.readdir(tenantDir);
    } catch {
      continue;
    }

    for (const subDir of subDirs) {
      const dir = path.join(tenantDir, subDir);
      let entries: string[];
      try {
        entries = await fsPromises.readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(PART_SUFFIX)) continue;
        try {
          await fsPromises.unlink(path.join(dir, entry));
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }

  return removed;
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

  await cleanupOrphanedPartFiles();
  await clearAllJobsOnStartup(ctx.workerConfig, ctx.configs);

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
