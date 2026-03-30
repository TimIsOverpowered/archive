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

    vodWorker.on('completed', (job) => {
      logger.info(`VOD job ${job?.id} completed`);
    });

    vodWorker.on('failed', (job, _err) => {
      logger.error({ jobId: job?.id }, `VOD job failed`);
    });

    chatWorker.on('completed', (job) => {
      logger.info(`Chat job ${job?.id} completed`);
    });

    chatWorker.on('failed', (job, _err) => {
      logger.error({ jobId: job?.id }, `Chat job failed`);
    });

    youtubeWorker.on('completed', (job) => {
      logger.info(`YouTube job ${job?.id} completed`);
    });

    youtubeWorker.on('failed', (job, _err) => {
      logger.error({ jobId: job?.id }, `YouTube job failed`);
    });

    dmcaWorker.on('completed', (job) => {
      logger.info(`DMCA job ${job?.id} completed`);
    });

    dmcaWorker.on('failed', (job, _err) => {
      logger.error({ jobId: job?.id }, `DMCA job failed`);
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
