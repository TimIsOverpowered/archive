import dotenv from 'dotenv';
import path from 'path';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { loadStreamerConfigs, clearConfigCache } from '../config/loader.js';
import { QUEUE_NAMES, closeQueues } from '../jobs/queues.js';

// Load environment variables based on NODE_ENV (same as src/index.ts)
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : process.env.NODE_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import vodProcessor from './vod.worker.js';
import chatProcessor from './chat.worker.js';
import youtubeProcessor from './youtube.worker.js';
import { releaseKickBrowser } from '../utils/puppeteer-manager.js';

import { startTokenHealthCron } from '../cron/token-health.js';

const logger = {
  info: console.info,
  error: console.error,
  warn: console.warn,
};

async function bootstrap() {
  logger.info('Starting worker process...');

  try {
    await loadStreamerConfigs();
    logger.info('Loaded streamer configurations');

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

    vodWorker.on('completed', (job) => {
      logger.info(`VOD job ${job?.id} completed`);
    });

    vodWorker.on('failed', (job, err) => {
      logger.error(`VOD job ${job?.id} failed:`, err);
    });

    chatWorker.on('completed', (job) => {
      logger.info(`Chat job ${job?.id} completed`);
    });

    chatWorker.on('failed', (job, err) => {
      logger.error(`Chat job ${job?.id} failed:`, err);
    });

    youtubeWorker.on('completed', (job) => {
      logger.info(`YouTube job ${job?.id} completed`);
    });

    youtubeWorker.on('failed', (job, err) => {
      logger.error(`YouTube job ${job?.id} failed:`, err);
    });

    startTokenHealthCron();
    logger.info('Token health check cron started');

    const shutdown = async () => {
      logger.info('Shutting down workers...');

      await vodWorker.close();
      await chatWorker.close();
      await youtubeWorker.close();

      const clientModule = await import('../db/client.js');
      await clientModule.closeAllClients();
      await releaseKickBrowser();
      await closeQueues();
      clearConfigCache();

      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info('Workers started successfully');
  } catch (error: any) {
    logger.error('Failed to start workers:', error);
    process.exit(1);
  }
}

bootstrap();
