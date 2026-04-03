import 'dotenv/config';
import { extractErrorDetails } from '../utils/error.js';
import { Worker, Queue, BaseJobOptions } from 'bullmq';
import Redis from 'ioredis';
import { loadStreamerConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, closeQueues, ChatDownloadJob, YoutubeUploadJob, DmcaProcessingJob, ChatDownloadResult, YoutubeUploadResult, DmcaProcessingResult } from '../jobs/queues.js';
import vodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import dmcaProcessor from './dmca.worker.js';
import { startTokenHealthCron } from '../cron/token-health.js';
import { startMonitorService, stopMonitorService } from '../monitor/index.js';
import { logger as baseLogger } from '../utils/logger.js';
import type { LiveHlsDownloadJobData, LiveHlsDownloadResult } from './vod.worker.js';

const logger = baseLogger;

export type WorkerName = 'vod_download' | 'chat_download' | 'youtube_upload' | 'dmca_processing';

type AllJobData = LiveHlsDownloadJobData | ChatDownloadJob | YoutubeUploadJob | DmcaProcessingJob;

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
const queues = new Map<WorkerName, Queue>();
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

    const rawData = (await job.data) as AllJobData;
    const finishedAtTimestamp = typeof job.finishedOn === 'number' ? new Date(job.finishedOn) : undefined;

    return {
      jobId: String(job.id),
      errorMessage: (job.failedReason || 'Unknown error').substring(0, 500),
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: ((job.opts as Partial<BaseJobOptions>).attempts ?? 3) as number,
      vodId: 'vodId' in rawData ? String(rawData.vodId) : undefined,
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

  for (const [name, queue] of queues) {
    try {
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

    const vodWorker = new Worker<LiveHlsDownloadJobData, LiveHlsDownloadResult>(QUEUE_NAMES.VOD_DOWNLOAD as string, vodProcessor, {
      connection: redisConnection,
      concurrency: 2,
    });

    registerWorker('vod_download', vodWorker);
    queues.set('vod_download', new Queue<LiveHlsDownloadJobData, unknown, string>(QUEUE_NAMES.VOD_DOWNLOAD as string, { connection: redisConnection }));

    const chatWorker = new Worker<ChatDownloadJob, ChatDownloadResult>(QUEUE_NAMES.CHAT_DOWNLOAD as string, chatProcessor, {
      connection: redisConnection,
      concurrency: 1,
    });

    registerWorker('chat_download', chatWorker);
    queues.set('chat_download', new Queue<ChatDownloadJob, unknown, string>(QUEUE_NAMES.CHAT_DOWNLOAD as string, { connection: redisConnection }));

    const youtubeWorker = new Worker<YoutubeUploadJob, YoutubeUploadResult>(QUEUE_NAMES.YOUTUBE_UPLOAD as string, youtubeProcessor, {
      connection: redisConnection,
      concurrency: 1,
    });

    registerWorker('youtube_upload', youtubeWorker);
    queues.set('youtube_upload', new Queue<YoutubeUploadJob, unknown, string>(QUEUE_NAMES.YOUTUBE_UPLOAD as string, { connection: redisConnection }));

    const dmcaWorker = new Worker<DmcaProcessingJob, DmcaProcessingResult>(QUEUE_NAMES.DMCA_PROCESSING as string, dmcaProcessor, {
      connection: redisConnection,
      concurrency: 1, // CPU-intensive re-encoding operations
    });

    registerWorker('dmca_processing', dmcaWorker);
    queues.set('dmca_processing', new Queue<DmcaProcessingJob, unknown, string>(QUEUE_NAMES.DMCA_PROCESSING as string, { connection: redisConnection }));

    vodWorker.on('active', async (job) => {
      if (!job) return;

      const data = job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          platform: data?.platform,
          tenantId: data?.tenantId,
          platformUserId: data?.platformUserId,
          attemptsMade: job.attemptsMade,
        },
        `VOD download job started processing`
      );
    });

    vodWorker.on('completed', async (job) => {
      if (!job) return;

      const data = job.data;
      logger.info(
        {
          jobId: String(job.id),
          vodId: data?.vodId,
          platform: data?.platform,
          tenantId: data?.tenantId,
          platformUserId: data?.platformUserId,
        },
        `VOD download completed successfully`
      );
    });

    vodWorker.on('failed', async (job, err) => {
      if (!job || !err) return;

      const jobData = job.data;
      logger.error(
        {
          jobId: String(job.id),
          vodId: jobData?.vodId,
          platform: jobData?.platform,
          tenantId: jobData?.tenantId,
          platformUserId: jobData?.platformUserId,
          attemptsMade: job.attemptsMade,
          maxAttempts: (job.opts as Partial<BaseJobOptions>).attempts ?? 3,
          errorMessage: err.message || String(err),
          errorStack: 'stack' in err ? String((err as Error & { stack?: string }).stack) : 'No stack trace available',
        },
        `VOD download failed - check logs for details`
      );
    });

    vodWorker.on('progress', async (job, progress) => {
      if (!job) return;

      const data = job.data;
      logger.debug({ jobId: String(job.id), vodId: data?.vodId, progress }, `VOD download progress update`);
    });

    vodWorker.on('error', (err) => {
      logger.error(
        {
          errorMessage: err.message || String(err),
          errorStack: 'stack' in err ? String((err as Error & { stack?: string }).stack) : 'No stack trace available',
        },
        `VOD worker error (not job-specific)`
      );
    });

    chatWorker.on('completed', async (job) => {
      if (!job) return;

      const data = job.data;
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

      const jobData = job.data;
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

      const data = job.data;
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

      const jobData = job.data;
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

      const data = job.data;
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

      const jobData = job.data;
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

      // Stop monitor polling loops first (also clears intervals)
      await stopMonitorService();

      // Clear YouTube OAuth clients cache
      try {
        const youtubeModule = await import('../services/youtube.js');
        if (youtubeModule.shutdown) {
          youtubeModule.shutdown();
        }
      } catch {}

      // Close workers and queues
      await vodWorker.close();
      await chatWorker.close();
      await youtubeWorker.close();
      await dmcaWorker.close();

      for (const queue of queues.values()) {
        await queue.close();
      }

      const clientModule = await import('../db/client.js');
      await clientModule.closeAllClients();
      await closeQueues();
      clearConfigCache();

      process.exit(0);
    };

    // Register shutdown handlers (don't remove existing listeners from other modules)
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info('Workers started successfully');
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    logger.error(details, 'Failed to start workers');
    process.exit(1);
  }
}

bootstrap();
