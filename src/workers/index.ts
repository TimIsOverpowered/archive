import 'dotenv/config';
import { extractErrorDetails } from '../utils/error.js';
import { Worker, Queue, BaseJobOptions } from 'bullmq';
import { loadTenantConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, getQueue } from './jobs/queues.js';
import { redisInstance, closeWorkersRedis, waitForRedisReady } from './redis.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from './monitor/index.js';
import { logger as baseLogger } from '../utils/logger.js';
import { AllJobData, WORKER_DEFINITIONS, WorkerName } from './worker-definitions.js';
import { createWorker } from './createWorker.js';

const logger = baseLogger;

interface LastFailedJob {
  jobId: string;
  errorMessage: string;
  attemptsMade: number;
  maxAttempts: number;
  vodId?: number;
  failedAt?: Date;
}

export interface WorkerHealthStatus {
  isRunning: boolean | null;
  queueCounts: Record<string, number>;
  lastFailedJob: LastFailedJob | null;
  status: 'healthy' | 'warning' | 'error';
}

const workers = new Map<WorkerName, Worker<Record<string, unknown>, unknown>>();

export function registerWorker(name: WorkerName, worker: Worker<Record<string, unknown>, unknown>) {
  workers.set(name, worker);
}

async function clearAllJobsOnStartup() {
  const queues = [getQueue(QUEUE_NAMES.VOD_LIVE), getQueue(QUEUE_NAMES.VOD_STANDARD), getQueue(QUEUE_NAMES.CHAT_DOWNLOAD), getQueue(QUEUE_NAMES.YOUTUBE_UPLOAD), getQueue(QUEUE_NAMES.DMCA_PROCESSING)];

  await Promise.allSettled(queues.map((queue) => queue.obliterate({ force: true })));

  logger.info(`[Queues] Cleared all queues`);
}

async function getLastFailedJob(queue: Queue): Promise<LastFailedJob | null> {
  try {
    const failedJobs = await queue.getFailed(0, 1);

    if (!failedJobs || failedJobs.length === 0) {
      return null;
    }

    const job = failedJobs[0];

    if (!job) {
      return null;
    }

    const rawData = (await job.data) as AllJobData;
    const finishedAtTimestamp = typeof job.finishedOn === 'number' ? new Date(job.finishedOn) : undefined;

    return {
      jobId: String(job.id),
      errorMessage: (job.failedReason || 'Unknown error').substring(0, 500),
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: ((job.opts as Partial<BaseJobOptions>).attempts ?? 3) as number,
      vodId: 'vodId' in rawData ? Number(rawData.vodId) : undefined,
      failedAt: finishedAtTimestamp ?? new Date(),
    };
  } catch {
    return null;
  }
}

export async function getWorkersHealth(): Promise<Record<string, WorkerHealthStatus>> {
  const result: Record<string, WorkerHealthStatus> = {};

  if (!redisInstance) {
    for (const [name] of workers) {
      result[name as string] = {
        isRunning: null,
        queueCounts: {},
        lastFailedJob: null,
        status: 'healthy',
      };
    }

    return result;
  }

  for (const name of workers.keys()) {
    const queue = getQueue(name);
    try {
      if (!workers.get(name)) continue;

      const counts = await queue.getJobCounts();
      const lastFailed = await getLastFailedJob(queue);

      const workerInstance = workers.get(name);
      const isRunningVal = typeof workerInstance?.isRunning === 'function' ? workerInstance.isRunning() : !!(workerInstance?.isRunning ?? false);

      let status: 'healthy' | 'warning' | 'error' = 'healthy';

      if (lastFailed?.attemptsMade !== undefined && lastFailed.maxAttempts > 0 && lastFailed.attemptsMade >= lastFailed.maxAttempts) {
        status = 'error';
      } else if ((counts.failed ?? 0) > 0 || (counts.paused ?? 0) > 0) {
        status = 'warning';
      }

      result[name] = {
        isRunning: isRunningVal,
        queueCounts: counts,
        lastFailedJob: await getLastFailedJob(queue),
        status,
      };
    } catch (error) {
      const details = extractErrorDetails(error);
      const errorMessage = details.message;
      logger.error({ workerName: name, error: errorMessage }, `Health check failed for ${name} queue`);

      result[name] = {
        isRunning: null,
        queueCounts: {},
        lastFailedJob: null,
        status: 'error',
      };
    }
  }

  return result;
}

async function waitForWorkersReady(workers: Worker[]): Promise<void> {
  const readyPromises = workers.map((worker) => {
    if (worker.isRunning()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      worker.once('ready', () => resolve());
    });
  });

  await Promise.all(readyPromises);
}

async function bootstrap() {
  logger.info(`Starting worker process (NODE_ENV: ${process.env.NODE_ENV})`);

  try {
    await loadTenantConfigs();
    await waitForRedisReady;
    startTokenHealthCron();
    await clearAllJobsOnStartup();

    const workers = WORKER_DEFINITIONS.map((def) => createWorker({ ...def, connection: redisInstance }));

    await waitForWorkersReady(workers);

    registerShutdownHandlers(workers);

    await startMonitorService();

    logger.info('All workers started successfully');
  } catch (error) {
    logger.error(extractErrorDetails(error), 'Failed to start workers');
    process.exit(1);
  }
}

function registerShutdownHandlers(workers: Worker[]) {
  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await stopMonitorService();
    await Promise.all(workers.map((w) => w.close(true)));
    const { closeAllClients } = await import('../db/client.js');
    await closeAllClients();
    await closeWorkersRedis();
    clearConfigCache();
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap();
