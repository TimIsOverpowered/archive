import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadStreamerConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, closeQueues } from '../jobs/queues.js';
import vodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import { releaseKickBrowser } from '../utils/puppeteer-manager.js';

import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from '../monitor/index.js';
import { logger as baseLogger } from '../utils/logger.js';

const logger = baseLogger;

export type WorkerName = 'vod_download' | 'chat_download' | 'youtube_upload' | 'dmca_processing';

interface LastFailedJob {
  jobId: string;
  errorMessage: string;
  attemptsMade: number;
  maxAttempts: number;
  vodId?: string;
  failedAt?: Date;
}

export interface WorkerHealthStatus {
  isRunning: boolean | null;
  queueCounts: Record<string, number>;
  lastFailedJob: LastFailedJob | null;
  status: 'healthy' | 'warning' | 'error';
}

const workers = new Map<WorkerName, Worker>();
let redisConnectionForWorkers: Redis | null = null;

export function registerWorker(name: WorkerName, worker: Worker) {
  workers.set(name, worker);
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

    const rawData = (await job.data) as any;
    const finishedAtTimestamp = typeof job.finishedOn === 'number' ? new Date(job.finishedOn) : undefined;

    return {
      jobId: String(job.id),
      errorMessage: (job.failedReason || 'Unknown error').substring(0, 500),
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: ((job.opts as any)?.attempts ?? 3) as number,
      vodId: rawData?.vodId ? String(rawData.vodId) : undefined,
      failedAt: finishedAtTimestamp ?? new Date(),
    };
  } catch {
    return null;
  }
}

export async function getWorkersHealth(): Promise<Record<string, WorkerHealthStatus>> {
  const result: Record<string, WorkerHealthStatus> = {};

  if (!redisConnectionForWorkers) {
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

  for (const [name] of workers) {
    try {
      const queue = new Queue(name as any, { connection: redisConnectionForWorkers });

      if (!queue || !workers.get(name)) continue;

      const counts = await queue.getJobCounts();
      const lastFailed = await getLastFailedJob(queue);

      const isRunningVal = typeof workers.get(name)?.isRunning === 'function' ? (workers.get(name)!.isRunning as unknown as () => boolean)() : !!(workers.get(name)?.isRunning ?? false);

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
      const errorMessage = error instanceof Error ? error.message : String(error);
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

async function bootstrap() {
  logger.info('Starting worker process...');
  logger.info(`NODE_ENV: ${process.env.NODE_ENV}`);

  try {
    await loadStreamerConfigs();
    logger.info('Loaded streamer configurations');

    // Start monitor service (stream detection polling)
    await startMonitorService();
    logger.info('Stream detection monitoring started');

    const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null, // Required by BullMQ workers
    });

    redisConnectionForWorkers = redisConnection;

    const vodWorker = new Worker(QUEUE_NAMES.VOD_DOWNLOAD as any, vodProcessor as any, {
      connection: redisConnection,
      concurrency: 2,
    });

    registerWorker('vod_download', vodWorker);

    const chatWorker = new Worker(QUEUE_NAMES.CHAT_DOWNLOAD as any, chatProcessor as any, {
      connection: redisConnection,
      concurrency: 1,
    });

    registerWorker('chat_download', chatWorker);

    const youtubeWorker = new Worker(QUEUE_NAMES.YOUTUBE_UPLOAD as any, youtubeProcessor as any, {
      connection: redisConnection,
      concurrency: 1,
    });

    registerWorker('youtube_upload', youtubeWorker);

    const dmcaWorker = new Worker(QUEUE_NAMES.DMCA_PROCESSING as any, dmcaProcessor as any, {
      connection: redisConnection,
      concurrency: 1, // CPU-intensive re-encoding operations
    });

    registerWorker('dmca_processing', dmcaWorker);

    vodWorker.on('completed', async (job) => {
      if (!job) return;

      const data = await job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          platform: data?.platform,
          streamerId: data?.streamerId,
        },
        `VOD download completed successfully`
      );
    });

    vodWorker.on('failed', async (job, err) => {
      if (!job || !err) return;

      const jobData = await job.data;
      logger.error(
        {
          jobId: String(job.id),
          vodId: jobData?.vodId,
          platform: jobData?.platform,
          streamerId: jobData?.streamerId,
          attemptsMade: job.attemptsMade,
          maxAttempts: (job.opts as any).attempts ?? 3,
          errorMessage: err.message || String(err),
          errorStack: 'stack' in err ? String((err as Error & { stack?: string }).stack) : 'No stack trace available',
        },
        `VOD download failed - check logs for details`
      );
    });

    vodWorker.on('progress', async (job, progress) => {
      if (!job) return;

      const data = await job.data;
      logger.debug({ jobId: String(job.id), vodId: data?.vodId, progress }, `VOD download progress update`);
    });

    chatWorker.on('completed', async (job) => {
      if (!job) return;

      const data = await job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          platform: data?.platform,
        },
        `Chat download completed successfully`
      );
    });

    chatWorker.on('failed', async (job, err) => {
      if (!job || !err) return;

      const jobData = await job.data;
      logger.error(
        {
          jobId: String(job.id),
          vodId: jobData?.vodId,
          platform: jobData?.platform,
          attemptsMade: job.attemptsMade,
          errorMessage: err.message || String(err),
        },
        `Chat download failed`
      );
    });

    youtubeWorker.on('completed', async (job) => {
      if (!job) return;

      const data = await job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          type: data?.type,
        },
        `YouTube upload completed successfully`
      );
    });

    youtubeWorker.on('failed', async (job, err) => {
      if (!job || !err) return;

      const jobData = await job.data;
      logger.error(
        {
          jobId: String(job.id),
          vodId: jobData?.vodId,
          type: jobData?.type,
          attemptsMade: job.attemptsMade,
          errorMessage: err.message || String(err),
        },
        `YouTube upload failed`
      );
    });

    dmcaWorker.on('completed', async (job) => {
      if (!job) return;

      const data = await job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          type: data?.type,
        },
        `DMCA processing completed successfully`
      );
    });

    dmcaWorker.on('failed', async (job, err) => {
      if (!job || !err) return;

      const jobData = await job.data;
      logger.error(
        {
          jobId: String(job.id),
          vodId: jobData?.vodId,
          type: jobData?.type,
          attemptsMade: job.attemptsMade,
          errorMessage: err.message || String(err),
        },
        `DMCA processing failed`
      );
    });

    startTokenHealthCron();
    logger.info('Token health check cron started');

    const shutdown = async () => {
      logger.info('Shutting down workers...');

      // Stop monitor polling loops first
      await stopMonitorService();

      await vodWorker.close();
      await chatWorker.close();
      await youtubeWorker.close();
      await dmcaWorker.close();

      const clientModule = await import('../db/client.js');
      await clientModule.closeAllClients();
      await releaseKickBrowser();
      await closeQueues();
      clearConfigCache();

      process.exit(0);
    };

    // Override default shutdown handlers (monitor/index.ts registers its own)
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info('Workers started successfully');
  } catch (error: any) {
    logger.error({ error }, 'Failed to start workers');
    process.exit(1);
  }
}

bootstrap();
