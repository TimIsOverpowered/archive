import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger.js';
import { REDIS_MAX_RETRIES, REDIS_RETRY_TIMEOUT_MS } from '../constants.js';

let redisInstance: Redis | null = null;
let initPromise: Promise<void> | null = null;

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ workers
  retryStrategy(times: number) {
    if (times > REDIS_MAX_RETRIES) return null;
    const delay = Math.min(times * 500, 5000);
    logger.warn({ times, delay }, '[Workers Redis] Reconnection attempt');
    return delay;
  },
};

export function getRedisInstance(): Redis {
  if (!redisInstance) throw new Error('workers Redis not initialized. Call initWorkersRedis() first.');
  return redisInstance;
}

export async function initWorkersRedis(): Promise<void> {
  if (redisInstance) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { getWorkersConfig } = await import('../config/env.js');
    const url = getWorkersConfig().REDIS_URL;
    const maskedUrl = url.replace(/:\/\/.*@/, '://***@');
    logger.info({ url: maskedUrl }, '[Workers Redis] Connecting to Redis');

    redisInstance = new Redis(url, redisOptions);

    const readyTimeout = REDIS_RETRY_TIMEOUT_MS;
    let errorCount = 0;

    redisInstance.on('error', (err) => {
      errorCount++;
      logger.error({ err: err.message, errorCount }, '[Workers Redis] Connection error');
    });

    redisInstance.on('connect', () => {
      logger.info('[Workers Redis] Connected to Redis server');
    });

    redisInstance.on('close', () => {
      logger.info('[Workers Redis] Connection closed');
    });

    await new Promise<void>((resolve, reject) => {
      if (redisInstance!.status === 'ready') {
        logger.info('[Workers Redis] Connection ready - BullMQ can now process jobs');
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        redisInstance!.off('ready', readyHandler);
        const errorMsg = `Redis did not become ready after ${readyTimeout}ms`;
        logger.fatal({ timeoutMs: readyTimeout }, errorMsg);
        reject(new Error(errorMsg));
      }, readyTimeout);

      const readyHandler = () => {
        clearTimeout(timeoutId);
        logger.info('[Workers Redis] Connection ready - BullMQ can now process jobs');
        resolve();
      };

      redisInstance!.once('ready', readyHandler);
    });
  })();

  return initPromise;
}

export async function waitForRedisReady(): Promise<void> {
  if (!initPromise) throw new Error('Call initWorkersRedis() first');
  return initPromise;
}

export async function closeWorkersRedis(): Promise<void> {
  if (redisInstance && (redisInstance.status === 'ready' || redisInstance.status === 'connecting')) {
    logger.info('[Workers Redis] Closing connection...');
    await redisInstance.quit();
  }
}

export function isRedisReady(): boolean {
  return redisInstance?.status === 'ready' || false;
}
