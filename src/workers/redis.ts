import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger.js';
import { REDIS_MAX_RETRIES, REDIS_RETRY_TIMEOUT_MS } from '../constants.js';

// Eagerly created singleton ioredis instance for all BullMQ operations
const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ workers
  retryStrategy(times: number) {
    if (times > REDIS_MAX_RETRIES) return null;
    const delay = Math.min(times * 500, 5000);
    logger.warn({ times, delay }, '[Workers Redis] Reconnection attempt');
    return delay;
  },
};

const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);

// Wait for ready event with timeout
const readyTimeout = REDIS_RETRY_TIMEOUT_MS;

const readyPromise: Promise<void> = new Promise<void>((resolve) => {
  if (redisInstance.status === 'ready') {
    resolve();
    return;
  }
  const timeoutId = setTimeout(() => {
    const errorMsg = `Redis did not become ready after ${readyTimeout}ms`;
    logger.fatal({ timeoutMs: readyTimeout }, errorMsg);
  }, readyTimeout);
  redisInstance.once('ready', () => {
    clearTimeout(timeoutId);
    logger.info('[Workers Redis] Connection ready - BullMQ can now process jobs');
    resolve();
  });
});

// Connection event handlers using project logger
redisInstance.on('error', (err) => {
  logger.error({ err: err.message }, '[Workers Redis] Connection error');
});

redisInstance.on('connect', () => {
  logger.info('[Workers Redis] Connected to Redis server');
});

redisInstance.on('close', () => {
  logger.info('[Workers Redis] Connection closed');
});

// Export the singleton instance
export { redisInstance };

// Export close function for graceful shutdown
export async function closeWorkersRedis(): Promise<void> {
  if (redisInstance.status === 'ready' || redisInstance.status === 'connecting') {
    logger.info('[Workers Redis] Closing connection...');
    await redisInstance.quit();
  }
}

// Export connection status checker for health checks
export function isRedisReady(): boolean {
  return redisInstance.status === 'ready';
}

// Export readyPromise for bootstrap to await
export { readyPromise as waitForRedisReady };
