import 'dotenv/config';
import { Worker } from 'bullmq';
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

    const vodWorker = new Worker(QUEUE_NAMES.VOD_DOWNLOAD as any, vodProcessor as any, {
      connection: redisConnection,
      concurrency: 2,
    });

    const chatWorker = new Worker(QUEUE_NAMES.CHAT_DOWNLOAD as any, chatProcessor as any, {
      connection: redisConnection,
      concurrency: 1,
    });

    const youtubeWorker = new Worker(QUEUE_NAMES.YOUTUBE_UPLOAD as any, youtubeProcessor as any, {
      connection: redisConnection,
      concurrency: 1,
    });

    const dmcaWorker = new Worker(QUEUE_NAMES.DMCA_PROCESSING as any, dmcaProcessor as any, {
      connection: redisConnection,
      concurrency: 1, // CPU-intensive re-encoding operations
    });

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
